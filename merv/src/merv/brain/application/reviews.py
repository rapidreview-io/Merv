# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Producer-facing review queries and their event-keyed response reactions."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from merv.shared.artifact_roles import EXHIBIT_ROLE, GATED_ROLES

from ..artifacts import Artifacts
from ..feed import FeedAdvisory
from ..kernel.utils import parse_iso
from ..research_core import (
    EXPERIMENT_WORKFLOW,
    REFLECTION_WORKFLOW,
    Research,
    TASK_WORKFLOW,
)
from .experiments.context import ExperimentContextQuery
from .project_context import ProjectContextQuery
from .reflections import present_agent_reflection_state
from .tasks import TaskContextQuery


def request_review(research: Research, **kwargs: Any) -> dict[str, Any]:
    """Add delivery instructions to a Research-owned review capability."""
    result = research.request_review(**kwargs)
    return {
        **result,
        "reviewer_handoff": reviewer_handoff_payload(
            role=str(kwargs["role"]),
            target_type=str(kwargs["target_type"]),
            target_id=str(kwargs["target_id"]),
            review_request_id=str(result["review_request_id"]),
            reviewer_capability=str(result["reviewer_capability"]),
        ),
    }


def reviewer_handoff_payload(
    *,
    role: str,
    target_type: str,
    target_id: str,
    review_request_id: str = "",
    reviewer_capability: str = "",
) -> dict[str, Any]:
    workflow = {
        "reflection": REFLECTION_WORKFLOW,
        "experiment": EXPERIMENT_WORKFLOW,
        "task": TASK_WORKFLOW,
    }.get(target_type)
    review = None if workflow is None else workflow.review(role)
    skill = "" if review is None else review.skill
    handoff: dict[str, Any] = {
        "role": role,
        "skill": skill,
        "target_type": target_type,
        "target_id": target_id,
        "read_only": True,
        "start_tool": "review.start",
        "submit_tool": "review.submit",
    }
    if review_request_id and reviewer_capability and skill:
        handoff["spawn_prompt"] = (
            f"You are the {role} for {target_type} {target_id}. "
            f"Follow the {skill} skill. Begin by calling review.start with "
            f"review_request_id={review_request_id}, "
            f"reviewer_capability={reviewer_capability}, and your own "
            "session identity as caller_session_id (required; never the "
            "producer's). You are read-only: your sole permitted mutation "
            "is review.submit."
        )
    return handoff


def start_review(
    *,
    research: Research,
    artifacts: Artifacts,
    experiment_context: ExperimentContextQuery,
    project_context: ProjectContextQuery,
    review_request_id: str,
    reviewer_capability: str,
    declared_agent: str = "",
    caller_session_id: str = "",
    assigned_agent_session_id: str = "",
    assigned_review_request_id: str = "",
    task_context: TaskContextQuery | None = None,
) -> dict[str, Any]:
    """Start a pinned review, then attach bounded orientation for its target."""
    result = dict(
        research.start_review(
            review_request_id=review_request_id,
            reviewer_capability=reviewer_capability,
            declared_agent=declared_agent,
            caller_session_id=caller_session_id,
            assigned_agent_session_id=assigned_agent_session_id,
            assigned_review_request_id=assigned_review_request_id,
        )
    )
    project_id = str(result.get("project_id") or "")
    target_type = str(result.get("target_type") or "")
    target_id = str(result.get("target_id") or "")
    target_snapshot = result.pop("target_snapshot", {})
    submitted_artifacts = _submitted_artifacts(
        artifacts=artifacts,
        snapshot=target_snapshot,
    )
    result["read_scope"] = [
        "claim",
        "experiment",
        "task",
        "reflection",
        "artifact",
        "review",
    ]
    result["project_context"] = project_context.build(project_id=project_id)
    if target_type == "experiment":
        live_state = research.experiment_state(
            experiment_id=target_id,
            project_id=project_id,
        )
        state = {
            **live_state,
            "status": target_snapshot.get("status") or live_state.get("status"),
            "attempt_index": target_snapshot.get("attempt_index")
            or live_state.get("attempt_index"),
        }
        result["context"] = experiment_context.build(
            state=state,
            project_id=project_id,
            pinned_artifacts=submitted_artifacts,
        )
    elif target_type == "task":
        result["submitted_artifacts"] = submitted_artifacts
        live_task = research.task_state(task_id=target_id, project_id=project_id)
        if task_context is not None:
            result["context"] = task_context.build(
                state=dict(live_task), project_id=project_id
            )
    elif target_type == "reflection":
        result["submitted_artifacts"] = submitted_artifacts
        result["reflection_context"] = present_agent_reflection_state(
            research.reflection_state(
                project_id=project_id,
                reflection_id=target_id,
                include_content=True,
            ),
            include_content=False,
        )
    return result


