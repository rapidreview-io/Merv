"""Read-only infrastructure discovery for a project already authorized by middleware."""

from fastapi import APIRouter

from ....infrastructure import RemoteProviders


def build_router(*, providers: RemoteProviders) -> APIRouter:
    router = APIRouter()

    @router.get("/api/projects/{project_id}/sandbox-providers")
    def provider_overview(project_id: str) -> dict[str, object]:
        return providers.overview(project_id=project_id)

    return router
