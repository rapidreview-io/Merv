# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Small values shared across Research workflows and application reads."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, TypedDict

from ..kernel.events import StoredEvent
from ..workflows import Public


def public_record(public: Public, record: Mapping[str, Any], **computed: Any) -> dict[str, Any]:
    """One record's public shape, and the only place a public shape is built.

    The row is the shape: a reader sees every field it carries, under the name
    the declaration gives it, minus what that declaration hides. Fields a
    presenter computes are passed here — one already in the row keeps its
    place, and a new one takes the seat the declaration gave it.
    """
    result: dict[str, Any] = {
        public.renames.get(name, name): value
        for name, value in record.items()
        if name not in public.hidden
    }
    for name, value in computed.items():
        anchor = public.after.get(name, "")
        if anchor not in result or name in result:
            result[name] = value
            continue
        keys = list(result)
        seat = keys.index(anchor) + 1
        result = {**{key: result[key] for key in keys[:seat]}, name: value,
                  **{key: result[key] for key in keys[seat:]}}
    return result


def project_fields(record: Mapping[str, Any], fields: Iterable[str]) -> dict[str, Any]:
    """Narrow one record to the columns a reader needs."""
    return {name: record.get(name) for name in fields}


def project_rows(rows: Iterable[Mapping[str, Any]], fields: Iterable[str]) -> list[dict[str, Any]]:
    fields = tuple(fields)
    return [project_fields(row, fields) for row in rows]


class ExperimentState(TypedDict, total=False):
    id: str
    project_id: str
    name: str
    intent: str
    details: str
    status: str
    attempt_index: int


class ExperimentSummary(TypedDict):
    id: str
    project_id: str
    name: str
    intent: str
    status: str
    attempt_index: int
    created_at: str
    updated_at: str


class ExhibitVerdict(TypedDict, total=False):
    result_files: int
    attempt_index: int
    pinned: bool


@dataclass(frozen=True, slots=True)
class CommittedExperimentUpdate:
    state: ExperimentState
    event: StoredEvent


class TaskResult(TypedDict):
    """One confirmation: the executor's claim, the pointer, how to check."""

    number: int
    state: str | None
    evidence: str | None
    how: str | None
    text: str


class DependencyNode(TypedDict):
    """A node on either side of a wave-DAG edge, with its current standing."""

    id: str
    node_type: str
    name: str
    status: str
    settled: bool
    failed: bool


class TaskState(TypedDict, total=False):
    id: str
    project_id: str
    name: str
    goal: str
    status: str
    attempt_index: int
    outcome: str
    failed_by: str
    # The goal's contract and the delivery parsed to structure;
    # `dependents` mirrors `dependencies` on the other side of the edge.
    deliverables: list[str]
    results: list[TaskResult]
    report: str | None
    caveats: str | None
    dependencies: list[DependencyNode]
    dependents: list[DependencyNode]


class TaskSummary(TypedDict):
    id: str
    project_id: str
    name: str
    goal: str
    status: str
    attempt_index: int
    outcome: str
    failed_by: str
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class CommittedTaskUpdate:
    state: TaskState
    event: StoredEvent


class LiteratureSignal(TypedDict):
    papers_total: int
    papers_unreviewed: int


@dataclass(frozen=True, slots=True)
class ResearchSnapshot:
    """One canonical, transaction-consistent view of a project's research."""

    project_id: str
    requested_experiment_id: str | None
    project: dict[str, Any]
    claims: list[dict[str, Any]]
    experiments: list[ExperimentState]
    open_reflection: dict[str, Any] | None
    latest_published_reflection: dict[str, Any] | None
    reflection_signal: dict[str, Any]
    gate_evaluations: dict[str, Any]
    tasks: list[TaskState] = field(default_factory=list)
    requested_task_id: str | None = None
    literature_signal: LiteratureSignal = field(
        default_factory=lambda: LiteratureSignal(
            papers_total=0, papers_unreviewed=0
        )
    )

    @property
    def selected_task(self) -> TaskState | None:
        selected_id = self.requested_task_id
        if selected_id is None:
            return None
        return next(
            (
                task
                for task in self.tasks
                if str(task.get("id") or "") == selected_id
            ),
            None,
        )

    @property
    def selected_experiment(self) -> ExperimentState | None:
        selected_id = self.requested_experiment_id
        if selected_id is None and self.experiments:
            selected_id = str(self.experiments[-1].get("id") or "")
        return next(
            (
                experiment
                for experiment in self.experiments
                if str(experiment.get("id") or "") == selected_id
            ),
            None,
        )


__all__ = [
    "CommittedExperimentUpdate",
    "CommittedTaskUpdate",
    "ExhibitVerdict",
    "ExperimentState",
    "ExperimentSummary",
    "LiteratureSignal",
    "ResearchSnapshot",
    "TaskState",
    "TaskSummary",
    "project_fields",
    "project_rows",
    "public_record",
]
