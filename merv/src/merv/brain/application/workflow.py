# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Application-owned workflow and project dashboard read models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..research_core import Artifact
from ..kernel.utils import NotFoundError
from ..research_core import (
    EXPERIMENT_ACTIVE_PROCESS_STATUSES,
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT_WORKFLOW,
    Research,
    ResearchSnapshot,
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

_RESULT_WORK = EXPERIMENT_WORKFLOW.effect_sources("result_submission")
_RESULT_REVIEW = EXPERIMENT_WORKFLOW.effect_destinations("result_submission")
_DESIGN_REVIEW = {
    state.name
    for state in EXPERIMENT_WORKFLOW.states
    if state.review is not None and state.name not in _RESULT_REVIEW
}
_EXPERIMENT_PRIORITY = {
    **{status: 0 for status in _RESULT_WORK},
    **{status: 1 for status in _RESULT_REVIEW},
    **{status: 2 for status in _DESIGN_REVIEW},
    EXPERIMENT_WORKFLOW.initial: 3,
}
_PROCESS_PRIORITY = {"running": 0, "provisioning": 1}
_STATUS_EXPERIMENT_FIELDS = ("id", "name", "intent", "status", "attempt_index")
_PROCESS_EXPERIMENT_FIELDS = ("id", "intent", "status", "attempt_index")
_ARTIFACT_LIST_FIELDS = (
    "id", "target_type", "target_id", "role", "attempt_index", "lens_id", "path",
    "title", "size_bytes", "content_type", "status", "created_by", "created_at",
    "updated_at",
)
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
                task=rich_task_state(task),
            )
        selected = snapshot.selected_experiment
        sandbox_rows = (
            self.sandboxes.for_experiment(
                project_id=snapshot.project_id, experiment_id=str(selected["id"])
            )
            if selected is not None
            else []
        )
        experiment = (
            self._enrich(project_id=snapshot.project_id, experiments=[selected])[0]
            if selected is not None
            else None
        )
        return self._status(
            snapshot=snapshot, experiment=experiment, sandboxes=sandbox_rows
        )

    def status_and_next_agent(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> Record:
        full = self.status_and_next(
            project_id=project_id, experiment_id=experiment_id, task_id=task_id
        )
        if task_id is not None:
            task = full.get("task")
            builder = self.task_context
            context = (
                builder.build(state=task, project_id=project_id)
                if isinstance(task, dict) and builder is not None
                else None
            )
            return _slim_status(full, task_context=context)
        if experiment_id is None:
            return _slim_status(
                full,
                project_context=self.project_context.build(project_id=project_id),
            )
        experiment = full.get("experiment")
        context = (
            self.context.build(state=experiment, project_id=project_id)
            if isinstance(experiment, dict)
            else None
        )
        return _slim_status(full, experiment_context=context)

    def project_models(
        self, *, snapshot: ResearchSnapshot, sandboxes: list[Record]
    ) -> tuple[Record, Record, list[Record]]:
        experiments = self._enrich(
            project_id=snapshot.project_id,
            experiments=snapshot.experiments,
        )
        by_id = {str(item["id"]): item for item in experiments}
        selected = (
            by_id.get(str(snapshot.selected_experiment["id"]))
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
                experiment=selected,
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
        experiment: Record | None,
        sandboxes: list[Record],
        task: Record | None = None,
    ) -> Record:
        if task is not None:
            workflow = self.policy.task(
                task=task,
                evaluation=snapshot.gate_evaluations[str(task["id"])],
            )
        elif experiment is not None:
            workflow = self.policy.experiment(
                experiment=experiment,
                sandboxes=sandboxes,
                evaluation=snapshot.gate_evaluations[str(experiment["id"])],
            )
        else:
            workflow = self.policy.project_setup()
        idle = all(
            str(row["status"]) in EXPERIMENT_TERMINAL_STATUSES
            for row in snapshot.experiments
        ) and all(
            str(row["status"]) in TASK_TERMINAL_STATUSES for row in snapshot.tasks
        )
        live_tasks = [
            row
            for row in snapshot.tasks
            if str(row["status"]) not in TASK_TERMINAL_STATUSES
        ]
        reflection = self.policy.project_reflection(
            open_wave=snapshot.open_reflection,
            evaluation=(
                None
                if snapshot.open_reflection is None
                else snapshot.gate_evaluations[str(snapshot.open_reflection["id"])]
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
                and str(experiment.get("status")) in EXPERIMENT_TERMINAL_STATUSES
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
            "experiment": experiment,
            "task": task,
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
                        experiment=experiment,
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
                **dict(task),
                "workflow": self.policy.task(
                    task=dict(task),
                    evaluation=snapshot.gate_evaluations[str(task["id"])],
                ),
            }
            for task in snapshot.tasks
            if str(task["status"]) not in TASK_TERMINAL_STATUSES
        ]
        return {
            "active_experiments": _sort_active(active, _EXPERIMENT_PRIORITY),
            "active_tasks": _sort_active(active_tasks, _TASK_PRIORITY),
            "active_processes": processes,
        }

    def _enrich(self, *, project_id: str, experiments: list[Record]) -> list[Record]:
        ids = tuple(
            str(experiment.get("id") or "")
            for experiment in experiments
            if experiment.get("id")
        )
        by_experiment = self.objects.by_experiment(
            project_id=project_id, experiment_ids=ids
        )
        return [
            rich_experiment_state(
                experiment,
                storage_objects=by_experiment.get(str(experiment.get("id") or ""), []),
            )
            for experiment in experiments
        ]


def artifact_list_record(artifact: Artifact) -> Record:
    """The dashboard's artifact row: the model's own columns, minus the bytes."""
    return {name: getattr(artifact, name) for name in _ARTIFACT_LIST_FIELDS}


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
        if not isinstance(task, dict):
            raise RuntimeError("task state is required for task scope")
        result: Record = {
            "scope": "task",
            "task": dict(slim_task_state(task)),
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


__all__ = ["StatusAndNextQuery", "artifact_list_record"]
