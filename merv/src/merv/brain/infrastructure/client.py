"""Authenticated, namespace-scoped transport to merv-sandboxes.

Merv consumes the public infrastructure API with sandbox-issued grants.
Budget policy, accounting, and administration remain entirely in the service.
"""

from __future__ import annotations

import re
import json as json_module
from pathlib import Path
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import httpx

from .ports import _subject, infrastructure_actor, project_namespace
from ..kernel.env import env_value
from ..kernel.utils import NotFoundError, ValidationError
from merv.shared.errors import PermissionDeniedError, ResearchPluginError, ThrottledError


class InfrastructureUnavailableError(ResearchPluginError):
    error_code = "infrastructure_unavailable"
    http_status = 503



class InfrastructureClient:
    def __init__(
        self, *, url: str, connections: Mapping[str, Mapping[str, str]],
        transport: httpx.BaseTransport | None = None
    ) -> None:
        parsed = urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValidationError("MERV_SANDBOXES_URL must be an HTTP(S) origin")
        self.url = url.rstrip("/")
        self._connections = {}
        self._validated_connections: set[str] = set()
        for project_id, entry in connections.items():
            if (not isinstance(project_id, str) or not isinstance(entry, Mapping)
                    or set(entry) - {"namespace", "token"}
                    or not isinstance(entry.get("namespace"), str)
                    or not isinstance(entry.get("token"), str)
                    or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", entry["namespace"])
                    or not re.fullmatch(r"sbxt_[A-Za-z0-9_-]+", entry["token"])):
                raise ValidationError("invalid infrastructure connection; expected project, namespace and consumer token")
            project_namespace(project_id)
            self._connections[project_id] = dict(entry)
        self._http = httpx.Client(
            base_url=self.url + "/v1/", timeout=httpx.Timeout(60, connect=10),
            transport=transport, follow_redirects=False,
        )

    def namespace_for_project(self, project_id: str) -> str:
        connection = self._connections.get(project_namespace(project_id))
        if connection is None:
            raise ValidationError("project has no authorized infrastructure connection")
        return connection["namespace"]

    def _response(
        self, method: str, path: str, *, namespace: str,
        json: Any = None, params: Any = None,
    ) -> httpx.Response:
        connection = self._connections.get(namespace)
        if connection is None:
            raise ValidationError("project has no authorized infrastructure connection")
        if (not path.startswith("/") or path.startswith("//") or ":" in path
                or "\\" in path or ".." in path or "?" in path or "#" in path):
            raise ValidationError("invalid infrastructure API path")
        if path != "/auth/me" and namespace not in self._validated_connections:
            # Validate before the first resource request. The service rechecks
            # revocation and selectors on every call; token roles are immutable.
            identity = self.request("GET", "/auth/me", namespace=namespace)
            if identity.get("role") != "consumer" or identity.get("namespace") != connection["namespace"]:
                raise PermissionDeniedError("Merv requires a consumer grant for the configured namespace")
            self._validated_connections.add(namespace)
        headers = {"Authorization": "Bearer " + connection["token"],
                   "X-Sandbox-Namespace": connection["namespace"]}
        if _subject.get():
            headers["X-Sandbox-Subject"] = _subject.get()
        try:
            response = self._http.request(
                method, path.lstrip("/"), json=json, params=params,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise InfrastructureUnavailableError(
                "merv-sandboxes is unavailable; retry the operation",
                details={"retryable": True},
            ) from exc
        if response.is_error:
            try:
                error = response.json().get("error", {})
            except (ValueError, AttributeError):
                error = {}
            code = str(error.get("code", "")) if isinstance(error, dict) else ""
            known_codes = {"validation", "authentication", "authorization", "not_found",
                           "capacity_unavailable", "provider_unavailable", "idempotency_conflict",
                           "operation_state", "rate_limited", "configuration", "internal"}
            code = code if code in known_codes else "request_failed"
            # Do not return upstream response bodies or signed URLs to callers.
            details = {"upstream_code": code, "status": response.status_code,
                       "retryable": response.status_code >= 500 or response.status_code == 429}
            policy = error.get("details", {}) if isinstance(error, dict) else {}
            if isinstance(policy, dict) and policy.get("reason") in {
                "budget_exceeded", "spending_suspended", "unpriced_offer",
                "concurrency_exceeded", "lifetime_exceeded", "hourly_price_exceeded",
                "attribution_unresolved", "usage_unresolved", "provider_disabled",
            }:
                details["reason"] = policy["reason"]
            cls = ({404: NotFoundError, 401: PermissionDeniedError,
                    403: PermissionDeniedError, 429: ThrottledError}.get(response.status_code)
                   or (InfrastructureUnavailableError if response.status_code >= 500 else ValidationError))
            raise cls(f"merv-sandboxes {code or 'request_failed'} (HTTP {response.status_code})",
                      details=details)
        return response

    def request(self, method: str, path: str, *, namespace: str,
                json: Any = None, params: Any = None) -> dict[str, Any]:
        response = self._response(method, path, namespace=namespace, json=json, params=params)
        if response.status_code == 204:
            return {}
        try:
            result = response.json()
        except ValueError as exc:
            raise InfrastructureUnavailableError("invalid response from merv-sandboxes") from exc
        if not isinstance(result, dict):
            raise InfrastructureUnavailableError("invalid response from merv-sandboxes")
        return result

    def request_bytes(self, method: str, path: str, *, namespace: str,
                      params: Any = None) -> tuple[bytes, dict[str, str]]:
        response = self._response(method, path, namespace=namespace, params=params)
        return response.content, dict(response.headers)

    def health(self) -> dict[str, Any]:
        try:
            response = self._http.get(self.url + "/healthz")
            response.raise_for_status()
            if response.json().get("status") != "ok":
                raise InfrastructureUnavailableError("infrastructure health is degraded")
        except (ResearchPluginError, httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "backend": "merv-sandboxes", "error": str(exc)}
        return {"ok": True, "backend": "merv-sandboxes"}

    def close(self) -> None:
        self._http.close()


def build_infrastructure_client(env: Mapping[str, str] | None = None) -> InfrastructureClient | None:
    url = env_value("MERV_SANDBOXES_URL", env=env)
    config_file = env_value("MERV_SANDBOXES_CONNECTIONS_FILE", env=env)
    if not url and not config_file:
        return None
    if not url or not config_file:
        raise ValidationError("MERV_SANDBOXES_URL and MERV_SANDBOXES_CONNECTIONS_FILE must be set together")
    try:
        connections = json_module.loads(Path(config_file).read_text())
    except (OSError, ValueError) as exc:
        raise ValidationError("cannot read infrastructure connections file") from exc
    if not isinstance(connections, dict):
        raise ValidationError("infrastructure connections file must map project IDs to connection records")
    return InfrastructureClient(url=url, connections=connections)
