from __future__ import annotations

import json
import unittest
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

from merv.brain.application.experiments.transition import TransitionExperiment
from merv.brain.application.mlflow import MlflowIntegration, TrackingCapabilities
from merv.brain.kernel.events import StoredEvent, freeze_json_object
from merv.brain.research_core.models import (
    CommittedExperimentUpdate as CommittedExperimentTransition,
)
from merv.brain.workflows import Delivery
from merv.shared.errors import TrackingPersistenceError
from tests.research_core.scenarios import VALID_PLAN, ResearchCase

REACTIONS_LOGGER = "merv.brain.application.mlflow"
PRESENTATION_LOGGER = "merv.brain.application.mlflow"
PROJECT_ID = "proj_1"
EXPERIMENT_ID = "exp_1"
CREATED_AT = "2026-07-19T12:34:56.789000Z"
_MISSING = object()


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


def _delivery(kind, *, data=None):
    return Delivery(
        "action-41",
        PROJECT_ID,
        EXPERIMENT_ID,
        7,
        kind,
        data or {},
        "delivery-lease",
        1,
        event_id=41,
    )


def _state(
    status: str,
    *,
    attempt_index: int = 3,
    run: object = _MISSING,
    token: str = "committed",
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "id": EXPERIMENT_ID,
        "project_id": PROJECT_ID,
        "name": "A Characterized Experiment",
        "status": status,
        "attempt_index": attempt_index,
        "state_token": token,
    }
    if run is not _MISSING:
        state["mlflow_run"] = run
    return state


def _open_run(run_id: str = "run_open") -> dict[str, Any]:
    return {
        "run_id": run_id,
        "run_name": f"{EXPERIMENT_ID}-attempt-3",
        "status": "RUNNING",
        "artifact_uri": f"s3://tracking/{run_id}",
        "created_at": "2026-07-19T12:00:00Z",
        "created_by_plugin": True,
    }


def _created_run(run_id: str = "run_new") -> dict[str, Any]:
    return {
        "created": True,
        "configured": True,
        "control_configured": True,
        "experiment_name": f"merv/{PROJECT_ID}/{EXPERIMENT_ID}",
        "experiment_id": "tracking-exp-7",
        "run_id": run_id,
        "run_name": f"{EXPERIMENT_ID}-attempt-3",
        "status": "RUNNING",
        "artifact_uri": f"s3://tracking/{run_id}",
        "created_at": "2026-07-19T12:35:00Z",
        "dashboard_run_url": f"https://tracking.test/runs/{run_id}",
    }


def _exhibit(*, runs_found: int = 1) -> dict[str, Any]:
    return {
        "kind": "metrics_exhibit",
        "project_id": PROJECT_ID,
        "experiment_id": EXPERIMENT_ID,
        "attempt_index": 3,
        "window": {"started_at": "2026-07-19T12:00:00Z"},
        "mlflow": {
            "configured": True,
            "available": True,
            "experiment_name": f"merv/{PROJECT_ID}/{EXPERIMENT_ID}",
            "runs_excluded_by_window": 0,
        },
        "runs": ([{"run_id": "run_open"}] if runs_found else []),
        "result_files": [],
        "verdict": {"runs_found": runs_found, "result_files": 0},
    }


class _Context:
    def __init__(
        self,
        *,
        payload: dict[str, Any],
        order: list[str],
        serialization_error: Exception | None,
    ) -> None:
        self._payload = payload
        self._order = order
        self._serialization_error = serialization_error

    @property
    def configured(self) -> bool:
        return bool(self._payload.get("configured"))

    @property
    def experiment_name(self) -> str:
        return str(self._payload.get("experiment_name") or "")

    def to_dict(self) -> dict[str, Any]:
        self._order.append("tracking.context.serialize")
        if self._serialization_error is not None:
            raise self._serialization_error
        return deepcopy(self._payload)


