# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""One engine for every native record bound to a workflow.

A ``RecordKind`` says what a kind's row looks like; this module is the runtime
that interprets it. Creation, hydration, gate evaluation, workflow knowledge and
transactional commit are written once here. What genuinely differs per kind is
the declaration beside its graph plus the hooks in ``RecordHooks``.
"""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import closing
import json
from typing import Any

from ..kernel.state.store import BaseStateStore, next_created_seq, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError, new_id, now_iso
from ..workflows import Binding, RecordKind, Reference, ReviewGate, Runtime, Snapshot, documents
from .artifacts import ResearchArtifacts as Artifacts
from .artifact_models import ArtifactTarget
from .dependencies import dependency_rows, dependent_rows, record_dependencies
from .reviews import read_review_fact
from .policy import GateContext, GateEvaluation, resolve_requirement, review_snapshot_id, snapshot_from_id


def _query(conn, sql: str, parameters: tuple[Any, ...]) -> list[dict[str, Any]]:
    return rows_to_dicts(rows=conn.execute(sql, parameters).fetchall())


class RecordHooks:
    """The per-kind logic an engine cannot infer from a declaration.

    Every hook is a no-op by default; a kind's service overrides only what its
    own invariants need. Hooks receive the open transaction because that is
    exactly why they are not part of the declaration.
    """

    def before_create(self, *, conn, project_id: str, values: dict[str, Any]) -> None:
        """Refuse a create the kind's own invariants forbid."""

    def after_create(self, *, conn, project_id: str, record_id: str, values: dict[str, Any]) -> None:
        """Write the kind's child rows on the same transaction as its row."""

    def hydrate(self, *, conn, project_id: str, records: list[dict[str, Any]], detail_ids: tuple[str, ...]) -> None:
        """Add the kind's own read state to every record in one batch."""

    def before_write(self, *, conn, before: Snapshot, after: Snapshot, action: str) -> None:
        """Refuse a transition before native writes, inside the caller's transaction."""

    def after_write(self, *, conn, before: Snapshot, after: Snapshot, action: str, payload) -> None:
        """React after native writes, still inside the caller's uncommitted transaction."""

    def read_fact(self, *, conn, record: dict[str, Any], reference: Reference) -> dict[str, Any] | None:
        """Answer a graph reference only this kind knows about."""
        return None

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        """Create the kind's row for an instance the runtime just started."""

    def bindings(self) -> Mapping[str, Binding]:
        """The table-less graphs this owner runs: knowledge and commit for a graph
        with no row, returned here instead of reached for from composition."""
        return {}


