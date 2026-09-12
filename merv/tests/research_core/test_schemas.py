"""What the registered graphs declare, and the review routing read off them."""

from __future__ import annotations

import unittest

from merv.brain.kernel.utils import ValidationError
from merv.brain.research_core import EXPERIMENT, REFLECTION, TASK
from merv.brain.research_core.policy import (
    REVIEW_GATE_EXEMPT_ROLES,
    resolve_review_return,
    review_snapshot_id,
    snapshot_from_id,
    validate_synopsis,
)
from merv.brain.workflows import ReviewGate


def _states(kind) -> tuple[str, ...]:
    return tuple(node.name for node in kind.workflow.nodes)


def _leads_to(kind, action: str) -> str:
    return next(edge.target for edge in kind.workflow.edges if edge.name == action)


class WorkflowDeclarationTest(unittest.TestCase):
    def test_every_declaration_names_an_edge_the_graph_actually_has(self) -> None:
        for kind in (EXPERIMENT, REFLECTION, TASK):
            with self.subTest(kind=kind.name):
                edges = {edge.name for edge in kind.workflow.edges}
                self.assertLessEqual(set(kind.metadata.effects), edges)
                # Review verdicts and the runner apply auto edges; the agent's enum omits them.
                self.assertEqual(set(kind.actions), {edge.name for edge in kind.workflow.edges if not edge.auto})
                self.assertFalse(any(edge.tools for edge in kind.workflow.edges if edge.auto))
                for node in kind.workflow.nodes:
                    actions = {edge.name for edge in kind.workflow.edges
                               if edge.source == node.name}
                    destinations = {edge.target for edge in kind.workflow.edges
                                    if edge.source == node.name}
                    for need in node.requires:
                        self.assertLessEqual(set(need.actions), actions)
                        if not isinstance(need, ReviewGate):
                            continue
                        routes = (*need.returns,
                                  *((need.fail_route,) if need.fail_route else ()))
                        for route in routes:
                            self.assertIn(route.to_status, destinations)

    def test_experiment_states_and_review_returns_project_the_graph(self) -> None:
        self.assertEqual(
            _states(EXPERIMENT),
            ("planned", "design_review", "running", "experiment_review"),
        )
        self.assertEqual(_leads_to(EXPERIMENT, "approve_design"), "running")
        self.assertEqual(_leads_to(EXPERIMENT, "retry_running"), "running")
        self.assertNotIn("ready_to_run", EXPERIMENT.actions)
        cases = (
            ("design_reviewer", "needs_changes", "", "planned", "new"),
            ("experiment_reviewer", "needs_changes", "planned", "planned", "new"),
            ("experiment_reviewer", "needs_changes", "running", "running", "same"),
        )
        for role, verdict, requested, destination, attempt in cases:
            with self.subTest(role=role, requested=requested):
                route = resolve_review_return(
                    kind=EXPERIMENT, role=role, verdict=verdict, return_to=requested
                )
                self.assertEqual(
                    (route.to_status, route.attempt), (destination, attempt)
                )

    def test_reflection_states_and_review_returns_project_the_graph(self) -> None:
        self.assertEqual(
            _states(REFLECTION),
            ("reflecting", "synthesizing", "reflection_review", "consolidating",
             "consolidation_review"),
        )
        self.assertFalse(REFLECTION.workflow.node("consolidating").execution.read_only)
        self.assertEqual(
            REFLECTION.review_state("consolidation_reviewer"), "consolidation_review"
        )
        for destination, attempt in (("synthesizing", "same"), ("reflecting", "new")):
            with self.subTest(destination=destination):
                route = resolve_review_return(
                    kind=REFLECTION, role="reflection_reviewer",
                    verdict="needs_changes", return_to=destination,
                )
                self.assertEqual(route.attempt, attempt)
        consolidation = resolve_review_return(
            kind=REFLECTION, role="consolidation_reviewer",
            verdict="needs_changes", return_to="consolidating",
        )
        self.assertEqual(
            (consolidation.to_status, consolidation.attempt),
            ("consolidating", "same"),
        )

    def test_task_states_and_review_routes_project_the_graph(self) -> None:
        self.assertEqual(_states(TASK), ("in_progress", "in_review"))
        self.assertEqual(TASK.terminal_statuses, {"done", "failed"})
        back = resolve_review_return(
            kind=TASK, role="task_reviewer", verdict="needs_changes", return_to=""
        )
        self.assertEqual((back.to_status, back.attempt), ("in_progress", "same"))
        for requested in ("", "failed"):
            ended = resolve_review_return(
                kind=TASK, role="task_reviewer", verdict="fail", return_to=requested
            )
            self.assertEqual(ended.to_status, "failed")
        self.assertEqual(
            tuple(gate.fail_route.to_status for gate in TASK.review_gates
                  if gate.fail_route is not None),
            ("failed",),
        )
        self.assertEqual(
            tuple(route.to_status for route in TASK.review_returns), ("in_progress",)
        )

    def test_invalid_review_returns_are_rejected_by_the_schema(self) -> None:
        cases = (
            (EXPERIMENT, "human", "pass", "planned"),
            (EXPERIMENT, "design_reviewer", "needs_changes", "running"),
            (EXPERIMENT, "experiment_reviewer", "needs_changes", ""),
            (REFLECTION, "reflection_reviewer", "needs_changes", ""),
            (REFLECTION, "consolidation_reviewer", "needs_changes", "reflecting"),
            (TASK, "task_reviewer", "needs_changes", "failed"),
            (TASK, "task_reviewer", "fail", "in_progress"),
        )
        for kind, role, verdict, destination in cases:
            with self.subTest(role=role, destination=destination):
                with self.assertRaises(ValidationError):
                    resolve_review_return(
                        kind=kind, role=role, verdict=verdict, return_to=destination
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

        self.assertEqual(choices(ExperimentTransitionInput, "transition"), EXPERIMENT.actions)
        self.assertEqual(choices(ReflectionTransitionInput, "transition"), REFLECTION.actions)
        self.assertEqual(choices(TaskTransitionInput, "transition"), TASK.actions)
        # Roles and return destinations come from the pinned graph at runtime.
        self.assertIs(ReviewRequestInput.model_fields["role"].annotation, str)
        self.assertIs(ReviewRequestInput.model_fields["target_type"].annotation, str)
        self.assertIs(ReviewSubmitInput.model_fields["return_to"].annotation, str)


if __name__ == "__main__":
    unittest.main()
