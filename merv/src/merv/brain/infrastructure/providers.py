"""Browser provider setup delivered to the independent infrastructure service."""

from __future__ import annotations

from contextlib import closing
import math
from typing import Any
from urllib.parse import quote

from ..kernel.utils import NotFoundError, ValidationError
from ..kernel.state import BaseStateStore
from .ports import InfrastructureTransport, project_namespace


class RemoteProviders:
    def __init__(self, *, client: InfrastructureTransport | None, store: BaseStateStore) -> None:
        self.client = client
        self._store = store

    def _call(self, method: str, path: str, *, project_id: str, **kwargs: Any) -> dict[str, Any]:
        with closing(self._store.connect()) as conn:
            pid = self._store.require_project_id(conn=conn, project_id=project_id)
        if self.client is None:
            raise ValidationError("merv-sandboxes is not configured")
        return self.client.request(method, path, namespace=project_namespace(pid), **kwargs)

    @staticmethod
    def _entry(plugin: dict[str, Any], instance: dict[str, Any] | None = None) -> dict[str, Any]:
        instance = instance or {}
        configured = bool(instance)
        health = instance.get("health") or {}
        # Saved secrets never enter Merv. Replacing a connection requires the
        # complete credential set because the remote PUT replaces, not merges.
        fields = [{"key": field["name"], "label": field["name"].replace("_", " ").title(),
                   "help": field.get("description", ""), "required": field.get("required", True),
                   "secret": field.get("secret", True), "multiline": False,
                   "set": False, "value": "", "placeholder": ""}
                  for field in plugin.get("credential_fields", [])]
        source = instance.get("source")
        return {
            "provider": instance.get("name") or plugin["name"], "plugin": plugin["name"],
            "label": (instance.get("name") or plugin["name"]).replace("_", " ").replace("-", " ").title(),
            "note": plugin.get("help", ""), "console_url": plugin.get("docs_url", ""),
            "fields": fields, "enabled": configured, "connected": configured,
            "setup_complete": configured, "env_configured": source == "host",
            "platform_available": source == "host", "platform_label": "shared infrastructure credentials",
            "credential_mode": "platform" if source == "host" else "own",
            "credential_source": "platform" if source == "host" else "saved" if configured else None,
            "daily_usd_limit": None, "verified_at": instance.get("verified_at") or "",
            "in_env_fleet": configured, "fleet_default": False, "updated_at": "",
            "health": health, "supports_enabled_toggle": True, "supports_daily_limit": True,
            "can_disconnect": configured and source != "host",
            "credentials_replace": True, "infrastructure": "merv-sandboxes",
        }

    def overview(self, *, project_id: str) -> dict[str, Any]:
        if self.client is None:
            with closing(self._store.connect()) as conn:
                self._store.require_project_id(conn=conn, project_id=project_id)
            return {"providers": [], "default": "", "infrastructure": "merv-sandboxes", "configured": False}
        data = self._call("GET", "/providers", project_id=project_id)
        instances = data.get("providers", [])
        plugins = {plugin["name"]: plugin for plugin in data.get("plugins", [])}
        rows = [self._entry(plugins.get(instance["plugin"], {"name": instance["plugin"]}), instance)
                for instance in instances]
        used = {instance["plugin"] for instance in instances}
        rows.extend(self._entry(plugin) for name, plugin in plugins.items() if name not in used)
        saved = {row["provider"]: row for row in self._store.list_sandbox_provider_settings(project_id=project_id)}
        for entry in rows:
            policy = saved.get(self._policy_provider(entry))
            if policy:
                entry["enabled"] = bool(policy["enabled"])
                entry["daily_usd_limit"] = policy["daily_usd_limit"]
        return {"providers": rows, "default": "", "infrastructure": "merv-sandboxes", "configured": True}

    @staticmethod
    def _policy_provider(entry: dict[str, Any]) -> str:
        return "lambda_labs" if entry["plugin"] == "lambda" else entry["plugin"]

    def _find(self, *, project_id: str, provider: str) -> dict[str, Any]:
        found = next((entry for entry in self.overview(project_id=project_id)["providers"]
                      if entry["provider"] == provider), None)
        if found is None:
            raise NotFoundError("provider not found")
        return found

    def set_credentials(self, *, project_id: str, provider: str,
                        values: dict[str, str] | None = None, mode: str | None = None) -> dict[str, Any]:
        entry = self._find(project_id=project_id, provider=provider)
        if mode == "platform" and entry["platform_available"]:
            return entry
        if mode not in {None, "own"}:
            raise ValidationError("provider credentials are configured in merv-sandboxes; supply the complete credential fields")
        values = values or {}
        if not isinstance(values, dict) or any(not isinstance(value, str) for value in values.values()):
            raise ValidationError("provider values must be a string-to-string object")
        if not values and entry["setup_complete"]:
            return entry
        allowed = {field["key"] for field in entry["fields"]}
        if set(values) - allowed:
            raise ValidationError("unknown provider credential field")
        required = {field["key"] for field in entry["fields"] if field["required"]}
        if any(not values.get(key, "").strip() for key in required):
            raise ValidationError("supply every required credential field when replacing the connection")
        self._call("PUT", "/providers/" + quote(provider, safe=""), project_id=project_id,
                   json={"plugin": entry["plugin"], "fields": values})
        return self._find(project_id=project_id, provider=provider)

    def verify(self, *, project_id: str, provider: str) -> dict[str, Any]:
        entry = self._find(project_id=project_id, provider=provider)
        health = entry["health"]
        return {"provider": entry, "ok": bool(entry["setup_complete"] and health.get("status") == "ok"),
                "detail": health.get("message") or "Provider health reported by merv-sandboxes."}

    def disconnect(self, *, project_id: str, provider: str) -> dict[str, Any]:
        entry = self._find(project_id=project_id, provider=provider)
        if not entry["can_disconnect"]:
            raise ValidationError("this provider is managed by the infrastructure deployment")
        self._call("DELETE", "/providers/" + quote(provider, safe=""), project_id=project_id)
        return self.overview(project_id=project_id)

    def set_enabled(self, *, project_id: str, provider: str, enabled: bool) -> dict[str, Any]:
        entry = self._find(project_id=project_id, provider=provider)
        if enabled and not entry["setup_complete"]:
            raise ValidationError("connect this provider before enabling compute")
        self._store.upsert_sandbox_provider_settings(
            project_id=project_id, provider=self._policy_provider(entry), enabled=bool(enabled),
        )
        return self._find(project_id=project_id, provider=provider)

    def set_daily_limit(self, *, project_id: str, provider: str, daily_usd_limit: float | None) -> dict[str, Any]:
        entry = self._find(project_id=project_id, provider=provider)
        if daily_usd_limit is not None:
            try:
                daily_usd_limit = float(daily_usd_limit)
            except (TypeError, ValueError) as exc:
                raise ValidationError("daily_usd_limit must be a number") from exc
            if not math.isfinite(daily_usd_limit) or daily_usd_limit < 0:
                raise ValidationError("daily_usd_limit must be a finite nonnegative number")
        self._store.set_sandbox_provider_daily_limit(
            project_id=project_id, provider=self._policy_provider(entry), daily_usd_limit=daily_usd_limit,
        )
        return self._find(project_id=project_id, provider=provider)

    def ensure_provider_allowed(self, *, project_id: str, provider: str) -> None:
        entry = self._find(project_id=project_id, provider=provider)
        if not entry["setup_complete"] or not entry["enabled"]:
            raise ValidationError("connect the provider in merv-sandboxes before requesting compute")


__all__ = ["RemoteProviders"]
