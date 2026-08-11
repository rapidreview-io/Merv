"""Projects HTTP routes."""

from __future__ import annotations

import json
import time
from typing import Any, Protocol

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import Response

from ....application import Application
from ....kernel.utils import NotFoundError, ValidationError
from ....research_core import Research
from ....sandbox import SandboxEngine
from ...identity import is_human_session
from .shared import (
    JsonBody,
    conditional_json_from_signal,
    path_scoped_body,
    require_membership_author,
)

from .gateway import ToolInvocationGateway
from .views import present


class UserDirectory(Protocol):
    def find_user_by_email(self, email: str) -> dict[str, object] | None: ...

    def user_profiles(self, user_ids: list[str]) -> dict[str, dict[str, object]]: ...


def build_router(
    gateway: ToolInvocationGateway,
    *,
    application: Application,
    research: Research,
    sandboxes: SandboxEngine,
    user_directory: UserDirectory | None = None,
) -> APIRouter:
    api_router = APIRouter()
    lookup_attempts: dict[str, list[float]] = {}

    def members_view(rows: dict[str, Any], request: Request) -> dict[str, Any]:
        members = rows.get("members") or []
        profiles: dict[str, Any] = {}
        if user_directory is not None and is_human_session(request.state.principal):
            try:
                profiles = user_directory.user_profiles(
                    [str(row.get("user_id") or "") for row in members]
                )
            except Exception:
                profiles = {}
        self_id = gateway.projects.user_id(request.state.principal)
        return {
            "members": [
                {
                    **profiles.get(str(row.get("user_id") or ""), {}),
                    **row,
                    "is_self": str(row.get("user_id") or "") == self_id,
                }
                for row in members
            ]
        }

    def limit_email_lookup(user_id: str) -> None:
        now = time.monotonic()
        recent = [
            stamp for stamp in lookup_attempts.get(user_id, []) if now - stamp < 60
        ]
        if len(recent) >= 10:
            raise HTTPException(status_code=429, detail="too many email lookups")
        lookup_attempts[user_id] = [*recent, now]

    @api_router.get("/api/projects")
    def list_projects(request: Request) -> dict[str, Any]:
        return gateway.call_http(request, name="project.list", arguments={})

    @api_router.post("/api/projects", status_code=201)
    def create_project(
        request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = body or {}
        return gateway.call_http(
            request,
            name="project",
            arguments={
                "action": "create",
                "name": payload.get("name")
                or payload.get("title")
                or "Untitled Project",
                "summary": payload.get("summary")
                or payload.get("description")
                or payload.get("research_goal")
                or "",
            },
        )

    @api_router.get("/api/projects/{project_id}/members")
    def list_members(project_id: str, request: Request) -> dict[str, Any]:
        return members_view(research.project_members(project_id=project_id), request)

    @api_router.post("/api/projects/{project_id}/members", status_code=201)
    def add_member(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        # Any human MEMBER may share the project (the membership gate already ran).
        require_membership_author(request)
        payload = body or {}
        email = str(payload.get("email") or "").strip()
        user_id = str(payload.get("user_id") or "").strip()
        if bool(email) == bool(user_id):
            raise ValidationError("provide exactly one of email or user_id")
        if email:
            if "@" not in email or len(email) > 320:
                raise ValidationError("a valid email address is required")
            if user_directory is None:
                raise HTTPException(
                    status_code=503, detail="email sharing is not configured"
                )
            limit_email_lookup(gateway.projects.user_id(request.state.principal))
            try:
                target = user_directory.find_user_by_email(email)
            except Exception as exc:
                raise HTTPException(
                    status_code=503, detail="user directory unavailable"
                ) from exc
            if not target or target.get("is_anonymous"):
                raise NotFoundError("no account found for that email")
            user_id = str(target.get("user_id") or target.get("id") or "")
            if not user_id:
                raise HTTPException(
                    status_code=503, detail="user directory returned no user id"
                )
        return members_view(
            research.add_project_member(project_id=project_id, user_id=user_id),
            request,
        )

    @api_router.delete("/api/projects/{project_id}/members/{user_id}")
    def remove_member(
        project_id: str, user_id: str, request: Request
    ) -> dict[str, Any]:
        require_membership_author(request)
        return members_view(
            research.remove_project_member(project_id=project_id, user_id=user_id),
            request,
        )

    @api_router.get("/api/projects/{project_id}")
    def get_project(project_id: str, request: Request) -> dict[str, Any]:
        return gateway.call_http(
            request, name="project.get", arguments={"project_id": project_id}
        )

    @api_router.patch("/api/projects/{project_id}")
    @api_router.put("/api/projects/{project_id}")
    def update_project(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        return gateway.call_http(
            request,
            name="project.update",
            arguments=path_scoped_body(body, project_id=project_id),
        )

    @api_router.get("/api/projects/{project_id}/home")
    def home(project_id: str, request: Request) -> Response:
        # Composite signal ETag. The home payload is a pure function of three
        # inputs: the event ledger (claims/experiments/reviews/reflections/
        # artifacts all append events), live sandbox rows (heartbeats bump
        # updated_at but write no event), and the MLflow reachability probe
        # (external, 5s-cached). A 304 skips the heavy status/experiment render.
        return conditional_json_from_signal(
            request,
            signal_parts=(
                "home",
                project_id,
                application.timeline_signal(project_id=project_id),
                sandboxes.project_signal(project_id=project_id),
                json.dumps(
                    application.tracking_health(),
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ),
            ),
            payload=lambda: present(application.dashboard(project_id=project_id)),
        )

    @api_router.get("/api/projects/{project_id}/status")
    def project_status(
        project_id: str, experiment_id: str | None = None
    ) -> dict[str, Any]:
        # Full shape for the UI (see home()); the tool stays slim for the agent.
        return present(
            application.status(project_id=project_id, experiment_id=experiment_id)
        )

    return api_router
