# If you update this file, you must consult workflows.md to see whether workflows.md needs to be updated. workflows.md must not exceed 100 lines.
"""Workflow-owned tables: instances, history, actions.

The runtime's durable state: one versioned instance per work node, the
append-only revision history behind it, and the outbound action queue.
"""

from __future__ import annotations

from ..kernel.state.schema import Connection, Migration, SchemaModule


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
"""


def _drop_tracking_deliveries(conn: Connection) -> None:
    """Migration 69: the keyed barrier had one writer, and it is gone.

    ``tracking_deliveries`` proved that one external tracking write appended
    at most once. With that integration deleted no delivery is keyed, so the
    table and its unique index have nothing left to state.
    """
    conn.execute("DROP TABLE IF EXISTS tracking_deliveries")


WORKFLOW_SCHEMA = SchemaModule(
    name="workflows",
    ddl=WORKFLOW_DDL,
    migrations=(Migration(69, "drop_tracking_deliveries", _drop_tracking_deliveries),),
)
