# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Task presentation, transition receipts, and the bounded task context."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, TypedDict, cast

from merv.shared.artifact_roles import TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE
from merv.shared.content_summaries import content_tldr

from ..artifacts import Artifacts
from ..feed import FeedAdvisory
from ..kernel.events import StoredEvent
from ..research_core import (
    TASK_TERMINAL_STATUSES,
    TASK_WORKFLOW,
    Research,
    TaskState,
    preferred_artifact,
)
from .experiments.presentation import (
    project_fields,
    project_rows,
    review_body,
    slim_review_rows,
)

Record = dict[str, Any]

_SLIM_ARTIFACT_FIELDS = ("id", "role", "path", "size_bytes", "title", "tldr")
_SLIM_DEPENDENCY_FIELDS = ("id", "node_type", "name", "status", "settled", "failed")
_CONTEXT_ARTIFACT_FIELDS = ("id", "role", "path", "size_bytes", "tldr")


def task_folder(*, task_id: str, name: str = "") -> str:
    """The local folder a task's brief and delivery live in: tasks/<name>/."""
    slug = (name or task_id).strip() or task_id
    return f"tasks/{slug}/"


class SlimTaskState(TaskState, total=False):
    """Agent-facing task detail: workflow substance without bookkeeping."""


class TaskTransitionReceipt(TypedDict, total=False):
    """Minimal agent acknowledgement for one committed task transition."""

    task_id: str
    transition: str
    from_status: str
    to_status: str
    status: str
    attempt_index: int
    event_id: int
    accepted_at: str
    feed_note: str


def rich_task_state(full: TaskState) -> TaskState:
    """The full Research state, unchanged: the UI reads everything."""
    return cast(TaskState, dict(full))


def slim_task_state(full: TaskState) -> SlimTaskState:
    """Project rich task facts to the exact agent-facing wire shape."""
    rich = dict(full)
    attempt = rich.get("attempt_index")
    all_artifacts = rich.get("artifacts", [])
    current = rich.get("current_attempt_artifacts")
    if current is None:
        current = [a for a in all_artifacts if a.get("attempt_index") == attempt]
    slim: dict[str, Any] = {
        "id": rich.get("id"),
        "name": rich.get("name"),
        "status": rich.get("status"),
        "attempt_index": attempt,
        "goal": rich.get("goal"),
        "outcome": rich.get("outcome"),
        "failed_by": rich.get("failed_by"),
        "revision_context": rich.get("revision_context"),
        "created_at": rich.get("created_at"),
        "updated_at": rich.get("updated_at"),
        "checks": list(rich.get("checks") or []),
        "dependencies": project_rows(
            rich.get("dependencies", []), _SLIM_DEPENDENCY_FIELDS
        ),
        "dependents": project_rows(
            rich.get("dependents", []), _SLIM_DEPENDENCY_FIELDS
        ),
        "allowed_transitions": rich.get("allowed_transitions", []),
        "gate_checklist": rich.get("gate_checklist", {}),
        "current_attempt_artifacts": project_rows(current, _SLIM_ARTIFACT_FIELDS),
        "reviews": slim_review_rows(rich.get("reviews", [])),
    }
    return cast(SlimTaskState, slim)


