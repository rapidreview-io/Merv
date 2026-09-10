"""Meta HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from .... import __version__
from ....research_core import Research

from .gateway import ToolInvocationGateway
from .shared import MCP_CATALOG_VERSION, MIN_PROXY_VERSION
from .views import ActivityTelemetry, activity_view


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
    research: Research,
    project_member_directory: bool = False,
    storage_enabled: bool = False,
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
        payload = {
            "server_version": __version__,
            "min_proxy_version": MIN_PROXY_VERSION,
            "catalog_version": MCP_CATALOG_VERSION,
        }
        payload["mode"] = "control" if surface.hosted_control else "local"
        payload["capabilities"] = {
            "hosted_control": surface.hosted_control,
            "mcp": True,
            "token_uploads": True,
            "project_member_directory": project_member_directory,
            "storage": storage_enabled,
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

    return api_router
