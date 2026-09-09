"""Real workflow leases, context freezing, stale-worker fencing, and MCP scope."""

import secrets
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from merv.brain.workflows import (
    Action,
    Brief,
    Change,
    Edge,
    Issue,
    Node,
    Reference,
    Workflow,
)
from merv.brain.workflows.definitions.checks import review_requested, reviewed
from tests.research_core.scenarios import ResearchCase


class WorkflowDispatchTest(ResearchCase):
    def setUp(self):
        super().setUp()
        self.call("project.update", project_id=self.project_id, agent_dispatch=True)
        self.facts = {"ready": True, "context": "initial context"}
        self.plugin = Workflow(
            name="replication", version=1, initial="investigate",
            nodes=(
                Node("investigate", "Investigate replication", "researcher",
                     lambda snapshot, knowledge: Brief(self.facts["context"], (Reference("project", snapshot.project_id),)),
                     lambda snapshot, knowledge: () if self.facts["ready"] else (Issue("dependency", "Wait for the dependency"),)),
                Node("review", "Review replication", "independent_verifier",
                     lambda snapshot, knowledge: Brief("Verify the retained evidence and record one outcome."),
                     read_only=True, workspace="review"),
            ),
            edges=(Edge("investigate", "submit", "review", change=lambda snapshot, payload, knowledge: Change(data={"evidence": "retained"})),
                   Edge("review", "revise", "investigate"), Edge("review", "accept", "complete")),
            outcomes={"complete": "passed"},
        )
        self.runtime = self.app.research.workflows.runtime
        self.runtime.registry.register(self.plugin)
        self.instance = self.call("workflow.start", project_id=self.project_id, workflow=self.plugin.name, request_id="start")
        self.instance_id = self.instance["id"]
        self.client = TestClient(self.app.fastapi_app, raise_server_exceptions=False)

    def claim(self, runner="runner"):
        secret = "mas_" + secrets.token_urlsafe(32)
        result = self.app.application.claim_agent_session(
            project_id=self.project_id, runner_id=runner, platform="codex",
            idempotency_key=runner, session_secret=secret,
        )
        return result["session"], secret

    def move(self, action, revision):
        return self.call("workflow.transition", project_id=self.project_id, instance_id=self.instance_id,
                         action=action, expected_revision=revision, request_id=f"{action}:{revision}")

    def mcp(self, secret, name, **arguments):
        return self.client.post("/mcp/call", headers={"Authorization": f"Bearer {secret}"},
                                json={"name": name, "arguments": arguments})

    def test_new_plugin_claim_freezes_context_inside_lease_and_fences_completed_nodes(self):
        candidate = self.runtime.assignment(project_id=self.project_id, instance_id=self.instance_id)
        self.facts["context"] = "fresh context at the lease transaction"
        secret = "mas_" + secrets.token_urlsafe(32)
        session = self.app.agent_sessions.claim(
            project_id=self.project_id, candidates=[candidate], runner_id="runner", platform="codex",
            idempotency_key="claim", session_secret=secret,
        )
        self.assertEqual(session["target_type"], "replication")
        self.assertEqual(session["workflow_instance_id"], self.instance_id)
        self.assertEqual(session["workflow_revision"], 0)
        self.assertEqual(session["assignment"]["brief"], self.facts["context"])
        self.assertIn(self.facts["context"], session["instruction"])
        self.facts["context"] = "later context must not rewrite the packet"
        self.assertEqual(self.app.agent_sessions.list(project_id=self.project_id)["sessions"][0]["assignment"], session["assignment"])
        self.assertEqual(self.app.application.dispatch_queue(project_id=self.project_id), [])
        self.move("submit", 0)
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secret))
        review, _ = self.claim("reviewer")
        self.assertEqual(review["kind"], "review")
        self.assertTrue(review["assignment"]["execution"]["read_only"])
        self.assertEqual(review["workflow_revision"], 1)
        self.move("accept", 1)
        self.assertIsNone(self.claim("after-completion")[0])

    def test_stale_candidates_and_changed_dependencies_cannot_receive_lease(self):
        candidate = self.runtime.assignment(project_id=self.project_id, instance_id=self.instance_id)
        self.facts["ready"] = False
        result = self.app.agent_sessions.claim(
            project_id=self.project_id, candidates=[candidate], runner_id="blocked", platform="codex",
            idempotency_key="blocked", session_secret="mas_" + secrets.token_urlsafe(32),
        )
        self.assertIsNone(result)
        self.facts["ready"] = True
        self.move("submit", 0)
        result = self.app.agent_sessions.claim(
            project_id=self.project_id, candidates=[candidate], runner_id="stale", platform="codex",
            idempotency_key="stale", session_secret="mas_" + secrets.token_urlsafe(32),
        )
        self.assertIsNone(result)

    def test_concurrent_runners_get_one_lease_and_activation_is_once_across_resume(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda runner: self.claim(runner), ("runner-a", "runner-b")))
        self.assertEqual(sum(session is not None for session, secret in results), 1)
        session, secret = next(item for item in results if item[0] is not None)
        sessions = self.app.agent_sessions
        denied_http = self.client.get(f"/api/projects/{self.project_id}", headers={"Authorization": f"Bearer {secret}"})
        self.assertEqual(denied_http.status_code, 403, denied_http.text)
        with self.app.store.transaction() as tx:
            self.assertEqual(tx.execute("SELECT COUNT(*) FROM events WHERE type = 'workflow.work_started'").fetchone()[0], 0)
        sessions.authenticate(session_secret=secret)
        sessions.authenticate(session_secret=secret)
        sessions.release(session_id=session["id"], runner_id=session["runner_id"], head_sha="a" * 40)
        resumed, resumed_secret = self.claim("resumer")
        self.assertEqual(resumed["source_sha"], "a" * 40)
        sessions.authenticate(session_secret=resumed_secret)
        with self.app.store.transaction() as tx:
            self.assertEqual(tx.execute("SELECT COUNT(*) FROM events WHERE type = 'workflow.work_started'").fetchone()[0], 1)
        self.assertEqual(self.runtime.get(project_id=self.project_id, instance_id=self.instance_id).revision, 0)

    def test_session_tools_are_scoped_to_instance_revision_and_read_only_policy(self):
        session, secret = self.claim()
        allowed = self.mcp(secret, "workflow.assignment", project_id=self.project_id, instance_id=self.instance_id)
        self.assertEqual(allowed.status_code, 200, allowed.text)
        bad_revision = self.mcp(secret, "workflow.transition", project_id=self.project_id, instance_id=self.instance_id,
                                action="submit", expected_revision=1, request_id="wrong-revision")
        self.assertEqual(bad_revision.json()["error_code"], "agent_session_scope_forbidden")
        foreign = self.mcp(secret, "workflow.transition", project_id=self.project_id, instance_id="wf_foreign",
                           action="submit", expected_revision=0, request_id="foreign")
        self.assertEqual(foreign.json()["error_code"], "agent_session_scope_forbidden")
        forbidden = self.mcp(secret, "workflow.start", project_id=self.project_id, workflow="replication", request_id="spawn")
        self.assertEqual(forbidden.json()["error_code"], "agent_session_scope_forbidden")
        forbidden_begin = self.mcp(secret, "workflow.begin", project_id=self.project_id, instance_id=self.instance_id, expected_revision=0)
        self.assertEqual(forbidden_begin.json()["error_code"], "agent_session_scope_forbidden")
        advanced = self.mcp(secret, "workflow.transition", project_id=self.project_id, instance_id=self.instance_id,
                            action="submit", expected_revision=0, request_id="submit")
        self.assertEqual(advanced.status_code, 200, advanced.text)
        review, reviewer_secret = self.claim("reviewer")
        upload = self.mcp(reviewer_secret, "artifact.store", project_id=self.project_id)
        self.assertEqual(upload.json()["error_code"], "agent_session_scope_forbidden")
        reviewer_begin = self.mcp(reviewer_secret, "workflow.begin", project_id=self.project_id, instance_id=self.instance_id, expected_revision=1)
        self.assertEqual(reviewer_begin.json()["error_code"], "agent_session_scope_forbidden")
        accepted = self.mcp(reviewer_secret, "workflow.transition", project_id=self.project_id, instance_id=self.instance_id,
                            action="accept", expected_revision=1, request_id="verdict")
        self.assertEqual(accepted.status_code, 200, accepted.text)

    def test_native_task_owner_and_independent_reviewer_use_generic_leases(self):
        from tests.research_core.scenarios import REVIEW_SYNOPSIS
        from tests.research_core.test_tasks import DELIVERABLES, VALID_DELIVERY

        self.move("submit", 0)
        self.move("accept", 1)
        task = self.call("task.create", project_id=self.project_id, name="prep-data",
                         goal="Prepare a reproducible dataset for research.", deliverables=DELIVERABLES)
        task_id = task["id"]
        owner, owner_secret = self.claim("task-owner")
        self.assertEqual(owner["workflow_instance_id"], task_id)
        self.assertEqual(owner["assignment"]["role"], "task_owner")
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=owner_secret))
        self.submit(target_type="task", target_id=task_id, role="delivery", body=VALID_DELIVERY)
        self.call("task.transition", project_id=self.project_id, task_id=task_id, transition="submit_delivery")
        request = self.app.application.request_review(
            project_id=self.project_id, target_type="task", target_id=task_id,
            role="task_reviewer", producer_session_id=owner["id"],
        )
        reviewer, secret = self.claim("task-reviewer")
        self.assertEqual(reviewer["workflow_instance_id"], task_id)
        self.assertEqual(reviewer["review_request_id"], request["review_request_id"])
        self.assertTrue(reviewer["assignment"]["execution"]["read_only"])
        denied = self.mcp(secret, "workflow.transition", project_id=self.project_id, instance_id=task_id,
                          action="mark_failed", expected_revision=reviewer["workflow_revision"], request_id="unrelated-exit")
        self.assertEqual(denied.json()["error_code"], "agent_session_scope_forbidden")
        started = self.mcp(secret, "review.start", review_request_id=request["review_request_id"],
                           reviewer_capability="assigned", caller_session_id="assigned")
        self.assertEqual(started.status_code, 200, started.text)
        submitted = self.mcp(secret, "review.submit", review_session_id=started.json()["result"]["review_session_id"],
                             verdict="pass", synopsis=REVIEW_SYNOPSIS)
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=owner_secret))
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secret))

    def test_custom_reviewer_role_uses_pinned_capability_and_automatic_graph_route(self):
        self.move("submit", 0)
        self.move("accept", 1)
        role = "evidence_auditor"

        def review_context(snapshot, knowledge):
            pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
            return Brief("Independently verify the retained result before accepting it.",
                         (Reference("review_request", pinned["request_id"]),))

        plugin = Workflow(
            "custom_audit", 1, "work",
            (Node("work", "Collect evidence", "collector", lambda snapshot, knowledge: Brief("Collect evidence.")),
             Node("audit", "Audit the evidence", role, review_context, review_requested,
                  read_only=True, workspace="review")),
            (Edge("work", "submit", "audit", change=lambda snapshot, payload, knowledge: Change(
                data={"result": "retained conclusion"},
                actions=(Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": role}),))),
             Edge("audit", "accept", "done", check=reviewed(role))),
            {"done": "passed"},
        )
        self.runtime.registry.register(plugin)
        instance = self.call("workflow.start", project_id=self.project_id, workflow=plugin.name, request_id="audit-start")
        owner, owner_secret = self.claim("audit-producer")
        advanced = self.mcp(owner_secret, "workflow.transition", project_id=self.project_id,
                            instance_id=instance["id"], expected_revision=0, action="submit", request_id="audit-submit")
        self.assertEqual(advanced.status_code, 200, advanced.text)
        reviewer, secret = self.claim("independent-auditor")
        self.assertEqual(reviewer["target_type"], "custom_audit")
        self.assertEqual(reviewer["assignment"]["role"], role)
        self.assertIn("reviewer_capability='assigned'", reviewer["instruction"])
        request_id = reviewer["review_request_id"]
        forbidden = self.mcp(secret, "workflow.transition", project_id=self.project_id,
                             instance_id=instance["id"], expected_revision=1, action="accept", request_id="skip-audit")
        self.assertEqual(forbidden.json()["error_code"], "agent_session_scope_forbidden")
        foreign_request = self.mcp(secret, "review.start", review_request_id="req_elsewhere",
                                   reviewer_capability="assigned", caller_session_id="assigned")
        self.assertEqual(foreign_request.json()["error_code"], "agent_session_scope_forbidden")
        upload = self.mcp(secret, "artifact.store", project_id=self.project_id, path="tamper.txt")
        self.assertEqual(upload.json()["error_code"], "agent_session_scope_forbidden")
        started = self.mcp(secret, "review.start", review_request_id=request_id,
                           reviewer_capability="assigned", caller_session_id="assigned")
        self.assertEqual(started.status_code, 200, started.text)
        packet = started.json()["result"]
        self.assertEqual(packet["context"]["role"], role)
        self.assertEqual(packet["context"]["revision"], 1)
        self.assertEqual(packet["target_snapshot"]["data"]["result"], "retained conclusion")
        submitted = self.mcp(secret, "review.submit", review_session_id=packet["review_session_id"],
                             verdict="pass", synopsis="The retained conclusion is supported by the evidence.")
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(self.runtime.get(project_id=self.project_id, instance_id=instance["id"]).outcome, "passed")
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=owner_secret))
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secret))
        self.assertIsNone(self.claim("audit-after-completion")[0])

    def test_lens_agents_read_parent_and_submit_generic_content_before_join(self):
        import shlex

        from tests.research_core.scenarios import LENSES

        self.move("submit", 0)
        self.move("accept", 1)
        experiment = self.call("experiment.create", project_id=self.project_id, name="completed-source", intent="Provide the reflection corpus.")
        self.call("experiment.transition", project_id=self.project_id, experiment_id=experiment["id"], transition="abandon")
        reflection = self.call("reflection.create", project_id=self.project_id, lenses=[dict(lens) for lens in LENSES])
        reflection_id = reflection["id"]
        retained = set()
        for index in range(5):
            worker, secret = self.claim(f"lens-{index}")
            self.assertEqual(worker["assignment"]["role"], "reflection_lens")
            read_parent = self.mcp(secret, "reflection.get", project_id=self.project_id, reflection_id=reflection_id)
            self.assertEqual(read_parent.status_code, 200, read_parent.text)
            forbidden = self.mcp(secret, "reflection.transition", project_id=self.project_id, reflection_id=reflection_id, transition="abandon")
            self.assertEqual(forbidden.json()["error_code"], "agent_session_scope_forbidden")
            uploaded = self.mcp(secret, "artifact.store", project_id=self.project_id, path=f"lens-{index}.md")
            self.assertEqual(uploaded.status_code, 200, uploaded.text)
            pending = uploaded.json()["result"]
            token = shlex.split(pending["run"])[-1].rsplit("/", 1)[-1]
            completed = self.client.put(f"/api/artifacts/u/{token}", content=f"## Summary\nIndependent lens {index} contribution grounded in the retained corpus.\n".encode())
            self.assertEqual(completed.status_code, 200, completed.text)
            artifact_id = completed.json()["artifact_id"]
            retained.add(artifact_id)
            submitted = self.mcp(secret, "workflow.transition", project_id=self.project_id,
                                 instance_id=worker["workflow_instance_id"], expected_revision=worker["workflow_revision"],
                                 action="submit", request_id=f"lens-{index}", payload={"artifact_id": artifact_id})
            self.assertEqual(submitted.status_code, 200, submitted.text)
            self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secret))
        parent = self.runtime.get(project_id=self.project_id, instance_id=reflection_id)
        self.assertEqual(parent.state, "synthesizing")
        self.assertEqual(set(parent.data["lens_artifacts"].values()), retained)
        synthesizer, _ = self.claim("synthesis")
        self.assertEqual(synthesizer["workflow_instance_id"], reflection_id)
        self.assertEqual(synthesizer["assignment"]["role"], "reflection_owner")
