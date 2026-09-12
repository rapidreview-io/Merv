"""Reflection decisions and independent lens, synthesis, and review assignments."""

from dataclasses import replace
from collections.abc import Mapping
from typing import Any

from ..composition import Child, join_guard
from ..graph import (
    Action, ArtifactNeed, Change, Edge, Guidance, Issue, Metadata, Node, Public, RecordKind, RecordNeed,
    Reference, ReviewGate, ReviewReturn, TransactionalEffect, Workflow, all_of,
)
from ...kernel.utils import NotFoundError, ValidationError, WorkflowError, now_iso
from .checks import project_brief, evidence_references, rejected, review_summary
from .documents import graph_problems, reflection_doc_review_problems, reflection_lens_doc_problems, parse_change_spec, preferred_artifact
from .execution import RESEARCH_HANDOFF, CONSOLIDATION_EXECUTION, LENS_EXECUTION, REFLECTION_EXECUTION, REVIEW_EXECUTION
from .research_state import ReflectionState


def _guarded(validate):
    """Turn a document validator into problems; a bad spec reads as one problem."""
    def problems(document, snapshot, knowledge):
        try:
            return validate(document, snapshot, knowledge)
        except (NotFoundError, ValidationError, WorkflowError) as exc:
            return (str(exc),)
    return problems


def _parse_spec(document, snapshot, knowledge):
    world = knowledge.read(Reference("reflection_world", snapshot.project_id))
    parse_change_spec(text=document["text"], path=document["path"],
                      claim_exists=lambda value: value in world["claim_ids"],
                      experiment_name_taken=lambda value: value.lower() in world["experiment_names"],
                      task_name_taken=lambda value: value.lower() in world["task_names"],
                      node_exists=lambda value: value in world["node_ids"],
                      non_terminal_experiments=lambda: list(world["non_terminal_experiments"]))
    return ()


_VALIDATORS = {
    "project_graph": lambda document, *_: graph_problems(document["text"]),
    "reflection_doc": lambda document, *_: reflection_doc_review_problems(
        text=document["text"], submitted_images=set(document.get("figure_links") or ()), path=document["path"]),
    "change_spec": _parse_spec,
}

ARTIFACTS = {
    "reflection_lens_doc": ArtifactNeed("reflection_lens_doc", "Every roster lens must submit its own reflection with a non-empty Summary.",
                                       "reflection_roster_incomplete", "fan_out_reflection_subagents", validator="roster",
                                       label="Per-lens reflections submitted", missing="one reflection document per roster lens", artifact_key="reflection"),
    **{role: ArtifactNeed(role, f"A {title} artifact must be submitted before reflection review.", f"{role}_required", f"submit_{role}",
                         validator=validator, label=f"{title.capitalize()} present and valid", missing=f"{title} artifact", artifact_key=role,
                         actions=("submit_reflection_artifacts",), validate=_guarded(_VALIDATORS[role]),
                         invalid=f"{title.capitalize()} artifact is not ready for reflection review: {{problems}}",
                         invalid_action=f"revise_{role}")
       for role, title, validator in (("project_graph", "project logic graph", "graph"),
                                     ("reflection_doc", "reflection document", "reflection_doc"),
                                     ("change_spec", "change spec", "change_spec"))},
}
PROPOSAL_NEED = RecordNeed("consolidation_proposal", "The consolidation agent must submit one proposal that accounts for every experiment in the reflection corpus.",
                           "consolidation_proposal_required", "submit_consolidation_proposal", ("consolidation.submit",),
                           label="Every experiment reviewed for consolidation", missing="a complete consolidation proposal")
