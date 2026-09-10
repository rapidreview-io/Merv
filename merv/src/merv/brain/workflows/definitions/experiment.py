"""Experiment decisions and agent handoffs, independent of persistence and dispatch."""

from __future__ import annotations


from .artifact_roles import EXHIBIT_ROLE
from merv.shared.markdown_images import markdown_image_links

from ..graph import Action, Brief, Change, Edge, Issue, Node, Reference, Workflow, all_of
from .checks import review_requested, reviewed
from .execution import EXPERIMENT_EXECUTION, REVIEW_EXECUTION
from .documents import graph_problems, markdown_section_body, plan_sections_missing, preferred_artifact, report_problems
from .metadata import ArtifactNeed, Metadata, ReviewGate, ReviewReturn


ARTIFACTS = {
    "plan": ArtifactNeed("plan", "an experiment plan artifact must be submitted before design review", "plan_required",
                         "write_and_submit_plan", validator="plan", label="Plan submitted and valid", missing="experiment plan artifact", artifact_key="plan"),
    "result": ArtifactNeed("result", "result artifact must be submitted before experiment_review", "execution_ready",
                           "run_experiment_and_retain_results", label="Result artifact present", missing="result artifact", artifact_key="result"),
    "report": ArtifactNeed("report", "a results report must be retained before experiment_review", "results_report_required",
                           "write_and_submit_results_report", validator="report", label="Results report present and valid", missing="results report artifact", artifact_key="report"),
    "graph": ArtifactNeed("graph", "a logic graph must be retained before experiment_review", "logic_graph_required",
                          "write_and_submit_logic_graph", validator="graph", label="Logic graph present and valid", missing="logic graph artifact", artifact_key="graph"),
}

RETURN_TO_PLANNED = ReviewReturn("planned", "new", event_type="experiment.returned_to_planned",
                               choose_when="The plan itself is flawed and must be revised.", default=True)
RETURN_TO_RUNNING = ReviewReturn("running", "same", event_type="experiment.returned_to_running",
                               choose_when="The plan stands, but execution or the conclusion needs work.",
                               revision="The approved plan stands; fix execution or conclusions, then resubmit results.")


def artifact_check(role):
    """Select and validate the submitted bytes; caller payload never supplies facts."""
    def check(snapshot, knowledge):
        experiment = knowledge.read(Reference("experiment", snapshot.id))
        artifact = preferred_artifact(artifacts=experiment.get("current_attempt_artifacts") or [], roles=(role,))
        need = ARTIFACTS[role]
        if artifact is None:
            return need.issue()
        document = knowledge.read(Reference("artifact", str(artifact["id"])))
        error = str(document.get("error") or "")
        if not error and role != "result":
            text = str(document.get("text") or "")
            path, figures = str(document.get("path") or ""), set(document.get("figure_links") or ())
            def figure_problem(link):
                if link not in figures:
                    return (f"figure {link!r} has no submitted content: make sure the file exists next to {path} "
                            f"(copy it out first if it was produced on the sandbox), then resubmit the {role} to submit it")
            if role == "plan":
                missing_sections = plan_sections_missing(text)
                if missing_sections:
                    error = ("experiment plan is missing required sections before design review: " + ", ".join(missing_sections)
                             + ". Fill in the plan template's required spine — Summary; Objective & hypothesis; Evaluation — then resubmit the plan.")
                else:
                    problems = [problem for link in markdown_image_links(text) if (problem := figure_problem(link))]
                    error = "experiment plan is not ready for design review: " + "; ".join(problems) if problems else ""
            elif role == "report":
                exhibit = preferred_artifact(artifacts=experiment.get("current_attempt_artifacts") or [], roles=(EXHIBIT_ROLE,))
                problems = report_problems(text, figure_problem=figure_problem, exhibit_path=exhibit["path"] if exhibit else None)
                error = "results report is not ready for experiment review: " + "; ".join(problems) if problems else ""
            elif role == "graph":
                problems = graph_problems(text)
                error = "logic graph is not ready for experiment review: " + "; ".join(problems) if problems else ""
        if error:
            return Issue(f"{role}_invalid", f"{need.missing}: {error}", need.action, need.tools)
    return check


