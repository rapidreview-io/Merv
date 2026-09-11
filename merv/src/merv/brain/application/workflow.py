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
    Research,
    ResearchSnapshot,
    ExperimentState,
    TaskState,
    TASK_TERMINAL_STATUSES,
    project_fields,
    project_rows,
)
from ..infrastructure import RemoteSandboxes as SandboxEngine
from .experiments.presentation import ProducedObjectCatalog, rich_experiment_state
from .experiments.context import ExperimentContextQuery
from .project_context import ProjectContextQuery
from .reflection_guidance import literature_hint
from .status_guidance import StatusGuidancePolicy
from .tasks import TaskContextQuery, rich_task_state, slim_task_state

Record = dict[str, Any]

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
_SANDBOX_SUMMARY_FIELDS = (
    "sandbox_id",
    "status",
    "gpu",
    "cpu",
    "memory",
    "ssh_host",
    "ssh_port",
    "ssh_user",
    "workdir",
    "sandbox_data_dir",
    "expires_at",
)


@dataclass
class StatusAndNextQuery:
    """Join Research snapshots to Sandbox reads, then apply pure policy."""

    research: Research
    sandboxes: SandboxEngine
    policy: StatusGuidancePolicy
    objects: ProducedObjectCatalog
    context: ExperimentContextQuery
    project_context: ProjectContextQuery
    task_context: TaskContextQuery | None = None

    def status_and_next(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> Record:
        snapshot = self.research.snapshot(
            project_id=project_id, experiment_id=experiment_id, task_id=task_id
        )
        if task_id is not None:
            task = snapshot.selected_task
            if task is None:
                raise NotFoundError(
                    f"task not found in project {snapshot.project_id}: {task_id}"
                )
            return self._status(
                snapshot=snapshot,
                experiment=None,
                sandboxes=[],
                task=task,
            )
        selected = snapshot.selected_experiment
        sandbox_rows = (
            self.sandboxes.for_experiment(
                project_id=snapshot.project_id, experiment_id=selected.id
            )
            if selected is not None
            else []
        )
        return self._status(
            snapshot=snapshot, experiment=selected, sandboxes=sandbox_rows
        )

    def status_and_next_agent(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> Record:
        snapshot = self.research.snapshot(project_id=project_id, experiment_id=experiment_id, task_id=task_id)
        experiment = snapshot.selected_experiment
        task = snapshot.selected_task if task_id is not None else None
        if experiment_id is not None and experiment is None:
            raise NotFoundError(f"experiment not found: {experiment_id}")
        if task_id is not None and task is None:
            raise NotFoundError(f"task not found: {task_id}")
        sandboxes = self.sandboxes.for_experiment(project_id=snapshot.project_id, experiment_id=experiment.id) if experiment else []
        full = self._status(snapshot=snapshot, experiment=None if task else experiment,
                            sandboxes=sandboxes, task=task, agent=True)
        return _slim_status(
            full,
            experiment_context=self.context.build(state=experiment, project_id=project_id) if experiment_id else None,
            task_context=self.task_context.build(state=task, project_id=project_id) if task and self.task_context else None,
            project_context=self.project_context.build(project_id=project_id) if not experiment_id and not task_id else None,
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
        if task is not None:
            workflow = self.policy.task(
                task=task,
                evaluation=snapshot.gate_evaluations[task.id],
            )
        elif experiment is not None:
            workflow = self.policy.experiment(
                experiment=experiment,
                sandboxes=sandboxes,
                evaluation=snapshot.gate_evaluations[experiment.id],
            )
        else:
            workflow = self.policy.project_setup()
        idle = all(
            row.status in EXPERIMENT_TERMINAL_STATUSES
            for row in snapshot.experiments
        ) and all(
            row.status in TASK_TERMINAL_STATUSES for row in snapshot.tasks
        )
        live_tasks = [
            row
            for row in snapshot.tasks
            if row.status not in TASK_TERMINAL_STATUSES
        ]
        reflection = self.policy.project_reflection(
            open_wave=snapshot.open_reflection,
            evaluation=(
                None
                if snapshot.open_reflection is None
                else snapshot.gate_evaluations[snapshot.open_reflection.id]
            ),
            signal=snapshot.reflection_signal,
            idle=idle,
        )
        scoped = (
            snapshot.requested_experiment_id is not None
            or snapshot.requested_task_id is not None
        )
        if not scoped and idle:
            workflow = (
                self.policy.reflection_workflow_takeover(reflection=reflection)
                or workflow
            )
        elif not scoped and (
            (
                experiment is not None
                and experiment.status in EXPERIMENT_TERMINAL_STATUSES
            )
            or (experiment is None and live_tasks)
        ):
            workflow = self.policy.live_experiments_takeover(
                exp_rows=snapshot.experiments,
                reflection=reflection,
                task_rows=snapshot.tasks,
            )
        result = {
            "project": {
                **snapshot.project,
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
            "workflow": workflow,
        }
        if reflection is not None:
            result["project_reflection"] = reflection
        hint = literature_hint(signal=snapshot.literature_signal)
        if hint is not None:
            result["litreview"] = {
                **snapshot.literature_signal,
                "hint": hint,
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
                    "workflow": self.policy.experiment(
                        experiment=next(item for item in snapshot.experiments if item.id == experiment["id"]),
                        sandboxes=experiment_sandboxes,
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
                "workflow": self.policy.task(
                    task=task,
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


def _slim_status(
    full: Record,
    *,
    experiment_context: Record | None = None,
    project_context: Record | None = None,
    task_context: Record | None = None,
) -> Record:
    workflow = full.get("workflow") or {}
    project = full.get("project") or {}
    experiment = full.get("experiment")
    if task_context is not None or full.get("task") is not None:
        task = full.get("task")
        if task is None:
            raise RuntimeError("task state is required for task scope")
        result: Record = {
            "scope": "task",
            "task": task,
            "workflow": workflow,
            "context": task_context or {},
            "project": {"id": project.get("id"), "name": project.get("name")},
        }
    elif project_context is not None:
        result = {
            "scope": "project",
            "experiment": None,
            "workflow": workflow,
            "context": project_context,
        }
    else:
        if experiment is None:
            raise RuntimeError("experiment state is required for experiment scope")
        if experiment_context is None:
            raise RuntimeError("experiment context is required for experiment scope")
        result = {
            "scope": "experiment",
            "workflow": workflow,
            "context": experiment_context,
            "sandbox": _sandbox_summary(full.get("sandboxes", [])),
            "project": {"id": project.get("id"), "name": project.get("name")},
        }
    if full.get("project_reflection"):
        result["project_reflection"] = full["project_reflection"]
    if full.get("litreview"):
        result["litreview"] = full["litreview"]
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
