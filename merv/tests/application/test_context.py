"""Project context assembly and batching."""

from __future__ import annotations

from dataclasses import replace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from merv.brain.application.project_context import ProjectContextQuery
from merv.brain.artifacts import Artifact
from merv.brain.kernel.state.store import StateStore
from merv.brain.research_core import Research
from tests.support.brain import TestBrain


def artifact(
    *,
    artifact_id: str,
    target_id: str,
    role: str,
    attempt_index: int,
    tldr: str,
) -> Artifact:
    return Artifact(
        id=artifact_id,
        project_id="proj_1",
        target_type=("reflection" if target_id.startswith("syn_") else "experiment"),
        target_id=target_id,
        role=role,
        attempt_index=attempt_index,
        lens_id="",
        path=f"{target_id}/{role}.md",
        title="",
        sha256=f"sha-{artifact_id}",
        size_bytes=10,
        content_type="text/markdown",
        status="complete",
        created_by="agent",
        created_at="2026-07-27T10:00:00Z",
        updated_at="2026-07-27T11:00:00Z",
        order=1,
        tldr=tldr,
    )


class ProjectContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.research = Mock()
        self.artifacts = Mock()
        self.query = ProjectContextQuery(
            research=self.research, artifacts=self.artifacts
        )
        self.research.project_context_facts.return_value = {
            "project": {
                "id": "proj_1",
                "name": "Project",
                "summary": "Test retrieval improvements.",
            },
            "claims": [
                {
                    "id": "claim_1",
                    "statement": "Reranking helps.",
                    "scope": "retrieval",
                    "status": "abandoned",
                    "confidence": "low",
                }
            ],
            "experiments": [
                {
                    "id": "exp_live",
                    "name": "Live",
                    "intent": "Test the new ranker.",
                    "status": "running",
                    "attempt_index": 2,
                    "conclusion": "",
                    "updated_at": "2026-07-27T12:00:00Z",
                    "tested_claim_ids": ["claim_1"],
                },
                {
                    "id": "exp_done",
                    "name": "Done",
                    "intent": "Measure candidate recall.",
                    "status": "complete",
                    "attempt_index": 1,
                    "conclusion": "Recall improved.",
                    "updated_at": "2026-07-26T12:00:00Z",
                    "tested_claim_ids": [],
                },
                {
                    "id": "exp_legacy",
                    "name": "Legacy",
                    "intent": "Legacy intent fallback.",
                    "status": "failed",
                    "attempt_index": 3,
                    "conclusion": "The run exhausted memory.",
                    "updated_at": "2026-07-25T12:00:00Z",
                    "tested_claim_ids": [],
                },
            ],
            "latest_published_reflection": {
                "id": "syn_1",
                "title": "Published synthesis",
                "status": "published",
                "attempt_index": 1,
                "published_at": "2026-07-24T12:00:00Z",
                "updated_at": "2026-07-24T12:00:00Z",
            },
            "open_reflection": {
                "id": "syn_open",
                "title": "Unpublished work",
                "status": "reflecting",
                "attempt_index": 2,
                "updated_at": "2026-07-27T09:00:00Z",
            },
            "literature_summary": {
                "id": "lit_summary",
                "tldr": "Reranking dominates candidate expansion.",
                "body": "Longer literature body.",
                "updated_at": "2026-07-27T08:00:00Z",
            },
            "paper_count": 18,
        }
        experiment_evidence = (
            artifact(
                artifact_id="art_plan",
                target_id="exp_live",
                role="plan",
                attempt_index=2,
                tldr="Run the bounded reranking comparison.",
            ),
            artifact(
                artifact_id="art_rejected_report",
                target_id="exp_live",
                role="report",
                attempt_index=2,
                tldr="Rejected report must not drive a running experiment.",
            ),
            artifact(
                artifact_id="art_report",
                target_id="exp_done",
                role="report",
                attempt_index=1,
                tldr="Candidate recall improved by five points.",
            ),
        )
        reflection_evidence = (
            artifact(
                artifact_id="art_reflection",
                target_id="syn_1",
                role="reflection_doc",
                attempt_index=1,
                tldr="Ranking quality is now the primary bottleneck.",
            ),
            artifact(
                artifact_id="art_graph",
                target_id="syn_1",
                role="project_graph",
                attempt_index=1,
                tldr="Graph summary is not the reflection summary.",
            ),
        )
        evidence_by_id = {
            item.id: item for item in experiment_evidence + reflection_evidence
        }
        self.artifacts.scan.side_effect = lambda **kwargs: (
            experiment_evidence
            if kwargs["target_type"] == "experiment"
            else reflection_evidence
        )
        self.artifacts.get.side_effect = lambda **kwargs: tuple(
            replace(
                evidence_by_id[artifact_id],
                data=("# Summary\n" f"{evidence_by_id[artifact_id].tldr}").encode(),
            )
            for artifact_id in kwargs["artifact_ids"]
            if artifact_id in evidence_by_id
        )

    def test_builds_the_project_macro_packet(self) -> None:
        result = self.query.build(project_id="proj_1")

        self.assertEqual(
            list(result),
            [
                "project",
                "reflection",
                "literature",
                "claims",
                "candidates",
                "experiments",
                "tasks",
            ],
        )
        self.assertEqual(result["tasks"], [])
        self.assertEqual(result["claims"][0]["status"], "abandoned")
        summaries = {row["id"]: row["summary"] for row in result["experiments"]}
        self.assertEqual(
            summaries,
            {
                "exp_live": "Run the bounded reranking comparison.",
                "exp_done": "Candidate recall improved by five points.",
                "exp_legacy": "The run exhausted memory.",
            },
        )
        self.assertEqual(result["experiments"][0]["tested_claim_ids"], ["claim_1"])
        published = result["reflection"]["latest_published"]
        self.assertEqual(
            published["summary"],
            "Ranking quality is now the primary bottleneck.",
        )
        self.assertEqual(
            [row["descriptor"] for row in published["artifacts"]],
            ["reflection document", "project graph"],
        )
        self.assertTrue(all(row["submitted_at"] for row in published["artifacts"]))
        self.assertEqual(
            result["reflection"]["open_wave"],
            {
                "id": "syn_open",
                "title": "Unpublished work",
                "status": "reflecting",
                "updated_at": "2026-07-27T09:00:00Z",
            },
        )
        self.assertNotIn("summary", result["reflection"]["open_wave"])
        self.assertEqual(
            result["literature"],
            {
                "summary": "Reranking dominates candidate expansion.",
                "paper_count": 18,
                "updated_at": "2026-07-27T08:00:00Z",
            },
        )

    def test_requests_summaries_only_for_meaningful_current_artifacts(self) -> None:
        self.query.build(project_id="proj_1")

        experiment_call, reflection_call = (
            call.kwargs for call in self.artifacts.scan.call_args_list
        )
        self.assertEqual(experiment_call["roles"], ("plan", "report"))
        self.assertEqual(
            experiment_call["target_ids"],
            ("exp_live", "exp_done", "exp_legacy"),
        )
        self.assertEqual(reflection_call["roles"], ("reflection_doc", "project_graph"))
        self.assertEqual(reflection_call["target_ids"], ("syn_1",))
        hydration = self.artifacts.get.call_args.kwargs
        self.assertEqual(
            hydration["artifact_ids"],
            (
                "art_plan",
                "art_rejected_report",
                "art_report",
                "art_reflection",
                "art_graph",
            ),
        )
        self.assertEqual(hydration["include"], "content")

    def test_forbidden_rich_state_is_absent(self) -> None:
        result = self.query.build(project_id="proj_1")

        forbidden = {
            "artifacts",
            "reviews",
            "workflow",
            "gate_checklist",
            "allowed_transitions",
            "sandboxes",
            "attempt_index",
            "content",
        }
        for experiment in result["experiments"]:
            self.assertTrue(forbidden.isdisjoint(experiment))


class ProjectContextFactsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        self.research = Research(store=self.store, artifacts=Mock())

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


class CountingStateStore(StateStore):
    def __init__(self, *, db_path: Path) -> None:
        self.statements: list[str] = []
        super().__init__(db_path=db_path)

    def connect(self):
        conn = super().connect()
        conn.set_trace_callback(self.statements.append)
        return conn


class ProjectContextBatchingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "state.sqlite"
        self.store = CountingStateStore(db_path=path)
        self.app = TestBrain(
            repo_root=Path(self.tmp.name),
            db_path=path,
            store=self.store,
        )

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _seed(self, *, project_id: str, count: int) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, created_at)
                VALUES (?, ?, '', ?)
                """,
                (project_id, project_id, "2026-07-27T00:00:00Z"),
            )
            for index in range(count):
                experiment_id = f"exp_{project_id}_{index:03d}"
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
                        "2026-07-27T01:00:00Z",
                        "2026-07-27T01:00:00Z",
                    ),
                )

    def _select_count(self, *, project_id: str) -> int:
        self.store.statements.clear()
        self.app.application.project_context(project_id=project_id)
        return sum(
            statement.lstrip().upper().startswith(("SELECT", "WITH"))
            for statement in self.store.statements
        )

    def test_query_count_is_constant_for_one_or_twenty_five_experiments(
        self,
    ) -> None:
        self._seed(project_id="proj_one", count=1)
        self._seed(project_id="proj_many", count=25)

        self.assertEqual(
            self._select_count(project_id="proj_one"),
            self._select_count(project_id="proj_many"),
        )

    def test_only_plan_and_report_bytes_are_summarized(self) -> None:
        self._seed(project_id="proj_roles", count=1)
        experiment_id = "exp_proj_roles_000"
        with self.store.transaction() as conn:
            for sequence, role in enumerate(
                ("plan", "report", "result", "metrics"), start=1
            ):
                conn.execute(
                    """
                    INSERT INTO artifacts
                      (id, project_id, target_type, target_id, role,
                       attempt_index, lens_id, path, title, content_sha256,
                       size_bytes, content_type, status, upload_token,
                       created_by, created_at, updated_at, created_seq)
                    VALUES (?, 'proj_roles', 'experiment', ?, ?, 1, '', ?,
                            '', '', 0, 'text/markdown', 'complete', '',
                            'agent', ?, ?, ?)
                    """,
                    (
                        f"art_{role}",
                        experiment_id,
                        role,
                        f"{role}.md",
                        "2026-07-27T02:00:00Z",
                        "2026-07-27T02:00:00Z",
                        sequence,
                    ),
                )
        original = self.app.artifacts.get
        hydrated_ids: list[str] = []

        def record_get(**kwargs):
            hydrated_ids.extend(kwargs["artifact_ids"])
            return original(**kwargs)

        self.app.artifacts.get = record_get
        try:
            self.app.application.project_context(project_id="proj_roles")
        finally:
            self.app.artifacts.get = original

        self.assertCountEqual(hydrated_ids, ["art_plan", "art_report"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
