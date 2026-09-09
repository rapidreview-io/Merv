from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from merv.brain.application.mlflow import TrackingCapabilities
from merv.brain.mlflow.tracking import MlflowTrackingContext
from tests.support.brain import TestBrain

VALID_PLAN = (
    "## Summary\nCharacterize transition delivery.\n\n"
    "## Objective & hypothesis\nThe composed workflow preserves its ledger.\n\n"
    "## Evaluation\nThe exact ordered event sequence is the success criterion.\n"
)
VALID_REPORT = (
    "## Summary\nRan the composed transition flow.\n\n"
    "## Results\nThe tracked run is recorded in "
    "[the metrics exhibit](metrics_exhibit.json).\n\n"
    "## Deviations from plan\nNone.\n\n"
    "## Conclusion\nThe ordered ledger remained canonical.\n"
)
VALID_GRAPH = (
    '{"version":1,"nodes":['
    '{"id":"start","kind":"objective","label":"Start"},'
    '{"id":"done","kind":"outcome","label":"Complete"}],'
    '"edges":[{"from":"start","to":"done","label":"then"}]}\n'
)
REVIEW_SYNOPSIS = "The submitted attempt matches its pinned evidence and can stand."


class RecordingTracking:
    """Product adapter double around otherwise-real application composition."""

    def __init__(self) -> None:
        self.create_calls: list[dict[str, Any]] = []
        self.finalize_calls: list[dict[str, Any]] = []
        self.context_calls = 0
        self.results_calls = 0
        self.runs: list[dict[str, Any]] = []

    def capabilities(self) -> TrackingCapabilities:
        return TrackingCapabilities(logging=True, control=True, readback=True)

    def health(self) -> dict[str, object]:
        return {"configured": True, "reachable": True}

    def namespace_experiments(self, *, project_id: str) -> list[dict[str, object]]:
        return []

    def context(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool = False,
    ) -> MlflowTrackingContext:
        self.context_calls += 1
        return MlflowTrackingContext(
            configured=True,
            mode="external",
            tracking_uri="https://tracking.test",
            dashboard_url="https://tracking.test",
            experiment_name=f"merv/{project_id}/{experiment_id}",
            env={
                "MLFLOW_TRACKING_URI": "https://tracking.test",
                "MLFLOW_EXPERIMENT_NAME": f"merv/{project_id}/{experiment_id}",
                "RP_PROJECT_ID": project_id,
                "RP_EXPERIMENT_ID": experiment_id,
            },
        )

    def create_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        attempt_index: int,
        run_name: str,
    ) -> dict[str, Any]:
        self.create_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "attempt_index": attempt_index,
                "run_name": run_name,
            }
        )
        run_id = "run-composed"
        self.runs = [
            {
                "run_id": run_id,
                "run_name": run_name,
                "status": "RUNNING",
                "start_time": int(time.time() * 1000),
                "end_time": 0,
                "params": {"seed": "7"},
                "tags": {
                    "project_id": project_id,
                    "experiment_id": experiment_id,
                },
                "metrics": {"accuracy": {"last": 0.75, "step": 1}},
            }
        ]
        return {
            "created": True,
            "configured": True,
            "control_configured": True,
            "experiment_name": f"merv/{project_id}/{experiment_id}",
            "experiment_id": "tracking-exp-1",
            "run_id": run_id,
            "run_name": run_name,
            "status": "RUNNING",
            "artifact_uri": "s3://tracking/run-composed",
            "created_at": "2026-07-19T12:00:00Z",
        }

    def finalize_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str,
        status: str | None,
        wait_seconds: float,
    ) -> dict[str, Any]:
        self.finalize_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "run_id": run_id,
                "status": status,
                "wait_seconds": wait_seconds,
            }
        )
        if status:
            self.runs[0]["status"] = status
            self.runs[0]["end_time"] = int(time.time() * 1000)
        return {
            "configured": True,
            "control_configured": True,
            "run_id": run_id,
            "requested_status": status,
            "terminal": True,
            "run": {
                "run_id": run_id,
                "run_name": self.runs[0]["run_name"],
                "status": status,
                "artifact_uri": "s3://tracking/run-composed",
                "created_at": "2026-07-19T12:00:00Z",
            },
        }

    def results_metrics(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_history: bool = True,
    ) -> dict[str, Any]:
        _ = include_history
        self.results_calls += 1
        return {
            "available": True,
            "source": "mlflow",
            "experiment_id": experiment_id,
            "experiments": [
                {
                    "experiment_id": "tracking-exp-1",
                    "name": f"merv/{project_id}/{experiment_id}",
                    "runs": [dict(run) for run in self.runs],
                }
            ],
        }


