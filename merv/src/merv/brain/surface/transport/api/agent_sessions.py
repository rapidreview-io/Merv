"""HTTP control routes for machine-local coding-agent runners."""

from __future__ import annotations

from typing import Any, Protocol

from fastapi import APIRouter, Body, Request

from ....agent_sessions import AgentSessions
from ....application import Application, present_session
from ....kernel.utils import NotFoundError, PermissionDeniedError, ValidationError
from ...identity import ProjectKeyScopeError, is_external_key, principal_label
from .gateway import ToolInvocationGateway
from .shared import JsonBody


class AgentAdvances(Protocol):
    """The runner's judgment-free central compare-and-swap, prepared and settled here.

    Research decides which instance may advance and what the receipt means;
    this delivery only carries ``{advance_id, instance_id, revision,
    expected_sha, target_sha, sources: [{id, sha}]}`` to the runner and its
    receipt back. ``sources[].id`` is an opaque lineage id the runner keys its
    ancestry receipt by.
    """

    def prepare_agent_advance(self, *, project_id: str, instance_id: str, runner_id: str) -> dict[str, Any] | None: ...

    def pending_agent_advance(self, *, project_id: str) -> dict[str, Any] | None: ...

    def settle_agent_advance(
        self, *, project_id: str, advance_id: str, runner_id: str, observed_sha: str,
        proposal_parents: list[str], diffstat: dict[str, Any], ancestry: dict[str, bool], error: str,
    ) -> dict[str, Any]: ...


def _dict(payload: dict[str, Any], key: str, default: Any = None) -> Any:
    """The body's object under ``key``, or ``default`` when it is not one."""
    value = payload.get(key)
    return value if isinstance(value, dict) else default


