"""Independent review support follows an arbitrary pinned workflow graph."""

from dataclasses import replace
from unittest.mock import patch

from merv.brain.kernel.utils import NotFoundError, PermissionDeniedError, ValidationError, WorkflowError
from merv.brain.workflows import Brief, Change, Edge, Node, Reference, Workflow, retain_artifacts
from merv.brain.workflows.definitions.checks import review_requested, reviewed
from tests.research_core.scenarios import ResearchCase, REVIEW_SYNOPSIS


ROLE = "replication_auditor"


def review_context(snapshot, knowledge):
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return Brief("Verify the retained replication result before accepting it.", (
        Reference("review_request", str(pinned.get("request_id") or "")),
        *(Reference("artifact", item["artifact_id"], item["role"]) for item in pinned.get("artifacts") or ()),
    ))


PLUGIN = Workflow(
    "replication_review", 1, "work",
    (Node("work", role="replicator", build_context=lambda snapshot, knowledge: Brief("Replicate the retained claim.")),
     Node("audit", role=ROLE, read_only=True, workspace="review", build_context=review_context, dispatch_check=review_requested)),
    (Edge("work", "submit", "audit", change=retain_artifacts),
     Edge("audit", "accept", "done", check=reviewed(ROLE)),
     Edge("audit", "repair", "work", check=reviewed(ROLE, verdict="needs_changes", return_to="work")),
     Edge("audit", "withdraw", "withdrawn", suggest=False)),
    {"done": "replicated", "withdrawn": "cancelled"},
)


