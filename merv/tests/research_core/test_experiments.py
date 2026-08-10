from __future__ import annotations

import json

from merv.brain.kernel.utils import PermissionDeniedError, WorkflowError
from merv.brain.research_core.experiment_workflow import EXPERIMENT_WORKFLOW

from .scenarios import VALID_GRAPH, VALID_PLAN, VALID_REPORT, ResearchCase


class ExperimentWorkflowTest(ResearchCase):
    def test_full_lifecycle_is_gated_and_records_schema_transitions(self) -> None:
        experiment_id = self.create_experiment()
        plan_requirement = EXPERIMENT_WORKFLOW.requirement("plan")

        with self.assertRaisesRegex(WorkflowError, plan_requirement.error):
            self.transition_experiment(experiment_id, "submit_design")

        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        states = [
            self.transition_experiment(experiment_id, "submit_design")["status"]
        ]
        self.pass_review(
            target_type="experiment",
            target_id=experiment_id,
            role="design_reviewer",
        )
        states.extend(
            (
                self.transition_experiment(experiment_id, "mark_ready_to_run")["status"],
                self.transition_experiment(experiment_id, "start_running")["status"],
            )
        )
        for role, path, body in (
            ("result", "results.json", '{"accuracy": 0.72}'),
            ("report", "report.md", VALID_REPORT),
            ("graph", "graph.json", VALID_GRAPH),
        ):
            self.submit(
                target_type="experiment",
                target_id=experiment_id,
                role=role,
                path=path,
                body=body,
            )
        states.append(
            self.transition_experiment(experiment_id, "submit_results")["status"]
        )
        self.pass_review(
            target_type="experiment",
            target_id=experiment_id,
            role="experiment_reviewer",
        )
        completed = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition="complete",
            evidence={"conclusion": "Accuracy cleared the registered threshold."},
        )
        states.append(completed["status"])

        self.assertEqual(
            states,
            [
                "design_review",
                "ready_to_run",
                "running",
                "experiment_review",
                "complete",
            ],
        )
        state = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        self.assertEqual(
            state["conclusion"], "Accuracy cleared the registered threshold."
        )
        with self.app.store.connect() as conn:
            events = conn.execute(
                """
                SELECT payload_json FROM events
                WHERE target_id = ? AND type = ?
                ORDER BY id
                """,
                (experiment_id, EXPERIMENT_WORKFLOW.event_type),
            ).fetchall()
            sealed = conn.execute(
                """
                SELECT COUNT(*) AS n FROM artifacts
                WHERE target_id = ? AND submission_id <> ''
                """,
                (experiment_id,),
            ).fetchone()["n"]
        self.assertEqual(
            [json.loads(row["payload_json"])["transition"] for row in events],
            [
                "submit_design",
                "mark_ready_to_run",
                "start_running",
                "submit_results",
                "complete",
            ],
        )
        self.assertGreater(sealed, 0)

    def test_reflection_sourced_create_dedupes_tested_claims(self) -> None:
        # Two refs (a change-spec key and a literal id) can resolve to one
        # claim at materialization; experiment_claims' composite primary key
        # would abort the whole publish transaction on the duplicate insert.
        claim = self.call(
            "claim.create", project_id=self.project_id, statement="One claim."
        )
        with self.app.store.transaction() as conn:
            created = self.app.experiments._create_in_transaction(
                conn=conn,
                project_id=self.project_id,
                name="dedupe-test",
                intent="Materialize with duplicate refs.",
                tested_claim_ids=[claim["id"], claim["id"]],
                source_reflection_id="rfl_defensive",
            )
        with self.app.store.connect() as conn:
            linked = conn.execute(
                "SELECT COUNT(*) AS n FROM experiment_claims WHERE experiment_id = ?",
                (created["id"],),
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

    def test_terminal_state_has_no_escape_hatch(self) -> None:
        experiment_id = self.create_experiment("abandoned")
        self.transition_experiment(experiment_id, "abandon")
        state = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=experiment_id,
        )
        self.assertEqual(state["allowed_transitions"], [])
        with self.assertRaises(WorkflowError):
            self.transition_experiment(experiment_id, "abandon")


if __name__ == "__main__":
    import unittest

    unittest.main()
