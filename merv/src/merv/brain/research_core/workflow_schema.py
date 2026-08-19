# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The small vocabulary shared by Research workflow declarations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class ArtifactNeed:
    """One artifact gate and the agent action that satisfies it."""

    role: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...]
    validator: str = ""
    missing: str = ""
    label: str = ""
    artifact_key: str = ""


@dataclass(frozen=True, slots=True)
class RecordNeed:
    """One durable non-artifact fact required to leave a state."""

    name: str
    error: str
    gate: str
    action: str
    tools: tuple[str, ...]
    label: str = ""
    missing: str = ""


@dataclass(frozen=True, slots=True)
class ReviewReturn:
    """A legal destination after a rejected review."""

    to_status: str
    attempt: Literal["new", "same"]
    event_type: str
    choose_when: str
    default: bool = False
    revision: str = ""


@dataclass(frozen=True, slots=True)
class ReviewGate:
    """The review required to leave a state."""

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
    # A verdict of ``fail`` may end the target instead of sending it back: the
    # route's destination is a terminal status, so it is deliberately kept
    # out of ``returns`` (which are working states a rejection reopens).
    fail_route: ReviewReturn | None = None

    @property
    def action_name(self) -> str:
        return self.role.removesuffix("er")


@dataclass(frozen=True, slots=True)
class Transition:
    """One named edge in a workflow."""

    name: str
    to_status: str
    action: str
    tools: tuple[str, ...]
    requires_prose: str = ""
    gate: str = ""
    effects: tuple[str, ...] = ()

    def public(self) -> dict[str, str]:
        result = {"transition": self.name, "leads_to": self.to_status}
        if self.requires_prose:
            result["requires"] = self.requires_prose
        return result


@dataclass(frozen=True, slots=True)
class State:
    """Requirements and exits for one persisted status."""

    name: str
    forward: Transition
    requirements: tuple[ArtifactNeed | RecordNeed, ...] = ()
    review: ReviewGate | None = None
    extras: tuple[Transition, ...] = ()

    @property
    def transitions(self) -> tuple[Transition, ...]:
        return (self.forward, *self.extras)


@dataclass(frozen=True, slots=True)
class Workflow:
    """A complete, declaration-only lifecycle."""

    target_type: str
    subject: str
    initial: str
    success_status: str
    states: tuple[State, ...]
    global_exits: tuple[Transition, ...]
    review_return_error: str
    event_type: str

    @property
    def terminal_statuses(self) -> frozenset[str]:
        return frozenset(
            (self.success_status, *(exit.to_status for exit in self.global_exits))
        )

    @property
    def review_returns(self) -> tuple[ReviewReturn, ...]:
        routes: list[ReviewReturn] = []
        for state in self.states:
            for route in () if state.review is None else state.review.returns:
                if route not in routes:
                    routes.append(route)
        return tuple(routes)

    def state(self, status: str) -> State | None:
        return next((state for state in self.states if state.name == status), None)

    @property
    def transitions(self) -> tuple[Transition, ...]:
        return (
            tuple(
                transition for state in self.states for transition in state.transitions
            )
            + self.global_exits
        )

    @property
    def transition_names(self) -> tuple[str, ...]:
        return tuple(transition.name for transition in self.transitions)

    def allowed_transitions_for(self, status: str) -> list[dict[str, str]]:
        if status in self.terminal_statuses:
            return []
        state = self.state(status)
        if state is None:
            return []
        return [
            transition.public()
            for transition in (*state.transitions, *self.global_exits)
        ]

    def transition(self, name: str) -> Transition | None:
        return next(
            (transition for transition in self.transitions if transition.name == name),
            None,
        )

    def requirement(self, role: str) -> ArtifactNeed | None:
        return next(
            (
                requirement
                for state in self.states
                for requirement in state.requirements
                if isinstance(requirement, ArtifactNeed) and requirement.role == role
            ),
            None,
        )

    def review(self, role: str) -> ReviewGate | None:
        state = self.review_state(role)
        return None if state is None else state.review

    def review_state(self, role: str) -> State | None:
        return next(
            (
                state
                for state in self.states
                if state.review is not None and state.review.role == role
            ),
            None,
        )

    def effect_sources(self, effect: str) -> frozenset[str]:
        return frozenset(
            state.name
            for state in self.states
            if any(effect in transition.effects for transition in state.transitions)
        )

    def effect_destinations(self, effect: str) -> frozenset[str]:
        return frozenset(
            transition.to_status
            for transition in self.transitions
            if effect in transition.effects
        )

    def forward_path(self, start: str) -> tuple[str, ...]:
        """Follow the one normal edge from a status through successful completion."""
        path: list[str] = []
        status = start
        while status not in path:
            path.append(status)
            if status in self.terminal_statuses:
                break
            state = self.state(status)
            if state is None:
                break
            status = state.forward.to_status
        return tuple(path)

    def return_route(self, to_status: str) -> ReviewReturn | None:
        """Look up a declared review route, using its default for legacy blanks."""
        if not to_status:
            return next(
                (route for route in self.review_returns if route.default),
                None,
            )
        return next(
            (route for route in self.review_returns if route.to_status == to_status),
            None,
        )

    def review_sources(self, route: ReviewReturn) -> frozenset[str]:
        """Statuses whose review gate permits this return route."""
        return frozenset(
            state.name
            for state in self.states
            if state.review is not None and route in state.review.returns
        )

    @property
    def review_return_statuses(self) -> tuple[str, ...]:
        return tuple(route.to_status for route in self.review_returns)

    @property
    def fail_routes(self) -> tuple[ReviewReturn, ...]:
        return tuple(
            state.review.fail_route
            for state in self.states
            if state.review is not None and state.review.fail_route is not None
        )

    @property
    def review_fail_statuses(self) -> tuple[str, ...]:
        return tuple(route.to_status for route in self.fail_routes)


