"""Tool-call dispatch, contract validation, and telemetry.

The dispatcher is intentionally independent of HTTP transport construction.
Composition roots provide handlers and telemetry sinks; this module owns the
tool contract machinery shared by HTTP MCP and trusted internal calls.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from pydantic import ValidationError as PydanticValidationError

from .contracts import TOOL_CONTRACTS, TOOL_MANIFEST
from ..identity import ToolVisibilityError
from ...kernel.state.activity import monotonic_ms
from ...kernel.utils import PermissionDeniedError, ResearchPluginError
from ...kernel.utils import ValidationError as ToolValidationError


class ToolHandler(Protocol):
    def __call__(self, **kwargs: Any) -> dict[str, Any]: ...


class ToolActivity(Protocol):
    def tool_ok(self, **kwargs: Any) -> None: ...
    def tool_error(self, **kwargs: Any) -> None: ...


class ToolCallRecorder(Protocol):
    def record(self, **kwargs: Any) -> None: ...


def _contract_error_message(*, exc: PydanticValidationError) -> str:
    first = exc.errors()[0] if exc.errors() else {}
    loc = ".".join(str(part) for part in first.get("loc", ())) or "input"
    error_type = first.get("type")
    if error_type == "missing":
        return f"{loc} is required"
    if error_type == "extra_forbidden":
        return f"unexpected field: {loc}"
    return f"{loc}: {first.get('msg', 'invalid value')}"


def _normalize_tool_schema_for_providers(value: Any) -> None:
    """Rewrite equivalent JSON Schema constructs for narrower tool providers."""

    if isinstance(value, dict):
        if "const" in value:
            value["enum"] = [value.pop("const")]
        for child in value.values():
            _normalize_tool_schema_for_providers(child)
    elif isinstance(value, list):
        for child in value:
            _normalize_tool_schema_for_providers(child)


def _assert_tool_contracts_match_handlers(
    *,
    handlers: dict[str, ToolHandler],
    tool_names: set[str],
) -> None:
    handler_names = set(handlers)
    unknown_tools = sorted(tool_names - set(TOOL_CONTRACTS))
    if unknown_tools:
        raise AssertionError(f"unknown tool contracts: {', '.join(unknown_tools)}")
    if handler_names == tool_names:
        return
    missing_handlers = sorted(tool_names - handler_names)
    missing_contracts = sorted(handler_names - tool_names)
    raise AssertionError(
        "tool handler/contract mismatch"
        f"; missing handlers: {', '.join(missing_handlers) or 'none'}"
        f"; missing contracts: {', '.join(missing_contracts) or 'none'}"
    )


class ToolDispatcher:
    """Contract-checked tool dispatcher with activity/tool-call telemetry."""

    def __init__(
        self,
        *,
        handlers: dict[str, ToolHandler],
        activity: ToolActivity,
        tool_calls: ToolCallRecorder,
        ledger: ToolCallRecorder | None = None,
        tool_names: Iterable[str] | None = None,
    ) -> None:
        selected_tool_names = (
            set(TOOL_CONTRACTS) if tool_names is None else set(tool_names)
        )
        _assert_tool_contracts_match_handlers(
            handlers=handlers,
            tool_names=selected_tool_names,
        )
        self.activity = activity
        self.tool_calls = tool_calls
        # Durable sibling of the in-memory ring: sizes, digests, and outcomes
        # that survive a restart. Absent in narrow test compositions.
        self.ledger = ledger
        self._tool_names = frozenset(selected_tool_names)
        self._tools = {
            name: (contract.input_model, handlers[name])
            for name, contract in TOOL_CONTRACTS.items()
            if name in self._tool_names
        }

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        for name, contract in TOOL_CONTRACTS.items():
            if name not in self._tool_names:
                continue
            schema = contract.input_model.model_json_schema()
            schema.pop("title", None)
            _normalize_tool_schema_for_providers(schema)
            tool: dict[str, Any] = {
                "name": name,
                "description": contract.description,
                "inputSchema": schema,
            }
            if contract.visibility == "internal":
                tool["hidden"] = True
            tools.append(tool)
        return tools

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        activity_source: str = "app",
        internal_kwargs: dict[str, Any] | None = None,
        telemetry_project_id: str | None = None,
        caller_is_external_mcp: bool = False,
    ) -> dict[str, Any]:
        arguments = arguments or {}
        telemetry_arguments = arguments
        if telemetry_project_id:
            telemetry_arguments = {
                **arguments,
                "project_id": telemetry_project_id,
            }
        started = monotonic_ms()
        try:
            if name not in self._tools:
                raise ResearchPluginError(f"unknown tool: {name}", details={"tool": name})
            # Defense-in-depth for INV-5: an internal/hidden tool is never
            # reachable over MCP by any non-local caller (mk_ key, rr_sk_, raw
            # JWT). Only LOCAL_PRINCIPAL composition — which never sets this
            # flag — keeps internal access over the same dispatch path.
            if caller_is_external_mcp and TOOL_CONTRACTS[name].visibility == "internal":
                raise ToolVisibilityError(
                    f"tool {name} is internal and cannot be invoked over MCP",
                    details={"tool": name, "visibility": "internal"},
                )
            if arguments.get("review_session_id") and name != "review.submit":
                raise PermissionDeniedError(
                    "review sessions are read-only except review.submit"
                )
            try:
                input_model, handler = self._tools[name]
                kwargs = input_model.model_validate(arguments).model_dump()
                if internal_kwargs:
                    kwargs.update(internal_kwargs)
                result = handler(**kwargs)
            except PydanticValidationError as exc:
                raise ToolValidationError(
                    _contract_error_message(exc=exc),
                    details={
                        "tool": name,
                        "errors": exc.errors(include_context=False),
                    },
                ) from exc
            duration_ms = monotonic_ms() - started
            self.activity.tool_ok(
                source=activity_source,
                tool=name,
                arguments=telemetry_arguments,
                duration_ms=duration_ms,
                result=result,
            )
            self.tool_calls.record(
                tool=name,
                source=activity_source,
                status="ok",
                duration_ms=duration_ms,
                arguments=telemetry_arguments,
                result=result,
            )
            if self.ledger is not None:
                self.ledger.record(
                    tool=name,
                    source=activity_source,
                    status="ok",
                    duration_ms=duration_ms,
                    arguments=telemetry_arguments,
                    result=result,
                )
            return result
        except Exception as exc:
            if isinstance(exc, ResearchPluginError):
                error = exc.message
                error_code = exc.error_code
            else:
                error = str(exc)
                error_code = "unexpected"
            duration_ms = monotonic_ms() - started
            self.activity.tool_error(
                source=activity_source,
                tool=name,
                arguments=telemetry_arguments,
                duration_ms=duration_ms,
                error=error,
                error_code=error_code,
            )
            self.tool_calls.record(
                tool=name,
                source=activity_source,
                status="error",
                duration_ms=duration_ms,
                arguments=telemetry_arguments,
                error=error,
                error_code=error_code,
            )
            if self.ledger is not None:
                self.ledger.record(
                    tool=name,
                    source=activity_source,
                    status="error",
                    duration_ms=duration_ms,
                    arguments=telemetry_arguments,
                    error=error,
                    error_code=error_code,
                )
            raise
