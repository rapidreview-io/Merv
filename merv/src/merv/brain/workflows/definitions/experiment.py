"""Experiment decisions and agent handoffs, independent of persistence and dispatch."""

from __future__ import annotations

from dataclasses import dataclass

from merv.shared.markdown_images import markdown_image_links

from ..graph import (
    Action, ArtifactNeed, Change, DependenciesDone, Edge, Guidance, Issue, Node, RecordKind,
    Metadata, Reference, ReviewGate, ReviewReturn, Workflow,
)
from .artifact_roles import EXHIBIT_ROLE
from .checks import project_brief, evidence_references, rejected, review_summary, short
from .documents import (REQUIRED_PLAN_SECTIONS, graph_problems, markdown_section_body, preferred_artifact,
                        report_problems, required_markdown_sections_missing)
from .execution import RESEARCH_HANDOFF, EXPERIMENT_EXECUTION, REVIEW_EXECUTION
from .research_contracts import REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD
from .research_state import ExperimentState


def _figure_problem(role, path, figures):
    def problem(link):
        if link not in figures:
            return (f"figure {link!r} has no submitted content: make sure the file exists next to {path} "
                    f"(copy it out first if it was produced on the sandbox), then resubmit the {role} to submit it")
    return problem


def _plan_problems(document, snapshot, knowledge):
    text = str(document.get("text") or "")
    missing_sections = required_markdown_sections_missing(text, REQUIRED_PLAN_SECTIONS)
    if missing_sections:
        return ("experiment plan is missing required sections before design review: " + ", ".join(missing_sections)
                + ". Fill in the plan template's required spine — Summary; Objective & hypothesis; Evaluation — "
                "then resubmit the plan.",)
    figure = _figure_problem("plan", str(document.get("path") or ""), set(document.get("figure_links") or ()))
    problems = [problem for link in markdown_image_links(text) if (problem := figure(link))]
    return ("experiment plan is not ready for design review: " + "; ".join(problems),) if problems else ()


def _report_problems(document, snapshot, knowledge):
    experiment = knowledge.read(Reference("experiment", snapshot.id))
    exhibit = preferred_artifact(artifacts=experiment.get("current_attempt_artifacts") or [], roles=(EXHIBIT_ROLE,))
    figure = _figure_problem("report", str(document.get("path") or ""), set(document.get("figure_links") or ()))
    problems = report_problems(str(document.get("text") or ""), figure_problem=figure,
                               exhibit_path=exhibit["path"] if exhibit else None)
    return ("results report is not ready for experiment review: " + "; ".join(problems),) if problems else ()


def _graph_problems(document, snapshot, knowledge):
    problems = graph_problems(str(document.get("text") or ""))
    return ("logic graph is not ready for experiment review: " + "; ".join(problems),) if problems else ()


ARTIFACTS = {
    "plan": ArtifactNeed("plan", "an experiment plan artifact must be submitted before design review", "plan_required",
                         "write_and_submit_plan", validator="plan", label="Plan submitted and valid", missing="experiment plan artifact",
                         artifact_key="plan", actions=("submit_design",), validate=_plan_problems,
                         invalid="experiment plan artifact: {problems}"),
    "result": ArtifactNeed("result", "result artifact must be submitted before experiment_review", "execution_ready",
                           "run_experiment_and_retain_results", label="Result artifact present", missing="result artifact",
                           artifact_key="result", actions=("submit_results",), invalid="result artifact: {problems}"),
    "report": ArtifactNeed("report", "a results report must be retained before experiment_review", "results_report_required",
                           "write_and_submit_results_report", validator="report", label="Results report present and valid",
                           missing="results report artifact", artifact_key="report", actions=("submit_results",),
                           validate=_report_problems, invalid="results report artifact: {problems}"),
    "graph": ArtifactNeed("graph", "a logic graph must be retained before experiment_review", "logic_graph_required",
                          "write_and_submit_logic_graph", validator="graph", label="Logic graph present and valid",
                          missing="logic graph artifact", artifact_key="graph", actions=("submit_results",),
                          validate=_graph_problems, invalid="logic graph artifact: {problems}"),
}
DEPENDENCIES = DependenciesDone()

