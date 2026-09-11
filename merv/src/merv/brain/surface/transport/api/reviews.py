"""Reviews HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Request

from ....application.reviews import present_review_recovery
from ....research_core import Research
from .shared import JsonBody, path_scoped_body

from .gateway import ToolInvocationGateway


def build_router(gateway: ToolInvocationGateway, *, research: Research) -> APIRouter:
    api_router = APIRouter()

    @api_router.get("/api/projects/{project_id}/reviews")
    def reviews(
        project_id: str,
        request: Request,
        target_type: str = "experiment",
        target_id: str | None = None,
    ) -> dict[str, Any]:
        if not target_id:
            return present_review_recovery(research.reviews.queue(project_id=project_id))
        return gateway.call_http(
            request,
            name="review.status",
            arguments={
                "project_id": project_id,
                "target_type": target_type,
                "target_id": target_id,
            },
        )

    @api_router.post("/api/projects/{project_id}/reviews/request", status_code=201)
    def request_review(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        return gateway.call_http(
            request,
            name="review.request",
            arguments=path_scoped_body(body, project_id=project_id),
        )

    @api_router.post("/api/projects/{project_id}/reviews/start")
    def start_review(
        project_id: str,
        request: Request,
        body: JsonBody = Body(default=None),
    ) -> dict[str, Any]:
        payload = body or {}
        research.assert_review_in_project(
            project_id=project_id,
            review_request_id=payload.get("review_request_id"),
        )
        return gateway.call_http(
            request,
            name="review.start",
            arguments=payload,
            project_scope=project_id,
        )

    @api_router.post("/api/projects/{project_id}/reviews/submit")
    def submit_review(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        payload = body or {}
        research.assert_review_in_project(
            project_id=project_id,
            review_session_id=payload.get("review_session_id"),
        )
        return gateway.call_http(
            request, name="review.submit", arguments=payload
        )

    return api_router