PASS_RETURN_TO_ERROR = (
    "return_to only applies when the verdict is needs_changes or fail"
)


def resolve_review_return(
    *,
    workflow: Workflow,
    role: str,
    verdict: str,
    return_to: str,
) -> ReviewReturn | None:
    """Resolve a verdict using only the target workflow's declared routes."""

    value = (return_to or "").strip()
    if verdict == "pass":
        if value:
            raise ValueError(PASS_RETURN_TO_ERROR)
        return None

    review = workflow.review(role)
    if verdict == "fail" and review is not None and review.fail_route is not None:
        # This gate ends the target on ``fail``; a caller may name the
        # terminal destination or omit it, but cannot reopen a working state.
        if value and value != review.fail_route.to_status:
            raise ValueError(
                f"a fail verdict from {role} ends the {workflow.subject}: "
                f"return_to must be omitted or {review.fail_route.to_status!r}"
                "; use needs_changes to send it back"
            )
        return review.fail_route
    routes = (
        review.returns
        if review is not None and review.returns
        else workflow.review_returns
    )
    forbidden = () if review is None else review.forbidden_returns
    for destination, message in forbidden:
        if value == destination:
            raise ValueError(message)
    if value and value not in {route.to_status for route in routes}:
        raise ValueError(workflow.review_return_error)
    if review is not None and review.return_choice_required and not value:
        raise ValueError(review.return_required_error)
    if not value:
        route = next((route for route in routes if route.default), None)
        if route is None:
            raise ValueError(workflow.review_return_error)
        return route
    return next(route for route in routes if route.to_status == value)


def validate_workflow(workflow: Workflow) -> None:
    """Fail at import time when a workflow declaration contradicts itself."""

    state_names = [state.name for state in workflow.states]
    states = set(state_names)
    if len(state_names) != len(states):
        raise ValueError(f"{workflow.target_type} workflow has duplicate states")
    if states & workflow.terminal_statuses:
        raise ValueError("terminal states do not need State declarations")
    if workflow.initial not in states:
        raise ValueError(f"unknown initial state: {workflow.initial}")
    if workflow.success_status not in workflow.terminal_statuses:
        raise ValueError(f"unknown success status: {workflow.success_status}")

    transitions = workflow.transitions
    if len(workflow.transition_names) != len(set(workflow.transition_names)):
        raise ValueError(f"{workflow.target_type} workflow has duplicate transitions")
    known = states | workflow.terminal_statuses
    for transition in transitions:
        if transition.to_status not in known:
            raise ValueError(
                f"{transition.name} leads to unknown state {transition.to_status!r}"
            )
    for state in workflow.states:
        if workflow.forward_path(state.name)[-1] not in workflow.terminal_statuses:
            raise ValueError(f"{workflow.target_type} workflow has a forward cycle")

    destinations = [route.to_status for route in workflow.review_returns]
    if len(destinations) != len(set(destinations)):
        raise ValueError(f"{workflow.target_type} has duplicate review returns")
    if sum(route.default for route in workflow.review_returns) != 1:
        raise ValueError(f"{workflow.target_type} needs one default review return")
    for route in workflow.review_returns:
        if route.to_status not in states:
            raise ValueError(f"review returns to unknown state {route.to_status!r}")
        if not (route.event_type and route.choose_when):
            raise ValueError(f"{route.to_status!r} has an incomplete review return")

    declared_routes = set(workflow.review_returns)
    reviews = [state.review for state in workflow.states if state.review is not None]
    for review in reviews:
        if not set(review.returns) <= declared_routes:
            raise ValueError(f"{review.role!r} uses an undeclared review return")
        if review.return_choice_required and not review.return_required_error:
            raise ValueError(f"{review.role!r} needs a return-choice error")
        if review.fail_route is not None:
            route = review.fail_route
            if route.to_status not in workflow.terminal_statuses:
                raise ValueError(
                    f"{review.role!r} fail route must end on a terminal status"
                )
            if not (route.event_type and route.choose_when):
                raise ValueError(f"{review.role!r} has an incomplete fail route")
    review_roles = [review.role for review in reviews]
    if len(review_roles) != len(set(review_roles)):
        raise ValueError(f"{workflow.target_type} has duplicate review roles")
    unused_routes = [
        route.to_status
        for route in workflow.review_returns
        if not workflow.review_sources(route)
    ]
    if unused_routes:
        raise ValueError(
            f"{workflow.target_type} has unused review returns: {unused_routes}"
        )


__all__ = [
    "ArtifactNeed",
    "RecordNeed",
    "ReviewGate",
    "ReviewReturn",
    "State",
    "Transition",
    "Workflow",
    "resolve_review_return",
    "validate_workflow",
]
