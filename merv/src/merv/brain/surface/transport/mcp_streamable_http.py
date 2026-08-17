"""JSON-RPC 2.0 framing for the stateless MCP streamable-HTTP transport.

``POST /mcp`` speaks the streamable-HTTP MCP transport: ``initialize``,
``notifications/initialized``, ``tools/list`` and ``tools/call`` (with SSE
progress for slow calls). The transport is STATELESS — every request is
authenticated on its own bearer by the request middleware and no session
state gates a request. ``Mcp-Session-Id`` is minted at initialize and merely
RECORDED (with the client's declared name/version) so agent identities and
ledger rows can name the transport session they rode in on; a request without
it is never refused. The catalog is ``tool_visible_over_mcp AND not hidden``
with no profile filter, and every tool but ``agent.hello`` advertises the
required ``agent_id`` argument the gateway lifts out before dispatch; internal
tools 403 for any non-local caller (enforced in the tool dispatcher and mapped
back to a 403 here).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any, Protocol

from fastapi import FastAPI, Header, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ... import __version__
from ...kernel.utils import NotFoundError, ResearchPluginError, ValidationError
from ..agent_identity import HELLO_TOOL
from ..identity import (
    LOCAL_PRINCIPAL,
    ProjectKeyScopeError,
    ToolVisibilityError,
    is_local_principal,
    principal_label,
)
from ..tools.contracts import TOOL_MANIFEST
from .request_body import RequestBodyTooLarge, read_limited_body


MCP_PROTOCOL_VERSION = "2025-06-18"

# Sent in the initialize result. This is the only orientation a client with no
# repo and no skills files ever sees -- claude.ai, Codex cloud, and Replit read
# the wire and nothing else -- so the multi-project convention has to live here
# rather than in AGENTS.md.
SERVER_INSTRUCTIONS = (
    "Merv is a research-suite backend. Work is organized into projects, and "
    "one credential may reach several of them.\n\n"
    "Before anything else, call agent.hello once: it returns the short "
    "agent_id that identifies THIS context window to Merv. Pass that "
    "agent_id in every other Merv call. Never reuse another context's id, "
    "and have each subagent call agent.hello itself. A call without a valid "
    "agent_id is refused with instructions.\n\n"
    'Then call project(action="list") when you do not already know which '
    "project the user means: it returns every project you can work in with "
    "its id, name, summary, and creation date. Most other tools require an "
    "explicit project_id, so carry the id from that list into each call. "
    "Never guess a project id.\n\n"
    'If your credential is bound to a single project, project(action="current") '
    "returns it and that id is the only one you may pass."
)

# The streamable-HTTP protocol revisions this stateless server actually speaks;
# initialize only ever negotiates MCP_PROTOCOL_VERSION, so that is the sole
# version served. A supplied-but-unsupported MCP-Protocol-Version header is a
# 400 (spec 2025-06-18); an absent header defaults to the negotiated version.
SUPPORTED_MCP_PROTOCOL_VERSIONS = frozenset({MCP_PROTOCOL_VERSION})
MAX_MCP_REQUEST_BODY_BYTES = 36_000_000
# Past this size the compact one-line result defeats every line-oriented reader
# on the agent side: Read cannot page a single giant line, and head/tail/grep
# see nothing. Indenting lands the top-level structure on its own lines.
PRETTY_RESULT_THRESHOLD_BYTES = 32 * 1024
_FAST_CALL_SECONDS = 0.05
_PROGRESS_INTERVAL_SECONDS = 10.0

JsonObject = dict[str, Any]
RequestId = str | int
ProgressToken = str | int

# The one argument every tool but agent.hello gains over MCP. Injected into the
# advertised schema here (not into the pydantic contracts, which forbid extras
# and whose handlers never want it) and lifted back out by the gateway.
AGENT_ID_PROPERTY: JsonObject = {
    "type": "string",
    "description": "This context window's agent_id from agent.hello.",
}


def with_agent_id_argument(
    tools: list[JsonObject], *, required: bool = True
) -> list[JsonObject]:
    """The catalog with ``agent_id`` advertised on every tool but agent.hello —
    as a required argument where the composition demands identity, as an
    optional one where it merely records it. Copies, never mutates, the
    dispatcher's schemas."""
    advertised: list[JsonObject] = []
    for tool in tools:
        if tool.get("name") == HELLO_TOOL:
            advertised.append(tool)
            continue
        schema = dict(tool.get("inputSchema") or {"type": "object"})
        properties = dict(schema.get("properties") or {})
        properties["agent_id"] = dict(AGENT_ID_PROPERTY)
        schema["properties"] = properties
        names = [
            name for name in list(schema.get("required") or []) if name != "agent_id"
        ]
        if required:
            names.append("agent_id")
        if names or "required" in schema:
            schema["required"] = names
        advertised.append({**tool, "inputSchema": schema})
    return advertised


