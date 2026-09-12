"""Workflow values and one evaluation shared by commands, guidance and dispatch."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from types import MappingProxyType
from typing import Any, Generic, Literal, Protocol, TYPE_CHECKING, TypeVar

from merv.shared.workspace_policy import REFERENCE_BASE_PREFIX, WorkspacePolicy

from .definitions.documents import preferred_artifact
from ..kernel.utils import WorkflowError

if TYPE_CHECKING:
    from .composition import Child, ChildResult
    from ..kernel.tools import ToolContract

Data = Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class Reference:
    kind: str
    id: str
    label: str = ""


class Knowledge(Protocol):
    """A reader bound to one project and the current transaction/snapshot."""

    def read(self, reference: Reference) -> Data: ...


@dataclass(frozen=True, slots=True)
class Snapshot:
    id: str
    project_id: str
    workflow: str
    version: int
    state: str
    revision: int
    data: Data = field(default_factory=dict)
    outcome: str = ""
    children: tuple[ChildResult, ...] = ()


@dataclass(frozen=True, slots=True)
class Issue:
    code: str
    message: str
    action: str = ""
    tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Brief:
    summary: str
    references: tuple[Reference, ...] = ()


@dataclass(frozen=True, slots=True)
class Action:
    """A requested external effect; delivery supplies its stable idempotency key."""

    kind: str
    data: Data = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TransactionalEffect:
    """A synchronous write on the transition's connection; failure aborts it."""

    kind: str
    data: Data = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Change:
    """A top-level data patch and effects to commit with the transition."""

    data: Data = field(default_factory=dict)
    actions: tuple[Action, ...] = ()
    transactional: tuple[TransactionalEffect, ...] = ()


