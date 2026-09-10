"""The DCR get-or-create law the OAuth DDL states as a database fact.

Column shapes ride with ``test_schema_snapshot``. What only this file can
assert is the behavior of the unique index over ``metadata_fingerprint``:
identical canonical metadata resolves to one client row, and NULL is the
deliberate exception that lets pre-canonicalization duplicates coexist.
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from tests.support.schema import booted_store


class OAuthClientFingerprintSchemaTest(unittest.TestCase):
    def test_the_fingerprint_index_is_unique_and_null_is_its_exception(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
