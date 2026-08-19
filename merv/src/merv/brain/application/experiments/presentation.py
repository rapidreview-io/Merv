# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Pure experiment projections owned by the application boundary."""

from __future__ import annotations

from typing import Any, Iterable, cast

from ...research_core import ExperimentState, SYNOPSIS_MAX_LEN
from ...object_storage import ProducedObject
from .claim_guidance import claim_update_suggestions


class SlimExperimentState(ExperimentState, total=False):
    """Agent-facing experiment detail: workflow substance without bookkeeping."""


_SLIM_ARTIFACT_FIELDS = (
    "id",
    "role",
    "path",
    "lens_id",
    "size_bytes",
    "title",
    "tldr",
)
_SLIM_STORAGE_FIELDS = tuple(
    field
    for field in ProducedObject.__annotations__
    if field not in {"created_at", "updated_at", "last_accessed_at"}
)
_PRIOR_ARTIFACT_FIELDS = (
    "id",
    "role",
    "path",
    "attempt_index",
    "tldr",
)
_SLIM_CLAIM_FIELDS = ("id", "statement", "confidence", "status", "scope")
_SLIM_DEPENDENCY_FIELDS = ("id", "node_type", "name", "status", "settled", "failed")
_SLIM_REVIEW_FIELDS = (
    "id",
    "role",
    "verdict",
    "created_at",
    "synopsis",
    "findings",
    "notes",
    "evidence",
)
_TLDR_REVIEW_FIELDS = ("id", "role", "verdict", "created_at", "synopsis")


def project_fields(record: dict[str, Any], fields: Iterable[str]) -> dict[str, Any]:
    return {field: record.get(field) for field in fields}


def project_rows(
    records: Iterable[dict[str, Any]], fields: Iterable[str]
) -> list[dict[str, Any]]:
    fields = tuple(fields)
    return [project_fields(record, fields) for record in records]


def slim_review_rows(reviews: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project every review to its TLDR; bodies require an explicit id read."""

    rows = list(reviews)
    return [_review_tldr(row) for row in rows]


def review_body(
    reviews: Iterable[dict[str, Any]], *, review_id: str
) -> dict[str, Any] | None:
    """Read one review's full prose back out of a state whose bodies are intact."""

    match = next(
        (row for row in reviews if str(row.get("id") or "") == review_id), None
    )
    if match is None:
        return None
    body = project_fields(match, _SLIM_REVIEW_FIELDS)
    if match.get("return_to"):
        body["return_to"] = match["return_to"]
    return body


def _review_tldr(review: dict[str, Any]) -> dict[str, Any]:
    row = project_fields(review, _TLDR_REVIEW_FIELDS)
    row["synopsis"] = (
        _compact_tldr(row.get("synopsis"))
        or _notes_tldr(review.get("notes"))
        or _finding_tldr(review.get("findings"))
        or _legacy_review_tldr(review)
    )
    return row


def _compact_tldr(value: Any) -> str:
    """Normalize legacy prose to the current one-line synopsis envelope."""

    compact = " ".join(str(value or "").split())
    if len(compact) <= SYNOPSIS_MAX_LEN:
        return compact
    clipped = compact[: SYNOPSIS_MAX_LEN - 1].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0].rstrip()
    return clipped + "…"


def _notes_tldr(notes: Any) -> str:
    """Use the first authored notes line for pre-synopsis review rows."""

    for line in str(notes or "").splitlines():
        if line.strip():
            return _compact_tldr(line)
    return ""


def _finding_tldr(findings: Any) -> str:
    if not isinstance(findings, list):
        return ""
    issues = [
        str(finding.get("issue") or "").strip()
        for finding in findings
        if isinstance(finding, dict) and str(finding.get("issue") or "").strip()
    ]
    return _compact_tldr("Review finding: " + "; ".join(issues[:3])) if issues else ""


def _legacy_review_tldr(review: dict[str, Any]) -> str:
    verdict = str(review.get("verdict") or "completed").replace("_", " ")
    role = str(review.get("role") or "review").replace("_", " ")
    return _compact_tldr(
        f"The {role} returned {verdict}; this legacy review stored no narrative synopsis."
    )


