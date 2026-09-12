"""Task graph: immutable goal, delivery, and independent review."""

from ..graph import (
    Action, ArtifactNeed, Change, DependenciesDone, Edge, Guidance, Metadata, Node, RecordKind,
    Reference, ReviewGate, ReviewReturn, Workflow,
)
from .checks import project_brief, evidence_references, rejected, review_summary, short
from .documents import brief_problems, delivery_problems
from .execution import RESEARCH_HANDOFF, REVIEW_EXECUTION, TASK_EXECUTION
from .research_state import TaskState


def _document_problems(role):
    def problems(document, snapshot, knowledge):
        task = knowledge.read(Reference("task", snapshot.id))
        checks = [str(item) for item in task.get("deliverables", ())]
        found = (brief_problems(document["text"]) if role == "brief" else
                 ["This task has no deliverables to confirm; end it and create a task with deliverables."] if not checks else
                 delivery_problems(document["text"], checks=checks))
        return ("; ".join(found),) if found else ()
    return problems


ARTIFACTS = {
    role: ArtifactNeed(role, f"a {role} artifact must be submitted before task review", f"{role}_required",
                       f"write_and_submit_{role}", validator=role, label=f"{role.capitalize()} submitted and valid",
                       missing=f"task {role} artifact", artifact_key=role, actions=("submit_delivery",),
                       validate=_document_problems(role), invalid=f"task {role} is not ready: {{problems}}",
                       invalid_action=f"fix_{role}_artifact")
    for role in ("brief", "delivery")
}
DEPENDENCIES = DependenciesDone(actions=("submit_delivery",))
RETURN_TO_IN_PROGRESS = ReviewReturn("in_progress", "same", event_type="task.returned_to_in_progress",
                                    choose_when="The goal stands, but the delivery needs work.", default=True,
                                    revision="Address the review findings, then submit the revised delivery.")
FAIL_TO_FAILED = ReviewReturn("failed", "same", event_type="task.failed_by_review", choose_when="The task goal cannot be achieved within its scope.")
DELIVERY_REVIEW = ReviewGate("task_reviewer", "task review must pass before done", "task_review_required",
                             "Delivery review passed", "task-review", "accept", (RETURN_TO_IN_PROGRESS,),
                             fail_route=FAIL_TO_FAILED, actions=("accept",))


def request_delivery_review(snapshot, payload, knowledge):
    return Change(actions=(Action("review.request", {"target_type": "task", "target_id": snapshot.id,
                                                     "role": "task_reviewer"}),))


def record_verdict(snapshot, payload, knowledge):
    fact = knowledge.read(Reference("review", "task_reviewer"))
    if fact.get("verdict") == "pass":
        outcome = (fact.get("evidence") or {}).get("outcome") or fact.get("synopsis") or fact.get("notes") or ""
        return Change(data={"outcome": str(outcome), "revision_context": ""})
    return Change(data={"revision_context": review_summary(fact) + "\nRevise the delivery against the brief's Done-when checks; the goal stands."})


def build_work_context(snapshot, knowledge):
    task = knowledge.read(Reference("task", snapshot.id))
    project = knowledge.read(Reference("project", snapshot.project_id))
    checks = short("; ".join(f"{index}. {item}" for index, item in enumerate(task.get("deliverables") or (), 1)), 65)
    revision = short(task.get("revision_context") or "No requested revisions.", 45)
    return project_brief(snapshot, knowledge,
        f"Complete task {task.get('name', snapshot.id)} for {project.get('name', 'this project')}. "
        f"Goal: {short(task.get('goal'), 50)}\nDeliverables (read the pinned brief for the full contract):\n{checks}\n\n"
        f"Why this assignment is active: {revision}\n\n"
        "Reuse retained work to complete the fixed brief and submit a verifiable delivery. Follow research-workflow.",
        (Reference("task", snapshot.id, "Task and durable progress"),
         *evidence_references(task.get("current_attempt_artifacts") or ())),
    )


def build_review_context(snapshot, knowledge):
    task = knowledge.read(Reference("task", snapshot.id))
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return project_brief(snapshot, knowledge,
        f"Independently review the delivery for task {task.get('name', snapshot.id)}. "
        f"Goal: {short(task.get('goal'), 65)}\n\n"
        "Verify the pinned brief's checks and whether they achieve the goal. Follow task-review; submit only the verdict.",
        (Reference("task", snapshot.id, "Task goal"),
         Reference("review_request", str(pinned.get("request_id") or "")),
         *evidence_references(pinned.get("artifacts") or ())),
    )


TASK = Workflow(
    name="task", version=1, initial="in_progress", event_type="task.transitioned", id_prefix="task",
    nodes=(
        Node("in_progress", "Complete task", "task_owner", build_work_context, guidance=Guidance("research-workflow", RESEARCH_HANDOFF), execution=TASK_EXECUTION,
             requires=(ARTIFACTS["brief"], DEPENDENCIES, ARTIFACTS["delivery"])),
        Node("in_review", "Review task delivery", "task_reviewer", build_review_context, guidance=Guidance(DELIVERY_REVIEW.skill, RESEARCH_HANDOFF), execution=REVIEW_EXECUTION,
             requires=(DELIVERY_REVIEW,)),
    ),
    edges=(
        Edge("in_progress", "submit_delivery", "in_review", change=request_delivery_review,
             label="Submit the complete delivery for independent review", tools=("task.transition",)),
        Edge("in_review", "accept", "done", change=record_verdict, label="Applied by a passing task review", auto=True),
        Edge("in_review", "revise", RETURN_TO_IN_PROGRESS.to_status, check=rejected("task_reviewer", RETURN_TO_IN_PROGRESS.to_status),
             change=record_verdict, label=RETURN_TO_IN_PROGRESS.choose_when, event_type=RETURN_TO_IN_PROGRESS.event_type, auto=True),
        Edge("in_review", "fail_review", FAIL_TO_FAILED.to_status, check=rejected("task_reviewer", FAIL_TO_FAILED.to_status),
             change=record_verdict, label=FAIL_TO_FAILED.choose_when, event_type=FAIL_TO_FAILED.event_type, auto=True),
        *(Edge(state, "mark_failed", "failed", label="Withdraw the task with a reason", tools=("task.transition",), suggest=False)
          for state in ("in_progress", "in_review")),
    ),
    outcome_guidance={
        "completed": Guidance(messages={"task_done": "task {entity} was just accepted"}),
        "failed": Guidance(messages={"task_failed": "task {entity} just failed"}),
    },
    outcomes={"done": "completed", "failed": "failed"},
)

METADATA = Metadata(effects={"accept": ("record_outcome",), "mark_failed": ("record_failure",)})

KIND = RecordKind(
    name="task", table="tasks", id_prefix="task", workflow=TASK,
    construct=TaskState.construct, metadata=METADATA, created_event="task.created",
    columns=("name", "goal", "deliverables_json"), json_columns={"deliverables_json": ("deliverables", "[]")},
    dependencies=True, seal_exempt_actions=frozenset({"revise", "fail_review", "migrate"}),
    commit_columns={"revise": ("revision_context",), "fail_review": ("revision_context",),
                    "accept": ("outcome", "revision_context")},
)
