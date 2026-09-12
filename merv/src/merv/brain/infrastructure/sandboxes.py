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
import time
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
    ) -> None:
        self.client = client
        self._store = store
        self.attachment_check = attachment_check
        store.install(INFRASTRUCTURE_SCHEMA)

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
        state = str(record.get("state", "unknown"))
        return {
            "sandbox_uid": record["id"], "experiment_id": experiments[0] if experiments else "",
            "active_experiment_ids": experiments, "status": _STATUS.get(state, state),
            "phase": state, "detail": (record.get("last_error") or {}).get("message", ""),
            "provider": record.get("provider", ""), "instance_type": offer.get("offer_id", ""),
            "region": offer.get("region", ""), "gpu": resources.get("gpu") or "",
            "cpu": resources.get("cpu"), "memory": resources.get("memory_mb"),
            "time_limit": (record.get("request") or {}).get("lease_seconds"), "workdir": "/workspace",
            "requested_at": record.get("created_at"), "updated_at": record.get("updated_at"),
            "expires_at": record.get("lease_expires_at"), "terminated_at": record.get("stopped_at"),
            "price_usd_per_hour": _usd(record.get("hourly_price") or offer.get("hourly_price")),
        }

    def _facts(self, project_id: str, record: dict[str, Any], *, public_key: str = "") -> dict[str, Any]:
        """What an agent needs from this box: a poll receipt while provisioning, the full row once it runs."""
        facts = self._snapshot(project_id, record)
        status = facts["status"]
        if status == "provisioning":
            return {key: facts[key] for key in ("sandbox_uid", "status", "phase", "detail", "expires_at")} | {
                "poll_after_seconds": 3, "hint": "Poll sandbox.get; do not repeat sandbox.request."}
        if status == "terminated":
            facts["hint"] = "Released; call sandbox.request for a new box. Job logs stay readable through sandbox.job."
        elif status == "cleanup_pending":
            facts["hint"] = "Deletion is pending in merv-sandboxes. Billing may continue until its worker confirms the resource is stopped."
        elif status == "running":
            key = public_key or next((link["public_key"] for link in reversed(self._links(project_id, record["id"]))
                                      if link["public_key"]), "")
            if not key:
                facts["hint"] = "No caller public key saved; call sandbox.request with public_key and the attached experiment to issue SSH access."
                return facts
            issued = self._call("POST", "/access/certificates", project_id=project_id,
                                json={"public_key": key, "sandbox_id": record["id"]})
            gateway = issued["gateway"]
            facts["ssh"] = {"host": gateway["host"], "port": gateway["port"], "user": record["id"],
                            "certificate": issued["certificate"], "certificate_expires_at": issued["expires_at"],
                            "host_public_key": gateway.get("host_public_key")}
            facts["hint"] = ("Save ssh.certificate beside your private key as <key>-cert.pub, add "
                             "'[ssh.host]:ssh.port ssh.host_public_key' to known_hosts (plain host when the port is 22), "
                             "then ssh -p ssh.port ssh.user@ssh.host. sandbox.get refreshes the certificate.")
        return facts

    def options(self, *, project_id: str | None = None, gpu: str | None = None,
                region: str | None = None, **_: Any) -> dict[str, Any]:
        pid = self._project(project_id)
        params = {key: value for key, value in {"gpu": gpu, "region": region}.items() if value}
        options = []
        for offer in self._call("GET", "/options", project_id=pid, params=params).get("offers", []):
            resources = offer.get("resources") or {}
            options.append({
                "instance_type": offer["offer_id"], "provider": offer["provider"], "region": offer.get("region"),
                "gpu": resources.get("gpu"), "gpu_count": resources.get("gpu_count"),
                "cpu": resources.get("cpu"), "memory": resources.get("memory_mb"),
                "price_usd_per_hour": _usd(offer.get("hourly_price")), "available": offer.get("available", True)})
        return {"options": options}

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
        offers = [offer for offer in self.options(project_id=pid, gpu=gpu, region=region)["options"] if offer["available"]]
        candidates = [offer for offer in offers
                      if (not provider or offer["provider"] == provider)
                      and (not instance_type or instance_type == offer["instance_type"])
                      and (cpu is None or (offer["cpu"] or 0) >= cpu)
                      and (memory is None or (offer["memory"] or 0) >= memory)]
        if not instance_type:
            return {"status": "needs_selection", "options": candidates}
        if not candidates:
            near = [offer["instance_type"] for offer in offers if instance_type in offer["instance_type"]]
            raise ValidationError(f"no available offer matches instance_type {instance_type!r}"
                                  + (f" from provider {provider!r}" if provider else "")
                                  + (f"; did you mean {', '.join(near)}?" if near else "; call sandbox.options"))
        if len(candidates) != 1:
            raise ValidationError(f"instance_type {instance_type!r} is offered by several providers ("
                                  + ", ".join(offer["provider"] for offer in candidates) + "); pass provider")
        offer = candidates[0]
        generation = sum(row.get("name") == name for row in records)
        idempotency_key = f"{name}-{generation}" if name and not additional else "merv-" + uuid.uuid4().hex
        body = {"provider": offer["provider"], "offer_id": offer["instance_type"],
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
            return {"experiment_id": experiment_id or "", "status": "none",
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
        return {"sandbox_uid": record["id"], "expires_at": renewed.get("lease_expires_at"),
                "time_limit": (renewed.get("request") or {}).get("lease_seconds")}

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
        return {"sandbox_uid": facts["sandbox_uid"], "ssh": ssh, "paths": selected,
                "command": f"rsync -az --protect-args --no-links --no-devices --no-specials -e {shlex.quote(transport)} -- {sources} <local-destination>",
                "hint": "Save ssh.certificate and pin ssh.host_public_key; replace the key, certificate, known_hosts, and destination placeholders before running the command."}

    def run(self, *, project_id: str | None = None, sandbox_uid: str | None = None,
            experiment_id: str | None = None, command: str, name: str = "",
            cwd: str = "/workspace", timeout_seconds: int = 0,
            outputs: str = "", idempotency_key: str | None = None,
            env: dict[str, str] | None = None) -> dict[str, Any]:
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        body = {"command": command, "name": name or " ".join(command.split())[:64], "cwd": cwd,
                "timeout_seconds": timeout_seconds, "outputs": outputs, "env": env or {}}
        if idempotency_key:
            body["idempotency_key"] = idempotency_key
        job = self._call("POST", "/sandboxes/" + _path(record["id"]) + "/jobs", project_id=pid, json=body)
        return {"job_id": job["id"], "name": job.get("name"), "state": job.get("state"), "cursor": job.get("cursor"),
                "sandbox_uid": record["id"],
                "hint": f"Wait with sandbox.job(job_id={job['id']!r}, after={job.get('cursor')!r}, wait_seconds={MAX_WAIT_SECONDS}); "
                        "then read output with stream='stdout', tail=4096."}

    def job(self, *, project_id: str | None = None, job_id: str,
            after: str | None = None, wait_seconds: int = 0, cancel: bool = False,
            experiment_id: str | None = None, stream: str | None = None,
            offset: int = 0, limit: int = 4096, tail: int | None = None) -> dict[str, Any]:
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
            if stream not in {"stdout", "stderr"} or offset < 0 or not 1 <= (tail or limit) <= 1048576:
                raise ValidationError("output requires stdout/stderr, a nonnegative offset and a limit/tail of 1–1048576 bytes")
            if tail:
                extent = next((row for row in result.get("outputs", []) if row.get("stream") == stream), {})
                offset = max(int(extent.get("available_start") or 0), int(extent.get("total_length") or 0) - tail)
                limit = tail
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
        # The service waits on one job at a time, so share the budget round-robin
        # across every pending job and stop at the first change.
        pending = [job for job in jobs if job["state"] not in _TERMINAL_JOBS]
        deadline = time.monotonic() + min(MAX_WAIT_SECONDS, wait_seconds)
        while pending and (left := deadline - time.monotonic()) > 0:
            job = pending.pop(0)
            changed = self.job(project_id=pid, job_id=job["id"], after=job.get("cursor"),
                               wait_seconds=math.ceil(left / (len(pending) + 1)))
            if changed["state"] in _TERMINAL_JOBS or changed.get("cursor") != job.get("cursor"):
                jobs = [changed if row["id"] == changed["id"] else row for row in jobs]
                break
            pending.append(job)
        return {"experiment_id": experiment_id or "", "sandbox_uid": sandbox_uid or "",
                "runs": [{key: job.get(key) for key in ("id", "name", "state", "exit_code", "cursor", "finished_at")}
                         for job in jobs]}

    def terminal(self, *, project_id: str | None = None, experiment_id: str | None = None,
                 sandbox_uid: str | None = None, tail: int | None = None) -> dict[str, Any]:
        """A bounded snapshot of the latest durable job's two output streams.

        The native service keeps separate byte cursors per job and stream.
        ``replace`` tells the UI to replace its previous snapshot instead of
        pretending those independent streams form one SSH transcript cursor.
        """
        pid = self._project(project_id)
        record = self._record(pid, sandbox_uid, experiment_id)
        base = {"sandbox_uid": record["id"], "status": _STATUS.get(record.get("state"), record.get("state")),
                "replace": True, "cursor": 0}
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
        return {**base, "available": True, "job_id": job["id"], "job_name": job.get("name"),
                "job_state": job.get("state"), "transcript": text,
                "cursor": len(text.encode("utf-8")), "truncated": omitted,
                "command_running": job.get("state") not in _TERMINAL_JOBS, "last_exit_code": job.get("exit_code"),
                "last_command_finished_at": job.get("finished_at")}

    def health(self, *, details: bool = False) -> dict[str, Any]:
        if self.client is None:
            return {"ok": False, "backend": "merv-sandboxes", "error": "merv-sandboxes is not configured"}
        return self.client.health()

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