@dataclass(kw_only=True, eq=False, repr=False)
class TransitionTask:
    """Commit one task transition through Research and acknowledge it."""

    research: Research
    feed: FeedAdvisory

    def agent(
        self,
        *,
        task_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> TaskTransitionReceipt:
        state, event = self._execute(
            task_id=task_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
        )
        receipt = TaskTransitionReceipt(
            task_id=task_id,
            transition=transition,
            from_status=str(event.payload.get("from") or ""),
            to_status=str(state.get("status") or ""),
            status=str(state.get("status") or ""),
            attempt_index=int(state.get("attempt_index") or 0),
            event_id=event.id,
            accepted_at=event.created_at,
        )
        note = self._feed_advisory(event=event, state=state)
        if note:
            receipt["feed_note"] = note
        return receipt

    def execute(
        self,
        *,
        task_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> Record:
        state, _event = self._execute(
            task_id=task_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
        )
        return dict(slim_task_state(state))

    def _execute(
        self,
        *,
        task_id: str,
        transition: str,
        evidence: dict[str, Any] | None,
        project_id: str | None,
    ) -> tuple[TaskState, StoredEvent]:
        committed = self.research.transition_task(
            task_id=task_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
        )
        return committed.state, committed.event

    def _feed_advisory(self, *, event: StoredEvent, state: TaskState) -> str | None:
        status = str(state.get("status") or "")
        if event.type != TASK_WORKFLOW.event_type or status not in TASK_TERMINAL_STATUSES:
            return None
        try:
            return self.feed.transition_advisory(
                project_id=str(state.get("project_id") or ""),
                experiment_id=str(state.get("id") or ""),
                event=f"task_{status}",
            )
        except Exception:
            return None


@dataclass(kw_only=True, eq=False, repr=False)
class TaskContextQuery:
    """The bounded packet an agent needs to work or review one task."""

    artifacts: Artifacts

    def build(self, *, state: Record, project_id: str | None = None) -> Record:
        artifacts = list(state.get("current_attempt_artifacts") or [])
        brief = preferred_artifact(artifacts=artifacts, roles=(TASK_BRIEF_ROLE,))
        delivery = preferred_artifact(artifacts=artifacts, roles=(TASK_DELIVERY_ROLE,))
        documents = self._documents(
            artifact_ids=tuple(
                str(item.get("id") or "") for item in (brief, delivery) if item
            ),
            project_id=project_id,
        )
        terminal = str(state.get("status") or "") in TASK_TERMINAL_STATUSES
        return {
            "task": project_fields(
                state,
                (
                    "id",
                    "name",
                    "goal",
                    "status",
                    "attempt_index",
                    "outcome",
                    "failed_by",
                    "revision_context",
                ),
            ),
            "folder": task_folder(
                task_id=str(state.get("id") or ""), name=str(state.get("name") or "")
            ),
            "checks": list(state.get("checks") or []),
            "dependencies": project_rows(
                state.get("dependencies") or [], _SLIM_DEPENDENCY_FIELDS
            ),
            "brief": self._document(brief, documents, full=True),
            "delivery": self._document(delivery, documents, full=not terminal),
            "reviews": [
                item
                for item in (
                    review_body(state.get("reviews", []), review_id=str(review.get("id")))
                    for review in state.get("reviews", [])[:1]
                )
                if item
            ],
        }

    def _documents(
        self, *, artifact_ids: tuple[str, ...], project_id: str | None
    ) -> dict[str, str]:
        if not artifact_ids:
            return {}
        found = self.artifacts.get(
            artifact_ids=artifact_ids, project_id=project_id, include="content"
        )
        return {
            artifact.id: artifact.data.decode("utf-8", errors="replace")
            for artifact in found
            if artifact.data is not None
        }

    @staticmethod
    def _document(
        artifact: Record | None, documents: dict[str, str], *, full: bool
    ) -> Record | None:
        if artifact is None:
            return None
        text = documents.get(str(artifact.get("id") or ""), "")
        record = project_fields(artifact, _CONTEXT_ARTIFACT_FIELDS)
        if not record.get("tldr"):
            record["tldr"] = content_tldr(
                text, role=str(artifact.get("role") or ""), path=str(artifact.get("path") or "")
            )
        if full:
            record["content"] = text
        return record


def rows_for_status(tasks: Iterable[Record], fields: Iterable[str]) -> list[Record]:
    return project_rows(tasks, fields)


__all__ = [
    "SlimTaskState",
    "TaskContextQuery",
    "TaskTransitionReceipt",
    "TransitionTask",
    "rich_task_state",
    "slim_task_state",
    "task_folder",
]
