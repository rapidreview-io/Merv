from __future__ import annotations

import unittest
from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

from merv.brain.application.mlflow import MlflowIntegration
from merv.brain.kernel.events import StoredEvent, freeze_json_object
from merv.brain.research_core.models import (
    CommittedExperimentUpdate as CommittedTrackingRunRefresh,
)

PRESENTATION_LOGGER = "merv.brain.application.mlflow"
PROJECT_ID = "proj_1"
EXPERIMENT_ID = "exp_1"


def _event() -> StoredEvent:
    return StoredEvent(
        id=73,
        project_id=PROJECT_ID,
        type="experiment.mlflow_run_refreshed",
        target_type="experiment",
        target_id=EXPERIMENT_ID,
        payload=freeze_json_object(
            {
                "run_id": "run_mine",
                "run_name": "owned",
                "status": "FINISHED",
                "error": "",
                "previous_run_id": "run_mine",
            }
        ),
        created_at="2026-07-19T18:00:00Z",
    )


def _state(*, run_id: str = "run_mine", run_status: str = "RUNNING") -> dict[str, Any]:
    return {
        "id": EXPERIMENT_ID,
        "project_id": PROJECT_ID,
        "name": "Tracking Slice",
        "intent": "Preserve the wire contract",
        "status": "running",
        "attempt_index": 1,
        "mlflow_run": {
            "run_id": run_id,
            "run_name": "owned",
            "status": run_status,
            "created_by_plugin": True,
        },
    }


class _Context:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def to_dict(self) -> dict[str, Any]:
        return deepcopy(self.payload)


class RecordingResearch:
    def __init__(
        self,
        order: list[str],
        *,
        state: dict[str, Any] | None = None,
        refreshed: dict[str, Any] | None = None,
        refresh_error: Exception | None = None,
    ) -> None:
        self.order = order
        self.state = state or _state()
        self.refreshed = refreshed or _state(run_status="FINISHED")
        self.refresh_error = refresh_error
        self.refresh_calls: list[dict[str, Any]] = []
        self.project_calls: list[str] = []
        self.event = _event()
        self.workflows = SimpleNamespace(deliveries=SimpleNamespace(
            resolve_manual_repair=lambda **kwargs: None,
            needs_manual_repair=lambda **kwargs: False,
        ))

    def experiment_state(self, **kwargs: Any) -> dict[str, Any]:
        self.order.append("research.state")
        return deepcopy(self.state)

    def project_experiment_summaries(self, *, project_id: str) -> list[dict[str, Any]]:
        self.order.append("research.project_experiment_summaries")
        self.project_calls.append(project_id)
        return [deepcopy(self.state)]

    def refresh_tracking_run(self, **kwargs: Any) -> CommittedTrackingRunRefresh:
        self.order.append("research.refresh")
        self.refresh_calls.append(deepcopy(kwargs))
        if self.refresh_error is not None:
            raise self.refresh_error
        return CommittedTrackingRunRefresh(
            state=deepcopy(self.refreshed), event=self.event
        )


class RecordingTracking:
    def __init__(
        self,
        order: list[str],
        *,
        finalize_result: dict[str, Any] | None = None,
        finalize_error: Exception | None = None,
        context_error: Exception | None = None,
    ) -> None:
        self.order = order
        self.context_error = context_error
        self.finalize_result = finalize_result or {
            "configured": True,
            "run_id": "run_mine",
            "terminal": True,
            "run": {
                "run_id": "run_mine",
                "run_name": "owned",
                "status": "FINISHED",
            },
        }
        self.finalize_error = finalize_error
        self.context_calls: list[dict[str, Any]] = []
        self.project_context_calls: list[dict[str, Any]] = []
        self.finalize_calls: list[dict[str, Any]] = []

    def context(self, **kwargs: Any) -> _Context:
        self.order.append("tracking.context")
        self.context_calls.append(kwargs)
        if self.context_error is not None:
            raise self.context_error
        return _Context(
            {
                "configured": True,
                "experiment_name": f"merv/{kwargs['project_id']}/{kwargs['experiment_id']}",
                "env": {
                    "MLFLOW_TRACKING_URI": "https://tracking.test",
                    "MLFLOW_TRACKING_PASSWORD": "public-secret",
                },
            }
        )

    def project_context(self, **kwargs: Any) -> dict[str, Any]:
        self.order.append("tracking.project_context")
        self.project_context_calls.append(kwargs)
        return {
            "configured": True,
            "tracking_uri": "https://tracking.test",
            "experiment_namespace_prefix": f"merv/{kwargs['project_id']}/",
            "env": {"MLFLOW_TRACKING_PASSWORD": "public-secret"},
        }

    def finalize_run(self, **kwargs: Any) -> dict[str, Any]:
        self.order.append("tracking.finalize")
        self.finalize_calls.append(kwargs)
        if self.finalize_error is not None:
            raise self.finalize_error
        return deepcopy(self.finalize_result)


