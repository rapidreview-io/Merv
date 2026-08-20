# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Artifact evidence selection and pure document-envelope validation.

Research workflows deliberately keep these checks pure. Database-backed
questions are passed as narrow callbacks only where a change spec needs them.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from merv.shared.artifact_roles import REFLECTION_LENS_DOC_ROLE
from merv.shared.markdown_images import markdown_image_links

from .reflection_workflow import (
    CORE_LENSES,
    CORE_LENS_IDS,
    ROSTER_SIZE,
)
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    CLAIM_CONFIDENCES,
    CLAIM_STATUSES,
    active_experiment_cap_would_exceed_message,
    validate_experiment_name,
    validate_task_name,
)
from ..kernel.utils import ValidationError, WorkflowError

CHANGE_SPEC_SCHEMA_VERSION = 1
MAX_REFLECTION_DOC_BYTES = 16_000
REQUIRED_REFLECTION_LENS_DOC_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Summary", "summary"),
)
REQUIRED_REFLECTION_DOC_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Summary", "summary"),
    ("Critical reading", "critical"),
    ("Decision / future directions", "decision"),
)

_CHANGE_SPEC_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
_MD_HEADING_RE = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_LENS_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")

REQUIRED_PLAN_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Summary", "summary"),
    ("Objective & hypothesis", "objective"),
    ("Evaluation", "evaluation"),
)
REQUIRED_REPORT_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Summary", "summary"),
    ("Results", "results"),
    ("Deviations from plan", "deviations"),
    ("Conclusion", "conclusion"),
)
# Task documents. The brief's "Done when" checks are the contract; the delivery
# answers them one entry per check under "Checks".
REQUIRED_BRIEF_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Goal", "goal"),
)
# The contract list section: "Deliverables" is current; "Done when" is the
# pre-schema name and stays readable.
BRIEF_LIST_SECTIONS: tuple[str, ...] = ("deliverables", "done when")
# The delivery's per-deliverable section: "Confirmations" is current;
# "Checks" is the pre-schema name and stays readable.
DELIVERY_LIST_SECTIONS: tuple[str, ...] = ("confirmations", "checks")
REQUIRED_DELIVERY_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Confirmations", "confirmations"),
)
MAX_BRIEF_BYTES = 16_000
MAX_DELIVERY_BYTES = 16_000
_NUMBERED_ITEM_RE = re.compile(r"^[ \t]*(\d+)[.)][ \t]+(.*\S)?[ \t]*$")
MAX_REPORT_BYTES = 16_000
GRAPH_SCHEMA_VERSION = 1
MAX_GRAPH_NODES = 16
MAX_GRAPH_BYTES = 16_000

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$", re.MULTILINE)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


@dataclass(frozen=True, slots=True)
class ArtifactDocument:
    text: str
    artifact_id: str
    path: str
    role: str
    figure_links: tuple[str, ...]


def require_artifact_document(
    artifact: Any | None,
    *,
    artifact_id: str,
    what: str,
) -> ArtifactDocument:
    if not artifact_id:
        raise WorkflowError(
            f"{what} has no submitted artifact — submit it with artifact.submit"
        )
    if artifact is None or artifact.status != "complete":
        raise WorkflowError(f"{what}: artifact not found: {artifact_id}")
    if artifact.data is None:
        raise WorkflowError(
            f"{what} ({artifact.path}) has no submitted content — resubmit it "
            "with artifact.submit"
        )
    try:
        text = artifact.data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkflowError(
            f"{what} ({artifact.path}) is not valid UTF-8 text"
        ) from exc
    return ArtifactDocument(
        text=text,
        artifact_id=artifact_id,
        path=artifact.path,
        role=artifact.role,
        figure_links=artifact.figures,
    )


def artifact_submission_recency_key(
    artifact: dict[str, Any],
) -> tuple[int, str, str, str]:
    return (
        int(artifact.get("submitted_order") or 0),
        str(artifact.get("updated_at") or artifact.get("created_at") or ""),
        str(artifact.get("id") or artifact.get("artifact_id") or ""),
        str(artifact.get("path") or ""),
    )


def artifact_slot_key(artifact: dict[str, Any]) -> tuple[str, str, str]:
    """Mirror the Artifacts replacement key within one target and attempt."""
    return (
        str(artifact.get("role") or ""),
        str(artifact.get("lens_id") or ""),
        str(artifact.get("path") or ""),
    )


