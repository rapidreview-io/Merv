"""Plugins run through the released tool dispatcher, including native task children."""

from merv.brain.kernel.utils import WorkflowError
from merv.brain.workflows import Brief, Child, Edge, Issue, Node, Workflow, join_guard
from tests.research_core.scenarios import ResearchCase
from tests.research_core.test_tasks import DELIVERABLES, VALID_DELIVERY


class WorkflowPluginTest(ResearchCase):
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
        blocked = description["workflow"]["blocked_actions"][0]["blockers"][0]
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
