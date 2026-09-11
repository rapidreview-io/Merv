"""The independent review a target's read-only node waits for.

A request pins the exact target snapshot; one reviewer session starts it; it
ends in a verdict, or superseded when a fresh capability revokes it. No node
carries a role: the reviewer is dispatched by the *target's* read-only node, so
a review instance is never assigned to anyone and decides nothing from project
facts — its verdict is the payload it was submitted with.
"""

from __future__ import annotations

from ...kernel.utils import ValidationError
from ..graph import Change, Edge, Metadata, Node, RecordKind, ReviewReturn, TransactionalEffect, Workflow
from .research_contracts import ENTITY_ID_RE, ENTITY_REF_VOCABULARY

REVIEW_VERDICT_VALUES = ("pass", "needs_changes", "fail")
REVIEW_VERDICTS = frozenset(REVIEW_VERDICT_VALUES)
SYNOPSIS_MIN_LEN = 40
SYNOPSIS_MAX_LEN = 420


def validate_review_verdict(*, verdict: str) -> None:
    if verdict not in REVIEW_VERDICTS:
        raise ValidationError(f"unknown review verdict: {verdict}")


def validate_synopsis(value: str) -> str:
    synopsis = value.strip()
    hint = (
        "synopsis is the researcher's TLDR: 1-3 plain sentences, 40-420 "
        "chars, no entity ids or markdown — describe what happened in "
        "human terms"
    )
    if not (SYNOPSIS_MIN_LEN <= len(synopsis) <= SYNOPSIS_MAX_LEN):
        raise ValueError(hint)
    if "\n" in synopsis:
        raise ValueError(f"{hint} (no newlines — keep it to one line)")
    if "`" in synopsis:
        raise ValueError(f"{hint} (no backticks — plain prose only)")
    if synopsis.startswith("#"):
        raise ValueError(f"{hint} (no markdown headings)")
    if ENTITY_ID_RE.search(synopsis):
        prefixes = "/".join(prefix for prefix, _ in ENTITY_REF_VOCABULARY)
        raise ValueError(
            f"{hint} (no entity ids like {prefixes} — name things by their "
            "human names instead)"
        )
    return synopsis


def resolve_review_return(
    *, kind: RecordKind, role: str, verdict: str, return_to: str
) -> ReviewReturn | None:
    """Validate a submitted review's routing input against the target's gates.

    The target's graph decides which edge the verdict eventually takes; this
    only refuses an input the gate's declared returns cannot honour.
    """
    value = (return_to or "").strip()
    if verdict == "pass":
        if value:
            raise ValidationError("return_to only applies when the verdict is needs_changes or fail")
        return None
    gate = kind.review_gate(role)
    subject = kind.metadata.subject or kind.name
    if verdict == "fail" and gate is not None and gate.fail_route is not None:
        if value and value != gate.fail_route.to_status:
            raise ValidationError(
                f"a fail verdict from {role} ends the {subject}: return_to must be omitted or "
                f"{gate.fail_route.to_status!r}; use needs_changes to send it back")
        return gate.fail_route
    routes = gate.returns if gate is not None and gate.returns else kind.review_returns
    for destination, message in () if gate is None else gate.forbidden_returns:
        if value == destination:
            raise ValidationError(message)
    if gate is not None and gate.return_choice_required and not value:
        raise ValidationError(gate.return_required_error)
    route = next((route for route in routes if route.to_status == value or (not value and route.default)), None)
    if route is None:
        raise ValidationError("return_to must be " + " or ".join(repr(route.to_status) for route in routes))
    return route


def revision_context_for_review_return(
    *, target_type: str, role: str, verdict: str, notes: str,
    findings: list[dict[str, object]], route: ReviewReturn,
) -> str:
    finding_text = "; ".join(
        str(item.get("issue", "")) for item in findings if item.get("issue")
    )
    pieces = [f"{role} returned {verdict}"]
    if route.revision:
        pieces.append(route.revision)
    if notes:
        pieces.append(notes)
    if finding_text:
        pieces.append(f"Findings: {finding_text}")
    return " | ".join(pieces)


def record_verdict(snapshot, payload, knowledge) -> Change:
    """Refuse a verdict the review vocabulary cannot accept, then declare the
    one write that records it: the verdict row and the target's own transition."""
    verdict = str(payload.get("verdict") or "")
    validate_review_verdict(verdict=verdict)
    try:
        synopsis = validate_synopsis(str(payload.get("synopsis") or ""))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return Change(
        data={"review_id": str(payload.get("review_id") or ""), "verdict": verdict},
        transactional=(TransactionalEffect("review.record_verdict", {**payload, "synopsis": synopsis}),),
    )


REVIEW = Workflow(
    name="review", version=1, initial="requested", id_prefix="rr",
    nodes=(Node("requested", "Awaiting a reviewer"), Node("started", "Review in progress")),
    edges=(
        Edge("requested", "start", "started", label="A reviewer session takes the request",
             event_type="review.started", suggest=False),
        Edge("started", "submit", "submitted", change=record_verdict, label="Record the verdict",
             event_type="review.submitted", suggest=False),
        *(Edge(state, "supersede", "superseded", label="A fresh capability revokes this request", suggest=False)
          for state in ("requested", "started")),
    ),
    outcomes={"submitted": "submitted", "superseded": "superseded"},
)

KIND = RecordKind(
    name="review", table="review_requests", id_prefix="rr", workflow=REVIEW,
    # A review row is read through the review service's own scoped SQL, never
    # projected as research state, so its record is the row the engine built.
    construct=lambda row, snapshot: row, metadata=Metadata(success_outcome="submitted"),
    created_event="review.requested", unique_name=False, reads_record=False, created_seq=True,
    columns=("target_type", "target_id", "role", "reason", "capability_hash",
             "target_snapshot_id", "producer_session_id", "expires_at"),
    # A review is evidence *about* a target, never a submission of its own, so
    # no transition here closes a submission round against the review's table.
    seal_exempt_actions=frozenset({"start", "submit", "supersede"}),
)