CENTRAL_ADVANCE_NEED = RecordNeed("central_advance", "The Merv runner binds the reviewed proposal to the central Git ref and publishes the wave; no agent transition does this.",
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


def _review_refs(pinned):
    return (Reference("review_request", str(pinned["request_id"]), "This independent review request"),
            *evidence_references(pinned.get("artifacts") or ()),
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


def _revision(snapshot, payload, knowledge):
    wave = _wave(snapshot, knowledge)
    role = "consolidation_reviewer" if snapshot.state == "consolidation_review" else "reflection_reviewer"
    fact = knowledge.read(Reference("review", role))
    return Change(data={"attempt_index": int(wave["attempt_index"]),
                        "revision_context": review_summary(fact)})


def _new_attempt(snapshot, payload, knowledge):
    change = _revision(snapshot, payload, knowledge)
    return replace(change, data={**change.data, "attempt_index": int(change.data["attempt_index"]) + 1, "lens_artifacts": {}})


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
    return project_brief(snapshot, knowledge,
        f"Reconcile reflection wave {wave.get('title') or snapshot.id}, attempt {wave['attempt_index']}. "
        f"The fixed corpus contains {len(corpus.get('terminal_experiments') or ())} completed experiments and "
        f"{len(corpus.get('terminal_tasks') or ())} completed tasks.\n"
        f"Revision request: {wave.get('revision_context') or 'First synthesis of this lens set.'}\n\n"
        "Reconcile the five lens contributions into the project graph, reflection and change spec; do not repeat their jobs. "
        "Follow project-reflection and submit the synthesis for independent review.",
        (Reference("reflection", snapshot.id, "Fixed reflection corpus and revision history"),
         *evidence_references(wave.get("current_attempt_artifacts") or ())),
    )


def build_review_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return project_brief(snapshot, knowledge,
        f"Independently review reflection wave {wave.get('title') or snapshot.id}, attempt {wave['attempt_index']}. "
        "Grade the pinned graph, reflection, change spec and five lenses against the fixed corpus and previous graph. "
        "Follow project-reflection-review; submit only the verdict and its return path.",
        (Reference("reflection", snapshot.id, "Fixed corpus and previous graph"), *_review_refs(pinned)),
    )


def build_consolidation_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    consolidation = wave.get("consolidation") or {}
    return project_brief(snapshot, knowledge,
        f"Consolidate code for approved reflection wave {wave.get('title') or snapshot.id}. "
        f"Revision request: {wave.get('revision_context') or 'Initial code consolidation.'}\n"
        f"Retained proposal: {(consolidation.get('proposal') or {}).get('id') or 'None submitted.'}\n\n"
        "Implement the approved research and account for every experiment. Follow project-reflection's consolidation "
        "procedure; submit the immutable proposal, validation and integration decisions for independent review.",
        (Reference("reflection", snapshot.id, "Approved reflection and consolidation progress"),
         *((Reference("code", str(proposal["base_sha"]), "Declared base of the retained proposal"),)
           if (proposal := consolidation.get("proposal") or {}).get("base_sha") else ()),
         *evidence_references(wave.get("current_attempt_artifacts") or ())),
    )


def build_consolidation_review_context(snapshot, knowledge):
    pinned = knowledge.read(Reference("review_snapshot", snapshot.id))
    return project_brief(snapshot, knowledge,
        f"Independently review code consolidation for reflection wave {snapshot.id}. "
        f"The exact proposal is {pinned.get('snapshot_token') or 'in the review packet'} at Git SHA "
        f"{pinned.get('code_sha') or 'recorded in the pinned proposal'}. "
        "Verify the code, tests and every integration decision against the approved research. Follow consolidation-review.",
        (Reference("reflection", snapshot.id, "Consolidation receipt and fixed corpus"), *_review_refs(pinned)),
    )


def proposal_ready(snapshot, knowledge):
    """A proposal this wave has not already sent to review must exist."""
    missing = consolidation_proposal(snapshot, knowledge)
    if missing:
        return missing
    if ((_wave(snapshot, knowledge).get("consolidation") or {}).get("proposal") or {}).get("id") == snapshot.data.get("proposal_id"):
        if knowledge.read(Reference("review", "consolidation_reviewer")).get("passed"):
            return Issue("consolidation_already_reviewed", "The pinned proposal already passed consolidation review; the Merv runner publishes after central advance.",
                         "wait_for_central_advance")
        return Issue("new_consolidation_proposal_required", "This exact proposal is already under consolidation review: wait for its verdict, or submit a revised one with consolidation.submit.",
                     "submit_consolidation_proposal", ("consolidation.submit",))


def pin_proposal(snapshot, payload, knowledge):
    """Freeze the exact proposal an independent consolidation review grades."""
    proposal = (_wave(snapshot, knowledge).get("consolidation") or {})["proposal"]
    return Change(data={"proposal_id": proposal["id"], "proposal_sha": proposal["proposal_sha"], "revision_context": ""},
                  actions=(Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id,
                                                     "role": "consolidation_reviewer"}),))


