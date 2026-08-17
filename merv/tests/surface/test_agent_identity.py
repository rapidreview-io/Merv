"""Agent context-window identity: agent.hello, per-call attribution, traces.

Pins the model-facing contract (what the catalog advertises, what a refusal
says, what hello returns) and the durable half (ledger rows carry the id and
the transport session, payload records land in the blob store and leave with
their rows).
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from merv.brain.kernel.state import StateStore
from merv.brain.kernel.state.tool_call_ledger import ToolCallLedger
from merv.brain.kernel.state.tool_call_payloads import (
    PAYLOAD_NAMESPACE,
    ToolCallPayloadStore,
)
from merv.brain.kernel.request_context import begin_request, bind_agent, reset_request
from merv.brain.object_storage.blobs import LocalDirBlobStore
from merv.brain.surface.agent_identity import (
    AGENT_ID_ALPHABET,
    AGENT_ID_LENGTH,
    AgentIdentities,
    AgentIdentityRequiredError,
    AgentIdentityUnknownError,
    CallerFacts,
)
from merv.brain.surface.transport.mcp_streamable_http import SERVER_INSTRUCTIONS
from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend

MCP_ACCEPT = "application/json, text/event-stream"


class _Mcp:
    """Minimal streamable-HTTP client: initialize once, then call."""

    def __init__(self, client: TestClient, *, client_name: str = "claude-code") -> None:
        self.client = client
        self.client_name = client_name
        self.session_id = ""
        self.next_id = 1

    def initialize(self) -> httpx.Response:
        response = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": self.client_name, "version": "9.9"},
                },
            },
            headers={"Accept": MCP_ACCEPT},
        )
        self.next_id += 1
        self.session_id = response.headers.get("mcp-session-id", "")
        return response

    def request(self, method: str, params: dict[str, Any] | None = None) -> httpx.Response:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        self.next_id += 1
        if params is not None:
            payload["params"] = params
        headers = {"Accept": MCP_ACCEPT}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return self.client.post("/mcp", json=payload, headers=headers)

    def call(self, name: str, arguments: dict[str, Any]) -> httpx.Response:
        return self.request("tools/call", {"name": name, "arguments": arguments})


def _result(response: httpx.Response) -> dict[str, Any]:
    body = response.json()
    assert "result" in body, body
    return body["result"]["structuredContent"]


def _error(response: httpx.Response) -> dict[str, Any]:
    body = response.json()
    assert "error" in body, body
    return body["error"]


class AgentIdentityOverMcpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.brain = TestBrain(
            repo_root=self.root,
            db_path=self.root / ".merv" / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )
        self.client = TestClient(self.brain.fastapi_app)
        self.mcp = _Mcp(self.client)
        self.mcp.initialize()

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def _rows(self) -> list[dict[str, Any]]:
        conn = self.brain.store.connect()
        try:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT tool, status, error_code, agent_id, mcp_session_id, "
                    "payload_ref FROM tool_calls ORDER BY id"
                ).fetchall()
            ]
        finally:
            conn.close()

    def test_the_wire_tells_a_fresh_client_to_hello_first(self) -> None:
        self.assertIn("agent.hello", SERVER_INSTRUCTIONS)
        self.assertIn("agent_id", SERVER_INSTRUCTIONS)
        catalog = self.mcp.request("tools/list").json()["result"]["tools"]
        legacy = self.client.get("/mcp/tools").json()["tools"]
        self.assertEqual(catalog, legacy)
        by_name = {tool["name"]: tool for tool in catalog}
        self.assertIn("agent.hello", by_name)
        hello_schema = by_name["agent.hello"]["inputSchema"]
        self.assertNotIn("agent_id", hello_schema.get("required", []))
        for name, tool in by_name.items():
            if name == "agent.hello":
                continue
            schema = tool["inputSchema"]
            with self.subTest(tool=name):
                self.assertEqual(schema["properties"]["agent_id"]["type"], "string")
                self.assertEqual(schema["required"][-1], "agent_id")

    def test_a_call_without_an_id_is_refused_with_instructions(self) -> None:
        refused = self.mcp.call("project", {"action": "list"})
        self.assertEqual(refused.status_code, 200, refused.text)
        error = _error(refused)
        self.assertEqual(error["code"], -32602)
        self.assertEqual(error["data"]["error_code"], "agent_id_required")
        self.assertIn("agent.hello", error["message"])
        # The legacy route says the same thing in its own shape.
        legacy = self.client.post(
            "/mcp/call", json={"name": "project", "arguments": {"action": "list"}}
        )
        self.assertEqual(legacy.status_code, 400, legacy.text)
        self.assertEqual(legacy.json()["error_code"], "agent_id_required")
        rows = self._rows()
        self.assertEqual([row["status"] for row in rows], ["rejected", "rejected"])
        self.assertEqual(rows[0]["error_code"], "agent_id_required")
        # Even the refusal names the transport session it arrived under.
        self.assertEqual(rows[0]["mcp_session_id"], self.mcp.session_id)
        self.assertEqual(rows[0]["agent_id"], "")

    def test_an_id_merv_never_issued_is_refused_with_instructions(self) -> None:
        refused = self.mcp.call("project", {"action": "list", "agent_id": "zzzzzz"})
        error = _error(refused)
        self.assertEqual(error["data"]["error_code"], "agent_id_unknown")
        self.assertIn("agent.hello", error["message"])

    def test_hello_mints_a_short_id_and_confirms_it_on_repeat(self) -> None:
        minted = _result(self.mcp.call("agent.hello", {"role": "main"}))
        agent_id = minted["agent_id"]
        self.assertTrue(minted["created"])
        self.assertEqual(len(agent_id), AGENT_ID_LENGTH)
        self.assertTrue(set(agent_id) <= set(AGENT_ID_ALPHABET), agent_id)
        self.assertIn(agent_id, minted["message"])
        confirmed = _result(self.mcp.call("agent.hello", {"agent_id": agent_id}))
        self.assertEqual(confirmed["agent_id"], agent_id)
        self.assertFalse(confirmed["created"])
        # A foreign/unknown id passed to hello mints a fresh one rather than
        # adopting a string the model made up.
        fresh = _result(self.mcp.call("agent.hello", {"agent_id": "nope42"}))
        self.assertTrue(fresh["created"])
        self.assertNotEqual(fresh["agent_id"], "nope42")
        # The identity row remembers the client the transport session declared.
        identity = self.brain.agent_identities.get(agent_id=agent_id)
        self.assertEqual(identity["client_name"], "claude-code")
        self.assertEqual(identity["client_version"], "9.9")
        self.assertEqual(identity["role"], "main")
        self.assertEqual(identity["mcp_session_id"], self.mcp.session_id)

    def test_attributed_calls_carry_the_id_and_a_payload_record(self) -> None:
        agent_id = _result(self.mcp.call("agent.hello", {}))["agent_id"]
        listed = self.mcp.call("project", {"action": "list", "agent_id": agent_id})
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertIn("projects", _result(listed))
        legacy = self.client.post(
            "/mcp/call",
            json={"name": "project", "arguments": {"action": "list", "agent_id": agent_id}},
        )
        self.assertEqual(legacy.status_code, 200, legacy.text)

        rows = self._rows()
        self.assertEqual([row["tool"] for row in rows], ["agent.hello", "project", "project"])
        for row in rows:
            with self.subTest(tool=row["tool"]):
                self.assertEqual(row["status"], "ok")
                self.assertEqual(row["agent_id"], agent_id)
                self.assertTrue(row["payload_ref"])
        # The hello row is the first line of the trace, under the id it minted.
        self.assertEqual(rows[0]["mcp_session_id"], self.mcp.session_id)
        self.assertEqual(rows[2]["mcp_session_id"], "")  # legacy route: no header

        payload = self.brain.tool_payloads.read(ref=rows[1]["payload_ref"])
        self.assertEqual(payload["agent_id"], agent_id)
        self.assertEqual(payload["tool"], "project")
        self.assertEqual(payload["status"], "ok")
        # The lifted argument is not echoed back into the record's arguments;
        # the row and record are already attributed.
        self.assertEqual(payload["arguments"], {"action": "list"})
        self.assertIn("projects", payload["result"])
        # On disk, in the blob store, beside artifacts — not in the database.
        blob_root = self.root / ".merv" / "blobs" / PAYLOAD_NAMESPACE
        self.assertTrue(any(blob_root.rglob("*.meta.json")))
        meta = json.loads(next(blob_root.rglob("*.meta.json")).read_text())
        self.assertTrue(meta["expires_at"])

    def test_the_operator_trace_reads_calls_with_their_payloads(self) -> None:
        agent_id = _result(self.mcp.call("agent.hello", {"note": "tracing"}))["agent_id"]
        self.mcp.call("project", {"action": "list", "agent_id": agent_id})
        listing = self.client.get("/api/admin/agents")
        self.assertEqual(listing.status_code, 200, listing.text)
        agents = listing.json()["agents"]
        self.assertEqual([agent["agent_id"] for agent in agents], [agent_id])
        self.assertEqual(agents[0]["calls"], 2)
        self.assertEqual(agents[0]["note"], "tracing")

        trace = self.client.get(f"/api/admin/agents/{agent_id}", params={"payloads": "true"})
        self.assertEqual(trace.status_code, 200, trace.text)
        body = trace.json()
        self.assertEqual(body["agent"]["agent_id"], agent_id)
        self.assertEqual([call["tool"] for call in body["calls"]], ["agent.hello", "project"])
        self.assertEqual(body["calls"][1]["payload"]["arguments"], {"action": "list"})
        self.assertFalse(body["more"])
        missing = self.client.get("/api/admin/agents/nope42")
        self.assertEqual(missing.status_code, 404, missing.text)


class OptionalModeTest(unittest.TestCase):
    def test_optional_mode_records_an_id_but_never_demands_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brain = TestBrain(
                repo_root=root,
                db_path=root / ".merv" / "state.sqlite",
                execution_backend=FakeSandboxBackend(),
                env={"MERV_AGENT_IDENTITY": "optional"},
            )
            try:
                mcp = _Mcp(TestClient(brain.fastapi_app))
                mcp.initialize()
                catalog = mcp.request("tools/list").json()["result"]["tools"]
                project = next(tool for tool in catalog if tool["name"] == "project")
                self.assertIn("agent_id", project["inputSchema"]["properties"])
                self.assertNotIn("agent_id", project["inputSchema"].get("required", []))
                self.assertEqual(mcp.call("project", {"action": "list"}).status_code, 200)
                self.assertIn("projects", _result(mcp.call("project", {"action": "list"})))
                agent_id = _result(mcp.call("agent.hello", {}))["agent_id"]
                _result(mcp.call("project", {"action": "list", "agent_id": agent_id}))
                # A made-up id is still refused: optional means "may omit", not
                # "may invent".
                error = _error(mcp.call("project", {"action": "list", "agent_id": "zzzzzz"}))
                self.assertEqual(error["data"]["error_code"], "agent_id_unknown")
                conn = brain.store.connect()
                try:
                    ids = [
                        str(row["agent_id"])
                        for row in conn.execute(
                            "SELECT agent_id FROM tool_calls ORDER BY id"
                        ).fetchall()
                    ]
                finally:
                    conn.close()
                self.assertEqual(ids, ["", "", agent_id, agent_id, ""])
            finally:
                brain.shutdown()


class BindingRulesTest(unittest.TestCase):
    """The service's own rules, independent of transport."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        self.identities = AgentIdentities(store=self.store)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_an_identity_belongs_to_the_user_that_minted_it(self) -> None:
        alice = CallerFacts(tenant_id="t", user_id="alice", principal_id="user:alice")
        bob = CallerFacts(tenant_id="t", user_id="bob", principal_id="user:bob")
        agent_id = self.identities.hello(caller=alice.as_dict())["agent_id"]
        self.assertEqual(
            self.identities.resolve(agent_id=agent_id, caller=alice, tool="x"), agent_id
        )
        # A rotated credential for the same user (a fresh OAuth access token)
        # keeps the identity: binding is by user, not by key.
        alice_again = CallerFacts(tenant_id="t", user_id="alice", principal_id="key:k2")
        self.assertEqual(
            self.identities.resolve(agent_id=agent_id, caller=alice_again, tool="x"),
            agent_id,
        )
        with self.assertRaises(AgentIdentityUnknownError):
            self.identities.resolve(agent_id=agent_id, caller=bob, tool="x")
        with self.assertRaises(AgentIdentityRequiredError):
            self.identities.resolve(agent_id="", caller=bob, tool="x")

    def test_local_callers_bind_by_tenant_when_there_is_no_user(self) -> None:
        local = CallerFacts(tenant_id="local", principal_id="local")
        other = CallerFacts(tenant_id="other", principal_id="local")
        agent_id = self.identities.hello(caller=local.as_dict())["agent_id"]
        self.assertEqual(
            self.identities.resolve(agent_id=agent_id, caller=local, tool="x"), agent_id
        )
        with self.assertRaises(AgentIdentityUnknownError):
            self.identities.resolve(agent_id=agent_id, caller=other, tool="x")

    def test_a_session_credential_falls_back_to_one_default_identity(self) -> None:
        worker = CallerFacts(
            tenant_id="t", user_id="alice", principal_id="agent-session:ags_1",
            agent_session_id="ags_1",
        )
        first = self.identities.resolve(agent_id="", caller=worker, tool="x")
        second = self.identities.resolve(agent_id="", caller=worker, tool="y")
        self.assertEqual(first, second)
        self.assertEqual(self.identities.get(agent_id=first)["role"], "session")
        # Its own hello still mints a distinct, session-bound identity — a
        # worker's subagent gets a context of its own.
        minted = self.identities.hello(role="subagent", caller=worker.as_dict())["agent_id"]
        self.assertNotEqual(minted, first)
        self.assertEqual(
            self.identities.resolve(agent_id=minted, caller=worker, tool="x"), minted
        )
        # An id from outside the session — even the same user's — is refused.
        parent = CallerFacts(tenant_id="t", user_id="alice", principal_id="user:alice")
        parent_id = self.identities.hello(caller=parent.as_dict())["agent_id"]
        with self.assertRaises(AgentIdentityUnknownError):
            self.identities.resolve(agent_id=parent_id, caller=worker, tool="x")
        other_worker = CallerFacts(
            tenant_id="t", user_id="alice", principal_id="agent-session:ags_2",
            agent_session_id="ags_2",
        )
        with self.assertRaises(AgentIdentityUnknownError):
            self.identities.resolve(agent_id=minted, caller=other_worker, tool="x")


