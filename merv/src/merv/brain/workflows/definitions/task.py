"""Task graph: immutable goal, delivery, and independent review."""

from ..graph import (
    Action, ArtifactNeed, Brief, Change, DependenciesDone, Edge, Metadata, Node, RecordKind,
    Reference, ReviewGate, ReviewReturn, Workflow,
)
from .checks import reviewed, review_summary
from .execution import REVIEW_EXECUTION, TASK_EXECUTION
from .documents import brief_problems, delivery_problems


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
        outcome = (fact.get("evidence") or {}).get("outcome") or fact.get("notes") or fact.get("synopsis") or ""
        return Change(data={"outcome": str(outcome)})
    return Change(data={"revision_context": review_summary(fact) + "\nRevise the delivery against the brief's Done-when checks; the goal stands."})


def _references(artifacts):
    return tuple(
        Reference("artifact", str(artifact.get("artifact_id") or artifact.get("id")), str(artifact.get("role") or "Evidence"))
        for artifact in artifacts if artifact.get("artifact_id") or artifact.get("id")
    )


def _short(value, words):
    parts = str(value or "").split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def build_work_context(snapshot, knowledge):
    task = knowledge.read(Reference("task", snapshot.id))
    project = knowledge.read(Reference("project", snapshot.project_id))
    checks = _short("; ".join(f"{index}. {item}" for index, item in enumerate(task.get("deliverables") or (), 1)), 65)
    revision = _short(task.get("revision_context") or "No requested revisions.", 45)
    return Brief(
        f"Complete task {task.get('name', snapshot.id)} for {project.get('name', 'this project')}. "
        f"Project purpose: {_short(project.get('summary') or 'No project summary supplied.', 35)}\n\n"
        f"Goal: {_short(task.get('goal'), 50)}\nDeliverables (read the pinned brief for the full contract):\n{checks}\n\n"
        f"Why this assignment is active: {revision}\n\n"
        "The goal and deliverables are the fixed contract. Read the pinned brief and existing delivery first; "
        "reuse retained work and address the remaining checks. Supply a verifiable confirmation for each "
        "deliverable, or explain explicitly why it could not be delivered. Keep supporting evidence available "
        "through artifact tools, and record caveats. Submit one complete delivery version before requesting "
        "independent review. A fresh agent will handle the next node; make the submitted evidence sufficient "
        "for that handoff without relying on this conversation.",
        (Reference("task", snapshot.id, "Task and durable progress"),
         *_references(task.get("current_attempt_artifacts") or ())),
    )


def build_review_context(snapshot, knowledge):
    task = knowledge.read(Reference("task", snapshot.id))
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return Brief(
        f"Independently review the delivery for task {task.get('name', snapshot.id)}. "
        f"Goal: {_short(task.get('goal'), 65)}\n\n"
        "Use the exact brief and delivery references in this submitted review snapshot. Verify every "
        "deliverable using its evidence and stated check, then judge whether the checks together achieve "
        "the goal. Read surrounding project context through existing tools where needed. Treat the "
        "producer's claims as things to verify; the submitted snapshot fixes what this review grades. "
        "Record concrete findings and the evidence you checked.\n\n"
        "Submit pass when the goal is achieved, needs_changes for specific repairable omissions, or fail "
        "when the task's goal cannot be achieved within its scope. Needs_changes returns to work; fail "
        "ends the task. Follow the task-review skill and use review.start and review.submit with your "
        "own reviewer identity. Your assignment is read-only apart from submitting that verdict. "
        "Hand off after the verdict; the next node receives the findings in its own context.",
        (Reference("task", snapshot.id, "Task goal"),
         Reference("review_request", str(pinned.get("request_id") or "")),
         *_references(pinned.get("artifacts") or ())),
    )


TASK = Workflow(
    name="task", version=1, initial="in_progress", event_type="task.transitioned", id_prefix="task",
    nodes=(
        Node("in_progress", "Complete task", "task_owner", build_work_context, execution=TASK_EXECUTION,
             requires=(ARTIFACTS["brief"], DEPENDENCIES, ARTIFACTS["delivery"])),
        Node("in_review", "Review task delivery", "task_reviewer", build_review_context, execution=REVIEW_EXECUTION,
             requires=(DELIVERY_REVIEW,)),
    ),
    edges=(
        Edge("in_progress", "submit_delivery", "in_review", change=request_delivery_review,
             label="Submit the complete delivery for independent review", tools=("task.transition",)),
        Edge("in_review", "accept", "done", change=record_verdict,
             label="Accept the reviewed delivery", tools=("task.transition",)),
        Edge("in_review", "revise", RETURN_TO_IN_PROGRESS.to_status, check=reviewed("task_reviewer", verdict="needs_changes", return_to=RETURN_TO_IN_PROGRESS.to_status),
             change=record_verdict,
             label=RETURN_TO_IN_PROGRESS.choose_when, event_type=RETURN_TO_IN_PROGRESS.event_type),
        Edge("in_review", "fail_review", FAIL_TO_FAILED.to_status, check=reviewed("task_reviewer", verdict="fail", return_to=FAIL_TO_FAILED.to_status),
             change=record_verdict,
             label=FAIL_TO_FAILED.choose_when, event_type=FAIL_TO_FAILED.event_type),
        *(Edge(state, "mark_failed", "failed", label="Withdraw the task with a reason", tools=("task.transition",), suggest=False)
          for state in ("in_progress", "in_review")),
    ),
    outcomes={"done": "completed", "failed": "failed"},
)

METADATA = Metadata(effects={"accept": ("record_outcome",), "mark_failed": ("record_failure",)})

KIND = RecordKind(
    name="task", table="tasks", id_prefix="task", workflow=TASK,
    metadata=METADATA, created_event="task.created",
    columns=("name", "goal", "deliverables_json"), json_columns={"deliverables_json": ("deliverables", "[]")},
    dependencies=True, seal_exempt_actions=frozenset({"revise", "fail_review", "migrate"}),
    commit_columns={"revise": ("revision_context",), "fail_review": ("revision_context",),
                    "accept": ("outcome",)},
)