RETURN_TO_PLANNED = ReviewReturn("planned", "new", event_type="experiment.returned_to_planned",
                               choose_when="The plan itself is flawed and must be revised.", default=True,
                               revision="Revise the plan for a new attempt; follow research-workflow.")
RETURN_TO_RUNNING = ReviewReturn("running", "same", event_type="experiment.returned_to_running",
                               choose_when="The plan stands, but execution or the conclusion needs work.",
                               revision="The approved plan stands; fix execution or conclusions, then resubmit results.")


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
    claims = "; ".join(str(item.get("statement") or item.get("id")) for item in experiment.get("tested_claims") or ())
    text = (f"Experiment {experiment.get('name', snapshot.id)}, attempt {experiment.get('attempt_index', 1)}. "
            f"Intent: {short(experiment.get('intent', ''), 35)}\nConstraints: {short(experiment.get('details') or 'No additional constraints.', 25)}\n"
            f"Claims: {short(claims or 'No specific claims linked.', 25)}\n"
            f"Requested revisions: {short(experiment.get('revision_context') or 'None.', 40)}\n\n")
    return experiment, text


def build_plan_context(snapshot, knowledge):
    experiment, intro = _intro(snapshot, knowledge)
    return project_brief(snapshot, knowledge, intro + "Design a falsifiable test of the intent and linked claims; submit its complete plan for independent review. "
        "Follow the research-workflow skill, including prior-attempt revisions.",
        (Reference("experiment", snapshot.id, "Experiment and prior attempts"), *evidence_references(experiment.get("current_attempt_artifacts") or ())))


def _build_review_context(snapshot, knowledge, *, design):
    experiment, intro = _intro(snapshot, knowledge)
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    instructions = ("Verify whether the pinned plan can test its claim. Follow experiment-design-review."
                    if design else "Verify the completed attempt against its exact approved plan. Follow experiment-attempt-review.")
    approved = () if design else approved_plan_artifacts(snapshot, knowledge)
    return project_brief(snapshot, knowledge, intro + instructions,
        (Reference("experiment", snapshot.id, "Experiment goal"),
         *((Reference("review_request", str(pinned["request_id"]), "Independent review capability"),) if pinned.get("request_id") else ()),
         *evidence_references(approved), *evidence_references(pinned.get("artifacts") or ())))


def build_design_review_context(snapshot, knowledge):
    return _build_review_context(snapshot, knowledge, design=True)


def build_attempt_review_context(snapshot, knowledge):
    return _build_review_context(snapshot, knowledge, design=False)


def build_execution_context(snapshot, knowledge):
    experiment, intro = _intro(snapshot, knowledge)
    approved = approved_plan_artifacts(snapshot, knowledge)
    return project_brief(snapshot, knowledge, intro + "Execute the exact approved plan; keep completed jobs and recover retained outputs before repeating work. "
        "Address this attempt's revisions and apply the approved decision rule. Follow research-workflow. "
        "Preview experiment.exhibit; interpret metrics_exhibit.json when pinned. Submit the completed evidence for review.",
        (Reference("experiment", snapshot.id, "Durable progress"), *evidence_references(approved),
         *evidence_references(item for item in experiment.get("current_attempt_artifacts") or () if item.get("role") != "plan")))


def pin_approved_plan(snapshot, payload, knowledge):
    approved = knowledge.read(Reference("review", "design_reviewer"))
    return Change(data={"approved_plan_snapshot": approved["snapshot_id"],
                        "approved_plan_artifacts": [dict(item) for item in approved.get("artifacts") or () if item.get("role") == "plan"]})


def _review_revision(snapshot, knowledge):
    role = "design_reviewer" if snapshot.state == "design_review" else "experiment_reviewer"
    return review_summary(knowledge.read(Reference("review", role)))


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


def request_review(role, snapshot):
    return Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": role})


def submit_design(snapshot, payload, knowledge):
    return Change(actions=(request_review("design_reviewer", snapshot),))