class PayloadRetentionTest(unittest.TestCase):
    def test_pruned_rows_take_their_payload_records_with_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = StateStore(db_path=root / "state.sqlite")
            blobs = LocalDirBlobStore(root=root / "blobs")
            payloads = ToolCallPayloadStore(blobs=blobs, retention_days=7)
            ledger = ToolCallLedger(store=store, retention_days=7, payloads=payloads)
            token = begin_request(request_id="req-1")
            try:
                bind_agent(agent_id="abc234", mcp_session_id="sess")
                ledger.record(
                    tool="project", source="mcp", status="ok", duration_ms=3,
                    arguments={"action": "list", "reviewer_capability": "mas_secret"},
                    result={"projects": [], "note": "token mk_abcdef123 inside"},
                )
                bind_agent(agent_id="")
            finally:
                reset_request(token)
            conn = store.connect()
            try:
                row = dict(conn.execute("SELECT * FROM tool_calls").fetchone())
            finally:
                conn.close()
            self.assertEqual(row["agent_id"], "abc234")
            self.assertEqual(row["mcp_session_id"], "sess")
            ref = row["payload_ref"]
            self.assertTrue(ref)
            record = payloads.read(ref=ref)
            # Field-level and shape-level redaction both hold on disk.
            self.assertEqual(record["arguments"]["reviewer_capability"], "[redacted]")
            self.assertNotIn("mk_abcdef123", json.dumps(record))
            self.assertEqual(record["result"]["projects"], [])
            self.assertEqual(record["request_id"], "req-1")

            # Well past the horizon: the sweep removes the row AND the blob.
            report = ledger.prune(now=datetime.now(tz=UTC) + timedelta(days=30))
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["deleted"], 1)
            self.assertIsNone(payloads.read(ref=ref))
            self.assertFalse(list((root / "blobs" / PAYLOAD_NAMESPACE).rglob("*.meta.json")))
            ledger.close()

    def test_a_payload_failure_never_costs_the_row(self) -> None:
        class BrokenBlobs:
            def put(self, **_: Any) -> str:
                raise OSError("disk full")

            def get(self, **_: Any) -> bytes:
                raise OSError("disk full")

            def delete(self, **_: Any) -> bool:
                raise OSError("disk full")

        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(db_path=Path(tmp) / "state.sqlite")
            dropped: list[str] = []
            ledger = ToolCallLedger(
                store=store,
                payloads=ToolCallPayloadStore(blobs=BrokenBlobs(), retention_days=7),
                on_failure=dropped.append,
            )
            token = begin_request(request_id="req-2")
            try:
                bind_agent(agent_id="abc234")
                ledger.record(tool="project", source="mcp", status="ok", arguments={})
            finally:
                reset_request(token)
            conn = store.connect()
            try:
                row = dict(conn.execute("SELECT * FROM tool_calls").fetchone())
            finally:
                conn.close()
            self.assertEqual(row["agent_id"], "abc234")
            self.assertEqual(row["payload_ref"], "")
            self.assertEqual(len(dropped), 1)
            self.assertTrue(dropped[0].startswith("payload:"), dropped)
            ledger.close()


if __name__ == "__main__":
    unittest.main()
