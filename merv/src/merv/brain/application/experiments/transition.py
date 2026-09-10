# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""The experiment transition: prepare, commit, react, and present."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypedDict, cast

from ...workflows import EXHIBIT_ROLE

from ...research_core import ResearchArtifacts as Artifacts
from ...workflows import Snapshot
from ...feed import FeedAdvisory
from ...kernel.events import StoredEvent
from ...object_storage import ObjectStorage
from ...research_core import (
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT_WORKFLOW,
    ExperimentState,
    PersistedRunState,
    Research,
)
from ..mlflow import MlflowIntegration, TrackingContextPayload
from .create import experiment_folder
from .exhibits import ExhibitBuilder, should_pin_exhibit
from .metrics_exhibit import METRICS_EXHIBIT_FILENAME, exhibit_bytes
from .presentation import SlimExperimentState, slim_experiment_state


class TransitionResponse(SlimExperimentState, total=False):
    mlflow: TrackingContextPayload
    mlflow_guidance: str
    mlflow_warning: dict[str, str]
    metrics_exhibit: dict[str, object]
    feed_note: str


class TransitionReceipt(TypedDict, total=False):
    """Minimal agent acknowledgement for one committed transition."""

    experiment_id: str
    transition: str
    from_status: str
    to_status: str
    status: str
    attempt_index: int
    event_id: int
    accepted_at: str
    metrics_exhibit: dict[str, object]
    feed_note: str
    mlflow: TrackingContextPayload
    mlflow_run: PersistedRunState
    mlflow_guidance: str
    mlflow_warning: dict[str, str]


