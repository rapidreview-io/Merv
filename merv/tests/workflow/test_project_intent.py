"""User intent reaches every research role without becoming workflow policy."""

import unittest

from merv.brain.programs import INSTALLED
from merv.brain.surface.transport.http_policy import SessionExecution
from merv.brain.workflows import Snapshot
from tests.research_core.scenarios import ResearchCase


INTENT = "Background: a user-defined problem. " * 100 + "\nGoal: understand it.\nScope: only the stated setting."


class IntentFacts:
    def __init__(self, summary):
        self.summary = summary

    def read(self, reference):
        if reference.kind == "project":
            return {"id": "proj_1", "name": "Full intent", "summary": self.summary, "literature": {"body": "Canonical literature body."},
                    "methods": "Causal methods account.", "results": "Established and contrary findings."}
        if reference.kind == "experiment":
            return {"id": reference.id, "name": "assigned-test", "intent": "Test the mechanism",
                    "attempt_index": 2, "revision_context": "Keep the approved control"}
        if reference.kind == "task":
            return {"id": reference.id, "name": "assigned-task", "goal": "Prepare the dataset",
                    "deliverables": ["A verified dataset"], "revision_context": "Repair the parser"}
        if reference.kind == "reflection":
            return {"id": reference.id, "title": "Fixed research corpus", "attempt_index": 2,
                    "roster": [{"id": "amplify", "charter": "Inspect retained wins"}]}
        if reference.kind == "review_snapshot":
            return {"request_id": "rev_1", "artifacts": [{"id": "art_pinned", "role": "plan"}]}
        if reference.kind == "review_history":
            return {"reviews": []}
        raise AssertionError(reference)


class ProjectIntentRolesTest(unittest.TestCase):
    def test_all_installed_agent_nodes_receive_full_intent_and_lack_the_writer(self):
        covered = set()
        for program in INSTALLED:
            for workflow in program.workflows:
                for node in workflow.nodes:
                    if not node.role:
                        continue
                    covered.add((workflow.name, node.name))
                    snapshot = Snapshot(id="record_1", project_id="proj_1", workflow=workflow.name,
                        version=workflow.version, state=node.name, revision=1,
                        data={"lens_id": "amplify", "attempt_index": 2, "reflection_id": "wave_1", "source": {"events": [],
                            "references": [{"kind": "experiment", "id": "record_1", "label": "Pinned approach"}]}})
                    full = node.build_context(snapshot, IntentFacts(INTENT))
                    empty = node.build_context(snapshot, IntentFacts(""))
                    assert "Canonical literature body." in full.summary
                    assert "Causal methods account." in full.summary
                    assert "Established and contrary findings." in full.summary
                    assert INTENT in full.summary, (workflow.name, node.name)
                    assert "ask the user focused questions" in full.summary
                    assert "never invent intent" in full.summary
                    assert "## Introduction\n" + INTENT in full.summary
                    assert full.summary.index("## Introduction") < full.summary.index("## Literature")
                    assert full.references == empty.references
                    assert full.references, (workflow.name, node.name)
                    policy = SessionExecution.from_packet(node.execution.public())
                    assert "project" in policy.allowed_tools
                    assert "project.context.update" not in policy.allowed_tools
                    assert "project.update" not in policy.allowed_tools
                    if workflow.name == "experiment":
                        assert "Test the mechanism" in full.summary
                        assert "Keep the approved control" in full.summary
                    if workflow.name == "task":
                        assert "Prepare the dataset" in full.summary
                    if "review" in node.name:
                        assert any(ref.id == "art_pinned" for ref in full.references)
        assert {name for name, _ in covered} == {"experiment", "task", "reflection", "reflection_lens", "project_synthesis"}


class ProjectIntentDeliveryTest(ResearchCase):
    def test_current_context_status_assignment_and_begin_keep_full_intent_without_a_gate(self):
        experiment = self.call("experiment.create", project_id=self.project_id,
                               name="intent-context", intent="Keep this experiment-specific ask")
        task = self.call("task.create", project_id=self.project_id, name="intent-task",
                         goal="Keep this task-specific goal", deliverables=["A retained dataset"])
        args = {"project_id": self.project_id, "instance_id": experiment["id"]}
        before = self.call("workflow.status_and_next", **args)
        self.call("project.context.update", project_id=self.project_id, summary=INTENT, expected_summary="")
        after = self.call("workflow.status_and_next", **args)
        self.assertEqual(before["workflow"], after["workflow"])
        self.assertIn(INTENT, after["context"]["brief"])
        for fields, child in (({"experiment_id": experiment["id"]}, "experiment"),
                              ({"task_id": task["id"]}, "task")):
            status = self.call("workflow.status_and_next", project_id=self.project_id, **fields)
            self.assertEqual(status["project"]["summary"], INTENT)
            self.assertIn(child, status["context"])
        for tool, extra in (("workflow.assignment", {}),
                            ("workflow.begin", {"expected_revision": after["workflow"]["revision"]})):
            packet = self.call(tool, **args, **extra)
            self.assertIn(INTENT, packet["brief"])
            self.assertIn("Keep this experiment-specific ask", packet["brief"])
        overview = self.call("project", action="overview", project_id=self.project_id)
        self.assertEqual(overview["project"]["summary"], INTENT)
        listed = self.call("project", action="list")["projects"]
        self.assertEqual(next(p for p in listed if p["id"] == self.project_id)["summary"], INTENT)
