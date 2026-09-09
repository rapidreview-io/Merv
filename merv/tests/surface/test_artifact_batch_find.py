"""Focused contract tests for artifact.read id batches and content opt-in."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError as PydanticValidationError

from merv.brain.kernel.utils import NotFoundError
from merv.brain.surface.tools.contracts import (
    ArtifactReadInput,
    ExperimentGetStateInput,
)
from tests.support.brain import TestBrain


class ArtifactBatchReadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.app.call_tool(
            "project", {"action": "create", "name": "Artifact batch retrieval"}
        )["id"]
        self.experiment_id = self.app.call_tool(
            "experiment.create",
            {
                "project_id": self.project_id,
                "name": "artifact-batch",
                "intent": "Exercise ordered artifact retrieval.",
            },
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _submit(self, *, role: str, path: str, body: str | bytes) -> str:
        return self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=self.experiment_id,
            role=role,
            path=path,
            body=body,
        )["artifact_id"]

    def test_batch_preserves_order_deduplicates_and_hydrates_on_opt_in(self) -> None:
        plan = self._submit(role="plan", path="plan.md", body="Plan body.")
        report = self._submit(role="report", path="report.md", body="Report body.")

        metadata = self.app.call_tool(
            "artifact.read",
            {
                "project_id": self.project_id,
                "artifact_ids": [report, plan, report],
            },
        )
        hydrated = self.app.call_tool(
            "artifact.read",
            {
                "project_id": self.project_id,
                "artifact_ids": [report, plan],
                "include_content": True,
            },
        )

        self.assertEqual(metadata["count"], 2)
        self.assertEqual(
            [artifact["id"] for artifact in metadata["artifacts"]],
            [report, plan],
        )
        self.assertNotIn("content", metadata["artifacts"][0])
        self.assertEqual(
            [artifact["content"]["content"] for artifact in hydrated["artifacts"]],
            ["Report body.", "Plan body."],
        )

    def test_missing_id_fails_the_batch_atomically(self) -> None:
        existing = self._submit(role="plan", path="plan.md", body="Plan body.")

        with self.assertRaises(NotFoundError) as ctx:
            self.app.call_tool(
                "artifact.read",
                {
                    "project_id": self.project_id,
                    "artifact_ids": [existing, "art_missing"],
                    "include_content": True,
                },
            )

        self.assertEqual(
            ctx.exception.details["missing_artifact_ids"], ["art_missing"]
        )

    def test_mixed_content_and_association_ids_keep_their_identity_and_order(self) -> None:
        content = self.app.artifacts.contents.create(
            project_id=self.project_id, path="plan.md", data=b"Reusable plan body."
        )
        association = self.app.call_tool("artifact.attach", {
            "project_id": self.project_id, "artifact_id": content.id,
            "target_type": "experiment", "target_id": self.experiment_id, "role": "plan",
        })["association"]
        report = self._submit(role="report", path="report.md", body="Report body.")
        ids = [association["id"], content.id, report]
        self.assertNotEqual(content.id, association["id"])
        result = self.app.call_tool("artifact.read", {
            "project_id": self.project_id, "artifact_ids": [*ids, content.id],
            "include_content": True,
        })
        self.assertEqual(result["count"], 3)
        self.assertEqual([row["id"] for row in result["artifacts"]], ids)
        self.assertEqual(
            [row["content"]["content"] for row in result["artifacts"]],
            ["Reusable plan body.", "Reusable plan body.", "Report body."],
        )
        for row in result["artifacts"]:
            self.assertTrue(row["download_url"].endswith(f"/{row['id']}/file"))
            self.assertEqual(row["figures"], [])
        self.assertEqual(result["artifacts"][0]["target_id"], self.experiment_id)
        self.assertNotIn("target_id", result["artifacts"][1])

    def test_mixed_batch_rejects_foreign_content_without_reading_its_bytes(self) -> None:
        existing = self._submit(role="plan", path="plan.md", body="Plan body.")
        foreign_project = self.app.call_tool("project", {"action": "create", "name": "Foreign"})["id"]
        foreign = self.app.artifacts.contents.create(
            project_id=foreign_project, path="private.bin", data=b"\x00private"
        )
        with patch.object(self.app._blobs, "get", wraps=self.app._blobs.get) as get:
            with self.assertRaises(NotFoundError) as ctx:
                self.app.call_tool("artifact.read", {
                    "project_id": self.project_id, "artifact_ids": [existing, foreign.id],
                    "include_content": True,
                })
            self.assertNotIn(foreign_project, [call.kwargs["namespace"] for call in get.call_args_list])
        self.assertEqual(ctx.exception.details["missing_artifact_ids"], [foreign.id])

    def test_contract_bounds_and_disambiguates_batch_reads(self) -> None:
        parsed = ArtifactReadInput.model_validate(
            {
                "project_id": "proj_1",
                "artifact_ids": ["art_2", "art_1", "art_2"],
            }
        )
        self.assertEqual(parsed.artifact_ids, ["art_2", "art_1"])
        with self.assertRaises(PydanticValidationError):
            ArtifactReadInput.model_validate(
                {
                    "project_id": "proj_1",
                    "artifact_ids": [f"art_{index}" for index in range(51)],
                }
            )
        with self.assertRaises(PydanticValidationError):
            ArtifactReadInput.model_validate(
                {
                    "project_id": "proj_1",
                    "artifact_ids": ["art_1"],
                    "role": "plan",
                }
            )

    def test_plural_ids_are_artifact_only(self) -> None:
        for plural_field in ("experiment_ids", "review_ids"):
            with self.subTest(plural_field=plural_field):
                with self.assertRaises(PydanticValidationError):
                    ExperimentGetStateInput.model_validate(
                        {
                            "project_id": "proj_1",
                            "experiment_id": "exp_1",
                            plural_field: ["unexpected_plural_id"],
                        }
                    )


if __name__ == "__main__":
    unittest.main()
