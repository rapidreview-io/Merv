"""Pure HTTP response shaping over already-selected public operations."""

from __future__ import annotations

from typing import Any, Protocol

from ....kernel.utils import NotFoundError
from ....research_core import EXPERIMENT_WORKFLOW
from ....infrastructure import RemoteSandboxes as SandboxEngine
from ...telemetry import activity_summary


class ActivityTelemetry(Protocol):
    def recent(self, **kwargs: Any) -> dict[str, Any]: ...


class ToolCallTelemetry(Protocol):
    def stats(self, **kwargs: Any) -> dict[str, Any]: ...
    def get(self, **kwargs: Any) -> dict[str, Any] | None: ...

_LOCAL_DATA_PLANE_RESPONSE_KEYS = frozenset({"repo_root", "local_sync_dir"})


def present(value: Any) -> Any:
    """Remove machine-local implementation details from public responses."""
    if isinstance(value, dict):
        return {
            key: present(item)
            for key, item in value.items()
            if key not in _LOCAL_DATA_PLANE_RESPONSE_KEYS
        }
    if isinstance(value, list):
        return [present(item) for item in value]
    return value


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
    return present(
        {
            "filter": {
                key: value
                for key, value in (("source", source), ("project_id", project_id))
                if value
            },
            "events": events,
            "summary": summary,
        }
    )


def tool_call_detail(
    telemetry: ToolCallTelemetry,
    call_id: int,
    *,
    project_ids: set[str] | list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    record = telemetry.get(call_id=call_id, project_ids=project_ids)
    if record is None:
        raise NotFoundError(f"tool call not found: {call_id}")
    return present(record)


def experiment_view_model(exp: dict[str, Any]) -> dict[str, Any]:
    current = exp.get("current_attempt_artifacts", [])
    plans = [res["id"] for res in current if res.get("role") == "plan"]
    results = [res["id"] for res in current if res.get("role") == "result"]
    claims = [claim["id"] for claim in exp.get("tested_claims", [])]
    return {
        **exp,
        "tests_claims": claims,
        "input_artifacts": [
            res["id"]
            for res in current
            if res.get("role") in {"input", "code", "config", "plan"}
        ],
        "output_artifacts": results,
        "check": {
            "summary": exp.get("intent", ""),
            "claims": claims,
            "success_criteria": "",
            "metrics": [],
        },
        "did": {
            "summary": exp.get("revision_context", ""),
            "runs": [],
            "input_artifacts": plans,
            "output_artifacts": results,
            "last_run_at": exp.get("updated_at"),
        },
        "learned": {
            "summary": "",
            "is_concluded": (
                exp.get("status") == EXPERIMENT_WORKFLOW.success_status
            ),
            "completion_blockers": [],
            "headline_metrics": {},
            "headline_metric_details": [],
        },
    }


def experiments_view(experiments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "experiments": [experiment_view_model(exp) for exp in experiments],
        "current": experiments[-1] if experiments else None,
        "artifact_use": [],
        "recent_runs": [],
    }


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
    return present(snapshot)


def sandbox_list_view(sandboxes: SandboxEngine, *, project_id: str) -> dict[str, Any]:
    return present({"sandboxes": sandboxes.for_project(project_id=project_id)})
