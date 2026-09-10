"""Namespace and transport contract used by Merv's infrastructure facades."""

from __future__ import annotations

import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Protocol

from ..kernel.utils import ValidationError


_subject: ContextVar[str | None] = ContextVar("infrastructure_subject", default=None)


@contextmanager
def infrastructure_actor(subject: str | None):
    token = _subject.set(subject or None)
    try:
        yield
    finally:
        _subject.reset(token)


def project_namespace(project_id: str) -> str:
    # This is the local project reference. The HTTP client resolves its explicit
    # remote namespace from connection configuration; prefixes convey no authority.
    if not re.fullmatch(r"[a-z0-9_-]{1,50}", project_id):
        raise ValidationError("invalid project id for infrastructure namespace")
    return project_id


class InfrastructureTransport(Protocol):
    def request(self, method: str, path: str, *, namespace: str,
                json: Any = None, params: Any = None) -> dict[str, Any]: ...

    def request_bytes(self, method: str, path: str, *, namespace: str,
                      params: Any = None) -> tuple[bytes, dict[str, str]]: ...

    def health(self) -> dict[str, Any]: ...

    def close(self) -> None: ...
