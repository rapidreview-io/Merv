"""Research projections over the independent merv-sandboxes HTTP service.

Only experiment associations and caller public keys are stored here. Rental,
credentials, access certificates, jobs, spend and cleanup belong to the
service, and so does the register of what machines ever existed: nothing here
reads a local mirror of the fleet.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shlex
import uuid
from contextlib import closing
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol
from urllib.parse import quote

from ...shared.tool_validation import validate_openssh_public_key
from ..kernel.utils import NotFoundError, ValidationError, now_iso, parse_iso
from ..kernel.state import BaseStateStore
from .ports import InfrastructureTransport, project_namespace
from .persistence import INFRASTRUCTURE_SCHEMA


_ACTIVE = frozenset({"requested", "provisioning", "bootstrapping", "ready", "unknown", "failed"})
_TERMINAL_JOBS = frozenset({"succeeded", "failed", "cancelled", "timed_out"})
_STATUS = {"requested": "provisioning", "provisioning": "provisioning",
           "bootstrapping": "provisioning", "ready": "running",
           "delete_requested": "cleanup_pending", "deleting": "cleanup_pending",
           "delete_failed": "cleanup_pending", "stopped": "terminated"}
_DEFAULT_OUTPUTS = ("results", "figures", "report.md", "graph.json", "metrics.json", "results.json")
# What merv-sandboxes actually honours on GET /jobs/{id}?wait=: its job service
# clamps to this, so a larger ask here would only promise a hold nobody keeps.
MAX_WAIT_SECONDS = 30


def _path(value: str) -> str:
    if not value or value in {".", ".."}:
        raise ValidationError("sandbox id must be non-empty")
    return quote(value, safe="")


def _usd(value: Any) -> float | None:
    if not isinstance(value, dict) or value.get("currency") != "USD":
        return None
    return float(value["amount"])


class ExperimentAttachmentCheck(Protocol):
    def __call__(self, *, attachment_id: str, project_id: str) -> None: ...


class RemoteSandboxes:
    """The Merv sandbox API backed exclusively by service calls."""

    def __init__(
        self, *, client: InfrastructureTransport | None, store: BaseStateStore,
        attachment_check: ExperimentAttachmentCheck | None = None,
        storage_enabled: bool = True, **_: Any,
    ) -> None:
        self.client = client
        self._store = store
        self.attachment_check = attachment_check
        store.install(INFRASTRUCTURE_SCHEMA)
        self.storage_enabled = storage_enabled

    def _project(self, project_id: str | None) -> str:
        with closing(self._store.connect()) as conn:
            return self._store.require_project_id(conn=conn, project_id=project_id)

    def _call(self, method: str, path: str, *, project_id: str, **kwargs: Any) -> dict[str, Any]:
        if self.client is None:
            raise ValidationError("merv-sandboxes is not configured")
        return self.client.request(method, path, namespace=project_namespace(project_id), **kwargs)

    def _check_experiment(self, project_id: str, experiment_id: str | None) -> None:
        if experiment_id and self.attachment_check:
            self.attachment_check(attachment_id=experiment_id, project_id=project_id)

    def _links(self, project_id: str, sandbox_uid: str | None = None) -> list[dict[str, Any]]:
        with closing(self._store.connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM remote_sandbox_links WHERE project_id = ?"
                + (" AND sandbox_uid = ?" if sandbox_uid else "") + " ORDER BY created_at",
                (project_id, sandbox_uid) if sandbox_uid else (project_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def _link(self, project_id: str, sandbox_uid: str, experiment_id: str = "", public_key: str = "") -> None:
        with self._store.transaction() as conn:
            conn.execute(
                "INSERT INTO remote_sandbox_links (project_id,sandbox_uid,experiment_id,public_key,created_at) "
                "VALUES (?,?,?,?,?) ON CONFLICT (project_id,sandbox_uid,experiment_id) "
                "DO UPDATE SET public_key = CASE WHEN excluded.public_key <> '' "
                "THEN excluded.public_key ELSE remote_sandbox_links.public_key END",
                (project_id, sandbox_uid, experiment_id, public_key, now_iso()),
            )

    def _records(self, project_id: str) -> list[dict[str, Any]]:
        if self.client is None:
            return []
        return self._call("GET", "/sandboxes", project_id=project_id,
                          params={"include_stopped": "true"}).get("sandboxes", [])

    def _record(self, project_id: str, sandbox_uid: str | None, experiment_id: str | None) -> dict[str, Any]:
        self._check_experiment(project_id, experiment_id)
        if sandbox_uid:
            record = self._call("GET", "/sandboxes/" + _path(sandbox_uid), project_id=project_id)
            if experiment_id and not any(link["experiment_id"] == experiment_id
                                         for link in self._links(project_id, sandbox_uid)):
                raise NotFoundError("sandbox is not attached to this experiment")
            return record
        if not experiment_id:
            raise ValidationError("experiment_id or sandbox_uid is required")
        ids = {link["sandbox_uid"] for link in self._links(project_id)
               if link["experiment_id"] == experiment_id}
        rows = [row for row in self._records(project_id) if row["id"] in ids]
        rows.sort(key=lambda row: (row.get("state") in _ACTIVE, row.get("created_at", "")), reverse=True)
        if not rows:
            raise NotFoundError("no sandbox for this experiment")
        return rows[0]

    def _snapshot(self, project_id: str, record: dict[str, Any]) -> dict[str, Any]:
        links = self._links(project_id, record["id"])
        experiments = [link["experiment_id"] for link in links if link["experiment_id"]]
        offer = record.get("offer") or {}
        resources = offer.get("resources") or {}
        error = record.get("last_error") or {}
        state = str(record.get("state", "unknown"))
        status = _STATUS.get(state, state)
        return {
            "sandbox_uid": record["id"], "sandbox_id": record["id"],
            "project_id": project_id, "experiment_id": experiments[0] if experiments else "",
            "active_experiment_ids": experiments, "status": status,
            "phase": state, "detail": error.get("message", ""), "error": error.get("message", ""),
            "provider": record.get("provider", ""), "instance_type": offer.get("instance_type", ""),
            "region": offer.get("region", ""), "gpu": resources.get("gpu") or "",
            "cpu": resources.get("cpu"), "memory": resources.get("memory_mb"),
            "time_limit": (record.get("request") or {}).get("lease_seconds"),
            "workdir": "/workspace", "sync_dir": "/workspace", "sandbox_data_dir": "/workspace",
            "public_key_source": "caller_certificate", "ssh_host": None, "ssh_port": None,
            "ssh_user": record["id"], "volume_name": None,
            "requested_at": record.get("created_at"), "created_at": record.get("created_at"),
            "updated_at": record.get("updated_at"), "expires_at": record.get("lease_expires_at"),
            "last_seen_at": record.get("agent_seen_at"), "terminated_at": record.get("stopped_at"),
            "price_usd_per_hour": _usd(record.get("hourly_price") or offer.get("hourly_price")),
            "cost_usd": _usd(record.get("cost_so_far")), "infrastructure": "merv-sandboxes",
            "billing_started_at": record.get("ready_at") or record.get("created_at"),
        }

    def _facts(self, project_id: str, record: dict[str, Any], *, public_key: str = "") -> dict[str, Any]:
        facts = self._snapshot(project_id, record)
        facts.update(experiment_dir="/workspace", data_dir="/workspace", storage_enabled=self.storage_enabled)
        facts["ssh"] = {"host": None, "port": None, "user": record["id"]}
        if not public_key:
            public_key = next((link["public_key"] for link in reversed(self._links(project_id, record["id"]))
                               if link["public_key"]), "")
        if facts["status"] == "running" and public_key:
            issued = self._call("POST", "/access/certificates", project_id=project_id,
                                json={"public_key": public_key, "sandbox_id": record["id"]})
            gateway = issued["gateway"]
            facts["ssh"] = {
                "host": gateway["host"], "port": gateway["port"], "user": record["id"],
                "certificate": issued["certificate"], "certificate_expires_at": issued["expires_at"],
                "host_public_key": gateway.get("host_public_key"),
            }
            facts.update(ssh_host=gateway["host"], ssh_port=gateway["port"])
        facts["hint"] = (
            "Work in /workspace. Use sandbox.run for durable jobs, sandbox.runs for their status, "
            "and sandbox.job for output and results. For SSH, save ssh.certificate beside your "
            "private key as <key>-cert.pub. Add '[ssh.host]:ssh.port ssh.host_public_key' to your "
            "known_hosts file (use the plain host instead of brackets when the port is 22); connect as "
            "ssh.user at ssh.host:ssh.port. Refresh the certificate with sandbox.get when it expires. "
            "Retain needed files with sandbox.pull_outputs or storage.submit before release or expiry."
        )
        if facts["status"] == "provisioning":
            facts.update(poll_after_seconds=3, hint="Provisioning in merv-sandboxes. Poll sandbox.get; do not repeat sandbox.request.")
        elif facts["status"] == "cleanup_pending":
            facts["hint"] = "Deletion is pending in merv-sandboxes. Billing may continue until its worker confirms the resource is stopped."
        elif facts["status"] == "running" and not public_key:
            facts["hint"] += " This sandbox has no caller public key saved; use sandbox.request with public_key and the attached experiment to issue access."
        return facts

    def options(self, *, project_id: str | None = None, gpu: str | None = None,
                region: str | None = None, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        params = {key: value for key, value in {"gpu": gpu, "region": region}.items() if value}
        data = self._call("GET", "/options", project_id=pid, params=params)
        options = []
        for offer in data.get("offers", []):
            resources = offer.get("resources") or {}
            options.append({**offer, "instance_type": offer["offer_id"],
                            "display_instance_type": offer.get("instance_type"),
                            "gpu": resources.get("gpu"), "cpu": resources.get("cpu"),
                            "memory": resources.get("memory_mb"),
                            "price_usd_per_hour": _usd(offer.get("hourly_price"))})
        return {"backend": "merv-sandboxes", "options": options, "selection_required": True,
                "hint": "Choose an available option and pass its provider and instance_type to sandbox.request."}

    def request(self, *, project_id: str | None = None, experiment_id: str | None = None,
                gpu: str | None = None, cpu: float | None = None, memory: int | None = None,
                time_limit: int | None = None, instance_type: str | None = None,
                region: str | None = None, provider: str | None = None,
                public_key: str | None = None, public_key_override: str | None = None,
                additional: bool = False, sandbox_uid: str | None = None,
                **_: Any) -> dict[str, Any]:
        if sandbox_uid:
            raise ValidationError("sandbox.request does not accept sandbox_uid; use sandbox.get or sandbox.attach")
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        try:
            key = validate_openssh_public_key(public_key_override or public_key)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        if not key:
            raise ValidationError("supply a single-line OpenSSH public_key; keep your private key local")
        lease = 3600 if time_limit is None else int(time_limit)
        if not 60 <= lease <= 86400:
            raise ValidationError("time_limit must be between 60 and 86400 seconds")
        if cpu is not None and (not math.isfinite(cpu) or cpu <= 0):
            raise ValidationError("cpu must be positive")
        if memory is not None and memory < 512:
            raise ValidationError("memory must be at least 512 MiB")
        records = self._records(pid)
        name = "merv-exp-" + hashlib.sha256(experiment_id.encode()).hexdigest()[:20] if experiment_id else ""
        if experiment_id and not additional:
            ids = {link["sandbox_uid"] for link in self._links(pid) if link["experiment_id"] == experiment_id}
            existing = next((row for row in reversed(records) if row.get("state") in _ACTIVE
                             and (row["id"] in ids or row.get("name") == name)), None)
            if existing:
                self._link(pid, existing["id"], experiment_id, key)
                return {**self._facts(pid, existing, public_key=key), "reused": True}
        choices = self.options(project_id=pid, gpu=gpu, region=region)
        candidates = [offer for offer in choices["options"]
                      if offer.get("available", True)
                      and (not provider or offer["provider"] == provider)
                      and (not instance_type or instance_type in {offer["instance_type"], offer["display_instance_type"]})
                      and (cpu is None or (offer.get("cpu") or 0) >= cpu)
                      and (memory is None or (offer.get("memory") or 0) >= memory)]
        if not instance_type:
            return {**choices, "options": candidates, "status": "needs_selection", "project_id": pid}
        if not candidates:
            raise ValidationError("selected hardware is unavailable; call sandbox.options for current offers")
        if len(candidates) != 1:
            raise ValidationError("hardware selection is ambiguous; pass the provider and complete instance_type from sandbox.options")
        offer = candidates[0]
        generation = sum(row.get("name") == name for row in records)
        idempotency_key = f"{name}-{generation}" if name and not additional else "merv-" + uuid.uuid4().hex
        body = {"provider": offer["provider"], "offer_id": offer["offer_id"],
                "lease_seconds": lease, "idempotency_key": idempotency_key}
        if name:
            body["name"] = name if not additional else name + "-" + uuid.uuid4().hex[:8]
        record = self._call("POST", "/sandboxes", project_id=pid, json=body)
        self._link(pid, record["id"], experiment_id or "", key)
        return {**self._facts(pid, record, public_key=key), "reused": False}

    def get(self, *, project_id: str | None = None, experiment_id: str | None = None,
            sandbox_uid: str | None = None, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        try:
            record = self._record(pid, sandbox_uid, experiment_id)
        except NotFoundError:
            if sandbox_uid:
                raise
            return {"project_id": pid, "experiment_id": experiment_id or "", "status": "none",
                    "hint": "No sandbox for this experiment; call sandbox.request."}
        return self._facts(pid, record)

    def attach(self, *, project_id: str | None = None, experiment_id: str, sandbox_uid: str,
               public_key_override: str | None = None) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        record = self._record(pid, sandbox_uid, None)
        if record.get("state") != "ready":
            raise ValidationError("sandbox.attach requires a running sandbox")
        self._link(pid, sandbox_uid, experiment_id, public_key_override or "")
        return {**self._facts(pid, record, public_key=public_key_override or ""), "reused": True}

    def snapshot(self, *, project_id: str | None = None, experiment_id: str | None = None,
                 sandbox_uid: str | None = None) -> dict[str, Any] | None:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        try:
            return self._snapshot(pid, self._record(pid, sandbox_uid, experiment_id))
        except NotFoundError:
            return None

    def for_project(self, *, project_id: str) -> list[dict[str, Any]]:
        pid = self._project(project_id)
        return [self._snapshot(pid, record) for record in self._records(pid)]

    def for_experiment(self, *, project_id: str, experiment_id: str) -> list[dict[str, Any]]:
        self._check_experiment(project_id, experiment_id)
        return [row for row in self.for_project(project_id=project_id)
                if experiment_id in row["active_experiment_ids"]]

    def list_sandboxes(self, *, project_id: str | None = None) -> dict[str, Any]:
        return {"sandboxes": self.for_project(project_id=self._project(project_id))}

    def project_signal(self, *, project_id: str) -> str:
        pid = self._project(project_id)
        # Read freshness without constructing the response projection or issuing
        # access certificates.
        remote = sorted((row["id"], row.get("updated_at"), row.get("state"),
                         row.get("lease_expires_at")) for row in self._records(pid))
        signal = [remote, self._links(pid)]
        return hashlib.sha256(json.dumps(signal, sort_keys=True).encode()).hexdigest()

    def release(self, *, project_id: str | None = None, experiment_id: str | None = None,
                sandbox_uid: str | None = None, confirm_retained: bool = False) -> dict[str, Any]:
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        targets = [record]
        if experiment_id and not sandbox_uid:
            ids = {row["sandbox_uid"] for row in self._links(pid) if row["experiment_id"] == experiment_id}
            targets = [row for row in self._records(pid) if row["id"] in ids and row.get("state") != "stopped"]
        if not confirm_retained and any(row.get("state") != "stopped" for row in targets):
            return {"project_id": pid, "experiment_id": experiment_id or "", "status": "confirmation_required",
                    "released": False, "pending_release": [self._snapshot(pid, row) for row in targets],
                    "hint": "Retain needed files with sandbox.pull_outputs or storage.submit, then repeat with confirm_retained=true. Release destroys ephemeral files."}
        released = [self._call("DELETE", "/sandboxes/" + _path(row["id"]), project_id=pid)
                    if row.get("state") != "stopped" else row for row in targets]
        stopped = all(row.get("state") == "stopped" for row in released)
        return {"project_id": pid, "experiment_id": experiment_id or "", "sandbox_uid": sandbox_uid or record["id"],
                "status": "terminated" if stopped else "cleanup_pending", "released": stopped,
                "sandboxes": [self._snapshot(pid, row) for row in released],
                "hint": "The service has confirmed release." if stopped else "Deletion requested. Poll sandbox.get until terminated; billing may continue while cleanup is pending."}

    def extend(self, *, project_id: str | None = None, experiment_id: str | None = None,
               sandbox_uid: str | None = None, seconds: int = 1800, **_: Any) -> dict[str, Any]:
        if not 1 <= seconds <= 1800:
            raise ValidationError("seconds must be between 1 and 1800")
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        if record.get("state") != "ready":
            raise ValidationError("sandbox.extend requires a running sandbox")
        # The service renews to now + lease_seconds; Merv's API adds to the
        # existing expiry. Preserve that distinction explicitly.
        expires = parse_iso(record["lease_expires_at"])
        if expires is None:
            raise ValidationError("sandbox has no renewable lease expiry")
        remaining = max(0, math.ceil((expires - datetime.now(UTC)).total_seconds()))
        renewed = self._call("POST", "/sandboxes/" + _path(record["id"]) + "/renew",
                             project_id=pid, json={"lease_seconds": max(60, remaining + seconds)})
        return self._facts(pid, renewed)

    def pull_outputs_command(self, *, project_id: str | None = None,
                             experiment_id: str | None = None, sandbox_uid: str | None = None,
                             paths: list[str] | None = None) -> dict[str, Any]:
        facts = self.get(project_id=project_id, experiment_id=experiment_id, sandbox_uid=sandbox_uid)
        ssh = facts.get("ssh") or {}
        if facts.get("status") != "running" or not ssh.get("host"):
            raise ValidationError("sandbox.pull_outputs requires a running sandbox with caller SSH access")
        selected = list(paths or _DEFAULT_OUTPUTS)
        for path in selected:
            if (not re.fullmatch(r"[A-Za-z0-9/._-]+", path) or path.startswith("/")
                    or any(part in {"", ".", ".."} for part in path.split("/"))):
                raise ValidationError("output paths must be safe relative paths under /workspace")
        # Everything interpolated comes from authenticated service values and
        # is independently quoted; private-key and destination remain placeholders.
        sources = " ".join(shlex.quote(f"{ssh['user']}@{ssh['host']}:/workspace/{path}") for path in selected)
        transport = f"ssh -i <key_path> -o CertificateFile=<certificate_path> -o UserKnownHostsFile=<known_hosts_path> -p {int(ssh['port'])}"
        return {**facts, "paths": selected,
                "command": f"rsync -az --protect-args --no-links --no-devices --no-specials -e {shlex.quote(transport)} -- {sources} <local-destination>",
                "hint": "Save ssh.certificate and pin ssh.host_public_key; replace the key, certificate, known_hosts, and destination placeholders before running the command."}

    def run(self, *, project_id: str | None = None, sandbox_uid: str | None = None,
            experiment_id: str | None = None, command: str, name: str = "",
            cwd: str = "/workspace", timeout_seconds: int = 0,
            outputs: str = "", idempotency_key: str | None = None,
            env: dict[str, str] | None = None) -> dict[str, Any]:
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        body = {"command": command, "name": name, "cwd": cwd,
                "timeout_seconds": timeout_seconds, "outputs": outputs, "env": env or {}}
        if idempotency_key:
            body["idempotency_key"] = idempotency_key
        return self._call("POST", "/sandboxes/" + _path(record["id"]) + "/jobs", project_id=pid, json=body)

    def job(self, *, project_id: str | None = None, job_id: str,
            after: str | None = None, wait_seconds: int = 0, cancel: bool = False,
            experiment_id: str | None = None, stream: str | None = None,
            offset: int = 0, limit: int = 65536) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        path = "/jobs/" + _path(job_id)
        if experiment_id:
            initial = self._call("GET", path, project_id=pid)
            if not any(link["experiment_id"] == experiment_id
                       for link in self._links(pid, initial["sandbox_id"])):
                raise NotFoundError("job is not attached to this experiment")
        result = self._call("POST" if cancel else "GET", path + ("/cancel" if cancel else ""),
                            project_id=pid, params=None if cancel else {"wait": min(MAX_WAIT_SECONDS, max(0, wait_seconds)), "after": after or ""})
        if stream is not None:
            if stream not in {"stdout", "stderr"} or offset < 0 or not 1 <= limit <= 1048576:
                raise ValidationError("output requires stdout/stderr, a nonnegative offset and a limit of 1–1048576 bytes")
            data, headers = self.client.request_bytes(
                "GET", path + "/output", namespace=project_namespace(pid),
                params={"stream": stream, "start": offset, "max_bytes": limit},
            )
            result["output"] = {"stream": stream, "text": data.decode("utf-8", errors="replace"),
                                "start": offset, "end": offset + len(data),
                                "available_start": int(headers.get("x-output-available-start", offset)),
                                "total_length": int(headers.get("x-output-total-length", offset + len(data))),
                                "complete": headers.get("x-output-complete") == "1",
                                "truncated": headers.get("x-output-truncated") == "1"}
        return result

    def runs(self, *, project_id: str | None = None, experiment_id: str | None = None,
             sandbox_uid: str | None = None, wait_seconds: int = 0, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        if not experiment_id and not sandbox_uid:
            raise ValidationError("sandbox.runs requires experiment_id or sandbox_uid")
        ids = [self._record(pid, sandbox_uid, experiment_id)["id"]] if sandbox_uid else [
            row["sandbox_uid"] for row in self._links(pid) if row["experiment_id"] == experiment_id]
        jobs: list[dict[str, Any]] = []
        for uid in dict.fromkeys(ids):
            after = None
            while True:
                params = {"sandbox_id": uid, "limit": 500}
                if after:
                    params["after"] = after
                page = self._call("GET", "/jobs", project_id=pid, params=params)
                jobs.extend(page.get("jobs", []))
                next_page = page.get("next")
                if not next_page or next_page == after:
                    break
                after = next_page
        if wait_seconds:
            pending = next((job for job in jobs if job["state"] not in _TERMINAL_JOBS), None)
            if pending:
                changed = self.job(project_id=pid, job_id=pending["id"], after=pending.get("cursor"), wait_seconds=wait_seconds)
                jobs = [changed if job["id"] == changed["id"] else job for job in jobs]
        rows = [{**job, "label": job["id"], "sandbox_uid": job["sandbox_id"],
                 "status": "finished" if job["state"] in _TERMINAL_JOBS else "running",
                 "log_path": None} for job in jobs]
        return {"project_id": pid, "experiment_id": experiment_id or "", "sandbox_uid": sandbox_uid or "",
                "runs": rows, "jobs": jobs, "hint": "These are durable merv-sandboxes jobs started with sandbox.run. SSH commands are not automatically recorded as jobs."}

    def terminal(self, *, project_id: str | None = None, experiment_id: str | None = None,
                 sandbox_uid: str | None = None, tail: int | None = None,
                 since: int | None = None) -> dict[str, Any]:
        """A bounded snapshot of the latest durable job's two output streams.

        The native service keeps separate byte cursors per job and stream.
        ``replace`` tells the UI to replace its previous snapshot instead of
        pretending those independent streams form one SSH transcript cursor.
        """
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        base = {"sandbox_id": record["id"], "sandbox_uid": record["id"],
                "running": record.get("state") == "ready",
                "status": _STATUS.get(record.get("state"), record.get("state")),
                "source": "merv-sandboxes-job", "replace": True, "cursor": 0}
        page = self._call("GET", "/jobs", project_id=pid,
                          params={"sandbox_id": record["id"], "limit": 1})
        jobs = page.get("jobs", [])
        if not jobs:
            return {**base, "available": False, "command_running": None,
                    "transcript": "No durable jobs have been started on this sandbox. Use sandbox.run to launch work and retain its logs. SSH shell sessions are not recorded here."}
        job = jobs[0]
        if job.get("sandbox_id") != record["id"]:
            raise ValidationError("service returned a job for another sandbox")
        byte_budget = 65536 if tail is None else min(200000, max(1, int(tail)))
        extents = {output["stream"]: output for output in job.get("outputs", [])}
        transcript = ["$ " + str(job.get("command") or "")[:3000]]
        omitted = False
        # Each stream gets half the requested window, so a noisy stderr cannot
        # crowd out stdout (or turn one poll into an unbounded read).
        for stream in ("stdout", "stderr"):
            extent = extents.get(stream) or {}
            length = int(extent.get("total_length") or 0)
            available = int(extent.get("available_start") or 0)
            if length <= available:
                if length:
                    transcript.append(f"[{stream}: earlier output is no longer retained]")
                continue
            limit = max(1, byte_budget // 2)
            offset = max(available, length - limit)
            data, _headers = self.client.request_bytes(
                "GET", "/jobs/" + _path(job["id"]) + "/output", namespace=project_namespace(pid),
                params={"stream": stream, "start": offset, "max_bytes": limit},
            )
            omitted = omitted or offset > 0
            transcript.append(f"[{stream}" + ("; earlier output omitted]" if offset else "]"))
            transcript.append(data.decode("utf-8", errors="replace"))
        text = "\n".join(transcript)
        running = job.get("state") not in _TERMINAL_JOBS
        return {**base, "available": True, "job_id": job["id"], "job_name": job.get("name"),
                "job_state": job.get("state"), "transcript": text,
                "cursor": len(text.encode("utf-8")), "truncated": omitted,
                "command_running": running, "last_exit_code": job.get("exit_code"),
                "last_command_finished_at": job.get("finished_at"),
                "last_command": {"command": job.get("command"), "status": "running" if running else "finished",
                                 "started_at": job.get("started_at"), "finished_at": job.get("finished_at"),
                                 "exit_code": job.get("exit_code")},
                "hint": "Latest durable job output. This bounded snapshot replaces the previous view; use sandbox.job for exact byte ranges or older jobs."}

    def health(self, *, details: bool = False) -> dict[str, Any]:
        if self.client is None:
            return {"ok": False, "backend": "merv-sandboxes", "error": "merv-sandboxes is not configured"}
        return self.client.health()

    def figure_snapshot(self, *, project_id: str, experiment_id: str) -> tuple[dict[str, Any] | None, bool]:
        value = self.snapshot(project_id=project_id, experiment_id=experiment_id)
        return value, bool(value and value["status"] in {"running", "provisioning"})

    def project_spend(self, *, project_id: str) -> dict[str, Any]:
        """Present service totals, joining resource amounts to research associations."""
        pid = self._project(project_id)
        report = self._call("GET", "/spend/report", project_id=pid)
        links = {row["sandbox_uid"]: row.get("experiment_id") or "" for row in self._links(pid)}

        def usd(amounts: list[dict[str, Any]]) -> float:
            return next((_usd(row) for row in amounts if row.get("currency") == "USD"), 0.0)

        experiments: dict[str, dict[str, Any]] = {}
        for resource in report["resources"]:
            eid = links.get(resource["id"], "")
            group = experiments.setdefault(eid, {"experiment_id": eid, "usd": Decimal(0),
                                                  "hours": Decimal(0), "generations": 0})
            amount = resource.get("accrued")
            if amount and amount["currency"] == "USD":
                group["usd"] += Decimal(amount["amount"])
            group["hours"] += Decimal(resource["hours"])
            group["generations"] += 1
        for adjustment in report.get("adjustments", []):
            reference = adjustment.get("reference")
            eid = ""
            if (isinstance(reference, dict) and reference.get("application") == "merv"
                    and reference.get("project_id") == pid
                    and isinstance(reference.get("experiment_id"), str)):
                eid = reference.get("experiment_id") or ""
            group = experiments.setdefault(eid, {"experiment_id": eid, "usd": Decimal(0),
                                                  "hours": Decimal(0), "generations": 0})
            amount = adjustment.get("accrued")
            if amount and amount["currency"] == "USD":
                group["usd"] += Decimal(amount["amount"])
            if adjustment.get("compute_hours") is not None:
                group["hours"] += Decimal(adjustment["compute_hours"])
            group["historical_adjustment_count"] = group.get("historical_adjustment_count", 0) + 1
        return {
            "total_usd": usd(report["accrued"]), "total_hours": float(report["hours"]),
            "unpriced_hours": float(report["unpriced_hours"]),
            "generations": report["resource_count"], "open_generations": report["active_resource_count"],
            "burn_usd_per_hour": usd(report["hourly_rate"]), "reserved_usd": usd(report["reserved"]),
            "by_experiment": [{**row, "usd": float(row["usd"]), "hours": float(row["hours"])}
                              for row in experiments.values()],
            "by_hardware": [{"instance_type": row["instance_type"], "gpu": row.get("gpu") or "",
                             "price_usd_per_hour": _usd(row.get("hourly_price")),
                             "usd": usd(row["accrued"]), "hours": float(row["hours"]),
                             "generations": row["resource_count"]} for row in report.get("by_hardware", [])],
            "daily": [{"date": row["date"], "usd": usd(row["totals"]), "hours": float(row["hours"])}
                      for row in report["daily"]],
            "source": "merv-sandboxes", "as_of": report["as_of"],
            "scope": {"namespace": report["namespace"], "member_id": report.get("member_id")},
            "currencies": report["accrued"],
            "hours_coverage": report.get("hours_coverage", "native_resources_only"),
            "accounting_complete": report.get("accounting_complete"),
            "unresolved_history_count": report.get("unresolved_history_count", 0),
            "unmeasured_adjustment_count": report.get("unmeasured_adjustment_count", 0),
            "reserved_hours": float(report["reserved_hours"]) if report.get("reserved_hours") is not None else None,
            "unbounded_lease_count": report.get("unbounded_lease_count", 0),
            "note": "Service-reported conservative compute estimates for the authorized scope. "
                    "Historical charges and measured hours are included; hours_coverage identifies incomplete history. "
                    "Saved resource and import references group experiments.",
        }


__all__ = ["RemoteSandboxes"]