def publish_wave(snapshot, payload, knowledge):
    """Pin the graph this wave published and start its experiment/task wave."""
    return Change(data={"published_at": now_iso(),
                        "published_graph_version_id": (_artifact(_wave(snapshot, knowledge), "project_graph") or {}).get("id")},
                  transactional=(TransactionalEffect("reflection.materialize_change_spec",
                      {"spec": knowledge.read(Reference("reflection_change_spec", snapshot.id))}),),
                  actions=(Action("workflow.start", {"workflow": "research_wave", "request_id": f"reflection-wave:{snapshot.id}",
                                                     "data": {"reflection_id": snapshot.id}}),))


def request_reflection_review(snapshot, payload, knowledge):
    return Change(actions=(Action("review.request", {"target_type": snapshot.workflow, "target_id": snapshot.id, "role": "reflection_reviewer"}),))


REFLECTION_REVIEW = ReviewGate("reflection_reviewer", "reflection review must pass before code consolidation", "reflection_review_required",
                               "Reflection review passed", "project-reflection-review", "begin_consolidation", (RETURN_TO_REFLECTING, RETURN_TO_SYNTHESIZING),
                               return_choice_required=True,
                               return_required_error="project-reflection-review rejections must set return_to: 'reflecting' for a fresh lens attempt, or 'synthesizing' to repair its synthesis",
                               actions=("begin_consolidation",))
CONSOLIDATION_REVIEW = ReviewGate("consolidation_reviewer", "consolidation review must pass before central can advance", "consolidation_review_required",
                                  "Consolidation code review passed", "consolidation-review", "publish", (RETURN_TO_CONSOLIDATING,),
                                  return_choice_required=True, return_required_error="consolidation-review rejections must set return_to: 'consolidating'",
                                  forbidden_returns=tuple((state, "consolidation cannot reopen the authoritative reflection") for state in ("reflecting", "synthesizing")),
                                  actions=("publish",))
PUBLISH_PROPOSAL = replace(PROPOSAL_NEED, actions=("publish",), verify=consolidation_proposal)
PUBLISH_ADVANCE = replace(CENTRAL_ADVANCE_NEED, actions=("publish",), verify=central_advance)

