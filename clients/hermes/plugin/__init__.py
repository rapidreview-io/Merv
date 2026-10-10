"""Register Merv's canonical skills with Hermes Agent."""

from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parent
SKILLS_ROOT = PLUGIN_ROOT / "skills"

MERV_CONTEXT = """<merv_integration>
Merv is connected through the `merv` MCP server. Hermes exposes each remote
tool as `mcp_merv_` followed by the public tool name with dots replaced by
underscores; for example, `workflow.status_and_next` is
`mcp_merv_workflow_status_and_next`.

Merv workflows are available as namespaced plugin skills. Load
`merv:research-workflow` for experiment work or resuming work already in
progress. Load `merv:project-reflection` when the workflow calls for a project
reflection. Any sibling skill named inside a Merv skill is available under the
same `merv:` namespace. When a review handoff is required, pass its spawn prompt
unchanged to a fresh `delegate_task` child.
</merv_integration>"""


def register(ctx):
    """Register every generated skill and a bounded discovery hint."""
    for skill_file in sorted(SKILLS_ROOT.glob("*/SKILL.md")):
        ctx.register_skill(skill_file.parent.name, skill_file)
    ctx.register_system_prompt_section(
        "merv.integration",
        MERV_CONTEXT,
        position="after_memory",
        max_chars=1600,
    )
