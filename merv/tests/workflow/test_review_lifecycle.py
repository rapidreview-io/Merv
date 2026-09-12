"""Reviews run on a declared graph like every other research process."""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from merv.brain.kernel.request_context import begin_request, bind_agent, reset_request
from merv.brain.kernel.utils import PermissionDeniedError, ValidationError, WorkflowError
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


class RecoveryTest(ReviewLifecycleCase):
    def setUp(self) -> None:
        super().setUp()
        self.requested = self.request()
        self.args = {"review_request_id": self.requested["review_request_id"],
                     "reviewer_capability": self.requested["reviewer_capability"],
                     "caller_session_id": "independent-reviewer"}
        self.started = self.call("review.start", **self.args)

    def test_retry_returns_same_handle_without_new_history_or_context(self) -> None:
        before = self.instance(self.args["review_request_id"])
        with patch.object(self.app.application._experiment_context, "build", side_effect=AssertionError("hydration")):
            recovered = self.call("review.start", **self.args)
        self.assertEqual(recovered["review_session_id"], self.started["review_session_id"])
        self.assertTrue(recovered["recovered"])
        self.assertNotIn("context", recovered)
        self.assertNotIn("target_snapshot", recovered)
        self.assertEqual(self.instance(self.args["review_request_id"]), before)
        with self.app.store.transaction() as conn:
            rows = conn.execute("SELECT * FROM review_sessions WHERE request_id = ?",
                                (self.args["review_request_id"],)).fetchall()
        self.assertEqual(len(rows), 1)

    def test_concurrent_retries_recover_one_handle(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.call("review.start", **self.args), range(2)))
        self.assertEqual([r["review_session_id"] for r in results], [self.started["review_session_id"]] * 2)

    def test_retry_rechecks_capability_caller_and_producer(self) -> None:
        for changes in ({"reviewer_capability": "wrong"}, {"caller_session_id": "other"},
                        {"caller_session_id": "producer"}):
            with self.subTest(changes=changes), self.assertRaises(PermissionDeniedError):
                self.call("review.start", **{**self.args, **changes})

    def test_retry_refuses_expired_stale_and_closed_requests(self) -> None:
        for column, value in (("expires_at", "2000-01-01T00:00:00+00:00"),
                              ("target_snapshot_id", "stale"), ("status", "submitted"),
                              ("status", "superseded")):
            with self.app.store.transaction() as conn:
                old = conn.execute(f"SELECT {column} FROM review_requests WHERE id = ?",
                                   (self.args["review_request_id"],)).fetchone()[column]
                conn.execute(f"UPDATE review_requests SET {column} = ? WHERE id = ?",
                             (value, self.args["review_request_id"]))
            with self.subTest(column=column, value=value), self.assertRaises(PermissionDeniedError):
                self.call("review.start", **self.args)
            with self.app.store.transaction() as conn:
                conn.execute(f"UPDATE review_requests SET {column} = ? WHERE id = ?",
                             (old, self.args["review_request_id"]))

    def test_retry_refuses_missing_or_ambiguous_active_sessions(self) -> None:
        with self.app.store.transaction() as conn:
            row = dict(conn.execute("SELECT * FROM review_sessions WHERE id = ?",
                                   (self.started["review_session_id"],)).fetchone())
            conn.execute("UPDATE review_sessions SET status = 'superseded' WHERE id = ?", (row["id"],))
        with self.assertRaises(PermissionDeniedError):
            self.call("review.start", **self.args)
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE review_sessions SET status = 'started' WHERE id = ?", (row["id"],))
            duplicate = {**row, "id": "rvs_duplicate"}
            conn.execute(f"INSERT INTO review_sessions ({', '.join(duplicate)}) VALUES ({', '.join('?' for _ in duplicate)})",
                         tuple(duplicate.values()))
        with self.assertRaises(PermissionDeniedError):
            self.call("review.start", **self.args)


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

    def test_starting_a_review_moves_the_request_and_records_one_session(self) -> None:
        request = self.request()
        session = self.call("review.start", review_request_id=request["review_request_id"],
                            reviewer_capability=request["reviewer_capability"],
                            caller_session_id="independent-reviewer")
        self.assertEqual((self.instance(request["review_request_id"]).state,
                          self.row_status(request["review_request_id"])), ("started", "started"))
        with self.app.store.transaction() as conn:
            rows = conn.execute("SELECT id, status, independence FROM review_sessions WHERE request_id = ?",
                                (request["review_request_id"],)).fetchall()
            started = conn.execute(
                "SELECT type FROM events WHERE target_id = ? ORDER BY id", (request["review_request_id"],),
            ).fetchall()
        self.assertEqual([(str(row["id"]), str(row["status"]), str(row["independence"])) for row in rows],
                         [(session["review_session_id"], "started", "verified_agent_review")])
        self.assertIn("review.started", [str(row["type"]) for row in started])


