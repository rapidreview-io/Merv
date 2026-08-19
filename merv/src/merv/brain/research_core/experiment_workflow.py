# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The complete experiment lifecycle and its agent-facing actions."""

from __future__ import annotations

from .workflow_schema import (
    ArtifactNeed,
    RecordNeed,
    ReviewGate,
    ReviewReturn,
    State,
    Transition,
    Workflow,
    validate_workflow,
)


# The wave DAG gate shared by experiments and tasks: a node whose
# ``node_dependencies`` targets are not all done (task) / complete
# (experiment) does not proceed. Experiments wait at ready_to_run; tasks wait
# before submit_delivery.
DEPENDENCIES_NEED = RecordNeed(
    name="dependencies",
    error=(
        "every node this one depends on must be done before it proceeds; a "
        "failed dependency means this node should be abandoned/marked failed, "
        "or wait for the next reflection to replan the wave"
    ),
    gate="dependencies_pending",
    action="wait_for_dependencies",
    tools=("workflow.status_and_next",),
    label="Dependencies done",
    missing="unfinished dependencies",
)


RETURN_TO_PLANNED = ReviewReturn(
    to_status="planned",
    attempt="new",
    event_type="experiment.returned_to_planned",
    default=True,
    choose_when="The plan itself is flawed and must be revised.",
)
RETURN_TO_RUNNING = ReviewReturn(
    to_status="running",
    attempt="same",
    event_type="experiment.returned_to_running",
    choose_when="The plan stands, but execution or the conclusion needs work.",
    revision=(
        "Sent back to running: the approved plan stands; fix execution "
        "and/or the conclusion, then resubmit results via artifact.submit "
        "and request review again"
    ),
)

EXPERIMENT_RETURN_ERROR = "return_to must be 'planned' or 'running'"