class Check(Protocol):
    def __call__(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | Iterable[Issue] | None: ...


class Reducer(Protocol):
    def __call__(self, snapshot: Snapshot, payload: Data, knowledge: Knowledge) -> Change: ...


class ContextBuilder(Protocol):
    def __call__(self, snapshot: Snapshot, knowledge: Knowledge) -> Brief: ...


class ChildrenBuilder(Protocol):
    def __call__(self, snapshot: Snapshot, knowledge: Knowledge) -> tuple[Child, ...]: ...


class Join(Protocol):
    def __call__(self, snapshot: Snapshot, knowledge: Knowledge) -> str | None: ...


def ready(snapshot: Snapshot, knowledge: Knowledge) -> None:
    return None


def unchanged(snapshot: Snapshot, payload: Data, knowledge: Knowledge) -> Change:
    return Change()


def issues(check: Check, snapshot: Snapshot, knowledge: Knowledge) -> tuple[Issue, ...]:
    result = check(snapshot, knowledge)
    return () if result is None else (result,) if isinstance(result, Issue) else tuple(result)


def all_of(*checks: Check) -> Check:
    def combined(snapshot: Snapshot, knowledge: Knowledge) -> tuple[Issue, ...]:
        return tuple(item for check in checks for item in issues(check, snapshot, knowledge))

    return combined


@dataclass(frozen=True, slots=True)
class Scope:
    """One argument an agent session may only fill with the value research resolved.

    ``field`` is the argument name, dotted for a nested object
    (``attach_to.target_id``). ``source`` is ``"instance"`` (the instance id),
    ``"workflow"`` (the workflow name) or ``"reference:<kind>"`` (the id of the
    brief Reference of that kind). ``tools`` limits the rule to those tools; empty
    means every ``mutating`` tool that carries the field. Support verifies a
    present argument and binds the resolved value into the handler call for
    ``mutating`` tools and for tools whose contract declares the field, so every
    ``mutating`` tool must accept each top-level scoped field as a keyword.
    """

    field: str
    source: str
    tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Execution:
    """What a session leased on this node may do. Research declares; support enforces.

    ``tools`` are the node-specific tools beyond the support baseline the gateway
    adds; ``mutating`` is the subset whose calls must satisfy ``scope``.
    """

    read_only: bool = False
    tools: frozenset[str] = frozenset()
    mutating: frozenset[str] = frozenset()
    scope: tuple[Scope, ...] = ()
    sandbox: bool = False
    workspace: WorkspacePolicy = WorkspacePolicy()

    def public(self) -> dict[str, Any]:
        """The JSON form carried by the assignment packet and stored with the lease."""
        return {
            "read_only": self.read_only,
            "tools": sorted(self.tools),
            "mutating": sorted(self.mutating),
            "scope": [{"field": rule.field, "source": rule.source, "tools": list(rule.tools)} for rule in self.scope],
            "sandbox": self.sandbox,
            "workspace": asdict(self.workspace),
        }

    def problems(self) -> list[str]:
        issues = self.workspace.problems()
        if not self.mutating <= self.tools:
            issues.append("mutating tools must be declared in tools")
        if self.read_only and (self.mutating or self.sandbox):
            issues.append("a read-only node has no mutating tools or sandbox")
        for rule in self.scope:
            if not rule.field or not _valid_source(rule.source):
                issues.append(f"invalid scope {rule.field!r} from {rule.source!r}")
        return issues


def _valid_source(source: str) -> bool:
    return source in {"instance", "workflow"} or (
        source.startswith(REFERENCE_BASE_PREFIX) and len(source) > len(REFERENCE_BASE_PREFIX)
    )


@dataclass(frozen=True, slots=True)
class ReviewReturn:
    to_status: str
    attempt: Literal["new", "same"]
    event_type: str
    choose_when: str
    default: bool = False
    revision: str = ""


class DocumentValidator(Protocol):
    def __call__(self, document: Data, snapshot: Snapshot, knowledge: Knowledge) -> Iterable[str]: ...


@dataclass(frozen=True, slots=True)
class ArtifactNeed:
    """A submitted document a node needs, how to validate it, and what it gates.

    ``actions`` names the edges this need guards; the runtime raises its issue
    on those edges instead of a hand-written edge check. ``dispatch`` also
    blocks the node's agent handoff. A need with neither still appears in the
    gate checklist, whose satisfaction reads the issues the evaluation produced.
    """

    role: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...] = ("artifact.upload",)
    validator: str = ""
    missing: str = ""
    label: str = ""
    artifact_key: str = ""
    actions: tuple[str, ...] = ()
    dispatch: bool = False
    validate: DocumentValidator | None = None
    invalid: str = "{problems}"
    invalid_action: str = ""

    @property
    def key(self) -> str:
        return self.role

    @property
    def codes(self) -> frozenset[str]:
        return frozenset({self.gate, f"{self.role}_invalid"})

    def issue(self) -> Issue:
        return Issue(self.gate, self.error, self.action, self.tools)

    def check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | None:
        record = knowledge.read(Reference(snapshot.workflow, snapshot.id))
        artifact = preferred_artifact(artifacts=list(record.get("current_attempt_artifacts") or ()), roles=(self.role,))
        if artifact is None:
            return self.issue()
        document = knowledge.read(Reference("artifact", str(artifact["id"])))
        error = str(document.get("error") or "")
        problems = (error,) if error else () if self.validate is None else tuple(self.validate(document, snapshot, knowledge))
        if problems:
            return Issue(f"{self.role}_invalid", self.invalid.format(problems="; ".join(problems)),
                         self.invalid_action or self.action, self.tools)
        return None

    dispatch_check = check


@dataclass(frozen=True, slots=True)
class RecordNeed:
    """A declared fact a node needs that its own graph function verifies."""

    name: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...] = ()
    label: str = ""
    missing: str = ""
    actions: tuple[str, ...] = ()
    dispatch: bool = False
    verify: Check | None = None

    @property
    def key(self) -> str:
        return self.name

    @property
    def codes(self) -> frozenset[str]:
        return frozenset({self.gate})

    def issue(self) -> Issue:
        return Issue(self.gate, self.error, self.action, self.tools)

    def check(self, snapshot: Snapshot, knowledge: Knowledge):
        return None if self.verify is None else self.verify(snapshot, knowledge)

    dispatch_check = check


