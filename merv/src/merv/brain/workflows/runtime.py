"""Transactional state, revision checks, history, and parent/child progression."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import closing
from dataclasses import asdict
import hashlib
import json
from typing import Any, Protocol

from ..kernel.events import StoredEvent, freeze_json_object
from ..kernel.state.store import BaseStateStore, Connection
from ..kernel.utils import NotFoundError, WorkflowError, new_id, now_iso
from .composition import ChildResult
from .graph import Change, Data, Evaluation, Knowledge, Reference, Registry, Snapshot


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(child) for child in value]
    return value


def encode(value: Any) -> str:
    return json.dumps(_plain(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def snapshot_view(snapshot: Snapshot) -> dict[str, Any]:
    return {
        "id": snapshot.id, "project_id": snapshot.project_id,
        "workflow": snapshot.workflow, "version": snapshot.version,
        "state": snapshot.state, "revision": snapshot.revision,
        "data": _plain(snapshot.data), "outcome": snapshot.outcome,
        "children": [
            {"key": child.key, "id": child.id, "workflow": child.workflow,
             "outcome": child.outcome, "data": _plain(child.data)}
            for child in snapshot.children
        ],
    }


def _snapshot(value: Data) -> Snapshot:
    return Snapshot(
        id=value["id"], project_id=value["project_id"], workflow=value["workflow"],
        version=int(value["version"]), state=value["state"], revision=int(value["revision"]),
        data=freeze_json_object(value["data"]), outcome=value.get("outcome", ""),
        children=tuple(ChildResult(**{**child, "data": freeze_json_object(child["data"])}) for child in value.get("children", ())),
    )


class EmptyKnowledge:
    def read(self, reference: Reference) -> Data:
        raise NotFoundError(f"no knowledge reader for {reference.kind}/{reference.id}")


class KnowledgeFactory(Protocol):
    def __call__(self, snapshot: Snapshot, conn: Connection) -> Knowledge: ...


class CommitRecord(Protocol):
    def __call__(self, conn: Connection, before: Snapshot, after: Snapshot, action: str, payload: Data) -> None: ...


class CreateRecord(Protocol):
    def __call__(self, conn: Connection, snapshot: Snapshot) -> None: ...


class Runtime:
    """One engine for every registered graph; no workflow-name switches."""

    def __init__(
        self, *, store: BaseStateStore, registry: Registry,
        knowledge: KnowledgeFactory | None = None,
        commit: CommitRecord | None = None,
        create: CreateRecord | None = None,
    ) -> None:
        self.store = store
        self.registry = registry
        self.knowledge = knowledge or (lambda snapshot, conn: EmptyKnowledge())
        self.commit = commit
        self.create = create

    def get(self, *, project_id: str, instance_id: str, conn: Connection | None = None) -> Snapshot:
        if conn is None:
            with closing(self.store.connect()) as reader:
                return self.get(project_id=project_id, instance_id=instance_id, conn=reader)
        row = conn.execute(
            "SELECT * FROM workflow_instances WHERE id = ? AND project_id = ?",
            (instance_id, project_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"workflow instance not found: {instance_id}")
        children = conn.execute(
            "SELECT id, workflow, child_key, outcome, data_json FROM workflow_instances "
            "WHERE parent_id = ? AND parent_revision = ? AND project_id = ? ORDER BY child_key",
            (instance_id, row["revision"], project_id),
        ).fetchall()
        return _snapshot({
            **dict(row), "data": json.loads(row["data_json"]),
            "children": [
                {"key": child["child_key"], "id": child["id"], "workflow": child["workflow"],
                 "outcome": child["outcome"], "data": json.loads(child["data_json"])}
                for child in children
            ],
        })

    def snapshots(self, *, project_id: str, conn: Connection) -> dict[str, Snapshot]:
        """Hydrate a project's pinned versions and child sets in one read."""
        rows = conn.execute("SELECT * FROM workflow_instances WHERE project_id = ?", (project_id,)).fetchall()
        children: dict[tuple[str, int], list[dict]] = {}
        for row in rows:
            if row["parent_id"]:
                children.setdefault((row["parent_id"], row["parent_revision"]), []).append({
                    "key": row["child_key"], "id": row["id"], "workflow": row["workflow"],
                    "outcome": row["outcome"], "data": json.loads(row["data_json"]),
                })
        return {row["id"]: _snapshot({**dict(row), "data": json.loads(row["data_json"]),
                "children": sorted(children.get((row["id"], row["revision"]), ()), key=lambda child: child["key"])})
                for row in rows}

    def evaluate(self, *, project_id: str, instance_id: str, conn: Connection | None = None) -> Evaluation:
        if conn is None:
            with self.store.transaction() as tx:
                return self.evaluate(project_id=project_id, instance_id=instance_id, conn=tx)
        snapshot = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        return self.registry.get(snapshot.workflow, snapshot.version).evaluate(snapshot, self.knowledge(snapshot, conn))

    def start(
        self, *, project_id: str, workflow: str, request_id: str,
        data: Data | None = None, entry: str = "", version: int | None = None,
    ) -> Snapshot:
        if not request_id:
            raise WorkflowError("workflow start requires a request id")
        with self.store.transaction() as conn:
            self.store.require_project_id(conn=conn, project_id=project_id)
            snapshot, entered = self._start(
                conn, project_id=project_id, workflow=workflow, version=version,
                entry=entry, data=data or {}, key=f"client:{request_id}",
            )
            self._settle(conn, project_id, entered)
            return self.get(project_id=project_id, instance_id=snapshot.id, conn=conn)

    def _start(
        self, conn: Connection, *, project_id: str, workflow: str,
        version: int | None, entry: str, data: Data, key: str,
        parent: Snapshot | None = None, child_key: str | None = None, depth: int = 0,
    ) -> tuple[Snapshot, list[str]]:
        fingerprint = _fingerprint({"workflow": workflow, "version": version, "entry": entry, "data": data})
        existing = conn.execute(
            "SELECT id, start_fingerprint FROM workflow_instances WHERE project_id = ? AND start_key = ?",
            (project_id, key),
        ).fetchone()
        if existing is not None:
            if existing["start_fingerprint"] != fingerprint:
                raise WorkflowError("request id was already used for a different workflow start")
            return self.get(project_id=project_id, instance_id=existing["id"], conn=conn), []
        definition = self.registry.get(workflow, version)
        state = definition.entry(entry)
        instance_id, now = new_id(prefix=definition.id_prefix), now_iso()
        conn.execute(
            "INSERT INTO workflow_instances "
            "(id, project_id, workflow, version, state, outcome, data_json, start_key, start_fingerprint, "
            "parent_id, parent_revision, child_key, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (instance_id, project_id, workflow, definition.version, state, definition.outcomes.get(state, ""),
             encode(data), key, fingerprint, None if parent is None else parent.id,
             None if parent is None else parent.revision, child_key, now, now),
        )
        snapshot = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        if self.create is not None:
            self.create(conn, snapshot)
        entered = self._enter(conn, snapshot, depth=depth)
        snapshot = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        self._record(conn, snapshot, from_state="", action="start", key=key, fingerprint=fingerprint)
        return snapshot, entered

    def apply(
        self, *, project_id: str, instance_id: str, action: str,
        expected_revision: int, request_id: str, payload: Data | None = None,
    ) -> Snapshot:
        if not request_id:
            raise WorkflowError("workflow action requires a request id")
        with self.store.transaction() as conn:
            snapshot, entered = self._apply(
                conn, project_id=project_id, instance_id=instance_id, action=action,
                expected_revision=expected_revision, key=f"client:{request_id}", payload=payload or {},
            )
            self._settle(conn, project_id, entered)
            return snapshot

    def replay_action(
        self, *, project_id: str, instance_id: str, action: str,
        expected_revision: int, request_id: str, payload: Data | None = None,
    ) -> Snapshot | None:
        """Check a command key before support preparation can produce evidence."""
        if not request_id:
            raise WorkflowError("workflow action requires a request id")
        fingerprint = _fingerprint({"action": action, "revision": expected_revision, "payload": payload or {}})
        with closing(self.store.connect()) as conn:
            return self._replay(conn, project_id, instance_id, f"client:{request_id}", fingerprint)

    def apply_in_transaction(
        self, *, conn: Connection, project_id: str, instance_id: str, action: str,
        expected_revision: int, request_id: str, payload: Data | None = None,
    ) -> Snapshot:
        """A module can commit its submissions and this transition atomically."""
        if not request_id:
            raise WorkflowError("workflow action requires a request id")
        snapshot, entered = self._apply(
            conn, project_id=project_id, instance_id=instance_id, action=action,
            expected_revision=expected_revision, key=f"domain:{request_id}", payload=payload or {},
        )
        self._settle(conn, project_id, entered)
        return snapshot

    def adopt(
        self, *, conn: Connection, project_id: str, instance_id: str, workflow: str,
        state: str, data: Data | None = None, version: int = 1,
    ) -> Snapshot:
        """Bind a workflow-owned record on the record's creation/migration transaction."""
        existing = conn.execute("SELECT project_id, workflow FROM workflow_instances WHERE id = ?", (instance_id,)).fetchone()
        if existing is not None:
            if (existing["project_id"], existing["workflow"]) != (project_id, workflow):
                raise WorkflowError("workflow instance identity already belongs to another record")
            return self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        definition = self.registry.get(workflow, version)
        if definition.node(state) is None and state not in definition.outcomes:
            raise WorkflowError(f"unknown adopted state {state!r}")
        now, key = now_iso(), f"adopt:{instance_id}"
        fingerprint = _fingerprint({"id": instance_id, "workflow": workflow, "version": version})
        conn.execute(
            "INSERT INTO workflow_instances (id, project_id, workflow, version, state, outcome, data_json, "
            "start_key, start_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (instance_id, project_id, workflow, version, state, definition.outcomes.get(state, ""), encode(data or {}), key, fingerprint, now, now),
        )
        snapshot = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        entered = self._enter(conn, snapshot)
        snapshot = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        self._record(conn, snapshot, from_state="", action="adopt", key=key, fingerprint=fingerprint)
        self._settle(conn, project_id, entered)
        return self.get(project_id=project_id, instance_id=instance_id, conn=conn)

    def _apply(
        self, conn: Connection, *, project_id: str, instance_id: str,
        action: str, expected_revision: int, key: str, payload: Data,
    ) -> tuple[Snapshot, list[str]]:
        fingerprint = _fingerprint({"action": action, "revision": expected_revision, "payload": payload})
        replay = self._replay(conn, project_id, instance_id, key, fingerprint)
        if replay is not None:
            return replay, []
        evaluation = self.evaluate(project_id=project_id, instance_id=instance_id, conn=conn)
        before = evaluation.snapshot
        if before.revision != expected_revision:
            raise WorkflowError("workflow changed; refresh its state before applying an action")
        edge = evaluation.require(action)
        change = edge.change(before, freeze_json_object(payload), self.knowledge(before, conn))
        after = self._save(conn, before, state=edge.target, change=change)
        if self.commit is not None:
            self.commit(conn, before, after, action, payload)
        entered = self._enter(conn, after)
        after = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        self._record(conn, after, from_state=before.state, action=action, key=key, fingerprint=fingerprint,
                     event_type=edge.event_type, payload=payload)
        return after, entered

    def _save(
        self, conn: Connection, before: Snapshot, *, state: str, change: Change,
        version: int | None = None,
    ) -> Snapshot:
        definition = self.registry.get(before.workflow, version or before.version)
        if definition.node(state) is None and state not in definition.outcomes:
            raise WorkflowError(f"unknown destination {state!r}")
        now, revision = now_iso(), before.revision + 1
        data = {**before.data, **change.data}
        row = conn.execute(
            "UPDATE workflow_instances SET state = ?, version = ?, revision = ?, outcome = ?, "
            "data_json = ?, updated_at = ? WHERE id = ? AND project_id = ? AND revision = ? RETURNING id",
            (state, definition.version, revision, definition.outcomes.get(state, ""), encode(data), now,
             before.id, before.project_id, before.revision),
        ).fetchone()
        if row is None:
            raise WorkflowError("workflow changed while applying the action")
        for index, action in enumerate(change.actions):
            conn.execute(
                "INSERT INTO workflow_actions (id, instance_id, project_id, revision, kind, data_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (f"{before.id}:{revision}:{index}", before.id, before.project_id, revision, action.kind, encode(action.data), now),
            )
        return self.get(project_id=before.project_id, instance_id=before.id, conn=conn)

    def _record(
        self, conn: Connection, snapshot: Snapshot, *, from_state: str,
        action: str, key: str, fingerprint: str,
        event_type: str = "", payload: Data | None = None,
    ) -> None:
        event = self.store.record_event(
            conn=conn, project_id=snapshot.project_id,
            event_type=event_type or ("workflow." + action if action in {"start", "adopt", "migrate"}
                                     else self.registry.get(snapshot.workflow, snapshot.version).event_type),
            target_type=snapshot.workflow, target_id=snapshot.id,
            payload={"from": from_state, "to": snapshot.state, "transition": action,
                     "workflow": snapshot.workflow, "version": snapshot.version, "revision": snapshot.revision,
                     "evidence": _plain(payload or {})},
        )
        conn.execute("UPDATE workflow_actions SET event_id = ? WHERE instance_id = ? AND revision = ? AND event_id IS NULL",
                     (event.id, snapshot.id, snapshot.revision))
        conn.execute(
            "INSERT INTO workflow_history "
            "(id, instance_id, project_id, revision, command_key, command_fingerprint, action, from_state, after_json, event_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (new_id(prefix="wfh"), snapshot.id, snapshot.project_id, snapshot.revision, key,
             fingerprint, action, from_state, encode(snapshot_view(snapshot)), event.id, now_iso()),
        )

    def event(self, *, conn: Connection, snapshot: Snapshot) -> StoredEvent:
        row = conn.execute(
            "SELECT e.* FROM events e JOIN workflow_history h ON h.event_id = e.id "
            "WHERE h.instance_id = ? AND h.project_id = ? AND h.revision = ?",
            (snapshot.id, snapshot.project_id, snapshot.revision),
        ).fetchone()
        if row is None:
            raise NotFoundError("workflow transition event not found")
        return StoredEvent(id=int(row["id"]), project_id=row["project_id"], type=row["type"],
                           target_type=row["target_type"], target_id=row["target_id"],
                           payload=freeze_json_object(json.loads(row["payload_json"])), created_at=row["created_at"])

    def _replay(self, conn: Connection, project_id: str, instance_id: str, key: str, fingerprint: str) -> Snapshot | None:
        row = conn.execute(
            "SELECT after_json, command_fingerprint FROM workflow_history "
            "WHERE instance_id = ? AND project_id = ? AND command_key = ?",
            (instance_id, project_id, key),
        ).fetchone()
        if row is None:
            return None
        if row["command_fingerprint"] != fingerprint:
            raise WorkflowError("request id was already used for a different workflow action")
        return _snapshot(json.loads(row["after_json"]))

    def _enter(self, conn: Connection, snapshot: Snapshot, *, depth: int = 0) -> list[str]:
        if depth > 32:
            raise WorkflowError("workflow composition exceeded 32 nested children")
        node = self.registry.get(snapshot.workflow, snapshot.version).node(snapshot.state)
        entered = [snapshot.id]
        if node is None or node.children is None:
            return entered
        children = node.children(snapshot, self.knowledge(snapshot, conn))
        if any(not child.key for child in children) or len({child.key for child in children}) != len(children):
            raise WorkflowError("child keys must be nonempty and unique within a wait")
        for child in children:
            if child.instance_id:
                attached = self.get(conn=conn, project_id=snapshot.project_id, instance_id=child.instance_id)
                if attached.workflow != child.workflow or (child.version is not None and attached.version != child.version):
                    raise WorkflowError("existing child has a different workflow or pinned version")
                if child.data or child.entry:
                    raise WorkflowError("attaching an existing child cannot rewrite its data or entry")
                ancestor = snapshot.id
                while ancestor:
                    if ancestor == attached.id:
                        raise WorkflowError("a workflow cannot attach itself or an ancestor as a child")
                    row = conn.execute("SELECT parent_id FROM workflow_instances WHERE id = ?", (ancestor,)).fetchone()
                    ancestor = "" if row is None else str(row["parent_id"] or "")
                row = conn.execute(
                    "UPDATE workflow_instances SET parent_id = ?, parent_revision = ?, child_key = ? "
                    "WHERE id = ? AND project_id = ? AND (parent_id IS NULL OR "
                    "(parent_id = ? AND parent_revision = ? AND child_key = ?)) RETURNING id",
                    (snapshot.id, snapshot.revision, child.key, attached.id, snapshot.project_id,
                     snapshot.id, snapshot.revision, child.key),
                ).fetchone()
                if row is None:
                    raise WorkflowError("child is already attached to another workflow wait")
                continue
            _, descendants = self._start(
                conn, project_id=snapshot.project_id, workflow=child.workflow, version=child.version,
                entry=child.entry, data=child.data, key=f"child:{snapshot.id}:{snapshot.revision}:{child.key}",
                parent=snapshot, child_key=child.key, depth=depth + 1,
            )
            entered.extend(descendants)
        return entered

    def _settle(self, conn: Connection, project_id: str, entered: list[str]) -> None:
        steps = 0
        while entered:
            steps += 1
            if steps > 1024:
                raise WorkflowError("composition did not settle after 1024 steps; check automatic cycles")
            snapshot = self.get(project_id=project_id, instance_id=entered.pop(0), conn=conn)
            node = self.registry.get(snapshot.workflow, snapshot.version).node(snapshot.state)
            if node is not None and node.join is not None:
                action = node.join(snapshot, self.knowledge(snapshot, conn))
                if action is not None:
                    _, descendants = self._apply(
                        conn, project_id=project_id, instance_id=snapshot.id, action=action,
                        expected_revision=snapshot.revision, key=f"join:{snapshot.revision}", payload={},
                    )
                    entered.extend(descendants)
            if snapshot.outcome:
                parent = conn.execute(
                    "SELECT p.id FROM workflow_instances p JOIN workflow_instances c ON c.parent_id = p.id "
                    "WHERE c.id = ? AND p.project_id = ? AND p.revision = c.parent_revision",
                    (snapshot.id, project_id),
                ).fetchone()
                if parent is not None:
                    entered.append(parent["id"])

    def assignment(self, *, project_id: str, instance_id: str, conn: Connection | None = None) -> dict[str, Any]:
        if conn is None:
            with self.store.transaction() as tx:
                return self.assignment(project_id=project_id, instance_id=instance_id, conn=tx)
        return self._assignment(self.evaluate(project_id=project_id, instance_id=instance_id, conn=conn), conn)

    def _assignment(self, evaluation: Evaluation, conn: Connection) -> dict[str, Any]:
        if not evaluation.dispatchable:
            reason = "; ".join(issue.message for issue in evaluation.dispatch_issues)
            raise WorkflowError(reason or "this node has no agent assignment")
        snapshot, node = evaluation.snapshot, evaluation.node
        assert node is not None and node.build_context is not None
        brief = node.build_context(snapshot, self.knowledge(snapshot, conn))
        current = self.get(project_id=snapshot.project_id, instance_id=snapshot.id, conn=conn)
        if current.revision != snapshot.revision:
            raise WorkflowError("workflow changed while building the assignment")
        return {
            **evaluation.public(), "project_id": snapshot.project_id, "role": node.role,
            "label": node.label or node.name, "brief": brief.summary,
            "execution": {"read_only": node.read_only, "workspace": node.workspace},
            "references": [asdict(reference) for reference in brief.references],
            "handoff": "Complete only this node's assignment, commit its allowed action, then hand off and exit.",
        }

    def describe(self, *, project_id: str, instance_id: str) -> dict[str, Any]:
        with self.store.transaction() as conn:
            evaluation = self.evaluate(project_id=project_id, instance_id=instance_id, conn=conn)
            packet = self._assignment(evaluation, conn) if evaluation.dispatchable else {}
            return {
                "scope": "workflow", "workflow": evaluation.public(),
                "context": {key: packet[key] for key in ("role", "label", "brief", "references", "handoff") if key in packet},
            }

    def require_assignment(self, *, conn: Connection, project_id: str, instance_id: str, revision: int) -> None:
        """The dispatcher calls this in the transaction that issues the lease."""
        self.lock(conn=conn, project_id=project_id, instance_id=instance_id, revision=revision)
        evaluation = self.evaluate(project_id=project_id, instance_id=instance_id, conn=conn)
        if not evaluation.dispatchable:
            raise WorkflowError("assignment is stale or its dispatch prerequisites no longer hold")

    def lock(self, *, conn: Connection, project_id: str, instance_id: str, revision: int) -> Snapshot:
        """Fence a support operation against concurrent workflow transitions."""
        locked = conn.execute(
            "UPDATE workflow_instances SET revision = revision WHERE id = ? AND project_id = ? AND revision = ? RETURNING id",
            (instance_id, project_id, revision),
        ).fetchone()
        if locked is None:
            raise WorkflowError("assignment is stale; workflow revision changed")
        return self.get(conn=conn, project_id=project_id, instance_id=instance_id)

    def adopt_children(self, *, conn: Connection, project_id: str, instance_id: str,
                       expected_revision: int, request_id: str) -> Snapshot:
        """Explicitly attach a legacy instance's declared child set once."""
        key = f"composition:{request_id}"
        fingerprint = _fingerprint({"revision": expected_revision})
        replay = self._replay(conn, project_id, instance_id, key, fingerprint)
        if replay is not None:
            return replay
        before = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        if before.revision != expected_revision:
            raise WorkflowError("workflow changed before child adoption")
        if before.children:
            return before
        node = self.registry.get(before.workflow, before.version).node(before.state)
        if node is None or node.children is None:
            raise WorkflowError("only a wait node can adopt child workflows")
        after = self._save(conn, before, state=before.state, change=Change())
        entered = self._enter(conn, after)
        after = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
        self._record(conn, after, from_state=before.state, action="adopt_children", key=key, fingerprint=fingerprint)
        self._settle(conn, project_id, entered)
        return self.get(project_id=project_id, instance_id=instance_id, conn=conn)

    def candidates(self, *, project_id: str) -> list[dict[str, Any]]:
        with self.store.transaction() as conn:
            rows = conn.execute(
                "SELECT id FROM workflow_instances WHERE project_id = ? AND outcome = '' ORDER BY created_at, id",
                (project_id,),
            ).fetchall()
            packets = []
            for row in rows:
                evaluation = self.evaluate(project_id=project_id, instance_id=row["id"], conn=conn)
                if evaluation.dispatchable:
                    packets.append(self._assignment(evaluation, conn))
            return packets

    def activate(self, *, conn: Connection, project_id: str, instance_id: str,
                 revision: int, session_id: str) -> None:
        """Record actual work start once, in the transaction activating its lease."""
        self.require_assignment(conn=conn, project_id=project_id, instance_id=instance_id, revision=revision)
        started = conn.execute(
            "UPDATE workflow_instances SET started_revision = ? WHERE id = ? AND project_id = ? "
            "AND revision = ? AND started_revision <> ? RETURNING id",
            (revision, instance_id, project_id, revision, revision),
        ).fetchone()
        if started is None:
            return
        snapshot = self.get(conn=conn, project_id=project_id, instance_id=instance_id)
        node = self.registry.get(snapshot.workflow, snapshot.version).node(snapshot.state)
        assert node is not None
        payload = {"session_id": session_id}
        change = node.on_start(snapshot, freeze_json_object(payload), self.knowledge(snapshot, conn))
        if change.data:
            raise WorkflowError("node activation may request actions but cannot edit workflow data")
        if self.commit is not None:
            self.commit(conn, snapshot, snapshot, "start_work", payload)
        now = now_iso()
        for index, action in enumerate(change.actions):
            conn.execute(
                "INSERT INTO workflow_actions (id, instance_id, project_id, revision, kind, data_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (f"{instance_id}:{revision}:start:{index}", instance_id, project_id, revision,
                 action.kind, encode(action.data), now),
            )
        event = self.store.record_event(
            conn=conn, project_id=project_id, event_type="workflow.work_started",
            target_type=snapshot.workflow, target_id=instance_id,
            payload={"workflow": snapshot.workflow, "state": snapshot.state, "revision": revision, **payload},
        )
        conn.execute("UPDATE workflow_actions SET event_id = ? WHERE instance_id = ? AND revision = ? AND event_id IS NULL",
                     (event.id, instance_id, revision))

    def migrate(
        self, *, project_id: str, instance_id: str, version: int, expected_revision: int,
        request_id: str, transform: Callable[[Snapshot], tuple[str, Change]],
        preserve_children: bool | None = None,
    ) -> Snapshot:
        """Explicit operator migration; the transform is trusted application code."""
        if not request_id:
            raise WorkflowError("workflow migration requires a request id")
        with self.store.transaction() as conn:
            fingerprint = _fingerprint({"version": version, "revision": expected_revision, "preserve_children": preserve_children})
            key = f"migration:{request_id}"
            replay = self._replay(conn, project_id, instance_id, key, fingerprint)
            if replay is not None:
                return replay
            before = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
            if before.revision != expected_revision:
                raise WorkflowError("workflow changed before migration")
            if version == before.version:
                raise WorkflowError("migration must select a different definition version")
            if before.children and preserve_children is None:
                raise WorkflowError("migration must explicitly preserve or replace the existing child set")
            if preserve_children is False and any(not child.outcome for child in before.children):
                raise WorkflowError("finish or cancel active children before replacing the child set")
            state, change = transform(before)
            if preserve_children:
                node = self.registry.get(before.workflow, version).node(state)
                if node is None or node.children is None:
                    raise WorkflowError("preserved children require a wait node in the new definition")
            after = self._save(conn, before, state=state, version=version, change=change)
            if preserve_children:
                conn.execute("UPDATE workflow_instances SET parent_revision = ? WHERE parent_id = ? AND parent_revision = ? AND project_id = ?",
                             (after.revision, before.id, before.revision, project_id))
                after = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
            if self.commit is not None:
                self.commit(conn, before, after, "migrate", {})
            entered = [after.id] if preserve_children else self._enter(conn, after)
            after = self.get(project_id=project_id, instance_id=instance_id, conn=conn)
            self._record(conn, after, from_state=before.state, action="migrate", key=key, fingerprint=fingerprint)
            self._settle(conn, project_id, entered)
            return self.get(project_id=project_id, instance_id=instance_id, conn=conn)

    def history(self, *, project_id: str, instance_id: str) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            self.get(project_id=project_id, instance_id=instance_id, conn=conn)
            rows = conn.execute(
                "SELECT id, revision, action, from_state, after_json, created_at FROM workflow_history "
                "WHERE instance_id = ? AND project_id = ? ORDER BY revision", (instance_id, project_id),
            ).fetchall()
            return [{key: value for key, value in {**dict(row), "after": json.loads(row["after_json"])}.items() if key != "after_json"} for row in rows]