class RecordingTracking:
    def __init__(
        self,
        order: list[str],
        *,
        create_result: dict[str, Any] | None = None,
        create_error: Exception | None = None,
        finalize_result: dict[str, Any] | None = None,
        finalize_error: Exception | None = None,
        context_error: Exception | None = None,
        capabilities: TrackingCapabilities | None = None,
    ) -> None:
        self.order = order
        self.create_result = create_result or {}
        self.create_error = create_error
        self.finalize_result = finalize_result or {}
        self.finalize_error = finalize_error
        self.context_error = context_error
        self._capabilities = capabilities or TrackingCapabilities(
            logging=True, control=True, readback=True
        )
        self.create_calls: list[dict[str, Any]] = []
        self.finalize_calls: list[dict[str, Any]] = []
        self.context_calls: list[dict[str, Any]] = []

    def capabilities(self) -> TrackingCapabilities:
        self.order.append("tracking.capabilities")
        return self._capabilities

    def context(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool = False,
    ) -> _Context:
        self.order.append("tracking.context")
        call = {
            "project_id": project_id,
            "experiment_id": experiment_id,
            "include_credentials": include_credentials,
        }
        self.context_calls.append(call)
        env = {
            "MLFLOW_TRACKING_URI": "https://tracking.test",
            "MLFLOW_EXPERIMENT_NAME": f"merv/{project_id}/{experiment_id}",
        }
        if include_credentials:
            env["MLFLOW_TRACKING_PASSWORD"] = "credential-for-public-response"
        return _Context(
            payload={
                "configured": True,
                "experiment_name": f"merv/{project_id}/{experiment_id}",
                "env": env,
            },
            order=self.order,
            serialization_error=self.context_error,
        )

    def create_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        attempt_index: int,
        run_name: str,
    ) -> dict[str, Any]:
        self.order.append("tracking.create")
        call = {
            "project_id": project_id,
            "experiment_id": experiment_id,
            "attempt_index": attempt_index,
            "run_name": run_name,
        }
        self.create_calls.append(call)
        if self.create_error is not None:
            raise self.create_error
        return deepcopy(self.create_result)

    def finalize_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str,
        status: str,
        wait_seconds: float,
    ) -> dict[str, Any]:
        self.order.append("tracking.finalize")
        call = {
            "project_id": project_id,
            "experiment_id": experiment_id,
            "run_id": run_id,
            "status": status,
            "wait_seconds": wait_seconds,
        }
        self.finalize_calls.append(call)
        if self.finalize_error is not None:
            raise self.finalize_error
        return deepcopy(self.finalize_result)

    def results_metrics(
        self, *, project_id: str, experiment_id: str
    ) -> dict[str, Any]:  # pragma: no cover - the exhibit collaborator owns this read
        raise AssertionError("TransitionExperiment must use its exhibit collaborator")


class LostAck:
    """A write that COMMITS and then fails to acknowledge.

    The only honest model of an ambiguous commit: the durable event and the
    current row both move, and the caller still sees an exception. A fake that
    merely raises cannot distinguish a landed write from stale matching state.
    """

    def __init__(self, error: Exception) -> None:
        self.error = error


