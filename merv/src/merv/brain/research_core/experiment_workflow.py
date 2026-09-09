# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Legacy experiment API metadata projected from the canonical definition."""

from ..workflows import experiment, metadata
from .workflow_schema import Workflow, validate_workflow

DEPENDENCIES_NEED = metadata.DEPENDENCIES_NEED
RETURN_TO_PLANNED = experiment.RETURN_TO_PLANNED
RETURN_TO_RUNNING = experiment.RETURN_TO_RUNNING
EXPERIMENT_WORKFLOW = Workflow(experiment.EXPERIMENT, experiment.METADATA)
EXPERIMENT_TERMINAL_STATUSES = EXPERIMENT_WORKFLOW.terminal_statuses
EXPERIMENT_TRANSITION_VALUES = EXPERIMENT_WORKFLOW.transition_names
validate_workflow(EXPERIMENT_WORKFLOW)

__all__ = ["DEPENDENCIES_NEED", "RETURN_TO_PLANNED", "RETURN_TO_RUNNING", "EXPERIMENT_WORKFLOW",
           "EXPERIMENT_TERMINAL_STATUSES", "EXPERIMENT_TRANSITION_VALUES"]
