"""Sandboxes HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from ....application import Application
from ....infrastructure import RemoteSandboxes as SandboxEngine
from .shared import conditional_json_from_signal

from .gateway import ToolInvocationGateway
from .views import present, sandbox_list_view, sandbox_view


def build_router(
    gateway: ToolInvocationGateway,
    *,
    application: Application,
    sandboxes: SandboxEngine,
) -> APIRouter:
    api_router = APIRouter()

    @api_router.get("/api/projects/{project_id}/sandboxes")
    def list_sandboxes(project_id: str, request: Request) -> Response:
        # Signal ETag: every sandbox mutation (status/heartbeat/command/
        # terminate) bumps updated_at, so the row digest changes iff this
        # payload would — a 304 short-circuits before rendering the rows.
        return conditional_json_from_signal(
            request,
            signal_parts=(
                "sandboxes",
                project_id,
                sandboxes.project_signal(project_id=project_id),
            ),
            payload=lambda: sandbox_list_view(sandboxes, project_id=project_id),
        )

    @api_router.get("/api/projects/{project_id}/compute-cost")
    def compute_cost(project_id: str) -> dict[str, Any]:
        # No ETag: open generations bill to now, so the payload moves with the
        # clock even when no row changes.
        return present(application.compute_cost(project_id=project_id))

    @api_router.get("/api/sandboxes/health")
    def sandbox_health() -> dict[str, Any]:
        return sandboxes.health(details=True)

    @api_router.get("/api/projects/{project_id}/experiments/{experiment_id}/sandbox")
    def get_sandbox(
        project_id: str, experiment_id: str, sandbox_uid: str | None = None
    ) -> dict[str, Any]:
        return sandbox_view(
            sandboxes,
            project_id=project_id,
            experiment_id=experiment_id,
            sandbox_uid=sandbox_uid,
        )

    @api_router.get("/api/projects/{project_id}/sandboxes/{sandbox_uid}")
    def get_sandbox_by_uid(project_id: str, sandbox_uid: str) -> dict[str, Any]:
        return sandbox_view(sandboxes, project_id=project_id, sandbox_uid=sandbox_uid)

    @api_router.get(
        "/api/projects/{project_id}/experiments/{experiment_id}/sandbox/metrics"
    )
    def sandbox_metrics(
        project_id: str, experiment_id: str, sandbox_uid: str | None = None
    ) -> dict[str, Any]:
        return sandboxes.sample_metrics(
            project_id=project_id, experiment_id=experiment_id, sandbox_uid=sandbox_uid
        )

    @api_router.get("/api/projects/{project_id}/sandboxes/{sandbox_uid}/metrics")
    def sandbox_metrics_by_uid(project_id: str, sandbox_uid: str) -> dict[str, Any]:
        return sandboxes.sample_metrics(
            project_id=project_id, experiment_id="", sandbox_uid=sandbox_uid
        )

    @api_router.get(
        "/api/projects/{project_id}/experiments/{experiment_id}/sandbox/terminal"
    )
    def sandbox_terminal(
        project_id: str,
        experiment_id: str,
        request: Request,
        tail: int | None = None,
        since: int | None = None,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {
            "project_id": project_id,
            "experiment_id": experiment_id,
        }
        if sandbox_uid:
            args["sandbox_uid"] = sandbox_uid
        if tail is not None:
            args["tail"] = tail
        if since is not None:
            args["since"] = since
        return gateway.call_http(
            request, name="sandbox.terminal", arguments=args
        )

    @api_router.get("/api/projects/{project_id}/sandboxes/{sandbox_uid}/terminal")
    def sandbox_terminal_by_uid(
        project_id: str,
        sandbox_uid: str,
        request: Request,
        tail: int | None = None,
        since: int | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"project_id": project_id, "sandbox_uid": sandbox_uid}
        if tail is not None:
            args["tail"] = tail
        if since is not None:
            args["since"] = since
        return gateway.call_http(
            request, name="sandbox.terminal", arguments=args
        )

    @api_router.post(
        "/api/projects/{project_id}/experiments/{experiment_id}/sandbox/release"
    )
    def release_sandbox(
        project_id: str,
        experiment_id: str,
        request: Request,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any]:
        arguments: dict[str, Any] = {
            "project_id": project_id,
            "experiment_id": experiment_id,
            "confirm_retained": True,
        }
        if sandbox_uid:
            arguments["sandbox_uid"] = sandbox_uid
        return gateway.call_http(
            request,
            name="sandbox.release",
            # The browser already confirms in its own UX; the retention gate is
            # for the agent's MCP call, so the UI route terminates directly.
            arguments=arguments,
        )

    @api_router.post("/api/projects/{project_id}/sandboxes/{sandbox_uid}/release")
    def release_sandbox_by_uid(
        project_id: str,
        sandbox_uid: str,
        request: Request,
    ) -> dict[str, Any]:
        return gateway.call_http(
            request,
            name="sandbox.release",
            arguments={
                "project_id": project_id,
                "sandbox_uid": sandbox_uid,
                "confirm_retained": True,
            },
        )

    return api_router
