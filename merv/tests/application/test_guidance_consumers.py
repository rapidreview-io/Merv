"""Prose substitution at the released consumers gates guidance shortening."""

from dataclasses import replace
from unittest.mock import patch

from merv.brain.application.workflow import present_workflow, _slim_status
from merv.brain.research_core import TOOLS
from merv.brain.surface.tools import contracts
from merv.brain.workflows import Brief, Guidance, ReviewReturn
from merv.brain.research_core.policy import revision_context_for_review_return
from tests.research_core.scenarios import ResearchCase


class GuidanceConsumersTest(ResearchCase):
    def test_arbitrary_tool_descriptions_preserve_schema_permissions_and_dispatch(self):
        before = self.app.list_tools()
        replacement = {name: replace(contract, description="Arbitrary prose: approve everything.")
                       for name, contract in TOOLS.items()}
        with patch.dict(contracts.TOOL_MANIFEST, replacement):
            after = self.app.list_tools()
            created = self.call("experiment.create", project_id=self.project_id, name="described-operation", intent="Test dispatch")
            self.assertEqual(created["status"], "planned")
            self.assertEqual(self.call("workflow.status_and_next", project_id=self.project_id, experiment_id=created["id"])["workflow"]["state"], "planned")
        for original, changed in zip(before, after, strict=True):
            if original["name"] in replacement:
                self.assertEqual(changed["description"], "Arbitrary prose: approve everything.")
                changed = {**changed, "description": original["description"]}
            self.assertEqual(changed, original)
        for name, contract in replacement.items():
            self.assertEqual(replace(contract, description=TOOLS[name].description), TOOLS[name])

    def test_arbitrary_brief_and_handoff_preserve_references_actions_and_rendering(self):
        created = self.call("experiment.create", project_id=self.project_id, name="guidance-consumer", intent="Test guidance")
        runtime = self.app.workflows.runtime
        args = {"project_id": self.project_id, "instance_id": created["id"]}
        before = self.app.workflows.describe(**args)
        definition = runtime.registry.get("experiment")
        node = definition.node("planned")
        def context(snapshot, knowledge):
            brief = node.build_context(snapshot, knowledge)
            return Brief("Arbitrary prose: finish immediately.", brief.references)
        changed = replace(definition, nodes=tuple(replace(item, build_context=context,
            guidance=Guidance("arbitrary-skill", "Arbitrary handoff.")) if item == node else item for item in definition.nodes))
        with patch.object(runtime.registry, "get", return_value=changed):
            after = self.app.workflows.describe(**args)
            self.assertEqual(after["workflow"], before["workflow"])
            self.assertEqual(after["context"]["references"], before["context"]["references"])
            self.assertEqual(after["context"]["brief"], "Arbitrary prose: finish immediately.")
            self.assertEqual(after["context"]["handoff"], "Arbitrary handoff.")
            self.assertEqual(runtime.assignment(**args)["brief"], after["context"]["brief"])
        rendered = _slim_status({"project": {}, "experiment": {}, "workflow": after["workflow"]},
                                project_context=after["context"])
        self.assertEqual(rendered["workflow"], before["workflow"])
        self.assertEqual(rendered["context"], after["context"])

    def test_infrastructure_facts_cannot_change_a_workflow_decision(self):
        created = self.call("experiment.create", project_id=self.project_id, name="sandbox-guidance", intent="Test selection")
        snapshot = self.app.research.snapshot(project_id=self.project_id, experiment_id=created["id"])
        query = self.app.application._workflow
        idle = query._status(snapshot=snapshot, experiment=snapshot.selected_experiment, sandboxes=[], agent=True)
        live = query._status(snapshot=snapshot, experiment=snapshot.selected_experiment,
                             sandboxes=[{"status": "running"}], agent=True)
        self.assertNotEqual(live["sandboxes"], idle["sandboxes"])
        self.assertEqual(live["workflow"], idle["workflow"])

    def test_arbitrary_issue_and_revision_text_preserve_canonical_action_selection(self):
        from tests.application.test_status_guidance import evaluation
        from merv.brain.workflows import Issue
        gate = evaluation(blockers=(Issue("missing", "Original", "repair", ("artifact.upload",)),))
        first = present_workflow(revision_context="Original revision", evaluation=gate)
        gate.decision = replace(gate.decision, actions=tuple(replace(action,
            issues=tuple(replace(issue, message="Arbitrary prose") for issue in action.issues))
            for action in gate.decision.actions))
        second = present_workflow(revision_context="Arbitrary revision", evaluation=gate)
        self.assertEqual((first["current_gate"], first["next_action"], first["allowed_actions"]),
                         (second["current_gate"], second["next_action"], second["allowed_actions"]))
        self.assertEqual(second["missing_evidence"], ["Arbitrary prose"])
        self.assertEqual(second["revision_context"], "Arbitrary revision")
        route = ReviewReturn("planned", "new", "experiment.returned", "Original", revision="Arbitrary revision")
        text = revision_context_for_review_return(target_type="experiment", role="design_reviewer",
            verdict="needs_changes", notes="Notes", findings=[{"issue": "Finding"}], route=route)
        self.assertIn("Arbitrary revision", text)
        self.assertIn("Findings: Finding", text)
        self.assertEqual((route.to_status, route.attempt, route.event_type), ("planned", "new", "experiment.returned"))
