# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Pure Research policy shared by its state machines."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import re
from typing import Any, Literal, TypeAlias

from merv.shared.artifact_roles import PROJECT_GRAPH_ROLE, REFLECTION_LENS_DOC_ROLE

from ..kernel.utils import ValidationError, WorkflowError
from .experiment_workflow import (
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT_WORKFLOW,
)
from .reflection_workflow import (
    REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD,
    REFLECTION_IDLE_RECOMMEND_NEW_TERMINAL_THRESHOLD,
    REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD,
    REFLECTION_WORKFLOW,
)
from .workflow_schema import ArtifactNeed, ReviewGate, ReviewReturn, Workflow


REVIEW_VERDICT_VALUES = ("pass", "needs_changes", "fail")
REVIEW_VERDICTS = frozenset(REVIEW_VERDICT_VALUES)
REVIEW_GATE_EXEMPT_ROLE_VALUES = ("human", "automated_check")
REVIEW_GATE_EXEMPT_ROLES = frozenset(REVIEW_GATE_EXEMPT_ROLE_VALUES)
REVIEW_ROLE_VALUES = (
    *(
        state.review.role
        for workflow in (EXPERIMENT_WORKFLOW, REFLECTION_WORKFLOW)
        for state in workflow.states
        if state.review is not None
    ),
    *REVIEW_GATE_EXEMPT_ROLE_VALUES,
)
REVIEW_ROLES = frozenset(REVIEW_ROLE_VALUES)

CLAIM_STATUSES = frozenset(
    {
        "draft",
        "active",
        "supported",
        "weakened",
        "contradicted",
        "abandoned",
    }
)
CLAIM_CONFIDENCES = frozenset({"low", "medium", "high"})

EXPERIMENT_ACTIVE_PROCESS_STATUSES = frozenset({"provisioning", "running"})

SYNOPSIS_MIN_LEN = 40
SYNOPSIS_MAX_LEN = 420
_ENTITY_ID_RE = re.compile(r"\b(exp|claim|res|rev|rver|syn|lit|paper)_[A-Za-z0-9]")

MAX_EXPERIMENT_NAME_LEN = 48
MIN_EXPERIMENT_NAME_LEN = 3
_EXPERIMENT_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

ACTIVE_EXPERIMENT_CAP = 7

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


def active_experiment_cap_would_exceed_message(
    *, active_count: int, proposed_count: int
) -> str:
    experiment_word = "experiment" if proposed_count == 1 else "experiments"
    return (
        "active experiment cap would be exceeded: "
        f"project has {active_count} active experiments and this reflection "
        f"proposes {proposed_count} new {experiment_word}; "
        "finish one before creating another."
    )


def covered_terminal_ids(corpus: Mapping[str, object] | None) -> set[str]:
    if not corpus:
        return set()
    entries = corpus.get("terminal_experiments") or []
    return {
        str(experiment.get("id"))
        for experiment in entries
        if isinstance(experiment, Mapping)
    }


