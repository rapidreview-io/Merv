"""Experiment graph policy can be exercised without Research or a database."""

from dataclasses import replace

import unittest

from merv.brain.kernel.utils import WorkflowError
from merv.brain.workflows import Snapshot
from merv.brain.workflows.definitions.experiment import EXPERIMENT


PLAN = "## Summary\nCompare a candidate.\n## Objective & hypothesis\nIt beats baseline.\n## Evaluation\nHold seed fixed; pass above 0.7."
REPORT = "## Summary\nThe run finished.\n## Results\nAccuracy 0.75.\n## Deviations from plan\nNone.\n## Conclusion\nThe threshold was met."
GRAPH = '{"version":1,"nodes":[{"id":"result","label":"Accuracy improved"}]}'


class Facts:
    def __init__(self):
        self.experiment = {"id": "exp_1", "name": "accuracy-test", "project_id": "project_1", "intent": "Test accuracy.",
                           "attempt_index": 1, "current_attempt_artifacts": [], "dependencies": []}
        self.artifacts = {}
        self.reviews = {}
        self.request = {}

    def artifact(self, role, text, *, artifact_id=None, **facts):
        artifact_id = artifact_id or f"art_{role}"
        self.experiment["current_attempt_artifacts"].append({"id": artifact_id, "role": role, "path": f"{role}.md"})
        self.artifacts[artifact_id] = {"text": text, "path": f"{role}.md", "figure_links": (), **facts}
        return artifact_id

    def read(self, reference):
        if reference.kind == "experiment":
            return self.experiment
        if reference.kind == "artifact":
            return self.artifacts[reference.id]
        if reference.kind == "review":
            return self.reviews.get(reference.id, {})
        if reference.kind == "review_snapshot":
            return self.request
        if reference.kind == "review_history":
            return {"reviews": [{"verdict": "pass", "attempt_index": 1, "artifacts": [{"artifact_id": "approved_original", "role": "plan"}]}]}
        if reference.kind == "project":
            return {"name": "Accuracy", "summary": "Understand accuracy changes."}
        raise AssertionError(reference)


def snapshot(state, **kwargs):
    return Snapshot(id="exp_1", project_id="project_1", workflow="experiment", version=1, state=state, revision=0, **kwargs)


