"""Read-only provider discovery; infrastructure administration belongs to its owner UI."""

from __future__ import annotations

from contextlib import closing
from typing import Any

from ..kernel.state import BaseStateStore
from .ports import InfrastructureTransport, project_namespace
from .persistence import INFRASTRUCTURE_SCHEMA


class RemoteProviders:
    def __init__(self, *, client: InfrastructureTransport | None, store: BaseStateStore) -> None:
        self.client, self._store = client, store
        store.install(INFRASTRUCTURE_SCHEMA)

    def overview(self, *, project_id: str) -> dict[str, Any]:
        with closing(self._store.connect()) as conn:
            pid = self._store.require_project_id(conn=conn, project_id=project_id)
        if self.client is None:
            return {"providers": [], "configured": False, "management_url": None}
        catalog = self.client.request("GET", "/providers", namespace=project_namespace(pid))
        providers = [{
            "provider": row["name"], "plugin": row["plugin"], "label": row["name"],
            "health": row.get("health") or {}, "credential_source": row.get("source"),
        } for row in catalog.get("providers", [])]
        return {"providers": providers, "configured": True,
                "management_url": (str(self.client.url).rstrip("/") + "/ui/settings") if getattr(self.client, "url", None) else None,
                "infrastructure": "merv-sandboxes"}


__all__ = ["RemoteProviders"]