class RecordingResearch:
    def __init__(
        self,
        order: list[str],
        *,
        before: dict[str, Any] | None = None,
        committed: dict[str, Any] | None = None,
        event: StoredEvent | None = None,
        persisted: dict[str, Any] | None = None,
        transition_error: Exception | None = None,
        persistence_error: Exception | None = None,
        persistence_errors: list[Exception | LostAck | None] | None = None,
    ) -> None:
        self.order = order
        self.workflow_revision, self.workflow_outcome = 7, ""
        self.workflows = SimpleNamespace(
            runtime=SimpleNamespace(
                get=lambda **kwargs: SimpleNamespace(
                    revision=self.workflow_revision,
                    outcome=self.workflow_outcome,
                    state=str(self.before["status"]),
                    id=EXPERIMENT_ID,
                    project_id=PROJECT_ID,
                )
            ),
            deliveries=SimpleNamespace(
                protect_external_effect=lambda *args, **kwargs: True,
                resolve_manual_repair=lambda **kwargs: None,
            ),
        )
        self.before = before or _state("running", run=_open_run(), token="before")
        self.committed = committed or _state("running", run=_open_run())
        self.event = event or _event("approve_design")
        self.persisted = persisted
        self.transition_error = transition_error
        self.persistence_error = persistence_error
        # Per-call outcomes, so a transient failure can be followed by success.
        self.persistence_errors: list[Exception | LostAck | None] = list(
            persistence_errors or []
        )
        # The mutable experiments row: any delivery's write overwrites it.
        self.current: dict[str, Any] | None = None
        # The append-only ledger, keyed by the delivery that appended it.
        self.ledger: dict[int, dict[str, Any]] = {}
        # Set by tests that make the durable re-read itself unavailable.
        self.state_error: Exception | None = None
        self.ledger_error: Exception | None = None
        self.transition_committed = False
        self.transition_calls: list[dict[str, Any]] = []
        self.persist_calls: list[dict[str, Any]] = []
        self.delivery_reads: list[int] = []
        self.verdicts: list[dict[str, Any]] = []
        self.exhibit_calls = []
        self.exhibit_error = None

    def experiment_state(
        self, *, experiment_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        self.order.append("research.state")
        if self.state_error is not None:
            raise self.state_error
        return self.before

    def transition_experiment(
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

    def record_tracking_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run: dict[str, Any],
        event_type: str | None = None,
        delivery_id: int | None = None,
    ) -> dict[str, Any]:
        self.order.append("research.record_tracking")
        self.persist_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "run": deepcopy(run),
                "event_type": event_type,
                "delivery_id": delivery_id,
            }
        )
        if delivery_id is not None and int(delivery_id) in self.ledger:
            return self.current or self.ledger[int(delivery_id)]
        failure = (
            self.persistence_errors.pop(0)
            if self.persistence_errors
            else self.persistence_error
        )
        if failure is None or isinstance(failure, LostAck):
            state = self._commit(run=run, delivery_id=delivery_id)
        if isinstance(failure, LostAck):
            raise failure.error
        if failure is not None:
            raise failure
        return state

    def _commit(
        self, *, run: dict[str, Any], delivery_id: int | None
    ) -> dict[str, Any]:
        """One write: the mutable row moves and the ledger gains one entry."""
        if self.persisted is not None:
            state = self.persisted
        else:
            state = dict(self.committed)
            state["mlflow_run"] = deepcopy(run)
        if delivery_id is not None:
            state = deepcopy(state)
            state.setdefault("mlflow_run", {})["delivery_id"] = int(delivery_id)
        self.current = state
        if delivery_id is not None:
            self.ledger[int(delivery_id)] = state
        return state

    def refresh_tracking_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run: dict[str, Any],
        if_current: bool = False,
        expected_run_id: str | None = None,
    ) -> CommittedExperimentTransition | None:
        self.order.append("research.record_tracking")
        self.persist_calls.append(
            {
                "project_id": project_id,
                "experiment_id": experiment_id,
                "run": deepcopy(run),
                "event_type": "experiment.mlflow_run_refreshed",
                "delivery_id": None,
                "if_current": if_current,
            }
        )
        if self.persistence_error is not None:
            raise self.persistence_error
        current = self.current or self.before
        if expected_run_id is not None and str((current.get("mlflow_run") or {}).get("run_id") or "") != expected_run_id:
            return None
        if if_current and (current.get("mlflow_run") or {}).get("run_id") != run.get(
            "run_id"
        ):
            return None
        state = self._commit(run=run, delivery_id=None)
        return CommittedExperimentTransition(
            state=state,
            event=_event(
                "refresh_tracking",
                event_type="experiment.mlflow_run_refreshed",
            ),
        )

    def tracking_delivery_state(
        self, *, project_id: str, experiment_id: str, delivery_id: int
    ) -> dict[str, Any] | None:
        self.order.append("research.tracking_delivery")
        self.delivery_reads.append(int(delivery_id))
        if self.ledger_error is not None:
            raise self.ledger_error
        # A landed delivery reads back whatever the row now holds, exactly as
        # the real re-read does — a later delivery may have superseded it.
        return None if int(delivery_id) not in self.ledger else self.current

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
    tracking: RecordingTracking | None,
    exhibits: RecordingExhibits,
    objects: RecordingObjects | None = None,
) -> TransitionExperiment:
    objects = objects or RecordingObjects(research.order)
    return TransitionExperiment(
        research=research,
        artifacts=artifacts,
        feed=feed,
        mlflow=MlflowIntegration(
            research=research,
            feed=feed,
            objects=objects,
            adapter=tracking,
        ),
        exhibits=exhibits,
        objects=objects,
    )


