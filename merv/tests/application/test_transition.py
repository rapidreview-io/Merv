from __future__ import annotations

from tests.support.research_state import experiment_state

import json
import unittest
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

from merv.brain.application.experiments.transition import TransitionExperiment
from merv.brain.kernel.events import StoredEvent, freeze_json_object
from merv.brain.research_core.models import (
    CommittedExperimentUpdate as CommittedExperimentTransition,
)

PRESENTATION_LOGGER = "merv.brain.application.experiments.transition"
PROJECT_ID = "proj_1"
EXPERIMENT_ID = "exp_1"
CREATED_AT = "2026-07-19T12:34:56.789000Z"


def _event(
    transition: str,
    *,
    event_type: str = "experiment.transitioned",
    payload_status: str = "intentionally-not-the-state",
) -> StoredEvent:
    return StoredEvent(
        id=41,
        project_id=PROJECT_ID,
        type=event_type,
        target_type="experiment",
        target_id=EXPERIMENT_ID,
        payload=freeze_json_object(
            {
                "evidence": {"source": "characterization"},
                "from": "design_review",
                "status": payload_status,
                "transition": transition,
            }
        ),
        created_at=CREATED_AT,
    )


def _state(
    status: str,
    *,
    attempt_index: int = 3,
    token: str = "committed",
) -> dict[str, Any]:
    return experiment_state(**{
        "id": EXPERIMENT_ID,
        "project_id": PROJECT_ID,
        "name": "A Characterized Experiment",
        "status": status,
        "attempt_index": attempt_index,
        "details": token,
    })


def _exhibit(*, result_files: int = 1) -> dict[str, Any]:
    return {
        "kind": "metrics_exhibit",
        "project_id": PROJECT_ID,
        "experiment_id": EXPERIMENT_ID,
        "attempt_index": 3,
        "window": {"started_at": "2026-07-19T12:00:00Z"},
        "result_files": [
            {"path": "results.json", "data": {"accuracy": 0.72},
             "source": {"type": "result_file", "path": "results.json"}}
        ][:result_files],
        "verdict": {"result_files": result_files},
    }


class RecordingResearch:
    def __init__(
        self,
        order: list[str],
        *,
        before: dict[str, Any] | None = None,
        committed: dict[str, Any] | None = None,
        event: StoredEvent | None = None,
        transition_error: Exception | None = None,
    ) -> None:
        self.order = order
        self.workflow_revision, self.workflow_outcome = 7, ""
        self.workflows = SimpleNamespace(
            runtime=SimpleNamespace(
                get=lambda **kwargs: SimpleNamespace(
                    revision=self.workflow_revision,
                    outcome=self.workflow_outcome,
                    state=str(self.before.status),
                    id=EXPERIMENT_ID,
                    project_id=PROJECT_ID,
                )
            ),
        )
        self.before = before or _state("running", token="before")
        self.committed = committed or _state("running")
        self.event = event or _event("approve_design")
        self.transition_error = transition_error
        # Set by tests that make the durable re-read itself unavailable.
        self.state_error: Exception | None = None
        self.transition_committed = False
        self.transition_calls: list[dict[str, Any]] = []
        self.verdicts: list[dict[str, Any]] = []
        self.exhibit_calls = []
        self.exhibit_error = None

    @property
    def experiments(self) -> "RecordingResearch":
        """This fake is its own experiment service."""
        return self

    def get_state(
        self, *, experiment_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        self.order.append("research.state")
        if self.state_error is not None:
            raise self.state_error
        return self.before

    def transition_with_event(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, object] | None = None,
        project_id: str | None = None,
        expected_revision: int | None = None,
    ) -> CommittedExperimentTransition:
        self.order.append("research.transition")
        self.transition_calls.append(
            {
                "experiment_id": experiment_id,
                "transition": transition,
                "evidence": evidence,
                "project_id": project_id,
                **(
                    {"expected_revision": expected_revision}
                    if expected_revision is not None
                    else {}
                ),
            }
        )
        if self.transition_error is not None:
            raise self.transition_error
        self.transition_committed = True
        return CommittedExperimentTransition(state=self.committed, event=self.event)

    def record_exhibit_verdict(
        self,
        *,
        experiment_id: str,
        project_id: str,
        verdict: dict[str, Any],
        **preparation,
    ) -> None:
        self.order.append("research.exhibit_verdict")
        self.exhibit_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "verdict": deepcopy(verdict),
                **preparation,
            }
        )
        if self.exhibit_error is not None:
            raise self.exhibit_error
        self.verdicts.append(deepcopy(verdict))

    def attempt_started_running_at(self, *, experiment_id: str) -> str | None:
        return "2026-07-19T12:00:00Z"

    def exhibit_path(self, *, experiment_id: str, name: str, filename: str) -> str:
        return f"experiments/a-characterized-experiment/{filename}"


