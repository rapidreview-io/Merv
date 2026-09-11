"""Kernel-owned tables: projects, membership, the event log, the tool ledger.

Kernel keeps only what every component writes through: project records and
their membership, the append-only ``events`` identity, the durable tool-call
ledger, tenants, and ``schema_migrations`` itself. Every other table belongs
to the component that reads it — see the ``persistence`` module beside each.
"""

from __future__ import annotations

import json
from typing import Any

from ..events import StoredEvent, freeze_json_object
from ..utils import now_iso
from .schema import Connection, SchemaModule


KERNEL_DDL = """\
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  -- Per-project policy knobs (e.g. require_verified_reviews), JSON dict.
  settings_json TEXT NOT NULL DEFAULT '{}',
  -- Tenancy (cloud plan Phase 6): ownership lives on the project row; every
  -- other table reaches its tenant through project_id. The current private
  -- deployment uses the fixed 'local' tenant until real user auth lands.
  tenant_id TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  -- Access layer for authenticated (hosted) mode: user_id is a Supabase
  -- auth.users UUID; a row grants full member access to the project. The
  -- local surface carries no user_id, so membership never filters it.
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Tenant records. The current private hosted-control deployment has no user
-- auth yet, but projects, quotas, budgets, and counters are already tenant
-- shaped so the real auth system can attach users later without reshaping
-- stored project data.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Durable tool-call ledger (July 2026, logging/observability P0). One row per
-- dispatched call AND per refusal that never reached the dispatcher, so agent
-- friction — retry loops, gate bounces, poll churn, per-tool latency, context
-- bloat — outlives a restart. Sizes and digests only: the in-memory rings keep
-- serving the debug UI's raw request/response view, and this table must never
-- become a second payload store. No foreign key to projects: project_id is
-- empty for global and rejected calls, and a telemetry insert may not fail on
-- a missing parent. Retention is a bounded prune, not a row cap.
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  -- Correlates every row a single HTTP request produced (X-RP-Request-Id).
  request_id TEXT NOT NULL DEFAULT '',
  -- Non-secret caller identity: key:<project_api_keys.id>, user:<uuid>,
  -- 'local', or 'open'. Never a token, never a digest of one.
  principal_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  error_code TEXT NOT NULL DEFAULT '',
  -- First line of the failure, secret-scrubbed and capped: enough to group
  -- errors, never enough to reconstruct a payload.
  error_head TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  sent_chars INTEGER NOT NULL DEFAULT 0,
  received_chars INTEGER NOT NULL DEFAULT 0,
  -- sha256 prefix of the redacted arguments: a retry loop repeats one digest.
  args_digest TEXT NOT NULL DEFAULT '',
  -- Agent attribution (August 2026). agent_id is the short id
  -- of the agent context window (one model conversation) that made the call,
  -- minted by agent.hello. mcp_session_id is the transport session header it
  -- arrived under. payload_ref names the redacted request/response record in
  -- the blob store (namespace tool-calls) — the row stays sizes-and-digests,
  -- the payload lives on disk beside artifacts, and both expire together.
  agent_id TEXT NOT NULL DEFAULT '',
  mcp_session_id TEXT NOT NULL DEFAULT '',
  payload_ref TEXT NOT NULL DEFAULT ''
);

-- The mining reads over this ledger: per-project timeline, error hunt,
-- per-tool rollup, and the calls of one agent context window. Each pairs its
-- filter with the append order it is scanned in.
CREATE INDEX IF NOT EXISTS idx_tool_calls_project ON tool_calls(project_id, id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status, id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool, id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id, id);

-- The event reads: the append-order tail of one project, and the history of
-- one work node (equality columns first, then `id`, so a newest-first window
-- comes straight off the index instead of being sorted).
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_events_target
  ON events(project_id, target_type, target_id, id);
-- A work node's own history is read by its id alone.
CREATE INDEX IF NOT EXISTS idx_events_target_id ON events(target_id, id);
"""


KERNEL_SCHEMA = SchemaModule(name="kernel", ddl=KERNEL_DDL)


def record_event(
    *,
    conn: Connection,
    project_id: str,
    event_type: str,
    target_type: str = "",
    target_id: str = "",
    payload: dict[str, Any] | None = None,
) -> StoredEvent:
    """Append one row to the kernel event log and return it."""
    created_at = now_iso()
    payload_json = json.dumps(payload or {}, sort_keys=True)
    row = conn.execute(
        """
        INSERT INTO events (project_id, type, target_type, target_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
        """,
        (project_id, event_type, target_type, target_id, payload_json, created_at),
    ).fetchone()
    if row is None:  # pragma: no cover - both supported dialects return it
        raise RuntimeError("event insert did not return an id")
    return StoredEvent(
        id=int(row["id"]),
        project_id=project_id,
        type=event_type,
        target_type=target_type,
        target_id=target_id,
        payload=freeze_json_object(json.loads(payload_json)),
        created_at=created_at,
    )