def read_review_status(
    *,
    research: Research,
    feed: FeedAdvisory,
    target_type: str,
    target_id: str,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Read canonical review state, then add best-effort producer guidance."""
    result = present_review_recovery(
        research.review_status(
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
        )
    )
    if target_type != "experiment" or not result.get("reviews"):
        return result
    try:
        state = research.experiment_state(
            experiment_id=target_id,
            project_id=project_id,
        )
        event = research.latest_submitted_review_event(
            target_type=target_type,
            target_id=target_id,
            project_id=str(state.get("project_id") or project_id or ""),
        )
    except Exception:
        return result
    if event is None:
        return result
    try:
        note = feed.transition_advisory(
            project_id=str(state.get("project_id") or ""),
            experiment_id=str(state.get("id") or ""),
            event="experiment_review_verdict",
        )
    except Exception:
        note = None
    if note:
        result["feed_note"] = note
    return result


def review_queue(
    research: Research, *, project_id: str | None = None
) -> dict[str, Any]:
    return present_review_recovery(research.review_queue(project_id=project_id))


def present_review_recovery(result: dict[str, Any]) -> dict[str, Any]:
    presented = dict(result)
    presented["requests"] = [
        {**request, "recovery": _recovery(request)}
        for request in result.get("requests", [])
    ]
    return presented


def _recovery(request: dict[str, Any]) -> dict[str, Any]:
    status = str(request.get("status") or "")
    expires = parse_iso(str(request.get("expires_at") or ""))
    expired = expires is None or datetime.now(UTC) > expires
    can_refresh = status in {"requested", "started"}
    recovery: dict[str, Any] = {
        "capability_returned_once": True,
        "capability_available": False,
        "expired": expired,
        "can_request_fresh_capability": can_refresh,
        "reason": (
            "capability lost or expired; request a fresh reviewer capability "
            "for the same target and role (this revokes the open request — "
            "the old capability can no longer start or submit)"
            if can_refresh
            else "review request is closed; inspect submitted reviews instead"
        ),
    }
    if can_refresh:
        recovery["tool"] = "review.request"
        recovery["arguments"] = {
            "target_type": request.get("target_type"),
            "target_id": request.get("target_id"),
            "role": request.get("role"),
        }
    return recovery


def _submitted_artifacts(
    *, artifacts: Artifacts, snapshot: dict[str, Any]
) -> list[dict[str, Any]]:
    """Hydrate exactly the immutable artifact ids pinned by Research."""
    visible = tuple(
        str(resource.get("artifact_id") or "")
        for resource in snapshot.get("artifacts", [])
        if str(resource.get("role") or "") in GATED_ROLES
        or resource.get("role") == EXHIBIT_ROLE
    )
    found = artifacts.get(artifact_ids=visible, include="content")
    result: list[dict[str, Any]] = []
    for artifact in sorted(found, key=lambda item: item.order):
        if artifact.status != "complete":
            continue
        content = (
            None
            if artifact.data is None
            else artifact.data.decode("utf-8", errors="replace")
        )
        entry: dict[str, Any] = {
            "role": artifact.role,
            "lens_id": artifact.lens_id,
            "path": artifact.path,
            "artifact_id": artifact.id,
            "submission_id": artifact.submission_id,
            "submitted_at": artifact.updated_at or artifact.created_at,
            "content": content,
        }
        if content is None:
            entry["note"] = (
                "submitted content unavailable; ask the producer to "
                "resubmit it with artifact.submit"
            )
        result.append(entry)
    return result


__all__ = [
    "read_review_status",
    "request_review",
    "review_queue",
    "start_review",
]
