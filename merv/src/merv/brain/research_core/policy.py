# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Pure Research policy shared by its state machines."""

from __future__ import annotations

from ..workflows.definitions.research_state import ReflectionState, ReviewStatus, GateStatus

from ..workflows import research_contracts

ACTIVE_EXPERIMENT_CAP = research_contracts.ACTIVE_EXPERIMENT_CAP
CLAIM_CONFIDENCES = research_contracts.CLAIM_CONFIDENCES
CLAIM_STATUSES = research_contracts.CLAIM_STATUSES
MAX_EXPERIMENT_NAME_LEN = research_contracts.MAX_EXPERIMENT_NAME_LEN
MAX_TASK_NAME_LEN = research_contracts.MAX_TASK_NAME_LEN
MIN_EXPERIMENT_NAME_LEN = research_contracts.MIN_EXPERIMENT_NAME_LEN
MIN_TASK_NAME_LEN = research_contracts.MIN_TASK_NAME_LEN
active_experiment_cap_would_exceed_message = research_contracts.active_experiment_cap_would_exceed_message
validate_experiment_name = research_contracts.validate_experiment_name
validate_task_name = research_contracts.validate_task_name

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
import json
import re
from typing import Any, Literal, TypeAlias

from ..kernel.utils import ValidationError
from ..workflows import (
    EXPERIMENT_KIND as EXPERIMENT, REFLECTION_KIND as REFLECTION, TASK_KIND as TASK,
    ArtifactNeed, DependenciesDone, Evaluation, Issue, RecordKind, RecordNeed, Requirement,
    ReviewGate, ReviewReturn, Snapshot,
)

# The record kinds research policy speaks about declare their own vocabulary;
# nothing here restates a state machine.
EXPERIMENT_TERMINAL_STATUSES = EXPERIMENT.terminal_statuses
TASK_TERMINAL_STATUSES = TASK.terminal_statuses
REFLECTION_TERMINAL_STATUSES = REFLECTION.terminal_statuses
REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD = research_contracts.REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD
REFLECTION_IDLE_RECOMMEND_NEW_TERMINAL_THRESHOLD = research_contracts.REFLECTION_IDLE_RECOMMEND_NEW_TERMINAL_THRESHOLD
REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD = research_contracts.REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD

REVIEW_VERDICT_VALUES = ("pass", "needs_changes", "fail")
REVIEW_VERDICTS = frozenset(REVIEW_VERDICT_VALUES)
REVIEW_GATE_EXEMPT_ROLE_VALUES = ("human", "automated_check")
REVIEW_GATE_EXEMPT_ROLES = frozenset(REVIEW_GATE_EXEMPT_ROLE_VALUES)
REVIEW_ROLE_VALUES = (
    *(gate.role for kind in (EXPERIMENT, REFLECTION, TASK) for gate in kind.review_gates),
    *REVIEW_GATE_EXEMPT_ROLE_VALUES,
)
REVIEW_ROLES = frozenset(REVIEW_ROLE_VALUES)


EXPERIMENT_ACTIVE_PROCESS_STATUSES = frozenset({"provisioning", "running"})

SYNOPSIS_MIN_LEN = 40
SYNOPSIS_MAX_LEN = 420
# Entity id prefixes agents may cite from prose, each with the kind it names.
# Support surfaces (the feed) receive this at composition and match prefixes
# only; the kinds label validation messages. `res_` and `rver_` predate the
# current reviews module and stay so older mentions keep parsing.
ENTITY_REF_VOCABULARY: tuple[tuple[str, str], ...] = (
    ("exp_", "experiment"),
    ("task_", "task"),
    ("claim_", "claim"),
    ("res_", "result"),
    ("rver_", "review verdict"),
    ("syn_", "reflection"),
    ("rev_", "review"),
    ("lit_", "literature"),
    ("paper_", "paper"),
)
_ENTITY_ID_RE = re.compile(
    r"\b(?:%s)[A-Za-z0-9]"
    % "|".join(prefix for prefix, _ in ENTITY_REF_VOCABULARY)
)

