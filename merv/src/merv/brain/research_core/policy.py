# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Pure Research policy shared by its state machines."""

from __future__ import annotations

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

from collections.abc import Mapping
from dataclasses import dataclass
import json
import re
from typing import Any, Literal, TypeAlias

from ..workflows import PROJECT_GRAPH_ROLE, REFLECTION_LENS_DOC_ROLE

from ..kernel.utils import ValidationError, WorkflowError, now_iso
from ..workflows import Evaluation
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
from .task_workflow import TASK_TERMINAL_STATUSES, TASK_WORKFLOW
from .workflow_schema import (
    ArtifactNeed,
    RecordNeed,
    ReviewGate,
    ReviewReturn,
    Workflow,
)


REVIEW_VERDICT_VALUES = ("pass", "needs_changes", "fail")
REVIEW_VERDICTS = frozenset(REVIEW_VERDICT_VALUES)
REVIEW_GATE_EXEMPT_ROLE_VALUES = ("human", "automated_check")
REVIEW_GATE_EXEMPT_ROLES = frozenset(REVIEW_GATE_EXEMPT_ROLE_VALUES)
REVIEW_ROLE_VALUES = (
    *(
        state.review.role
        for workflow in (EXPERIMENT_WORKFLOW, REFLECTION_WORKFLOW, TASK_WORKFLOW)
        for state in workflow.states
        if state.review is not None
    ),
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
    published: Mapping[str, Any] | None,
    open_wave: Mapping[str, Any] | None,
    current_terminal_tasks: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    covered_ids = covered_terminal_ids(
        None if published is None else (published.get("corpus") or {})
    )
    corpus = {} if published is None else published.get("corpus") or {}
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
    decision: Evaluation

    @property
    def state(self):
        return self.workflow.state(self.decision.snapshot.state)

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
    def blocker_code(self) -> str:
        selected = self.decision.suggested
        return "" if selected is None or not selected.issues else selected.issues[0].code

    @property
    def explanation(self) -> str:
        selected = self.decision.suggested
        return "" if selected is None else "; ".join(issue.message for issue in selected.issues)

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

    def require_transition(self, transition: str) -> str:
        return self.decision.require(transition).target


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
    snapshot=None,
) -> RequirementEvaluation:
    snapshot_id = review_snapshot_id(target_type=target_type, target=target, snapshot=snapshot)
    latest = conn.execute(
        """
        SELECT r.verdict, s.independence FROM reviews r
        JOIN review_sessions s ON s.id = r.session_id
        WHERE r.target_type = ? AND r.target_id = ? AND r.role = ?
          AND r.target_snapshot_id = ? AND r.project_id = ? AND s.status = 'submitted'
        ORDER BY r.created_seq DESC LIMIT 1
        """,
        (
            target_type,
            str(target["id"]),
            review.role,
            snapshot_id,
            str(target["project_id"]),
        ),
    ).fetchall()
    passes = [row for row in latest if row["verdict"] == "pass"]
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
    if not isinstance(role, str) or not role.strip() or len(role) > 128:
        raise ValidationError("review role must be a nonempty workflow role of at most 128 characters")


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
        prefixes = "/".join(prefix for prefix, _ in ENTITY_REF_VOCABULARY)
        raise ValueError(
            f"{hint} (no entity ids like {prefixes} — name things by their "
            "human names instead)"
        )
    return synopsis








