# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Small values shared across Research workflows and application reads."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, fields, is_dataclass
from enum import Enum
from typing import Any, Generic, TypedDict, TypeVar

from ..kernel.events import StoredEvent
from ..workflows import Public
from ..workflows.definitions.research_state import ExperimentState, TaskState, ReflectionState, MISSING
from .policy import GateEvaluation


def _public_value(value):
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return public_record(Public(), value)
    if isinstance(value, Mapping):
        return {name: _public_value(item) for name, item in value.items() if item is not MISSING}
    if isinstance(value, (list, tuple)):
        return [_public_value(item) for item in value]
    return value


def public_record(public: Public, record: object, **computed: Any) -> dict[str, Any]:
    """Serialize declared fields; hidden names cannot be restored by computations."""
    names = (item.name for item in fields(record)) if is_dataclass(record) else record
    result = {}
    for name in dict.fromkeys((*names, *computed)):
        if name in public.hidden:
            continue
        value = computed.get(name, MISSING)
        if name not in computed:
            value = getattr(record, name) if is_dataclass(record) else record[name]
        if value is not MISSING:
            result[public.renames.get(name, name)] = _public_value(value)
    return result


def project_fields(record: object, fields: Iterable[str]) -> dict[str, Any]:
    """Narrow one record to the columns a reader needs."""
    return {name: _public_value(getattr(record, name, None) if is_dataclass(record) else record.get(name)) for name in fields}


def project_rows(rows: Iterable[object], fields: Iterable[str]) -> list[dict[str, Any]]:
    fields = tuple(fields)
    return [project_fields(row, fields) for row in rows]


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


S = TypeVar("S")


@dataclass(frozen=True, slots=True)
class Committed(Generic[S]):
    """One transition's resulting state and the event that recorded it."""

    state: S
    event: StoredEvent


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
    open_reflection: ReflectionState | None
    latest_published_reflection: ReflectionState | None
    reflection_signal: dict[str, Any]
    gate_evaluations: dict[str, GateEvaluation]
    tasks: list[TaskState] = field(default_factory=list)
    requested_task_id: str | None = None
    literature_signal: LiteratureSignal = field(
        default_factory=lambda: LiteratureSignal(
            papers_total=0, papers_unreviewed=0
        )
    )

    @property
    def selected_task(self) -> TaskState | None:
        return next((task for task in self.tasks if task.id == self.requested_task_id), None)

    @property
    def selected_experiment(self) -> ExperimentState | None:
        if self.requested_experiment_id is None:
            return self.experiments[-1] if self.experiments else None
        return next((experiment for experiment in self.experiments
                     if experiment.id == self.requested_experiment_id), None)


__all__ = [
    "Committed",
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