def finish_execution(snapshot, payload, knowledge):
    return Change(actions=(request_review("experiment_reviewer", snapshot),))


def conclude(snapshot, payload, knowledge):
    text = payload.get("conclusion")
    if not isinstance(text, str) or not text.strip():
        review = knowledge.read(Reference("review", "experiment_reviewer"))
        report = next((item for item in review.get("artifacts") or () if item.get("role") == "report"), None)
        document = {} if report is None else knowledge.read(Reference("artifact", str(report.get("artifact_id") or report.get("id"))))
        text = markdown_section_body(str(document.get("text") or ""), "conclusion") or str(review.get("notes") or "")
    return Change(data={"conclusion": text.strip()})


DESIGN_REVIEW = ReviewGate("design_reviewer", "design review must pass before execution", "design_review_required",
                           "Design review passed", "experiment-design-review", "approve_design", (RETURN_TO_PLANNED,),
                           forbidden_returns=(("running", "experiment-design-review rejections cannot return_to 'running'; a flawed plan goes back to 'planned'"),),
                           actions=("approve_design",))
ATTEMPT_REVIEW = ReviewGate("experiment_reviewer", "experiment review must pass before complete", "experiment_review_required",
                            "Experiment review passed", "experiment-attempt-review", "complete", (RETURN_TO_PLANNED, RETURN_TO_RUNNING),
                            return_choice_required=True,
                            return_required_error="experiment-attempt-review rejections must set return_to: 'planned' if the plan is flawed, or 'running' if execution or the conclusion needs repair",
                            actions=("complete",))

EXPERIMENT = Workflow(
    name="experiment", version=1, initial="planned", event_type="experiment.transitioned", id_prefix="exp",
    nodes=(
        Node("planned", "Design experiment", "experiment_owner", build_plan_context,
             guidance=Guidance("research-workflow", RESEARCH_HANDOFF, messages={
                 "folder": ("Use {folder} as the experiment's one local folder. "
                     "Create it yourself before working in it: plan.md, scripts, configs, "
                     "retained results, report, and graph all live there. This local folder "
                     "is not uploaded to a sandbox automatically: create, fetch, or explicitly "
                     "transfer sandbox inputs after provisioning. Pull selected light outputs "
                     "back with sandbox.pull_outputs, or upload heavy outputs to configured "
                     "object storage, before the sandbox is released."),
                 "feed_update": "{entity} just had a workflow update"}), execution=EXPERIMENT_EXECUTION,
             requires=(ARTIFACTS["plan"],)),
        Node("design_review", "Review experiment design", "design_reviewer", build_design_review_context, guidance=Guidance(DESIGN_REVIEW.skill, RESEARCH_HANDOFF),
             execution=REVIEW_EXECUTION, requires=(DESIGN_REVIEW,)),
        Node("running", "Execute approved plan", "experiment_owner", build_execution_context,
             guidance=Guidance("research-workflow", RESEARCH_HANDOFF, messages={
                 "exhibit": ("Retain every quantitative run as a role-'result' JSON or "
                     "CSV artifact, including failed and aborted runs, plus the "
                     "figures used by the report. At submit_results the system "
                     "evaluates the attempt's submitted result evidence. Preview "
                     "the current exhibit with experiment.exhibit; when one is "
                     "pinned at {path}, report.md must reference and interpret "
                     "{filename}.")}), execution=EXPERIMENT_EXECUTION,
             requires=(ARTIFACTS["result"], ARTIFACTS["report"], ARTIFACTS["graph"], DEPENDENCIES)),
        Node("experiment_review", "Review completed attempt", "experiment_reviewer", build_attempt_review_context,
             guidance=Guidance(ATTEMPT_REVIEW.skill, RESEARCH_HANDOFF,
                               messages={"experiment_review_verdict": "a review verdict just landed on {entity}"}),
             execution=REVIEW_EXECUTION, requires=(ATTEMPT_REVIEW,)),
    ),
    edges=(
        Edge("planned", "submit_design", "design_review", change=submit_design, label="Submit the plan for independent review", tools=("experiment.transition",)),
        Edge("design_review", "approve_design", "running", change=pin_approved_plan, label="Execute the approved plan", tools=("experiment.transition",)),
        Edge("design_review", "revise_plan", RETURN_TO_PLANNED.to_status, check=rejected("design_reviewer", RETURN_TO_PLANNED.to_status), change=return_plan, label=RETURN_TO_PLANNED.choose_when, event_type=RETURN_TO_PLANNED.event_type),
        Edge("running", "submit_results", "experiment_review", change=finish_execution, label="Submit the completed attempt for review", tools=("experiment.transition",)),
        Edge("running", "retry_running", "running", change=retry_execution, label="Recover interrupted execution", tools=("experiment.transition",), suggest=False),
        Edge("experiment_review", "complete", "complete", change=conclude, label="Accept the reviewed conclusion", tools=("experiment.transition",)),
        Edge("experiment_review", "revise_plan", RETURN_TO_PLANNED.to_status, check=rejected("experiment_reviewer", RETURN_TO_PLANNED.to_status), change=return_plan, label=RETURN_TO_PLANNED.choose_when, event_type=RETURN_TO_PLANNED.event_type),
        Edge("experiment_review", "revise_execution", RETURN_TO_RUNNING.to_status, check=rejected("experiment_reviewer", RETURN_TO_RUNNING.to_status), change=return_execution, label=RETURN_TO_RUNNING.choose_when, event_type=RETURN_TO_RUNNING.event_type),
        *(Edge(state, name, target, label=label, tools=("experiment.transition",), suggest=False)
          for state in ("planned", "design_review", "running", "experiment_review")
          for name, target, label in (("abandon", "abandoned", "Abandon experiment"), ("mark_failed", "failed", "End failed experiment"))),
    ),
    outcome_guidance={
        "completed": Guidance(messages={"experiment_complete": "{entity} just completed"}),
        "failed": Guidance(messages={"experiment_failed": "{entity} just failed"}),
        "abandoned": Guidance(messages={"experiment_abandoned": "{entity} was just abandoned"}),
    },
    outcomes={"complete": "completed", "abandoned": "abandoned", "failed": "failed"},
)

