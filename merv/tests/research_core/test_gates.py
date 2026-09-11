"""One resolver per requirement kind, and the single checklist item they produce."""

from __future__ import annotations

import unittest

from merv.brain.research_core.policy import GateContext, resolve_requirement
from merv.brain.programs import PROGRAM
from merv.brain.research_core import EXPERIMENT, REFLECTION, TASK
from merv.brain.workflows import (
    ArtifactNeed, DependenciesDone, Issue, RecordNeed, ReviewGate, Snapshot,
)

from .scenarios import VALID_PLAN, ResearchCase

# Every checklist item the UI and the agent presenters read, whatever its kind.
COMMON_KEYS = frozenset({"id", "kind", "role", "label", "satisfied", "status", "gate", "action"})

PLAN = EXPERIMENT.requirements("planned")[0]
DEPENDENCIES = next(need for need in TASK.requirements("in_progress")
                    if isinstance(need, DependenciesDone))
PROPOSAL = next(need for need in REFLECTION.requirements("consolidating")
                if isinstance(need, RecordNeed))


def context(record=None, *, issues=(), state="planned") -> GateContext:
    return GateContext(record=record or {"id": "rec_1", "project_id": "proj_1"},
                       snapshot=Snapshot(id="rec_1", project_id="proj_1", workflow="experiment", version=1,
                                         state=state, revision=0),
                       issues=tuple(issues))


class RequirementResolverTest(unittest.TestCase):
    """The resolvers read the evaluation that already ran; none re-derives a fact."""

    def test_an_artifact_need_reads_missing_invalid_and_valid_from_the_evaluation(self) -> None:
        missing = resolve_requirement(PLAN, context(issues=(PLAN.issue(),))).items[0]
        self.assertEqual((missing["id"], missing["kind"], missing["status"], missing["satisfied"]),
                         ("artifact:plan", "artifact", "missing", False))
        self.assertEqual(missing["missing"], PLAN.missing)
        self.assertEqual(missing["gate"], PLAN.gate)

        invalid = resolve_requirement(PLAN, context(
            record={"id": "rec_1", "project_id": "proj_1",
                    "current_attempt_artifacts": [{"id": "ra_1", "role": "plan", "path": "plan.md"}]},
            issues=(Issue("plan_invalid", "experiment plan artifact: no Summary"),))).items[0]
        self.assertEqual((invalid["status"], invalid["satisfied"]), ("invalid", False))
        self.assertEqual(invalid["problems"], ["experiment plan artifact: no Summary"])
        self.assertEqual((invalid["artifact_id"], invalid["path"]), ("ra_1", "plan.md"))

        valid = resolve_requirement(PLAN, context(
            record={"id": "rec_1", "project_id": "proj_1",
                    "current_attempt_artifacts": [{"id": "ra_1", "role": "plan", "path": "plan.md"}]})).items[0]
        self.assertEqual((valid["status"], valid["satisfied"]), ("valid", True))
        self.assertNotIn("missing", valid)
        self.assertEqual(valid["validator"], "plan")

    def test_a_need_without_a_validator_reports_presence_not_validity(self) -> None:
        result = EXPERIMENT.requirements("running")
        need = next(item for item in result if isinstance(item, ArtifactNeed) and item.role == "result")
        item = resolve_requirement(need, context(
            record={"id": "rec_1", "project_id": "proj_1",
                    "current_attempt_artifacts": [{"id": "ra_2", "role": "result"}]}, state="running")).items[0]
        self.assertEqual(item["status"], "present")
        self.assertNotIn("validator", item)

    def test_the_dependency_item_lists_every_edge_with_its_settled_flag(self) -> None:
        rows = [{"id": "task_1", "node_type": "task", "name": "prep", "status": "done", "settled": True},
                {"id": "task_2", "node_type": "task", "name": "label", "status": "in_progress", "settled": False}]
        blocked = resolve_requirement(DEPENDENCIES, context(
            record={"id": "rec_1", "project_id": "proj_1", "dependencies": rows},
            issues=(Issue("dependencies_pending", "Work is waiting on unfinished dependencies: task label."),)))
        item = blocked.items[0]
        self.assertEqual((item["id"], item["kind"], item["satisfied"]), ("record:dependencies", "record", False))
        self.assertEqual([entry["id"] for entry in item["dependencies"]], ["task_1", "task_2"])
        self.assertEqual([entry["settled"] for entry in item["dependencies"]], [True, False])
        self.assertEqual(blocked.blocker_code, "dependencies_pending")

        settled = resolve_requirement(DEPENDENCIES, context(
            record={"id": "rec_1", "project_id": "proj_1", "dependencies": rows[:1]})).items[0]
        self.assertTrue(settled["satisfied"])
        self.assertEqual(settled["missing"], "")

    def test_a_record_need_reports_the_issue_its_own_graph_check_raised(self) -> None:
        blocked = resolve_requirement(PROPOSAL, context(issues=(PROPOSAL.issue(),), state="consolidating"))
        item = blocked.items[0]
        self.assertEqual((item["id"], item["kind"], item["satisfied"]),
                         ("record:consolidation_proposal", "record", False))
        self.assertEqual(item["missing"], PROPOSAL.missing)
        self.assertTrue(resolve_requirement(PROPOSAL, context(state="consolidating")).items[0]["satisfied"])

    def test_every_declared_requirement_produces_one_item_with_the_shared_keys(self) -> None:
        for kind in PROGRAM.kinds:
            for node in kind.workflow.nodes:
                for need in node.requires:
                    if isinstance(need, ReviewGate):
                        continue  # Needs its own rows; covered by ReviewGateTest.
                    with self.subTest(kind=kind.name, state=node.name, need=need.key):
                        items = resolve_requirement(need, context(state=node.name)).items
                        self.assertEqual(len(items), 1)
                        self.assertTrue(COMMON_KEYS <= set(items[0]), items[0])
                        self.assertEqual(items[0]["id"].split(":", 1)[1], need.key)