class OverviewTracking:
    def __init__(
        self,
        *,
        reachable: bool = True,
        has_runs: bool = True,
        failure_hint: str = "",
    ) -> None:
        self.reachable = reachable
        self.has_runs = has_runs
        self.failure_hint = failure_hint
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def health(self) -> dict[str, bool]:
        self.calls.append(("health", {}))
        return {"configured": True, "reachable": self.reachable}

    def project_results_snapshot(self, **kwargs: Any):
        self.calls.append(("project_results_snapshot", kwargs))
        project_id = kwargs["project_id"]
        experiment_ids = kwargs["experiment_ids"]
        if not self.has_runs or not experiment_ids:
            mapped = {}
        else:
            mapped = {
                f"merv/{project_id}/{experiment_id}": {
                    "experiment_id": str(index),
                    "name": f"merv/{project_id}/{experiment_id}",
                    "runs": [{"run_id": f"run_{index}"}],
                }
                for index, experiment_id in enumerate(experiment_ids, start=7)
            }
        rows = [
            {
                "name": f"merv/{project_id}/{experiment_id}",
                "experiment_id": str(index),
                "dashboard_experiment_url": (
                    f"https://tracking.test/#/experiments/{index}"
                ),
            }
            for index, experiment_id in enumerate(experiment_ids, start=7)
        ]
        rows.append({"name": f"merv/{project_id}/stray", "experiment_id": "8"})
        return mapped, rows, self.failure_hint


class RecordingFeed:
    def __init__(
        self, order: list[str], *, note: str | None = "Share it.", raises: bool = False
    ) -> None:
        self.order = order
        self.note = note
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    def advisory(self, **kwargs: Any) -> str | None:
        self.order.append("feed.advisory")
        self.calls.append(kwargs)
        if self.raises:
            raise RuntimeError("feed unavailable")
        return self.note


class RecordingObjects:
    def __init__(
        self,
        order: list[str],
        *,
        error: Exception | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.order = order
        self.error = error
        self.rows = rows or []
        self.calls: list[dict[str, Any]] = []

    def by_experiment(self, **kwargs: Any) -> dict[str, list[dict[str, Any]]]:
        self.order.append("objects.by_experiment")
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {
            experiment_id: deepcopy(self.rows)
            for experiment_id in kwargs["experiment_ids"]
        }


def _mlflow(*, research, tracking, feed=None, objects=None) -> MlflowIntegration:
    return MlflowIntegration(
        research=research,
        feed=feed or RecordingFeed([]),
        objects=objects or RecordingObjects([]),
        adapter=tracking,
    )


def _overview(*, summaries, tracking):
    research = Mock()
    research.project_experiment_summaries.return_value = summaries
    return _mlflow(research=research, tracking=tracking).overview(
        project_id=PROJECT_ID
    )


class MlflowContextTest(unittest.TestCase):
    def test_project_context_uses_port_and_research_namespace_map(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order)

        result = _mlflow(research=research, tracking=tracking).context(
            project_id=PROJECT_ID
        )

        self.assertEqual(result["scope"], "project")
        self.assertEqual(result["project_id"], PROJECT_ID)
        self.assertEqual(
            result["mlflow"]["experiments"],
            [
                {
                    "experiment_id": EXPERIMENT_ID,
                    "name": "Tracking Slice",
                    "status": "running",
                    "intent": "Preserve the wire contract",
                    "mlflow_experiment_name": f"merv/{PROJECT_ID}/{EXPERIMENT_ID}",
                }
            ],
        )
        self.assertEqual(
            tracking.project_context_calls,
            [{"project_id": PROJECT_ID, "include_credentials": True}],
        )
        self.assertEqual(research.project_calls, [PROJECT_ID])
        self.assertEqual(
            order,
            ["tracking.project_context", "research.project_experiment_summaries"],
        )

    def test_experiment_context_resolves_identity_and_preserves_credentials(
        self,
    ) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order)
        mlflow = _mlflow(research=research, tracking=tracking)
        result = mlflow.context(
            project_id="caller_project", experiment_id=EXPERIMENT_ID
        )

        self.assertEqual(result["project_id"], PROJECT_ID)
        self.assertEqual(result["experiment_id"], EXPERIMENT_ID)
        self.assertEqual(result["scope"], "experiment")
        self.assertEqual(result["mlflow"]["run"]["run_id"], "run_mine")
        self.assertEqual(result["mlflow"]["env"]["MLFLOW_RUN_ID"], "run_mine")
        self.assertEqual(
            tracking.context_calls[0],
            {
                "project_id": PROJECT_ID,
                "experiment_id": EXPERIMENT_ID,
                "include_credentials": True,
            },
        )
        self.assertEqual(
            result["mlflow"]["env"]["MLFLOW_TRACKING_PASSWORD"], "public-secret"
        )

    def test_unconfigured_project_context_is_exact_and_does_not_list(self) -> None:
        order: list[str] = []
        result = _mlflow(
            research=RecordingResearch(order), tracking=None
        ).context(project_id=PROJECT_ID)

        self.assertEqual(result["mlflow"], {"configured": False})
        self.assertEqual(order, [])