class TransitionStoragePrefetchTest(unittest.TestCase):
    def test_catalog_failure_prevents_exhibit_and_transition_side_effects(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        artifacts = RecordingArtifacts(order)
        feed = RecordingFeed(order)
        tracking = RecordingTracking(order)
        exhibits = RecordingExhibits(order)
        use_case = _use_case(
            research=research,
            artifacts=artifacts,
            feed=feed,
            tracking=tracking,
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
        self.assertEqual(tracking.create_calls, [])
        self.assertEqual(feed.calls, [])


class TrackingDeliveryTest(unittest.TestCase):
    def fixture(
        self,
        *,
        state=None,
        create_result=None,
        create_error=None,
        persistence_errors=None,
        persistence_error=None,
    ):
        order = []
        state = state or _state("running", run=None)
        research = RecordingResearch(
            order,
            before=state,
            committed=state,
            persistence_errors=persistence_errors,
            persistence_error=persistence_error,
        )
        tracking = RecordingTracking(
            order, create_result=create_result, create_error=create_error
        )
        integration = MlflowIntegration(
            research=research,
            feed=RecordingFeed(order),
            objects=RecordingObjects(order),
            adapter=tracking,
        )
        return integration, research, tracking, order

    def start(self, integration, research, *, delivery_id=41):
        return integration._ensure_run(
            state=research.before, replace_terminal=True, delivery_id=delivery_id
        )

    def test_approval_commit_does_not_start_tracking(self):
        integration, research, tracking, order = self.fixture(
            create_result=_created_run()
        )
        use_case = _use_case(
            research=research,
            artifacts=RecordingArtifacts(order),
            feed=RecordingFeed(order),
            tracking=tracking,
            exhibits=RecordingExhibits(order),
        )
        result = use_case.execute(
            experiment_id=EXPERIMENT_ID,
            transition="approve_design",
            project_id=PROJECT_ID,
        )
        self.assertTrue(research.transition_committed)
        self.assertEqual(result["status"], "running")
        self.assertEqual(tracking.create_calls, [])
        self.assertEqual(research.persist_calls, [])

    def test_start_delivery_creates_and_persists_normalized_run_with_event_identity(
        self,
    ):
        integration, research, tracking, order = self.fixture(
            create_result=_created_run()
        )
        integration.deliver_workflow_action(_delivery("experiment.start_tracking"))
        self.assertEqual(
            tracking.create_calls,
            [
                {
                    "project_id": PROJECT_ID,
                    "experiment_id": EXPERIMENT_ID,
                    "attempt_index": 3,
                    "run_name": f"{EXPERIMENT_ID}-attempt-3",
                }
            ],
        )
        run = research.persist_calls[0]["run"]
        self.assertEqual(run["run_id"], "run_new")
        self.assertEqual(run["status"], "RUNNING")
        self.assertTrue(run["created_by_plugin"])
        self.assertNotIn("configured", run)
        self.assertNotIn("dashboard_run_url", run)
        self.assertEqual(set(research.ledger), {41})
        self.assertEqual(research.current["mlflow_run"]["delivery_id"], 41)
        self.assertLess(
            order.index("tracking.create"), order.index("research.record_tracking")
        )

    def test_delayed_start_cannot_create_tracking_for_a_new_node_or_completed_workflow(
        self,
    ):
        for revision, outcome in ((8, ""), (7, "completed")):
            with self.subTest(revision=revision, outcome=outcome):
                integration, research, tracking, order = self.fixture(
                    create_result=_created_run()
                )
                research.workflow_revision, research.workflow_outcome = (
                    revision,
                    outcome,
                )
                integration.deliver_workflow_action(
                    _delivery("experiment.start_tracking")
                )
                self.assertEqual(tracking.create_calls, [])
                self.assertEqual(research.persist_calls, [])

    def test_start_reuses_open_run_and_error_only_redelivery_without_another_remote_create(
        self,
    ):
        for run in (
            _open_run(),
            {"run_id": None, "error": "prior outage", "delivery_id": 41},
        ):
            with self.subTest(run=run):
                integration, research, tracking, order = self.fixture(
                    state=_state("running", run=run), create_result=_created_run()
                )
                result, attempted = self.start(integration, research)
                self.assertEqual(result["mlflow_run"], run)
                self.assertEqual(tracking.create_calls, [])
                self.assertEqual(research.persist_calls, [])

    def test_explicit_retry_replaces_terminal_run_for_same_attempt(self):
        integration, research, tracking, order = self.fixture(
            state=_state("running", run={**_open_run(), "status": "FAILED"}),
            create_result=_created_run("retry-run"),
        )
        result, attempted = self.start(integration, research)
        self.assertTrue(attempted)
        self.assertEqual(result["mlflow_run"]["run_id"], "retry-run")
        self.assertEqual(tracking.create_calls[0]["attempt_index"], 3)

    def test_absent_tracking_capabilities_make_no_attempt(self):
        integration, research, tracking, order = self.fixture(
            state=_state("running", run={"error": "earlier outage"})
        )
        tracking._capabilities = TrackingCapabilities(
            logging=False, control=False, readback=False
        )
        result, attempted = self.start(integration, research)
        self.assertFalse(attempted)
        self.assertEqual(result["mlflow_run"]["error"], "earlier outage")
        self.assertEqual(tracking.create_calls, [])
        self.assertEqual(research.persist_calls, [])

    def test_adapter_returned_error_and_exception_become_durable_degraded_outcomes(
        self,
    ):
        for create_result, create_error, expected in (
            (
                {"error": "control unavailable", "configured": True},
                None,
                "control unavailable",
            ),
            (
                None,
                RuntimeError("control unavailable"),
                "MLflow run creation failed: control unavailable",
            ),
        ):
            with self.subTest(expected=expected):
                integration, research, tracking, order = self.fixture(
                    create_result=create_result, create_error=create_error
                )
                with self.assertLogs(REACTIONS_LOGGER, level="ERROR"):
                    result, attempted = self.start(integration, research)
                self.assertTrue(attempted)
                self.assertEqual(result["mlflow_run"]["error"], expected)
                self.assertNotIn("configured", research.persist_calls[0]["run"])
                self.assertEqual(set(research.ledger), {41})

    def test_retry_after_rollback_or_lost_ack_creates_one_remote_run_and_one_ledger_entry(
        self,
    ):
        for failure in (
            RuntimeError("connection reset"),
            LostAck(RuntimeError("ack lost")),
        ):
            with self.subTest(failure=failure):
                integration, research, tracking, order = self.fixture(
                    create_result=_created_run(), persistence_errors=[failure]
                )
                with self.assertLogs(REACTIONS_LOGGER, level="ERROR"):
                    result, attempted = self.start(integration, research)
                self.assertEqual(len(tracking.create_calls), 1)
                self.assertEqual(len(research.persist_calls), 2)
                self.assertEqual(set(research.ledger), {41})
                self.assertEqual(result["mlflow_run"]["run_id"], "run_new")

    def test_prior_delivery_with_identical_error_does_not_mask_this_outcome(self):
        prior = _state(
            "running",
            run={"error": "MLflow run creation failed: unavailable", "delivery_id": 7},
        )
        integration, research, tracking, order = self.fixture(
            state=prior,
            create_error=RuntimeError("unavailable"),
            persistence_errors=[RuntimeError("first write rolled back")],
        )
        research.ledger[7], research.current = prior, prior
        with self.assertLogs(REACTIONS_LOGGER, level="ERROR"):
            result, attempted = self.start(integration, research)
        self.assertEqual(set(research.ledger), {7, 41})
        self.assertEqual(result["mlflow_run"]["delivery_id"], 41)
        self.assertEqual(len(tracking.create_calls), 1)

    def test_lost_ack_then_rival_write_does_not_restore_the_older_run(self):
        integration, research, tracking, order = self.fixture(
            create_result=_created_run(),
            persistence_errors=[LostAck(RuntimeError("ack lost"))],
        )
        rival = _state("running", run={**_open_run("rival"), "delivery_id": 99})
        original_write = research.record_tracking_run
        calls = 0

        def rival_wins(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                research.current, research.ledger[99] = rival, rival
            return original_write(**kwargs)

        research.record_tracking_run = rival_wins
        with self.assertLogs(REACTIONS_LOGGER, level="ERROR"):
            result, attempted = self.start(integration, research)
        self.assertEqual(set(research.ledger), {41, 99})
        self.assertEqual(result["mlflow_run"]["run_id"], "rival")
        self.assertEqual(len(tracking.create_calls), 1)

    def test_double_persistence_failure_preserves_orphan_id_and_adapter_cause(self):
        for adapter_fails in (False, True):
            with self.subTest(adapter_fails=adapter_fails):
                integration, research, tracking, order = self.fixture(
                    create_result=None if adapter_fails else _created_run(),
                    create_error=RuntimeError("control down")
                    if adapter_fails
                    else None,
                    persistence_error=RuntimeError("database unavailable"),
                )
                with self.assertLogs(REACTIONS_LOGGER, level="ERROR") as logs:
                    with self.assertRaises(TrackingPersistenceError) as caught:
                        self.start(integration, research)
                self.assertEqual(len(tracking.create_calls), 1)
                self.assertEqual(len(research.persist_calls), 2)
                self.assertEqual(research.ledger, {})
                message = str(caught.exception)
                self.assertIn("database unavailable", message)
                self.assertIn("may or may not exist", message)
                self.assertIn("experiment.get_state", message)
                self.assertIn("control down" if adapter_fails else "run_new", message)
                self.assertIn(
                    "orphaned run: none" if adapter_fails else "orphaned run: run_new",
                    "\n".join(logs.output),
                )

    def test_terminal_delivery_finalizes_the_pinned_old_run_instead_of_current_pointer(
        self,
    ):
        for kind, status in (
            ("experiment.finish_tracking", "FINISHED"),
            ("experiment.stop_tracking", "KILLED"),
            ("experiment.fail_tracking", "FAILED"),
        ):
            with self.subTest(kind=kind):
                integration, research, tracking, order = self.fixture(
                    state=_state(
                        "running", attempt_index=4, run=_open_run("new-attempt")
                    )
                )
                tracking.finalize_result = {
                    "run": {**_open_run("old-attempt"), "status": status}
                }
                integration.deliver_workflow_action(
                    _delivery(kind, data={"run_id": "old-attempt"})
                )
                self.assertEqual(
                    tracking.finalize_calls[0],
                    {
                        "project_id": PROJECT_ID,
                        "experiment_id": EXPERIMENT_ID,
                        "run_id": "old-attempt",
                        "status": status,
                        "wait_seconds": 0.0,
                    },
                )
                self.assertTrue(research.persist_calls[0]["if_current"])
                self.assertIsNone(research.current)
                self.assertEqual(research.before["mlflow_run"]["run_id"], "new-attempt")

    def test_terminal_delivery_error_propagates_for_outbox_retry(self):
        integration, research, tracking, order = self.fixture()
        tracking.finalize_error = RuntimeError("temporary tracking outage")
        with self.assertRaisesRegex(RuntimeError, "temporary tracking outage"):
            integration.deliver_workflow_action(
                _delivery("experiment.finish_tracking", data={"run_id": "old"})
            )
        self.assertEqual(research.persist_calls, [])

    def test_terminal_delivery_without_pinned_run_has_no_remote_effect(self):
        integration, research, tracking, order = self.fixture(
            state=_state("complete", run=_open_run("current"))
        )
        integration.deliver_workflow_action(_delivery("experiment.finish_tracking"))
        self.assertEqual(tracking.finalize_calls, [])
        self.assertEqual(research.persist_calls, [])


class FeedTransitionReactionTest(unittest.TestCase):
    def _execute(
        self,
        *,
        status: str,
        transition: str,
        event: StoredEvent | None = None,
        feed_note: str | None = "feed note",
        feed_error: Exception | None = None,
        tracking: RecordingTracking | None = None,
        research: RecordingResearch | None = None,
    ) -> tuple[dict[str, Any], RecordingFeed, RecordingResearch, list[str]]:
        order = tracking.order if tracking is not None else []
        committed = _state(status, run=None)
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
            tracking=tracking,
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
        result, feed, research, _order = self._execute(
            status="complete",
            transition="complete",
            feed_error=RuntimeError("feed unavailable"),
        )
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

    def test_feed_query_is_after_response_context_assembly_and_none_stays_absent(
        self,
    ) -> None:
        order: list[str] = []
        tracking = RecordingTracking(order)
        result, feed, _research, observed = self._execute(
            status="complete",
            transition="complete",
            feed_note=None,
            tracking=tracking,
        )

        self.assertEqual(len(feed.calls), 1)
        self.assertNotIn("feed_note", result)
        self.assertLess(
            observed.index("tracking.context.serialize"),
            observed.index("feed.advisory"),
        )

    def test_context_assembly_failure_degrades_to_a_warning_after_commit(self) -> None:
        order: list[str] = []
        tracking = RecordingTracking(
            order, context_error=RuntimeError("context serialization failed")
        )
        committed = _state("complete", run=None)
        research = RecordingResearch(
            order, committed=committed, event=_event("complete")
        )
        feed = RecordingFeed(order)
        use_case = _use_case(
            research=research,
            artifacts=RecordingArtifacts(order),
            feed=feed,
            tracking=tracking,
            exhibits=RecordingExhibits(order),
        )

        with self.assertLogs(PRESENTATION_LOGGER, level="ERROR") as logs:
            result = use_case.execute(
                experiment_id=EXPERIMENT_ID,
                transition="complete",
                project_id=PROJECT_ID,
            )

        # A committed transition is never reported as a failure, and the half
        # written context block never survives into the response.
        self.assertTrue(research.transition_committed)
        self.assertEqual(result["status"], "complete")
        self.assertNotIn("mlflow", result)
        self.assertNotIn("mlflow_guidance", result)
        self.assertEqual(
            result["mlflow_warning"]["error"], "context serialization failed"
        )
        self.assertIn("mlflow.context", result["mlflow_warning"]["repair"])
        self.assertIn("context serialization failed", "\n".join(logs.output))
        self.assertEqual(len(feed.calls), 1)


class SubmitResultsExhibitPrerequisiteTest(unittest.TestCase):
    def _fixture(
        self,
        *,
        pin_error: Exception | None = None,
        transition_error: Exception | None = None,
        before_status: str = "running",
        runs_found: int = 1,
    ) -> tuple[
        TransitionExperiment,
        RecordingResearch,
        RecordingArtifacts,
        RecordingTracking,
        RecordingFeed,
        RecordingExhibits,
        list[str],
    ]:
        order: list[str] = []
        run = _open_run()
        research = RecordingResearch(
            order,
            before=_state(before_status, run=run, token="before"),
            committed=_state("experiment_review", run=run),
            event=_event("submit_results"),
            transition_error=transition_error,
        )
        research.exhibit_error = pin_error
        artifacts = RecordingArtifacts(order)
        tracking = RecordingTracking(
            order,
            finalize_result={"run": {**run, "status": "FINISHED"}},
        )
        feed = RecordingFeed(order)
        exhibits = RecordingExhibits(order, exhibit=_exhibit(runs_found=runs_found))
        return (
            _use_case(
                research=research,
                artifacts=artifacts,
                feed=feed,
                tracking=tracking,
                exhibits=exhibits,
            ),
            research,
            artifacts,
            tracking,
            feed,
            exhibits,
            order,
        )

    def test_verdict_and_pin_are_one_fenced_capability_before_transition(self):
        use_case, research, artifacts, tracking, feed, exhibits, order = self._fixture()
        research.before["current_attempt_artifacts"] = [
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
        self.assertEqual(recorded["verdict"]["runs_found"], 1)
        self.assertTrue(recorded["verdict"]["pinned"])
        self.assertEqual(json.loads(recorded["artifact_data"]), _exhibit())
        self.assertEqual(
            recorded["artifact_path"],
            "experiments/A_Characterized_Experiment/metrics_exhibit.json",
        )
        self.assertEqual(research.transition_calls[0]["expected_revision"], 7)
        self.assertEqual(artifacts.pins, [])
        self.assertEqual(tracking.finalize_calls, [])
        self.assertEqual(
            result["metrics_exhibit"],
            {
                "pinned": True,
                "path": recorded["artifact_path"],
                "verdict": {"runs_found": 1, "result_files": 0},
            },
        )

    def test_atomic_recorder_failure_stops_transition_and_external_effects(self):
        use_case, research, artifacts, tracking, feed, exhibits, order = self._fixture(
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
        self.assertEqual(tracking.finalize_calls, [])
        self.assertEqual(feed.calls, [])

    def test_transition_after_preparation_still_receives_the_original_revision(self):
        use_case, research, artifacts, tracking, feed, exhibits, order = self._fixture(
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
        self.assertEqual(tracking.finalize_calls, [])
        self.assertEqual(feed.calls, [])

    def test_submit_from_non_running_state_skips_exhibit_prerequisite(self) -> None:
        use_case, research, artifacts, _tracking, _feed, exhibits, order = (
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


class TrackingCredentialFlagTest(unittest.TestCase):
    def test_execute_passes_the_explicit_credential_flag_to_context(self) -> None:
        for include_credentials in (False, True):
            with self.subTest(include_credentials=include_credentials):
                order: list[str] = []
                committed = _state("running", run=_open_run())
                research = RecordingResearch(
                    order,
                    committed=committed,
                    event=_event("approve_design"),
                )
                tracking = RecordingTracking(order)
                use_case = _use_case(
                    research=research,
                    artifacts=RecordingArtifacts(order),
                    feed=RecordingFeed(order),
                    tracking=tracking,
                    exhibits=RecordingExhibits(order),
                )

                result = use_case.execute(
                    experiment_id=EXPERIMENT_ID,
                    transition="approve_design",
                    project_id=PROJECT_ID,
                    include_tracking_credentials=include_credentials,
                )

                self.assertEqual(
                    tracking.context_calls[0]["include_credentials"],
                    include_credentials,
                )
                password = result["mlflow"]["env"].get("MLFLOW_TRACKING_PASSWORD")
                self.assertEqual(
                    password,
                    "credential-for-public-response" if include_credentials else None,
                )


class RealTrackingDeliveryTest(ResearchCase):
    def test_late_terminal_readback_cannot_overwrite_a_new_run(self):
        experiment = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="tracking-replacement",
            intent="Preserve the current run pointer.",
        )
        experiment_id = experiment["id"]
        research = self.app.research
        research.refresh_tracking_run(
            project_id=self.project_id,
            experiment_id=experiment_id,
            run=_open_run("old-run"),
        )
        tracking = RecordingTracking(
            [],
            finalize_result={
                "run": {**_open_run("old-run"), "status": "FINISHED"},
            },
        )
        finalize = tracking.finalize_run

        def replaced_during_finalize(**kwargs):
            result = finalize(**kwargs)
            research.refresh_tracking_run(
                project_id=self.project_id,
                experiment_id=experiment_id,
                run=_open_run("new-run"),
            )
            return result

        tracking.finalize_run = replaced_during_finalize
        self.app.application._mlflow.adapter = tracking
        self.app.application._mlflow.deliver_workflow_action(
            Delivery(
                "late-finish",
                self.project_id,
                experiment_id,
                0,
                "experiment.finish_tracking",
                {"run_id": "old-run"},
                "lease",
                1,
            )
        )
        current = research.experiment_state(
            project_id=self.project_id, experiment_id=experiment_id
        )
        self.assertEqual(current["mlflow_run"]["run_id"], "new-run")
        self.assertEqual(current["mlflow_run"]["status"], "RUNNING")
        self.assertEqual(tracking.finalize_calls[0]["run_id"], "old-run")

    def test_approval_activation_delivery_and_terminal_retry_have_distinct_boundaries(
        self,
    ):
        tracking = RecordingTracking([], create_result=_created_run())
        self.app.application._mlflow.adapter = tracking
        self.call("project.update", project_id=self.project_id, agent_dispatch=True)
        experiment = self.call(
            "experiment.create",
            project_id=self.project_id,
            name="tracking-boundaries",
            intent="Exercise tracking lifecycle.",
        )
        experiment_id = experiment["id"]
        self.submit(
            target_type="experiment",
            target_id=experiment_id,
            role="plan",
            body=VALID_PLAN,
        )
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition="submit_design",
        )
        self.pass_review(
            target_type="experiment", target_id=experiment_id, role="design_reviewer"
        )
        self.assertEqual(
            self.app.research.workflows.runtime.get(
                project_id=self.project_id, instance_id=experiment_id
            ).state,
            "running",
        )
        self.assertIsNone(
            self.app.research.attempt_started_running_at(experiment_id=experiment_id)
        )
        self.assertEqual(tracking.create_calls, [])

        secret = "mas_" + "x" * 43
        offered = self.app.application.lease_agent_session(
            project_id=self.project_id,
            runner_id="runner",
            platform="codex",
            idempotency_key="tracking",
            session_secret=secret,
        )["session"]
        self.assertEqual(offered["workflow_node"], "running")
        self.assertEqual(tracking.create_calls, [])
        self.app.agent_sessions.authenticate(session_secret=secret)
        self.assertIsNotNone(
            self.app.research.attempt_started_running_at(experiment_id=experiment_id)
        )
        self.assertEqual(tracking.create_calls, [])
        self.app.application.workflow_deliveries.run_once(
            project_id=self.project_id, renew_interval_seconds=0
        )
        recorded = self.app.research.experiment_state(
            project_id=self.project_id, experiment_id=experiment_id
        )["mlflow_run"]
        self.assertEqual(recorded["run_id"], "run_new")
        self.assertEqual(len(tracking.create_calls), 1)
        self.app.agent_sessions.authenticate(session_secret=secret)
        self.app.application.workflow_deliveries.run_once(
            project_id=self.project_id, renew_interval_seconds=0
        )
        self.assertEqual(len(tracking.create_calls), 1)

        tracking.finalize_error = RuntimeError("temporary finish outage")
        self.call(
            "experiment.transition",
            project_id=self.project_id,
            experiment_id=experiment_id,
            transition="abandon",
        )
        failed = self.app.application.workflow_deliveries.run_once(
            project_id=self.project_id, renew_interval_seconds=0
        )
        self.assertEqual(failed["failed"], 1)
        with self.app.store.transaction() as conn:
            row = conn.execute(
                "SELECT id, status, data_json FROM workflow_actions WHERE instance_id = ? AND kind = 'experiment.stop_tracking'",
                (experiment_id,),
            ).fetchone()
            self.assertEqual(row["status"], "pending")
            self.assertEqual(json.loads(row["data_json"])["run_id"], "run_new")
            conn.execute(
                "UPDATE workflow_actions SET next_attempt_at = '' WHERE id = ?",
                (row["id"],),
            )
        tracking.finalize_error = None
        self.app.application.workflow_deliveries.run_once(
            project_id=self.project_id, renew_interval_seconds=0
        )
        self.assertEqual(
            [call["run_id"] for call in tracking.finalize_calls], ["run_new", "run_new"]
        )
        self.assertEqual(
            [call["status"] for call in tracking.finalize_calls], ["KILLED", "KILLED"]
        )
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secret))


if __name__ == "__main__":
    unittest.main()
