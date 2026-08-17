"""Authentication, authorization, and tool invocation for the HTTP surface."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError as PydanticValidationError

from ....kernel.env import mlflow_suspended
from ....kernel.request_context import bind_agent
from ....agent_sessions import AGENT_SESSION_SECRET_PREFIX, AgentSessions
from ....kernel.utils import (
    NotFoundError,
    ResearchPluginError,
    ValidationError,
)
from ....kernel.version import CLIENT_VERSION_HEADER, MIN_PROXY_VERSION, is_below_floor
from ...agent_identity import HELLO_TOOL, AgentIdentities, CallerFacts
from ...auth import UnauthorizedError
from ...identity import (
    AgentSessionScopeError,
    LOCAL_PRINCIPAL,
    Principal,
    ProjectKeyScopeError,
    is_external_key,
    is_local_principal,
    principal_label,
)
from ...tools.contracts import TOOL_MANIFEST
from ...tools.dispatcher import ToolDispatcher
from ....research_core import Research
from ....sandbox import SandboxEngine
from ..http_policy import (
    AGENT_CONSOLIDATION_SESSION_TOOLS,
    AGENT_EXPERIMENT_SESSION_TOOLS,
    AGENT_REVIEW_SESSION_TOOLS,
    HOSTED_CONTROL_TOOL_POLICIES,
    HttpSurfacePolicy,
)
from .shared import (
    CallLedger,
    GLOBAL_MUTATOR_PREFIXES,
    RefusalLedger,
    bind_request_principal,
    is_local_origin,
    ledger_direct_call,
    ledger_refusal,
    ledger_tool_refusal,
    open_hosted_operator_denial,
    operator_denial,
    operator_membership_recovery,
)
from .views import present
from . import oauth, project_keys, runner_pairing
from ...runner_pairing import RunnerPairings


@dataclass(frozen=True)
class RequestAuthenticator:
    """Resolve a request principal without coupling the factory to a verifier."""

    surface: HttpSurfacePolicy
    verifier: Any | None = None
    agent_sessions: AgentSessions | None = None
    # Phase B: OAuth routes are auth-exempt; audience-bound bearers are /mcp-only.
    oauth_enabled: bool = False
    canonical_mcp_resource: str = ""

    def authenticate(self, request: Request) -> JSONResponse | None:
        if request.method == "OPTIONS":
            return None
        request.state.principal = LOCAL_PRINCIPAL
        request.state.authenticated = False
        path = request.url.path
        # Token-bearer routes carry their own credential (INV-12), /wait/ too.
        # Runner pairing is unauthenticated by construction: the runner has no
        # credential yet, and it polls with the device code it alone holds.
        exempt = (
            "/api/artifacts/u/",
            "/api/artifacts/f/",
            "/api/feed/u/",
            "/api/storage/u/",
            "/wait/",
            runner_pairing.PAIRING_PUBLIC_PREFIX,
        )
        if (
            path in ("/health", "/api/meta", "/internal/auth/mlflow")
            or path.startswith(exempt)
            or oauth.public_request(request, enabled=self.oauth_enabled)
        ):
            return None
        client_version = request.headers.get(CLIENT_VERSION_HEADER)
        if (
            self.surface.hosted_control
            and client_version
            and is_below_floor(client_version=client_version, floor=MIN_PROXY_VERSION)
        ):
            return JSONResponse(
                {
                    "detail": f"client version {client_version} is below the minimum "
                    f"supported {MIN_PROXY_VERSION}; upgrade the merv client "
                    "(pip install -U merv) and reconnect",
                    "error_code": "client_too_old",
                    "min_version": MIN_PROXY_VERSION,
                    "client_version": client_version,
                },
                status_code=426,
            )
        authorization = request.headers.get("Authorization")
        token = (
            authorization[len("Bearer ") :].strip()
            if authorization and authorization.startswith("Bearer ")
            else ""
        )
        if token.startswith(AGENT_SESSION_SECRET_PREFIX):
            record = (
                None
                if self.agent_sessions is None
                else self.agent_sessions.authenticate(session_secret=token)
            )
            if record is None:
                return oauth.bearer_denial(
                    request,
                    message="unknown, expired, or released agent session",
                    enabled=self.oauth_enabled,
                    session_denial=None,
                )
            source_key_id = str(record.get("source_key_id") or "")
            source_key = None
            if source_key_id:
                key_control = getattr(self.verifier, "project_keys", None)
                source_key = (
                    None
                    if key_control is None
                    else key_control.active_record(key_id=source_key_id)
                )
                source_user_id = str(record.get("source_user_id") or "")
                source_valid = (
                    source_key is not None
                    and source_key.owner_user_id == source_user_id
                    and source_key.tenant_id == str(record["tenant_id"])
                    and (
                        source_key.grant_scope != "project"
                        or source_key.project_id == str(record["project_id"])
                    )
                )
                if not source_valid:
                    self.agent_sessions.invalidate(
                        session_id=str(record["id"]),
                        reason="source_authority_revoked",
                    )
                    return oauth.bearer_denial(
                        request,
                        message="unknown, expired, or released agent session",
                        enabled=self.oauth_enabled,
                        session_denial=None,
                    )
            principal = Principal(
                tenant_id=str(record["tenant_id"]),
                client_id=f"agent-session:{record['id']}",
                user_id=str(record.get("source_user_id") or ""),
                key_project_id=str(record["project_id"]),
                agent_session_id=str(record["id"]),
                agent_experiment_id=(
                    str(record["target_id"])
                    if str(record["target_type"]) == "experiment"
                    else ""
                ),
                agent_target_type=str(record["target_type"]),
                agent_target_id=str(record["target_id"]),
                agent_session_kind=str(record["kind"]),
                agent_review_request_id=str(record["review_request_id"] or ""),
                source_key_id=source_key_id or None,
                key_sandbox_seconds_ceiling=(
                    None if source_key is None else source_key.sandbox_seconds_ceiling
                ),
                key_blob_bytes_ceiling=(
                    None if source_key is None else source_key.blob_bytes_ceiling
                ),
            )
            request.state.principal = principal
            request.state.authenticated = True
            return oauth.credential_audience_denial(
                request=request,
                principal=principal,
                canonical_mcp_resource=self.canonical_mcp_resource,
            )
        if self.verifier is None:
            return None
        try:
            principal = self.verifier.verify_bearer(authorization)
        except UnauthorizedError as exc:
            return oauth.bearer_denial(
                request,
                message=exc.message,
                enabled=self.oauth_enabled,
                session_denial=None,
            )
        request.state.principal = principal
        request.state.authenticated = True
        # INV-7: audience-bound bearers are valid ONLY on the canonical /mcp path.
        return oauth.credential_audience_denial(
            request=request,
            principal=principal,
            canonical_mcp_resource=self.canonical_mcp_resource,
        )


@dataclass(frozen=True)
class ProjectAuthorizer:
    """The single project-membership boundary for every HTTP entry path."""

    research: Research
    _project_path = re.compile(r"^/api/projects/([^/]+)")
    _query_scoped_prefixes = ("/api/activity", "/api/debug/")
    # Operator/tenant diagnostics an mk_ key must never reach (INV-11).
    _operator_diagnostic_prefixes = ("/api/activity", "/api/debug/", "/api/admin")
    # Owner-only key list/revoke, by method: owner_user_id-scoped in SQL, so
    # membership adds nothing and gating on it would strand an account key
    # live-but-unrevokable once its owner leaves home. Minting stays gated.
    _owner_key_routes = {
        "GET": re.compile(r"^/api/projects/[^/]+/keys$"),
        "POST": re.compile(r"^/api/projects/[^/]+/keys/[^/]+/revoke$"),
    }

    @staticmethod
    def user_id(principal: Any) -> str:
        return str(getattr(principal, "user_id", "") or "")

    @staticmethod
    def key_project_id(principal: Any) -> str:
        return str(getattr(principal, "key_project_id", "") or "")

    def require_key_scope(self, *, project_id: str | None, principal: Any) -> None:
        """Exact key-project equality, BEFORE any membership check (INV-11)."""
        key_project_id = self.key_project_id(principal)
        if key_project_id and project_id and project_id != key_project_id:
            raise ProjectKeyScopeError(
                "project API key cannot access a different project",
                details={
                    "key_project_id": key_project_id,
                    "requested_project_id": project_id,
                },
            )

    def require_member(self, *, project_id: str | None, principal: Any) -> None:
        self.require_key_scope(project_id=project_id, principal=principal)
        user_id = self.user_id(principal)
        if (
            user_id
            and project_id
            and not self.research.is_project_member(
                project_id=project_id, user_id=user_id
            )
        ):
            raise NotFoundError(f"project not found: {project_id}")

    def http_denial(self, request: Request) -> JSONResponse | None:
        path = request.url.path
        if getattr(request.state.principal, "agent_session_id", None) and not (
            path == "/mcp" or path.startswith("/mcp/")
        ):
            return JSONResponse(
                {
                    "detail": "agent session credentials are valid only on the MCP endpoint",
                    "error_code": "agent_session_scope_forbidden",
                },
                status_code=403,
            )
        # Credential SHAPE, not binding: an account key has no
        # key_project_id, so a binding test fails open here (INV-11).
        if is_external_key(request.state.principal) and path.startswith(
            self._operator_diagnostic_prefixes
        ):
            return JSONResponse(
                {
                    "detail": "project API keys cannot access operator diagnostics",
                    "error_code": "project_scope_forbidden",
                },
                status_code=403,
            )
        if path.startswith(GLOBAL_MUTATOR_PREFIXES):
            # Operator token replaces membership scoping here (local keeps access).
            return operator_denial(request)
        match = self._project_path.match(path)
        project_id = match.group(1) if match else ""
        if not project_id and path.startswith(self._query_scoped_prefixes):
            project_id = request.query_params.get("project_id") or ""
            if not project_id:
                return JSONResponse(
                    {
                        "detail": "project_id is required on this endpoint when authenticated",
                        "error_code": "validation_error",
                    },
                    status_code=400,
                )
        try:
            self.require_key_scope(
                project_id=project_id, principal=request.state.principal
            )
        except ProjectKeyScopeError as exc:
            return JSONResponse(
                {"detail": exc.message, "error_code": exc.error_code, **exc.details},
                status_code=403,
            )
        owner_key = self._owner_key_routes.get(request.method)
        gated = project_id and not (owner_key and owner_key.match(path))
        if gated and operator_membership_recovery(request):
            gated = False  # operator re-staffing an orphaned project
        if gated and not self.research.is_project_member(
            project_id=project_id, user_id=self.user_id(request.state.principal)
        ):
            return JSONResponse(
                {"detail": "project not found", "error_code": "not_found"},
                status_code=404,
            )
        return None


def caller_facts(principal: Any, *, mcp_session_id: str = "") -> CallerFacts:
    """The non-secret caller facts an agent identity is bound to and stored with.

    Lives here, beside the principal vocabulary, so the identity service never
    has to know what a principal is.
    """
    return CallerFacts(
        tenant_id=str(getattr(principal, "tenant_id", "") or ""),
        user_id=str(getattr(principal, "user_id", "") or ""),
        principal_id=principal_label(principal),
        oauth_family_id=str(getattr(principal, "oauth_family_id", "") or ""),
        agent_session_id=str(getattr(principal, "agent_session_id", "") or ""),
        mcp_session_id=str(mcp_session_id or ""),
    )


@dataclass(frozen=True)
class ToolInvocationGateway:
    """Apply hosted-tool policy before delegating to application commands."""

    tools: ToolDispatcher
    research: Research
    sandboxes: SandboxEngine
    surface: HttpSurfacePolicy
    projects: ProjectAuthorizer
    ledger: CallLedger | None = None
    agent_sessions: AgentSessions | None = None
    # Who the agent context window behind an MCP call is (agent.hello ids).
    # None only in narrow test compositions: then agent_id is neither
    # demanded nor recorded.
    agent_identities: AgentIdentities | None = None
    # Per-composition: the SAME key this app's /wait route verifies with, so
    # two apps over one backend each sign only what their own route accepts.
    wait_secret: bytes | None = None
    auth_meta: dict[str, Any] | None = None

    def call(
        self,
        *,
        name: str,
        arguments: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        project_scope: str | None = None,
        activity_source: str = "http",
        principal: Any | None = None,
        base_url: str = "",  # renders upload one-liners and run wait URLs
        mcp_session_id: str = "",  # the transport session header, if any
    ) -> dict[str, Any]:
        arguments = dict(arguments or {})
        scope = str(arguments.get("project_id") or project_scope or "")
        try:
            plan = self._preflight(
                name=name,
                arguments=arguments,
                context=dict(context or {}),
                project_scope=project_scope,
                activity_source=activity_source,
                principal=principal,
                base_url=base_url,
                mcp_session_id=mcp_session_id,
            )
        except ResearchPluginError as exc:
            # Only PRE-dispatch refusals reach here — repo_root, membership, the
            # key project-create block. Legacy /mcp/call earns these too, and
            # without this line the caller's refusal would leave no evidence.
            ledger_tool_refusal(
                self.ledger,
                tool=name,
                source=activity_source,
                project_id=scope,
                exc=exc,
            )
            raise
        result = self._dispatch(
            name=name,
            arguments=arguments,
            plan=plan,
            activity_source=activity_source,
            project_id=scope,
        )
        if self.agent_sessions is not None and getattr(
            principal, "agent_session_id", None
        ):
            self.agent_sessions.reconcile()
        return result

    def _preflight(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        context: dict[str, Any],
        project_scope: str | None,
        activity_source: str,
        principal: Any | None,
        base_url: str,
        mcp_session_id: str = "",
    ) -> tuple[Any, Any, dict[str, Any] | None, dict[str, Any]]:
        """Every denial a call can earn before dispatch, plus the kwargs it needs.

        Split from dispatch so one ``except`` owns the durable refusal row: past
        this point the dispatcher and the hosted sandbox route each mint their
        own, and a blanket handler would double-count them.

        Agent identity wraps the scope checks: the model-supplied ``agent_id``
        is lifted out of the arguments FIRST (every contract forbids extras,
        and no handler wants it), an already-valid one is bound before the
        checks so even a denial is attributed, and the identity requirement
        itself is asked LAST — a call that is out of scope is refused for that
        reason, not for a missing id.
        """
        supplied_agent_id = (
            str(arguments.get("agent_id") or "")
            if name == HELLO_TOOL
            else str(arguments.pop("agent_id", "") or "")
        )
        identities = self.agent_identities if activity_source == "mcp" else None
        caller = caller_facts(principal, mcp_session_id=mcp_session_id)
        if identities is not None:
            bind_agent(
                agent_id=(
                    identities.peek(agent_id=supplied_agent_id, caller=caller)
                    if supplied_agent_id
                    else ""
                ),
                mcp_session_id=mcp_session_id,
            )
        contract, policy, internal_kwargs, call_kwargs = self._preflight_scope(
            name=name,
            arguments=arguments,
            context=context,
            project_scope=project_scope,
            activity_source=activity_source,
            principal=principal,
            base_url=base_url,
        )
        if identities is None:
            return contract, policy, internal_kwargs, call_kwargs
        if name == HELLO_TOOL:
            # The tool sees who is calling from the credential, never the model.
            internal_kwargs = {**(internal_kwargs or {}), "caller": caller.as_dict()}
            return contract, policy, internal_kwargs, call_kwargs
        agent_id = identities.resolve(
            agent_id=supplied_agent_id, caller=caller, tool=name
        )
        bind_agent(agent_id=agent_id, mcp_session_id=mcp_session_id)
        return contract, policy, internal_kwargs, call_kwargs

    def _preflight_scope(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        context: dict[str, Any],
        project_scope: str | None,
        activity_source: str,
        principal: Any | None,
        base_url: str,
    ) -> tuple[Any, Any, dict[str, Any] | None, dict[str, Any]]:
        """The scope/visibility/membership half of pre-flight (see _preflight)."""
        contract = TOOL_MANIFEST.get(name)
        # INV-5: an MCP call from any non-local principal (mk_/rr_sk_/JWT) is
        # confined to public tools by the dispatcher; local composition is not.
        caller_is_external_mcp = activity_source == "mcp" and not is_local_principal(
            principal
        )
        if context.get("repo_root"):
            raise ValidationError(
                "repo_root context is not supported; send project_id explicitly "
                "or authenticate with a project-bound MCP key",
                details={
                    "field": "context.repo_root",
                    "reason": "repo_root_not_supported",
                },
            )
        user_id = self.projects.user_id(principal)
        key_project_id = self.projects.key_project_id(principal)
        self.authorize_agent_session(
            name=name, arguments=arguments, principal=principal
        )
        self.projects.require_member(
            project_id=key_project_id or None, principal=principal
        )
        for scope in (arguments.get("project_id"), project_scope):
            self.projects.require_member(project_id=scope, principal=principal)
        if (
            is_external_key(principal)
            and name == "project"
            and arguments.get("action") == "create"
        ):
            # Shape, not binding: account keys are machine credentials too.
            raise ProjectKeyScopeError(
                "project API keys cannot create projects",
                details={"key_project_id": key_project_id},
            )
        internal_kwargs = None
        if user_id and name in ("project", "project.list"):
            internal_kwargs = {"user_id": user_id}
            if (
                key_project_id
            ):  # list -> scope to bound project; project -> pass through
                internal_kwargs[
                    "project_id" if name == "project.list" else "key_project_id"
                ] = key_project_id
        if base_url and name in (
            "artifact.submit",
            "feed.post",
            "storage.submit",
            "sandbox.runs",
        ):
            # Each renders an absolute URL against the caller-reachable base: an
            # upload token-curl one-liner, or a run's signed wait capability.
            internal_kwargs = {"base_url": base_url}
            if name == "sandbox.runs":
                internal_kwargs["wait_secret"] = self.wait_secret
        if name == "sandbox.options":
            # Same payer resolution as sandbox.request, so the options view
            # can show remaining daily budget when a user cap applies.
            internal_kwargs = {
                **(internal_kwargs or {}),
                "requesting_user_id": user_id,
                "requesting_key_id": str(
                    getattr(principal, "key_id", "")
                    or getattr(principal, "source_key_id", "")
                    or ""
                ),
            }
        if name == "sandbox.request":
            internal_kwargs = {
                "provisioning_user_id": user_id,
                "provisioning_key_id": str(
                    getattr(principal, "key_id", "")
                    or getattr(principal, "source_key_id", "")
                    or ""
                ),
            }
            agent_experiment_id = str(
                getattr(principal, "agent_experiment_id", "") or ""
            )
            if agent_experiment_id:
                internal_kwargs["experiment_id"] = agent_experiment_id
        elif getattr(principal, "agent_experiment_id", None) and name in {
            "sandbox.attach",
            "sandbox.extend",
            "sandbox.get",
            "sandbox.pull_outputs",
            "sandbox.release",
            "sandbox.runs",
            "sandbox.terminal",
        }:
            internal_kwargs = {
                **(internal_kwargs or {}),
                "experiment_id": str(principal.agent_experiment_id),
            }
        agent_session_id = str(getattr(principal, "agent_session_id", "") or "")
        agent_experiment_id = str(getattr(principal, "agent_experiment_id", "") or "")
        if agent_session_id and name == "review.request":
            internal_kwargs = {
                **(internal_kwargs or {}),
                "producer_session_id": agent_session_id,
            }
        if agent_session_id and name == "consolidation.submit":
            internal_kwargs = {
                **(internal_kwargs or {}),
                "producer_session_id": agent_session_id,
            }
        if agent_session_id and name == "review.start":
            internal_kwargs = {
                **(internal_kwargs or {}),
                "caller_session_id": agent_session_id,
                "assigned_agent_session_id": agent_session_id,
                "assigned_review_request_id": str(
                    getattr(principal, "agent_review_request_id", "") or ""
                ),
            }
        if agent_experiment_id and name in ("storage.submit", "storage.put_object"):
            internal_kwargs = {
                **(internal_kwargs or {}),
                "producing_experiment_id": agent_experiment_id,
            }
        policy = (
            HOSTED_CONTROL_TOOL_POLICIES.get(name)
            if self.surface.use_hosted_tool_policies
            else None
        )
        call_kwargs: dict[str, Any] = {"caller_is_external_mcp": caller_is_external_mcp}
        if project_scope:
            call_kwargs["telemetry_project_id"] = project_scope
        if policy is not None:
            if policy.telemetry_from_review_request:
                project_id = self.research.review_project_id(
                    review_request_id=arguments.get("review_request_id")
                )
                self.projects.require_member(project_id=project_id, principal=principal)
                if project_scope and project_id != project_scope:
                    raise NotFoundError(f"project not found: {project_scope}")
                call_kwargs["telemetry_project_id"] = project_id
            if policy.telemetry_from_review_session:
                # INV-9: the session's own project decides scope, so an mk_ key
                # cannot ride a foreign session id into another project.
                project_id = self.research.review_project_id(
                    review_session_id=arguments.get("review_session_id")
                )
                self.projects.require_member(project_id=project_id, principal=principal)
                if project_scope and project_id != project_scope:
                    raise NotFoundError(f"project not found: {project_scope}")
                call_kwargs["telemetry_project_id"] = project_id
            return contract, policy, internal_kwargs, call_kwargs
        if (
            contract is not None
            and contract.scope_strategy == "linked-project"
            and "project_id" not in arguments
        ):
            raise ValidationError(
                "project_id is required", details={"field": "project_id"}
            )
        return contract, policy, internal_kwargs, call_kwargs

    def authorize_agent_session(
        self, *, name: str, arguments: dict[str, Any], principal: Any | None
    ) -> None:
        session_id = str(getattr(principal, "agent_session_id", "") or "")
        if not session_id:
            return
        target_type = str(getattr(principal, "agent_target_type", "") or "")
        target_id = str(getattr(principal, "agent_target_id", "") or "")
        experiment_id = target_id if target_type == "experiment" else ""
        kind = str(getattr(principal, "agent_session_kind", "") or "experiment")
        allowed = (
            AGENT_REVIEW_SESSION_TOOLS
            if kind == "review"
            else (
                AGENT_CONSOLIDATION_SESSION_TOOLS
                if kind == "consolidation"
                else AGENT_EXPERIMENT_SESSION_TOOLS
            )
        )
        if name not in allowed:
            raise AgentSessionScopeError(
                f"agent session cannot call {name}",
                details={
                    "tool": name,
                    "target_type": target_type,
                    "target_id": target_id,
                },
            )
        requested = str(arguments.get("experiment_id") or "")
        if requested and requested != experiment_id:
            raise AgentSessionScopeError(
                "agent session cannot act on another experiment",
                details={
                    "session_experiment_id": experiment_id,
                    "requested_experiment_id": requested,
                },
            )
        requested_reflection = str(arguments.get("reflection_id") or "")
        if requested_reflection and (
            target_type != "reflection" or requested_reflection != target_id
        ):
            raise AgentSessionScopeError(
                "agent session cannot act on another reflection",
                details={
                    "session_reflection_id": (
                        target_id if target_type == "reflection" else ""
                    ),
                    "requested_reflection_id": requested_reflection,
                },
            )
        if (
            name.startswith("sandbox.")
            and name
            not in {
                "sandbox.health",
                "sandbox.options",
                "sandbox.request",
                "sandbox.attach",
            }
            and not requested
        ):
            raise AgentSessionScopeError(
                "agent session sandbox calls must identify their experiment",
                details={"experiment_id": experiment_id, "tool": name},
            )
        requested_target_type = str(arguments.get("target_type") or "")
        requested_target_id = str(arguments.get("target_id") or "")
        if name in {"artifact.submit", "review.request", "review.status"} and (
            requested_target_type != target_type or requested_target_id != target_id
        ):
            raise AgentSessionScopeError(
                f"{name} must target the assigned {target_type}",
                details={"target_type": target_type, "target_id": target_id},
            )
        assigned_request_id = str(
            getattr(principal, "agent_review_request_id", "") or ""
        )
        if name == "review.start" and (
            kind != "review"
            or str(arguments.get("review_request_id") or "") != assigned_request_id
        ):
            raise AgentSessionScopeError(
                "review worker is bound to a different review request",
                details={"review_request_id": assigned_request_id},
            )
        if name == "review.submit" and (
            kind != "review"
            or self.research.review_request_for_session(
                review_session_id=arguments.get("review_session_id")
            )
            != assigned_request_id
        ):
            raise AgentSessionScopeError(
                "review worker is bound to a different review request",
                details={"review_request_id": assigned_request_id},
            )
        if name in {"review.start", "review.submit"}:
            target = self.research.review_target(
                review_request_id=(
                    arguments.get("review_request_id")
                    if name == "review.start"
                    else None
                ),
                review_session_id=(
                    arguments.get("review_session_id")
                    if name == "review.submit"
                    else None
                ),
            )
            if target is not None and target[1:] != (target_type, target_id):
                raise AgentSessionScopeError(
                    f"{name} review target is outside the assigned {target_type}",
                    details={"target_type": target_type, "target_id": target_id},
                )

    def _dispatch(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        plan: tuple[Any, Any, dict[str, Any] | None, dict[str, Any]],
        activity_source: str,
        project_id: str,
    ) -> dict[str, Any]:
        """Run the pre-flighted call. Both routes write their own ledger row."""
        contract, policy, internal_kwargs, call_kwargs = plan
        if (
            self.surface.hosted_control
            and contract is not None
            and contract.hosted_control_sandbox_lookup
            and policy is None
        ):
            try:
                request = contract.input_model.model_validate(arguments)
            except PydanticValidationError as exc:
                refusal = ValidationError(
                    "invalid tool arguments",
                    details={"tool": name, "errors": exc.errors()},
                )
                ledger_tool_refusal(
                    self.ledger,
                    tool=name,
                    source=activity_source,
                    project_id=project_id,
                    exc=refusal,
                )
                raise refusal from exc
            return ledger_direct_call(
                self.ledger,
                tool=name,
                source=activity_source,
                project_id=project_id,
                arguments=arguments,
                run=lambda: self.sandboxes.get(
                    experiment_id=request.experiment_id,
                    project_id=request.project_id,
                    tenant_id=None,
                    sandbox_uid=request.sandbox_uid,
                ),
            )
        return self.tools.call_tool(
            name=name,
            arguments=arguments,
            activity_source=activity_source,
            internal_kwargs=internal_kwargs,
            **call_kwargs,
        )

    def call_mcp(
        self,
        name: str,
        arguments: dict[str, Any],
        context: dict[str, Any],
        request: Request,
    ) -> dict[str, Any]:
        return self.call(
            name=name,
            arguments=arguments,
            context=context,
            activity_source="mcp",
            principal=getattr(request.state, "principal", LOCAL_PRINCIPAL),
            base_url=str(request.base_url).rstrip("/"),  # caller-reachable base
            mcp_session_id=str(request.headers.get("mcp-session-id") or ""),
        )

    def call_http(
        self,
        request: Request,
        *,
        name: str,
        arguments: dict[str, Any] | None = None,
        project_scope: str | None = None,
    ) -> dict[str, Any]:
        return present(
            self.call(
                name=name,
                arguments=arguments,
                project_scope=project_scope,
                activity_source="http",
                principal=getattr(request.state, "principal", LOCAL_PRINCIPAL),
                base_url=str(request.base_url).rstrip("/"),
            )
        )

    def authorize_project(self, request: Request, project_id: str) -> None:
        self.projects.require_member(
            project_id=project_id,
            principal=getattr(request.state, "principal", LOCAL_PRINCIPAL),
        )


def install_request_middleware(
    http: FastAPI,
    *,
    authenticator: RequestAuthenticator,
    authorizer: ProjectAuthorizer,
    ledger: RefusalLedger | None = None,
) -> None:
    # Hosted WITHOUT a verifier: nobody authenticates, so an undenied caller is
    # an anonymous remote one, not this machine's trusted operator.
    open_mode = authenticator.surface.hosted_control and authenticator.verifier is None

    @http.middleware("http")
    async def reject_foreign_origins(request: Request, call_next):
        origin = request.headers.get("origin")
        if (
            not authenticator.surface.restrict_cors
            and not authenticator.surface.hosted_control
            and origin
            and not is_local_origin(origin)
        ):
            return JSONResponse(
                {
                    "detail": "cross-origin requests to the local HTTP server are not allowed",
                    "error_code": "forbidden_origin",
                },
                status_code=403,
            )
        return await call_next(request)

    @http.middleware("http")
    async def attach_principal(request: Request, call_next):
        denied = authenticator.authenticate(request)
        if denied is None and getattr(request.state, "authenticated", False):
            denied = authorizer.http_denial(request)
        elif denied is None and authenticator.surface.hosted_control:
            # OPEN hosted mode (no verifier): still operator-gate global mutators.
            denied = open_hosted_operator_denial(request)
        bind_request_principal(request, denied=denied, open_mode=open_mode)
        if denied is None:
            return await call_next(request)
        # Off the event loop: a 401 storm against a stalled database must not
        # queue every unrelated request behind the durable row it is writing.
        await run_in_threadpool(ledger_refusal, request, denied=denied, ledger=ledger)
        return denied


def install_auth_routes(
    http: FastAPI,
    *,
    verifier: Any | None,
    tracking_enabled: bool = False,
    runner_pairings: RunnerPairings | None = None,
    gateway: "ToolInvocationGateway | None" = None,
) -> None:
    if verifier is None:
        return
    if getattr(verifier, "project_keys", None) is not None:
        http.include_router(
            project_keys.build_router(keys=verifier.project_keys)
        )
        # Runner pairing registers a key from a runner-presented digest, so it
        # exists exactly where owner key management exists (hosted auth) and
        # nowhere else; the loopback brain needs no runner credential at all.
        # The component is built by the composition root, never here.
        if runner_pairings is not None and gateway is not None:
            http.include_router(
                runner_pairing.build_router(pairings=runner_pairings, gateway=gateway)
            )

    if tracking_enabled:

        @http.get("/internal/auth/mlflow")
        def mlflow_gate(request: Request) -> Response:
            if mlflow_suspended():
                return JSONResponse(
                    {
                        "detail": "MLflow is temporarily suspended",
                        "error_code": "mlflow_suspended",
                    },
                    status_code=403,
                )
            try:
                principal = verifier.verify_basic_or_bearer(
                    request.headers.get("Authorization")
                )
            except UnauthorizedError:
                return Response(
                    status_code=401,
                    headers={"WWW-Authenticate": 'Basic realm="RapidReview MLflow"'},
                )
            if getattr(principal, "key_id", None):
                return JSONResponse(
                    {
                        "detail": "project API keys are not valid for the MLflow audience",
                        "error_code": "credential_audience_forbidden",
                    },
                    status_code=403,
                )
            return Response(status_code=204)
