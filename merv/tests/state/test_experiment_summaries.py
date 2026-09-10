from __future__ import annotations

from merv.brain.workflows import Workflows
from merv.brain.agent_sessions import WorkspaceAdvances

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError
from merv.brain.research_core import Research


class CountingStateStore(StateStore):
    def __init__(self, *, db_path: Path) -> None:
        self.statements: list[str] = []
        super().__init__(db_path=db_path)

    def connect(self):
        conn = super().connect()
        conn.set_trace_callback(self.statements.append)
        return conn


class ExperimentSummaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CountingStateStore(
            db_path=Path(self.tmp.name) / "state.sqlite"
        )
        self.research = Research(store=self.store, advances=WorkspaceAdvances(store=self.store), artifacts=Mock(), workflows=Workflows(store=self.store))
        self.experiments = self.research.experiments
        self.one_ids = self._seed("proj_one", 1)
        self.many_ids = self._seed("proj_many", 25)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed(self, project_id: str, count: int) -> list[str]:
        experiments: list[tuple[str, str]] = []
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
                (project_id, project_id, "2026-07-21T00:00:00Z"),
            )
            for index in range(count):
                experiment_id = f"exp_{project_id}_{count - index:02d}"
                created_at = f"2026-07-21T00:{index // 3:02d}:00Z"
                experiments.append((experiment_id, created_at))
                conn.execute(
                    """
                    INSERT INTO experiments
                      (id, project_id, name, intent, status, attempt_index,
                       created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'planned', 1, ?, ?)
                    """,
                    (
                        experiment_id,
                        project_id,
                        f"Experiment {index}",
                        f"Intent {index}",
                        created_at,
                        created_at,
                    ),
                )
        return [
            experiment_id
            for experiment_id, _created_at in sorted(
                experiments, key=lambda item: (item[1], item[0])
            )
        ]

    def _summary_selects(self, *, project_id: str) -> tuple[list[dict], list[str]]:
        self.store.statements.clear()
        with patch.object(
            self.experiments,
            "get_state",
            side_effect=AssertionError("summary read hydrated rich experiment state"),
        ):
            rows = self.research.experiments.list_experiment_summaries(project_id=project_id)
        selects = [
            statement
            for statement in self.store.statements
            if statement.lstrip().upper().startswith(("SELECT", "WITH"))
        ]
        return rows, selects

    def test_one_and_twenty_five_summaries_each_use_two_selects(self) -> None:
        for project_id, expected_ids in (
            ("proj_one", self.one_ids),
            ("proj_many", self.many_ids),
        ):
            with self.subTest(project_id=project_id):
                rows, selects = self._summary_selects(project_id=project_id)

                self.assertEqual([row["id"] for row in rows], expected_ids)
                self.assertEqual(len(selects), 2)
                self.assertEqual(
                    list(rows[0]),
                    [
                        "id",
                        "project_id",
                        "name",
                        "intent",
                        "status",
                        "attempt_index",
                        "created_at",
                        "updated_at",
                    ],
                )
                self.assertFalse(
                    any(
                        table in statement.lower()
                        for statement in selects
                        for table in (
                            " claims",
                            " experiment_claims",
                            " resources",
                            " resource_associations",
                            " reviews",
                            " review_requests",
                            " reflections",
                        )
                    )
                )

    def test_missing_project_preserves_research_not_found_semantics(self) -> None:
        self.store.statements.clear()

        with self.assertRaisesRegex(ValidationError, "project_id is required"):
            self.research.experiments.list_experiment_summaries(project_id=None)
        with self.assertRaisesRegex(NotFoundError, "project not found: proj_missing"):
            self.research.experiments.list_experiment_summaries(project_id="proj_missing")

        self.assertFalse(
            any("FROM experiments" in statement for statement in self.store.statements)
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