class GenericReviewTest(ResearchCase):
    def setUp(self):
        super().setUp()
        self.app.workflows.runtime.registry.register(PLUGIN)
        self.instance = self.call("workflow.start", project_id=self.project_id, workflow=PLUGIN.name,
                                 request_id="create", data={"question": "Does it reproduce?"})
        self.artifact = self.app.artifact_store.create(project_id=self.project_id, path="replication.md", data=b"Replicated on held-out data.")
        self.call("workflow.transition", project_id=self.project_id, instance_id=self.instance["id"],
                  action="submit", expected_revision=0, request_id="submit",
                  payload={"artifacts": {"replication evidence": self.artifact.id}})

    def request(self, **overrides):
        return self.call("review.request", **{
            "project_id": self.project_id, "target_type": PLUGIN.name, "target_id": self.instance["id"],
            "role": ROLE, "producer_session_id": "producer", **overrides})

    def start(self, request, identity="auditor"):
        return self.call("review.start", review_request_id=request["review_request_id"],
                         reviewer_capability=request["reviewer_capability"], caller_session_id=identity)

    def verdict(self, session, verdict="pass", **extra):
        return self.call("review.submit", review_session_id=session["review_session_id"], verdict=verdict,
                         synopsis=REVIEW_SYNOPSIS, **extra)

    def test_custom_role_pass_and_repair_follow_ordinary_edges_with_exact_context(self):
        first = self.request()
        pinned = first["target_snapshot"]
        self.assertEqual((pinned["project_id"], pinned["workflow"], pinned["version"], pinned["state"], pinned["revision"]),
                         (self.project_id, PLUGIN.name, 1, "audit", 1))
        self.assertEqual(pinned["data"]["artifacts"], {"replication evidence": self.artifact.id})
        self.assertIn("spawn_prompt", first["reviewer_handoff"])
        session = self.start(first)
        self.assertEqual(session["context"]["role"], ROLE)
        self.assertIn(self.artifact.id, {ref["id"] for ref in session["context"]["references"]})
        self.verdict(session, "needs_changes", return_to="work", notes="Add a second independent seed.")
        current = self.app.workflows.runtime.get(project_id=self.project_id, instance_id=self.instance["id"])
        self.assertEqual((current.state, current.revision), ("work", 2))
        updated = self.app.artifact_store.create(project_id=self.project_id, path="replication.md", data=b"Two independent seeds replicate.")
        self.call("workflow.transition", project_id=self.project_id, instance_id=current.id,
                  action="submit", expected_revision=2, request_id="resubmit", payload={"artifacts": {"replication evidence": updated.id}})
        second = self.request()
        self.assertNotEqual(first["target_snapshot_id"], second["target_snapshot_id"])
        self.assertEqual(first["target_snapshot"]["data"]["artifacts"]["replication evidence"], self.artifact.id)
        self.verdict(self.start(second))
        current = self.app.workflows.runtime.get(project_id=self.project_id, instance_id=current.id)
        self.assertEqual((current.state, current.outcome), ("done", "replicated"))
        history = self.call("workflow.history", project_id=self.project_id, instance_id=current.id)["history"]
        self.assertEqual([entry["action"] for entry in history], ["start", "submit", "repair", "submit", "accept"])
        with self.assertRaises(WorkflowError):
            self.call("workflow.assignment", project_id=self.project_id, instance_id=current.id)

    def test_request_scope_and_independence_are_enforced(self):
        other = self.call("project", action="create", name="Other review project")["id"]
        with self.assertRaises(NotFoundError):
            self.request(project_id=other)
        with self.assertRaises(NotFoundError):
            self.request(target_type="task")
        with self.assertRaisesRegex(PermissionDeniedError, "active gate requires"):
            self.request(role="unrelated_reviewer")
        request = self.request()
        with self.assertRaisesRegex(PermissionDeniedError, "differ from producer"):
            self.start(request, "producer")
        session = self.start(request)
        with self.assertRaisesRegex(ValidationError, "destination"):
            self.verdict(session, "needs_changes", return_to="invented_state")
        self.verdict(session)

    def test_changed_state_and_version_revoke_started_reviews(self):
        request = self.request()
        session = self.start(request)
        self.app.workflows.runtime.registry.register(replace(PLUGIN, version=2))
        self.app.workflows.runtime.migrate(
            project_id=self.project_id, instance_id=self.instance["id"], version=2, expected_revision=1,
            request_id="upgrade", transform=lambda before: ("audit", Change({"question": "Review the changed question."})))
        with self.assertRaisesRegex(PermissionDeniedError, "changed"):
            self.start(request, "another-auditor")
        with self.assertRaisesRegex(PermissionDeniedError, "changed"):
            self.verdict(session)
        fresh = self.request()
        self.assertEqual((fresh["target_snapshot"]["version"], fresh["target_snapshot"]["revision"]), (2, 2))
        self.verdict(self.start(fresh))

    def test_request_cannot_pin_cross_project_artifact_data(self):
        other = self.call("project", action="create", name="Private evidence project")["id"]
        foreign = self.app.artifact_store.create(project_id=other, path="private.md", data=b"Private result")
        self.app.workflows.runtime.registry.register(replace(PLUGIN, version=2))
        self.app.workflows.runtime.migrate(
            project_id=self.project_id, instance_id=self.instance["id"], version=2, expected_revision=1,
            request_id="bad-upgrade", transform=lambda before: ("audit", Change({"artifacts": {"evidence": foreign.id}})))
        with self.assertRaises(NotFoundError):
            self.request()

    def test_capability_refresh_while_waiting_for_the_workflow_lock_cannot_reopen_it(self):
        request = self.request()
        runtime = self.app.workflows.runtime
        lock = runtime.lock

        def refreshed_before_lock(**kwargs):
            kwargs["conn"].execute("UPDATE review_requests SET status = 'superseded' WHERE id = ?",
                                   (request["review_request_id"],))
            return lock(**kwargs)

        with patch.object(runtime, "lock", side_effect=refreshed_before_lock):
            with self.assertRaisesRegex(PermissionDeniedError, "no longer open"):
                self.start(request)
        with self.app.store.transaction() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM review_sessions WHERE request_id = ?",
                                          (request["review_request_id"],)).fetchone()[0], 0)

    def test_capability_refresh_while_submit_waits_does_not_accept_a_verdict(self):
        request = self.request()
        session = self.start(request)
        runtime = self.app.workflows.runtime
        lock = runtime.lock

        def refreshed_before_lock(**kwargs):
            kwargs["conn"].execute("UPDATE review_requests SET status = 'superseded' WHERE id = ?",
                                   (request["review_request_id"],))
            return lock(**kwargs)

        with patch.object(runtime, "lock", side_effect=refreshed_before_lock):
            with self.assertRaisesRegex(PermissionDeniedError, "no longer open"):
                self.verdict(session)
        current = runtime.get(project_id=self.project_id, instance_id=self.instance["id"])
        self.assertEqual((current.state, current.revision), ("audit", 1))
        self.assertEqual(self.call("review.status", project_id=self.project_id, target_type=PLUGIN.name,
                                  target_id=current.id)["reviews"], [])
