# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Application-facing reflection commands and response presentation."""

from __future__ import annotations

from typing import Any

from ..research_core import (
    REFLECTION,
    content_tldr,
    project_fields,
    public_record,
)
from ..workflows import Public
from .experiments.presentation import slim_review_rows
from .reflection_guidance import post_publish_guidance, present_reflection_signal

Record = dict[str, Any]

# A published wave's guidance is about the experiments it just created, and an
# agent reads the two together; the reflection row has no other ordered field.
# It is declared here rather than on the kind because the reflection graph is
# owned by a parallel change.
PUBLIC = Public(after={"post_publish_guidance": "materialized_experiments"})
AUTHORITATIVE_ROLES = frozenset({"project_graph", "reflection_doc", "change_spec"})
_PACKET_REFLECTION = ("id", "title", "status", "attempt_index", "created_at", "published_at")
_PACKET_ARTIFACT = ("id", "artifact_id", "role", "path", "content", "tldr")
_PACKET_CORPUS_ARTIFACT = ("artifact_id", "id", "role", "path", "tldr")
_PACKET_EXPERIMENT = ("id", "name", "status", "attempt_index")


def _kept(record: Record, fields: tuple[str, ...]) -> Record:
    """Drop everything but these fields, without inventing the absent ones."""
    return {key: value for key, value in record.items() if key in fields}


def _tldr(artifact: Record) -> str:
    return content_tldr(artifact.get("content"), role=str(artifact.get("role") or ""),
                        path=str(artifact.get("path") or ""))


def _tldr_only(artifact: Record) -> Record:
    """Replace a document's bytes with the one line that stands in for them."""
    if "content" not in artifact:
        return dict(artifact)
    return {("tldr" if key == "content" else key):
            (_tldr(artifact) if key == "content" else value)
            for key, value in artifact.items()}


def present_reflection_state(state: Record) -> Record:
    materialized = state.get("materialized_experiments")
    published = state.get("status") == REFLECTION.success_status
    return public_record(PUBLIC, state, **(
        {"post_publish_guidance": post_publish_guidance(materialized_experiments=materialized)}
        if published and materialized else {}
    ))


def present_agent_reflection_state(
    state: Record, *, include_content: bool = False
) -> Record:
    """Agent reflection state: TLDRs by default, exact documents on opt-in."""
    presented = present_reflection_state(state)
    if include_content:
        return presented
    corpus = dict(presented.get("corpus") or {})
    for key in ("previous_lens_reflections", "previous_published_artifacts"):
        corpus[key] = {
            str(name): _tldr_only(artifact)
            for name, artifact in (corpus.get(key) or {}).items()
            if isinstance(artifact, dict)
        }
    corpus["terminal_experiments"] = [
        {**experiment, "artifacts": [_tldr_only(artifact)
                                     for artifact in experiment.get("artifacts", [])
                                     if isinstance(artifact, dict)]}
        for experiment in corpus.get("terminal_experiments", [])
        if isinstance(experiment, dict)
    ]
    return public_record(
        PUBLIC,
        presented,
        reviews=slim_review_rows(presented.get("reviews", [])),
        current_attempt_artifacts=[
            _tldr_only(artifact)
            for artifact in presented.get("current_attempt_artifacts", [])
        ],
        corpus=corpus,
    )


def present_reflection_overview(overview: Record) -> Record:
    result = dict(overview)
    result["reflections"] = [
        present_reflection_state(item) for item in result.get("reflections", [])
    ]
    for key in ("current", "open_reflection", "latest_published"):
        if isinstance(result.get(key), dict):
            result[key] = present_reflection_state(result[key])
    if isinstance(result.get("signal"), dict):
        result["signal"] = present_reflection_signal(result["signal"])
    return result


def consolidation_packet(state: Record, *, workspaces: dict[str, Record]) -> Record:
    """The compact, immutable handoff a code consolidator actually needs."""
    consolidation = state.get("consolidation") or {}
    advance = consolidation.get("advance") or {}
    stale = advance.get("status") == "stale"
    return {
        "reflection": {
            **project_fields(state, _PACKET_REFLECTION),
            "reviews": slim_review_rows(state.get("reviews", [])),
            "reviewed_artifacts": [
                _kept(artifact, _PACKET_ARTIFACT)
                for artifact in state.get("current_attempt_artifacts", [])
                if artifact.get("role") in AUTHORITATIVE_ROLES
            ],
        },
        "base_sha": (advance.get("observed_sha") if stale
                     else (consolidation.get("proposal") or {}).get("base_sha")) or "",
        "experiments": [
            {
                **project_fields(experiment, _PACKET_EXPERIMENT),
                "artifacts": [
                    {**_kept(artifact, _PACKET_CORPUS_ARTIFACT),
                     **({"tldr": _tldr(artifact)} if "content" in artifact else {})}
                    for artifact in experiment.get("artifacts", [])
                    if isinstance(artifact, dict)
                ],
                "workspace": workspaces.get(str(experiment["id"])),
            }
            for experiment in (state.get("corpus") or {}).get("terminal_experiments", [])
            if isinstance(experiment, dict) and experiment.get("id")
        ],
        "consolidation": consolidation,
        "revision_context": state.get("revision_context", ""),
    }


__all__ = [
    "present_agent_reflection_state",
    "consolidation_packet",
    "present_reflection_overview",
    "present_reflection_state",
]
