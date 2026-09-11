"""The ladder above the squashed baseline.

Versions 1..64 are gone: the DDL states the shape they used to build up to.
What remains testable is the seam between the two — a fresh database stamps
the baseline and applies what came after it; a database already carrying the
baseline (production, at head 64 when the squash landed) applies only that.
"""

from __future__ import annotations

import re
import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path

from merv.brain.kernel.state.schema import BASELINE_VERSION, has_column, has_table
from tests.support.schema import ALL_SCHEMAS, LADDER, booted_store

# What migration 65 drops: the fleet the brain used to mirror locally.
RETIRED_TABLES = (
    "sandboxes",
    "sandbox_attachments",
    "sandbox_runs",
    "sandbox_generations",
    "sandbox_provider_settings",
    "tenant_quotas",
    "provider_user_caps",
    "spend_kill_switches",
)

# The shape those tables had at migration 64, reduced to what the drop needs
# to survive: the parent and the two children whose foreign keys name it.
RELEASE_64_SANDBOX_DDL = """
CREATE TABLE sandboxes (
  sandbox_uid TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE sandbox_attachments (
  sandbox_uid TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);
CREATE TABLE sandbox_runs (
  sandbox_uid TEXT NOT NULL,
  label TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sandbox_uid, label),
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);
CREATE TABLE sandbox_generations (id TEXT PRIMARY KEY, started_at TEXT NOT NULL);
CREATE TABLE sandbox_provider_settings (project_id TEXT, provider TEXT);
CREATE TABLE tenant_quotas (tenant_id TEXT PRIMARY KEY);
CREATE TABLE provider_user_caps (provider TEXT, user_id TEXT);
CREATE TABLE spend_kill_switches (scope TEXT PRIMARY KEY);
"""


def ledger(db_path: Path) -> list[tuple[int, str]]:
    conn = sqlite3.connect(db_path)
    try:
        return [
            (int(version), str(name))
            for version, name in conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
        ]
    finally:
        conn.close()


class BaselineLadderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / ".research_plugin" / "state.sqlite"
        self.db.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_fresh_install_records_the_baseline_and_everything_above_it(self) -> None:
        booted_store(db_path=self.db)
        self.assertEqual(ledger(self.db), list(LADDER))
        self.assertEqual(ledger(self.db)[0], (BASELINE_VERSION, "baseline"))

    def test_a_second_boot_of_a_fresh_store_applies_nothing_new(self) -> None:
        booted_store(db_path=self.db)
        first = ledger(self.db)
        booted_store(db_path=self.db)
        self.assertEqual(ledger(self.db), first)

    def test_a_database_at_the_baseline_applies_only_what_came_after(self) -> None:
        """Production: head 64, every legacy sandbox table still standing."""
        booted_store(db_path=self.db)
        with sqlite3.connect(self.db) as conn:
            conn.executescript(RELEASE_64_SANDBOX_DDL)
            conn.execute(
                "INSERT INTO sandboxes (sandbox_uid, project_id, status, created_at, updated_at) "
                "VALUES ('sbx_1', 'proj_1', 'terminated', 'then', 'then')"
            )
            conn.execute("DELETE FROM schema_migrations")
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) "
                "VALUES (?, 'converge_feed_columns', 'then')",
                (BASELINE_VERSION,),
            )
            conn.commit()

        store = booted_store(db_path=self.db)

        self.assertEqual(
            ledger(self.db),
            [(BASELINE_VERSION, "converge_feed_columns")]
            + [item for item in LADDER if item[0] > BASELINE_VERSION],
        )
        conn = store.connect()
        try:
            for table in RETIRED_TABLES:
                self.assertFalse(has_table(conn, table), table)
            # The tables Infrastructure still owns are untouched.
            for table in ("remote_sandbox_links", "storage_completion_tokens",
                          "storage_objects"):
                self.assertTrue(has_table(conn, table), table)
        finally:
            conn.close()


    def test_migration_67_drops_the_agent_session_columns_nothing_read(self) -> None:
        """A database that still carries them loses them; a fresh one is already
        without them, so the step is a no-op rather than an error."""
        booted_store(db_path=self.db)
        retired = (
            ("agent_sessions", "label"),
            ("agent_sessions", "telemetry_at"),
            ("agent_runners", "started_at"),
        )
        with sqlite3.connect(self.db) as conn:
            for table, column in retired:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
            conn.execute("DELETE FROM schema_migrations WHERE version = 67")
            conn.commit()

        store = booted_store(db_path=self.db)
        conn = store.connect()
        try:
            for table, column in retired:
                self.assertFalse(has_column(conn, table, column), column)
        finally:
            conn.close()


class DroppedUserHfTokensTest(unittest.TestCase):
    """Migration 80: a database that still carries the write-only token table
    loses it, so the one plaintext credential the brain stored is gone."""

    def test_the_table_is_dropped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "state.sqlite"
            with closing(sqlite3.connect(db)) as conn:
                conn.execute("CREATE TABLE user_hf_tokens (user_id TEXT PRIMARY KEY, token TEXT)")
                conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)")
                conn.execute("INSERT INTO schema_migrations VALUES (71, 'x', 'now')")
                conn.commit()
            store = booted_store(db_path=db)
            conn = store.connect()
            try:
                self.assertFalse(has_table(conn, "user_hf_tokens"))
            finally:
                conn.close()


class DeclaredIndexesTest(unittest.TestCase):
    """Every CREATE INDEX a schema module declares exists after a fresh install,
    so a hot lookup cannot silently fall back to a table scan."""

    def test_every_declared_index_is_installed(self) -> None:
        declared = set()
        for schema in ALL_SCHEMAS:
            declared.update(re.findall(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)", schema.ddl))
        with tempfile.TemporaryDirectory() as tmp:
            store = booted_store(db_path=Path(tmp) / "state.sqlite")
            conn = store.connect()
            try:
                installed = {
                    str(row["name"]) for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    ).fetchall()
                }
            finally:
                conn.close()
        self.assertGreater(len(declared), 20)
        self.assertEqual(declared - installed, set())


if __name__ == "__main__":
    unittest.main()
