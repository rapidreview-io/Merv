"""Authenticated, namespace-scoped transport to merv-sandboxes.

Merv signs short-lived service credentials only after its own project access
checks. Provider secrets, VM access keys, and object-store credentials never
enter this process.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import httpx
import jwt

from .ports import project_namespace
from ..kernel.env import env_value
from ..kernel.utils import NotFoundError, ValidationError
from merv.shared.errors import PermissionDeniedError, ResearchPluginError, ThrottledError


class InfrastructureUnavailableError(ResearchPluginError):
    error_code = "infrastructure_unavailable"



class InfrastructureClient:
    def __init__(
        self, *, url: str, secret: str, transport: httpx.BaseTransport | None = None
    ) -> None:
        parsed = urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValidationError("MERV_SANDBOXES_URL must be an HTTP(S) origin")
        if len(secret.encode()) < 32:
            raise ValidationError("MERV_SANDBOXES_JWT_SECRET must contain at least 32 bytes")
        self.url = url.rstrip("/")
        self._secret = secret
        self._http = httpx.Client(
            base_url=self.url + "/v1/", timeout=httpx.Timeout(60, connect=10),
            transport=transport, follow_redirects=False,
        )

    def _response(
        self, method: str, path: str, *, namespace: str,
        json: Any = None, params: Any = None, budget: dict[str, Any] | None = None,
    ) -> httpx.Response:
        if not re.fullmatch(r"merv-[a-z0-9_-]{1,58}", namespace):
            raise ValidationError("invalid infrastructure namespace")
        if (not path.startswith("/") or path.startswith("//") or ":" in path
                or "\\" in path or ".." in path or "?" in path or "#" in path):
            raise ValidationError("invalid infrastructure API path")
        now = int(time.time())
        claims = {"iss": "merv", "aud": "merv-sandboxes", "sub": "merv-control",
                  "namespace": namespace, "iat": now, "exp": now + 120}
        if budget is not None:
            claims["merv_budget"] = budget
        token = jwt.encode(
            claims,
            self._secret, algorithm="HS256",
        )
        try:
            response = self._http.request(
                method, path.lstrip("/"), json=json, params=params,
                headers={"Authorization": "Bearer " + token},
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
            if isinstance(policy, dict) and policy.get("reason") == "merv_daily_budget_exceeded":
                details["reason"] = "merv_daily_budget_exceeded"
                if policy.get("scope") in {"provider_payer", "project_provider"}:
                    details["scope"] = policy["scope"]
                for field in ("cap_usd", "accrued_and_reserved_usd", "requested_lease_usd"):
                    value = policy.get(field)
                    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}(?:\.[0-9]{1,30})?", value):
                        details[field] = value
            cls = ({404: NotFoundError, 401: PermissionDeniedError,
                    403: PermissionDeniedError, 429: ThrottledError}.get(response.status_code)
                   or (InfrastructureUnavailableError if response.status_code >= 500 else ValidationError))
            raise cls(f"merv-sandboxes {code or 'request_failed'} (HTTP {response.status_code})",
                      details=details)
        return response

    def request(self, method: str, path: str, *, namespace: str,
                json: Any = None, params: Any = None,
                budget: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self._response(method, path, namespace=namespace, json=json, params=params, budget=budget)
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
            self.request("GET", "/providers", namespace="merv-control")
        except ResearchPluginError as exc:
            return {"ok": False, "backend": "merv-sandboxes", "error": str(exc)}
        return {"ok": True, "backend": "merv-sandboxes"}

    def close(self) -> None:
        self._http.close()


def build_infrastructure_client(env: Mapping[str, str] | None = None) -> InfrastructureClient | None:
    url = env_value("MERV_SANDBOXES_URL", env=env)
    secret = env_value("MERV_SANDBOXES_JWT_SECRET", env=env)
    if not url and not secret:
        return None
    if not url or not secret:
        raise ValidationError("MERV_SANDBOXES_URL and MERV_SANDBOXES_JWT_SECRET must be set together")
    return InfrastructureClient(url=url, secret=secret)
