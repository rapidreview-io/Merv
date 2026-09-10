"""Control-plane runtime adapters with no local workspace dependencies."""

from __future__ import annotations

import json
import sys
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

from ..kernel.state.activity import (
    ToolActivityEmitter,
    ToolCallRecord,
    effective_source,
    is_event_ok,
    redact_sensitive,
)
from ..kernel.utils import now_iso, parse_iso


class ControlActivitySink(ToolActivityEmitter):
    """Bounded in-memory activity sink for the unified brain composition."""

    log_path = "<control-activity-disabled>"

    def __init__(self, *, max_events: int = 5000) -> None:
        self.max_events = max_events
        self._events: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def emit(self, *, event_type: str, payload: dict[str, Any]) -> None:
        event = {"ts": now_iso(), "event": event_type, **payload}
        with self._lock:
            self._events.append(event)
            del self._events[: max(0, len(self._events) - self.max_events)]

    def recent(
        self,
        *,
        limit: int = 100,
        source: str | None = None,
        event_filter: Any | None = None,
        window: int = 5000,
    ) -> dict[str, Any]:
        with self._lock:
            scanned = list(self._events[-max(1, min(window, self.max_events)):])
        if source is not None:
            scanned = [
                event for event in scanned if effective_source(event=event) == source
            ]
        if event_filter is not None:
            scanned = [event for event in scanned if event_filter(event)]
        limit = max(1, min(limit, 1000))
        return {
            "events": scanned[-limit:],
            "scanned_filtered": scanned,
            # Summarize what the filters kept: totals that describe rows the
            # caller cannot see are not a summary of anything (audit TEL-01).
            "summary": activity_summary(scanned),
        }


class ControlToolCallSink:
    """Bounded in-memory tool-call sink for the unified brain composition."""

    db_path = "<control-tool-calls-disabled>"

    def __init__(self, *, max_rows: int = 1500) -> None:
        self.max_rows = max_rows
        self._next_id = 1
        self._calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def record(self, call: ToolCallRecord) -> None:
        row = {
            "id": self._next_id,
            "ts": now_iso(),
            "tool": call.tool,
            "source": call.source,
            "status": call.status,
            "duration_ms": call.duration_ms,
            "sent_chars": call.sent_chars,
            "received_chars": call.received_chars,
            "error_code": call.error_code,
            "project_id": call.project_id,
            "target_type": call.target_type or None,
            "target_id": call.target_id or None,
            "args": redact_sensitive(value=dict(call.arguments)),
            "result": call.error
            if call.status != "ok"
            else redact_sensitive(value=call.result),
            "args_truncated": False,
            "result_truncated": False,
        }
        with self._lock:
            self._next_id += 1
            self._calls.append(row)
            del self._calls[: max(0, len(self._calls) - self.max_rows)]

    def stats(
        self,
        *,
        minutes: int | None = None,
        source: str | None = None,
        status: str | None = None,
        tool: str | None = None,
        project_id: str | None = None,
        project_ids: set[str] | list[str] | tuple[str, ...] | None = None,
        limit: int = 200,
        sort: str = "ts",
        order: str = "desc",
    ) -> dict[str, Any]:
        with self._lock:
            calls = [dict(row) for row in self._calls]
        calls = [
            row
            for row in calls
            if _tool_call_matches(
                row,
                minutes=minutes,
                source=source,
                status=status,
                tool=tool,
                project_id=project_id,
                project_ids=project_ids,
            )
        ]
        sortable = {"ts", "received_chars", "sent_chars", "duration_ms", "tool"}
        sort = sort if sort in sortable else "ts"
        calls.sort(
            key=lambda row: row.get(sort) if row.get(sort) is not None else 0,
            reverse=(str(order).lower() != "asc"),
        )
        limit = max(1, min(int(limit), 2000))
        visible = [_tool_call_summary(row) for row in calls[:limit]]
        return {
            "calls": visible,
            # No per-tool rollup: the Debug page derives its own from
            # GET /api/activity and never read one from here.
            "totals": {
                "calls": len(calls),
                "sent_chars": sum(int(row["sent_chars"]) for row in calls),
                "received_chars": sum(int(row["received_chars"]) for row in calls),
                "error_calls": sum(1 for row in calls if row["status"] == "error"),
            },
            "coverage": {
                "calls": len(calls),
                "stored": len(calls),
                "oldest_ts": min((row["ts"] for row in calls), default=None),
                "newest_ts": max((row["ts"] for row in calls), default=None),
                "capped": False,
            },
            "filter": {
                "minutes": minutes,
                "source": source,
                "status": status,
                "tool": tool,
                "project_id": project_id,
            },
        }

    def get(
        self, *, call_id: int, project_ids: set[str] | None = None
    ) -> dict[str, Any] | None:
        allowed = {str(pid) for pid in project_ids or [] if str(pid)}
        with self._lock:
            for row in self._calls:
                if int(row["id"]) != int(call_id):
                    continue
                if (
                    project_ids is not None
                    and str(row.get("project_id") or "") not in allowed
                ):
                    return None
                return dict(row)
        return None

    def clear(self, *, project_ids: set[str] | None = None) -> dict[str, Any]:
        allowed = {str(pid) for pid in project_ids or [] if str(pid)}
        with self._lock:
            if project_ids is None:
                cleared = len(self._calls)
                self._calls.clear()
                return {"cleared": cleared}
            before = len(self._calls)
            self._calls = [
                row
                for row in self._calls
                if str(row.get("project_id") or "") not in allowed
            ]
            return {"cleared": before - len(self._calls)}


