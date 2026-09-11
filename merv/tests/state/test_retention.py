"""The retention clock: what it runs, what it isolates, what its sweeps clear."""

from __future__ import annotations

import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path

from merv.brain.kernel.retention import Retention
from merv.brain.kernel.utils import now_iso
from tests.support.brain import TestBrain

STALE = "2000-01-01T00:00:00Z"


class RetentionClockTest(unittest.TestCase):
    def test_run_once_runs_every_sweep_and_isolates_a_failing_one(self) -> None:
        failed: list[tuple[str, str]] = []
        ran: list[str] = []
        clock = Retention(on_error=lambda name, error: failed.append((name, str(error))))

        def broken() -> None:
            ran.append("broken")
            raise RuntimeError("the table is unreachable")

        clock.add("first", lambda: ran.append("first") or "swept")
        clock.add("broken", broken)
        clock.add("last", lambda: ran.append("last") or 3)

        outcomes = clock.run_once()

        self.assertEqual(ran, ["first", "broken", "last"], "a failure stopped the pass")
        self.assertEqual(outcomes["first"], "swept")
        self.assertEqual(outcomes["last"], 3)
        self.assertIsInstance(outcomes["broken"], RuntimeError)
        self.assertEqual(failed, [("broken", "the table is unreachable")])

    def test_the_thread_ticks_takes_late_sweeps_and_stops(self) -> None:
        ticks: list[str] = []
        started, joined = threading.Event(), threading.Event()

        def early() -> None:
            ticks.append("early")
            started.set()

        def late() -> None:
            ticks.append("late")
            joined.set()

        clock = Retention(initial_delay=0.0, interval=0.01)
        clock.add("early", early)
        clock.start()
        self.assertTrue(started.wait(timeout=5), "the clock never ticked")

        # The loop reads the registry each tick, so composition may register an
        # owner that is built after the clock is already running.
        clock.add("late", late)
        self.assertTrue(joined.wait(timeout=5), "a late sweep never ran")

        clock.stop()
        settled = len(ticks)
        time.sleep(0.05)
        self.assertEqual(len(ticks), settled, "a stopped clock kept sweeping")


class ComposedSweepTest(unittest.TestCase):
    """The sweeps a composed brain registers, over the rows they answer for."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.brain = TestBrain(repo_root=root, db_path=root / "state.sqlite")
        self.addCleanup(self.brain.shutdown)
        self.project_id = str(
            self.brain.call_tool("project", {"action": "create", "name": "Swept"})["id"]
        )

    def test_one_pass_clears_expired_feed_and_artifact_credentials(self) -> None:
        stale = self.brain.artifact_store.submit(project_id=self.project_id, path="stale.md")
        live = self.brain.artifact_store.submit(project_id=self.project_id, path="fresh.md")
        # A completed document whose figure slot was never filled: the slot is
        # retired, the document stays.
        doc = self.brain.artifact_store.submit(
            project_id=self.project_id, path="doc.md", discover_figures=True
        )
        self.brain.artifact_store.complete_upload(
            token=doc.token, kind="artifact", data=b"![p](figures/p.png)\n"
        )
        with self.brain.store.transaction() as conn:
            conn.execute(
                "UPDATE artifacts SET expires_at = ? WHERE id = ?",
                (STALE, stale.artifact_id),
            )
            conn.execute(
                "UPDATE artifact_figures SET expires_at = ? WHERE artifact_id = ?",
                (STALE, doc.artifact_id),
            )
            conn.execute(
                """
                INSERT INTO feed_upload_tokens (
                  token, project_id, post_id, handle, media_kind, expires_at, created_at
                ) VALUES ('fut_stale', ?, 'post_1', 'Nova-7', 'image', ?, ?)
                """,
                (self.project_id, STALE, now_iso()),
            )

        outcomes = self.brain.retention.run_once()

        self.assertLessEqual(
            {"tool_calls", "agent_sessions", "feed", "artifacts"}, set(outcomes)
        )
        self.assertTrue(dict(outcomes["tool_calls"])["ok"])
        with closing(self.brain.store.connect()) as conn:
            kept = {
                str(row["id"])
                for row in conn.execute("SELECT id FROM artifacts").fetchall()
            }
            tokens = conn.execute(
                "SELECT COUNT(*) AS n FROM feed_upload_tokens"
            ).fetchone()
            slot = conn.execute(
                "SELECT status, upload_token FROM artifact_figures WHERE artifact_id = ?",
                (doc.artifact_id,),
            ).fetchone()
        self.assertEqual(kept, {live.artifact_id, doc.artifact_id})
        self.assertEqual(int(tokens["n"]), 0)
        self.assertEqual((slot["status"], slot["upload_token"]), ("expired", ""))


if __name__ == "__main__":
    unittest.main()
