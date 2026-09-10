"""What a reflection wave reads: its fixed corpus, its diff, its code state.

These are the wave's reads, and they are research logic, so they live beside
the graph that declares them rather than inside the record service. Every
function here is pure: rows and submitted bytes arrive as arguments, and what
comes back is exactly the shape a brief, a gate or a presenter renders.
"""

from __future__ import annotations

import json
from typing import Any

from .artifact_roles import METRIC_RESULT_MAX_BYTES, PROJECT_GRAPH_ROLE, REFLECTION_LENS_DOC_ROLE
from .documents import (
    artifact_submission_recency_key,
    graph_diff,
    graph_diff_summary,
    graph_problems,
    preferred_artifact,
)

# Which submitted roles a wave shows in full when a caller asks for content.
HYDRATED_ROLES = frozenset({REFLECTION_LENS_DOC_ROLE, PROJECT_GRAPH_ROLE, "reflection_doc", "change_spec"})


def newest_by(records, key: str) -> dict[str, dict[str, Any]]:
    """The latest submission per value of ``key``, by submission recency."""
    newest: dict[str, dict[str, Any]] = {}
    for record in records:
        held = newest.get(str(record.get(key) or ""))
        if held is None or artifact_submission_recency_key(record) > artifact_submission_recency_key(held):
            newest[str(record.get(key) or "")] = record
    return newest


def content_reference(artifact: dict[str, Any]) -> dict[str, Any]:
    """A corpus entry names submitted bytes; it never copies them."""
    return {"artifact_id": artifact.get("id"), "path": artifact.get("path"),
            "role": artifact.get("role"), "submitted_order": artifact.get("submitted_order")}


def authoritative_references(*, artifacts, attempt_index: int, roles: tuple[str, ...]) -> list[dict[str, Any]]:
    """One reference per role: the current attempt's latest submission of it."""
    current = [item for item in artifacts if item.get("attempt_index") == attempt_index and item.get("role") in roles]
    newest = newest_by(current, "role")
    return [content_reference(newest[role]) for role in roles if role in newest]


def corpus_snapshot(
    *, captured_at: str, experiments: list[dict[str, Any]], tasks: list[dict[str, Any]],
    claims: list[dict[str, Any]], previous: dict[str, Any] | None, covered: set[str], covered_tasks: set[str],
) -> dict[str, Any]:
    """The fixed corpus one wave reasons over, pinned the moment it is created.

    The wave's new signal is the terminal work the last published wave never
    saw. The reflection still reads the whole project; these name why it is
    happening now. Prior artifacts are pinned by id and hydrated only on
    focused reads.
    """
    graph = None if previous is None else preferred_artifact(
        artifacts=previous.get("current_attempt_artifacts") or [], roles=(PROJECT_GRAPH_ROLE,))
    doc = None if previous is None else preferred_artifact(
        artifacts=previous.get("current_attempt_artifacts") or [], roles=("reflection_doc",))
    return {
        "captured_at": captured_at,
        "terminal_experiments": experiments,
        "terminal_tasks": tasks,
        "claims": claims,
        "new_terminal_experiments": [{"id": item["id"], "name": item["name"], "status": item["status"]}
                                     for item in experiments if str(item["id"]) not in covered],
        "new_terminal_tasks": [{"id": item["id"], "name": item["name"], "status": item["status"]}
                               for item in tasks if str(item["id"]) not in covered_tasks],
        "previous_published_reflection_id": None if previous is None else previous["id"],
        "previous_lens_reflections": {} if previous is None else {
            str(lens["lens_id"]): {key: lens[key] for key in ("artifact_id", "path", "role", "submitted_order")}
            for lens in previous["reflection_coverage"]["lenses"] if lens.get("covered")},
        "previous_published_artifacts": {role: content_reference(artifact)
                                         for role, artifact in ((PROJECT_GRAPH_ROLE, graph), ("reflection_doc", doc))
                                         if artifact is not None},
    }


def referenced_content_ids(*, corpus: dict[str, Any], current: list[dict[str, Any]]) -> tuple[str, ...]:
    """Every submitted content id this wave would show, named once."""
    nodes = (*(corpus.get("terminal_experiments") or ()), *(corpus.get("terminal_tasks") or ()))
    references = [
        *current,
        *(corpus.get("previous_lens_reflections") or {}).values(),
        *(corpus.get("previous_published_artifacts") or {}).values(),
        *(item for node in nodes if isinstance(node, dict) for item in node.get("artifacts") or ()),
    ]
    return tuple(dict.fromkeys(
        str(item.get("artifact_id") or item.get("id") or "")
        for item in references if isinstance(item, dict) and (item.get("artifact_id") or item.get("id"))))


def with_content(artifact: dict[str, Any], content: dict[str, bytes | None]) -> dict[str, Any]:
    """One reference plus its bytes as text, bounded and marked when truncated."""
    data = content.get(str(artifact.get("artifact_id") or artifact.get("id") or ""))
    text, truncated = None, False
    if data is not None:
        truncated = len(data) > METRIC_RESULT_MAX_BYTES
        encoded = data[:METRIC_RESULT_MAX_BYTES].decode("utf-8", errors="replace").encode("utf-8")
        text = encoded[:METRIC_RESULT_MAX_BYTES].decode("utf-8", errors="ignore")
    return {**{key: value for key, value in artifact.items() if key != "tldr"},
            "content": text, "content_available": text is not None, "content_truncated": truncated}