class OutageTracking(RecordingTracking):
    """Reachable for context and readback, unavailable for run creation."""

    def create_run(self, **kwargs: Any) -> dict[str, Any]:
        self.create_calls.append(dict(kwargs))
        raise RuntimeError("mlflow control plane unreachable")

    def finalize_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str,
        status: str,
        wait_seconds: float,
    ) -> dict[str, Any]:
        self.finalize_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "run_id": run_id,
                "status": status,
                "wait_seconds": wait_seconds,
            }
        )
        return {
            "configured": True,
            "run_id": run_id,
            "terminal": True,
            "run": {
                "run_id": run_id,
                "run_name": "agent-authored",
                "status": status or "RUNNING",
                "artifact_uri": f"s3://tracking/{run_id}",
                "created_at": "2026-07-25T09:00:00Z",
            },
        }


def _cursor(app: TestBrain) -> int:
    conn = app._store.connect()
    try:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS id FROM events").fetchone()
        return int(row["id"])
    finally:
        conn.close()


def _ledger_delta(
    testcase: unittest.TestCase,
    app: TestBrain,
    *,
    project_id: str,
    after_id: int,
) -> list[tuple[str, str, str, dict[str, Any]]]:
    conn = app._store.connect()
    try:
        raw = conn.execute(
            """
            SELECT id, project_id, type, target_type, target_id, payload_json
            FROM events
            WHERE project_id = ? AND id > ?
            ORDER BY id
            """,
            (project_id, after_id),
        ).fetchall()
    finally:
        conn.close()
    testcase.assertEqual(
        [int(row["id"]) for row in raw],
        list(range(after_id + 1, after_id + len(raw) + 1)),
    )
    rows: list[tuple[str, str, str, dict[str, Any]]] = []
    for row in raw:
        testcase.assertEqual(str(row["project_id"]), project_id)
        payload_json = str(row["payload_json"])
        payload = json.loads(payload_json)
        testcase.assertEqual(payload_json, json.dumps(payload, sort_keys=True))
        rows.append(
            (
                str(row["type"]),
                str(row["target_type"]),
                str(row["target_id"]),
                payload,
            )
        )
    return rows


def _normalized(value: Any, *, project_id: str, experiment_id: str) -> Any:
    if isinstance(value, dict):
        return {
            key: (
                "<timestamp>"
                if key in {"accepted_at", "created_at", "updated_at"}
                # The delivery key is a real event id, so it differs per
                # transport; only its presence is comparable across them.
                else (
                    "<delivery>"
                    if key in {"delivery_id", "event_id"}
                    else _normalized(
                        item, project_id=project_id, experiment_id=experiment_id
                    )
                )
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            _normalized(item, project_id=project_id, experiment_id=experiment_id)
            for item in value
        ]
    if isinstance(value, tuple):
        return tuple(
            _normalized(item, project_id=project_id, experiment_id=experiment_id)
            for item in value
        )
    if isinstance(value, str):
        return value.replace(project_id, "<project>").replace(
            experiment_id, "<experiment>"
        )
    return value


def _row(
    event_type: str,
    target_id: str,
    payload: dict[str, Any],
    *,
    target_type: str = "experiment",
) -> tuple[str, str, str, dict[str, Any]]:
    return event_type, target_type, target_id, payload


class TrackingSurfaceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.brains = []

    def tearDown(self):
        for app in self.brains:
            app.shutdown()
        self.tmp.cleanup()

    def _brain(self, tracking):
        app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / "state.sqlite",
            mlflow_tracking=tracking,
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.brains.append(app)
        return app

    def _register(self, app, *, project_id, experiment_id, path, role, body):
        app.submit_artifact(
            project_id=project_id,
            target_type="experiment",
            target_id=experiment_id,
            role=role,
            path=path,
            body=body,
        )

    def _pass_review(self, app, *, project_id, experiment_id, role):
        requested = app.call_tool(
            "review.request",
            {
                "project_id": project_id,
                "target_type": "experiment",
                "target_id": experiment_id,
                "role": role,
            },
        )
        started = app.call_tool(
            "review.start",
            {
                "review_request_id": requested["review_request_id"],
                "reviewer_capability": requested["reviewer_capability"],
                "caller_session_id": f"{role}-reviewer",
            },
        )
        submitted = app.call_tool(
            "review.submit",
            {
                "review_session_id": started["review_session_id"],
                "verdict": "pass",
                "synopsis": REVIEW_SYNOPSIS,
            },
        )
        return requested, started, submitted

    def _approved(self, app, name):
        project_id = app.call_tool("project", {"action": "create", "name": name})["id"]
        experiment_id = app.call_tool(
            "experiment.create",
            {
                "project_id": project_id,
                "name": "tracking-flow",
                "intent": "Verify composed workflow delivery.",
            },
        )["id"]
        self._register(
            app,
            project_id=project_id,
            experiment_id=experiment_id,
            path="plan.md",
            role="plan",
            body=VALID_PLAN,
        )
        app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "submit_design",
            },
        )
        self._pass_review(
            app,
            project_id=project_id,
            experiment_id=experiment_id,
            role="design_reviewer",
        )
        return project_id, experiment_id

    def _begin(self, app, project_id, experiment_id):
        current = app.workflows.runtime.get(
            project_id=project_id, instance_id=experiment_id
        )
        return app.call_tool(
            "workflow.begin",
            {
                "project_id": project_id,
                "instance_id": experiment_id,
                "expected_revision": current.revision,
            },
        )

    def _drain(self, app, project_id):
        return app.application.workflow_deliveries.run_once(
            project_id=project_id, renew_interval_seconds=0
        )



