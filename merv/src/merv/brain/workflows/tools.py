"""MCP tool contracts for the workflow engine.

Workflows owns the schema of every ``workflow.*`` call; the support registry
in ``surface/tools/contracts.py`` merges this table with the other owners'.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field, model_validator

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract


class WorkflowStatusAndNextInput(ProjectScopedInput):
    instance_id: str | None = Field(default=None, description="Any workflow instance id (lens, synthesis, plugin workflow).")
    experiment_id: str | None = None
    task_id: str | None = None

    @model_validator(mode="after")
    def _one_scope(self) -> "WorkflowStatusAndNextInput":
        if sum(bool(value) for value in (self.instance_id, self.experiment_id, self.task_id)) > 1:
            raise ValueError("pass only one of instance_id, experiment_id or task_id")
        return self


class WorkflowInstanceInput(ProjectScopedInput):
    instance_id: str = Field(min_length=1)


class WorkflowBeginInput(WorkflowInstanceInput):
    expected_revision: int = Field(ge=0, description="The revision workflow.status_and_next returned.")


class WorkflowStartInput(ProjectScopedInput):
    workflow: str = Field(min_length=1)
    request_id: str = Field(min_length=1, description="Stable id for this start; reuse it on retries.")
    data: dict[str, Any] = Field(default_factory=dict)
    entry: str = ""
    version: int | None = Field(default=None, ge=1)


class WorkflowTransitionInput(WorkflowInstanceInput):
    action: str = Field(min_length=1)
    expected_revision: int = Field(ge=0, description="The revision workflow.status_and_next returned.")
    request_id: str = Field(min_length=1, description="Stable id for this action; reuse it on retries.")
    payload: dict[str, Any] = Field(default_factory=dict)


TOOLS: dict[str, ToolContract] = {
    "workflow.status_and_next": ToolContract(
        handler_identity="application.status_for_agent",
        input_model=WorkflowStatusAndNextInput,
        description=(
            "Start or resume here. Unscoped: the project's next step and context (introduction, literature, claims, "
            "one row per experiment and task). With experiment_id or task_id: that record's state, revision, next "
            "action, blockers and documents. With instance_id: any other instance. Then call the tool the next action names."
        ),
    ),
    "workflow.catalog": ToolContract(
        handler_identity="workflows.catalog", input_model=ContractModel, visibility="internal",
        description="List registered workflows and their definition versions.",
    ),
    "workflow.start": ToolContract(
        handler_identity="workflows.start", input_model=WorkflowStartInput, visibility="internal",
        description="Runner effect: start a registered workflow at an entry, pinned to a version. Agents create records with experiment.create and task.create.",
    ),
    "workflow.transition": ToolContract(
        handler_identity="workflows.transition", input_model=WorkflowTransitionInput,
        description="Apply a graph action to an instance that has no dedicated tool (a reflection lens, project synthesis, a plugin workflow); experiments and tasks use experiment.transition and task.transition. Pass the revision from workflow.status_and_next.",
    ),
    "workflow.assignment": ToolContract(
        handler_identity="workflows.assignment", input_model=WorkflowInstanceInput,
        description="The current node's brief, input references and handoff instructions; unmet prerequisites are listed instead.",
    ),
    "workflow.begin": ToolContract(
        handler_identity="workflows.begin", input_model=WorkflowBeginInput,
        description="Interactive sessions call this once before working a node: it records the start at the given revision and returns the assignment. Auto-run leases begin on their own.",
    ),
    "workflow.history": ToolContract(
        handler_identity="workflows.history", input_model=WorkflowInstanceInput,
        description="State history, delivery status and pending repairs for one instance.",
    ),
}