EXPERIMENT_WORKFLOW = Workflow(
    target_type="experiment",
    subject="experiment",
    initial="planned",
    success_status="complete",
    event_type="experiment.transitioned",
    review_return_error=EXPERIMENT_RETURN_ERROR,
    states=(
        State(
            name="planned",
            requirements=(
                ArtifactNeed(
                    role="plan",
                    error=(
                        "an experiment plan artifact must be submitted before "
                        "design review"
                    ),
                    validator="plan",
                    gate="plan_required",
                    missing="experiment plan artifact",
                    label="Plan submitted and valid",
                    action="write_and_submit_plan",
                    tools=("artifact.submit",),
                    artifact_key="plan",
                ),
            ),
            forward=Transition(
                name="submit_design",
                to_status="design_review",
                requires_prose=(
                    "a 'plan' artifact must be submitted to this experiment, "
                    "with the required plan section headers present"
                ),
                gate="design_review_required",
                action="submit_design_for_review",
                tools=("experiment.transition",),
            ),
        ),
        State(
            name="design_review",
            review=ReviewGate(
                role="design_reviewer",
                error="design review must pass before ready_to_run",
                blocker_code="design_review_required",
                label="Design review passed",
                skill="experiment-design-review",
                pass_action="mark_ready_to_run",
                returns=(RETURN_TO_PLANNED,),
                forbidden_returns=(
                    (
                        "running",
                        "experiment-design-review rejections cannot return_to "
                        "'running'; a flawed plan goes back to 'planned'",
                    ),
                ),
            ),
            forward=Transition(
                name="mark_ready_to_run",
                to_status="ready_to_run",
                requires_prose="a passing design_reviewer review",
                action="mark_ready_to_run",
                tools=("experiment.transition",),
            ),
        ),
        State(
            name="ready_to_run",
            requirements=(DEPENDENCIES_NEED,),
            forward=Transition(
                name="start_running",
                to_status="running",
                gate="execution_ready",
                action="start_running",
                tools=(
                    "sandbox.request",
                    "sandbox.attach",
                    "experiment.transition",
                ),
                effects=(
                    "start_attempt_clock",
                    "start_tracking",
                    "show_metrics_exhibit",
                ),
            ),
        ),
        State(
            name="running",
            requirements=(
                ArtifactNeed(
                    role="result",
                    error=(
                        "result artifact must be submitted before "
                        "experiment_review"
                    ),
                    gate="execution_ready",
                    missing="result artifact",
                    label="Result artifact present",
                    action="run_experiment_and_retain_results",
                    tools=(
                        "sandbox.request",
                        "sandbox.attach",
                        "sandbox.terminal",
                        "sandbox.get",
                        "experiment.transition",
                        "artifact.submit",
                    ),
                    artifact_key="result",
                ),
                ArtifactNeed(
                    role="report",
                    error=(
                        "a results report must be retained before "
                        "experiment_review: write a short markdown report "
                        "(sections Summary; Results interpreting the system "
                        "metrics exhibit — preview it with experiment.exhibit; "
                        "Deviations from plan; Conclusion applying the plan's "
                        "decision rule), copy it out if produced on the "
                        "sandbox, and submit it with artifact.submit (role "
                        "'report') — see "
                        "skills/research-workflow/report-template.md"
                    ),
                    validator="report",
                    gate="results_report_required",
                    missing="results report artifact (role 'report')",
                    label="Results report present and valid",
                    action="write_and_submit_results_report",
                    tools=("artifact.submit",),
                    artifact_key="report",
                ),
                ArtifactNeed(
                    role="graph",
                    error=(
                        "a logic graph must be retained before "
                        "experiment_review: write the experiment's logic graph "
                        "(experiments/<name>/graph.json — your story of the "
                        "experiment's logical path: the hard decisions and the "
                        "reasoning behind them, as a DAG of at most 16 nodes; "
                        "not a pipeline/provenance diagram and never "
                        "script-generated), copy it out if produced on the "
                        "sandbox, and submit it with artifact.submit (role "
                        "'graph') — see "
                        "skills/research-workflow/graph-template.md"
                    ),
                    validator="graph",
                    gate="logic_graph_required",
                    missing="logic graph artifact (role 'graph')",
                    label="Logic graph present and valid",
                    action="write_and_submit_logic_graph",
                    tools=("artifact.submit",),
                    artifact_key="graph",
                ),
            ),
            forward=Transition(
                name="submit_results",
                to_status="experiment_review",
                requires_prose=(
                    "a 'result' artifact, a results report (role 'report'), AND "
                    "a logic graph (role 'graph') must be submitted to this "
                    "experiment; the report needs the required section "
                    "headers, resolvable figure links, and — when the system "
                    "pinned a metrics exhibit for this attempt — a reference "
                    "to it (the exhibit, not an agent-written table, is the "
                    "record of the attempt's runs); the graph must be valid "
                    "JSON forming a DAG of at most 16 nodes"
                ),
                gate="experiment_review_required",
                action=(
                    "submit_results_for_review (call only once the experiment "
                    "is fully complete and every success criterion in the "
                    "experiment intent is satisfied; do NOT call if the "
                    "experiment should continue running; continue with "
                    "sandbox.* and artifact.submit calls instead and only "
                    "transition once the work is truly done; if "
                    "revision_context is present, the last review rejected "
                    "this attempt or an infrastructure retry was requested — "
                    "address it before resubmitting)"
                ),
                tools=("experiment.transition",),
                effects=(
                    "result_submission",
                    "prepare_metrics_exhibit",
                    "finish_tracking",
                ),
            ),
            extras=(
                Transition(
                    name="retry_running",
                    to_status="running",
                    requires_prose=(
                        "use only for infrastructure failure or interrupted "
                        "execution when the approved plan still stands; the "
                        "experiment remains running and attempt_index is "
                        "unchanged"
                    ),
                    action="retry_running",
                    tools=("experiment.transition",),
                    effects=(
                        "record_retry_context",
                        "restart_tracking",
                        "show_metrics_exhibit",
                    ),
                ),
            ),
        ),
        State(
            name="experiment_review",
            review=ReviewGate(
                role="experiment_reviewer",
                error="experiment review must pass before complete",
                blocker_code="experiment_review_required",
                label="Experiment review passed",
                skill="experiment-attempt-review",
                pass_action="complete_experiment",
                returns=(RETURN_TO_PLANNED, RETURN_TO_RUNNING),
                return_choice_required=True,
                return_required_error=(
                    "experiment-attempt-review rejections must set return_to: "
                    "'planned' if the results show the plan itself is flawed, "
                    "or 'running' if the plan stands but execution or the "
                    "conclusion is flawed"
                ),
            ),
            forward=Transition(
                name="complete",
                to_status="complete",
                requires_prose="a passing experiment_reviewer review",
                action="complete_experiment",
                tools=("experiment.transition",),
                effects=("record_conclusion", "finish_tracking"),
            ),
        ),
    ),
    global_exits=(
        Transition(
            name="abandon",
            to_status="abandoned",
            action="abandon_experiment",
            tools=("experiment.transition",),
            effects=("stop_tracking",),
        ),
        Transition(
            name="mark_failed",
            to_status="failed",
            action="mark_experiment_failed",
            tools=("experiment.transition",),
            effects=("fail_tracking",),
        ),
    ),
)

validate_workflow(EXPERIMENT_WORKFLOW)

EXPERIMENT_TERMINAL_STATUSES = EXPERIMENT_WORKFLOW.terminal_statuses
EXPERIMENT_TRANSITION_VALUES = EXPERIMENT_WORKFLOW.transition_names


__all__ = [
    "DEPENDENCIES_NEED",
    "EXPERIMENT_TERMINAL_STATUSES",
    "EXPERIMENT_TRANSITION_VALUES",
    "EXPERIMENT_WORKFLOW",
]