def evaluate_dependency_requirement(
    requirement: RecordNeed,
    *,
    dependencies: list[dict[str, Any]],
) -> RequirementEvaluation:
    """Gate a node on its wave dependencies (``node_dependencies`` rows).

    ``dependencies`` rows carry ``id``, ``node_type``, ``name``, ``status`` and
    ``settled`` (done/complete). Missing rows (a dependency that was deleted)
    count as unsettled so the gate never silently opens on a dangling edge.
    """
    pending = [item for item in dependencies if not item.get("settled")]
    dead = [item for item in pending if item.get("failed")]
    satisfied = not pending
    if satisfied:
        error = ""
    elif dead:
        names = ", ".join(
            f"{item.get('node_type')} {item.get('name') or item.get('id')} "
            f"({item.get('status')})"
            for item in dead
        )
        error = (
            f"a dependency has ended without succeeding: {names}; this node "
            "cannot proceed on it — mark it failed/abandoned, or wait for the "
            "next reflection to replan the wave"
        )
    else:
        names = ", ".join(
            f"{item.get('node_type')} {item.get('name') or item.get('id')} "
            f"({item.get('status')})"
            for item in pending
        )
        error = f"waiting on unfinished dependencies: {names}"
    item: GateItem = {
        "id": f"record:{requirement.name}",
        "kind": "record",
        "role": requirement.name,
        "label": requirement.label,
        "satisfied": satisfied,
        "status": "valid" if satisfied else "missing",
        "gate": requirement.gate,
        "action": requirement.action,
        "missing": "" if satisfied else (requirement.missing or error),
        "dependencies": [
            {
                "id": item.get("id"),
                "node_type": item.get("node_type"),
                "name": item.get("name"),
                "status": item.get("status"),
                "settled": bool(item.get("settled")),
            }
            for item in dependencies
        ],
    }
    if pending:
        item["problems"] = [error]
    return RequirementEvaluation(
        role=requirement.name,
        status="valid" if satisfied else "missing",
        blocker_code="" if satisfied else (
            "dependency_failed" if dead else requirement.gate
        ),
        enforcement_error=error,
        problems=() if satisfied else (error,),
        items=(item,),
    )


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


def read_review_fact(*, conn, project_id: str, target_type: str, target_id: str,
                     snapshot_id: str, role: str, request: bool = False) -> dict[str, Any]:
    """Read a capability or verdict for exactly one scoped immutable snapshot."""
    if request:
        row = conn.execute(
            "SELECT id, target_snapshot_id FROM review_requests WHERE project_id = ? AND target_type = ? "
            "AND target_id = ? AND role = ? AND target_snapshot_id = ? AND status IN ('requested', 'started') "
            "AND expires_at > ? ORDER BY created_seq DESC LIMIT 1",
            (project_id, target_type, target_id, role, snapshot_id, now_iso()),
        ).fetchone()
        return {} if row is None else {**snapshot_from_id(snapshot_id=row["target_snapshot_id"]), "request_id": row["id"]}
    row = conn.execute(
        "SELECT r.id, r.verdict, r.return_to, r.notes, r.synopsis, r.findings_json, r.evidence_json, s.independence "
        "FROM reviews r JOIN review_sessions s ON s.id = r.session_id WHERE r.project_id = ? AND r.target_type = ? "
        "AND r.target_id = ? AND r.role = ? AND r.target_snapshot_id = ? AND s.status = 'submitted' "
        "ORDER BY r.created_seq DESC LIMIT 1", (project_id, target_type, target_id, role, snapshot_id),
    ).fetchone()
    fact = {} if row is None else dict(row)
    passed = fact.get("verdict") == "pass"
    strict = project_settings(conn=conn, project_id=project_id).get("require_verified_reviews")
    error = f"A passing independent {role} review is required."
    if passed and strict and fact.get("independence") != "verified_agent_review":
        passed = False
        error = (f"A {role} review passed with only attested independence; this project requires verified reviews "
                 "(require_verified_reviews is on). Request a fresh review with the reviewer's own caller_session_id.")
    return {**fact, "role": role, "passed": passed, "error": "" if passed else error, "snapshot_id": snapshot_id,
            "artifacts": snapshot_from_id(snapshot_id=snapshot_id).get("artifacts") or [],
            "findings": json.loads(str(fact.get("findings_json") or "[]")),
            "evidence": json.loads(str(fact.get("evidence_json") or "{}"))}


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
    "evaluate_artifact_requirement",
    "evaluate_dependency_requirement",
    "evaluate_review_gate",
    "parse_project_settings",
    "project_settings",
    "reflection_create_block_message",
    "reflection_signal_state",
    "review_snapshot_id",
    "revision_context_for_review_return",
    "snapshot_from_id",
    "validate_experiment_name",
    "validate_task_name",
    "validate_review_role",
    "validate_review_verdict",
    "validate_synopsis",
]
