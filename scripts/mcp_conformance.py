#!/usr/bin/env python3
"""Platform-neutral MCP conformance probe for a Merv brain.

Every agent platform — Claude Code, Codex, Cursor, Replit, OpenHands, claude.ai —
reaches the brain the same way: a Streamable-HTTP MCP client speaking JSON-RPC to
``POST /mcp`` with an ``mk_`` bearer key (project- or account-scoped), or the
OAuth 2.1 browser flow. This
script exercises that exact wire with nothing but the standard library, so a green
run here is the same signal any platform's MCP client would see.

Usage:
    # Anonymous half only (discovery + auth challenge) — no key needed:
    python3 scripts/mcp_conformance.py

    # Full keyed loop against the hosted brain:
    MERV_MCP_KEY=mk_... python3 scripts/mcp_conformance.py

    # Point at a local or self-hosted brain:
    python3 scripts/mcp_conformance.py --base http://127.0.0.1:8787

Exit code is 0 only when every attempted check passes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

MCP_PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "merv-conformance-probe", "version": "1"}

# RFC 8414 / 9728 fields a compliant OAuth MCP client relies on to self-register
# (DCR) and run PKCE without any pre-shared secret.
REQUIRED_AS_FIELDS = (
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "code_challenge_methods_supported",
)
REQUIRED_PR_FIELDS = ("resource", "authorization_servers")


class Checks:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def ok(self, label: str, detail: str = "") -> None:
        self.passed += 1
        print(f"  \033[32mPASS\033[0m {label}" + (f" — {detail}" if detail else ""))

    def fail(self, label: str, detail: str = "") -> None:
        self.failed += 1
        print(f"  \033[31mFAIL\033[0m {label}" + (f" — {detail}" if detail else ""))


def _post_mcp(base: str, payload: dict, key: str | None) -> tuple[int, dict | None, dict]:
    """POST one JSON-RPC message to /mcp; parse a JSON or SSE result body."""
    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        # Streamable HTTP may answer either way; accept both.
        "Accept": "application/json, text/event-stream",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(f"{base}/mcp", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, _parse_result(raw), _lower_headers(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, None, _lower_headers(exc.headers)


def _lower_headers(headers) -> dict:
    """Flatten HTTP headers to a lower-cased dict (HTTP header names are
    case-insensitive; the wire capitalization varies by server/proxy)."""
    return {k.lower(): v for k, v in (headers or {}).items()}


def _parse_result(raw: str) -> dict | None:
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("{"):
        return json.loads(raw)
    # SSE framing: take the last `data:` line.
    for line in reversed(raw.splitlines()):
        if line.startswith("data:"):
            return json.loads(line[len("data:"):].strip())
    return None


def _get_json(url: str) -> tuple[int, dict | None]:
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, None


def anonymous_checks(base: str, c: Checks) -> None:
    print("\nAnonymous surface (the OAuth native-connect path — no key needed)")

    status, as_meta = _get_json(f"{base}/.well-known/oauth-authorization-server")
    if status == 200 and as_meta:
        missing = [f for f in REQUIRED_AS_FIELDS if f not in as_meta]
        if missing:
            c.fail("RFC 8414 authorization-server metadata", f"missing {missing}")
        elif "S256" not in (as_meta.get("code_challenge_methods_supported") or []):
            c.fail("RFC 8414 PKCE", "S256 not advertised")
        else:
            c.ok("RFC 8414 authorization-server metadata", "DCR + PKCE(S256) advertised")
    else:
        c.fail("RFC 8414 authorization-server metadata", f"HTTP {status}")

    status, pr_meta = _get_json(f"{base}/.well-known/oauth-protected-resource/mcp")
    if status == 200 and pr_meta and all(f in pr_meta for f in REQUIRED_PR_FIELDS):
        c.ok("RFC 9728 protected-resource metadata", f"resource={pr_meta['resource']}")
    else:
        c.fail("RFC 9728 protected-resource metadata", f"HTTP {status}")

    # An unauthenticated tools/list must be refused with the RFC 9728 challenge
    # so any MCP client can discover how to authenticate.
    status, _, headers = _post_mcp(
        base, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, key=None
    )
    challenge = headers.get("www-authenticate", "")
    if status == 401 and "resource_metadata" in challenge:
        c.ok("Unauthenticated /mcp challenge", "401 + WWW-Authenticate resource_metadata")
    elif status == 401:
        c.fail("Unauthenticated /mcp challenge", "401 but no resource_metadata hint")
    elif status in (200, 400):
        c.ok("Unauthenticated /mcp (auth-off brain)", f"HTTP {status} — local/open mode")
    else:
        c.fail("Unauthenticated /mcp challenge", f"HTTP {status}")


def keyed_checks(base: str, key: str, c: Checks) -> None:
    print("\nKeyed loop (the wire every bundled platform uses)")

    status, result, _ = _post_mcp(
        base,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": CLIENT_INFO,
            },
        },
        key,
    )
    server = (result or {}).get("result", {}).get("serverInfo", {})
    if status == 200 and server.get("name") == "merv":
        c.ok("initialize", f"serverInfo merv v{server.get('version')}")
    else:
        c.fail("initialize", f"HTTP {status}; body={result}")
        return

    status, result, _ = _post_mcp(
        base, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, key
    )
    tools = (result or {}).get("result", {}).get("tools", [])
    if status == 200 and tools:
        c.ok("tools/list", f"{len(tools)} tools visible")
    else:
        c.fail("tools/list", f"HTTP {status}; body={result}")
        return

    # How an agent learns a project id. A project-scoped key answers with its
    # one binding; an account-scoped key has no single "current", so it lists.
    status, result, _ = _post_mcp(
        base,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "project", "arguments": {"action": "current"}},
        },
        key,
    )
    project_id = _tool_field(result, "project", "id") or _tool_field(result, None, "project_id")
    if status == 200 and project_id:
        c.ok("project(current)", f"bound project {project_id}")
    elif status == 200:
        projects = _tool_field(result, None, "projects") or []
        if projects:
            project_id = str(projects[0].get("id") or "")
            c.ok("project(list)", f"{len(projects)} reachable; using {project_id}")
        else:
            c.fail("project(list)", f"no reachable projects; body={_short(result)}")
            return
    else:
        c.fail("project(current)", f"HTTP {status}; body={_short(result)}")
        return

    # The first thing a real agent does with that id.
    status, result, _ = _post_mcp(
        base,
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "workflow.status_and_next",
                "arguments": {"project_id": project_id},
            },
        },
        key,
    )
    if status == 200 and not (result or {}).get("error"):
        c.ok("workflow.status_and_next(project_id)", "explicit project scope accepted")
    else:
        c.fail("workflow.status_and_next(project_id)", f"HTTP {status}; body={_short(result)}")


def _tool_field(result: dict | None, obj: str | None, field: str):
    """Dig a field out of a tools/call structured result, tolerant of shape."""
    payload = (result or {}).get("result", {})
    for block in payload.get("content", []) if isinstance(payload, dict) else []:
        text = block.get("text") if isinstance(block, dict) else None
        if not text:
            continue
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            continue
        scope = data.get(obj) if obj else data
        if isinstance(scope, dict) and field in scope:
            return scope[field]
    sc = payload.get("structuredContent") if isinstance(payload, dict) else None
    if isinstance(sc, dict):
        scope = sc.get(obj) if obj else sc
        if isinstance(scope, dict):
            return scope.get(field)
    return None


def _short(result: dict | None) -> str:
    return (json.dumps(result)[:200] + "…") if result else "<empty>"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        default=os.environ.get("MERV_CONTROL_URL", "https://experiments.rapidreview.io"),
        help="Brain origin (no trailing /mcp). Default: the hosted brain.",
    )
    args = parser.parse_args(argv)
    base = args.base.rstrip("/")
    key = os.environ.get("MERV_MCP_KEY")

    print(f"MCP conformance probe → {base}")
    c = Checks()
    anonymous_checks(base, c)
    if key:
        keyed_checks(base, key, c)
    else:
        print("\nKeyed loop skipped — export MERV_MCP_KEY to run it.")

    print(f"\n{c.passed} passed, {c.failed} failed")
    return 1 if c.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
