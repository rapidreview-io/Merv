# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""The concrete cross-module Application root.

Surface calls this object only for operations that coordinate multiple brain
modules.  Module-local operations continue to call their owning public root.
This first consolidation keeps the existing behavior intact while removing
the composition-wide bag of one-use Application objects.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from merv.shared.storage_guidance import storage_guidance

from ..agent_sessions import AgentSessions
from ..research_core import ResearchArtifacts as Artifacts
from ..feed import FeedService
from ..kernel.utils import ValidationError, WorkflowError
from ..research_core import (
    Research,
    AGENT_DISPATCH_SETTING,
)
from ..infrastructure import RemoteObjects, RemoteSandboxes as SandboxEngine
from .experiments.context import ExperimentContextQuery
from .experiments.create import create_experiment
from .experiments.exhibits import ExperimentExhibits
from .experiments.presentation import (
    ProducedObjectCatalog,
    review_body,
    rich_experiment_state,
    slim_experiment_state,
)
from .experiments.transition import TransitionExperiment
from .project_context import ProjectContextQuery
from .reflections import (
    consolidation_packet,
    present_agent_reflection_state,
    present_reflection_overview,
)
from .reviews import (
    read_review_status,
    request_review,
    review_queue,
    start_review,
)
from .status_guidance import StatusGuidancePolicy
from .tasks import (
    TaskContextQuery,
    TransitionTask,
    rich_task_state,
    slim_task_state,
)
from .workflow import StatusAndNextQuery, artifact_list_record
from .workflow_actions import Handler, WorkflowDeliveries


