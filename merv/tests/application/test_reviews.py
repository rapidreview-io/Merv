"""Review status reads and post-commit feed reactions."""

from __future__ import annotations

import unittest
from copy import deepcopy
from typing import Any
from merv.brain.application.reviews import read_review_status
from merv.brain.kernel.events import StoredEvent, freeze_json_object


def _event() -> StoredEvent:
    return StoredEvent(
        id=73,
        project_id="proj_1",
        type="review.submitted",
        target_type="experiment",
        target_id="exp_1",
        payload=freeze_json_object({"review_id": "rev_1", "verdict": "pass"}),
        created_at="2026-07-19T12:00:00Z",
    )


class RecordingReviews:
    def __init__(
        self,
        order: list[str],
        *,
        result: dict[str, Any],
        event: StoredEvent | None = None,
        status_error: Exception | None = None,
        event_error: Exception | None = None,
    ) -> None:
        self.order = order
        self.result = result
        self.event = event
        self.status_error = status_error
        self.event_error = event_error
        self.event_calls: list[dict[str, Any]] = []

    def status(self, **_kwargs: Any) -> dict[str, Any]:
        self.order.append("reviews.status")
        if self.status_error is not None:
            raise self.status_error
        return deepcopy(self.result)

    def latest_submitted_event(self, **kwargs: Any) -> StoredEvent | None:
        self.order.append("reviews.event")
        self.event_calls.append(kwargs)
        if self.event_error is not None:
            raise self.event_error
        return self.event


class RecordingExperiments:
    def __init__(self, order: list[str], *, error: Exception | None = None) -> None:
        self.order = order
        self.error = error
        self.state = {"id": "exp_1", "project_id": "proj_1", "status": "planned"}

    def get_state(self, **_kwargs: Any) -> dict[str, Any]:
        self.order.append("research.state")
        if self.error is not None:
            raise self.error
        return self.state


class RecordingResearch:
    def __init__(self, order: list[str], *, error: Exception | None = None) -> None:
        self.experiments = RecordingExperiments(order, error=error)

    @property
    def state(self) -> dict[str, Any]:
        return self.experiments.state


class RecordingFeed:
    def __init__(self, order: list[str], *, error: Exception | None = None) -> None:
        self.order = order
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def advisory(self, **kwargs: Any) -> str:
        self.order.append("feed.advisory")
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return "A review verdict is worth sharing."


def _read_status(
    *,
    research: RecordingResearch,
    reviews: RecordingReviews,
    feed: RecordingFeed,
    **kwargs: Any,
) -> dict[str, Any]:
    research.reviews = reviews
    return read_review_status(research=research, feed=feed, **kwargs)


class ReadReviewStatusTest(unittest.TestCase):
    def test_dispatches_exact_committed_event_after_primary_read(self) -> None:
        order: list[str] = []
        event = _event()
        reviews = RecordingReviews(
            order,
            result={"requests": [], "reviews": [{"id": "rev_1", "verdict": "pass"}]},
            event=event,
        )
        research = RecordingResearch(order)
        feed = RecordingFeed(order)
        result = _read_status(
            research=research,
            reviews=reviews,
            feed=feed,
            target_type="experiment",
            target_id="exp_1",
            project_id="proj_1",
        )

        self.assertEqual(result["feed_note"], "A review verdict is worth sharing.")
        self.assertEqual(
            order,
            ["reviews.status", "research.state", "reviews.event", "feed.advisory"],
        )
        self.assertEqual(reviews.event_calls[0]["project_id"], "proj_1")
        self.assertEqual(
            feed.calls,
            [
                {
                    "project_id": "proj_1",
                    "ref": "exp_1",
                    "message": "a review verdict just landed on exp_1",
                }
            ],
        )

    def test_pending_and_non_experiment_reads_are_exact_no_ops(self) -> None:
        for target_type, reviews_result in (
            ("experiment", []),
            ("reflection", [{"id": "rev_2", "verdict": "pass"}]),
        ):
            with self.subTest(target_type=target_type):
                order: list[str] = []
                reviews = RecordingReviews(
                    order,
                    result={"requests": [{"id": "rr_1"}], "reviews": reviews_result},
                    event=_event(),
                )
                research = RecordingResearch(order)
                feed = RecordingFeed(order)
                result = _read_status(
                    research=research,
                    reviews=reviews,
                    feed=feed,
                    target_type=target_type,
                    target_id="exp_1",
                    project_id="proj_1",
                )

                self.assertNotIn("feed_note", result)
                self.assertEqual(order, ["reviews.status"])

    def test_primary_status_failure_is_fatal(self) -> None:
        order: list[str] = []
        reviews = RecordingReviews(
            order,
            result={},
            status_error=RuntimeError("status unavailable"),
        )
        with self.assertRaisesRegex(RuntimeError, "status unavailable"):
            _read_status(
                research=RecordingResearch(order),
                reviews=reviews,
                feed=RecordingFeed(order),
                target_type="experiment",
                target_id="exp_1",
            )
        self.assertEqual(order, ["reviews.status"])

    def test_enrichment_and_feed_failures_never_break_status(self) -> None:
        cases = (
            (
                RuntimeError("state unavailable"),
                None,
                None,
                ["reviews.status", "research.state"],
            ),
            (
                None,
                RuntimeError("event unavailable"),
                None,
                ["reviews.status", "research.state", "reviews.event"],
            ),
            (
                None,
                None,
                RuntimeError("feed unavailable"),
                ["reviews.status", "research.state", "reviews.event", "feed.advisory"],
            ),
        )
        for state_error, event_error, feed_error, expected_order in cases:
            with self.subTest(expected_order=expected_order):
                order: list[str] = []
                reviews = RecordingReviews(
                    order,
                    result={"requests": [], "reviews": [{"id": "rev_1"}]},
                    event=_event(),
                    event_error=event_error,
                )
                result = _read_status(
                    research=RecordingResearch(order, error=state_error),
                    reviews=reviews,
                    feed=RecordingFeed(order, error=feed_error),
                    target_type="experiment",
                    target_id="exp_1",
                    project_id="proj_1",
                )

                self.assertEqual(result["reviews"], [{"id": "rev_1"}])
                self.assertNotIn("feed_note", result)
                self.assertEqual(order, expected_order)

    def test_same_event_can_be_safely_reacted_to_on_repeated_producer_reads(
        self,
    ) -> None:
        order: list[str] = []
        reviews = RecordingReviews(
            order,
            result={"requests": [], "reviews": [{"id": "rev_1"}]},
            event=_event(),
        )
        feed = RecordingFeed(order)
        research = RecordingResearch(order)
        first = _read_status(
            research=research,
            reviews=reviews,
            feed=feed,
            target_type="experiment",
            target_id="exp_1",
        )
        second = _read_status(
            research=research,
            reviews=reviews,
            feed=feed,
            target_type="experiment",
            target_id="exp_1",
        )

        self.assertEqual(first["feed_note"], second["feed_note"])
        self.assertEqual(len(feed.calls), 2)


if __name__ == "__main__":
    unittest.main()
