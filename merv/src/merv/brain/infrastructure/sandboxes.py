"""Research projections over the independent merv-sandboxes HTTP service.

Only experiment associations and caller public keys are stored here. Rental,
credentials, access certificates, jobs, spend and cleanup belong to the service.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shlex
import uuid
from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import quote

from ...shared.tool_validation import validate_openssh_public_key
from ..kernel.utils import NotFoundError, ValidationError, now_iso, parse_iso
from ..kernel.state import BaseStateStore
from ..kernel.secret_tokens import MIN_WAIT_SECRET_BYTES, wait_url
from .ports import InfrastructureTransport, project_namespace
from .budget import daily_budget


_ACTIVE = frozenset({"requested", "provisioning", "bootstrapping", "ready", "unknown", "failed"})
_TERMINAL_JOBS = frozenset({"succeeded", "failed", "cancelled", "timed_out"})
_STATUS = {"requested": "provisioning", "provisioning": "provisioning",
           "bootstrapping": "provisioning", "ready": "running",
           "delete_requested": "cleanup_pending", "deleting": "cleanup_pending",
           "delete_failed": "cleanup_pending", "stopped": "terminated"}
_DEFAULT_OUTPUTS = ("results", "figures", "report.md", "graph.json", "metrics.json", "results.json")


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

    def _archives(self, project_id: str) -> list[dict[str, Any]]:
        """Released legacy rows remain research history, with no infrastructure behavior."""
        with closing(self._store.connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM sandboxes WHERE project_id = ? AND status IN ('terminated','expired','failed') ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
            attachments = conn.execute(
                "SELECT a.sandbox_uid,a.experiment_id FROM sandbox_attachments a "
                "JOIN sandboxes s ON s.sandbox_uid = a.sandbox_uid WHERE s.project_id = ?",
                (project_id,),
            ).fetchall()
        by_uid: dict[str, list[str]] = {}
        for link in attachments:
            by_uid.setdefault(link["sandbox_uid"], []).append(link["experiment_id"])
        result = []
        keys = ("sandbox_uid", "sandbox_id", "project_id", "experiment_id", "status", "phase", "detail",
                "error", "gpu", "cpu", "memory", "provider", "instance_type", "region", "public_key_source",
                "time_limit", "workdir", "sync_dir", "sandbox_data_dir", "volume_name", "requested_at",
                "expires_at", "last_seen_at", "terminated_at", "created_at", "updated_at")
        for stored in rows:
            data = dict(stored)
            row = {key: data.get(key) for key in keys}
            row.update(active_experiment_ids=by_uid.get(data["sandbox_uid"], []),
                       ssh_host=None, ssh_port=None, ssh_user=None, archived=True,
                       infrastructure="legacy", price_usd_per_hour=None, cost_usd=None)
            if not row["experiment_id"] and row["active_experiment_ids"]:
                row["experiment_id"] = row["active_experiment_ids"][0]
            result.append(row)
        return result

    def _archive(self, project_id: str, sandbox_uid: str | None, experiment_id: str | None) -> dict[str, Any] | None:
        return next((row for row in self._archives(project_id)
                     if (sandbox_uid and row["sandbox_uid"] == sandbox_uid)
                     or (not sandbox_uid and experiment_id and experiment_id in row["active_experiment_ids"])), None)

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
                provisioning_user_id: str = "", **_: Any) -> dict[str, Any]:
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
        providers = self._call("GET", "/providers", project_id=pid)["providers"]
        connection = next((entry for entry in providers if entry["name"] == offer["provider"]), None)
        if connection is None:
            raise ValidationError("selected provider is no longer connected")
        budget = daily_budget(
            store=self._store, project_id=pid, provider=connection["plugin"],
            payer_id=provisioning_user_id,
            billing_mode="platform" if connection["source"] == "host" else "own",
        )
        record = self._call("POST", "/sandboxes", project_id=pid, json=body, budget=budget)
        self._link(pid, record["id"], experiment_id or "", key)
        return {**self._facts(pid, record, public_key=key), "reused": False}

    def get(self, *, project_id: str | None = None, experiment_id: str | None = None,
            sandbox_uid: str | None = None, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        archive = self._archive(pid, sandbox_uid, experiment_id)
        if archive and sandbox_uid:
            if experiment_id and experiment_id not in archive["active_experiment_ids"]:
                raise NotFoundError("sandbox is not attached to this experiment")
            return {**archive, "hint": "Archived sandbox from the previous infrastructure. Its retained research records remain available."}
        try:
            record = self._record(pid, sandbox_uid, experiment_id)
        except NotFoundError:
            if sandbox_uid:
                raise
            if archive:
                return {**archive, "hint": "Archived sandbox from the previous infrastructure."}
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
        archive = self._archive(pid, sandbox_uid, experiment_id)
        if archive and sandbox_uid:
            if experiment_id and experiment_id not in archive["active_experiment_ids"]:
                raise NotFoundError("sandbox is not attached to this experiment")
            return archive
        try:
            return self._snapshot(pid, self._record(pid, sandbox_uid, experiment_id))
        except NotFoundError:
            return archive

    def for_project(self, *, project_id: str) -> list[dict[str, Any]]:
        pid = self._project(project_id)
        return [self._snapshot(pid, record) for record in self._records(pid)] + self._archives(pid)

    def for_experiment(self, *, project_id: str, experiment_id: str) -> list[dict[str, Any]]:
        self._check_experiment(project_id, experiment_id)
        return [row for row in self.for_project(project_id=project_id)
                if experiment_id in row["active_experiment_ids"]]

    def list_sandboxes(self, *, project_id: str | None = None) -> dict[str, Any]:
        return {"sandboxes": self.for_project(project_id=self._project(project_id))}

    def project_signal(self, *, project_id: str) -> str:
        pid = self._project(project_id)
        # Read freshness without constructing the response projection or issuing
        # access certificates. Legacy terminal records are immutable history.
        remote = sorted((row["id"], row.get("updated_at"), row.get("state"),
                         row.get("lease_expires_at")) for row in self._records(pid))
        with closing(self._store.connect()) as conn:
            legacy = conn.execute(
                "SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM sandboxes WHERE project_id = ?",
                (pid,),
            ).fetchone()
        signal = [remote, self._links(pid), dict(legacy)]
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
        original = (record.get("request") or {}).get("merv_budget")
        if not original:
            raise ValidationError("sandbox has no preserved billing owner; cannot safely renew its lease")
        budget = daily_budget(
            store=self._store, project_id=pid, provider=original["provider"],
            payer_id=original["payer_id"], billing_mode=original["billing_mode"],
        )
        renewed = self._call("POST", "/sandboxes/" + _path(record["id"]) + "/renew",
                             project_id=pid, json={"lease_seconds": max(60, remaining + seconds)}, budget=budget)
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
                            project_id=pid, params=None if cancel else {"wait": min(45, max(0, wait_seconds)), "after": after or ""})
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
             sandbox_uid: str | None = None, wait_seconds: int = 0,
             base_url: str = "", wait_secret: bytes | None = None, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        self._check_experiment(pid, experiment_id)
        if not experiment_id and not sandbox_uid:
            raise ValidationError("sandbox.runs requires experiment_id or sandbox_uid")
        legacy_runs: list[dict[str, Any]] = []
        with closing(self._store.connect()) as conn:
            historical = conn.execute(
                "SELECT r.* FROM sandbox_runs r JOIN sandboxes s ON s.sandbox_uid = r.sandbox_uid "
                "WHERE s.project_id = ? AND s.status IN ('terminated','expired','failed') "
                + ("AND s.sandbox_uid = ? " if sandbox_uid else "")
                + ("AND EXISTS (SELECT 1 FROM sandbox_attachments a WHERE a.sandbox_uid = s.sandbox_uid AND a.experiment_id = ?) " if experiment_id else ""),
                (pid,) + ((sandbox_uid,) if sandbox_uid else ()) + ((experiment_id,) if experiment_id else ()),
            ).fetchall()
        for stored in historical:
            row = dict(stored)
            row.update(status="finished" if row.get("exit_code") is not None or row.get("finished_at") else "unknown",
                       archived=True, infrastructure="legacy", log_path=None)
            legacy_runs.append(row)
        archived = self._archive(pid, sandbox_uid, experiment_id) if sandbox_uid else None
        ids = [] if archived else [self._record(pid, sandbox_uid, experiment_id)["id"]] if sandbox_uid else [
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
        if base_url and wait_secret is not None and len(wait_secret) >= MIN_WAIT_SECRET_BYTES:
            for row in rows:
                row["wait_url"] = wait_url(base_url=base_url, key=wait_secret,
                                           sandbox_uid=row["sandbox_uid"], label=row["label"])
        return {"project_id": pid, "experiment_id": experiment_id or "", "sandbox_uid": sandbox_uid or "",
                "runs": rows + legacy_runs, "jobs": jobs, "hint": "These are durable merv-sandboxes jobs started with sandbox.run. SSH commands are not automatically recorded as jobs."}

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

    def sample_metrics(self, *, project_id: str | None = None, experiment_id: str | None = None,
                       sandbox_uid: str | None = None) -> dict[str, Any]:
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        return {"available": False, "sandbox_uid": record["id"],
                "reason": "merv-sandboxes does not publish resource utilization samples"}

    def health(self, *, details: bool = False) -> dict[str, Any]:
        if self.client is None:
            return {"ok": False, "backend": "merv-sandboxes", "error": "merv-sandboxes is not configured"}
        return self.client.health()

    def figure_snapshot(self, *, project_id: str, experiment_id: str) -> tuple[dict[str, Any] | None, bool]:
        value = self.snapshot(project_id=project_id, experiment_id=experiment_id)
        return value, bool(value and value["status"] in {"running", "provisioning"})

    def project_spend(self, *, project_id: str) -> dict[str, Any]:
        pid = self._project(project_id)
        rows = [row for row in self.for_project(project_id=pid) if not row.get("archived")]
        with closing(self._store.connect()) as conn:
            legacy = [dict(row) for row in conn.execute(
                "SELECT * FROM sandbox_generations WHERE project_id = ? AND ended_at IS NOT NULL",
                (pid,),
            ).fetchall()]
        now = datetime.now(UTC)
        usages = []
        for row in rows:
            start = parse_iso(row.get("billing_started_at"))
            end = parse_iso(row.get("terminated_at")) or now
            if start is None:
                continue
            usages.append({**row, "start": start, "end": end,
                           "open": row["status"] != "terminated", "usd": row["cost_usd"]})
        for row in legacy:
            start, end = parse_iso(row["started_at"]), parse_iso(row["ended_at"])
            if start is None or end is None:
                continue
            hours = max(0, (end - start).total_seconds()) / 3600
            usages.append({**row, "start": start, "end": end, "open": False,
                           "usd": float(row["price_usd_per_hour"]) * hours})
        totals = {"total_usd": 0.0, "total_hours": 0.0, "unpriced_hours": 0.0,
                  "generations": len(usages), "open_generations": 0, "burn_usd_per_hour": 0.0}
        experiments: dict[str, dict[str, Any]] = {}
        hardware: dict[tuple[str, str, float | None], dict[str, Any]] = {}
        daily: dict[str, dict[str, Any]] = {}
        for row in usages:
            start, end = row["start"], row["end"]
            hours = max(0.0, (end - start).total_seconds()) / 3600
            usd = row["usd"] or 0.0
            price = row.get("price_usd_per_hour")
            totals["total_usd"] += usd
            totals["total_hours"] += hours
            if price is None or (row.get("infrastructure") != "merv-sandboxes" and not row.get("price_known") and not price):
                totals["unpriced_hours"] += hours
            if row["open"]:
                totals["open_generations"] += 1
                totals["burn_usd_per_hour"] += price or 0.0
            eid = row.get("experiment_id") or ""
            group = experiments.setdefault(eid, {"experiment_id": eid, "usd": 0.0, "hours": 0.0, "generations": 0})
            group["usd"] += usd
            group["hours"] += hours
            group["generations"] += 1
            key = (row.get("instance_type") or "", row.get("gpu") or "", price)
            hw = hardware.setdefault(key, {"instance_type": key[0], "gpu": key[1], "price_usd_per_hour": price,
                                          "usd": 0.0, "hours": 0.0, "generations": 0})
            hw["usd"] += usd
            hw["hours"] += hours
            hw["generations"] += 1
            cursor = start.astimezone(UTC)
            while cursor < end:
                next_day = cursor.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
                stop = min(next_day, end)
                fraction = (stop - cursor).total_seconds() / 3600
                day = cursor.date().isoformat()
                bucket = daily.setdefault(day, {"date": day, "usd": 0.0, "hours": 0.0})
                bucket["hours"] += fraction
                bucket["usd"] += usd * fraction / hours if hours else 0.0
                cursor = stop
        return {**totals, "by_experiment": list(experiments.values()), "by_hardware": list(hardware.values()),
                "daily": sorted(daily.values(), key=lambda row: row["date"]), "source": "merv-sandboxes",
                "note": "Current service-reported costs plus retained closed legacy generations."}

    def user_budget_view(self, **_: Any) -> None:
        return None

    def tenant_generation_counters(self, *, tenant_id: str) -> dict[str, Any]:
        return {"sandbox_generations": None, "sandbox_hours": None,
                "sandbox_accounting_source": "merv-sandboxes"}

    def run_wait_facts(self, *, sandbox_uid: str, label: str) -> dict[str, Any] | None:
        """Resolve an already-verified wait capability against its linked namespace.

        Native job IDs are the wait labels; display names are not unique. A
        successful response is a fresh observation even for an old terminal job.
        Transient service failures propagate so the waiter can retry safely.
        """
        with closing(self._store.connect()) as conn:
            projects = conn.execute(
                "SELECT DISTINCT project_id FROM remote_sandbox_links WHERE sandbox_uid = ?",
                (sandbox_uid,),
            ).fetchall()
        if len(projects) != 1:
            return None
        pid = projects[0]["project_id"]
        try:
            record = self._call("GET", "/sandboxes/" + _path(sandbox_uid), project_id=pid)
        except NotFoundError:
            return None
        facts = {"present": False, "sandbox_active": record.get("state") in _ACTIVE,
                 "expires_at": record.get("lease_expires_at"), "observed_at": now_iso()}
        try:
            job = self._call("GET", "/jobs/" + _path(label), project_id=pid)
        except NotFoundError:
            return facts
        if job.get("sandbox_id") != sandbox_uid:
            return None
        facts.update(present=True, status="finished" if job["state"] in _TERMINAL_JOBS else "running",
                     exit_code=job.get("exit_code"), observed_at=now_iso())
        return facts


__all__ = ["RemoteSandboxes"]
