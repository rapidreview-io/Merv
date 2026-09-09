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
from ....research_core import ResearchArtifacts as Artifacts, CompletedArtifact
from ....kernel.utils import NotFoundError, ValidationError
from ...artifacts import (
    artifact_list_v1,
    completed_artifact_v1,
    completed_figure_v1,
    content_envelope_v1,
)

_RAW_CONTENT_HEADERS = {
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
}


def _too_large(cap: int) -> JSONResponse:
    return JSONResponse(
        {
            "detail": (
                f"upload exceeds the maximum of {cap} bytes for this token — slim "
                "the file (move raw data/outputs elsewhere and reference them) "
                "and re-run the upload command"
            ),
            "error_code": "payload_too_large",
            "max_bytes": cap,
        },
        status_code=413,
    )


async def _read_capped(request: Request, *, cap: int) -> bytes | None:
    """Body bytes, or None once the cap is exceeded (never buffers past it)."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > cap:
        return None
    data = bytearray()
    async for chunk in request.stream():
        # INV-6: reject on the PROJECTED size before extending, so one huge ASGI
        # chunk is never allocated past the cap (mirrors request_body.py).
        if len(data) + len(chunk) > cap:
            return None
        data.extend(chunk)
    return bytes(data)


def build_router(*, artifacts: Artifacts) -> APIRouter:
    api_router = APIRouter()

    def read_artifact(project_id: str, artifact_id: str):
        found = artifacts.get(
            project_id=project_id, artifact_ids=(artifact_id,), include="document"
        ) or artifacts.contents.get(
            project_id=project_id, artifact_ids=(artifact_id,), include="document"
        )
        if not found:
            raise NotFoundError(
                f"artifact not found in project {project_id}: {artifact_id}"
            )
        return found[0]

    @api_router.put("/api/artifacts/u/{token}")
    async def upload_artifact(token: str, request: Request) -> Any:
        # Token first: an unknown token 404s before any body byte is buffered.
        cap = artifacts.upload_cap(token=token, kind="artifact")
        data = await _read_capped(request, cap=cap)
        if data is None:
            return _too_large(cap)
        try:
            completed = artifacts.complete_upload(
                token=token,
                kind="artifact",
                data=data,
            )
        except ValidationError as exc:
            if "max_bytes" in exc.details:
                return JSONResponse(
                    {"detail": exc.message, "error_code": "payload_too_large", **exc.details},
                    status_code=413,
                )
            raise
        if not isinstance(completed, CompletedArtifact):
            raise TypeError("artifact upload returned a figure result")
        return completed_artifact_v1(
            completed,
            base_url=str(request.base_url).rstrip("/"),
        )

    @api_router.put("/api/artifacts/f/{token}")
    async def upload_figure(token: str, request: Request) -> Any:
        cap = artifacts.upload_cap(token=token, kind="figure")
        data = await _read_capped(request, cap=cap)
        if data is None:
            return _too_large(cap)
        try:
            completed = artifacts.complete_upload(
                token=token,
                kind="figure",
                data=data,
            )
        except ValidationError as exc:
            if "max_bytes" in exc.details:
                return JSONResponse(
                    {"detail": exc.message, "error_code": "payload_too_large", **exc.details},
                    status_code=413,
                )
            raise
        if not isinstance(completed, CompletedFigure):
            raise TypeError("figure upload returned an artifact result")
        return completed_figure_v1(completed)

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
            data = artifacts.contents.figure(
                project_id=project_id, artifact_id=artifact_id, link_path=rel
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
