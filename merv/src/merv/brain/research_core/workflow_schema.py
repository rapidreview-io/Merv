# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Compatibility views of canonical graphs for the existing research API.

No state machine is declared here. New clients use the runtime evaluation;
these views retain the old labels, review-input contract and figure metadata.
"""

from dataclasses import dataclass

from ..workflows import Workflow as Graph, metadata

ArtifactNeed = metadata.ArtifactNeed
RecordNeed = metadata.RecordNeed
ReviewGate = metadata.ReviewGate
ReviewReturn = metadata.ReviewReturn


@dataclass(frozen=True, slots=True)
class Transition:
    source: str
    name: str
    to_status: str
    action: str
    tools: tuple[str, ...]
    effects: tuple[str, ...] = ()

    def public(self) -> dict[str, str]:
        return {"transition": self.name, "leads_to": self.to_status}


@dataclass(frozen=True, slots=True)
class State:
    name: str
    transitions: tuple[Transition, ...]
    requirements: tuple[ArtifactNeed | RecordNeed, ...] = ()
    review: ReviewGate | None = None


@dataclass(frozen=True, slots=True)
class Workflow:
    graph: Graph
    metadata: metadata.Metadata

    @property
    def target_type(self) -> str:
        return self.graph.name

    @property
    def subject(self) -> str:
        return self.metadata.subject or self.graph.name

    @property
    def initial(self) -> str:
        return self.graph.initial

    @property
    def event_type(self) -> str:
        return self.graph.event_type

    @property
    def success_status(self) -> str:
        return next(state for state, outcome in self.graph.outcomes.items() if outcome == self.metadata.success_outcome)

    @property
    def terminal_statuses(self) -> frozenset[str]:
        return frozenset(self.graph.outcomes)

    @property
    def transitions(self) -> tuple[Transition, ...]:
        return tuple(Transition(edge.source, edge.name, edge.target, edge.label or edge.name,
                                edge.tools, self.metadata.effects.get(edge.name, ())) for edge in self.graph.edges)

    @property
    def transition_names(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(edge.name for edge in self.graph.edges))

    @property
    def states(self) -> tuple[State, ...]:
        return tuple(self.state(node.name) for node in self.graph.nodes)

    def state(self, status: str) -> State | None:
        node = self.graph.node(status)
        if node is not None:
            review = None
            if node.read_only:
                review = self.review(node.role) or ReviewGate(
                    node.role, f"An independent {node.role} review is required.",
                    f"{node.role}_required", node.label or node.name, "", "", ())
            return State(status, tuple(edge for edge in self.transitions if edge.source == status),
                         self.metadata.requirements.get(status, ()), review)
        return None

    def allowed_transitions_for(self, status: str) -> list[dict[str, str]]:
        return [edge.public() for edge in self.transitions if edge.source == status]

    def transition(self, name: str) -> Transition | None:
        return next((edge for edge in self.transitions if edge.name == name), None)

    def requirement(self, role: str) -> ArtifactNeed | None:
        return next((need for needs in self.metadata.requirements.values() for need in needs
                     if isinstance(need, ArtifactNeed) and need.role == role), None)

    def review(self, role: str) -> ReviewGate | None:
        return next((review for review in self.metadata.reviews.values() if review.role == role), None)

    def review_state(self, role: str) -> State | None:
        return next((state for state in self.states if state.review is not None and state.review.role == role), None)

    def effect_sources(self, effect: str) -> frozenset[str]:
        return frozenset(edge.source for edge in self.transitions if effect in edge.effects)

    def effect_destinations(self, effect: str) -> frozenset[str]:
        return frozenset(edge.to_status for edge in self.transitions if effect in edge.effects)

    @property
    def review_returns(self) -> tuple[ReviewReturn, ...]:
        return tuple(dict.fromkeys(route for review in self.metadata.reviews.values() for route in review.returns))

    @property
    def review_return_statuses(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(route.to_status for route in self.review_returns))

    @property
    def fail_routes(self) -> tuple[ReviewReturn, ...]:
        return tuple(dict.fromkeys(review.fail_route for review in self.metadata.reviews.values() if review.fail_route))

    @property
    def review_fail_statuses(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(route.to_status for route in self.fail_routes))


def resolve_review_return(*, workflow: Workflow, role: str, verdict: str, return_to: str) -> ReviewReturn | None:
    """Validate the legacy review input; the graph evaluates its eventual edge."""
    value = (return_to or "").strip()
    if verdict == "pass":
        if value:
            raise ValueError("return_to only applies when the verdict is needs_changes or fail")
        return None
    review = workflow.review(role)
    if verdict == "fail" and review is not None and review.fail_route is not None:
        if value and value != review.fail_route.to_status:
            raise ValueError(f"a fail verdict from {role} ends the {workflow.subject}: return_to must be omitted or "
                             f"{review.fail_route.to_status!r}; use needs_changes to send it back")
        return review.fail_route
    routes = review.returns if review is not None and review.returns else workflow.review_returns
    for destination, message in () if review is None else review.forbidden_returns:
        if value == destination:
            raise ValueError(message)
    if review is not None and review.return_choice_required and not value:
        raise ValueError(review.return_required_error)
    route = next((route for route in routes if route.to_status == value or (not value and route.default)), None)
    if route is None:
        raise ValueError("return_to must be " + " or ".join(repr(route.to_status) for route in routes))
    return route


def validate_workflow(workflow: Workflow) -> None:
    """Check that compatibility descriptions name real graph nodes and edges."""
    names = {node.name for node in workflow.graph.nodes}
    if not set(workflow.metadata.requirements) <= names or not set(workflow.metadata.reviews) <= names:
        raise ValueError("workflow metadata names an unknown node")
    if not set(workflow.metadata.effects) <= set(workflow.transition_names):
        raise ValueError("workflow metadata names an unknown action")
    for state, review in workflow.metadata.reviews.items():
        destinations = {edge.target for edge in workflow.graph.edges if edge.source == state}
        for route in (*review.returns, *((review.fail_route,) if review.fail_route else ())):
            if route.to_status not in destinations:
                raise ValueError(f"{review.role} describes a return without a graph edge")


__all__ = ["ArtifactNeed", "RecordNeed", "ReviewGate", "ReviewReturn", "State", "Transition", "Workflow",
           "resolve_review_return", "validate_workflow"]