# What Research's own tool arguments mean to the shared activity log: the
# capability that must never be persisted, the ids worth keeping in a redacted
# summary, and the record each call is about. Surface registers this with the
# kernel vocabulary at composition, so Kernel names no research record.
ACTIVITY_VOCABULARY: dict[str, tuple[Any, ...]] = {
    "sensitive_keys": ("reviewer_capability",),
    "id_keys": ("claim_id", "experiment_id", "review_request_id", "review_session_id"),
    "targets": (
        ("experiment", "experiment_id"),
        ("claim", "claim_id"),
        ("review", "review_id"),
        ("review", "request_id"),
    ),
}

# What `project` action=overview hands back, in the sentence the caller
# reads. Research owns the contents, so the tool registry quotes this instead
# of listing research records itself.
PROJECT_OVERVIEW_CONTENTS = (
    "the latest published reflection, the literature General Summary, every "
    "claim including settled and abandoned ones, and every experiment "
    "including terminal ones with one status-dependent summary"
)

# Agent voices on the project feed. Adoptable roles share one persistent voice
# per project so the reader follows one reviewer or lens instead of a new name
# per session; the feed applies that rule without knowing what the roles are.
FEED_AUTHOR_ROLES = frozenset({"main", "reviewer", "lens"})
FEED_ADOPTABLE_ROLES = frozenset({"reviewer", "lens"})

# Task names follow the same folder-safe rules and become tasks/<name>/.


# projects.settings_json key gating automatic local coding-agent dispatch.
AGENT_DISPATCH_SETTING = "agent_dispatch"


def active_experiment_cap_reached_message(
    *, active_count: int, reserved_count: int = 0
) -> str:
    reserved = (
        f" and {reserved_count} reserved by an in-flight reflection wave"
        if reserved_count
        else ""
    )
    return (
        "active experiment cap reached: "
        f"project has {active_count} active experiments{reserved}; "
        "finish one before creating another."
    )




def covered_terminal_ids(
    corpus: Mapping[str, object] | None, *, key: str = "terminal_experiments"
) -> set[str]:
    if not corpus:
        return set()
    entries = corpus.get(key) or []
    return {
        str(entry.get("id"))
        for entry in entries
        if isinstance(entry, Mapping)
    }


