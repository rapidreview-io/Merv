"""Artifact evidence selection and pure document-envelope validation.

Every research document declares its shape once, as a pydantic model. A
validator asks the model first and then applies only the rules a schema cannot
state: cycles, uniqueness across entries, and cross-references into the project,
which arrive as narrow callbacks. Research workflows deliberately keep these
checks pure — no database question is asked here.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, TypeVar

from pydantic import (
    AfterValidator,
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError as SchemaBreach,
    model_validator,
)

from .artifact_roles import REFLECTION_LENS_DOC_ROLE
from merv.shared.markdown_images import markdown_image_links

from .research_contracts import (
    ACTIVE_EXPERIMENT_CAP,
    CLAIM_CONFIDENCES,
    CLAIM_STATUSES,
    CORE_LENSES,
    CORE_LENS_IDS,
    ROSTER_SIZE,
    active_experiment_cap_would_exceed_message,
    validate_experiment_name,
    validate_task_name,
)
from ...kernel.tools import ContractModel
from ...kernel.utils import ValidationError, WorkflowError

CHANGE_SPEC_SCHEMA_VERSION = 1
MAX_REFLECTION_DOC_BYTES = 16_000
REQUIRED_REFLECTION_LENS_DOC_SECTIONS: tuple[tuple[str, str], ...] = (("Summary", "summary"),)
REQUIRED_REFLECTION_DOC_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Summary", "summary"),
    ("Critical reading", "critical"),
    ("Decision / future directions", "decision"),
)

_CHANGE_SPEC_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
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
REQUIRED_BRIEF_SECTIONS: tuple[tuple[str, str], ...] = (("Goal", "goal"),)
# The contract list section: "Deliverables" is current; "Done when" is the
# pre-schema name and stays readable.
BRIEF_LIST_SECTIONS: tuple[str, ...] = ("deliverables", "done when")
# The delivery's per-deliverable section: "Confirmations" is current;
# "Checks" is the pre-schema name and stays readable.
DELIVERY_LIST_SECTIONS: tuple[str, ...] = ("confirmations", "checks")
REQUIRED_DELIVERY_SECTIONS: tuple[tuple[str, str], ...] = (("Confirmations", "confirmations"),)
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
    artifact: Any | None, *, artifact_id: str, what: str
) -> ArtifactDocument:
    if not artifact_id:
        raise WorkflowError(
            f"{what} has no submitted artifact — submit it with artifact.upload"
        )
    if artifact is None or artifact.status != "complete":
        raise WorkflowError(f"{what}: artifact not found: {artifact_id}")
    if artifact.data is None:
        raise WorkflowError(
            f"{what} ({artifact.path}) has no submitted content — resubmit it "
            "with artifact.upload"
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
        [a for a in artifacts if a.get("attempt_index") == attempt]
    )


def sealed_submission_artifacts(
    artifacts: list[dict[str, Any]], *, submission_id: str
) -> list[dict[str, Any]]:
    if not submission_id:
        return []
    return [a for a in artifacts if str(a.get("submission_id") or "") == submission_id]


def historical_latest_artifacts(
    artifacts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return latest_per_slot(artifacts)


def artifact_state_record(evidence: Any) -> dict[str, Any]:
    record = {
        field: getattr(evidence, field)
        for field in (
            "id", "project_id", "path", "title", "lens_id", "size_bytes",
            "content_type", "created_by", "created_at", "updated_at", "role",
            "attempt_index", "tldr", "submission_id",
        )
    }
    return {**record, "submitted_order": evidence.order}


def submission_state_record(submission: Any) -> dict[str, Any]:
    return {
        "id": submission.id,
        "attempt_index": submission.attempt_index,
        "transition": submission.transition,
        "created_at": submission.created_at,
        "created_seq": submission.order,
        "artifact_ids": list(submission.artifact_ids),
    }


def preferred_artifact(
    *, artifacts: list[dict[str, Any]], roles: tuple[str, ...]
) -> dict[str, Any] | None:
    """Pick the newest artifact in the highest-precedence requested role."""
    rank = {role: index for index, role in enumerate(roles)}
    ranked = [(rank[str(a.get("role") or "")], a) for a in artifacts if str(a.get("role") or "") in rank]
    if not ranked:
        return None
    best = min(index for index, _ in ranked)
    return max(
        (a for index, a in ranked if index == best), key=artifact_submission_recency_key
    )


# ---- markdown documents as a section table --------------------------------
# Plan, report, brief, delivery and reflection documents are prose: their
# schema is the table of headings each one must carry, above.


def _sections(text: str) -> list[tuple[str, str]]:
    """Each heading's normalized name and the body it owns, comments stripped."""
    text = _HTML_COMMENT_RE.sub("", text)
    heads = [
        (match.start(), len(match.group(1)), _normalize_heading(match.group(2)), match.end())
        for match in _HEADING_RE.finditer(text)
    ]
    return [
        (
            name,
            text[body_start : next(
                (start for start, deeper, _, _ in heads[index + 1 :] if deeper <= level),
                len(text),
            )],
        )
        for index, (_, level, name, body_start) in enumerate(heads)
    ]


