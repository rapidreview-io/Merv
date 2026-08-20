"""Tasks HTTP routes: the UI's read side plus create/transition through the gateway."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request

from ....application import Application
from .shared import JsonBody, path_scoped_body

from .gateway import ToolInvocationGateway
from .views import present


def build_router(
    gateway: ToolInvocationGateway,
    *,
    application: Application,
) -> APIRouter:
    api_router = APIRouter()

    @api_router.get("/api/projects/{project_id}/tasks")
    def list_tasks(project_id: str, status: str | None = None) -> dict[str, Any]:
        items = application.tasks(project_id=project_id, rich=True)
        if status:
            items = [item for item in items if item.get("status") == status]
        return present({"tasks": items})

    @api_router.post("/api/projects/{project_id}/tasks", status_code=201)
    def create_task(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = path_scoped_body(body, project_id=project_id)
        return gateway.call_http(
            request,
            name="task.create",
            arguments={
                "project_id": project_id,
                "name": payload.get("name") or "",
                "goal": payload.get("goal") or "",
                "deliverables": payload.get("deliverables") or [],
                "depends_on": payload.get("depends_on") or [],
            },
        )

    @api_router.get("/api/projects/{project_id}/tasks/{task_id}")
    def get_task(project_id: str, task_id: str) -> dict[str, Any]:
        # Full shape for the UI; the task.get_state tool stays slim for the agent.
        return present(
            application.task(task_id=task_id, project_id=project_id, rich=True)
        )

    @api_router.get("/api/projects/{project_id}/tasks/{task_id}/status")
    def task_status(project_id: str, task_id: str) -> dict[str, Any]:
        return present(application.status(project_id=project_id, task_id=task_id))

    @api_router.post("/api/projects/{project_id}/tasks/{task_id}/transition")
    def transition_task(
        project_id: str,
        task_id: str,
        request: Request,
        body: JsonBody = Body(default=None),
    ) -> dict[str, Any]:
        payload = path_scoped_body(body, project_id=project_id)
        return gateway.call_http(
            request,
            name="task.transition",
            arguments={
                "project_id": project_id,
                "task_id": task_id,
                "transition": payload.get("transition") or "",
                "evidence": payload.get("evidence"),
            },
        )

    return api_router


__all__ = ["build_router"]
