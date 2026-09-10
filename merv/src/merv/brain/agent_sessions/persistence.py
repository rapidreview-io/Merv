# If you update this file, you must consult agent_sessions.md to see whether agent_sessions.md needs to be updated. agent_sessions.md must not exceed 100 lines.
"""Agent-session tables: leases, runners, their pairing, traces, workspaces."""

from __future__ import annotations

from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    ensure_columns,
    has_column,
    has_table,
    table_ddl,
)


AGENT_SESSION_DDL = """\
-- One locally hosted coding-agent process leased to one workflow instance
-- revision. The runner submits a high-entropy session secret once; only its
-- digest is stored. The lease carries the declared execution policy of its
-- node and the packet references verbatim; kind, review_request_id and
-- source_sha are legacy columns kept only for the schema-60 replay.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  review_request_id TEXT NOT NULL DEFAULT '',
  source_sha TEXT NOT NULL DEFAULT '',
  runner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('offered', 'active', 'released', 'expired')),
  host_session_ref TEXT NOT NULL DEFAULT '',
  workspace_ref TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  assignment_json TEXT NOT NULL DEFAULT '{}',
  agent_setup_json TEXT NOT NULL DEFAULT '{}',
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  telemetry_at TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_activity_at TEXT,
  lease_expires_at TEXT NOT NULL,
  hard_deadline_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT NOT NULL DEFAULT '',
  source_key_id TEXT,
  source_user_id TEXT NOT NULL DEFAULT '',
  workflow_instance_id TEXT NOT NULL DEFAULT '',
  workflow_revision INTEGER NOT NULL DEFAULT 0,
  workflow_node TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  execution_json TEXT NOT NULL DEFAULT '{}',
  references_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- One small, non-secret liveness record per project runner. The daemon renews
-- it every poll even while idle, so the UI can distinguish a ready machine
-- from a remembered or disconnected one without dialing the user's network.
CREATE TABLE IF NOT EXISTS agent_runners (
  project_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  machine_json TEXT NOT NULL DEFAULT '{}',
  platforms_json TEXT NOT NULL DEFAULT '{}',
  capacity INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- Brain-held runner tuning (August 2026). desired_* is what the owner asked
  -- for in Settings; the runner pulls it on its heartbeat, applies it to its
  -- private client.json, and reports applied_version. inventory_json is the
  -- runner's non-secret report of what it actually has: every configured
  -- platform (enabled or not, native or CLI-only), workspace paths, which
  -- executables resolve, local session counts, and any pending/error state.
  -- The schema is closed and carries no executable argv in either direction.
  desired_settings_json TEXT NOT NULL DEFAULT '{}',
  desired_version INTEGER NOT NULL DEFAULT 0,
  applied_version INTEGER NOT NULL DEFAULT 0,
  inventory_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id, runner_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Device-code pairing of a runner machine to one project (August 2026). The
-- runner generates its own mk_ key and sends only the digest; approval by a
-- project owner registers that digest as a project key. The row is the durable
-- exchange: pending until approved, then readable by the same device code for
-- a short window so a lost response cannot strand a registered key.
CREATE TABLE IF NOT EXISTS agent_runner_pairings (
  id TEXT PRIMARY KEY,
  device_code_digest TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  key_digest TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL,
  machine_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  project_id TEXT,
  key_id TEXT,
  approved_by TEXT,
  client_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(key_id) REFERENCES project_api_keys(id)
);

-- Approval misses per principal, so a project owner cannot spray user codes.
CREATE TABLE IF NOT EXISTS agent_runner_pairing_attempts (
  principal TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

-- A bounded, redacted excerpt of the trace for one auto-run session (August 2026):
-- the last few provider events and the tail of stderr, mirrored by the runner
-- so the Auto-run page can show what a job is doing or why it stopped. The
-- full trace stays on the executor; this row is capped and overwritten.
CREATE TABLE IF NOT EXISTS agent_session_traces (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  stderr_tail TEXT NOT NULL DEFAULT '',
  complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Durable branch identity per leased workflow instance across its sessions.
-- The worktree stays on the runner's machine; the brain stores only the Git
-- facts later sessions continue from and the UI shows as lineage.
CREATE TABLE IF NOT EXISTS agent_workspaces (
  instance_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  commit_count INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, instance_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""


def _add_agent_sessions(conn: Connection) -> None:
    """Migration 41: coding-agent leases and their concurrency keys.

    The indexes live here and never in the DDL: an existing store reaches the
    table only when this step creates it.
    """
    if not has_table(conn, "agent_sessions"):
        conn.execute(table_ddl(table="agent_sessions"))
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_runner_retry"
        "  ON agent_sessions(runner_id, idempotency_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_project"
        "  ON agent_sessions(project_id, created_at)"
    )
    # One live lease per instance revision. Migration 60 adds the columns to a
    # table that predates them and creates this there; a table created here
    # already has them, and this is then the only step that reaches it.
    if has_column(conn, "agent_sessions", "workflow_instance_id"):
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_workflow "
            "ON agent_sessions(project_id, workflow_instance_id, workflow_revision) "
            "WHERE workflow_instance_id <> '' AND status IN ('offered', 'active')"
        )


def _add_agent_session_observability(conn: Connection) -> None:
    """Migration 46: bounded assignment/setup/telemetry session state."""
    ensure_columns(
        conn,
        "agent_sessions",
        {
            "assignment_json": "TEXT NOT NULL DEFAULT '{}'",
            "agent_setup_json": "TEXT NOT NULL DEFAULT '{}'",
            "telemetry_json": "TEXT NOT NULL DEFAULT '{}'",
            "telemetry_at": "TEXT",
        },
    )


def _add_agent_runners(conn: Connection) -> None:
    """Migration 47: one non-secret machine heartbeat per project runner."""
    if not has_table(conn, "agent_runners"):
        conn.execute(table_ddl(table="agent_runners"))


def _add_agent_runner_pairing(conn: Connection) -> None:
    """Migration 48: device-code pairing, brain-held runner tuning, key label."""
    for table in ("agent_runner_pairings", "agent_runner_pairing_attempts"):
        if not has_table(conn, table):
            conn.execute(table_ddl(table=table))
    ensure_columns(
        conn,
        "agent_runners",
        {
            "desired_settings_json": "TEXT NOT NULL DEFAULT '{}'",
            "desired_version": "INTEGER NOT NULL DEFAULT 0",
            "applied_version": "INTEGER NOT NULL DEFAULT 0",
            "inventory_json": "TEXT NOT NULL DEFAULT '{}'",
        },
    )
    # An owner needs to see which credential belongs to which paired machine.
    ensure_columns(conn, "project_api_keys", {"label": "TEXT"})
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_agent_runner_pairings_expiry"
        "  ON agent_runner_pairings(status, expires_at)",
        "CREATE INDEX IF NOT EXISTS idx_agent_runner_pairings_ip"
        "  ON agent_runner_pairings(client_ip, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_agent_runner_pairing_attempts_principal"
        "  ON agent_runner_pairing_attempts(principal, attempted_at)",
    ):
        conn.execute(statement)


def _add_agent_session_traces(conn: Connection) -> None:
    """Migration 49: one bounded, redacted excerpt row per session."""
    if not has_table(conn, "agent_session_traces"):
        conn.execute(table_ddl(table="agent_session_traces"))
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_session_traces_project"
        "  ON agent_session_traces(project_id, updated_at)"
    )


def _add_agent_workspaces(conn: Connection) -> None:
    """Migration 61: lease policy columns and instance-keyed workspace facts."""
    ensure_columns(
        conn,
        "agent_sessions",
        {
            "role": "TEXT NOT NULL DEFAULT ''",
            "label": "TEXT NOT NULL DEFAULT ''",
            "execution_json": "TEXT NOT NULL DEFAULT '{}'",
            "references_json": "TEXT NOT NULL DEFAULT '[]'",
        },
    )
    if not has_table(conn, "agent_workspaces"):
        conn.execute(table_ddl(table="agent_workspaces"))
    if has_table(conn, "experiment_workspaces"):
        # Native ids are the workflow instance ids, so the key carries over.
        conn.execute(
            """
            INSERT INTO agent_workspaces (
              instance_id, project_id, branch, base_sha, head_sha,
              commit_count, files_changed, insertions, deletions, updated_at
            )
            SELECT experiment_id, project_id, branch, base_sha, head_sha,
                   commit_count, files_changed, insertions, deletions, updated_at
            FROM experiment_workspaces
            ON CONFLICT (project_id, instance_id) DO NOTHING
            """
        )
        conn.execute("DROP TABLE experiment_workspaces")


AGENT_SESSION_SCHEMA = SchemaModule(
    name="agent_sessions",
    ddl=AGENT_SESSION_DDL,
    migrations=(
        Migration(41, "add_agent_sessions", _add_agent_sessions),
        Migration(46, "add_agent_session_observability", _add_agent_session_observability),
        Migration(47, "add_agent_runners", _add_agent_runners),
        Migration(48, "add_agent_runner_pairing", _add_agent_runner_pairing),
        Migration(49, "add_agent_session_traces", _add_agent_session_traces),
        Migration(61, "add_agent_workspaces", _add_agent_workspaces),
    ),
)