class TransitionDeliveryAndLedgerTest(TrackingSurfaceCase):
    def test_rest_and_mcp_retry_have_equivalent_response_and_canonical_ledger_delta(
        self,
    ):
        tracking = RecordingTracking()
        app = self._brain(tracking)
        client = TestClient(app.fastapi_app)
        targets = [self._approved(app, name) for name in ("MCP Parity", "REST Parity")]
        responses, ledgers = [], []
        for index, (project_id, experiment_id) in enumerate(targets):
            cursor = _cursor(app)
            response = (
                client.post(
                    "/mcp/call",
                    json={
                        "name": "experiment.transition",
                        "arguments": {
                            "project_id": project_id,
                            "experiment_id": experiment_id,
                            "transition": "retry_running",
                        },
                    },
                )
                if index == 0
                else client.post(
                    f"/api/projects/{project_id}/experiments/{experiment_id}/transition",
                    json={"transition": "retry_running"},
                )
            )
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()["result"] if index == 0 else response.json()
            responses.append(
                _normalized(result, project_id=project_id, experiment_id=experiment_id)
            )
            rows = _ledger_delta(self, app, project_id=project_id, after_id=cursor)
            self.assertEqual(
                rows,
                [
                    _row(
                        "experiment.transitioned",
                        experiment_id,
                        {
                            "evidence": {},
                            "from": "running",
                            "to": "running",
                            "transition": "retry_running",
                            "workflow": "experiment",
                            "version": 1,
                            "revision": 3,
                        },
                    )
                ],
            )
            ledgers.append(
                _normalized(rows, project_id=project_id, experiment_id=experiment_id)
            )
        self.assertEqual(responses[0], responses[1])
        self.assertEqual(ledgers[0], ledgers[1])
        self.assertEqual(tracking.create_calls, [])

    def test_real_composition_records_canonical_graph_and_delivery_events_without_recursion(
        self,
    ):
        tracking = RecordingTracking()
        app = self._brain(tracking)
        project_id, experiment_id = self._approved(app, "Canonical Ledger")
        self.assertEqual(tracking.create_calls, [])
        cursor = _cursor(app)
        assignment = self._begin(app, project_id, experiment_id)
        self.assertEqual(assignment["state"], "running")
        self.assertEqual(tracking.create_calls, [])
        self._drain(app, project_id)
        for path, role, body in (
            ("results.json", "result", '{"accuracy":0.75}'),
            ("report.md", "report", VALID_REPORT),
            ("graph.json", "graph", VALID_GRAPH),
        ):
            self._register(
                app,
                project_id=project_id,
                experiment_id=experiment_id,
                path=path,
                role=role,
                body=body,
            )
        submitted = app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "submit_results",
            },
        )
        self.assertTrue(submitted["metrics_exhibit"]["pinned"])
        self.assertEqual(tracking.finalize_calls, [])
        self._drain(app, project_id)
        self._pass_review(
            app,
            project_id=project_id,
            experiment_id=experiment_id,
            role="experiment_reviewer",
        )
        self._drain(app, project_id)
        state = app.research.experiment_state(
            project_id=project_id, experiment_id=experiment_id
        )
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["mlflow_run"]["status"], "FINISHED")
        rows = _ledger_delta(self, app, project_id=project_id, after_id=cursor)
        lifecycle = [
            row
            for row in rows
            if row[0]
            in {
                "workflow.work_started",
                "experiment.mlflow_run_created",
                "experiment.transitioned",
                "review.submitted",
                "experiment.mlflow_run_refreshed",
            }
        ]
        self.assertEqual(
            [row[0] for row in lifecycle],
            [
                "workflow.work_started",
                "experiment.mlflow_run_created",
                "experiment.transitioned",
                "experiment.mlflow_run_refreshed",
                "review.submitted",
                "experiment.transitioned",
                "experiment.mlflow_run_refreshed",
            ],
        )
        self.assertEqual(
            lifecycle[0][3],
            {
                "workflow": "experiment",
                "state": "running",
                "revision": 2,
                "session_id": "interactive",
            },
        )
        self.assertEqual(lifecycle[1][3]["delivery_id"], cursor + 1)
        self.assertEqual(
            [
                row[3]["transition"]
                for row in lifecycle
                if row[0] == "experiment.transitioned"
            ],
            ["submit_results", "complete"],
        )
        self.assertFalse(any("dispatch" in row[0] or "ack" in row[0] for row in rows))
        self.assertEqual(len(tracking.create_calls), 1)
        self.assertEqual(
            {call["run_id"] for call in tracking.finalize_calls}, {"run-composed"}
        )
        before_redelivery = _cursor(app)
        self._drain(app, project_id)
        self.assertEqual(_cursor(app), before_redelivery)


