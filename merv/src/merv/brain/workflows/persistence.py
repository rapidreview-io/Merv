# If you update this file, you must consult workflows.md to see whether workflows.md needs to be updated. workflows.md must not exceed 100 lines.
"""Workflow-owned tables: instances, history, actions, tracking deliveries.

The runtime's durable state plus migration 60, which adopted every work node
that predated the runtime into a versioned instance without replaying any of
its work.
"""

from __future__ import annotations

import json
import re

from ..kernel.secret_tokens import hash_secret
from ..kernel.state.persistence import record_event
from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    columns_of,
    ensure_columns,
    has_column,
    has_table,
    is_sqlite,
    statements,
    table_ddl,
)
from ..kernel.utils import ValidationError, new_id, now_iso


WORKFLOW_DDL = """\
CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  started_revision INTEGER NOT NULL DEFAULT -1,
  outcome TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  start_key TEXT NOT NULL,
  start_fingerprint TEXT NOT NULL,
  parent_id TEXT REFERENCES workflow_instances(id),
  parent_revision INTEGER,
  child_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, start_key),
  UNIQUE (parent_id, parent_revision, child_key)
);

CREATE TABLE IF NOT EXISTS workflow_history (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  command_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT NOT NULL,
  after_json TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  UNIQUE (instance_id, revision),
  UNIQUE (instance_id, command_key)
);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_project
  ON workflow_instances(project_id, outcome, workflow);

CREATE INDEX IF NOT EXISTS idx_workflow_actions_pending
  ON workflow_actions(status, next_attempt_at, lease_until);

-- Lookup key for the MLflow tracking delivery barrier (migration 40, July
-- 2026). One row per KEYED tracking write, inserted in the same transaction as
-- the event it names, so replay detection is one indexed lookup on
-- (project_id, target_type, target_id, delivery_id) instead of a decode of
-- every keyed event the target has accrued. `event_id` names the `events` row
-- the delivery appended, which the barrier then fetches by primary key. The
-- delivery id still rides in that event payload, but only as a readable trace,
-- never as a lookup key. Nothing here is derived state: the row and its event
-- commit together or not at all. The UNIQUE index belongs to migration 40 and
-- never to the DDL (see the tool_calls block in kernel).
CREATE TABLE IF NOT EXISTS tracking_deliveries (
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  delivery_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""


def _add_tracking_deliveries(conn: Connection) -> None:
    """Migration 40: the keyed-delivery table plus its UNIQUE index.

    Additive and idempotent. The table guard is belt-and-braces — the DDL
    creates it on both dialects before the ladder runs — but the index
    genuinely needs to be here, where it executes after the table it names
    exists. No backfill: pre-migration deliveries predate the dedupe feature
    shipping, so no committed event needs a row.

    The index is exactly the barrier's lookup, and its uniqueness law: one row
    per delivery per target, so the database itself — not only the check inside
    the write transaction — states that a delivery appends at most once."""
    if not has_table(conn, "tracking_deliveries"):
        conn.execute(table_ddl(table="tracking_deliveries"))
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_deliveries_key"
        "  ON tracking_deliveries(project_id, target_type, target_id, delivery_id)"
    )


def _expand_workflow_sessions(conn: Connection) -> None:
    """Widen the former closed target/kind enum on the lease table."""
    if not has_table(conn, "agent_sessions"):
        return
    if is_sqlite(conn):
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'"
        ).fetchone()
        sql = "" if row is None else str(row["sql"])
        if "target_type IN" in sql or "kind IN" in sql:
            # Widen in place: rebuild the table from its own shape with the
            # closed enums removed, so columns later steps still read survive.
            widened = re.sub(r"\s*CHECK \((?:target_type|kind) IN \([^)]*\)\)", "", sql)
            widened = re.sub(
                r"CREATE TABLE \"?agent_sessions\"?", "CREATE TABLE agent_sessions_v60", widened, count=1
            )
            names = ", ".join(columns_of(conn, "agent_sessions"))
            conn.execute("DROP TABLE IF EXISTS agent_sessions_v60")
            conn.execute(widened)
            conn.execute(
                f"INSERT INTO agent_sessions_v60 ({names}) SELECT {names} FROM agent_sessions"
            )
            conn.execute("DROP TABLE agent_sessions")
            conn.execute("ALTER TABLE agent_sessions_v60 RENAME TO agent_sessions")
    else:
        for row in conn.execute(
            "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint "
            "WHERE conrelid = 'agent_sessions'::regclass AND contype = 'c'"
        ).fetchall():
            if "target_type" in row["definition"] or "kind" in row["definition"]:
                name = str(row["conname"]).replace('"', '""')
                conn.execute(f'ALTER TABLE agent_sessions DROP CONSTRAINT "{name}"')
    ensure_columns(
        conn,
        "agent_sessions",
        {
            "workflow_instance_id": "TEXT NOT NULL DEFAULT ''",
            "workflow_revision": "INTEGER NOT NULL DEFAULT 0",
            "workflow_node": "TEXT NOT NULL DEFAULT ''",
        },
    )


def _add_workflow_runtime(conn: Connection) -> None:
    """Migration 60: explicit v1 adoption, preserving evidence and never
    replaying work."""
    for statement in statements(WORKFLOW_DDL):
        conn.execute(statement)
    _expand_workflow_sessions(conn)
    definitions = (
        ("task", "tasks", {"in_progress", "in_review"}, {"done": "completed", "failed": "failed"}),
        ("experiment", "experiments", {"planned", "design_review", "running", "experiment_review"},
         {"complete": "completed", "failed": "failed", "abandoned": "abandoned"}),
        ("reflection", "reflections", {"reflecting", "synthesizing", "reflection_review", "consolidating"},
         {"published": "published", "abandoned": "abandoned"}),
    )
    for workflow, table, working, outcomes in definitions:
        if not has_table(conn, table):
            continue
        for row in conn.execute(f"SELECT id, project_id, status, attempt_index, created_at, updated_at FROM {table}").fetchall():
            if conn.execute("SELECT id FROM workflow_instances WHERE id = ?", (row["id"],)).fetchone() is not None:
                continue
            old_state = row["status"]
            state = "running" if workflow == "experiment" and old_state == "ready_to_run" else old_state
            if state not in working | set(outcomes):
                raise ValidationError(f"cannot migrate {workflow} {row['id']}: unknown status {old_state!r}")
            data = {} if workflow == "task" else {"attempt_index": row["attempt_index"]}
            if workflow == "reflection" and state == "consolidating":
                proposal = conn.execute("SELECT id, proposal_sha FROM consolidation_proposals WHERE reflection_id = ? ORDER BY revision DESC LIMIT 1", (row["id"],)).fetchone()
                if proposal is not None:
                    data.update(proposal_id=proposal["id"], proposal_sha=proposal["proposal_sha"])
                    reviews = conn.execute(
                        "SELECT r.verdict, r.target_snapshot_id FROM reviews r JOIN review_sessions s ON s.id = r.session_id "
                        "WHERE r.target_type = 'reflection' AND r.target_id = ? AND r.role = 'consolidation_reviewer' "
                        "AND s.status = 'submitted' ORDER BY r.created_seq DESC", (row["id"],)
                    ).fetchall()
                    suffix = f"|{proposal['id']}|{proposal['proposal_sha']}"
                    latest = next((review for review in reviews if review["target_snapshot_id"].endswith(suffix)), None)
                    if latest is None or latest["verdict"] == "pass":
                        state = "consolidation_review"
            snapshot = {
                "id": row["id"], "project_id": row["project_id"], "workflow": workflow, "version": 1,
                "state": state, "revision": 0, "data": data, "children": [], "outcome": outcomes.get(state, ""),
            }
            identity = json.dumps({"id": row["id"], "workflow": workflow, "version": 1}, sort_keys=True, separators=(",", ":"))
            fingerprint = hash_secret(identity)
            conn.execute(
                "INSERT INTO workflow_instances (id, project_id, workflow, version, state, outcome, data_json, "
                "start_key, start_fingerprint, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
                (row["id"], row["project_id"], workflow, state, snapshot["outcome"], json.dumps(data, sort_keys=True), f"adopt:{row['id']}", fingerprint,
                 row["created_at"], row["updated_at"]),
            )
            if workflow == "experiment" and state != old_state:
                conn.execute(f"UPDATE {table} SET status = ? WHERE id = ?", (state, row["id"]))
            event = record_event(conn=conn, project_id=row["project_id"], event_type="workflow.migrated",
                                 target_type=workflow, target_id=row["id"],
                                 payload={"migration": 60, "version": 1, "from": old_state, "state": state})
            conn.execute(
                "INSERT INTO workflow_history (id, instance_id, project_id, revision, command_key, command_fingerprint, "
                "action, from_state, after_json, event_id, created_at) VALUES (?, ?, ?, 0, 'migration:60', ?, 'migrate', ?, ?, ?, ?)",
                (new_id(prefix="wfh"), row["id"], row["project_id"], fingerprint, old_state,
                 json.dumps(snapshot, sort_keys=True), event.id, now_iso()),
            )
    _adopt_pre_workflow_leases(conn)
    roles = {"design_review": "design_reviewer", "experiment_review": "experiment_reviewer",
             "in_review": "task_reviewer", "reflection_review": "reflection_reviewer",
             "consolidation_review": "consolidation_reviewer"}
    for instance in conn.execute("SELECT * FROM workflow_instances WHERE outcome = ''").fetchall():
        role = roles.get(instance["state"])
        if role is not None:
            data = {"target_type": instance["workflow"], "target_id": instance["id"], "role": role}
            conn.execute(
                "INSERT INTO workflow_actions (id,instance_id,project_id,revision,kind,data_json,created_at) "
                "VALUES (?, ?, ?, 0, 'review.request', ?, ?)",
                (f"{instance['id']}:migration:60:review", instance["id"], instance["project_id"], json.dumps(data, sort_keys=True), now_iso()),
            )
    if not has_table(conn, "reflections"):
        return
    for reflection in conn.execute(
        "SELECT r.id, r.project_id FROM reflections r WHERE r.status = 'published' AND NOT EXISTS "
        "(SELECT 1 FROM reflections newer WHERE newer.project_id = r.project_id AND newer.status = 'published' "
        "AND newer.created_seq > r.created_seq) AND (EXISTS "
        "(SELECT 1 FROM reflection_experiments m JOIN workflow_instances w ON w.id = m.experiment_id "
        "WHERE m.reflection_id = r.id AND w.outcome = '') OR EXISTS "
        "(SELECT 1 FROM reflection_tasks m JOIN workflow_instances w ON w.id = m.task_id "
        "WHERE m.reflection_id = r.id AND w.outcome = ''))"
    ).fetchall():
        data = {"workflow": "research_wave", "request_id": f"reflection-wave:{reflection['id']}",
                "data": {"reflection_id": reflection["id"]}}
        conn.execute(
            "INSERT INTO workflow_actions (id,instance_id,project_id,revision,kind,data_json,created_at) "
            "VALUES (?, ?, ?, 0, 'workflow.start', ?, ?)",
            (f"{reflection['id']}:migration:60:wave", reflection["id"], reflection["project_id"], json.dumps(data, sort_keys=True), now_iso()),
        )


def _adopt_pre_workflow_leases(conn: Connection) -> None:
    """Keep valid pre-upgrade leases attached to the adopted revision, fence
    the rest, and swap the lease uniqueness key onto the instance.

    A lease table with no `kind` column was created in its post-workflow shape
    and therefore holds nothing to adopt; only a database that predates the
    runtime reaches the rest of this.
    """
    if not has_table(conn, "agent_sessions"):
        return
    if not has_column(conn, "agent_sessions", "kind"):
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_workflow "
            "ON agent_sessions(project_id, workflow_instance_id, workflow_revision) "
            "WHERE workflow_instance_id <> '' AND status IN ('offered', 'active')"
        )
        return
    # Their authenticating adapter rechecks phase, attempt and review capability.
    conn.execute(
        "UPDATE agent_sessions SET workflow_instance_id = target_id, workflow_revision = 0, "
        "workflow_node = (SELECT state FROM workflow_instances w WHERE w.id = agent_sessions.target_id) "
        "WHERE status IN ('offered', 'active') AND EXISTS "
        "(SELECT 1 FROM workflow_instances w WHERE w.id = agent_sessions.target_id AND w.project_id = agent_sessions.project_id)"
    )
    for session in conn.execute("SELECT * FROM agent_sessions WHERE workflow_instance_id <> '' AND status IN ('offered', 'active')").fetchall():
        instance = conn.execute("SELECT * FROM workflow_instances WHERE id = ?", (session["workflow_instance_id"],)).fetchone()
        table = {"experiment": "experiments", "reflection": "reflections", "task": "tasks"}[instance["workflow"]]
        target = conn.execute(f"SELECT status, attempt_index FROM {table} WHERE id = ?", (instance["id"],)).fetchone()
        valid = not instance["outcome"] and target is not None and target["attempt_index"] == session["attempt_index"]
        review_role = {"design_review": "design_reviewer", "experiment_review": "experiment_reviewer",
                       "in_review": "task_reviewer", "reflection_review": "reflection_reviewer",
                       "consolidation_review": "consolidation_reviewer"}.get(instance["state"], "")
        if session["kind"] == "review":
            request = conn.execute("SELECT * FROM review_requests WHERE id = ?", (session["review_request_id"],)).fetchone()
            prefix = f"{instance['workflow']}|{instance['id']}|{target['status']}|{target['attempt_index']}|" if target else ""
            valid = valid and bool(review_role) and request is not None and (
                request["status"] in {"requested", "started"} and request["expires_at"] > now_iso()
                and request["role"] == review_role and request["project_id"] == session["project_id"]
                and request["target_snapshot_id"].startswith(prefix)
            )
        else:
            valid = valid and not review_role
            valid = valid and (session["kind"] != "consolidation" or instance["state"] == "consolidating")
        try:
            packet = json.loads(session["assignment_json"] or "{}")
        except ValueError:
            packet = {}
        if session["status"] == "offered" and not packet.get("instruction"):
            valid = False
        if not valid:
            conn.execute("UPDATE agent_sessions SET status = 'expired', closed_at = ?, "
                         "close_reason = 'workflow_migration_stale_lease' WHERE id = ?", (now_iso(), session["id"]))
    # The old lease keys allowed owner and reviewer simultaneously. Keep the
    # reviewer at a submitted gate and fence the superseded owner.
    seen: set[tuple[str, str]] = set()
    for session in conn.execute(
        "SELECT id, project_id, workflow_instance_id FROM agent_sessions "
        "WHERE workflow_instance_id <> '' AND status IN ('offered', 'active') "
        "ORDER BY CASE WHEN kind = 'review' THEN 0 ELSE 1 END, "
        "CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at, id"
    ).fetchall():
        identity = (session["project_id"], session["workflow_instance_id"])
        if identity in seen:
            conn.execute("UPDATE agent_sessions SET status = 'expired', closed_at = ?, "
                         "close_reason = 'workflow_migration_superseded' WHERE id = ?", (now_iso(), session["id"]))
        seen.add(identity)
    conn.execute(
        "UPDATE workflow_instances SET started_revision = revision WHERE EXISTS "
        "(SELECT 1 FROM agent_sessions s WHERE s.workflow_instance_id = workflow_instances.id AND s.status = 'active') "
        "AND NOT (workflow = 'experiment' AND state = 'running')"
    )
    for instance in conn.execute(
        "SELECT id, project_id FROM workflow_instances WHERE workflow = 'experiment' AND state = 'running'"
    ).fetchall():
        for event in conn.execute(
            "SELECT type, payload_json FROM events WHERE target_type = 'experiment' AND target_id = ? AND project_id = ? ORDER BY id DESC",
            (instance["id"], instance["project_id"]),
        ).fetchall():
            if event["type"] == "experiment.returned_to_planned":
                break
            payload = json.loads(event["payload_json"])
            if payload.get("transition") == "start_running" or (event["type"] == "workflow.work_started" and payload.get("state") == "running"):
                conn.execute("UPDATE workflow_instances SET started_revision = revision WHERE id = ?", (instance["id"],))
                break
    for name in ("experiment", "review", "consolidation"):
        conn.execute(f"DROP INDEX IF EXISTS idx_agent_sessions_one_live_{name}")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_workflow "
        "ON agent_sessions(project_id, workflow_instance_id, workflow_revision) "
        "WHERE workflow_instance_id <> '' AND status IN ('offered', 'active')"
    )


WORKFLOW_SCHEMA = SchemaModule(
    name="workflows",
    ddl=WORKFLOW_DDL,
    migrations=(
        Migration(40, "add_tracking_deliveries", _add_tracking_deliveries),
        Migration(60, "add_workflow_runtime", _add_workflow_runtime),
    ),
)


def install_workflow_schema(store) -> None:  # type: ignore[no-untyped-def]
    store.install(WORKFLOW_SCHEMA)
