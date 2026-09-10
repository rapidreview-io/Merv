# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""The only Application boundary to the optional MLflow integration.

Research remains authoritative for persisted run state.  This file owns every
external MLflow call, presentation block, post-commit tracking effect, and
repair message.  The rest of Application only asks this object to decorate or
react; a normal deployment constructs it with ``adapter=None``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Final, Protocol, TypedDict, cast, runtime_checkable

from merv.shared.errors import TrackingPersistenceError, WorkflowError

from ..feed import FeedAdvisory
from ..research_core import (
    ExperimentState,
    ExperimentSummary,
    PersistedRunState,
    Research,
)
from ..workflows import Delivery
from .experiments.presentation import ProducedObjectCatalog, slim_experiment_state

LOGGER = logging.getLogger(__name__)

MAX_TRACKING_SNAPSHOT_RUNS: Final = 50
TRACKING_NAMESPACE_PREFIX: Final = "merv"
TRACKING_TERMINAL_RUN_STATUSES: Final = frozenset({"FINISHED", "FAILED", "KILLED"})
_RUN_FIELDS = (
    "run_id",
    "run_name",
    "status",
    "artifact_uri",
    "created_at",
    "created_by_plugin",
    "error",
)


@dataclass(frozen=True, slots=True)
class TrackingCapabilities:
    logging: bool
    control: bool
    readback: bool


TRACKING_CAPABILITY_TRUTH_TABLE: Final = MappingProxyType(
    {
        (logging, control): TrackingCapabilities(
            logging=logging,
            control=control,
            readback=logging or control,
        )
        for logging in (False, True)
        for control in (False, True)
    }
)


def capabilities_for_configuration(
    *, logging: bool, control: bool
) -> TrackingCapabilities:
    return TRACKING_CAPABILITY_TRUTH_TABLE[(bool(logging), bool(control))]


def tracking_experiment_name(*, project_id: str, experiment_id: str) -> str:
    return f"{TRACKING_NAMESPACE_PREFIX}/{project_id}/{experiment_id}"


class TrackingContextPayload(TypedDict, total=False):
    configured: bool
    mode: str
    tracking_uri: str
    dashboard_url: str
    experiment_name: str
    env: dict[str, str]
    note: str
    project_id: str
    experiment_namespace_prefix: str
    experiments: list[dict[str, str]]


@runtime_checkable
class TrackingContext(Protocol):
    def to_dict(self) -> TrackingContextPayload: ...


class TrackingRun(TypedDict, total=False):
    run_id: str
    run_name: str
    status: str
    artifact_uri: str
    created_at: str
    created_by_plugin: bool
    error: str


class CreateRunResult(TypedDict, total=False):
    created: bool
    run_id: str
    run_name: str
    status: str
    artifact_uri: str
    created_at: str
    created_by_plugin: bool
    error: str


class FinalizeRunResult(TypedDict, total=False):
    run: TrackingRun


class TrackingMetric(TypedDict, total=False):
    last: float | None
    step: object
    min: float
    max: float


class TrackingSnapshotRun(TypedDict, total=False):
    run_id: str
    run_name: str
    status: str
    start_time: int
    end_time: int
    params: dict[str, object]
    tags: dict[str, str]
    metrics: dict[str, TrackingMetric]
    metrics_capped_at: int


class TrackingExperimentSnapshot(TypedDict, total=False):
    name: str
    runs: list[TrackingSnapshotRun]


class MetricsSnapshot(TypedDict, total=False):
    available: bool
    suspended: bool
    experiments: list[TrackingExperimentSnapshot]


@runtime_checkable
class ExperimentTracking(Protocol):
    def capabilities(self) -> TrackingCapabilities: ...

    def context(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool = False,
    ) -> TrackingContext: ...

    def project_context(
        self, *, project_id: str, include_credentials: bool = False
    ) -> TrackingContextPayload: ...

    def create_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        attempt_index: int,
        run_name: str,
    ) -> CreateRunResult: ...

    def finalize_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str,
        status: str | None,
        wait_seconds: float,
    ) -> FinalizeRunResult: ...

    def results_metrics(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_history: bool = True,
    ) -> MetricsSnapshot: ...

    def health(self) -> dict[str, object]: ...

    def project_results_snapshot(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], str]: ...


