"""Booting migration 36 against a database that predates it.

This is a regression test for a production outage. SCHEMA is executed on every
boot before the migration ladder, and its `CREATE TABLE IF NOT EXISTS` is a
no-op on a database that already has the table. So a `CREATE INDEX` in SCHEMA
naming a column that only a migration adds will fail on every existing
deployment — before the ALTER that would add it can run — and the container
crash-loops. A fresh database never sees it, so neither does the test suite
unless it simulates an upgrade.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.brain.kernel.state.store import MIGRATIONS, SCHEMA, StateStore


def _schema_without_submissions() -> str:
    """SCHEMA as it stood before migration 36: no submissions table, and no
    submission_id column on artifacts or reviews."""
    blocks = SCHEMA.split(";")
    kept = []
    for block in blocks:
        if "CREATE TABLE IF NOT EXISTS submissions" in block:
            continue
        lines = [
            line
            for line in block.splitlines()
            if "submission_id" not in line
        ]
        kept.append("\n".join(lines))
    return ";".join(kept)


class Migration36OnExistingDatabaseTest(unittest.TestCase):
    def test_store_boots_against_a_pre_submission_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "legacy.sqlite"

            # Stand up the old shape and stamp every migration before 36, so
            # the ladder has exactly one to apply — the same position a live
            # deployment is in when it pulls this change.
            conn = sqlite3.connect(db_path)
            conn.executescript(_schema_without_submissions())
            for version, name, _ in MIGRATIONS:
                if version < 36:
                    conn.execute(
                        "INSERT OR IGNORE INTO schema_migrations "
                        "(version, name, applied_at) VALUES (?, ?, '2026-01-01T00:00:00Z')",
                        (version, name),
                    )
            conn.commit()
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(artifacts)").fetchall()
            }
            self.assertNotIn(
                "submission_id", columns, "fixture must start without the column"
            )
            conn.close()

            # The outage: this raised UndefinedColumn and the process died.
            with patch("merv.brain.kernel.state.store.MIGRATIONS",
                       tuple(migration for migration in MIGRATIONS if migration[0] <= 36)):
                store = StateStore(db_path=db_path)

            with store.transaction() as conn:
                columns = {
                    row["name"]
                    for row in conn.execute("PRAGMA table_info(artifacts)").fetchall()
                }
                self.assertIn("submission_id", columns)
                review_columns = {
                    row["name"]
                    for row in conn.execute("PRAGMA table_info(reviews)").fetchall()
                }
                self.assertIn("submission_id", review_columns)
                tables = {
                    row["name"]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
                self.assertIn("submissions", tables)
                indexes = {
                    row["name"]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    ).fetchall()
                }
                self.assertIn("idx_submissions_target", indexes)
                self.assertIn("idx_artifacts_submission", indexes)
                applied = {
                    int(row["version"])
                    for row in conn.execute(
                        "SELECT version FROM schema_migrations"
                    ).fetchall()
                }
                self.assertIn(36, applied)

            # The later content split transfers the seal marker to Research;
            # it must still accept the real migration-36 shape just verified.
            store = StateStore(db_path=db_path)
            with store.transaction() as conn:
                content_columns = {row["name"] for row in conn.execute("PRAGMA table_info(artifacts)").fetchall()}
                link_columns = {row["name"] for row in conn.execute("PRAGMA table_info(research_artifact_links)").fetchall()}
                self.assertNotIn("submission_id", content_columns)
                self.assertIn("submission_id", link_columns)
                self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (36,59)").fetchone()["n"], 2)

    def test_schema_declares_no_index_on_a_migration_added_column(self) -> None:
        """The general form of the outage: SCHEMA runs before the ladder, so no
        index in it may name a column that a migration introduces."""
        migration_added = {"submission_id"}
        offenders = [
            block.strip().splitlines()[0]
            for block in SCHEMA.split(";")
            if "CREATE INDEX" in block
            and any(column in block for column in migration_added)
        ]
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
