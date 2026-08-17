"""The durable ledger seen from the wire.

Proves the two things a unit test cannot: that the request id and principal
minted in middleware reach the dispatcher through the threadpool, and that the
refusals which never touch the dispatcher — auth denials and JSON-RPC protocol
errors — still land as ``rejected`` rows.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from merv.brain.kernel.utils import NotFoundError
from merv.brain.kernel.version import CLIENT_VERSION_HEADER
from merv.brain.surface.auth import ALLOW_OPEN_CONTROL_ENV_VAR, SupabaseVerifier
from merv.brain.surface.transport.api.gateway import (
    ProjectAuthorizer,
    ToolInvocationGateway,
)
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy


class RecordingLedger:
    """Captures exactly what the transport hands the durable ledger."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def reject(self, **kwargs: Any) -> None:
        self.rows.append({"status": "rejected", **kwargs})

    def record(self, **kwargs: Any) -> None:
        self.rows.append(kwargs)


class ToolCallLedgerOverHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / ".merv" / "state.sqlite",
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.client = TestClient(self.brain.fastapi_app, raise_server_exceptions=False)
        self.project_id = self.brain.current_project()["project"]["id"]

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def _rows(self) -> list[dict[str, Any]]:
        with self.brain.store.transaction() as conn:
            return [
                {key: row[key] for key in row.keys()}
                for row in conn.execute(
                    "SELECT * FROM tool_calls ORDER BY id"
                ).fetchall()
            ]

    def _call(self, name: str, arguments: dict[str, Any]) -> Any:
        return self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        )

    def test_an_ok_call_carries_its_request_id_and_principal(self) -> None:
        response = self._call("claim.list", {"project_id": self.project_id})
        self.assertEqual(response.status_code, 200, response.text)
        (row,) = [row for row in self._rows() if row["tool"] == "claim.list"]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["project_id"], self.project_id)
        self.assertEqual(row["principal_id"], "local")
        # Threaded from the middleware through the MCP threadpool hop.
        self.assertEqual(row["request_id"], response.headers["X-RP-Request-Id"])
        self.assertGreater(int(row["received_chars"]), 0)

    def test_a_failing_call_records_the_error_and_still_raises_to_the_caller(self) -> None:
        response = self._call("claim.list", {"project_id": "proj_missing"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("error", response.json())
        (row,) = [row for row in self._rows() if row["tool"] == "claim.list"]
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error_code"], "not_found")
        self.assertIn("proj_missing", str(row["error_head"]))
        self.assertEqual(row["request_id"], response.headers["X-RP-Request-Id"])

    def test_a_json_rpc_protocol_error_is_a_rejected_row(self) -> None:
        response = self.client.post("/mcp", json={"jsonrpc": "1.0", "id": 1})
        self.assertEqual(response.status_code, 400)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["error_code"], "invalid_request")
        self.assertEqual(row["request_id"], response.headers["X-RP-Request-Id"])

    def test_an_unknown_method_names_itself_in_the_rejected_row(self) -> None:
        response = self.client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/teleport"}
        )
        self.assertEqual(response.status_code, 200)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["error_code"], "method_not_found")
        self.assertEqual(row["tool"], "tools/teleport")

    def test_invalid_initialize_params_are_a_rejected_row(self) -> None:
        """The handshake the server refused is evidence too: it used to answer
        -32602 straight out of _initialize, leaving nothing behind."""
        response = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["error"]["code"], -32602)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["error_code"], "invalid_params")
        self.assertEqual(row["tool"], "initialize")

    def test_a_legacy_mcp_call_gateway_refusal_is_a_rejected_row(self) -> None:
        """/mcp/call reaches the gateway, whose own pre-dispatch checks —
        repo_root here — never touch the dispatcher that writes rows."""
        response = self.client.post(
            "/mcp/call",
            json={
                "name": "claim.list",
                "arguments": {"project_id": self.project_id},
                "context": {"repo_root": "/home/agent/checkout"},
            },
        )
        self.assertEqual(response.status_code, 400)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["tool"], "claim.list")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["project_id"], self.project_id)
        self.assertIn("repo_root", str(row["error_head"]))

    def test_a_ledger_outage_never_fails_the_call_it_observes(self) -> None:
        with self.brain.store.transaction() as conn:
            conn.execute("DROP TABLE tool_calls")  # the outage, as the app sees it
        response = self._call("claim.list", {"project_id": self.project_id})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["result"]["structuredContent"], {"claims": []})
        self.assertEqual(self.brain.tool_ledger.failures, 1)
        # The drop is announced through the activity feed, not swallowed.
        events = self.brain.activity.recent(limit=50)["events"]
        dropped = [event for event in events if event["event"] == "telemetry.dropped"]
        self.assertEqual(len(dropped), 1, events)
        self.assertEqual(dropped[0]["sink"], "tool_calls")