def _normalize_heading(text: str) -> str:
    return re.sub(
        r"[^a-z0-9]+", " ", text.replace("&", " and ").lower()
    ).strip()


def markdown_section_body(text: str, key: str) -> str | None:
    """Body of the first heading whose normalized text starts with ``key``."""
    return next((body for name, body in _sections(text) if name.startswith(key)), None)


def required_markdown_sections_missing(
    text: str, required: tuple[tuple[str, str], ...]
) -> list[str]:
    """Return required headings that are missing or have an empty body."""
    sections = _sections(text)
    missing: list[str] = []
    for canonical, key in required:
        body = next((body for name, body in sections if name.startswith(key)), None)
        if body is None or not body.strip():
            missing.append(canonical)
    return missing


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
                "attempt's result files — write the Results section around it "
                "and cite it by name"
            )
    problems += _oversize(
        report_text,
        cap=MAX_REPORT_BYTES,
        what="report",
        advice="move raw numbers and logs into result artifacts and link them instead",
    )
    if figure_problem is not None:
        for target in report_figure_links(report_text):
            problem = figure_problem(target)
            if problem:
                problems.append(problem)
    return problems


def _oversize(text: str, *, cap: int, what: str, advice: str) -> list[str]:
    size = len(text.encode("utf-8"))
    if size <= cap:
        return []
    return [f"{what} is {size} bytes; keep it under {cap} — {advice}"]


# ---- declared documents ----------------------------------------------------

Model = TypeVar("Model", bound=BaseModel)


class Declared(BaseModel):
    """A declared research document: whitespace-stripped, and silent about the
    vocabulary it does not police — node kinds, edge labels, agent prose."""

    model_config = ConfigDict(str_strip_whitespace=True)


def _listed(value: Any) -> Any:
    """The shapes an agent writes a list of ids in: one, many, or none. Anything
    else passes through so the model itself names the type error."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return value
    return [str(item).strip() for item in value if str(item).strip()]


Refs = Annotated[list[str], BeforeValidator(_listed)]
# JSON ``null`` where the document could simply have omitted the list.
Listed = BeforeValidator(lambda value: [] if value is None else value)
# The same list as an MCP client may write it; tool inputs keep this wire shape.
WrittenList = list[str] | str | None


def _spec_key(value: str) -> str:
    if value and not _CHANGE_SPEC_KEY_RE.fullmatch(value):
        raise ValueError(
            "must start with a letter and use only letters, digits, '_' and '-'"
        )
    return value


def _folder_name(validate: Callable[[str], str]) -> Callable[[str], str]:
    """Reuse the project's folder-name rule as a field rule."""

    def named(value: str) -> str:
        try:
            return validate(value)
        except ValidationError as exc:
            raise ValueError(f"invalid: {exc}") from exc

    return named


SpecKey = Annotated[str, AfterValidator(_spec_key)]
ExperimentName = Annotated[str, AfterValidator(_folder_name(validate_experiment_name))]
TaskName = Annotated[str, AfterValidator(_folder_name(validate_task_name))]


