# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Canonical bounded project context for agent operations."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from merv.shared.artifact_roles import PROJECT_GRAPH_ROLE
from merv.shared.content_summaries import content_tldr

from ..artifacts import Artifact, Artifacts
from ..research_core import EXPERIMENT_WORKFLOW, Research, preferred_artifact


Record = dict[str, Any]

_EXPERIMENT_PATH = EXPERIMENT_WORKFLOW.forward_path(EXPERIMENT_WORKFLOW.initial)
_EXECUTION_STATUS = next(iter(EXPERIMENT_WORKFLOW.effect_sources("result_submission")))
_PLAN_SUMMARY_STATUSES = frozenset(
    _EXPERIMENT_PATH[: _EXPERIMENT_PATH.index(_EXECUTION_STATUS) + 1]
)
_PROJECT_REFLECTION_ROLES = ("reflection_doc", PROJECT_GRAPH_ROLE)


class ProjectContextQuery:
    """Compose one macro packet without hydrating rich child state."""

    def __init__(self, *, research: Research, artifacts: Artifacts) -> None:
        self.research = research
        self.artifacts = artifacts

    def build(self, *, project_id: str | None = None) -> Record:
        facts = self.research.project_context_facts(project_id=project_id)
        project = facts["project"]
        resolved_project_id = str(project.get("id") or project_id or "") or None
        experiments = facts["experiments"]
        experiment_ids = tuple(str(row["id"]) for row in experiments)
        attempts = {
            str(row["id"]): int(row.get("attempt_index") or 0) for row in experiments
        }
        experiment_evidence = tuple(
            artifact
            for artifact in (
                self.artifacts.scan(
                    project_id=resolved_project_id,
                    target_type="experiment",
                    target_ids=experiment_ids,
                    roles=("plan", "report"),
                )
                if experiment_ids
                else ()
            )
            if artifact.attempt_index == attempts.get(artifact.target_id)
        )

        latest_published = facts.get("latest_published_reflection")
        reflection_evidence: tuple[Artifact, ...] = ()
        if isinstance(latest_published, dict):
            reflection_id = str(latest_published.get("id") or "")
            if reflection_id:
                reflection_evidence = tuple(
                    artifact
                    for artifact in self.artifacts.scan(
                        project_id=resolved_project_id,
                        target_type="reflection",
                        target_ids=(reflection_id,),
                        roles=_PROJECT_REFLECTION_ROLES,
                    )
                    if artifact.attempt_index
                    == int(latest_published.get("attempt_index") or 0)
                )
        summaries = self._artifact_summaries(
            artifacts=experiment_evidence + reflection_evidence,
            project_id=resolved_project_id,
        )
        evidence = _by_target(experiment_evidence)
        reflection_evidence_by_target = _by_target(reflection_evidence)

        return {
            "project": {
                "id": project.get("id"),
                "name": project.get("name"),
                "summary": project.get("summary", ""),
            },
            "reflection": self._reflection(
                latest=latest_published,
                open_wave=facts.get("open_reflection"),
                evidence=reflection_evidence_by_target,
                summaries=summaries,
            ),
            "literature": self._literature(facts),
            "claims": [dict(claim) for claim in facts["claims"]],
            "candidates": facts.get("candidates", {}),
            "experiments": [
                self._experiment(
                    experiment=row,
                    evidence=evidence.get(str(row["id"]), ()),
                    summaries=summaries,
                )
                for row in experiments
            ],
        }

    def _artifact_summaries(
        self,
        *,
        artifacts: tuple[Artifact, ...],
        project_id: str | None,
    ) -> dict[str, str]:
        if not artifacts:
            return {}
        found = self.artifacts.get(
            artifact_ids=tuple(artifact.id for artifact in artifacts),
            project_id=project_id,
            include="content",
        )
        content_by_id = {
            artifact.id: (
                artifact.data.decode("utf-8", errors="replace")
                if artifact.data is not None
                else None
            )
            for artifact in found
        }
        return {
            artifact.id: content_tldr(
                content_by_id.get(artifact.id),
                role=artifact.role,
                path=artifact.path,
            )
            for artifact in artifacts
        }

    @staticmethod
    def _experiment(
        *,
        experiment: Record,
        evidence: tuple[Artifact, ...],
        summaries: Mapping[str, str],
    ) -> Record:
        artifacts = [
            _artifact_record(item, tldr=summaries.get(item.id, "")) for item in evidence
        ]
        plan = preferred_artifact(artifacts=artifacts, roles=("plan",))
        report = preferred_artifact(artifacts=artifacts, roles=("report",))
        status = str(experiment.get("status") or "")
        preferred = plan if status in _PLAN_SUMMARY_STATUSES else report
        if preferred is None:
            preferred = report if status in _PLAN_SUMMARY_STATUSES else plan
        summary = str((preferred or {}).get("tldr") or "").strip()
        if not summary:
            summary = str(experiment.get("conclusion") or "").strip()
        if not summary:
            summary = str(experiment.get("intent") or "").strip()
        return {
            "id": experiment.get("id"),
            "name": experiment.get("name"),
            "status": status,
            "intent": experiment.get("intent"),
            "summary": summary,
            "tested_claim_ids": list(experiment.get("tested_claim_ids") or []),
            "updated_at": experiment.get("updated_at"),
        }

    @staticmethod
    def _reflection(
        *,
        latest: Record | None,
        open_wave: Record | None,
        evidence: Mapping[str, tuple[Artifact, ...]],
        summaries: Mapping[str, str],
    ) -> Record:
        published = None
        if latest:
            reflection_id = str(latest.get("id") or "")
            artifacts = [
                _artifact_record(item, tldr=summaries.get(item.id, ""))
                for item in evidence.get(reflection_id, ())
            ]
            document = preferred_artifact(
                artifacts=artifacts, roles=("reflection_doc",)
            )
            graph = preferred_artifact(artifacts=artifacts, roles=(PROJECT_GRAPH_ROLE,))
            summary = str((document or {}).get("tldr") or "").strip()
            if not summary:
                summary = str(latest.get("title") or "").strip()
            published = {
                "id": latest.get("id"),
                "published_at": latest.get("published_at"),
                "summary": summary,
                "artifacts": [
                    ProjectContextQuery._artifact_reference(
                        artifact, descriptor=descriptor
                    )
                    for artifact, descriptor in (
                        (document, "reflection document"),
                        (graph, "project graph"),
                    )
                    if artifact is not None
                ],
            }
        open_context = (
            {
                "id": open_wave.get("id"),
                "title": open_wave.get("title"),
                "status": open_wave.get("status"),
                "updated_at": open_wave.get("updated_at"),
            }
            if open_wave
            else None
        )
        return {
            "latest_published": published,
            "open_wave": open_context,
        }

    @staticmethod
    def _literature(facts: Record) -> Record:
        source = facts.get("literature_summary") or {}
        summary = str(source.get("tldr") or "").strip()
        if not summary and str(source.get("body") or "").strip():
            summary = content_tldr(source.get("body"), role="literature_summary")
        return {
            "summary": summary,
            "paper_count": int(facts.get("paper_count") or 0),
            "updated_at": source.get("updated_at") or None,
        }

    @staticmethod
    def _artifact_reference(artifact: Record, *, descriptor: str) -> Record:
        return {
            "descriptor": descriptor,
            "id": artifact.get("id"),
            "path": artifact.get("path"),
            "submitted_at": (
                artifact.get("updated_at") or artifact.get("created_at") or ""
            ),
        }


def _artifact_record(evidence: Artifact, *, tldr: str) -> Record:
    """Project the public evidence value into selector/presentation fields."""

    return {
        "id": evidence.id,
        "role": evidence.role,
        "path": evidence.path,
        "attempt_index": evidence.attempt_index,
        "created_at": evidence.created_at,
        "updated_at": evidence.updated_at,
        "submitted_order": evidence.order,
        "tldr": tldr,
    }


def _by_target(
    artifacts: tuple[Artifact, ...],
) -> dict[str, tuple[Artifact, ...]]:
    grouped: dict[str, list[Artifact]] = {}
    for artifact in artifacts:
        grouped.setdefault(artifact.target_id, []).append(artifact)
    return {
        target_id: tuple(target_artifacts)
        for target_id, target_artifacts in grouped.items()
    }


__all__ = ["ProjectContextQuery"]
