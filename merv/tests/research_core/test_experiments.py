from __future__ import annotations

from merv.brain.kernel.utils import PermissionDeniedError, WorkflowError

from .scenarios import VALID_PLAN, ResearchCase


class ExperimentWorkflowTest(ResearchCase):
    def test_create_carries_the_ask_details_through_to_state(self) -> None:
        ask = "Hold the optimizer at the harness default; budget one GPU-day."
        created = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="wd-sweep",
            intent="Establish whether weight decay moves grokking timing.",
            details=ask,
        )
        self.assertEqual(created["details"], ask)
        state = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=str(created["id"]),
        )
        self.assertEqual(state["details"], ask)
        bare = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="width-sweep",
            intent="Establish whether width moves grokking timing.",
        )
        self.assertEqual(bare["details"], "")

    def test_reflection_sourced_create_dedupes_tested_claims(self) -> None:
        # Two refs (a change-spec key and a literal id) can resolve to one
        # claim at materialization; experiment_claims' composite primary key
        # would abort the whole publish transaction on the duplicate insert.
        claim = self.call(
            "claim.create", project_id=self.project_id, statement="One claim."
        )
        with self.app.store.transaction() as conn:
            created = self.app.experiments._create(
                conn=conn,
                project_id=self.project_id,
                name="dedupe-test",
                intent="Materialize with duplicate refs.",
                tested_claim_ids=[claim["id"], claim["id"]],
                guard=False,
            )
        with self.app.store.connect() as conn:
            linked = conn.execute(
                "SELECT COUNT(*) AS n FROM experiment_claims WHERE experiment_id = ?",
                (created.id,),
            ).fetchone()["n"]
        self.assertEqual(int(linked), 1)

    def test_review_returns_follow_declared_attempt_policy(self) -> None:
        planned = self.create_experiment("design-rejection")
        self.submit(
            target_type="experiment",
            target_id=planned,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.transition_experiment(planned, "submit_design")
        self.review(
            target_type="experiment",
            target_id=planned,
            role="design_reviewer",
            verdict="needs_changes",
        )
        rejected = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=planned,
        )
        self.assertEqual(
            (rejected["status"], rejected["attempt_index"]), ("planned", 2)
        )

        running = self.drive_experiment_to_review("execution-rejection")
        self.review(
            target_type="experiment",
            target_id=running,
            role="experiment_reviewer",
            verdict="needs_changes",
            return_to="running",
        )
        same_attempt = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=running,
        )
        self.assertEqual(
            (same_attempt["status"], same_attempt["attempt_index"]),
            ("running", 1),
        )

    def test_review_capability_is_independent_and_snapshot_pinned(self) -> None:
        experiment_id = self.create_experiment()
        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.transition_experiment(experiment_id, "submit_design")
        request = self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=experiment_id,
            role="design_reviewer",
            producer_session_id="producer",
        )

        with self.assertRaises(PermissionDeniedError):
            self.call(
                "review.start",
                review_request_id=request["review_request_id"],
                reviewer_capability=request["reviewer_capability"],
                caller_session_id="producer",
            )

        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            path="revised-plan.md",
            body=VALID_PLAN + "\nRevised after the request.\n",
        )
        with self.assertRaises(PermissionDeniedError):
            self.call(
                "review.start",
                review_request_id=request["review_request_id"],
                reviewer_capability=request["reviewer_capability"],
                caller_session_id="independent-reviewer",
            )

    def test_running_retry_preserves_attempt_and_records_context(self) -> None:
        experiment_id = self.drive_experiment_to_running("retry")
        before = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        retried = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition="retry_running",
            evidence={"reason": "provider outage", "detail": "VM disappeared"},
        )
        self.assertEqual(retried["status"], "running")
        self.assertEqual(retried["attempt_index"], before["attempt_index"])
        state = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        self.assertIn("provider outage", state["revision_context"])


if __name__ == "__main__":
    import unittest

    unittest.main()
