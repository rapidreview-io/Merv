"""HTTP control routes for machine-local coding-agent runners."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request

from ....application import Application
from ....kernel.utils import NotFoundError, PermissionDeniedError, ValidationError
from ...identity import LOCAL_PRINCIPAL, ProjectKeyScopeError, principal_label
from .gateway import ToolInvocationGateway
from .shared import JsonBody


def build_router(
    gateway: ToolInvocationGateway, *, application: Application
) -> APIRouter:
    router = APIRouter()

    def owner(request: Request, payload: dict[str, Any]) -> str:
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        if getattr(principal, "agent_session_id", None):
            raise PermissionDeniedError(
                "an agent session credential cannot control runner sessions"
            )
        runner_id = str(payload.get("runner_id") or "").strip()
        return f"{principal_label(principal)}/{runner_id}"

    def authorize_session_control(request: Request, session_id: str) -> None:
        """Re-check the session's immutable parent project before mutation."""
        authority = application.agent_session_authority(session_id=session_id)
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        same_source = str(authority["source_user_id"]) == str(
            getattr(principal, "user_id", "") or ""
        ) and str(authority["source_key_id"]) == str(
            getattr(principal, "key_id", "") or ""
        )
        try:
            gateway.authorize_project(request, authority["project_id"])
        except (NotFoundError, ProjectKeyScopeError):
            if same_source:
                application.agent_sessions.invalidate(
                    session_id=session_id,
                    reason="source_authority_revoked",
                )
            raise

    @router.post("/api/agent-sessions/claim")
    def claim(request: Request, body: JsonBody = Body(default=None)) -> dict[str, Any]:
        payload = dict(body or {})
        project_id = str(payload.get("project_id") or "")
        gateway.authorize_project(request, project_id)
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        deadline = payload.get("hard_deadline_seconds", 24 * 60 * 60)
        if not isinstance(deadline, int) or isinstance(deadline, bool):
            raise ValidationError(
                "hard_deadline_seconds must be an integer",
                details={"field": "hard_deadline_seconds"},
            )
        return application.claim_agent_session(
            project_id=project_id,
            runner_id=owner(request, payload),
            platform=str(payload.get("platform") or ""),
            idempotency_key=str(payload.get("idempotency_key") or ""),
            session_secret=str(payload.get("session_secret") or ""),
            source_key_id=str(getattr(principal, "key_id", "") or ""),
            source_user_id=str(getattr(principal, "user_id", "") or ""),
            hard_deadline_seconds=deadline,
        )

    @router.post("/api/agent-sessions/{session_id}/attach")
    def attach(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return application.attach_agent_session(
            session_id=session_id,
            runner_id=owner(request, payload),
            host_session_ref=str(payload.get("host_session_ref") or ""),
            workspace_ref=str(payload.get("workspace_ref") or ""),
            base_sha=str(payload.get("base_sha") or ""),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=(
                payload.get("workspace_stats")
                if isinstance(payload.get("workspace_stats"), dict)
                else {}
            ),
            agent_setup=(
                payload.get("agent_setup")
                if isinstance(payload.get("agent_setup"), dict)
                else None
            ),
            telemetry=(
                payload.get("telemetry")
                if isinstance(payload.get("telemetry"), dict)
                else None
            ),
        )

    @router.post("/api/agent-sessions/{session_id}/release")
    def release(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return application.release_agent_session(
            session_id=session_id,
            runner_id=owner(request, payload),
            reason=str(payload.get("reason") or "runner_released"),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=(
                payload.get("workspace_stats")
                if isinstance(payload.get("workspace_stats"), dict)
                else {}
            ),
            telemetry=(
                payload.get("telemetry")
                if isinstance(payload.get("telemetry"), dict)
                else None
            ),
        )

    @router.post("/api/agent-sessions/{session_id}/heartbeat")
    def heartbeat(
        session_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        authorize_session_control(request, session_id)
        return application.heartbeat_agent_session(
            session_id=session_id,
            runner_id=owner(request, payload),
            head_sha=str(payload.get("head_sha") or ""),
            workspace_stats=(
                payload.get("workspace_stats")
                if isinstance(payload.get("workspace_stats"), dict)
                else {}
            ),
            telemetry=(
                payload.get("telemetry")
                if isinstance(payload.get("telemetry"), dict)
                else None
            ),
        )

    @router.post("/api/projects/{project_id}/consolidation/prepare")
    def prepare_advance(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        return {
            "advance": application.prepare_consolidation_advance(
                project_id=project_id,
                reflection_id=str(payload.get("reflection_id") or ""),
                runner_id=owner(request, payload),
            )
        }

    @router.get("/api/projects/{project_id}/consolidation/pending")
    def pending_advance(project_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return {
            "pending": application.pending_consolidation_advance(project_id=project_id)
        }

    @router.post("/api/projects/{project_id}/consolidation/settle")
    def settle_advance(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        return {
            "reflection": application.settle_consolidation_advance(
                project_id=project_id,
                advance_id=str(payload.get("advance_id") or ""),
                runner_id=owner(request, payload),
                observed_sha=str(payload.get("observed_sha") or ""),
                proposal_parents=(
                    [str(value) for value in payload.get("proposal_parents", [])]
                    if isinstance(payload.get("proposal_parents"), list)
                    else []
                ),
                diffstat=(
                    payload.get("diffstat")
                    if isinstance(payload.get("diffstat"), dict)
                    else {}
                ),
                ancestry=(
                    {
                        str(key): value
                        for key, value in payload.get("ancestry", {}).items()
                    }
                    if isinstance(payload.get("ancestry"), dict)
                    else {}
                ),
                error=str(payload.get("error") or ""),
            )
        }

    @router.get("/api/projects/{project_id}/agent-sessions")
    def list_sessions(project_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return application.agent_sessions.list(project_id=project_id)

    @router.post("/api/projects/{project_id}/agent-runners/heartbeat")
    def heartbeat_runner(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = dict(body or {})
        gateway.authorize_project(request, project_id)
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        if getattr(principal, "agent_session_id", None):
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
        return application.heartbeat_agent_runner(
            project_id=project_id,
            runner_id=owner(request, payload),
            machine=(
                payload.get("machine")
                if isinstance(payload.get("machine"), dict)
                else {}
            ),
            platforms=(
                [item for item in payload.get("platforms", []) if isinstance(item, dict)]
                if isinstance(payload.get("platforms"), list)
                else []
            ),
            capacity=capacity,
            inventory=(
                payload.get("inventory")
                if isinstance(payload.get("inventory"), dict)
                else None
            ),
            applied_version=applied_version,
        )

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
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        if getattr(principal, "agent_session_id", None) or getattr(
            principal, "key_id", None
        ):
            raise PermissionDeniedError(
                "runner settings are saved from the browser, not by a runner or agent"
            )
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise ValidationError(
                "settings must be an object", details={"field": "settings"}
            )
        return application.set_agent_runner_settings(
            project_id=project_id,
            runner_ref=str(payload.get("runner_ref") or ""),
            settings=settings,
        )

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
        return application.record_agent_session_trace(
            session_id=session_id,
            runner_id=owner(request, payload),
            events=events,
            stderr_tail=stderr_tail,
            complete=bool(payload.get("complete")),
        )

    @router.get("/api/projects/{project_id}/agent-sessions/{session_id}/trace")
    def session_trace(project_id: str, session_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return application.agent_session_trace(project_id=project_id, session_id=session_id)

    @router.post("/api/projects/{project_id}/agent-sessions/{session_id}/halt")
    def halt_session(project_id: str, session_id: str, request: Request) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        return application.halt_agent_session(project_id=project_id, session_id=session_id)

    @router.post("/api/projects/{project_id}/agent-sessions/halt")
    def halt_sessions(project_id: str, request: Request) -> dict[str, Any]:
        """Stop this project's live sessions; disabling dispatch does not."""
        gateway.authorize_project(request, project_id)
        return application.halt_agent_sessions(project_id=project_id)

    return router
