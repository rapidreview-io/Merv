"""Small built-in requirement descriptions shared by guards and legacy views.

The graph owns edges and decisions. These values supply labels and review-input
semantics for the existing research API while its clients adopt graph responses.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from ..graph import Issue


@dataclass(frozen=True, slots=True)
class ArtifactNeed:
    role: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...] = ("artifact.upload",)
    validator: str = ""
    missing: str = ""
    label: str = ""
    artifact_key: str = ""

    def issue(self) -> Issue:
        return Issue(self.gate, self.error, self.action, self.tools)


@dataclass(frozen=True, slots=True)
class RecordNeed:
    name: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...] = ()
    label: str = ""
    missing: str = ""

    def issue(self) -> Issue:
        return Issue(self.gate, self.error, self.action, self.tools)


@dataclass(frozen=True, slots=True)
class ReviewReturn:
    to_status: str
    attempt: Literal["new", "same"]
    event_type: str
    choose_when: str
    default: bool = False
    revision: str = ""


@dataclass(frozen=True, slots=True)
class ReviewGate:
    role: str
    error: str
    blocker_code: str
    label: str
    skill: str
    pass_action: str
    returns: tuple[ReviewReturn, ...]
    return_choice_required: bool = False
    return_required_error: str = ""
    forbidden_returns: tuple[tuple[str, str], ...] = ()
    fail_route: ReviewReturn | None = None

    @property
    def action_name(self) -> str:
        return self.role.removesuffix("er")


@dataclass(frozen=True, slots=True)
class Metadata:
    requirements: Mapping[str, tuple[ArtifactNeed | RecordNeed, ...]] = field(default_factory=dict)
    reviews: Mapping[str, ReviewGate] = field(default_factory=dict)
    effects: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    subject: str = ""
    success_outcome: str = "completed"


DEPENDENCIES_NEED = RecordNeed(
    "dependencies", "Every dependency must succeed before work proceeds.",
    "dependencies_pending", "wait_for_dependencies", ("workflow.status_and_next",),
    label="Dependencies done", missing="unfinished dependencies",
)
