"""Infrastructure-owned tables: sandbox machines, spend, and the old ledger.

Everything the merv-sandboxes adapter records locally — machine rows and their
attachments, generations and the spend policy around them, per-project provider
connections — plus ``storage_objects``, the retired heavy-object ledger kept
only until ``deploy/migrate_storage_ledger.py`` has run.

The sandbox identity migrations (4-8) reshape a table rather than adding to it,
so each carries both dialects: Postgres can drop a constraint in place, SQLite
has to copy into a twin and swap it in.
"""

from __future__ import annotations

import uuid

from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    columns_of,
    drop_columns,
    ensure_columns,
    has_column,
    has_table,
    is_sqlite,
    table_ddl,
)
from ..kernel.utils import now_iso


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

CREATE TABLE IF NOT EXISTS sandboxes (
  sandbox_uid TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  sandbox_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'none',
  gpu TEXT NOT NULL DEFAULT '',
  cpu REAL NOT NULL DEFAULT 0,
  memory INTEGER NOT NULL DEFAULT 0,
  -- Compute provider that owns this sandbox (the backend's capabilities.name).
  -- Empty on rows that predate multi-provider support and means "the
  -- configured default backend" at read time.
  provider TEXT NOT NULL DEFAULT '',
  -- Provider-bundled machine SKU + datacenter, for backends (Lambda Labs) that
  -- procure a fixed instance type rather than composing cpu/memory. Empty for
  -- Modal, which sets gpu/cpu/memory above instead.
  instance_type TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  -- Provider price quote at provision (cloud plan Phase 7): captured from the
  -- catalog option (Lambda has it; Modal leaves 0). Recorded on the row AND
  -- appended to sandbox_generations so per-generation spend is reconstructable
  -- even though the row itself only retains its current generation.
  price_usd_per_hour REAL NOT NULL DEFAULT 0,
  time_limit INTEGER NOT NULL DEFAULT 0,
  ssh_host TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 0,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  workdir TEXT NOT NULL DEFAULT '',
  sync_dir TEXT NOT NULL DEFAULT '',
  unsynced_dir TEXT NOT NULL DEFAULT '',
  sandbox_data_dir TEXT NOT NULL DEFAULT '',
  -- Management keypair reference (cloud plan Phase 5, fixed decision 4):
  -- non-empty when a control-plane management key was minted for this
  -- sandbox. A key-store reference (the sandbox_uid) — never key material.
  mgmt_key_ref TEXT NOT NULL DEFAULT '',
  -- User SSH key custody source: caller supplied an OpenSSH public key, or the
  -- local data plane used the managed fallback keypair.
  public_key_source TEXT NOT NULL DEFAULT 'managed',
  volume_name TEXT NOT NULL DEFAULT '',
  sandbox_name TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  provision_started_at TEXT,
  requested_at TEXT,
  expires_at TEXT,
  last_seen_at TEXT,
  idle_since TEXT,
  heartbeat_snapshot_json TEXT NOT NULL DEFAULT '{}',
  last_command_id TEXT NOT NULL DEFAULT '',
  last_command_text TEXT NOT NULL DEFAULT '',
  last_command_started_at TEXT,
  last_command_status TEXT NOT NULL DEFAULT '',
  last_command_exit_code INTEGER,
  last_command_finished_at TEXT,
  last_command_output_tail TEXT NOT NULL DEFAULT '',
  last_command_snapshot_at TEXT,
  -- Set when a receipt read SUCCEEDED while the row was still active, on the
  -- way to terminal. It is what separates "we looked and the run was not
  -- there" (lost) from "we never got to look" (unknown): reconcile_row
  -- reports a dead channel, a timeout and genuine no-news identically, so
  -- without this stamp every unfinished run on a dead box reads as lost.
  runs_final_observed_at TEXT,
  terminated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Insertion-order column replacing rowid ordering (cloud plan Phase 6).
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- Migration 44 (columns stay LAST so migrated and fresh stores hash the
  -- same schema): payer of record ('' = unattributed, never capped), the
  -- credential source that bills it ('platform' | 'own', adapter-reported),
  -- the tri-state admitted/validated price (NULL = unknown, distinct from
  -- the NOT NULL 0 floor above), and the budget-enforcement ladder
  -- ('' | 'warned' | 'over_budget').
  user_id TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '',
  quoted_price_usd_per_hour REAL,
  budget_state TEXT NOT NULL DEFAULT '',
  over_budget_at TEXT,
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

CREATE TABLE IF NOT EXISTS sandbox_attachments (
  sandbox_uid TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  detached_at TEXT,
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);

-- merv_run receipts observed on the box (July 2026). The sandbox filesystem is
-- the registry — .runs/<label>/ sentinel files written by the merv_run wrapper —
-- and this table is the brain's reconciled mirror of it, so run status
-- outlives both the agent session and the sandbox. finished_event_emitted
-- makes the run.finished event exactly-once across daemon restarts (flag and
-- event flip in one transaction).
CREATE TABLE IF NOT EXISTS sandbox_runs (
  sandbox_uid TEXT NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  pid INTEGER,
  exit_code INTEGER,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_event_emitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sandbox_uid, label),
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);

-- Cost governance (cloud plan Phase 7). One quota row per tenant; every
-- column nullable = unlimited. Local mode's 'local' tenant has no row, so
-- QuotaService.check_admission is a no-op (unlimited) — byte-identical
-- behavior. Enforcement gates at the procurement choke point only when a
-- ceiling is set and exceeded.
CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id TEXT PRIMARY KEY,
  max_concurrent_sandboxes INTEGER,
  max_time_limit_seconds INTEGER,
  max_price_usd_per_hour REAL,
  gpu_hours_budget REAL,
  usd_budget REAL,
  blob_bytes_budget INTEGER
);

