"""Experiments HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request

from ....application import Application
from .shared import JsonBody, path_scoped_body

from .gateway import ToolInvocationGateway


def build_router(
    gateway: ToolInvocationGateway,
    *,
    application: Application,
) -> APIRouter:
    api_router = APIRouter()

    @api_router.get("/api/projects/{project_id}/experiments")
    def list_experiments(project_id: str, status: str | None = None) -> dict[str, Any]:
        items = application.experiments(project_id=project_id, rich=True)
        if status:
            items = [item for item in items if item.get("status") == status]
        return {"experiments": items}

    @api_router.post("/api/projects/{project_id}/experiments", status_code=201)
    def create_experiment(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = path_scoped_body(body, project_id=project_id)
        return gateway.call_http(
            request,
            name="experiment.create",
            arguments={
                "project_id": project_id,
                "name": payload.get("name") or "",
                "intent": payload.get("intent")
                or payload.get("title")
                or payload.get("question")
                or "",
                "tested_claim_ids": payload.get("tested_claim_ids")
                or payload.get("claim_ids")
                or [],
            },
        )

    @api_router.get("/api/projects/{project_id}/experiments/{experiment_id}")
    def get_experiment(project_id: str, experiment_id: str) -> dict[str, Any]:
        # Full shape for the UI; the experiment.get_state tool stays slim for the agent.
        return application.experiment(
            experiment_id=experiment_id,
            project_id=project_id,
            rich=True,
        )

    @api_router.get("/api/projects/{project_id}/experiments/{experiment_id}/status")
    def experiment_status(project_id: str, experiment_id: str) -> dict[str, Any]:
        # Full shape for the UI (see home()); the tool stays slim for the agent.
        return application.status(project_id=project_id, experiment_id=experiment_id)

    @api_router.get("/api/projects/{project_id}/experiments/{experiment_id}/graph")
    def experiment_logic_graph(project_id: str, experiment_id: str) -> dict[str, Any]:
        # Agent-authored logic graph (role 'graph'); UI-only read, no agent tool.
        return application.experiment_graph(
            project_id=project_id, experiment_id=experiment_id
        )

    @api_router.post(
        "/api/projects/{project_id}/experiments/{experiment_id}/transition"
    )
    def transition_experiment(
        project_id: str,
        experiment_id: str,
        request: Request,
        body: JsonBody = Body(default=None),
    ) -> dict[str, Any]:
        return gateway.call_http(
            request,
            name="experiment.transition",
            arguments=path_scoped_body(
                body,
                project_id=project_id,
                experiment_id=experiment_id,
            ),
        )

    return api_router
