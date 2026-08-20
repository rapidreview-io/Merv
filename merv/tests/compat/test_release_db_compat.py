from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any

from merv.brain.artifacts import Artifacts
from merv.brain.feed.persistence import install_feed_schema
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.state.store import MIGRATIONS
from merv.brain.object_storage.blobs import LocalDirBlobStore
from merv.brain.research_core.association_targets import AssociationTargets

FIXTURE = Path(__file__).parent / "fixtures" / "release_f0439ca_v40.sql"
EXPECTED_SCHEMA_SHA256 = (
    "7201feaff5387661866e040eda820d6d20ec1982929d82b98288d4b389a0a8c3"
)


def _quoted_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _normalized_sql(value: str | None) -> str:
    if value is None:
        return ""
    without_conditional = re.sub(
        r"\bIF\s+NOT\s+EXISTS\b", "", value, flags=re.IGNORECASE
    )
    # ALTER TABLE ADD COLUMN splices new columns into sqlite_master's stored
    # text without the SCHEMA constant's comments or line spacing (first hit:
    # migration 44's sandboxes/sandbox_generations columns), so comments and
    # punctuation spacing are presentation, not structure. Structural drift —
    # names, types, defaults, constraints, order — still changes the hash.
    without_comments = re.sub(r"--[^\n]*", "", without_conditional)
    collapsed = " ".join(without_comments.split())
    collapsed = re.sub(r"\s*,\s*", ", ", collapsed)
    collapsed = re.sub(r"\(\s+", "(", collapsed)
    return re.sub(r"\s+\)", ")", collapsed)


def _schema_contract(db_path: Path) -> dict[str, Any]:
    """Return a structural contract including defaults, constraints, and indexes."""
    conn = sqlite3.connect(db_path)
    try:
        objects = conn.execute(
            """
            SELECT type, name, tbl_name, sql
            FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
            """
        ).fetchall()
        contract: dict[str, Any] = {
            "objects": [
                {
                    "type": row[0],
                    "name": row[1],
                    "table": row[2],
                    "sql": _normalized_sql(row[3]),
                }
                for row in objects
            ],
            "tables": {},
        }
        table_names = sorted(
            str(row[1]) for row in objects if row[0] == "table"
        )
        for table_name in table_names:
            quoted = _quoted_identifier(table_name)
            columns = conn.execute(f"PRAGMA table_xinfo({quoted})").fetchall()
            foreign_keys = conn.execute(
                f"PRAGMA foreign_key_list({quoted})"
            ).fetchall()
            indexes = []
            for index in conn.execute(f"PRAGMA index_list({quoted})").fetchall():
                index_name = str(index[1])
                index_columns = conn.execute(
                    f"PRAGMA index_xinfo({_quoted_identifier(index_name)})"
                ).fetchall()
                indexes.append(
                    {
                        "name": index_name,
                        "unique": int(index[2]),
                        "origin": str(index[3]),
                        "partial": int(index[4]),
                        "columns": sorted(tuple(row) for row in index_columns),
                    }
                )
            contract["tables"][table_name] = {
                "columns": sorted(tuple(row) for row in columns),
                "foreign_keys": sorted(tuple(row) for row in foreign_keys),
                "indexes": sorted(indexes, key=lambda item: item["name"]),
            }
        return contract
    finally:
        conn.close()


def _schema_sha256(db_path: Path) -> str:
    encoded = json.dumps(
        _schema_contract(db_path),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _data_snapshot(db_path: Path) -> dict[str, dict[str, Any]]:
    conn = sqlite3.connect(db_path)
    try:
        tables = [
            str(row[0])
            for row in conn.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            ).fetchall()
        ]
        snapshot: dict[str, dict[str, Any]] = {}
        for table in tables:
            quoted = _quoted_identifier(table)
            columns = [
                str(row[1])
                for row in conn.execute(f"PRAGMA table_info({quoted})").fetchall()
            ]
            rows = sorted(
                (
                    tuple(row)
                    for row in conn.execute(f"SELECT * FROM {quoted}").fetchall()
                ),
                key=repr,
            )
            snapshot[table] = {"columns": columns, "rows": rows}
        return snapshot
    finally:
        conn.close()


def _projected_rows(
    snapshot: dict[str, Any], columns: list[str]
) -> list[tuple[Any, ...]]:
    """Rows narrowed to `columns`, so an additive migration still compares.

    The ladder widens released tables (first populated hit: migration 54's
    experiments.details); released values must survive unchanged under their
    original columns, while the new columns' defaults are covered by the
    fresh-vs-migrated schema hash equality below.
    """
    indexes = [snapshot["columns"].index(name) for name in columns]
    return sorted(
        (tuple(row[i] for i in indexes) for row in snapshot["rows"]),
        key=repr,
    )


