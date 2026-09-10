"""Infrastructure-owned tables: remote machine links, uploads, the old ledger.

What the merv-sandboxes adapter records locally is the service's business, not
the brain's: the machine rows, their attachments, generations and the spend
policy around them were the brain's own projection of a fleet it no longer
runs, and migration 65 drops them. What is left is the link from a project to
an independently operated machine, the one-time upload completion tokens, and
``storage_objects`` — the retired heavy-object ledger kept only until
``deploy/migrate_storage_ledger.py`` has run.
"""

from __future__ import annotations

from ..kernel.state.schema import Connection, Migration, SchemaModule


INFRASTRUCTURE_DDL = """\
CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  namespace TEXT NOT NULL,
  status TEXT NOT NULL,
  upload_id TEXT,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'codex',
  producing_experiment_id TEXT NOT NULL DEFAULT '',
  producing_run TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  created_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, name, version),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS remote_sandbox_links (
  project_id TEXT NOT NULL,
  sandbox_uid TEXT NOT NULL,
  experiment_id TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sandbox_uid, experiment_id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Token-curl upload completion (no-dataplane Phase D). storage.submit mints a
-- one-time, expiring token bound to a pending upload; the auth-exempt bodyless
-- POST /api/storage/u/<token>/complete is the ONLY wire-reachable completion for
-- a key agent (storage.complete_upload is internal and rejected over MCP), so
-- without it a direct-to-S3 object stays uploading forever. Single-use: the row
-- is deleted once the service verifies the completion. object_id and upload_id
-- both name the merv-sandboxes object; the ledger FK is gone.
CREATE TABLE IF NOT EXISTS storage_completion_tokens (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Read paths of the retired ledger, for as long as it is still read.
CREATE INDEX IF NOT EXISTS idx_storage_objects_content
  ON storage_objects(namespace, content_sha256, status);
CREATE INDEX IF NOT EXISTS idx_storage_objects_latest
  ON storage_objects(project_id, status, name, version DESC);
CREATE INDEX IF NOT EXISTS idx_storage_objects_producer
  ON storage_objects(project_id, producing_experiment_id, status);
-- Deliberately NOT unique: upload_id uniqueness is unenforced today, so a
-- unique index could fail on existing production rows.
CREATE INDEX IF NOT EXISTS idx_storage_objects_upload
  ON storage_objects(project_id, upload_id);
"""

# Tables the brain kept about a sandbox fleet it does not own. The merv-
# sandboxes service is the register of what machines exist, what they cost and
# what ran on them; every read the brain had of these rows now goes there, and
# the archived projection they fed was deleted with them. Children first so
# foreign-key enforcement never blocks the drop.
_RETIRED_SANDBOX_TABLES = (
    "sandbox_attachments",
    "sandbox_runs",
    "sandbox_generations",
    "provider_user_caps",
    "spend_kill_switches",
    "sandbox_provider_settings",
    "tenant_quotas",
    "sandboxes",
)


def _drop_legacy_infrastructure_tables(conn: Connection) -> None:
    """Migration 65: the brain stops mirroring the sandbox fleet."""
    for table in _RETIRED_SANDBOX_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")


INFRASTRUCTURE_SCHEMA = SchemaModule(
    name="infrastructure",
    ddl=INFRASTRUCTURE_DDL,
    migrations=(
        Migration(
            65,
            "drop_legacy_infrastructure_tables",
            _drop_legacy_infrastructure_tables,
        ),
    ),
)
