"""Reviews run on a declared graph like every other research process."""

from __future__ import annotations

import unittest

from merv.brain.kernel.utils import PermissionDeniedError, ValidationError
from merv.brain.workflows import REVIEW_KIND
from merv.brain.workflows.definitions.review import REVIEW, record_verdict

from tests.research_core.scenarios import REVIEW_SYNOPSIS, VALID_PLAN, ResearchCase


class ReviewGraphTest(unittest.TestCase):
    """What the declaration says, before anything applies it."""

    def test_the_graph_states_exactly_how_a_request_can_end(self) -> None:
        self.assertEqual([node.name for node in REVIEW.nodes], ["requested", "started"])
        self.assertEqual(
            sorted((edge.source, edge.name, edge.target) for edge in REVIEW.edges),
            [("requested", "start", "started"), ("requested", "supersede", "superseded"),
             ("started", "submit", "submitted"), ("started", "supersede", "superseded")],
        )
        self.assertEqual(dict(REVIEW.outcomes), {"submitted": "submitted", "superseded": "superseded"})
        # A review instance is never dispatched: the reviewer is assigned by
        # the target's own read-only node.
        self.assertEqual([node.role for node in REVIEW.nodes], ["", ""])
        self.assertEqual(REVIEW_KIND.seal_exempt_actions, frozenset(REVIEW_KIND.actions))
        self.assertFalse(REVIEW_KIND.reads_record)

    def test_the_submit_reducer_refuses_a_verdict_the_vocabulary_rejects(self) -> None:
        with self.assertRaisesRegex(ValidationError, "unknown review verdict: maybe"):
            record_verdict(None, {"verdict": "maybe", "synopsis": REVIEW_SYNOPSIS}, None)
        with self.assertRaisesRegex(ValidationError, "TLDR"):
            record_verdict(None, {"verdict": "pass", "synopsis": "too short"}, None)
        change = record_verdict(None, {"verdict": "pass", "synopsis": f"  {REVIEW_SYNOPSIS}  ",
                                       "review_id": "rev_1"}, None)
        self.assertEqual(change.data, {"review_id": "rev_1", "verdict": "pass"})
        effect, = change.transactional
        self.assertEqual(effect.kind, "review.record_verdict")
        self.assertEqual(effect.data["synopsis"], REVIEW_SYNOPSIS)


class ReviewRecordSpineTest(ResearchCase):
    def test_migration_72_gives_the_review_row_the_record_spine(self) -> None:
        with self.app.store.transaction() as conn:
            columns = {str(row["name"]) for row in
                       conn.execute("PRAGMA table_info(review_requests)").fetchall()}
        self.assertLessEqual({"attempt_index", "revision_context", "updated_at"}, columns)


class ReviewLifecycleCase(ResearchCase):
    """Requests driven through the graph against a real experiment gate."""

    def setUp(self) -> None:
        super().setUp()
        self.experiment_id = self.create_experiment("reviewed")
        self.submit(target_type="experiment", target_id=self.experiment_id,
                    role="plan", path="plan.md", body=VALID_PLAN)
        self.transition_experiment(self.experiment_id, "submit_design")

    def request(self, role: str = "design_reviewer", **overrides):
        return self.call("review.request", project_id=self.project_id, target_type="experiment",
                         target_id=self.experiment_id, role=role,
                         producer_session_id="producer", **overrides)

    def instance(self, request_id: str):
        return self.app.workflows.runtime.get(project_id=self.project_id, instance_id=request_id)

    def row_status(self, request_id: str) -> str:
        with self.app.store.transaction() as conn:
            return str(conn.execute("SELECT status FROM review_requests WHERE id = ?",
                                    (request_id,)).fetchone()["status"])


class RequestTest(ReviewLifecycleCase):
    def test_a_fresh_capability_supersedes_every_open_request_through_the_graph(self) -> None:
        first = self.request()
        self.assertEqual((self.instance(first["review_request_id"]).state,
                          self.row_status(first["review_request_id"])), ("requested", "requested"))
        second = self.request()
        closed = self.instance(first["review_request_id"])
        self.assertEqual((closed.state, closed.outcome), ("superseded", "superseded"))
        self.assertEqual(self.row_status(first["review_request_id"]), "superseded")
        with self.assertRaisesRegex(PermissionDeniedError, "no longer open"):
            self.call("review.start", review_request_id=first["review_request_id"],
                      reviewer_capability=first["reviewer_capability"], caller_session_id="reviewer")
        self.call("review.start", review_request_id=second["review_request_id"],
                  reviewer_capability=second["reviewer_capability"], caller_session_id="reviewer")


if __name__ == "__main__":
    unittest.main()