def _problem(error: dict[str, Any], at: str) -> str:
    where = at
    for part in error["loc"]:
        where += f"[{part}]" if isinstance(part, int) else f".{part}" if where else part
    message = re.sub(r"^Value error, | or instance of \w+", "", error["msg"])
    return f"{where}: {message}" if where else message


def _checked(
    model: type[Model], payload: Any, *, at: str = ""
) -> tuple[Model | None, list[str]]:
    """The parsed document, or None plus one problem per declared rule it breaks."""
    try:
        return model.model_validate(payload), []
    except SchemaBreach as breach:
        return None, [_problem(error, at) for error in breach.errors()]


class GraphNode(Declared):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)


class GraphEdge(Declared):
    source: str = Field(alias="from", min_length=1)
    target: str = Field(alias="to", min_length=1)


class ProjectGraph(Declared):
    """The project's logic graph: what the work established and what it opened."""

    version: Literal[GRAPH_SCHEMA_VERSION]
    nodes: list[GraphNode] = Field(min_length=1, max_length=MAX_GRAPH_NODES)
    edges: Annotated[list[GraphEdge], Listed] = []


class ReflectionLens(ContractModel):
    """One lens of a reflection roster: the angle it reads the project from."""

    id: str = Field(
        description=(
            "Lens id slug (lowercase letters/digits/'_'/'-'). It doubles as the "
            "reflection filename: the lens's subagent submits <id>.md."
        )
    )
    title: str = ""
    charter: str = Field(
        default="",
        description=(
            "What angle this lens reads the project from. The core lenses "
            "(amplify, avoid, entropy) default their charter; the two "
            "wave-authored lenses must supply one."
        ),
    )
    why_distinct: str = Field(
        default="",
        description=(
            "Required for the two wave-authored lenses: how this lens differs "
            "from the core three and from the other authored lens. Engineered "
            "diversity is the point of the roster."
        ),
    )

    @model_validator(mode="after")
    def _slug_doubles_as_a_filename(self) -> "ReflectionLens":
        if not _LENS_ID_RE.match(self.id):
            raise ValueError(
                f"invalid lens id {self.id!r}: use a lowercase slug "
                "(letters, digits, '_', '-') — it doubles as the reflection "
                "filename (<lens_id>.md)"
            )
        return self


class RosterLens(ReflectionLens):
    """A validated roster entry: the lens plus whether it is one of the core three."""

    core: bool = False


class ConsolidationDecision(ContractModel):
    """One experiment's disposition, as the consolidating agent declares it."""

    experiment_id: str
    disposition: Literal["used_as_is", "adapted", "reviewed_not_used", "superseded"]
    rationale: str
    integration_kind: Literal["merge", "fast_forward", "cherry_pick", "rewrite", "none"]
    superseded_by: str = ""

    @property
    def carries_code(self) -> bool:
        return self.disposition in ("used_as_is", "adapted")

    @model_validator(mode="after")
    def _disposition_agrees_with_its_git_story(self) -> "ConsolidationDecision":
        if not self.rationale:
            raise ValueError(
                f"consolidation rationale is required for {self.experiment_id}"
            )
        if self.carries_code != (self.integration_kind != "none"):
            raise ValueError(
                f"{self.experiment_id} disposition {self.disposition!r} requires "
                + ("a Git integration kind" if self.carries_code else "integration_kind='none'")
            )
        if bool(self.superseded_by) != (self.disposition == "superseded"):
            raise ValueError(
                f"superseded decision for {self.experiment_id} must name the "
                "superseding experiment"
                if self.disposition == "superseded"
                else "superseded_by is valid only for a superseded decision"
            )
        if self.superseded_by == self.experiment_id:
            raise ValueError(f"{self.experiment_id} cannot supersede itself")
        return self


