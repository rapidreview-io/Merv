"""Wait capabilities retain tenant scope and identify native jobs uniquely."""
from __future__ import annotations

import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

from merv.brain.infrastructure.client import InfrastructureUnavailableError
from merv.brain.infrastructure.sandboxes import RemoteSandboxes
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import parse_iso
from tests.support.infrastructure import FakeInfrastructureClient, project_namespace


class NativeWaitContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.db")
        with self.store.transaction() as conn:
            for pid in ("p1", "p2"):
                conn.execute("INSERT INTO projects (id,name,created_at) VALUES (?,?,?)", (pid, pid, "2026-09-08T00:00:00Z"))
        self.client = FakeInfrastructureClient()
        self.service = RemoteSandboxes(client=self.client, store=self.store)
        self.client.seed(project_namespace("p1"), "sbx_one")
        self.service._link("p1", "sbx_one", "exp_one")

    def test_equal_job_names_have_distinct_signed_wait_urls(self):
        self.client.seed_jobs(project_namespace("p1"), "sbx_one",
                              {"label": "job_1", "name": "train", "exit_code": 0},
                              {"label": "job_2", "name": "train"})
        result = self.service.runs(project_id="p1", sandbox_uid="sbx_one",
                                   base_url="https://merv.test", wait_secret=b"x" * 32)
        rows = result["runs"]
        self.assertEqual([row["label"] for row in rows], ["job_1", "job_2"])
        self.assertEqual([row["name"] for row in rows], ["train", "train"])
        self.assertNotEqual(rows[0]["wait_url"], rows[1]["wait_url"])
        self.assertIn("/sbx_one/job_1/", rows[0]["wait_url"])

    def test_wait_cannot_read_a_job_on_another_sandbox(self):
        self.client.seed_jobs(project_namespace("p1"), "sbx_other", {"label": "job_1", "exit_code": 0})
        self.assertIsNone(self.service.run_wait_facts(sandbox_uid="sbx_one", label="job_1"))

    def test_wait_never_searches_other_project_namespaces(self):
        self.client.seed_jobs(project_namespace("p2"), "sbx_one", {"label": "job_1", "exit_code": 0})
        facts = self.service.run_wait_facts(sandbox_uid="sbx_one", label="job_1")
        self.assertFalse(facts["present"])
        self.assertTrue(all(call[2] == project_namespace("p1") for call in self.client.calls))
        self.service._link("p2", "sbx_one")
        self.client.calls.clear()
        self.assertIsNone(self.service.run_wait_facts(sandbox_uid="sbx_one", label="job_1"))
        self.assertEqual(self.client.calls, [])

    def test_service_read_is_fresh_and_failures_are_retryable(self):
        self.client.seed_jobs(project_namespace("p1"), "sbx_one",
                              {"label": "job_1", "exit_code": 0, "finished_at": "2020-01-01T00:00:00Z"})
        before = datetime.now(UTC).replace(microsecond=0)
        facts = self.service.run_wait_facts(sandbox_uid="sbx_one", label="job_1")
        self.assertEqual((facts["status"], facts["exit_code"]), ("finished", 0))
        self.assertGreaterEqual(parse_iso(facts["observed_at"]), before)
        self.client.healthy = False
        with self.assertRaises(InfrastructureUnavailableError):
            self.service.run_wait_facts(sandbox_uid="sbx_one", label="job_1")

    def test_closed_legacy_runs_remain_scoped_read_only_history(self):
        with self.store.transaction() as conn:
            conn.execute("INSERT INTO sandboxes (sandbox_uid,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?)",
                         ("legacy", "p1", "terminated", "2020-01-01", "2020-01-01"))
            conn.execute("INSERT INTO sandbox_runs (sandbox_uid,label,exit_code,first_seen_at,updated_at) VALUES (?,?,?,?,?)",
                         ("legacy", "train", 0, "2020-01-01", "2020-01-01"))
        result = self.service.runs(project_id="p1", sandbox_uid="legacy", base_url="https://merv.test", wait_secret=b"x" * 32)
        self.assertEqual(len(result["runs"]), 1)
        self.assertTrue(result["runs"][0]["archived"])
        self.assertEqual(result["runs"][0]["status"], "finished")
        self.assertNotIn("wait_url", result["runs"][0])
        self.assertEqual(self.client.calls, [])
