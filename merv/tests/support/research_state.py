"""Complete native state examples for focused consumer tests."""
from merv.brain.workflows.definitions.research_state import ExperimentState, TaskState, ReflectionState, ReviewReference, ReviewVerdict
from merv.brain.workflows import Snapshot


def experiment_state(**changes) -> ExperimentState:
    return ExperimentState.construct(dict(
        id="exp_1", project_id="proj_1", name="Example", intent="Test one claim", status="planned",
        attempt_index=1, revision_context="", conclusion="", created_at="now", updated_at="now", details="",
        artifacts=[], current_attempt_artifacts=[], submissions=[], reviews=[], tested_claims=[],
        dependencies=[], dependents=[], allowed_transitions=[],
        gate_checklist=dict(status="planned", transition="submit_design", leads_to="design_review", ready=False, items=[]),
    ) | changes)


def task_state(**changes) -> TaskState:
    return TaskState.construct(dict(
        id="task_1", project_id="proj_1", name="Example", goal="Prepare data", status="in_progress",
        attempt_index=1, revision_context="", outcome="", failed_by="", created_at="now", updated_at="now",
        deliverables=["Data is ready"], artifacts=[], current_attempt_artifacts=[], submissions=[], reviews=[],
        dependencies=[], dependents=[], allowed_transitions=[],
        gate_checklist=dict(status="in_progress", transition="submit_delivery", leads_to="in_review", ready=False, items=[]),
    ) | changes)


def reflection_state(**changes) -> ReflectionState:
    row = dict(
        id="syn_1", project_id="proj_1", title="Example", status="reflecting", attempt_index=1,
        revision_context="", published_at=None, published_graph_version_id=None, created_at="now", updated_at="now",
        created_seq=1, roster=[], corpus={}, artifacts=[], current_attempt_artifacts=[], submissions=[], reviews=[],
        materialized_claims=[], materialized_experiments=[], materialized_tasks=[], consolidation={},
        reflection_coverage={}, project_graph_diff={}, allowed_transitions=[],
        gate_checklist=dict(status="reflecting", transition=None, leads_to=None, ready=False, items=[]),
    ) | changes
    snapshot = Snapshot(row["id"], row["project_id"], "reflection", 1, row["status"], 0)
    return ReflectionState.construct(row, snapshot)


def review_reference(**changes) -> ReviewReference:
    row = dict(id="rev_1", project_id="proj_1", request_id="rr_1", session_id="rvs_1", target_snapshot_id="snapshot",
               target_type="experiment", target_id="exp_1", role="experiment_reviewer", verdict="pass", return_to="",
               notes="", synopsis="A verified result.", created_at="now", created_seq=1, submission_id="sub_1", findings=[], evidence={}) | changes
    return ReviewReference(**(row | {"verdict": ReviewVerdict(row["verdict"])}))
