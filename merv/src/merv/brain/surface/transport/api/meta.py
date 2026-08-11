"""Meta HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from .... import __version__
from ....kernel.version import meta
from ....research_core import Research

from .gateway import ToolInvocationGateway
from .views import ActivityTelemetry, ToolCallTelemetry
from .views import activity_view, tool_call_detail as select_tool_call_detail


def _caller_project_ids(
    research: Research, request: Request
) -> set[str] | None:
    """The authenticated caller's project memberships, or None for the local
    principal (unscoped/global — unchanged local behavior). Diagnostics scope to
    this set so a member cannot read another project's calls (INV-11 FIX 1)."""
    user_id = str(getattr(getattr(request.state, "principal", None), "user_id", "") or "")
    if not user_id:
        return None
    return research.project_ids_for_user(user_id=user_id)


def build_router(
    gateway: ToolInvocationGateway,
    *,
    activity_log: ActivityTelemetry,
    tool_calls: ToolCallTelemetry,
    research: Research,
    project_member_directory: bool = False,
) -> APIRouter:
    api_router = APIRouter()
    surface = gateway.surface
    @api_router.get("/health")
    def health() -> dict[str, Any]:
        # Surface hygiene: /health is liveness only and never exposes host
        # paths or deployment details.
        return {"ok": True, "version": __version__}

    @api_router.get("/api/meta")
    def server_meta() -> dict[str, Any]:
        # Version/compat handshake: server and catalog versions plus the
        # retained minimum proxy floor. Capabilities advertise the universal
        # HTTP MCP and token-upload paths.
        payload = meta()
        payload["mode"] = "control" if surface.hosted_control else "local"
        payload["capabilities"] = {
            "hosted_control": surface.hosted_control,
            "mcp": True,
            "token_uploads": True,
            "project_member_directory": project_member_directory,
        }
        # Auth handshake: tells the UI whether to show a login and which
        # Supabase project to sign in against (public values only).
        payload["auth"] = gateway.auth_meta or {"required": False}
        return payload

    @api_router.api_route(
        "/api/daemon/{_path:path}",
        methods=["GET", "POST", "PUT", "DELETE"],
        status_code=410,
    )
    def daemon_retired(_path: str) -> dict[str, Any]:
        # Tombstone for pre-0.0010 local thin-pipe daemons: their long-poll
        # would spin on bare 404s forever with nothing telling the operator why.
        return {
            "error_code": "daemon_retired",
            "message": (
                "The local thin-pipe daemon path was removed in plugin 0.0010. "
                "Stop this daemon and upgrade the merv package."
            ),
        }

    @api_router.get("/api/activity")
    def activity(
        request: Request,
        limit: int = Query(100, ge=1),
        source: str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        return activity_view(
            activity_log,
            limit=limit,
            source=source,
            project_id=project_id,
            project_ids=_caller_project_ids(research, request),
        )

    # /api/debug/* expose tool-call internals. Hosted control is currently a
    # private operator surface; the real auth system should gate these before
    # broad exposure.
    @api_router.get("/api/debug/tool-calls")
    def tool_call_stats(
        request: Request,
        minutes: int | None = Query(None, ge=1),
        source: str | None = None,
        status: str | None = None,
        tool: str | None = None,
        project_id: str | None = None,
        limit: int = Query(200, ge=1, le=2000),
        sort: str = "ts",
        order: str = "desc",
    ) -> dict[str, Any]:
        return tool_calls.stats(
            minutes=minutes,
            source=source,
            status=status,
            tool=tool,
            project_id=project_id,
            project_ids=_caller_project_ids(research, request),
            limit=limit, sort=sort, order=order,
        )

    @api_router.get("/api/debug/tool-calls/{call_id}")
    def tool_call_detail(call_id: int, request: Request) -> dict[str, Any]:
        # A supplied call must belong to one of the caller's projects, so a
        # member can never read an arbitrary cross-project call (INV-11).
        return select_tool_call_detail(
            tool_calls,
            call_id=call_id,
            project_ids=_caller_project_ids(research, request),
        )

    @api_router.post("/api/debug/tool-calls/clear")
    def tool_calls_clear() -> dict[str, Any]:
        # Global mutator: the gateway's membership boundary gates this path on
        # MERV_ADMIN_TOKEN (hosted) before the route runs; local keeps access.
        return tool_calls.clear(project_ids=None)


    return api_router