class TrackingOutageDegradationTest(TrackingSurfaceCase):

    def _outage(self):
        tracking = OutageTracking()
        app = self._brain(tracking)
        project_id, experiment_id = self._approved(app, "Tracking Outage")
        self._begin(app, project_id, experiment_id)
        with self.assertLogs("merv.brain.application.mlflow", level="ERROR"):
            self._drain(app, project_id)
        return app, tracking, project_id, experiment_id

    def test_tracking_outage_is_durable_and_keeps_the_approved_execution_available(
        self,
    ):
        app, tracking, project_id, experiment_id = self._outage()
        state = app.call_tool(
            "experiment.get_state",
            {"project_id": project_id, "experiment_id": experiment_id},
        )
        self.assertEqual(state["status"], "running")
        self.assertIn("mlflow control plane unreachable", state["mlflow_run"]["error"])
        self.assertEqual(len(tracking.create_calls), 1)
        with app.store.transaction() as conn:
            row = conn.execute(
                "SELECT status, event_id FROM workflow_actions WHERE instance_id = ? AND kind = 'experiment.start_tracking'",
                (experiment_id,),
            ).fetchone()
            self.assertEqual(row["status"], "delivered")
            outcome = conn.execute(
                "SELECT payload_json FROM events WHERE target_id = ? AND type = 'experiment.mlflow_run_unavailable'",
                (experiment_id,),
            ).fetchone()
            self.assertEqual(
                json.loads(outcome["payload_json"])["delivery_id"], row["event_id"]
            )
        self._begin(app, project_id, experiment_id)
        self._drain(app, project_id)
        self.assertEqual(len(tracking.create_calls), 1)

    def test_agent_run_repair_attaches_without_creating_another_run(self):
        app, tracking, project_id, experiment_id = self._outage()
        cursor = _cursor(app)
        for _ in range(2):
            repaired = app.call_tool(
                "mlflow.finalize_run",
                {
                    "project_id": project_id,
                    "experiment_id": experiment_id,
                    "run_id": "agent-authored-run",
                    "status": "FINISHED",
                },
            )
            self.assertEqual(
                repaired["experiment"]["mlflow_run"]["run_id"], "agent-authored-run"
            )
        rows = _ledger_delta(self, app, project_id=project_id, after_id=cursor)
        self.assertEqual(
            [row[0] for row in rows], ["experiment.mlflow_run_refreshed"] * 2
        )
        self.assertEqual(
            [row[3]["previous_run_id"] for row in rows], ["", "agent-authored-run"]
        )
        self.assertEqual(len(tracking.create_calls), 1)

    def test_failed_tracking_write_stops_for_manual_repair_after_successful_mcp_begin(
        self,
    ):
        tracking = RecordingTracking()
        app = self._brain(tracking)
        project_id, experiment_id = self._approved(app, "Lost Tracking Write")
        client = TestClient(app.fastapi_app)
        current = app.workflows.runtime.get(
            project_id=project_id, instance_id=experiment_id
        )
        arguments = {
            "project_id": project_id,
            "instance_id": experiment_id,
            "expected_revision": current.revision,
        }
        response = client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 7,
                "method": "tools/call",
                "params": {"name": "workflow.begin", "arguments": arguments},
            },
            headers={"Accept": "application/json, text/event-stream"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("error", response.json())
        self.assertEqual(tracking.create_calls, [])
        with (
            patch(
                "merv.brain.research_core.experiments.ExperimentService.record_mlflow_run",
                side_effect=RuntimeError("write-ahead log offline"),
            ),
            self.assertLogs("merv.brain.application.mlflow", level="ERROR"),
        ):
            result = self._drain(app, project_id)
        self.assertEqual(result["failed"], 1)
        with app.store.transaction() as conn:
            action = dict(
                conn.execute(
                    "SELECT * FROM workflow_actions WHERE instance_id = ? AND kind = 'experiment.start_tracking'",
                    (experiment_id,),
                ).fetchone()
            )
        self.assertEqual(action["status"], "manual_repair")
        for phrase in (
            "may or may not exist",
            "run-composed",
            "write-ahead log offline",
        ):
            self.assertIn(phrase, action["last_error"])
        self.assertEqual(
            app.research.experiment_state(
                project_id=project_id, experiment_id=experiment_id
            )["status"],
            "running",
        )
        replay = client.post(
            "/mcp/call", json={"name": "workflow.begin", "arguments": arguments}
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(len(tracking.create_calls), 1)
        with app.store.transaction() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM workflow_actions WHERE instance_id = ? AND kind = 'experiment.start_tracking'",
                    (experiment_id,),
                ).fetchone()[0],
                1,
            )
            conn.execute(
                "UPDATE workflow_actions SET lease_until = '', next_attempt_at = '' WHERE id = ?",
                (action["id"],),
            )
        self._drain(app, project_id)
        history = app.call_tool(
            "workflow.history",
            {"project_id": project_id, "instance_id": experiment_id},
        )
        stopped = next(item for item in history["actions"] if item["id"] == action["id"])
        self.assertEqual(stopped["status"], "manual_repair")
        self.assertIn("run-composed", stopped["last_error"])
        self.assertEqual(len(tracking.create_calls), 1)
        repaired = app.call_tool(
            "mlflow.finalize_run",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "run_id": "run-composed",
                "status": None,
            },
        )
        self.assertEqual(repaired["experiment"]["mlflow_run"]["run_id"], "run-composed")
        history = app.call_tool(
            "workflow.history",
            {"project_id": project_id, "instance_id": experiment_id},
        )
        restored = next(item for item in history["actions"] if item["id"] == action["id"])
        self.assertEqual(restored["status"], "delivered")
        self.assertEqual(restored["last_error"], "")
        self._drain(app, project_id)
        self.assertEqual(len(tracking.create_calls), 1)

    def test_manual_repair_can_replace_the_previous_terminal_pointer(self):
        tracking = RecordingTracking()
        app = self._brain(tracking)
        project_id, experiment_id = self._approved(app, "Lost Replacement Write")
        app.research.refresh_tracking_run(
            project_id=project_id, experiment_id=experiment_id,
            run={"run_id": "run-prior", "status": "FINISHED"},
        )
        self._begin(app, project_id, experiment_id)
        with (
            patch("merv.brain.research_core.experiments.ExperimentService.record_mlflow_run",
                  side_effect=RuntimeError("database acknowledgement lost")),
            self.assertLogs("merv.brain.application.mlflow", level="ERROR"),
        ):
            self._drain(app, project_id)
        self.assertEqual(app.research.experiment_state(
            project_id=project_id, experiment_id=experiment_id,
        )["mlflow_run"]["run_id"], "run-prior")
        repaired = app.call_tool("mlflow.finalize_run", {
            "project_id": project_id, "experiment_id": experiment_id,
            "run_id": "run-composed", "status": None,
        })
        self.assertEqual(repaired["experiment"]["mlflow_run"]["run_id"], "run-composed")
        self.assertFalse(app.workflows.deliveries.needs_manual_repair(
            project_id=project_id, instance_id=experiment_id, kind="experiment.start_tracking",
        ))
        self._drain(app, project_id)
        self.assertEqual(len(tracking.create_calls), 1)


if __name__ == "__main__":
    unittest.main()