@dataclass(frozen=True, slots=True)
class DependenciesDone:
    """Every node this one waits on in the wave DAG has succeeded."""

    name: str = "dependencies"
    error: str = "Every dependency must succeed before work proceeds."
    gate: str = "dependencies_pending"
    action: str = "wait_for_dependencies"
    tools: tuple[str, ...] = ("workflow.status_and_next",)
    label: str = "Dependencies done"
    missing: str = "unfinished dependencies"
    actions: tuple[str, ...] = ()
    dispatch: bool = True

    @property
    def key(self) -> str:
        return self.name

    @property
    def codes(self) -> frozenset[str]:
        return frozenset({self.gate, "dependency_failed"})

    def check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | None:
        record = knowledge.read(Reference(snapshot.workflow, snapshot.id))
        pending = [item for item in record.get("dependencies") or () if not item.get("settled")]
        if not pending:
            return None
        failed = [item for item in pending if item.get("failed")]
        names = ", ".join(f"{item.get('node_type')} {item.get('name') or item.get('id')} ({item.get('status')})"
                          for item in failed or pending)
        return Issue("dependency_failed" if failed else self.gate,
                     f"A dependency has ended without succeeding: {names}. End this node or replan the wave."
                     if failed else f"Work is waiting on unfinished dependencies: {names}.",
                     "mark_failed" if failed else "wait_for_dependencies", ("workflow.status_and_next",))

    dispatch_check = check


@dataclass(frozen=True, slots=True)
class ReviewGate:
    """An independent passing review of this node's submitted evidence.

    Dispatch needs an open request for the current snapshot; the guarded edges
    need its passing verdict. The return routes describe the legacy review
    input contract that ``review.submit`` still validates.
    """

    role: str
    error: str
    blocker_code: str
    label: str
    skill: str
    pass_action: str
    returns: tuple[ReviewReturn, ...]
    return_choice_required: bool = False
    return_required_error: str = ""
    forbidden_returns: tuple[tuple[str, str], ...] = ()
    fail_route: ReviewReturn | None = None
    actions: tuple[str, ...] = ()
    dispatch: bool = True

    @property
    def key(self) -> str:
        return self.role

    @property
    def action_name(self) -> str:
        return self.role.removesuffix("er")

    def check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | None:
        fact = knowledge.read(Reference("review", self.role))
        if not fact.get("passed"):
            return Issue(f"{self.role}_required", str(fact.get("error") or self.error),
                         "request_review", ("review.request",))
        return None

    def dispatch_check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | None:
        if not knowledge.read(Reference("review_snapshot", snapshot.id)):
            return Issue("review_not_requested", "Create an independent review of the submitted evidence.",
                         "request_review", ("review.request",))
        return None


class Requirement(Protocol):
    """What a node declares its state needs, whatever class supplies it: which
    edges it gates, whether it also blocks the agent handoff, and how to check
    both. Research keeps one resolver per class, so a new kind of need is a class
    and an entry — never a case inside an evaluation."""

    actions: tuple[str, ...]
    dispatch: bool

    @property
    def key(self) -> str: ...
    def check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | Iterable[Issue] | None: ...
    def dispatch_check(self, snapshot: Snapshot, knowledge: Knowledge) -> Issue | Iterable[Issue] | None: ...


@dataclass(frozen=True, slots=True)
class Guidance:
    """Presentation only: no predicates, permissions or transition names to interpret."""

    skill: str = ""
    handoff: str = ""
    messages: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "messages", MappingProxyType(dict(self.messages)))


