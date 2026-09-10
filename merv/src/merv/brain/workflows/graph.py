"""Workflow values and one evaluation shared by commands, guidance and dispatch."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass, field
from types import MappingProxyType
from typing import Any, Protocol, TYPE_CHECKING

from merv.shared.workspace_policy import REFERENCE_BASE_PREFIX, WorkspacePolicy

from ..kernel.utils import WorkflowError

if TYPE_CHECKING:
    from .composition import Child, ChildResult

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
class Change:
    """A top-level data patch and effects to commit with the transition."""

    data: Data = field(default_factory=dict)
    actions: tuple[Action, ...] = ()


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
class Node:
    name: str
    label: str = ""
    role: str = ""
    build_context: ContextBuilder | None = None
    dispatch_check: Check = ready
    children: ChildrenBuilder | None = None
    join: Join | None = None
    execution: Execution = Execution()
    on_start: Reducer = unchanged


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
            raise WorkflowError(f"action {name!r} is not allowed from {ending}{self.snapshot.state!r}")
        if action.issues:
            raise WorkflowError("; ".join(issue.message for issue in action.issues))
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

    def __post_init__(self) -> None:
        object.__setattr__(self, "nodes", tuple(self.nodes))
        object.__setattr__(self, "edges", tuple(self.edges))
        object.__setattr__(self, "outcomes", MappingProxyType(dict(self.outcomes)))
        object.__setattr__(self, "entries", MappingProxyType(dict(self.entries)))
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

    def evaluate(self, snapshot: Snapshot, knowledge: Knowledge) -> Evaluation:
        if (snapshot.workflow, snapshot.version) != (self.name, self.version):
            raise WorkflowError("snapshot is pinned to a different workflow definition")
        node = self.node(snapshot.state)
        if node is None and snapshot.state not in self.outcomes:
            raise WorkflowError(f"unknown state {snapshot.state!r} for {self.name} v{self.version}")
        return Evaluation(
            snapshot,
            node,
            tuple(EvaluatedEdge(edge, issues(edge.check, snapshot, knowledge)) for edge in self.edges if edge.source == snapshot.state),
            () if node is None else issues(node.dispatch_check, snapshot, knowledge),
        )


class Registry:
    """Explicit plugins; previous definitions remain available to pinned instances."""

    def __init__(self, workflows: Iterable[Workflow] = ()) -> None:
        self._versions: dict[tuple[str, int], Workflow] = {}
        for workflow in workflows:
            self.register(workflow)

    def register(self, workflow: Workflow) -> None:
        key = (workflow.name, workflow.version)
        if key in self._versions and self._versions[key] is not workflow:
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
