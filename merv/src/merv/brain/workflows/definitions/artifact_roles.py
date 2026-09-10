"""Artifact role and association-target vocabulary.

Workflow definitions own evidence roles, association targets, and per-role
byte caps; generic artifact content has no role or workflow target. This module
is deliberately dependency-free. Research, Application, and Surface reach it
through the ``workflows`` package root; support components never import it.
"""

from __future__ import annotations

ARTIFACT_TARGET_TYPES = frozenset(
    {"experiment", "reflection", "task", "claim", "review", "attempt"}
)

PROJECT_GRAPH_ROLE = "project_graph"
LEGACY_PROJECT_GRAPH_ROLE = "graph"

REFLECTION_LENS_DOC_ROLE = "reflection_lens_doc"

# Pre-rename role spellings, rejected at submit with the replacement named.
# Migration 24 canonicalizes backfilled rows to the replacement roles, so no
# stored artifact carries a legacy spelling — readers know only the canon.
LEGACY_ROLE_REPLACEMENTS = {
    "reflection": REFLECTION_LENS_DOC_ROLE,
    "synthesis_doc": "reflection_doc",
    "proposals": "change_spec",
}

# System-authored role: the metrics exhibit is generated and pinned by the
# backend at submit_results. It is deliberately NOT submittable — agents
# cannot submit (and so cannot replace) it; only the system pin path may.
EXHIBIT_ROLE = "exhibit"
SYSTEM_CREATED_BY = "system"

# Role-'result' artifacts are small metrics JSON files the exhibit ingests.
METRIC_RESULT_MAX_BYTES = 16_000

# Task documents: the brief (goal + numbered "Done when" checks) goes in, the
# delivery (evidence per check) comes out.
TASK_BRIEF_ROLE = "brief"
TASK_DELIVERY_ROLE = "delivery"

# Roles an agent may submit via artifact.upload: the canonical gated docs plus
# the metrics-JSON 'result' role.
SUBMITTABLE_ROLES = frozenset(
    {
        "plan",
        "report",
        "graph",
        PROJECT_GRAPH_ROLE,
        REFLECTION_LENS_DOC_ROLE,
        "reflection_doc",
        "change_spec",
        TASK_BRIEF_ROLE,
        TASK_DELIVERY_ROLE,
        "result",
    }
)

# Everything the generic Artifacts tool schema needs to describe one
# association: the target kinds, the roles an agent may submit, and the single
# role that also carries a lens id. Passed as a bundle so the tool registry
# never spells a research role itself.
ARTIFACT_TOOL_VOCABULARY = {
    "target_types": ARTIFACT_TARGET_TYPES,
    "roles": SUBMITTABLE_ROLES,
    "lens_role": REFLECTION_LENS_DOC_ROLE,
}


def artifact_byte_cap(role: str) -> int | None:
    """Upload byte cap for a submittable role; None = role is not size-capped."""
    if role == "result":
        return METRIC_RESULT_MAX_BYTES
    return GATED_ROLE_BYTE_CAPS.get(role)


# Gated roles: the artifacts workflow gates lint. Submitting one of these pins
# the file's bytes in the blob store (size-capped), so gates and reviewers read
# immutable content.
GATED_ROLE_BYTE_CAPS: dict[str, int] = {
    "plan": 16_000,
    "report": 16_000,
    "graph": 16_000,
    PROJECT_GRAPH_ROLE: 16_000,
    REFLECTION_LENS_DOC_ROLE: 16_000,
    "reflection_doc": 16_000,
    "change_spec": 16_000,
    TASK_BRIEF_ROLE: 16_000,
    TASK_DELIVERY_ROLE: 16_000,
}
GATED_ROLES = frozenset(GATED_ROLE_BYTE_CAPS)

# Gated markdown roles whose relative image links are captured as submitted
# figures at artifact.upload time and pinned beside the document.
MARKDOWN_FIGURE_ROLES = frozenset({"plan", "report", "reflection_doc"})
