"""A fresh install must reproduce the schema, whoever owns the DDL.

`fixtures/fresh_schema.json` is the table-and-column set a fresh database
reached by replaying the whole 1..64 ladder, minus the eight sandbox-fleet
tables migration 65 drops, the three OAuth exchange tables migration 66 drops,
the six experiment tracking columns migration 68 drops, the delivery-barrier
table migration 69 drops and the three record-spine columns migration 72 adds
to `review_requests`. Squashing that ladder into the DDL is a move, not a
change: installing
every component on an empty database — SQLite here, Postgres in
``test_postgres_dialect`` — must land on exactly this shape.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any

from merv.brain.kernel.state import StateStore
from tests.support.schema import install_all_schemas

SNAPSHOT = Path(__file__).parent / "fixtures" / "fresh_schema.json"


def expected_schema() -> dict[str, Any]:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def sqlite_schema(db_path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        objects = conn.execute(
            "SELECT type, name FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view') "
            "ORDER BY name"
        ).fetchall()
        tables: dict[str, list[str]] = {}
        views: list[dict[str, Any]] = []
        for kind, name in objects:
            columns = sorted(
                str(row[1])
                for row in conn.execute(f'PRAGMA table_info("{name}")').fetchall()
            )
            if kind == "table":
                tables[name] = columns
            else:
                views.append({"name": name, "columns": columns})
        return {"tables": tables, "views": views}
    finally:
        conn.close()


class FreshSchemaSnapshotTest(unittest.TestCase):
    def test_fresh_sqlite_install_matches_the_pre_squash_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = StateStore(db_path=Path(root) / "state.sqlite")
            install_all_schemas(store)
            self.assertEqual(sqlite_schema(Path(root) / "state.sqlite"), expected_schema())


if __name__ == "__main__":
    unittest.main()
