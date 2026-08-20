# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Task state machine: brief in, delivery out, one review, two endings."""

from __future__ import annotations

from contextlib import closing
import json
from typing import Any

from merv.shared.artifact_roles import TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE

from .dependencies import dependency_rows, dependent_rows, record_dependencies
from .evidence import (
    ArtifactDocument,
    artifact_state_record,
    brief_checks,
    brief_problems,
    current_slot_artifacts,
    delivery_problems,
    delivery_results,
    delivery_section,
    preferred_artifact,
    render_task_brief,
    require_artifact_document,
    submission_state_record,
)
from .policy import (
    GateEvaluation,
    RequirementEvaluation,
    evaluate_artifact_requirement,
    evaluate_dependency_requirement,
    evaluate_review_gate,
    validate_task_name,
)
from .task_workflow import TASK_WORKFLOW
from .workflow_schema import ArtifactNeed, RecordNeed, ReviewReturn
from ..artifacts import Artifact, ArtifactTarget, Artifacts, Submission
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from ..kernel.utils import new_id, now_iso
from .models import CommittedTaskUpdate


def _query(conn, sql: str, parameters: tuple[Any, ...]) -> list[dict[str, Any]]:
    return rows_to_dicts(rows=conn.execute(sql, parameters).fetchall())


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
    items = [str(item or "").strip() for item in value]
    items = [item for item in items if item]
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


