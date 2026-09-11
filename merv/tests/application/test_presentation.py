"""The computed fields of an experiment projection.

Its wire shape is pinned by tests/surface/test_wire_shapes.py against a real
seeded project; what stays here is what a fixture cannot show: the fallback
when a caller hands in a state with no current-attempt selection, and the
synopsis a review row is given when it stored none.
"""

from __future__ import annotations

import unittest
from tests.support.research_state import experiment_state

from merv.brain.application.experiments.presentation import (
    review_body,
    slim_experiment_state,
    slim_review_rows,
)

TLDR_KEYS = {"id", "role", "verdict", "created_at", "synopsis"}
BODY_KEYS = TLDR_KEYS | {"findings", "notes", "evidence"}


def _review(review_id: str, *, created_at: str, **overrides) -> dict:
    return {
        "id": review_id,
        "role": "experiment_reviewer",
        "verdict": "pass",
        "created_at": created_at,
        "synopsis": f"synopsis for {review_id}",
        "findings": [{"issue": review_id}],
        "notes": f"notes for {review_id}",
        "evidence": {"exit_code": 0},
        "target_snapshot_id": "drop",
        **overrides,
    }


class ExperimentPresentationTest(unittest.TestCase):
    def test_explicit_empty_current_resources_does_not_fall_back(self) -> None:
        state = experiment_state(**{
            "id": "exp_1",
            "attempt_index": 1,
            "artifacts": [
                {
                    "id": "res_1",
                    "attempt_index": 1,
                    "role": "plan",
                }
            ],
            "current_attempt_artifacts": [],
        })

        result = slim_experiment_state(state, storage_objects=[])

        self.assertEqual(result["current_attempt_artifacts"], [])
        self.assertNotIn("prior_attempt_artifacts", result)


class ReviewDietTest(unittest.TestCase):
    def test_projection_is_tldr_only_and_preserves_input_order(self) -> None:
        cases = (
            (),
            (_review("rev_1", created_at="2026-07-01T00:00:00Z"),),
            (
                _review("rev_2", created_at="2026-07-01T00:00:00Z"),
                _review("rev_1", created_at="2026-07-01T00:00:00Z"),
            ),
            (
                _review("rev_new", created_at="2026-07-01T00:00:00Z"),
                _review("rev_skewed", created_at="2026-07-09T00:00:00Z"),
                _review("rev_old", created_at="2026-06-20T00:00:00Z"),
            ),
        )
        for reviews in cases:
            with self.subTest(ids=[review["id"] for review in reviews]):
                rows = slim_review_rows(reviews)
                self.assertEqual(
                    [row["id"] for row in rows],
                    [review["id"] for review in reviews],
                )
                self.assertTrue(all(set(row) == TLDR_KEYS for row in rows))

    def test_legacy_reviews_get_a_bounded_nonempty_synopsis(self) -> None:
        cases = (
            (
                {"notes": "\n\n  The sweep never separated the arms.  \nmore detail"},
                "The sweep never separated the arms.",
            ),
            ({"notes": "w" * 900}, "w" * 419 + "…"),
            ({"notes": "   \n \n"}, "Review finding: rev_1"),
            (
                {"notes": "", "findings": []},
                "The experiment reviewer returned pass; this legacy review stored "
                "no narrative synopsis.",
            ),
        )
        for overrides, expected in cases:
            with self.subTest(overrides=overrides):
                review = _review(
                    "rev_1",
                    created_at="2026-07-01T00:00:00Z",
                    synopsis="",
                    **overrides,
                )
                synopsis = slim_review_rows([review])[0]["synopsis"]
                self.assertEqual(synopsis, expected)
                self.assertLessEqual(len(synopsis), 420)

    def test_review_body_reads_an_older_round_back_with_its_routing(self) -> None:
        reviews = [
            _review("rev_2", created_at="2026-07-02T00:00:00Z"),
            _review("rev_1", created_at="2026-07-01T00:00:00Z", return_to="planned"),
        ]

        body = review_body(reviews, review_id="rev_1")

        self.assertEqual(set(body), BODY_KEYS | {"return_to"})
        self.assertEqual(body["notes"], "notes for rev_1")
        self.assertEqual(body["return_to"], "planned")
        self.assertIsNone(review_body(reviews, review_id="rev_9"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
