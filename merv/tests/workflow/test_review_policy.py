"""The require_verified_reviews policy knob and its gate enforcement."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from merv.brain.kernel.state.store import next_created_seq
from merv.brain.kernel.utils import WorkflowError, new_id, now_iso

VALID_PLAN = (
    "## Summary\n"
    "A toy experiment used by the review-policy tests.\n\n"
    "## Objective & hypothesis\n"
    "Test that the threshold rule beats the majority baseline.\n\n"
    "## Evaluation\n"
    "Metric: accuracy vs the majority-class baseline; success if accuracy > 0.6.\n"
)


class ReviewPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Policy Test")["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    def test_expired_requests_are_pending_in_checklist_and_absent_from_runtime(self):
        from merv.brain.workflows import Reference
        exp_id = self._drive_to_design_review()
        for status in ("requested", "started"):
            with self.subTest(status=status):
                request = self.call("review.request", project_id=self.project_id, target_type="experiment", target_id=exp_id, role="design_reviewer")
                with self.app.store.transaction() as conn:
                    conn.execute("UPDATE review_requests SET status = ?, expires_at = '2000-01-01' WHERE id = ?", (status, request["review_request_id"]))
                    records = self.app.research.records
                    kind = records.kinds["experiment"]
                    record, gate = records.get_state_with_gate(kind, conn=conn, project_id=self.project_id, record_id=exp_id)
                    self.assertEqual(gate.review.status, "pending")
                    self.assertFalse(gate.review.satisfied)
                    knowledge = records.knowledge(kind, gate.decision.snapshot, conn)
                    self.assertEqual(knowledge.read(Reference("review_snapshot", exp_id)), {})
                refreshed = self.app.reviews.request(project_id=self.project_id, target_type="experiment", target_id=exp_id,
                                                     role="design_reviewer", if_current=True)
                self.assertNotEqual(refreshed.review_request_id, request["review_request_id"])
                self.assertTrue(self.app.reviews.request(project_id=self.project_id, target_type="experiment", target_id=exp_id,
                                                        role="design_reviewer", if_current=True).reused)

    def test_request_outcomes_serialize_only_their_available_fields(self):
        from merv.brain.application.reviews import request_review
        exp_id = self._drive_to_design_review()
        arguments = dict(project_id=self.project_id, target_type="experiment",
                         target_id=exp_id, role="design_reviewer", if_current=True)
        created = request_review(self.app.research, **arguments)
        self.assertEqual(set(created), {"review_request_id", "reviewer_capability", "role",
                                       "target_snapshot_id", "target_snapshot", "expires_at", "reviewer_handoff", "producer_next"})
        self.assertEqual(request_review(self.app.research, **arguments),
                         {"review_request_id": created["review_request_id"], "reused": True})
        self.assertEqual(request_review(self.app.research, **arguments, expected_revision=-1), {"skipped": True})
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        self.assertEqual(request_review(self.app.research, **arguments),
                         {"skipped": True, "reason": "The exact submitted snapshot already passed review."})

    def test_scoped_latest_verdict_and_independence_have_checklist_runtime_parity(self):
        from merv.brain.research_core.reviews import read_review_fact
        from unittest.mock import patch
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        for strict in (True, False):
            self.call("project.update", project_id=self.project_id, require_verified_reviews=strict)
            with self.app.store.transaction() as conn, patch("merv.brain.research_core.records.read_review_fact", wraps=read_review_fact) as reads:
                records = self.app.research.records
                _, gate = records.get_state_with_gate(records.kinds["experiment"], conn=conn, record_id=exp_id, project_id=self.project_id)
                approve = next(item for item in gate.decision.actions if item.edge.name == "approve_design")
                self.assertEqual((gate.review.satisfied, approve.available), (not strict, not strict))
                self.assertEqual(reads.call_count, 1)
                args = reads.call_args.kwargs
                for changes in ({"project_id": "foreign"}, {"snapshot_id": "different"}, {"role": "experiment_reviewer"}):
                    isolated = read_review_fact(**{**args, **changes})
                    self.assertFalse(isolated.passed)
                    self.assertFalse(isolated.request_valid)
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE reviews SET verdict = 'fail' WHERE id = (SELECT id FROM reviews WHERE target_id = ? ORDER BY created_seq DESC LIMIT 1)", (exp_id,))
            records = self.app.research.records
            _, gate = records.get_state_with_gate(records.kinds["experiment"], conn=conn, record_id=exp_id)
            self.assertFalse(gate.review.satisfied)
            self.assertFalse(next(item for item in gate.decision.actions if item.edge.name == "approve_design").available)

    # ---- helpers ----

    def _drive_to_design_review(self, *, name: str = "exp-policy") -> str:
        exp_id = self.call(
            "experiment.create", name=name, project_id=self.project_id, intent="Policy."
        )["id"]
        self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_design",
        )
        return exp_id

    def _insert_attested_pass(self, *, exp_id: str, role: str) -> None:
        """Simulate a legacy pass whose session predates mandatory caller_session_id."""
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role=role,
        )
        request_id = req["review_request_id"]
        with self.app.reviews.store.transaction() as conn:
            row = conn.execute(
                "SELECT target_snapshot_id FROM review_requests WHERE id = ?", (request_id,)
            ).fetchone()
            session_id = new_id(prefix="rvs")
            conn.execute(
                """
                INSERT INTO review_sessions (
                  id, request_id, declared_agent, caller_session_id, tenant_id,
                  independence, status, created_at
                )
                VALUES (?, ?, '', '', 'local', 'attested_agent_review', 'submitted', ?)
                """,
                (session_id, request_id, now_iso()),
            )
            conn.execute(
                """
                INSERT INTO reviews (
                  id, project_id, request_id, session_id, target_snapshot_id,
                  target_type, target_id, role, verdict, return_to, notes,
                  findings_json, evidence_json, created_at, created_seq
                )
                VALUES (?, ?, ?, ?, ?, 'experiment', ?, ?, 'pass', '', '', '[]', '{}', ?, ?)
                """,
                (
                    new_id(prefix="rev"),
                    self.project_id,
                    request_id,
                    session_id,
                    row["target_snapshot_id"],
                    exp_id,
                    role,
                    now_iso(),
                    next_created_seq(conn=conn, table="reviews"),
                ),
            )
            conn.execute(
                "UPDATE review_requests SET status = 'submitted' WHERE id = ?", (request_id,)
            )

    def _pass_verified_review(self, *, exp_id: str, role: str) -> None:
        req = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role=role,
        )
        session = self.call(
            "review.start",
            review_request_id=req["review_request_id"],
            reviewer_capability=req["reviewer_capability"],
            caller_session_id=f"{role}-reviewer",
        )
        self.call(
            "review.submit",
            review_session_id=session["review_session_id"],
            verdict="pass",
            synopsis="The plan and results check out, so the attempt stands as reported.",
        )

    def _approve_design(self, exp_id):
        current = self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=exp_id)
        self.call("workflow.transition", project_id=self.project_id, instance_id=exp_id, action="approve_design",
                  expected_revision=current.revision, request_id="approve")
        return self.app.research.experiments.get_state(project_id=self.project_id, experiment_id=exp_id)

    # ---- default (knob off) ----

    def test_attested_pass_satisfies_gate_by_default(self) -> None:
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        out = self._approve_design(exp_id)
        self.assertEqual(out.status, "running")

    # ---- knob on ----

    def test_policy_blocks_attested_pass_with_clear_reason(self) -> None:
        self.call("project.update", project_id=self.project_id, require_verified_reviews=True)
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        with self.assertRaises(WorkflowError) as ctx:
            self._approve_design(exp_id)
        self.assertIn("require_verified_reviews", str(ctx.exception))
        self.assertIn("caller_session_id", str(ctx.exception))

    def test_workflow_surfaces_attested_blocked_reason(self) -> None:
        self.call("project.update", project_id=self.project_id, require_verified_reviews=True)
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        wf = self.call(
            "workflow.status_and_next", project_id=self.project_id, experiment_id=exp_id
        )
        workflow = wf["workflow"]
        self.assertEqual(workflow["current_gate"], "review_not_requested")
        self.assertEqual(workflow["review_gate"]["status"], "attested_blocked")
        self.assertTrue(
            any("require_verified_reviews" in item["reason"] for item in workflow["suggested_action"]["blockers"])
        )
        self.assertNotIn("blocked_actions", workflow)
        # The remedy is a fresh, verified review — review.request stays allowed.
        self.assertIn("review.request", workflow["allowed_actions"])

    def test_verified_review_satisfies_gate_with_policy_on(self) -> None:
        self.call("project.update", project_id=self.project_id, require_verified_reviews=True)
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        self._pass_verified_review(exp_id=exp_id, role="design_reviewer")
        out = self.app.research.experiments.get_state(project_id=self.project_id, experiment_id=exp_id)
        self.assertEqual(out.status, "running")

    def test_policy_can_be_switched_back_off(self) -> None:
        self.call("project.update", project_id=self.project_id, require_verified_reviews=True)
        self.call("project.update", project_id=self.project_id, require_verified_reviews=False)
        exp_id = self._drive_to_design_review()
        self._insert_attested_pass(exp_id=exp_id, role="design_reviewer")
        out = self._approve_design(exp_id)
        self.assertEqual(out.status, "running")

    # ---- settings surface ----

    def test_project_update_roundtrips_the_knob(self) -> None:
        updated = self.call(
            "project.update", project_id=self.project_id, require_verified_reviews=True
        )
        self.assertTrue(updated["settings"]["require_verified_reviews"])
        fetched = self.call("project.get", project_id=self.project_id)
        self.assertTrue(fetched["settings"]["require_verified_reviews"])
        # Unrelated updates leave the knob alone.
        renamed = self.call("project.update", project_id=self.project_id, name="Policy Renamed")
        self.assertTrue(renamed["settings"]["require_verified_reviews"])


if __name__ == "__main__":
    unittest.main()