class Records:
    """Create, read, gate, and transition every declared record kind."""

    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts, runtime: Runtime) -> None:
        self.store = store
        self.artifacts = artifacts
        self.runtime = runtime
        # What this brain installed: the kinds their services registered.
        self.kinds: dict[str, RecordKind] = {}
        self.hooks: dict[str, RecordHooks] = {}

    def register(self, kind: RecordKind, hooks: RecordHooks) -> None:
        self.kinds[kind.name] = kind
        self.hooks[kind.name] = hooks

    # ---- create ----

    def create_in_transaction(
        self, kind: RecordKind, *, conn, project_id: str, values: dict[str, Any], event: dict[str, Any],
        depends_on=(), instance: Snapshot | None = None, guard: bool = True,
        read: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Insert one record on the caller's transaction, then read its state back.

        The reflection wave calls this on its own connection, which is why the
        engine never opens one here: every node of a materialized wave is
        created before any dependency edge between them.
        """
        hooks = self.hooks[kind.name]
        if guard:
            hooks.before_create(conn=conn, project_id=project_id, values=values)
        name = str(values.get(kind.label) or "")
        if kind.unique_name and conn.execute(
            f"SELECT id FROM {kind.table} WHERE project_id = ? AND lower({kind.label}) = lower(?)",
            (project_id, name),
        ).fetchone() is not None:
            article = "an" if kind.name[0] in "aeiou" else "a"
            raise ValidationError(
                f"{article} {kind.name} named {name!r} already exists in this project — choose a new name"
            )
        record_id = new_id(prefix=kind.id_prefix) if instance is None else instance.id
        now = now_iso()
        columns = ("id", "project_id", "status", "attempt_index", "revision_context",
                   "created_at", "updated_at", *kind.columns)
        parameters: list[Any] = [
            record_id, project_id,
            kind.workflow.initial if instance is None else kind.status_of(instance.state),
            1, "", now, now, *(values.get(column) for column in kind.columns),
        ]
        if kind.created_seq:
            columns += ("created_seq",)
            parameters.append(next_created_seq(conn=conn, table=kind.table))
        conn.execute(
            f"INSERT INTO {kind.table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
            tuple(parameters),
        )
        hooks.after_create(conn=conn, project_id=project_id, record_id=record_id, values=values)
        if kind.dependencies:
            recorded = record_dependencies(
                conn=conn, project_id=project_id, node_id=record_id,
                depends_on_ids=[depends_on] if isinstance(depends_on, str) else list(depends_on or []),
            )
            if recorded:
                event = {**event, "depends_on": recorded}
        self.store.record_event(conn=conn, project_id=project_id, event_type=kind.created_event,
                                target_type=kind.name, target_id=record_id, payload=event)
        if instance is None:
            self.runtime.adopt(conn=conn, project_id=project_id, instance_id=record_id,
                               workflow=kind.name, state=kind.workflow.initial, data={"attempt_index": 1})
        return self.get_state(kind, record_id=record_id, conn=conn, **(read or {}))

    # ---- read ----

    def assert_in_project(self, kind: RecordKind, *, record_id: str, project_id: str) -> None:
        """Verify identity and scope without hydrating the record's child rows."""
        with closing(self.store.connect()) as conn:
            row = conn.execute(f"SELECT 1 FROM {kind.table} WHERE id = ? AND project_id = ?",
                               (record_id, project_id)).fetchone()
        if row is None:
            raise NotFoundError(f"{kind.name} not found in project {project_id}: {record_id}")

    def get_state(self, kind: RecordKind, *, record_id: str, project_id: str | None = None,
                  conn=None, **extra) -> dict[str, Any]:
        return self.get_state_with_gate(kind, record_id=record_id, project_id=project_id, conn=conn, **extra)[0]

    def get_state_with_gate(self, kind: RecordKind, *, record_id: str, project_id: str | None = None,
                            conn=None, **extra) -> tuple[dict[str, Any], GateEvaluation]:
        owns_conn = conn is None
        if conn is None:
            conn = self.store.connect()
        try:
            if owns_conn:
                project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(f"SELECT * FROM {kind.table} WHERE id = ?", (record_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"{kind.name} not found: {record_id}")
            record = row_to_dict(row=row) or {}
            if project_id is not None and record["project_id"] != project_id:
                raise NotFoundError(f"{kind.name} not found in project {project_id}: {record_id}")
            return self._assemble(kind, conn=conn, records=[record], detail_ids=(record_id,), **extra)[0]
        finally:
            if owns_conn:
                conn.close()

    def list_states_with_gates(self, kind: RecordKind, *, conn, project_id: str,
                               detail_ids: tuple[str, ...] = (), **extra):
        """Hydrate a project's records with one read per child table."""
        records = _query(conn, f"SELECT * FROM {kind.table} WHERE project_id = ? ORDER BY created_at, id",
                         (project_id,))
        if not records:
            return []
        return self._assemble(kind, conn=conn, records=records, detail_ids=detail_ids,
                              snapshots=self.runtime.snapshots(project_id=project_id, conn=conn), **extra)

    def _assemble(self, kind: RecordKind, *, conn, records: list[dict[str, Any]],
                  detail_ids: tuple[str, ...], snapshots=None, **extra):
        project_id = str(records[0]["project_id"])
        record_ids = tuple(str(record["id"]) for record in records)
        history = self.artifacts.history(tx=conn, target_type=kind.name, target_ids=record_ids, summarize=True)
        reviews: dict[str, list[dict[str, Any]]] = {}
        # A focused read pays for one record's reviews; a project read joins once.
        focused = " AND r.target_id = ?" if len(record_ids) == 1 else ""
        for review in _query(conn, f"""SELECT r.* FROM reviews r JOIN {kind.table} t ON t.id = r.target_id
                                       WHERE r.target_type = ? AND t.project_id = ?{focused}
                                       ORDER BY t.created_at, t.id, r.created_seq DESC""",
                             (kind.name, project_id, *(record_ids[:1] if focused else ()))):
            review["findings"] = json.loads(review.pop("findings_json", "[]"))
            review["evidence"] = json.loads(review.pop("evidence_json", "{}"))
            reviews.setdefault(str(review["target_id"]), []).append(review)
        dependencies = dependency_rows(conn=conn, project_id=project_id, node_ids=record_ids) if kind.dependencies else {}
        dependents = dependent_rows(conn=conn, project_id=project_id, node_ids=record_ids) if kind.dependencies else {}
        for record in records:
            record_id = str(record["id"])
            for column, (field, empty) in kind.json_columns.items():
                record[field] = json.loads(str(record.pop(column, None) or empty))
            record["artifacts"] = [{**documents.artifact_state_record(item), "artifact_id": item.artifact_id}
                                   for item in history[record_id].artifacts]
            record["current_attempt_artifacts"] = documents.current_slot_artifacts(
                record["artifacts"], attempt=record["attempt_index"])
            record["submissions"] = [documents.submission_state_record(item) for item in history[record_id].submissions]
            record["reviews"] = reviews.get(record_id, [])
            if kind.dependencies:
                record["dependencies"] = dependencies.get(record_id, [])
                record["dependents"] = dependents.get(record_id, [])
        self.hooks[kind.name].hydrate(conn=conn, project_id=project_id, records=records,
                                      detail_ids=detail_ids, **extra)
        assembled = []
        for record in records:
            evaluation = self.evaluate_gate(kind, conn=conn, record=record, snapshots=snapshots)
            record["allowed_transitions"] = [dict(item) for item in evaluation.legal_transitions]
            record["gate_checklist"] = evaluation.checklist()
            assembled.append((record, evaluation))
        return assembled

    # ---- gates ----

    def snapshot_for(self, kind: RecordKind, *, conn, record: dict[str, Any], snapshots=None) -> Snapshot:
        """The record's workflow instance, or a projection of the row alone."""
        record_id, status = str(record["id"]), str(record.get("status") or "")
        if snapshots is not None:
            snapshot = snapshots.get(record_id)
        else:
            try:
                snapshot = self.runtime.get(project_id=record["project_id"], instance_id=record_id, conn=conn)
            except NotFoundError:
                snapshot = None
        if snapshot is not None:
            return snapshot
        return Snapshot(id=record_id, project_id=record["project_id"], workflow=kind.name, version=1,
                        state=status, revision=0, data={"attempt_index": record.get("attempt_index") or 1},
                        outcome=kind.workflow.outcomes.get(status, ""))

    def evaluate_gate(self, kind: RecordKind, *, conn, record: dict[str, Any], snapshots=None) -> GateEvaluation:
        """Evaluate the registered graph once; the checklist reads that evaluation."""
        snapshot = self.snapshot_for(kind, conn=conn, record=record, snapshots=snapshots)
        definition = self.runtime.registry.get(kind.name, snapshot.version)
        knowledge = RecordKnowledge(self, kind, conn, record, snapshot)
        decision = definition.evaluate(snapshot, knowledge)
        context = GateContext(record=record, snapshot=snapshot,
                              reviews={need.role: knowledge.review_fact(need.role) for need in kind.requirements(snapshot.state)
                                       if isinstance(need, ReviewGate)},
                              issues=(*(issue for action in decision.actions for issue in action.issues),
                                      *decision.dispatch_issues))
        resolved = [(need, resolve_requirement(need, context)) for need in kind.requirements(snapshot.state)]
        return GateEvaluation(
            status=str(record.get("status") or ""),
            requirements=tuple(item for need, item in resolved if not isinstance(need, ReviewGate)),
            review=next((item for need, item in resolved if isinstance(need, ReviewGate)), None),
            decision=decision,
        )

    # ---- workflow binding ----

    def knowledge(self, kind: RecordKind, snapshot: Snapshot, conn) -> RecordKnowledge:
        record = self.get_state(kind, record_id=snapshot.id, project_id=snapshot.project_id, conn=conn)
        if record["status"] != kind.status_of(snapshot.state):
            raise WorkflowError(f"{kind.name} state differs from its workflow instance; "
                                "an explicit migration is required")
        return RecordKnowledge(self, kind, conn, record, snapshot)

    def transition(self, kind: RecordKind, *, record_id: str, transition: str, evidence=None,
                   project_id: str | None = None, expected_revision: int | None = None):
        """Apply one graph action and return the state and event it committed."""
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            record = self.get_state(kind, record_id=record_id, project_id=project_id, conn=conn)
            current = self.runtime.adopt(conn=conn, project_id=project_id, instance_id=record_id,
                                         workflow=kind.name, state=record["status"],
                                         data={"attempt_index": record["attempt_index"]})
            after = self.runtime.apply_in_transaction(
                conn=conn, project_id=project_id, instance_id=record_id, action=transition,
                expected_revision=current.revision if expected_revision is None else expected_revision,
                request_id=new_id(prefix=f"{kind.name}_action"), payload=evidence or {},
            )
            return (self.get_state(kind, record_id=record_id, project_id=project_id, conn=conn),
                    self.runtime.event(conn=conn, snapshot=after))

    def commit_change(self, kind: RecordKind, conn, before: Snapshot, after: Snapshot, action: str, payload) -> None:
        """Keep the native record and its sealed evidence on the runtime's transaction.

        Lifecycle decisions live in the graph. What this writes is declared:
        ``seal_exempt_actions`` says which transitions do not close a submission
        round, and ``commit_columns`` says which of the transition's data fields
        each action writes back beside the projected status.
        """
        if action in {"start_work", "adopt_children"}:
            return  # The runtime's idempotent work_started event owns the clock.
        hooks = self.hooks[kind.name]
        hooks.before_write(conn=conn, before=before, after=after, action=action)
        if action not in kind.seal_exempt_actions:
            self.artifacts.seal(tx=conn, target=ArtifactTarget(kind.name, before.id, before.project_id),
                                transition=action)
        written = tuple(column for column in kind.commit_columns.get(action, ()) if column in after.data)
        columns = ("status", *written, "updated_at")
        values = [kind.status_of(after.state), *(after.data[column] for column in written), now_iso()]
        conn.execute(f"UPDATE {kind.table} SET {', '.join(f'{name} = ?' for name in columns)} "
                     "WHERE id = ? AND project_id = ?", (*values, before.id, before.project_id))
        hooks.after_write(conn=conn, before=before, after=after, action=action, payload=payload)


class RecordKnowledge:
    """Transaction- and project-bound facts; graph functions own every decision."""

    def __init__(self, records: Records, kind: RecordKind, conn, record: dict[str, Any], snapshot: Snapshot) -> None:
        self.records, self.kind, self.conn, self.record, self.snapshot = records, kind, conn, record, snapshot
        self._documents: dict[str, dict[str, Any]] = {}
        self._reviews = {}

    def read(self, reference: Reference) -> dict[str, Any]:
        record, conn, kind = self.record, self.conn, self.kind
        if reference.kind == kind.name and reference.id == record["id"]:
            return record
        if reference.kind == "project" and reference.id == record["project_id"]:
            row = conn.execute("SELECT id, name, summary FROM projects WHERE id = ?", (reference.id,)).fetchone()
            return {} if row is None else dict(row)
        if reference.kind == "artifact":
            return self._artifact(reference.id)
        if reference.kind in {"review", "review_snapshot"}:
            if reference.kind == "review_snapshot" and reference.id != record["id"]:
                raise NotFoundError("review snapshot belongs to another workflow instance")
            node = self.records.runtime.registry.get(self.snapshot.workflow, self.snapshot.version).node(self.snapshot.state)
            role = reference.id if reference.kind == "review" else (node.role if node is not None else "")
            return self.review_fact(role).reference(request=reference.kind == "review_snapshot")
        if reference.kind == "review_history":
            rows = conn.execute(
                "SELECT r.target_snapshot_id, r.verdict, r.return_to, r.notes, s.independence FROM reviews r "
                "JOIN review_sessions s ON s.id = r.session_id WHERE r.project_id = ? AND r.target_id = ? "
                "AND r.target_type = ? AND r.role = ? AND s.status = 'submitted' ORDER BY r.created_seq DESC",
                (record["project_id"], record["id"], kind.name, reference.id),
            ).fetchall()
            return {"reviews": [{**dict(row), **snapshot_from_id(snapshot_id=row["target_snapshot_id"])} for row in rows]}
        fact = self.records.hooks[kind.name].read_fact(conn=conn, record=record, reference=reference)
        if fact is None:
            raise NotFoundError(f"{kind.name} fact not available: {reference.kind}/{reference.id}")
        return fact

    def review_fact(self, role: str):
        if role not in self._reviews:
            self._reviews[role] = read_review_fact(conn=self.conn, project_id=self.record["project_id"],
                                                  target_type=self.kind.name, target_id=self.record["id"],
                                                  role=role, snapshot_id=self._snapshot_id())
        return self._reviews[role]

    def _snapshot_id(self) -> str:
        return review_snapshot_id(target_type=self.kind.name, target=self.record, snapshot=self.snapshot)

    def _artifact(self, artifact_id: str) -> dict[str, Any]:
        """The submitted bytes behind one association id, with any failure as ``error``.

        A definition validator never raises for missing or unreadable content:
        it reads ``error`` and reports it as the requirement's problem.
        """
        if artifact_id in self._documents:
            return self._documents[artifact_id]
        record, contents = self.record, self.records.artifacts.contents
        # Either an association this record already carries, or — for content a
        # transition payload names before it is attached — the content id itself.
        artifact = next((item for item in record.get("artifacts") or ()
                         if artifact_id in {str(item.get("id")), str(item.get("artifact_id"))}), {})
        content_id = str(artifact.get("artifact_id") or artifact_id)
        fact = {"id": artifact_id, "artifact_id": content_id, "path": str(artifact.get("path") or ""),
                "role": str(artifact.get("role") or ""), "text": "", "figure_links": (), "error": ""}
        try:
            contents.assert_complete(artifact_ids=(content_id,), project_id=record["project_id"], tx=self.conn)
            content = contents.get(artifact_ids=(content_id,), project_id=record["project_id"],
                                   include="document", tx=self.conn)[0]
            if content.data is None:
                raise WorkflowError(f"{fact['path'] or content.path} has no submitted content — "
                                    "resubmit it with artifact.upload")
            fact.update(figure_links=content.figures, path=fact["path"] or content.path,
                        text=content.data.decode("utf-8", errors="replace"))
        except (NotFoundError, ValidationError, WorkflowError) as exc:
            fact["error"] = str(exc)
        self._documents[artifact_id] = fact
        return fact


__all__ = ["RecordHooks", "RecordKnowledge", "Records"]