class SealedConsolidationDecision(ConsolidationDecision):
    """The declaration plus the workspace head Merv seals onto it; a consolidator
    never tells us which branch it reviewed."""

    source_sha: Annotated[str, AfterValidator(lambda sha: git_sha(sha) if sha else "")] = ""

    @model_validator(mode="after")
    def _code_names_the_head_it_came_from(self) -> "SealedConsolidationDecision":
        if not self.source_sha and self.carries_code:
            raise ValueError(
                f"{self.experiment_id} cannot carry code without a recorded "
                "experiment workspace head"
            )
        return self


class ClaimChange(Declared):
    """One claim the wave creates or revises."""

    op: Literal["create", "update"]
    key: SpecKey = ""
    claim_id: str = ""
    statement: str = ""
    scope: str = ""
    status: Literal[*sorted(CLAIM_STATUSES)] | None = None
    confidence: Literal[*sorted(CLAIM_CONFIDENCES)] | None = None
    rationale: str = Field(min_length=1)

    @model_validator(mode="after")
    def _op_carries_its_own_fields(self) -> "ClaimChange":
        if self.op == "create":
            if not self.statement:
                raise ValueError("statement is required for create")
        elif not self.claim_id:
            raise ValueError("claim_id is required for update")
        elif not {"statement", "scope", "status", "confidence"} & self.model_fields_set:
            raise ValueError(
                "update must include at least one of statement, scope, status, "
                "confidence"
            )
        return self


class NodeProposal(Declared):
    """What every proposed wave node carries: a spec-local key and its edges."""

    key: SpecKey = ""
    depends_on: Refs = []


class ExperimentProposal(NodeProposal):
    """An experiment the reflection proposes for the next wave."""

    name: ExperimentName
    intent: str = Field(min_length=1)
    details: str | None = None
    tested_claim_refs: Refs = Field(
        default=[],
        validation_alias=AliasChoices("tested_claim_refs", "tested_claim_ids"),
    )


def _one_thing_each(value: list[str]) -> list[str]:
    if not value:
        raise ValueError(
            "needs at least one item — a thing that must exist when the task "
            "is done, verifiable as written"
        )
    return value


class TaskProposal(NodeProposal):
    """A task the reflection proposes: goal prose plus the deliverables contract."""

    name: TaskName
    goal: str = Field(min_length=1)
    deliverables: Annotated[Refs, AfterValidator(_one_thing_each)] = Field(
        validation_alias=AliasChoices("deliverables", "done_when")
    )
    scope: str = ""
    context: str = ""


class Decision(Declared):
    """The wave a reviewed reflection proposes the project run next."""

    type: Literal["create_experiments"]
    experiments: Annotated[list[ExperimentProposal], Listed] = Field(default=[], max_length=3)
    tasks: Annotated[list[TaskProposal], Listed] = []

    @model_validator(mode="after")
    def _proposes_a_wave(self) -> "Decision":
        if not self.experiments and not self.tasks:
            raise ValueError(
                "must propose at least one node — an experiment in "
                "decision.experiments or a task in decision.tasks: the next wave "
                "the project runs; stopping is the researcher's call, not the "
                "reflection's"
            )
        return self


# ---- rules a schema cannot state ------------------------------------------


def cycle_problem(*, node_ids: set[str], edges: list[tuple[str, str]]) -> str | None:
    """Kahn's algorithm: whatever never reaches indegree zero sits on a cycle."""
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


def _graph_reference_problems(graph: ProjectGraph) -> list[str]:
    """Unique node ids, edges that resolve to them, and no cycle."""
    problems: list[str] = []
    known: set[str] = set()
    for node in graph.nodes:
        if node.id in known:
            problems.append(f"duplicate node id: {node.id}")
        known.add(node.id)
    edges: list[tuple[str, str]] = []
    for index, edge in enumerate(graph.edges):
        if edge.source not in known or edge.target not in known:
            problems.append(
                f"edges[{index}] must reference existing node ids in 'from' and 'to'"
            )
        elif edge.source == edge.target:
            problems.append(f"edges[{index}] is a self-loop on '{edge.source}'")
        else:
            edges.append((edge.source, edge.target))
    cycle = cycle_problem(node_ids=known, edges=edges)
    return problems + ([cycle] if cycle else [])