class MlflowFinalizeTest(unittest.TestCase):
    def _integration(
        self,
        *,
        research: RecordingResearch,
        tracking: RecordingTracking | None,
        feed: RecordingFeed,
        objects: RecordingObjects | None = None,
    ) -> MlflowIntegration:
        return _mlflow(
            research=research,
            tracking=tracking,
            feed=feed,
            objects=objects or RecordingObjects(research.order),
        )

    def test_unconfigured_response_remains_exact(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        feed = RecordingFeed(order)

        result = self._integration(
            research=research, tracking=None, feed=feed
        ).finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertEqual(
            result,
            {
                "project_id": PROJECT_ID,
                "experiment_id": EXPERIMENT_ID,
                "configured": False,
                "run_id": "run_mine",
                "error": "MLflow tracking is not configured on this backend.",
            },
        )
        self.assertEqual(order, ["research.state"])

    def test_canonical_refresh_feeds_after_the_response_is_built(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order)
        feed = RecordingFeed(order)
        mlflow = self._integration(research=research, tracking=tracking, feed=feed)

        result = mlflow.finalize(
            project_id=PROJECT_ID,
            experiment_id=EXPERIMENT_ID,
            status="FINISHED",
            wait_seconds=3.5,
        )

        self.assertEqual(
            tracking.finalize_calls,
            [
                {
                    "project_id": PROJECT_ID,
                    "experiment_id": EXPERIMENT_ID,
                    "run_id": "run_mine",
                    "status": "FINISHED",
                    "wait_seconds": 3.5,
                }
            ],
        )
        self.assertEqual(research.refresh_calls[0]["run"]["status"], "FINISHED")
        self.assertEqual(result["run"]["status"], "FINISHED")
        self.assertEqual(result["experiment"]["mlflow_run"]["status"], "FINISHED")
        self.assertEqual(result["experiment"]["mlflow"]["run"]["status"], "FINISHED")
        self.assertEqual(result["feed_note"], "Share it.")
        self.assertEqual(
            feed.calls,
            [
                {
                    "project_id": PROJECT_ID,
                    "ref": EXPERIMENT_ID,
                    "message": f"an MLflow run for {EXPERIMENT_ID} just finished",
                }
            ],
        )
        self.assertEqual(
            order,
            [
                "research.state",
                "objects.by_experiment",
                "tracking.finalize",
                "research.refresh",
                "tracking.context",
                "feed.advisory",
            ],
        )

    def test_catalog_failure_prevents_tracking_and_research_side_effects(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order)
        feed = RecordingFeed(order)
        mlflow = self._integration(
            research=research,
            tracking=tracking,
            feed=feed,
            objects=RecordingObjects(order, error=RuntimeError("catalog down")),
        )

        with self.assertRaisesRegex(RuntimeError, "catalog down"):
            mlflow.finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertEqual(order, ["research.state", "objects.by_experiment"])
        self.assertEqual(tracking.finalize_calls, [])
        self.assertEqual(research.refresh_calls, [])
        self.assertEqual(feed.calls, [])

    def test_finalize_response_retains_produced_objects(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order)
        feed = RecordingFeed(order)
        mlflow = self._integration(
            research=research,
            tracking=tracking,
            feed=feed,
            objects=RecordingObjects(
                order,
                rows=[
                    {
                        "id": "so_1",
                        "name": "models/checkpoint.bin",
                        "kind": "model",
                        "status": "available",
                    }
                ],
            ),
        )

        result = mlflow.finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertEqual(result["experiment"]["storage_objects"][0]["id"], "so_1")

    def test_foreign_readback_keeps_canonical_identity_and_current_feed_response(
        self,
    ) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(
            order,
            finalize_result={
                "configured": True,
                "terminal": True,
                "run": {"run_id": "run_foreign", "status": "FINISHED"},
            },
        )
        feed = RecordingFeed(order)
        mlflow = self._integration(research=research, tracking=tracking, feed=feed)

        result = mlflow.finalize(
            project_id=PROJECT_ID,
            experiment_id=EXPERIMENT_ID,
            run_id="run_foreign",
        )

        self.assertEqual(research.refresh_calls, [])
        self.assertEqual(result["run"]["run_id"], "run_foreign")
        self.assertEqual(result["experiment"]["mlflow_run"]["run_id"], "run_mine")
        self.assertEqual(result["feed_note"], "Share it.")

    def test_no_readback_run_does_not_persist_or_query_feed(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        tracking = RecordingTracking(order, finalize_result={"error": "not found"})
        feed = RecordingFeed(order)

        result = self._integration(
            research=research, tracking=tracking, feed=feed
        ).finalize(
            project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID
        )

        self.assertEqual(result["error"], "not found")
        self.assertEqual(research.refresh_calls, [])
        self.assertEqual(feed.calls, [])

    def test_feed_failure_is_advisory(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        result = self._integration(
            research=research,
            tracking=RecordingTracking(order),
            feed=RecordingFeed(order, raises=True),
        ).finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertNotIn("feed_note", result)
        self.assertEqual(result["experiment"]["mlflow_run"]["status"], "FINISHED")

    def test_refresh_failure_propagates_before_presentation_or_feed(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order, refresh_error=RuntimeError("db down"))
        mlflow = self._integration(
            research=research,
            tracking=RecordingTracking(order),
            feed=RecordingFeed(order),
        )

        with self.assertRaisesRegex(RuntimeError, "db down"):
            mlflow.finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertEqual(
            order,
            [
                "research.state",
                "objects.by_experiment",
                "tracking.finalize",
                "research.refresh",
            ],
        )

    def test_context_failure_after_the_refresh_degrades_to_a_warning(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        mlflow = self._integration(
            research=research,
            tracking=RecordingTracking(
                order, context_error=RuntimeError("context serialization failed")
            ),
            feed=RecordingFeed(order),
        )

        with self.assertLogs(PRESENTATION_LOGGER, level="ERROR"):
            result = mlflow.finalize(
                project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID
            )

        # The refresh already committed, so presentation cannot report failure.
        self.assertEqual(len(research.refresh_calls), 1)
        self.assertNotIn("mlflow", result["experiment"])
        self.assertEqual(
            result["mlflow_warning"]["error"], "context serialization failed"
        )
        self.assertIn("mlflow.context", result["mlflow_warning"]["repair"])
        self.assertEqual(result["experiment"]["mlflow_run"]["status"], "FINISHED")

    def test_tracking_failure_propagates_without_persistence_or_feed(self) -> None:
        order: list[str] = []
        research = RecordingResearch(order)
        mlflow = self._integration(
            research=research,
            tracking=RecordingTracking(
                order, finalize_error=RuntimeError("tracking down")
            ),
            feed=RecordingFeed(order),
        )

        with self.assertRaisesRegex(RuntimeError, "tracking down"):
            mlflow.finalize(project_id=PROJECT_ID, experiment_id=EXPERIMENT_ID)

        self.assertEqual(
            order,
            ["research.state", "objects.by_experiment", "tracking.finalize"],
        )


class MlflowOverviewTest(unittest.TestCase):
    def test_maps_research_experiments_and_reports_unmapped_names(self) -> None:
        tracking = OverviewTracking()
        result = _overview(
            summaries=[
                {
                    "id": EXPERIMENT_ID,
                    "name": "Experiment One",
                    "status": "running",
                    "intent": "Measure it",
                }
            ],
            tracking=tracking,
        )

        experiment = result["experiments"][0]
        self.assertEqual(
            experiment["mlflow_experiment_name"],
            f"merv/{PROJECT_ID}/{EXPERIMENT_ID}",
        )
        self.assertEqual(
            experiment["dashboard_experiment_url"],
            "https://tracking.test/#/experiments/7",
        )
        self.assertEqual(
            result["unmapped_mlflow_experiments"],
            [{"name": f"merv/{PROJECT_ID}/stray", "experiment_id": "8"}],
        )

    def test_batches_one_and_twenty_five_experiments(self) -> None:
        for count in (1, 25):
            with self.subTest(count=count):
                tracking = OverviewTracking()
                summaries = [
                    {
                        "id": f"exp_{index:02d}",
                        "name": f"Experiment {index}",
                        "status": "running",
                        "intent": f"Measure {index}",
                    }
                    for index in range(count)
                ]

                result = _overview(summaries=summaries, tracking=tracking)

                expected_ids = tuple(item["id"] for item in summaries)
                self.assertEqual(
                    tracking.calls,
                    [
                        ("health", {}),
                        (
                            "project_results_snapshot",
                            {
                                "project_id": PROJECT_ID,
                                "experiment_ids": expected_ids,
                            },
                        ),
                    ],
                )
                self.assertEqual(
                    [item["experiment_id"] for item in result["experiments"]],
                    list(expected_ids),
                )

    def test_unreachable_adapter_short_circuits(self) -> None:
        tracking = OverviewTracking(reachable=False)

        result = _overview(summaries=[{"id": EXPERIMENT_ID}], tracking=tracking)

        self.assertEqual(
            result["experiments"][0]["metrics"],
            {
                "experiment_id": EXPERIMENT_ID,
                "available": False,
                "source": "mlflow",
                "hint": "MLflow unreachable.",
            },
        )
        self.assertEqual(result["unmapped_mlflow_experiments"], [])
        self.assertEqual(tracking.calls, [("health", {})])

    def test_no_runs_and_batch_failure_have_distinct_hints(self) -> None:
        for failure_hint, expected_hint in (
            ("", "No MLflow runs found for this experiment yet."),
            ("MLflow unreachable.", "MLflow unreachable."),
        ):
            with self.subTest(failure_hint=failure_hint):
                result = _overview(
                    summaries=[{"id": EXPERIMENT_ID}],
                    tracking=OverviewTracking(
                        has_runs=False,
                        failure_hint=failure_hint,
                    ),
                )

                experiment = result["experiments"][0]
                self.assertEqual(experiment["metrics"]["hint"], expected_hint)
                self.assertEqual(experiment["dashboard_experiment_url"], "")
                self.assertNotIn(
                    "dashboard_experiment_url",
                    experiment["metrics"],
                )
                self.assertEqual(
                    result["unmapped_mlflow_experiments"],
                    [{"name": f"merv/{PROJECT_ID}/stray", "experiment_id": "8"}],
                )

    def test_empty_project_still_discovers_the_mlflow_namespace(self) -> None:
        tracking = OverviewTracking()

        result = _overview(summaries=[], tracking=tracking)

        self.assertEqual(
            tracking.calls,
            [
                ("health", {}),
                (
                    "project_results_snapshot",
                    {"project_id": PROJECT_ID, "experiment_ids": ()},
                ),
            ],
        )
        self.assertEqual(result["experiments"], [])
        self.assertEqual(
            result["unmapped_mlflow_experiments"],
            [{"name": f"merv/{PROJECT_ID}/stray", "experiment_id": "8"}],
        )


if __name__ == "__main__":
    unittest.main()