-- Per-generation sandbox spend ledger (cloud plan Phase 7). The sandboxes row
-- retains only its current generation, so it cannot reconstruct historical
-- spend; each provisioned generation appends a row here with the price the
-- provider quoted (Lambda has it; Modal leaves it 0/null). Reconstructable
-- spend = sum over rows of price_usd_per_hour * runtime. Dormant in local
-- mode (no quota to govern) but always recorded so the ledger is truthful.
CREATE TABLE IF NOT EXISTS sandbox_generations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  sandbox_id TEXT NOT NULL DEFAULT '',
  -- Owning compute provider (empty = pre-multi-provider row / default backend).
  provider TEXT NOT NULL DEFAULT '',
  instance_type TEXT NOT NULL DEFAULT '',
  gpu TEXT NOT NULL DEFAULT '',
  price_usd_per_hour REAL NOT NULL DEFAULT 0,
  -- Provisioning credential attribution (agent-anywhere spend). NULL for every
  -- JWT/rr_sk_/local write; set to the project_api_keys.id that provisioned it.
  key_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- Migration 44 (columns stay LAST so migrated and fresh stores hash the
  -- same schema): payer of record + billing source ('' rows predate
  -- attribution, never capped), the durable sandbox_uid linkage that new
  -- close/update paths key on (legacy '' rows keep sandbox_id + provider
  -- matching), and price_known (1 = real provider quote, genuine $0 allowed;
  -- 0 = unknown, the stored 0 is only the NOT NULL floor — legacy rows keep
  -- 0, matching their existing "unpriced hours" treatment).
  user_id TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '',
  sandbox_uid TEXT NOT NULL DEFAULT '',
  price_known INTEGER NOT NULL DEFAULT 0
);

-- Per-user per-provider daily USD caps (migration 44). user_id '' is the
-- platform default for the provider; a user-specific row overrides it; a
-- NULL daily_usd_limit is an explicit uncapped override. Spend is always
-- recomputed from sandbox_generations — this table stores policy only.
CREATE TABLE IF NOT EXISTS provider_user_caps (
  provider TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  daily_usd_limit REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, user_id)
);

-- Spend kill-switch (cloud plan Phase 9, risk 13). An operator-trippable
-- circuit breaker that refuses NEW sandbox provisioning when set, independent
-- of (and faster to act than) per-dimension budgets. ``scope = 'global'`` is a
-- platform-wide halt; ``scope = '<tenant_id>'`` halts one tenant. A row exists
-- only when the switch was tripped; absence = armed/off. Dormant in local mode
-- (no row, no tripping). Never carries secrets — just a reason string.
CREATE TABLE IF NOT EXISTS spend_kill_switches (
  scope TEXT PRIMARY KEY,
  tripped INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  tripped_at TEXT
);

