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
    PROJECT_OVERVIEW_CONTENTS,
)
from ...workflows import ARTIFACT_TOOL_VOCABULARY, Program


class AgentHelloInput(ContractModel):
    """Mint (or confirm) the agent_id this context window carries on every call.

    Kept tiny on purpose: the whole point of the id is that carrying it costs
    the model a handful of tokens per call.
    """

    agent_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Only if this context window already has an agent_id: pass it to "
            "confirm it instead of minting a second one."
        ),
    )
    role: str = Field(
        default="",
        max_length=64,
        description=(
            "Optional self-description of what this context is doing: "
            "main, subagent, worker, or whatever role your assignment names."
        ),
    )
    parent_agent_id: str = Field(
        default="",
        max_length=64,
        description=(
            "Optional: the agent_id of the context that spawned this one, if "
            "it told you."
        ),
    )
    note: str = Field(
        default="",
        max_length=200,
        description="Optional one-line note about what this context is doing.",
    )


class ProjectInput(ContractModel):
    """The one agent-facing project tool: list / current / create / overview."""

    action: Literal["list", "current", "create", "overview"] = Field(
        description=(
            "list = every project you can work in, with names, summaries, "
            "and creation dates — start here to pick a project_id; "
            "current = the project this credential is bound to, if it is "
            "bound to exactly one; "
            f"overview = the canonical bounded project context ({PROJECT_OVERVIEW_CONTENTS}) "
            "for orienting or re-grounding; "
            "create = create a project."
        )
    )
    project_id: str = Field(
        default="",
        description="Optional explicit project id for action=overview.",
    )
    name: str = Field(
        default="",
        description=(
            "User-confirmed project name, at least 3 characters. Required for "
            "action=create. Do not infer a placeholder unless the user "
            "explicitly asked for it."
        ),
    )
    summary: str = Field(
        default="",
        description="Short user-confirmed project purpose or scope.",
    )

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
        elif self.action in ("current", "overview"):
            # Both default to the project bound to the caller's MCP key;
            # overview also tolerates an explicit project_id.
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
            "Call ONCE at the start of a context window, before any other Merv "
            "call: returns the short agent_id that identifies this context "
            "window (this conversation, or this subagent) to Merv. Every other "
            "Merv tool requires that agent_id as an argument, so Merv can "
            "attribute what each agent did and was told. Never share an "
            "agent_id across contexts; a subagent must call agent.hello "
            "itself. If you already have one from earlier in this context, "
            "keep using it (or pass it here to confirm) instead of minting "
            "another."
        ),
    ),
    "project": ToolContract(
        handler_identity="application.project",
        scope_strategy="caller-selected",
        binds_caller_project="key_project_id",
        external_key_denied_action="create",
        input_model=ProjectInput,
        description=(
            "Project navigation for this credential, dispatched on 'action'. "
            "action=list returns every project you can work in — id, name, "
            "summary, and creation date, minus any the user has stashed — and "
            "is how you pick the project_id "
            "that most other tools require; call it first when you do not "
            "already know which project the user means. "
            "action=current returns the single project this credential is "
            "bound to; a credential that reaches several returns exists=false "
            "and the same list, because there is no one current project. "
            "action=overview is the whole-project read for orienting or "
            "re-grounding: the same bounded project context used by project-"
            f"scoped workflow and review starts, holding {PROJECT_OVERVIEW_CONTENTS}. "
            "action=create creates a project from a user-confirmed name and "
            "summary."
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
