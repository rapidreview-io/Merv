# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Sandbox orchestration behind the single public ``SandboxEngine``."""

from __future__ import annotations

import logging
import re
import shlex
import threading
import time
from contextlib import closing, contextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Any, Callable, Iterator

from ..kernel.env import env_float
from ..kernel.ports.mgmt_keys import MgmtKeyStore
from ..kernel.state.store import BaseStateStore, Connection
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    format_iso,
    now_iso,
    parse_iso,
)
from .lifecycle import EphemeralSecretCustody, SandboxLifecycle
from .quotas import AdmissionRequest, QuotaService
from .observation import (
    RELEASE_OBSERVE_ACQUIRE_SECONDS,
    RunsObserver,
    SandboxMetrics,
    SandboxRunLedger,
    TranscriptCache,
    parse_terminal_markers,
    parse_terminal_snapshot,
    run_records_view,
    run_status,
)
from .budget import BudgetEnforcer
from .provisioning import SandboxProvisioner
from .models import (
    ACTIVE_SANDBOX_STATUSES,
    BackendCapabilities,
    BackendValidationError,
    CLEANUP_PENDING_STATUS,
    DEFAULT_REQUEST_WAIT_SECONDS,
    DEFAULT_STALE_PROVISION_SECONDS,
    POLL_AFTER_SECONDS,
    ProviderAdmission,
    RUNS_WAIT_CAP_SECONDS,
    RUNS_WAIT_POLL_SECONDS,
    SandboxBackend,
    SandboxRequest,
    SandboxTarget,
    TranscriptTail,
    cleanup_attempts,
    cleanup_inflight_token,
    public_phase,
)
from .scheduler import SandboxScheduler
from .heartbeat import (
    SandboxActivityPolicy,
    SandboxHeartbeatMonitor,
    gpu_inventory,
    usage_point,
)
from .sandbox_paths import DEFAULT_DATA_DIR, remote_experiment_dir
from .storage import SandboxStorage

LOGGER = logging.getLogger(__name__)


_DEFAULT_PULL_OUTPUTS = (
    "results",
    "figures",
    "report.md",
    "graph.json",
    "metrics.json",
    "results.json",
)

# Paths cross local and remote shell parsers, so accept only shell-inert ASCII.
_SAFE_PULL_OUTPUT_PATH_RE = re.compile(r"[A-Za-z0-9/._-]+\Z")
_SAFE_SSH_USER_RE = re.compile(r"[A-Za-z0-9._-]+\Z")

# The caller supplies its private key and destination; the brain never runs
# rsync. ``--protect-args`` works on older peers that lack ``--secluded-args``.
_RSYNC_PULL_OUTPUTS_TEMPLATE = (
    "rsync -az --itemize-changes --no-links --no-devices --no-specials "
    "--protect-args "
    '-e "ssh -i <key_path> -p {port} -o StrictHostKeyChecking=no '
    '-o UserKnownHostsFile=/dev/null" -- {remote_sources} <local-destination>'
)

VALID_GPUS = frozenset(
    {"T4", "L4", "A10G", "L40S", "A100", "A100-80GB", "H100", "B200"}
)
MIN_TIME_LIMIT_SECONDS = 60
MAX_TIME_LIMIT_SECONDS = 24 * 60 * 60
DEFAULT_TIME_LIMIT_SECONDS = 3600
DEFAULT_CPU = 2.0
DEFAULT_MEMORY_MB = 8192
# Command text on the fleet list is a label, not a record — the terminal has
# the full line. Bounding it keeps a pathological command out of a 3s poll.
LIVE_COMMAND_MAX_CHARS = 300


def _validated_resources(
    *,
    gpu: str | None,
    cpu: float | None,
    memory: int | None,
    time_limit: int | None,
    configurable: bool,
) -> tuple[str | None, float, int, int]:
    normalized_gpu = str(gpu).upper() if gpu not in (None, "") else None
    if configurable and normalized_gpu and normalized_gpu not in VALID_GPUS:
        raise ValidationError(
            f"invalid gpu: {gpu}; allowed: {', '.join(sorted(VALID_GPUS))}"
        )
    normalized_cpu = float(cpu) if cpu is not None else DEFAULT_CPU
    if normalized_cpu <= 0:
        raise ValidationError("cpu must be positive")
    normalized_memory = int(memory) if memory is not None else DEFAULT_MEMORY_MB
    if normalized_memory < 512:
        raise ValidationError("memory must be at least 512 (MiB)")
    normalized_time = (
        int(time_limit)
        if time_limit is not None
        else DEFAULT_TIME_LIMIT_SECONDS
    )
    if not MIN_TIME_LIMIT_SECONDS <= normalized_time <= MAX_TIME_LIMIT_SECONDS:
        raise ValidationError(
            f"time_limit must be between {MIN_TIME_LIMIT_SECONDS} and "
            f"{MAX_TIME_LIMIT_SECONDS} seconds"
        )
    return normalized_gpu, normalized_cpu, normalized_memory, normalized_time


def _sandbox_dirs(row: dict[str, Any]) -> tuple[str, str]:
    experiment_id = str(row.get("experiment_id") or "")
    remote_dir = str(
        row.get("sync_dir")
        or row.get("workdir")
        or remote_experiment_dir(
            experiment_id=str(row.get("sandbox_uid") or experiment_id)
        )
    )
    data_dir = str(
        row.get("sandbox_data_dir") or row.get("unsynced_dir") or DEFAULT_DATA_DIR
    )
    return remote_dir, data_dir


def _runtime_hint(
    *,
    status: str,
    ssh: dict[str, Any],
    remote_dir: str,
    expires_at: Any,
    storage_enabled: bool,
) -> str:
    expiry = (
        f" This sandbox expires at {expires_at}; retain valuable output before "
        "that deadline or before release."
        if expires_at
        else ""
    )
    retention = (
        " Nothing is copied out automatically. Use sandbox.pull_outputs for "
        "selected light files, then artifact.submit for gated documents"
        + (
            ", and storage.submit for durable heavy artifacts."
            if storage_enabled
            else "; durable heavy-artifact storage is not configured."
        )
    )
    if status == "provisioning":
        return (
            "Provisioning is in progress. Poll sandbox.get after "
            f"{POLL_AFTER_SECONDS} seconds until status is running; do not "
            "re-call sandbox.request as a poll. Once running, connect using "
            "the returned ssh.host, ssh.port, and ssh.user with the "
            "caller-owned private key." + expiry + retention
        )
    if status == "failed":
        return (
            "Provisioning failed; inspect error, correct the request or "
            "provider issue, then call sandbox.request to retry."
        )
    if status == CLEANUP_PENDING_STATUS:
        return (
            "This sandbox was told to shut down but the provider never "
            "confirmed it, so the machine may still exist and still be "
            "billing. Do not use it for work and do not assume the cost "
            "stopped. The cleanup sweep re-asks the provider on a backoff and "
            "settles the row once it confirms; check the provider console if "
            "it stays here. Call sandbox.request for a fresh sandbox."
        )
    if status in ACTIVE_SANDBOX_STATUSES and ssh.get("host") and ssh.get("port"):
        return (
            "Connect using the returned ssh.host, ssh.port, and ssh.user with "
            "the caller-owned private key. Work in the remote experiment_dir "
            f"({remote_dir}); use merv_run for long jobs and sandbox.runs for "
            "their receipts."
            + expiry
            + retention
            + " Call sandbox.get once if the SSH endpoint becomes stale."
        )
    return "No live sandbox found; call sandbox.request to create one."


def _pull_output_sources(
    *, remote_dir: str, user: str, host: str, paths: list[str]
) -> list[str]:
    """Validated, individually shell-quoted rsync remote source arguments."""
    if user.startswith("-") or _SAFE_SSH_USER_RE.fullmatch(user) is None:
        raise ValidationError(
            "sandbox.pull_outputs SSH user must be non-empty and contain only "
            "ASCII letters, digits, '.', '_', or '-', and must not start with '-'"
        )
    root = PurePosixPath(remote_dir)
    sources: list[str] = []
    for raw_path in paths:
        path = str(raw_path)
        relative = PurePosixPath(path)
        if not path or relative.is_absolute() or ".." in relative.parts:
            raise ValidationError(
                "sandbox.pull_outputs paths must be non-empty relative paths "
                "without '..' components"
            )
        if _SAFE_PULL_OUTPUT_PATH_RE.fullmatch(path) is None:
            raise ValidationError(
                "sandbox.pull_outputs paths may contain only ASCII letters, "
                "digits, '/', '.', '_', and '-' (no whitespace, backslashes, "
                "or shell metacharacters)"
            )
        resolved = root.joinpath(relative)
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise ValidationError(
                f"sandbox.pull_outputs path escapes experiment_dir: {path}"
            ) from exc
        sources.append(shlex.quote(f"{user}@{host}:{resolved}"))
    return sources


