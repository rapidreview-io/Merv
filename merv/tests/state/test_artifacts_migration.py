"""Migration 24: artifact tables + metadata-only backfill from resources."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.brain.kernel.state.store import MIGRATIONS, StateStore


class ArtifactsBackfillMigrationTest(unittest.TestCase):
    """Replay migrations 24+25 against a resource-era database.

    A first StateStore boot creates the modern schema; the test then rewinds
    migrations 24 and 25 (drops the artifact tables + their ledger rows),
    recreates the resource-era tables the pre-cut SCHEMA used to carry, seeds
    rows, and re-opens the store so the backfill-then-drop replays — the same
    shape a production upgrade sees.
    """

    _RESOURCE_ERA_DDL = (
        """
        CREATE TABLE resources (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
          kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
          current_version_id TEXT, version_token TEXT NOT NULL,
          mtime_ns INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
          observed_at TEXT NOT NULL, git_commit TEXT,
          missing INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT 'codex', created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, UNIQUE(project_id, path)
        )
        """,
        """
        CREATE TABLE resource_versions (
          id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, project_id TEXT NOT NULL,
          path TEXT NOT NULL, content_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          mtime_ns INTEGER NOT NULL, observed_at TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          created_by TEXT NOT NULL DEFAULT 'codex', created_at TEXT NOT NULL,
          created_seq INTEGER NOT NULL DEFAULT 0
        )
        """,
        """
        CREATE TABLE resource_associations (
          id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, version_id TEXT,
          target_type TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT NOT NULL,
          attempt_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          created_seq INTEGER NOT NULL DEFAULT 0,
          UNIQUE(resource_id, target_type, target_id, role, attempt_index)
        )
        """,
        """
        CREATE TABLE report_figures (
          report_version_id TEXT NOT NULL, link_path TEXT NOT NULL,
          sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (report_version_id, link_path)
        )
        """,
    )

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "state.sqlite"
        with patch("merv.brain.kernel.state.store.MIGRATIONS", tuple(item for item in MIGRATIONS if item[0] < 59)):
            StateStore(db_path=self.db_path)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DROP TABLE IF EXISTS artifact_figures")
            conn.execute("DROP TABLE IF EXISTS artifacts")
            conn.execute("DELETE FROM schema_migrations WHERE version IN (24, 25)")
            for ddl in self._RESOURCE_ERA_DDL:
                conn.execute(ddl)
            self._seed(conn)
            conn.commit()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed(self, conn: sqlite3.Connection) -> None:
        project = ("proj_1",)
        conn.execute(
            "INSERT INTO projects (id, name, created_at) VALUES (?, 'P', '2026-07-01T00:00:00Z')",
            project,
        )
        experiments = [("exp_1", 2)]
        for exp_id, attempt in experiments:
            conn.execute(
                """
                INSERT INTO experiments
                  (id, project_id, name, intent, status, attempt_index,
                   revision_context, created_at, updated_at)
                VALUES (?, 'proj_1', ?, 'i', 'running', ?, '',
                        '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')
                """,
                (exp_id, exp_id, attempt),
            )
        conn.execute(
            """
            INSERT INTO reflections
              (id, project_id, title, status, roster_json, corpus_json,
               published_at, published_graph_version_id, created_at,
               updated_at, created_seq)
            VALUES ('ref_1', 'proj_1', 'Wave', 'published', '[]', '{}',
                    '2026-07-02T00:00:00Z', 'rver_graph',
                    '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 1)
            """
        )
        resources = [
            # (id, path, kind, title)
            ("res_plan", "plan.md", "plan", "Plan"),
            ("res_lens", "reflections/rigor.md", "reflection", "Rigor lens"),
            ("res_graph", "project/logic_graph.json", "document", ""),
        ]
        for resource_id, path, kind, title in resources:
            conn.execute(
                """
                INSERT INTO resources
                  (id, project_id, path, kind, title, current_version_id,
                   version_token, mtime_ns, size_bytes, observed_at,
                   created_by, created_at, updated_at)
                VALUES (?, 'proj_1', ?, ?, ?, ?, 'tok', 1, 10,
                        '2026-07-01T00:00:00Z', 'codex',
                        '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')
                """,
                (resource_id, path, kind, title, f"rver_{resource_id[4:]}"),
            )
        versions = [
            # rver_plan_v1 is superseded: no association pins it any more.
            ("rver_plan_v1", "res_plan", "plan.md", "9" * 64, 10),
            ("rver_plan", "res_plan", "plan.md", "a" * 64, 11),
            ("rver_lens", "res_lens", "reflections/rigor.md", "b" * 64, 12),
            ("rver_graph", "res_graph", "project/logic_graph.json", "c" * 64, 13),
        ]
        for seq, (version_id, resource_id, path, sha, size) in enumerate(versions, 1):
            conn.execute(
                """
                INSERT INTO resource_versions
                  (id, resource_id, project_id, path, content_sha256,
                   size_bytes, mtime_ns, observed_at, content_type,
                   created_by, created_at, created_seq)
                VALUES (?, ?, 'proj_1', ?, ?, ?, 1, '2026-07-01T00:00:00Z',
                        'text/markdown', 'codex', '2026-07-01T00:00:00Z', ?)
                """,
                (version_id, resource_id, path, sha, size, seq),
            )
        associations = [
            # (id, resource, version, target_type, target_id, role, attempt)
            ("as_1", "res_plan", "rver_plan", "experiment", "exp_1", "plan", 2),
            # Legacy lens-doc role spelling: canonicalized by the backfill.
            ("as_2", "res_lens", "rver_lens", "reflection", "ref_1",
             "reflection", 1),
            ("as_3", "res_graph", "rver_graph", "reflection", "ref_1",
             "project_graph", 1),
            # Shares rver_graph with as_3 under another (legacy) role, so the
            # version->artifact map must keep both artifacts.
            ("as_4", "res_graph", "rver_graph", "reflection", "ref_1",
             "synthesis_doc", 1),
            # Duplicate of as_2 under the CANONICAL spelling: both land in one
            # new-model slot, so the backfill must keep a single artifact
            # (preferring this already-canonical association) and map the
            # legacy association onto the survivor.
            ("as_5", "res_lens", "rver_lens", "reflection", "ref_1",
             "reflection_lens_doc", 1),
        ]
        for seq, row in enumerate(associations, 1):
            conn.execute(
                """
                INSERT INTO resource_associations
                  (id, resource_id, version_id, target_type, target_id, role,
                   attempt_index, created_at, created_seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-01T01:00:00Z', ?)
                """,
                (*row, seq),
            )
        for version_id, link in (
            ("rver_plan", "figures/curve.png"),
            # Attached to the shared version: must fan out to BOTH artifacts.
            ("rver_graph", "figures/shared.png"),
            # Attached to the deduped lens version: exactly ONE figure row,
            # on the surviving artifact — not one per duplicate association.
            ("rver_lens", "figures/lens.png"),
        ):
            conn.execute(
                """
                INSERT INTO report_figures
                  (report_version_id, link_path, sha256, size_bytes, created_at)
                VALUES (?, ?, ?, 42, '2026-07-01T01:00:00Z')
                """,
                (version_id, link, "d" * 64),
            )
        # req_1: old-format snapshot pinning the CURRENT plan version.
        # req_2: pinned to the superseded rver_plan_v1 — it must stay stale
        # (kept verbatim), never be revived onto the current version's artifact.
        # req_3: pinned via the LEGACY lens association (the dedupe loser) —
        # it must rewrite onto the surviving canonical artifact.
        for req_id, target_type, target_id, snapshot in (
            ("req_1", "experiment", "exp_1",
             "experiment|exp_1|design_review|2|res_plan:rver_plan:plan:2"),
            ("req_2", "experiment", "exp_1",
             "experiment|exp_1|design_review|2|res_plan:rver_plan_v1:plan:2"),
            ("req_3", "reflection", "ref_1",
             "reflection|ref_1|reflection_review|1|res_lens:rver_lens:reflection:1"),
            # req_4: lists BOTH halves of the deduped pair — the rewrite must
            # collapse them to ONE survivor token, matching the live snapshot.
            ("req_4", "reflection", "ref_1",
             "reflection|ref_1|reflection_review|1|"
             "res_lens:rver_lens:reflection:1,"
             "res_lens:rver_lens:reflection_lens_doc:1"),
        ):
            conn.execute(
                """
                INSERT INTO review_requests
                  (id, project_id, target_type, target_id, role, capability_hash,
                   status, target_snapshot_id, expires_at, created_at, created_seq)
                VALUES (?, 'proj_1', ?, ?, 'design_reviewer',
                        ?, 'requested', ?,
                        '2027-01-01T00:00:00Z', '2026-07-01T02:00:00Z', 1)
                """,
                (req_id, target_type, target_id, f"hash_{req_id}", snapshot),
            )

    def test_backfill_maps_rows_figures_and_refs(self) -> None:
        StateStore(db_path=self.db_path)  # replays migrations 24 (backfill) + 25 (drop)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        artifacts = {
            (str(row["path"]), str(row["role"])): dict(row)
            for row in conn.execute("SELECT * FROM research_artifacts").fetchall()
        }
        self.assertEqual(len(artifacts), 4)
        # The keyed dict above would mask a duplicate-slot row; count raw rows.
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0], 4
        )

        plan = artifacts[("plan.md", "plan")]
        self.assertTrue(str(plan["id"]).startswith("art_"))
        self.assertEqual(plan["target_id"], "exp_1")
        self.assertEqual(plan["attempt_index"], 2)
        self.assertEqual(plan["content_sha256"], "a" * 64)
        self.assertEqual(plan["size_bytes"], 11)
        self.assertEqual(plan["status"], "complete")
        self.assertEqual(plan["lens_id"], "")

        # Legacy roles are canonicalized; lens docs inherit lens_id from the
        # basename stem convention. The legacy+canonical duplicate pair
        # (as_2 + as_5) collapsed into ONE artifact — the total above counts
        # it once — surviving as the already-canonical association (as_5).
        lens = artifacts[("reflections/rigor.md", "reflection_lens_doc")]
        self.assertEqual(lens["lens_id"], "rigor")
        self.assertEqual(lens["title"], "Rigor lens")
        self.assertEqual(lens["created_seq"], 5)
        graph = artifacts[("project/logic_graph.json", "project_graph")]
        doc = artifacts[("project/logic_graph.json", "reflection_doc")]

        # report_figures follow their document via the version->artifact map;
        # a version shared by two associations fans out to both artifacts.
        figures = {
            (str(row["artifact_id"]), str(row["link_path"]))
            for row in conn.execute(
                "SELECT artifact_id, link_path FROM artifact_figures"
            ).fetchall()
        }
        self.assertEqual(
            figures,
            {
                (plan["id"], "figures/curve.png"),
                (graph["id"], "figures/shared.png"),
                (doc["id"], "figures/shared.png"),
                # Deduped slot: one figure row on the survivor, not two.
                (lens["id"], "figures/lens.png"),
            },
        )
        # The set above would hide row-level duplicates; count them out.
        figure_rows = conn.execute(
            "SELECT COUNT(*) FROM artifact_figures"
        ).fetchone()[0]
        self.assertEqual(figure_rows, 4)

        # The published-graph ref resolves to the project_graph-role artifact
        # specifically, even though another role shares the pinned version.
        published_ref = conn.execute(
            "SELECT published_graph_version_id FROM reflections WHERE id = 'ref_1'"
        ).fetchone()[0]
        self.assertEqual(published_ref, graph["id"])

        # The current-version snapshot token was rewritten to
        # artifact_id:role:attempt; the superseded-version token stays
        # verbatim, so its review remains stale instead of matching again.
        snapshots = {
            str(row["id"]): str(row["target_snapshot_id"])
            for row in conn.execute(
                "SELECT id, target_snapshot_id FROM review_requests"
            ).fetchall()
        }
        self.assertEqual(
            snapshots["req_1"],
            f"experiment|exp_1|design_review|2|{plan['id']}:plan:2",
        )
        self.assertEqual(
            snapshots["req_2"],
            "experiment|exp_1|design_review|2|res_plan:rver_plan_v1:plan:2",
        )
        # The legacy half of the deduped pair resolves to the SURVIVING
        # artifact with the canonical role spelling.
        self.assertEqual(
            snapshots["req_3"],
            f"reflection|ref_1|reflection_review|1|{lens['id']}:reflection_lens_doc:1",
        )
        # Both deduped-pair tokens collapse to a single survivor token —
        # byte-identical to the freshly computed post-migration snapshot.
        self.assertEqual(
            snapshots["req_4"],
            f"reflection|ref_1|reflection_review|1|{lens['id']}:reflection_lens_doc:1",
        )

        # Migration 25 dropped the resource-era tables right after the backfill.
        remaining = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        for table in ("resources", "resource_versions", "resource_associations", "report_figures"):
            self.assertNotIn(table, remaining)
        conn.close()

    def test_backfill_is_a_noop_on_fresh_databases(self) -> None:
        with tempfile.TemporaryDirectory() as fresh:
            StateStore(db_path=Path(fresh) / "state.sqlite")
            conn = sqlite3.connect(Path(fresh) / "state.sqlite")
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0], 0
            )
            applied = conn.execute(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 24"
            ).fetchone()[0]
            self.assertEqual(applied, 1)
            conn.close()


if __name__ == "__main__":
    unittest.main()
