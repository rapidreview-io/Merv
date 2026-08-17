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


def _transition_row(
    experiment_id: str, *, before: str, after: str, transition: str
) -> tuple[str, str, str, dict[str, Any]]:
    return _row(
        "experiment.transitioned",
        experiment_id,
        {"evidence": {}, "from": before, "to": after, "transition": transition},
    )


def _tracking_row(
    experiment_id: str,
    *,
    event_type: str,
    status: str,
    previous: str,
    delivery: int | None = None,
) -> tuple[str, str, str, dict[str, Any]]:
    # ``delivery`` is the id of the transition event this outcome belongs to —
    # the correlation key that makes the append-only row exact proof of commit.
    return _row(
        event_type,
        experiment_id,
        {
            "error": "",
            "previous_run_id": previous,
            "run_id": "run-composed",
            "run_name": f"{experiment_id}-attempt-1",
            "status": status,
            **({} if delivery is None else {"delivery_id": delivery}),
        },
    )


class TransitionDeliveryAndLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _brain(self, tracking: RecordingTracking) -> TestBrain:
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        return TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            mlflow_tracking=tracking,
            env={"MERV_AGENT_IDENTITY": "optional"},
        )

    def _register(
        self,
        app: TestBrain,
        *,
        project_id: str,
        experiment_id: str,
        path: str,
        role: str,
        body: str,
    ) -> None:
        app.submit_artifact(
            project_id=project_id,
            target_type="experiment",
            target_id=experiment_id,
            role=role,
            path=path,
            body=body,
        )

    def _pass_review(
        self,
        app: TestBrain,
        *,
        project_id: str,
        experiment_id: str,
        role: str,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
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

    def test_rest_and_mcp_start_running_have_equivalent_response_and_ledger_delta(
        self,
    ) -> None:
        tracking = RecordingTracking()
        app = self._brain(tracking)
        client = TestClient(app.fastapi_app)
        targets: list[tuple[str, str]] = []
        for name in ("MCP Parity", "REST Parity"):
            project_id = app.call_tool("project", {"action": "create", "name": name})[
                "id"
            ]
            experiment_id = app.call_tool(
                "experiment.create",
                {
                    "project_id": project_id,
                    "name": "equivalent-start",
                    "intent": "Prove delivery parity.",
                },
            )["id"]
            with app._store.transaction() as conn:
                conn.execute(
                    "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                    (experiment_id,),
                )
            targets.append((project_id, experiment_id))

        mcp_project, mcp_experiment = targets[0]
        mcp_cursor = _cursor(app)
        mcp_http = client.post(
            "/mcp/call",
            json={
                "name": "experiment.transition",
                "arguments": {
                    "project_id": mcp_project,
                    "experiment_id": mcp_experiment,
                    "transition": "start_running",
                },
            },
        )
        self.assertEqual(mcp_http.status_code, 200, mcp_http.text)
        mcp_response = mcp_http.json()["result"]
        mcp_rows = _ledger_delta(self, app, project_id=mcp_project, after_id=mcp_cursor)

        rest_project, rest_experiment = targets[1]
        rest_cursor = _cursor(app)
        rest_http = client.post(
            f"/api/projects/{rest_project}/experiments/{rest_experiment}/transition",
            json={"transition": "start_running"},
        )
        self.assertEqual(rest_http.status_code, 200, rest_http.text)
        rest_response = rest_http.json()
        rest_rows = _ledger_delta(
            self, app, project_id=rest_project, after_id=rest_cursor
        )

        self.assertEqual(
            _normalized(
                mcp_response,
                project_id=mcp_project,
                experiment_id=mcp_experiment,
            ),
            _normalized(
                rest_response,
                project_id=rest_project,
                experiment_id=rest_experiment,
            ),
        )
        expected = lambda experiment_id, cursor: [
            _transition_row(
                experiment_id,
                before="ready_to_run",
                after="running",
                transition="start_running",
            ),
            _tracking_row(
                experiment_id,
                event_type="experiment.mlflow_run_created",
                status="RUNNING",
                previous="",
                # The transition event is the first row after the cursor.
                delivery=cursor + 1,
            ),
        ]
        self.assertEqual(mcp_rows, expected(mcp_experiment, mcp_cursor))
        self.assertEqual(rest_rows, expected(rest_experiment, rest_cursor))
        self.assertEqual(
            _normalized(mcp_rows, project_id=mcp_project, experiment_id=mcp_experiment),
            _normalized(
                rest_rows, project_id=rest_project, experiment_id=rest_experiment
            ),
        )

    def test_real_composition_emits_exact_canonical_transition_ledger_without_recursion(
        self,
    ) -> None:
        tracking = RecordingTracking()
        app = self._brain(tracking)
        project_id = app.call_tool(
            "project", {"action": "create", "name": "Canonical Ledger"}
        )["id"]
        experiment_id = app.call_tool(
            "experiment.create",
            {
                "project_id": project_id,
                "name": "ledger-flow",
                "intent": "Drive the real composed workflow.",
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
        app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "mark_ready_to_run",
            },
        )
        for path, role, body in (
            ("results.json", "result", '{"accuracy":0.75}\n'),
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

        cursor = _cursor(app)
        started = app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "start_running",
            },
        )
        submitted = app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "submit_results",
            },
        )
        request, session, review = self._pass_review(
            app,
            project_id=project_id,
            experiment_id=experiment_id,
            role="experiment_reviewer",
        )
        completed = app.call_tool(
            "experiment.transition",
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "transition": "complete",
            },
        )

        self.assertEqual(started["mlflow_run"]["status"], "RUNNING")
        self.assertTrue(submitted["metrics_exhibit"]["pinned"])
        self.assertEqual(submitted["mlflow_run"]["status"], "FINISHED")
        self.assertEqual(completed["status"], "complete")

        conn = app._store.connect()
        try:
            exhibit_link = conn.execute(
                """
                SELECT id, path FROM artifacts
                WHERE target_type = 'experiment' AND target_id = ?
                  AND role = 'exhibit' AND status = 'complete'
                ORDER BY created_seq DESC LIMIT 1
                """,
                (experiment_id,),
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(exhibit_link)
        exhibit_artifact_id = str(exhibit_link["id"])
        exhibit_path = str(exhibit_link["path"])
        review_id = str(review["id"])

        expected = [
            _transition_row(
                experiment_id,
                before="ready_to_run",
                after="running",
                transition="start_running",
            ),
            _tracking_row(
                experiment_id,
                event_type="experiment.mlflow_run_created",
                status="RUNNING",
                previous="",
                delivery=cursor + 1,
            ),
            _row(
                "experiment.exhibit_generated",
                experiment_id,
                {
                    "attempt_index": 1,
                    "mlflow": {
                        "available": True,
                        "configured": True,
                        "experiment_name": f"merv/{project_id}/{experiment_id}",
                        "runs_excluded_by_window": 0,
                    },
                    "pinned": True,
                    "result_files": 1,
                    "runs_found": 1,
                },
            ),
            _row(
                "artifact.pinned",
                experiment_id,
                {
                    "artifact_id": exhibit_artifact_id,
                    "path": exhibit_path,
                    "role": "exhibit",
                },
            ),
            _transition_row(
                experiment_id,
                before="running",
                after="experiment_review",
                transition="submit_results",
            ),
            _tracking_row(
                experiment_id,
                event_type="experiment.mlflow_run_refreshed",
                status="FINISHED",
                previous="run-composed",
            ),
            _row(
                "review.requested",
                experiment_id,
                {
                    "request_id": request["review_request_id"],
                    "role": "experiment_reviewer",
                    "superseded_request_ids": [],
                },
            ),
            _row(
                "review.started",
                experiment_id,
                {
                    "request_id": request["review_request_id"],
                    "role": "experiment_reviewer",
                    "session_id": session["review_session_id"],
                },
            ),
            _row(
                "review.submitted",
                experiment_id,
                {
                    "return_to": "",
                    "review_id": review_id,
                    "role": "experiment_reviewer",
                    "synopsis": REVIEW_SYNOPSIS,
                    "verdict": "pass",
                },
            ),
            _transition_row(
                experiment_id,
                before="experiment_review",
                after="complete",
                transition="complete",
            ),
        ]
        rows = _ledger_delta(self, app, project_id=project_id, after_id=cursor)
        self.assertEqual(rows, expected)
        self.assertEqual(
            [row[0] for row in rows].count("experiment.mlflow_run_created"),
            1,
        )
        self.assertEqual(
            [row[0] for row in rows].count("experiment.mlflow_run_refreshed"),
            1,
        )
        self.assertFalse(any("dispatch" in row[0] or "ack" in row[0] for row in rows))
        self.assertEqual(len(tracking.create_calls), 1)
        self.assertEqual(len(tracking.finalize_calls), 1)
        self.assertEqual(tracking.finalize_calls[0]["status"], "FINISHED")
        self.assertEqual(tracking.results_calls, 1)
        self.assertEqual(tracking.context_calls, 3)


class TrackingOutageDegradationTest(unittest.TestCase):
    """A committed transition is never reported as a failure (audit APP-01)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.tracking = OutageTracking()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            mlflow_tracking=self.tracking,
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Tracking Outage"}
        )["id"]
        self.experiment_id = self.app.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "outage-start",
                "intent": "Start running while MLflow is down.",
            },
        )["id"]
        with self.app._store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                (self.experiment_id,),
            )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _experiment_row(self) -> dict[str, Any]:
        conn = self.app._store.connect()
        try:
            row = conn.execute(
                """
                SELECT status, mlflow_run_id, mlflow_run_error
                FROM experiments WHERE id = ?
                """,
                (self.experiment_id,),
            ).fetchone()
        finally:
            conn.close()
        return dict(row)

    def _start(self) -> dict[str, Any]:
        return self.app.call_tool(
            "experiment.transition",
            {
                "project_id": self.project_id,
                "experiment_id": self.experiment_id,
                "transition": "start_running",
            },
        )

    def test_start_running_commits_and_reports_a_repairable_tracking_warning(
        self,
    ) -> None:
        cursor = _cursor(self.app)

        started = self._start()

        self.assertEqual(started["status"], "running")
        self.assertEqual(started["mlflow_warning"]["tracking"], "unavailable")
        self.assertIn(
            "mlflow control plane unreachable", started["mlflow_warning"]["error"]
        )
        self.assertIn("mlflow.finalize_run", started["mlflow_warning"]["repair"])
        self.assertEqual(len(self.tracking.create_calls), 1)
        self.assertEqual(
            _ledger_delta(self, self.app, project_id=self.project_id, after_id=cursor),
            [
                _transition_row(
                    self.experiment_id,
                    before="ready_to_run",
                    after="running",
                    transition="start_running",
                ),
                _row(
                    "experiment.mlflow_run_unavailable",
                    self.experiment_id,
                    {
                        "delivery_id": cursor + 1,
                        "error": (
                            "MLflow run creation failed: "
                            "mlflow control plane unreachable"
                        ),
                        "previous_run_id": "",
                        "run_id": "",
                        "run_name": "",
                        "status": "",
                    },
                ),
            ],
        )
        row = self._experiment_row()
        self.assertEqual(row["status"], "running")
        self.assertEqual(row["mlflow_run_id"], "")
        self.assertIn("mlflow control plane unreachable", row["mlflow_run_error"])
        state = self.app.call_tool(
            "experiment.get_state",
            {"project_id": self.project_id, "experiment_id": self.experiment_id},
        )
        self.assertEqual(state["status"], "running")
        self.assertIn(
            "submit_results",
            [item["transition"] for item in state["allowed_transitions"]],
        )

    def test_agent_run_repair_attaches_once_and_creates_no_second_run(self) -> None:
        self._start()
        cursor = _cursor(self.app)

        repaired = [
            self.app.call_tool(
                "mlflow.finalize_run",
                {
                    "project_id": self.project_id,
                    "experiment_id": self.experiment_id,
                    "run_id": "agent-authored-run",
                    "status": "FINISHED",
                },
            )
            for _ in range(2)
        ]

        for response in repaired:
            self.assertEqual(
                response["experiment"]["mlflow_run"]["run_id"], "agent-authored-run"
            )
            self.assertEqual(response["experiment"]["mlflow_run"]["status"], "FINISHED")
        row = self._experiment_row()
        self.assertEqual(row["mlflow_run_id"], "agent-authored-run")
        self.assertEqual(row["mlflow_run_error"], "")
        self.assertEqual(len(self.tracking.create_calls), 1)
        rows = _ledger_delta(
            self, self.app, project_id=self.project_id, after_id=cursor
        )
        self.assertEqual(
            [row[0] for row in rows],
            ["experiment.mlflow_run_refreshed", "experiment.mlflow_run_refreshed"],
        )
        self.assertEqual(
            [row[3]["run_id"] for row in rows],
            ["agent-authored-run", "agent-authored-run"],
        )
        self.assertEqual(
            [row[3]["previous_run_id"] for row in rows], ["", "agent-authored-run"]
        )


class LostTrackingWriteOverMcpTest(unittest.TestCase):
    """A lost tracking write must survive MCP serialization verbatim.

    As a plain ``RuntimeError`` it collapsed to -32603 "Internal error", which
    reads as an ordinary retryable server fault — exactly the wrong lesson for
    a transition that is already committed.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.tracking = RecordingTracking()
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            mlflow_tracking=self.tracking,
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Lost Tracking Write"}
        )["id"]
        self.experiment_id = self.app.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "lost-write",
                "intent": "Lose the tracking write after a committed transition.",
            },
        )["id"]
        with self.app._store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'ready_to_run' WHERE id = ?",
                (self.experiment_id,),
            )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_lost_tracking_write_reaches_the_agent_as_a_coded_mcp_error(self) -> None:
        client = TestClient(self.app.fastapi_app)

        with patch(
            "merv.brain.research_core.experiments.ExperimentService.record_mlflow_run",
            side_effect=RuntimeError("write-ahead log offline"),
        ):
            response = client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 7,
                    "method": "tools/call",
                    "params": {
                        "name": "experiment.transition",
                        "arguments": {
                            "project_id": self.project_id,
                            "experiment_id": self.experiment_id,
                            "transition": "start_running",
                        },
                    },
                },
                headers={"Accept": "application/json, text/event-stream"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        error = response.json()["error"]
        self.assertEqual(error["code"], -32000)
        self.assertNotEqual(error["message"], "Internal error")
        self.assertEqual(error["data"]["error_code"], "tracking_persistence_failed")
        for phrase in (
            "already committed",
            "must not be retried",
            "may or may not exist",
            "experiment.get_state",
            "run-composed",
            "write-ahead log offline",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, error["message"])

        conn = self.app._store.connect()
        try:
            row = conn.execute(
                "SELECT status, mlflow_run_id FROM experiments WHERE id = ?",
                (self.experiment_id,),
            ).fetchone()
        finally:
            conn.close()
        # The error is about the tracking record only: the transition itself is
        # durable, which is why the caller must not retry it.
        self.assertEqual(row["status"], "running")
        self.assertEqual(row["mlflow_run_id"], "")
        self.assertEqual(len(self.tracking.create_calls), 1)

    def test_lost_tracking_write_is_a_server_error_on_the_rest_route(self) -> None:
        # The request was valid and its transition committed; only the server's
        # own durable record failed. 400 would tell the agent to fix its call.
        client = TestClient(self.app.fastapi_app, raise_server_exceptions=False)

        with patch(
            "merv.brain.research_core.experiments.ExperimentService.record_mlflow_run",
            side_effect=RuntimeError("write-ahead log offline"),
        ):
            response = client.post(
                f"/api/projects/{self.project_id}"
                f"/experiments/{self.experiment_id}/transition",
                json={"transition": "start_running"},
            )

        self.assertEqual(response.status_code, 500, response.text)
        body = response.json()
        self.assertEqual(body["error_code"], "tracking_persistence_failed")
        for phrase in (
            "already committed",
            "must not be retried",
            "may or may not exist",
            "experiment.get_state",
            "write-ahead log offline",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body["detail"])


if __name__ == "__main__":
    unittest.main()
