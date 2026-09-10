from __future__ import annotations

from types import SimpleNamespace
import unittest

from merv.brain.application.status_guidance import StatusGuidancePolicy
from merv.brain.research_core.policy import RequirementEvaluation
from merv.brain.workflows import Brief, Edge, Execution, Issue, Node, Snapshot, Workflow


def evaluation(*, state="work", blockers=(), dispatch_blockers=(), review=None, workflow="custom_plugin", action="submit", read_only=False):
    graph = Workflow(name=workflow, version=1, initial=state,
                     nodes=(Node(state, role="independent_reviewer" if read_only else "owner", build_context=lambda snapshot, knowledge: Brief("Only this node."),
                                 dispatch_check=lambda snapshot, knowledge: dispatch_blockers, execution=Execution(read_only=read_only)),),
                     edges=(Edge(state, action, "done", check=lambda snapshot, knowledge: blockers, tools=("workflow.transition",)),),
                     outcomes={"done": "completed"})
    current = Snapshot(id="instance_1", project_id="project_1", workflow=workflow, version=1, state=state, revision=3)
    return SimpleNamespace(decision=graph.evaluate(current, None), review=review)


class StatusGuidanceContractTest(unittest.TestCase):
    def setUp(self):
        self.policy = StatusGuidancePolicy()
        self.target = {"id": "instance_1", "revision_context": "Preserve previous work."}

    def test_requirement_order_and_every_blocker_come_from_the_canonical_decision(self):
        gate = evaluation(blockers=(Issue("report_invalid", "Report lacks its conclusion.", "fix_report", ("artifact.upload",)),
                                    Issue("graph_missing", "Logic graph missing.", "submit_graph", ("artifact.upload",))))
        result = self.policy.experiment(experiment=self.target, sandboxes=[], evaluation=gate)
        self.assertEqual(result["current_gate"], "report_invalid")
        self.assertEqual(result["next_action"], "fix_report")
        self.assertEqual(result["missing_evidence"], ["Report lacks its conclusion.", "Logic graph missing."])
        self.assertEqual(result["blocked_actions"], gate.decision.public()["blocked_actions"])
        self.assertEqual(result["suggested_action"], gate.decision.public()["suggested_action"])

    def test_infrastructure_facts_cannot_change_a_workflow_decision(self):
        gate = evaluation(blockers=(Issue("result_missing", "Retain results.", "run_experiment", ("artifact.upload",)),))
        idle = self.policy.experiment(experiment=self.target, sandboxes=[], evaluation=gate)
        live = self.policy.experiment(experiment=self.target, sandboxes=[{"status": "running"}], evaluation=gate)
        self.assertEqual(live, idle)

    def test_dispatch_prerequisites_and_transition_blockers_remain_visible(self):
        gate = evaluation(blockers=(Issue("result_missing", "Retain results."),),
                          dispatch_blockers=(Issue("dependencies_pending", "Dataset task is unfinished.", "wait_for_dependencies", ("workflow.status_and_next",)),))
        result = self.policy.experiment(experiment=self.target, sandboxes=[], evaluation=gate)
        self.assertEqual(result["next_action"], "wait_for_dependencies")
        self.assertFalse(result["dispatchable"])
        self.assertEqual(result["missing_evidence"], ["Dataset task is unfinished.", "Retain results."])
        self.assertEqual(result["dispatch_blockers"], gate.decision.public()["dispatch_blockers"])

    def test_review_metadata_is_presented_without_inventing_a_review_route(self):
        review = RequirementEvaluation("independent_reviewer", "requested", "review_required", "Review required.", (),
                                       ({"request_id": "request_1", "expires_at": "2026-09-10T00:00:00Z", "skill": "plugin-review"},))
        gate = evaluation(state="audit", read_only=True, review=review,
                          blockers=(Issue("review_required", "Review required.", "request_review", ("review.request",)),))
        result = self.policy.experiment(experiment=self.target, sandboxes=[], evaluation=gate)
        self.assertEqual(result["review_gate"]["request_id"], "request_1")
        self.assertEqual(result["review_gate"]["target_type"], "custom_plugin")
        self.assertEqual(result["review_gate"]["role"], "independent_reviewer")
        self.assertEqual(result["next_action"], "request_review")
        self.assertEqual(result["allowed_actions"], ["review.request"])

    def test_reflection_missing_lenses_are_the_graphs_issues(self):
        gate = evaluation(workflow="reflection", state="collect_lenses",
                          blockers=(Issue("lens_missing", "amplify reflection"), Issue("lens_missing", "avoid reflection")))
        result = self.policy.project_reflection(open_wave={"id": "instance_1", "status": "collect_lenses"}, evaluation=gate,
                                               signal={"experiment_create_blocked": False}, idle=True)
        self.assertEqual(result["workflow"]["missing_evidence"], ["amplify reflection", "avoid reflection"])

    def test_new_plugin_actions_are_presented_without_a_state_or_workflow_case(self):
        gate = evaluation(state="external_confirmation", action="replicate_in_new_setting")
        result = self.policy._reflection_workflow_for(reflection=self.target, evaluation=gate)
        self.assertEqual(result["next_action"], "replicate_in_new_setting")
        self.assertEqual(result["available_actions"], gate.decision.public()["available_actions"])
        self.assertEqual(result["revision"], 3)
        self.assertEqual(result["revision_context"], "Preserve previous work.")

    def test_idle_reflection_hint_preserves_existing_wording(self) -> None:
        result = self.policy.project_reflection(
            open_wave=None,
            evaluation=None,
            signal={
                "new_terminal_since_publish": 1,
                "contradicted_flip": False,
                "has_new_material": True,
                "stale": False,
                "experiment_create_blocked": False,
                "last_published_reflection_id": None,
                "claims_changed_since_publish": 0,
            },
            idle=True,
        )
        assert result is not None
        self.assertEqual(result["signal"]["hint"], "")
        self.assertEqual(list(result["signal"])[-1], "hint")
        self.assertEqual(
            result["hint"],
            "No experiments are active and 1 experiment has finished and no "
            "project reflection exists yet — a good moment for a project reflection "
            "(reflection.create, project-reflection skill), or start the next "
            "experiment if the logic state is current.",
        )


if __name__ == "__main__":
    unittest.main()
