"""Unified brain composition with local and hosted deployment presets.

The composition wires research records and workflow to the independent
merv-sandboxes HTTP service for compute and ML data, and Merv's R2 store for
research evidence. Hosted control requires Postgres and service authentication.
Checkout I/O never runs here; agents move bounded bytes through
token-authenticated upload routes, and the brain never dials a user machine.
"""

from __future__ import annotations

from ..workflows import Workflows

import logging
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from ..application import Application, LogicGraphQuery, research_effects
from ..programs import INSTALLED, PROGRAM
from ..application.maintenance import CleanupService
from .workflow_knowledge import WorkflowKnowledge
from ..agent_sessions import WorkspaceAdvances, AgentSessions
from ..artifacts import Artifacts
from ..feed import FeedService
from ..literature import Literature
from ..research_core import (
    ACTIVITY_VOCABULARY,
    ENTITY_REF_VOCABULARY,
    RESOLVERS,
    FEED_ADOPTABLE_ROLES,
    FEED_AUTHOR_ROLES,
    Research,
    ResearchArtifacts,
    ResearchObjects,
)
from .config import (
    ALLOWED_ORIGINS_ENV_VAR,
    CONTROL_RESTRICT_CORS_ENV_VAR,
    DB_URL_ENV_VAR,
    build_blob_store,
    build_state_store,
    REQUIRE_SANDBOX_BACKEND_ENV_VAR,
    resolve_db_url,
    resolve_allowed_origins,
    resolve_oauth_resource_uri,
    sandbox_feature_enabled,
    resolve_storage_max_upload_bytes,
    resolve_ui_base_url,
)
from .brain_dirs import resolve_brain_state_root, resolve_local_brain_staging
from ..kernel.env import env_bool, env_value
from ..kernel.ports.blob_store import BlobStore, EvidenceBlobStore
from ..kernel.state import BaseStateStore
from ..kernel.retention import Retention
from ..kernel.state.activity import error_head, register_activity_vocabulary
from ..kernel.state.tool_call_ledger import (
    ToolCallLedger,
    configured_retention_days,
)
from ..kernel.state.tool_call_payloads import ToolCallPayloadStore
from ..kernel.utils import ValidationError
from ..infrastructure.client import build_infrastructure_client
from ..infrastructure import RemoteObjects, RemoteProviders, RemoteSandboxes
from ..infrastructure.objects import DEFAULT_MAX_UPLOAD_BYTES
from .agent_identity import AGENT_IDENTITY_SCHEMA, AgentIdentities, resolve_agent_identity_mode
from .artifacts import ArtifactTools
from .auth import SupabaseVerifier
from .oauth import OAuthService
from .oauth_store import OAUTH_SCHEMA, SqlOAuthRepository
from .project_keys import PROJECT_KEY_SCHEMA, ProjectKeys
from .runner_pairing import RunnerPairings
from .telemetry import ControlActivitySink, StructuredLogger
from .tools.contracts import TOOL_MANIFEST, available_tool_names
from .tools.dispatcher import ToolDispatcher
from .transport.api import create_fastapi_app
from .transport.http_policy import HttpSurfacePolicy
from .web_preview import AllowlistedPaperPreview, NetworkWebPreview