async def read_limited_mcp_body(request: Request) -> bytes:
    """Read the MCP body capped at the transport ceiling (read at call time)."""
    return await read_limited_body(request, limit=MAX_MCP_REQUEST_BODY_BYTES)


class ToolCatalog(Protocol):
    def __call__(self) -> list[JsonObject]: ...


class ToolFilter(Protocol):
    def __call__(self, tool: JsonObject) -> bool: ...


class ToolCaller(Protocol):
    def __call__(
        self,
        name: str,
        arguments: JsonObject,
        context: JsonObject,
        request: Request,
    ) -> JsonObject: ...


class SessionRecorder(Protocol):
    """Told about each successful initialize: the minted session id, the
    principal it authenticated as, and what the client called itself."""

    def __call__(
        self,
        *,
        session_id: str,
        principal_id: str,
        client_name: str,
        client_version: str,
        protocol_version: str,
    ) -> None: ...


class Authorizer(Protocol):
    def __call__(self, authorization: str | None) -> None: ...


class RefusalLedger(Protocol):
    """Durable sink for JSON-RPC refusals issued before dispatch."""

    def reject(self, **kwargs: Any) -> None: ...


class ScopeAuthorizer(Protocol):
    """Resolves every pre-flight denial for a tool call (key-project equality,
    membership, key create block, review-derived scope), raising
    ProjectKeyScopeError / NotFoundError. Runs synchronously so a slow denial
    is a transport 403/404, never a mid-stream error."""

    def __call__(self, request: Request, name: str, arguments: dict[str, Any]) -> None: ...


def _is_request_id(value: object) -> bool:
    return isinstance(value, (str, int)) and not isinstance(value, bool)


def _request_id(payload: JsonObject) -> RequestId | None:
    value = payload.get("id")
    return value if _is_request_id(value) else None


def _result(request_id: RequestId, result: JsonObject) -> JsonObject:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(
    request_id: RequestId | None,
    code: int,
    message: str,
    data: JsonObject | None = None,
) -> JsonObject:
    error: JsonObject = {"code": code, "message": message}
    if data:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _json_response(
    payload: JsonObject, *, status_code: int = 200, headers: dict[str, str] | None = None
) -> JSONResponse:
    return JSONResponse(content=payload, status_code=status_code, headers=headers)


def _sse_message(payload: JsonObject) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: message\ndata: {encoded}\n\n"


def _tool_result(result: JsonObject) -> JsonObject:
    # Only the inner text gains newlines; the envelope escapes them, so SSE
    # framing is untouched.
    text = json.dumps(result, sort_keys=True)
    if len(text) > PRETTY_RESULT_THRESHOLD_BYTES:
        text = json.dumps(result, sort_keys=True, indent=1)
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": result,
    }


def tool_visible_over_mcp(*, name: str) -> bool:
    """Unknown tools retain the dispatcher's historical error handling."""
    contract = TOOL_MANIFEST.get(name)
    return contract is None or contract.visibility == "public"


def _protocol_version_denial(version: str | None) -> JSONResponse | None:
    """400 on a supplied-but-unsupported MCP-Protocol-Version; None otherwise
    (absent header defaults to the negotiated version, per the 2025-06-18 spec)."""
    if version is None or version in SUPPORTED_MCP_PROTOCOL_VERSIONS:
        return None
    return _json_response(
        _error(
            None,
            -32600,
            f"Unsupported MCP-Protocol-Version: {version}",
            {
                "error_code": "unsupported_protocol_version",
                "supported": sorted(SUPPORTED_MCP_PROTOCOL_VERSIONS),
            },
        ),
        status_code=400,
    )


# JSON-RPC codes rendered as the ledger's error_code vocabulary.
_PROTOCOL_ERROR_CODES = {
    -32700: "parse_error",
    -32600: "invalid_request",
    -32601: "method_not_found",
    -32602: "invalid_params",
    -32004: "request_too_large",
}


def _error_status(exc: BaseException | None) -> int:
    """Scope + internal-tool refusals surface as 403; everything else 200."""
    return 403 if isinstance(exc, (ProjectKeyScopeError, ToolVisibilityError)) else 200


