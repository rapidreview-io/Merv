# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Producer-facing review queries and their event-keyed response reactions."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..workflows import EXHIBIT_ROLE, GATED_ROLES, KINDS

from ..feed import FeedAdvisory
from ..kernel.utils import parse_iso
from ..research_core import (
    Research,
    project_fields,
)
from ..research_core import ResearchArtifacts as Artifacts
from .experiments.context import ExperimentContextQuery
from .experiments.transition import feed_transition_note
from .project_context import ProjectContextQuery
from .reflections import present_agent_reflection_state
from .tasks import TaskContextQuery

_SUBMITTED_FIELDS = {"role": "role", "lens_id": "lens_id", "path": "path",
                     "id": "artifact_id", "submission_id": "submission_id"}


def request_review(research: Research, **kwargs: Any) -> dict[str, Any]:
    """Add delivery instructions to a Research-owned review capability."""
    result = research.reviews.request(**kwargs)
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
    kind = KINDS.get(target_type)
    gate = None if kind is None else kind.review_gate(role)
    skill = "" if gate is None else gate.skill
    handoff: dict[str, Any] = {
        "role": role,
        "skill": skill,
        "target_type": target_type,
        "target_id": target_id,
        "read_only": True,
        "start_tool": "review.start",
        "submit_tool": "review.submit",
    }
    if review_request_id and reviewer_capability:
        handoff["spawn_prompt"] = (
            f"You are the {role} for {target_type} {target_id}. "
            + (f"Follow the {skill} skill. " if skill else "Use the workflow's pinned brief and exact evidence references. ")
            + "Begin by calling review.start with "
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
        research.reviews.start(
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
    ) if target_type in {"experiment", "task", "reflection"} else []
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
        live_state = research.experiments.get_state(
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
        live_task = research.tasks.get_state(task_id=target_id, project_id=project_id)
        if task_context is not None:
            result["context"] = task_context.build(
                state=dict(live_task), project_id=project_id
            )
    elif target_type == "reflection":
        result["submitted_artifacts"] = submitted_artifacts
        result["reflection_context"] = present_agent_reflection_state(
            research.reflections.get_state(
                project_id=project_id,
                reflection_id=target_id,
                include_content=True,
            ),
            include_content=False,
        )
    else:
        result["target_snapshot"] = target_snapshot
        result["context"] = result.get("workflow_context") or {}
        result["submitted_artifacts"] = target_snapshot.get("artifacts") or []
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
        research.reviews.status(
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
        )
    )
    if target_type != "experiment" or not result.get("reviews"):
        return result
    try:
        state = research.experiments.get_state(
            experiment_id=target_id,
            project_id=project_id,
        )
        event = research.reviews.latest_submitted_event(
            target_type=target_type,
            target_id=target_id,
            project_id=str(state.get("project_id") or project_id or ""),
        )
    except Exception:
        return result
    if event is None:
        return result
    note = feed_transition_note(
        feed,
        project_id=str(state.get("project_id") or ""),
        ref=str(state.get("id") or ""),
        event="experiment_review_verdict",
    )
    if note:
        result["feed_note"] = note
    return result


def review_queue(
    research: Research, *, project_id: str | None = None
) -> dict[str, Any]:
    return present_review_recovery(research.reviews.queue(project_id=project_id))


def present_review_recovery(result: dict[str, Any]) -> dict[str, Any]:
    presented = dict(result)
    presented["requests"] = [
        {**request, "recovery": _recovery(request)}
        for request in result.get("requests", [])
    ]
    return presented


def _recovery(request: dict[str, Any]) -> dict[str, Any]:
    """How a producer who lost a one-time capability gets a usable one back."""
    expires = parse_iso(str(request.get("expires_at") or ""))
    refresh = str(request.get("status") or "") in {"requested", "started"}
    return {
        "capability_returned_once": True,
        "capability_available": False,
        "expired": expires is None or datetime.now(UTC) > expires,
        "can_request_fresh_capability": refresh,
        "reason": (
            "capability lost or expired; request a fresh reviewer capability "
            "for the same target and role (this revokes the open request — "
            "the old capability can no longer start or submit)"
            if refresh
            else "review request is closed; inspect submitted reviews instead"
        ),
        **({"tool": "review.request",
            "arguments": project_fields(request, ("target_type", "target_id", "role"))}
           if refresh else {}),
    }


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
        result.append({
            **{public: getattr(artifact, name) for name, public in _SUBMITTED_FIELDS.items()},
            "submitted_at": artifact.updated_at or artifact.created_at,
            "content": content,
            **({} if content is not None else {"note": (
                "submitted content unavailable; ask the producer to "
                "resubmit it with artifact.upload")}),
        })
    return result


__all__ = [
    "read_review_status",
    "request_review",
    "review_queue",
    "start_review",
]