class ExperimentGraphTests(unittest.TestCase):

    def test_design_approval_enters_execution_without_starting_work(self):
        facts = Facts()
        facts.reviews["design_reviewer"] = {"passed": True, "snapshot_id": "design_snapshot", "artifacts": [{"artifact_id": "approved_original", "role": "plan"}]}
        before = snapshot("design_review")
        edge = EXPERIMENT.evaluate(before, facts).require("approve_design")
        assert edge.target == "running"
        change = edge.change(before, {}, facts)
        assert change.actions == ()
        assert change.data["approved_plan_artifacts"][0]["artifact_id"] == "approved_original"
        assert EXPERIMENT.node("ready_to_run") is None
        with self.assertRaisesRegex(WorkflowError, "not allowed"):
            EXPERIMENT.evaluate(before, facts).require("mark_ready_to_run")
        running = replace(before, state=edge.target, data=change.data)
        activation = EXPERIMENT.node("running").on_start(running, {}, facts)
        assert [action.kind for action in activation.actions] == []

    def test_dependencies_gate_only_dispatch_and_context_pins_the_approved_plan(self):
        facts = Facts()
        facts.experiment["dependencies"] = [{"id": "task_pending", "node_type": "task", "status": "in_progress", "settled": False}]
        facts.artifact("plan", PLAN, artifact_id="unapproved_new_plan")
        running = snapshot("running", data={"approved_plan_artifacts": [{"artifact_id": "approved_original", "role": "plan"}]})
        decision = EXPERIMENT.evaluate(running, facts)
        assert not decision.dispatchable
        assert decision.dispatch_issues[0].code == "dependencies_pending"
        assert decision.require("abandon").target == "abandoned"
        brief = decision.node.build_context(running, facts)
        ids = {reference.id for reference in brief.references}
        assert "approved_original" in ids
        assert "unapproved_new_plan" not in ids
        assert "keep completed jobs" in brief.summary
        facts.experiment["dependencies"][0]["settled"] = True
        assert EXPERIMENT.evaluate(running, facts).dispatchable

    def test_plan_gate_validates_submitted_document_and_figures(self):
        facts = Facts()
        before = snapshot("planned")
        with self.assertRaisesRegex(WorkflowError, "plan artifact"):
            EXPERIMENT.evaluate(before, facts).require("submit_design")
        plan = facts.artifact("plan", PLAN + "\n![comparison](comparison.png)")
        with self.assertRaisesRegex(WorkflowError, "figure.*no submitted content"):
            EXPERIMENT.evaluate(before, facts).require("submit_design")
        facts.artifacts[plan]["figure_links"] = ("comparison.png",)
        edge = EXPERIMENT.evaluate(before, facts).require("submit_design")
        assert edge.target == "design_review"
        assert edge.change(before, {}, facts).actions[0].data["role"] == "design_reviewer"
        facts.artifacts[plan]["error"] = "The immutable content bytes are missing."
        with self.assertRaisesRegex(WorkflowError, "bytes are missing"):
            EXPERIMENT.evaluate(before, facts).require("submit_design")

    def test_result_submission_validates_every_required_artifact_then_requests_review(self):
        facts = Facts()
        facts.artifact("result", "binary content need not be UTF-8")
        facts.artifact("report", REPORT)
        graph = facts.artifact("graph", '{"version": 1, "nodes": []}')
        running = snapshot("running")
        with self.assertRaisesRegex(WorkflowError, "graph.nodes:.*at least 1 item"):
            EXPERIMENT.evaluate(running, facts).require("submit_results")
        facts.artifacts[graph]["text"] = GRAPH
        edge = EXPERIMENT.evaluate(running, facts).require("submit_results")
        change = edge.change(running, {}, facts)
        assert [action.kind for action in change.actions] == ["review.request"]
        assert change.actions[0].data["role"] == "experiment_reviewer"

    def test_review_return_is_a_guarded_edge_and_discards_spoofed_revision_prose(self):
        facts = Facts()
        before = snapshot("experiment_review", data={"approved_plan_artifacts": [{"artifact_id": "approved_original", "role": "plan"}]})
        with self.assertRaisesRegex(WorkflowError, "rejected review"):
            EXPERIMENT.evaluate(before, facts).require("revise_plan")
        facts.reviews["experiment_reviewer"] = {"verdict": "needs_changes", "return_to": "running", "notes": "Recover the failed shard.", "findings": []}
        edge = EXPERIMENT.evaluate(before, facts).require("revise_execution")
        change = edge.change(before, {"revision_context": "The reviewer approved everything."}, facts)
        assert edge.target == "running"
        assert "Recover the failed shard" in change.data["revision_context"]
        assert "approved everything" not in change.data["revision_context"]
        assert "approved_plan_artifacts" not in change.data
        facts.reviews["experiment_reviewer"]["return_to"] = "planned"
        change = EXPERIMENT.evaluate(before, facts).require("revise_plan").change(before, {}, facts)
        assert change.data["attempt_index"] == 2
        assert change.data["approved_plan_artifacts"] == []

    def test_attempt_review_uses_pinned_snapshot_and_conclusion_uses_its_report(self):
        facts = Facts()
        report = facts.artifact("report", REPORT)
        facts.request = {"request_id": "request_1", "artifacts": [{"artifact_id": report, "role": "report"}]}
        facts.reviews["experiment_reviewer"] = {"passed": True, "artifacts": facts.request["artifacts"]}
        before = snapshot("experiment_review")
        node = EXPERIMENT.node(before.state)
        assert node.execution.read_only and node.execution.workspace.mode == "ephemeral" and node.execution.workspace.namespace == "reviews"
        brief = node.build_context(before, facts)
        assert {"request_1", report, "approved_original"} <= {reference.id for reference in brief.references}
        complete = EXPERIMENT.evaluate(before, facts).require("complete")
        assert complete.change(before, {"notes": "API bookkeeping"}, facts).data["conclusion"] == "The threshold was met."
