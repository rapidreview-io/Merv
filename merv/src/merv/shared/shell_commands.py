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
    """``curl -T`` a local file at one of this brain's one-time upload routes.

    The reply body prints either way: the receipt (its id) on success, the
    server's reason on failure — never a bare exit 22.
    """
    url = api_base(base_url) + route
    return f"curl -sS --fail-with-body -T {shell_quote(path)} {shell_quote(url)}"