class Surface:
    """One composed product surface shared by HTTP, MCP, and local delivery."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        blobs: EvidenceBlobStore,
        infrastructure_client: Any | None = None,
        sandbox_enabled: bool = True,
        storage_enabled: bool = False,
        storage_max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
        structured_logging: bool = False,
        agent_identity_mode: str = "required",
    ) -> None:
        self._store = store
        self._blobs = blobs
        # Kernel installed its own tables when the store opened. Credentials
        # and OAuth have no constructed owner here — they exist only in hosted
        # mode — so their schema installs from composition. Every other
        # component installs its own as it is built.
        for schema in (PROJECT_KEY_SCHEMA, OAUTH_SCHEMA):
            store.install(schema)
        self.sandbox_enabled = sandbox_enabled
        # Every owner names its own argument fields for the shared log; the
        # kernel shapes them without knowing what any of them mean.
        register_activity_vocabulary(**ACTIVITY_VOCABULARY)
        self.activity = ControlActivitySink()
        # Agent-attributed request/response records ride the same blob store
        # as Artifacts and Feed bytes (disk or bucket, never RAM), and expire on
        # the ledger's horizon.
        self.tool_payloads = ToolCallPayloadStore(
            blobs=blobs, retention_days=configured_retention_days()
        )
        self.tool_ledger = ToolCallLedger(
            store=store, on_failure=self._ledger_dropped, payloads=self.tool_payloads
        )
        # One clock for every owner's sweep. Owners register as they are
        # built, here and in hosted composition; the loop reads the registry
        # each tick, so a late arrival still gets swept.
        self.retention = Retention(on_error=self._sink_failed)
        self.retention.add("tool_calls", self.tool_ledger.prune)
        self.retention.start()
        self.agent_identities = AgentIdentities(
            store=store, mode=agent_identity_mode, payloads=self.tool_payloads
        )
        self.structured_log = StructuredLogger(enabled=structured_logging)

        self.artifact_store = Artifacts(store=store, blobs=blobs)
        self.artifacts = ResearchArtifacts(store=store, artifacts=self.artifact_store)
        self.workflows = Workflows(store=store, programs=INSTALLED, knowledge=lambda snapshot, conn: WorkflowKnowledge(
            snapshot=snapshot, conn=conn, artifacts=self.artifact_store, project=self.research.get_project,
            review=self.research.reviews.read_fact))
        self.research = Research(store=store, advances=WorkspaceAdvances(store=store), artifacts=self.artifacts,
                                 workflows=self.workflows, program=PROGRAM)
        self.research.initialize_workflows()
        self.feed = FeedService(
            store=store,
            blobs=blobs,
            web_preview=NetworkWebPreview(),
            ref_vocabulary=ENTITY_REF_VOCABULARY,
            author_roles=FEED_AUTHOR_ROLES,
            adoptable_roles=FEED_ADOPTABLE_ROLES,
            figure_lookup=self._figure_exists,
        )
        self.literature = Literature(store=store, unfurl=AllowlistedPaperPreview())
        # The logic-graph read the experiment and reflection routes both
        # render; it joins Research facts with the pinned graph bytes and
        # belongs to neither router.
        self.logic_graphs = LogicGraphQuery(research=self.research, artifacts=self.artifacts)
        # Leases learn whether their instance still stands from the workflow
        # runtime's facts; Agent Sessions never reads a research record.
        self.agent_sessions = AgentSessions(store=store, facts=self.workflows.runtime)
        self.retention.add("agent_sessions", self.agent_sessions.prune)
        self.retention.add("feed", self.feed.prune)
        self.retention.add("artifacts", self.artifact_store.prune)
        self.artifact_tools = ArtifactTools(artifacts=self.artifacts)
        self.infrastructure_client = infrastructure_client
        self.sandbox_providers = RemoteProviders(store=store, client=infrastructure_client)
        self.sandboxes = RemoteSandboxes(
            store=store, client=infrastructure_client if sandbox_enabled else None,
            # Sandboxes names the thing it is attached to neutrally; only this
            # root knows the attachment is an experiment.
            attachment_check=lambda *, attachment_id, project_id: (
                self.research.experiments.assert_in_project(
                    experiment_id=attachment_id, project_id=project_id)),
        )
        # Heavy objects live in merv-sandboxes; Research records which
        # experiment produced each one through the facade's lifecycle hook.
        self.research_objects = ResearchObjects(store=store)
        objects = RemoteObjects(
            client=infrastructure_client if storage_enabled else None,
            store=store,
            lifecycle=self.research_objects,
            max_upload_bytes=storage_max_upload_bytes,
        )
        self.storage = objects if objects.enabled else None
        # Installing a program means serving every effect it emits and resolving
        # every requirement class it declares; a half-installed one starts nothing.
        effects = research_effects(research=self.research, sessions=self.agent_sessions)
        for program in INSTALLED:
            missing = ([name for name in program.effects if name not in effects]
                       + [need.__name__ for need in program.requirements if need not in RESOLVERS])
            if missing:
                raise ValidationError(f"program {program.name!r} is not installable: {missing}")
        self.application = Application(
            effects=effects,
            research=self.research,
            sandboxes=self.sandboxes,
            objects=objects,
            produced_objects=self.research_objects,
            artifacts=self.artifacts,
            feed=self.feed,
            agent_sessions=self.agent_sessions,
        )
        # The runner's central-advance routes call this Protocol; Application
        # keeps the research meaning of an advance behind these method names.
        self.agent_advances = self.application

        tool_names = available_tool_names(
            storage_enabled=objects.enabled,
            sandbox_enabled=sandbox_enabled,
        )
        tool_owners = {
            "agents": self.agent_identities,
            "application": self.application,
            "research": self.research,
            "reviews": self.research.reviews,
            "workflows": self.research.workflows,
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
            ledger=self.tool_ledger,
            tool_names=tool_names,
        )

    def _figure_exists(self, project_id: str, artifact_id: str, path: str) -> bool:
        """A research-visible artifact (by association id) whose attachment is
        recorded under its content id: two row reads, never the bytes."""
        found = self.artifacts.get(artifact_ids=(artifact_id,), project_id=project_id)
        return bool(found) and self.artifact_store.has_figure(
            project_id=found[0].project_id, artifact_id=found[0].artifact_id, link_path=path
        )

    def _ledger_dropped(self, error: str) -> None:
        self._sink_failed("tool_calls", error)

    def _sink_failed(self, name: str, error: object) -> None:
        """Announce work one sink could not do; never raise into its caller."""
        with suppress(Exception):
            self.activity.emit(
                event_type="telemetry.dropped",
                payload={"sink": name, "status": "error", "error": error_head(error=str(error))},
            )

    def shutdown(self) -> None:
        self.application.workflow_deliveries.stop()
        self.retention.stop()
        if self.infrastructure_client is not None:
            with suppress(Exception):
                self.infrastructure_client.close()
        with suppress(Exception):
            self.tool_ledger.close()


CONTROL_COMPAT_REPO_ROOT = Path("/var/empty/merv-control")
LOCAL_BRAIN_STATE_DIR_ENV_VAR = "MERV_LOCAL_STATE_DIR"
LOGGER = logging.getLogger(__name__)


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
        # Research metadata cleanup is operator-triggered. The infrastructure
        # service independently schedules sandbox and physical object cleanup.
        self.cleanup = cleanup
        self.fastapi_app = fastapi_app

    def shutdown(self) -> None:
        self.app.shutdown()


def build_control_app(
    *,
    repo_root: Path | None = None,
    env: Mapping[str, str] | None = None,
    infrastructure_client: Any | None = None,
    store: Any | None = None,
    blobs: BlobStore | None = None,
    storage_enabled: bool | None = None,
    local_deployment: bool = False,
) -> Surface:
    """Build the unified brain app.

    ``repo_root`` is an explicit dev/test staging dir for SQLite/blob defaults;
    production omits it and must provide DB_URL and the infrastructure service
    URL plus delegated-auth signing key. The compatibility ``repo_root`` on that production path is
    a stable sentinel, not a created checkout or temp dir. ``infrastructure_client``
    lets tests inject a deterministic implementation of the remote API;
    ``storage_enabled`` defaults to whether that service connection exists.
    """
    staging = _control_repo_root(
        repo_root=repo_root, env=env, local_deployment=local_deployment
    )
    # De-nested for fresh roots; a legacy nested `.research_plugin/` layout
    # keeps every path verbatim forever (see brain_dirs).
    state_root = resolve_brain_state_root(staging)
    db_path = state_root / "state.sqlite"
    store = store if store is not None else build_state_store(db_path=db_path, env=env)
    infrastructure_client = infrastructure_client or build_infrastructure_client(env)
    blobs = (
        blobs
        if blobs is not None
        else build_blob_store(default_root=state_root / "blobs", env=env)
    )
    sandbox_enabled = sandbox_feature_enabled(env) and infrastructure_client is not None
    # Heavy objects need the same service connection the sandboxes use.
    if storage_enabled is None:
        storage_enabled = infrastructure_client is not None
    storage_enabled = bool(storage_enabled) and infrastructure_client is not None
    app = Surface(
        store=store, blobs=blobs,
        infrastructure_client=infrastructure_client,
        sandbox_enabled=sandbox_enabled,
        storage_enabled=storage_enabled,
        storage_max_upload_bytes=resolve_storage_max_upload_bytes(env),
        structured_logging=not local_deployment,
        agent_identity_mode=resolve_agent_identity_mode(env),
    )
    if sandbox_enabled and env_bool(REQUIRE_SANDBOX_BACKEND_ENV_VAR, False, env=env):
        health = app.sandboxes.health()
        if not health.get("ok"):
            app.shutdown()
            raise ValidationError("merv-sandboxes failed the required startup health check")
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
        tool_call_ledger=app.tool_ledger,
        oauth_clients=oauth_repository,
        agent_sessions=app.agent_sessions,
    )
    project_keys = ProjectKeys(store=app._store)
    # The two credential tables only exist in hosted composition, so they join
    # the clock here rather than in __init__; it has been running since then.
    app.retention.add("oauth", oauth_repository.prune)
    app.retention.add("project_keys", project_keys.prune)
    # Device-code pairing registers runner-generated key digests; it exists
    # exactly where owner key management exists (hosted auth), so the loopback
    # brain, which needs no runner credential, never mounts it.
    runner_pairings = RunnerPairings(store=app._store, project_keys=project_keys)
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
        surface_policy=surface,
        auth=auth,
        user_directory=auth if auth is not None and auth.service_key else None,
        oauth_service=oauth_service,
        ui_base_url=resolve_ui_base_url(env),
        oauth_resource_uri=oauth_resource_uri,
        env=env,
        runner_pairings=runner_pairings,
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
    infrastructure_client: Any | None = None,
    store: Any | None = None,
    blobs: BlobStore | None = None,
    storage_enabled: bool | None = None,
) -> ControlPlaneServer:
    """Build the localhost brain using the same Surface composition."""
    root = _local_brain_root(state_dir=state_dir, env=env)
    app = build_control_app(
        repo_root=root,
        env=env,
        infrastructure_client=infrastructure_client,
        store=store,
        blobs=blobs,
        storage_enabled=storage_enabled,
        local_deployment=True,
    )
    cleanup = CleanupService(
        tool_call_ledger=app.tool_ledger,
        agent_sessions=app.agent_sessions,
    )
    fastapi_app = create_fastapi_app(
        app=app,
        allowed_origins=allowed_origins or [],
        cleanup=cleanup,
        surface_policy=_local_http_surface(),
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
    for key in ("MERV_SANDBOXES_URL", "MERV_SANDBOXES_CONNECTIONS_FILE"):
        if not env_value(key, env=env):
            missing.append(key)
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
    return HttpSurfacePolicy(
        restrict_cors=env_bool(CONTROL_RESTRICT_CORS_ENV_VAR, True, env=env),
        hosted_control=True,
    )


def _local_http_surface() -> HttpSurfacePolicy:
    return HttpSurfacePolicy(
        restrict_cors=False,
        hosted_control=False,
    )
