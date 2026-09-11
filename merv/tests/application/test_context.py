"""Explicit record inventory remains complete when shared orientation is synthesized."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from merv.brain.programs import INSTALLED, PROGRAM
from merv.brain.workflows import Workflows
from merv.brain.agent_sessions import WorkspaceAdvances
from merv.brain.kernel.state.store import StateStore
from merv.brain.research_core import Research


class ProjectContextFactsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        self.research = Research(store=self.store, advances=WorkspaceAdvances(store=self.store), artifacts=Mock(), workflows=Workflows(store=self.store, programs=INSTALLED), program=PROGRAM)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_reads_every_claim_and_experiment_with_claim_links(self) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, created_at)
                VALUES ('proj_context', 'Context', 'Macro view', ?)
                """,
                ("2026-07-27T00:00:00Z",),
            )
            for claim_id, status in (
                ("claim_active", "active"),
                ("claim_abandoned", "abandoned"),
            ):
                conn.execute(
                    """
                    INSERT INTO claims
                      (id, project_id, statement, status, confidence, created_at)
                    VALUES (?, 'proj_context', ?, ?, 'medium', ?)
                    """,
                    (
                        claim_id,
                        claim_id,
                        status,
                        "2026-07-27T01:00:00Z",
                    ),
                )
            for experiment_id, status in (
                ("exp_live", "running"),
                ("exp_done", "complete"),
            ):
                conn.execute(
                    """
                    INSERT INTO experiments
                      (id, project_id, name, intent, status, attempt_index,
                       conclusion, created_at, updated_at)
                    VALUES (?, 'proj_context', ?, ?, ?, 1, ?, ?, ?)
                    """,
                    (
                        experiment_id,
                        experiment_id,
                        f"Intent {experiment_id}",
                        status,
                        f"Conclusion {experiment_id}",
                        "2026-07-27T02:00:00Z",
                        "2026-07-27T03:00:00Z",
                    ),
                )
            conn.execute(
                """
                INSERT INTO experiment_claims (experiment_id, claim_id)
                VALUES ('exp_live', 'claim_abandoned')
                """
            )

        result = self.research.project_context_facts(project_id="proj_context")

        self.assertCountEqual(
            [claim["status"] for claim in result["claims"]],
            ["active", "abandoned"],
        )
        self.assertEqual(
            [experiment["id"] for experiment in result["experiments"]],
            ["exp_done", "exp_live"],
        )
        by_id = {experiment["id"]: experiment for experiment in result["experiments"]}
        self.assertEqual(by_id["exp_live"]["tested_claim_ids"], ["claim_abandoned"])
        self.assertEqual(by_id["exp_done"]["tested_claim_ids"], [])
