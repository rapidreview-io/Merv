# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Application-owned workflow and project dashboard read models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..kernel.utils import NotFoundError
from ..research_core import (
    EXPERIMENT_ACTIVE_PROCESS_STATUSES,
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT,
    Research, GateEvaluation,
    ResearchSnapshot,
    ExperimentState,
    TaskState,
    TASK_TERMINAL_STATUSES,
    project_fields,
    project_rows,
)
from ..infrastructure import RemoteSandboxes as SandboxEngine
from ..workflows import agent_workflow
from .experiments.presentation import ProducedObjectCatalog, rich_experiment_state
from .experiments.context import ExperimentContextQuery
from .tasks import TaskContextQuery, rich_task_state, slim_task_state

Record = dict[str, Any]

_SLIM_REFLECTION_FIELDS = ("id", "title", "status", "attempt_index", "revision_context", "reflection_coverage")


def present_workflow(*, revision_context, evaluation: GateEvaluation):
    decision = evaluation.decision
    if decision is None:
        raise RuntimeError("canonical workflow evaluation is missing")
    selected = decision.suggested
    issues = tuple(dict.fromkeys((*decision.dispatch_issues, *(() if selected is None else selected.issues))))
    first = next(iter(issues), None)
    tools = tuple(tool for issue in issues for tool in issue.tools)
    if not tools and selected is not None and selected.available:
        tools = selected.edge.tools or ("workflow.transition",)
    result = {
        **decision.public(),
        "current_gate": first.code if first is not None else "terminal" if decision.snapshot.outcome else decision.snapshot.state,
        "next_action": (first.action or "resolve_workflow_blocker") if first is not None else "none" if selected is None else selected.edge.name,
        "allowed_actions": list(dict.fromkeys(tools)),
        "missing_evidence": [issue.message for issue in issues],
        "revision_context": revision_context,
    }
    # This is request metadata for older views, not another review policy.
    review = evaluation.review
    if review is not None and decision.node is not None and decision.node.execution.read_only:
        item = next(iter(review.items), {})
        status = "attested_blocked" if review.problems and review.status == "pending" else review.status
        result["review_gate"] = {
            "role": decision.node.role, "target_type": decision.snapshot.workflow,
            "target_id": decision.snapshot.id, "status": status,
            "read_only": True,
            **{name: item[name] for name in ("request_id", "expires_at", "skill", "label") if item.get(name)},
        }
    return result


def slim_reflection(reflection):
    return {
        **project_fields(reflection, _SLIM_REFLECTION_FIELDS),
        "roster": project_rows(reflection.roster, ("id", "title", "core")),
        "current_attempt_artifacts": project_rows(reflection.current_attempt_artifacts,
                                                  ("id", "role", "lens_id", "path", "size_bytes", "tldr")),
        "reviews": project_rows(reflection.reviews, ("id", "role", "verdict", "created_at", "synopsis")),
        "allowed_transitions": project_rows(reflection.allowed_transitions, ("transition", "leads_to")),
    }

_RESULT_WORK = EXPERIMENT.effect_sources("result_submission")
_RESULT_REVIEW = EXPERIMENT.effect_destinations("result_submission")
_DESIGN_REVIEW = {
    node.name
    for node in EXPERIMENT.workflow.nodes
    if node.execution.read_only and node.name not in _RESULT_REVIEW
}
_EXPERIMENT_PRIORITY = {
    **{status: 0 for status in _RESULT_WORK},
    **{status: 1 for status in _RESULT_REVIEW},
    **{status: 2 for status in _DESIGN_REVIEW},
    EXPERIMENT.workflow.initial: 3,
}
_PROCESS_PRIORITY = {"running": 0, "provisioning": 1}
_STATUS_EXPERIMENT_FIELDS = ("id", "name", "intent", "status", "attempt_index")
_PROCESS_EXPERIMENT_FIELDS = ("id", "intent", "status", "attempt_index")
_STATUS_TASK_FIELDS = ("id", "name", "goal", "status", "attempt_index")
_TASK_PRIORITY = {"in_review": 0, "in_progress": 1}
_SANDBOX_SUMMARY_FIELDS = ("sandbox_uid", "status", "gpu", "cpu", "memory", "workdir", "expires_at")