def hydrated_artifacts(*, artifacts: list[dict[str, Any]], content: dict[str, bytes | None]) -> list[dict[str, Any]]:
    """This attempt's submissions, one lens document per lens, bytes included."""
    lens_docs = [item for item in artifacts if item.get("role") == REFLECTION_LENS_DOC_ROLE]
    authoritative = {str(item.get("id") or "") for item in newest_by(lens_docs, "lens_id").values()}
    return [with_content(item, content) if item.get("role") in HYDRATED_ROLES else item
            for item in artifacts
            if item.get("role") != REFLECTION_LENS_DOC_ROLE or str(item.get("id") or "") in authoritative]


def hydrated_corpus(*, corpus: dict[str, Any], content: dict[str, bytes | None],
                    claims: list[dict[str, Any]]) -> dict[str, Any]:
    """The fixed corpus with every reference it pinned read back as text."""
    def nodes(key: str) -> list[dict[str, Any]]:
        return [{**node, "artifacts": [with_content(dict(item), content) for item in node.get("artifacts") or ()
                                       if isinstance(item, dict)]}
                for node in corpus.get(key) or () if isinstance(node, dict)]

    return {
        **corpus, "claims": claims, "terminal_experiments": nodes("terminal_experiments"),
        "terminal_tasks": nodes("terminal_tasks"),
        "previous_lens_reflections": {
            str(lens_id): with_content(
                dict(raw) if isinstance(raw, dict)
                else {"artifact_id": None, "path": str(raw), "role": REFLECTION_LENS_DOC_ROLE}, content)
            for lens_id, raw in (corpus.get("previous_lens_reflections") or {}).items()},
        "previous_published_artifacts": {
            str(role): with_content(dict(item), content)
            for role, item in (corpus.get("previous_published_artifacts") or {}).items() if isinstance(item, dict)},
    }


def consolidation_state(*, proposal: dict[str, Any] | None, decisions: list[dict[str, Any]],
                        corpus: dict[str, Any], review: dict[str, Any] | None,
                        advance: dict[str, Any] | None) -> dict[str, Any]:
    """Where code consolidation stands: one decision per experiment in the corpus.

    A disposition the proposal never gave reads as pending, and an integration
    counts as merged only where the runner's independent ancestry receipt says
    the experiment's own history is actually reachable from central.
    """
    by_experiment = {str(item["experiment_id"]): item for item in decisions}
    pending = {"disposition": "pending", "rationale": "", "source_sha": "",
               "integration_kind": "none", "superseded_by": ""}
    ancestry = (advance or {}).get("ancestry") or {}
    covered = []
    for experiment in corpus.get("terminal_experiments") or ():
        if not (isinstance(experiment, dict) and experiment.get("id")):
            continue
        experiment_id = str(experiment["id"])
        decision = {"experiment_id": experiment_id, "experiment_name": str(experiment.get("name") or ""),
                    **by_experiment.get(experiment_id, pending)}
        covered.append({**decision, **integration_outcome(decision=decision, ancestry=ancestry)})
    considered = sum(decision["disposition"] != "pending" for decision in covered)
    return {
        "proposal": proposal, "decisions": covered,
        "coverage": {"total": len(covered), "considered": considered,
                     "pending": len(covered) - considered, "complete": considered == len(covered)},
        "review": review, "advance": advance,
    }


def integration_outcome(*, decision: dict[str, Any], ancestry: dict[str, Any],
                        unapplied: tuple[str, ...] = ("pending", "reviewed_not_used", "superseded")) -> dict[str, Any]:
    """Whether one decision's code actually reached central, and how."""
    verified = bool(ancestry.get(str(decision["experiment_id"]), False))
    return {"ancestry_verified": verified,
            "integration_outcome": "not_applied" if str(decision.get("disposition") or "") in unapplied
            else "merged" if verified and decision.get("integration_kind") in {"merge", "fast_forward"}
            else "applied"}


def graph_comparison(*, base: dict[str, Any] | None, current_graph_version_id: str,
                     current_reflection_id: str, read: dict[str, dict[str, str]]) -> dict[str, Any]:
    """This wave's project graph against the last published one, or why not.

    ``read`` maps an artifact id to the graph bytes as ``text`` or why they
    could not be read as ``error``; a diff is offered only when both sides
    parse, and every reason one could not is reported instead.
    """
    result: dict[str, Any] = {
        "available": False, "reason": "", "summary": "",
        "base_reflection_id": (base or {}).get("reflection_id"),
        "base_graph_version_id": (base or {}).get("graph_version_id"),
        "current_reflection_id": current_reflection_id,
        "current_graph_version_id": current_graph_version_id or None, "problems": [],
    }
    if not current_graph_version_id:
        return {**result, "reason": "no_current_project_graph",
                "summary": "No current project graph is associated for this reflection wave."}
    if base is None or not base.get("graph_version_id"):
        return {**result, "reason": "no_previous_project_graph",
                "summary": "No previous published project graph is available to compare."}
    graphs, problems = {}, []
    for artifact_id, what in ((str(base["graph_version_id"]), "previous project logic graph"),
                              (current_graph_version_id, "current project logic graph")):
        found = read.get(artifact_id) or {"error": f"{what} was not read"}
        if found.get("error"):
            problems.append(found["error"])
            continue
        breaks = graph_problems(found["text"])
        problems.extend(f"{what}: {problem}" for problem in breaks)
        if not breaks:
            graphs[what] = json.loads(found["text"])
    if problems or len(graphs) != 2:
        return {**result, "reason": "graph_unavailable", "problems": problems,
                "summary": "Project graph diff is unavailable because one graph cannot be read."}
    diff = graph_diff(base_graph=graphs["previous project logic graph"],
                      current_graph=graphs["current project logic graph"])
    return {**result, **diff, "available": True, "summary": graph_diff_summary(diff=diff)}
