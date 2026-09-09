# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Application read model for experiment metrics exhibits."""

from __future__ import annotations

import json
from typing import Protocol

from ...research_core import Artifact, ResearchArtifacts as Artifacts
from ...kernel.utils import WorkflowError
from ...research_core import EXPERIMENT_WORKFLOW, ExperimentState, Research
from ..mlflow import MlflowIntegration
from .create import experiment_folder
from .metrics_exhibit import METRICS_EXHIBIT_FILENAME, build_metrics_exhibit


class ExhibitBuilder(Protocol):
    def generate(self, *, state: ExperimentState) -> dict[str, object]: ...


class ExperimentExhibits:
    """Build current observations; transition decides whether to commit them."""

    def __init__(
        self,
        *,
        research: Research,
        artifacts: Artifacts,
        mlflow: MlflowIntegration,
    ) -> None:
        self.research = research
        self.artifacts = artifacts
        self.mlflow = mlflow

    def generate(self, *, state: ExperimentState) -> dict[str, object]:
        project_id = str(state.get("project_id") or "")
        experiment_id = str(state.get("id") or "")
        attempt_index = int(state.get("attempt_index") or 1)
        experiment_name, configured, snapshot = self.mlflow.exhibit_snapshot(
            project_id=project_id,
            experiment_id=experiment_id,
        )
        exhibit = build_metrics_exhibit(
            project_id=project_id,
            experiment_id=experiment_id,
            attempt_index=attempt_index,
            experiment_name=experiment_name,
            window_started_at=self.research.attempt_started_running_at(
                experiment_id=experiment_id
            ),
            snapshot=snapshot,
            mlflow_configured=configured,
            file_sources=self._metric_file_sources(
                project_id=project_id,
                experiment_id=experiment_id,
                attempt_index=attempt_index,
            ),
        )
        if not self.mlflow.enabled:
            # Keep the legacy adapter's envelope dormant without leaking its
            # name or namespace into normal previews and pinned artifacts.
            exhibit.pop("mlflow", None)
        return exhibit

    def preview(
        self, *, experiment_id: str, project_id: str | None = None
    ) -> dict[str, object]:
        state = self.research.experiment_state(
            experiment_id=experiment_id, project_id=project_id
        )
        if str(state.get("status")) not in EXPERIMENT_WORKFLOW.effect_sources(
            "result_submission"
        ):
            raise WorkflowError(
                "experiment.exhibit previews a running experiment; this one is "
                f"{state.get('status')!r}. After submit_results, read the pinned "
                "exhibit artifact instead (artifact.find)."
            )
        exhibit = self.generate(state=state)
        path = (
            experiment_folder(
                experiment_id=str(state.get("id") or experiment_id),
                name=str(state.get("name") or ""),
            )
            + METRICS_EXHIBIT_FILENAME
        )
        return {
            "project_id": str(state.get("project_id") or ""),
            "experiment_id": experiment_id,
            "exhibit_path": path,
            "exhibit": exhibit,
            "guidance": (
                "Preview of the system-generated metrics exhibit. At "
                "submit_results the system regenerates it from the same sources "
                f"and may pin it at {path}. When pinned, report.md "
                f"must reference {METRICS_EXHIBIT_FILENAME} and interpret it "
                "rather than restate numbers by hand."
            ),
        }

    def _metric_file_sources(
        self,
        *,
        project_id: str,
        experiment_id: str,
        attempt_index: int,
    ) -> list[dict[str, object]]:
        rows = sorted(
            (
                artifact
                for artifact in self.artifacts.scan(
                    project_id=project_id,
                    target_type="experiment",
                    target_ids=(experiment_id,),
                    roles=("result",),
                )
                if artifact.attempt_index == attempt_index
            ),
            key=lambda artifact: (artifact.path, artifact.order),
        )
        newest: dict[tuple[str, str], Artifact] = {}
        for artifact in rows:
            newest[(artifact.lens_id, artifact.path)] = artifact
        selected = tuple(newest.values())
        artifact_by_id = {
            artifact.id: artifact
            for artifact in self.artifacts.get(
                artifact_ids=tuple(artifact.id for artifact in selected),
                project_id=project_id,
                include="content",
            )
        }
        sources: list[dict[str, object]] = []
        for artifact in selected:
            hydrated = artifact_by_id.get(artifact.id)
            if hydrated is None or hydrated.data is None:
                continue
            try:
                parsed = json.loads(hydrated.data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                parsed = None
            sources.append(
                {
                    "path": artifact.path,
                    "artifact_id": artifact.id,
                    "sha256": artifact.sha256,
                    "submitted_at": artifact.updated_at,
                    "data": parsed,
                }
            )
        return sources


def should_pin_exhibit(*, exhibit: dict[str, object], state: ExperimentState) -> bool:
    verdict = exhibit["verdict"]
    tracking = exhibit.get("mlflow") or {}
    run = state.get("mlflow_run") or {}
    assert isinstance(verdict, dict) and isinstance(tracking, dict)
    return bool(
        verdict.get("runs_found")
        or (
            tracking.get("configured")
            and not tracking.get("available")
            and run.get("run_id")
        )
    )


__all__ = ["ExhibitBuilder", "ExperimentExhibits", "should_pin_exhibit"]