@dataclass(frozen=True, slots=True)
class Node:
    name: str
    label: str = ""
    role: str = ""
    build_context: ContextBuilder | None = None
    guidance: Guidance = field(default=Guidance(), kw_only=True)
    dispatch_check: Check = ready
    children: ChildrenBuilder | None = None
    join: Join | None = None
    execution: Execution = Execution()
    on_start: Reducer = unchanged
    requires: tuple[Requirement, ...] = ()


@dataclass(frozen=True, slots=True)
class Edge:
    source: str
    name: str
    target: str
    check: Check = ready
    change: Reducer = unchanged
    label: str = ""
    tools: tuple[str, ...] = ()
    suggest: bool = True
    event_type: str = ""
    # Applied by a review verdict or the runner, never by the agent's transition tool.
    auto: bool = False


@dataclass(frozen=True, slots=True)
class EvaluatedEdge:
    edge: Edge
    issues: tuple[Issue, ...]

    @property
    def available(self) -> bool:
        return not self.issues


@dataclass(frozen=True, slots=True)
class Evaluation:
    snapshot: Snapshot
    node: Node | None
    actions: tuple[EvaluatedEdge, ...]
    dispatch_issues: tuple[Issue, ...] = ()

    @property
    def available(self) -> tuple[EvaluatedEdge, ...]:
        return tuple(action for action in self.actions if action.available)

    @property
    def blocked(self) -> tuple[EvaluatedEdge, ...]:
        return tuple(action for action in self.actions if not action.available)

    @property
    def suggested(self) -> EvaluatedEdge | None:
        candidates = tuple(action for action in self.actions if action.edge.suggest)
        return next((action for action in candidates if action.available), next(iter(candidates), None))

    @property
    def dispatchable(self) -> bool:
        return bool(self.node and self.node.role and not self.dispatch_issues)

    def require(self, name: str) -> Edge:
        action = next((action for action in self.actions if action.edge.name == name), None)
        if action is None:
            ending = "terminal state " if self.snapshot.outcome else ""
            allowed = ", ".join(action.edge.name for action in self.actions if not action.edge.auto) or "none"
            raise WorkflowError(f"action {name!r} is not allowed from {ending}{self.snapshot.state!r}; allowed: {allowed}")
        if action.issues:
            raise WorkflowError("; ".join(issue.message for issue in action.issues),
                                details={"issues": [issue_view(issue) for issue in action.issues]})
        return action.edge

    def public(self) -> dict[str, Any]:
        def view(action: EvaluatedEdge) -> dict[str, Any]:
            return {
                "action": action.edge.name,
                "leads_to": action.edge.target,
                "label": action.edge.label,
                "tools": list(action.edge.tools),
                "blockers": [issue_view(issue) for issue in action.issues],
            }

        suggested = self.suggested
        return {
            "instance_id": self.snapshot.id,
            "workflow": self.snapshot.workflow,
            "version": self.snapshot.version,
            "state": self.snapshot.state,
            "revision": self.snapshot.revision,
            "outcome": self.snapshot.outcome or None,
            "children": [{"key": child.key, "instance_id": child.id, "workflow": child.workflow,
                          "outcome": child.outcome or None} for child in self.snapshot.children],
            "available_actions": [view(action) for action in self.available],
            "blocked_actions": [view(action) for action in self.blocked],
            "suggested_action": None if suggested is None else view(suggested),
            "dispatchable": self.dispatchable,
            "dispatch_blockers": [issue_view(issue) for issue in self.dispatch_issues],
        }


def issue_view(issue: Issue) -> dict[str, Any]:
    return {"code": issue.code, "reason": issue.message, "action": issue.action, "tools": list(issue.tools)}


_AGENT_HIDDEN = ("version", "dispatchable", "missing_evidence", "execution", "messages")


