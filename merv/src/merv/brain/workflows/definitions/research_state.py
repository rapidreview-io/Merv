"""Research-owned native values; arbitrary submitted content remains JSON."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, StrEnum
from typing import TypeAlias

JSON: TypeAlias = str | int | float | bool | None | list["JSON"] | dict[str, "JSON"]


class Missing(Enum):
    VALUE = "missing"


MISSING = Missing.VALUE


class ExperimentStatus(StrEnum):
    PLANNED = "planned"
    DESIGN_REVIEW = "design_review"
    RUNNING = "running"
    EXPERIMENT_REVIEW = "experiment_review"
    COMPLETE = "complete"
    FAILED = "failed"
    ABANDONED = "abandoned"


@dataclass(frozen=True, slots=True)
class Transition:
    transition: str
    leads_to: str


@dataclass(frozen=True, slots=True)
class Dependency:
    id: str
    node_type: str
    name: str
    status: str
    settled: bool
    failed: bool


class GateKind(StrEnum):
    ARTIFACT = "artifact"
    RECORD = "record"
    REVIEW = "review"


class GateStatus(StrEnum):
    MISSING = "missing"
    PRESENT = "present"
    VALID = "valid"
    INVALID = "invalid"
    PENDING = "pending"
    REQUESTED = "requested"
    STARTED = "started"
    PASSED = "passed"


@dataclass(frozen=True, slots=True)
class ChecklistItem:
    id: str
    kind: GateKind
    role: str
    label: str
    satisfied: bool
    status: GateStatus
    gate: str
    action: str
    validator: str | Missing = MISSING
    missing: str | Missing = MISSING
    artifact_id: str | Missing = MISSING
    path: str | Missing = MISSING
    problems: list[str] | Missing = MISSING
    dependencies: list[dict[str, JSON]] | Missing = MISSING
    skill: str | Missing = MISSING
    request_id: str | Missing = MISSING
    expires_at: str | Missing = MISSING


@dataclass(frozen=True, slots=True)
class GateChecklist:
    status: str
    transition: str | None
    leads_to: str | None
    ready: bool
    items: list[ChecklistItem]

    @classmethod
    def construct(cls, row):
        return cls(**{**row, "items": [ChecklistItem(**{**item, "kind": GateKind(item["kind"]),
                                                      "status": GateStatus(item["status"])}) for item in row["items"]]})


@dataclass(frozen=True, slots=True)
class ExperimentState:
    id: str
    project_id: str
    name: str
    intent: str
    status: ExperimentStatus
    attempt_index: int
    revision_context: str
    conclusion: str
    created_at: str
    updated_at: str
    details: str
    artifacts: list[dict[str, JSON]]
    current_attempt_artifacts: list[dict[str, JSON]]
    submissions: list[dict[str, JSON]]
    reviews: list[dict[str, JSON]]
    dependencies: list[Dependency]
    dependents: list[Dependency]
    tested_claims: list[dict[str, JSON]]
    allowed_transitions: list[Transition]
    gate_checklist: GateChecklist

    @classmethod
    def construct(cls, row):
        return cls(**{**row, "status": ExperimentStatus(row["status"]),
                      "dependencies": [Dependency(**item) for item in row["dependencies"]],
                      "dependents": [Dependency(**item) for item in row["dependents"]],
                      "allowed_transitions": [Transition(**item) for item in row["allowed_transitions"]],
                      "gate_checklist": GateChecklist.construct(row["gate_checklist"])})