class VerdictTest(ReviewLifecycleCase):
    def start(self, request):
        return self.call("review.start", review_request_id=request["review_request_id"],
                         reviewer_capability=request["reviewer_capability"],
                         caller_session_id="independent-reviewer")["review_session_id"]

    def test_a_passing_verdict_closes_the_request_and_advances_its_target(self) -> None:
        request = self.request()
        session = self.start(request)
        verdict = self.call("review.submit", review_session_id=session, verdict="pass",
                            synopsis=REVIEW_SYNOPSIS)
        self.assertEqual((verdict["verdict"], verdict["role"], verdict["synopsis"]),
                         ("pass", "design_reviewer", REVIEW_SYNOPSIS))
        # The producer learns from the receipt that the pass already moved the target.
        self.assertEqual(verdict["target"], {"type": "experiment", "id": self.experiment_id,
                                             "status_before": "design_review", "status_after": "running"})
        self.assertIn("workflow.status_and_next", verdict["next_action"])
        self.assertLess(len(json.dumps(verdict)), 700)
        self.assertIn("producer_next", request)
        closed = self.instance(request["review_request_id"])
        self.assertEqual((closed.state, closed.outcome, closed.data["review_id"]),
                         ("submitted", "submitted", verdict["id"]))
        self.assertEqual(self.row_status(request["review_request_id"]), "submitted")
        self.assertEqual(self.app.research.experiments.get_state(
            project_id=self.project_id, experiment_id=self.experiment_id).status, "running")

    def test_a_rejection_routes_its_target_back_to_the_declared_return(self) -> None:
        request = self.request()
        verdict = self.call("review.submit", review_session_id=self.start(request),
                            verdict="needs_changes", synopsis=REVIEW_SYNOPSIS,
                            notes="The evaluation cannot separate the arms.")
        self.assertEqual(verdict["return_to"], "planned")
        state = self.app.research.experiments.get_state(
            project_id=self.project_id, experiment_id=self.experiment_id)
        self.assertEqual((state.status, state.attempt_index), ("planned", 2))
        self.assertIn("design_reviewer returned needs_changes", state.revision_context)

    def test_only_the_context_window_that_started_a_session_may_submit(self) -> None:
        request = self.request()
        token = begin_request(request_id="reviewer")
        try:
            bind_agent(agent_id="reviewer-window")
            session = self.start(request)
            bind_agent(agent_id="producer-window")
            with self.assertRaisesRegex(PermissionDeniedError, "started by agent 'reviewer-window'"):
                self.call("review.submit", review_session_id=session, verdict="pass", synopsis=REVIEW_SYNOPSIS)
            bind_agent(agent_id="reviewer-window")
            self.assertEqual(self.call("review.submit", review_session_id=session, verdict="pass",
                                       synopsis=REVIEW_SYNOPSIS)["verdict"], "pass")
        finally:
            reset_request(token)

    def test_the_graph_refuses_a_verdict_from_a_request_nobody_started(self) -> None:
        request = self.request()
        session = self.start(request)
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE review_requests SET status = 'requested' WHERE id = ?",
                         (request["review_request_id"],))
            self.app.workflows.runtime.apply_in_transaction(
                conn=conn, project_id=self.project_id, instance_id=request["review_request_id"],
                action="supersede", expected_revision=1, request_id="rewind")
            conn.execute("UPDATE review_requests SET status = 'started' WHERE id = ?",
                         (request["review_request_id"],))
        with self.assertRaisesRegex(WorkflowError, "not allowed from terminal state"):
            self.call("review.submit", review_session_id=session, verdict="pass",
                      synopsis=REVIEW_SYNOPSIS)

    def test_a_target_that_refuses_its_edge_leaves_no_verdict_behind(self) -> None:
        request = self.request()
        session = self.start(request)
        runtime = self.app.workflows.runtime
        before = runtime.get(project_id=self.project_id, instance_id=self.experiment_id)
        apply_in_transaction = runtime.apply_in_transaction

        def refuse(**kwargs):
            if kwargs["instance_id"] == self.experiment_id:
                raise WorkflowError("the target refused its edge")
            return apply_in_transaction(**kwargs)

        with patch.object(runtime, "apply_in_transaction", side_effect=refuse):
            with self.assertRaisesRegex(WorkflowError, "refused its edge"):
                self.call("review.submit", review_session_id=session, verdict="pass",
                          synopsis=REVIEW_SYNOPSIS)
        after = runtime.get(project_id=self.project_id, instance_id=self.experiment_id)
        self.assertEqual((after.state, after.revision), (before.state, before.revision))
        self.assertEqual(self.row_status(request["review_request_id"]), "started")
        self.assertEqual(self.instance(request["review_request_id"]).state, "started")
        self.assertEqual(self.call("review.status", project_id=self.project_id,
                                   target_type="experiment", target_id=self.experiment_id)["reviews"], [])


class ReflectionVerdictTest(ResearchCase):
    """The same graph carries a target that is not an experiment."""

    def test_a_reflection_review_passes_and_rejects_through_the_same_edges(self) -> None:
        reflection_id = self.drive_reflection_to_review()
        rejected = self.review(target_type="reflection", target_id=reflection_id,
                               role="reflection_reviewer", verdict="needs_changes",
                               return_to="synthesizing")
        self.assertEqual(rejected["return_to"], "synthesizing")
        self.assertEqual(self.app.research.reflections.get_state(
            project_id=self.project_id, reflection_id=reflection_id).workflow_state, "synthesizing")
        self.submit_reflection_bundle(reflection_id)
        self.call("reflection.transition", project_id=self.project_id,
                  reflection_id=reflection_id, transition="submit_reflection_artifacts")
        self.pass_review(target_type="reflection", target_id=reflection_id,
                         role="reflection_reviewer")
        self.assertEqual(self.app.research.reflections.get_state(
            project_id=self.project_id, reflection_id=reflection_id).workflow_state, "consolidating")


if __name__ == "__main__":
    unittest.main()
