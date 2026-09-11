"""MCP-shaped HTTP routes shared by local and control HTTP surfaces.

Registers the legacy ``GET /mcp/tools`` + ``POST /mcp/call`` pair and the
stateless streamable ``POST /mcp`` endpoint. The internal-tool block and
key-project scope enforcement live downstream (the tool dispatcher and the
request gateway); these routes only add the shared body cap and the
``not hidden`` catalog filter so internal tools are never advertised.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request, Response
from fastapi.concurrency import run_in_threadpool

from ...kernel.utils import ValidationError
from .mcp_streamable_http import (
    McpStreamableHttp,
    RefusalLedger,
    RequestBodyTooLarge,
    SessionRecorder,
    ToolCaller,
    ToolCatalog,
    ToolPlanner,
    read_limited_mcp_body,
    with_agent_id_argument,
)

def register_mcp_routes(
    http: Any,
    *,
    list_tools: ToolCatalog,
    call_tool: ToolCaller,
    plan_tool: ToolPlanner | None = None,
    ledger: RefusalLedger | None = None,
    record_session: SessionRecorder | None = None,
    agent_identity: str | None = None,
) -> None:
    def catalog(request: Request) -> list[dict[str, Any]]:
        visible = [tool for tool in list_tools(request) if not tool.get("hidden")]
        if agent_identity is None:
            return visible
        return with_agent_id_argument(visible, required=agent_identity == "required")

    @http.get("/mcp/tools")
    def mcp_tools_list(request: Request) -> dict[str, Any]:
        return {"tools": catalog(request)}

    @http.post("/mcp/call")
    async def mcp_call(request: Request) -> Any:
        try:
            raw_body = await read_limited_mcp_body(request)
        except RequestBodyTooLarge as exc:
            return Response(
                content=json.dumps(
                    {
                        "detail": str(exc),
                        "error_code": "request_too_large",
                        "max_body_bytes": exc.limit,
                    }
                ),
                media_type="application/json",
                status_code=413,
            )
        if raw_body:
            try:
                payload = json.loads(raw_body)
            except ValueError as exc:
                raise ValidationError(
                    "request body must be valid JSON", details={"field": "body"}
                ) from exc
        else:
            payload = {}
        if not isinstance(payload, dict):
            raise ValidationError(
                "request body must be an object", details={"field": "body"}
            )
        name = payload.get("name")
        if not isinstance(name, str) or not name:
            raise ValidationError("tool name is required", details={"field": "name"})
        arguments = payload.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise ValidationError(
                "arguments must be an object", details={"field": "arguments"}
            )
        context = payload.get("context") or {}
        if not isinstance(context, dict):
            raise ValidationError(
                "context must be an object", details={"field": "context"}
            )
        # call_tool is synchronous and may do slow outbound IO (e.g. sandbox
        # service calls inside transitions). Run it in the threadpool — like every
        # sync route in http_api — so one slow tool call never stalls the event
        # loop for every other agent and UI request.
        result = await run_in_threadpool(call_tool, name, arguments, context, request)
        return {"result": result}

    McpStreamableHttp(
        list_tools=list_tools,
        call_tool=call_tool,
        plan_tool=plan_tool,
        ledger=ledger,
        record_session=record_session,
        agent_identity=agent_identity,
    ).register(http)
