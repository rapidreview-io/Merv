"""The ladder above the squashed baseline.

Versions 1..64 are gone: the DDL states the shape they used to build up to.
What remains testable is the seam between the two — a fresh database stamps
the baseline and applies what came after it; a database already carrying the
baseline (production, at head 64 when the squash landed) applies only that.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from merv.brain.kernel.state.schema import BASELINE_VERSION, has_table
from merv.brain.surface.user_settings import UserHfTokenSettings
from tests.support.schema import LADDER, booted_store

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


class UserHfTokenStoreTest(unittest.TestCase):
    """no-dataplane Phase C: write-only per-user Hugging Face token store."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / ".research_plugin" / "state.sqlite"
        self.db.parent.mkdir(parents=True, exist_ok=True)
        self.store = booted_store(db_path=self.db)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_set_resolve_upsert_and_clear(self) -> None:
        settings = UserHfTokenSettings(store=self.store)
        self.assertEqual(settings.resolve(user_id="u1"), "")
        settings.set_token(user_id="u1", token="hf_first")
        self.assertEqual(settings.resolve(user_id="u1"), "hf_first")
        # Upsert (one row per user) — the second set replaces, not appends.
        settings.set_token(user_id="u1", token="hf_second")
        self.assertEqual(settings.resolve(user_id="u1"), "hf_second")
        conn = self.store.connect()
        try:
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM user_hf_tokens WHERE user_id = ?", ("u1",)
            ).fetchone()
            self.assertEqual(int(count["n"]), 1)
        finally:
            conn.close()
        settings.clear_token(user_id="u1")
        self.assertEqual(settings.resolve(user_id="u1"), "")

    def test_resolve_is_scoped_per_user_and_empty_for_unknown(self) -> None:
        settings = UserHfTokenSettings(store=self.store)
        settings.set_token(user_id="a", token="hf_a")
        self.assertEqual(settings.resolve(user_id="b"), "")
        self.assertEqual(settings.resolve(user_id=""), "")


if __name__ == "__main__":
    unittest.main()