class ReviewGateTest(ResearchCase):
    """The one resolver that reads its own rows: a verdict and its open request."""

    def test_the_review_item_tracks_the_request_then_the_verdict(self) -> None:
        experiment_id = self.create_experiment("review-gate")
        self.submit(target_type="experiment", target_id=experiment_id, role="plan",
                    path="plan.md", body=VALID_PLAN)
        self.transition_experiment(experiment_id, "submit_design")
        state = self.call("experiment.get_state", project_id=self.project_id, experiment_id=experiment_id)
        item = next(entry for entry in state["gate_checklist"]["items"] if entry["kind"] == "review")
        self.assertEqual((item["id"], item["role"], item["satisfied"], item["status"]),
                         ("review:design_reviewer", "design_reviewer", False, "pending"))
        self.assertEqual(item["skill"], "experiment-design-review")
        self.assertEqual(item["action"], "launch_design_reviewer")

        self.pass_review(target_type="experiment", target_id=experiment_id, role="design_reviewer")
        approved = self.call("experiment.get_state", project_id=self.project_id, experiment_id=experiment_id)
        self.assertEqual(approved["status"], "running")

    def test_an_unrequested_review_blocks_dispatch_of_its_own_node(self) -> None:
        experiment_id = self.create_experiment("undispatchable")
        self.submit(target_type="experiment", target_id=experiment_id, role="plan",
                    path="plan.md", body=VALID_PLAN)
        self.transition_experiment(experiment_id, "submit_design")
        evaluation = self.app.workflows.runtime.evaluate(
            project_id=self.project_id, instance_id=experiment_id).public()
        self.assertFalse(evaluation["dispatchable"])
        self.assertEqual([issue["code"] for issue in evaluation["dispatch_blockers"]], ["review_not_requested"])


if __name__ == "__main__":
    unittest.main()
