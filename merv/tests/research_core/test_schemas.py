from __future__ import annotations

import unittest

from merv.brain.research_core import (
    EXPERIMENT_WORKFLOW,
    REFLECTION_WORKFLOW,
    TASK_WORKFLOW,
)
from merv.brain.research_core.policy import (
    REVIEW_GATE_EXEMPT_ROLES,
    review_snapshot_id,
    snapshot_from_id,
    validate_synopsis,
)
from merv.brain.research_core.workflow_schema import (
    resolve_review_return,
    validate_workflow,
)


class WorkflowSchemaTest(unittest.TestCase):
    def test_declarations_are_complete_and_self_consistent(self) -> None:
        for workflow in (EXPERIMENT_WORKFLOW, REFLECTION_WORKFLOW, TASK_WORKFLOW):
            with self.subTest(workflow=workflow.target_type):
                validate_workflow(workflow)
                self.assertTrue(workflow.state(workflow.initial))
                self.assertTrue(workflow.transitions)
                self.assertEqual(
                    len(workflow.transition_names),
                    len(set(workflow.transition_names)),
                )

    def test_experiment_states_and_review_returns_project_the_graph(self) -> None:
        self.assertEqual(
            tuple(state.name for state in EXPERIMENT_WORKFLOW.states),
            ("planned", "design_review", "running", "experiment_review"),
        )
        self.assertEqual(EXPERIMENT_WORKFLOW.transition("approve_design").to_status, "running")
        self.assertEqual(EXPERIMENT_WORKFLOW.transition("retry_running").to_status, "running")
        self.assertNotIn("ready_to_run", EXPERIMENT_WORKFLOW.transition_names)
        cases = (
            ("design_reviewer", "needs_changes", "", "planned", "new"),
            ("experiment_reviewer", "needs_changes", "planned", "planned", "new"),
            ("experiment_reviewer", "needs_changes", "running", "running", "same"),
        )
        for role, verdict, requested, destination, attempt in cases:
            with self.subTest(role=role, requested=requested):
                route = resolve_review_return(
                    workflow=EXPERIMENT_WORKFLOW,
                    role=role,
                    verdict=verdict,
                    return_to=requested,
                )
                self.assertEqual(
                    (route.to_status, route.attempt), (destination, attempt)
                )

    def test_reflection_states_and_review_returns_project_the_graph(self) -> None:
        self.assertEqual(
            tuple(state.name for state in REFLECTION_WORKFLOW.states),
            ("reflecting", "synthesizing", "reflection_review", "consolidating", "consolidation_review"),
        )
        self.assertIsNone(REFLECTION_WORKFLOW.state("consolidating").review)
        self.assertEqual(REFLECTION_WORKFLOW.review_state("consolidation_reviewer").name, "consolidation_review")
        cases = (
            ("synthesizing", "same"),
            ("reflecting", "new"),
        )
        for destination, attempt in cases:
            with self.subTest(destination=destination):
                route = resolve_review_return(
                    workflow=REFLECTION_WORKFLOW,
                    role="reflection_reviewer",
                    verdict="needs_changes",
                    return_to=destination,
                )
                self.assertEqual(route.attempt, attempt)
        consolidation = resolve_review_return(
            workflow=REFLECTION_WORKFLOW,
            role="consolidation_reviewer",
            verdict="needs_changes",
            return_to="consolidating",
        )
        self.assertEqual(
            (consolidation.to_status, consolidation.attempt),
            ("consolidating", "same"),
        )

    def test_task_states_and_review_routes_project_the_graph(self) -> None:
        self.assertEqual(
            tuple(state.name for state in TASK_WORKFLOW.states),
            ("in_progress", "in_review"),
        )
        self.assertEqual(TASK_WORKFLOW.terminal_statuses, {"done", "failed"})
        back = resolve_review_return(
            workflow=TASK_WORKFLOW,
            role="task_reviewer",
            verdict="needs_changes",
            return_to="",
        )
        self.assertEqual((back.to_status, back.attempt), ("in_progress", "same"))
        for requested in ("", "failed"):
            ended = resolve_review_return(
                workflow=TASK_WORKFLOW,
                role="task_reviewer",
                verdict="fail",
                return_to=requested,
            )
            self.assertEqual(ended.to_status, "failed")
        self.assertEqual(TASK_WORKFLOW.review_fail_statuses, ("failed",))
        self.assertEqual(TASK_WORKFLOW.review_return_statuses, ("in_progress",))

    def test_compatibility_view_preserves_branches_and_cycles(self) -> None:
        from merv.brain.workflows import Edge, Node, Workflow as Graph, metadata
        from merv.brain.research_core.workflow_schema import Workflow

        graph = Graph("revision", 1, "draft", (Node("draft"), Node("review")),
                      (Edge("draft", "submit", "review"), Edge("review", "repair", "draft"),
                       Edge("review", "accept", "done")), {"done": "completed"})
        view = Workflow(graph, metadata.Metadata())
        validate_workflow(view)
        self.assertEqual(view.allowed_transitions_for("review"), [
            {"transition": "repair", "leads_to": "draft"}, {"transition": "accept", "leads_to": "done"}])
        self.assertFalse(hasattr(view, "forward_path"))

    def test_invalid_review_returns_are_rejected_by_the_schema(self) -> None:
        cases = (
            (EXPERIMENT_WORKFLOW, "human", "pass", "planned"),
            (EXPERIMENT_WORKFLOW, "design_reviewer", "needs_changes", "running"),
            (EXPERIMENT_WORKFLOW, "experiment_reviewer", "needs_changes", ""),
            (REFLECTION_WORKFLOW, "reflection_reviewer", "needs_changes", ""),
            (
                REFLECTION_WORKFLOW,
                "consolidation_reviewer",
                "needs_changes",
                "reflecting",
            ),
            (TASK_WORKFLOW, "task_reviewer", "needs_changes", "failed"),
            (TASK_WORKFLOW, "task_reviewer", "fail", "in_progress"),
        )
        for workflow, role, verdict, destination in cases:
            with self.subTest(role=role, destination=destination):
                with self.assertRaises(ValueError):
                    resolve_review_return(
                        workflow=workflow,
                        role=role,
                        verdict=verdict,
                        return_to=destination,
                    )

    def test_review_snapshot_is_deterministic_and_round_trips(self) -> None:
        target = {
            "id": "exp_1",
            "status": "running",
            "attempt_index": 3,
            "current_attempt_artifacts": [
                {"id": "art_b", "role": "report", "attempt_index": 3},
                {"id": "art_a", "role": "plan", "attempt_index": 3},
            ],
        }
        snapshot = review_snapshot_id(target_type="experiment", target=target)
        self.assertEqual(
            snapshot,
            "experiment|exp_1|running|3|art_a:plan:3,art_b:report:3",
        )
        self.assertEqual(
            snapshot_from_id(snapshot_id=snapshot)["artifacts"],
            [
                {"artifact_id": "art_a", "role": "plan", "attempt_index": 3},
                {"artifact_id": "art_b", "role": "report", "attempt_index": 3},
            ],
        )
        consolidation = review_snapshot_id(
            target_type="reflection",
            target={
                "id": "ref_1",
                "status": "consolidating",
                "attempt_index": 1,
                "snapshot_token": "cpr_1",
                "code_sha": "a" * 40,
            },
        )
        self.assertEqual(
            snapshot_from_id(snapshot_id=consolidation),
            {
                "target_type": "reflection",
                "target_id": "ref_1",
                "status": "consolidating",
                "attempt_index": 1,
                "artifacts": [],
                "snapshot_token": "cpr_1",
                "code_sha": "a" * 40,
            },
        )

    def test_synopsis_and_review_exemptions_keep_the_security_envelope(self) -> None:
        valid = (
            "The attempt clears its registered threshold, while the remaining "
            "qualification is narrow enough to preserve the stated conclusion."
        )
        self.assertEqual(validate_synopsis(f"  {valid}  "), valid)
        for invalid in ("too short", "x" * 421, valid + "\nextra", valid + " exp_abc"):
            with self.subTest(invalid=invalid[:20]):
                with self.assertRaises(ValueError):
                    validate_synopsis(invalid)
        self.assertEqual(REVIEW_GATE_EXEMPT_ROLES, {"human", "automated_check"})

    def test_surface_choices_are_derived_from_the_workflows(self) -> None:
        from merv.brain.research_core.tools import (
            ExperimentTransitionInput,
            ReflectionTransitionInput,
            ReviewRequestInput,
            ReviewSubmitInput,
            TaskTransitionInput,
        )

        def choices(model, field: str) -> tuple[str, ...]:
            return tuple(model.model_fields[field].annotation.__args__)

        self.assertEqual(
            choices(ExperimentTransitionInput, "transition"),
            EXPERIMENT_WORKFLOW.transition_names,
        )
        self.assertEqual(
            choices(ReflectionTransitionInput, "transition"),
            REFLECTION_WORKFLOW.transition_names,
        )
        self.assertEqual(
            choices(TaskTransitionInput, "transition"),
            TASK_WORKFLOW.transition_names,
        )
        # Roles and return destinations come from the pinned graph at runtime.
        self.assertIs(ReviewRequestInput.model_fields["role"].annotation, str)
        self.assertIs(ReviewRequestInput.model_fields["target_type"].annotation, str)
        self.assertIs(ReviewSubmitInput.model_fields["return_to"].annotation, str)


if __name__ == "__main__":
    unittest.main()
