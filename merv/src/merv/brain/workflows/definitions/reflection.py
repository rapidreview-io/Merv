"""Reflection decisions and independent lens, synthesis, and review assignments."""

from ..composition import Child, join_guard
from ..graph import Action, Brief, Change, Edge, Issue, Node, Reference, Workflow, all_of
from ...kernel.utils import NotFoundError, ValidationError, WorkflowError
from .checks import review_requested, reviewed, review_summary
from .execution import CONSOLIDATION_EXECUTION, LENS_EXECUTION, REFLECTION_EXECUTION, REVIEW_EXECUTION
from .documents import graph_problems, reflection_doc_review_problems, reflection_lens_doc_problems, parse_change_spec, preferred_artifact
from .metadata import ArtifactNeed, Metadata, RecordNeed, ReviewGate, ReviewReturn


ARTIFACTS = {
    "reflection_lens_doc": ArtifactNeed("reflection_lens_doc", "Every roster lens must submit its own reflection with a non-empty Summary.",
                                       "reflection_roster_incomplete", "fan_out_reflection_subagents", validator="roster",
                                       label="Per-lens reflections submitted", missing="one reflection document per roster lens", artifact_key="reflection"),
    **{role: ArtifactNeed(role, f"A {title} artifact must be submitted before reflection review.", f"{role}_required", f"submit_{role}",
                         validator=validator, label=f"{title.capitalize()} present and valid", missing=f"{title} artifact", artifact_key=role)
       for role, title, validator in (("project_graph", "project logic graph", "graph"),
                                     ("reflection_doc", "reflection document", "reflection_doc"), ("change_spec", "change spec", "change_spec"))},
}
PROPOSAL_NEED = RecordNeed("consolidation_proposal", "The consolidation agent must submit one proposal that accounts for every experiment in the reflection corpus.",
                           "consolidation_proposal_required", "submit_consolidation_proposal", ("consolidation.submit",),
                           label="Every experiment reviewed for consolidation", missing="a complete consolidation proposal")
CENTRAL_ADVANCE_NEED = RecordNeed("central_advance", "The Merv runner must bind the reviewed proposal to the central Git ref before the reflection can publish.",
                                 "central_advance_required", "wait_for_central_advance", label="Reviewed proposal bound to central", missing="the runner's central-advance receipt")
RETURN_TO_REFLECTING = ReviewReturn("reflecting", "new", event_type="reflection.returned_to_reflecting",
                                   choose_when="The lens reflections or coverage require a fresh attempt.",
                                   revision="Every roster lens must submit a fresh reflection for the new attempt.")
RETURN_TO_SYNTHESIZING = ReviewReturn("synthesizing", "same", event_type="reflection.returned_to_synthesizing",
                                     choose_when="The lenses stand; revise the graph, reflection document or change spec.", default=True,
                                     revision="Keep the completed lenses and revise the reflection artifacts.")
RETURN_TO_CONSOLIDATING = ReviewReturn("consolidating", "same", event_type="reflection.consolidation_returned",
                                      choose_when="The code proposal or its validation needs repair; the reviewed reflection stands.",
                                      revision="Revise only the code proposal and submit it for independent review.")


def _wave(snapshot, knowledge):
    return knowledge.read(Reference("reflection", str(snapshot.data.get("reflection_id") or snapshot.id)))


def _refs(artifacts):
    return tuple(Reference("artifact", str(item.get("artifact_id") or item.get("id")),
                           str(item.get("role") or item.get("label") or "Evidence"))
                 for item in artifacts if item.get("artifact_id") or item.get("id"))


def _review_refs(pinned):
    return (Reference("review_request", str(pinned["request_id"]), "This independent review request"),
            *_refs(pinned.get("artifacts") or ()),
            *((Reference("code", str(pinned["code_sha"]), "Exact submitted code proposal"),) if pinned.get("code_sha") else ()))


def _artifact(wave, role, lens_id=""):
    return preferred_artifact(artifacts=[item for item in wave.get("current_attempt_artifacts") or ()
                                        if not lens_id or item.get("lens_id") == lens_id], roles=(role,))


def _document(knowledge, artifact):
    return knowledge.read(Reference("artifact", str(artifact.get("artifact_id") or artifact["id"])))


