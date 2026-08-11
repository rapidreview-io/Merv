"""Unified brain composition with local and hosted deployment presets.

The composition wires records, workflow, reviews, blobs, quotas, and
sandbox lifecycle. Hosted/no-checkout control requires Postgres, a durable blob
store, and mounted management keys; local deployment selects SQLite and local
adapters. Checkout I/O never runs here; agents move bounded bytes through
token-authenticated upload routes, and the brain never dials a user machine.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from merv.shared.storage_guidance import STORAGE_RULE_OF_THUMB

from ..application import Application
from ..application.maintenance import CleanupService
from ..agent_sessions import AgentSessions
from ..artifacts import Artifacts
from ..feed import FeedService
from ..literature import Literature
from ..research_core import (
    EXPERIMENT_TERMINAL_STATUSES,
    Research,
    ResearchTargets,
)
from .config import (
    ALLOWED_ORIGINS_ENV_VAR,
    BLOB_BUCKET_ENV_VAR,
    CONTROL_RESTRICT_CORS_ENV_VAR,
    DB_URL_ENV_VAR,
    MGMT_KEY_PATH_ENV_VAR,
    build_blob_store,
    build_object_store,
    build_state_store,
    REQUIRE_SANDBOX_BACKEND_ENV_VAR,
    resolve_blob_bucket,
    resolve_db_url,
    resolve_allowed_origins,
    resolve_mgmt_key_path,
    resolve_mgmt_public_key,
    resolve_oauth_resource_uri,
    sandbox_feature_enabled,
    resolve_storage_max_upload_bytes,
    resolve_ui_base_url,
)
from .brain_dirs import resolve_brain_state_root, resolve_local_brain_staging
from ..kernel.env import env_bool, env_value
from ..kernel.ports.blob_store import BlobStore, EvidenceBlobStore
from ..kernel.ports.mgmt_keys import MgmtKeyStore
from ..kernel.secret_tokens import load_wait_secret
from ..kernel.state import BaseStateStore
from ..kernel.state.tool_call_ledger import ToolCallLedger
from ..kernel.utils import ValidationError
from ..object_storage import ObjectStorage
from ..sandbox import DisabledSandboxBackend, SandboxBackend, SandboxEngine
from ..sandbox.adapters import (
    CONNECTABLE_PROVIDERS,
    CREDENTIAL_CHECKS,
    build_sandbox_backend,
    configured_backend_names,
)
from ..sandbox.keys import LocalMgmtKeyStore, MountedMgmtKeyStore
from .artifacts import ArtifactTools
from .auth import SupabaseVerifier
from .oauth import OAuthService
from .oauth_store import SqlOAuthRepository
from .project_keys import ProjectKeys
from .telemetry import ControlActivitySink, ControlToolCallSink, StructuredLogger
from .tools.contracts import TOOL_MANIFEST, available_tool_names
from .tools.dispatcher import ToolDispatcher
from .transport.api import create_fastapi_app
from .transport.http_policy import HttpSurfacePolicy
from .sandbox_providers import SandboxProviderSettings
from .user_settings import UserHfTokenSettings
from .web_preview import AllowlistedPaperPreview, NetworkWebPreview


class Surface:
    """One composed product surface shared by HTTP, MCP, and local delivery."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        blobs: EvidenceBlobStore,
        storage: ObjectStorage,
        execution_backend: SandboxBackend,
        mgmt_keys: MgmtKeyStore,
        mlflow_tracking: Any | None = None,
        sandbox_enabled: bool = True,
        force_expiry_reaper: bool = False,
        structured_logging: bool = False,
    ) -> None:
        self._store = store
        self._blobs = blobs
        self._tracking = mlflow_tracking
        self.sandbox_enabled = sandbox_enabled
        self.storage = storage if storage.enabled else None
        self.activity = ControlActivitySink()
        self.tool_calls = ControlToolCallSink()
        self.tool_ledger = ToolCallLedger(store=store, on_failure=self._ledger_dropped)
        self.tool_ledger.start_retention()
        self.structured_log = StructuredLogger(enabled=structured_logging)

        self.artifacts = Artifacts(
            store=store,
            blobs=blobs,
            targets=ResearchTargets(),
        )
        self.research = Research(store=store, artifacts=self.artifacts)
        self.feed = FeedService(
            store=store,
            blobs=blobs,
            web_preview=NetworkWebPreview(),
        )
        self.literature = Literature(store=store, unfurl=AllowlistedPaperPreview())
        self.agent_sessions = AgentSessions(
            store=store,
            terminal_experiment_statuses=EXPERIMENT_TERMINAL_STATUSES,
        )
        self.artifact_tools = ArtifactTools(artifacts=self.artifacts)
        self.sandbox_providers = SandboxProviderSettings(
            store=store,
            fleet=configured_backend_names,
            catalog=CONNECTABLE_PROVIDERS,
            checks=CREDENTIAL_CHECKS,
        )
        self.sandboxes = SandboxEngine(
            store=store,
            backend=execution_backend,
            mgmt_keys=mgmt_keys,
            force_expiry_reaper=force_expiry_reaper,
            storage_enabled=storage.enabled,
            storage_hint=STORAGE_RULE_OF_THUMB,
            attachment_check=self.research.assert_experiment_in_project,
            provider_admission=self.sandbox_providers.ensure_provider_allowed,
        )
        if sandbox_enabled:
            self.sandboxes.start()
        self.application = Application(
            research=self.research,
            sandboxes=self.sandboxes,
            objects=storage,
            artifacts=self.artifacts,
            feed=self.feed,
            agent_sessions=self.agent_sessions,
            tracking=mlflow_tracking,
        )
        self.user_settings = UserHfTokenSettings(store=store)

        tool_names = available_tool_names(
            storage_enabled=storage.enabled,
            tracking_enabled=mlflow_tracking is not None,
            sandbox_enabled=sandbox_enabled,
        )
        tool_owners = {
            "application": self.application,
            "research": self.research,
            "artifact_submissions": self.artifact_tools,
            "sandboxes": self.sandboxes,
            "feed": self.feed,
            "litreview": self.literature,
        }
        if self.storage is not None:
            tool_owners["storage"] = self.storage
        self.tools = ToolDispatcher(
            handlers={
                name: getattr(tool_owners[root], method)
                for name, tool in TOOL_MANIFEST.items()
                if name in tool_names
                for root, method in (tool.handler_identity.split(".", 1),)
            },
            activity=self.activity,
            tool_calls=self.tool_calls,
            ledger=self.tool_ledger,
            tool_names=tool_names,
        )

    def _ledger_dropped(self, error: str) -> None:
        with suppress(Exception):
            self.activity.emit(
                event_type="telemetry.dropped",
                payload={"sink": "tool_calls", "status": "error", "error": error},
            )

    def shutdown(self) -> None:
        with suppress(Exception):
            self.sandboxes.shutdown()
        with suppress(Exception):
            self.tool_ledger.close()


