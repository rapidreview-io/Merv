"""Deterministic namespace-scoped implementation of the native HTTP client port."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from merv.brain.infrastructure.client import InfrastructureUnavailableError, project_namespace
from merv.brain.kernel.utils import NotFoundError


class FakeInfrastructureClient:
    def __init__(self) -> None:
        self.records: dict[str, dict[str, dict[str, Any]]] = {}
        self.jobs: dict[str, dict[str, dict[str, Any]]] = {}
        self.providers: dict[str, dict[str, dict[str, Any]]] = {}
        self.calls: list[tuple[str, str, str, Any]] = []
        self.healthy = True
        self.counter = 0
        self.spend_reports = {}
        self.url = "https://sandboxes.test"
        self.offer = {
            "provider": "fake", "plugin": "fake", "offer_id": "tiny:east",
            "instance_type": "tiny", "region": "east", "available": True,
            "resources": {"cpu": 8, "memory_mb": 16384, "gpu": None, "gpu_count": 0},
            "hourly_price": {"amount": "0.01", "currency": "USD"},
        }

    def seed(self, namespace: str, sandbox_id: str, **fields: Any) -> dict[str, Any]:
        now = datetime.now(UTC)
        record = {
            "id": sandbox_id, "namespace": namespace, "name": "", "state": "ready",
            "provider": "fake", "plugin": "fake", "offer": deepcopy(self.offer),
            "request": {"lease_seconds": 3600}, "created_at": now.isoformat(),
            "updated_at": now.isoformat(), "ready_at": now.isoformat(),
            "lease_expires_at": (now + timedelta(hours=1)).isoformat(),
            "stopped_at": None, "cost_so_far": {"amount": "0", "currency": "USD"},
        }
        record.update(fields)
        self.records.setdefault(namespace, {})[sandbox_id] = record
        return deepcopy(record)

    def seed_jobs(self, namespace: str, sandbox_id: str, *runs: dict[str, Any]) -> None:
        jobs = self.jobs.setdefault(namespace, {})
        for run in runs:
            label = run["label"]
            jobs[label] = {"id": label, "name": run.get("name", label), "sandbox_id": sandbox_id,
                           "state": run.get("state") or ("succeeded" if run.get("exit_code") == 0 else "failed" if run.get("exit_code") is not None else "running"),
                           "exit_code": run.get("exit_code"), "created_at": datetime.now(UTC).isoformat(),
                           "updated_at": run.get("finished_at") or datetime.now(UTC).isoformat(),
                           "request": {"command": "python train.py"}}

    def request(self, method: str, path: str, *, namespace: str,
                json: Any = None, params: Any = None) -> dict[str, Any]:
        self.calls.append((method, path, namespace, deepcopy(json)))
        if not self.healthy:
            raise InfrastructureUnavailableError("test infrastructure unavailable")
        records = self.records.setdefault(namespace, {})
        if path == "/spend/report":
            return deepcopy(self.spend_reports.get(namespace, {
                "namespace": namespace, "member_id": None, "as_of": datetime.now(UTC).isoformat(),
                "accrued": [], "reserved": [], "hourly_rate": [], "hours": "0", "unpriced_hours": "0",
                "resource_count": 0, "active_resource_count": 0, "resources": [], "adjustments": [],
                "daily": [], "by_hardware": [],
            }))
        if path == "/sandboxes":
            if method == "GET":
                return {"sandboxes": deepcopy(list(records.values()))}
            if method == "POST":
                for row in records.values():
                    if row["request"].get("idempotency_key") == json.get("idempotency_key"):
                        return deepcopy(row)
                self.counter += 1
                return self.seed(namespace, f"sbx_{self.counter}", name=json.get("name", ""),
                                 request=json, provider=json["provider"])
        if path == "/options":
            return {"offers": [deepcopy(self.offer)]}
        if path == "/access/certificates":
            if json["sandbox_id"] not in records:
                raise NotFoundError("sandbox not found")
            return {"certificate": "ssh-ed25519-cert-v01@openssh.com AAAAcertificate",
                    "expires_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                    "gateway": {"host": "gateway.test", "port": 2222,
                                "host_public_key": "ssh-ed25519 AAAAgateway"}}
        if path.startswith("/sandboxes/"):
            sandbox_id, _, action = path[len("/sandboxes/"):].partition("/")
            if sandbox_id not in records:
                raise NotFoundError("sandbox not found")
            row = records[sandbox_id]
            if action == "renew":
                row["lease_expires_at"] = (datetime.now(UTC) + timedelta(seconds=json["lease_seconds"])).isoformat()
            elif action == "jobs" and method == "POST":
                jobs = self.jobs.setdefault(namespace, {})
                job = {"id": f"job_{len(jobs) + 1}", "sandbox_id": sandbox_id,
                       "state": "running", "request": json, "name": json.get("name"), "exit_code": None,
                       "created_at": datetime.now(UTC).isoformat(), "result": None}
                jobs[job["id"]] = job
                return deepcopy(job)
            elif action == "sessions":
                return {"sessions": []}
            elif method == "DELETE":
                row["state"] = "stopped"
                row["stopped_at"] = datetime.now(UTC).isoformat()
            return deepcopy(row)
        if path == "/jobs":
            return {"jobs": deepcopy([job for job in self.jobs.get(namespace, {}).values()
                                     if not params or not params.get("sandbox_id") or job["sandbox_id"] == params["sandbox_id"]]), "next": None}
        if path.startswith("/jobs/"):
            job_id, _, action = path[len("/jobs/"):].partition("/")
            if job_id not in self.jobs.get(namespace, {}):
                raise NotFoundError("job not found")
            job = self.jobs[namespace][job_id]
            if action == "cancel":
                job["state"] = "cancelled"
            return deepcopy(job)
        if path == "/providers":
            return {"providers": deepcopy(list(self.providers.setdefault(namespace, {"fake": {"name": "fake", "plugin": "fake", "source": "user", "health": {"status": "ok"}}}).values())),
                    "plugins": [{"name": "fake", "credential_fields": []},
                                {"name": "aws", "credential_fields": [
                                    {"name": "access_key_id", "required": True, "secret": False},
                                    {"name": "secret_access_key", "required": True, "secret": True}]}]}
        if path.startswith("/providers/"):
            name = path.rsplit("/", 1)[1]
            providers = self.providers.setdefault(namespace, {})
            if method == "DELETE":
                providers.pop(name, None)
                return {}
            providers[name] = {"name": name, "plugin": json["plugin"], "source": "user",
                               "health": {"status": "ok", "message": "verified"}}
            return deepcopy(providers[name])
        if path == "/storage/objects":
            return {"objects": []}
        if path == "/spend":
            return {"spend": [], "sandboxes": []}
        raise AssertionError(f"Unhandled native service request: {method} {path}")

    def request_bytes(self, method: str, path: str, *, namespace: str,
                      params: Any = None) -> tuple[bytes, dict[str, str]]:
        return b"", {"x-next-offset": "0", "x-truncated": "false"}

    def health(self) -> dict[str, Any]:
        return {"ok": self.healthy, "backend": "merv-sandboxes"}

    def close(self) -> None:
        pass


def seed_sandbox(sandboxes: Any, *, experiment_id: str, sandbox_uid: str,
                 expected_project_id: str = "", **fields: Any) -> None:
    project_id = fields.get("project_id") or expected_project_id
    namespace = project_namespace(project_id)
    state = {"running": "ready", "terminated": "stopped"}.get(fields.get("status"), "ready")
    sandboxes.client.seed(namespace, sandbox_uid, state=state)
    sandboxes._link(project_id, sandbox_uid, experiment_id)