def lens_issue(wave, knowledge, lens_id):
    artifact = _artifact(wave, "reflection_lens_doc", lens_id)
    if artifact is None:
        return Issue("reflection_roster_incomplete", f"Reflection is missing for lens {lens_id!r}; submit its own reflection_lens_doc with that lens_id.",
                     "fan_out_reflection_subagents", ("artifact.upload",))
    try:
        problems = reflection_lens_doc_problems(_document(knowledge, artifact)["text"])
    except (NotFoundError, ValidationError, WorkflowError) as exc:
        problems = (str(exc),)
    if problems:
        return Issue("reflection_lens_doc_invalid", f"Reflection for lens {lens_id!r} is not ready: " + "; ".join(problems)
                     + ". Add a non-empty ## Summary and resubmit it.", "revise_lens_reflection", ("artifact.upload",))


def lenses_complete(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    issues = tuple(issue for lens in wave.get("roster") or ()
                   if (issue := lens_issue(wave, knowledge, str(lens["id"]))) is not None)
    return issues


def _artifact_check(role, validator):
    def check(snapshot, knowledge):
        wave = _wave(snapshot, knowledge)
        artifact = _artifact(wave, role)
        need = ARTIFACTS[role]
        if artifact is None:
            return need.issue()
        try:
            document = _document(knowledge, artifact)
            problems = validator(document, snapshot, knowledge)
        except (NotFoundError, ValidationError, WorkflowError) as exc:
            problems = (str(exc),)
        if problems:
            return Issue(f"{role}_invalid", f"{need.missing.capitalize()} is not ready for reflection review: " + "; ".join(problems),
                         f"revise_{role}", ("artifact.upload",))
    return check


def _parse_spec(document, snapshot, knowledge):
    world = knowledge.read(Reference("reflection_world", snapshot.project_id))
    parse_change_spec(text=document["text"], path=document["path"],
                      claim_exists=lambda value: value in world["claim_ids"],
                      experiment_name_taken=lambda value: value.lower() in world["experiment_names"],
                      task_name_taken=lambda value: value.lower() in world["task_names"],
                      node_exists=lambda value: value in world["node_ids"],
                      non_terminal_experiments=lambda: list(world["non_terminal_experiments"]))
    return ()


project_graph = _artifact_check("project_graph", lambda document, *_: graph_problems(document["text"]))
reflection_document = _artifact_check("reflection_doc", lambda document, *_: reflection_doc_review_problems(
    text=document["text"], submitted_images=set(document.get("figure_links") or ()), path=document["path"]))
change_spec = _artifact_check("change_spec", _parse_spec)


def consolidation_proposal(snapshot, knowledge):
    consolidation = _wave(snapshot, knowledge).get("consolidation") or {}
    if not consolidation.get("proposal") or not (consolidation.get("coverage") or {}).get("complete"):
        return PROPOSAL_NEED.issue()


def central_advance(snapshot, knowledge):
    consolidation = _wave(snapshot, knowledge).get("consolidation") or {}
    proposal, advance = consolidation.get("proposal") or {}, consolidation.get("advance") or {}
    if not proposal or advance.get("status") != "bound" or advance.get("proposal_id") != proposal.get("id") or advance.get("observed_sha") != proposal.get("proposal_sha"):
        return CENTRAL_ADVANCE_NEED.issue()


def can_abandon(snapshot, knowledge):
    advance = (_wave(snapshot, knowledge).get("consolidation") or {}).get("advance") or {}
    if advance.get("status") == "bound":
        return Issue("central_already_advanced", "Central has already advanced for this wave; publication completes via the runner's settle retry. The wave cannot be abandoned once bound.",
                     "wait_for_runner_publish")


def _rejected(role, destination):
    def check(snapshot, knowledge):
        fact = knowledge.read(Reference("review", role))
        if fact.get("verdict") not in {"needs_changes", "fail"} or fact.get("return_to") != destination:
            return Issue("review_return_required", f"An authenticated {role} rejection returning to {destination!r} is required.")
    return check


def _revision(snapshot, payload, knowledge):
    wave = _wave(snapshot, knowledge)
    role = "consolidation_reviewer" if snapshot.state == "consolidation_review" else "reflection_reviewer"
    fact = knowledge.read(Reference("review", role))
    return Change(data={"attempt_index": int(wave["attempt_index"]),
                        "revision_context": review_summary(fact)})


def _new_attempt(snapshot, payload, knowledge):
    change = _revision(snapshot, payload, knowledge)
    return Change(data={**change.data, "attempt_index": int(change.data["attempt_index"]) + 1, "lens_artifacts": {}})


def _lens_children(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    children = []
    for lens in wave["roster"]:
        lens_id = str(lens["id"])
        data = {"reflection_id": snapshot.id, "attempt_index": int(wave["attempt_index"]), "lens_id": lens_id}
        complete = lens_issue(wave, knowledge, lens_id) is None
        if complete:
            artifact = _artifact(wave, "reflection_lens_doc", lens_id)
            data["artifact_id"] = str(artifact.get("artifact_id") or artifact["id"])
        children.append(Child(key=lens_id, workflow="reflection_lens", data=data, entry="submitted" if complete else ""))
    return tuple(children)


def _join_lenses(snapshot, knowledge):
    if snapshot.children and all(child.outcome == "submitted" for child in snapshot.children):
        return "submit_reflections"
    return None


def pin_lenses(snapshot, payload, knowledge):
    return Change(data={"lens_artifacts": {child.key: child.data["artifact_id"] for child in snapshot.children}})


def build_synthesis_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    corpus = wave.get("corpus") or {}
    return Brief(
        f"Reconcile reflection wave {wave.get('title') or snapshot.id}, attempt {wave['attempt_index']}. "
        f"The fixed corpus contains {len(corpus.get('terminal_experiments') or ())} completed experiments and "
        f"{len(corpus.get('terminal_tasks') or ())} completed tasks. Read the five independent lens reflections "
        "and their evidence, then resolve disagreements into the project's current research position.\n\n"
        f"Revision request: {wave.get('revision_context') or 'First synthesis of this lens set.'}\n\n"
        "The completed lens contributions stand unless the review explicitly sends the whole wave back to "
        "reflecting. Reuse their submitted work and the previous project graph; do not repeat their jobs. "
        "Produce the updated project logic graph, a concise reflection document that explains the scientific "
        "argument, and one machine-actionable change spec. Distinguish supported conclusions, failures, "
        "uncertainty, and the next falsifiable bets. Compare the new graph with the previous published graph "
        "and explain each changed belief. Task deliveries can inform the work without counting as scientific "
        "evidence for a claim. Retain negative results and counterexamples that constrain the next wave. "
        "Existing tools supply the detailed corpus and evidence.\n\n"
        "Submit complete artifact versions and request independent reflection review. The next agent gets "
        "this immutable evidence set, so attach the exact references behind each decision. Keep code "
        "consolidation for its later assignment; publication applies the approved change spec only after "
        "the reviewed code proposal has a central-advance receipt.",
        (Reference("reflection", snapshot.id, "Fixed reflection corpus and revision history"),
         *_refs(wave.get("current_attempt_artifacts") or ())),
    )


def build_review_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return Brief(
        f"Independently review reflection wave {wave.get('title') or snapshot.id}, attempt {wave['attempt_index']}. "
        "Grade the exact submitted graph, reflection document, change spec, and five lens reflections named "
        "in this immutable review snapshot against the fixed experiment/task corpus and previous graph.\n\n"
        "Trace conclusions to evidence, investigate disagreement across lenses, and check the change spec "
        "is the scientific update the evidence warrants. Compare claim changes and proposed experiments "
        "with the previous published graph. Test whether the next wave could distinguish the stated "
        "explanations, whether important failures were omitted, and whether task deliveries have been "
        "mistaken for experimental confirmation. Use existing tools for the detailed documents and "
        "history. Your role is read-only except for review.start and review.submit with your own reviewer "
        "identity; follow the project-reflection-review skill.\n\n"
        "Pass hands the approved research to code consolidation. A rejection must choose its ordinary "
        "return edge: reflecting when coverage or lens reasoning requires a fresh five-lens attempt; "
        "synthesizing when those contributions stand and only the reconciled artifacts need repair. "
        "Name the missing evidence and exact repair, so the next independent agent can start from the "
        "findings without this conversation. Do not rewrite the submitted evidence during the review.",
        (Reference("reflection", snapshot.id, "Fixed corpus and previous graph"), *_review_refs(pinned)),
    )


def build_consolidation_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    consolidation = wave.get("consolidation") or {}
    return Brief(
        f"Consolidate code for approved reflection wave {wave.get('title') or snapshot.id}. "
        "Its reviewed research conclusion is authoritative. Read that artifact snapshot, the per-experiment "
        "workspaces, and any retained proposal before changing code. Account for every experiment in the "
        "fixed corpus with a concrete integrate, retain, or discard decision and an evidence-backed reason.\n\n"
        f"Revision request: {wave.get('revision_context') or 'Initial code consolidation.'}\n"
        f"Retained proposal: {(consolidation.get('proposal') or {}).get('id') or 'None submitted.'}\n\n"
        "Reuse completed work and the recorded proposal; inspect whether it already satisfies the current "
        "findings before repeating anything. Identify the approved base SHA and the source SHA of each "
        "experiment branch before integration. Preserve reproducibility and the useful test coverage of "
        "retained changes, and make discarded or superseded approaches explicit so they remain available "
        "as research history. Make the smallest coherent code change, run the checks "
        "needed to prove it, and submit the immutable proposal SHA, validation, and per-experiment "
        "decisions through consolidation.submit. An independent consolidator reviewer will inspect that "
        "exact proposal. Rejection returns only to this code assignment; it cannot reopen the approved "
        "reflection or rerun its lenses. The runner performs the central advance and publication after "
        "approval. Finish with precise references that let the reviewer reproduce the checks.",
        (Reference("reflection", snapshot.id, "Approved reflection and consolidation progress"),
         *((Reference("code", str(proposal["base_sha"]), "Declared base of the retained proposal"),)
           if (proposal := consolidation.get("proposal") or {}).get("base_sha") else ()),
         *_refs(wave.get("current_attempt_artifacts") or ())),
    )


def build_consolidation_review_context(snapshot, knowledge):
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return Brief(
        f"Independently review code consolidation for reflection wave {snapshot.id}. "
        f"The exact proposal is {pinned.get('snapshot_token') or 'in the review packet'} at Git SHA "
        f"{pinned.get('code_sha') or 'recorded in the pinned proposal'}. Inspect that proposal, its tests, "
        "and the integrate/retain/discard decision for every experiment in the fixed reflection corpus.\n\n"
        "The reflection's scientific conclusion has already passed review and remains authoritative. "
        "Judge whether the proposed code faithfully implements it, whether discarded changes are "
        "accounted for, and whether the submitted validation demonstrates the result. Read the exact "
        "artifact versions in this request rather than later replacements. Investigate failure paths "
        "and unintended changes, then record the evidence you checked and concrete findings. Confirm the "
        "proposal starts from its declared base and that its actual diff matches the integration decisions. "
        "Reproduce the meaningful validation where feasible and distinguish observed checks from any "
        "claims you could not verify.\n\n"
        "Follow consolidation-review, use your own reviewer identity, and keep the assignment read-only "
        "except for review.start/review.submit. Pass permits the runner to bind this exact proposal to "
        "central and publish the wave. Needs_changes or fail must return_to='consolidating'; the next "
        "agent repairs only code, validation, or per-experiment integration decisions. Do not return to "
        "reflecting or synthesizing. Hand off after the verdict.",
        (Reference("reflection", snapshot.id, "Consolidation receipt and fixed corpus"), *_review_refs(pinned)),
    )


def proposal_ready(snapshot, knowledge):
    missing = consolidation_proposal(snapshot, knowledge)
    if missing:
        return missing
    proposal = (_wave(snapshot, knowledge).get("consolidation") or {}).get("proposal") or {}
    if proposal.get("id") == snapshot.data.get("proposal_id"):
        return Issue("new_consolidation_proposal_required", "Submit a revised proposal before requesting another consolidation review.",
                     "submit_consolidation_proposal", ("consolidation.submit",))


def pin_proposal(snapshot, payload, knowledge):
    proposal = (_wave(snapshot, knowledge).get("consolidation") or {})["proposal"]
    return Change(data={"proposal_id": proposal["id"], "proposal_sha": proposal["proposal_sha"], "revision_context": ""},
                  actions=(Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": "consolidation_reviewer"}),))


def request_reflection_review(snapshot, payload, knowledge):
    return Change(actions=(Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": "reflection_reviewer"}),))


def start_published_wave(snapshot, payload, knowledge):
    return Change(actions=(Action("workflow.start", {"workflow": "research_wave", "request_id": f"reflection-wave:{snapshot.id}",
                                                      "data": {"reflection_id": snapshot.id}}),))


REFLECTION = Workflow(
    name="reflection", version=1, initial="reflecting", event_type="reflection.transitioned", id_prefix="syn",
    nodes=(
        Node("reflecting", "Independent reflection lenses", children=_lens_children, join=_join_lenses),
        Node("synthesizing", "Reconcile reflection", "reflection_owner", build_synthesis_context, execution=REFLECTION_EXECUTION),
        Node("reflection_review", "Review reflection", "reflection_reviewer", build_review_context, review_requested,
             execution=REVIEW_EXECUTION),
        Node("consolidating", "Consolidate reviewed code", "consolidation", build_consolidation_context,
             execution=CONSOLIDATION_EXECUTION),
        Node("consolidation_review", "Review consolidated code", "consolidation_reviewer", build_consolidation_review_context, review_requested,
             execution=REVIEW_EXECUTION),
    ),
    edges=(
        Edge("reflecting", "submit_reflections", "synthesizing", check=all_of(lenses_complete, join_guard(_join_lenses, "submit_reflections")), change=pin_lenses,
             label="Reconcile the completed lens contributions", tools=("reflection.transition",)),
        Edge("synthesizing", "submit_reflection_artifacts", "reflection_review",
             check=all_of(project_graph, reflection_document, change_spec), change=request_reflection_review,
             label="Submit the reflection for independent review", tools=("reflection.transition",)),
        Edge("reflection_review", "begin_consolidation", "consolidating", check=reviewed("reflection_reviewer"),
             label="Consolidate code from the approved reflection", tools=("reflection.transition",)),
        Edge("reflection_review", "revise_lenses", RETURN_TO_REFLECTING.to_status, check=_rejected("reflection_reviewer", RETURN_TO_REFLECTING.to_status), change=_new_attempt,
             label=RETURN_TO_REFLECTING.choose_when, event_type=RETURN_TO_REFLECTING.event_type),
        Edge("reflection_review", "revise_synthesis", RETURN_TO_SYNTHESIZING.to_status, check=_rejected("reflection_reviewer", RETURN_TO_SYNTHESIZING.to_status), change=_revision,
             label=RETURN_TO_SYNTHESIZING.choose_when, event_type=RETURN_TO_SYNTHESIZING.event_type),
        *(Edge(state, "submit_consolidation", "consolidation_review", check=proposal_ready, change=pin_proposal,
               label="Review the exact code proposal", tools=("consolidation.submit",))
          for state in ("consolidating", "consolidation_review")),
        Edge("consolidation_review", "revise_consolidation", RETURN_TO_CONSOLIDATING.to_status, check=_rejected("consolidation_reviewer", RETURN_TO_CONSOLIDATING.to_status), change=_revision,
             label=RETURN_TO_CONSOLIDATING.choose_when, event_type=RETURN_TO_CONSOLIDATING.event_type),
        Edge("consolidation_review", "publish", "published", check=all_of(consolidation_proposal, reviewed("consolidation_reviewer"), central_advance),
             change=start_published_wave, label="Publish the reviewed wave after the runner advances central"),
        *(Edge(state, "abandon", "abandoned", check=can_abandon, label="Abandon this reflection wave", suggest=False, tools=("reflection.transition",))
          for state in ("reflecting", "synthesizing", "reflection_review", "consolidating", "consolidation_review")),
    ),
    outcomes={"published": "published", "abandoned": "abandoned"},
)

METADATA = Metadata(
    requirements={"reflecting": (ARTIFACTS["reflection_lens_doc"],),
                  "synthesizing": tuple(ARTIFACTS[role] for role in ("project_graph", "reflection_doc", "change_spec")),
                  "consolidating": (PROPOSAL_NEED,), "consolidation_review": (PROPOSAL_NEED, CENTRAL_ADVANCE_NEED)},
    reviews={
        "reflection_review": ReviewGate("reflection_reviewer", "reflection review must pass before code consolidation", "reflection_review_required",
                                        "Reflection review passed", "project-reflection-review", "begin_consolidation", (RETURN_TO_REFLECTING, RETURN_TO_SYNTHESIZING),
                                        return_choice_required=True, return_required_error="project-reflection-review rejections must set return_to: 'reflecting' for a fresh lens attempt, or 'synthesizing' to repair its synthesis"),
        "consolidation_review": ReviewGate("consolidation_reviewer", "consolidation review must pass before central can advance", "consolidation_review_required",
                                           "Consolidation code review passed", "consolidation-review", "publish", (RETURN_TO_CONSOLIDATING,),
                                           return_choice_required=True, return_required_error="consolidation-review rejections must set return_to: 'consolidating'",
                                           forbidden_returns=tuple((state, "consolidation cannot reopen the authoritative reflection") for state in ("reflecting", "synthesizing"))),
    },
    effects={"publish": ("materialize_change_spec", "pin_project_graph")},
    subject="reflection wave", success_outcome="published",
)


def lens_active(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    if wave["status"] != "reflecting" or int(wave["attempt_index"]) != int(snapshot.data["attempt_index"]):
        return Issue("lens_attempt_closed", "This lens belongs to an earlier or closed reflection attempt.")


def submit_lens(snapshot, payload, knowledge):
    artifact = _artifact(_wave(snapshot, knowledge), "reflection_lens_doc", str(snapshot.data["lens_id"]))
    artifact_id = str(payload.get("artifact_id") or (artifact or {}).get("artifact_id") or (artifact or {}).get("id") or "")
    if not artifact_id:
        raise WorkflowError("Submit this lens's reflection_lens_doc, or upload it with artifact.upload and pass artifact_id to this action.")
    document = knowledge.read(Reference("artifact", artifact_id))
    problems = reflection_lens_doc_problems(document["text"])
    if problems:
        raise WorkflowError("The lens contribution is not ready: " + "; ".join(problems))
    return Change(data={"artifact_id": str(document.get("artifact_id") or artifact_id)})


def build_lens_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    lens = next(item for item in wave["roster"] if item["id"] == snapshot.data["lens_id"])
    return Brief(
        f"Work independently as the {lens.get('title') or lens['id']} lens for reflection wave {wave.get('title') or wave['id']}, "
        f"attempt {snapshot.data['attempt_index']}. Your charter: {lens.get('charter') or lens.get('prompt') or ''}\n\n"
        f"Revision request: {wave.get('revision_context') or 'First pass over this fixed corpus.'}\n\n"
        "Read the wave's snapshotted experiment and task corpus, the previous project graph, and the "
        "relevant submitted artifacts. Use existing tools to inspect the details behind any conclusion. "
        "Do not edit the experiments, project graph, other lenses, or the change spec. Your independent "
        "view is an input to a later synthesis assignment. Investigate promising findings and failed "
        "directions through this lens's charter, name uncertainty, and propose concrete next tests.\n\n"
        "Resume from any retained contribution before repeating investigation. Submit one complete "
        "document with artifact.upload and a non-empty Summary section. Cite exact evidence references "
        "so the synthesizer can verify your claims quickly. Then commit the submit action for this lens "
        "workflow with payload={artifact_id: the uploaded content ID}. The workflow associates it with "
        "this fixed lens and wave; its submitted artifact ID is frozen in workflow "
        "history; after every lens finishes, the parent automatically hands their fixed contributions "
        "to the synthesis node. Hand off and exit after your own lens is submitted.",
        (Reference("reflection", wave["id"], "Fixed corpus and prior lens progress"),
         *_refs([item for item in wave.get("current_attempt_artifacts") or () if item.get("lens_id") == lens["id"]])),
    )


LENS = Workflow(
    name="reflection_lens", version=1, initial="reflecting", id_prefix="lens",
    nodes=(Node("reflecting", "Investigate one reflection lens", "reflection_lens", build_lens_context, lens_active,
                execution=LENS_EXECUTION),),
    edges=(Edge("reflecting", "submit", "submitted", check=lens_active, change=submit_lens,
                label="Submit this lens's completed contribution", tools=("workflow.transition",)),),
    outcomes={"submitted": "submitted"}, entries={"submitted": "submitted"},
)
