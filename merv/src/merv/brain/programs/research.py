"""Merv's own research program: the graphs, records, effects and tools it runs on."""

from __future__ import annotations

from ..research_core import TOOLS as RESEARCH_TOOLS, project_rows
from ..workflows import (
    TOOLS as WORKFLOW_TOOLS, ArtifactNeed, DependenciesDone, Guidance, Program, RecordNeed, ReviewGate,
)
from ..workflows.definitions.experiment import EXPERIMENT, KIND as EXPERIMENT_KIND
from ..workflows.definitions.reflection import LENS, REFLECTION, KIND as REFLECTION_KIND, present_reflection_signal
from ..workflows.definitions.research_wave import RESEARCH_WAVE
from ..workflows.definitions.review import REVIEW, KIND as REVIEW_KIND
from ..workflows.definitions.task import TASK, KIND as TASK_KIND

# These are advisory choices; neither alters dependency or transition permissions.
LITERATURE_NUDGE_PAPERS = 3
ORIENTATION_GUIDANCE = Guidance("research-workflow", messages={
    "literature": ("{unreviewed} cited papers are not yet worked into the literature "
        "review — consider a targeted litreview.edit (add or amend the one relevant section)."),
    "idle": ("No experiments are active and {drift} — a good moment for a "
        "project reflection (reflection.create, project-reflection skill), or "
        "start the next experiment if the logic state is current."),
})


def literature_hint(*, signal: dict) -> str | None:
    unreviewed = int(signal.get("papers_unreviewed") or 0)
    return (ORIENTATION_GUIDANCE.messages["literature"].format(unreviewed=unreviewed)
            if unreviewed >= LITERATURE_NUDGE_PAPERS else None)


def idle_reflection_hint(*, signal: dict) -> str:
    new = signal["new_terminal_since_publish"]
    finished = f"{new} experiment{'s have' if new != 1 else ' has'} finished"
    if signal["last_published_reflection_id"]:
        drift = f"{finished} since the last published reflection"
        if signal["claims_changed_since_publish"]:
            drift += (
                f" and {signal['claims_changed_since_publish']} claims have changed"
            )
    else:
        drift = f"{finished} and no project reflection exists yet"
    return ORIENTATION_GUIDANCE.messages["idle"].format(drift=drift)


def _next(*, gate, action, allowed, blocked=None, missing=None, **details):
    return {"current_gate": gate, "next_action": action, "allowed_actions": allowed,
            "blocked_actions": blocked or [], "missing_evidence": missing or [], "revision_context": "", **details}


def orient_project(snapshot, *, selected, workflow, reflection, reflection_workflow):
    """Explicit scope wins; idle reflection and live-work advice never grant an edge."""
    live = [row for row in snapshot.experiments if row.status not in EXPERIMENT_KIND.terminal_statuses]
    tasks = [row for row in snapshot.tasks if row.status not in TASK_KIND.terminal_statuses]
    idle = not live and not tasks
    signal = snapshot.reflection_signal
    need = EXPERIMENT_KIND.creation_requires[0]
    blocked = need.blocked(signal)
    presented = present_reflection_signal(signal) or {}
    recommended = idle and signal.get("has_new_material")
    reason = need.reason(signal) if blocked else ""
    advice = None
    if reflection is not None:
        if blocked:
            reflection_workflow = {**reflection_workflow,
                "allowed_actions": [action for action in reflection_workflow.get("allowed_actions", []) if action != "experiment.create"],
                "blocked_actions": [item for item in reflection_workflow.get("blocked_actions", []) if item.get("action") != "experiment.create"]
                                   + [{"action": "experiment.create", "reason": reason}]}
        advice = {"reflection": reflection, "workflow": reflection_workflow, "signal": presented}
    elif signal.get("stale") or recommended:
        advice = {"reflection": None, "hint": presented.get("hint") or idle_reflection_hint(signal=signal),
                  "signal": presented, "experiment_create_blocked": blocked,
                  **({"recommended": True} if recommended else {})}
    if not workflow:
        workflow = _next(gate="project_setup", action="create_claim_or_experiment",
                         allowed=["claim.create", "experiment.create", "task.create"])
    scoped = snapshot.requested_experiment_id is not None or snapshot.requested_task_id is not None
    if not scoped and idle and advice:
        hint = advice.get("hint") or reason
        if reflection is not None:
            workflow = reflection_workflow
        elif blocked:
            workflow = _next(gate="reflection_required", action="start_project_reflection_before_next_experiment",
                allowed=["reflection.create", "claim.create", "task.create"],
                blocked=[{"action": "experiment.create", "reason": hint}], missing=[hint] if hint else [])
        elif recommended:
            workflow = _next(gate="reflection_suggested", action="consider_project_reflection",
                allowed=["reflection.create", "claim.create", "experiment.create", "task.create"], missing=[hint] if hint else [])
    elif not scoped and ((selected is not None and selected.status in EXPERIMENT_KIND.terminal_statuses)
                         or (selected is None and tasks)):
        # A hidden signal never changes the released live-work follow-up fields.
        blocked = bool(advice and advice["signal"].get("experiment_create_blocked"))
        workflow = _next(gate="live_experiments", action="tend_live_work",
            allowed=["workflow.status_and_next", "task.create", *([] if blocked else ["experiment.create"])],
            blocked=[{"action": "experiment.create", "reason": advice.get("hint") or reason}] if blocked else [],
            live_experiments=project_rows(live, ("id", "name", "status", "attempt_index", "intent")),
            live_tasks=project_rows(tasks, ("id", "name", "status", "goal")))
    hint = literature_hint(signal=snapshot.literature_signal)
    return {"workflow": workflow, **({"project_reflection": advice} if advice is not None else {}),
            **({"litreview": {**snapshot.literature_signal, "hint": hint}} if hint is not None else {})}


# The lens and the published wave keep their whole record in instance data, so
# they carry no ``RecordKind``; the other four bind to a native row.
PROGRAM = Program(
    name="research", orientation=orient_project,
    version=1,
    workflows=(EXPERIMENT, TASK, REFLECTION, LENS, RESEARCH_WAVE, REVIEW),
    kinds=(EXPERIMENT_KIND, TASK_KIND, REFLECTION_KIND, REVIEW_KIND),
    effects=("workflow.start", "review.request"),
    transactional_effects=("reflection.materialize_change_spec", "review.record_verdict"),
    requirements=(ArtifactNeed, RecordNeed, DependenciesDone, ReviewGate),
    tools={**WORKFLOW_TOOLS, **RESEARCH_TOOLS},
)