_VISIBLE_STATUSES = frozenset({"running", "experiment_review", "complete", "failed", "abandoned"})
_PRESENTATION_REPAIR = (
    "The state change is committed; only the MLflow context block failed to "
    "assemble, so this response carries no mlflow environment. Do not retry "
    "the call — read mlflow.context for the logging environment."
)
_TRACKING_REPAIR = (
    "The transition is committed; only MLflow tracking degraded. No "
    "plugin-created run is attached to this attempt. Read mlflow.context for "
    "the logging environment, log to a run you create there, then call "
    "mlflow.finalize_run with that run_id to attach it to the experiment."
)
_PERSISTENCE_FAILURE = (
    "The experiment transition already committed and must not be retried, but "
    "persisting its MLflow tracking outcome failed on both attempts, so a "
    "durable record of the run (or of the outage) may or may not exist. Verify "
    "with experiment.get_state before any repair, then attach any run you find "
    "with mlflow.finalize_run. Underlying error: "
)


def _message(exc: BaseException) -> str:
    return str(exc).strip() or exc.__class__.__name__


def _warning(error: str, repair: str) -> dict[str, str]:
    return {"tracking": "unavailable", "error": error, "repair": repair}


def _persisted_run(run: dict[str, Any]) -> PersistedRunState:
    persisted = {key: run[key] for key in _RUN_FIELDS if key in run}
    if "created" in run:
        persisted["created_by_plugin"] = bool(run["created"])
    return cast(PersistedRunState, persisted)


