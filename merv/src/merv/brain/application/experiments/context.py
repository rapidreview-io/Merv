# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Canonical agent context for work already inside one experiment."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from ...research_core import content_tldr

from ...research_core import ResearchArtifacts as Artifacts
from ...research_core import (
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT,
    ExperimentState,
)
from ...workflows import preferred_artifact


Record = dict[str, Any]

_DESIGN_REVIEW_ROLE, _RESULTS_REVIEW_ROLE = "design_reviewer", "experiment_reviewer"
_DESIGN_REVIEW_STATUS = EXPERIMENT.review_state(_DESIGN_REVIEW_ROLE)
_RESULTS_REVIEW_STATUS = EXPERIMENT.review_state(_RESULTS_REVIEW_ROLE)
if not _DESIGN_REVIEW_STATUS or not _RESULTS_REVIEW_STATUS:
    raise RuntimeError("experiment workflow is missing its review states")


class ExperimentContextQuery:
    """Build the one experiment context shape used to initialize agents.

    Normal workflow reads use the current submitted artifact composition.
    Review sessions may provide the immutable artifacts pinned by the review
    request; the resulting shape is identical, but its document bytes and
    artifact rows come from that snapshot.
    """

    def __init__(self, *, artifacts: Artifacts) -> None:
        self.artifacts = artifacts

    def build(
        self,
        *,
        state: ExperimentState | Record,
        project_id: str | None = None,
        pinned_artifacts: Iterable[Mapping[str, Any]] | None = None,
    ) -> Record:
        status = str(state.get("status") or "")
        artifact_project_id = str(state.get("project_id") or project_id or "") or None
        rows, pinned_content = self._artifact_rows(
            state=state, pinned_artifacts=pinned_artifacts
        )
        plan = preferred_artifact(artifacts=rows, roles=("plan",))
        report = preferred_artifact(artifacts=rows, roles=("report",))
        experiment: Record = {
            "id": state.get("id"),
            "project_id": state.get("project_id") or project_id,
            "name": state.get("name"),
            "status": status,
            "intent": state.get("intent"),
            "tested_claims": [
                {
                    "id": claim.get("id"),
                    "statement": claim.get("statement"),
                }
                for claim in state.get("tested_claims", [])
                if isinstance(claim, dict)
            ],
        }
        if status == EXPERIMENT.success_status:
            experiment["conclusion"] = state.get("conclusion") or ""

        return {
            "experiment": experiment,
            "plan": self._plan(
                artifact=plan,
                state=state,
                status=status,
                pinned_content=pinned_content,
                project_id=artifact_project_id,
            ),
            "report": self._report(
                artifact=report,
                state=state,
                status=status,
                pinned_content=pinned_content,
                project_id=artifact_project_id,
            ),
            "artifacts": [
                self._artifact_reference(artifact)
                for artifact in rows
                if str(artifact.get("role") or "") not in {"plan", "report"}
            ],
        }

    def _artifact_rows(
        self,
        *,
        state: ExperimentState | Record,
        pinned_artifacts: Iterable[Mapping[str, Any]] | None,
    ) -> tuple[list[Record], dict[str, str | None]]:
        current = [
            dict(artifact)
            for artifact in state.get("current_attempt_artifacts", [])
            if isinstance(artifact, dict)
        ]
        if pinned_artifacts is None:
            return current, {}

        pinned = [dict(artifact) for artifact in pinned_artifacts]
        by_id = {
            str(artifact.get("id") or ""): artifact
            for artifact in current
            if artifact.get("id")
        }
        rows: list[Record] = []
        content: dict[str, str | None] = {}
        for artifact in pinned:
            artifact_id = str(artifact.get("artifact_id") or artifact.get("id") or "")
            if not artifact_id:
                continue
            merged = {
                **by_id.get(artifact_id, {}),
                "id": artifact_id,
                "role": artifact.get("role") or by_id.get(artifact_id, {}).get("role"),
                "lens_id": artifact.get("lens_id")
                or by_id.get(artifact_id, {}).get("lens_id")
                or "",
                "path": artifact.get("path") or by_id.get(artifact_id, {}).get("path"),
                "attempt_index": (
                    artifact.get("attempt_index")
                    or by_id.get(artifact_id, {}).get("attempt_index")
                    or state.get("attempt_index")
                ),
                "updated_at": (
                    artifact.get("submitted_at")
                    or artifact.get("updated_at")
                    or by_id.get(artifact_id, {}).get("updated_at")
                    or by_id.get(artifact_id, {}).get("created_at")
                    or ""
                ),
            }
            rows.append(merged)
            content[artifact_id] = artifact.get("content")

        # Keep the snapshot order supplied by Review, which is the submitted
        # artifact order. Filtering exclusively through that list also ensures
        # a post-start resubmission cannot leak into this review context.
        return rows, content

    def _plan(
        self,
        *,
        artifact: Record | None,
        state: ExperimentState | Record,
        status: str,
        pinned_content: Mapping[str, str | None],
        project_id: str | None,
    ) -> Record:
        if artifact is None:
            return {"status": "missing"}
        result = {
            **self._document_identity(artifact),
            "attempt_index": artifact.get("attempt_index")
            or state.get("attempt_index"),
            "status": self._plan_status(
                state=state, artifact_id=str(artifact.get("id") or "")
            ),
        }
        content = self._content(
            artifact=artifact,
            pinned_content=pinned_content,
            project_id=project_id,
        )
        if status in EXPERIMENT_TERMINAL_STATUSES:
            result["summary"] = str(artifact.get("tldr") or "").strip() or content_tldr(
                content,
                role="plan",
                path=str(artifact.get("path") or ""),
            )
        else:
            result["content"] = content or ""
        return result

    def _report(
        self,
        *,
        artifact: Record | None,
        state: ExperimentState | Record,
        status: str,
        pinned_content: Mapping[str, str | None],
        project_id: str | None,
    ) -> Record:
        if artifact is None:
            return {"status": "missing"}
        return {
            **self._document_identity(artifact),
            "status": self._report_status(
                state=state,
                artifact_id=str(artifact.get("id") or ""),
                status=status,
            ),
            "content": self._content(
                artifact=artifact,
                pinned_content=pinned_content,
                project_id=project_id,
            )
            or "",
        }

    def _content(
        self,
        *,
        artifact: Record,
        pinned_content: Mapping[str, str | None],
        project_id: str | None,
    ) -> str | None:
        artifact_id = str(artifact.get("id") or "")
        if artifact_id in pinned_content:
            return pinned_content[artifact_id]
        if not artifact_id:
            return None
        payloads = self.artifacts.get(
            artifact_ids=(artifact_id,),
            project_id=project_id,
            include="content",
        )
        data = payloads[0].data if payloads else None
        return data.decode("utf-8", errors="replace") if data is not None else None

    @staticmethod
    def _document_identity(artifact: Record) -> Record:
        return {
            "id": artifact.get("id"),
            "path": artifact.get("path"),
            "submitted_at": _submitted_at(artifact),
        }

    @staticmethod
    def _artifact_reference(artifact: Record) -> Record:
        role = str(artifact.get("role") or "artifact").replace("_", " ")
        version = str(artifact.get("version") or "").strip()
        descriptor = f"{role} {version}".strip() if version else role
        return {
            "descriptor": descriptor,
            "id": artifact.get("id"),
            "path": artifact.get("path"),
            "submitted_at": _submitted_at(artifact),
        }

    @staticmethod
    def _plan_status(*, state: ExperimentState | Record, artifact_id: str) -> str:
        status = str(state.get("status") or "")
        if status == _DESIGN_REVIEW_STATUS:
            return "in_review"
        review = _latest_review(
            state=state, role=_DESIGN_REVIEW_ROLE, artifact_id=artifact_id
        )
        if review and str(review.get("verdict") or "") != "pass":
            return "changes_requested"
        if review and str(review.get("verdict") or "") == "pass":
            return "approved"
        return "submitted"

    @staticmethod
    def _report_status(
        *,
        state: ExperimentState | Record,
        artifact_id: str,
        status: str,
    ) -> str:
        if status == _RESULTS_REVIEW_STATUS:
            return "in_review"
        review = _latest_review(
            state=state, role=_RESULTS_REVIEW_ROLE, artifact_id=artifact_id
        )
        if review and str(review.get("verdict") or "") != "pass":
            return "changes_requested"
        if review and str(review.get("verdict") or "") == "pass":
            return "approved"
        if status == EXPERIMENT.success_status and not _reviews_for_role(
            state=state, role=_RESULTS_REVIEW_ROLE
        ):
            return "approved"
        return "submitted"


def _latest_review(
    *,
    state: ExperimentState | Record,
    role: str,
    artifact_id: str,
) -> Record | None:
    for review in state.get("reviews", []):
        if not isinstance(review, dict) or str(review.get("role") or "") != role:
            continue
        snapshot_id = str(review.get("target_snapshot_id") or "")
        if not snapshot_id or f"{artifact_id}:" in snapshot_id:
            return review
    return None


def _reviews_for_role(*, state: ExperimentState | Record, role: str) -> list[Record]:
    return [
        review
        for review in state.get("reviews", [])
        if isinstance(review, dict) and str(review.get("role") or "") == role
    ]


def _submitted_at(artifact: Mapping[str, Any]) -> str:
    return str(
        artifact.get("submitted_at")
        or artifact.get("updated_at")
        or artifact.get("created_at")
        or ""
    )


__all__ = ["ExperimentContextQuery"]
