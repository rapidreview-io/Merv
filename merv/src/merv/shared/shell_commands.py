"""POSIX one-liners an agent runs verbatim, and the quoting they need."""

from __future__ import annotations

# Direct in-process calls lack the caller-reachable base injected by HTTP.
LOCAL_API_BASE = "http://127.0.0.1:8787"


def shell_quote(value: str) -> str:
    """Quote one POSIX shell argument."""
    return "'" + value.replace("'", "'\\''") + "'"


def api_base(base_url: str) -> str:
    return (base_url or LOCAL_API_BASE).rstrip("/")


def curl_upload_command(*, base_url: str, path: str, route: str) -> str:
    """``curl -T`` a local file at one of this brain's one-time upload routes."""
    url = api_base(base_url) + route
    return f"curl -sf -T {shell_quote(path)} {shell_quote(url)}"
