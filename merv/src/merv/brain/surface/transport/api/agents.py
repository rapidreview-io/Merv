"""Operator routes over agent context-window identities and their traces.

Mounted under ``/api/admin`` on purpose: a trace is everything one model
conversation sent to and received from Merv, across every project it touched,
so it is operator diagnostics — hosted callers present ``MERV_ADMIN_TOKEN``
(the gateway's global-mutator boundary), the loopback brain keeps open access.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from ...agent_identity import AgentIdentities


def build_router(*, identities: AgentIdentities) -> APIRouter:
    router = APIRouter()

    @router.get("/api/admin/agents")
    def list_agents(
        user_id: str | None = None,
        limit: int = Query(100, ge=1, le=1000),
    ) -> dict[str, Any]:
        """Identities newest first, each with call count and activity span."""
        return identities.list(user_id=user_id, limit=limit)

    @router.get("/api/admin/agents/{agent_id}")
    def agent_trace(
        agent_id: str,
        limit: int = Query(200, ge=1, le=2000),
        after_id: int | None = Query(None, ge=0),
        payloads: bool = False,
    ) -> dict[str, Any]:
        """One agent's calls in order; ``payloads=true`` inlines each call's
        redacted request/response record (what the agent sent, what it got)."""
        return identities.trace(
            agent_id=agent_id, limit=limit, after_id=after_id, payloads=payloads
        )

    return router


__all__ = ["build_router"]
