# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The complete task lifecycle and its agent-facing actions.

A task is scoped work with a verifiable finish line and no claim: lit reviews,
data preparation, harness building, memos — anything the project needs that
does not test a claim. It is the experiment with the middle taken out: one
document going in (the brief, whose ``Done when`` checks are the contract), one
coming out (the delivery, evidence per check), and one review instead of two.
"""

from __future__ import annotations

from .experiment_workflow import DEPENDENCIES_NEED
from .workflow_schema import (
    ArtifactNeed,
    ReviewGate,
    ReviewReturn,
    State,
    Transition,
    Workflow,
    validate_workflow,
)


RETURN_TO_IN_PROGRESS = ReviewReturn(
    to_status="in_progress",
    attempt="same",
    event_type="task.returned_to_in_progress",
    default=True,
    choose_when=(
        "Something specific is wrong or could not be verified; the executor "
        "fixes the delivery and resubmits."
    ),
    revision=(
        "Sent back to in_progress: the brief stands; address each named check, "
        "resubmit delivery.md via artifact.submit, then request review again"
    ),
)
FAIL_TO_FAILED = ReviewReturn(
    to_status="failed",
    attempt="same",
    event_type="task.failed_by_review",
    choose_when=(
        "The goal cannot be met within the task's scope — a wrong premise, a "
        "resource that no longer exists, a dependency that died. The task ends."
    ),
)

TASK_RETURN_ERROR = "return_to must be 'in_progress' (or omitted)"


TASK_WORKFLOW = Workflow(
    target_type="task",
    subject="task",
    initial="in_progress",
    success_status="done",
    event_type="task.transitioned",
    review_return_error=TASK_RETURN_ERROR,
    states=(
        State(
            name="in_progress",
            requirements=(
                ArtifactNeed(
                    role="brief",
                    error=(
                        "a brief artifact must be submitted before the delivery: "
                        "write tasks/<name>/brief.md with the sections Goal; "
                        "Done when (a numbered list of checks, each stating what "
                        "must be true and how it can be verified); optionally "
                        "Scope and Context — see "
                        "skills/research-workflow/brief-template.md"
                    ),
                    validator="brief",
                    gate="brief_required",
                    missing="task brief artifact (role 'brief')",
                    label="Brief submitted and valid",
                    action="write_and_submit_brief",
                    tools=("artifact.submit",),
                    artifact_key="brief",
                ),
                DEPENDENCIES_NEED,
                ArtifactNeed(
                    role="delivery",
                    error=(
                        "a delivery artifact must be submitted before task "
                        "review: write tasks/<name>/delivery.md with a Checks "
                        "section holding one numbered entry per brief check "
                        "(the evidence, and how the reviewer can check it), then "
                        "Caveats — see skills/research-workflow/delivery-template.md"
                    ),
                    validator="delivery",
                    gate="delivery_required",
                    missing="task delivery artifact (role 'delivery')",
                    label="Delivery submitted and valid",
                    action="write_and_submit_delivery",
                    tools=("artifact.submit",),
                    artifact_key="delivery",
                ),
            ),
            forward=Transition(
                name="submit_delivery",
                to_status="in_review",
                requires_prose=(
                    "a 'brief' artifact and a 'delivery' artifact must be "
                    "submitted to this task; the delivery must carry one Checks "
                    "entry per brief check, and every dependency must be done"
                ),
                gate="task_review_required",
                action=(
                    "submit_delivery_for_review (call only once every check in "
                    "the brief is addressed in the delivery — met with evidence, "
                    "or explicitly unmet with a reason; if revision_context is "
                    "present, the last review sent this task back — address it "
                    "before resubmitting)"
                ),
                tools=("task.transition",),
            ),
        ),
        State(
            name="in_review",
            review=ReviewGate(
                role="task_reviewer",
                error="task review must pass before done",
                blocker_code="task_review_required",
                label="Delivery review passed",
                skill="task-review",
                pass_action="accept_task",
                returns=(RETURN_TO_IN_PROGRESS,),
                fail_route=FAIL_TO_FAILED,
            ),
            forward=Transition(
                name="accept",
                to_status="done",
                requires_prose="a passing task_reviewer review",
                action="accept_task",
                tools=("task.transition",),
                effects=("record_outcome",),
            ),
        ),
    ),
    global_exits=(
        Transition(
            name="mark_failed",
            to_status="failed",
            requires_prose=(
                "the owner withdraws the task or judges its goal unreachable; "
                "pass evidence={'reason': ...} so the reflection can read why"
            ),
            action="mark_task_failed",
            tools=("task.transition",),
            effects=("record_failure",),
        ),
    ),
)

validate_workflow(TASK_WORKFLOW)

TASK_TERMINAL_STATUSES = TASK_WORKFLOW.terminal_statuses
TASK_TRANSITION_VALUES = TASK_WORKFLOW.transition_names


__all__ = [
    "FAIL_TO_FAILED",
    "RETURN_TO_IN_PROGRESS",
    "TASK_TERMINAL_STATUSES",
    "TASK_TRANSITION_VALUES",
    "TASK_WORKFLOW",
]