def graph_problems(graph_text: str) -> list[str]:
    problems = _oversize(
        graph_text, cap=MAX_GRAPH_BYTES, what="graph file", advice="reduce it"
    )
    try:
        data = json.loads(graph_text)
    except json.JSONDecodeError as exc:
        return [*problems, f"graph is not valid JSON: {exc}"]
    graph, breaches = _checked(ProjectGraph, data, at="graph")
    problems += breaches
    return problems if graph is None else problems + _graph_reference_problems(graph)


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


def _list_section(text: str, keys: tuple[str, ...]) -> str | None:
    """The first of several accepted heading names that the document uses."""
    bodies = (markdown_section_body(text, key) for key in keys)
    return next((body for body in bodies if body is not None), None)


def brief_checks(brief_text: str) -> list[str]:
    """The brief's deliverables in numeric order (empty if malformed)."""
    body = _list_section(brief_text, BRIEF_LIST_SECTIONS)
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
    body = _list_section(brief_text, BRIEF_LIST_SECTIONS)
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
    return problems + _oversize(
        brief_text,
        cap=MAX_BRIEF_BYTES,
        what="brief",
        advice="the brief is a contract, not a plan",
    )


def delivery_problems(delivery_text: str, *, checks: list[str]) -> list[str]:
    """Shape only: one confirmation per deliverable. Content is the reviewer's."""
    problems: list[str] = []
    body = _list_section(delivery_text, DELIVERY_LIST_SECTIONS)
    if body is None:
        problems.append(
            "missing required sections: Confirmations (one numbered entry per "
            "deliverable)"
        )
    else:
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
    return problems + _oversize(
        delivery_text,
        cap=MAX_DELIVERY_BYTES,
        what="delivery",
        advice="point at files and receipts instead of inlining them",
    )


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
    body = _list_section(delivery_text, DELIVERY_LIST_SECTIONS)
    entries = {} if body is None else numbered_items(body)
    results: list[dict[str, Any]] = []
    for number in sorted(set(range(1, count + 1)) | set(entries)):
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
    return _HTML_COMMENT_RE.sub("", body).strip() or None


def render_task_brief(proposal: dict[str, Any]) -> str:
    """The brief.md Merv pins at task creation.

    Rendered from the immutable goal — prose plus the numbered deliverables —
    so the record on disk and the reviewer read one canonical form. Legacy
    proposals may still carry the list as ``done_when``.
    """
    task = TaskProposal.model_validate(proposal)
    lines = [f"# Brief: {task.name}", "", "## Goal", task.goal, "", "## Deliverables"]
    lines += [f"{number}. {check}" for number, check in enumerate(task.deliverables, 1)]
    lines.append("")
    if task.scope:
        lines += ["## Scope", task.scope, ""]
    if task.context or task.depends_on:
        lines.append("## Context")
        if task.context:
            lines.append(task.context)
        if task.depends_on:
            lines.append("Depends on: " + ", ".join(task.depends_on))
        lines.append("")
    return "\n".join(lines)


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
    if not text.strip():
        return ["reflection document is empty"]
    problems = _oversize(
        text,
        cap=MAX_REFLECTION_DOC_BYTES,
        what="reflection document",
        advice="cite the lens documents instead of quoting them",
    )
    names = [name for name, _ in _sections(text)]
    return problems + [
        f"missing required section: {canonical}"
        for canonical, key in REQUIRED_REFLECTION_DOC_SECTIONS
        if not any(name.startswith(key) for name in names)
    ]


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


ROSTER_CONTRACT = (
    "the reflection roster must declare exactly "
    f"{ROSTER_SIZE} lenses: the {len(CORE_LENS_IDS)} core lenses "
    f"({', '.join(CORE_LENS_IDS)}) plus "
    f"{ROSTER_SIZE - len(CORE_LENS_IDS)} lenses you design for this "
    "project, each with a 'charter' and a 'why_distinct' stating how it "
    "differs from the core three and from each other"
)