class Application:
    """Coordinate workflows spanning Research and one or more sibling modules."""

    def __init__(
        self,
        *,
        research: Research,
        artifacts: Artifacts,
        feed: FeedService,
        sandboxes: SandboxEngine,
        objects: RemoteObjects,
        produced_objects: ProducedObjectCatalog,
        agent_sessions: AgentSessions,
        effects: Mapping[str, Handler],
    ) -> None:
        self.research = research
        self.artifacts = artifacts
        self.feed = feed
        self.sandboxes = sandboxes
        # The service-backed object API (pointers, pins) and Research's own
        # per-experiment snapshot of the objects it produced.
        self.objects = objects
        self.produced_objects = produced_objects
        self.agent_sessions = agent_sessions
        self.agent_sessions.bind_workflows(
            assignment=self._workflow_assignment,
            activate=self._activate_workflow_session,
        )
        # Which effect name each installed program emits is the root's to say.
        self.workflow_deliveries = WorkflowDeliveries(workflows=research.workflows, handlers=effects)

        self._project_context = ProjectContextQuery(
            research=research,
            artifacts=artifacts,
        )
        self._experiment_context = ExperimentContextQuery(artifacts=artifacts)
        self._task_context = TaskContextQuery(artifacts=artifacts)
        self._task_transition = TransitionTask(research=research, feed=feed)
        self._exhibits = ExperimentExhibits(research=research, artifacts=artifacts)
        self._transition = TransitionExperiment(
            research=research,
            artifacts=artifacts,
            feed=feed,
            exhibits=self._exhibits,
            objects=produced_objects,
        )
        self.research.workflows.register_preparation("experiment", self._transition.prepare_workflow_transition)
        self._policy = StatusGuidancePolicy(
            storage_enabled=bool(getattr(objects, "enabled", False)),
            storage_guidance=storage_guidance(
                enabled=bool(getattr(objects, "enabled", False))
            ),
        )
        self._workflow = StatusAndNextQuery(
            research=research,
            sandboxes=sandboxes,
            policy=self._policy,
            objects=produced_objects,
            context=self._experiment_context,
            project_context=self._project_context,
            task_context=self._task_context,
        )

    # Coding-agent execution ----------------------------------------------

    def _dispatch_plan(self, *, project_id: str) -> dict[str, Any]:
        """Queue every registered graph's dispatchable nodes from one evaluation."""
        self.workflow_deliveries.run_once(project_id=project_id)
        candidates = self.research.workflows.candidates(project_id=project_id)
        # Reviews release waiting research, but the scheduler knows no workflow
        # names, native states, reviewer roles, or forward-path assumptions.
        candidates.sort(key=lambda item: not bool((item.get("execution") or {}).get("read_only")))
        return {"project": self.research.get_project(project_id=project_id), "candidates": candidates}

    def dispatch_queue(self, *, project_id: str) -> list[dict[str, Any]]:
        plan = self._dispatch_plan(project_id=project_id)
        live = self.agent_sessions.live_leases(project_id=project_id)
        return [
            {
                "target_type": candidate["workflow"], "target_id": candidate["instance_id"],
                "instance_id": candidate["instance_id"], "revision": candidate["revision"],
                "kind": session_kind(candidate["execution"]),
                "review_request_id": _reference_id(candidate["references"], "review_request"),
                "role": candidate["role"], "title": candidate["label"], "status": candidate["state"],
            }
            for candidate in plan["candidates"]
            if (str(candidate["instance_id"]), int(candidate["revision"])) not in live
        ]

    def list_agent_sessions(
        self, *, project_id: str, queue_limit: int = 50
    ) -> dict[str, Any]:
        """The Auto-run page's one read: sessions, runners, and the queue.

        ``queue`` carries at most ``queue_limit`` rows; ``queue_total`` is the
        real count so the headline never reports a truncated list as the whole.
        """
        queue = self.dispatch_queue(project_id=project_id)
        listing = self.agent_sessions.list(project_id=project_id)
        sessions = [present_session(session) for session in listing["sessions"]]
        # The current state of each worktree the listed jobs worked in
        # (branch, base, head, commit and diff counts), keyed by the instance
        # (a native id today): what "continuing each other's work" looks like.
        workspaces = self.agent_sessions.workspaces(
            project_id=project_id,
            instance_ids=(
                str(session.get("workflow_instance_id") or "") for session in sessions
            ),
        )
        return {
            **listing,
            "sessions": sessions,
            "workspaces": workspaces,
            "queue": queue[:queue_limit],
            "queue_total": len(queue),
        }

    def lease_agent_session(
        self, *, project_id: str, runner_id: str, platform: str,
        idempotency_key: str, session_secret: str, source_key_id: str = "",
        source_user_id: str = "", hard_deadline_seconds: int = 24 * 60 * 60,
    ) -> dict[str, Any]:
        """Lease one node; the node owns its brief and its completion boundary."""
        plan = self._dispatch_plan(project_id=project_id)
        if not plan["project"]["settings"].get(AGENT_DISPATCH_SETTING, False):
            return {"session": None, "reason": "agent_dispatch_disabled"}
        session = self.agent_sessions.lease(
            project_id=project_id, candidates=plan["candidates"], runner_id=runner_id,
            platform=platform, idempotency_key=idempotency_key, session_secret=session_secret,
            source_key_id=source_key_id, source_user_id=source_user_id,
            hard_deadline_seconds=hard_deadline_seconds,
        )
        if session is None:
            return {"session": None, "reason": "no_dispatchable_agent_task"}
        if session["status"] not in {"offered", "active"}:
            return {"session": present_session(session), "reason": "idempotent_session_closed"}
        return {"session": present_session(session)}

    def _workflow_assignment(
        self, tx: Any, project_id: str, instance_id: str, revision: int,
    ) -> dict[str, Any]:
        runtime = self.research.workflows.runtime
        runtime.require_assignment(conn=tx, project_id=project_id, instance_id=instance_id, revision=revision)
        packet = runtime.assignment(conn=tx, project_id=project_id, instance_id=instance_id)
        instruction = (
            f"{packet['label']}\nProject: {project_id}\n"
            f"Workflow: {packet['workflow']} {instance_id}; node {packet['state']}; revision {revision}.\n\n"
            f"{packet['brief']}\n\nExact references:\n"
            + json.dumps(packet["references"], indent=2)
            + f"\n\n{packet['handoff']}\n"
            "Use workflow.status_and_next with this instance_id to refresh available actions. "
            "Workflow transitions must carry this instance_id, expected_revision, and a stable request_id. "
            "If native MCP is unavailable, use `merv-client call TOOL --arguments JSON`."
        )
        if any(ref["kind"] == "review_request" for ref in packet["references"]):
            instruction += (
                "\nThe assigned credential supplies reviewer authority. Start the referenced review "
                "with reviewer_capability='assigned' and caller_session_id='assigned'; Merv binds "
                "them to this independent session. Submit one verdict and exit."
            )
        return {
            **packet, "schema_version": 2, "instruction": instruction,
            "title": packet["label"], "subtitle": packet["workflow"],
            "packet": {"task": packet["label"], "workflow": packet["workflow"],
                       "project": project_id, "revision": revision},
            "navigation": {"type": packet["workflow"], "target_id": instance_id},
        }

    def _activate_workflow_session(self, tx: Any, row: Mapping[str, Any]) -> None:
        self.research.workflows.activate(
            conn=tx, project_id=str(row["project_id"]), instance_id=str(row["workflow_instance_id"]),
            revision=int(row["workflow_revision"]), session_id=str(row["id"]),
        )

    def halt_agent_sessions(self, *, project_id: str) -> dict[str, Any]:
        """Stop every live session now; runners kill their children on reconcile."""
        halted = self.agent_sessions.halt(project_id=project_id)
        listing = self.agent_sessions.list(project_id=project_id)
        return {"halted": halted, **listing, "sessions": [present_session(row) for row in listing["sessions"]]}

    # Workflow and context -------------------------------------------------

    def status(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> dict[str, Any]:
        return self._workflow.status_and_next(
            project_id=project_id,
            experiment_id=experiment_id,
            task_id=task_id,
        )

    def status_for_agent(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
        instance_id: str | None = None,
    ) -> dict[str, Any]:
        if instance_id is not None:
            return self.research.workflows.describe(project_id=str(project_id or ""), instance_id=instance_id)
        return self._workflow.status_and_next_agent(
            project_id=project_id,
            experiment_id=experiment_id,
            task_id=task_id,
        )

    def submit_candidate(
        self,
        *,
        project_id: str,
        name: str,
        source_kind: str,
        source_ref: str,
        expected_sha256: str = "",
        metrics: dict[str, float],
        primary_metric: str,
        higher_is_better: bool,
        validation_summary: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """Resolve a durable source or register a pathless worktree nomination."""
        if source_kind == "experiment_workspace":
            source_experiment_id = source_ref
        else:
            if expected_sha256:
                raise ValidationError("expected_sha256 applies only to workspaces")
            expected_sha256, discovered_source = self._candidate_pointer(
                project_id=project_id, kind=source_kind, ref=source_ref
            )
            source_experiment_id = discovered_source
        return self.research.submit_candidate(
            project_id=project_id,
            name=name,
            source_kind=source_kind,
            source_ref=source_ref,
            source_experiment_id=source_experiment_id,
            expected_sha256=expected_sha256,
            metrics=metrics,
            primary_metric=primary_metric,
            higher_is_better=higher_is_better,
            validation_summary=validation_summary,
            idempotency_key=idempotency_key,
        )

    def stage_candidate(
        self,
        *,
        project_id: str,
        candidate_id: str,
        stage_kind: str,
        stage_ref: str,
        content_sha256: str = "",
        manifest_sha256: str = "",
    ) -> dict[str, Any]:
        """Resolve and pin evaluator-captured bytes, then append the receipt."""
        if stage_kind == "evaluator_receipt":
            if not content_sha256 or not manifest_sha256:
                raise ValidationError(
                    "evaluator_receipt staging requires receipt/content/manifest hashes only"
                )
        else:
            content_sha256, _ = self._candidate_pointer(
                project_id=project_id, kind=stage_kind, ref=stage_ref
            )
            manifest_sha256 = ""
        return self.research.stage_candidate(
            project_id=project_id,
            candidate_id=candidate_id,
            stage_kind=stage_kind,
            stage_ref=stage_ref,
            content_sha256=content_sha256,
            manifest_sha256=manifest_sha256,
        )

    def _candidate_pointer(
        self, *, project_id: str, kind: str, ref: str
    ) -> tuple[str, str]:
        if kind == "artifact":
            found = self.artifacts.get(artifact_ids=(ref,), project_id=project_id)
            if not found or found[0].status != "complete":
                raise ValidationError(f"complete artifact not found: {ref}")
            item = found[0]
            source = item.target_id if item.target_type == "experiment" else ""
            return item.sha256, source
        if kind != "storage_object":
            raise ValidationError(f"unknown durable candidate source: {kind}")
        item = self.objects.get_object(project_id=project_id, object_id=ref)["object"]
        if item.get("status") != "available":
            raise ValidationError(f"storage object is not available: {ref}")
        self.objects.manage(project_id=project_id, object_id=ref, action="pin")
        link = self.produced_objects.association(project_id=project_id, object_id=ref)
        source = (
            str(link["target_id"])
            if link is not None and link.get("target_type") == "experiment"
            else ""
        )
        return str(item["content_sha256"]), source

    def project_list(
        self, *, user_id: str = "", project_id: str = ""
    ) -> dict[str, Any]:
        return self._reachable_projects(
            user_id=user_id,
            key_project_id=project_id,
        )

    def project(
        self,
        *,
        action: str,
        project_id: str = "",
        name: str = "",
        summary: str = "",
        tenant_id: str | None = None,
        user_id: str = "",
        key_project_id: str = "",
    ) -> dict[str, Any]:
        if action == "list":
            return self._reachable_projects(
                user_id=user_id,
                key_project_id=key_project_id,
            )
        if action == "current":
            if not key_project_id:
                return {
                    "exists": False,
                    "hint": (
                        "This credential reaches every project listed here, so "
                        "there is no single current project. Pass project_id "
                        "explicitly on each call."
                    ),
                    **self._reachable_projects(
                        user_id=user_id,
                        key_project_id=key_project_id,
                    ),
                }
            project = self.research.get_project(project_id=key_project_id)
            return {
                "exists": True,
                "project": {
                    "id": project["id"],
                    "name": project["name"],
                    "summary": project.get("summary", ""),
                },
            }
        if action == "create":
            return self.research.create_project(
                name=name,
                summary=summary,
                tenant_id=tenant_id,
                user_id=user_id,
            )
        if action == "overview":
            resolved = project_id or key_project_id
            if not resolved:
                raise ValidationError(
                    "project_id is required: this credential is not bound to a "
                    'single project. Call project(action="list") to see the '
                    "projects you can work in, then pass project_id explicitly.",
                    details={"field": "project_id"},
                )
            return self._project_context.build(project_id=resolved)
        raise ValidationError(f'action="{action}" is not recognized for project')

    def _reachable_projects(
        self, *, user_id: str, key_project_id: str
    ) -> dict[str, Any]:
        listed = self.research.reachable_projects(
            user_id=user_id,
            key_project_id=key_project_id,
        )["projects"]
        return {
            "projects": [
                {
                    "id": project["id"],
                    "name": project["name"],
                    "summary": project.get("summary", ""),
                    "status": project.get("status", ""),
                    "created_at": project.get("created_at", ""),
                }
                for project in listed
            ]
        }

    # Experiments ----------------------------------------------------------

    def create_experiment(self, **kwargs: Any) -> dict[str, Any]:
        return create_experiment(self.research, **kwargs)

    def experiments(
        self, *, project_id: str | None = None, rich: bool = False
    ) -> dict[str, Any] | list[dict[str, Any]]:
        states = self.research.project_experiments(project_id=project_id)
        ids = tuple(state.id for state in states if state.id)
        resolved = (
            str(states[0].project_id or project_id or "") if states else ""
        )
        objects = (
            self.produced_objects.by_experiment(project_id=resolved, experiment_ids=ids)
            if ids
            else {}
        )
        workspaces = (
            self.agent_sessions.workspaces(
                project_id=resolved,
                instance_ids=ids,
            )
            if ids and resolved
            else {}
        )
        consolidations = (
            self.research.reflections.experiment_consolidations(
                project_id=resolved,
                experiment_ids=ids,
            )
            if ids and resolved
            else {}
        )
        presented = [
            (rich_experiment_state if rich else slim_experiment_state)(
                state,
                storage_objects=objects.get(state.id, []),
                code_workspace=workspaces.get(state.id),
                consolidation_history=consolidations.get(state.id, []),
            )
            for state in states
        ]
        return presented if rich else {"experiments": presented}

    def experiment(
        self,
        *,
        experiment_id: str,
        project_id: str | None = None,
        review_id: str = "",
        rich: bool = False,
    ) -> dict[str, Any]:
        state = self.research.experiments.get_state(
            experiment_id=experiment_id,
            project_id=project_id,
        )
        resolved_project_id = str(state.project_id or project_id or "")
        response = (rich_experiment_state if rich else slim_experiment_state)(
            state,
            storage_objects=self.produced_objects.by_experiment(
                project_id=resolved_project_id, experiment_ids=(experiment_id,),
            )[experiment_id],
            code_workspace=self.agent_sessions.workspaces(
                project_id=resolved_project_id, instance_ids=(experiment_id,),
            ).get(experiment_id),
            consolidation_history=self.research.reflections.experiment_consolidations(
                project_id=resolved_project_id, experiment_ids=(experiment_id,),
            ).get(experiment_id, []),
        )
        if review_id and not rich:
            body = review_body(state.reviews, review_id=review_id)
            if body is None:
                known = [
                    review.id for review in state.reviews
                ]
                raise ValidationError(
                    f"no review {review_id} on this experiment. Reviews here: "
                    f"{', '.join(known) or 'none yet'}.",
                    details={"field": "review_id", "review_ids": known},
                )
            response["review"] = body
        return response

    def transition_experiment(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
        rich: bool = False,
    ) -> dict[str, Any]:
        operation = self._transition.execute if rich else self._transition.agent
        return operation(
            experiment_id=experiment_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
        )

    def exhibit(self, *, project_id: str, experiment_id: str) -> dict[str, Any]:
        return self._exhibits.preview(
            project_id=project_id,
            experiment_id=experiment_id,
        )

    # Tasks ----------------------------------------------------------------

    def create_task(
        self,
        *,
        name: str,
        goal: str,
        deliverables: list[str] | str | None = None,
        depends_on: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        state = self.research.tasks.create(
            name=name,
            goal=goal,
            deliverables=deliverables,
            depends_on=depends_on,
            project_id=project_id,
        )
        return slim_task_state(state)

    def tasks(
        self, *, project_id: str | None = None, rich: bool = False
    ) -> dict[str, Any] | list[dict[str, Any]]:
        states = self.research.project_tasks(project_id=project_id)
        presented = [
            (rich_task_state if rich else slim_task_state)(state)
            for state in states
        ]
        return presented if rich else {"tasks": presented}

    def task(
        self,
        *,
        task_id: str,
        project_id: str | None = None,
        review_id: str = "",
        rich: bool = False,
    ) -> dict[str, Any]:
        state = self.research.tasks.get_state(task_id=task_id, project_id=project_id)
        if rich:
            return rich_task_state(state)
        response = slim_task_state(state)
        if review_id:
            body = review_body(state.reviews, review_id=review_id)
            if body is None:
                known = [
                    review.id for review in state.reviews
                ]
                raise ValidationError(
                    f"no review {review_id} on this task. Reviews here: "
                    f"{', '.join(known) or 'none yet'}.",
                    details={"field": "review_id", "review_ids": known},
                )
            response["review"] = body
        return response

    def transition_task(
        self,
        *,
        task_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
        rich: bool = False,
    ) -> dict[str, Any]:
        operation = self._task_transition.execute if rich else self._task_transition.agent
        return operation(
            task_id=task_id,
            transition=transition,
            evidence=evidence,
            project_id=project_id,
        )

    # Reviews and reflections ---------------------------------------------

    def request_review(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        reason: str = "",
        producer_session_id: str = "main",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        return request_review(
            self.research,
            target_type=target_type,
            target_id=target_id,
            role=role,
            reason=reason,
            producer_session_id=producer_session_id,
            project_id=project_id,
        )

    def start_review(
        self,
        *,
        review_request_id: str,
        reviewer_capability: str,
        declared_agent: str = "",
        caller_session_id: str = "",
        assigned_agent_session_id: str = "",
        assigned_review_request_id: str = "",
    ) -> dict[str, Any]:
        return start_review(
            research=self.research,
            artifacts=self.artifacts,
            experiment_context=self._experiment_context,
            project_context=self._project_context,
            task_context=self._task_context,
            review_request_id=review_request_id,
            reviewer_capability=reviewer_capability,
            declared_agent=declared_agent,
            caller_session_id=caller_session_id,
            assigned_agent_session_id=assigned_agent_session_id,
            assigned_review_request_id=assigned_review_request_id,
        )

    def review_status(
        self,
        *,
        target_type: str,
        target_id: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        return read_review_status(
            research=self.research,
            feed=self.feed,
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
        )

    def create_reflection(
        self,
        *,
        project_id: str,
        title: str = "",
        lenses: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return present_agent_reflection_state(
            self.research.reflections.create(
                project_id=project_id,
                title=title,
                lenses=lenses or [],
            ),
            include_content=False,
        )

    def reflection(
        self,
        *,
        project_id: str,
        reflection_id: str,
        include_content: bool = False,
    ) -> dict[str, Any]:
        return present_agent_reflection_state(
            self.research.reflections.get_state(
                project_id=project_id,
                reflection_id=reflection_id,
                include_content=True,
            ),
            include_content=include_content,
        )

    def reflections(self, *, project_id: str) -> dict[str, Any]:
        result = self.research.reflections.list_reflections(project_id=project_id)
        return present_reflection_overview(
            {
                "count": result.get(
                    "count",
                    len(result.get("reflections", [])),
                ),
                **result,
            }
        )

    def transition_reflection(
        self,
        *,
        project_id: str,
        reflection_id: str,
        transition: str,
    ) -> dict[str, Any]:
        return present_agent_reflection_state(
            self.research.reflections.transition(
                project_id=project_id,
                reflection_id=reflection_id,
                transition=transition,
            ),
            include_content=False,
        )

    def consolidation(self, *, project_id: str, reflection_id: str) -> dict[str, Any]:
        state = self.research.reflections.get_state(
            project_id=project_id,
            reflection_id=reflection_id,
            include_content=True,
        )
        experiment_ids = tuple(
            str(item.get("id") or "")
            for item in (state.corpus or {}).get("terminal_experiments", [])
            if isinstance(item, dict) and item.get("id")
        )
        packet = consolidation_packet(
            state,
            workspaces=self.agent_sessions.workspaces(
                project_id=project_id,
                instance_ids=experiment_ids,
            ),
        )
        if not packet.get("base_sha"):
            session = next(
                (
                    item
                    for item in self.agent_sessions.list(project_id=project_id)[
                        "sessions"
                    ]
                    if item.get("target_type") == "reflection"
                    and item.get("target_id") == reflection_id
                    and session_kind(item.get("execution") or {}) == "consolidation"
                    and item.get("status") in {"offered", "active"}
                ),
                {},
            )
            packet["base_sha"] = str(session.get("base_sha") or "")
        return packet

    def submit_consolidation(
        self,
        *,
        project_id: str,
        reflection_id: str,
        base_sha: str,
        proposal_sha: str,
        summary: str,
        validation: dict[str, Any] | None,
        decisions: list[dict[str, Any]],
        producer_session_id: str = "",
    ) -> dict[str, Any]:
        state = self.research.reflections.get_state(
            project_id=project_id,
            reflection_id=reflection_id,
        )
        experiment_ids = tuple(
            str(item.get("id") or "")
            for item in (state.corpus or {}).get("terminal_experiments", [])
            if isinstance(item, dict) and item.get("id")
        )
        workspaces = self.agent_sessions.workspaces(
            project_id=project_id,
            instance_ids=experiment_ids,
        )
        decisions = [
            {
                **decision,
                # Experiment workspace lineage is Merv-owned evidence. Never
                # trust a consolidating agent to tell us which branch head it
                # reviewed.
                "source_sha": str(
                    workspaces.get(str(decision.get("experiment_id") or ""), {}).get(
                        "head_sha"
                    )
                    or ""
                ),
            }
            for decision in decisions
        ]
        return present_agent_reflection_state(
            self.research.reflections.submit_consolidation(
                project_id=project_id,
                reflection_id=reflection_id,
                base_sha=base_sha,
                proposal_sha=proposal_sha,
                summary=summary,
                validation=validation,
                decisions=decisions,
                producer_session_id=producer_session_id,
            ),
            include_content=False,
        )

    def prepare_agent_advance(
        self, *, project_id: str, instance_id: str, runner_id: str
    ) -> dict[str, Any] | None:
        """Record the exact central compare-and-swap a runner may perform.

        ``instance_id`` is the consolidating reflection; a receipt whose Git
        work already bound hands the same shape back so the runner's no-op
        advance can retry the settle that publishes it.
        """
        pending, status = self._pending_advance(project_id=project_id)
        if pending is None or pending["instance_id"] != instance_id:
            raise WorkflowError("no reviewed proposal awaits a central advance for this instance")
        if status == "bound" and pending["advance_id"]:
            return pending
        advance = self.research.reflections.prepare_advance(
            project_id=project_id,
            reflection_id=instance_id,
            runner_id=runner_id,
        )
        return {**_advance_view(advance), "revision": pending["revision"]}

    def pending_agent_advance(self, *, project_id: str) -> dict[str, Any] | None:
        """The one reviewed proposal the runner may try to advance, or None."""
        return self._pending_advance(project_id=project_id)[0]

    def _pending_advance(self, *, project_id: str) -> tuple[dict[str, Any] | None, str]:
        reflection = self.research.snapshot(project_id=project_id).open_reflection
        if not reflection or reflection.status != "consolidating":
            return None, ""
        state = self.research.reflections.get_state(
            project_id=project_id,
            reflection_id=str(reflection.id),
        )
        consolidation = state.consolidation or {}
        proposal = consolidation.get("proposal") or {}
        advance = consolidation.get("advance") or {}
        review_passed = any(
            item.kind == "review"
            and item.role == "consolidation_reviewer"
            and item.satisfied
            for item in state.gate_checklist.items
        )
        if not proposal or not review_passed:
            return None, ""
        status = str(advance.get("status") or "")
        if status in {"stale", "failed"}:
            return None, status
        sources = [
            {"id": str(decision.get("experiment_id") or ""), "sha": str(decision.get("source_sha") or "")}
            for decision in consolidation.get("decisions") or ()
            if decision.get("integration_kind") not in {None, "", "none"}
        ]
        # A ``bound`` receipt is one whose publish was blocked: the Git CAS is
        # done, so only the settle remains and the runner's no-op advance
        # retries it through the same prepare/settle pair.
        return {
            "advance_id": str(advance.get("id") or ""),
            "instance_id": str(state.id),
            "revision": proposal["revision"],
            "expected_sha": str(proposal["base_sha"]),
            "target_sha": str(proposal["proposal_sha"]),
            "sources": sources,
        }, status

    def settle_agent_advance(
        self,
        *,
        project_id: str,
        advance_id: str,
        runner_id: str,
        observed_sha: str,
        proposal_parents: list[str] | None = None,
        diffstat: dict[str, Any] | None = None,
        ancestry: dict[str, bool] | None = None,
        error: str = "",
    ) -> dict[str, Any]:
        state = self.research.reflections.settle_advance(
            project_id=project_id,
            advance_id=advance_id,
            runner_id=runner_id,
            observed_sha=observed_sha,
            proposal_parents=proposal_parents,
            diffstat=diffstat,
            ancestry=ancestry,
            error=error,
        )
        consolidation = state.consolidation or {}
        advance = consolidation.get("advance") or {}
        return {
            "advance_id": advance_id,
            "instance_id": str(state.id),
            "status": str(advance.get("status") or ""),
            "observed_sha": str(advance.get("observed_sha") or ""),
            "outcome": str(state.status or ""),
        }

    # Read models ----------------------------------------------------------

    def dashboard(self, *, project_id: str) -> dict[str, Any]:
        snapshot = self.research.snapshot(project_id=project_id)
        status, work, experiments = self._workflow.project_models(
            snapshot=snapshot,
            sandboxes=self.sandboxes.for_project(project_id=project_id),
        )
        artifacts = [
            artifact_list_record(artifact)
            for artifact in self.artifacts.scan(project_id=project_id)
        ]
        reviews = review_queue(self.research, project_id=project_id)
        claims = status["project"]["active_claims"]
        active_experiments = work["active_experiments"]
        active_tasks = work.get("active_tasks", [])
        active_processes = work["active_processes"]
        active = active_experiments[0] if active_experiments else None
        result = {
            "project": status["project"],
            "claims": claims,
            "experiments": experiments,
            "tasks": [rich_task_state(task) for task in snapshot.tasks],
            "active_experiments": active_experiments,
            "active_tasks": active_tasks,
            "active_processes": active_processes,
            "artifacts": artifacts,
            "reviews": reviews,
            "pending_change_sets": [],
            "recent_events": self.research.recent_events(
                project_id=project_id,
                limit=25,
            )["events"],
            "stats": {
                "claims": len(claims),
                "experiments": len(experiments),
                "tasks": len(snapshot.tasks),
                "active_experiments": len(active_experiments),
                "active_tasks": len(active_tasks),
                "active_processes": len(active_processes),
                "artifacts": len(artifacts),
                "open_reviews": len(reviews["requests"]),
            },
            "workflow": active.get("workflow") if active else status["workflow"],
            "active_experiment": active,
        }
        return result

    def compute_cost(self, *, project_id: str) -> dict[str, Any]:
        spend = self.sandboxes.project_spend(project_id=project_id)
        names = {
            str(experiment.get("id") or ""): str(experiment.get("name") or "")
            for experiment in self.research.experiments.list_experiment_summaries(
                project_id=project_id
            )
        }
        for entry in spend["by_experiment"]:
            entry["experiment_name"] = names.get(entry["experiment_id"], "")
        return spend

__all__ = ["Application", "present_session"]


def session_kind(execution: Mapping[str, Any]) -> str:
    """The job kind the Auto-run page shows, read off the node's declared policy."""
    if execution.get("read_only"):
        return "review"
    if (execution.get("workspace") or {}).get("advances_central"):
        return "consolidation"
    return "workflow"


def _reference_id(references: Any, kind: str) -> str:
    for item in references or ():
        if isinstance(item, Mapping) and item.get("kind") == kind:
            return str(item.get("id") or "")
    return ""


def present_session(row: Mapping[str, Any]) -> dict[str, Any]:
    """Decorate a lease with the native ids and job kind the UI links by.

    Agent Sessions stores the packet's workflow name and instance id opaquely;
    only research knows that an ``experiment`` instance is an experiment.
    """
    target_type = str(row.get("target_type") or "")
    target_id = str(row.get("target_id") or "")
    return {
        **row,
        "kind": session_kind(row.get("execution") or {}),
        "experiment_id": target_id if target_type == "experiment" else "",
        "reflection_id": target_id if target_type == "reflection" else "",
        "review_request_id": _reference_id(row.get("references"), "review_request"),
    }


def _advance_view(advance: Mapping[str, Any]) -> dict[str, Any]:
    """The runner's judgment-free CAS instruction, with opaque lineage ids."""
    return {
        "advance_id": str(advance.get("id") or ""),
        "instance_id": str(advance.get("reflection_id") or ""),
        "revision": advance.get("revision"),
        "expected_sha": str(advance.get("expected_sha") or ""),
        "target_sha": str(advance.get("target_sha") or ""),
        "sources": [
            {"id": str(item.get("experiment_id") or ""), "sha": str(item.get("source_sha") or "")}
            for item in advance.get("sources") or ()
        ],
    }


