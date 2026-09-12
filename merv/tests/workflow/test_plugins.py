"""Plugins run through the released tool dispatcher, including native task children."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tempfile
import unittest

from merv.brain.application.workflow_actions import WorkflowDeliveries
from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.tools import ProjectScopedInput, ToolContract
from merv.brain.kernel.utils import WorkflowError
from merv.brain.programs import PROGRAM
from merv.brain.research_core.policy import (
    RESOLVERS, GateContext, RequirementEvaluation, resolve_requirement,
)
from merv.brain.surface.tools.contracts import build_manifest
from merv.brain.workflows import (
    Action, Brief, Change, Child, Edge, Guidance, Issue, Node, Program, Snapshot, Workflow, Workflows, join_guard,
)
from tests.research_core.scenarios import ResearchCase
from tests.research_core.test_tasks import DELIVERABLES, VALID_DELIVERY


@dataclass(frozen=True, slots=True)
class Calibrated:
    """A requirement class the graph has never heard of, brought by its program."""

    actions: tuple[str, ...] = ("publish",)
    dispatch: bool = False
    key: str = "calibrated"

    def check(self, snapshot, knowledge):
        if snapshot.data.get("reading") is None:
            return Issue("uncalibrated", "Record a reading before publishing.", "record", ("workflow.transition",))
        return None

    dispatch_check = check


def _notify(snapshot, payload, knowledge):
    return Change(actions=(Action("calibration.notify", {"instance_id": snapshot.id}),))


CALIBRATION = Program(
    name="calibration", version=1,
    workflows=(Workflow(
        name="calibration", version=1, initial="calibrate",
        nodes=(Node("calibrate", role="technician", guidance=Guidance("instrument-operation", "Leave the reading for the operator.", messages={"setup": "Zero the sensor."}), requires=(Calibrated(),),
                    build_context=lambda snapshot, knowledge: Brief("Calibrate the instrument.")),),
        edges=(Edge("calibrate", "record", "calibrate",
                    change=lambda snapshot, payload, knowledge: Change(data={"reading": payload.get("reading")})),
               Edge("calibrate", "publish", "published", change=_notify)),
        outcomes={"published": "calibrated"},
        outcome_guidance={"calibrated": Guidance("instrument-operation", messages={"summary": "Instrument ready."})},
    ),),
    effects=("calibration.notify",),
    requirements=(Calibrated,),
    tools={"calibration.status": ToolContract(
        input_model=ProjectScopedInput, handler_identity="calibration.status",
        description="Read the instrument's last calibration.")},
)


class WorkflowPluginTest(ResearchCase):
    def test_program_orientation_is_optional_and_application_projects_its_result(self):
        from dataclasses import replace
        self.app.research.program = CALIBRATION
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(status["workflow"], {})
        self.app.research.program = replace(CALIBRATION, orientation=lambda snapshot, **facts:
            {"workflow": {"current_gate": "instrument_setup", "next_action": "calibrate", "hint": "Any prose."}})
        status = self.call("workflow.status_and_next", project_id=self.project_id)
        self.assertEqual(status["workflow"], {"current_gate": "instrument_setup", "next_action": "calibrate", "hint": "Any prose."})

    def test_native_creation_interprets_a_second_programs_requirement_and_reserved_bypass(self):
        from dataclasses import replace
        from unittest.mock import patch
        from merv.brain.workflows import TASK_KIND
        class Permit:
            def check(self, facts):
                return Issue("permit_required", "An instrument permit is required.")
        kind = replace(TASK_KIND, creation_requires=(Permit(),))
        with patch("merv.brain.research_core.tasks.TASK", kind):
            with self.assertRaisesRegex(WorkflowError, "instrument permit"):
                self.call("task.create", project_id=self.project_id, name="instrument-check",
                          goal="Check the instrument", deliverables=DELIVERABLES)
            self.assertEqual(self.app.research.tasks.list_task_summaries(project_id=self.project_id), [])
            with self.app.research.store.transaction() as conn:
                state = self.app.research.tasks._create(conn=conn, project_id=self.project_id,
                    name="instrument-check", goal="Check the instrument", deliverables=DELIVERABLES, guard=False)
                self.assertEqual(state.name, "instrument-check")

    def test_task_uses_generic_api_and_the_same_evidence_gate(self):
        started = self.call(
            "workflow.start", project_id=self.project_id, workflow="task", request_id="create-task",
            data={"name": "prep-data", "goal": "Prepare the common dataset for comparable experiments.", "deliverables": DELIVERABLES},
        )
        task_id = started["id"]
        description = self.call("workflow.status_and_next", project_id=self.project_id, instance_id=task_id)
        self.assertEqual(description["workflow"]["state"], "in_progress")
        self.assertIn("Prepare the common dataset", description["context"]["brief"])
        self.assertTrue(any(reference["label"] == "brief" for reference in description["context"]["references"]))
        blocked = description["workflow"]["suggested_action"]["blockers"][0]
        with self.assertRaisesRegex(WorkflowError, "delivery artifact"):
            self.call("workflow.transition", project_id=self.project_id, instance_id=task_id,
                      action="submit_delivery", expected_revision=0, request_id="submit", payload={"delivery_present": True})
        self.assertEqual(blocked["code"], "delivery_required")
        delivery_id = self.submit(target_type="task", target_id=task_id, role="delivery",
                                  path="tasks/prep-data/delivery.md", body=VALID_DELIVERY)
        submitted = self.call("workflow.transition", project_id=self.project_id, instance_id=task_id,
                              action="submit_delivery", expected_revision=0, request_id="submit")
        self.assertEqual(submitted["state"], "in_review")
        self.call("review.request", project_id=self.project_id, target_type="task", target_id=task_id, role="task_reviewer")
        packet = self.call("workflow.assignment", project_id=self.project_id, instance_id=task_id)
        self.assertEqual(packet["role"], "task_reviewer")
        self.assertIn(delivery_id, {reference["id"] for reference in packet["references"]})
        self.pass_review(target_type="task", target_id=task_id, role="task_reviewer")
        completed = self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=task_id)
        self.assertEqual(completed.outcome, "completed")
        state = self.call("task.get_state", project_id=self.project_id, task_id=task_id)
        self.assertEqual(state["status"], "done")
        history = self.call("workflow.history", project_id=self.project_id, instance_id=task_id)["history"]
        self.assertEqual([entry["action"] for entry in history], ["start", "submit_delivery", "accept"])

    def test_new_plugin_needs_no_dispatcher_or_api_case(self):
        plugin = Workflow(
            name="replication", version=1, initial="investigate",
            nodes=(Node("investigate", role="researcher", build_context=lambda snapshot, knowledge: Brief(snapshot.data["question"])),),
            edges=(Edge("investigate", "confirm", "done"),), outcomes={"done": "confirmed"},
        )
        self.app.research.workflows.runtime.registry.register(plugin)
        created = self.call("workflow.start", project_id=self.project_id, workflow="replication", request_id="replication",
                            data={"question": "Does the result reproduce on the held-out subset?"})
        packet = self.call("workflow.status_and_next", project_id=self.project_id, instance_id=created["id"])
        self.assertEqual(packet["context"]["brief"], "Does the result reproduce on the held-out subset?")
        completed = self.call("workflow.transition", project_id=self.project_id, instance_id=created["id"],
                              action="confirm", expected_revision=0, request_id="confirm")
        self.assertEqual(completed["outcome"], "confirmed")

    def test_composition_starts_a_real_task_and_resumes_from_its_named_outcome(self):
        def joined(snapshot, knowledge):
            if not all(child.outcome for child in snapshot.children):
                return None
            return "failed" if any(child.outcome == "failed" for child in snapshot.children) else "completed"

        parent = Workflow(
            name="preparation", version=1, initial="wait",
            nodes=(Node("wait", children=lambda snapshot, knowledge: (
                Child("dataset", "task", {"name": "prepare-data", "goal": "Prepare the dataset.", "deliverables": ["A retained dataset with a verifiable manifest."]}),
            ), join=joined),),
            edges=(Edge("wait", "completed", "ready", check=join_guard(joined, "completed")), Edge("wait", "failed", "blocked", check=join_guard(joined, "failed"))),
            outcomes={"ready": "prepared", "blocked": "preparation_failed"},
        )
        self.app.research.workflows.runtime.registry.register(parent)
        created = self.call("workflow.start", project_id=self.project_id, workflow="preparation", request_id="prepare")
        child_id = created["children"][0]["id"]
        task = self.call("task.get_state", project_id=self.project_id, task_id=child_id)
        self.assertEqual(task["goal"], "Prepare the dataset.")
        with self.assertRaisesRegex(WorkflowError, "declared child outcomes"):
            self.call("workflow.transition", project_id=self.project_id, instance_id=created["id"],
                      action="completed", expected_revision=0, request_id="premature")
        self.call("task.transition", project_id=self.project_id, task_id=child_id,
                  transition="mark_failed", evidence={"reason": "The required source dataset is unavailable."})
        status = self.call("workflow.status_and_next", project_id=self.project_id, instance_id=created["id"])
        self.assertEqual(status["workflow"]["outcome"], "preparation_failed")


class WorkflowArtifactPluginTest(ResearchCase):
    def setUp(self):
        super().setUp()
        from merv.brain.workflows import retain_artifacts, artifact_references
        self.app.workflows.runtime.registry.register(Workflow(
            name="evidence_plugin", version=1, initial="work",
            nodes=(Node("work", role="researcher", build_context=lambda snapshot, knowledge:
                        Brief("Continue from the retained evidence.", artifact_references(snapshot))),),
            edges=(Edge("work", "retain", "work", change=retain_artifacts),), outcomes={"done": "completed"},
        ))
        self.instance = self.call("workflow.start", project_id=self.project_id, workflow="evidence_plugin", request_id="evidence")

    def retain(self, artifact_id, *, revision=0, request_id="retain"):
        return self.call("workflow.transition", project_id=self.project_id, instance_id=self.instance["id"],
                         action="retain", expected_revision=revision, request_id=request_id,
                         payload={"artifacts": {"novel evidence label": artifact_id}})

    def test_arbitrary_labels_pin_immutable_content_and_replays_preserve_the_original(self):
        first = self.app.artifact_store.create(project_id=self.project_id, path="custom.md", data=b"first result")
        accepted = self.retain(first.id)
        second = self.app.artifact_store.create(project_id=self.project_id, path="custom.md", data=b"corrected result")
        self.retain(second.id, revision=1, request_id="correction")
        self.assertEqual(self.retain(first.id), accepted)
        history = self.call("workflow.history", project_id=self.project_id, instance_id=self.instance["id"])["history"]
        self.assertEqual(history[1]["after"]["data"]["artifacts"], {"novel evidence label": first.id})
        assignment = self.call("workflow.assignment", project_id=self.project_id, instance_id=self.instance["id"])
        self.assertEqual(assignment["references"], [{"kind": "artifact", "id": second.id, "label": "novel evidence label"}])
        self.assertEqual(self.app.artifact_store.get(project_id=self.project_id, artifact_ids=(first.id,), include="content")[0].data, b"first result")
        with self.assertRaisesRegex(WorkflowError, "different workflow action"):
            self.retain(second.id)

    def test_acceptance_rejects_cross_project_pending_incomplete_or_missing_content(self):
        from merv.brain.kernel.utils import NotFoundError, ValidationError
        other = self.call("project", action="create", name="Other evidence project")["id"]
        foreign = self.app.artifact_store.create(project_id=other, path="foreign.md", data=b"private")
        pending = self.app.artifact_store.submit(project_id=self.project_id, path="pending.bin")
        figures = self.app.artifact_store.submit(project_id=self.project_id, path="figures.md", discover_figures=True)
        self.app.artifact_store.complete_upload(token=figures.token, kind="artifact", data=b"![figure](missing.png)")
        missing = self.app.artifact_store.create(project_id=self.project_id, path="lost.md", data=b"lost")
        self.app._blobs.delete(namespace=self.project_id, sha256=missing.sha256)
        for index, artifact_id in enumerate((foreign.id, pending.artifact_id, figures.artifact_id, missing.id)):
            with self.subTest(artifact_id=artifact_id), self.assertRaises((WorkflowError, ValidationError, NotFoundError)):
                self.retain(artifact_id, request_id=f"invalid-{index}")
        current = self.app.workflows.runtime.get(project_id=self.project_id, instance_id=self.instance["id"])
        self.assertEqual(current.revision, 0)
        self.assertFalse(current.data)


class ProgramInstallationTest(unittest.TestCase):
    """A second program installs beside Merv's own, with no registration edit.

    Everything this exercises -- the runtime, the gate, the effect worker and
    the tool manifest -- is composed exactly the way bootstrap composes the
    real one: from the tuple of installed programs and nothing else.
    """

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = StateStore(db_path=Path(directory.name) / "state.sqlite")
        with self.store.transaction() as conn:
            self.project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]
        RESOLVERS[Calibrated] = lambda need, context: RequirementEvaluation(
            need.key, "valid", "", "", (), ({"id": f"record:{need.key}", "kind": "record"},))
        self.addCleanup(RESOLVERS.pop, Calibrated)
        self.programs = (PROGRAM, CALIBRATION)
        self.workflows = Workflows(store=self.store, programs=self.programs)
        self.delivered: list[str] = []
        self.deliveries = WorkflowDeliveries(workflows=self.workflows, handlers={
            "calibration.notify": lambda delivery: self.delivered.append(str(delivery.data["instance_id"]))})

    def test_an_installed_program_runs_gates_delivers_and_lists_its_tool(self) -> None:
        started = self.workflows.start(project_id=self.project_id, workflow="calibration", request_id="cal")
        instance_id = started["id"]
        blocked = self.workflows.status(project_id=self.project_id, instance_id=instance_id)["blocked_actions"]
        self.assertEqual([issue["code"] for action in blocked for issue in action["blockers"]], ["uncalibrated"])
        with self.assertRaisesRegex(WorkflowError, "Record a reading"):
            self.workflows.transition(project_id=self.project_id, instance_id=instance_id, action="publish",
                                      expected_revision=0, request_id="early")
        self.workflows.transition(project_id=self.project_id, instance_id=instance_id, action="record",
                                  expected_revision=0, request_id="reading", payload={"reading": 7})
        published = self.workflows.transition(project_id=self.project_id, instance_id=instance_id, action="publish",
                                              expected_revision=1, request_id="publish")
        self.assertEqual(published["outcome"], "calibrated")
        self.assertEqual(self.deliveries.run_once(project_id=self.project_id), {"delivered": 1, "failed": 0})
        self.assertEqual(self.delivered, [instance_id])
        self.assertIn("calibration.status", build_manifest(self.programs))
        self.assertNotIn("calibration.status", build_manifest((PROGRAM,)))

    def test_second_program_projects_its_own_assignment_and_outcome_guidance(self):
        started = self.workflows.start(project_id=self.project_id, workflow="calibration", request_id="guidance")
        arguments = {"project_id": self.project_id, "instance_id": started["id"]}
        context = self.workflows.describe(**arguments)["context"]
        self.assertEqual(context["brief"], "Calibrate the instrument.")
        self.assertEqual(context["skill"], "instrument-operation")
        self.assertEqual(context["handoff"], "Leave the reading for the operator.")
        self.assertNotIn("messages", context)
        self.workflows.transition(**arguments, action="record", expected_revision=0, request_id="reading", payload={"reading": 7})
        self.workflows.transition(**arguments, action="publish", expected_revision=1, request_id="publish")
        described = self.workflows.describe(**arguments)
        self.assertTrue(described["workflow"]["outcome"])
        self.assertEqual(set(described["context"]), {"skill", "handoff"})
        self.assertIsNone(CALIBRATION.workflows[0].node("published"))

    def test_guidance_is_immutable_and_outcomes_are_declared(self):
        from dataclasses import replace
        messages = {"summary": "Original"}
        guidance = Guidance(messages=messages)
        messages["summary"] = "Changed"
        self.assertEqual(guidance.messages["summary"], "Original")
        with self.assertRaises(TypeError):
            guidance.messages["summary"] = "Changed"
        with self.assertRaisesRegex(ValueError, "undeclared outcome"):
            replace(CALIBRATION.workflows[0], outcome_guidance={"typo": guidance})

    def test_requirements_can_only_name_their_own_nodes_outgoing_actions(self):
        from dataclasses import replace
        workflow = CALIBRATION.workflows[0]
        node = workflow.nodes[0]
        need = node.requires[0]
        for action in ("publsih", "elsewhere"):
            edges = (*workflow.edges, Edge("other", "elsewhere", next(iter(workflow.outcomes))))
            nodes = (replace(node, requires=(replace(need, actions=(action,)),)), Node("other"))
            with self.assertRaisesRegex(ValueError, "non-outgoing actions"):
                replace(workflow, nodes=nodes, edges=edges)
        replace(workflow, nodes=(replace(node, requires=(replace(need, actions=(), dispatch=True),)),))

    def test_duplicate_definitions_and_preparations_are_rejected(self):
        workflow = CALIBRATION.workflows[0]
        with self.assertRaisesRegex(ValueError, "already registered"):
            self.workflows.runtime.registry.register(workflow)
        prepare = lambda snapshot, action, payload: None
        self.workflows.register_preparation(workflow.name, prepare)
        with self.assertRaisesRegex(ValueError, "already has a preparation"):
            self.workflows.register_preparation(workflow.name, prepare)

    def test_bootstrap_rejects_a_missing_declared_effect_handler(self):
        from unittest.mock import patch
        from tests.support.brain import TestBrain
        from merv.brain.kernel.utils import ValidationError
        with tempfile.TemporaryDirectory() as root, patch("merv.brain.surface.surface.research_effects", return_value={}), self.assertRaisesRegex(ValidationError, "workflow.start.*review.request"):
            TestBrain(repo_root=Path(root), db_path=Path(root) / "state.sqlite")

    def test_its_own_requirement_class_resolves_into_the_shared_checklist(self) -> None:
        need = CALIBRATION.workflows[0].node("calibrate").requires[0]
        context = GateContext(record={}, issues=(),
                              snapshot=Snapshot(id="cal_1", project_id=self.project_id, workflow="calibration",
                                                version=1, state="calibrate", revision=0))
        self.assertEqual(resolve_requirement(need, context).items[0]["id"], "record:calibrated")
