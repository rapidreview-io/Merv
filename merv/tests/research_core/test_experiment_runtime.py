"""Experiment graph decisions remain atomic with native evidence and record state."""

from unittest.mock import patch

from merv.brain.kernel.utils import WorkflowError
from tests.research_core.scenarios import ResearchCase, VALID_GRAPH, VALID_PLAN, VALID_REPORT


class ExperimentRuntimeTest(ResearchCase):
    def advance(self, experiment_id, action, payload=None, *, request_id=None):
        current = self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=experiment_id)
        return self.call("workflow.transition", project_id=self.project_id, instance_id=experiment_id,
                         action=action, expected_revision=current.revision, request_id=request_id or f"{action}:{current.revision}",
                         payload=payload or {})

    def approved(self, name="experiment"):
        experiment_id = self.create_experiment(name)
        plan = self.submit(target_type="experiment", target_id=experiment_id, role="plan", path="plan.md", body=VALID_PLAN)
        self.advance(experiment_id, "submit_design")
        self.pass_review(target_type="experiment", target_id=experiment_id, role="design_reviewer")
        return experiment_id, plan

    def results(self, experiment_id):
        for role, path, body in (("result", "results.json", '{"accuracy": 0.72}'),
                                 ("report", "report.md", VALID_REPORT), ("graph", "graph.json", VALID_GRAPH)):
            self.submit(target_type="experiment", target_id=experiment_id, role=role, path=path, body=body)

    def test_generic_start_creates_the_native_record_and_uses_identical_gates(self):
        created = self.call("workflow.start", project_id=self.project_id, workflow="experiment", request_id="create",
                            data={"name": "registered-experiment", "intent": "Test an explicit research claim."})
        experiment_id = created["id"]
        self.assertEqual(self.app.research.experiment_state(project_id=self.project_id, experiment_id=experiment_id)["intent"], "Test an explicit research claim.")
        with self.assertRaisesRegex(WorkflowError, "plan artifact"):
            self.advance(experiment_id, "submit_design", {"plan_present": True})
        plan = self.submit(target_type="experiment", target_id=experiment_id, role="plan", path="plan.md", body=VALID_PLAN)
        submitted = self.advance(experiment_id, "submit_design")
        self.assertEqual(submitted["state"], "design_review")
        self.call("review.request", project_id=self.project_id, target_type="experiment", target_id=experiment_id, role="design_reviewer")
        packet = self.call("workflow.assignment", project_id=self.project_id, instance_id=experiment_id)
        self.assertTrue(packet["execution"]["read_only"])
        self.assertIn(plan, {reference["id"] for reference in packet["references"]})
        self.pass_review(target_type="experiment", target_id=experiment_id, role="design_reviewer")
        accepted = self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=experiment_id)
        self.assertEqual((accepted.state, accepted.revision), ("running", 2))
        self.assertIsNone(self.app.experiments.attempt_started_running_at(experiment_id=experiment_id))
        self.assertEqual(accepted.data["approved_plan_artifacts"][0]["artifact_id"], plan)

    def test_execution_context_keeps_the_exact_approved_plan_after_resubmission(self):
        experiment_id, approved = self.approved()
        replacement = self.submit(target_type="experiment", target_id=experiment_id, role="plan", path="plan.md", body=VALID_PLAN + "\nAn unapproved new threshold.\n")
        packet = self.call("workflow.assignment", project_id=self.project_id, instance_id=experiment_id)
        references = {item["id"] for item in packet["references"]}
        self.assertIn(approved, references)
        self.assertNotIn(replacement, references)
        self.assertIn("keep completed jobs", packet["brief"])

    def test_approval_bypasses_no_dependencies_and_never_creates_a_ready_state(self):
        task = self.call("task.create", project_id=self.project_id, name="prepare-data", goal="Prepare the comparison data.", deliverables=["A verified comparison dataset."])
        created = self.call("experiment.create", project_id=self.project_id, name="dependent-experiment", intent="Compare accuracy.", depends_on=[task["id"]])
        experiment_id = created["id"]
        self.submit(target_type="experiment", target_id=experiment_id, role="plan", path="plan.md", body=VALID_PLAN)
        self.advance(experiment_id, "submit_design")
        self.pass_review(target_type="experiment", target_id=experiment_id, role="design_reviewer")
        status = self.call("workflow.status_and_next", project_id=self.project_id, instance_id=experiment_id)["workflow"]
        self.assertEqual(status["state"], "running")
        self.assertFalse(status["dispatchable"])
        self.assertEqual(status["dispatch_blockers"][0]["code"], "dependencies_pending")
        with self.assertRaisesRegex(WorkflowError, "dependencies"):
            self.call("workflow.assignment", project_id=self.project_id, instance_id=experiment_id)

    def test_clock_starts_once_on_actual_work_and_retries_keep_the_attempt_window(self):
        experiment_id, _ = self.approved()
        runtime = self.app.research.workflows.runtime
        with self.app.store.transaction() as conn, patch("merv.brain.kernel.state.persistence.now_iso", return_value="2026-09-09T12:00:00Z"):
            runtime.activate(conn=conn, project_id=self.project_id, instance_id=experiment_id, revision=2, session_id="owner-one")
            runtime.activate(conn=conn, project_id=self.project_id, instance_id=experiment_id, revision=2, session_id="owner-resume")
        self.assertEqual(self.app.experiments.attempt_started_running_at(experiment_id=experiment_id), "2026-09-09T12:00:00Z")
        self.advance(experiment_id, "retry_running", {"reason": "Interrupted process"})
        with self.app.store.transaction() as conn, patch("merv.brain.kernel.state.persistence.now_iso", return_value="2026-09-09T13:00:00Z"):
            runtime.activate(conn=conn, project_id=self.project_id, instance_id=experiment_id, revision=3, session_id="owner-two")
        self.assertEqual(self.app.experiments.attempt_started_running_at(experiment_id=experiment_id), "2026-09-09T12:00:00Z")
        with self.app.store.connect() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM events WHERE target_id = ? AND type = 'workflow.work_started'", (experiment_id,)).fetchone()["n"]
        self.assertEqual(count, 2)

    def test_rejected_attempt_opens_a_new_plan_and_clears_the_clock(self):
        experiment_id, _ = self.approved()
        runtime = self.app.research.workflows.runtime
        with self.app.store.transaction() as conn:
            runtime.activate(conn=conn, project_id=self.project_id, instance_id=experiment_id, revision=2, session_id="owner")
        self.results(experiment_id)
        self.advance(experiment_id, "submit_results")
        self.review(target_type="experiment", target_id=experiment_id, role="experiment_reviewer", verdict="needs_changes", return_to="planned")
        state = self.app.research.experiment_state(project_id=self.project_id, experiment_id=experiment_id)
        current = runtime.get(project_id=self.project_id, instance_id=experiment_id)
        self.assertEqual((state["status"], state["attempt_index"]), ("planned", 2))
        self.assertEqual(tuple(current.data["approved_plan_artifacts"]), ())
        self.assertIsNone(self.app.experiments.attempt_started_running_at(experiment_id=experiment_id))

    def test_exhibit_pin_rejects_stale_revision_and_changed_source_evidence(self):
        experiment_id, _ = self.approved()
        state = self.app.research.experiment_state(project_id=self.project_id, experiment_id=experiment_id)
        ids = tuple(item["id"] for item in state["current_attempt_artifacts"])
        parameters = {"project_id": self.project_id, "experiment_id": experiment_id, "verdict": {"pinned": True},
                      "expected_revision": 2, "expected_attempt_index": 1, "expected_artifact_ids": ids,
                      "artifact_path": "metrics-exhibit.md", "artifact_data": b"Metrics from old evidence"}
        self.submit(target_type="experiment", target_id=experiment_id, role="result", path="new.json", body='{"accuracy":0.7}')
        with self.assertRaisesRegex(WorkflowError, "evidence changed"):
            self.app.research.record_exhibit_verdict(**parameters)
        self.advance(experiment_id, "retry_running")
        with self.assertRaisesRegex(WorkflowError, "changed"):
            self.app.research.record_exhibit_verdict(**parameters)
        with self.app.store.connect() as conn:
            pinned = conn.execute("SELECT COUNT(*) AS n FROM research_artifacts WHERE target_id = ? AND role = 'exhibit'", (experiment_id,)).fetchone()["n"]
            verdicts = conn.execute("SELECT COUNT(*) AS n FROM events WHERE target_id = ? AND type = 'experiment.exhibit_generated'", (experiment_id,)).fetchone()["n"]
        self.assertEqual((pinned, verdicts), (0, 0))

    def test_native_transition_keeps_the_revision_observed_before_preparing_metrics(self):
        experiment_id, _ = self.approved()
        self.results(experiment_id)
        transition = self.app.application._transition
        finalize = transition._finalize_exhibit

        def prepare_then_retry(**kwargs):
            result = finalize(**kwargs)
            self.advance(experiment_id, "retry_running", {"reason": "Another worker recovered the attempt."})
            return result

        with patch.object(transition, "_finalize_exhibit", side_effect=prepare_then_retry):
            with self.assertRaisesRegex(WorkflowError, "workflow changed"):
                self.transition_experiment(experiment_id, "submit_results")
        current = self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=experiment_id)
        self.assertEqual((current.state, current.revision), ("running", 3))
