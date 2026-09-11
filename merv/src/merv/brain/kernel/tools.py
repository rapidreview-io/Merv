"""Tool contract primitives every component declares its own tools with.

The registry that merges the owners' tables is support; the contract type
lives here so a component can declare tools without importing delivery.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ContractModel(BaseModel):
    """Strict boundary model for external tool inputs."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


ToolVisibility = Literal["public", "internal"]
ToolScopeStrategy = Literal["linked-project", "caller-selected", "capability", "none"]
ToolFeature = Literal["storage"]


@dataclass(frozen=True)
class ToolContract:
    """One tool's complete public contract and routing metadata."""

    input_model: type[ContractModel]
    description: str
    handler_identity: str
    visibility: ToolVisibility = "public"
    scope_strategy: ToolScopeStrategy | None = None
    feature_requirements: tuple[ToolFeature, ...] = ()
    # producer_session_id is the verified caller's leased session; "agent"
    # also accepts its context-window id when it holds no session — never the
    # model's word.
    binds_producer_session: Literal["", "session", "agent"] = ""
    # Hosted mode resolves the telemetry project from this argument's id.
    telemetry_scope_field: str = ""
    # A reviewer handoff: the caller's session id and the id its lease scoped
    # this argument to arrive as caller_session_id and assigned_*.
    binds_capability: str = ""
    # Pass the authenticated native lease identity without accepting a model override.
    binds_caller_session: bool = False
    # The reply renders absolute URLs against the caller-reachable base.
    needs_base_url: bool = False
    # The caller's verified user id, and their key's bound project under this
    # argument name, replace whatever the model sent.
    binds_caller_project: str = ""
    # An action a machine key (mk_) may not take on this tool.
    external_key_denied_action: str = ""

    def __post_init__(self) -> None:
        if self.scope_strategy is None:
            inferred: ToolScopeStrategy = (
                "linked-project"
                if issubclass(self.input_model, ProjectScopedInput)
                else "none"
            )
            object.__setattr__(self, "scope_strategy", inferred)


class ProjectScopedInput(ContractModel):
    project_id: str = Field(
        description=(
            "Explicit project scope. Discover the id with "
            'project(action="list"), which returns the projects you can work '
            "in with names and dates. A credential bound to a single "
            "project may only pass that one; otherwise pass whichever project "
            "the user is asking about."
        )
    )
