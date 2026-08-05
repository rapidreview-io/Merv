"""Project candidate lifecycle, durability, and champion CAS behavior."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError as PydanticValidationError

from merv.brain.kernel.utils import ValidationError
from merv.brain.surface.tools.contracts import CandidateSubmitInput
from tests.support.brain import TestBrain


class CandidateLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call(
            "project", action="create", name="Candidate lifecycle"
        )["id"]
        self.experiment_id = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="candidate-source",
            intent="Produce and compare a project candidate.",
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def call(self, tool: str, **arguments):
        return self.app.call_tool(tool, arguments)

    def submit_workspace(self, *, key: str, expected_sha256: str = ""):
        return self.call(
            "candidate.submit",
            project_id=self.project_id,
            name=f"Workspace {key}",
            source_kind="experiment_workspace",
            source_ref=self.experiment_id,
            expected_sha256=expected_sha256,
            metrics={"score": 0.8},
            primary_metric="score",
            higher_is_better=True,
            validation_summary="Measured against the current development slice.",
            idempotency_key=key,
        )

    def test_workspace_requires_durable_staging_before_cas_promotion(self) -> None:
        digest = "a" * 64
        submitted = self.submit_workspace(key="workspace-1", expected_sha256=digest)
        candidate_id = submitted["candidate"]["id"]
        self.assertFalse(submitted["candidate"]["staged"])
        self.assertFalse(submitted["candidate"]["validated"])

        with self.assertRaises(ValidationError):
            self.call(
                "candidate.promote",
                project_id=self.project_id,
                candidate_id=candidate_id,
                expected_champion_id="",
                reason="This is the strongest measured candidate so far.",
            )
        with self.assertRaises(ValidationError):
            self.call(
                "candidate.stage",
                project_id=self.project_id,
                candidate_id=candidate_id,
                stage_kind="evaluator_receipt",
                stage_ref="receipt-1",
                content_sha256="b" * 64,
                manifest_sha256="c" * 64,
            )

        staged = self.call(
            "candidate.stage",
            project_id=self.project_id,
            candidate_id=candidate_id,
            stage_kind="evaluator_receipt",
            stage_ref="receipt-1",
            content_sha256=digest,
            manifest_sha256="c" * 64,
        )
        self.assertTrue(staged["candidate"]["staged"])
        self.assertFalse(staged["candidate"]["validated"])
        self.assertTrue(
            self.call(
                "candidate.stage",
                project_id=self.project_id,
                candidate_id=candidate_id,
                stage_kind="evaluator_receipt",
                stage_ref="receipt-1",
                content_sha256=digest,
                manifest_sha256="c" * 64,
            )["idempotent"]
        )

        promoted = self.call(
            "candidate.promote",
            project_id=self.project_id,
            candidate_id=candidate_id,
            expected_champion_id="",
            reason="This beats the current empty baseline on the agreed score.",
        )
        self.assertTrue(promoted["promoted"])
        self.assertTrue(promoted["champion"]["validated"])
        unchanged = self.call(
            "candidate.promote",
            project_id=self.project_id,
            candidate_id=candidate_id,
            expected_champion_id=candidate_id,
            reason="The same candidate remains champion after an idempotent retry.",
        )
        self.assertFalse(unchanged["promoted"])
        self.assertTrue(unchanged["champion"]["validated"])
        listed = self.call("candidate.list", project_id=self.project_id)
        self.assertEqual(listed["champion_id"], candidate_id)
        self.assertEqual(len(listed["promotions"]), 1)

    def test_artifact_source_is_resolved_and_stale_promotion_is_rejected(self) -> None:
        artifact_id = self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role="plan",
            path="candidate.md",
            body="A durable candidate description.",
        )["artifact_id"]
        direct = self.call(
            "candidate.submit",
            project_id=self.project_id,
            name="Artifact candidate",
            source_kind="artifact",
            source_ref=artifact_id,
            metrics={"score": 0.7},
            primary_metric="score",
            higher_is_better=True,
            validation_summary="Measured against the current development slice.",
            idempotency_key="artifact-1",
        )
        candidate_id = direct["candidate"]["id"]
        self.assertTrue(direct["candidate"]["staged"])
        self.assertEqual(
            direct["candidate"]["source_experiment_id"], self.experiment_id
        )
        self.call(
            "candidate.promote",
            project_id=self.project_id,
            candidate_id=candidate_id,
            expected_champion_id="",
            reason="This is the first durable candidate and establishes the baseline.",
        )

        second_id = self.submit_workspace(key="workspace-2")["candidate"]["id"]
        self.call(
            "candidate.stage",
            project_id=self.project_id,
            candidate_id=second_id,
            stage_kind="evaluator_receipt",
            stage_ref="receipt-2",
            content_sha256="d" * 64,
            manifest_sha256="e" * 64,
        )
        with self.assertRaises(ValidationError) as stale:
            self.call(
                "candidate.promote",
                project_id=self.project_id,
                candidate_id=second_id,
                expected_champion_id="",
                reason="This candidate appears stronger but used a stale champion read.",
            )
        self.assertEqual(
            stale.exception.details["actual_champion_id"], candidate_id
        )

    def test_submission_is_idempotent_and_paths_are_not_contract_fields(self) -> None:
        first = self.submit_workspace(key="same-request")
        retry = self.submit_workspace(key="same-request")
        self.assertEqual(first["candidate"]["id"], retry["candidate"]["id"])
        self.assertTrue(retry["idempotent"])
        with self.assertRaises(ValidationError):
            self.call(
                "candidate.submit",
                project_id=self.project_id,
                name="Changed request",
                source_kind="experiment_workspace",
                source_ref=self.experiment_id,
                metrics={"score": 0.9},
                primary_metric="score",
                higher_is_better=True,
                validation_summary="A different request with the same retry key.",
                idempotency_key="same-request",
            )
        with self.assertRaises(PydanticValidationError):
            CandidateSubmitInput.model_validate(
                {
                    "project_id": self.project_id,
                    "name": "Unsafe path",
                    "source_kind": "experiment_workspace",
                    "source_ref": self.experiment_id,
                    "path": "/tmp/candidate.bin",
                    "metrics": {"score": 1.0},
                    "primary_metric": "score",
                    "validation_summary": "Caller paths must remain evaluator-owned.",
                    "idempotency_key": "unsafe",
                }
            )


if __name__ == "__main__":
    unittest.main()
