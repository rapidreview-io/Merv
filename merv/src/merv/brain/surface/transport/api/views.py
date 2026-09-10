"""Pure HTTP response shaping over already-selected public operations."""

from __future__ import annotations

from typing import Any, Protocol

from ....kernel.utils import NotFoundError
from ....infrastructure import RemoteSandboxes as SandboxEngine
from ...telemetry import activity_summary


class ActivityTelemetry(Protocol):
    def recent(self, **kwargs: Any) -> dict[str, Any]: ...


class ToolCallTelemetry(Protocol):
    def stats(self, **kwargs: Any) -> dict[str, Any]: ...
    def get(self, **kwargs: Any) -> dict[str, Any] | None: ...


def _event_project_id(event: dict[str, Any]) -> str | None:
    value = event.get("project_id")
    if value:
        return str(value)
    args = event.get("args")
    return str(args["project_id"]) if isinstance(args, dict) and args.get("project_id") else None


def activity_view(
    activity: ActivityTelemetry,
    *,
    limit: int,
    source: str | None = None,
    project_id: str | None = None,
    project_ids: set[str] | None = None,
    include_unscoped_events: bool = True,
) -> dict[str, Any]:
    event_filter = None
    if project_ids is not None:
        allowed = {str(pid) for pid in project_ids if str(pid)}

        def event_filter(event: dict[str, Any]) -> bool:
            pid = _event_project_id(event)
            return pid == project_id if project_id else (
                pid in allowed or (include_unscoped_events and pid is None)
            )

    result = activity.recent(limit=limit, source=source, event_filter=event_filter)
    events = result["events"]
    scanned = result.get("scanned_filtered", events)
    if project_id is not None and project_ids is None:

        def visible(event: dict[str, Any]) -> bool:
            return _event_project_id(event) in (None, project_id)

        events = [event for event in events if visible(event)]
        scanned = [event for event in scanned if visible(event)]
    # Summarize the same rows the caller is shown, never a wider window.
    summary = activity_summary(scanned)
    return {
        "filter": {
            key: value
            for key, value in (("source", source), ("project_id", project_id))
            if value
        },
        "events": events,
        "summary": summary,
    }


def tool_call_detail(
    telemetry: ToolCallTelemetry,
    call_id: int,
    *,
    project_ids: set[str] | list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    record = telemetry.get(call_id=call_id, project_ids=project_ids)
    if record is None:
        raise NotFoundError(f"tool call not found: {call_id}")
    return record


def sandbox_view(
    sandboxes: SandboxEngine,
    *,
    project_id: str,
    experiment_id: str | None = None,
    sandbox_uid: str | None = None,
) -> dict[str, Any]:
    snapshot = sandboxes.snapshot(
        experiment_id=experiment_id, project_id=project_id, sandbox_uid=sandbox_uid
    )
    if snapshot is None:
        return {
            "experiment_id": experiment_id or "",
            "sandbox_uid": sandbox_uid or "",
            "status": "none",
            "sandbox": None,
        }
    return snapshot


def sandbox_list_view(sandboxes: SandboxEngine, *, project_id: str) -> dict[str, Any]:
    return {"sandboxes": sandboxes.for_project(project_id=project_id)}
