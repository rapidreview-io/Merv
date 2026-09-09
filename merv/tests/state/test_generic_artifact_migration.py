"""Upgrade coverage for immutable content and Research-owned evidence links."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.brain.kernel.state import store as state


def seed_legacy_artifacts(store: state.BaseStateStore) -> None:
    """Two rounds, a later attempt, a pending upload, and another project."""
    with store.transaction() as tx:
        for project in ("p1", "p2"):
            tx.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, ?, '2026-09-09')",
                (project, project),
            )
        for sid, attempt, order in (("s1", 0, 1), ("s2", 0, 2), ("s3", 1, 3)):
            tx.execute(
                "INSERT INTO submissions (id,project_id,target_type,target_id,"
                "attempt_index,transition,created_at,created_seq) "
                "VALUES (?,'p1','experiment','exp1',?,'submit_results','2026-09-09',?)",
                (sid, attempt, order),
            )
        records = (
            ("plan", "p1", "plan", 0, "plan.md", "s1", "complete"),
            ("report1", "p1", "report", 0, "report.md", "s1", "complete"),
            ("report2", "p1", "report", 0, "report.md", "s2", "complete"),
            ("result", "p1", "result", 0, "metrics.json", "s2", "complete"),
            ("unsealed", "p1", "report", 0, "report.md", "", "complete"),
            ("pending", "p1", "report", 0, "next.md", "", "pending"),
            ("next-attempt", "p1", "plan", 1, "plan.md", "s3", "complete"),
            ("other-project", "p2", "report", 0, "report.md", "", "complete"),
        )
        for order, (aid, project, role, attempt, path, seal, status) in enumerate(records, 1):
            tx.execute(
                "INSERT INTO artifacts (id,project_id,target_type,target_id,role,"
                "attempt_index,lens_id,path,title,content_sha256,size_bytes,content_type,"
                "status,upload_token,expires_at,created_by,created_at,updated_at,"
                "created_seq,submission_id) VALUES (?,?,'experiment','exp1',?,?,"
                "'',?,'Original title',?,123,'text/markdown',?,?,?,'agent',"
                "'2026-09-09','2026-09-09',?,?)",
                (
                    aid, project, role, attempt, path, aid + "-digest", status,
                    "pending-token" if status == "pending" else "",
                    "2099-01-01T00:00:00Z" if status == "pending" else None,
                    order, seal,
                ),
            )
        tx.execute(
            "INSERT INTO artifact_figures (id,artifact_id,link_path,content_sha256,"
            "size_bytes,status,upload_token) VALUES "
            "('figure','report1','plot.png','figure-digest',456,'complete','')"
        )
        tx.execute(
            "INSERT INTO artifact_figures (id,artifact_id,link_path,status,upload_token,"
            "expires_at) VALUES ('pending-figure','report2','next.png','pending',"
            "'figure-token','2099-01-01T00:00:00Z')"
        )


class GenericArtifactMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "state.sqlite"
        with patch.object(state, "MIGRATIONS", state.MIGRATIONS[:-1]):
            legacy = state.StateStore(db_path=self.db)
        seed_legacy_artifacts(legacy)

    def test_extracts_research_fields_without_rewriting_content_or_uploads(self) -> None:
        upgraded = state.StateStore(db_path=self.db)
        with upgraded.transaction() as tx:
            columns = {row["name"] for row in tx.execute("PRAGMA table_info(artifacts)").fetchall()}
            self.assertTrue({"max_bytes", "discover_figures"} <= columns)
            self.assertFalse(
                {"target_type", "target_id", "role", "attempt_index", "lens_id", "submission_id"} & columns
            )
            content = tx.execute("SELECT * FROM artifacts WHERE id = 'report1'").fetchone()
            self.assertEqual(content["content_sha256"], "report1-digest")
            self.assertEqual(content["title"], "Original title")
            self.assertEqual(content["size_bytes"], 123)
            self.assertEqual(content["max_bytes"], 16000)
            self.assertEqual(content["discover_figures"], 1)
            link = tx.execute("SELECT * FROM research_artifacts WHERE id = 'report1'").fetchone()
            self.assertEqual((link["id"], link["artifact_id"], link["role"], link["submission_id"]),
                             ("report1", "report1", "report", "s1"))
            self.assertEqual(link["created_seq"], 2)
            pending = tx.execute("SELECT * FROM artifacts WHERE id = 'pending'").fetchone()
            self.assertEqual((pending["status"], pending["upload_token"], pending["expires_at"]),
                             ("pending", "pending-token", "2099-01-01T00:00:00Z"))
            activity = {row["id"]: row["active"] for row in tx.execute(
                "SELECT id,active FROM research_artifact_links WHERE project_id='p1' AND attempt_index=0"
            ).fetchall()}
            self.assertEqual(activity, {"plan": 1, "report1": 0, "report2": 0,
                                        "result": 1, "unsealed": 1, "pending": 0})
            figures = tx.execute("SELECT * FROM artifact_figures ORDER BY id").fetchall()
            self.assertEqual([(row["id"], row["artifact_id"]) for row in figures],
                             [("figure", "report1"), ("pending-figure", "report2")])
            self.assertEqual(figures[1]["upload_token"], "figure-token")
            self.assertEqual(tx.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_materializes_carried_evidence_without_future_rounds_or_other_projects(self) -> None:
        upgraded = state.StateStore(db_path=self.db)
        with upgraded.transaction() as tx:
            rows = tx.execute(
                "SELECT submission_id,link_id FROM research_submission_artifacts ORDER BY submission_id,link_id"
            ).fetchall()
            self.assertEqual(
                [(row["submission_id"], row["link_id"]) for row in rows],
                [("s1", "plan"), ("s1", "report1"),
                 ("s2", "plan"), ("s2", "report2"), ("s2", "result"),
                 ("s3", "next-attempt")],
            )

    def test_reopening_and_reusing_content_preserve_history(self) -> None:
        state.StateStore(db_path=self.db)

        reopened = state.StateStore(db_path=self.db)
        with reopened.transaction() as tx:
            tx.execute(
                "INSERT INTO research_artifact_links (id,artifact_id,project_id,target_type,"
                "target_id,role,created_at,created_seq) VALUES "
                "('second-use','plan','p1','task','task1','input','2026-09-10',9)"
            )
            tx.execute(
                "INSERT INTO artifacts (id,project_id,path,created_at,updated_at) "
                "VALUES ('generic','p1','file.bin','2026-09-10','2026-09-10')"
            )
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM artifacts").fetchone()["n"], 9)
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM research_artifact_links").fetchone()["n"], 9)
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=59").fetchone()["n"], 1)
            links = tx.execute("SELECT id,artifact_id FROM research_artifacts WHERE artifact_id='plan' ORDER BY id").fetchall()
            self.assertEqual([(row["id"], row["artifact_id"]) for row in links],
                             [("plan", "plan"), ("second-use", "plan")])
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM research_submission_artifacts").fetchone()["n"], 6)

    def test_failed_migration_rolls_back_fields_data_and_ledger_together(self) -> None:
        class FailingStore(state.StateStore):
            def _separate_artifact_content_from_research(self, *, conn) -> None:
                super()._separate_artifact_content_from_research(conn=conn)
                raise RuntimeError("injected migration failure")

        with self.assertRaisesRegex(RuntimeError, "injected migration failure"):
            FailingStore(db_path=self.db)
        with sqlite3.connect(self.db) as tx:
            self.assertEqual(tx.execute("SELECT role,submission_id FROM artifacts WHERE id='plan'").fetchone(),
                             ("plan", "s1"))
            self.assertEqual(tx.execute("SELECT COUNT(*) FROM schema_migrations WHERE version=59").fetchone()[0], 0)
            self.assertEqual(tx.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='research_artifact_links'").fetchone()[0], 0)
        state.StateStore(db_path=self.db)

    def test_pending_cleanup_cascades_intents_but_snapshots_protect_content(self) -> None:
        upgraded = state.StateStore(db_path=self.db)
        with upgraded.transaction() as tx:
            tx.execute("DELETE FROM artifacts WHERE id='pending'")
            self.assertIsNone(tx.execute("SELECT id FROM research_artifact_links WHERE id='pending'").fetchone())
            with self.assertRaises(sqlite3.IntegrityError):
                tx.execute("DELETE FROM artifacts WHERE id='plan'")
            self.assertIsNotNone(tx.execute("SELECT id FROM artifacts WHERE id='plan'").fetchone())

    def test_next_research_seal_uses_latest_migrated_versions_and_carried_slots(self) -> None:
        from merv.brain.artifacts import Artifacts
        from merv.brain.research_core.artifact_models import ArtifactTarget
        from merv.brain.research_core.artifacts import ResearchArtifacts
        from tests.fakes import FakeBlobStore

        with sqlite3.connect(self.db) as tx:
            tx.execute("DELETE FROM artifacts WHERE id='unsealed'")
            tx.execute("UPDATE artifact_figures SET status='complete', content_sha256='finished' WHERE id='pending-figure'")
            tx.execute(
                "INSERT INTO experiments (id,project_id,name,intent,status,attempt_index,"
                "created_at,updated_at) VALUES ('exp1','p1','Migration','Preserve evidence',"
                "'running',0,'2026-09-09','2026-09-09')"
            )
        upgraded = state.StateStore(db_path=self.db)
        evidence = ResearchArtifacts(store=upgraded, artifacts=Artifacts(store=upgraded, blobs=FakeBlobStore()))
        with upgraded.transaction() as tx:
            evidence.seal(tx=tx, target=ArtifactTarget("experiment", "exp1", "p1"), transition="submit_results")
            latest = tx.execute("SELECT id FROM submissions ORDER BY created_seq DESC LIMIT 1").fetchone()["id"]
            selected = tx.execute("SELECT link_id FROM research_submission_artifacts WHERE submission_id=? ORDER BY link_id", (latest,)).fetchall()
            self.assertEqual([row["link_id"] for row in selected], ["plan", "report2", "result"])
            historic = tx.execute("SELECT link_id FROM research_submission_artifacts WHERE submission_id='s1' ORDER BY link_id").fetchall()
            self.assertEqual([row["link_id"] for row in historic], ["plan", "report1"])

    def test_later_system_pin_retires_old_paths_but_keeps_later_agent_slot(self) -> None:
        with sqlite3.connect(self.db) as tx:
            tx.execute("UPDATE artifacts SET created_by='system',path='old.md' WHERE id='report1'")
            tx.execute("UPDATE artifacts SET created_by='system',path='new.md' WHERE id='report2'")
        upgraded = state.StateStore(db_path=self.db)
        with upgraded.transaction() as tx:
            active = tx.execute(
                "SELECT id FROM research_artifacts WHERE project_id='p1' AND role='report' AND active=1 ORDER BY id"
            ).fetchall()
            self.assertEqual([row["id"] for row in active], ["report2", "unsealed"])
            # Earlier rounds retain the composition the old path-based
            # history reader exposed, including their original display paths.
            historic = tx.execute(
                "SELECT l.id,a.path FROM research_submission_artifacts m "
                "JOIN research_artifact_links l ON l.id=m.link_id "
                "JOIN artifacts a ON a.id=l.artifact_id "
                "WHERE m.submission_id='s2' AND l.role='report' ORDER BY l.id"
            ).fetchall()
            self.assertEqual([(row["id"], row["path"]) for row in historic],
                             [("report1", "old.md"), ("report2", "new.md")])


@unittest.skipUnless(os.environ.get("MERV_TEST_POSTGRES_DSN"), "disposable Postgres not supplied")
class GenericArtifactPostgresMigrationTest(unittest.TestCase):
    def test_real_upgrade_rollback_and_reopen_preserve_references(self) -> None:
        import psycopg

        from merv.brain.kernel.state.dialects import PostgresStateStore

        dsn = os.environ["MERV_TEST_POSTGRES_DSN"]
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        with patch.object(state, "MIGRATIONS", state.MIGRATIONS[:-1]):
            legacy = PostgresStateStore(dsn=dsn)
        seed_legacy_artifacts(legacy)

        class FailingStore(PostgresStateStore):
            def _separate_artifact_content_from_research(self, *, conn) -> None:
                super()._separate_artifact_content_from_research(conn=conn)
                raise RuntimeError("injected migration failure")

        with self.assertRaisesRegex(RuntimeError, "injected migration failure"):
            FailingStore(dsn=dsn)
        with legacy.transaction() as tx:
            self.assertEqual(tx.execute("SELECT role FROM artifacts WHERE id='plan'").fetchone()["role"], "plan")
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=59").fetchone()["n"], 0)
        PostgresStateStore(dsn=dsn)
        reopened = PostgresStateStore(dsn=dsn)
        with reopened.transaction() as tx:
            columns = {
                row["column_name"] for row in tx.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='artifacts'"
                ).fetchall()
            }
            self.assertFalse({"role", "target_id", "submission_id", "attempt_index", "lens_id"} & columns)
            self.assertEqual(tx.execute("SELECT COUNT(*) AS n FROM artifacts").fetchone()["n"], 8)
            rows = tx.execute(
                "SELECT submission_id,link_id FROM research_submission_artifacts ORDER BY submission_id,link_id"
            ).fetchall()
            self.assertEqual([(row["submission_id"], row["link_id"]) for row in rows],
                             [("s1", "plan"), ("s1", "report1"), ("s2", "plan"),
                              ("s2", "report2"), ("s2", "result"), ("s3", "next-attempt")])
            pending = tx.execute("SELECT upload_token FROM research_artifacts WHERE id='pending'").fetchone()
            self.assertEqual(pending["upload_token"], "pending-token")
            figure = tx.execute("SELECT artifact_id,content_sha256 FROM artifact_figures WHERE id='figure'").fetchone()
            self.assertEqual((figure["artifact_id"], figure["content_sha256"]), ("report1", "figure-digest"))
            tx.execute(
                "INSERT INTO artifacts (id,project_id,path,created_at,updated_at) "
                "VALUES ('generic','p1','file.bin','2026-09-10','2026-09-10')"
            )