def _dispatcher_error(request_id: RequestId, exc: Exception) -> JsonObject:
    if isinstance(exc, ResearchPluginError):
        code = (
            -32602
            if isinstance(exc, ValidationError) or exc.message.startswith("unknown tool:")
            else -32000
        )
        return _error(
            request_id,
            code,
            exc.message,
            {"error_code": exc.error_code, **exc.details},
        )
    return _error(request_id, -32603, "Internal error")


class McpStreamableHttp:
    """Stateless streamable-HTTP adapter around the shared tool collaborators."""

    def __init__(
        self,
        *,
        list_tools: ToolCatalog,
        call_tool: ToolCaller,
        allow_tool: ToolFilter | None,
        authorize: Authorizer | None,
        authorize_scope: ScopeAuthorizer | None = None,
        ledger: RefusalLedger | None = None,
        record_session: SessionRecorder | None = None,
        agent_identity: str | None = None,
    ) -> None:
        self._list_tools = list_tools
        self._call_tool = call_tool
        self._allow_tool = allow_tool
        self._authorize = authorize
        self._authorize_scope = authorize_scope
        self._ledger = ledger
        self._record_session = record_session
        # None: no agent identity wired (narrow compositions), catalog untouched.
        # "required" / "optional": the catalog advertises agent_id on every
        # tool but agent.hello, required or not accordingly.
        self._agent_identity = agent_identity

    async def _protocol_error(
        self,
        *,
        request_id: RequestId | None,
        code: int,
        message: str,
        data: JsonObject | None = None,
        status_code: int = 200,
        tool: str = "",
    ) -> JSONResponse:
        """One refusal issued before dispatch: the ledger row and the JSON-RPC
        response are minted together, so neither can be forgotten."""
        await self._ledger_reject(
            tool=tool,
            error_code=_PROTOCOL_ERROR_CODES.get(code, "protocol_error"),
            message=message,
        )
        return _json_response(_error(request_id, code, message, data), status_code=status_code)

    async def _ledger_reject(self, *, tool: str, error_code: str, message: str) -> None:
        """Durable refusal row, written OFF the event loop.

        A stalled database on a malformed-request storm would otherwise block
        every unrelated request behind these inserts.
        """
        if self._ledger is None:
            return
        with suppress(Exception):  # telemetry never breaks the transport
            await run_in_threadpool(
                self._ledger.reject,
                tool=tool, source="mcp", error_code=error_code, error=message,
            )

    def register(self, http: FastAPI) -> None:
        @http.post("/mcp")
        async def mcp_streamable_http(
            request: Request,
            authorization: str | None = Header(default=None),
            mcp_protocol_version: str | None = Header(default=None),
        ) -> Response:
            if self._authorize is not None:
                self._authorize(authorization)
            version_denial = _protocol_version_denial(mcp_protocol_version)
            if version_denial is not None:
                await self._ledger_reject(
                    tool="",
                    error_code="unsupported_protocol_version",
                    message=f"Unsupported MCP-Protocol-Version: {mcp_protocol_version}",
                )  # not a _protocol_error: the response shape is the module's
                return version_denial
            try:
                raw_body = await read_limited_mcp_body(request)
            except RequestBodyTooLarge as exc:
                return await self._protocol_error(
                    request_id=None,
                    code=-32004,
                    message=str(exc),
                    data={"error_code": "request_too_large", "max_body_bytes": exc.limit},
                    status_code=413,
                )
            try:
                payload = json.loads(raw_body)
            except (UnicodeDecodeError, ValueError):
                return await self._protocol_error(
                    request_id=None, code=-32700, message="Parse error", status_code=400
                )
            if not isinstance(payload, dict):
                return await self._protocol_error(
                    request_id=None,
                    code=-32600,
                    message="Invalid Request",
                    status_code=400,
                )
            return await self._handle(request=request, payload=payload)

    async def _handle(self, *, request: Request, payload: JsonObject) -> Response:
        if payload.get("jsonrpc") != "2.0":
            return await self._protocol_error(
                request_id=None, code=-32600, message="Invalid Request", status_code=400
            )

        has_id = "id" in payload
        request_id = _request_id(payload)
        if has_id and request_id is None:
            return await self._protocol_error(
                request_id=None, code=-32600, message="Invalid Request", status_code=400
            )

        method = payload.get("method")
        # A JSON-RPC response echoed back (no method, carries result/error) is
        # accepted and dropped: the stateless server issues no server->client
        # requests, so it never expects one.
        if method is None and has_id and ("result" in payload or "error" in payload):
            return Response(status_code=202)
        if not isinstance(method, str) or not method:
            return await self._protocol_error(
                request_id=None, code=-32600, message="Invalid Request", status_code=400
            )
        params = payload.get("params", {})
        if not isinstance(params, dict):
            response_id = request_id if has_id else None
            return await self._protocol_error(
                request_id=response_id,
                code=-32602,
                message="Invalid params",
                status_code=200 if has_id else 400,
                tool=method,
            )

        if method == "initialize":
            if not has_id or request_id is None:
                return await self._protocol_error(
                    request_id=None,
                    code=-32600,
                    message="Initialize must be a request",
                    status_code=400,
                    tool=method,
                )
            return await self._initialize(
                request=request, request_id=request_id, params=params
            )

        if method == "notifications/initialized":
            # Stateless: accept the handshake completion without tracking it.
            if has_id:
                return await self._protocol_error(
                    request_id=request_id,
                    code=-32600,
                    message="Initialized must be a notification",
                    tool=method,
                )
            return Response(status_code=202)

        if not has_id or request_id is None:
            # Notifications never receive a JSON-RPC response; unknown ones are
            # accepted and ignored (no response channel to report on).
            return Response(status_code=202)

        if method == "ping":
            # Spec liveness probe: an empty result echoing the request id.
            return _json_response(_result(request_id, {}))
        if method == "tools/list":
            return await self._tools_list(request_id=request_id, params=params)
        if method == "tools/call":
            return await self._tools_call(
                request=request, request_id=request_id, params=params
            )
        return await self._protocol_error(
            request_id=request_id,
            code=-32601,
            message=f"Method not found: {method}",
            tool=method,
        )

    async def _initialize(
        self, *, request: Request, request_id: RequestId, params: JsonObject
    ) -> JSONResponse:
        requested_version = params.get("protocolVersion")
        capabilities = params.get("capabilities")
        client_info = params.get("clientInfo")
        if (
            not isinstance(requested_version, str)
            or not requested_version
            or not isinstance(capabilities, dict)
            or not isinstance(client_info, dict)
            or not isinstance(client_info.get("name"), str)
            or not isinstance(client_info.get("version"), str)
        ):
            # Through _protocol_error like every other refusal: a handshake the
            # server rejected is exactly the kind of thing that must leave a
            # trace, and its 200 JSON-RPC shape is unchanged.
            return await self._protocol_error(
                request_id=request_id,
                code=-32602,
                message="Invalid initialize params",
                tool="initialize",
            )
        session_id = uuid.uuid4().hex
        if self._record_session is not None:
            # Off the loop, and never fatal: the handshake is not gated on the
            # record, the record just lets a later agent.hello name the client.
            principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
            with suppress(Exception):
                await run_in_threadpool(
                    self._record_session,
                    session_id=session_id,
                    principal_id=principal_label(principal),
                    client_name=str(client_info.get("name") or ""),
                    client_version=str(client_info.get("version") or ""),
                    protocol_version=str(requested_version),
                )
        return _json_response(
            _result(
                request_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "merv", "version": __version__},
                    "instructions": SERVER_INSTRUCTIONS,
                },
            ),
            # Minted here, recorded above, echoed back by conformant clients on
            # every later request; never required.
            headers={"Mcp-Session-Id": session_id},
        )

    def _catalog(self) -> list[JsonObject]:
        tools = self._list_tools()
        if self._allow_tool is not None:
            tools = [tool for tool in tools if self._allow_tool(tool)]
        visible = [
            tool
            for tool in tools
            if tool_visible_over_mcp(name=str(tool.get("name") or ""))
            and not tool.get("hidden")
        ]
        if self._agent_identity is None:
            return visible
        return with_agent_id_argument(
            visible, required=self._agent_identity == "required"
        )

    async def _tools_list(
        self, *, request_id: RequestId, params: JsonObject
    ) -> JSONResponse:
        cursor = params.get("cursor")
        if cursor is not None:
            return await self._protocol_error(
                request_id=request_id,
                code=-32602,
                message="Invalid cursor",
                tool="tools/list",
            )
        return _json_response(_result(request_id, {"tools": self._catalog()}))

    async def _tools_call(
        self, *, request: Request, request_id: RequestId, params: JsonObject
    ) -> Response:
        name = params.get("name")
        arguments = params.get("arguments", {})
        if not isinstance(name, str) or not name:
            return await self._protocol_error(
                request_id=request_id, code=-32602, message="Tool name is required"
            )
        if not isinstance(arguments, dict):
            return await self._protocol_error(
                request_id=request_id,
                code=-32602,
                message="Tool arguments must be an object",
                tool=name,
            )
        progress_token, token_error = self._progress_token(params)
        if token_error is not None:
            return await self._protocol_error(
                request_id=request_id, code=-32602, message=token_error, tool=name
            )
        denied = await self._preauthorize(
            name=name, arguments=arguments, request=request, request_id=request_id
        )
        if denied is not None:
            return denied

        task = asyncio.create_task(
            run_in_threadpool(self._call_tool, name, arguments, {}, request)
        )
        done, _pending = await asyncio.wait((task,), timeout=_FAST_CALL_SECONDS)
        if done:
            payload = await self._completed_call(task, request_id)
            return _json_response(payload, status_code=_error_status(task.exception()))

        if "text/event-stream" not in request.headers.get("accept", "").lower():
            payload = await self._completed_call(task, request_id)
            return _json_response(payload, status_code=_error_status(task.exception()))
        return StreamingResponse(
            self._stream_call(
                task=task, request_id=request_id, progress_token=progress_token
            ),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def _preauthorize(
        self, *, name: str, arguments: JsonObject, request: Request, request_id: RequestId
    ) -> JSONResponse | None:
        """INV-5/INV-11 (FIX 6): resolve project scope and the internal-tool block
        BEFORE the SSE stream can commit a 200 — so a slow scope or visibility
        denial is always a transport 403 (404 for membership misses), never a
        mid-stream error. Tool execution alone runs behind the stream; only the
        denial's ledger row is awaited, off the loop."""
        principal = getattr(request.state, "principal", LOCAL_PRINCIPAL)
        try:
            if self._authorize_scope is not None:
                self._authorize_scope(request, name, arguments)
            contract = TOOL_MANIFEST.get(name)
            if (
                contract is not None
                and contract.visibility == "internal"
                and not is_local_principal(principal)
            ):
                raise ToolVisibilityError(
                    f"tool {name} is internal and cannot be invoked over MCP",
                    details={"tool": name, "visibility": "internal"},
                )
        except ResearchPluginError as exc:
            # Preflight denials are always transport-visible: membership misses
            # are 404 here even though a tool-raised NotFoundError stays 200.
            status = 404 if isinstance(exc, NotFoundError) else _error_status(exc)
            await self._ledger_reject(
                tool=name, error_code=exc.error_code, message=exc.message
            )
            return _json_response(_dispatcher_error(request_id, exc), status_code=status)
        return None

    @staticmethod
    def _progress_token(
        params: JsonObject,
    ) -> tuple[ProgressToken | None, str | None]:
        meta = params.get("_meta")
        if meta is None:
            return None, None
        if not isinstance(meta, dict):
            return None, "Tool _meta must be an object"
        token = meta.get("progressToken")
        if token is None:
            return None, None
        if not _is_request_id(token):
            return None, "Progress token must be a string or integer"
        return token, None

    @staticmethod
    async def _completed_call(
        task: asyncio.Task[JsonObject], request_id: RequestId
    ) -> JsonObject:
        try:
            result = await task
        except Exception as exc:
            return _dispatcher_error(request_id, exc)
        return _result(request_id, _tool_result(result))

    async def _stream_call(
        self,
        *,
        task: asyncio.Task[JsonObject],
        request_id: RequestId,
        progress_token: ProgressToken | None,
    ) -> AsyncIterator[str]:
        progress = 0
        while not task.done():
            if progress_token is None:
                yield ": tool call in progress\n\n"
            else:
                progress += 1
                yield _sse_message(
                    {
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": {
                            "progressToken": progress_token,
                            "progress": progress,
                            "message": "Tool call is still running",
                        },
                    }
                )
            try:
                await asyncio.wait_for(
                    asyncio.shield(task), timeout=_PROGRESS_INTERVAL_SECONDS
                )
            except TimeoutError:
                continue
            except Exception:
                # The completed-call renderer below owns JSON-RPC error
                # serialization. Do not let a task that fails after the SSE
                # headers are committed escape through Starlette's HTTP
                # exception handlers.
                break
        yield _sse_message(await self._completed_call(task, request_id))