def _restore_fixture(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(FIXTURE.read_text(encoding="utf-8"))
    finally:
        conn.close()


class ReleaseDatabaseCompatibilityTest(unittest.TestCase):
    def test_release_v40_database_boot_is_schema_and_data_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            release_db = root / "release-v40.sqlite"
            fresh_db = root / "fresh.sqlite"
            _restore_fixture(release_db)

            release_schema_before = _schema_sha256(release_db)
            data_before = _data_snapshot(release_db)
            self.assertEqual(release_schema_before, EXPECTED_SCHEMA_SHA256)

            store = StateStore(db_path=release_db)
            migrated_data = _data_snapshot(release_db)
            for table, snap in data_before.items():
                if table == "schema_migrations":
                    continue
                self.assertLessEqual(
                    set(snap["columns"]), set(migrated_data[table]["columns"])
                )
                self.assertEqual(
                    _projected_rows(migrated_data[table], snap["columns"]),
                    snap["rows"],
                )
            self.assertEqual(migrated_data["agent_sessions"]["rows"], [])
            for table in (
                "experiment_workspaces",
                "consolidation_proposals",
                "consolidation_decisions",
                "reflection_advances",
            ):
                self.assertEqual(migrated_data[table]["rows"], [])
            self.assertIn(
                42,
                [int(row[0]) for row in migrated_data["schema_migrations"]["rows"]],
            )
            install_feed_schema(store)
            composed_schema = _schema_sha256(release_db)
            composed_data = _data_snapshot(release_db)
            for table, snap in data_before.items():
                if table == "schema_migrations":
                    continue
                self.assertEqual(
                    _projected_rows(composed_data[table], snap["columns"]),
                    snap["rows"],
                )

            reopened = StateStore(db_path=release_db)
            install_feed_schema(reopened)
            self.assertEqual(_schema_sha256(release_db), composed_schema)
            self.assertEqual(_data_snapshot(release_db), composed_data)

            fresh = StateStore(db_path=fresh_db)
            install_feed_schema(fresh)
            fresh_schema = _schema_sha256(fresh_db)
            self.assertEqual(fresh_schema, composed_schema)

            service = Artifacts(
                store=store,
                targets=AssociationTargets(),
                blobs=LocalDirBlobStore(root=root / "blobs"),
            )
            found = service.scan(
                project_id="proj_contract_v40",
                target_type="experiment",
                target_ids=("exp_contract_v40",),
            )
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0].id, "art_contract_v40")
            self.assertEqual(found[0].status, "complete")

            conn = store.connect()
            try:
                artifacts = conn.execute(
                    """
                    SELECT id, status, upload_token, submission_id
                    FROM artifacts
                    ORDER BY id
                    """
                ).fetchall()
                self.assertEqual(
                    [tuple(row) for row in artifacts],
                    [
                        (
                            "art_contract_v40",
                            "complete",
                            "",
                            "sub_contract_v40",
                        ),
                        (
                            "art_pending_v40",
                            "pending",
                            "release-v40-token",
                            "",
                        ),
                    ],
                )
                figure = conn.execute(
                    """
                    SELECT artifact_id, link_path, status, content_sha256
                    FROM artifact_figures
                    WHERE id = 'fig_contract_v40'
                    """
                ).fetchone()
                self.assertEqual(
                    tuple(figure),
                    (
                        "art_contract_v40",
                        "figures/curve.png",
                        "complete",
                        "b" * 64,
                    ),
                )
                snapshot = conn.execute(
                    """
                    SELECT target_snapshot_id
                    FROM review_requests
                    WHERE id = 'rr_contract_v40'
                    """
                ).fetchone()[0]
                self.assertEqual(
                    snapshot, "exp_contract_v40:1:art_contract_v40"
                )
                event = conn.execute(
                    """
                    SELECT type, target_type, target_id, payload_json
                    FROM events
                    WHERE id = 100
                    """
                ).fetchone()
                self.assertEqual(
                    tuple(event[:3]),
                    (
                        "artifact.submitted",
                        "experiment",
                        "exp_contract_v40",
                    ),
                )
                self.assertEqual(
                    json.loads(event[3]),
                    {
                        "artifact_id": "art_contract_v40",
                        "attempt_index": 1,
                        "path": "plan.md",
                        "role": "plan",
                    },
                )
                latest_migration = conn.execute(
                    "SELECT MAX(version) FROM schema_migrations"
                ).fetchone()[0]
                # A v40 database must boot all the way to the current ladder,
                # whatever its length is today.
                self.assertEqual(latest_migration, MIGRATIONS[-1][0])
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