def validate_reflection_roster(*, lenses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Envelope check for a reflection roster."""
    if len(lenses) != ROSTER_SIZE:
        raise ValidationError(f"got {len(lenses)} lenses; {ROSTER_CONTRACT}")
    core_by_id = {lens["id"]: lens for lens in CORE_LENSES}
    roster: list[dict[str, Any]] = []
    seen: set[str] = set()
    for lens in lenses:
        entry, breaches = _checked(RosterLens, lens)
        if entry is None:
            raise ValidationError(f"{'; '.join(breaches)}; {ROSTER_CONTRACT}")
        if entry.id in seen:
            raise ValidationError(f"duplicate lens id: {entry.id}")
        seen.add(entry.id)
        core = core_by_id.get(entry.id)
        if core is None and not (entry.charter and entry.why_distinct):
            raise ValidationError(
                f"lens {entry.id!r} needs a charter (what angle it reads the "
                "project from) and a why_distinct (how it differs from the "
                f"core three and the other authored lens); {ROSTER_CONTRACT}"
            )
        roster.append(
            {
                "id": entry.id,
                "title": entry.title
                or (core or {}).get("title")
                or entry.id.replace("_", " ").replace("-", " "),
                "charter": entry.charter or (core or {}).get("charter", ""),
                "core": core is not None,
                "why_distinct": entry.why_distinct,
            }
        )
    missing_core = [cid for cid in CORE_LENS_IDS if cid not in seen]
    if missing_core:
        raise ValidationError(
            f"missing core lens(es): {', '.join(missing_core)}; {ROSTER_CONTRACT}"
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
    # explicit lens_id L (artifact.upload requires it for the role).
    newest: dict[str, dict[str, Any]] = {}
    for res in reflection.get("current_attempt_artifacts", []):
        if res.get("role") != REFLECTION_LENS_DOC_ROLE:
            continue
        lens_id = str(res.get("lens_id") or "")
        held = newest.get(lens_id)
        if held is None or artifact_submission_recency_key(
            res
        ) > artifact_submission_recency_key(held):
            newest[lens_id] = res
    lenses = [
        {
            "lens_id": lens_id,
            "covered": entry is not None,
            "path": str(entry.get("path") or "") if entry else None,
            "artifact_id": entry.get("id") if entry else None,
            "role": entry.get("role") if entry else None,
            "submitted_order": entry.get("submitted_order") if entry else None,
        }
        for lens_id, entry in (
            (lens_id, newest.get(lens_id))
            for lens_id in (
                str(lens.get("id") or "") for lens in reflection.get("roster", [])
            )
        )
    ]
    return {
        "lenses": lenses,
        "missing": [lens["lens_id"] for lens in lenses if not lens["covered"]],
        "complete": all(lens["covered"] for lens in lenses),
    }


def claim_change_problems(
    spec: dict[str, Any],
    *,
    problems: list[str],
    claim_exists: Callable[[str], bool] | None = None,
) -> dict[str, dict[str, Any]]:
    raw = spec.get("claim_changes")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        problems.append("claim_changes must be a list")
        return {}
    claim_keys: dict[str, dict[str, Any]] = {}
    updated_claim_ids: set[str] = set()
    for index, item in enumerate(raw):
        label = f"claim_changes[{index}]"
        change, breaches = _checked(ClaimChange, item, at=label)
        problems += breaches
        if change is None:
            continue
        if change.op == "create":
            if change.key in claim_keys:
                problems.append(f"duplicate claim key: {change.key}")
            elif change.key:
                claim_keys[change.key] = change.model_dump()
        elif change.claim_id in updated_claim_ids:
            problems.append(f"duplicate claim update: {change.claim_id}")
        elif claim_exists is not None and not claim_exists(change.claim_id):
            problems.append(f"{label}.claim_id not found in project: {change.claim_id}")
        else:
            updated_claim_ids.add(change.claim_id)
    return claim_keys


_REFS = TypeAdapter(Refs)


def claim_refs(proposal: dict[str, Any]) -> list[str]:
    return _REFS.validate_python(
        proposal.get("tested_claim_refs", proposal.get("tested_claim_ids", []))
    )


def depends_on_refs(proposal: dict[str, Any]) -> list[str]:
    return _REFS.validate_python(proposal.get("depends_on"))


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
    decision, breaches = _checked(Decision, spec.get("decision"), at="decision")
    problems += breaches
    if decision is None:
        return
    problems += _wave_problems(
        decision,
        claim_keys=claim_keys,
        claim_exists=claim_exists,
        experiment_name_taken=experiment_name_taken,
        task_name_taken=task_name_taken,
        node_exists=node_exists,
        non_terminal_experiments=non_terminal_experiments,
    )


def _wave_problems(
    decision: Decision,
    *,
    claim_keys: dict[str, dict[str, Any]],
    claim_exists: Callable[[str], bool] | None,
    experiment_name_taken: Callable[[str], bool] | None,
    task_name_taken: Callable[[str], bool] | None,
    node_exists: Callable[[str], bool] | None,
    non_terminal_experiments: Callable[[], list[str]] | None,
) -> list[str]:
    """Everything about the wave as a whole: unique keys and names, claim and
    node references that resolve, and the shape of its dependency DAG."""
    problems: list[str] = []
    if non_terminal_experiments is not None and decision.experiments:
        active_count = len(non_terminal_experiments())
        if active_count + len(decision.experiments) > ACTIVE_EXPERIMENT_CAP:
            problems.append(
                active_experiment_cap_would_exceed_message(
                    active_count=active_count,
                    proposed_count=len(decision.experiments),
                )
            )
    nodes = [
        (f"decision.experiments[{index}]", proposal, True)
        for index, proposal in enumerate(decision.experiments)
    ] + [
        (f"decision.tasks[{index}]", proposal, False)
        for index, proposal in enumerate(decision.tasks)
    ]
    node_keys: dict[str, str] = {}
    experiment_nodes: set[str] = set()
    seen_names: set[str] = set()
    edges: list[tuple[str, str]] = []
    for label, proposal, is_experiment in nodes:
        if proposal.key and proposal.key in node_keys:
            problems.append(f"duplicate node key in change spec: {proposal.key}")
        elif proposal.key:
            node_keys[proposal.key] = label
        if is_experiment:
            experiment_nodes.add(proposal.key or label)
        if proposal.name.lower() in seen_names:
            problems.append(f"duplicate node name in change spec: {proposal.name}")
        seen_names.add(proposal.name.lower())
        taken = experiment_name_taken if is_experiment else task_name_taken
        if taken is not None and taken(proposal.name):
            subject = "experiment" if is_experiment else "task"
            problems.append(
                f"{subject} name already exists in project: {proposal.name}"
            )
        edges += [(proposal.key or label, ref) for ref in proposal.depends_on]
        if not is_experiment:
            continue
        seen_refs: set[str] = set()
        for ref in proposal.tested_claim_refs:
            if ref in seen_refs:
                # Caught here so the agent gets a domain error at review time;
                # the materialization write also dedupes (defense in depth).
                problems.append(f"{label} lists a duplicate claim reference: {ref}")
            elif (
                ref not in claim_keys
                and claim_exists is not None
                and not claim_exists(ref)
            ):
                problems.append(f"{label} references unknown claim or claim key: {ref}")
            seen_refs.add(ref)

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
    cycle = cycle_problem(
        node_ids=set(node_keys),
        edges=[
            (source, ref)
            for source, ref in edges
            if source in node_keys and ref in node_keys and source != ref
        ],
    )
    if cycle:
        problems.append("depends_on " + cycle)
    return problems + _sequential_experiment_problems(
        edges=edges, node_keys=node_keys, experiment_nodes=experiment_nodes
    )


def _sequential_experiment_problems(
    *,
    edges: list[tuple[str, str]],
    node_keys: dict[str, str],
    experiment_nodes: set[str],
) -> list[str]:
    """No sequential experiments inside one wave: an experiment may not run
    after another experiment — directly or through any chain of tasks. An
    experiment that builds on a sibling's results is the next reflection's
    proposal. Edges onto existing exp_/task_ ids are lineage to earlier waves
    and stay outside this rule."""
    adjacency: dict[str, set[str]] = {}
    for source, ref in edges:
        if ref in node_keys and ref != source:
            adjacency.setdefault(source, set()).add(ref)
    experiment_keys = {key for key in experiment_nodes if key in node_keys}
    problems: list[str] = []
    for origin in sorted(experiment_nodes):
        parent: dict[str, str] = {ref: "" for ref in adjacency.get(origin, ())}
        queue = sorted(parent)
        found = ""
        while queue:
            node = queue.pop(0)
            if node in experiment_keys:
                found = node
                break
            for nxt in sorted(adjacency.get(node, ())):
                if nxt not in parent:
                    parent[nxt] = node
                    queue.append(nxt)
        if not found:
            continue
        chain: list[str] = []
        walk = parent[found]
        while walk:
            chain.append(walk)
            walk = parent[walk]
        chain.reverse()
        via = f" through {' -> '.join(chain)}" if chain else ""
        problems.append(
            f"{node_keys.get(origin, origin)} depends on experiment "
            f"{found}{via}: no sequential experiments in one wave — an "
            "experiment that builds on another experiment's results is "
            "the next reflection's proposal"
        )
    return problems


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
            "resubmit it (artifact.upload) to submit the content"
        )
    try:
        spec = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WorkflowError(
            f"change spec {path!r} is not valid JSON: {exc}. "
            "Write the role 'change_spec' artifact from "
            "skills/project-reflection/reflection-artifacts-template.md and "
            "resubmit it with artifact.upload."
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
            + ". Fix the file and resubmit it (artifact.upload) — "
            "see skills/project-reflection/reflection-artifacts-template.md."
        )
    return spec


def graph_diff(
    *, base_graph: dict[str, Any], current_graph: dict[str, Any]
) -> dict[str, Any]:
    return {
        kind: _diff_indexed_items(
            base=_graph_index(graph=base_graph, kind=kind),
            current=_graph_index(graph=current_graph, kind=kind),
        )
        for kind in ("nodes", "edges")
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


def _graph_index(*, graph: dict[str, Any], kind: str) -> dict[str, dict[str, Any]]:
    """Items by identity — a node's id, an edge's ``from->to`` — fields sorted."""
    indexed: dict[str, dict[str, Any]] = {}
    for item in graph.get(kind) or []:
        if not isinstance(item, dict):
            continue
        if kind == "nodes":
            key = str(item.get("id") or "")
        else:
            frm, to = str(item.get("from") or ""), str(item.get("to") or "")
            key = f"{frm}->{to}" if frm and to else ""
        if key:
            indexed[key] = {field: item[field] for field in sorted(item)}
    return indexed


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


def validate_consolidation_decisions(
    *,
    decisions: list[dict[str, Any]],
    expected_experiments: set[str],
) -> list[dict[str, Any]]:
    if not isinstance(decisions, list):
        raise ValidationError("decisions must be a list")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in decisions:
        decision, breaches = _checked(SealedConsolidationDecision, raw)
        if decision is None:
            raise ValidationError("; ".join(breaches))
        if decision.experiment_id not in expected_experiments:
            raise ValidationError(
                "consolidation decision names an experiment outside the "
                f"reflection corpus: {decision.experiment_id or '<missing>'}"
            )
        if decision.experiment_id in seen:
            raise ValidationError(
                f"duplicate consolidation decision for {decision.experiment_id}"
            )
        if decision.superseded_by and decision.superseded_by not in expected_experiments:
            raise ValidationError(
                f"superseded decision for {decision.experiment_id} must name the "
                "superseding experiment"
            )
        normalized.append(decision.model_dump())
        seen.add(decision.experiment_id)
    missing = sorted(expected_experiments - seen)
    if missing:
        raise ValidationError(
            "every experiment must be reviewed for consolidation; missing: "
            + ", ".join(missing)
        )
    return normalized


def git_sha(value: Any) -> str:
    sha = str(value or "").strip().lower()
    if not (40 <= len(sha) <= 64) or any(
        character not in "0123456789abcdef" for character in sha
    ):
        raise ValidationError("Git SHA must be a full hexadecimal object id")
    return sha