REFLECTION = Workflow(
    name="reflection", version=1, initial="reflecting", event_type="reflection.transitioned", id_prefix="syn",
    nodes=(
        Node("reflecting", "Independent reflection lenses", children=_lens_children, join=_join_lenses,
             requires=(ARTIFACTS["reflection_lens_doc"],)),
        Node("synthesizing", "Reconcile reflection", "reflection_owner", build_synthesis_context, guidance=Guidance("project-reflection", RESEARCH_HANDOFF), execution=REFLECTION_EXECUTION,
             requires=tuple(ARTIFACTS[role] for role in ("project_graph", "reflection_doc", "change_spec"))),
        Node("reflection_review", "Review reflection", "reflection_reviewer", build_review_context, guidance=Guidance(REFLECTION_REVIEW.skill, RESEARCH_HANDOFF),
             execution=REVIEW_EXECUTION, requires=(REFLECTION_REVIEW,)),
        Node("consolidating", "Consolidate reviewed code", "consolidation", build_consolidation_context, guidance=Guidance("project-reflection", RESEARCH_HANDOFF),
             execution=CONSOLIDATION_EXECUTION, requires=(PROPOSAL_NEED,)),
        Node("consolidation_review", "Review consolidated code", "consolidation_reviewer", build_consolidation_review_context, guidance=Guidance(CONSOLIDATION_REVIEW.skill, RESEARCH_HANDOFF),
             execution=REVIEW_EXECUTION, requires=(PUBLISH_PROPOSAL, CONSOLIDATION_REVIEW, PUBLISH_ADVANCE)),
    ),
    edges=(
        Edge("reflecting", "submit_reflections", "synthesizing", check=all_of(lenses_complete, join_guard(_join_lenses, "submit_reflections")), change=pin_lenses,
             label="Reconcile the completed lens contributions", tools=("reflection.transition",)),
        Edge("synthesizing", "submit_reflection_artifacts", "reflection_review", change=request_reflection_review,
             label="Submit the reflection for independent review", tools=("reflection.transition",)),
        Edge("reflection_review", "begin_consolidation", "consolidating", label="Applied by a passing reflection review", auto=True),
        Edge("reflection_review", "revise_lenses", RETURN_TO_REFLECTING.to_status, check=rejected("reflection_reviewer", RETURN_TO_REFLECTING.to_status), change=_new_attempt,
             label=RETURN_TO_REFLECTING.choose_when, event_type=RETURN_TO_REFLECTING.event_type, auto=True),
        Edge("reflection_review", "revise_synthesis", RETURN_TO_SYNTHESIZING.to_status, check=rejected("reflection_reviewer", RETURN_TO_SYNTHESIZING.to_status), change=_revision,
             label=RETURN_TO_SYNTHESIZING.choose_when, event_type=RETURN_TO_SYNTHESIZING.event_type, auto=True),
        # Publish leads the review node's edges: a passed review suggests the runner's step, not another proposal.
        Edge("consolidation_review", "publish", "published", change=publish_wave,
             label="Applied by the Merv runner once central has advanced", auto=True),
        *(Edge(state, "submit_consolidation", "consolidation_review", check=proposal_ready, change=pin_proposal,
               label="Review the exact code proposal", tools=("consolidation.submit",))
          for state in ("consolidating", "consolidation_review")),
        Edge("consolidation_review", "revise_consolidation", RETURN_TO_CONSOLIDATING.to_status, check=rejected("consolidation_reviewer", RETURN_TO_CONSOLIDATING.to_status), change=_revision,
             label=RETURN_TO_CONSOLIDATING.choose_when, event_type=RETURN_TO_CONSOLIDATING.event_type, auto=True),
        *(Edge(state, "abandon", "abandoned", check=can_abandon, label="Abandon this reflection wave", suggest=False, tools=("reflection.transition",))
          for state in ("reflecting", "synthesizing", "reflection_review", "consolidating", "consolidation_review")),
    ),
    outcome_guidance={"published": Guidance("project-reflection", messages={
        "summary": ("Reflection publish created {count} planned {noun}. Create each "
            "experiment's working folder yourself (experiments/<name>/) before "
            "editing files, then call workflow.status_and_next for the one you "
            "start."),
        "first_experiment": "Start with the first newly planned experiment.",
    })},
    outcomes={"published": "published", "abandoned": "abandoned"},
)


def published_followups(experiments):
    """Suggest the first planned experiment; status still evaluates its dependencies."""
    return [{"tool": "workflow.status_and_next", "arguments": {"experiment_id": experiments[0]["experiment_id"]},
             "why": REFLECTION.outcome_guidance["published"].messages["first_experiment"]}] if experiments else []


METADATA = Metadata(subject="reflection wave", success_outcome="published")

KIND = RecordKind(
    name="reflection", table="reflections", id_prefix="syn", workflow=REFLECTION,
    construct=ReflectionState.construct, public=Public(hidden=("workflow_state",)),
    metadata=METADATA, created_event="reflection.created",
    label="title", unique_name=False, columns=("title", "roster_json", "corpus_json"),
    json_columns={"roster_json": ("roster", "[]"), "corpus_json": ("corpus", "{}")}, created_seq=True,
    # The row has no consolidation_review status: a wave under code review is
    # still `consolidating` to every reader of the record.
    status_projection={"consolidation_review": "consolidating"},
    seal_exempt_actions=frozenset({"revise_lenses", "revise_synthesis", "revise_consolidation", "migrate"}),
    commit_columns={**{action: ("attempt_index", "revision_context")
                       for action in ("revise_lenses", "revise_synthesis", "revise_consolidation")},
                    "submit_consolidation": ("revision_context",),
                    "publish": ("published_at", "published_graph_version_id")},
)


