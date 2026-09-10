# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""What is true of tasks alone: the immutable goal, its brief, and its delivery."""

from __future__ import annotations

from contextlib import closing
import json
from typing import Any

from ..workflows import KINDS, TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE, Snapshot
from .evidence import (
    ArtifactDocument,
    brief_checks,
    delivery_results,
    delivery_section,
    preferred_artifact,
    render_task_brief,
    require_artifact_document,
)
from .policy import GateEvaluation, validate_task_name
from .artifact_models import ArtifactTarget
from .records import RecordHooks, Records
from ..kernel.state.store import BaseStateStore, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from .models import CommittedTaskUpdate

TASK = KINDS["task"]
_MAX_DELIVERABLES = 12
_MAX_DELIVERABLE_CHARS = 500


def _validate_deliverables(value: Any) -> list[str]:
    """The goal's contract: 1..N deliverables, each verifiable as written."""
    if isinstance(value, str):
        value = [value]
    if value is None or not isinstance(value, (list, tuple)):
        raise ValidationError(
            "deliverables is required: a list of the things that must exist "
            "when the task is done — each one thing, verifiable as written"
        )
    items = [text for item in value if (text := str(item or "").strip())]
    if not items:
        raise ValidationError(
            "deliverables needs at least one item — a thing that must exist "
            "when the task is done, verifiable as written"
        )
    if len(items) > _MAX_DELIVERABLES:
        raise ValidationError(
            f"{len(items)} deliverables is too many (max {_MAX_DELIVERABLES}; "
            "the rule of thumb is 1-7) — this is probably two tasks"
        )
    for index, item in enumerate(items, start=1):
        if len(item) > _MAX_DELIVERABLE_CHARS:
            raise ValidationError(
                f"deliverable {index} is {len(item)} characters; keep each "
                f"under {_MAX_DELIVERABLE_CHARS} — one thing, stated so it "
                "can be checked"
            )
    return items