def agent_workflow(view: dict[str, Any]) -> dict[str, Any]:
    """What an agent reads of a workflow view: each gate said once, nothing this state leaves empty."""
    suggested = view.get("suggested_action")
    hidden = {*_AGENT_HIDDEN, "blocked_actions" if suggested and suggested["blockers"] else "suggested_action"}
    view = {**view, "available_actions": [{key: value for key, value in action.items() if key != "blockers"}
                                          for action in view.get("available_actions", ())]}
    return {key: value for key, value in view.items()
            if key not in hidden and (value or key in ("revision", "state", "current_gate", "next_action"))}


@dataclass(frozen=True, slots=True)
class Workflow:
    name: str
    version: int
    initial: str
    nodes: tuple[Node, ...]
    edges: tuple[Edge, ...]
    outcomes: Mapping[str, str]
    entries: Mapping[str, str] = field(default_factory=dict)
    event_type: str = "workflow.transitioned"
    id_prefix: str = "wf"
    outcome_guidance: Mapping[str, Guidance] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "nodes", tuple(self.nodes))
        object.__setattr__(self, "edges", tuple(self.edges))
        object.__setattr__(self, "outcomes", MappingProxyType(dict(self.outcomes)))
        object.__setattr__(self, "entries", MappingProxyType(dict(self.entries)))
        object.__setattr__(self, "outcome_guidance", MappingProxyType(dict(self.outcome_guidance)))
        if set(self.outcome_guidance) - set(self.outcomes.values()):
            raise ValueError("guidance names an undeclared outcome")
        names = [node.name for node in self.nodes]
        if not self.name or self.version < 1 or len(names) != len(set(names)):
            raise ValueError("workflow needs a name, positive version and unique nodes")
        known = set(names) | set(self.outcomes)
        if set(names) & set(self.outcomes) or any(not outcome for outcome in self.outcomes.values()):
            raise ValueError("terminal states expose named outcomes and have no work node")
        if self.initial not in known or any(state not in known for state in self.entries.values()):
            raise ValueError("workflow entry names an unknown state")
        keys = [(edge.source, edge.name) for edge in self.edges]
        if len(keys) != len(set(keys)):
            raise ValueError("actions must be unique within a state")
        for edge in self.edges:
            if edge.source not in names or edge.target not in known or not edge.name:
                raise ValueError(f"invalid edge {edge.source}/{edge.name}/{edge.target}")
        for node in self.nodes:
            outgoing = {edge.name for edge in self.edges if edge.source == node.name}
            for need in node.requires:
                unknown = set(need.actions) - outgoing
                if unknown:
                    raise ValueError(f"requirement {need.key!r} on {node.name!r} names non-outgoing actions: {sorted(unknown)}")
            problems = node.execution.problems()
            if not node.role and node.execution != Execution():
                problems.append("only an agent node declares an execution policy")
            if problems:
                raise ValueError(f"invalid execution policy for {node.name!r}: " + "; ".join(problems))
            if bool(node.role) != bool(node.build_context):
                raise ValueError(f"agent node {node.name!r} needs both a role and context builder")
            if bool(node.children) != bool(node.join) or (node.children and node.role):
                raise ValueError(f"wait node {node.name!r} needs children and join, without an agent")

    def entry(self, name: str = "") -> str:
        if not name:
            return self.initial
        try:
            return self.entries[name]
        except KeyError:
            raise WorkflowError(f"unknown entry {name!r} for workflow {self.name!r}") from None

    def node(self, state: str) -> Node | None:
        return next((node for node in self.nodes if node.name == state), None)

    def evaluate(self, snapshot: Snapshot, knowledge: Knowledge, *, dispatch_only: bool = False) -> Evaluation:
        if (snapshot.workflow, snapshot.version) != (self.name, self.version):
            raise WorkflowError("snapshot is pinned to a different workflow definition")
        node = self.node(snapshot.state)
        if node is None and snapshot.state not in self.outcomes:
            raise WorkflowError(f"unknown state {snapshot.state!r} for {self.name} v{self.version}")
        requires = () if node is None else node.requires
        memo: dict[tuple[int, bool], tuple[Issue, ...]] = {}

        def declared(need: Requirement, dispatch: bool) -> tuple[Issue, ...]:
            key = (id(need), dispatch)
            if key not in memo:
                memo[key] = issues(need.dispatch_check if dispatch else need.check, snapshot, knowledge)
            return memo[key]

        return Evaluation(
            snapshot,
            node,
            () if dispatch_only else tuple(EvaluatedEdge(edge, (*issues(edge.check, snapshot, knowledge),
                                       *(issue for need in requires if edge.name in need.actions
                                         for issue in declared(need, False))))
                  for edge in self.edges if edge.source == snapshot.state),
            () if node is None else (*issues(node.dispatch_check, snapshot, knowledge),
                                     *(issue for need in requires if need.dispatch
                                       for issue in declared(need, True))),
        )