-- Per-project compute-provider connections (August 2026). One row per
-- (project, provider) the project has touched in Sandboxes → Configure:
-- saved credentials (JSON keyed by canonical MERV_* field names) and the
-- agent-facing enable switch. Credentials are WRITE-ONLY by contract — set,
-- merged, or cleared over the API; reads surface only WHICH keys are set
-- (plus non-secret values) and the raw JSON is read back only internally at
-- sandbox provisioning. No row means "no opinion": env-configured providers
-- stay usable until a row explicitly disables them.
CREATE TABLE IF NOT EXISTS sandbox_provider_settings (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credentials TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- '' = decide from what exists (saved creds, else env); 'own' and
  -- 'platform' record an explicit wizard choice (platform = the deployment's
  -- shared credentials, offered for Lambda Labs by default).
  credential_mode TEXT NOT NULL DEFAULT '',
  -- NULL = uncapped. Admission stops NEW provisioning on this provider once
  -- the project's UTC-day spend reaches the cap (quotas.py).
  daily_usd_limit REAL,
  -- Set when credential_check last confirmed access; cleared on every
  -- credential write.
  verified_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, provider)
);

-- Token-curl upload completion (no-dataplane Phase D). storage.submit mints a
-- one-time, expiring token bound to a pending upload; the auth-exempt bodyless
-- POST /api/storage/u/<token>/complete is the ONLY wire-reachable completion for
-- a key agent (storage.complete_upload is internal and rejected over MCP), so
-- without it a direct-to-S3 object stays uploading forever. Single-use: the row
-- is deleted once the service verifies the completion. object_id and upload_id
-- both name the merv-sandboxes object (migration 61); the ledger FK is gone.
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

-- Read-path indexes for the tables above. They name only columns this DDL
-- declares, so unlike the ladder-added columns' indexes they are safe here.
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
CREATE INDEX IF NOT EXISTS idx_sandbox_generations_tenant
  ON sandbox_generations(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sandbox_generations_project
  ON sandbox_generations(project_id, created_seq);
"""

# Mirrors the sandboxes DDL exactly; adding a ninth last_command_* column
# there means extending this map too.
LAST_COMMAND_COLUMNS = {
    "last_command_id": "TEXT NOT NULL DEFAULT ''",
    "last_command_text": "TEXT NOT NULL DEFAULT ''",
    "last_command_started_at": "TEXT",
    "last_command_status": "TEXT NOT NULL DEFAULT ''",
    "last_command_exit_code": "INTEGER",
    "last_command_finished_at": "TEXT",
    "last_command_output_tail": "TEXT NOT NULL DEFAULT ''",
    "last_command_snapshot_at": "TEXT",
}

# The async-provisioning family (June 2026) reached fresh schemas without a
# ladder step of its own, so a pre-ledger SQLite store gets it with migration 2.
_ASYNC_PROVISIONING_COLUMNS = {
    "sandbox_name": "TEXT NOT NULL DEFAULT ''",
    "phase": "TEXT NOT NULL DEFAULT ''",
    "detail": "TEXT NOT NULL DEFAULT ''",
    "error": "TEXT NOT NULL DEFAULT ''",
    "provision_started_at": "TEXT",
    "sandbox_data_dir": "TEXT NOT NULL DEFAULT ''",
    "sync_dir": "TEXT NOT NULL DEFAULT ''",
    "unsynced_dir": "TEXT NOT NULL DEFAULT ''",
    # Lambda-default: provider-bundled machine SKU + datacenter.
    "instance_type": "TEXT NOT NULL DEFAULT ''",
    "region": "TEXT NOT NULL DEFAULT ''",
    # Provider price quote captured at provision, for cost governance.
    "price_usd_per_hour": "REAL NOT NULL DEFAULT 0",
}


def _sandbox_uid_is_pk(conn: Connection) -> bool:
    """True once sandbox_uid is the sandboxes primary key (fresh or upgraded)."""
    if not has_table(conn, "sandboxes"):
        return False
    if is_sqlite(conn):
        return any(
            str(row["name"]) == "sandbox_uid" and int(row["pk"] or 0) > 0
            for row in conn.execute("PRAGMA table_info(sandboxes)").fetchall()
        )
    row = conn.execute(
        """
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'sandboxes'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'sandbox_uid'
        """
    ).fetchone()
    return row is not None


def _backfill_sandbox_attachments(conn: Connection) -> None:
    """Open the forward relation for legacy/un-attached rows; a no-op once filled."""
    conn.execute(table_ddl(table="sandbox_attachments"))
    if not has_column(conn, "sandboxes", "experiment_id"):
        return
    # Only rows still missing their attachment — so re-runs after the first
    # upgrade do no work, while a partial upgrade still gets finished.
    rows = conn.execute(
        """
        SELECT sandbox_uid, experiment_id, requested_at, created_at, updated_at,
               terminated_at, status
        FROM sandboxes
        WHERE COALESCE(sandbox_uid, '') != ''
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_attachments a
            WHERE a.sandbox_uid = sandboxes.sandbox_uid
              AND a.experiment_id = sandboxes.experiment_id
          )
        """
    ).fetchall()
    for row in rows:
        attached_at = (
            row["requested_at"] or row["created_at"] or row["updated_at"] or now_iso()
        )
        detached_at = None
        if row["terminated_at"] or row["status"] in {"terminated", "failed"}:
            detached_at = row["terminated_at"] or row["updated_at"] or attached_at
        conn.execute(
            """
            INSERT INTO sandbox_attachments (
              sandbox_uid, experiment_id, attached_at, detached_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (row["sandbox_uid"], row["experiment_id"], attached_at, detached_at),
        )