class TaskService(RecordHooks):
    """The task's own rules; every lifecycle step runs on ``Records``."""

    def __init__(self, *, store: BaseStateStore, records: Records) -> None:
        self.store = store
        self.records = records
        self.artifacts = records.artifacts
        records.register(TASK, self)

    # ---- create ----

    def create(
        self, *, name: str, goal: str,
        deliverables: list[str] | tuple[str, ...] | str | None = None,
        depends_on: list[str] | str | None = None, project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._create(conn=conn, project_id=project_id, name=name, goal=goal,
                                deliverables=deliverables, depends_on=depends_on)

    def create_from_reflection(
        self, *, conn, project_id: str, reflection_id: str, name: str, goal: str,
        deliverables: list[str] | tuple[str, ...] | None = None, proposal_key: str = "",
        depends_on: list[str] | str | None = None,
    ) -> dict[str, Any]:
        """Create one reviewed reflection proposal through normal invariants."""
        reflection_id = str(reflection_id or "").strip()
        if conn.execute("SELECT id FROM reflections WHERE id = ? AND project_id = ?",
                        (reflection_id, project_id)).fetchone() is None:
            raise NotFoundError(f"reflection not found: {reflection_id}")
        return self._create(conn=conn, project_id=project_id, name=name, goal=goal,
                            deliverables=deliverables, depends_on=depends_on, guard=False,
                            source={"source_reflection_id": reflection_id, "proposal_key": proposal_key.strip()})

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        self._create(conn=conn, project_id=snapshot.project_id, instance=snapshot,
                     name=str(snapshot.data.get("name") or ""), goal=str(snapshot.data.get("goal") or ""),
                     deliverables=snapshot.data.get("deliverables"), depends_on=snapshot.data.get("depends_on"))

    def _create(self, *, conn, project_id, name, goal, deliverables, depends_on=None,
                guard=True, source=None, instance=None) -> dict[str, Any]:
        name = validate_task_name(name)
        if not (goal or "").strip():
            raise ValidationError(
                "goal is required: short prose — what needs to be done and why "
                "— readable standalone by someone who just opened the task"
            )
        deliverables = _validate_deliverables(deliverables)
        return self.records.create_in_transaction(
            TASK, conn=conn, project_id=project_id, guard=guard, instance=instance,
            values={"name": name, "goal": goal.strip(), "deliverables_json": json.dumps(deliverables),
                    "deliverables": deliverables},
            event={"name": name, "goal": goal.strip(), "deliverables": deliverables, **(source or {})},
            depends_on=depends_on,
        )

    # ---- declared hooks ----

    def before_create(self, *, conn, project_id: str, values: dict[str, Any]) -> None:
        # Names reserved by an in-flight reflection wave (experiments and tasks
        # share the reservation table) are not for tool creates to take.
        row = conn.execute(
            """SELECT r.reflection_id FROM reflection_reserved_names r
               JOIN reflections s ON s.id = r.reflection_id
               WHERE r.project_id = ? AND r.name_lower = lower(?)
                 AND s.status NOT IN ('published', 'abandoned') LIMIT 1""",
            (project_id, str(values["name"])),
        ).fetchone()
        if row is not None:
            raise ValidationError(
                f"the name {str(values['name'])!r} is reserved by reflection wave "
                f"{row['reflection_id']} — pick another, or wait for the wave to publish")

    def after_create(self, *, conn, project_id: str, record_id: str, values: dict[str, Any]) -> None:
        # The goal is immutable: Merv renders and pins the brief here, once;
        # brief submissions against tasks are refused (see artifacts).
        name = str(values["name"])
        self.artifacts.pin(
            target=ArtifactTarget("task", record_id, project_id), role=TASK_BRIEF_ROLE,
            path=f"tasks/{name}/brief.md", title=f"Brief: {name}", tx=conn,
            data=render_task_brief({"name": name, "goal": values["goal"],
                                    "deliverables": values["deliverables"]}).encode("utf-8"),
        )

    def hydrate(self, *, conn, project_id: str, records: list[dict[str, Any]], detail_ids=()) -> None:
        """The structure the UI renders: the goal's deliverables (the column;
        pre-53 rows fall back to the brief's list) and — for detail reads —
        the delivery's confirmations, Notes prose, and legacy Caveats."""
        for task in records:
            if not task["deliverables"]:
                brief = self._document(task=task, role=TASK_BRIEF_ROLE, what="task brief")
                task["deliverables"] = [] if brief is None else brief_checks(brief.text)
            # `checks` stays as the agent-facing alias for the same list.
            task["checks"] = list(task["deliverables"])
            if str(task["id"]) not in detail_ids:
                continue
            delivery = self._document(task=task, role=TASK_DELIVERY_ROLE, what="task delivery")
            task["results"] = [] if delivery is None else delivery_results(delivery.text, count=len(task["deliverables"]))
            task["report"] = None if delivery is None else (
                delivery_section(delivery.text, "notes") or delivery_section(delivery.text, "report"))
            task["caveats"] = None if delivery is None else delivery_section(delivery.text, "caveats")

    def after_commit(self, *, conn, before, after, action: str, payload) -> None:
        """Who ended the task, and with what note; the status write is declared."""
        if action == "fail_review":
            conn.execute("UPDATE tasks SET outcome = ?, failed_by = 'reviewer' WHERE id = ?",
                         (str(after.data.get("revision_context") or ""), before.id))
        elif action == "mark_failed":
            conn.execute("UPDATE tasks SET outcome = ?, failed_by = 'owner' WHERE id = ?",
                         (_note_from_evidence(dict(payload)), before.id))

    def _document(self, *, task: dict[str, Any], role: str, what: str) -> ArtifactDocument | None:
        artifact = preferred_artifact(artifacts=task.get("current_attempt_artifacts") or [], roles=(role,))
        if artifact is None:
            return None
        artifact_id = str(artifact.get("id") or "")
        found = self.artifacts.get(artifact_ids=(artifact_id,), include="document")
        try:
            return require_artifact_document(found[0] if found else None, artifact_id=artifact_id, what=what)
        except WorkflowError:
            return None

    # ---- reads and transitions ----

    def get_state(self, *, task_id: str, project_id: str | None = None, conn=None) -> dict[str, Any]:
        return self.records.get_state(TASK, record_id=task_id, project_id=project_id, conn=conn)

    def get_state_with_gate(self, *, task_id: str, project_id: str | None = None,
                            conn=None) -> tuple[dict[str, Any], GateEvaluation]:
        return self.records.get_state_with_gate(TASK, record_id=task_id, project_id=project_id, conn=conn)

    def list_states_with_gates(self, *, conn, project_id: str, detail_ids: tuple[str, ...] = ()):
        """``detail_ids`` name the tasks that also pay for the delivery read."""
        return self.records.list_states_with_gates(TASK, conn=conn, project_id=project_id, detail_ids=detail_ids)

    def assert_in_project(self, *, task_id: str, project_id: str) -> None:
        self.records.assert_in_project(TASK, record_id=task_id, project_id=project_id)

    def list_task_summaries(self, *, project_id: str | None = None) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return rows_to_dicts(rows=conn.execute(
                """SELECT id, project_id, name, goal, status, attempt_index, outcome, failed_by,
                          created_at, updated_at
                   FROM tasks WHERE project_id = ? ORDER BY created_at, id""",
                (project_id,)).fetchall())

    def transition_with_event(
        self, *, task_id: str, transition: str, evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> CommittedTaskUpdate:
        state, event = self.records.transition(TASK, record_id=task_id, transition=transition,
                                               evidence=evidence, project_id=project_id)
        return CommittedTaskUpdate(state=state, event=event)


def _note_from_evidence(evidence: dict[str, Any]) -> str:
    for key in ("reason", "outcome", "note", "notes", "summary"):
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return json.dumps(evidence, sort_keys=True) if evidence else ""


__all__ = ["TaskService"]