def activity_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Counts describing exactly the events handed in (audit TEL-01).

    The API view recomputes the summary for every response over its own
    filtered list, and calls this: one shape, so a key can never be present in
    the scoped response and absent from the unscoped one. `count` mirrors
    `total`.
    """
    summary = {
        "total": len(events),
        "count": len(events),
        "source_counts": {},
        "event_counts": {},
        "status_counts": {"ok": 0, "error": 0},
        "window": len(events),
    }
    for event in events:
        source = effective_source(event=event)
        event_type = str(event.get("event") or "unknown")
        summary["source_counts"][source] = summary["source_counts"].get(source, 0) + 1
        summary["event_counts"][event_type] = (
            summary["event_counts"].get(event_type, 0) + 1
        )
        status = "ok" if is_event_ok(event=event) else "error"
        summary["status_counts"][status] += 1
    return summary


def _tool_call_matches(
    row: dict[str, Any],
    *,
    minutes: int | None,
    source: str | None,
    status: str | None,
    tool: str | None,
    project_id: str | None,
    project_ids: set[str] | list[str] | tuple[str, ...] | None,
) -> bool:
    if minutes and minutes > 0:
        cutoff = datetime.now(tz=UTC) - timedelta(minutes=minutes)
        ts = parse_iso(row.get("ts"))
        if ts is None or ts < cutoff:
            return False
    if source and source != "all" and row.get("source") != source:
        return False
    if status and status != "all" and row.get("status") != status:
        return False
    if tool and tool not in str(row.get("tool") or ""):
        return False
    if project_id and row.get("project_id") != project_id:
        return False
    if project_ids is not None:
        allowed = {str(pid) for pid in project_ids if str(pid)}
        return bool(allowed) and str(row.get("project_id") or "") in allowed
    return True


def _tool_call_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "id",
            "ts",
            "tool",
            "source",
            "status",
            "duration_ms",
            "sent_chars",
            "received_chars",
            "error_code",
            "project_id",
            "target_type",
            "target_id",
        )
    }


class StructuredLogger:
    """Emit redacted request JSON when hosted composition enables logging."""

    def __init__(self, *, enabled: bool | None = None, stream: Any | None = None) -> None:
        self.enabled = bool(enabled)
        self._stream = stream if stream is not None else sys.stdout

    def log(
        self,
        *,
        kind: str,
        request_id: str = "",
        tenant_id: str = "",
        tool: str = "",
        path: str = "",
        status: Any = "",
        duration_ms: int = 0,
        **extra: Any,
    ) -> None:
        if not self.enabled:
            return
        record = redact_sensitive(
            value={
                "log": "rp.request",
                "kind": kind,
                "request_id": request_id,
                "tenant_id": tenant_id,
                "tool": tool,
                "path": path,
                "status": status,
                "duration_ms": duration_ms,
                **extra,
            }
        )
        record = {key: value for key, value in record.items() if value != "" or key == "status"}
        print(
            json.dumps(record, sort_keys=True, separators=(",", ":")),
            file=self._stream,
            flush=True,
        )