def _rebuild_sandboxes(conn: Connection) -> None:
    """Copy sandboxes into the current shape and swap it in (SQLite only).

    Preserves the attachment rows across the swap: the child table's foreign
    key names the parent being replaced.
    """
    attachments_exist = has_table(conn, "sandbox_attachments")
    if attachments_exist:
        conn.execute("DROP TABLE IF EXISTS sandbox_attachments_migrate")
        conn.execute(
            """
            CREATE TEMP TABLE sandbox_attachments_migrate AS
            SELECT sandbox_uid, experiment_id, attached_at, detached_at
            FROM sandbox_attachments
            """
        )
        conn.execute("DROP TABLE sandbox_attachments")
    conn.execute(table_ddl(table="sandboxes", name="sandboxes_migrate"))
    source = set(columns_of(conn, "sandboxes"))
    shared = [
        column for column in columns_of(conn, "sandboxes_migrate") if column in source
    ]
    if shared:
        columns = ", ".join(shared)
        conn.execute(
            f"INSERT INTO sandboxes_migrate ({columns}) SELECT {columns} FROM sandboxes"
        )
    conn.execute("DROP TABLE sandboxes")
    conn.execute("ALTER TABLE sandboxes_migrate RENAME TO sandboxes")
    conn.execute(table_ddl(table="sandbox_attachments"))
    if attachments_exist:
        conn.execute(
            """
            INSERT OR IGNORE INTO sandbox_attachments (
              sandbox_uid, experiment_id, attached_at, detached_at
            )
            SELECT sandbox_uid, experiment_id, attached_at, detached_at
            FROM sandbox_attachments_migrate
            """
        )
        conn.execute("DROP TABLE sandbox_attachments_migrate")


