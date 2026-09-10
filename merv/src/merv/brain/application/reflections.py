# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Application-facing reflection commands and response presentation."""

from __future__ import annotations

from typing import Any

from ..research_core import content_tldr

from ..research_core import REFLECTION_WORKFLOW
from .experiments.presentation import slim_review_rows
from .reflection_guidance import post_publish_guidance, present_reflection_signal

Record = dict[str, Any]


def present_reflection_state(state: Record) -> Record:
    result = dict(state)
    materialized = result.get("materialized_experiments")
    if result.get("status") == REFLECTION_WORKFLOW.success_status and materialized:
        items = list(result.items())
        index = list(result).index("materialized_experiments") + 1
        items.insert(
            index,
            (
                "post_publish_guidance",
                post_publish_guidance(materialized_experiments=materialized),
            ),
        )
        result = dict(items)
    return result


def present_agent_reflection_state(
    state: Record, *, include_content: bool = False
) -> Record:
    """Agent reflection state: TLDRs by default, exact documents on opt-in."""

    presented = present_reflection_state(state)
    if include_content:
        return presented
    result = dict(presented)
    result["reviews"] = slim_review_rows(result.get("reviews", []))
    result["current_attempt_artifacts"] = [
        _slim_content_artifact(artifact)
        for artifact in result.get("current_attempt_artifacts", [])
    ]
    corpus = dict(result.get("corpus") or {})
    corpus["previous_lens_reflections"] = {
        str(lens_id): _slim_content_artifact(artifact)
        for lens_id, artifact in (corpus.get("previous_lens_reflections") or {}).items()
        if isinstance(artifact, dict)
    }
    corpus["previous_published_artifacts"] = {
        str(role): _slim_content_artifact(artifact)
        for role, artifact in (corpus.get("previous_published_artifacts") or {}).items()
        if isinstance(artifact, dict)
    }
    corpus["terminal_experiments"] = [
        {
            **experiment,
            "artifacts": [
                _slim_content_artifact(artifact)
                for artifact in experiment.get("artifacts", [])
                if isinstance(artifact, dict)
            ],
        }
        for experiment in corpus.get("terminal_experiments", [])
        if isinstance(experiment, dict)
    ]
    result["corpus"] = corpus
    return result


def _slim_content_artifact(artifact: Record) -> Record:
    if "content" not in artifact:
        return dict(artifact)
    result: Record = {}
    for key, value in artifact.items():
        if key == "content":
            result["tldr"] = content_tldr(
                value,
                role=str(artifact.get("role") or ""),
                path=str(artifact.get("path") or ""),
            )
        else:
            result[key] = value
    return result


def present_reflection_overview(overview: Record) -> Record:
    state_keys = {"current", "open_reflection", "latest_published"}
    result = dict(overview)
    result["reflections"] = [
        present_reflection_state(item) for item in result.get("reflections", [])
    ]
    for key in state_keys:
        if isinstance(result.get(key), dict):
            result[key] = present_reflection_state(result[key])
    if isinstance(result.get("signal"), dict):
        result["signal"] = present_reflection_signal(result["signal"])
    return result


def consolidation_packet(
    state: Record,
    *,
    workspaces: dict[str, Record],
) -> Record:
    """The compact, immutable handoff a code consolidator actually needs."""
    authoritative_roles = {"project_graph", "reflection_doc", "change_spec"}
    approved = [
        {
            key: value
            for key, value in artifact.items()
            if key in {"id", "artifact_id", "role", "path", "content", "tldr"}
        }
        for artifact in state.get("current_attempt_artifacts", [])
        if artifact.get("role") in authoritative_roles
    ]
    experiments = []
    for experiment in (state.get("corpus") or {}).get("terminal_experiments", []):
        if not isinstance(experiment, dict) or not experiment.get("id"):
            continue
        experiment_id = str(experiment["id"])
        artifacts = [
            {
                **{
                    key: value
                    for key, value in artifact.items()
                    if key in {"artifact_id", "id", "role", "path", "tldr"}
                },
                **(
                    {
                        "tldr": content_tldr(
                            artifact.get("content"),
                            role=str(artifact.get("role") or ""),
                            path=str(artifact.get("path") or ""),
                        )
                    }
                    if "content" in artifact
                    else {}
                ),
            }
            for artifact in experiment.get("artifacts", [])
            if isinstance(artifact, dict)
        ]
        experiments.append(
            {
                "id": experiment_id,
                "name": experiment.get("name", ""),
                "status": experiment.get("status", ""),
                "attempt_index": experiment.get("attempt_index", 0),
                "artifacts": artifacts,
                "workspace": workspaces.get(experiment_id),
            }
        )
    proposal = (state.get("consolidation") or {}).get("proposal") or {}
    advance = (state.get("consolidation") or {}).get("advance") or {}
    return {
        "reflection": {
            "id": state.get("id"),
            "title": state.get("title", ""),
            "status": state.get("status"),
            "attempt_index": state.get("attempt_index"),
            "created_at": state.get("created_at"),
            "published_at": state.get("published_at"),
            "reviews": slim_review_rows(state.get("reviews", [])),
            "reviewed_artifacts": approved,
        },
        "base_sha": (
            advance.get("observed_sha")
            if advance.get("status") == "stale"
            else proposal.get("base_sha")
        )
        or "",
        "experiments": experiments,
        "consolidation": state.get("consolidation") or {},
        "revision_context": state.get("revision_context", ""),
    }


__all__ = [
    "present_agent_reflection_state",
    "consolidation_packet",
    "present_reflection_overview",
    "present_reflection_state",
]