def _list(payload: dict[str, Any], key: str) -> list[Any]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def build_router(
    gateway: ToolInvocationGateway, *, application: Application,
    sessions: AgentSessions, advances: AgentAdvances,
) -> APIRouter:
    router = APIRouter()

    def owner(request: Request, payload: dict[str, Any]) -> str:
        principal = request.state.principal
        if principal.agent_session_id:
            raise PermissionDeniedError(
                "an agent session credential cannot control runner sessions"
            )
        runner_id = str(payload.get("runner_id") or "").strip()
        return f"{principal_label(principal)}/{runner_id}"

    def authorize_session_control(request: Request, session_id: str) -> None:
        """Re-check the session's immutable parent project before mutation."""
        authority = sessions.authority(session_id=session_id)
        principal = request.state.principal
        same_source = (
            str(authority["source_user_id"]) == principal.user_id
            and str(authority["source_key_id"]) == (principal.key_id or "")
        )
        try:
            gateway.authorize_project(request, authority["project_id"])
        except (NotFoundError, ProjectKeyScopeError):
            if same_source:
                sessions.invalidate(
                    session_id=session_id,
                    reason="source_authority_revoked",
                )
            raise

    @router.post("/api/agent-sessions/lease")
    def lease(request: Request, body: JsonBody = Body(default=None)) -> dict[str, Any]:
        payload = dict(body or {})
        project_id = str(payload.get("project_id") or "")
        gateway.authorize_project(request, project_id)
        principal = request.state.principal
        deadline = payload.get("hard_deadline_seconds", 24 * 60 * 60)
        if not isinstance(deadline, int) or isinstance(deadline, bool):
            raise ValidationError(
                "hard_deadline_seconds must be an integer",
                details={"field": "hard_deadline_seconds"},
            )
        return application.lease_agent_session(
            project_id=project_id,
            runner_id=owner(request, payload),
            platform=str(payload.get("platform") or ""),
            idempotency_key=str(payload.get("idempotency_key") or ""),
            session_secret=str(payload.get("session_secret") or ""),
            source_key_id=principal.key_id or "",
            source_user_id=principal.user_id,
            hard_deadline_seconds=deadline,
        )

    @router.post("/api/agent-sessions/{session_id}/attach")
    def attach(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return {"session": present_session(sessions.attach(
            session_id=session_id,
            runner_id=owner(request, payload),
            host_session_ref=str(payload.get("host_session_ref") or ""),
            workspace_ref=str(payload.get("workspace_ref") or ""),
            base_sha=str(payload.get("base_sha") or ""),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=_dict(payload, "workspace_stats", {}),
            agent_setup=_dict(payload, "agent_setup"),
            telemetry=_dict(payload, "telemetry"),
        ))}

    @router.post("/api/agent-sessions/{session_id}/release")
    def release(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return {"session": present_session(sessions.release(
            session_id=session_id,
            runner_id=owner(request, payload),
            reason=str(payload.get("reason") or "runner_released"),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=_dict(payload, "workspace_stats", {}),
            telemetry=_dict(payload, "telemetry"),
        ))}

    @router.post("/api/agent-sessions/{session_id}/heartbeat")
    def heartbeat(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return {"session": present_session(sessions.heartbeat(
            session_id=session_id,
            runner_id=owner(request, payload),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=_dict(payload, "workspace_stats", {}),
            telemetry=_dict(payload, "telemetry"),
        ))}

    @router.post("/api/projects/{project_id}/workspace-advances/prepare")
    def prepare_agent_advance(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        return {
            "advance": advances.prepare_agent_advance(
                project_id=project_id,
                instance_id=str(payload.get("instance_id") or ""),
                runner_id=owner(request, payload),
            )
        }

    @router.get("/api/projects/{project_id}/workspace-advances/pending")
    def pending_agent_advance(project_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return {"advance": advances.pending_agent_advance(project_id=project_id)}

    @router.post("/api/projects/{project_id}/workspace-advances/settle")
    def settle_agent_advance(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        return {
            "advance": advances.settle_agent_advance(
                project_id=project_id,
                advance_id=str(payload.get("advance_id") or ""),
                runner_id=owner(request, payload),
                observed_sha=str(payload.get("observed_sha") or ""),
                proposal_parents=[str(value) for value in _list(payload, "proposal_parents")],
                diffstat=_dict(payload, "diffstat", {}),
                ancestry={str(key): value for key, value in _dict(payload, "ancestry", {}).items()},
                error=str(payload.get("error") or ""),
            )
        }

    @router.get("/api/projects/{project_id}/agent-sessions")
    def list_sessions(project_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return application.list_agent_sessions(project_id=project_id)

    @router.post("/api/projects/{project_id}/agent-runners/heartbeat")
    def heartbeat_runner(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        if request.state.principal.agent_session_id:
            raise PermissionDeniedError(
                "an agent session credential cannot report runner presence"
            )
        capacity = payload.get("capacity", 0)
        if not isinstance(capacity, int) or isinstance(capacity, bool):
            raise ValidationError(
                "capacity must be an integer", details={"field": "capacity"}
            )
        applied_version = payload.get("applied_version")
        if applied_version is not None and (
            not isinstance(applied_version, int) or isinstance(applied_version, bool)
        ):
            raise ValidationError(
                "applied_version must be an integer",
                details={"field": "applied_version"},
            )
        response = sessions.heartbeat_runner(
            project_id=project_id,
            runner_id=owner(request, payload),
            machine=_dict(payload, "machine", {}),
            platforms=[item for item in _list(payload, "platforms") if isinstance(item, dict)],
            capacity=capacity,
            inventory=_dict(payload, "inventory"),
            applied_version=applied_version,
        )
        # ``runner`` keeps the pre-existing key for one release; the caller's
        # own row, the desired version, and the desired settings are the
        # contract.
        return {"runner": response["presence"], **response}

    @router.put("/api/projects/{project_id}/agent-runners/settings")
    def set_runner_settings(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        """Owner-side tuning for one paired runner, addressed by ``runner_ref``.

        The runner is named in the body because its opaque ref is the only
        browser-visible identity; the closed schema is validated again here so
        no executable argv can be stored even by a hand-built request.
        """
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        if is_external_key(request.state.principal):
            raise PermissionDeniedError(
                "runner settings are saved from the browser, not by a runner or agent"
            )
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise ValidationError(
                "settings must be an object", details={"field": "settings"}
            )
        return {
            "runner": sessions.set_desired_settings(
                project_id=project_id,
                runner_ref=str(payload.get("runner_ref") or ""),
                settings=settings,
            )
        }

    @router.post("/api/agent-sessions/{session_id}/trace")
    def record_trace(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        """The owning runner mirrors a bounded, redacted trace excerpt."""
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        events = payload.get("events")
        if not isinstance(events, list):
            raise ValidationError("events must be a list", details={"field": "events"})
        stderr_tail = payload.get("stderr_tail", "")
        if not isinstance(stderr_tail, str):
            raise ValidationError(
                "stderr_tail must be a string", details={"field": "stderr_tail"}
            )
        return sessions.record_trace(
            session_id=session_id,
            runner_id=owner(request, payload),
            events=events,
            stderr_tail=stderr_tail,
            complete=bool(payload.get("complete")),
        )

    @router.get("/api/projects/{project_id}/agent-sessions/{session_id}/trace")
    def session_trace(project_id: str, session_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return {"trace": sessions.trace(project_id=project_id, session_id=session_id)}

    @router.post("/api/projects/{project_id}/agent-sessions/{session_id}/halt")
    def halt_session(project_id: str, session_id: str, request: Request) -> dict[str, Any]:
        """Stop one live session now; its runner kills the child on reconcile."""
        gateway.authorize_project(request, project_id)
        return {
            "session": present_session(
                sessions.halt_session(project_id=project_id, session_id=session_id)
            )
        }

    @router.post("/api/projects/{project_id}/agent-sessions/halt")
    def halt_sessions(project_id: str, request: Request) -> dict[str, Any]:
        """Stop this project's live sessions; disabling dispatch does not."""
        gateway.authorize_project(request, project_id)
        return application.halt_agent_sessions(project_id=project_id)

    return router