class SandboxEngine:
    """One readable API for Sandbox commands, reads, and maintenance."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        backend: SandboxBackend,
        mgmt_keys: MgmtKeyStore,
        request_wait_seconds: float | None = None,
        stale_provision_seconds: float | None = None,
        force_expiry_reaper: bool = False,
        storage_enabled: bool = False,
        storage_hint: str = "",
        attachment_check: Callable[..., None] | None = None,
        provider_admission: ProviderAdmission | None = None,
    ) -> None:
        self._quotas = QuotaService(store=store)
        self.storage_enabled = bool(storage_enabled)
        self.storage_hint = str(storage_hint or "")
        self.attachment_check = attachment_check
        # Composition-injected project gate: raises when the project has
        # switched the resolved provider off (Sandboxes → Configure).
        self._provider_admission = provider_admission
        self.activity_policy = SandboxActivityPolicy()
        self.request_wait_seconds = env_float(
            "RESEARCH_PLUGIN_SANDBOX_REQUEST_WAIT",
            request_wait_seconds,
            DEFAULT_REQUEST_WAIT_SECONDS,
        )
        self._stale_provision_seconds = env_float(
            "RESEARCH_PLUGIN_SANDBOX_STALE",
            stale_provision_seconds,
            DEFAULT_STALE_PROVISION_SECONDS,
        )
        self._store = store
        self._backend = backend
        self._keys = mgmt_keys
        self._secret_custody = EphemeralSecretCustody()
        self._storage = SandboxStorage(store=store)
        self._metrics = SandboxMetrics(
            storage=self._storage, backend=backend, mgmt_keys=mgmt_keys
        )
        self._runs = SandboxRunLedger(
            store=store,
            storage=self._storage,
            backend=backend,
            mgmt_keys=mgmt_keys,
        )
        self._observer = RunsObserver(ledger=self._runs, storage=self._storage)
        self._lifecycle = SandboxLifecycle(
            storage=self._storage,
            backend=backend,
            mgmt_keys=mgmt_keys,
            secret_custody=self._secret_custody,
            observer=self._observer,
            runs=self._runs,
        )
        self._provisioner = SandboxProvisioner(
            storage=self._storage,
            backend=backend,
            lifecycle=self._lifecycle,
            revalidate_quote=self._revalidate_quote,
        )
        self._heartbeat = SandboxHeartbeatMonitor(
            storage=self._storage,
            metrics=self._metrics,
            runs=self._runs,
            observer=self._observer,
            reap_row=self._lifecycle.reap_row,
        )
        self._budget = BudgetEnforcer(
            store=store,
            storage=self._storage,
            quotas=self._quotas,
            lifecycle=self._lifecycle,
            cancel_provision=self._provisioner.cancel,
        )
        self._scheduler = SandboxScheduler(
            sweep=self._maintenance_sweep,
            enforce_expiry=backend.capabilities.enforce_expiry,
            force_expiry_reaper=force_expiry_reaper,
            caps_active=store.any_provider_user_caps,
        )
        self._transcripts = TranscriptCache()
        self.runs_wait_poll_seconds = RUNS_WAIT_POLL_SECONDS
        # The durable transaction is authoritative; this lock avoids duplicate
        # local work before two same-experiment requests reach it.
        self._request_locks: dict[str, threading.Lock] = {}
        self._request_locks_guard = threading.Lock()

    def start(self) -> None:
        self._scheduler.start()

    def shutdown(self) -> None:
        self._scheduler.stop()
        self._provisioner.shutdown()
        self._secret_custody.clear()
        self._backend.shutdown()

    def _maintenance_sweep(
        self,
        *,
        stale_deadline_seconds: float,
        expiry_enabled: bool,
        idle_threshold_seconds: float,
    ) -> None:
        """Run one safety-ordered sweep without letting one pass kill the timer.

        Isolation stays per pass but is never silent: several passes ARE the
        money safety (budget caps, expiry reaping), so a persistent failure
        must reach the logs instead of becoming a permanent no-op.
        """
        now = datetime.now(tz=UTC)

        def guarded(pass_name: str, run: Callable[[], object]) -> None:
            try:
                run()
            except Exception:
                LOGGER.exception("sandbox maintenance pass %s failed", pass_name)

        if expiry_enabled:
            guarded("reap_expired", lambda: self._lifecycle.reap_expired(now=now))
        # Detached work appears in receipts before it appears in gauges.
        guarded("observe_live", self._observer.observe_live)
        guarded(
            "reap_idle",
            lambda: self._heartbeat.reap_idle(
                now=now, threshold_seconds=idle_threshold_seconds
            ),
        )
        if expiry_enabled:
            guarded(
                "reap_stale_provisions",
                lambda: self._provisioner.reap_stale_provisions(
                    now=now, deadline_seconds=stale_deadline_seconds
                ),
            )
        # Deliberately NOT gated by expiry_enabled: user-cap money safety
        # must not switch off with the expiry reaper env flags.
        guarded("budget_enforce", lambda: self._budget.enforce(now=now))
        guarded(
            "retry_cleanup_pending",
            lambda: self._lifecycle.retry_cleanup_pending(now=now),
        )

    def _deliver_secrets_once(self, *, row: dict[str, Any]) -> None:
        uid = str(row.get("sandbox_uid") or "")
        if row.get("status") != "running" or not self._secret_custody.pending(
            sandbox_uid=uid
        ):
            return
        sandbox_id = str(row.get("sandbox_id") or "")
        if not sandbox_id:
            return
        try:
            target = SandboxTarget.from_row(
                row,
                key_path=str(self._keys.key_path(sandbox_uid=uid)),
            ).addressed(self._backend)
        except Exception:
            return
        hf_token = self._secret_custody.hf_token(
            sandbox_uid=uid
        )
        try:
            secrets = self._backend.sandbox_secrets(hf_token=hf_token)
        except Exception:
            return
        if not secrets:
            self._secret_custody.mark_delivered(sandbox_uid=uid)
            return
        try:
            delivered = self._backend.write_secrets(
                target=target,
                secrets=secrets,
            )
        except Exception:
            return
        if delivered:
            self._secret_custody.mark_delivered(sandbox_uid=uid)

    @contextmanager
    def _experiment_request_guard(self, experiment_id: str) -> Iterator[None]:
        """Serialize the short reserve decision, not the provisioning wait."""
        if not experiment_id:
            yield
            return
        with self._request_locks_guard:
            lock = self._request_locks.get(experiment_id)
            if lock is None:
                lock = threading.Lock()
                self._request_locks[experiment_id] = lock
        with lock:
            yield

    def _provisioning_is_fresh(self, *, row: dict[str, Any]) -> bool:
        started = parse_iso(row.get("provision_started_at") or row.get("updated_at"))
        now = parse_iso(now_iso())
        if started is None or now is None:
            return False
        return (now - started).total_seconds() < self._stale_provision_seconds

    def _reconcile(self, *, row: dict[str, Any]) -> dict[str, Any]:
        job_live = False
        if row.get("status") == "provisioning":
            with suppress(Exception):
                job_live = self._provisioner.job_is_live(
                    sandbox_uid=str(row.get("sandbox_uid") or ""),
                )
        return self._lifecycle.reconcile(
            row=row,
            provisioning_job_live=job_live,
        )

    def _revalidate_quote(
        self,
        *,
        sandbox_uid: str,
        project_id: str,
        req: SandboxRequest,
        price: float | None,
    ) -> bool:
        """Pre-launch on_quote hook: recheck spend policy against the final
        quote under the cap lock and stamp it on the reservation. A raise
        aborts acquire before any billable resource exists; False means the
        reservation is no longer provisioning (a release/reaper won) — the
        worker must abort rather than launch an unaccountable instance."""
        with self._store.transaction() as conn:
            self._quotas.check_final_quote(
                conn=conn,
                sandbox_uid=sandbox_uid,
                tenant_id=self._storage.tenant_for_project(
                    project_id=project_id, conn=conn
                ),
                user_id=req.user_id,
                billing_mode=req.billing_mode,
                provider=self._capabilities_for(provider=req.provider).name,
                time_limit_seconds=int(req.time_limit),
                price=price,
            )
            return self._storage.stamp_quoted_price(
                conn=conn,
                sandbox_uid=sandbox_uid,
                expected_project_id=project_id,
                price=price,
            )

    def _resolve_hf_token(self, *, user_id: str) -> str:
        """Read the write-only token; lookup failure means public models only."""
        if not user_id:
            return ""
        try:
            return self._store.user_hf_token(user_id=user_id)
        except Exception:
            return ""

    def _agent_result(
        self,
        *,
        row: dict[str, Any],
        reused: bool | None,
    ) -> dict[str, Any]:
        return self._with_runs_nudge(
            view=self._agent_facts(row=row, reused=reused),
            sandbox_uid=str(row.get("sandbox_uid") or ""),
        )

    def _with_runs_nudge(
        self, *, view: dict[str, Any], sandbox_uid: str
    ) -> dict[str, Any]:
        if not sandbox_uid:
            return view
        try:
            nudge = self._runs.nudge_line(sandbox_uid=sandbox_uid)
        except Exception:
            return view
        if nudge:
            view["runs"] = nudge
        return view

    def _agent_facts(
        self, *, row: dict[str, Any], reused: bool | None
    ) -> dict[str, Any]:
        snapshot = self._canonical_snapshot(row=row)
        status = str(snapshot["status"])
        facts: dict[str, Any] = {
            "sandbox_uid": snapshot["sandbox_uid"],
            "experiment_id": snapshot["experiment_id"],
            "active_experiment_ids": snapshot["active_experiment_ids"],
            "project_id": snapshot["project_id"],
            "sandbox_id": snapshot["sandbox_id"],
            "status": status,
            "ssh": {
                "host": snapshot["ssh_host"],
                "port": snapshot["ssh_port"],
                "user": snapshot["ssh_user"],
            },
            "workdir": snapshot["workdir"],
            "experiment_dir": snapshot["sync_dir"],
            "data_dir": snapshot["sandbox_data_dir"],
            "volume": snapshot["volume_name"],
            "gpu": snapshot["gpu"] or None,
            "cpu": snapshot["cpu"],
            "memory": snapshot["memory"],
            "provider": snapshot["provider"] or None,
            "instance_type": snapshot["instance_type"] or None,
            "region": snapshot["region"] or None,
            "public_key_source": snapshot["public_key_source"],
            "expires_at": snapshot["expires_at"],
        }
        facts["storage_enabled"] = self.storage_enabled
        facts["hint"] = _runtime_hint(
            status=status,
            ssh=facts["ssh"],
            remote_dir=str(facts["experiment_dir"]),
            expires_at=facts["expires_at"],
            storage_enabled=self.storage_enabled,
        )
        environment = self._sandbox_environment()
        if environment.get("available_tokens"):
            facts["environment"] = environment
        if status == "provisioning":
            facts.update(
                phase=snapshot["phase"] or "starting",
                detail=snapshot["detail"],
                poll_after_seconds=POLL_AFTER_SECONDS,
            )
        elif status == "failed":
            facts["error"] = snapshot["error"] or "provisioning failed"
        elif status == CLEANUP_PENDING_STATUS:
            facts["cleanup"] = {
                "attempt": cleanup_attempts(phase=row.get("phase")),
                "in_flight": bool(cleanup_inflight_token(phase=row.get("phase"))),
                "detail": snapshot["detail"],
                "error": snapshot["error"],
            }
        if reused is not None:
            facts["reused"] = reused
        return facts

    def _agent_summary(self, *, row: dict[str, Any]) -> dict[str, Any]:
        snapshot = self._canonical_snapshot(row=row)
        return {
            "sandbox_uid": snapshot["sandbox_uid"],
            "experiment_id": snapshot["experiment_id"],
            "active_experiment_ids": snapshot["active_experiment_ids"],
            "sandbox_id": snapshot["sandbox_id"],
            "status": snapshot["status"],
            "gpu": snapshot["gpu"] or None,
            "provider": snapshot["provider"] or None,
            "instance_type": snapshot["instance_type"] or None,
            "region": snapshot["region"] or None,
            "expires_at": snapshot["expires_at"],
        }

    def _canonical_snapshot(self, *, row: dict[str, Any]) -> dict[str, Any]:
        """Build every public projection from one hydrated row."""
        hydrated = dict(row)
        active = [
            str(experiment_id)
            for experiment_id in hydrated.get("active_experiment_ids") or []
            if str(experiment_id)
        ]
        if not hydrated.get("experiment_id") and active:
            hydrated["experiment_id"] = active[0]
        remote_dir, data_dir = _sandbox_dirs(hydrated)
        status = hydrated.get("status") or "none"
        return {
            "sandbox_uid": hydrated.get("sandbox_uid"),
            "experiment_id": hydrated.get("experiment_id"),
            "active_experiment_ids": active,
            "project_id": hydrated.get("project_id"),
            "sandbox_id": hydrated.get("sandbox_id"),
            "status": status,
            "phase": public_phase(phase=hydrated.get("phase")),
            "detail": hydrated.get("detail") or "",
            "error": hydrated.get("error") or "",
            "gpu": hydrated.get("gpu") or "",
            "cpu": hydrated.get("cpu"),
            "memory": hydrated.get("memory"),
            "provider": hydrated.get("provider") or "",
            "instance_type": hydrated.get("instance_type") or "",
            "region": hydrated.get("region") or "",
            "public_key_source": hydrated.get("public_key_source") or "managed",
            "time_limit": hydrated.get("time_limit"),
            "ssh_host": hydrated.get("ssh_host"),
            "ssh_port": hydrated.get("ssh_port"),
            "ssh_user": hydrated.get("ssh_user"),
            "workdir": hydrated.get("workdir"),
            "sync_dir": remote_dir,
            "sandbox_data_dir": data_dir,
            "volume_name": hydrated.get("volume_name"),
            "requested_at": hydrated.get("requested_at"),
            "expires_at": hydrated.get("expires_at"),
            "last_seen_at": hydrated.get("last_seen_at"),
            "terminated_at": hydrated.get("terminated_at"),
            "created_at": hydrated.get("created_at"),
            "updated_at": hydrated.get("updated_at"),
        }

    def _live_snapshot(self, *, row: dict[str, Any]) -> dict[str, Any]:
        """Canonical row plus the liveness the fleet table reads per row.

        The fleet view has to answer "is this box working, on what, and
        trending which way" for every box at once. Both answers are already on
        the row — the command snapshot written by the last transcript read, the
        usage series written by the control-plane heartbeat sweep — so reading
        them costs one projection, not one SSH round trip per box. Only the
        list path enriches: single-sandbox and agent-facing views keep the
        narrower canonical shape.
        """
        snapshot = self._canonical_snapshot(row=row)
        command = self._storage.command_snapshot(row=row)
        if command is not None:
            snapshot["last_command"] = {
                # Bound the text: this rides a 3s poll, and the row ellipsizes.
                "command": str(command.get("command") or "")[:LIVE_COMMAND_MAX_CHARS],
                "status": command.get("status"),
                "started_at": command.get("started_at"),
                "finished_at": command.get("finished_at"),
                "exit_code": command.get("exit_code"),
            }
        # A terminated box's last sample is archaeology, not liveness.
        if snapshot["status"] == "running":
            snapshot["heartbeat"] = self._heartbeat_view(row=row)
        return snapshot

    def _heartbeat_view(self, *, row: dict[str, Any]) -> dict[str, Any] | None:
        """Compact usage projection: current percentages plus the trend ring.

        `latest` is derived from the stored sample rather than the ring's tail
        so rows written before the ring existed still render their bars — the
        sparkline simply stays empty until the sweep has filled it.

        `gpus` is the card inventory the sampler saw (count, per-card VRAM,
        model name): the row only stores the short GPU label chosen at
        provision, so this is where the fleet table learns "1× A100 80 GB".
        """
        record = self._storage.heartbeat_snapshot(row=row)
        if not isinstance(record, dict):
            return None
        metrics = record.get("metrics")
        sampled_at = parse_iso(record.get("sampled_at"))
        series = record.get("series")
        return {
            "sampled_at": record.get("sampled_at"),
            "idle_since": row.get("idle_since") or None,
            "latest": (
                usage_point(
                    metrics=metrics,
                    now=sampled_at or datetime.now(tz=UTC),
                    row=row,
                )
                if isinstance(metrics, dict)
                else None
            ),
            "gpus": gpu_inventory(metrics=metrics) if isinstance(metrics, dict) else None,
            "series": (
                [point for point in series if isinstance(point, dict)]
                if isinstance(series, list)
                else []
            ),
        }

    def _capabilities_for(self, *, provider: str | None) -> BackendCapabilities:
        try:
            return self._backend.capabilities_for(provider=provider)
        except BackendValidationError as exc:
            raise ValidationError(str(exc)) from exc

    def _quoted_price(
        self,
        *,
        instance_type: str | None,
        region: str | None,
        provider: str | None = None,
    ) -> tuple[float | None, str]:
        """``(price, why-unknown)`` for the chosen instance.

        The reason lets admission distinguish an unavailable quote from the
        provider's explicit zero price and fail closed.
        """
        if not instance_type:
            return None, (
                "no instance_type was selected, so this backend quotes no "
                "per-instance price"
            )
        try:
            catalog = self._backend.hardware_catalog(region=region)
        except Exception as exc:  # noqa: BLE001
            return None, f"the provider price catalog could not be read ({exc})"
        if not catalog:
            return None, "this backend publishes no price catalog"
        for option in catalog.get("options", []) or []:
            if str(option.get("instance_type") or "") != instance_type:
                continue
            tagged = str(option.get("provider") or "")
            if provider and tagged and (tagged != provider):
                continue
            price = option.get("price_usd_per_hour")
            if price is None:
                return None, (
                    f"the catalog lists no price for instance_type {instance_type}"
                )
            return float(price), ""
        return None, (
            f"instance_type {instance_type} is not in the provider price catalog"
        )

    def _hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        catalog = self._backend.hardware_catalog(gpu=gpu, region=region)
        if catalog is None:
            return {
                "provider": self._backend.capabilities.name,
                "selection_required": False,
                "options": [],
                "regions": [],
            }
        return catalog

    @staticmethod
    def _needs_selection_view(
        *, experiment_id: str, project_id: str, catalog: dict[str, Any]
    ) -> dict[str, Any]:
        options = catalog.get("options", [])
        cheapest = options[0]["instance_type"] if options else None
        providers = catalog.get("providers")
        view: dict[str, Any] = {
            "experiment_id": experiment_id,
            "project_id": project_id,
            "status": "needs_selection",
            "provider": catalog.get("provider"),
            "select_with": catalog.get("select_with") or "instance_type",
            "reason": catalog.get("reason")
            or "This provider bundles GPU + CPU + RAM into fixed machine types.",
            "options": options,
            "regions": catalog.get("regions", []),
            "hint": (
                "No sandbox is attached and this provider procures whole machines, "
                "so choose one before provisioning. Re-call sandbox.request with "
                "instance_type=<one of options[].instance_type> (and optionally "
                "region=<one of that option's regions>"
                + (
                    "; multiple compute providers are configured, so also pass the "
                    "chosen option's provider"
                    if providers
                    else ""
                )
                + "). Options are sorted cheapest-first"
                + (f"; cheapest available now is '{cheapest}'. " if cheapest else ". ")
                + "Call sandbox.options anytime to re-list current availability."
            ),
        }
        if providers:
            view["providers"] = providers
        return view

    def _sandbox_environment(self) -> dict[str, Any]:
        try:
            result = self._backend.sandbox_environment()
        except Exception:
            return {"available_tokens": [], "notes": []}
        if not isinstance(result, dict):
            return {"available_tokens": [], "notes": []}
        tokens = [
            str(token)
            for token in result.get("available_tokens", [])
            if isinstance(token, str) and token
        ]
        notes = [
            str(note)
            for note in result.get("notes", [])
            if isinstance(note, str) and note
        ]
        return {"available_tokens": tokens, "notes": notes}

    def _reserve_provisioning(
        self,
        *,
        conn: Connection,
        experiment_id: str,
        project_id: str,
        request: SandboxRequest,
        admission: AdmissionRequest,
        provider_name: str,
        additional: bool,
    ) -> dict[str, Any] | None:
        """Atomically admit and reserve one potentially billable slot."""
        if experiment_id and not additional:
            existing = self._storage.active_reservation(
                conn=conn, experiment_id=experiment_id
            )
            if existing is not None:
                return existing
        self._quotas.check_admission(request=admission, conn=conn, _serialize=True)
        self._storage.reserve_provisioning(
            conn=conn,
            experiment_id=experiment_id,
            project_id=project_id,
            request=request,
            provider=provider_name,
            quoted_price=admission.price_usd_per_hour,
        )
        return None

    def request(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        gpu: str | None = None,
        cpu: float | None = None,
        memory: int | None = None,
        time_limit: int | None = None,
        instance_type: str | None = None,
        region: str | None = None,
        provider: str | None = None,
        public_key: str | None = None,
        public_key_override: str | None = None,
        additional: bool = False,
        sandbox_uid: str | None = None,
        provisioning_user_id: str = "",
        provisioning_key_id: str = "",
    ) -> dict[str, Any]:
        if (sandbox_uid or "").strip():
            raise ValidationError(
                "sandbox.request does not take sandbox_uid — the brain mints it "
                "and returns it; use sandbox.attach or sandbox.get to reach a "
                "sandbox that already exists"
            )
        experiment_id = (experiment_id or "").strip()
        instance_type = (instance_type or "").strip() or None
        region = (region or "").strip() or None
        provider = (provider or "").strip() or None
        public_key = (
            str(public_key_override).strip()
            if public_key_override is not None
            else str(public_key or "").strip()
        )
        additional = bool(additional)
        provisioning_user_id = str(provisioning_user_id or "")
        provisioning_key_id = str(provisioning_key_id or "")
        caps = self._capabilities_for(provider=provider)
        gpu, cpu, memory, time_limit = _validated_resources(
            gpu=gpu,
            cpu=cpu,
            memory=memory,
            time_limit=time_limit,
            configurable=caps.configurable_resources,
        )
        with self._store.transaction() as conn:
            project_id = self._store.require_project_id(
                conn=conn, project_id=project_id
            )
        if self._provider_admission is not None:
            # caps.name is the RESOLVED provider (the fleet default when the
            # caller passed none), so a disabled default blocks bare requests.
            self._provider_admission(project_id=project_id, provider=caps.name)
        if experiment_id and self.attachment_check is not None:
            self.attachment_check(attachment_id=experiment_id, project_id=project_id)
        with self._experiment_request_guard(experiment_id):
            if experiment_id:
                try:
                    existing = self._storage.load_row(experiment_id=experiment_id)
                except NotFoundError:
                    existing = None
            else:
                existing = None
                additional = False
            parked_cleanup = bool(
                existing and existing.get("status") == CLEANUP_PENDING_STATUS
            )
            if parked_cleanup:
                # Its VM may still be up and billing, and that row is the only
                # record of it — provisioning over it would erase the provider
                # id. Leave it to the cleanup sweep and mint a fresh row.
                existing = None
            reuse_live = bool(
                not additional
                and existing
                and (existing.get("status") in ACTIVE_SANDBOX_STATUSES)
                and existing.get("sandbox_id")
                # Unknown liveness is reused; clearing it could orphan a live VM.
                and (self._lifecycle.liveness(row=existing) is not False)
            )
            # Never clean beneath an in-flight local provision. An additional
            # request provisions a freshly minted uid, so the sibling's live
            # job must not stand in for it — that would skip admission and
            # the reservation for a box the ledger could never attribute.
            job_live = bool(
                not additional
                and existing
                and self._provisioner.job_is_live(
                    sandbox_uid=str(existing.get("sandbox_uid") or ""),
                )
            )
            if (
                not additional
                and existing
                and existing.get("status") == "provisioning"
                and not job_live
                and self._provisioning_is_fresh(row=existing)
            ):
                result = self._agent_result(row=existing, reused=None)
                result["public_key_source"] = "caller"
                return result
            if (
                not additional
                and not reuse_live
                and not job_live
                and not parked_cleanup
            ):
                # Unconfirmed deletion parks the old provider ID for retry.
                cleanup = self._lifecycle.clear_for_reacquisition(
                    experiment_id=experiment_id, row=existing
                )
                if cleanup == "maybe_alive":
                    existing = None
            sandbox_uid = (
                self._storage.new_sandbox_uid()
                if additional
                else str(
                    (existing or {}).get("sandbox_uid")
                    or self._storage.new_sandbox_uid()
                )
            )
            if not public_key:
                raise ValidationError(
                    "sandbox.request requires public_key; generate a caller-owned OpenSSH keypair and pass the single-line .pub contents"
                )
            public_key_source = "caller"
            if reuse_live and existing:
                touched = self._storage.touch_alive(
                    sandbox_uid=str(existing.get("sandbox_uid") or ""),
                    expected_project_id=project_id,
                )
                if touched:
                    row = self._lifecycle.refresh_endpoint(
                        row=self._storage.get_by_uid(
                            sandbox_uid=str(existing.get("sandbox_uid") or "")
                        )
                    )
                    self._storage.emit_event(
                        project_id=project_id,
                        event_type="sandbox.reused",
                        experiment_id=experiment_id,
                        payload={
                            "sandbox_id": existing["sandbox_id"],
                            "sandbox_uid": existing.get("sandbox_uid", ""),
                            "active_experiment_ids": (
                                self._storage.active_experiment_ids(
                                    sandbox_uid=str(existing.get("sandbox_uid") or "")
                                )
                            ),
                        },
                    )
                    result = self._agent_result(
                        row=row,
                        reused=True,
                    )
                    result["public_key_source"] = public_key_source
                    return result
                # A concurrent cleanup claimed the row after the liveness read.
                existing = None
                sandbox_uid = self._storage.new_sandbox_uid()
            if caps.requires_hardware_selection and (not instance_type):
                catalog = self._hardware_catalog(gpu=gpu, region=region)
                return self._needs_selection_view(
                    experiment_id=experiment_id, project_id=project_id, catalog=catalog
                )
            price, price_unknown_reason = self._quoted_price(
                instance_type=instance_type, region=region, provider=caps.name
            )
            # Payer of record: the JWT user, else the mk_ key's owner —
            # resolved once here so the admission check and the ledger stamp
            # agree by construction. '' stays uncapped (legacy/local).
            payer_user_id = provisioning_user_id or self._store.api_key_owner(
                key_id=provisioning_key_id
            )
            billing_mode = ""
            if payer_user_id:
                try:
                    billing_mode = self._backend.credential_source_for(
                        provider=caps.name
                    )
                except Exception:  # noqa: BLE001 — fail toward the capped mode
                    billing_mode = "platform"
            admission = AdmissionRequest(
                tenant_id=self._storage.tenant_for_project(project_id=project_id),
                time_limit_seconds=int(time_limit),
                price_usd_per_hour=price,
                price_unknown_reason=price_unknown_reason,
                project_id=project_id,
                provider=caps.name,
                user_id=payer_user_id,
                billing_mode=billing_mode,
            )
            # The later transactional admission is authoritative.
            if not job_live:
                self._quotas.check_admission(request=admission)
            # Mint only after preflight so denied retries cannot leak keypairs.
            management_public_key = self._keys.ensure(sandbox_uid=sandbox_uid)
            remote_dir = remote_experiment_dir(
                experiment_id=sandbox_uid, name=f"sandbox-{sandbox_uid[:12]}"
            )
            # Modal injects at provision; VM/SSH backends deliver post-boot.
            # The token is never persisted.
            hf_token = self._resolve_hf_token(
                user_id=provisioning_user_id
            )
            if hf_token:
                self._secret_custody.remember(
                    sandbox_uid=sandbox_uid,
                    hf_token=hf_token,
                )
            req = SandboxRequest(
                experiment_id=sandbox_uid,
                project_id=project_id,
                public_key=public_key,
                sandbox_uid=sandbox_uid,
                management_public_key=management_public_key,
                management_key_path=str(self._keys.key_path(sandbox_uid=sandbox_uid)),
                gpu=gpu,
                cpu=cpu,
                memory=memory,
                time_limit=time_limit,
                instance_type=instance_type,
                region=region,
                provider=provider,
                remote_workdir=remote_dir,
                public_key_source=public_key_source,
                hf_token=hf_token,
                key_id=provisioning_key_id,
                user_id=payer_user_id,
                billing_mode=billing_mode,
            )
            if not job_live:
                try:
                    with self._store.transaction() as conn:
                        reserved_existing = self._reserve_provisioning(
                            conn=conn,
                            experiment_id=experiment_id,
                            project_id=project_id,
                            request=req,
                            admission=admission,
                            provider_name=caps.name,
                            additional=additional,
                        )
                except Exception:
                    self._secret_custody.forget(sandbox_uid=sandbox_uid)
                    with suppress(Exception):
                        self._keys.remove(sandbox_uid=sandbox_uid)
                    raise
                if reserved_existing is not None:
                    # Never deliver this caller's secret to another controller's
                    # winning reservation.
                    self._secret_custody.forget(sandbox_uid=sandbox_uid)
                    existing_uid = str(reserved_existing.get("sandbox_uid") or "")
                    if sandbox_uid != existing_uid:
                        with suppress(Exception):
                            self._keys.remove(sandbox_uid=sandbox_uid)
                    result = self._agent_result(
                        row=reserved_existing,
                        reused=(
                            True
                            if reserved_existing.get("status") == "running"
                            else None
                        ),
                    )
                    result["public_key_source"] = public_key_source
                    return result
            job = self._provisioner.ensure_job(
                experiment_id=experiment_id,
                project_id=project_id,
                req=req,
                sandbox_uid=sandbox_uid,
            )
        job.done.wait(timeout=self.request_wait_seconds)
        row = self._storage.get_by_uid(sandbox_uid=sandbox_uid)
        reused = False if row.get("status") == "running" else None
        self._deliver_secrets_once(row=row)
        result = self._agent_result(
            row=row,
            reused=reused,
        )
        result["public_key_source"] = public_key_source
        return result

    def get(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        tenant_id: str | None = None,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any]:
        experiment_id = (experiment_id or "").strip()
        if not experiment_id and (not (sandbox_uid or "").strip()):
            raise ValidationError("sandbox.get requires experiment_id or sandbox_uid")
        try:
            row = self._storage.fetch_scoped(
                experiment_id=experiment_id,
                project_id=project_id,
                tenant_id=tenant_id,
                sandbox_uid=sandbox_uid,
            )
        except NotFoundError:
            if (sandbox_uid or "").strip():
                raise
            if experiment_id and self._storage.exists(experiment_id=experiment_id):
                raise
            return {
                "experiment_id": experiment_id,
                "status": "none",
                "hint": "No sandbox for this experiment — call sandbox.request to create one.",
            }
        row = self._reconcile(row=row)
        self._deliver_secrets_once(row=row)
        return self._agent_result(row=row, reused=None)

    def attach(
        self,
        *,
        experiment_id: str,
        project_id: str | None = None,
        sandbox_uid: str,
        public_key_override: str | None = None,
    ) -> dict[str, Any]:
        _ = public_key_override
        sandbox_uid = sandbox_uid.strip()
        if not sandbox_uid:
            raise ValidationError("sandbox.attach requires sandbox_uid")
        with closing(self._store.connect()) as conn:
            project_id = self._store.require_project_id(
                conn=conn, project_id=project_id
            )
        try:
            source_row = self._storage.get_by_uid(sandbox_uid=sandbox_uid)
        except NotFoundError as exc:
            raise NotFoundError(f"sandbox not found: {sandbox_uid}") from exc
        if source_row.get("project_id") != project_id:
            raise NotFoundError(
                f"sandbox not found in project {project_id}: {sandbox_uid}"
            )
        source_row = self._reconcile(row=source_row)
        if source_row.get("status") != "running" or not source_row.get("sandbox_id"):
            raise ValidationError("sandbox.attach requires a running sandbox")
        # Legacy IDs must be asked of the provider recorded on the row.
        if self._lifecycle.liveness(row=source_row) is False:
            raise ValidationError("sandbox.attach requires a live sandbox")
        if self.attachment_check is not None:
            self.attachment_check(attachment_id=experiment_id, project_id=project_id)
        row = self._storage.attach(
            sandbox_uid=sandbox_uid, experiment_id=experiment_id, project_id=project_id
        )
        active_experiment_ids = self._storage.active_experiment_ids(
            sandbox_uid=sandbox_uid
        )
        self._storage.emit_event(
            project_id=project_id,
            event_type="sandbox.attached",
            experiment_id=experiment_id,
            payload={
                "sandbox_id": row.get("sandbox_id", ""),
                "sandbox_uid": sandbox_uid,
                "active_experiment_ids": active_experiment_ids,
            },
        )
        result = self._agent_result(
            row=row,
            reused=True,
        )
        result["active_experiment_ids"] = active_experiment_ids
        return result

    def extend(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        tenant_id: str | None = None,
        sandbox_uid: str | None = None,
        seconds: int = 1800,
    ) -> dict[str, Any]:
        experiment_id = (experiment_id or "").strip()
        sandbox_uid = (sandbox_uid or "").strip()
        if not experiment_id and (not sandbox_uid):
            raise ValidationError(
                "sandbox.extend requires experiment_id or sandbox_uid"
            )
        seconds = int(seconds)
        if seconds <= 0 or seconds > 1800:
            raise ValidationError("sandbox.extend seconds must be between 1 and 1800")
        row = self._storage.fetch_scoped(
            experiment_id=experiment_id,
            project_id=project_id,
            tenant_id=tenant_id,
            sandbox_uid=sandbox_uid,
        )
        caps = self._capabilities_for(provider=str(row.get("provider") or "") or None)
        if not caps.lifetime_extension_supported:
            raise ValidationError(
                f"{caps.name} sandboxes do not support lifetime extension"
            )
        row = self._reconcile(row=row)
        if row.get("status") not in ACTIVE_SANDBOX_STATUSES:
            raise ValidationError("sandbox.extend requires a running sandbox")
        expires_at = parse_iso(row.get("expires_at"))
        if expires_at is None:
            raise ValidationError(
                "sandbox.extend requires an existing expires_at deadline"
            )
        current_limit = int(row.get("time_limit") or 0)
        new_limit = current_limit + seconds
        if new_limit > MAX_TIME_LIMIT_SECONDS:
            raise ValidationError(
                f"sandbox.extend would exceed the max lifetime ({MAX_TIME_LIMIT_SECONDS}s)"
            )
        resolved_project_id = str(row.get("project_id") or project_id or "")
        tenant = str(
            row.get("tenant_id")
            or self._storage.tenant_for_project(project_id=resolved_project_id)
        )
        if not self.activity_policy.is_active_snapshot(
            snapshot=self._storage.heartbeat_snapshot(row=row),
            command=self._storage.command_snapshot(row=row),
        ):
            raise ValidationError(
                "sandbox.extend requires a running command or active heartbeat metrics"
            )
        target_uid = str(row.get("sandbox_uid") or "")
        # One transaction holds the cap-row lock, the fresh row re-read, the
        # quota recompute, and the guarded expiry update — two extends by one
        # payer (or an extend racing an admission) can no longer both pass on
        # a stale commitment snapshot. The preamble checks above are fast-fail
        # only; everything below re-reads inside the transaction.
        with self._store.transaction() as conn:
            fresh = self._storage.raw_row_in(conn=conn, sandbox_uid=target_uid)
            if fresh is None:
                raise NotFoundError(f"sandbox not found: {target_uid}")
            if str(fresh.get("status")) != "running":
                raise ValidationError("sandbox.extend requires a running sandbox")
            fresh_expires = parse_iso(fresh.get("expires_at"))
            if fresh_expires is None:
                raise ValidationError(
                    "sandbox.extend requires an existing expires_at deadline"
                )
            new_limit = int(fresh.get("time_limit") or 0) + seconds
            if new_limit > MAX_TIME_LIMIT_SECONDS:
                raise ValidationError(
                    f"sandbox.extend would exceed the max lifetime ({MAX_TIME_LIMIT_SECONDS}s)"
                )
            old_expires_at = str(fresh.get("expires_at") or "")
            new_expires_at = format_iso(fresh_expires + timedelta(seconds=seconds))
            fresh_price = fresh.get("price_usd_per_hour")
            self._quotas.check_lifetime_extension(
                tenant_id=tenant,
                total_time_limit_seconds=new_limit,
                price_usd_per_hour=(
                    float(fresh_price) if fresh_price is not None else None
                ),
                conn=conn,
                row=fresh,
                added_seconds=seconds,
            )
            updated = self._storage.extend_lifetime(
                sandbox_uid=target_uid,
                expires_at=new_expires_at,
                time_limit=new_limit,
                expected_project_id=resolved_project_id,
                conn=conn,
            )
        resolved_experiment_id = experiment_id or str(
            updated.get("experiment_id") or ""
        )
        self._storage.emit_event(
            project_id=resolved_project_id,
            event_type="sandbox.lifetime_extended",
            experiment_id=resolved_experiment_id,
            payload={
                "sandbox_id": updated.get("sandbox_id", ""),
                "sandbox_uid": updated.get("sandbox_uid", ""),
                "old_expires_at": old_expires_at,
                "expires_at": new_expires_at,
                "seconds": seconds,
                "time_limit": new_limit,
            },
        )
        view = self._agent_result(
            row=updated,
            reused=None,
        )
        view["extended"] = True
        view["old_expires_at"] = old_expires_at
        view["extended_by_seconds"] = seconds
        view["time_limit"] = new_limit
        return view

    def options(
        self,
        *,
        project_id: str | None = None,
        gpu: str | None = None,
        region: str | None = None,
        requesting_user_id: str = "",
        requesting_key_id: str = "",
    ) -> dict[str, Any]:
        _ = project_id
        caps = self._backend.capabilities
        catalog = self._hardware_catalog(gpu=gpu, region=region)
        selection_required = bool(caps.requires_hardware_selection)
        hint = (
            "Pick one options[].instance_type and call sandbox.request(instance_type=..., region=?). Include experiment_id only when attaching the sandbox to an experiment. Options are sorted cheapest-first and reflect live capacity."
            if selection_required
            else "Call sandbox.request(gpu=?, cpu=?, memory=?). Include experiment_id only when attaching the sandbox to an experiment. Omit gpu for a CPU-only sandbox."
        )
        view = {"backend": caps.name, **catalog, "hint": hint}
        budget = self.user_budget_view(
            user_id=requesting_user_id,
            key_id=requesting_key_id,
            provider=caps.name,
        )
        if budget is not None:
            view["budget"] = budget
        return view

    def user_budget_view(
        self, *, user_id: str = "", key_id: str = "", provider: str = ""
    ) -> dict[str, Any] | None:
        """Remaining daily budget for the payer on one provider, or None
        when no cap applies. Read-only; powers options + settings views."""
        payer = user_id or self._store.api_key_owner(key_id=key_id)
        if not payer or not provider:
            return None
        cap = self._store.resolve_provider_user_cap(
            provider=provider, user_id=payer
        )
        if cap is None:
            return None
        now = datetime.now(tz=UTC)
        spent = self._quotas.user_provider_day_spend(
            user_id=payer, provider=provider, now=now
        )
        return {
            "provider": provider,
            "daily_cap_usd": cap,
            "spent_today_usd": round(spent, 4),
            "remaining_today_usd": round(max(0.0, cap - spent), 4),
            "resets_at": format_iso(
                datetime(now.year, now.month, now.day, tzinfo=UTC)
                + timedelta(days=1)
            ),
            "note": (
                "Daily per-user spend cap; enforced with a 1-hour grace on "
                "running sandboxes. New provisioning is denied once spend "
                "plus committed lease burn reaches the cap."
            ),
        }

    def list_sandboxes(self, *, project_id: str | None = None) -> dict[str, Any]:
        rows = self._storage.list_for_project(project_id=project_id)
        return {"sandboxes": [self._agent_summary(row=row) for row in rows]}

    def release(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        sandbox_uid: str | None = None,
        confirm_retained: bool = False,
    ) -> dict[str, Any]:
        experiment_id = (experiment_id or "").strip()
        if not experiment_id and (not (sandbox_uid or "").strip()):
            raise ValidationError(
                "sandbox.release requires experiment_id or sandbox_uid"
            )
        row = self._storage.fetch_scoped(
            experiment_id=experiment_id, project_id=project_id, sandbox_uid=sandbox_uid
        )
        targets = [row]
        if experiment_id and (not sandbox_uid):
            rows = [
                item
                for item in self._storage.list_for_experiment(
                    experiment_id=experiment_id,
                    project_id=str(row.get("project_id") or ""),
                )
                if item.get("project_id") == row.get("project_id")
            ]
            # Parked siblings may still bill and belong in aggregate release.
            active = [
                item
                for item in rows
                if item.get("status")
                in ACTIVE_SANDBOX_STATUSES | {"provisioning", CLEANUP_PENDING_STATUS}
            ]
            if len(active) > 1:
                targets = active
        if not confirm_retained:
            return self._with_runs_nudge(
                view=self._release_confirmation(
                    experiment_id=experiment_id,
                    project_id=str(row.get("project_id") or ""),
                    targets=targets,
                ),
                sandbox_uid=str(row.get("sandbox_uid") or ""),
            )
        views = [self._release_row(row=target) for target in targets]
        if len(views) == 1:
            return views[0]
        # Never report aggregate termination while any member may still bill.
        pending = [
            view for view in views if view.get("status") == CLEANUP_PENDING_STATUS
        ]
        result: dict[str, Any] = {
            "experiment_id": experiment_id,
            "project_id": row.get("project_id"),
            "status": CLEANUP_PENDING_STATUS if pending else "terminated",
            "released_count": len(views) - len(pending),
            "sandboxes": views,
            "hint": "All live sandboxes for this experiment were terminated.",
        }
        if pending:
            result["pending_count"] = len(pending)
            result["released"] = False
            result["hint"] = (
                f"Release is INCOMPLETE: {len(views) - len(pending)} of "
                f"{len(views)} sandboxes terminated, {len(pending)} could not "
                "be confirmed deleted and may still be running (and billing). "
                "Those rows are cleanup_pending — they stay visible and the "
                "cleanup sweep keeps asking the provider. Do not assume the "
                "bill stopped; see sandboxes[] for which ones, re-call "
                "sandbox.release to retry sooner, or check the provider console."
            )
        return result

    def _release_confirmation(
        self, *, experiment_id: str, project_id: str, targets: list[dict[str, Any]]
    ) -> dict[str, Any]:
        pending = [
            {
                "sandbox_uid": str(target.get("sandbox_uid") or ""),
                "sandbox_id": str(target.get("sandbox_id") or ""),
                "status": target.get("status"),
                "workdir": target.get("workdir"),
            }
            for target in targets
        ]
        count = len(pending)
        noun = "sandbox" if count == 1 else "sandboxes"
        return {
            "experiment_id": experiment_id,
            "project_id": project_id,
            "status": "confirmation_required",
            "released": False,
            "pending_release": pending,
            "hint": f"Not released yet. This will permanently destroy {count} {noun} and everything on the VM. First confirm you have retained everything you need: rsync the light files you want off the box yourself over SSH into the local work folder"
            + (
                f", and storage.submit for durable heavy artifacts. {self.storage_hint}"
                if self.storage_enabled
                else "; heavy-file storage is not enabled on this backend"
            )
            + ". Nothing is copied automatically — anything you do not pull is lost. When you have everything, re-call sandbox.release with confirm_retained=true to terminate.",
        }

    def _release_row(self, *, row: dict[str, Any]) -> dict[str, Any]:
        sandbox_uid = str(row.get("sandbox_uid") or "")
        # Manual release may jump backoff, but never another worker's claim.
        claim = self._lifecycle.claim_cleanup(row=row)
        if not claim:
            # A fresh reread distinguishes a stale snapshot from a held claim.
            fresh = self._storage.get_by_uid(sandbox_uid=sandbox_uid)
            if str(fresh.get("status") or "") == CLEANUP_PENDING_STATUS:
                claim = self._lifecycle.claim_cleanup(row=fresh)
                if claim:
                    row = fresh
        if not claim:
            view = self._canonical_snapshot(
                row=self._storage.get_by_uid(sandbox_uid=sandbox_uid)
            )
            view["hint"] = (
                "Nothing was sent to the provider: another cleanup attempt for this sandbox was already in flight, and a second one would terminate the same VM twice and settle it twice. `status` above is the row as it stands right now — if it is still cleanup_pending, that attempt has not reported yet; re-call sandbox.release to try again, or check the provider console."
            )
            return view
        self._provisioner.cancel(sandbox_uid=sandbox_uid)
        was_active = bool(
            row.get("sandbox_id") and row.get("status") in ACTIVE_SANDBOX_STATUSES
        )
        # Release bounds observation wait so receipt contention cannot delay
        # stopping the bill; skipped observation yields ``unknown``, not ``lost``.
        observed = self._lifecycle.observe_runs_before_terminal(
            row=row, acquire_timeout=RELEASE_OBSERVE_ACQUIRE_SECONDS
        )
        outcome = self._lifecycle.terminate_vm(
            row=row,
            try_direct=bool(
                row.get("sandbox_id")
                and row.get("status")
                in ACTIVE_SANDBOX_STATUSES | {"provisioning", CLEANUP_PENDING_STATUS}
            ),
        )
        # Preserve the failed verdict recorded before cleanup was parked.
        error = (
            str(row.get("error") or "")
            if row.get("status") == CLEANUP_PENDING_STATUS
            else ""
        )
        # Stamp only after provider absence is known, but before the fenced mark.
        if outcome != "maybe_alive":
            self._lifecycle.commit_runs_observation(
                row=row, observed=observed, expected_phase=claim.phase
            )
        applied = self._lifecycle.record_release_outcome(
            row=row,
            outcome=outcome,
            error=error,
            claim=claim,
        )
        if (
            outcome != "maybe_alive"
            and claim.phase
            and str(applied.get("status") or "") == CLEANUP_PENDING_STATUS
        ):
            # Another worker reclaimed the fence; report the row it owns.
            view = self._canonical_snapshot(row=applied)
            view["hint"] = (
                "The provider terminate call went through, but this release took longer than the cleanup deadline and another attempt reclaimed the sandbox, so the row was NOT settled here. `status` above is the row as it stands right now; the holding attempt will confirm it. Re-call sandbox.release if it stays cleanup_pending, or check the provider console."
            )
            return view
        if outcome == "maybe_alive":
            view = self._canonical_snapshot(
                row=self._storage.get_by_uid(sandbox_uid=sandbox_uid)
            )
            view["hint"] = (
                "Release did NOT complete: the provider terminate call failed and the VM may still be running (and billing). The sandbox is now cleanup_pending — it stays visible and the cleanup sweep keeps asking the provider until it confirms the VM is gone. Do not assume the bill stopped; re-call sandbox.release to retry sooner, or check the provider console."
            )
            return view
        view = self._canonical_snapshot(
            row=self._storage.get_by_uid(sandbox_uid=sandbox_uid)
        )
        if view.get("status") == "failed":
            view["hint"] = (
                "The VM is confirmed gone, but this sandbox is recorded as FAILED, not cleanly terminated: it carried a provisioning failure that release does not erase. See `error` for what went wrong."
            )
        elif was_active:
            view["hint"] = (
                "Sandbox terminated. The VM and files on it are gone. Only files the agent explicitly copied or uploaded before release remain durable."
            )
        else:
            view["hint"] = "Sandbox terminated. No running sandbox needed teardown."
        return view

    def terminal(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        sandbox_uid: str | None = None,
        tail: int | None = None,
        since: int | None = None,
    ) -> dict[str, Any]:
        experiment_id = (experiment_id or "").strip()
        if not experiment_id and (not (sandbox_uid or "").strip()):
            raise ValidationError(
                "sandbox.terminal requires experiment_id or sandbox_uid"
            )
        row = self._storage.fetch_scoped(
            experiment_id=experiment_id,
            project_id=project_id,
            sandbox_uid=sandbox_uid,
        )
        target = SandboxTarget.from_row(
            row,
            key_path=str(
                self._keys.key_path(sandbox_uid=str(row.get("sandbox_uid") or ""))
            ),
        )
        status = str(row.get("status", "none"))
        resolved_experiment_id = experiment_id or target.experiment_id
        transcript_key = target.sandbox_uid or resolved_experiment_id

        def read_for(key: str) -> TranscriptTail:
            return self._backend.read_transcript(
                target=addressed_target.for_experiment(key),
                tail=None,
            )

        def read_transcript() -> TranscriptTail:
            window = read_for(transcript_key)
            if (
                window.data
                or window.total_bytes
                or not resolved_experiment_id
                or resolved_experiment_id == transcript_key
            ):
                return window
            return read_for(resolved_experiment_id)

        unavailable = False
        window = TranscriptTail(data=b"", total_bytes=0)
        try:
            addressed_target = target.addressed(self._backend)
            window = self._transcripts.get_or_read(
                sandbox_id=addressed_target.sandbox_id,
                read=read_transcript,
                since=since,
            )
        except Exception as exc:
            full = f"(terminal unavailable: {exc})"
            unavailable = True
        if unavailable:
            transcript = full
            cursor = len(full)
        else:
            cursor = window.total_bytes
            window_start = max(cursor - len(window.data), 0)
            if since is not None:
                start = min(max(int(since) - window_start, 0), len(window.data))
                raw = window.data[start:]
            elif tail is not None and tail >= 0 and len(window.data) > tail:
                raw = window.data[-tail:]
            else:
                raw = window.data
            transcript = raw.decode("utf-8", errors="replace")
            full = window.data.decode("utf-8", errors="replace")

        command_status_stale = False
        if unavailable:
            last_command = self._storage.command_snapshot(row=row)
            command_status_stale = last_command is not None
            last_exit_code = (
                None if last_command is None else last_command.get("exit_code")
            )
            last_command_finished_at = (
                None if last_command is None else last_command.get("finished_at")
            )
            command_running = (
                None
                if last_command is None
                else last_command.get("status") == "running"
                and status in ACTIVE_SANDBOX_STATUSES
            )
        else:
            snapshot = parse_terminal_snapshot(full)
            if (
                snapshot.get("status") == "running"
                and status not in ACTIVE_SANDBOX_STATUSES
            ):
                snapshot = {**snapshot, "status": "interrupted"}
            last_command = (
                self._storage.record_command_snapshot(
                    sandbox_uid=target.sandbox_uid,
                    snapshot=snapshot,
                    expected_project_id=str(row.get("project_id") or ""),
                )
                if snapshot.get("command_id")
                else None
            )
            last_exit_code, last_command_finished_at, in_flight = (
                parse_terminal_markers(full)
            )
            command_running = in_flight and status in ACTIVE_SANDBOX_STATUSES
        return self._with_runs_nudge(
            view={
                "experiment_id": resolved_experiment_id,
                "sandbox_uid": target.sandbox_uid,
                "sandbox_id": row.get("sandbox_id", ""),
                "status": status,
                "running": status in ACTIVE_SANDBOX_STATUSES,
                "transcript": transcript,
                "cursor": cursor,
                "new_chars": len(transcript) if since is not None else None,
                "last_exit_code": last_exit_code,
                "last_command_finished_at": last_command_finished_at,
                "command_running": command_running,
                "last_command": last_command,
                "command_status_stale": command_status_stale,
            },
            sandbox_uid=target.sandbox_uid,
        )

    def pull_outputs_command(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        sandbox_uid: str | None = None,
        paths: list[str] | None = None,
    ) -> dict[str, Any]:
        """Build an rsync command; bytes and private keys bypass the brain."""
        facts = self.get(
            experiment_id=experiment_id,
            project_id=project_id,
            sandbox_uid=sandbox_uid,
        )
        ssh = facts.get("ssh") or {}
        host = str(ssh.get("host") or "")
        port = int(ssh.get("port") or 0) or 22
        user = str(ssh.get("user") or "")
        remote_dir = str(facts.get("experiment_dir") or "").rstrip("/")
        if facts.get("status") != "running" or not host or not remote_dir:
            return {
                "sandbox_uid": facts.get("sandbox_uid"),
                "experiment_id": facts.get("experiment_id"),
                "project_id": facts.get("project_id"),
                "status": facts.get("status"),
                "rsync": "",
                "hint": (
                    "No running sandbox to pull from. Provision or wait for the "
                    "sandbox to reach status 'running', then re-call."
                ),
            }
        wanted = list(paths) if paths else list(_DEFAULT_PULL_OUTPUTS)
        remote_sources = _pull_output_sources(
            remote_dir=remote_dir,
            user=user,
            host=host,
            paths=wanted,
        )
        rsync = _RSYNC_PULL_OUTPUTS_TEMPLATE.format(
            port=port, remote_sources=" ".join(remote_sources)
        )
        view = {
            "sandbox_uid": facts.get("sandbox_uid"),
            "experiment_id": facts.get("experiment_id"),
            "project_id": facts.get("project_id"),
            "status": "running",
            "experiment_dir": remote_dir,
            "paths": wanted,
            "rsync": rsync,
            "hint": (
                "Run this rsync locally with your own private key: replace "
                "<key_path> with the path to the private key whose public key "
                "you authorized on this sandbox, and <local-destination> with a "
                "local directory. The brain does not run rsync or hold your key; "
                "bytes move directly between your machine and the box. Pull what "
                "you need before sandbox.release."
            ),
        }
        return self._with_runs_nudge(
            view=view, sandbox_uid=str(facts.get("sandbox_uid") or "")
        )

    def runs(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        tenant_id: str | None = None,
        sandbox_uid: str | None = None,
        wait_seconds: int = 0,
        base_url: str = "",
        wait_secret: bytes | None = None,
    ) -> dict[str, Any]:
        # execute_runs deliberately tolerates "experiment has no sandboxes yet"
        # by swallowing the scoped lookup's NotFoundError, which would otherwise
        # also let a foreign experiment_id through and read another project's
        # receipts. Ownership is asserted here instead, as on every other
        # experiment-scoped entry point.
        if experiment_id and self.attachment_check is not None:
            self.attachment_check(attachment_id=experiment_id, project_id=project_id)
        experiment_id = (experiment_id or "").strip()
        sandbox_uid = (sandbox_uid or "").strip()
        if not experiment_id and not sandbox_uid:
            raise ValidationError("sandbox.runs requires experiment_id or sandbox_uid")
        scoped_row: dict[str, Any] | None = None
        try:
            scoped_row = self._storage.fetch_scoped(
                experiment_id=experiment_id,
                project_id=project_id,
                tenant_id=tenant_id,
                sandbox_uid=sandbox_uid or None,
            )
        except NotFoundError:
            if sandbox_uid:
                raise
        wait = min(max(float(wait_seconds or 0), 0.0), RUNS_WAIT_CAP_SECONDS)
        deadline = time.monotonic() + wait
        baseline_finished: set[tuple[str, str]] | None = None
        resolved_project_id = (
            str((scoped_row or {}).get("project_id") or project_id or "") or None
        )
        while True:
            self._observe_run_targets(
                experiment_id=experiment_id,
                sandbox_uid=sandbox_uid,
                project_id=resolved_project_id,
            )
            records = (
                self._runs.records_for_sandbox(sandbox_uid=sandbox_uid)
                if sandbox_uid
                else self._runs.records_for_experiment(experiment_id=experiment_id)
            )
            finished_now = {
                (str(record.get("sandbox_uid") or ""), str(record.get("label") or ""))
                for record in records
                if record.get("exit_code") is not None
            }
            if baseline_finished is None:
                baseline_finished = finished_now
            if (
                finished_now - baseline_finished
                or not any(run_status(record) == "running" for record in records)
                or time.monotonic() >= deadline
            ):
                return run_records_view(
                    records=records,
                    experiment_id=experiment_id,
                    sandbox_uid=sandbox_uid,
                    base_url=base_url,
                    wait_secret=wait_secret,
                )
            time.sleep(
                min(self.runs_wait_poll_seconds, max(deadline - time.monotonic(), 0.1))
            )

    def _observe_run_targets(
        self,
        *,
        experiment_id: str,
        sandbox_uid: str,
        project_id: str | None,
    ) -> None:
        if sandbox_uid:
            try:
                rows = [self._storage.get_by_uid(sandbox_uid=sandbox_uid)]
            except NotFoundError:
                rows = []
        else:
            rows = self._storage.list_for_experiment(
                experiment_id=experiment_id,
                project_id=project_id,
            )
        for row in rows:
            self._observer.observe(row=row, max_age_seconds=self.runs_wait_poll_seconds)

    def observe_run(
        self,
        *,
        sandbox_uid: str,
        max_age_seconds: float,
        acquire_timeout: float | None = None,
    ) -> bool:
        row = self._storage.get_by_uid(sandbox_uid=sandbox_uid)
        return self._observer.observe(
            row=row,
            max_age_seconds=max_age_seconds,
            acquire_timeout=acquire_timeout,
        )

    def run_wait_facts(self, *, sandbox_uid: str, label: str) -> dict[str, Any] | None:
        return self._runs.wait_facts(sandbox_uid=sandbox_uid, label=label)

    def health(self, *, details: bool = False) -> dict[str, Any]:
        health = self._backend.health()
        if details:
            return dict(health)
        result = {"ok": bool(health.get("ok"))}
        if not result["ok"] and health.get("error"):
            result["error"] = health["error"]
        return result

    def snapshot(
        self,
        *,
        experiment_id: str | None = None,
        project_id: str | None = None,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any] | None:
        try:
            row = self._storage.fetch_scoped(
                experiment_id=experiment_id or "",
                project_id=project_id,
                sandbox_uid=sandbox_uid,
            )
        except NotFoundError:
            return None
        return self._canonical_snapshot(row=self._reconcile(row=row))

    def project_signal(self, *, project_id: str) -> str:
        return self._store.project_sandbox_signal(project_id=project_id)

    def sample_metrics(
        self,
        *,
        experiment_id: str,
        project_id: str | None = None,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any]:
        return self._metrics.sample_metrics(
            experiment_id=experiment_id, project_id=project_id, sandbox_uid=sandbox_uid
        )

    def for_experiment(
        self, *, project_id: str, experiment_id: str
    ) -> list[dict[str, Any]]:
        rows = self._storage.list_for_experiment(
            project_id=project_id,
            experiment_id=experiment_id,
        )
        return [self._canonical_snapshot(row=row) for row in rows]

    def for_project(self, *, project_id: str) -> list[dict[str, Any]]:
        rows = self._storage.list_for_project(project_id=project_id)
        return [self._live_snapshot(row=row) for row in rows]

    def reap_expired(self, *, now: datetime | None = None) -> int:
        return self._lifecycle.reap_expired(now=now)

    def reap_idle(
        self,
        *,
        now: datetime | None = None,
        threshold_seconds: float | None = None,
    ) -> int:
        threshold = (
            self._scheduler._idle_reap_threshold()
            if threshold_seconds is None
            else float(threshold_seconds)
        )
        return self._heartbeat.reap_idle(
            now=now,
            threshold_seconds=threshold,
        )

    def reconcile_running_rows(self) -> int:
        left_running = 0
        for row in self._storage.list_running_rows():
            try:
                fresh = self._reconcile(row=row)
            except Exception:
                continue
            if (fresh or {}).get("status") != "running":
                left_running += 1
        return left_running

    def reap_stale_provisions(self, *, now: datetime, deadline_seconds: float) -> int:
        return self._provisioner.reap_stale_provisions(
            now=now, deadline_seconds=deadline_seconds
        )

    def retry_cleanup_pending(self, *, now: datetime | None = None) -> dict[str, Any]:
        return self._lifecycle.retry_cleanup_pending(now=now)

    def has_running_rows(self) -> bool:
        return bool(self._storage.list_running_rows())

    def figure_snapshot(
        self, *, experiment_id: str, project_id: str
    ) -> tuple[dict[str, Any] | None, bool]:
        snapshot = self.snapshot(experiment_id=experiment_id, project_id=project_id)
        if snapshot is None:
            return None, False
        return snapshot, str(snapshot.get("status") or "") in ACTIVE_SANDBOX_STATUSES

    def project_spend(self, *, project_id: str) -> dict[str, Any]:
        return self._quotas.project_spend(project_id=project_id)

    def tenant_generation_counters(self, *, tenant_id: str) -> dict[str, Any]:
        return self._quotas.tenant_generation_counters(tenant_id=tenant_id)


__all__ = ["SandboxEngine"]