def _add_sandbox_tenant_id(conn: Connection) -> None:
    """Migration 2: tenancy on sandbox rows, plus the pre-ledger convergence.

    A SQLite store old enough to predate the ledger never saw the async
    provisioning columns, the machine-local column removals or the insertion
    order column; the Postgres dialect has no such stores.
    """
    if not has_table(conn, "sandboxes"):
        return
    if is_sqlite(conn):
        ensure_columns(conn, "sandboxes", _ASYNC_PROVISIONING_COLUMNS)
        # Machine-local values left the cloud-bound row (the per-sandbox key
        # path and sync dir live in the runner's own store), and the automatic
        # experiment-folder push that counted initial_pushed is gone. All three
        # were derivable, so no value migration is needed.
        drop_columns(conn, "sandboxes", ("key_path", "local_sync_dir", "initial_pushed"))
        # Explicit insertion order replaces `ORDER BY rowid` so the same
        # queries run on Postgres. Legacy rows backfill from their rowid — the
        # exact order the old queries observed — once, when first added.
        if "created_seq" in ensure_columns(
            conn, "sandboxes", {"created_seq": "INTEGER NOT NULL DEFAULT 0"}
        ):
            conn.execute("UPDATE sandboxes SET created_seq = rowid")
        # Nullable = unlimited; pre-Phase-9 quota rows predate the column.
        ensure_columns(conn, "tenant_quotas", {"usd_budget": "REAL"})
    ensure_columns(conn, "sandboxes", {"tenant_id": "TEXT NOT NULL DEFAULT 'local'"})
    conn.execute(
        """
        UPDATE sandboxes
        SET tenant_id = COALESCE(
          (SELECT tenant_id FROM projects WHERE projects.id = sandboxes.project_id),
          tenant_id,
          'local'
        )
        WHERE project_id != ''
        """
    )


def _add_sandbox_heartbeat_columns(conn: Connection) -> None:
    """Migration 3: the idle-reaper columns."""
    ensure_columns(
        conn,
        "sandboxes",
        {"idle_since": "TEXT", "heartbeat_snapshot_json": "TEXT NOT NULL DEFAULT '{}'"},
    )


def _migrate_sandbox_uid_identity(conn: Connection) -> None:
    """Migration 4: repoint an experiment_id-keyed sandboxes table onto sandbox_uid.

    The decoupling refactor makes sandbox_uid the primary key and opens the
    sandbox_attachments relation. Fresh schemas already have that shape, so the
    guard makes this a no-op there. Idempotent: every step is guarded or
    IF-EXISTS, and the swap only commits once (a partial run re-converges).
    """
    if _sandbox_uid_is_pk(conn) or not has_column(conn, "sandboxes", "experiment_id"):
        return
    if is_sqlite(conn):
        # experiment_id was the legacy primary key, so it addresses each row.
        ensure_columns(conn, "sandboxes", {"sandbox_uid": "TEXT"})
        for row in conn.execute(
            "SELECT experiment_id FROM sandboxes WHERE COALESCE(sandbox_uid, '') = ''"
        ).fetchall():
            conn.execute(
                "UPDATE sandboxes SET sandbox_uid = ? WHERE experiment_id = ?",
                (uuid.uuid4().hex, row["experiment_id"]),
            )
        # The rebuild drops experiment_id, so the relation has to be opened
        # from it first; _rebuild_sandboxes carries the rows across the swap.
        conn.execute("DROP TABLE IF EXISTS sandbox_attachments")
        _backfill_sandbox_attachments(conn)
        _rebuild_sandboxes(conn)
        return
    ensure_columns(conn, "sandboxes", {"sandbox_uid": "TEXT"})
    for row in conn.execute(
        "SELECT experiment_id FROM sandboxes WHERE COALESCE(sandbox_uid, '') = ''"
    ).fetchall():
        conn.execute(
            "UPDATE sandboxes SET sandbox_uid = ? WHERE experiment_id = ?",
            (uuid.uuid4().hex, row["experiment_id"]),
        )
    conn.execute("ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_pkey")
    conn.execute("ALTER TABLE sandboxes ADD PRIMARY KEY (sandbox_uid)")
    # Open one attachment per surviving sandbox (closed if already terminated).
    _backfill_sandbox_attachments(conn)


def _drop_sandboxes_experiment_unique(conn: Connection) -> None:
    """Migration 5: one experiment may own several sandbox rows."""
    if not has_table(conn, "sandboxes"):
        return
    if not is_sqlite(conn):
        conn.execute(
            "ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_experiment_id_key"
        )
        return
    unique = False
    for index in conn.execute("PRAGMA index_list(sandboxes)").fetchall():
        if not index["unique"]:
            continue
        columns = [
            str(info["name"])
            for info in conn.execute(f"PRAGMA index_info({index['name']})").fetchall()
        ]
        unique = unique or columns == ["experiment_id"]
    if not unique:
        return
    _backfill_sandbox_attachments(conn)
    _rebuild_sandboxes(conn)
    _backfill_sandbox_attachments(conn)