CONTROL_COMPAT_REPO_ROOT = Path("/var/empty/merv-control")
LOCAL_BRAIN_STATE_DIR_ENV_VAR = "MERV_LOCAL_STATE_DIR"
LOGGER = logging.getLogger(__name__)
_UNSET = object()


class ControlPlaneServer:
    """A running brain app plus its FastAPI surface.

    Holds the record/policy app, cleanup service, and FastAPI app that serves
    ``/mcp/*`` and ``/api/*``. Both deployment presets use it. ``fastapi_app``
    is what uvicorn serves.
    """

    def __init__(
        self,
        *,
        app: Surface,
        cleanup: CleanupService,
        fastapi_app: FastAPI,
    ) -> None:
        self.app = app
        # Broader cleanup sweeps are built but NOT scheduled here — a managed
        # cron or sidecar tick calls ``cleanup.run_all(now=...)``. The owned
        # expiry reaper lives in the composition-owned SandboxEngine, and
        # tool-call retention rides its tick, so the one horizon that must hold
        # without an operator does not depend on that cron existing.
        self.cleanup = cleanup
        self.fastapi_app = fastapi_app

    def shutdown(self) -> None:
        self.app.shutdown()


def build_control_app(
    *,
    repo_root: Path | None = None,
    env: Mapping[str, str] | None = None,
    execution_backend: Any | None = None,
    store: Any | None = None,
    blobs: BlobStore | None = None,
    storage: Any = _UNSET,
    mgmt_keys: Any | None = None,
    mlflow_tracking: Any | None = None,
    local_deployment: bool = False,
) -> Surface:
    """Build the unified brain app.

    ``repo_root`` is an explicit dev/test staging dir for SQLite/blob defaults;
    production omits it and must provide DB_URL + BLOB_BUCKET + a mounted
    management key. The compatibility ``repo_root`` on that production path is
    a stable sentinel, not a created checkout or temp dir. ``execution_backend``
    lets the crash-recovery test inject a reaper-capable fake backend.
    """
    staging = _control_repo_root(
        repo_root=repo_root, env=env, local_deployment=local_deployment
    )
    # De-nested for fresh roots; a legacy nested `.research_plugin/` layout
    # keeps every path verbatim forever (see brain_dirs).
    state_root = resolve_brain_state_root(staging)
    db_path = state_root / "state.sqlite"
    store = store if store is not None else build_state_store(db_path=db_path, env=env)
    blobs = (
        blobs
        if blobs is not None
        else build_blob_store(default_root=state_root / "blobs", env=env)
    )
    if storage is _UNSET:
        storage = ObjectStorage(
            store=store,
            provider=build_object_store(default_root=state_root, env=env),
            max_upload_bytes=resolve_storage_max_upload_bytes(env),
        )
    elif storage is None:
        storage = ObjectStorage(store=store, provider=None)
    sandbox_enabled = sandbox_feature_enabled(env)
    if not sandbox_enabled:
        execution_backend = DisabledSandboxBackend()
    elif execution_backend is None:
        execution_backend = build_sandbox_backend(repo_root=staging)
    if sandbox_enabled:
        _validate_sandbox_backend_requirement(
            execution_backend=execution_backend, env=env
        )
    app = Surface(
        store=store,
        blobs=blobs,
        storage=storage,
        execution_backend=execution_backend,
        mgmt_keys=(
            mgmt_keys
            if mgmt_keys is not None
            else _build_mgmt_key_store(
                env=env,
                local_root=staging if local_deployment else None,
            )
        ),
        mlflow_tracking=mlflow_tracking,
        sandbox_enabled=sandbox_enabled,
        # The brain holds provider lifecycle responsibility, so this composition
        # forces the expiry reaper on in both deployment presets.
        force_expiry_reaper=True,
        structured_logging=not local_deployment,
    )
    # A brain restart with live VMs must re-acquire reaping. Surface has
    # already started its SandboxEngine; this reconciles rows left running.
    _resume_active_sandboxes(app=app)
    return app