@dataclass(kw_only=True, eq=False, repr=False)
class TransitionExperiment:
    """Coordinate one transition without exposing component internals."""

    research: Research
    artifacts: Artifacts
    feed: FeedAdvisory
    mlflow: MlflowIntegration
    exhibits: ExhibitBuilder
    objects: ObjectStorage

    def agent(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> TransitionReceipt:
        response, event = self._execute(
            experiment_id=experiment_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
            include_tracking_credentials=True,
        )
        receipt = TransitionReceipt(
            experiment_id=experiment_id,
            transition=transition,
            from_status=str(event.payload.get("from") or ""),
            to_status=str(response.get("status") or ""),
            # Keep the conventional status key as a concise acknowledgement,
            # not as a second experiment-state projection.
            status=str(response.get("status") or ""),
            attempt_index=int(response.get("attempt_index") or 0),
            event_id=event.id,
            accepted_at=event.created_at,
        )
        # These are operation-specific side-effect receipts, not experiment
        # context. The normal composition has no tracking fields; compatibility
        # builds keep them reversible for a later reintroduction.
        for key in (
            "metrics_exhibit",
            "feed_note",
            "mlflow",
            "mlflow_run",
            "mlflow_guidance",
            "mlflow_warning",
        ):
            if key in response:
                receipt[key] = response[key]
        return receipt

    def execute(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
        include_tracking_credentials: bool = False,
    ) -> TransitionResponse:
        response, _event = self._execute(
            experiment_id=experiment_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
            include_tracking_credentials=include_tracking_credentials,
        )
        return response

    def _execute(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, Any] | None,
        project_id: str | None,
        include_tracking_credentials: bool,
    ) -> tuple[TransitionResponse, StoredEvent]:
        step = EXPERIMENT_WORKFLOW.transition(transition)
        effects = () if step is None else step.effects
        before = (
            self.research.experiment_state(
                experiment_id=experiment_id, project_id=project_id
            )
            if "prepare_metrics_exhibit" in effects or not project_id
            else None
        )
        resolved_project_id = str((before or {}).get("project_id") or project_id or "")
        storage_objects = self.objects.by_experiment(
            project_id=resolved_project_id, experiment_ids=(experiment_id,)
        )[experiment_id]
        exhibit = None
        prepared_snapshot = None
        if (
            "prepare_metrics_exhibit" in effects
            and before is not None
            and str(before.get("status"))
            in EXPERIMENT_WORKFLOW.effect_sources("prepare_metrics_exhibit")
        ):
            prepared_snapshot = self.research.workflows.runtime.get(project_id=resolved_project_id, instance_id=experiment_id)
            exhibit = self._finalize_exhibit(state=before, snapshot=prepared_snapshot)

        committed = self.research.transition_experiment(
            experiment_id=experiment_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
            **({"expected_revision": prepared_snapshot.revision} if prepared_snapshot is not None else {}),
        )
        state = committed.state
        # The committed graph queues tracking actions. The durable delivery
        # worker owns retry and idempotency for native and generic transitions.
        response = cast(
            TransitionResponse,
            dict(
                slim_experiment_state(
                    state,
                    storage_objects=storage_objects,
                    include_legacy_tracking=self.mlflow.enabled,
                )
            ),
        )
        if not self.mlflow.enabled:
            response.pop("mlflow_run", None)
        presentation_warning = self.mlflow.decorate_after_commit(
            response,
            project_id=resolved_project_id,
            experiment_id=experiment_id,
            include_credentials=include_tracking_credentials,
        )
        if presentation_warning is not None:
            response["mlflow_warning"] = presentation_warning
        if "show_metrics_exhibit" in effects:
            response["metrics_exhibit"] = self._exhibit_expectation(
                experiment_id=experiment_id, state=response
            )
        elif "prepare_metrics_exhibit" in effects and exhibit is not None:
            response["metrics_exhibit"] = {
                "pinned": True,
                "path": self._exhibit_path(experiment_id=experiment_id, state=response),
                "verdict": exhibit["verdict"],
            }

        note = self._feed_advisory(event=committed.event, state=state)
        if note:
            response["feed_note"] = note
        return response, committed.event

    def _feed_advisory(
        self, *, event: StoredEvent, state: ExperimentState
    ) -> str | None:
        status = str(state.get("status") or "")
        if (
            event.type != EXPERIMENT_WORKFLOW.event_type
            or status not in EXPERIMENT_TERMINAL_STATUSES
        ):
            return None
        try:
            return self.feed.transition_advisory(
                project_id=str(state.get("project_id") or ""),
                experiment_id=str(state.get("id") or ""),
                event=f"experiment_{status}",
            )
        except Exception:
            return None

    def prepare_workflow_transition(self, snapshot: Snapshot, action: str, payload) -> dict[str, object] | None:
        """Prepare external metrics before the runtime's final transactional gate."""
        if action != "submit_results" or snapshot.state != "running":
            return None
        state = self.research.experiment_state(experiment_id=snapshot.id, project_id=snapshot.project_id)
        return self._finalize_exhibit(state=state, snapshot=snapshot)

    def _finalize_exhibit(self, *, state: ExperimentState, snapshot: Snapshot | None = None) -> dict[str, object] | None:
        project_id, experiment_id = str(state.get("project_id") or ""), str(state.get("id") or "")
        if snapshot is None:
            snapshot = self.research.workflows.runtime.get(project_id=project_id, instance_id=experiment_id)
        source_ids = tuple(str(item["id"]) for item in state.get("current_attempt_artifacts") or () if item.get("role") != EXHIBIT_ROLE)
        # Remote reads happen before any database transaction. The native
        # capability locks/rechecks this revision and evidence before pinning.
        exhibit = self.exhibits.generate(state=state)
        pinned = should_pin_exhibit(exhibit=exhibit, state=state)
        verdict = {**dict(exhibit["verdict"]), "attempt_index": exhibit["attempt_index"], "pinned": pinned}
        if "mlflow" in exhibit:
            verdict["mlflow"] = exhibit["mlflow"]
        self.research.record_exhibit_verdict(
            experiment_id=experiment_id, project_id=project_id, verdict=verdict,
            expected_revision=snapshot.revision, expected_attempt_index=int(state["attempt_index"]),
            expected_artifact_ids=source_ids,
            artifact_path=self._exhibit_path(experiment_id=experiment_id, state=state) if pinned else "",
            artifact_data=exhibit_bytes(exhibit) if pinned else None,
        )
        return exhibit if pinned else None

    def _exhibit_path(self, *, experiment_id: str, state: dict[str, Any]) -> str:
        return (
            experiment_folder(
                experiment_id=experiment_id,
                name=str(state.get("name") or ""),
            )
            + METRICS_EXHIBIT_FILENAME
        )

    def _exhibit_expectation(
        self, *, experiment_id: str, state: dict[str, Any]
    ) -> dict[str, object]:
        path = self._exhibit_path(experiment_id=experiment_id, state=state)
        if not self.mlflow.enabled:
            return {
                "final_path": path,
                "preview_tool": "experiment.exhibit",
                "notice": (
                    "Retain every quantitative run as a role-'result' JSON or "
                    "CSV artifact, including failed and aborted runs, plus the "
                    "figures used by the report. At submit_results the system "
                    "evaluates the attempt's submitted result evidence. Preview "
                    "the current exhibit with experiment.exhibit; when one is "
                    f"pinned at {path}, report.md must reference and interpret "
                    f"{METRICS_EXHIBIT_FILENAME}."
                ),
            }
        return {
            "final_path": path,
            "preview_tool": "experiment.exhibit",
            "notice": (
                "At submit_results the system generates a metrics exhibit from "
                "up to the newest 50 MLflow runs in this attempt's window (no "
                "curation; the cap is recorded) and every role-'result' artifact "
                "submitted for the attempt (JSON is parsed into the exhibit). "
                "It pins the exhibit when matching runs are found, "
                "or when MLflow is unavailable after a plugin-created run, at "
                f"{path}. When pinned, your report must reference "
                f"{METRICS_EXHIBIT_FILENAME} and answer around it — log every run "
                "to the MLflow env you were handed, tag project_id/experiment_id, "
                "and pull result files before submitting. Preview anytime with "
                "experiment.exhibit; later runs remain in MLflow but are outside "
                "the finalized exhibit."
            ),
        }


__all__ = ["TransitionExperiment", "TransitionReceipt", "TransitionResponse"]