METADATA = Metadata(
    effects={"submit_results": ("result_submission", "prepare_metrics_exhibit"),
             "retry_running": ("record_retry_context", "show_metrics_exhibit"),
             "complete": ("record_conclusion",)},
)

@dataclass(frozen=True, slots=True)
class ReflectionFreshness:
    """Block a new experiment once enough finished ones await a published reflection."""

    threshold: int = REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD

    def blocked(self, facts):
        return facts.get("new_terminal_since_publish", 0) >= self.threshold

    def message(self, facts):
        since = ("since the last published reflection" if facts.get("last_published_reflection_id")
                 else "and no project reflection has been published yet")
        open_id = facts.get("open_reflection_id")
        return (f"project reflection is required before creating another experiment: "
                f"{facts.get('new_terminal_since_publish', 0)} experiments have finished {since} (threshold {self.threshold}); "
                + (f"finish and publish open reflection wave {open_id} first." if open_id
                   else "start one with reflection.create and publish it before creating another experiment."))

    def check(self, facts):
        if self.blocked(facts):
            return Issue("reflection_required", self.message(facts),
                         "start_project_reflection_before_next_experiment", ("reflection.create",))


KIND = RecordKind(
    name="experiment", table="experiments", id_prefix="exp", workflow=EXPERIMENT,
    construct=ExperimentState.construct, metadata=METADATA, created_event="experiment.created",
    columns=("name", "intent", "details"), dependencies=True, creation_requires=(ReflectionFreshness(),),
    seal_exempt_actions=frozenset({"revise_plan", "revise_execution", "migrate"}),
    commit_columns={"revise_plan": ("attempt_index", "revision_context"),
                    "revise_execution": ("revision_context",), "retry_running": ("revision_context",),
                    "complete": ("conclusion",)},
    # An agent reads the claim follow-ups as the answer to the gate it just saw.
)