@dataclass(frozen=True, slots=True)
class Metadata:
    """What a graph says for the legacy research API beyond its own edges: the
    effect labels of each action and how its subject is named."""

    effects: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    subject: str = ""
    success_outcome: str = "completed"


@dataclass(frozen=True, slots=True)
class Public:
    """The fields an audience must never see, and public names for the rest."""

    hidden: tuple[str, ...] = ()
    renames: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "renames", MappingProxyType(dict(self.renames)))


S = TypeVar("S", covariant=True)


class StateConstructor(Protocol[S]):
    def __call__(self, row: Data, snapshot: Snapshot) -> S: ...


class CreationRequirement(Protocol):
    def check(self, facts: Data) -> Issue | None: ...


@dataclass(frozen=True, slots=True)
class RecordKind(Generic[S]):
    """One native record bound to a workflow: what differs between kinds is data.

    ``columns`` are the kind's own INSERT columns beyond the shared spine
    (id, project_id, status, attempt_index, revision_context, timestamps);
    ``json_columns`` map a stored column to the field a read exposes and the
    empty JSON a row without one decodes to.
    ``commit_columns`` say which of the transition's ``after.data`` fields each
    action writes back, and ``status_projection`` maps a workflow state onto the
    row status when the record has no column for it. ``reads_record`` is False
    for a kind whose graph decides nothing from its row or its project — every
    transition is its own payload — so the engine hands it no record knowledge.
    """

    name: str
    table: str
    id_prefix: str
    workflow: Workflow
    construct: StateConstructor[S]
    metadata: Metadata = Metadata()
    created_event: str = ""
    label: str = "name"
    unique_name: bool = True
    reads_record: bool = True
    columns: tuple[str, ...] = ()
    json_columns: Mapping[str, tuple[str, str]] = field(default_factory=dict)
    dependencies: bool = False
    created_seq: bool = False
    seal_exempt_actions: frozenset[str] = frozenset()
    commit_columns: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    status_projection: Mapping[str, str] = field(default_factory=dict)
    public: Public = Public()
    creation_requires: tuple[CreationRequirement, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "json_columns", MappingProxyType(dict(self.json_columns)))
        object.__setattr__(self, "commit_columns", MappingProxyType(dict(self.commit_columns)))
        object.__setattr__(self, "status_projection", MappingProxyType(dict(self.status_projection)))

    def status_of(self, state: str) -> str:
        return self.status_projection.get(state, state)

    @property
    def terminal_statuses(self) -> frozenset[str]:
        return frozenset(self.status_of(state) for state in self.workflow.outcomes)

    def requirements(self, state: str) -> tuple[Requirement, ...]:
        node = self.workflow.node(state)
        return () if node is None else node.requires

    # ---- what the kind's own graph says, read off its nodes and edges ----

    @property
    def success_status(self) -> str:
        """The single state whose outcome this kind's metadata calls success."""
        return next(state for state, outcome in self.workflow.outcomes.items()
                    if outcome == self.metadata.success_outcome)

    @property
    def actions(self) -> tuple[str, ...]:
        """The transitions an agent may call; auto edges are the graph's own."""
        return tuple(dict.fromkeys(edge.name for edge in self.workflow.edges if not edge.auto))

    def action_with_effect(self, effect: str) -> str:
        return next(edge.name for edge in self.workflow.edges
                    if effect in self.metadata.effects.get(edge.name, ()))

    def effect_sources(self, effect: str) -> frozenset[str]:
        return frozenset(edge.source for edge in self.workflow.edges
                         if effect in self.metadata.effects.get(edge.name, ()))

    def effect_destinations(self, effect: str) -> frozenset[str]:
        return frozenset(edge.target for edge in self.workflow.edges
                         if effect in self.metadata.effects.get(edge.name, ()))

    @property
    def review_gates(self) -> tuple[ReviewGate, ...]:
        return tuple(need for node in self.workflow.nodes for need in node.requires
                     if isinstance(need, ReviewGate))

    def review_gate(self, role: str) -> ReviewGate | None:
        return next((gate for gate in self.review_gates if gate.role == role), None)

    def review_state(self, role: str) -> str:
        """The state a role reviews in, or empty when the kind has no such role."""
        return next((node.name for node in self.workflow.nodes if node.role == role), "")

    @property
    def review_returns(self) -> tuple[ReviewReturn, ...]:
        return tuple(dict.fromkeys(route for gate in self.review_gates
                                   for route in gate.returns))