class AuthDenialLedgerTest(unittest.TestCase):
    """Hosted shape: denials short-circuit the gateway, never the dispatcher."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.brain = TestBrain(
            repo_root=root, db_path=root / ".merv" / "state.sqlite"
        )
        self.client = TestClient(
            create_fastapi_app(
                self.brain,
                allowed_origins=["https://ui.example"],
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=SupabaseVerifier(
                    supabase_url="https://example.supabase.co",
                    jwt_secret="test-jwt-secret",
                ),
            ),
            raise_server_exceptions=False,
        )

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def _rows(self) -> list[dict[str, Any]]:
        with self.brain.store.transaction() as conn:
            return [
                {key: row[key] for key in row.keys()}
                for row in conn.execute(
                    "SELECT * FROM tool_calls ORDER BY id"
                ).fetchall()
            ]

    def test_an_unauthenticated_request_is_a_rejected_row(self) -> None:
        response = self.client.get(
            "/api/projects", headers={"Authorization": "Bearer not-a-token"}
        )
        self.assertEqual(response.status_code, 401)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["source"], "http")
        self.assertEqual(row["error_code"], "unauthorized")
        self.assertEqual(row["principal_id"], "open")
        self.assertEqual(row["request_id"], response.headers["X-RP-Request-Id"])

    def test_an_mcp_denial_takes_the_mcp_source_and_project_scope(self) -> None:
        response = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={CLIENT_VERSION_HEADER: "0.0.0001"},
        )
        self.assertEqual(response.status_code, 426)
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["error_code"], "client_too_old")

    def test_no_denial_means_no_rejected_row(self) -> None:
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self._rows(), [])


class HostedSandboxLookupLedgerTest(unittest.TestCase):
    """The one call hosted mode answers WITHOUT the dispatcher still records."""

    def setUp(self) -> None:
        self.ledger = RecordingLedger()
        self.surface = HttpSurfacePolicy.for_surface(
            restrict_cors=True, hosted_control=True
        )

    def _gateway(self, get: Any) -> ToolInvocationGateway:
        return ToolInvocationGateway(
            tools=SimpleNamespace(call_tool=lambda **_kwargs: {"unexpected": True}),
            research=SimpleNamespace(),
            sandboxes=SimpleNamespace(get=get),
            surface=self.surface,
            projects=ProjectAuthorizer(
                research=SimpleNamespace(
                    is_project_member=lambda **_kwargs: True
                )
            ),
            ledger=self.ledger,
        )

    def _call(self, gateway: ToolInvocationGateway, **arguments: Any) -> Any:
        return gateway.call(
            name="sandbox.get", arguments=arguments, activity_source="mcp"
        )

    def test_a_successful_lookup_is_an_ok_row(self) -> None:
        gateway = self._gateway(lambda **_kwargs: {"sandbox": {"status": "running"}})
        result = self._call(gateway, project_id="proj-a", sandbox_uid="sbx-1")
        self.assertEqual(result, {"sandbox": {"status": "running"}})
        (row,) = self.ledger.rows
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["tool"], "sandbox.get")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["project_id"], "proj-a")
        self.assertIn("duration_ms", row)

    def test_a_failing_lookup_is_an_error_row_and_still_raises(self) -> None:
        def explode(**_kwargs: Any) -> dict[str, Any]:
            raise NotFoundError("sandbox not found: sbx-9")

        gateway = self._gateway(explode)
        with self.assertRaises(NotFoundError):
            self._call(gateway, project_id="proj-a", sandbox_uid="sbx-9")
        (row,) = self.ledger.rows
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error_code"], "not_found")
        self.assertIn("sbx-9", row["error"])

    def test_arguments_the_contract_rejects_are_a_rejected_row(self) -> None:
        gateway = self._gateway(lambda **_kwargs: {"unreachable": True})
        with self.assertRaises(Exception):
            self._call(gateway, sandbox_uid="sbx-1")  # no project_id
        (row,) = self.ledger.rows
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["tool"], "sandbox.get")


class OpenHostedLabelTest(unittest.TestCase):
    """Hosted WITHOUT a verifier: nobody is the trusted local operator."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / ".merv" / "state.sqlite",
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.client = TestClient(
            create_fastapi_app(
                self.brain,
                allowed_origins=["https://ui.example"],
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=None,
                env={ALLOW_OPEN_CONTROL_ENV_VAR: "1"},
            ),
            raise_server_exceptions=False,
        )
        self.project_id = self.brain.current_project()["project"]["id"]

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def _rows(self) -> list[dict[str, Any]]:
        with self.brain.store.transaction() as conn:
            return [
                {key: row[key] for key in row.keys()}
                for row in conn.execute("SELECT * FROM tool_calls ORDER BY id").fetchall()
            ]

    def test_a_successful_open_hosted_call_is_labeled_open_not_local(self) -> None:
        response = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "claim.list",
                    "arguments": {"project_id": self.project_id},
                },
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        (row,) = [row for row in self._rows() if row["tool"] == "claim.list"]
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["principal_id"], "open")


if __name__ == "__main__":
    unittest.main()