def build_control_server(
    *,
    repo_root: Path | None = None,
    env: Mapping[str, str] | None = None,
    allowed_origins: list[str] | None = None,
) -> ControlPlaneServer:
    """Build the hosted-control FastAPI brain."""
    app = build_control_app(repo_root=repo_root, env=env)
    origins = (
        resolve_allowed_origins(env) if allowed_origins is None else allowed_origins
    )
    surface = _control_http_surface(env=env)
    if surface.restrict_cors and not origins:
        LOGGER.warning(
            "%s is empty; browser clients will be blocked by hosted-control CORS",
            ALLOWED_ORIGINS_ENV_VAR,
        )
    oauth_repository = SqlOAuthRepository(store=app._store, env=env)
    cleanup = CleanupService(
        sandboxes=app.sandboxes,
        blobs=app._blobs,
        storage=app.storage,
        tool_call_ledger=app.tool_ledger,
        oauth_clients=oauth_repository,
        agent_sessions=app.agent_sessions,
    )
    project_keys = ProjectKeys(store=app._store)
    # The fail-closed/open decision (SEC-02) is NOT taken here: it lives in
    # create_fastapi_app, where a hosted-policy app is actually composed, so no
    # composition path can reach an open hosted surface by skipping this
    # builder. Passing `env` below is what carries the operator's answer.
    auth = SupabaseVerifier.from_env(env, project_keys=project_keys)
    oauth_resource_uri = resolve_oauth_resource_uri(env)
    # OAuth needs a verifier (browser Supabase sessions drive consent) and the
    # canonical /mcp resource URI; without either it is not mounted and cloud
    # agents authenticate with directly minted mk_ keys only.
    oauth_service = (
        OAuthService(
            repository=oauth_repository,
            project_keys=project_keys,
            is_project_member=app.research.is_project_member,
        )
        if auth is not None and oauth_resource_uri
        else None
    )
    fastapi_app = create_fastapi_app(
        app=app,
        allowed_origins=origins,
        cleanup=cleanup,
        tenant_counters=app.application.tenant_counters,
        surface_policy=surface,
        auth=auth,
        user_directory=auth if auth is not None and auth.service_key else None,
        oauth_service=oauth_service,
        ui_base_url=resolve_ui_base_url(env),
        oauth_resource_uri=oauth_resource_uri,
        # Hosted state lives outside this container and its state root is the
        # /var/empty sentinel, so the run-wait key must arrive as configuration:
        # a generated one would die with the process and every URL already
        # handed to an agent would stop verifying.
        wait_secret=load_wait_secret(env=env, require_env=True),
        env=env,
    )
    return ControlPlaneServer(
        app=app,
        cleanup=cleanup,
        fastapi_app=fastapi_app,
    )


