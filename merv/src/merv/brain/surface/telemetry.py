"""Control-plane runtime adapters with no local workspace dependencies."""

from __future__ import annotations

import json
import sys
import threading
from typing import Any

from ..kernel.state.activity import (
    ToolActivityEmitter,
    effective_source,
    is_event_ok,
    redact_sensitive,
)
from ..kernel.utils import now_iso


class ControlActivitySink(ToolActivityEmitter):
    """Bounded in-memory activity sink for the unified brain composition."""

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
