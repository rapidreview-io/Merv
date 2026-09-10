"""Append-only schema migration coverage for the OAuth Phase-B tables.

Migrations 28-30 create the three surface-owned OAuth tables from the same
SCHEMA-extracted DDL that a fresh database gets, gated on ``_has_table`` so an
existing store is upgraded in place. The audience + oauth_family_id columns
these access bearers ride live in migration 26's DDL, so no separate column
migration appears here.

Migration 38 then makes DCR get-or-create a database fact rather than an
application convention: the canonical metadata fingerprint, its UNIQUE index,
and the two child-table client_id indexes the registration path's eligibility
subqueries scan.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from merv.brain.kernel.state.fingerprints import oauth_client_fingerprint
from merv.brain.kernel.state.schema import MIGRATION_ORDER
from merv.brain.surface.oauth_store import _add_oauth_client_fingerprint
from merv.brain.kernel.state.store import StateStore
from tests.support.schema import LADDER, booted_store


class OAuthMigrationTest(unittest.TestCase):
    def test_fresh_schema_has_surface_owned_oauth_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = booted_store(db_path=Path(tmp) / "state.sqlite")
            with store.connect() as conn:
                columns = {
                    table: {
                        row["name"]
                        for row in conn.execute(
                            f"PRAGMA table_info({table})"
                        ).fetchall()
                    }
                    for table in (
                        "oauth_clients",
                        "oauth_authorization_codes",
                        "oauth_refresh_tokens",
                    )
                }
                migrations = [
                    (row["version"], row["name"])
                    for row in conn.execute(
                        "SELECT version, name FROM schema_migrations "
                        "WHERE version BETWEEN 28 AND 30 ORDER BY version"
                    ).fetchall()
                ]
        self.assertEqual(
            columns["oauth_clients"],
            {
                "client_id",
                "client_name",
                "redirect_uris_json",
                "grant_types_json",
                "metadata_fingerprint",
                "created_at",
            },
        )
        self.assertEqual(
            columns["oauth_authorization_codes"],
            {
                "code_digest",
                "client_id",
                "redirect_uri",
                "owner_user_id",
                "project_id",
                "grant_scope",
                "code_challenge",
                "resource",
                "created_at",
                "expires_at",
                "consumed_at",
            },
        )
        self.assertEqual(
            columns["oauth_refresh_tokens"],
            {
                "id",
                "family_id",
                "secret_digest",
                "client_id",
                "owner_user_id",
                "project_id",
                "grant_scope",
                "resource",
                "current_key_id",
                "parent_token_id",
                "created_at",
                "expires_at",
                "consumed_at",
                "revoked_at",
            },
        )
        self.assertEqual(
            migrations,
            [
                (28, "add_oauth_clients"),
                (29, "add_oauth_authorization_codes"),
                (30, "add_oauth_refresh_tokens"),
            ],
        )
        self.assertEqual(
            [item for item in LADDER if 28 <= item[0] <= 30],
            migrations,
        )

    def test_v28_through_v30_upgrade_an_existing_store_without_rewriting_history(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "state.sqlite"
            # Build the pre-upgrade ledger before removing these historical
            # table shapes. Rewinding a fully migrated content store would
            # incorrectly replay destructive later migrations against it.
            with patch("merv.brain.kernel.state.store.MIGRATION_ORDER",
                       tuple(v for v in MIGRATION_ORDER if v < 28)):
                booted_store(db_path=db_path)
            conn = sqlite3.connect(db_path)
            try:
                conn.execute("PRAGMA foreign_keys = OFF")
                conn.execute("DROP TABLE oauth_refresh_tokens")
                conn.execute("DROP TABLE oauth_authorization_codes")
                conn.execute("DROP TABLE oauth_clients")
                before = conn.execute(
                    "SELECT version, name FROM schema_migrations ORDER BY version"
                ).fetchall()
                conn.commit()
            finally:
                conn.close()

            migrated = booted_store(db_path=db_path)
            with migrated.connect() as conn:
                after = [
                    (row["version"], row["name"])
                    for row in conn.execute(
                        "SELECT version, name FROM schema_migrations ORDER BY version"
                    ).fetchall()
                ]
                tables = {
                    row["name"]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
        self.assertEqual(
            before,
            [item for item in LADDER if item[0] < 28],
        )
        self.assertEqual(
            after,
            list(LADDER),
        )
        self.assertTrue(
            {
                "oauth_clients",
                "oauth_authorization_codes",
                "oauth_refresh_tokens",
            }
            <= tables
        )


class OAuthClientFingerprintMigrationTest(unittest.TestCase):
    """Migration 38: the canonical fingerprint, its UNIQUE index, the child
    indexes, and a backfill that adopts pre-canonicalization rows."""

    def _legacy_store(self, *, rows: list[tuple[str, str, list[str], list[str], str]]):
        """A store whose oauth_clients predates migration 38, holding ``rows``."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_path = Path(tmp.name) / "state.sqlite"
        with patch("merv.brain.kernel.state.store.MIGRATION_ORDER",
                   tuple(v for v in MIGRATION_ORDER if v < 38)):
            booted_store(db_path=db_path)
        conn = sqlite3.connect(db_path)
        try:
            # The index must go before the column SQLite refuses to drop under it.
            conn.execute("DROP INDEX IF EXISTS idx_oauth_clients_fingerprint")
            conn.execute("ALTER TABLE oauth_clients DROP COLUMN metadata_fingerprint")
            for client_id, name, uris, grants, created_at in rows:
                conn.execute(
                    "INSERT INTO oauth_clients (client_id, client_name, "
                    "redirect_uris_json, grant_types_json, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (client_id, name, json.dumps(uris), json.dumps(grants), created_at),
                )
            conn.commit()
        finally:
            conn.close()
        return db_path

    def test_v38_backfills_from_canonicalized_metadata(self) -> None:
        """A row written with UNSORTED arrays fingerprints as if it were sorted,
        so a canonical lookup finds it instead of forking a duplicate."""
        db_path = self._legacy_store(
            rows=[
                (
                    "oauthc_legacy",
                    "Legacy Agent",
                    ["https://client.example/b", "https://client.example/a"],
                    ["refresh_token", "authorization_code"],
                    "2026-01-01T00:00:00Z",
                )
            ]
        )
        migrated = booted_store(db_path=db_path)
        with migrated.connect() as conn:
            stored = conn.execute(
                "SELECT client_id, metadata_fingerprint FROM oauth_clients"
            ).fetchall()
        canonical = oauth_client_fingerprint(
            client_name="Legacy Agent",
            redirect_uris_json=json.dumps(
                ["https://client.example/a", "https://client.example/b"]
            ),
            grant_types_json=json.dumps(["authorization_code", "refresh_token"]),
        )
        self.assertEqual(
            [(row["client_id"], row["metadata_fingerprint"]) for row in stored],
            [("oauthc_legacy", canonical)],
        )

    def test_v38_leaves_a_canonical_duplicate_null_so_the_unique_index_builds(
        self,
    ) -> None:
        """Two legacy rows can already say the same thing. The oldest owns the
        identity; the other keeps NULL — distinct under both dialects' unique
        indexes — and stays reachable by client_id."""
        db_path = self._legacy_store(
            rows=[
                (
                    "oauthc_first",
                    "Twin Agent",
                    ["https://client.example/a", "https://client.example/b"],
                    ["authorization_code"],
                    "2026-01-01T00:00:00Z",
                ),
                (
                    "oauthc_second",
                    "Twin Agent",
                    ["https://client.example/b", "https://client.example/a"],
                    ["authorization_code"],
                    "2026-02-02T00:00:00Z",
                ),
            ]
        )
        migrated = booted_store(db_path=db_path)
        with migrated.connect() as conn:
            rows = {
                str(row["client_id"]): row["metadata_fingerprint"]
                for row in conn.execute(
                    "SELECT client_id, metadata_fingerprint FROM oauth_clients"
                ).fetchall()
            }
        self.assertIsNotNone(rows["oauthc_first"])
        self.assertIsNone(rows["oauthc_second"])

    def _fingerprints(self, store: StateStore) -> dict[str, Any]:
        with store.connect() as conn:
            return {
                str(row["client_id"]): row["metadata_fingerprint"]
                for row in conn.execute(
                    "SELECT client_id, metadata_fingerprint FROM oauth_clients"
                ).fetchall()
            }

    def test_v38_handler_replays_on_a_store_that_already_applied_it(self) -> None:
        """A migration that crashed after its work but before its ledger row is
        re-entered on the next boot, so the HANDLER — not just the version
        guard — has to be idempotent. Running it again on a migrated store must
        add no column twice, re-fingerprint nothing, leave the deliberate NULL
        duplicate alone, and keep the UNIQUE index enforcing."""
        db_path = self._legacy_store(
            rows=[
                (
                    "oauthc_first",
                    "Twin Agent",
                    ["https://client.example/a"],
                    ["authorization_code"],
                    "2026-01-01T00:00:00Z",
                ),
                (
                    "oauthc_second",
                    "Twin Agent",
                    ["https://client.example/a"],
                    ["authorization_code"],
                    "2026-02-02T00:00:00Z",
                ),
            ]
        )
        store = booted_store(db_path=db_path)
        before = self._fingerprints(store)
        self.assertIsNotNone(before["oauthc_first"])
        self.assertIsNone(before["oauthc_second"])

        with store.transaction() as conn:
            # Twice: the second pass proves replay is not a one-shot allowance.
            _add_oauth_client_fingerprint(conn)
            _add_oauth_client_fingerprint(conn)

        self.assertEqual(self._fingerprints(store), before)
        with store.connect() as conn:
            self.assertEqual(
                len(
                    [
                        row
                        for row in conn.execute(
                            "PRAGMA table_info(oauth_clients)"
                        ).fetchall()
                        if row["name"] == "metadata_fingerprint"
                    ]
                ),
                1,
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO oauth_clients (client_id, client_name, "
                    "redirect_uris_json, grant_types_json, metadata_fingerprint, "
                    "created_at) VALUES ('z', 'Z', '[]', '[]', ?, 'now')",
                    (before["oauthc_first"],),
                )

    def test_v38_indexes_exist_and_the_fingerprint_one_is_unique(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = booted_store(db_path=Path(tmp) / "state.sqlite")
            with store.connect() as conn:
                indexes = {
                    str(row["name"]): bool(row["unique"])
                    for table in (
                        "oauth_clients",
                        "oauth_authorization_codes",
                        "oauth_refresh_tokens",
                    )
                    for row in conn.execute(f"PRAGMA index_list({table})").fetchall()
                }
                applied = [
                    (row["version"], row["name"])
                    for row in conn.execute(
                        "SELECT version, name FROM schema_migrations WHERE version = 38"
                    ).fetchall()
                ]
                conn.execute(
                    "INSERT INTO oauth_clients (client_id, client_name, "
                    "redirect_uris_json, grant_types_json, metadata_fingerprint, "
                    "created_at) VALUES ('a', 'A', '[]', '[]', 'same', 'now')"
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute(
                        "INSERT INTO oauth_clients (client_id, client_name, "
                        "redirect_uris_json, grant_types_json, metadata_fingerprint, "
                        "created_at) VALUES ('b', 'B', '[]', '[]', 'same', 'now')"
                    )
                # NULL is the deliberate exception: legacy duplicates coexist.
                for client_id in ("c", "d"):
                    conn.execute(
                        "INSERT INTO oauth_clients (client_id, client_name, "
                        "redirect_uris_json, grant_types_json, metadata_fingerprint, "
                        f"created_at) VALUES ('{client_id}', 'N', '[]', '[]', NULL, 'now')"
                    )
        self.assertTrue(indexes.get("idx_oauth_clients_fingerprint"))
        self.assertIn("idx_oauth_codes_client", indexes)
        self.assertIn("idx_oauth_refresh_tokens_client", indexes)
        self.assertEqual(applied, [(38, "add_oauth_client_fingerprint")])


if __name__ == "__main__":
    unittest.main()