class TaskService:
    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts) -> None:
        self.store = store
        self.artifacts = artifacts

    # ---- create ----

    def create(
        self,
        *,
        name: str,
        goal: str,
        deliverables: list[str] | tuple[str, ...] | str | None = None,
        depends_on: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._create_in_transaction(
                conn=conn,
                project_id=project_id,
                name=name,
                goal=goal,
                deliverables=deliverables,
                depends_on=depends_on,
            )

    def create_from_reflection(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        name: str,
        goal: str,
        deliverables: list[str] | tuple[str, ...] | None = None,
        proposal_key: str = "",
        depends_on: list[str] | str | None = None,
    ) -> dict[str, Any]:
        """Create one reviewed reflection proposal through normal invariants."""
        reflection_id = str(reflection_id or "").strip()
        source = conn.execute(
            "SELECT id FROM reflections WHERE id = ? AND project_id = ?",
            (reflection_id, project_id),
        ).fetchone()
        if source is None:
            raise NotFoundError(f"reflection not found: {reflection_id}")
        return self._create_in_transaction(
            conn=conn,
            project_id=project_id,
            name=name,
            goal=goal,
            deliverables=deliverables,
            depends_on=depends_on,
            source_reflection_id=reflection_id,
            proposal_key=proposal_key,
        )

    def _create_in_transaction(
        self,
        *,
        conn,
        project_id: str,
        name: str,
        goal: str,
        deliverables: list[str] | tuple[str, ...] | str | None,
        depends_on: list[str] | str | None,
        source_reflection_id: str = "",
        proposal_key: str = "",
    ) -> dict[str, Any]:
        name = validate_task_name(name)
        if not (goal or "").strip():
            raise ValidationError(
                "goal is required: short prose — what needs to be done and why "
                "— readable standalone by someone who just opened the task"
            )
        deliverables = _validate_deliverables(deliverables)
        if not source_reflection_id:
            self._reject_reserved_wave_name(conn=conn, project_id=project_id, name=name)
        duplicate = conn.execute(
            "SELECT id FROM tasks WHERE project_id = ? AND lower(name) = lower(?)",
            (project_id, name),
        ).fetchone()
        if duplicate is not None:
            raise ValidationError(
                f"a task named {name!r} already exists in this project — choose "
                "a new name"
            )
        task_id = new_id(prefix="task")
        now = now_iso()
        conn.execute(
            """
            INSERT INTO tasks
              (id, project_id, name, goal, deliverables_json, status,
               attempt_index, revision_context, outcome, failed_by,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, '', '', '', ?, ?)
            """,
            (
                task_id,
                project_id,
                name,
                goal.strip(),
                json.dumps(deliverables),
                TASK_WORKFLOW.initial,
                now,
                now,
            ),
        )
        # The goal is immutable: Merv renders and pins the brief here, once;
        # brief submissions against tasks are refused (see artifacts).
        self.artifacts.pin(
            target=ArtifactTarget("task", task_id, project_id),
            role=TASK_BRIEF_ROLE,
            path=f"tasks/{name}/brief.md",
            data=render_task_brief(
                {"name": name, "goal": goal.strip(), "deliverables": deliverables}
            ).encode("utf-8"),
            title=f"Brief: {name}",
            tx=conn,
        )
        depends_on_ids = (
            [depends_on] if isinstance(depends_on, str) else list(depends_on or [])
        )
        recorded = record_dependencies(
            conn=conn,
            project_id=project_id,
            node_id=task_id,
            depends_on_ids=depends_on_ids,
        )
        event_payload: dict[str, Any] = {
            "name": name,
            "goal": goal.strip(),
            "deliverables": deliverables,
        }
        if recorded:
            event_payload["depends_on"] = recorded
        if source_reflection_id:
            event_payload.update(
                source_reflection_id=source_reflection_id,
                proposal_key=proposal_key.strip(),
            )
        self.store.record_event(
            conn=conn,
            project_id=project_id,
            event_type="task.created",
            target_type="task",
            target_id=task_id,
            payload=event_payload,
        )
        return self.get_state(task_id=task_id, conn=conn)

    def _reject_reserved_wave_name(self, *, conn, project_id: str, name: str) -> None:
        # Names reserved by an in-flight reflection wave (experiments and tasks
        # share the reservation table) are not for tool creates to take.
        row = conn.execute(
            """
            SELECT r.reflection_id FROM reflection_reserved_names r
            JOIN reflections s ON s.id = r.reflection_id
            WHERE r.project_id = ? AND r.name_lower = lower(?)
              AND s.status NOT IN ('published', 'abandoned')
            LIMIT 1
            """,
            (project_id, name),
        ).fetchone()
        if row is not None:
            raise ValidationError(
                f"the name {name!r} is reserved by reflection wave "
                f"{row['reflection_id']} — pick another, or wait for the wave "
                "to publish"
            )

    # ---- read ----

    def get_state(
        self, *, task_id: str, project_id: str | None = None, conn=None
    ) -> dict[str, Any]:
        return self.get_state_with_gate(
            task_id=task_id, project_id=project_id, conn=conn
        )[0]

    def get_state_with_gate(
        self, *, task_id: str, project_id: str | None = None, conn=None
    ) -> tuple[dict[str, Any], GateEvaluation]:
        owns_conn = conn is None
        if conn is None:
            conn = self.store.connect()
        try:
            if owns_conn:
                project_id = self.store.require_project_id(
                    conn=conn, project_id=project_id
                )
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"task not found: {task_id}")
            data = row_to_dict(row=row) or {}
            if project_id is not None and data["project_id"] != project_id:
                raise NotFoundError(f"task not found in project {project_id}: {task_id}")
            history = self.artifacts.history(
                tx=conn,
                target_type="task",
                target_ids=(task_id,),
                summarize=True,
            )[task_id]
            return self._assemble_state_with_gate(
                conn=conn,
                task=data,
                evidence=history.artifacts,
                reviews=_query(
                    conn,
                    """SELECT * FROM reviews
                    WHERE target_type = 'task' AND target_id = ?
                    ORDER BY created_seq DESC""",
                    (task_id,),
                ),
                submissions=history.submissions,
                dependencies=dependency_rows(
                    conn=conn,
                    project_id=str(data["project_id"]),
                    node_ids=(task_id,),
                )[task_id],
                dependents=dependent_rows(
                    conn=conn,
                    project_id=str(data["project_id"]),
                    node_ids=(task_id,),
                )[task_id],
                detail=True,
            )
        finally:
            if owns_conn:
                conn.close()

    def list_states_with_gates(
        self, *, conn, project_id: str, detail_ids: tuple[str, ...] = ()
    ) -> list[tuple[dict[str, Any], GateEvaluation]]:
        """Hydrate a project's task states with one read per child table.
        ``detail_ids`` name the tasks that also get the delivery read (the
        one a status call was asked about)."""
        task_rows = _query(
            conn,
            "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id",
            (project_id,),
        )
        task_ids = tuple(str(row["id"]) for row in task_rows)
        if not task_ids:
            return []
        reviews: dict[str, list[dict[str, Any]]] = {}
        for review in _query(
            conn,
            """SELECT r.* FROM reviews r
            JOIN tasks t ON t.id = r.target_id
            WHERE r.target_type = 'task' AND t.project_id = ?
            ORDER BY t.created_at, t.id, r.created_seq DESC""",
            (project_id,),
        ):
            reviews.setdefault(str(review["target_id"]), []).append(review)
        history = self.artifacts.history(
            tx=conn,
            target_type="task",
            target_ids=task_ids,
            summarize=True,
        )
        dependencies = dependency_rows(conn=conn, project_id=project_id, node_ids=task_ids)
        dependents = dependent_rows(conn=conn, project_id=project_id, node_ids=task_ids)
        return [
            self._assemble_state_with_gate(
                conn=conn,
                task=task,
                evidence=history[str(task["id"])].artifacts,
                reviews=reviews.get(str(task["id"]), []),
                submissions=history[str(task["id"])].submissions,
                dependencies=dependencies.get(str(task["id"]), []),
                dependents=dependents.get(str(task["id"]), []),
                detail=str(task["id"]) in detail_ids,
            )
            for task in task_rows
        ]

    def _assemble_state_with_gate(
        self,
        *,
        conn,
        task: dict[str, Any],
        evidence: tuple[Artifact, ...],
        reviews: list[dict[str, Any]],
        submissions: tuple[Submission, ...],
        dependencies: list[dict[str, Any]],
        dependents: list[dict[str, Any]] | None = None,
        detail: bool = False,
    ) -> tuple[dict[str, Any], GateEvaluation]:
        """Hydrate one task. ``detail`` also reads the delivery document (results,
        report, caveats) — one extra blob read that lists do not pay for."""
        data = dict(task)
        data["artifacts"] = [artifact_state_record(item) for item in evidence]
        data["current_attempt_artifacts"] = current_slot_artifacts(
            data["artifacts"], attempt=data["attempt_index"]
        )
        data["submissions"] = [
            submission_state_record(submission) for submission in submissions
        ]
        for review in reviews:
            review["findings"] = json.loads(review.pop("findings_json", "[]"))
            review["evidence"] = json.loads(review.pop("evidence_json", "{}"))
        data["reviews"] = reviews
        data["dependencies"] = dependencies
        data["dependents"] = list(dependents or [])
        self._attach_documents(task=data, detail=detail)
        evaluation = self._evaluate_gate(conn=conn, task=data)
        data["allowed_transitions"] = [dict(x) for x in evaluation.legal_transitions]
        data["gate_checklist"] = evaluation.checklist()
        return data, evaluation

    def assert_in_project(self, *, task_id: str, project_id: str) -> None:
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT 1 FROM tasks WHERE id = ? AND project_id = ?",
                (task_id, project_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"task not found in project {project_id}: {task_id}")

    def list_task_summaries(self, *, project_id: str | None = None) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, name, goal, status, attempt_index,
                       outcome, failed_by, created_at, updated_at
                FROM tasks
                WHERE project_id = ?
                ORDER BY created_at, id
                """,
                (project_id,),
            ).fetchall()
            return rows_to_dicts(rows=rows)

    # ---- gates ----

    def _evaluate_gate(self, *, conn, task: dict[str, Any]) -> GateEvaluation:
        status = str(task.get("status") or "")
        workflow_state = TASK_WORKFLOW.state(status)
        artifacts = task.get("current_attempt_artifacts") or []
        present_roles = {str(art.get("role")) for art in artifacts if art.get("role")}
        requirements: list[RequirementEvaluation] = []
        for requirement in () if workflow_state is None else workflow_state.requirements:
            if isinstance(requirement, RecordNeed):
                requirements.append(
                    evaluate_dependency_requirement(
                        requirement, dependencies=task.get("dependencies") or []
                    )
                )
                continue
            assert isinstance(requirement, ArtifactNeed)
            present = requirement.role in present_roles
            problems: tuple[str, ...] = ()
            if present and requirement.validator:
                try:
                    self._run_validator(task=task, name=requirement.validator)
                except WorkflowError as exc:
                    problems = (str(exc),)
            requirements.append(
                evaluate_artifact_requirement(requirement, present=present, problems=problems)
            )
        review = (
            None
            if workflow_state is None or workflow_state.review is None
            else evaluate_review_gate(
                conn=conn,
                target_type="task",
                target=task,
                review=workflow_state.review,
            )
        )
        return GateEvaluation(
            workflow=TASK_WORKFLOW,
            status=status,
            requirements=tuple(requirements),
            review=review,
        )

    def _run_validator(self, *, task: dict[str, Any], name: str) -> None:
        if name == "brief":
            self._validate_brief(task=task)
        elif name == "delivery":
            self._validate_delivery(task=task)

    def _submitted_document(
        self, *, task: dict[str, Any], role: str, what: str
    ) -> ArtifactDocument | None:
        artifact = preferred_artifact(
            artifacts=task.get("current_attempt_artifacts") or [],
            roles=(role,),
        )
        if artifact is None:
            return None
        artifact_id = str(artifact.get("id") or "")
        found = self.artifacts.get(artifact_ids=(artifact_id,), include="document")
        return require_artifact_document(
            found[0] if found else None, artifact_id=artifact_id, what=what
        )

    def _document_or_none(self, *, task: dict[str, Any], role: str, what: str):
        try:
            return self._submitted_document(task=task, role=role, what=what)
        except WorkflowError:
            return None

    def _attach_documents(self, *, task: dict[str, Any], detail: bool) -> None:
        """The structure the UI renders: the goal's deliverables (the column;
        pre-53 rows fall back to the brief's list) and — for detail reads —
        the delivery's confirmations, Notes prose, and legacy Caveats."""
        raw = task.pop("deliverables_json", None)
        try:
            deliverables = [str(x) for x in json.loads(raw or "[]")]
        except (TypeError, ValueError):
            deliverables = []
        if not deliverables:
            brief = self._document_or_none(
                task=task, role=TASK_BRIEF_ROLE, what="task brief"
            )
            deliverables = [] if brief is None else brief_checks(brief.text)
        task["deliverables"] = deliverables
        # `checks` stays as the agent-facing alias for the same list.
        task["checks"] = list(deliverables)
        if not detail:
            return
        task["results"] = []
        task["report"] = None
        task["caveats"] = None
        delivery = self._document_or_none(
            task=task, role=TASK_DELIVERY_ROLE, what="task delivery"
        )
        if delivery is None:
            return
        task["results"] = delivery_results(delivery.text, count=len(deliverables))
        task["report"] = delivery_section(delivery.text, "notes") or delivery_section(
            delivery.text, "report"
        )
        task["caveats"] = delivery_section(delivery.text, "caveats")

    def _validate_brief(self, *, task: dict[str, Any]) -> None:
        document = self._submitted_document(
            task=task, role=TASK_BRIEF_ROLE, what="task brief"
        )
        if document is None:
            raise WorkflowError("no 'brief' artifact is submitted for this task")
        problems = brief_problems(document.text)
        if problems:
            raise WorkflowError(
                "task brief is not ready: "
                + "; ".join(problems)
                + ". Fix the file and resubmit it (artifact.submit) — see "
                "skills/research-workflow/brief-template.md."
            )

    def _validate_delivery(self, *, task: dict[str, Any]) -> None:
        checks = [str(x) for x in task.get("deliverables") or []]
        if not checks:
            raise WorkflowError(
                "this task has no deliverables to confirm — it predates "
                "structured goals and its brief lists none; the owner should "
                "end it (mark_failed) and create a task with deliverables"
            )
        document = self._submitted_document(
            task=task, role=TASK_DELIVERY_ROLE, what="task delivery"
        )
        if document is None:
            raise WorkflowError("no 'delivery' artifact is submitted for this task")
        problems = delivery_problems(document.text, checks=checks)
        if problems:
            raise WorkflowError(
                "task delivery is not ready for review: "
                + "; ".join(problems)
                + ". Fix the file and resubmit it (artifact.submit) — see "
                "skills/research-workflow/delivery-template.md."
            )

    # ---- transitions ----

    def transition_with_event(
        self,
        *,
        task_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> CommittedTaskUpdate:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            task, gate = self.get_state_with_gate(
                task_id=task_id, project_id=project_id, conn=conn
            )
            status = task["status"]
            next_status = gate.require_transition(transition)
            step = TASK_WORKFLOW.transition(transition)
            if step is None:
                raise WorkflowError(f"unknown task transition: {transition}")
            now = now_iso()
            self.artifacts.seal(
                tx=conn,
                target=ArtifactTarget("task", task_id, task["project_id"]),
                transition=transition,
            )
            evidence = evidence or {}
            if "record_outcome" in step.effects:
                conn.execute(
                    "UPDATE tasks SET status = ?, outcome = ?, updated_at = ? WHERE id = ?",
                    (next_status, self._note_from_evidence(evidence, "outcome"), now, task_id),
                )
            elif "record_failure" in step.effects:
                conn.execute(
                    """
                    UPDATE tasks SET status = ?, outcome = ?, failed_by = 'owner',
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (next_status, self._note_from_evidence(evidence, "reason"), now, task_id),
                )
            else:
                conn.execute(
                    "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                    (next_status, now, task_id),
                )
            event = self.store.record_event(
                conn=conn,
                project_id=task["project_id"],
                event_type=TASK_WORKFLOW.event_type,
                target_type="task",
                target_id=task_id,
                payload={
                    "from": status,
                    "to": next_status,
                    "transition": transition,
                    "evidence": evidence,
                },
            )
            state = self.get_state(task_id=task_id, conn=conn)
            return CommittedTaskUpdate(state=state, event=event)

    @staticmethod
    def _note_from_evidence(evidence: dict[str, Any], key: str) -> str:
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        for alternative in ("outcome", "reason", "note", "notes", "summary"):
            candidate = evidence.get(alternative)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return json.dumps(evidence, sort_keys=True) if evidence else ""

    def return_from_review(
        self,
        *,
        conn,
        task_id: str,
        route: ReviewReturn,
        revision_context: str,
    ) -> None:
        """Apply the declared destination: back to in_progress, or ended."""
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"task not found: {task_id}")
        review_state = TASK_WORKFLOW.review_state("task_reviewer")
        if review_state is None or row["status"] != review_state.name:
            raise WorkflowError(
                f"task is {row['status']!r}; only a task under review can be "
                f"sent to {route.to_status}"
            )
        now = now_iso()
        if route.to_status in TASK_WORKFLOW.terminal_statuses:
            conn.execute(
                """
                UPDATE tasks
                SET status = ?, outcome = ?, failed_by = 'reviewer',
                    revision_context = ?, updated_at = ?
                WHERE id = ?
                """,
                (route.to_status, revision_context, revision_context, now, task_id),
            )
        else:
            conn.execute(
                """
                UPDATE tasks
                SET status = ?, revision_context = ?, updated_at = ?
                WHERE id = ?
                """,
                (route.to_status, revision_context, now, task_id),
            )
        self.store.record_event(
            conn=conn,
            project_id=row["project_id"],
            event_type=route.event_type,
            target_type="task",
            target_id=task_id,
            payload={"revision_context": revision_context},
        )


__all__ = ["TaskService"]
