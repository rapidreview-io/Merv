"""Execution policies the research graphs declare for their agent nodes.

Support adds its own baseline (project reads, workflow status, artifacts, feed,
storage) to every session and enforces exactly what a node declares here: the
node-specific tools, which of them mutate the leased instance, the argument
scopes that bind those calls to it, sandbox authority, and the workspace layout
the runner prepares. Nothing in support names a workflow or a record type.
"""

from __future__ import annotations

from ..graph import Execution, Scope, WorkspacePolicy


# Project-scoped knowledge every research agent reads; mutations stay scoped.
KNOWLEDGE_TOOLS = frozenset({
    "claim.list", "experiment.get_state", "experiment.list", "task.get_state", "task.list",
    "reflection.get", "reflection.list", "litreview.view",
})

# Sandbox tools that act on one experiment's compute; each accepts the bound
# ``experiment_id`` keyword the gateway supplies for a mutating call.
SANDBOX_BOUND_TOOLS = frozenset({
    "sandbox.attach", "sandbox.extend", "sandbox.get", "sandbox.pull_outputs", "sandbox.release",
    "sandbox.request", "sandbox.run", "sandbox.job", "sandbox.runs", "sandbox.terminal",
})
SANDBOX_TOOLS = SANDBOX_BOUND_TOOLS | {"sandbox.health", "sandbox.options"}

REVIEW_TOOLS = KNOWLEDGE_TOOLS | {"consolidation.get", "review.start", "review.status", "review.submit"}

REVIEW_WORKSPACE = WorkspacePolicy(mode="ephemeral", namespace="reviews", base="reference:code", retain=False)


def owner_scopes(field: str) -> tuple[Scope, ...]:
    """Bind an owner's record writes, evidence attachments and review requests to its instance."""
    targeted = ("artifact.attach", "review.request", "review.status")
    return (
        Scope(field, "instance"),
        Scope("target_id", "instance", tools=targeted),
        Scope("target_type", "workflow", tools=targeted),
        Scope("attach_to.target_id", "instance", tools=("artifact.upload",)),
        Scope("attach_to.target_type", "workflow", tools=("artifact.upload",)),
    )


def owner_execution(field: str, *, tools: frozenset[str], mutating: frozenset[str], sandbox: bool = False,
                    workspace: WorkspacePolicy = WorkspacePolicy(), scope: tuple[Scope, ...] = ()) -> Execution:
    return Execution(tools=tools, mutating=mutating, scope=(*owner_scopes(field), *scope), sandbox=sandbox,
                     workspace=workspace)


REVIEW_EXECUTION = Execution(
    read_only=True, tools=REVIEW_TOOLS,
    scope=(Scope("review_request_id", "reference:review_request", tools=("review.start", "review.submit")),),
    workspace=REVIEW_WORKSPACE,
)

EXPERIMENT_EXECUTION = owner_execution(
    "experiment_id",
    tools=KNOWLEDGE_TOOLS | SANDBOX_TOOLS | {
        "experiment.exhibit", "experiment.transition", "litreview.cite",
        "review.request", "review.status",
    },
    mutating=SANDBOX_BOUND_TOOLS | {"experiment.transition", "experiment.exhibit"},
    sandbox=True,
    workspace=WorkspacePolicy(namespace="experiments"),
    scope=(Scope("producing_experiment_id", "instance", tools=("storage.submit",)),),
)

TASK_EXECUTION = owner_execution(
    "task_id",
    tools=KNOWLEDGE_TOOLS | {"task.transition", "litreview.cite", "review.request", "review.status"},
    mutating=frozenset({"task.transition"}),
)

REFLECTION_EXECUTION = owner_execution(
    "reflection_id",
    tools=KNOWLEDGE_TOOLS | {"reflection.transition", "consolidation.get", "litreview.cite", "review.request", "review.status"},
    mutating=frozenset({"reflection.transition"}),
)

CONSOLIDATION_EXECUTION = owner_execution(
    "reflection_id",
    tools=KNOWLEDGE_TOOLS | {"consolidation.get", "consolidation.submit", "review.request", "review.status"},
    mutating=frozenset({"consolidation.submit"}),
    workspace=WorkspacePolicy(namespace="consolidations", base="reference:code", per_base=True, advances_central=True),
)

# A lens reads the fixed corpus and submits its own document through the
# generic workflow exit; it never writes a research record.
LENS_EXECUTION = Execution(
    tools=KNOWLEDGE_TOOLS,
    scope=(Scope("attach_to.target_id", "instance", tools=("artifact.upload",)),
           Scope("target_id", "instance", tools=("artifact.attach",))),
)
