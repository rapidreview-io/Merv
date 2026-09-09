from __future__ import annotations

import unittest
from unittest.mock import Mock

from merv.brain.research_core import ArtifactTarget, ResearchArtifacts
from merv.brain.kernel.utils import ValidationError
from merv.brain.research_core.policy import (
    validate_review_role,
    validate_review_verdict,
)


class OwnedPermissionPolicyTest(unittest.TestCase):
    def test_research_validates_review_vocabulary(self) -> None:
        validate_review_role(role="experiment_reviewer")
        # The active graph chooses the role; this validator checks its shape.
        validate_review_role(role="replication_auditor")
        validate_review_verdict(verdict="needs_changes")
        for role in ("", "   ", "x" * 129):
            with self.subTest(role=role), self.assertRaisesRegex(ValidationError, "nonempty workflow role"):
                validate_review_role(role=role)
        with self.assertRaisesRegex(ValidationError, "unknown review verdict: maybe"):
            validate_review_verdict(verdict="maybe")

    def test_research_validates_association_vocabulary(self) -> None:
        artifacts = ResearchArtifacts(store=Mock(), artifacts=Mock())

        with self.assertRaises(ValidationError) as target_error:
            artifacts.submit(
                target=ArtifactTarget("project", "project_1"),
                role="plan",
                path="plan.md",
            )
        self.assertIn("experiment", target_error.exception.details["allowed_target_types"])
        with self.assertRaises(ValidationError) as legacy_error:
            artifacts.submit(
                target=ArtifactTarget("reflection", "reflection_1"),
                role="synthesis_doc",
                path="synthesis.md",
            )
        self.assertEqual(legacy_error.exception.details["replacement_role"], "reflection_doc")
        with self.assertRaises(ValidationError) as graph_error:
            artifacts.submit(
                target=ArtifactTarget("reflection", "reflection_1"),
                role="graph",
                path="graph.json",
            )
        self.assertEqual(graph_error.exception.details["replacement_role"], "project_graph")

if __name__ == "__main__":
    unittest.main()