def build_local_server(
    *,
    state_dir: Path | None = None,
    env: Mapping[str, str] | None = None,
    allowed_origins: list[str] | None = None,
    execution_backend: Any | None = None,
    store: Any | None = None,
    blobs: BlobStore | None = None,
    storage: Any = _UNSET,
    mgmt_keys: Any | None = None,
    mlflow_tracking: Any | None = None,
) -> ControlPlaneServer:
    """Build the localhost brain using the same Surface composition."""
    root = _local_brain_root(state_dir=state_dir, env=env)
    app = build_control_app(
        repo_root=root,
        env=env,
        execution_backend=execution_backend,
        store=store,
        blobs=blobs,
        storage=storage,
        mgmt_keys=mgmt_keys,
        mlflow_tracking=mlflow_tracking,
        local_deployment=True,
    )
    cleanup = CleanupService(
        sandboxes=app.sandboxes,
        blobs=app._blobs,
        storage=app.storage,
        tool_call_ledger=app.tool_ledger,
        agent_sessions=app.agent_sessions,
    )
    fastapi_app = create_fastapi_app(
        app=app,
        allowed_origins=allowed_origins or [],
        cleanup=cleanup,
        tenant_counters=app.application.tenant_counters,
        surface_policy=_local_http_surface(),
        # Generated once into the writable state root this deployment already
        # owns, so wait URLs minted before a restart still verify after one.
        wait_secret=load_wait_secret(
            env=env, state_root=resolve_brain_state_root(root)
        ),
    )
    return ControlPlaneServer(
        app=app,
        cleanup=cleanup,
        fastapi_app=fastapi_app,
    )


