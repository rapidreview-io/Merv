"""Reflections HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ....application import Application, LogicGraphQuery
from ....application.reflections import present_reflection_overview
from ....research_core import Research


def build_router(
    *, application: Application, research: Research, graphs: LogicGraphQuery
) -> APIRouter:
    api_router = APIRouter()

    @api_router.get("/api/projects/{project_id}/reflections")
    def list_reflections(project_id: str) -> dict[str, Any]:
        # Reflection waves + staleness/coverage signal for the UI panel.
        return present_reflection_overview(
            research.reflection_overview(project_id=project_id)
        )

    @api_router.get("/api/projects/{project_id}/reflections/current/graph")
    def project_logic_graph(project_id: str) -> dict[str, Any]:
        # The living project logic graph; same payload shape as the
        # per-experiment graph endpoint. UI-only read, no agent tool.
        return graphs.project(project_id=project_id)

    @api_router.get("/api/projects/{project_id}/reflections/{reflection_id}/graph")
    def reflection_graph(project_id: str, reflection_id: str) -> dict[str, Any]:
        # One wave's logic graph, rendered from the bytes that wave pinned, so
        # a past wave shows faithfully even after later waves overwrite the
        # living file. Same payload shape as /reflections/current/graph (minus
        # signal). Registered after the literal current/graph route so
        # "current" is not captured as a reflection_id. UI-only read.
        return graphs.reflection_graph(
            project_id=project_id, reflection_id=reflection_id
        )

    @api_router.get("/api/projects/{project_id}/reflections/{reflection_id}")
    def get_reflection(project_id: str, reflection_id: str) -> dict[str, Any]:
        return application.reflection(
            project_id=project_id, reflection_id=reflection_id
        )

    @api_router.get(
        "/api/projects/{project_id}/reflections/{reflection_id}/consolidation"
    )
    def get_consolidation(project_id: str, reflection_id: str) -> dict[str, Any]:
        return application.consolidation(
            project_id=project_id,
            reflection_id=reflection_id,
        )

    return api_router
