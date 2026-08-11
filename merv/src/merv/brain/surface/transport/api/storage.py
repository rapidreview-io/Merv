"""Storage HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from ....kernel.utils import NotFoundError
from ....object_storage import ObjectStorage

def build_router(*, storage: ObjectStorage | None) -> APIRouter:
    api_router = APIRouter()
    def storage_for_project(project_id: str) -> ObjectStorage:
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        return storage

    @api_router.get("/api/storage/u/{token}")
    def storage_upload_target(token: str) -> dict[str, Any]:
        # The one-time URL is the credential. Provider URLs are minted only
        # when the client is ready to stream a multipart upload.
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        return storage.upload_target_via_token(token=token)

    @api_router.post("/api/storage/u/{token}/complete")
    def complete_storage_upload(
        token: str, body: dict[str, Any] | None = Body(default=None)
    ) -> dict[str, Any]:
        # Auth-exempt (see RequestAuthenticator): the one-time
        # completion token minted by storage.submit is the whole credential.
        # Token-first — an unknown/expired/used token 404s before any object
        # work — and single-use. Server-side it runs the internal
        # complete_upload head-verify, so a key agent (barred from that internal
        # tool over MCP) still finalizes its direct-to-S3 upload.
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        payload = body or {}
        return storage.complete_via_token(token=token, parts=payload.get("parts"))

    @api_router.get("/api/projects/{project_id}/storage")
    def list_storage(
        project_id: str,
        kind: str | None = None,
        status: str | None = None,
        name: str | None = None,
        include_expired: bool = False,
    ) -> dict[str, Any]:
        return storage_for_project(project_id).list_objects(
            project_id=project_id,
            kind=kind,
            status=status,
            name=name,
            include_expired=include_expired,
        )

    @api_router.get("/api/projects/{project_id}/storage/{object_id}")
    def get_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).get_object(
            project_id=project_id, object_id=object_id
        )

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/download")
    def download_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).resolve(
            project_id=project_id, object_id=object_id, include_download=True
        )

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/pin")
    def pin_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return {"object": storage_for_project(project_id).pin(
            project_id=project_id, object_id=object_id
        )}

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/unpin")
    def unpin_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return {"object": storage_for_project(project_id).unpin(
            project_id=project_id, object_id=object_id
        )}

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/renew")
    def renew_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return {"object": storage_for_project(project_id).renew(
            project_id=project_id, object_id=object_id
        )}

    @api_router.delete("/api/projects/{project_id}/storage/{object_id}")
    def delete_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).delete(
            project_id=project_id, object_id=object_id
        )


    return api_router