def _control_repo_root(
    *,
    repo_root: Path | None,
    env: Mapping[str, str] | None = None,
    local_deployment: bool = False,
) -> Path:
    if repo_root is not None:
        return repo_root
    if local_deployment:
        return _local_brain_root(state_dir=None, env=env)
    missing = []
    if not resolve_db_url(env):
        missing.append(DB_URL_ENV_VAR)
    if not resolve_blob_bucket(env):
        missing.append(BLOB_BUCKET_ENV_VAR)
    if not resolve_mgmt_key_path(env):
        missing.append(MGMT_KEY_PATH_ENV_VAR)
    if missing:
        raise ValidationError(
            "control mode without repo_root requires durable control-plane "
            f"configuration: {', '.join(missing)}",
            details={"missing": missing},
        )
    return CONTROL_COMPAT_REPO_ROOT


def _local_brain_root(
    *, state_dir: Path | None, env: Mapping[str, str] | None = None
) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    raw = env_value(LOCAL_BRAIN_STATE_DIR_ENV_VAR, env=env)
    if raw:
        return Path(raw).expanduser().resolve()
    return resolve_local_brain_staging().expanduser().resolve()


def _control_http_surface(*, env: Mapping[str, str] | None = None) -> HttpSurfacePolicy:
    return HttpSurfacePolicy.for_surface(
        restrict_cors=env_bool(CONTROL_RESTRICT_CORS_ENV_VAR, True, env=env),
        hosted_control=True,
    )


def _local_http_surface() -> HttpSurfacePolicy:
    return HttpSurfacePolicy.for_surface(
        restrict_cors=False,
        hosted_control=False,
    )


def _build_mgmt_key_store(
    *,
    env: Mapping[str, str] | None = None,
    local_root: Path | None = None,
):
    if local_root is not None:
        return LocalMgmtKeyStore(
            root=resolve_brain_state_root(local_root) / "mgmt_keys"
        )
    key_path = resolve_mgmt_key_path(env)
    public_key = resolve_mgmt_public_key(env)
    if not key_path:
        raise ValidationError(
            f"{MGMT_KEY_PATH_ENV_VAR} is required in control mode; "
            "mount an externally managed management key"
        )
    return MountedMgmtKeyStore(
        private_key_path=Path(key_path),
        public_key=public_key,
    )


def _validate_sandbox_backend_requirement(
    *,
    execution_backend: Any,
    env: Mapping[str, str] | None = None,
) -> None:
    if not env_bool(REQUIRE_SANDBOX_BACKEND_ENV_VAR, False, env=env):
        return
    health = dict(execution_backend.health())
    if health.get("ok"):
        return
    backend = str(
        health.get("backend")
        or health.get("name")
        or health.get("provider")
        or "unknown"
    )
    error = str(health.get("error") or "sandbox backend health check failed")
    raise ValidationError(
        f"{REQUIRE_SANDBOX_BACKEND_ENV_VAR}=1 requires a healthy sandbox backend "
        f"before control startup; {backend} reported: {error}",
        details={"backend": backend, "error": error},
    )


def _resume_active_sandboxes(*, app: Surface) -> None:
    """Reconcile rows left running/provisioning after a control restart.

    The reaper thread is already running (Surface started SandboxEngine);
    a one-shot reconcile pass on startup makes the resumed reaper truthful
    about rows that may have expired while the control plane was down.
    Best-effort — a reconcile failure must not block startup or the reaper.
    """
    if not app.sandbox_enabled:
        return
    with suppress(Exception):  # startup must not hinge on recovery
        had_running = app.sandboxes.has_running_rows()
        app.sandboxes.reconcile_running_rows()
        if had_running:
            # Kick the resumed reaper once so anything already past its deadline
            # is reaped promptly instead of waiting a full interval. Off-thread:
            # startup must not block on cleanup. The composition-started runtime
            # reaper also catches it on its next tick.
            import threading

            threading.Thread(
                target=_safe_reap,
                args=(app,),
                name="control-recovery-reap",
                daemon=True,
            ).start()


def _safe_reap(app: Surface) -> None:
    with suppress(Exception):  # the reaper must never die
        app.sandboxes.reap_expired()
