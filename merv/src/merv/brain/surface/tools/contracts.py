"""The tool registry: every owner's contracts merged into one manifest.

Support routes tool calls; it does not describe them. Each component
declares its own ``TOOLS`` table; this module keeps the two the surface
itself owns — the agent identity handshake and the project record tool —
and merges them all under unique names for the dispatcher, the gateway,
and the MCP transport.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from pydantic import Field, model_validator

from ...artifacts import artifact_tools
from ...feed import feed_tools
from ...infrastructure import TOOLS as INFRASTRUCTURE_TOOLS
from ...kernel.tools import ContractModel, ProjectScopedInput, ToolContract
from ...programs import INSTALLED
from ...research_core import (
    ENTITY_REF_VOCABULARY, FEED_ADOPTABLE_ROLES, FEED_AUTHOR_ROLES,
    PROJECT_OVERVIEW_CONTENTS, review_request_tool,
)
from ...workflows import ARTIFACT_TOOL_VOCABULARY, Program


class AgentHelloInput(ContractModel):
    """Mint (or confirm) the agent_id this context window carries on every call."""

    agent_id: str | None = Field(default=None, max_length=64, description="An agent_id this context already holds, to confirm instead of minting another.")
    role: str = Field(default="", max_length=64, description="What this context is doing: main, subagent, worker, or the role your assignment names.")
    parent_agent_id: str = Field(default="", max_length=64, description="The agent_id of the context that spawned this one, if told.")
    note: str = Field(default="", max_length=200, description="One line on what this context is doing.")


class ProjectInput(ContractModel):
    """Project discovery, living document, explicit records and creation."""

    action: Literal["list", "current", "create", "overview", "records"] = Field(
        description=(
            "list = every project you can work in (start here for a project_id); current = the credential's bound "
            f"project; overview = the living project document ({PROJECT_OVERVIEW_CONTENTS}); records = the full "
            "record inventory; create = a new project."
        )
    )
    project_id: str = Field(default="", description="For action=overview or records.")
    name: str = Field(default="", description="Required for action=create: user-confirmed, at least 3 characters, never a placeholder.")
    summary: str = Field(default="", description="Short user-confirmed purpose or scope.")

    @model_validator(mode="after")
    def _check_action(self) -> "ProjectInput":
        if self.action == "list":
            extras = [
                field
                for field in ("project_id", "name", "summary")
                if getattr(self, field)
            ]
            if extras:
                raise ValueError(
                    f"action=list takes no other fields; got {', '.join(extras)}"
                )
        elif self.action in ("current", "overview", "records"):
            # Reads default to the project bound to the caller's MCP key.
            forbidden = ["name", "summary"]
            if self.action == "current":
                forbidden = ["project_id", *forbidden]
            extras = [field for field in forbidden if getattr(self, field)]
            if extras:
                raise ValueError(
                    f"action={self.action} takes no other fields; "
                    f"got {', '.join(extras)}"
                )
        elif self.action == "create":
            if len(self.name) < 3:
                raise ValueError("action=create requires name (at least 3 characters)")
        return self


class ProjectUpdateInput(ProjectScopedInput):
    name: str | None = Field(
        default=None,
        description="New project name, at least 3 characters when provided.",
    )
    summary: str | None = None
    require_verified_reviews: bool | None = Field(
        default=None,
        description=(
            "Policy knob: when true, only reviews with verified independent "
            "authorship (verified_agent_review) satisfy review gates; "
            "attested reviews stop counting. Omit to leave unchanged."
        ),
    )
    agent_dispatch: bool | None = Field(
        default=None,
        description=(
            "Policy knob (off by default): when true, local coding-agent "
            "runners may take this project's assigned work automatically. "
            "Turning it off stops new leases; sessions already running keep "
            "going until halted. Omit to leave unchanged."
        ),
    )
    hidden: bool | None = Field(
        default=None,
        description=(
            "Stash a project out of the UI project list without deleting it: "
            "when true, project.list omits it while the project's data and "
            "direct-by-id access are retained; false restores it. Omit to "
            "leave unchanged."
        ),
    )


SURFACE_TOOLS: dict[str, ToolContract] = {
    "agent.hello": ToolContract(
        handler_identity="agents.hello",
        scope_strategy="none",
        input_model=AgentHelloInput,
        description=(
            "Call once at the start of every context window (subagents too), before any other Merv call: returns "
            "the agent_id every other tool requires. Never share it across contexts; pass one you already hold to confirm it."
        ),
    ),
    "project": ToolContract(
        handler_identity="application.project",
        scope_strategy="caller-selected",
        binds_caller_project="key_project_id",
        external_key_denied_action="create",
        input_model=ProjectInput,
        description=(
            "Project navigation by action. list is how you pick the project_id most tools need; call it first unless "
            "you know the project. current returns exists=false plus the list when the credential reaches several."
        ),
    ),
    "project.update": ToolContract(
        handler_identity="research.update_project",
        visibility="internal",
        input_model=ProjectUpdateInput,
        description=(
            "Update a project name, summary, review/agent/storage policy knobs, "
            "or hidden state."
        ),
    ),
    "project.get": ToolContract(
        handler_identity="research.get_project",
        visibility="internal",
        input_model=ProjectScopedInput,
        description="Get project metadata.",
    ),
    "project.list": ToolContract(
        handler_identity="application.project_list",
        visibility="internal",
        binds_caller_project="project_id",
        input_model=ContractModel,
        description="List projects in the current tool scope.",
    ),
}

# Fixed merge order, unique names: the registry is a view of the owners'
# tables, never a second place a contract can be defined or overridden. A
# research program brings its own table, so installing one adds its tools.
ARTIFACT_TOOLS = artifact_tools(**ARTIFACT_TOOL_VOCABULARY)
FEED_TOOLS = feed_tools(vocabulary=ENTITY_REF_VOCABULARY, author_roles=FEED_AUTHOR_ROLES, adoptable_roles=FEED_ADOPTABLE_ROLES)


def build_manifest(programs: Iterable[Program]) -> dict[str, ToolContract]:
    manifest: dict[str, ToolContract] = {}
    for table in (SURFACE_TOOLS, *(program.tools for program in programs),
                  ARTIFACT_TOOLS, FEED_TOOLS, INFRASTRUCTURE_TOOLS):
        if not manifest.keys().isdisjoint(table):
            raise RuntimeError(f"tool names claimed twice: {sorted(manifest.keys() & table.keys())}")
        manifest.update(table)
    # The one contract written across programs: the reviewer roles it names are every installed workflow's.
    manifest["review.request"] = review_request_tool([w for program in programs for w in program.workflows])
    return manifest


TOOL_MANIFEST = build_manifest(INSTALLED)
STORAGE_TOOL_NAMES = {name for name, tool in TOOL_MANIFEST.items() if "storage" in tool.feature_requirements}
SANDBOX_TOOL_NAMES = {name for name, tool in TOOL_MANIFEST.items() if tool.handler_identity.startswith("sandboxes.")}


def available_tool_names(
    *,
    storage_enabled: bool,
    sandbox_enabled: bool = True,
) -> set[str]:
    """Tool names for the active feature set: an absent capability is not advertised."""
    names = set(TOOL_MANIFEST)
    if not storage_enabled:
        names -= STORAGE_TOOL_NAMES
    if not sandbox_enabled:
        names -= SANDBOX_TOOL_NAMES
    return names
