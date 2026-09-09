"""Parent/child composition values, expressed using entries and named outcomes."""

from __future__ import annotations

from dataclasses import dataclass, field

from .graph import Data, Issue, Join, Knowledge, Snapshot


@dataclass(frozen=True, slots=True)
class Child:
    key: str
    workflow: str
    data: Data = field(default_factory=dict)
    entry: str = ""
    version: int | None = None
    instance_id: str = ""


@dataclass(frozen=True, slots=True)
class ChildResult:
    key: str
    id: str
    workflow: str
    outcome: str
    data: Data


def wait_for_all(snapshot: Snapshot, knowledge: Knowledge) -> str | None:
    """A plain join for waves; definitions may supply a more specific function."""
    return "children_finished" if all(child.outcome for child in snapshot.children) else None


def join_guard(join: Join, action: str):
    """Enforce the named join route for manual commands as well as auto-routing."""
    def check(snapshot: Snapshot, knowledge: Knowledge):
        if join(snapshot, knowledge) != action:
            return Issue("children_pending", "Wait for the declared child outcomes before taking this route.")
    return check
