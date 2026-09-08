"""Namespace and transport contract used by Merv's infrastructure facades."""

from __future__ import annotations

import re
from typing import Any, Protocol

from ..kernel.utils import ValidationError


def project_namespace(project_id: str) -> str:
    if not re.fullmatch(r"[a-z0-9_-]{1,50}", project_id):
        raise ValidationError("invalid project id for infrastructure namespace")
    return "merv-project-" + project_id


class InfrastructureTransport(Protocol):
    def request(self, method: str, path: str, *, namespace: str,
                json: Any = None, params: Any = None,
                budget: dict[str, Any] | None = None) -> dict[str, Any]: ...

    def request_bytes(self, method: str, path: str, *, namespace: str,
                      params: Any = None) -> tuple[bytes, dict[str, str]]: ...

    def health(self) -> dict[str, Any]: ...

    def close(self) -> None: ...
