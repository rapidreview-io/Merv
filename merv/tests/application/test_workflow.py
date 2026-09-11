"""Application workflow read performance."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from merv.brain.kernel.state.store import StateStore
from tests.support.brain import TestBrain


class CountingStateStore(StateStore):
    def __init__(self, *, db_path: Path) -> None:
        self.statements: list[str] = []
        super().__init__(db_path=db_path)

    def connect(self):
        conn = super().connect()
        conn.set_trace_callback(self.statements.append)
        return conn


class ApplicationDashboardTest(unittest.TestCase):
    """Keep the one performance invariant that matters: no experiment N+1."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = CountingStateStore(db_path=root / "state.sqlite")
        self.app = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            store=self.store,
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _seed_terminal_project(self, *, project_id: str, experiments: int) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
                (project_id, project_id, "2026-07-22T00:00:00Z"),
            )
            for index in range(experiments):
                conn.execute(
                    """
                    INSERT INTO experiments
                      (id, project_id, name, intent, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'complete', ?, ?)
                    """,
                    (
                        f"exp_{project_id}_{index:03d}",
                        project_id,
                        f"Experiment {index}",
                        f"Intent {index}",
                        "2026-07-22T00:00:00Z",
                        "2026-07-22T00:00:00Z",
                    ),
                )

    def _dashboard(self, project_id: str) -> tuple[dict, int]:
        self.store.statements.clear()
        result = self.app.application.dashboard(project_id=project_id)
        selects = sum(
            statement.lstrip().upper().startswith(("SELECT", "WITH"))
            for statement in self.store.statements
        )
        return result, selects

    def test_query_count_does_not_grow_with_experiment_history(self) -> None:
        self._seed_terminal_project(project_id="proj_one", experiments=1)
        self._seed_terminal_project(project_id="proj_many", experiments=25)

        self.app.research.initialize_workflows()
        one, one_selects = self._dashboard("proj_one")
        many, many_selects = self._dashboard("proj_many")

        self.assertEqual(len(one["experiments"]), 1)
        self.assertEqual(len(many["experiments"]), 25)
        self.assertEqual(many_selects, one_selects)


if __name__ == "__main__":
    unittest.main()
