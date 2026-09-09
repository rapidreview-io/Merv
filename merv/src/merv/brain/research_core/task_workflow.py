# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Legacy task API metadata projected from the canonical definition."""

from ..workflows import task
from .workflow_schema import Workflow, validate_workflow

RETURN_TO_IN_PROGRESS = task.RETURN_TO_IN_PROGRESS
FAIL_TO_FAILED = task.FAIL_TO_FAILED
TASK_WORKFLOW = Workflow(task.TASK, task.METADATA)
TASK_TERMINAL_STATUSES = TASK_WORKFLOW.terminal_statuses
TASK_TRANSITION_VALUES = TASK_WORKFLOW.transition_names
validate_workflow(TASK_WORKFLOW)

__all__ = ["RETURN_TO_IN_PROGRESS", "FAIL_TO_FAILED", "TASK_WORKFLOW", "TASK_TERMINAL_STATUSES", "TASK_TRANSITION_VALUES"]
