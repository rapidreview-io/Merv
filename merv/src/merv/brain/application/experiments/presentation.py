# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Pure experiment projections owned by the application boundary."""

from __future__ import annotations

from typing import Any, Iterable, Protocol, cast

from ...research_core import (
    EXPERIMENT,
    SYNOPSIS_MAX_LEN,
    ExperimentState,
    ProducedObject,
    project_fields,
    project_rows,
    public_record,
)
from ...workflows import Public

# What an agent reading an experiment does not need: the project it named to
# ask, the whole artifact history, and the sealed submission rounds.
AGENT = Public(hidden=("project_id", "artifacts", "submissions", "dependents"),
               after=EXPERIMENT.public.after)

_CLAIM_ROW = ("id", "statement", "confidence", "status", "scope")
_DEPENDENCY_ROW = ("id", "node_type", "name", "status", "settled", "failed")
_ARTIFACT_ROW = ("id", "role", "path", "lens_id", "size_bytes", "title", "tldr")
_PRIOR_ARTIFACT_ROW = ("id", "role", "path", "attempt_index", "tldr")
_STORAGE_ROW = tuple(
    field for field in ProducedObject.__annotations__ if field != "created_at"
)
_REVIEW_TLDR = ("id", "role", "verdict", "created_at", "synopsis")
_REVIEW_BODY = (*_REVIEW_TLDR, "findings", "notes", "evidence")


class SlimExperimentState(ExperimentState, total=False):
    """Agent-facing experiment detail: workflow substance without bookkeeping."""


class ProducedObjectCatalog(Protocol):
    """Research's own record of the heavy objects its experiments produced."""

    def by_experiment(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[ProducedObject]]: ...

    def association(
        self, *, project_id: str, object_id: str
    ) -> dict[str, Any] | None: ...


def review_synopsis(review: dict[str, Any]) -> str:
    """The one line a review row shows, clipped to the synopsis envelope.

    Reviews written before the synopsis field carry their narrative in notes
    or findings; the last resort states the verdict itself, so no row is blank.
    """
    findings = review.get("findings")
    issues = [
        text
        for finding in (findings if isinstance(findings, list) else ())
        if isinstance(finding, dict) and (text := str(finding.get("issue") or "").strip())
    ]
    verdict = str(review.get("verdict") or "completed").replace("_", " ")
    role = str(review.get("role") or "review").replace("_", " ")
    line = next(
        text
        for text in (
            str(review.get("synopsis") or ""),
            *str(review.get("notes") or "").splitlines(),
            *(("Review finding: " + "; ".join(issues[:3]),) if issues else ()),
            f"The {role} returned {verdict}; this legacy review stored no "
            "narrative synopsis.",
        )
        if text.strip()
    )
    compact = " ".join(line.split())
    if len(compact) <= SYNOPSIS_MAX_LEN:
        return compact
    clipped = compact[: SYNOPSIS_MAX_LEN - 1].rstrip()
    return (clipped.rsplit(" ", 1)[0].rstrip() if " " in clipped else clipped) + "…"


def slim_review_rows(reviews: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project every review to its TLDR; bodies require an explicit id read."""
    return [
        {**project_fields(review, _REVIEW_TLDR), "synopsis": review_synopsis(review)}
        for review in reviews
    ]


def review_body(
    reviews: Iterable[dict[str, Any]], *, review_id: str
) -> dict[str, Any] | None:
    """Read one review's full prose back out of a state whose bodies are intact."""
    match = next(
        (row for row in reviews if str(row.get("id") or "") == review_id), None
    )
    if match is None:
        return None
    body = project_fields(match, _REVIEW_BODY)
    if match.get("return_to"):
        body["return_to"] = match["return_to"]
    return body


def rich_experiment_state(
    full: ExperimentState,
    *,
    storage_objects: Iterable[ProducedObject | dict[str, Any]],
) -> ExperimentState:
    """Attach Storage facts without mutating Research's authoritative state."""
    return cast(ExperimentState, public_record(
        EXPERIMENT.public,
        full,
        storage_objects=list(storage_objects),
    ))


def slim_experiment_state(
    full: ExperimentState,
    *,
    storage_objects: Iterable[ProducedObject | dict[str, Any]],
) -> SlimExperimentState:
    """Project rich experiment facts to the exact agent-facing wire shape."""
    rich = rich_experiment_state(full, storage_objects=storage_objects)
    attempt = rich.get("attempt_index")
    history = rich.get("artifacts", [])
    current = rich.get("current_attempt_artifacts")
    if current is None:
        current = [item for item in history if item.get("attempt_index") == attempt]
    prior = [item for item in history if item.get("attempt_index") != attempt]
    slim = public_record(
        AGENT,
        rich,
        tested_claims=project_rows(rich.get("tested_claims", []), _CLAIM_ROW),
        dependencies=project_rows(rich.get("dependencies", []), _DEPENDENCY_ROW),
        current_attempt_artifacts=project_rows(current, _ARTIFACT_ROW),
        storage_objects=project_rows(rich.get("storage_objects", []), _STORAGE_ROW),
        reviews=slim_review_rows(rich.get("reviews", [])),
    )
    if prior:
        slim["prior_attempt_artifacts"] = project_rows(prior, _PRIOR_ARTIFACT_ROW)
    return cast(SlimExperimentState, slim)


__all__ = [
    "ProducedObjectCatalog",
    "SlimExperimentState",
    "review_body",
    "review_synopsis",
    "rich_experiment_state",
    "slim_experiment_state",
    "slim_review_rows",
]
