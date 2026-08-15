"""HTTP routes for device-code pairing of auto-run runner machines.

Two routes are unauthenticated by design — the runner has no credential yet
when it asks for a code, and it polls for the outcome with the 256-bit
``device_code`` it alone holds. The approval route is owner-only, exactly like
minting a project key, because that is what it does.
"""

from __future__ import annotations

from typing import Any, Protocol

from fastapi import APIRouter, Body, Request

from ....kernel.utils import ValidationError
from ...identity import (
    HumanSessionRequiredError,
    is_human_session,
    principal_label,
)
from ...runner_pairing import RunnerPairings
from .shared import JsonBody

PAIRING_CREATE_PATH = "/api/agent-runners/pairing"
PAIRING_TOKEN_PATH = "/api/agent-runners/pairing/token"
# Prefix the request authenticator exempts; both unauthenticated routes live
# under it and nothing else does.
PAIRING_PUBLIC_PREFIX = "/api/agent-runners/pairing"


class ProjectGate(Protocol):
    """The one gateway capability approval needs: project membership."""

    def authorize_project(self, request: Request, project_id: str) -> None: ...


def build_router(*, pairings: RunnerPairings, gateway: ProjectGate) -> APIRouter:
    router = APIRouter()

    @router.post(PAIRING_CREATE_PATH, status_code=201)
    def create_pairing(request: Request, body: JsonBody = Body(default=None)) -> dict[str, Any]:
        payload = dict(body or {})
        machine = payload.get("machine")
        return pairings.create(
            key_digest=str(payload.get("key_digest") or ""),
            runner_id=str(payload.get("runner_id") or ""),
            machine=machine if isinstance(machine, dict) else None,
            client_ip=_client_ip(request),
        )

    @router.post(PAIRING_TOKEN_PATH)
    def pairing_token(body: JsonBody = Body(default=None)) -> dict[str, Any]:
        payload = dict(body or {})
        return pairings.token(device_code=str(payload.get("device_code") or ""))

    @router.post("/api/projects/{project_id}/agent-runners/pairings/approve")
    def approve_pairing(
        project_id: str, request: Request, body: JsonBody = Body(default=None)
    ) -> dict[str, Any]:
        gateway.authorize_project(request, project_id)
        principal = request.state.principal
        if not is_human_session(principal):
            raise HumanSessionRequiredError(
                "runner pairing approval requires a Supabase browser session"
            )
        payload = dict(body or {})
        user_code = payload.get("user_code")
        if not isinstance(user_code, str):
            raise ValidationError("user_code is required", details={"field": "user_code"})
        return pairings.approve(
            project_id=project_id,
            user_code=user_code,
            owner_user_id=str(getattr(principal, "user_id", "") or ""),
            principal_label=principal_label(principal),
        )

    return router


def _client_ip(request: Request) -> str:
    client = getattr(request, "client", None)
    return str(getattr(client, "host", "") or "")


__all__ = ["PAIRING_PUBLIC_PREFIX", "build_router"]
