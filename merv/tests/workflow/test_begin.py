"""Interactive work start shares auto-run activation and revision fencing."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json

from fastapi.testclient import TestClient

from merv.brain.workflows import (
    Action,
    Brief,
    Change,
    Edge,
    Issue,
    Node,
    Reference,
    Workflow,
)
from merv.shared.errors import WorkflowError
from tests.research_core.scenarios import ResearchCase, VALID_PLAN


class WorkflowBeginTest(ResearchCase):
    def setUp(self):
        super().setUp()
        self.ready = True
        self.definition = Workflow(
            name="interactive_probe",
            version=1,
            initial="work",
            nodes=(
                Node(
                    "work",
                    "Investigate",
                    "researcher",
                    lambda snapshot, knowledge: Brief(
                        "Resume the recorded evidence.",
                        (Reference("project", snapshot.project_id),),
                    ),
                    lambda snapshot, knowledge: (
                        None
                        if self.ready
                        else Issue("dependency", "Wait for the dataset.")
                    ),
                    on_start=lambda snapshot, payload, knowledge: Change(
                        actions=(Action("prepare_inputs", {"source": "fixed"}),)
                    ),
                ),
            ),
            edges=(Edge("work", "finish", "done"),),
            outcomes={"done": "completed"},
        )
        self.runtime = self.app.workflows.runtime
        self.runtime.registry.register(self.definition)
        self.instance_id = self.call(
            "workflow.start",
            project_id=self.project_id,
            workflow=self.definition.name,
            request_id="interactive",
        )["id"]

    def begin(self, revision=0):
        return self.call(
            "workflow.begin",
            project_id=self.project_id,
            instance_id=self.instance_id,
            expected_revision=revision,
        )

    def starts(self, instance_id=None):
        with self.app.store.transaction() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT id, payload_json FROM events WHERE type = 'workflow.work_started' AND target_id = ?",
                    (instance_id or self.instance_id,),
                ).fetchall()
            ]

    def test_concurrent_begin_records_one_start_and_returns_the_same_node_assignment(
        self,
    ):
        with ThreadPoolExecutor(max_workers=3) as pool:
            packets = list(pool.map(lambda _: self.begin(), range(3)))
        self.assertEqual(packets, [packets[0]] * 3)
        self.assertEqual(packets[0]["revision"], 0)
        self.assertEqual(packets[0]["state"], "work")
        self.assertEqual(packets[0]["references"][0]["id"], self.project_id)
        started = self.starts()
        self.assertEqual(len(started), 1)
        self.assertEqual(
            json.loads(started[0]["payload_json"])["session_id"], "interactive"
        )
        with self.app.store.transaction() as conn:
            actions = conn.execute(
                "SELECT event_id FROM workflow_actions WHERE instance_id = ?",
                (self.instance_id,),
            ).fetchall()
            self.assertEqual([row["event_id"] for row in actions], [started[0]["id"]])
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM agent_sessions").fetchone()[0], 0
            )

    def test_begin_rechecks_dependencies_and_cannot_start_a_stale_or_terminal_node(
        self,
    ):
        self.ready = False
        with self.assertRaisesRegex(WorkflowError, "prerequisites"):
            self.begin()
        self.assertEqual(self.starts(), [])
        self.ready = True
        self.call(
            "workflow.transition",
            project_id=self.project_id,
            instance_id=self.instance_id,
            action="finish",
            expected_revision=0,
            request_id="finish",
        )
        for revision in (0, 1):
            with self.subTest(revision=revision), self.assertRaises(WorkflowError):
                self.begin(revision)
        self.assertEqual(self.starts(), [])

    def test_context_failure_rolls_back_start_marker_and_queued_effects(self):
        def unavailable(snapshot, knowledge):
            raise RuntimeError("evidence unavailable")

        broken = replace(
            self.definition,
            name="broken_context",
            nodes=(replace(self.definition.nodes[0], build_context=unavailable),),
        )
        self.runtime.registry.register(broken)
        self.instance_id = self.call(
            "workflow.start",
            project_id=self.project_id,
            workflow=broken.name,
            request_id="broken",
        )["id"]
        with self.assertRaisesRegex(RuntimeError, "evidence unavailable"):
            self.begin()
        self.assertEqual(self.starts(), [])
        with self.app.store.transaction() as conn:
            row = conn.execute(
                "SELECT started_revision FROM workflow_instances WHERE id = ?",
                (self.instance_id,),
            ).fetchone()
            self.assertEqual(row["started_revision"], -1)
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM workflow_actions WHERE instance_id = ?",
                    (self.instance_id,),
                ).fetchone()[0],
                0,
            )

    def test_http_begin_is_project_scoped_and_rejects_spoofed_session_identity(self):
        client = TestClient(self.app.fastapi_app, raise_server_exceptions=False)
        foreign_project = self.call("project", action="create", name="Other project")[
            "id"
        ]
        hello = client.post("/mcp/call", json={"name": "agent.hello", "arguments": {}})
        self.assertEqual(hello.status_code, 200, hello.text)
        arguments = {
            "project_id": self.project_id,
            "instance_id": self.instance_id,
            "expected_revision": 0,
            "agent_id": hello.json()["result"]["agent_id"],
        }
        foreign = client.post(
            "/mcp/call",
            json={
                "name": "workflow.begin",
                "arguments": {**arguments, "project_id": foreign_project},
            },
        )
        self.assertNotEqual(foreign.status_code, 200, foreign.text)
        self.assertEqual(foreign.json()["error_code"], "workflow_error")
        spoofed = client.post(
            "/mcp/call",
            json={
                "name": "workflow.begin",
                "arguments": {**arguments, "session_id": "another-agent"},
            },
        )
        self.assertNotEqual(spoofed.status_code, 200, spoofed.text)
        self.assertIn("unexpected field: session_id", spoofed.json()["detail"])
        self.assertEqual(self.starts(), [])
        started = client.post(
            "/mcp/call", json={"name": "workflow.begin", "arguments": arguments}
        )
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["result"]["revision"], 0)
        self.assertEqual(len(self.starts()), 1)

    def test_interactive_experiment_execution_begins_without_auto_run(self):
        experiment = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="manual-execution",
            intent="Run directly through MCP.",
        )
        experiment_id = experiment["id"]
        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            body=VALID_PLAN,
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition="submit_design",
        )
        self.pass_review(
            target_type="experiment", target_id=experiment_id, role="design_reviewer"
        )
        current = self.runtime.get(
            project_id=self.project_id, instance_id=experiment_id
        )
        self.assertEqual(current.state, "running")
        self.assertIsNone(
            self.app.research.attempt_started_running_at(experiment_id=experiment_id)
        )
        self.call(
            "workflow.begin",
            project_id=self.project_id,
            instance_id=experiment_id,
            expected_revision=current.revision,
        )
        self.call(
            "workflow.begin",
            project_id=self.project_id,
            instance_id=experiment_id,
            expected_revision=current.revision,
        )
        self.assertIsNotNone(
            self.app.research.attempt_started_running_at(experiment_id=experiment_id)
        )
        self.assertEqual(len(self.starts(experiment_id)), 1)
