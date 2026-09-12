"""MCP tool contracts for the workflow engine.

Workflows owns the schema of every ``workflow.*`` call; the support registry
in ``surface/tools/contracts.py`` merges this table with the other owners'.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field, model_validator

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract


class WorkflowStatusAndNextInput(ProjectScopedInput):
    instance_id: str | None = Field(default=None, description="A registered workflow instance, including any plugin workflow.")
    experiment_id: str | None = None
    task_id: str | None = Field(
        default=None,
        description=(
            "Scope the status to one task (task_… id) instead of an experiment; "
            "returns the task's workflow guidance, brief, delivery, and checks."
        ),
    )

    @model_validator(mode="after")
    def _one_scope(self) -> "WorkflowStatusAndNextInput":
        if sum(bool(value) for value in (self.instance_id, self.experiment_id, self.task_id)) > 1:
            raise ValueError("pass only one of instance_id, experiment_id or task_id")
        return self


class WorkflowInstanceInput(ProjectScopedInput):
    instance_id: str = Field(min_length=1)


class WorkflowBeginInput(WorkflowInstanceInput):
    expected_revision: int = Field(ge=0)


class WorkflowStartInput(ProjectScopedInput):
    workflow: str = Field(min_length=1)
    request_id: str = Field(min_length=1, description="Stable id for this logical start; reuse it on retries.")
    data: dict[str, Any] = Field(default_factory=dict)
    entry: str = ""
    version: int | None = Field(default=None, ge=1)


class WorkflowTransitionInput(WorkflowInstanceInput):
    action: str = Field(min_length=1)
    expected_revision: int = Field(ge=0)
    request_id: str = Field(min_length=1, description="Stable id for this logical action; reuse it on retries.")
    payload: dict[str, Any] = Field(default_factory=dict)


TOOLS: dict[str, ToolContract] = {
    "workflow.status_and_next": ToolContract(
        handler_identity="application.status_for_agent",
        input_model=WorkflowStatusAndNextInput,
        description=(
            "The canonical entrypoint for starting or resuming work. Without "
            "experiment_id or task_id: the project-level orientation gate (what to do "
            "next for the project as a whole) plus the project context — Introduction, "
            "literature summary, Methods/Results, every claim, and one row per "
            "experiment and task with id, name and status; scope to one of those ids "
            "for its own workflow. With experiment_id: that experiment's workflow "
            "(state, revision, next action and what blocks it) and context — "
            "experiment, latest plan, latest report, other current-attempt artifact "
            "references; live experiments get the full plan, terminal ones its Summary. "
            "With task_id: the task's workflow plus brief, delivery, deliverables and "
            "dependencies. With instance_id: any registered workflow instance's state "
            "and its current node's brief. Use artifact.read for deeper artifact reads."
        ),
    ),
    "workflow.catalog": ToolContract(
        handler_identity="workflows.catalog", input_model=ContractModel,
        description="List registered workflows and their available definition versions.",
    ),
    "workflow.start": ToolContract(
        handler_identity="workflows.start", input_model=WorkflowStartInput,
        description="Start a registered workflow at a named entry, pinned to a definition version. Reuse request_id on retries.",
    ),
    "workflow.transition": ToolContract(
        handler_identity="workflows.transition", input_model=WorkflowTransitionInput,
        description="Apply a named graph action using the revision returned by workflow.status_and_next. Durable facts are rechecked before committing.",
    ),
    "workflow.assignment": ToolContract(
        handler_identity="workflows.assignment", input_model=WorkflowInstanceInput,
        description="Build the current agent node's concise brief, exact input references, and handoff instructions. Missing dispatch prerequisites block the assignment.",
    ),
    "workflow.begin": ToolContract(
        handler_identity="workflows.begin", input_model=WorkflowBeginInput,
        description=(
            "Begin this existing node's work in an interactive session and return its assignment. "
            "Use the current expected_revision; prerequisites are rechecked atomically. Records "
            "actual work start once per revision and queues node start effects without changing "
            "state. Auto-run sessions activate through their own lease instead."
        ),
    ),
    "workflow.history": ToolContract(
        handler_identity="workflows.history", input_model=WorkflowInstanceInput,
        description="Read the durable state history and support actions for one workflow instance, including delivery status and errors requiring repair.",
    ),
}
