"""The agent-facing experiment.get_state / experiment.list tools return a
slim projection (detail kept, waste dropped); the service methods stay full."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from merv.brain.kernel.utils import ValidationError
from tests.support.infrastructure import FakeInfrastructureClient

SLIM_ARTIFACT_KEYS = {
    "id",
    "role",
    "path",
    "lens_id",
    "size_bytes",
    "title",
    "tldr",
}
WASTE_ARTIFACT_KEYS = {
    "content_sha256",
    "content_type",
    "created_by",
    "created_at",
    "updated_at",
    "project_id",
    "attempt_index",
    "submitted_order",
}
WASTE_REVIEW_KEYS = {
    "target_snapshot_id",
    "request_id",
    "session_id",
    "target_id",
    "target_type",
    "project_id",
}


class ExperimentSlimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.project_id = self.call("project", action="create", name="Slim get_state")[
            "id"
        ]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, tool: str, **kwargs):
        return self.app.call_tool(tool, kwargs)

    def _experiment_with_artifacts(self) -> str:
        exp_id = self.call(
            "experiment.create",
            name="reve-small",
            project_id=self.project_id,
            intent="Train REVE-Small.\n\nTitle: REVE-Small",
        )["id"]
        for path, role, body in [
            (
                "experiments/004/plan.md",
                "plan",
                "## Summary\nCompare REVE-Small with the baseline.\n",
            ),
            (
                "experiments/004/report.md",
                "report",
                "## Summary\nREVE-Small improved over the baseline.\n",
            ),
            (
                "experiments/004/results/status.json",
                "result",
                '{"summary": "The run completed successfully."}\n',
            ),
        ]:
            self.app.submit_artifact(
                project_id=self.project_id,
                target_type="experiment",
                target_id=exp_id,
                role=role,
                path=path,
                body=body,
            )
        return exp_id

    def test_create_returns_folder_without_mkdir(self) -> None:
        created = self.call(
            "experiment.create",
            name="folder-test",
            project_id=self.project_id,
            intent="Create the experiment folder.",
        )

        self.assertTrue(created["id"])
        self.assertEqual(created["folder"], "experiments/folder-test/")
        self.assertEqual(created["next"]["role"], "plan")
        self.assertFalse((self.repo / "experiments" / "folder-test").exists())

    def test_get_state_tool_is_slim(self) -> None:
        exp_id = self._experiment_with_artifacts()
        slim = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id
        )

        # The duplicate all-attempts `resources` list is gone.
        self.assertNotIn("artifacts", slim)
        self.assertIn("current_attempt_artifacts", slim)
        res = slim["current_attempt_artifacts"][0]
        self.assertEqual(set(res), SLIM_ARTIFACT_KEYS)
        self.assertEqual(WASTE_ARTIFACT_KEYS & set(res), set())
        self.assertEqual(res["tldr"], "Compare REVE-Small with the baseline.")
        # Detail that get_state exists for is preserved.
        self.assertIn("intent", slim)
        self.assertIn("conclusion", slim)
        self.assertIn("gate_checklist", slim)
        self.assertEqual(slim["storage_objects"], [])
        self.assertEqual(
            {"id", "statement", "confidence", "status", "scope"},
            (
                set(slim["tested_claims"][0])
                if slim["tested_claims"]
                else {"id", "statement", "confidence", "status", "scope"}
            ),
        )
        # Single-attempt experiment: no prior-attempt block.
        self.assertNotIn("prior_attempt_artifacts", slim)

    def _seed_review(
        self, *, exp_id: str, review_id: str, seq: int, **overrides
    ) -> None:
        """Write a review row directly (FK off) with bookkeeping + findings."""
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

    def test_get_state_review_list_is_synopsis_only(self) -> None:
        exp_id = self._experiment_with_artifacts()
        self._seed_review(exp_id=exp_id, review_id="rev_1", seq=1)

        slim = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id
        )
        review = slim["reviews"][0]
        self.assertEqual(review["verdict"], "pass")
        self.assertEqual(review["synopsis"], "looks good")
        self.assertNotIn("findings", review)
        self.assertNotIn("notes", review)
        self.assertNotIn("evidence", review)
        self.assertEqual(WASTE_REVIEW_KEYS & set(review), set())  # bookkeeping dropped

    def test_get_state_older_rounds_arrive_as_tldrs(self) -> None:
        exp_id = self._experiment_with_artifacts()
        self._seed_review(
            exp_id=exp_id,
            review_id="rev_1",
            seq=1,
            created_at="2026-06-01T00:00:00Z",
            verdict="needs_changes",
            return_to="planned",
            synopsis="",
            notes="The first pass never separated the arms.\nlong prose follows",
        )
        self._seed_review(
            exp_id=exp_id,
            review_id="rev_2",
            seq=2,
            created_at="2026-06-03T00:00:00Z",
            synopsis="The rerun clears the baseline, so the attempt stands.",
        )

        reviews = self.call(
            "experiment.get_state", project_id=self.project_id, experiment_id=exp_id
        )["reviews"]

        self.assertEqual([review["id"] for review in reviews], ["rev_2", "rev_1"])
        self.assertEqual(
            set(reviews[0]), {"id", "role", "verdict", "created_at", "synopsis"}
        )
        self.assertEqual(
            set(reviews[1]), {"id", "role", "verdict", "created_at", "synopsis"}
        )
        self.assertEqual(
            reviews[1]["synopsis"], "The first pass never separated the arms."
        )

    def test_get_state_review_id_reads_an_older_body_back(self) -> None:
        exp_id = self._experiment_with_artifacts()
        self._seed_review(
            exp_id=exp_id,
            review_id="rev_1",
            seq=1,
            created_at="2026-06-01T00:00:00Z",
            verdict="needs_changes",
            return_to="planned",
            notes="the arms overlap",
            findings_json=json.dumps([{"issue": "confounded", "severity": "high"}]),
        )
        self._seed_review(
            exp_id=exp_id, review_id="rev_2", seq=2, created_at="2026-06-03T00:00:00Z"
        )

        state = self.call(
            "experiment.get_state",
            project_id=self.project_id,
            experiment_id=exp_id,
            review_id="rev_1",
        )

        self.assertEqual(state["review"]["id"], "rev_1")
        self.assertEqual(state["review"]["notes"], "the arms overlap")
        self.assertEqual(state["review"]["findings"][0]["issue"], "confounded")
        self.assertEqual(state["review"]["evidence"], {"exit_code": 0})
        self.assertEqual(state["review"]["return_to"], "planned")
        # The list itself stays on its diet.
        self.assertNotIn("notes", state["reviews"][1])

    def test_get_state_unknown_review_id_names_the_ids_that_exist(self) -> None:
        exp_id = self._experiment_with_artifacts()
        self._seed_review(exp_id=exp_id, review_id="rev_1", seq=1)

        with self.assertRaises(ValidationError) as ctx:
            self.call(
                "experiment.get_state",
                project_id=self.project_id,
                experiment_id=exp_id,
                review_id="rev_nope",
            )

        self.assertIn("rev_nope", str(ctx.exception))
        self.assertIn("rev_1", str(ctx.exception))

    def test_list_tool_is_slim(self) -> None:
        self._experiment_with_artifacts()
        listed = self.call("experiment.list", project_id=self.project_id)["experiments"]
        self.assertNotIn("artifacts", listed[0])
        self.assertEqual(
            set(listed[0]["current_attempt_artifacts"][0]), SLIM_ARTIFACT_KEYS
        )

    def test_transition_returns_a_receipt_without_experiment_context(self) -> None:
        exp_id = self.call(
            "experiment.create",
            name="transition-tldr",
            project_id=self.project_id,
            intent="Exercise the transition projection.",
        )["id"]
        self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="experiments/transition-tldr/plan.md",
            body=(
                "## Summary\nCompare the candidate with the baseline.\n\n"
                "## Objective & hypothesis\nThe candidate should improve accuracy.\n\n"
                "## Evaluation\nCompare accuracy; pass if it exceeds baseline.\n"
            ),
        )

        transitioned = self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_design",
        )

        self.assertEqual(transitioned["from_status"], "planned")
        self.assertEqual(transitioned["to_status"], "design_review")
        self.assertEqual(transitioned["status"], "design_review")
        self.assertEqual(transitioned["attempt_index"], 1)
        self.assertIsInstance(transitioned["event_id"], int)
        self.assertTrue(transitioned["accepted_at"])
        self.assertNotIn("current_attempt_artifacts", transitioned)
        self.assertNotIn("allowed_transitions", transitioned)
        self.assertNotIn("gate_checklist", transitioned)

    def test_service_method_keeps_full_shape_for_ui(self) -> None:
        exp_id = self._experiment_with_artifacts()
        full = self.app.experiments.get_state(
            experiment_id=exp_id, project_id=self.project_id
        )
        self.assertTrue(full.artifacts)
        self.assertIn("content_type", full.current_attempt_artifacts[0])


if __name__ == "__main__":
    unittest.main()