def reflection_signal_state(
    *,
    current_terminal: Mapping[str, str],
    current_claims: Mapping[str, str],
    published: ReflectionState | None,
    open_wave: ReflectionState | None,
    current_terminal_tasks: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    covered_ids = covered_terminal_ids(
        None if published is None else (published.corpus or {})
    )
    corpus = {} if published is None else published.corpus or {}
    # Tasks are inputs the reflection reads, not evidence: a finished task
    # counts as new material (something to reflect over) but never toward
    # the experiment debt that nudges or blocks.
    covered_task_ids = covered_terminal_ids(corpus, key="terminal_tasks")
    new_terminal_tasks = sorted(
        set(current_terminal_tasks or {}) - covered_task_ids
    )
    snapshot_claims = {
        str(claim.get("id")): str(claim.get("status"))
        for claim in corpus.get("claims", [])
        if isinstance(claim, Mapping)
    }
    new_terminal = sorted(set(current_terminal) - covered_ids)
    claims_changed = [
        {"id": claim_id, "from": snapshot_claims.get(claim_id), "to": status}
        for claim_id, status in sorted(current_claims.items())
        if published is not None and snapshot_claims.get(claim_id) != status
    ]
    contradicted_flip = any(change["to"] == "contradicted" for change in claims_changed)
    create_blocked = len(new_terminal) >= REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD
    has_new_material = (
        len(new_terminal) >= REFLECTION_IDLE_RECOMMEND_NEW_TERMINAL_THRESHOLD
        or contradicted_flip
        or bool(new_terminal_tasks)
    )
    stale = open_wave is None and (
        len(new_terminal) >= REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD
        or contradicted_flip
    )
    return {
        "terminal_experiments": len(current_terminal),
        "covered_terminal_experiments": len(covered_ids & set(current_terminal)),
        "new_terminal_since_publish": len(new_terminal),
        "terminal_tasks": len(current_terminal_tasks or {}),
        "new_terminal_tasks_since_publish": len(new_terminal_tasks),
        "claims_changed_since_publish": len(claims_changed),
        "contradicted_flip": contradicted_flip,
        "has_new_material": has_new_material,
        "last_published_at": published.published_at if published else None,
        "last_published_reflection_id": published.id if published else None,
        "open_reflection_id": open_wave.id if open_wave else None,
        "stale": stale,
        "experiment_create_blocked": create_blocked,
        "nudge_new_terminal_threshold": REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD,
        "block_new_terminal_threshold": REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD,
    }


def reflection_create_block_message(
    *,
    debt: int,
    published_id: str | None,
    open_wave: Mapping[str, Any] | None,
    threshold: int = REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD,
) -> str | None:
    if debt < threshold:
        return None
    if open_wave is not None:
        return (
            "project reflection is required before creating another experiment: "
            f"{debt} experiments have finished since the last published "
            f"reflection (threshold {threshold}), and reflection wave "
            f"{open_wave['id']} is {open_wave['status']!r}. Finish and publish "
            "that reflection wave; its approved change spec will create the "
            "next experiment wave."
        )
    since = (
        "since the last published reflection"
        if published_id
        else "and no project reflection has been published yet"
    )
    return (
        "project reflection is required before creating another experiment: "
        f"{debt} experiments have finished {since} (threshold {threshold}). "
        "Start a reflection wave with reflection.create and publish it before "
        "creating another experiment."
    )


JSONValue: TypeAlias = (
    str | int | float | bool | None | list["JSONValue"] | dict[str, "JSONValue"]
)
GateItem: TypeAlias = dict[str, JSONValue]



@dataclass(frozen=True, slots=True)
class RequirementEvaluation:
    role: str
    status: GateStatus | ReviewStatus
    blocker_code: str
    enforcement_error: str
    problems: tuple[str, ...]
    items: tuple[GateItem, ...]

    @property
    def satisfied(self) -> bool:
        return not self.enforcement_error


@dataclass(frozen=True, slots=True)
class GateEvaluation:
    status: str
    requirements: tuple[RequirementEvaluation, ...]
    review: RequirementEvaluation | None
    decision: Evaluation

    @property
    def transition(self) -> str | None:
        return None if self.decision.suggested is None else self.decision.suggested.edge.name

    @property
    def leads_to(self) -> str | None:
        return None if self.decision.suggested is None else self.decision.suggested.edge.target

    @property
    def terminal(self) -> bool:
        return bool(self.decision.snapshot.outcome)

    @property
    def legal_transitions(self) -> tuple[dict[str, str], ...]:
        return tuple({"transition": action.edge.name, "leads_to": action.edge.target} for action in self.decision.actions)

    @property
    def ready(self) -> bool:
        selected = self.decision.suggested
        return self.terminal if selected is None else selected.available

    def checklist(self) -> dict[str, JSONValue]:
        items = [dict(item) for gate in self.requirements for item in gate.items]
        if self.review is not None:
            items.extend(dict(item) for item in self.review.items)
        return {
            "status": self.status,
            "transition": self.transition,
            "leads_to": self.leads_to,
            "ready": self.ready,
            "items": items,
        }


@dataclass(frozen=True, slots=True)
class ReviewFact:
    role: str
    snapshot_id: str
    verdict: Mapping[str, Any]
    request: Mapping[str, Any]
    strict: bool
    expired: bool

    @property
    def passed(self) -> bool:
        return self.verdict.get("verdict") == "pass" and not self.blocked_reason

    @property
    def blocked_reason(self) -> str:
        if self.verdict.get("verdict") == "pass" and self.strict and self.verdict.get("independence") != "verified_agent_review":
            return (f"a {self.role} review passed but its independence is only attested "
                    "(the reviewer did not present a session identity) and this project "
                    "requires verified reviews (require_verified_reviews is on): request "
                    "a fresh review and have the reviewer pass its own caller_session_id "
                    "to review.start")
        return ""

    @property
    def request_valid(self) -> bool:
        return self.request.get("status") in {"requested", "started"} and not self.expired

    @property
    def status(self) -> ReviewStatus:
        return ReviewStatus.PASSED if self.passed else ReviewStatus(self.request["status"]) if self.request_valid else ReviewStatus.PENDING

    def reference(self, *, request: bool = False) -> dict[str, Any]:
        pinned = snapshot_from_id(snapshot_id=self.snapshot_id)
        if request:
            return {**pinned, "request_id": self.request["id"]} if self.request_valid else {}
        return {**self.verdict, "role": self.role, "passed": self.passed,
                "error": "" if self.passed else self.blocked_reason or f"A passing independent {self.role} review is required.",
                "snapshot_id": self.snapshot_id, "artifacts": pinned.get("artifacts") or [],
                "findings": json.loads(str(self.verdict.get("findings_json") or "[]")),
                "evidence": json.loads(str(self.verdict.get("evidence_json") or "{}"))}


@dataclass(frozen=True, slots=True)
class GateContext:
    """Everything a requirement resolver may read: no resolver re-derives a fact."""

    record: dict[str, Any]
    snapshot: Snapshot
    issues: tuple[Issue, ...]
    reviews: Mapping[str, ReviewFact] = field(default_factory=dict)

    def issue_for(self, codes) -> Issue | None:
        return next((issue for issue in self.issues if issue.code in codes), None)

    def artifact(self, role: str) -> dict[str, Any] | None:
        from ..workflows import documents

        return documents.preferred_artifact(
            artifacts=list(self.record.get("current_attempt_artifacts") or ()), roles=(role,)
        )


def resolve_requirement(need: Requirement, context: GateContext) -> RequirementEvaluation:
    """One checklist item per declared need, from the resolver its class registered."""
    return RESOLVERS[type(need)](need, context)


def resolve_record_need(need, context: GateContext, extra: GateItem | None = None) -> RequirementEvaluation:
    """A fact the graph verified: satisfied, or missing with the reason it gave."""
    issue = context.issue_for(need.codes)
    return _requirement_item(need, context, kind="record", status="valid" if issue is None else "missing",
                             extra={"missing": "" if issue is None else (need.missing or issue.message),
                                    **(extra or {})})


def resolve_dependencies_done(need: DependenciesDone, context: GateContext) -> RequirementEvaluation:
    """The wave rows behind the gate; a dependency whose row is gone reads as
    unsettled, so no gate opens on a dangling edge."""
    return resolve_record_need(need, context, {"dependencies": [
        {"id": row.get("id"), "node_type": row.get("node_type"), "name": row.get("name"),
         "status": row.get("status"), "settled": bool(row.get("settled"))}
        for row in context.record.get("dependencies") or ()]})


def resolve_artifact_need(need: ArtifactNeed, context: GateContext) -> RequirementEvaluation:
    """A submitted document, missing or invalid by which code its own issue carried."""
    issue = context.issue_for(need.codes)
    status: GateStatus | ReviewStatus = ("missing" if issue is not None and issue.code == need.gate
                                else "invalid" if issue is not None
                                else "valid" if need.validator else "present")
    artifact = context.artifact(need.role) or {}
    return _requirement_item(need, context, kind="artifact", status=status, extra={
        "validator": need.validator or None,
        "missing": (need.missing or f"{need.role} artifact") if status == "missing" else None,
        "artifact_id": artifact.get("id"), "path": artifact.get("path")})


def _requirement_item(need, context: GateContext, *, kind: str, status: GateStatus | ReviewStatus,
                      extra: GateItem) -> RequirementEvaluation:
    issue = context.issue_for(need.codes)
    item: GateItem = {
        "id": f"{kind}:{need.key}", "kind": kind, "role": need.key,
        "label": need.label, "satisfied": issue is None, "status": status,
        "gate": need.gate, "action": need.action,
        **{name: value for name, value in extra.items() if value is not None},
        **({} if issue is None else {"problems": [issue.message]}),
    }
    return RequirementEvaluation(
        role=need.key, status=GateStatus(status), blocker_code="" if issue is None else issue.code,
        enforcement_error="" if issue is None else issue.message,
        problems=() if issue is None else (issue.message,), items=(item,))


def evaluate_review_gate(review: ReviewGate, context: GateContext) -> RequirementEvaluation:
    """Format the exact scoped fact the graph used for enforcement."""
    target = context.record
    fact = context.reviews[review.role]
    passed, request = fact.passed, fact.request
    review_status, blocked_reason = fact.status, fact.blocked_reason
    error = "" if passed else blocked_reason or review.error
    item: GateItem = {
        "id": f"review:{review.role}",
        "kind": "review",
        "role": review.role,
        "label": review.label,
        "satisfied": bool(passed),
        "status": review_status,
        "gate": str(target["status"]),
        "action": (review.pass_action if passed else f"launch_{review.action_name}er"),
        "skill": review.skill,
    }
    if blocked_reason:
        item["problems"] = [blocked_reason]
    if request:
        item.update(
            request_id=str(request["id"]),
            expires_at=str(request["expires_at"]),
        )
    return RequirementEvaluation(
        role=review.role,
        status=review_status,
        blocker_code=review.blocker_code if not passed else "",
        enforcement_error=error,
        problems=(blocked_reason,) if blocked_reason else (),
        items=(item,),
    )


# One resolver per requirement class; bootstrap refuses a program whose need
# class is not here, so a new kind of need is a class and an entry.
Resolver: TypeAlias = "Callable[[Any, GateContext], RequirementEvaluation]"
RESOLVERS: dict[type, Resolver] = {
    ArtifactNeed: resolve_artifact_need, RecordNeed: resolve_record_need,
    DependenciesDone: resolve_dependencies_done, ReviewGate: evaluate_review_gate}


def is_review_gate_exempt(*, role: str) -> bool:
    return role in REVIEW_GATE_EXEMPT_ROLES


def validate_review_role(*, role: str) -> None:
    if not isinstance(role, str) or not role.strip() or len(role) > 128:
        raise ValidationError("review role must be a nonempty workflow role of at most 128 characters")


def validate_review_verdict(*, verdict: str) -> None:
    if verdict not in REVIEW_VERDICTS:
        raise ValidationError(f"unknown review verdict: {verdict}")


def resolve_review_return(
    *, kind: RecordKind, role: str, verdict: str, return_to: str
) -> ReviewReturn | None:
    """Validate a submitted review's routing input against the kind's gates.

    The graph decides which edge the verdict eventually takes; this only
    refuses an input the gate's declared returns cannot honour.
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
    if _ENTITY_ID_RE.search(synopsis):
        prefixes = "/".join(prefix for prefix, _ in ENTITY_REF_VOCABULARY)
        raise ValueError(
            f"{hint} (no entity ids like {prefixes} — name things by their "
            "human names instead)"
        )
    return synopsis








def parse_project_settings(raw: Any) -> dict[str, Any]:
    try:
        settings = json.loads(str(raw or "{}"))
    except ValueError:
        return {}
    return settings if isinstance(settings, dict) else {}


def agent_dispatch_enabled(project: Mapping[str, Any]) -> bool:
    """Whether this project may hand work to local coding-agent runners.

    Off by default: dispatch starts processes on a contributor's machine, so a
    project opts in rather than inheriting automation from a runner someone
    happened to leave running.
    """
    settings = parse_project_settings(project.get("settings_json"))
    return bool(settings.get(AGENT_DISPATCH_SETTING, False))


def review_snapshot_id(*, target_type: str, target: dict[str, Any], snapshot=None) -> str:
    """Byte-stable identity of the exact state and artifacts under review."""
    if snapshot is not None and (snapshot.version > 1 or target_type not in {"experiment", "reflection", "task"}):
        from ..workflows import snapshot_view
        pinned = snapshot_view(snapshot)
        return "workflow:" + json.dumps({**pinned, "target_type": target_type, "target_id": snapshot.id,
                                         "status": snapshot.state, "attempt_index": int(target.get("attempt_index") or 1),
                                         "artifacts": [{"artifact_id": item["id"], "role": item.get("role", "")}
                                                       for item in target.get("current_attempt_artifacts") or ()]},
                                        sort_keys=True, separators=(",", ":"))
    artifact_tokens = [
        f"{artifact['id']}:{artifact.get('role', '')}:"
        f"{artifact.get('attempt_index', 0)}"
        for artifact in target.get("current_attempt_artifacts", [])
    ]
    parts = [
        target_type,
        target["id"],
        target["status"],
        str(target["attempt_index"]),
        ",".join(sorted(artifact_tokens)),
    ]
    snapshot_token = str(target.get("snapshot_token") or "")
    code_sha = str(target.get("code_sha") or "")
    if snapshot_token or code_sha:
        parts.extend((snapshot_token, code_sha))
    return "|".join(parts)


def snapshot_from_id(*, snapshot_id: str) -> dict[str, Any]:
    if snapshot_id.startswith("workflow:"):
        return json.loads(snapshot_id.removeprefix("workflow:"))
    if "|" not in snapshot_id:
        target_type, _, target_id = snapshot_id.partition(":")
        return {
            "target_type": target_type,
            "target_id": target_id,
            "artifacts": [],
        }
    parts = snapshot_id.split("|", 6)
    artifacts = []
    for token in (parts[4].split(",") if len(parts) > 4 and parts[4] else []):
        try:
            artifact_id, role, attempt_index = token.rsplit(":", 2)
        except ValueError:
            artifacts.append({"raw": token})
            continue
        artifacts.append(
            {
                "artifact_id": artifact_id,
                "role": role,
                "attempt_index": _int_or_zero(attempt_index),
            }
        )
    return {
        "target_type": parts[0] if len(parts) > 0 else "",
        "target_id": parts[1] if len(parts) > 1 else "",
        "status": parts[2] if len(parts) > 2 else "",
        "attempt_index": _int_or_zero(parts[3]) if len(parts) > 3 else 0,
        "artifacts": artifacts,
        "snapshot_token": parts[5] if len(parts) > 5 else "",
        "code_sha": parts[6] if len(parts) > 6 else "",
    }


def _int_or_zero(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def revision_context_for_review_return(
    *,
    target_type: str,
    role: str,
    verdict: str,
    notes: str,
    findings: list[dict[str, object]],
    route: ReviewReturn,
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
    if role == "consolidation_reviewer":
        pieces.append(
            "Revise only the code proposal, validation, or per-experiment "
            "integration decisions. The approved reflection is authoritative "
            "and cannot be reopened here"
        )
    elif target_type == "task":
        pieces.append(
            "Revise the delivery against the brief's Done-when checks: give the "
            "evidence the reviewer could not verify, or state plainly which "
            "checks are unmet and why; the brief itself stands"
        )
    elif target_type == "reflection":
        pieces.append(
            "Consider revising the project graph, reflection doc, and/or "
            "change spec where this review changes the project's story; the "
            "16-node graph budget still applies"
        )
    else:
        pieces.append(
            "Consider updating the experiment's logic graph (role 'graph') "
            "if this review changes the experiment's story; the 16-node graph "
            "budget still applies"
        )
    return " | ".join(pieces)


__all__ = [
    "ACTIVE_EXPERIMENT_CAP",
    "EXPERIMENT",
    "REFLECTION",
    "REFLECTION_TERMINAL_STATUSES",
    "TASK",
    "TASK_TERMINAL_STATUSES",
    "AGENT_DISPATCH_SETTING",
    "CLAIM_CONFIDENCES",
    "CLAIM_STATUSES",
    "EXPERIMENT_ACTIVE_PROCESS_STATUSES",
    "EXPERIMENT_TERMINAL_STATUSES",
    "GateEvaluation",
    "GateItem",
    "REVIEW_ROLES",
    "REVIEW_ROLE_VALUES",
    "REVIEW_VERDICTS",
    "REVIEW_VERDICT_VALUES",
    "RequirementEvaluation",
    "SYNOPSIS_MAX_LEN",
    "active_experiment_cap_reached_message",
    "active_experiment_cap_would_exceed_message",
    "agent_dispatch_enabled",
    "covered_terminal_ids",
    "is_review_gate_exempt",
    "GateContext",
    "evaluate_review_gate",
    "resolve_requirement",
    "parse_project_settings",
    "reflection_create_block_message",
    "reflection_signal_state",
    "resolve_review_return",
    "review_snapshot_id",
    "revision_context_for_review_return",
    "snapshot_from_id",
    "validate_experiment_name",
    "validate_task_name",
    "validate_review_role",
    "validate_review_verdict",
    "validate_synopsis",
]