class RecordingArtifacts:
    def __init__(self, order: list[str], *, pin_error: Exception | None = None) -> None:
        self.order = order
        self.pin_error = pin_error
        self.pin_attempts: list[dict[str, Any]] = []
        self.pins: list[dict[str, Any]] = []

    def pin(self, **kwargs: Any) -> None:
        self.order.append("artifacts.pin")
        copied = deepcopy(kwargs)
        self.pin_attempts.append(copied)
        if self.pin_error is not None:
            raise self.pin_error
        self.pins.append(copied)


class RecordingFeed:
    def __init__(
        self,
        order: list[str],
        *,
        note: str | None = "A terminal update is ready for the feed.",
        error: Exception | None = None,
    ) -> None:
        self.order = order
        self.note = note
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def advisory(self, *, project_id: str, ref: str, message: str) -> str | None:
        self.order.append("feed.advisory")
        self.calls.append({"project_id": project_id, "ref": ref, "message": message})
        if self.error is not None:
            raise self.error
        return self.note


class RecordingExhibits:
    def __init__(
        self,
        order: list[str],
        *,
        exhibit: dict[str, Any] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.order = order
        self.exhibit = exhibit or _exhibit()
        self.error = error
        self.states: list[dict[str, Any]] = []

    def generate(self, *, state: dict[str, Any]) -> dict[str, Any]:
        self.order.append("exhibits.generate")
        self.states.append(state)
        if self.error is not None:
            raise self.error
        return deepcopy(self.exhibit)


class RecordingObjects:
    def __init__(self, order: list[str], *, error: Exception | None = None) -> None:
        self.order = order
        self.error = error

    def by_experiment(self, **kwargs: Any) -> dict[str, list[dict[str, Any]]]:
        self.order.append("objects.by_experiment")
        if self.error is not None:
            raise self.error
        return {experiment_id: [] for experiment_id in kwargs["experiment_ids"]}


def _use_case(
    *,
    research: RecordingResearch,
    artifacts: RecordingArtifacts,
    feed: RecordingFeed,
    exhibits: RecordingExhibits,
    objects: RecordingObjects | None = None,
) -> TransitionExperiment:
    objects = objects or RecordingObjects(research.order)
    return TransitionExperiment(
        research=research,
        artifacts=artifacts,
        feed=feed,
        exhibits=exhibits,
        objects=objects,
    )


class TransitionStoragePrefetchTest(unittest.TestCase):
    def test_catalog_failure_prevents_exhibit_and_transition_side_effects(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        artifacts = RecordingArtifacts(order)
        feed = RecordingFeed(order)
        exhibits = RecordingExhibits(order)
        use_case = _use_case(
            research=research,
            artifacts=artifacts,
            feed=feed,
            exhibits=exhibits,
            objects=RecordingObjects(order, error=RuntimeError("catalog down")),
        )

        with self.assertRaisesRegex(RuntimeError, "catalog down"):
            use_case.execute(
                experiment_id=EXPERIMENT_ID,
                transition="submit_results",
                project_id=PROJECT_ID,
            )

        self.assertEqual(order, ["research.state", "objects.by_experiment"])
        self.assertEqual(research.verdicts, [])
        self.assertEqual(research.transition_calls, [])
        self.assertEqual(exhibits.states, [])
        self.assertEqual(artifacts.pin_attempts, [])
        self.assertEqual(feed.calls, [])


class FeedTransitionReactionTest(unittest.TestCase):
    def _execute(
        self,
        *,
        status: str,
        transition: str,
        event: StoredEvent | None = None,
        feed_note: str | None = "feed note",
        feed_error: Exception | None = None,
        research: RecordingResearch | None = None,
    ) -> tuple[dict[str, Any], RecordingFeed, RecordingResearch, list[str]]:
        order: list[str] = []
        committed = _state(status)
        research = research or RecordingResearch(
            order,
            committed=committed,
            event=event or _event(transition, payload_status="running"),
        )
        feed = RecordingFeed(order, note=feed_note, error=feed_error)
        use_case = _use_case(
            research=research,
            artifacts=RecordingArtifacts(order),
            feed=feed,
            exhibits=RecordingExhibits(order),
        )
        result = use_case.execute(
            experiment_id=EXPERIMENT_ID,
            transition=transition,
            project_id=PROJECT_ID,
        )
        return result, feed, research, order

    def test_feed_event_is_mapped_from_final_state_not_event_payload_or_command(
        self,
    ) -> None:
        cases = (
            ("complete", "mark_failed", f"{EXPERIMENT_ID} just completed"),
            ("failed", "complete", f"{EXPERIMENT_ID} just failed"),
            ("abandoned", "complete", f"{EXPERIMENT_ID} was just abandoned"),
        )
        for status, transition, expected_message in cases:
            with self.subTest(status=status, transition=transition):
                event = _event(transition, payload_status="running")
                result, feed, _research, _order = self._execute(
                    status=status, transition=transition, event=event
                )
                self.assertEqual(feed.calls[0]["ref"], EXPERIMENT_ID)
                self.assertEqual(feed.calls[0]["message"], expected_message)
                self.assertEqual(result["feed_note"], "feed note")

    def test_nonterminal_state_does_not_query_feed(self) -> None:
        result, feed, _research, _order = self._execute(
            status="experiment_review", transition="submit_results"
        )
        self.assertEqual(feed.calls, [])
        self.assertNotIn("feed_note", result)

    def test_feed_failure_is_suppressed(self) -> None:
        with self.assertLogs("merv.brain.application.experiments.transition", level="ERROR") as logged:
            result, feed, research, _order = self._execute(
                status="complete",
                transition="complete",
                feed_error=RuntimeError("feed unavailable"),
            )
        self.assertIn("feed unavailable", logged.output[0])
        self.assertIn(EXPERIMENT_ID, logged.output[0])
        self.assertTrue(research.transition_committed)
        self.assertEqual(len(feed.calls), 1)
        self.assertEqual(result["status"], "complete")
        self.assertNotIn("feed_note", result)

    def test_feed_note_phrases_are_research_words_with_a_generic_default(self) -> None:
        from merv.brain.application.experiments.transition import feed_transition_note

        feed = RecordingFeed([])
        feed_transition_note(feed, project_id=PROJECT_ID, ref="task_7", event="task_done")
        feed_transition_note(feed, project_id=PROJECT_ID, ref="exp_9", event="some_future_event")
        self.assertEqual(
            [call["message"] for call in feed.calls],
            ["task task_7 was just accepted", "exp_9 just had a workflow update"],
        )
        self.assertIsNone(
            feed_transition_note(
                RecordingFeed([], error=RuntimeError("feed unavailable")),
                project_id=PROJECT_ID,
                ref="exp_9",
                event="experiment_complete",
            )
        )

    def test_feed_query_is_after_the_commit_and_none_stays_absent(self) -> None:
        result, feed, _research, observed = self._execute(
            status="complete", transition="complete", feed_note=None
        )

        self.assertEqual(len(feed.calls), 1)
        self.assertNotIn("feed_note", result)
        self.assertLess(
            observed.index("research.transition"), observed.index("feed.advisory")
        )


class SubmitResultsExhibitPrerequisiteTest(unittest.TestCase):
    def _fixture(
        self,
        *,
        pin_error: Exception | None = None,
        transition_error: Exception | None = None,
        before_status: str = "running",
        result_files: int = 1,
    ) -> tuple[
        TransitionExperiment,
        RecordingResearch,
        RecordingArtifacts,
        RecordingFeed,
        RecordingExhibits,
        list[str],
    ]:
        order: list[str] = []
        research = RecordingResearch(
            order,
            before=_state(before_status, token="before"),
            committed=_state("experiment_review"),
            event=_event("submit_results"),
            transition_error=transition_error,
        )
        research.exhibit_error = pin_error
        artifacts = RecordingArtifacts(order)
        feed = RecordingFeed(order)
        exhibits = RecordingExhibits(order, exhibit=_exhibit(result_files=result_files))
        return (
            _use_case(
                research=research,
                artifacts=artifacts,
                feed=feed,
                exhibits=exhibits,
            ),
            research,
            artifacts,
            feed,
            exhibits,
            order,
        )

    def test_verdict_and_pin_are_one_fenced_capability_before_transition(self):
        use_case, research, artifacts, feed, exhibits, order = self._fixture()
        research.before.current_attempt_artifacts[:] = [
            {"id": "result_1", "role": "result"},
            {"id": "old_exhibit", "role": "exhibit"},
        ]
        result = use_case.execute(
            experiment_id=EXPERIMENT_ID,
            transition="submit_results",
            project_id=PROJECT_ID,
        )
        self.assertIs(exhibits.states[0], research.before)
        self.assertEqual(
            [
                item
                for item in order
                if item
                in {
                    "research.state",
                    "exhibits.generate",
                    "research.exhibit_verdict",
                    "research.transition",
                }
            ],
            [
                "research.state",
                "exhibits.generate",
                "research.exhibit_verdict",
                "research.transition",
            ],
        )
        recorded = research.exhibit_calls[0]
        self.assertEqual(recorded["expected_revision"], 7)
        self.assertEqual(recorded["expected_attempt_index"], 3)
        self.assertEqual(recorded["expected_artifact_ids"], ("result_1",))
        self.assertEqual(recorded["verdict"]["result_files"], 1)
        self.assertTrue(recorded["verdict"]["pinned"])
        self.assertEqual(json.loads(recorded["artifact_data"]), _exhibit())
        self.assertEqual(
            recorded["artifact_path"],
            "experiments/A_Characterized_Experiment/metrics_exhibit.json",
        )
        self.assertEqual(research.transition_calls[0]["expected_revision"], 7)
        self.assertEqual(artifacts.pins, [])
        self.assertEqual(
            result["metrics_exhibit"],
            {
                "pinned": True,
                "path": recorded["artifact_path"],
                "verdict": {"result_files": 1},
            },
        )

    def test_atomic_recorder_failure_stops_transition_and_external_effects(self):
        use_case, research, artifacts, feed, exhibits, order = self._fixture(
            pin_error=RuntimeError("atomic pin failed")
        )
        with self.assertRaisesRegex(RuntimeError, "atomic pin failed"):
            use_case.execute(
                experiment_id=EXPERIMENT_ID,
                transition="submit_results",
                project_id=PROJECT_ID,
            )
        self.assertEqual(len(research.exhibit_calls), 1)
        self.assertEqual(research.transition_calls, [])
        self.assertFalse(research.transition_committed)
        self.assertEqual(feed.calls, [])

    def test_transition_after_preparation_still_receives_the_original_revision(self):
        use_case, research, artifacts, feed, exhibits, order = self._fixture(
            transition_error=RuntimeError("workflow revision changed")
        )
        with self.assertRaisesRegex(RuntimeError, "workflow revision changed"):
            use_case.execute(
                experiment_id=EXPERIMENT_ID,
                transition="submit_results",
                project_id=PROJECT_ID,
            )
        self.assertEqual(research.exhibit_calls[0]["expected_revision"], 7)
        self.assertEqual(research.transition_calls[0]["expected_revision"], 7)
        self.assertFalse(research.transition_committed)
        self.assertEqual(feed.calls, [])

    def test_submit_from_non_running_state_skips_exhibit_prerequisite(self) -> None:
        use_case, research, artifacts, _feed, exhibits, order = (
            self._fixture(before_status="experiment_review")
        )

        use_case.execute(
            experiment_id=EXPERIMENT_ID,
            transition="submit_results",
            project_id=PROJECT_ID,
        )

        self.assertEqual(exhibits.states, [])
        self.assertEqual(research.verdicts, [])
        self.assertEqual(artifacts.pin_attempts, [])
        self.assertEqual(
            order[:3],
            ["research.state", "objects.by_experiment", "research.transition"],
        )