@dataclass
class StatusAndNextQuery:
    """Join Research snapshots to Sandbox reads, then apply pure policy."""

    research: Research
    sandboxes: SandboxEngine
    objects: ProducedObjectCatalog
    context: ExperimentContextQuery
    task_context: TaskContextQuery

    def _selection(self, *, project_id, experiment_id, task_id):
        """The snapshot plus the one record the caller scoped to, and that experiment's sandboxes."""
        snapshot = self.research.snapshot(project_id=project_id, experiment_id=experiment_id, task_id=task_id)
        task = snapshot.selected_task if task_id is not None else None
        if task_id is not None and task is None:
            raise NotFoundError(f"task not found in project {snapshot.project_id}: {task_id}")
        experiment = None if task_id is not None else snapshot.selected_experiment
        if experiment_id is not None and experiment is None:
            raise NotFoundError(f"experiment not found: {experiment_id}")
        sandboxes = self.sandboxes.for_experiment(project_id=snapshot.project_id, experiment_id=experiment.id) if experiment else []
        return snapshot, experiment, task, sandboxes

    def status_and_next(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> Record:
        snapshot, experiment, task, sandboxes = self._selection(project_id=project_id, experiment_id=experiment_id, task_id=task_id)
        return self._status(snapshot=snapshot, experiment=experiment, sandboxes=sandboxes, task=task)

    def status_and_next_agent(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> Record:
        snapshot, experiment, task, sandboxes = self._selection(project_id=project_id, experiment_id=experiment_id, task_id=task_id)
        if experiment_id is None:
            # Project scope orients; it never adopts the last-created experiment's workflow.
            experiment, sandboxes = None, []
        full = self._status(snapshot=snapshot, experiment=experiment, sandboxes=sandboxes, task=task, agent=True)
        return _slim_status(
            full,
            experiment_context=self.context.build(state=experiment, project_id=project_id) if experiment else None,
            task_context=self.task_context.build(state=task, project_id=project_id) if task else None,
        )

    def project_models(
        self, *, snapshot: ResearchSnapshot, sandboxes: list[Record]
    ) -> tuple[Record, Record, list[Record]]:
        experiments = self._enrich(
            project_id=snapshot.project_id,
            experiments=snapshot.experiments,
        )
        by_id = {str(item["id"]): item for item in experiments}
        selected = (
            by_id.get(snapshot.selected_experiment.id)
            if snapshot.selected_experiment is not None
            else None
        )
        selected_sandboxes = []
        if selected is not None:
            selected_id = str(selected["id"])
            selected_sandboxes = [
                {**sandbox, "experiment_id": selected_id}
                for sandbox in sandboxes
                if selected_id in (sandbox.get("active_experiment_ids") or [])
            ]
        return (
            self._status(
                snapshot=snapshot,
                experiment=snapshot.selected_experiment,
                sandboxes=selected_sandboxes,
            ),
            self._active_work(
                snapshot=snapshot,
                experiments=experiments,
                sandboxes=sandboxes,
            ),
            experiments,
        )

    def _status(
        self,
        *,
        snapshot: ResearchSnapshot,
        experiment: ExperimentState | None,
        sandboxes: list[Record],
        task: TaskState | None = None,
        agent: bool = False,
    ) -> Record:
        selected = task or experiment
        workflow = (present_workflow(revision_context=selected.revision_context,
                                     evaluation=snapshot.gate_evaluations[selected.id]) if selected else {})
        wave = snapshot.open_reflection
        orientation = self.research.program.orientation
        oriented = orientation(
            snapshot, selected=selected, workflow=workflow,
            reflection=slim_reflection(wave) if wave else None,
            reflection_workflow=present_workflow(revision_context=wave.revision_context,
                evaluation=snapshot.gate_evaluations[wave.id]) if wave else None,
        ) if orientation else {"workflow": workflow}
        result = {
            "project": {
                **self.research.synthesis.document(project_id=snapshot.project_id),
                "active_claims": snapshot.claims,
                "active_experiments": project_rows(
                    snapshot.experiments, _STATUS_EXPERIMENT_FIELDS
                ),
                "active_tasks": project_rows(snapshot.tasks, _STATUS_TASK_FIELDS),
            },
            "experiment": (experiment if agent else self._enrich(
                project_id=snapshot.project_id, experiments=[experiment])[0]) if experiment else None,
            "task": (slim_task_state if agent else rich_task_state)(task) if task else None,
            "sandboxes": sandboxes,
            **oriented,
        }
        return result

    def _active_work(
        self,
        *,
        snapshot: ResearchSnapshot,
        experiments: list[Record],
        sandboxes: list[Record],
    ) -> Record:
        by_id = {str(item["id"]): item for item in experiments}
        processes = _sort_active(
            [
                _process_view(
                    sandbox=sandbox,
                    experiment=by_id.get(
                        str((sandbox.get("active_experiment_ids") or [""])[0])
                    ),
                    experiments=[
                        by_id[experiment_id]
                        for experiment_id in sandbox.get("active_experiment_ids") or []
                        if experiment_id in by_id
                    ],
                )
                for sandbox in sandboxes
                if sandbox.get("status") in EXPERIMENT_ACTIVE_PROCESS_STATUSES
            ],
            _PROCESS_PRIORITY,
        )
        active = []
        for experiment in experiments:
            if experiment["status"] in EXPERIMENT_TERMINAL_STATUSES:
                continue
            experiment_sandboxes = [
                sandbox
                for sandbox in sandboxes
                if experiment["id"] in (sandbox.get("active_experiment_ids") or [])
            ]
            active.append(
                {
                    **experiment,
                    "workflow": present_workflow(
                        revision_context=next(item for item in snapshot.experiments if item.id == experiment["id"]).revision_context,
                        evaluation=snapshot.gate_evaluations[str(experiment["id"])],
                    ),
                    "sandboxes": experiment_sandboxes,
                    "active_processes": [
                        process
                        for process in processes
                        if experiment["id"]
                        in (process.get("active_experiment_ids") or [])
                    ],
                }
            )
        active_tasks = [
            {
                **rich_task_state(task),
                "workflow": present_workflow(
                    revision_context=task.revision_context,
                    evaluation=snapshot.gate_evaluations[task.id],
                ),
            }
            for task in snapshot.tasks
            if task.status not in TASK_TERMINAL_STATUSES
        ]
        return {
            "active_experiments": _sort_active(active, _EXPERIMENT_PRIORITY),
            "active_tasks": _sort_active(active_tasks, _TASK_PRIORITY),
            "active_processes": processes,
        }

    def _enrich(self, *, project_id: str, experiments: list[ExperimentState]) -> list[Record]:
        ids = tuple(
            experiment.id
            for experiment in experiments
            if experiment.id
        )
        by_experiment = self.objects.by_experiment(
            project_id=project_id, experiment_ids=ids
        )
        return [
            rich_experiment_state(
                experiment,
                storage_objects=by_experiment.get(experiment.id, []),
            )
            for experiment in experiments
        ]


def _sort_active(items: list[Record], priority: dict[str, int]) -> list[Record]:
    recency = sorted(
        items,
        key=lambda item: item.get("updated_at") or item.get("created_at") or "",
        reverse=True,
    )
    return sorted(recency, key=lambda item: priority.get(str(item.get("status")), 99))


def _process_view(
    *, sandbox: Record, experiment: Record | None, experiments: list[Record]
) -> Record:
    return {
        **sandbox,
        "process_type": "sandbox",
        **({} if experiment is None
           else {"experiment": project_fields(experiment, _PROCESS_EXPERIMENT_FIELDS)}),
        **({} if not experiments
           else {"active_experiments": project_rows(experiments, _PROCESS_EXPERIMENT_FIELDS)}),
    }


def _slim_status(full: Record, *, experiment_context: Record | None, task_context: Record | None) -> Record:
    """One scope's context beside its workflow; the project roster only at project scope."""
    result: Record = {"workflow": agent_workflow(full.get("workflow") or {})}
    if task_context is not None:
        result.update(scope="task", context=task_context)
    elif experiment_context is not None:
        result.update(scope="experiment", context=experiment_context, sandbox=_sandbox_summary(full.get("sandboxes", [])))
    else:
        result.update(scope="project", context={"project": full["project"]})
    for key in ("project_reflection", "litreview"):
        if full.get(key):
            result[key] = full[key]
    if "workflow" in result.get("project_reflection", {}):
        result["project_reflection"]["workflow"] = agent_workflow(result["project_reflection"]["workflow"])
    return result


def _sandbox_summary(sandboxes: list[Record]) -> Record:
    active = next(
        (
            sandbox
            for sandbox in sandboxes
            if sandbox.get("status") in EXPERIMENT_ACTIVE_PROCESS_STATUSES
        ),
        None,
    )
    if active is not None:
        return {
            "active": True,
            **project_fields(active, _SANDBOX_SUMMARY_FIELDS),
        }
    last = sandboxes[0] if sandboxes else None
    return {
        "active": False,
        "last_status": last.get("status") if last else None,
        "note": "No active sandbox for this experiment — call sandbox.request to create or reuse one.",
    }


__all__ = ["StatusAndNextQuery"]
