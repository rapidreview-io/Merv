"""Storage HTTP routes: the service-backed object API and completion tokens."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from ....infrastructure import RemoteObjects
from ....kernel.utils import NotFoundError


def build_router(*, storage: RemoteObjects | None) -> APIRouter:
    api_router = APIRouter()

    def storage_for_project(project_id: str) -> RemoteObjects:
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        return storage

    @api_router.get("/api/storage/u/{token}")
    def storage_upload_target(token: str) -> dict[str, Any]:
        # The one-time URL is the credential. Service part URLs are minted only
        # when the client is ready to stream a multipart upload.
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        return storage.upload_target_via_token(token=token)

    @api_router.post("/api/storage/u/{token}/complete")
    def complete_storage_upload(
        token: str, body: dict[str, Any] | None = Body(default=None)
    ) -> dict[str, Any]:
        # Auth-exempt (see RequestAuthenticator): the one-time completion token
        # minted by storage.submit is the whole credential. Token-first — an
        # unknown/expired/used token 404s before any object work — and
        # single-use. Completing asks merv-sandboxes to verify the bytes, then
        # activates Research's association for the object.
        if storage is None:
            raise NotFoundError("storage is not enabled on this backend")
        payload = body or {}
        return storage.complete_via_token(token=token, parts=payload.get("parts"))

    @api_router.get("/api/projects/{project_id}/storage")
    def list_storage(
        project_id: str,
        status: str | None = None,
        name: str | None = None,
    ) -> dict[str, Any]:
        # select_one=False: ``name`` filters the listing here, it does not
        # resolve one object the way the agent-facing storage.find does.
        return storage_for_project(project_id).find(
            project_id=project_id, status=status, name=name, select_one=False
        )

    @api_router.get("/api/projects/{project_id}/storage/{object_id}")
    def get_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).get_object(
            project_id=project_id, object_id=object_id
        )

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/download")
    def download_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).find(
            project_id=project_id, object_id=object_id, include_download=True
        )

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/pin")
    def pin_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return {"object": storage_for_project(project_id).manage(
            project_id=project_id, object_id=object_id, action="pin"
        )}

    @api_router.post("/api/projects/{project_id}/storage/{object_id}/renew")
    def renew_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return {"object": storage_for_project(project_id).manage(
            project_id=project_id, object_id=object_id, action="renew"
        )}

    @api_router.delete("/api/projects/{project_id}/storage/{object_id}")
    def delete_storage_object(project_id: str, object_id: str) -> dict[str, Any]:
        return storage_for_project(project_id).manage(
            project_id=project_id, object_id=object_id, action="delete"
        )

    return api_router
