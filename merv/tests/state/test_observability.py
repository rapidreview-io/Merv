"""Observability: structured logs + per-tenant counters (cloud plan Phase 9).

The structured logger emits redacted JSON to stdout in control mode only (so no
token/capability leaks and local mode stays silent); the per-tenant counters
read RED-ish usage from the events table + the generation ledger.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.surface.telemetry import StructuredLogger


class StructuredLoggerTest(unittest.TestCase):
    def test_disabled_logger_emits_nothing(self) -> None:
        stream = io.StringIO()
        logger = StructuredLogger(enabled=False, stream=stream)
        logger.log(kind="http", path="/api/projects", status=200)
        self.assertEqual(stream.getvalue(), "")

    def test_enabled_logger_emits_one_json_line(self) -> None:
        stream = io.StringIO()
        logger = StructuredLogger(enabled=True, stream=stream)
        logger.log(
            kind="http",
            request_id="abc123",
            tenant_id="acme",
            path="/api/projects",
            status=200,
            duration_ms=12,
            method="GET",
        )
        lines = [ln for ln in stream.getvalue().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 1)
        record = json.loads(lines[0])
        self.assertEqual(record["request_id"], "abc123")
        self.assertEqual(record["tenant_id"], "acme")
        self.assertEqual(record["status"], 200)
        self.assertEqual(record["duration_ms"], 12)

    def test_sensitive_fields_are_redacted(self) -> None:
        stream = io.StringIO()
        logger = StructuredLogger(enabled=True, stream=stream)
        logger.log(
            kind="tool",
            tool="review.start",
            status="ok",
            capability="super-secret-token",
            reviewer_capability="another-secret",
            MLFLOW_TRACKING_PASSWORD="rr_sk_agent",
            nested={"items": ({"MLFLOW_TRACKING_PASSWORD": "nested-secret"},)},
        )
        out = stream.getvalue()
        self.assertNotIn("super-secret-token", out)
        self.assertNotIn("another-secret", out)
        self.assertNotIn("rr_sk_agent", out)
        self.assertNotIn("nested-secret", out)
        record = json.loads(out.splitlines()[0])
        self.assertEqual(record["capability"], "[redacted]")
        self.assertEqual(record["reviewer_capability"], "[redacted]")
        self.assertEqual(record["MLFLOW_TRACKING_PASSWORD"], "[redacted]")
        self.assertEqual(
            record["nested"]["items"][0]["MLFLOW_TRACKING_PASSWORD"],
            "[redacted]",
        )

    def test_status_zero_is_kept_even_when_falsey(self) -> None:
        # status is always present (the empty-field prune exempts it).
        stream = io.StringIO()
        logger = StructuredLogger(enabled=True, stream=stream)
        logger.log(kind="tool", tool="x", status="")
        record = json.loads(stream.getvalue().splitlines()[0])
        self.assertIn("status", record)


class TenantCountersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.store = self.app.store
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Proj P"}
        )["id"]
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE projects SET tenant_id = ? WHERE id = ?",
                ("tenant_x", self.project_id),
            )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def test_counts_are_tenant_scoped(self) -> None:
        with self.store.transaction() as conn:
            self.store.record_event(
                conn=conn,
                project_id=self.project_id,
                event_type="audit.test",
                target_type="experiment",
                target_id="exp",
                payload={"k": "v"},
            )
        counts = self.app.application.tenant_counters(tenant_id="tenant_x")
        self.assertEqual(counts["tenant_id"], "tenant_x")
        self.assertGreaterEqual(counts["tool_calls"], 1)

    def test_other_tenant_sees_nothing(self) -> None:
        counts = self.app.application.tenant_counters(tenant_id="tenant_none")
        self.assertEqual(counts["tool_calls"], 0)


if __name__ == "__main__":
    unittest.main()