def _backfill_sandbox_mgmt_key_refs(conn: Connection) -> None:
    """Migration 6: management keys follow the sandbox, not the experiment."""
    if not has_table(conn, "sandboxes"):
        return
    ensure_columns(conn, "sandboxes", {"mgmt_key_ref": "TEXT NOT NULL DEFAULT ''"})
    conn.execute(
        """
        UPDATE sandboxes
        SET mgmt_key_ref = sandbox_uid
        WHERE COALESCE(mgmt_key_ref, '') = '' AND COALESCE(sandbox_uid, '') != ''
        """
    )


def _allow_sandbox_attachment_history(conn: Connection) -> None:
    """Migration 7: several close-then-open rows may share one sandbox/target."""
    if not is_sqlite(conn):
        conn.execute(
            "ALTER TABLE sandbox_attachments DROP CONSTRAINT IF EXISTS sandbox_attachments_pkey"
        )
        return
    if not has_table(conn, "sandbox_attachments"):
        conn.execute(table_ddl(table="sandbox_attachments"))
        return
    keyed = [
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(sandbox_attachments)").fetchall()
        if int(row["pk"] or 0) > 0
    ]
    if not keyed:
        return
    conn.execute("DROP TABLE IF EXISTS sandbox_attachments_migrate")
    conn.execute(
        table_ddl(table="sandbox_attachments", name="sandbox_attachments_migrate")
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO sandbox_attachments_migrate (
          sandbox_uid, experiment_id, attached_at, detached_at
        )
        SELECT sandbox_uid, experiment_id, attached_at, detached_at
        FROM sandbox_attachments
        """
    )
    conn.execute("DROP TABLE sandbox_attachments")
    conn.execute(
        "ALTER TABLE sandbox_attachments_migrate RENAME TO sandbox_attachments"
    )


def _drop_sandboxes_experiment_id(conn: Connection) -> None:
    """Migration 8: sandbox rows are machine state only; the relationship
    lives in sandbox_attachments."""
    if not has_column(conn, "sandboxes", "experiment_id"):
        return
    _backfill_sandbox_attachments(conn)
    if is_sqlite(conn):
        _rebuild_sandboxes(conn)
        return
    conn.execute("ALTER TABLE sandboxes DROP COLUMN IF EXISTS experiment_id")


def _drop_metrics_snapshots(conn: Connection) -> None:
    """Migration 9: MLflow is centralized, not archived through sandbox release."""
    conn.execute("DROP TABLE IF EXISTS metrics_snapshots")


def _normalize_storage_missing_status(conn: Connection) -> None:
    """Migration 10: `missing` is no longer a storage object status. Old rows
    are unavailable to agents, so keep them visible only through expired
    history instead of preserving a removed state."""
    if has_table(conn, "storage_objects"):
        conn.execute(
            "UPDATE storage_objects SET status = 'expired' WHERE status = 'missing'"
        )


def _add_sandbox_public_key_source(conn: Connection) -> None:
    """Migration 14: sandbox.get reports whether the authorized user SSH key
    came from the caller or the managed fallback."""
    ensure_columns(
        conn, "sandboxes", {"public_key_source": "TEXT NOT NULL DEFAULT 'managed'"}
    )


def _add_sandbox_last_command_columns(conn: Connection) -> None:
    """Migration 16: the whole last_command_* snapshot family."""
    ensure_columns(conn, "sandboxes", LAST_COMMAND_COLUMNS)


def _add_sandbox_provider_columns(conn: Connection) -> None:
    """Migration 18: rows record their owning compute provider.

    Backfill is the empty string: '' means "the configured default backend" at
    read time, so pre-multi-provider rows keep working.
    """
    for table in ("sandboxes", "sandbox_generations"):
        ensure_columns(conn, table, {"provider": "TEXT NOT NULL DEFAULT ''"})


def _add_sandbox_generation_key_id(conn: Connection) -> None:
    """Migration 27: spend attribution for project-key generations. Nullable
    keeps every JWT, rr_sk_, and local write on its historical row shape."""
    ensure_columns(conn, "sandbox_generations", {"key_id": "TEXT"})


def _add_runs_final_observed_at(conn: Connection) -> None:
    """Migration 35: a nullable stamp recording that a receipt read SUCCEEDED
    while the sandbox was still active. Existing rows stay NULL, which reads as
    `unknown`: honest about boxes that died before this shipped."""
    ensure_columns(conn, "sandboxes", {"runs_final_observed_at": "TEXT"})


def _add_sandbox_provider_settings(conn: Connection) -> None:
    """Migration 43: per-project saved cloud credentials + the enable switch."""
    if not has_table(conn, "sandbox_provider_settings"):
        conn.execute(table_ddl(table="sandbox_provider_settings"))


def _add_user_provider_caps(conn: Connection) -> None:
    """Migration 44: payer attribution + per-user per-provider daily caps.

    Additive only. The index lives here, never in the DDL: it names
    ladder-added columns (the migration-36 crash-loop lesson).
    """
    ensure_columns(
        conn,
        "sandboxes",
        {
            "user_id": "TEXT NOT NULL DEFAULT ''",
            "billing_mode": "TEXT NOT NULL DEFAULT ''",
            "quoted_price_usd_per_hour": "REAL",
            "budget_state": "TEXT NOT NULL DEFAULT ''",
            "over_budget_at": "TEXT",
        },
    )
    ensure_columns(
        conn,
        "sandbox_generations",
        {
            "user_id": "TEXT NOT NULL DEFAULT ''",
            "billing_mode": "TEXT NOT NULL DEFAULT ''",
            "sandbox_uid": "TEXT NOT NULL DEFAULT ''",
            "price_known": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    if not has_table(conn, "provider_user_caps"):
        conn.execute(table_ddl(table="provider_user_caps"))
    if has_table(conn, "sandbox_generations"):
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sandbox_generations_user"
            "  ON sandbox_generations(user_id, provider, started_at)"
        )


def _add_storage_completion_tokens(conn: Connection) -> None:
    """Migration 33: the one-time completion-token table behind the
    auth-exempt POST /api/storage/u/<token>/complete route."""
    if not has_table(conn, "storage_completion_tokens"):
        conn.execute(table_ddl(table="storage_completion_tokens"))


def _add_remote_sandbox_links(conn: Connection) -> None:
    """Migration 58: research associations for independently operated machines."""
    if not has_table(conn, "remote_sandbox_links"):
        conn.execute(table_ddl(table="remote_sandbox_links"))


INFRASTRUCTURE_SCHEMA = SchemaModule(
    name="infrastructure",
    ddl=INFRASTRUCTURE_DDL,
    migrations=(
        Migration(2, "add_sandbox_tenant_id", _add_sandbox_tenant_id),
        Migration(3, "add_sandbox_heartbeat_columns", _add_sandbox_heartbeat_columns),
        Migration(4, "migrate_sandbox_uid_identity", _migrate_sandbox_uid_identity),
        Migration(
            5, "drop_sandboxes_experiment_unique", _drop_sandboxes_experiment_unique
        ),
        Migration(
            6, "backfill_sandbox_mgmt_key_refs", _backfill_sandbox_mgmt_key_refs
        ),
        Migration(
            7, "allow_sandbox_attachment_history", _allow_sandbox_attachment_history
        ),
        Migration(8, "drop_sandboxes_experiment_id", _drop_sandboxes_experiment_id),
        Migration(9, "drop_metrics_snapshots", _drop_metrics_snapshots),
        Migration(
            10, "normalize_storage_missing_status", _normalize_storage_missing_status
        ),
        Migration(14, "add_sandbox_public_key_source", _add_sandbox_public_key_source),
        Migration(
            16, "add_sandbox_last_command_columns", _add_sandbox_last_command_columns
        ),
        Migration(18, "add_sandbox_provider_columns", _add_sandbox_provider_columns),
        Migration(
            27, "add_sandbox_generation_key_id", _add_sandbox_generation_key_id
        ),
        Migration(
            33, "add_storage_completion_tokens", _add_storage_completion_tokens
        ),
        Migration(35, "add_runs_final_observed_at", _add_runs_final_observed_at),
        Migration(43, "add_sandbox_provider_settings", _add_sandbox_provider_settings),
        Migration(44, "add_user_provider_caps", _add_user_provider_caps),
        Migration(58, "add_remote_sandbox_links", _add_remote_sandbox_links),
    ),
)