def reflection_signal_state(
    *,
    current_terminal: Mapping[str, str],
    current_claims: Mapping[str, str],
    published: Mapping[str, Any] | None,
    open_wave: Mapping[str, Any] | None,
) -> dict[str, Any]:
    covered_ids = covered_terminal_ids(
        None if published is None else (published.get("corpus") or {})
    )
    corpus = {} if published is None else published.get("corpus") or {}
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
    )
    stale = open_wave is None and (
        len(new_terminal) >= REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD
        or contradicted_flip
    )
    return {
        "terminal_experiments": len(current_terminal),
        "covered_terminal_experiments": len(covered_ids & set(current_terminal)),
        "new_terminal_since_publish": len(new_terminal),
        "claims_changed_since_publish": len(claims_changed),
        "contradicted_flip": contradicted_flip,
        "has_new_material": has_new_material,
        "last_published_at": (published or {}).get("published_at"),
        "last_published_reflection_id": (published or {}).get("id"),
        "open_reflection_id": (open_wave or {}).get("id"),
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
EvaluationStatus = Literal[
    "missing",
    "present",
    "valid",
    "invalid",
    "pending",
    "requested",
    "started",
    "passed",
]


@dataclass(frozen=True, slots=True)
class RequirementEvaluation:
    role: str
    status: EvaluationStatus
    blocker_code: str
    enforcement_error: str
    problems: tuple[str, ...]
    items: tuple[GateItem, ...]

    @property
    def satisfied(self) -> bool:
        return not self.enforcement_error

    @property
    def explanation(self) -> str:
        return self.enforcement_error if not self.satisfied else ""


@dataclass(frozen=True, slots=True)
class GateEvaluation:
    workflow: Workflow
    status: str
    requirements: tuple[RequirementEvaluation, ...]
    review: RequirementEvaluation | None

    @property
    def subject(self) -> str:
        return self.workflow.subject

    @property
    def state(self):
        return self.workflow.state(self.status)

    @property
    def transition(self) -> str | None:
        return None if self.state is None else self.state.forward.name

    @property
    def leads_to(self) -> str | None:
        return None if self.state is None else self.state.forward.to_status

    @property
    def terminal(self) -> bool:
        return self.status in self.workflow.terminal_statuses

    @property
    def legal_transitions(self) -> tuple[dict[str, str], ...]:
        return tuple(self.workflow.allowed_transitions_for(self.status))

    @property
    def blocker(self) -> RequirementEvaluation | None:
        return next(
            (
                item
                for item in (*self.requirements, self.review)
                if item and not item.satisfied
            ),
            None,
        )

    @property
    def blocker_code(self) -> str:
        return "" if self.blocker is None else self.blocker.blocker_code

    @property
    def explanation(self) -> str:
        return "" if self.blocker is None else self.blocker.explanation

    @property
    def ready(self) -> bool:
        return self.terminal if self.transition is None else self.blocker is None

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

    def require_transition(self, transition: str) -> str:
        if self.terminal:
            raise WorkflowError(
                f"{self.subject} is {self.status!r}; no transitions are "
                "allowed from a terminal state"
            )
        selected = next(
            (
                item
                for item in self.legal_transitions
                if item["transition"] == transition
            ),
            None,
        )
        if selected is None:
            options = ", ".join(item["transition"] for item in self.legal_transitions)
            raise WorkflowError(
                f"transition {transition!r} is not allowed from "
                f"{self.status!r}; allowed from here: {options}"
            )
        if transition != self.transition:
            return selected["leads_to"]
        for requirement in self.requirements:
            if not requirement.satisfied:
                raise WorkflowError(requirement.enforcement_error)
        if self.review is not None and not self.review.satisfied:
            raise WorkflowError(self.review.enforcement_error)
        return selected["leads_to"]


def evaluate_artifact_requirement(
    requirement: ArtifactNeed,
    *,
    present: bool,
    problems: tuple[str, ...] = (),
    artifact_fields: GateItem | None = None,
) -> RequirementEvaluation:
    status: EvaluationStatus = (
        "missing"
        if not present
        else "invalid" if problems else "valid" if requirement.validator else "present"
    )
    error = requirement.error if not present else problems[0] if problems else ""
    item: GateItem = {
        "id": f"artifact:{requirement.role}",
        "kind": "artifact",
        "role": requirement.role,
        "label": requirement.label,
        "satisfied": present and not problems,
        "status": status,
        "gate": requirement.gate,
        "action": requirement.action,
    }
    if requirement.validator:
        item["validator"] = requirement.validator
    if artifact_fields is not None:
        item.update(artifact_fields)
    if not present:
        item["missing"] = requirement.missing or f"{requirement.role} artifact"
    if problems:
        item["problems"] = list(problems)
    return RequirementEvaluation(
        role=requirement.role,
        status=status,
        blocker_code=(
            requirement.gate or f"{requirement.role}_missing"
            if not present
            else f"{requirement.role}_invalid" if problems else ""
        ),
        enforcement_error=error,
        problems=problems,
        items=(item,),
    )


def evaluate_review_gate(
    *,
    conn: Any,
    target_type: str,
    target: dict[str, Any],
    review: ReviewGate,
) -> RequirementEvaluation:
    snapshot_id = review_snapshot_id(target_type=target_type, target=target)
    passes = conn.execute(
        """
        SELECT s.independence FROM reviews r
        JOIN review_sessions s ON s.id = r.session_id
        WHERE r.target_type = ? AND r.target_id = ? AND r.role = ?
          AND r.target_snapshot_id = ? AND r.verdict = 'pass'
        ORDER BY r.created_seq DESC
        """,
        (
            target_type,
            str(target["id"]),
            review.role,
            snapshot_id,
        ),
    ).fetchall()
    verified = any(
        str(row["independence"]) == "verified_agent_review" for row in passes
    )
    strict = bool(
        passes
        and project_settings(conn=conn, project_id=str(target["project_id"])).get(
            "require_verified_reviews"
        )
    )
    passed = bool(passes) and (verified or not strict)
    row = conn.execute(
        """
        SELECT id, status, expires_at
        FROM review_requests
        WHERE target_type = ? AND target_id = ? AND role = ?
          AND target_snapshot_id = ?
        ORDER BY created_seq DESC
        LIMIT 1
        """,
        (
            target_type,
            str(target["id"]),
            review.role,
            snapshot_id,
        ),
    ).fetchone()
    request = None if row is None else dict(row)
    review_status = "pending"
    if passed:
        review_status = "passed"
    elif request is not None and request.get("status") in {"requested", "started"}:
        review_status = str(request["status"])
    blocked_reason = (
        f"a {review.role} review passed but its independence is only attested "
        "(the reviewer did not present a session identity) and this project "
        "requires verified reviews (require_verified_reviews is on): request "
        "a fresh review and have the reviewer pass its own caller_session_id "
        "to review.start"
        if passes and strict and not verified
        else ""
    )
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
    if request is not None:
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


def is_review_gate_exempt(*, role: str) -> bool:
    return role in REVIEW_GATE_EXEMPT_ROLES


def validate_review_role(*, role: str) -> None:
    if role not in REVIEW_ROLES:
        raise ValidationError(f"unknown review role: {role}")


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
    if _ENTITY_ID_RE.search(synopsis):
        raise ValueError(
            f"{hint} (no entity ids like exp_/claim_/res_/rev_/rver_/syn_/"
            "lit_/paper_ — name things by their human names instead)"
        )
    return synopsis


def validate_experiment_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValidationError(
            "name is required: a short, folder-safe experiment name — it "
            "becomes the experiment folder experiments/<name>/"
        )
    if (
        len(name) < MIN_EXPERIMENT_NAME_LEN
        or len(name) > MAX_EXPERIMENT_NAME_LEN
        or not _EXPERIMENT_NAME_RE.fullmatch(name)
    ):
        raise ValidationError(
            "experiment name must work as a folder name: start with a letter "
            "or digit and use only letters, digits, '.', '_' and '-', between "
            f"{MIN_EXPERIMENT_NAME_LEN} and "
            f"{MAX_EXPERIMENT_NAME_LEN} characters"
        )
    return name


def parse_project_settings(raw: Any) -> dict[str, Any]:
    try:
        settings = json.loads(str(raw or "{}"))
    except ValueError:
        return {}
    return settings if isinstance(settings, dict) else {}


def project_settings(*, conn: Any, project_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT settings_json FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    return parse_project_settings(row["settings_json"]) if row else {}


def agent_dispatch_enabled(project: Mapping[str, Any]) -> bool:
    """Whether this project may hand work to local coding-agent runners.

    Off by default: dispatch starts processes on a contributor's machine, so a
    project opts in rather than inheriting automation from a runner someone
    happened to leave running.
    """
    settings = parse_project_settings(project.get("settings_json"))
    return bool(settings.get(AGENT_DISPATCH_SETTING, False))


def review_snapshot_id(*, target_type: str, target: dict[str, Any]) -> str:
    """Byte-stable identity of the exact state and artifacts under review."""
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
    "evaluate_artifact_requirement",
    "evaluate_review_gate",
    "parse_project_settings",
    "project_settings",
    "reflection_create_block_message",
    "reflection_signal_state",
    "review_snapshot_id",
    "revision_context_for_review_return",
    "snapshot_from_id",
    "validate_experiment_name",
    "validate_review_role",
    "validate_review_verdict",
    "validate_synopsis",
]