def dependencies_ready(snapshot, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    pending = [item for item in experiment.get("dependencies") or () if not item.get("settled")]
    if pending:
        failed = [item for item in pending if item.get("failed")]
        names = ", ".join(f"{item.get('node_type')} {item.get('name') or item.get('id')} ({item.get('status')})" for item in failed or pending)
        return Issue("dependency_failed" if failed else "dependencies_pending",
                     f"A dependency ended without succeeding: {names}. Replan or end this experiment." if failed
                     else f"Execution is waiting for dependencies to finish: {names}.",
                     "wait_for_dependencies", ("workflow.status_and_next",))


def _references(artifacts):
    return tuple(Reference("artifact", str(item.get("artifact_id") or item.get("id")), str(item.get("role") or "Evidence"))
                 for item in artifacts if item.get("artifact_id") or item.get("id"))


def _short(value, words):
    parts = str(value or "").split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def approved_plan_artifacts(snapshot, knowledge):
    if snapshot.data.get("approved_plan_artifacts"):
        return snapshot.data["approved_plan_artifacts"]
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    for review in knowledge.read(Reference("review_history", "design_reviewer")).get("reviews") or ():
        if review.get("verdict") == "pass" and review.get("attempt_index") == experiment.get("attempt_index"):
            return tuple(item for item in review.get("artifacts") or () if item.get("role") == "plan")
    return ()


def _intro(snapshot, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    project = knowledge.read(Reference("project", snapshot.project_id))
    claims = "; ".join(str(item.get("statement") or item.get("id")) for item in experiment.get("tested_claims") or ())
    text = (f"Experiment {experiment.get('name', snapshot.id)}, attempt {experiment.get('attempt_index', 1)}. "
            f"Project: {_short(project.get('name', snapshot.project_id), 10)} — {_short(project.get('summary') or 'Read project context for its purpose.', 22)}\n"
            f"Intent: {_short(experiment.get('intent', ''), 35)}\nConstraints: {_short(experiment.get('details') or 'No additional constraints.', 25)}\n"
            f"Claims: {_short(claims or 'No specific claims linked.', 25)}\n"
            f"Requested revisions: {_short(experiment.get('revision_context') or 'None.', 40)}\n\n")
    return experiment, text


def build_plan_context(snapshot, knowledge):
    experiment, intro = _intro(snapshot, knowledge)
    return Brief(intro +
        "Design a test that can resolve the intent and linked claims. Read the project graph and relevant earlier "
        "experiments through existing tools; focus on the decision this experiment should enable. Specify a falsifiable "
        "hypothesis, controls and comparisons, the data and compute budget, quantitative metrics where appropriate, "
        "and a decision rule that distinguishes meaningful outcomes. Make the plan detailed enough for a fresh "
        "agent to execute it without this conversation.\n\n"
        "Use prior attempt evidence and review findings to correct the design; a revised plan begins a new attempt. "
        "Keep useful retained artifacts and explain deliberate changes. Submit one complete plan with substantive "
        "Summary, Objective & hypothesis, and Evaluation sections. Any local figures must be uploaded with the "
        "document. Submit the design for independent review once its evidence is complete. The review determines "
        "whether this plan can test its claim; approval sends the workflow directly to execution.",
        (Reference("experiment", snapshot.id, "Experiment and prior attempts"), *_references(experiment.get("current_attempt_artifacts") or ())))


def _build_review_context(snapshot, knowledge, *, design):
    experiment, intro = _intro(snapshot, knowledge)
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    instructions = (
        "Independently review whether this plan can test its stated claim. Check the hypothesis, controls, measurement "
        "validity, confounds, budget and decision rule. Identify what evidence would disprove the claim and whether "
        "the proposed design could produce it. A rejection returns to planning and starts a new attempt; approval "
        "enters execution immediately. Follow the experiment-design-review skill."
        if design else
        "Independently review the completed attempt against the exact approved plan. Verify retained outputs, run "
        "receipts, metrics, results report and logic graph. Apply the original decision rule and check whether the "
        "conclusion follows from the evidence. Pass completes the experiment. For a rejection, choose planned when "
        "the plan must change (a new attempt), or running when the plan stands and execution or conclusions need "
        "repair (the same attempt). Follow the experiment-attempt-review skill."
    )
    approved = () if design else approved_plan_artifacts(snapshot, knowledge)
    return Brief(intro + instructions + "\n\n"
        "This is an independent, read-only assignment apart from the review verdict. Start the supplied review with "
        "your own reviewer identity. Grade the immutable submission referenced here; read surrounding project "
        "knowledge through existing tools as needed. Check the producer's claims rather than repeating them, "
        "record concrete findings with supporting evidence, and submit the verdict through review.submit. A later "
        "agent receives those findings in a separate assignment. Do not rerun completed work merely to recreate "
        "the producer's context; inspect its retained outputs and durable receipts first.",
        (Reference("experiment", snapshot.id, "Experiment goal"),
         *((Reference("review_request", str(pinned["request_id"]), "Independent review capability"),) if pinned.get("request_id") else ()),
         *_references(approved), *_references(pinned.get("artifacts") or ())))


def build_design_review_context(snapshot, knowledge):
    return _build_review_context(snapshot, knowledge, design=True)


def build_attempt_review_context(snapshot, knowledge):
    return _build_review_context(snapshot, knowledge, design=False)


def build_execution_context(snapshot, knowledge):
    experiment, intro = _intro(snapshot, knowledge)
    approved = approved_plan_artifacts(snapshot, knowledge)
    return Brief(intro +
        "Execute the exact approved plan referenced below. Read its decision rule before starting, then inspect "
        "retained results, tracking records and durable run receipts to establish what already finished and what "
        "remains. A new agent assignment does not mean a new experiment: keep completed jobs, attach to live "
        "work and recover its outputs. Start another job only for work still needed or an explicitly justified retry. "
        "Dependencies must have succeeded before execution is dispatched.\n\n"
        "For execution or conclusion revisions, preserve the approved plan and address the review findings in this "
        "attempt. If the plan itself is invalid, return through review to a new planning attempt. Record checkpoints "
        "and retained evidence so another agent can continue without this conversation.\n\n"
        "Submit compact machine-readable results, a report with Summary, Results, Deviations from plan and "
        "Conclusion, and a logic graph explaining the key decisions. Use the system metrics exhibit when one is "
        "available: preview it with experiment.exhibit; submit_results pins metrics_exhibit.json as the record "
        "of this attempt's runs. Apply the approved decision rule. Submit results for independent review only when the "
        "planned work and requested corrections are complete.",
        (Reference("experiment", snapshot.id, "Durable progress and tracking"), *_references(approved),
         *_references(item for item in experiment.get("current_attempt_artifacts") or () if item.get("role") != "plan")))


def pin_approved_plan(snapshot, payload, knowledge):
    approved = knowledge.read(Reference("review", "design_reviewer"))
    return Change(data={"approved_plan_snapshot": approved["snapshot_id"],
                        "approved_plan_artifacts": [dict(item) for item in approved.get("artifacts") or () if item.get("role") == "plan"]})


def _review_revision(snapshot, knowledge):
    role = "design_reviewer" if snapshot.state == "design_review" else "experiment_reviewer"
    fact = knowledge.read(Reference("review", role))
    from .checks import review_summary
    return review_summary(fact)


def return_plan(snapshot, payload, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    return Change(data={"attempt_index": int(experiment.get("attempt_index") or 1) + 1,
                        "revision_context": _review_revision(snapshot, knowledge),
                        "approved_plan_snapshot": "", "approved_plan_artifacts": []})


def return_execution(snapshot, payload, knowledge):
    return Change(data={"revision_context": "The approved plan stands; fix execution or conclusions. " + _review_revision(snapshot, knowledge)})


def retry_execution(snapshot, payload, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    reason = str(payload.get("reason") or "infrastructure failure").strip()
    detail = str(payload.get("detail") or payload.get("notes") or payload.get("note") or "").strip()
    text = ("Infrastructure retry requested while experiment was running. Approved plan and current attempt stay "
            "in force; recover retained outputs and rerun only unfinished or failed execution before submit_results. "
            f"Reason: {reason}." + (f" Detail: {detail}" if detail else ""))
    previous = str(experiment.get("revision_context") or "")
    return Change(data={"revision_context": f"{previous}\n\n{text}".strip()})


def tracking_action(kind, snapshot, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    return Action(kind, {"experiment_id": snapshot.id, "attempt_index": int(experiment.get("attempt_index") or 1),
                         "run_id": str(experiment.get("mlflow_run_id") or "")})


def request_review(role, snapshot):
    return Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": role})


def submit_design(snapshot, payload, knowledge):
    return Change(actions=(request_review("design_reviewer", snapshot),))


def finish_execution(snapshot, payload, knowledge):
    return Change(actions=(tracking_action("experiment.finish_tracking", snapshot, knowledge),
                           request_review("experiment_reviewer", snapshot)))


def stop_execution(snapshot, payload, knowledge):
    return Change(actions=(tracking_action("experiment.stop_tracking", snapshot, knowledge),))


def fail_execution(snapshot, payload, knowledge):
    return Change(actions=(tracking_action("experiment.fail_tracking", snapshot, knowledge),))


def conclude(snapshot, payload, knowledge):
    text = payload.get("conclusion")
    if not isinstance(text, str) or not text.strip():
        review = knowledge.read(Reference("review", "experiment_reviewer"))
        report = next((item for item in review.get("artifacts") or () if item.get("role") == "report"), None)
        document = {} if report is None else knowledge.read(Reference("artifact", str(report.get("artifact_id") or report.get("id"))))
        text = markdown_section_body(str(document.get("text") or ""), "conclusion") or str(review.get("notes") or "")
    return Change(data={"conclusion": text.strip()},
                  actions=(tracking_action("experiment.finish_tracking", snapshot, knowledge),))


def rejected(role, return_to):
    def check(snapshot, knowledge):
        fact = knowledge.read(Reference("review", role))
        if fact.get("verdict") not in {"needs_changes", "fail"} or fact.get("return_to") != return_to:
            return Issue(f"{role}_required", f"An independent rejected review returning to {return_to!r} is required.", "request_review", ("review.request",))
    return check


def start_execution(snapshot, payload, knowledge):
    return Change(actions=(tracking_action("experiment.start_tracking", snapshot, knowledge),))


EXPERIMENT = Workflow(
    name="experiment", version=1, initial="planned", event_type="experiment.transitioned", id_prefix="exp",
    nodes=(
        Node("planned", "Design experiment", "experiment_owner", build_plan_context, execution=EXPERIMENT_EXECUTION),
        Node("design_review", "Review experiment design", "design_reviewer", build_design_review_context, review_requested, execution=REVIEW_EXECUTION),
        Node("running", "Execute approved plan", "experiment_owner", build_execution_context, dependencies_ready,
             execution=EXPERIMENT_EXECUTION, on_start=start_execution),
        Node("experiment_review", "Review completed attempt", "experiment_reviewer", build_attempt_review_context, review_requested, execution=REVIEW_EXECUTION),
    ),
    edges=(
        Edge("planned", "submit_design", "design_review", check=artifact_check("plan"), change=submit_design, label="Submit the plan for independent review", tools=("experiment.transition",)),
        Edge("design_review", "approve_design", "running", check=reviewed("design_reviewer"), change=pin_approved_plan, label="Execute the approved plan", tools=("experiment.transition",)),
        Edge("design_review", "revise_plan", RETURN_TO_PLANNED.to_status, check=rejected("design_reviewer", RETURN_TO_PLANNED.to_status), change=return_plan, label=RETURN_TO_PLANNED.choose_when, event_type=RETURN_TO_PLANNED.event_type),
        Edge("running", "submit_results", "experiment_review", check=all_of(*(artifact_check(role) for role in ("result", "report", "graph"))), change=finish_execution, label="Submit the completed attempt for review", tools=("experiment.transition",)),
        Edge("running", "retry_running", "running", change=retry_execution, label="Recover interrupted execution", tools=("experiment.transition",), suggest=False),
        Edge("experiment_review", "complete", "complete", check=reviewed("experiment_reviewer"), change=conclude, label="Accept the reviewed conclusion", tools=("experiment.transition",)),
        Edge("experiment_review", "revise_plan", RETURN_TO_PLANNED.to_status, check=rejected("experiment_reviewer", RETURN_TO_PLANNED.to_status), change=return_plan, label=RETURN_TO_PLANNED.choose_when, event_type=RETURN_TO_PLANNED.event_type),
        Edge("experiment_review", "revise_execution", RETURN_TO_RUNNING.to_status, check=rejected("experiment_reviewer", RETURN_TO_RUNNING.to_status), change=return_execution, label=RETURN_TO_RUNNING.choose_when, event_type=RETURN_TO_RUNNING.event_type),
        *(Edge(state, name, target, change=change, label=label, tools=("experiment.transition",), suggest=False)
          for state in ("planned", "design_review", "running", "experiment_review")
          for name, target, label, change in (("abandon", "abandoned", "Abandon experiment", stop_execution), ("mark_failed", "failed", "End failed experiment", fail_execution))),
    ),
    outcomes={"complete": "completed", "abandoned": "abandoned", "failed": "failed"},
)

METADATA = Metadata(
    requirements={"planned": (ARTIFACTS["plan"],), "running": tuple(ARTIFACTS[role] for role in ("result", "report", "graph"))},
    reviews={
        "design_review": ReviewGate("design_reviewer", "design review must pass before execution", "design_review_required",
                                    "Design review passed", "experiment-design-review", "approve_design", (RETURN_TO_PLANNED,),
                                    forbidden_returns=(("running", "experiment-design-review rejections cannot return_to 'running'; a flawed plan goes back to 'planned'"),)),
        "experiment_review": ReviewGate("experiment_reviewer", "experiment review must pass before complete", "experiment_review_required",
                                        "Experiment review passed", "experiment-attempt-review", "complete", (RETURN_TO_PLANNED, RETURN_TO_RUNNING),
                                        return_choice_required=True, return_required_error="experiment-attempt-review rejections must set return_to: 'planned' if the plan is flawed, or 'running' if execution or the conclusion needs repair"),
    },
    effects={"submit_results": ("result_submission", "prepare_metrics_exhibit", "finish_tracking"),
             "retry_running": ("record_retry_context", "show_metrics_exhibit"),
             "complete": ("record_conclusion", "finish_tracking"),
             "abandon": ("stop_tracking",), "mark_failed": ("fail_tracking",)},
)