def lens_active(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    if wave["status"] != "reflecting" or int(wave["attempt_index"]) != int(snapshot.data["attempt_index"]):
        return Issue("lens_attempt_closed", "This lens belongs to an earlier or closed reflection attempt.")


def submit_lens(snapshot, payload, knowledge):
    artifact = _artifact(_wave(snapshot, knowledge), "reflection_lens_doc", str(snapshot.data["lens_id"]))
    artifact_id = str(payload.get("artifact_id") or (artifact or {}).get("artifact_id") or (artifact or {}).get("id") or "")
    if not artifact_id:
        raise WorkflowError(f"Submit the {snapshot.data['lens_id']!r} lens's reflection_lens_doc, or upload it with artifact.upload and pass artifact_id to this action.")
    document = knowledge.read(Reference("artifact", artifact_id))
    problems = reflection_lens_doc_problems(document["text"])
    if problems:
        raise WorkflowError("The lens contribution is not ready: " + "; ".join(problems))
    return Change(data={"artifact_id": str(document.get("artifact_id") or artifact_id)})


def build_lens_context(snapshot, knowledge):
    wave = _wave(snapshot, knowledge)
    lens = next(item for item in wave["roster"] if item["id"] == snapshot.data["lens_id"])
    return project_brief(snapshot, knowledge,
        f"Work independently as the {lens.get('title') or lens['id']} lens for reflection wave {wave.get('title') or wave['id']}, "
        f"attempt {snapshot.data['attempt_index']}. Your charter: {lens.get('charter') or lens.get('prompt') or ''}\n\n"
        f"Revision request: {wave.get('revision_context') or 'First pass over this fixed corpus.'}\n\n"
        "Investigate this charter against the fixed corpus; resume retained work. Follow project-reflection's lens procedure. "
        "Upload one complete contribution, then submit this lens with payload={artifact_id: the uploaded content ID}.",
        (Reference("reflection", wave["id"], "Fixed corpus and prior lens progress"),
         *evidence_references([item for item in wave.get("current_attempt_artifacts") or () if item.get("lens_id") == lens["id"]])),
    )


LENS = Workflow(
    name="reflection_lens", version=1, initial="reflecting", id_prefix="lens",
    nodes=(Node("reflecting", "Investigate one reflection lens", "reflection_lens", build_lens_context, lens_active, guidance=Guidance("project-reflection", RESEARCH_HANDOFF),
                execution=LENS_EXECUTION),),
    edges=(Edge("reflecting", "submit", "submitted", check=lens_active, change=submit_lens,
                label="Submit this lens's completed contribution", tools=("workflow.transition",)),),
    outcomes={"submitted": "submitted"}, entries={"submitted": "submitted"},
)


def reflection_staleness_hint(*, signal: Mapping[str, Any]) -> str:
    if not signal["stale"]:
        return ""
    blocked = bool(signal.get("experiment_create_blocked"))
    lead = "Project reflection required before creating another experiment" if blocked else "Consider running a project reflection"
    if not signal.get("last_published_reflection_id"):
        first = lead if blocked else "Consider running the project's first reflection"
        return (f"{first} — {signal['terminal_experiments']} experiments have finished and no project reflection exists yet. "
                "Use the project-reflection skill (reflection.create)"
                + (" and publish the wave before creating another experiment." if blocked else " when you judge the time is right."))
    pieces = [f"{lead} — {signal['new_terminal_since_publish']} experiments have finished since the last published reflection"]
    if signal["claims_changed_since_publish"]:
        pieces.append(f"{signal['claims_changed_since_publish']} claims have changed"
                      + (" (including a claim now contradicted)" if signal["contradicted_flip"] else ""))
    pieces.append(f"the current reflection covers {signal['covered_terminal_experiments']} of {signal['terminal_experiments']} finished experiments")
    return "; ".join(pieces) + (". Publish a project reflection wave before creating another experiment." if blocked else
                                ". Whether these developments change the project's logic state is your call (project-reflection skill, reflection.create).")

def present_reflection_signal(signal: Any) -> Any:
    if not isinstance(signal, Mapping):
        return signal
    result = dict(signal)
    if "stale" in result:
        result["hint"] = result.get("hint") or reflection_staleness_hint(signal=result)
    return result
