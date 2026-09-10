"""Shared HTTP API response helpers and CORS policy constants."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import urllib.parse
from collections.abc import Callable
from contextlib import suppress
from typing import Any, Protocol

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response

from ....kernel.env import env_value
from ....kernel.request_context import bind_principal
from ....kernel.utils import ValidationError
from ...identity import (
    HumanSessionRequiredError, is_human_session, is_local_principal,
    principal_label,
)

ADMIN_TOKEN_ENV_VAR = "MERV_ADMIN_TOKEN"
ADMIN_TOKEN_HEADER = "X-Admin-Token"

# Version handshake. Clients stamp their version on this header; a MISSING
# header is tolerated (a client may predate the handshake, and refusing it would
# strand in-flight upgrades), so only an explicitly-too-old version is refused.
# The floors are plain constants bumped by hand when a wire change makes an
# older client unsafe to serve — the point is that a breaking change has a
# refusal mechanism instead of a confusing partial failure.
CLIENT_VERSION_HEADER = "X-RP-Client-Version"
# 0.0014 fences clients that predate reflection consolidation: an older client
# would try to publish directly from reflection_review and strand the wave.
MIN_PROXY_VERSION = "0.0014"
# Bump only when the agent-facing MCP catalog changes incompatibly. Unlike the
# retired proxy catalogs, this is a deployment-drift signal, not a file digest.
MCP_CATALOG_VERSION = "2026-09-10"

JsonBody = dict[str, Any] | None
UI_CORS_HEADERS = [
    "Content-Type",
    "Accept",
    "Authorization",
    CLIENT_VERSION_HEADER,
    "If-None-Match",
]
# ETag is not CORS-safelisted; expose it so a cross-origin dev UI can echo it back.
UI_CORS_EXPOSE_HEADERS = ["ETag"]

# Upload tokens are bearer credentials living in the URL path; the activity log
# must never persist them. Shared choke-point across every auth-exempt token
# route (INV-12): artifact document/figure PUTs, feed-media PUTs, and the
# storage completion POST.
_UPLOAD_TOKEN_PATH_RE = re.compile(r"(/api/(?:artifacts/[uf]|feed/u|storage/u)/)[^/?]+")
# The run-wait tag is the same kind of credential in the same place: keep the
# sandbox and the label (they name the run a log line is about), mask the tag.
_WAIT_SIGNATURE_PATH_RE = re.compile(r"(/wait/[^/?]+/[^/?]+/)[^/?]+")


def redact_upload_tokens(path: str) -> str:
    return _WAIT_SIGNATURE_PATH_RE.sub(
        r"\1<redacted>", _UPLOAD_TOKEN_PATH_RE.sub(r"\1<redacted>", path)
    )


def path_scoped_body(body: JsonBody, **scope: str) -> dict[str, Any]:
    """Bind route identifiers after parsing a body, rejecting contradictions."""
    payload = dict(body or {})
    conflicts = [
        field
        for field, value in scope.items()
        if field in payload and payload[field] != value
    ]
    if conflicts:
        raise ValidationError(
            "request body scope does not match route",
            details={"fields": conflicts},
        )
    payload.update(scope)
    return payload


def _json_body(payload: Any) -> bytes:
    """Serialize exactly like FastAPI's default JSON path for these handlers."""
    body = json.dumps(
        jsonable_encoder(payload),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return body


def _matches(request: Request, *, etag: str) -> bool:
    if_none_match = request.headers.get("if-none-match") or ""
    return etag in [tag.strip() for tag in if_none_match.split(",")]


def _signal_etag(*parts: object) -> str:
    raw = "\0".join(str(part) for part in parts).encode("utf-8")
    return f'"{hashlib.sha256(raw).hexdigest()[:32]}"'


def conditional_json(request: Request, payload: Any) -> Response:
    """ETag/304 wrapper for body-hash endpoints.

    Serializes exactly like FastAPI's default path (jsonable_encoder +
    compact json.dumps) so 200 bodies stay byte-identical for clients that
    never send If-None-Match; the ETag is a content hash of those bytes.
    """
    body = _json_body(payload)
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if _matches(request, etag=etag):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


def conditional_json_from_signal(
    request: Request,
    *,
    signal_parts: tuple[object, ...],
    payload: Callable[[], Any],
) -> Response:
    """ETag/304 wrapper for endpoints with a proven monotonic change signal."""
    etag = _signal_etag(*signal_parts)
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if _matches(request, etag=etag):
        return Response(status_code=304, headers=headers)
    return Response(
        content=_json_body(payload()), media_type="application/json", headers=headers
    )


def is_local_origin(origin: str) -> bool:
    host = (urllib.parse.urlsplit(origin).hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1")


_PROJECT_PATH_RE = re.compile(r"^/api/projects/([^/]+)")


class RefusalLedger(Protocol):
    """Durable sink for calls refused before the dispatcher ever sees them."""

    def reject(self, **kwargs: Any) -> None: ...


class CallLedger(RefusalLedger, Protocol):
    """...plus the outcome sink for a call answered outside the dispatcher."""

    def record(self, **kwargs: Any) -> None: ...


def _denial_facts(response: Response) -> tuple[str, str]:
    """(error_code, detail) of an already-rendered denial body, if it has one."""
    try:
        payload = json.loads(bytes(getattr(response, "body", b"") or b"{}"))
    except (TypeError, ValueError):
        return "", ""
    if not isinstance(payload, dict):
        return "", ""
    return str(payload.get("error_code") or ""), str(payload.get("detail") or "")


def bind_request_principal(
    request: Request, *, denied: Response | None, open_mode: bool = False
) -> None:
    """Name the caller for this request's telemetry.

    Call this BEFORE ``call_next``, and on the event loop: the identity is a
    contextvar, and only the layers entered after it is bound — routes, the
    tool dispatcher, the ledger itself — inherit it. ``open_mode`` is hosted
    deployment WITHOUT a verifier: every caller there carries the local
    sentinel by default, so an undenied request is an anonymous remote one and
    is named ``open``. ``local`` stays reserved for genuine local deployment.
    """
    principal = getattr(request.state, "principal", None)  # unset on OPTIONS
    # A refusal that never authenticated still leaves the local sentinel on
    # request.state; that is the default, not evidence of a local caller.
    authenticated = getattr(request.state, "authenticated", False)
    unnamed = not authenticated and (denied is not None or open_mode)
    bind_principal(principal_id="open" if unnamed else principal_label(principal))


def ledger_refusal(
    request: Request, *, denied: Response, ledger: RefusalLedger | None
) -> None:
    """Durable row for a request the auth boundary short-circuited.

    Such a request never reaches the dispatcher, so this is its only chance at
    the record; source and project scope come off the path, since no tool
    contract resolved to supply them. Blocking work — run it off the loop.
    """
    if ledger is None:
        return
    path = request.url.path
    match = _PROJECT_PATH_RE.match(path)
    error_code, detail = _denial_facts(denied)
    with suppress(Exception):  # telemetry never turns a 401 into a 500
        ledger.reject(
            source="mcp" if path == "/mcp" or path.startswith("/mcp/") else "http",
            error_code=error_code or f"http_{denied.status_code}",
            error=detail or f"request refused with {denied.status_code}",
            project_id=match.group(1) if match else (request.query_params.get("project_id") or ""),
        )


def ledger_tool_refusal(
    ledger: RefusalLedger | None,
    *,
    tool: str,
    source: str,
    project_id: str,
    exc: BaseException,
) -> None:
    """Durable row for a gateway pre-flight refusal (INV-5/INV-11 and friends).

    These denials — repo_root, membership, the key project-create block, a
    contract that will not validate — are raised before any dispatcher runs, so
    without this the durable record would show nothing at all for a call the
    caller definitely made.
    """
    if ledger is None:
        return
    with suppress(Exception):  # telemetry never breaks the refusal it observes
        ledger.reject(
            tool=tool,
            source=source,
            project_id=project_id,
            error_code=str(getattr(exc, "error_code", "") or "unexpected"),
            error=str(getattr(exc, "message", "") or exc),
        )


# Global mutators/aggregates gated behind the operator token in hosted mode.
GLOBAL_MUTATOR_PREFIXES = ("/api/admin", "/api/debug/tool-calls/clear")


def _operator_token_ok(request: Request) -> bool:
    token = env_value(ADMIN_TOKEN_ENV_VAR) or ""
    supplied = request.headers.get(ADMIN_TOKEN_HEADER, "")
    return bool(token) and hmac.compare_digest(supplied, token)


def operator_denial(request: Request) -> JSONResponse | None:
    """Gate a GLOBAL operator mutator/aggregate (INV-11 FIX 1). LOCAL_PRINCIPAL
    (local mode, no verifier) is the trusted operator and keeps access; any
    hosted caller — even a JWT owner — must present MERV_ADMIN_TOKEN on the
    X-Admin-Token header (constant-time). An unset token in hosted mode denies
    everyone, so the prod cleanup cron must send the token."""
    if is_local_principal(getattr(request.state, "principal", None)):
        return None
    if _operator_token_ok(request):
        return None
    return JSONResponse(
        {"detail": "operator token required", "error_code": "operator_forbidden"},
        status_code=403,
    )


# The two routes that rewrite who belongs to a project.
_MEMBERSHIP_MUTATION_ROUTES = {
    "POST": re.compile(r"^/api/projects/[^/]+/members$"),
    "DELETE": re.compile(r"^/api/projects/[^/]+/members/[^/]+$"),
}


def operator_membership_recovery(request: Request) -> bool:
    """Whether MERV_ADMIN_TOKEN may pass the membership gate on this request.

    An orphaned project — one whose last member predates the last-member rule —
    is unreachable through the hosted API: the gateway answers 404 for a
    non-member before the route's own author check can see the admin token, so
    the operator's documented recovery path never runs. This buys back exactly
    the two membership-mutation routes and nothing else; every other route
    still 404s for a non-member, token or not.
    """
    route = _MEMBERSHIP_MUTATION_ROUTES.get(request.method)
    return bool(route and route.match(request.url.path)) and _operator_token_ok(request)


def require_membership_author(request: Request) -> None:
    """Only a human (or the operator) may change who belongs to a project.

    A machine credential can drive every research tool, but membership is the
    root of project reach: a key that adds or removes members can hand the
    project away, or empty it (audit AUTH-01). The trusted-local sentinel keeps
    access — local mode has no accounts at all — and MERV_ADMIN_TOKEN stays the
    operator's recovery path.
    """
    principal = getattr(request.state, "principal", None)
    if is_human_session(principal) or is_local_principal(principal):
        return
    if _operator_token_ok(request):
        return
    raise HumanSessionRequiredError(
        "changing project membership requires a signed-in user; share the "
        "project from the Merv UI (API keys cannot add or remove members)"
    )


def open_hosted_operator_denial(request: Request) -> JSONResponse | None:
    """Operator gate for hosted control mode WITHOUT a verifier (OPEN mode).

    Open mode has no trusted principal — downstream code labels callers
    LOCAL_PRINCIPAL — so global mutators require the operator token
    unconditionally; there is no local bypass here.
    """
    if not request.url.path.startswith(GLOBAL_MUTATOR_PREFIXES):
        return None
    if _operator_token_ok(request):
        return None
    return JSONResponse(
        {"detail": "operator token required", "error_code": "operator_forbidden"},
        status_code=403,
    )


def _version_tuple(version: str) -> tuple[int, ...]:
    """Parse a dotted numeric version to a comparable tuple.

    Lenient: non-numeric segments contribute 0 so a malformed version sorts low
    (and is therefore refused against any real floor) rather than raising.
    """
    parts: list[int] = []
    for segment in str(version).strip().split("."):
        try:
            parts.append(int(segment))
        except ValueError:
            parts.append(0)
    return tuple(parts) or (0,)


def is_below_floor(*, client_version: str, floor: str) -> bool:
    """True when ``client_version`` is strictly older than ``floor``."""
    return _version_tuple(client_version) < _version_tuple(floor)
