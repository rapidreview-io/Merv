"""Research maintenance stays independent from infrastructure lifecycle."""
from __future__ import annotations

import unittest
from datetime import UTC, datetime
from unittest.mock import Mock

from merv.brain.application.maintenance import CleanupService


class ResearchMaintenanceTest(unittest.TestCase):
    def test_record_sweeps_run_with_one_clock(self):
        now = datetime(2026, 9, 8, tzinfo=UTC)
        logs = Mock()
        logs.prune.return_value = {"ok": True, "deleted": 3}
        oauth = Mock()
        oauth.prune.return_value = {"ok": True, "deleted": 4}
        sessions = Mock()
        sessions.reconcile.return_value = 5
        report = CleanupService(tool_call_ledger=logs,
                                oauth_clients=oauth, agent_sessions=sessions).run_all(now=now).as_dict()
        self.assertTrue(report["ok"])
        # merv-sandboxes owns object expiry; no storage sweep is reported.
        self.assertNotIn("storage_objects_swept", report)
        self.assertEqual(report["tool_calls_pruned"]["deleted"], 3)
        self.assertEqual(report["oauth_clients_pruned"]["deleted"], 4)
        self.assertEqual(report["agent_sessions_expired"], 5)
        logs.prune.assert_called_once_with(now=now)
        oauth.prune.assert_called_once_with(now=now)
        sessions.reconcile.assert_called_once_with(now=now)
        self.assertNotIn("blobs_swept", report)
        self.assertNotIn("orphan_vms_reaped", report)
        self.assertNotIn("cleanup_pending", report)

    def test_one_failure_does_not_cancel_other_record_retention(self):
        sessions = Mock()
        sessions.reconcile.side_effect = RuntimeError("session ledger unavailable")
        logs = Mock()
        logs.prune.return_value = {"ok": True, "deleted": 3}
        report = CleanupService(tool_call_ledger=logs,
                                agent_sessions=sessions).run_all().as_dict()
        self.assertFalse(report["ok"])
        self.assertIn("agent_sessions", report["sweep_errors"])
        self.assertEqual(report["tool_calls_pruned"]["deleted"], 3)

    def test_unconfigured_record_adapters_are_explicitly_skipped(self):
        report = CleanupService().run_all().as_dict()
        self.assertTrue(report["ok"])
        for key in ("tool_calls_pruned", "oauth_clients_pruned"):
            self.assertTrue(report[key]["skipped"])