class Orientation(Protocol):
    """Project advice over program-owned facts and already evaluated record projections."""

    def __call__(self, snapshot: object, *, selected: object, workflow: Data,
                 reflection: Data | None, reflection_workflow: Data | None) -> Data: ...


@dataclass(frozen=True, slots=True)
class Program:
    """One research program: every part a brain must install to run it.

    ``effects`` names delivery handlers; ``transactional_effects`` names synchronous
    writes on the workflow transaction. ``requirements`` declares the need
    classes its nodes use; bootstrap refuses to start unless each has a handler
    and a resolver, so a second program is an entry in ``programs`` and nothing else.
    """

    name: str
    version: int
    workflows: tuple[Workflow, ...] = ()
    kinds: tuple[RecordKind, ...] = ()
    effects: tuple[str, ...] = ()
    transactional_effects: tuple[str, ...] = ()
    requirements: tuple[type, ...] = ()
    tools: Mapping[str, ToolContract] = field(default_factory=dict)
    orientation: Orientation | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tools", MappingProxyType(dict(self.tools)))
        installed = {workflow.name for workflow in self.workflows}
        undeclared = sorted({type(need).__name__ for workflow in self.workflows for node in workflow.nodes
                             for need in node.requires} - {cls.__name__ for cls in self.requirements})
        if not self.name or self.version < 1:
            raise ValueError("a program needs a name and a positive version")
        if any(kind.workflow.name not in installed for kind in self.kinds):
            raise ValueError(f"program {self.name!r} binds a record to an uninstalled workflow")
        if undeclared:
            raise ValueError(f"program {self.name!r} uses undeclared requirements: {undeclared}")


class Registry:
    """Explicit plugins; previous definitions remain available to pinned instances."""

    def __init__(self, workflows: Iterable[Workflow] = ()) -> None:
        self._versions: dict[tuple[str, int], Workflow] = {}
        for workflow in workflows:
            self.register(workflow)

    def register(self, workflow: Workflow) -> None:
        key = (workflow.name, workflow.version)
        if key in self._versions:
            raise ValueError(f"definition {key} already registered; publish a new version")
        self._versions[key] = workflow

    def get(self, name: str, version: int | None = None) -> Workflow:
        if version is None:
            version = max((version for candidate, version in self._versions if candidate == name), default=0)
        try:
            return self._versions[(name, version)]
        except KeyError:
            raise WorkflowError(f"workflow {name!r} version {version} is not registered") from None

    def catalog(self) -> list[dict[str, Any]]:
        return [{"name": name, "version": version} for name, version in sorted(self._versions)]
