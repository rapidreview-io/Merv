"""The agent-facing `workflow.status_and_next` tool returns a slim projection;
the service method still returns the full shape the UI depends on."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend


class WorkflowSlimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.backend = FakeSandboxBackend()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=self.backend,
        )
        self.project_id = self.call("project", action="create", name="Slim Project")[
            "id"
        ]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, tool: str, **kwargs):
        return self.app.call_tool(tool, kwargs)

    def _set_status(self, exp_id: str, status: str) -> None:
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = ? WHERE id = ?", (status, exp_id)
            )

    def _seed_review(
        self, *, exp_id: str, review_id: str, seq: int, **overrides
    ) -> None:
        """Write a review row directly (FK off) with bookkeeping + findings."""
        import json
        import sqlite3

        raw = sqlite3.connect(self.repo / ".research_plugin" / "state.sqlite")
        raw.execute("PRAGMA foreign_keys=OFF")
        cols = [r[1] for r in raw.execute("PRAGMA table_info(reviews)").fetchall()]
        vals = {
            "id": review_id,
            "project_id": self.project_id,
            "target_type": "experiment",
            "target_id": exp_id,
            "role": "experiment_reviewer",
            "verdict": "pass",
            "status": "submitted",
            "findings_json": json.dumps([{"issue": "narrow", "severity": "low"}]),
            "evidence_json": json.dumps({"exit_code": 0}),
            "notes": "looks good",
            "synopsis": f"synopsis for {review_id}",
            "target_snapshot_id": "experiment|" + "x" * 500,
            "created_at": "2026-06-03T04:41:27Z",
            "request_id": "rr_x",
            "session_id": "rvs_x",
            "created_seq": seq,
            **overrides,
        }
        present = {k: v for k, v in vals.items() if k in cols}
        raw.execute(
            f"INSERT INTO reviews ({','.join(present)}) VALUES ({','.join('?' for _ in present)})",
            list(present.values()),
        )
        raw.commit()
        raw.close()

    def _experiment_with_plan(self) -> str:
        exp_id = self.call(
            "experiment.create",
            name="the-thing",
            project_id=self.project_id,
            intent="Do the thing on the staged subset.\n\nTitle: The Thing",
        )["id"]
        self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body="## Summary\nTest the staged subset before scaling up.\n",
        )
        return exp_id

    def test_experiment_scope_is_slim(self) -> None:
        exp_id = self._experiment_with_plan()
        slim = self.call(
            "workflow.status_and_next", project_id=self.project_id, experiment_id=exp_id
        )

        self.assertEqual(slim["scope"], "experiment")
        self.assertIn("current_gate", slim["workflow"])

        context = slim["context"]
        self.assertEqual(set(context), {"experiment", "plan", "report", "artifacts"})
        exp = context["experiment"]
        self.assertEqual(exp["name"], "the-thing")
        self.assertNotIn("attempt_index", exp)
        self.assertNotIn("conclusion", exp)
        self.assertEqual(exp["tested_claims"], [])

        plan = context["plan"]
        self.assertEqual(plan["status"], "submitted")
        self.assertEqual(plan["attempt_index"], 1)
        self.assertIn("## Summary", plan["content"])
        self.assertNotIn("summary", plan)
        self.assertTrue(plan["submitted_at"])
        self.assertEqual(context["report"], {"status": "missing"})
        self.assertEqual(context["artifacts"], [])

        # Project block is a bare reference — no other experiments' intents.
        self.assertEqual(set(slim["project"]), {"id", "name"})

        # No sandbox yet → explicitly says so.
        self.assertFalse(slim["sandbox"]["active"])
        self.assertIn("note", slim["sandbox"])

    def test_review_history_is_not_dumped_into_experiment_context(self) -> None:
        exp_id = self._experiment_with_plan()
        self._seed_review(
            exp_id=exp_id, review_id="rev_1", seq=1, created_at="2026-06-01T00:00:00Z"
        )
        self._seed_review(
            exp_id=exp_id, review_id="rev_2", seq=2, created_at="2026-06-03T00:00:00Z"
        )

        slim = self.call(
            "workflow.status_and_next", project_id=self.project_id, experiment_id=exp_id
        )
        context = slim["context"]

        self.assertNotIn("reviews", context)
        self.assertNotIn("reviews", context["experiment"])

    def test_terminal_context_summarizes_plan_and_keeps_full_report(self) -> None:
        exp_id = self._experiment_with_plan()
        report = self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="report",
            path="report.md",
            body=(
                "## Summary\nThe candidate passed.\n\n"
                "## Results\nAccuracy improved.\n\n"
                "## Deviations from plan\nNone.\n\n"
                "## Conclusion\nSupport the claim.\n"
            ),
        )
        result = self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="result",
            path="results/results.json",
            body='{"summary": "Accuracy improved by two points."}\n',
        )
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE experiments SET status = 'complete', conclusion = ? WHERE id = ?",
                ("The candidate passed the registered threshold.", exp_id),
            )

        context = self.call(
            "workflow.status_and_next",
            project_id=self.project_id,
            experiment_id=exp_id,
        )["context"]

        self.assertEqual(
            context["experiment"]["conclusion"],
            "The candidate passed the registered threshold.",
        )
        self.assertEqual(
            context["plan"]["summary"],
            "Test the staged subset before scaling up.",
        )
        self.assertNotIn("content", context["plan"])
        self.assertEqual(context["plan"]["status"], "approved")
        self.assertEqual(context["report"]["id"], report["artifact_id"])
        self.assertIn("## Results", context["report"]["content"])
        self.assertNotIn("summary", context["report"])
        self.assertTrue(context["report"]["submitted_at"])
        self.assertEqual(
            context["artifacts"],
            [
                {
                    "descriptor": "result",
                    "id": result["artifact_id"],
                    "path": "results/results.json",
                    "submitted_at": context["artifacts"][0]["submitted_at"],
                }
            ],
        )
        self.assertTrue(context["artifacts"][0]["submitted_at"])

    def test_active_sandbox_is_summarized(self) -> None:
        exp_id = self._experiment_with_plan()
        self._set_status(exp_id, "ready_to_run")
        self.call(
            "sandbox.request",
            project_id=self.project_id,
            experiment_id=exp_id,
            gpu="A100",
        )

        slim = self.call(
            "workflow.status_and_next", project_id=self.project_id, experiment_id=exp_id
        )
        sandbox = slim["sandbox"]
        self.assertTrue(sandbox["active"])
        self.assertTrue(sandbox["sandbox_id"])
        self.assertTrue(sandbox["ssh_host"])
        self.assertEqual(sandbox["status"], "running")
        # SSH key material / raw command are NOT here — that's sandbox.request's job.
        self.assertNotIn("key_path", sandbox)

    def test_project_scope_is_compact(self) -> None:
        # With no experiment yet, the tool orients at the project level
        # (`_resolve_scope` only auto-picks an experiment once one exists).
        self.call(
            "claim.create", project_id=self.project_id, statement="Bigger batches help."
        )
        slim = self.call("workflow.status_and_next", project_id=self.project_id)

        self.assertEqual(slim["scope"], "project")
        self.assertIsNone(slim["experiment"])
        self.assertEqual(
            set(slim["context"]),
            {
                "project",
                "reflection",
                "literature",
                "claims",
                "candidates",
                "experiments",
            },
        )
        self.assertEqual(slim["workflow"]["current_gate"], "project_setup")
        claim = slim["context"]["claims"][0]
        self.assertEqual(
            set(claim), {"id", "statement", "scope", "status", "confidence"}
        )

    def test_service_method_keeps_full_shape_for_ui(self) -> None:
        exp_id = self._experiment_with_plan()
        full = self.app.application.status(
            project_id=self.project_id, experiment_id=exp_id
        )
        # The UI path still gets the rich shape: the all-attempts artifact
        # list with full metadata, and the project-wide experiment list.
        self.assertIn("artifacts", full["experiment"])
        self.assertIn(
            "content_type", full["experiment"]["current_attempt_artifacts"][0]
        )
        self.assertIn("active_experiments", full["project"])


if __name__ == "__main__":
    unittest.main()
