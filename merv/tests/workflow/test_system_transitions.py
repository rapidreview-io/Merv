"""Sandbox lifecycle is not an experiment-status transition.

Pins the correctness boundary: sandbox code must not write experiments or call
a hidden experiment transition. Experiments move through explicit workflow
transitions; sandboxes are linked through sandbox_attachments only.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient, project_namespace
from merv.brain.research_core.experiment_workflow import EXPERIMENT_WORKFLOW
from merv.brain.kernel.utils import WorkflowError


class SystemTransitionTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.backend = FakeInfrastructureClient()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=self.backend,
        )
        self.project_id = self.call("project", action="create", name="System Transitions")["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def call(self, tool: str, **kwargs):
        return self.app.call_tool(tool, kwargs)

    def _experiment(self, *, status: str = "ready_to_run") -> str:
        exp_id = self.call("experiment.create", name="exp-1", project_id=self.project_id, intent="x")["id"]
        if status != "planned":
            with self.app.store.transaction() as conn:
                conn.execute("UPDATE experiments SET status = ? WHERE id = ?", (status, exp_id))
        return exp_id

    def _transition_events(self, exp_id: str) -> list[dict]:
        conn = self.app.store.connect()
        try:
            rows = conn.execute(
                """
                SELECT payload_json FROM events
                WHERE type = 'experiment.transitioned' AND target_id = ?
                ORDER BY id
                """,
                (exp_id,),
            ).fetchall()
            return [json.loads(row["payload_json"]) for row in rows]
        finally:
            conn.close()


class SandboxDrivenTransitionTest(SystemTransitionTestBase):
    def test_sandbox_request_does_not_transition_experiment(self) -> None:
        exp_id = self._experiment(status="ready_to_run")
        self.call("sandbox.request", project_id=self.project_id, experiment_id=exp_id)
        state = self.call("experiment.get_state", project_id=self.project_id, experiment_id=exp_id)
        self.assertEqual(state["status"], "ready_to_run")
        self.assertEqual(self._transition_events(exp_id), [])

    def test_reaper_expiry_does_not_transition_experiment(self) -> None:
        exp_id = self._experiment(status="ready_to_run")
        created = self.call("sandbox.request", project_id=self.project_id, experiment_id=exp_id)
        record = self.app.infrastructure_client.records[project_namespace(self.project_id)][created["sandbox_uid"]]
        record.update(state="stopped", lease_expires_at="2000-01-01T00:00:00Z")
        self.assertEqual(self.app.sandboxes.get(project_id=self.project_id, sandbox_uid=created["sandbox_uid"])["status"], "terminated")
        state = self.call("experiment.get_state", project_id=self.project_id, experiment_id=exp_id)
        self.assertEqual(state["status"], "ready_to_run")
        self.assertEqual(self._transition_events(exp_id), [])

    def test_no_system_transitions_in_discovery(self) -> None:
        exp_id = self._experiment(status="ready_to_run")
        state = self.call("experiment.get_state", project_id=self.project_id, experiment_id=exp_id)
        names = {t["transition"] for t in state["allowed_transitions"]}
        self.assertEqual(names, {"start_running", "abandon", "mark_failed"})

class WorkflowDeclarationTest(SystemTransitionTestBase):
    def test_enforcement_fact_drives_application_guidance(self) -> None:
        exp_id = self._experiment(status="planned")
        plan_req = EXPERIMENT_WORKFLOW.requirement("plan")
        self.assertIsNotNone(plan_req)
        with self.assertRaises(WorkflowError) as ctx:
            self.call(
                "experiment.transition",
                project_id=self.project_id,
                experiment_id=exp_id,
                transition="submit_design",
            )
        self.assertEqual(str(ctx.exception), plan_req.error)
        wf = self.call("workflow.status_and_next", project_id=self.project_id, experiment_id=exp_id)
        workflow = wf["workflow"]
        self.assertEqual(workflow["current_gate"], plan_req.gate)
        self.assertEqual(workflow["next_action"], plan_req.action)
        self.assertEqual(workflow["allowed_actions"], list(plan_req.tools))
        self.assertEqual(workflow["missing_evidence"], [plan_req.missing])


if __name__ == "__main__":
    unittest.main()