def rich_experiment_state(
    full: ExperimentState,
    *,
    storage_objects: Iterable[ProducedObject | dict[str, Any]],
    include_legacy_tracking: bool = False,
) -> ExperimentState:
    """Attach Storage facts without mutating Research's authoritative state.

    Legacy tracking state is deliberately omitted from this public projection.
    The persisted columns remain intact so the integration can be reintroduced
    without a data migration.
    """

    result = (
        dict(full)
        if include_legacy_tracking
        else {
            key: value
            for key, value in full.items()
            if "mlflow" not in str(key).lower()
        }
    )
    if isinstance(result.get("mlflow_run"), dict):
        result["mlflow_run"] = {
            key: value
            for key, value in result["mlflow_run"].items()
            if key != "delivery_id"
        }
    if "gate_checklist" in result and "claim_update_suggestions" not in result:
        items = list(result.items())
        index = list(result).index("gate_checklist") + 1
        items.insert(
            index, ("claim_update_suggestions", claim_update_suggestions(full))
        )
        result = dict(items)
    result.pop("storage_objects", None)
    items = list(result.items())
    storage_item = ("storage_objects", list(storage_objects))
    if include_legacy_tracking and "mlflow_run" in result:
        index = list(result).index("mlflow_run")
        items.insert(index, storage_item)
    else:
        items.append(storage_item)
    return cast(ExperimentState, dict(items))


def slim_experiment_state(
    full: ExperimentState,
    *,
    storage_objects: Iterable[ProducedObject | dict[str, Any]],
    include_legacy_tracking: bool = False,
) -> SlimExperimentState:
    """Project rich experiment facts to the exact agent-facing wire shape."""

    rich = rich_experiment_state(
        full,
        storage_objects=storage_objects,
        include_legacy_tracking=include_legacy_tracking,
    )
    attempt = rich.get("attempt_index")
    all_artifacts = rich.get("artifacts", [])
    current = rich.get("current_attempt_artifacts")
    if current is None:
        current = [
            artifact
            for artifact in all_artifacts
            if artifact.get("attempt_index") == attempt
        ]
    prior = [
        artifact
        for artifact in all_artifacts
        if artifact.get("attempt_index") != attempt
    ]

    slim: dict[str, Any] = {
        "id": rich.get("id"),
        "name": rich.get("name"),
        "status": rich.get("status"),
        "attempt_index": attempt,
        "intent": rich.get("intent"),
        "conclusion": rich.get("conclusion"),
        "revision_context": rich.get("revision_context"),
        "created_at": rich.get("created_at"),
        "updated_at": rich.get("updated_at"),
        "allowed_transitions": rich.get("allowed_transitions", []),
        "gate_checklist": rich.get("gate_checklist", {}),
    }
    if include_legacy_tracking:
        slim["mlflow_run"] = rich.get("mlflow_run")
    slim.update(
        {
            "claim_update_suggestions": rich.get("claim_update_suggestions", []),
            "tested_claims": project_rows(
                rich.get("tested_claims", []), _SLIM_CLAIM_FIELDS
            ),
            "dependencies": project_rows(
                rich.get("dependencies", []), _SLIM_DEPENDENCY_FIELDS
            ),
            "current_attempt_artifacts": project_rows(current, _SLIM_ARTIFACT_FIELDS),
            "storage_objects": project_rows(
                rich.get("storage_objects", []), _SLIM_STORAGE_FIELDS
            ),
            "reviews": slim_review_rows(rich.get("reviews", [])),
        }
    )
    if prior:
        slim["prior_attempt_artifacts"] = project_rows(prior, _PRIOR_ARTIFACT_FIELDS)
    return cast(SlimExperimentState, slim)


__all__ = [
    "SlimExperimentState",
    "claim_update_suggestions",
    "project_fields",
    "project_rows",
    "review_body",
    "rich_experiment_state",
    "slim_experiment_state",
    "slim_review_rows",
]