def latest_per_slot(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best: dict[tuple[str, str, str], dict[str, Any]] = {}
    for artifact in artifacts:
        key = artifact_slot_key(artifact)
        held = best.get(key)
        if held is None or artifact_submission_recency_key(
            artifact
        ) > artifact_submission_recency_key(held):
            best[key] = artifact
    keep = {id(artifact) for artifact in best.values()}
    return [artifact for artifact in artifacts if id(artifact) in keep]


def current_slot_artifacts(
    artifacts: list[dict[str, Any]], *, attempt: Any
) -> list[dict[str, Any]]:
    return latest_per_slot(
        [
            artifact
            for artifact in artifacts
            if artifact.get("attempt_index") == attempt
        ]
    )


def sealed_submission_artifacts(
    artifacts: list[dict[str, Any]], *, submission_id: str
) -> list[dict[str, Any]]:
    if not submission_id:
        return []
    return [
        artifact
        for artifact in artifacts
        if str(artifact.get("submission_id") or "") == submission_id
    ]


def historical_latest_artifacts(
    artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return latest_per_slot(artifacts)


def artifact_state_record(evidence: Any) -> dict[str, Any]:
    return {
        "id": evidence.id,
        "project_id": evidence.project_id,
        "path": evidence.path,
        "title": evidence.title,
        "lens_id": evidence.lens_id,
        "size_bytes": evidence.size_bytes,
        "content_type": evidence.content_type,
        "created_by": evidence.created_by,
        "created_at": evidence.created_at,
        "updated_at": evidence.updated_at,
        "role": evidence.role,
        "attempt_index": evidence.attempt_index,
        "submitted_order": evidence.order,
        "tldr": evidence.tldr,
        "submission_id": evidence.submission_id,
    }


def submission_state_record(submission: Any) -> dict[str, Any]:
    return {
        "id": submission.id,
        "attempt_index": submission.attempt_index,
        "transition": submission.transition,
        "created_at": submission.created_at,
        "created_seq": submission.order,
    }


def preferred_artifact(
    *,
    artifacts: list[dict[str, Any]],
    roles: tuple[str, ...],
) -> dict[str, Any] | None:
    """Pick the newest artifact in the highest-precedence requested role."""
    rank = {role: index for index, role in enumerate(roles)}
    candidates = [
        artifact
        for artifact in artifacts
        if str(artifact.get("role") or "") in rank
    ]
    if not candidates:
        return None
    best_rank = min(rank[str(artifact.get("role") or "")] for artifact in candidates)
    return max(
        (
            artifact
            for artifact in candidates
            if rank[str(artifact.get("role") or "")] == best_rank
        ),
        key=artifact_submission_recency_key,
    )


def required_markdown_sections_missing(
    text: str, required: tuple[tuple[str, str], ...]
) -> list[str]:
    """Return required headings that are missing or have an empty body."""
    text = _HTML_COMMENT_RE.sub("", text)
    headings = [
        (
            match.start(),
            len(match.group(1)),
            _normalize_heading(match.group(2)),
            match.end(),
        )
        for match in _HEADING_RE.finditer(text)
    ]
    missing: list[str] = []
    for canonical, key in required:
        index = next(
            (i for i, heading in enumerate(headings) if heading[2].startswith(key)),
            None,
        )
        if index is None:
            missing.append(canonical)
            continue
        level, body_start = headings[index][1], headings[index][3]
        body_end = len(text)
        for next_start, next_level, _, _ in headings[index + 1 :]:
            if next_level <= level:
                body_end = next_start
                break
        if not text[body_start:body_end].strip():
            missing.append(canonical)
    return missing


def _normalize_heading(text: str) -> str:
    return re.sub(
        r"[^a-z0-9]+", " ", text.replace("&", " and ").lower()
    ).strip()


def plan_sections_missing(plan_text: str) -> list[str]:
    return required_markdown_sections_missing(plan_text, REQUIRED_PLAN_SECTIONS)


def report_sections_missing(report_text: str) -> list[str]:
    return required_markdown_sections_missing(report_text, REQUIRED_REPORT_SECTIONS)


def report_figure_links(report_text: str) -> list[str]:
    return markdown_image_links(report_text)


def report_problems(
    report_text: str,
    *,
    figure_problem: Callable[[str], str | None] | None = None,
    exhibit_path: str | None = None,
) -> list[str]:
    problems: list[str] = []
    missing = report_sections_missing(report_text)
    if missing:
        problems.append("missing required sections: " + ", ".join(missing))
    if exhibit_path:
        basename = exhibit_path.rsplit("/", 1)[-1]
        if basename not in _HTML_COMMENT_RE.sub("", report_text):
            problems.append(
                "the report must reference the system metrics exhibit "
                f"({exhibit_path}): it is the authoritative record of this "
                "attempt's runs and result files — write the Results section "
                "around it and cite it by name"
            )
    size = len(report_text.encode("utf-8"))
    if size > MAX_REPORT_BYTES:
        problems.append(
            f"report is {size} bytes; keep it under {MAX_REPORT_BYTES} — move raw "
            "numbers and logs into result artifacts and link them instead"
        )
    if figure_problem is not None:
        for target in report_figure_links(report_text):
            problem = figure_problem(target)
            if problem:
                problems.append(problem)
    return problems


def markdown_section_body(text: str, key: str) -> str | None:
    """Body of the first heading whose normalized text starts with ``key``."""
    text = _HTML_COMMENT_RE.sub("", text)
    headings = [
        (
            match.start(),
            len(match.group(1)),
            _normalize_heading(match.group(2)),
            match.end(),
        )
        for match in _HEADING_RE.finditer(text)
    ]
    index = next(
        (i for i, heading in enumerate(headings) if heading[2].startswith(key)),
        None,
    )
    if index is None:
        return None
    level, body_start = headings[index][1], headings[index][3]
    body_end = len(text)
    for next_start, next_level, _, _ in headings[index + 1 :]:
        if next_level <= level:
            body_end = next_start
            break
    return text[body_start:body_end]


def numbered_items(body: str) -> dict[int, str]:
    """``1. text`` items in a section body; continuation lines fold in."""
    items: dict[int, str] = {}
    current: int | None = None
    for line in body.splitlines():
        match = _NUMBERED_ITEM_RE.match(line)
        if match:
            current = int(match.group(1))
            items[current] = (match.group(2) or "").strip()
            continue
        if current is not None and line.strip() and line[:1] in (" ", "\t"):
            items[current] = (items[current] + " " + line.strip()).strip()
        elif not line.strip():
            continue
        else:
            current = None
    return items


def brief_checks(brief_text: str) -> list[str]:
    """The brief's deliverables in numeric order (empty if malformed)."""
    body = None
    for key in BRIEF_LIST_SECTIONS:
        body = markdown_section_body(brief_text, key)
        if body is not None:
            break
    if body is None:
        return []
    items = numbered_items(body)
    if not items or sorted(items) != list(range(1, len(items) + 1)):
        return []
    return [items[number] for number in sorted(items)]


def brief_problems(brief_text: str) -> list[str]:
    problems: list[str] = []
    missing = required_markdown_sections_missing(brief_text, REQUIRED_BRIEF_SECTIONS)
    if missing:
        problems.append("missing required sections: " + ", ".join(missing))
    body = None
    for key in BRIEF_LIST_SECTIONS:
        body = markdown_section_body(brief_text, key)
        if body is not None:
            break
    if body is None:
        problems.append(
            "missing required sections: Deliverables (a numbered list of the "
            "things that must exist when the task is done)"
        )
    else:
        items = numbered_items(body)
        if not items:
            problems.append(
                "Deliverables must be a numbered list (1. ..., 2. ...), each "
                "one thing, verifiable as written"
            )
        elif sorted(items) != list(range(1, len(items) + 1)):
            problems.append(
                "Deliverables must be numbered 1..N without gaps or repeats"
            )
        else:
            for number, text in sorted(items.items()):
                if not text:
                    problems.append(f"Deliverable {number} is empty")
    size = len(brief_text.encode("utf-8"))
    if size > MAX_BRIEF_BYTES:
        problems.append(
            f"brief is {size} bytes; keep it under {MAX_BRIEF_BYTES} — the "
            "brief is a contract, not a plan"
        )
    return problems


def delivery_problems(delivery_text: str, *, checks: list[str]) -> list[str]:
    """Shape only: one confirmation per deliverable. Content is the reviewer's."""
    problems: list[str] = []
    body = None
    for key in DELIVERY_LIST_SECTIONS:
        body = markdown_section_body(delivery_text, key)
        if body is not None:
            break
    if body is None:
        problems.append(
            "missing required sections: Confirmations (one numbered entry per "
            "deliverable)"
        )
    if body is not None:
        entries = numbered_items(body)
        expected = list(range(1, len(checks) + 1))
        absent = [number for number in expected if number not in entries]
        if absent:
            problems.append(
                "Confirmations needs one numbered entry per deliverable; "
                "missing entries for deliverable(s) "
                + ", ".join(str(n) for n in absent)
                + " — say where the thing is and how to check it, or state "
                "plainly 'not delivered — <why>'"
            )
        empty = [number for number in expected if entries.get(number) == ""]
        if empty:
            problems.append(
                "Confirmations must not be empty: " + ", ".join(str(n) for n in empty)
            )
        extra = sorted(number for number in entries if number not in expected)
        if extra:
            problems.append(
                "Confirmations has entries with no matching deliverable: "
                + ", ".join(str(n) for n in extra)
                + f" (the goal lists {len(checks)} deliverable(s))"
            )
    size = len(delivery_text.encode("utf-8"))
    if size > MAX_DELIVERY_BYTES:
        problems.append(
            f"delivery is {size} bytes; keep it under {MAX_DELIVERY_BYTES} — "
            "point at files and receipts instead of inlining them"
        )
    return problems


# ---- task documents as structure ------------------------------------------
# The goal (prose + deliverables) is structure at creation; only the delivery
# still arrives as a document. Each confirmation entry parses into
# state/evidence/how; the prose sections (Notes, legacy Report/Caveats) come
# out whole. Parsers stay tolerant: unmarked entries claim met, prose that
# fits no shape reads as a single field.

# Delivery entry state: "[x] …", "[ ] …", "[~] …", "not delivered — …".
_RESULT_MARKER_RE = re.compile(
    r"^\s*(?:\[(?P<box>[xX✓ ~]|met|unmet|partial(?:ly met)?|not met|yes|no)\]"
    r"|(?P<word>not delivered|unmet|not met|met|partial(?:ly met)?)\b)\s*[:—–-]?\s*",
    re.IGNORECASE,
)

_HOW_SPLIT_RE = re.compile(
    r"^(?P<evidence>.+?)(?:\s*[—–;]\s*|\s+-\s+|\s+)"
    r"(?:how\s+to\s+(?:check|verify)(?:\s+it)?|to\s+(?:check|verify)|check|verify)\s*:\s*(?P<how>.+)$",
    re.IGNORECASE | re.DOTALL,
)


def delivery_entry_parts(number: int, entry_text: str) -> dict[str, Any]:
    """One delivery entry as ``{number, state, evidence, how, text}``.

    ``state`` is the executor's claim — met | unmet | partial — read from a
    leading ``[x]``/``[ ]``/``[~]`` box or an ``UNMET:`` word; an unmarked
    entry claims met (the template says unmet must be stated).
    """
    text = (entry_text or "").strip()
    state = "met"
    body = text
    marker = _RESULT_MARKER_RE.match(text)
    if marker:
        token = (marker.group("box") or marker.group("word") or "").strip().lower()
        if token in ("", "unmet", "not met", "not delivered", "no"):
            state = "unmet"
        elif token.startswith("partial") or token == "~":
            state = "partial"
        else:
            state = "met"
        body = text[marker.end():].strip()
    how = None
    evidence = body
    split = _HOW_SPLIT_RE.match(body)
    if split:
        evidence = split.group("evidence").strip().rstrip("—–-;,: ").strip() or body
        how = split.group("how").strip() or None
    return {"number": number, "state": state, "evidence": evidence, "how": how, "text": text}


def delivery_results(delivery_text: str, *, count: int) -> list[dict[str, Any]]:
    """The confirmations, one per deliverable (missing ones None-filled)."""
    body = None
    for key in DELIVERY_LIST_SECTIONS:
        body = markdown_section_body(delivery_text, key)
        if body is not None:
            break
    entries = {} if body is None else numbered_items(body)
    results: list[dict[str, Any]] = []
    numbers = sorted(set(range(1, count + 1)) | set(entries))
    for number in numbers:
        if number in entries and entries[number]:
            results.append(delivery_entry_parts(number, entries[number]))
        else:
            results.append({"number": number, "state": None, "evidence": None, "how": None, "text": ""})
    return results


def delivery_section(delivery_text: str, key: str) -> str | None:
    """A delivery section's prose (Report, Caveats) or None when absent/empty."""
    body = markdown_section_body(delivery_text, key)
    if body is None:
        return None
    body = _HTML_COMMENT_RE.sub("", body).strip()
    return body or None


def render_task_brief(proposal: dict[str, Any]) -> str:
    """The brief.md Merv pins at task creation.

    Rendered from the immutable goal — prose plus the numbered deliverables —
    so the record on disk and the reviewer read one canonical form. Legacy
    proposals may still carry the list as ``done_when``.
    """
    name = str(proposal.get("name") or "").strip()
    goal = str(proposal.get("goal") or "").strip()
    checks = (
        _string_list(proposal.get("deliverables"))
        or _string_list(proposal.get("done_when"))
        or []
    )
    lines = [f"# Brief: {name}" if name else "# Brief", "", "## Goal", goal, ""]
    lines.append("## Deliverables")
    for number, check in enumerate(checks, start=1):
        lines.append(f"{number}. {check}")
    lines.append("")
    scope = str(proposal.get("scope") or "").strip()
    if scope:
        lines.extend(["## Scope", scope, ""])
    context = str(proposal.get("context") or "").strip()
    depends_on = depends_on_refs(proposal)
    if context or depends_on:
        lines.append("## Context")
        if context:
            lines.append(context)
        if depends_on:
            lines.append("Depends on: " + ", ".join(depends_on))
        lines.append("")
    return "\n".join(lines)


def graph_problems(graph_text: str) -> list[str]:
    problems: list[str] = []
    size = len(graph_text.encode("utf-8"))
    if size > MAX_GRAPH_BYTES:
        problems.append(
            f"graph file is {size} bytes; the maximum is {MAX_GRAPH_BYTES} — reduce it"
        )
    try:
        data = json.loads(graph_text)
    except json.JSONDecodeError as exc:
        return [*problems, f"graph is not valid JSON: {exc}"]
    if not isinstance(data, dict):
        return [
            *problems,
            "graph must be a JSON object with 'nodes' and optional 'edges'",
        ]
    if data.get("version") != GRAPH_SCHEMA_VERSION:
        problems.append(f"graph 'version' must be {GRAPH_SCHEMA_VERSION}")
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return [*problems, "graph 'nodes' must be a non-empty list"]
    if len(nodes) > MAX_GRAPH_NODES:
        problems.append(
            f"graph has {len(nodes)} nodes; the maximum is {MAX_GRAPH_NODES} — reduce the graph"
        )
    known_ids: set[str] = set()
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            problems.append(f"nodes[{index}] must be an object")
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id.strip():
            problems.append(f"nodes[{index}] needs a non-empty string 'id'")
            continue
        if node_id in known_ids:
            problems.append(f"duplicate node id: {node_id}")
            continue
        known_ids.add(node_id)
        label = node.get("label")
        if not isinstance(label, str) or not label.strip():
            problems.append(f"node '{node_id}' needs a non-empty string 'label'")
    edges = data.get("edges") or []
    if not isinstance(edges, list):
        return [*problems, "graph 'edges' must be a list"]
    valid_edges: list[tuple[str, str]] = []
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            problems.append(f"edges[{index}] must be an object")
            continue
        start, end = edge.get("from"), edge.get("to")
        if start not in known_ids or end not in known_ids:
            problems.append(
                f"edges[{index}] must reference existing node ids in 'from' and 'to'"
            )
        elif start == end:
            problems.append(f"edges[{index}] is a self-loop on '{start}'")
        else:
            valid_edges.append((str(start), str(end)))
    cycle = _cycle_problem(node_ids=known_ids, edges=valid_edges)
    if cycle:
        problems.append(cycle)
    return problems


def _cycle_problem(*, node_ids: set[str], edges: list[tuple[str, str]]) -> str | None:
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    indegree: dict[str, int] = {node_id: 0 for node_id in node_ids}
    for start, end in edges:
        outgoing[start].append(end)
        indegree[end] += 1
    queue = [node_id for node_id in node_ids if indegree[node_id] == 0]
    visited: set[str] = set()
    while queue:
        node_id = queue.pop()
        visited.add(node_id)
        for next_id in outgoing[node_id]:
            indegree[next_id] -= 1
            if indegree[next_id] == 0:
                queue.append(next_id)
    cycle = sorted(node_ids - visited)
    if cycle:
        return (
            "graph contains a cycle (must be a DAG); nodes on the cycle: "
            + ", ".join(cycle)
        )
    return None


def reflection_lens_doc_problems(text: str) -> list[str]:
    """Require each lens to author the TLDR used by macro reflection views."""

    if not text.strip():
        return ["reflection lens document is empty"]
    missing = required_markdown_sections_missing(
        text, REQUIRED_REFLECTION_LENS_DOC_SECTIONS
    )
    return (
        ["missing or empty required section: Summary"]
        if missing
        else []
    )


def reflection_doc_problems(text: str) -> list[str]:
    problems: list[str] = []
    stripped = text.strip()
    if not stripped:
        return ["reflection document is empty"]
    size = len(text.encode("utf-8"))
    if size > MAX_REFLECTION_DOC_BYTES:
        problems.append(
            f"reflection document is {size} bytes; keep it under "
            f"{MAX_REFLECTION_DOC_BYTES}"
        )
    headings = {
        re.sub(r"[^a-z0-9]+", " ", match.group(1).lower()).strip()
        for match in _MD_HEADING_RE.finditer(text)
    }
    for canonical, key in REQUIRED_REFLECTION_DOC_SECTIONS:
        if not any(heading.startswith(key) for heading in headings):
            problems.append(f"missing required section: {canonical}")
    return problems


def reflection_doc_review_problems(
    *, text: str, submitted_images: set[str], path: str
) -> list[str]:
    problems = reflection_doc_problems(text)
    for link in markdown_image_links(text):
        if link not in submitted_images:
            problems.append(
                f"image {link!r} has no submitted content: make sure the "
                f"file exists next to {path}, then resubmit the "
                "reflection document to submit it"
            )
    return problems


def validate_reflection_roster(*, lenses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Envelope check for a reflection roster."""
    contract = (
        "the reflection roster must declare exactly "
        f"{ROSTER_SIZE} lenses: the {len(CORE_LENS_IDS)} core lenses "
        f"({', '.join(CORE_LENS_IDS)}) plus "
        f"{ROSTER_SIZE - len(CORE_LENS_IDS)} lenses you design for this "
        "project, each with a 'charter' and a 'why_distinct' stating how it "
        "differs from the core three and from each other"
    )
    if len(lenses) != ROSTER_SIZE:
        raise ValidationError(f"got {len(lenses)} lenses; {contract}")
    core_by_id = {lens["id"]: lens for lens in CORE_LENSES}
    roster: list[dict[str, Any]] = []
    seen: set[str] = set()
    for lens in lenses:
        lens_id = str(lens.get("id") or "").strip()
        if not _LENS_ID_RE.match(lens_id):
            raise ValidationError(
                f"invalid lens id {lens_id!r}: use a lowercase slug "
                "(letters, digits, '_', '-') — it doubles as the reflection "
                "filename (<lens_id>.md)"
            )
        if lens_id in seen:
            raise ValidationError(f"duplicate lens id: {lens_id}")
        seen.add(lens_id)
        charter = str(lens.get("charter") or "").strip()
        why = str(lens.get("why_distinct") or "").strip()
        core = core_by_id.get(lens_id)
        if core is not None:
            roster.append(
                {
                    "id": lens_id,
                    "title": str(lens.get("title") or "").strip() or core["title"],
                    "charter": charter or core["charter"],
                    "core": True,
                    "why_distinct": why,
                }
            )
            continue
        if not charter:
            raise ValidationError(
                f"lens {lens_id!r} needs a charter (what angle it reads the "
                f"project from); {contract}"
            )
        if not why:
            raise ValidationError(
                f"lens {lens_id!r} needs why_distinct (how it differs from "
                f"the core three and the other authored lens); {contract}"
            )
        roster.append(
            {
                "id": lens_id,
                "title": str(lens.get("title") or "").strip()
                or lens_id.replace("_", " ").replace("-", " "),
                "charter": charter,
                "core": False,
                "why_distinct": why,
            }
        )
    missing_core = [cid for cid in CORE_LENS_IDS if cid not in seen]
    if missing_core:
        raise ValidationError(
            f"missing core lens(es): {', '.join(missing_core)}; {contract}"
        )
    return roster


def current_reflection_requirement_artifact(
    *, reflection: dict[str, Any], role: str
) -> dict[str, Any] | None:
    return preferred_artifact(
        artifacts=reflection.get("current_attempt_artifacts") or [],
        roles=(role,),
    )


def reflection_coverage_for(*, reflection: dict[str, Any]) -> dict[str, Any]:
    # A current-attempt lens doc covers lens L when it was submitted with the
    # explicit lens_id L (artifact.submit requires it for the role).
    by_lens: dict[str, dict[str, Any]] = {}
    for res in reflection.get("current_attempt_artifacts", []):
        if res.get("role") != REFLECTION_LENS_DOC_ROLE:
            continue
        lens_id = str(res.get("lens_id") or "")
        current = by_lens.get(lens_id)
        if current is not None and artifact_submission_recency_key(
            current
        ) >= artifact_submission_recency_key(res):
            continue
        by_lens[lens_id] = {
            "id": res.get("id"),
            "path": str(res.get("path") or ""),
            "artifact_id": res.get("id"),
            "role": res.get("role"),
            "submitted_order": res.get("submitted_order"),
            "updated_at": res.get("updated_at"),
        }
    lenses = []
    missing = []
    for lens in reflection.get("roster", []):
        lens_id = str(lens.get("id") or "")
        entry = by_lens.get(lens_id)
        lenses.append(
            {
                "lens_id": lens_id,
                "covered": entry is not None,
                "path": entry["path"] if entry else None,
                "artifact_id": entry.get("artifact_id") if entry else None,
                "role": entry.get("role") if entry else None,
                "submitted_order": (
                    entry.get("submitted_order") if entry else None
                ),
            }
        )
        if entry is None:
            missing.append(lens_id)
    return {"lenses": lenses, "missing": missing, "complete": not missing}


def claim_change_problems(
    spec: dict[str, Any],
    *,
    problems: list[str],
    claim_exists: Callable[[str], bool] | None = None,
) -> dict[str, dict[str, Any]]:
    raw = spec.get("claim_changes", [])
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        problems.append("claim_changes must be a list")
        return {}
    claim_keys: dict[str, dict[str, Any]] = {}
    updated_claim_ids: set[str] = set()
    for index, change in enumerate(raw):
        label = f"claim_changes[{index}]"
        if not isinstance(change, dict):
            problems.append(f"{label} must be an object")
            continue
        op = str(change.get("op") or "").strip()
        if op not in {"create", "update"}:
            problems.append(f"{label}.op must be 'create' or 'update'")
            continue
        if not str(change.get("rationale") or "").strip():
            problems.append(f"{label} needs a rationale")
        confidence = change.get("confidence")
        if confidence is not None and confidence not in CLAIM_CONFIDENCES:
            problems.append(
                f"{label}.confidence must be one of {', '.join(sorted(CLAIM_CONFIDENCES))}"
            )
        status = change.get("status")
        if status is not None and status not in CLAIM_STATUSES:
            problems.append(
                f"{label}.status must be one of {', '.join(sorted(CLAIM_STATUSES))}"
            )
        if op == "create":
            key = str(change.get("key") or "").strip()
            if key:
                if not _CHANGE_SPEC_KEY_RE.fullmatch(key):
                    problems.append(
                        f"{label}.key must start with a letter and use only "
                        "letters, digits, '_' and '-'"
                    )
                elif key in claim_keys:
                    problems.append(f"duplicate claim key: {key}")
                else:
                    claim_keys[key] = change
            if not str(change.get("statement") or "").strip():
                problems.append(f"{label}.statement is required for create")
        else:
            claim_id = str(change.get("claim_id") or "").strip()
            if not claim_id:
                problems.append(f"{label}.claim_id is required for update")
            elif claim_id in updated_claim_ids:
                problems.append(f"duplicate claim update: {claim_id}")
            elif claim_exists is not None and not claim_exists(claim_id):
                problems.append(f"{label}.claim_id not found in project: {claim_id}")
            else:
                updated_claim_ids.add(claim_id)
            if not any(
                field in change
                for field in ("statement", "scope", "status", "confidence")
            ):
                problems.append(
                    f"{label} update must include at least one of "
                    "statement, scope, status, confidence"
                )
    return claim_keys


def claim_refs(proposal: dict[str, Any]) -> list[str]:
    raw = proposal.get("tested_claim_refs", proposal.get("tested_claim_ids", []))
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return []


def _string_list(raw: Any) -> list[str] | None:
    """A list of non-empty strings, or None when the value is not a list."""
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return None


def depends_on_refs(proposal: dict[str, Any]) -> list[str]:
    return _string_list(proposal.get("depends_on")) or []


def decision_problems(
    spec: dict[str, Any],
    *,
    problems: list[str],
    claim_keys: dict[str, dict[str, Any]],
    claim_exists: Callable[[str], bool] | None = None,
    experiment_name_taken: Callable[[str], bool] | None = None,
    task_name_taken: Callable[[str], bool] | None = None,
    node_exists: Callable[[str], bool] | None = None,
    non_terminal_experiments: Callable[[], list[str]] | None = None,
) -> None:
    decision = spec.get("decision")
    if not isinstance(decision, dict):
        problems.append("decision must be an object")
        return
    typ = str(decision.get("type") or "").strip()
    if typ != "create_experiments":
        problems.append("decision.type must be 'create_experiments'")
        return
    experiments = decision.get("experiments")
    if experiments is None:
        experiments = []
    if not isinstance(experiments, list):
        problems.append("decision.experiments must be a list")
        return
    tasks = decision.get("tasks")
    if tasks is None:
        tasks = []
    if not isinstance(tasks, list):
        problems.append("decision.tasks must be a list")
        return
    if not experiments and not tasks:
        problems.append(
            "decision must propose at least one node — an experiment in "
            "decision.experiments or a task in decision.tasks: the next wave "
            "the project runs; stopping is the researcher's call, not the "
            "reflection's"
        )
    if len(experiments) > 3:
        problems.append(
            "decision.experiments must contain no more than three experiments"
        )
    if non_terminal_experiments is not None and experiments:
        active_count = len(non_terminal_experiments())
        if active_count + len(experiments) > ACTIVE_EXPERIMENT_CAP:
            problems.append(
                active_experiment_cap_would_exceed_message(
                    active_count=active_count,
                    proposed_count=len(experiments),
                )
            )
    seen_names: set[str] = set()
    node_keys: dict[str, str] = {}
    edges: list[tuple[str, str]] = []

    def check_key(label: str, proposal: dict[str, Any]) -> str:
        key = str(proposal.get("key") or "").strip()
        if key and not _CHANGE_SPEC_KEY_RE.fullmatch(key):
            problems.append(
                f"{label}.key must start with a letter and use only "
                "letters, digits, '_' and '-'"
            )
        elif key and key in node_keys:
            problems.append(f"duplicate node key in change spec: {key}")
        elif key:
            node_keys[key] = label
        return key

    def check_name(label: str, name: str, *, taken: Callable[[str], bool] | None,
                   subject: str) -> None:
        if not name:
            return
        lowered = name.lower()
        if lowered in seen_names:
            problems.append(f"duplicate node name in change spec: {name}")
        seen_names.add(lowered)
        if taken is not None and taken(name):
            problems.append(f"{subject} name already exists in project: {name}")

    for index, proposal in enumerate(experiments):
        label = f"decision.experiments[{index}]"
        if not isinstance(proposal, dict):
            problems.append(f"{label} must be an object")
            continue
        key = check_key(label, proposal)
        name = str(proposal.get("name") or "").strip()
        try:
            name = validate_experiment_name(name)
        except ValidationError as exc:
            problems.append(f"{label}.name invalid: {exc}")
            name = ""
        check_name(label, name, taken=experiment_name_taken, subject="experiment")
        if not str(proposal.get("intent") or "").strip():
            problems.append(f"{label}.intent is required")
        details_value = proposal.get("details")
        if details_value is not None and not isinstance(details_value, str):
            problems.append(f"{label}.details must be prose (a string)")
        refs = claim_refs(proposal)
        seen_refs: set[str] = set()
        for ref in refs:
            if ref in seen_refs:
                # Caught here so the agent gets a domain error at review time;
                # the materialization write also dedupes (defense in depth).
                problems.append(f"{label} lists a duplicate claim reference: {ref}")
                continue
            seen_refs.add(ref)
            if ref in claim_keys:
                continue
            if claim_exists is not None and not claim_exists(ref):
                problems.append(f"{label} references unknown claim or claim key: {ref}")
        for ref in depends_on_refs(proposal):
            edges.append((key or label, ref))
        if _string_list(proposal.get("depends_on")) is None:
            problems.append(f"{label}.depends_on must be a list of node keys or ids")

    for index, proposal in enumerate(tasks):
        label = f"decision.tasks[{index}]"
        if not isinstance(proposal, dict):
            problems.append(f"{label} must be an object")
            continue
        key = check_key(label, proposal)
        name = str(proposal.get("name") or "").strip()
        try:
            name = validate_task_name(name)
        except ValidationError as exc:
            problems.append(f"{label}.name invalid: {exc}")
            name = ""
        check_name(label, name, taken=task_name_taken, subject="task")
        if not str(proposal.get("goal") or "").strip():
            problems.append(f"{label}.goal is required")
        raw = proposal.get("deliverables")
        legacy = proposal.get("done_when")
        checks = _string_list(raw if raw is not None else legacy)
        if checks is None:
            problems.append(
                f"{label}.deliverables must be a list of deliverables"
            )
        elif not checks:
            problems.append(
                f"{label}.deliverables needs at least one item — a thing that "
                "must exist when the task is done, verifiable as written"
            )
        for field in ("scope", "context"):
            value = proposal.get(field)
            if value is not None and not isinstance(value, str):
                problems.append(f"{label}.{field} must be a string")
        for ref in depends_on_refs(proposal):
            edges.append((key or label, ref))
        if _string_list(proposal.get("depends_on")) is None:
            problems.append(f"{label}.depends_on must be a list of node keys or ids")

    # Dependencies: every ref is a key in this spec or an existing node id;
    # no self edges; no cycles among the spec's own keys.
    for source, ref in edges:
        if ref == source:
            problems.append(f"{source} cannot depend on itself")
        elif ref in node_keys:
            continue
        elif ref.startswith(("exp_", "task_")):
            if node_exists is not None and not node_exists(ref):
                problems.append(f"{source} depends on unknown node: {ref}")
        else:
            problems.append(
                f"{source} depends on unknown node key or id: {ref} (use a key "
                "from this change spec, or an existing exp_/task_ id)"
            )
    cycle = _cycle_problem(
        node_ids=set(node_keys),
        edges=[
            (source, ref)
            for source, ref in edges
            if source in node_keys and ref in node_keys and source != ref
        ],
    )
    if cycle:
        problems.append("depends_on " + cycle)


def parse_change_spec(
    *,
    text: str,
    path: str,
    claim_exists: Callable[[str], bool] | None = None,
    experiment_name_taken: Callable[[str], bool] | None = None,
    task_name_taken: Callable[[str], bool] | None = None,
    node_exists: Callable[[str], bool] | None = None,
    non_terminal_experiments: Callable[[], list[str]] | None = None,
) -> dict[str, Any]:
    """Validate a reviewed reflection change spec and return its JSON object."""
    problems: list[str] = []
    if not text.strip():
        raise WorkflowError(
            f"change spec {path!r} is empty — write it and "
            "resubmit it (artifact.submit) to submit the content"
        )
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WorkflowError(
            f"change spec {path!r} is not valid JSON: {exc}. "
            "Write the role 'change_spec' artifact from "
            "skills/project-reflection/reflection-artifacts-template.md and "
            "resubmit it with artifact.submit."
        ) from exc
    if not isinstance(spec, dict):
        raise WorkflowError(f"change spec {path!r} must be a JSON object")
    if spec.get("version") != CHANGE_SPEC_SCHEMA_VERSION:
        problems.append(f"version must be {CHANGE_SPEC_SCHEMA_VERSION}")

    claim_keys = claim_change_problems(
        spec,
        problems=problems,
        claim_exists=claim_exists,
    )
    decision_problems(
        spec,
        problems=problems,
        claim_keys=claim_keys,
        claim_exists=claim_exists,
        experiment_name_taken=experiment_name_taken,
        task_name_taken=task_name_taken,
        node_exists=node_exists,
        non_terminal_experiments=non_terminal_experiments,
    )
    if problems:
        raise WorkflowError(
            "change spec is not ready for review: "
            + "; ".join(problems)
            + ". Fix the file and resubmit it (artifact.submit) — "
            "see skills/project-reflection/reflection-artifacts-template.md."
        )
    return spec


def graph_diff(
    *, base_graph: dict[str, Any], current_graph: dict[str, Any]
) -> dict[str, Any]:
    base_nodes = _graph_node_index(graph=base_graph)
    current_nodes = _graph_node_index(graph=current_graph)
    base_edges = _graph_edge_index(graph=base_graph)
    current_edges = _graph_edge_index(graph=current_graph)
    return {
        "nodes": _diff_indexed_items(base=base_nodes, current=current_nodes),
        "edges": _diff_indexed_items(base=base_edges, current=current_edges),
    }


def graph_diff_summary(*, diff: dict[str, Any]) -> str:
    nodes = diff.get("nodes") or {}
    edges = diff.get("edges") or {}
    return (
        "Project graph diff: "
        f"{len(nodes.get('added') or [])} nodes added, "
        f"{len(nodes.get('removed') or [])} removed, "
        f"{len(nodes.get('changed') or [])} changed; "
        f"{len(edges.get('added') or [])} edges added, "
        f"{len(edges.get('removed') or [])} removed, "
        f"{len(edges.get('changed') or [])} changed."
    )


def _graph_node_index(*, graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        if node_id:
            indexed[node_id] = _sorted_json_object(node)
    return indexed


def _graph_edge_index(*, graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        frm = str(edge.get("from") or "")
        to = str(edge.get("to") or "")
        if frm and to:
            indexed[f"{frm}->{to}"] = _sorted_json_object(edge)
    return indexed


def _sorted_json_object(item: dict[str, Any]) -> dict[str, Any]:
    return {key: item[key] for key in sorted(item)}


def _diff_indexed_items(
    *, base: dict[str, dict[str, Any]], current: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    base_keys = set(base)
    current_keys = set(current)
    changed = []
    for key in sorted(base_keys & current_keys):
        before = base[key]
        after = current[key]
        if before == after:
            continue
        changed.append(
            {
                "id": key,
                "before": before,
                "after": after,
                "changed_fields": [
                    field
                    for field in sorted(set(before) | set(after))
                    if before.get(field) != after.get(field)
                ],
            }
        )
    return {
        "added": [current[key] for key in sorted(current_keys - base_keys)],
        "removed": [base[key] for key in sorted(base_keys - current_keys)],
        "changed": changed,
        "unchanged_count": len(base_keys & current_keys) - len(changed),
    }