class MlflowIntegration:
    """All optional MLflow behavior behind one collaborator."""

    def __init__(
        self,
        *,
        research: Research,
        feed: FeedAdvisory,
        objects: ProducedObjectCatalog,
        adapter: ExperimentTracking | None,
    ) -> None:
        self.research = research
        self.feed = feed
        self.objects = objects
        self.adapter = adapter

    @property
    def enabled(self) -> bool:
        return self.adapter is not None

    def deliver_workflow_action(self, delivery: Delivery) -> None:
        """Deliver one graph-requested tracking operation using its durable key."""
        if self.adapter is None:
            return
        state = self.research.experiment_state(project_id=delivery.project_id, experiment_id=delivery.instance_id)
        if delivery.kind == "experiment.start_tracking":
            current = self.research.workflows.runtime.get(project_id=delivery.project_id, instance_id=delivery.instance_id)
            if current.revision != delivery.revision or current.outcome:
                return
            self._ensure_run(
                state=state, replace_terminal=True, delivery_id=delivery.event_id,
                before_create=lambda: self._protect_creation(delivery),
            )
            return
        run_id = str(delivery.data.get("run_id") or "")
        if not run_id:
            return
        status = {"experiment.finish_tracking": "FINISHED", "experiment.stop_tracking": "KILLED",
                  "experiment.fail_tracking": "FAILED"}[delivery.kind]
        # A delayed action names the old run explicitly; never finalize a new
        # attempt's mutable current pointer after a plan revision.
        result = self.adapter.finalize_run(project_id=delivery.project_id, experiment_id=delivery.instance_id,
                                           run_id=run_id, status=status, wait_seconds=0.0)
        readback = result.get("run")
        if isinstance(readback, dict) and str(readback.get("run_id") or "") == run_id:
            self.research.refresh_tracking_run(project_id=delivery.project_id, experiment_id=delivery.instance_id,
                                              run=_persisted_run(readback), if_current=True)

    def _protect_creation(self, delivery: Delivery) -> None:
        if not self.research.workflows.deliveries.protect_external_effect(
            delivery, reason=(
                "MLflow creation may have started. Inspect the experiment's MLflow namespace "
                "and attach the existing run with mlflow.finalize_run before retrying work. "
                "Automatic creation is stopped to avoid duplicate remote runs."
            ),
        ):
            raise WorkflowError("tracking delivery lease changed before run creation")

    def connection(
        self,
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool,
        run: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        block = (
            {"configured": False}
            if self.adapter is None or not project_id or not experiment_id
            else dict(
                self.adapter.context(
                    project_id=project_id,
                    experiment_id=experiment_id,
                    include_credentials=include_credentials,
                ).to_dict()
            )
        )
        if not run:
            return block
        result = {**block, "run": run}
        run_id = str(run.get("run_id") or "")
        if run_id:
            result["env"] = {
                **dict(result.get("env") or {}),
                "MLFLOW_RUN_ID": run_id,
                "RP_MLFLOW_RUN_ID": run_id,
            }
        return result

    @staticmethod
    def guidance(block: dict[str, Any]) -> str:
        if not block.get("configured"):
            return str(block.get("note") or "").strip() or (
                "If you run a quantitative experiment, log it to MLflow — but "
                "no central MLflow tracking URI is configured on this backend yet."
            )
        if block.get("experiment_name"):
            return (
                "For this quantitative experiment, set the variables in mlflow.env "
                "(MLFLOW_TRACKING_URI, MLFLOW_EXPERIMENT_NAME, …), then log params, "
                "metrics, artifacts, and required tags to the centralized server. "
                "Use MLflow's native APIs for reads and comparisons."
            )
        return (
            "Use MLflow's native APIs with mlflow.env.MLFLOW_TRACKING_URI to browse "
            "quantitative runs. Search experiment names under "
            f"{block.get('experiment_namespace_prefix') or 'the project namespace'} "
            "or use mlflow.experiments as the plugin experiment-to-MLflow-name map."
        )

    def decorate(
        self,
        state: dict[str, Any],
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool,
        include_guidance: bool = True,
    ) -> dict[str, Any]:
        if not self.enabled or str(state.get("status") or "") not in _VISIBLE_STATUSES:
            return state
        block = self.connection(
            project_id=project_id,
            experiment_id=experiment_id,
            include_credentials=include_credentials,
            run=state.get("mlflow_run"),
        )
        state["mlflow"] = block
        if include_guidance:
            state["mlflow_guidance"] = self.guidance(block)
        return state

    def decorate_after_commit(
        self,
        state: dict[str, Any],
        *,
        project_id: str,
        experiment_id: str,
        include_credentials: bool,
    ) -> dict[str, str] | None:
        try:
            self.decorate(
                state,
                project_id=project_id,
                experiment_id=experiment_id,
                include_credentials=include_credentials,
            )
        except Exception as exc:  # a committed transition never fails here
            error = _message(exc)
            LOGGER.error(
                "MLflow context presentation failed for experiment %s: %s",
                experiment_id,
                error,
            )
            state.pop("mlflow", None)
            state.pop("mlflow_guidance", None)
            return _warning(error, _PRESENTATION_REPAIR)
        return None

    def context(
        self, *, project_id: str, experiment_id: str | None = None
    ) -> dict[str, Any]:
        if experiment_id:
            state = self.research.experiment_state(
                experiment_id=experiment_id,
                project_id=project_id,
            )
            resolved = str(state.get("project_id") or project_id)
            block = self.connection(
                project_id=resolved,
                experiment_id=experiment_id,
                include_credentials=True,
                run=state.get("mlflow_run"),
            )
            return {
                "project_id": resolved,
                "experiment_id": experiment_id,
                "scope": "experiment",
                "mlflow": block,
                "guidance": self.guidance(block),
            }
        block: dict[str, Any] = (
            {"configured": False}
            if self.adapter is None or not project_id
            else dict(
                self.adapter.project_context(
                    project_id=project_id,
                    include_credentials=True,
                )
            )
        )
        if self.adapter is not None and project_id:
            block["experiments"] = [
                {
                    "experiment_id": str(state.get("id") or ""),
                    "name": str(state.get("name") or state.get("id") or ""),
                    "status": str(state.get("status") or ""),
                    "intent": str(state.get("intent") or ""),
                    "mlflow_experiment_name": tracking_experiment_name(
                        project_id=project_id,
                        experiment_id=str(state.get("id") or ""),
                    ),
                }
                for state in self.research.project_experiment_summaries(
                    project_id=project_id
                )
                if state.get("id")
            ]
        return {
            "project_id": project_id,
            "scope": "project",
            "mlflow": block,
            "guidance": self.guidance(block),
        }

    def _ensure_run(
        self,
        *,
        state: ExperimentState,
        replace_terminal: bool,
        delivery_id: int,
        before_create: Callable[[], None] | None = None,
    ) -> tuple[ExperimentState, bool]:
        if self.adapter is None:
            return state, False
        capabilities = self.adapter.capabilities()
        if not (capabilities.logging and capabilities.control):
            return state, False
        existing = state.get("mlflow_run") or {}
        if existing.get("delivery_id") == delivery_id:
            return state, True
        status = str(existing.get("status") or "").upper()
        if existing.get("run_id") and (
            not replace_terminal or status not in TRACKING_TERMINAL_RUN_STATUSES
        ):
            return state, False
        experiment_id = str(state.get("id") or "")
        project_id = str(state.get("project_id") or "")
        attempt = int(state.get("attempt_index") or 1)
        if before_create is not None:
            before_create()
        try:
            created: dict[str, Any] = self.adapter.create_run(
                project_id=project_id,
                experiment_id=experiment_id,
                attempt_index=attempt,
                run_name=f"{experiment_id}-attempt-{attempt}",
            )
        except Exception as exc:
            created = {"error": f"MLflow run creation failed: {_message(exc)}"}
        if not (created.get("run_id") or created.get("error")):
            return state, True
        adapter_failure = (
            "" if created.get("run_id") else str(created.get("error") or "")
        )
        if adapter_failure:
            LOGGER.error(
                "MLflow run creation failed for experiment %s; recording the "
                "outage as this attempt's durable tracking state: %s",
                experiment_id,
                adapter_failure,
            )
        return (
            self._persist_run(
                project_id=project_id,
                experiment_id=experiment_id,
                run=_persisted_run(created),
                delivery_id=delivery_id,
                adapter_failure=adapter_failure,
            ),
            True,
        )

    def _persist_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run: PersistedRunState,
        delivery_id: int,
        adapter_failure: str,
    ) -> ExperimentState:
        for attempt in range(2):
            try:
                return self.research.record_tracking_run(
                    project_id=project_id,
                    experiment_id=experiment_id,
                    run=run,
                    delivery_id=delivery_id,
                )
            except Exception as exc:
                if attempt == 0:
                    LOGGER.error(
                        "Retrying the durable MLflow tracking outcome for "
                        "experiment %s: %s",
                        experiment_id,
                        _message(exc),
                    )
                    continue
                orphan = str(run.get("run_id") or "")
                LOGGER.error(
                    "MLflow tracking outcome for experiment %s may never have "
                    "reached the database (orphaned run: %s): %s%s",
                    experiment_id,
                    orphan or "none",
                    _message(exc),
                    f" (after {adapter_failure})" if adapter_failure else "",
                )
                raise TrackingPersistenceError(
                    f"{_PERSISTENCE_FAILURE}{_message(exc)}"
                    + (f" (possibly orphaned MLflow run: {orphan})" if orphan else "")
                    + (
                        f". The outcome it was recording: {adapter_failure}"
                        if adapter_failure
                        else ""
                    )
                ) from exc
        raise AssertionError("unreachable")


    def finalize(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str | None = None,
        status: str | None = "FINISHED",
        wait_seconds: float = 2.0,
    ) -> dict[str, Any]:
        state = self.research.experiment_state(
            experiment_id=experiment_id,
            project_id=project_id,
        )
        resolved_project_id = str(state.get("project_id") or project_id)
        existing = state.get("mlflow_run") or {}
        resolved_run_id = str(run_id or existing.get("run_id") or "")
        if self.adapter is None:
            return {
                "project_id": resolved_project_id,
                "experiment_id": experiment_id,
                "configured": False,
                "run_id": resolved_run_id,
                "error": "MLflow tracking is not configured on this backend.",
            }
        storage_objects = self.objects.by_experiment(
            project_id=resolved_project_id,
            experiment_ids=(experiment_id,),
        )[experiment_id]
        result = self.adapter.finalize_run(
            project_id=resolved_project_id,
            experiment_id=experiment_id,
            run_id=resolved_run_id,
            status=status,
            wait_seconds=wait_seconds,
        )
        run = result.get("run")
        persisted_id = str(existing.get("run_id") or "")
        repairing = bool(
            run_id and persisted_id and str(run_id) != persisted_id
            and str(existing.get("status") or "").upper() in TRACKING_TERMINAL_RUN_STATUSES
            and self.research.workflows.deliveries.needs_manual_repair(
                project_id=resolved_project_id, instance_id=experiment_id,
                kind="experiment.start_tracking",
            )
        )
        if (
            isinstance(run, dict)
            and run.get("run_id")
            and (not persisted_id or str(run.get("run_id")) == persisted_id or repairing)
        ):
            refreshed = self.research.refresh_tracking_run(
                project_id=resolved_project_id,
                experiment_id=experiment_id,
                run=cast(PersistedRunState, run),
                expected_run_id=persisted_id,
            )
            state = refreshed.state if refreshed is not None else self.research.experiment_state(
                project_id=resolved_project_id, experiment_id=experiment_id,
            )
            if run_id and refreshed is not None:
                self.research.workflows.deliveries.resolve_manual_repair(
                    project_id=resolved_project_id, instance_id=experiment_id,
                    kind="experiment.start_tracking",
                )
        experiment = dict(
            slim_experiment_state(
                state,
                storage_objects=storage_objects,
                include_legacy_tracking=True,
            )
        )
        warning = self.decorate_after_commit(
            experiment,
            project_id=resolved_project_id,
            experiment_id=experiment_id,
            include_credentials=True,
        )
        response = {
            **result,
            "project_id": resolved_project_id,
            "experiment_id": experiment_id,
            "experiment": experiment,
        }
        if warning is not None:
            response["mlflow_warning"] = warning
        if isinstance(run, dict) and run.get("run_id"):
            note = self._feed_note(state)
            if note:
                response["feed_note"] = note
        return response

    def _feed_note(self, state: ExperimentState) -> str | None:
        experiment_id = str(state.get("id") or "")
        try:
            return self.feed.advisory(
                project_id=str(state.get("project_id") or ""),
                ref=experiment_id,
                message=f"an MLflow run for {experiment_id} just finished",
            )
        except Exception:
            return None

    def health(self) -> dict[str, object]:
        return {} if self.adapter is None else self.adapter.health()

    def metrics(self, *, project_id: str, experiment_id: str) -> dict[str, Any]:
        if self.adapter is None:
            return {}
        return dict(
            self.adapter.results_metrics(
                project_id=project_id,
                experiment_id=experiment_id,
            )
        )

    def exhibit_snapshot(
        self, *, project_id: str, experiment_id: str
    ) -> tuple[str, bool, MetricsSnapshot | None]:
        """Return the one tracking observation needed by metrics exhibits."""
        name = tracking_experiment_name(
            project_id=project_id,
            experiment_id=experiment_id,
        )
        if self.adapter is None:
            return name, False, None
        configured = self.adapter.capabilities().readback
        snapshot = (
            self.adapter.results_metrics(
                project_id=project_id,
                experiment_id=experiment_id,
            )
            if configured
            else None
        )
        return name, configured, snapshot

    def overview(self, *, project_id: str) -> dict[str, Any]:
        if self.adapter is None:
            return {}
        health = self.health()
        experiments: list[ExperimentSummary] = (
            self.research.project_experiment_summaries(project_id=project_id)
        )
        unreachable = health.get("reachable") is False
        snapshots, namespace, failure_hint = (
            ({}, [], "MLflow unreachable.")
            if unreachable
            else self.adapter.project_results_snapshot(
                project_id=project_id,
                experiment_ids=tuple(
                    str(item["id"]) for item in experiments if item.get("id")
                ),
            )
        )
        namespace_by_name = {str(entry.get("name") or ""): entry for entry in namespace}
        items = []
        for experiment in experiments:
            experiment_id = str(experiment.get("id") or "")
            if not experiment_id:
                continue
            name = tracking_experiment_name(
                project_id=project_id,
                experiment_id=experiment_id,
            )
            snapshot = snapshots.get(name)
            entry = namespace_by_name.get(name, {})
            url = (
                str(entry.get("dashboard_experiment_url") or "")
                if snapshot is not None
                else ""
            )
            metrics: dict[str, Any] = {
                "experiment_id": experiment_id,
                "available": snapshot is not None,
                "source": "mlflow",
            }
            if snapshot is None:
                metrics["hint"] = failure_hint or (
                    "No MLflow runs found for this experiment yet."
                )
            else:
                metrics["experiments"] = [snapshot]
                if url:
                    metrics["dashboard_experiment_url"] = url
            items.append(
                {
                    "experiment_id": experiment_id,
                    "name": experiment.get("name") or experiment_id,
                    "status": experiment.get("status") or "",
                    "intent": experiment.get("intent") or "",
                    "mlflow_experiment_name": name,
                    "dashboard_experiment_url": url,
                    "metrics": metrics,
                }
            )
        expected = {str(item["mlflow_experiment_name"]) for item in items}
        return {
            "mlflow": health,
            "experiments": items,
            "unmapped_mlflow_experiments": [
                experiment
                for experiment in namespace
                if str(experiment.get("name") or "") not in expected
            ],
        }


__all__ = [
    "MAX_TRACKING_SNAPSHOT_RUNS",
    "TRACKING_CAPABILITY_TRUTH_TABLE",
    "TRACKING_NAMESPACE_PREFIX",
    "TRACKING_TERMINAL_RUN_STATUSES",
    "CreateRunResult",
    "ExperimentTracking",
    "FinalizeRunResult",
    "MetricsSnapshot",
    "MlflowIntegration",
    "TrackingCapabilities",
    "TrackingContext",
    "TrackingContextPayload",
    "TrackingExperimentSnapshot",
    "TrackingMetric",
    "TrackingRun",
    "TrackingSnapshotRun",
    "capabilities_for_configuration",
    "tracking_experiment_name",
]
