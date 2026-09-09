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
    current_slot_artifacts,
    delivery_results,
    delivery_section,
    preferred_artifact,
    render_task_brief,
    require_artifact_document,
    submission_state_record,
)
from .policy import (
    GateEvaluation,
    evaluate_artifact_requirement,
    evaluate_dependency_requirement,
    evaluate_review_gate,
    read_review_fact,
    review_snapshot_id,
    snapshot_from_id,
    validate_task_name,
)
from .task_workflow import TASK_WORKFLOW
from ..workflows import Reference, Runtime, Snapshot, WORKFLOWS
from .workflow_schema import RecordNeed, Workflow
from .artifacts import ResearchArtifacts as Artifacts
from .artifact_models import Artifact, ArtifactTarget, Submission
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from ..kernel.utils import new_id, now_iso
from .models import CommittedTaskUpdate


def _query(conn, sql: str, parameters: tuple[Any, ...]) -> list[dict[str, Any]]:
    return rows_to_dicts(rows=conn.execute(sql, parameters).fetchall())


_MAX_DELIVERABLES = 12
_MAX_DELIVERABLE_CHARS = 500
TASK = WORKFLOWS["task"]


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
    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts, runtime: Runtime) -> None:
        self.store = store
        self.artifacts = artifacts
        self.runtime = runtime

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
        workflow_instance: Snapshot | None = None,
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
        task_id = new_id(prefix="task") if workflow_instance is None else workflow_instance.id
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
        if workflow_instance is None:
            self.runtime.adopt(conn=conn, project_id=project_id, instance_id=task_id,
                               workflow="task", state=TASK.initial)
        return self.get_state(task_id=task_id, conn=conn)

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        self._create_in_transaction(
            conn=conn, project_id=snapshot.project_id, name=str(snapshot.data.get("name") or ""),
            goal=str(snapshot.data.get("goal") or ""), deliverables=snapshot.data.get("deliverables"),
            depends_on=snapshot.data.get("depends_on"), workflow_instance=snapshot,
        )

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
        snapshots = self.runtime.snapshots(project_id=project_id, conn=conn)
        return [
            self._assemble_state_with_gate(
                conn=conn, snapshots=snapshots,
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
        snapshots: dict[str, Snapshot] | None = None,
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
        evaluation = self._evaluate_gate(conn=conn, task=data, snapshots=snapshots)
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

    def _evaluate_gate(self, *, conn, task: dict[str, Any], snapshots=None) -> GateEvaluation:
        status = str(task["status"])
        if snapshots is None:
            try:
                snapshot = self.runtime.get(project_id=task["project_id"], instance_id=task["id"], conn=conn)
            except NotFoundError:
                snapshot = None
        else:
            snapshot = snapshots.get(task["id"])
        if snapshot is None:
            snapshot = Snapshot(id=task["id"], project_id=task["project_id"], workflow="task",
                                version=1, state=status, revision=0,
                                data={"attempt_index": task["attempt_index"]}, outcome=TASK.outcomes.get(status, ""))
        knowledge = _TaskKnowledge(self, conn, task, snapshot)
        decision = self.runtime.registry.get("task", snapshot.version).evaluate(snapshot, knowledge)
        workflow = Workflow(self.runtime.registry.get("task", snapshot.version), TASK_WORKFLOW.metadata)
        workflow_state = workflow.state(snapshot.state)
        requirements = []
        for need in () if workflow_state is None else workflow_state.requirements:
            if isinstance(need, RecordNeed):
                requirements.append(evaluate_dependency_requirement(need, dependencies=task.get("dependencies") or []))
            else:
                present = any(item.get("role") == need.role for item in task.get("current_attempt_artifacts") or [])
                problem = next((issue.message for action in decision.blocked for issue in action.issues
                                if issue.code == f"{need.role}_invalid"), "")
                requirements.append(evaluate_artifact_requirement(need, present=present, problems=(problem,) if problem else ()))
        review = None if workflow_state is None or workflow_state.review is None else evaluate_review_gate(
            conn=conn, target_type="task", target=task, review=workflow_state.review, snapshot=snapshot)
        return GateEvaluation(workflow=workflow, status=status, requirements=tuple(requirements),
                              review=review, decision=decision)

    def _workflow_knowledge(self, snapshot: Snapshot, conn):
        task = self.get_state(task_id=snapshot.id, project_id=snapshot.project_id, conn=conn)
        if task["status"] != snapshot.state:
            raise WorkflowError("task state differs from its workflow instance; an explicit migration is required")
        return _TaskKnowledge(self, conn, task, snapshot)

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

    # ---- transitions ----

    def transition_with_event(
        self, *, task_id: str, transition: str,
        evidence: dict[str, Any] | None = None, project_id: str | None = None,
    ) -> CommittedTaskUpdate:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            task = self.get_state(task_id=task_id, project_id=project_id, conn=conn)
            current = self.runtime.adopt(conn=conn, project_id=project_id, instance_id=task_id,
                                         workflow="task", state=task["status"])
            after = self.runtime.apply_in_transaction(
                conn=conn, project_id=project_id, instance_id=task_id, action=transition,
                expected_revision=current.revision, request_id=new_id(prefix="task_action"), payload=evidence or {},
            )
            return CommittedTaskUpdate(
                state=self.get_state(task_id=task_id, project_id=project_id, conn=conn),
                event=self.runtime.event(conn=conn, snapshot=after),
            )

    def _commit_workflow_change(self, conn, before, after, action, payload) -> None:
        if action == "start_work":
            return
        # The runtime owns graph decisions, revision checks and the event. This
        # adapter keeps the released task record and its evidence transactional.
        if action not in {"revise", "fail_review", "migrate"}:
            self.artifacts.seal(tx=conn, target=ArtifactTarget("task", before.id, before.project_id), transition=action)
        now = now_iso()
        if action in {"revise", "fail_review"}:
            revision = str(after.data.get("revision_context") or "")
            conn.execute(
                "UPDATE tasks SET status = ?, revision_context = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                (after.state, revision, now, before.id, before.project_id),
            )
            if action == "fail_review":
                conn.execute("UPDATE tasks SET outcome = ?, failed_by = 'reviewer' WHERE id = ?", (revision, before.id))
        elif action == "accept":
            conn.execute("UPDATE tasks SET status = ?, outcome = ?, updated_at = ? WHERE id = ?",
                         (after.state, str(after.data.get("outcome") or ""), now, before.id))
        elif action == "mark_failed":
            conn.execute("UPDATE tasks SET status = ?, outcome = ?, failed_by = 'owner', updated_at = ? WHERE id = ?",
                         (after.state, self._note_from_evidence(dict(payload), "reason"), now, before.id))
        else:
            conn.execute("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", (after.state, now, before.id))

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



class _TaskKnowledge:
    """Project-bound task facts; definitions receive no connection or writer."""

    def __init__(self, service, conn, task, snapshot):
        self.service, self.conn, self.task, self.snapshot = service, conn, task, snapshot
        self._review = None

    def read(self, reference: Reference):
        task, conn = self.task, self.conn
        if reference.kind == "task" and reference.id == task["id"]:
            return task
        if reference.kind == "project" and reference.id == task["project_id"]:
            row = conn.execute("SELECT id, name, summary FROM projects WHERE id = ?", (reference.id,)).fetchone()
            return {} if row is None else dict(row)
        if reference.kind == "artifact":
            history = self.service.artifacts.history(tx=conn, target_type="task", target_ids=(task["id"],))[task["id"]]
            artifact = next((item for item in history.artifacts if item.id == reference.id and item.project_id == task["project_id"]), None)
            if artifact is not None:
                try:
                    self.service.artifacts.contents.assert_complete(artifact_ids=(artifact.artifact_id,), project_id=task["project_id"], tx=conn)
                    content = self.service.artifacts.contents.get(artifact_ids=(artifact.artifact_id,), project_id=task["project_id"], include="document", tx=conn)[0]
                    if content.data is None:
                        raise WorkflowError(f"{artifact.path} has no retained content")
                    return {"text": content.data.decode("utf-8"), "error": ""}
                except (WorkflowError, ValidationError, NotFoundError, UnicodeDecodeError) as exc:
                    return {"text": "", "error": str(exc)}
        if reference.kind in {"review", "review_snapshot"}:
            if reference.kind == "review_snapshot" and reference.id != task["id"]:
                raise NotFoundError("review snapshot belongs to another workflow instance")
            node = self.service.runtime.registry.get(self.snapshot.workflow, self.snapshot.version).node(self.snapshot.state)
            role = reference.id if reference.kind == "review" else (node.role if node is not None else "")
            return read_review_fact(conn=conn, project_id=task["project_id"], target_type="task",
                                    target_id=task["id"], role=role, request=reference.kind == "review_snapshot",
                                    snapshot_id=review_snapshot_id(target_type="task", target=task, snapshot=self.snapshot))
        raise NotFoundError(f"task fact not available: {reference.kind}/{reference.id}")


__all__ = ["TaskService"]
