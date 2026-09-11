"""Artifact HTTP routes: token-bearer uploads plus UI reads.

The PUT routes are auth-exempt (see RequestAuthenticator): the one-time upload
token minted by artifact.upload is the credential, so the agent's bare
``curl -T`` works against both local and hosted brains.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ....artifacts import CompletedFigure
from ....research_core import ResearchArtifacts as Artifacts
from ....kernel.utils import NotFoundError
from ...artifacts import (
    artifact_list_v1,
    completed_artifact_v1,
    completed_figure_v1,
    content_envelope_v1,
)
from ..request_body import payload_too_large, read_capped_body

_RAW_CONTENT_HEADERS = {
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
}


def build_router(*, artifacts: Artifacts) -> APIRouter:
    api_router = APIRouter()

    def read_artifact(project_id: str, artifact_id: str):
        return artifacts.resolve(
            project_id=project_id, artifact_ids=(artifact_id,), include="document"
        )[0]

    async def upload(token: str, request: Request, *, kind: str) -> Any:
        # Token first: an unknown token 404s before any body byte is buffered,
        # and the body is capped at the token's own ceiling before completion.
        cap = artifacts.upload_cap(token=token, kind=kind)
        data = await read_capped_body(request, cap=cap)
        if data is None:
            return payload_too_large(cap, hint=(
                "for this token — slim the file (move raw data/outputs elsewhere and reference them)"
            ))
        completed = artifacts.complete_upload(token=token, kind=kind, data=data)
        if isinstance(completed, CompletedFigure):
            return completed_figure_v1(completed)
        return completed_artifact_v1(completed, base_url=str(request.base_url).rstrip("/"))

    @api_router.put("/api/artifacts/u/{token}")
    async def upload_artifact(token: str, request: Request) -> Any:
        return await upload(token, request, kind="artifact")

    @api_router.put("/api/artifacts/f/{token}")
    async def upload_figure(token: str, request: Request) -> Any:
        return await upload(token, request, kind="figure")

    @api_router.get("/api/projects/{project_id}/artifacts")
    def list_artifacts(
        project_id: str,
        target_type: str = "",
        target_id: str = "",
        role: str = "",
    ) -> dict[str, Any]:
        return artifact_list_v1(
            artifacts.scan(
                project_id=project_id,
                target_type=target_type,
                target_ids=(target_id,) if target_id else (),
                roles=(role,) if role else (),
            )
        )

    @api_router.get("/api/projects/{project_id}/artifacts/{artifact_id}/content")
    def artifact_content(project_id: str, artifact_id: str) -> dict[str, Any]:
        return content_envelope_v1(read_artifact(project_id, artifact_id))

    @api_router.get("/api/projects/{project_id}/artifacts/{artifact_id}/file")
    def artifact_file(project_id: str, artifact_id: str) -> Response:
        artifact = read_artifact(project_id, artifact_id)
        if artifact.data is None:
            if artifact.status == "complete":
                raise NotFoundError(
                    "blob not found: "
                    f"{artifact.project_id}/{artifact.sha256}"
                )
            raise NotFoundError(
                f"artifact has no submitted content: {artifact_id}"
            )
        filename = (artifact.path or artifact_id).rsplit("/", 1)[-1]
        return Response(
            content=artifact.data,
            media_type=(
                artifact.content_type or "application/octet-stream"
            ),
            headers={
                **_RAW_CONTENT_HEADERS,
                "Content-Disposition": _content_disposition(filename),
            },
        )

    @api_router.get("/api/projects/{project_id}/artifacts/{artifact_id}/figure")
    def artifact_figure(project_id: str, artifact_id: str, rel: str) -> Response:
        data = artifacts.figure(
            project_id=project_id,
            artifact_id=artifact_id,
            link_path=rel,
        )
        if data is None:
            return JSONResponse(
                {"detail": f"figure not found: {rel}", "error_code": "not_found"},
                status_code=404,
            )
        return Response(
            content=data, media_type="application/octet-stream", headers=_RAW_CONTENT_HEADERS
        )

    return api_router


def _content_disposition(filename: str) -> str:
    if all(32 <= ord(char) < 127 and char not in {'"', "\\"} for char in filename):
        return f'inline; filename="{filename}"'
    return f"inline; filename*=UTF-8''{quote(filename, safe='')}"
