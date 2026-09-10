from __future__ import annotations

import base64
import copy
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from merv.brain.infrastructure.client import InfrastructureUnavailableError
from merv.brain.infrastructure.providers import RemoteProviders
from merv.brain.infrastructure.sandboxes import RemoteSandboxes
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError


PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm test"


class RemoteClient:
    def __init__(self):
        self.calls = []
        self.records = {"p1": [], "p2": []}
        self.jobs = {}
        self.providers = {"cloud": {"name": "cloud", "plugin": "cloud", "source": "host", "health": {"status": "ok"}}}
        self.fail = False
        self.lost_response = False
        self.offer = {"provider": "cloud", "plugin": "cloud", "offer_id": "cpu:us", "instance_type": "cpu",
                      "region": "us", "resources": {"cpu": 2, "memory_mb": 8192, "gpu": None},
                      "hourly_price": {"currency": "USD", "amount": "1.25"}, "available": True}

    def request(self, method, path, *, namespace, json=None, params=None):
        self.calls.append((method, path, namespace, copy.deepcopy(json), params))
        if self.fail:
            raise InfrastructureUnavailableError("service down")
        rows = self.records[namespace]
        if path == "/spend/report":
            return copy.deepcopy(self.report)
        if path == "/options":
            return {"offers": [copy.deepcopy(self.offer)]}
        if path == "/sandboxes" and method == "GET":
            return {"sandboxes": copy.deepcopy(rows)}
        if path == "/sandboxes" and method == "POST":
            now = datetime.now(UTC)
            row = {"id": "sbx_" + str(len(rows) + 1), "namespace": namespace, "name": json.get("name", ""),
                   "state": "ready", "provider": "cloud", "plugin": "cloud", "request": dict(json),
                   "offer": copy.deepcopy(self.offer), "created_at": now.isoformat(),
                   "ready_at": now.isoformat(), "updated_at": now.isoformat(),
                   "lease_expires_at": (now + timedelta(seconds=json["lease_seconds"])).isoformat(),
                   "stopped_at": None, "cost_so_far": {"currency": "USD", "amount": "0"},
                   "endpoint": {"host": "do-not-expose-provider.example", "port": 22, "user": "root"}}
            rows.append(row)
            if self.lost_response:
                self.lost_response = False
                raise InfrastructureUnavailableError("response lost after provisioning")
            return copy.deepcopy(row)
        if path == "/access/certificates":
            return {"certificate": "ssh-ed25519-cert-v01@openssh.com certificate", "expires_at": "2099-01-01T00:00:00Z",
                    "gateway": {"host": "ssh.sandboxes.test", "port": 2222, "host_public_key": "ssh-ed25519 gateway"}}
        if path == "/jobs":
            return {"jobs": [copy.deepcopy(job) for job in self.jobs.values()
                             if job["namespace"] == namespace and job["sandbox_id"] == params["sandbox_id"]]}
        if path.startswith("/jobs/"):
            jid = path.split("/")[2]
            if jid not in self.jobs or self.jobs[jid]["namespace"] != namespace:
                raise NotFoundError("job not found")
            return copy.deepcopy(self.jobs[jid])
        if path.startswith("/sandboxes/"):
            uid = path.split("/")[2]
            row = next((row for row in rows if row["id"] == uid), None)
            if not row:
                raise NotFoundError("sandbox not found")
            if method == "DELETE":
                row["state"] = "deleting"
            if path.endswith("/renew"):
                row["lease_expires_at"] = (datetime.now(UTC) + timedelta(seconds=json["lease_seconds"])).isoformat()
            return copy.deepcopy(row)
        if path == "/providers":
            return {"providers": list(self.providers.values()), "plugins": [
                {"name": "cloud", "credential_fields": [{"name": "api_key", "required": True, "secret": True}]}]}
        if path.startswith("/providers/"):
            name = path.split("/")[2]
            if method == "PUT":
                self.providers[name] = {"name": name, "plugin": json["plugin"], "source": "namespace",
                                        "health": {"status": "ok"}, "verified_at": "2026-09-08T00:00:00Z"}
                return self.providers[name]
            if method == "DELETE":
                self.providers.pop(name)
                return {}
        raise AssertionError((method, path, json, params))

    def request_bytes(self, method, path, *, namespace, params=None):
        self.calls.append((method, path, namespace, None, params))
        return b"job output", {"x-output-total-length": "10", "x-output-complete": "1"}

    def health(self):
        return {"ok": not self.fail, "backend": "merv-sandboxes"}


class RemoteSandboxesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "test.db")
        with self.store.transaction() as conn:
            for pid in ("p1", "p2"):
                conn.execute("INSERT INTO projects (id,name,created_at) VALUES (?,?,?)", (pid, pid, "2026-09-08T00:00:00Z"))
        self.client = RemoteClient()
        self.engine = RemoteSandboxes(client=self.client, store=self.store, attachment_check=self.check_experiment)

    def tearDown(self):
        self.tmp.cleanup()

    def check_experiment(self, *, attachment_id, project_id):
        if attachment_id not in {"e1", "e2"} or project_id != "p1":
            raise NotFoundError("experiment not in project")

    def create(self, **kwargs):
        return self.engine.request(project_id="p1", experiment_id="e1", public_key=PUBLIC_KEY,
                                   instance_type="cpu:us", provider="cloud", **kwargs)

    def test_gateway_certificate_and_association_survive_reconstruction(self):
        facts = self.create()
        again = RemoteSandboxes(client=self.client, store=self.store, attachment_check=self.check_experiment)
        result = again.get(project_id="p1", experiment_id="e1")
        self.assertEqual(result["sandbox_uid"], facts["sandbox_uid"])
        self.assertEqual(result["ssh"]["host"], "ssh.sandboxes.test")
        self.assertIn("certificate", result["ssh"])
        self.assertNotIn("do-not-expose-provider", str(result))

    def test_hardware_public_keys_follow_the_shared_supported_key_contract(self):
        fields = [b"sk-ssh-ed25519@openssh.com", b"f" * 32, b"ssh:test"]
        blob = b"".join(len(field).to_bytes(4, "big") + field for field in fields)
        key = "sk-ssh-ed25519@openssh.com " + base64.b64encode(blob).decode("ascii")
        facts = self.engine.request(project_id="p1", experiment_id="e1", public_key=key,
                                    instance_type="cpu:us", provider="cloud")
        certificate_request = next(call for call in self.client.calls if call[1] == "/access/certificates")
        self.assertEqual(certificate_request[3]["public_key"], key)
        self.assertIn("[ssh.host]:ssh.port ssh.host_public_key", facts["hint"])

    def test_unknown_liveness_reuses_instead_of_double_provisioning(self):
        first = self.create()
        self.client.records["p1"][0]["state"] = "unknown"
        second = self.create()
        self.assertEqual(first["sandbox_uid"], second["sandbox_uid"])
        self.assertTrue(second["reused"])
        self.assertEqual(sum(method == "POST" and path == "/sandboxes" for method, path, *_ in self.client.calls), 1)

    def test_remote_accepted_request_is_recovered_after_lost_response(self):
        self.client.lost_response = True
        with self.assertRaises(InfrastructureUnavailableError):
            self.create()
        facts = self.create()
        self.assertTrue(facts["reused"])
        self.assertEqual(len(self.client.records["p1"]), 1)

    def test_release_requires_retention_then_waits_for_confirmed_deletion(self):
        facts = self.create()
        args = {"project_id": "p1", "sandbox_uid": facts["sandbox_uid"]}
        self.assertEqual(self.engine.release(**args)["status"], "confirmation_required")
        self.assertFalse(any(method == "DELETE" for method, *_ in self.client.calls))
        result = self.engine.release(**args, confirm_retained=True)
        self.assertEqual(result["status"], "cleanup_pending")
        self.assertFalse(result["released"])

    def test_foreign_project_cannot_read_or_attach(self):
        facts = self.create()
        with self.assertRaises(NotFoundError):
            self.engine.get(project_id="p2", sandbox_uid=facts["sandbox_uid"])
        with self.assertRaises(NotFoundError):
            self.engine.attach(project_id="p2", experiment_id="e1", sandbox_uid=facts["sandbox_uid"])
        with self.assertRaises(NotFoundError):
            self.engine.get(project_id="p2", experiment_id="e1")

    def test_association_restricts_job_cancel_and_output(self):
        facts = self.create()
        self.client.jobs["job_1"] = {"id": "job_1", "name": "train", "namespace": "p1",
                                       "sandbox_id": facts["sandbox_uid"], "state": "running"}
        before = len(self.client.calls)
        with self.assertRaises(NotFoundError):
            self.engine.job(project_id="p1", experiment_id="e2", job_id="job_1", cancel=True, stream="stdout")
        calls = self.client.calls[before:]
        self.assertFalse(any(path.endswith("/cancel") or path.endswith("/output") for _, path, *_ in calls))
        result = self.engine.job(project_id="p1", experiment_id="e1", job_id="job_1", stream="stdout")
        self.assertEqual(result["output"]["text"], "job output")

    def test_extend_adds_to_existing_expiry(self):
        facts = self.create(time_limit=7200)
        self.engine.extend(project_id="p1", sandbox_uid=facts["sandbox_uid"], seconds=1800)
        body = next(body for method, path, ns, body, params in reversed(self.client.calls) if path.endswith("/renew"))
        self.assertGreaterEqual(body["lease_seconds"], 8999)

    def test_terminal_projects_bounded_job_streams_as_replacement(self):
        facts = self.create()
        self.client.jobs["job_1"] = {"id": "job_1", "name": "train", "namespace": "p1",
                                       "sandbox_id": facts["sandbox_uid"], "state": "running", "command": "python train.py",
                                       "outputs": [{"stream": "stdout", "total_length": 100000, "available_start": 0},
                                                   {"stream": "stderr", "total_length": 200, "available_start": 0}]}
        result = self.engine.terminal(project_id="p1", sandbox_uid=facts["sandbox_uid"], tail=1000, since=800)
        self.assertTrue(result["replace"])
        self.assertTrue(result["available"])
        self.assertEqual(result["job_id"], "job_1")
        self.assertIn("[stdout; earlier output omitted]", result["transcript"])
        self.assertIn("[stderr]", result["transcript"])
        reads = [params for _, path, _, _, params in self.client.calls if path.endswith("/output")]
        self.assertEqual(reads[0]["start"], 99500)
        self.assertEqual(sum(params["max_bytes"] for params in reads), 1000)

    def test_unknown_service_failure_does_not_become_empty_fleet(self):
        self.client.fail = True
        with self.assertRaises(InfrastructureUnavailableError):
            self.engine.for_project(project_id="p1")
        self.assertFalse(self.engine.health()["ok"])

    def test_no_private_key_or_unsafe_pull_paths_are_accepted(self):
        with self.assertRaises(ValidationError):
            self.engine.request(project_id="p1", public_key="-----BEGIN PRIVATE KEY-----")
        facts = self.create()
        with self.assertRaises(ValidationError):
            self.engine.pull_outputs_command(project_id="p1", sandbox_uid=facts["sandbox_uid"], paths=["../secret"])

    def test_spend_reports_service_totals_only(self):
        facts = self.create()
        self.client.report = {
            "namespace": "explicit-remote", "member_id": "member-one", "as_of": "2026-09-09T00:00:00Z",
            "accrued": [{"currency": "USD", "amount": "4.25"}], "reserved": [], "hourly_rate": [],
            "hours": "2", "unpriced_hours": "0", "resource_count": 1, "active_resource_count": 0,
            "resources": [{"id": facts["sandbox_uid"], "accrued": {"currency": "USD", "amount": "3"}, "hours": "2"}],
            "adjustments": [{"id": "imported", "accrued": {"currency": "USD", "amount": "1.25"}}],
            "daily": [{"date": "2026-09-07", "totals": [{"currency": "USD", "amount": "4.25"}], "hours": "2"}],
        }
        costs = self.engine.project_spend(project_id="p1")
        self.assertEqual(costs["total_usd"], 4.25)
        self.assertEqual(costs["total_hours"], 2)
        self.assertEqual(costs["by_experiment"][0]["usd"], 3)
        self.assertEqual(costs["daily"][0]["usd"], 4.25)
        self.assertEqual(costs["scope"]["namespace"], "explicit-remote")
        self.assertEqual(self.client.calls[-1][1], "/spend/report")
        self.client.fail = True
        with self.assertRaises(InfrastructureUnavailableError):
            self.engine.project_spend(project_id="p1")
        with self.assertRaises(ValidationError):
            RemoteSandboxes(client=None, store=self.store).project_spend(project_id="p1")

    def test_provider_overview_is_read_only(self):
        providers = RemoteProviders(client=self.client, store=self.store)
        self.assertEqual(providers.overview(project_id="p1")["providers"][0]["provider"], "cloud")
        self.assertTrue(all(call[0] == "GET" for call in self.client.calls))

if __name__ == "__main__":
    unittest.main()
