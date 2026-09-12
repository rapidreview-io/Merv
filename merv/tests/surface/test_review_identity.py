"""review.start requires the reviewer's session identity (caller_session_id)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.support.brain import TestBrain
from merv.brain.kernel.utils import ValidationError

VALID_PLAN = (
    "## Summary\n"
    "A toy experiment used by the review-identity tests.\n\n"
    "## Objective & hypothesis\n"
    "Test that the threshold rule beats the majority baseline.\n\n"
    "## Evaluation\n"
    "Metric: accuracy vs the majority-class baseline; success if accuracy > 0.6.\n"
)


class ReviewIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
        )
        self.project_id = self.call("project", action="create", name="Identity Test")["id"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def call(self, tool_name: str, **kwargs):
        return self.app.call_tool(tool_name, kwargs)

    def _request_design_review(self) -> dict:
        exp_id = self.call(
            "experiment.create", name="exp-identity", project_id=self.project_id, intent="Identity."
        )["id"]
        self.app.submit_artifact(
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="plan",
            path="plan.md",
            body=VALID_PLAN,
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=exp_id,
            transition="submit_design",
        )
        return self.call(
            "review.request",
            project_id=self.project_id,
            target_type="experiment",
            target_id=exp_id,
            role="design_reviewer",
        )

    def test_review_start_rejects_omitted_caller_session_id(self) -> None:
        # The contract leaves it blank so the handler's sentence, not a bare
        # "field required", tells the reviewer what to pass.
        req = self._request_design_review()
        with self.assertRaises(ValidationError) as ctx:
            self.call(
                "review.start",
                review_request_id=req["review_request_id"],
                reviewer_capability=req["reviewer_capability"],
            )
        self.assertIn("caller_session_id is required: pass the reviewer's own", str(ctx.exception))

    def test_review_start_rejects_whitespace_caller_session_id(self) -> None:
        req = self._request_design_review()
        with self.assertRaises(ValidationError) as ctx:
            self.call(
                "review.start",
                review_request_id=req["review_request_id"],
                reviewer_capability=req["reviewer_capability"],
                caller_session_id="   ",
            )
        # The error explains what to pass, not just that the field is missing.
        self.assertIn("reviewer's own", str(ctx.exception))
        # The rejection consumed nothing: the same capability still starts.
        session = self.call(
            "review.start",
            review_request_id=req["review_request_id"],
            reviewer_capability=req["reviewer_capability"],
            caller_session_id="design-reviewer",
        )
        self.assertEqual(session["independence"], "verified_agent_review")


if __name__ == "__main__":
    unittest.main()
