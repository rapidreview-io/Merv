"""Complete native state examples for focused consumer tests."""
from merv.brain.workflows.definitions.research_state import ExperimentState


def experiment_state(**changes) -> ExperimentState:
    return ExperimentState.construct(dict(
        id="exp_1", project_id="proj_1", name="Example", intent="Test one claim", status="planned",
        attempt_index=1, revision_context="", conclusion="", created_at="now", updated_at="now", details="",
        artifacts=[], current_attempt_artifacts=[], submissions=[], reviews=[], tested_claims=[],
        dependencies=[], dependents=[], allowed_transitions=[],
        gate_checklist=dict(status="planned", transition="submit_design", leads_to="design_review", ready=False, items=[]),
    ) | changes)
