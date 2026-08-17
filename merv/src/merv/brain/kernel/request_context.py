"""Request-scoped correlation identity, readable from any call depth.

The HTTP middleware mints a request id and resolves a principal long before a
call reaches the tool dispatcher, and neither travels in the tool signature.
A contextvar carries them instead: asyncio tasks and anyio's worker threads
both copy the ambient context when they are created, so a value set in
middleware is still visible inside a threadpool-run tool handler.

Foundation-level on purpose — both the delivery middleware that sets it and
the record-layer ledger that reads it may reach here.
"""

from __future__ import annotations

from contextlib import suppress
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Who is calling and under which request, for telemetry attribution.

    ``agent_id`` names the agent context window (one model conversation) the
    call came from — the short id minted by ``agent.hello`` — and
    ``mcp_session_id`` the MCP transport session it rode in on. Both are
    empty for HTTP/UI calls and for MCP calls that never identified.
    """

    request_id: str = ""
    principal_id: str = ""
    agent_id: str = ""
    mcp_session_id: str = ""


_EMPTY = RequestContext()
_CURRENT: ContextVar[RequestContext] = ContextVar(
    "merv_request_context", default=_EMPTY
)


def current_request_context() -> RequestContext:
    """The ambient correlation identity; empty outside an HTTP request."""
    return _CURRENT.get()


def begin_request(*, request_id: str) -> Token[RequestContext]:
    """Open a correlation scope. Pass the token back to ``reset_request``."""
    return _CURRENT.set(RequestContext(request_id=request_id))


def bind_principal(*, principal_id: str) -> None:
    """Name the caller once authentication has resolved it, same request."""
    _CURRENT.set(replace(_CURRENT.get(), principal_id=principal_id))


def bind_agent(*, agent_id: str = "", mcp_session_id: str = "") -> None:
    """Name the agent context window (and transport session) behind this call.

    Bound by the tool gateway once the call's ``agent_id`` has been resolved,
    on the same thread that goes on to dispatch it, so the ledger writing the
    call's row — and the payload record beside it — sees the attribution.
    Empty values leave the current binding untouched.
    """
    current = _CURRENT.get()
    _CURRENT.set(
        replace(
            current,
            agent_id=agent_id or current.agent_id,
            mcp_session_id=mcp_session_id or current.mcp_session_id,
        )
    )


def reset_request(token: Token[RequestContext]) -> None:
    # A token minted in another Context cannot be reset; that is a torn-down
    # scope, not an error worth propagating out of a telemetry helper.
    with suppress(ValueError):
        _CURRENT.reset(token)


__all__ = [
    "RequestContext",
    "begin_request",
    "bind_agent",
    "bind_principal",
    "current_request_context",
    "reset_request",
]
