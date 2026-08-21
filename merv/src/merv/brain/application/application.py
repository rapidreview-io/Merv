# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""The concrete cross-module Application root.

Surface calls this object only for operations that coordinate multiple brain
modules.  Module-local operations continue to call their owning public root.
This first consolidation keeps the existing behavior intact while removing
the composition-wide bag of one-use Application objects.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from merv.shared.storage_guidance import storage_guidance

from ..agent_sessions import AgentSessions
from ..artifacts import Artifacts
from ..feed import FeedService
from ..kernel.utils import ValidationError, parse_iso
from ..object_storage import ObjectStorage
from ..research_core import (
    EXPERIMENT_TERMINAL_STATUSES,
    EXPERIMENT_WORKFLOW,
    REFLECTION_WORKFLOW,
    Research,
    agent_dispatch_enabled,
)
from ..sandbox import SandboxEngine
from .experiments.context import ExperimentContextQuery
from .experiments.create import create_experiment
from .experiments.exhibits import ExperimentExhibits
from .experiments.presentation import (
    review_body,
    rich_experiment_state,
    slim_experiment_state,
)
from .experiments.transition import TransitionExperiment
from .mlflow import ExperimentTracking, MlflowIntegration
from .project_context import ProjectContextQuery
from .queries import LogicGraphQuery
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
from .workflow import (
    StatusAndNextQuery,
    artifact_list_record,
    project_at_a_glance,
)


class Application:
    """Coordinate workflows spanning Research and one or more sibling modules."""

    def __init__(
        self,
        *,
        research: Research,
        artifacts: Artifacts,
        feed: FeedService,
        sandboxes: SandboxEngine,
        objects: ObjectStorage,
        agent_sessions: AgentSessions,
        tracking: ExperimentTracking | None = None,
    ) -> None:
        self.research = research
        self.artifacts = artifacts
        self.feed = feed
        self.sandboxes = sandboxes
        self.objects = objects
        self.agent_sessions = agent_sessions
        self._mlflow = MlflowIntegration(
            research=research,
            feed=feed,
            objects=objects,
            adapter=tracking,
        )

        self._project_context = ProjectContextQuery(
            research=research,
            artifacts=artifacts,
        )
        self._experiment_context = ExperimentContextQuery(artifacts=artifacts)
        self._task_context = TaskContextQuery(artifacts=artifacts)
        self._task_transition = TransitionTask(research=research, feed=feed)
        self._exhibits = ExperimentExhibits(
            research=research,
            artifacts=artifacts,
            mlflow=self._mlflow,
        )
        self._transition = TransitionExperiment(
            research=research,
            artifacts=artifacts,
            feed=feed,
            mlflow=self._mlflow,
            exhibits=self._exhibits,
            objects=objects,
        )
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
            objects=objects,
            context=self._experiment_context,
            project_context=self._project_context,
            task_context=self._task_context,
        )
        self._graphs = LogicGraphQuery(research=research, artifacts=artifacts)

    # Coding-agent execution ----------------------------------------------

    def _dispatch_plan(self, *, project_id: str) -> dict[str, Any]:
        """Everything a claim needs, in claim order: review requests first,
        then a pending consolidation, then experiments needing an owner (the
        published wave first). Shared with ``dispatch_queue`` so the page and
        the runner agree on what is next."""
        snapshot = self.research.snapshot(project_id=project_id)
        active = [
            experiment
            for experiment in snapshot.experiments
            if str(experiment["status"]) not in EXPERIMENT_TERMINAL_STATUSES
        ]
        active_by_id = {str(item["id"]): item for item in active}
        published = snapshot.latest_published_reflection or {}
        wave_ids = [
            str(item.get("experiment_id") or "")
            for item in published.get("materialized_experiments", [])
        ]
        wave_order = {
            experiment_id: index for index, experiment_id in enumerate(wave_ids)
        }
        owners = sorted(
            active,
            key=lambda item: (
                0 if str(item["id"]) in wave_order else 1,
                wave_order.get(str(item["id"]), 0),
                str(item.get("created_at") or ""),
                str(item["id"]),
            ),
        )
        workspace_by_experiment = self.agent_sessions.workspaces(
            project_id=project_id,
            experiment_ids=active_by_id,
        )
        reflection = snapshot.open_reflection or {}
        now = datetime.now(UTC)
        requests = [
            request
            for request in self.research.review_queue(project_id=project_id)["requests"]
            if request.get("status") in {"requested", "started"}
            and (parse_iso(request.get("expires_at")) or now) > now
            and (
                (
                    request.get("target_type") == "experiment"
                    and str(request.get("target_id") or "") in active_by_id
                )
                or (
                    request.get("target_type") == "reflection"
                    and str(request.get("target_id") or "")
                    == str(reflection.get("id") or "")
                    and reflection.get("status")
                    in {"reflection_review", "consolidating"}
                )
            )
        ]
        waiting_for_review = {
            (str(request["target_type"]), str(request["target_id"]))
            for request in requests
        }
        review_candidates = [
            {
                **(
                    active_by_id[str(request["target_id"])]
                    if request["target_type"] == "experiment"
                    else reflection
                ),
                "target_type": str(request["target_type"]),
                "target_id": str(request["target_id"]),
                "kind": "review",
                "review_request_id": str(request["id"]),
                "source_sha": str(
                    (request.get("target_snapshot") or {}).get("code_sha") or ""
                ),
            }
            for request in reversed(requests)
        ]
        consolidation_candidates: list[dict[str, Any]] = []
        if reflection.get("status") == "consolidating" and (
            ("reflection", str(reflection["id"])) not in waiting_for_review
        ):
            consolidation = reflection.get("consolidation") or {}
            advance = consolidation.get("advance") or {}
            review_item = next(
                (
                    item
                    for item in (reflection.get("gate_checklist") or {}).get(
                        "items", []
                    )
                    if item.get("kind") == "review"
                    and item.get("role") == "consolidation_reviewer"
                ),
                {},
            )
            if not review_item.get("satisfied") or advance.get("status") in {
                "stale",
                "failed",
            }:
                proposal = consolidation.get("proposal") or {}
                consolidation_candidates.append(
                    {
                        **reflection,
                        "target_type": "reflection",
                        "target_id": str(reflection["id"]),
                        "kind": "consolidation",
                        "source_sha": str(
                            advance.get("observed_sha")
                            or proposal.get("base_sha")
                            or ""
                        ),
                    }
                )
        owner_candidates = [
            {
                **experiment,
                "target_type": "experiment",
                "target_id": str(experiment["id"]),
                "kind": "experiment",
                "source_sha": str(
                    workspace_by_experiment.get(str(experiment["id"]), {}).get(
                        "head_sha"
                    )
                    or ""
                ),
            }
            for experiment in owners
            if ("experiment", str(experiment["id"])) not in waiting_for_review
        ]
        return {
            "snapshot": snapshot,
            "active_by_id": active_by_id,
            "reflection": reflection,
            "requests": requests,
            "candidates": review_candidates + consolidation_candidates + owner_candidates,
        }

    def dispatch_queue(self, *, project_id: str) -> list[dict[str, Any]]:
        """What auto-run would pick up next, in order, whether or not anything
        can pick it up right now: candidates without a live session. Read-only;
        the page shows these as waiting rows and counts them in its headline."""
        plan = self._dispatch_plan(project_id=project_id)
        live = self.agent_sessions.live_targets(project_id=project_id)
        queue: list[dict[str, Any]] = []
        for candidate in plan["candidates"]:
            kind = str(candidate.get("kind") or "experiment")
            key = (
                ("review", str(candidate.get("review_request_id") or ""))
                if kind == "review"
                else (kind, str(candidate.get("target_type") or ""), str(candidate.get("target_id") or ""))
            )
            if key in live:
                continue
            title = str(candidate.get("name") or "")
            if not title and str(candidate.get("target_type") or "") == "reflection":
                title = "Project reflection"
            queue.append(
                {
                    "target_type": str(candidate.get("target_type") or ""),
                    "target_id": str(candidate.get("target_id") or ""),
                    "kind": kind,
                    "review_request_id": str(candidate.get("review_request_id") or ""),
                    "title": title,
                    "status": str(candidate.get("status") or ""),
                    "attempt_index": int(candidate.get("attempt_index") or 0),
                }
            )
        return queue

    def list_agent_sessions(
        self, *, project_id: str, queue_limit: int = 50
    ) -> dict[str, Any]:
        """The Auto-run page's one read: sessions, runners, and the queue.

        ``queue`` carries at most ``queue_limit`` rows; ``queue_total`` is the
        real count so the headline never reports a truncated list as the whole.
        """
        queue = self.dispatch_queue(project_id=project_id)
        listing = self.agent_sessions.list(project_id=project_id)
        # The current state of each worktree the listed jobs worked in
        # (branch, base, head, commit and diff counts), keyed by experiment:
        # what "continuing each other's work" looks like in numbers.
        workspaces = self.agent_sessions.workspaces(
            project_id=project_id,
            experiment_ids=(
                str(session.get("experiment_id") or "")
                for session in listing["sessions"]
                if session.get("experiment_id")
            ),
        )
        public_keys = {
            "branch", "base_sha", "head_sha", "commit_count",
            "files_changed", "insertions", "deletions", "updated_at",
        }
        return {
            **listing,
            "workspaces": {
                experiment_id: {key: value for key, value in row.items() if key in public_keys}
                for experiment_id, row in workspaces.items()
            },
            "queue": queue[:queue_limit],
            "queue_total": len(queue),
        }

    def claim_agent_session(
        self,
        *,
        project_id: str,
        runner_id: str,
        platform: str,
        idempotency_key: str,
        session_secret: str,
        source_key_id: str = "",
        source_user_id: str = "",
        hard_deadline_seconds: int = 24 * 60 * 60,
    ) -> dict[str, Any]:
        """Assign the next experiment, review, or consolidation task."""
        plan = self._dispatch_plan(project_id=project_id)
        if not agent_dispatch_enabled(plan["snapshot"].project):
            return {"session": None, "reason": "agent_dispatch_disabled"}
        active_by_id = plan["active_by_id"]
        reflection = plan["reflection"]
        requests = plan["requests"]
        session = self.agent_sessions.claim(
            project_id=project_id,
            candidates=plan["candidates"],
            runner_id=runner_id,
            platform=platform,
            idempotency_key=idempotency_key,
            session_secret=session_secret,
            source_key_id=source_key_id,
            source_user_id=source_user_id,
            hard_deadline_seconds=hard_deadline_seconds,
        )
        if session is None:
            return {"session": None, "reason": "no_dispatchable_agent_task"}
        target_type = str(session["target_type"])
        target_id = str(session["target_id"])
        target = (
            active_by_id.get(target_id)
            if target_type == "experiment"
            else reflection if target_type == "reflection" else None
        )
        if target is None or session["status"] not in {"offered", "active"}:
            return {"session": session, "reason": "idempotent_session_closed"}
        request: dict[str, Any] | None = None
        if session["kind"] == "review":
            request = next(
                (
                    item
                    for item in requests
                    if item["id"] == session["review_request_id"]
                ),
                None,
            )
            if request is None:
                return {"session": session, "reason": "review_request_closed"}
            workflow = (
                EXPERIMENT_WORKFLOW
                if target_type == "experiment"
                else REFLECTION_WORKFLOW
            )
            review = workflow.review(str(request["role"]))
            skill = str(getattr(review, "skill", "") or "review")
            session["instruction"] = (
                f"Independently review Merv {target_type} {target_id} for "
                f"request {request['id']}. Follow the {skill} "
                "skill. Begin with review.start using this review_request_id; "
                "the assigned session credential supplies reviewer authority, "
                "so pass reviewer_capability='assigned' and "
                "caller_session_id='assigned' (Merv replaces it with this "
                "session's verified identity). Submit exactly one verdict with "
                "review.submit. If this platform has no native MCP support, "
                "invoke tools with `merv-client call TOOL --arguments JSON`."
            )
        elif session["kind"] == "consolidation":
            session["instruction"] = (
                f"Consolidate the code for authoritative Merv reflection "
                f"{target_id} in project {project_id}. Start with "
                "consolidation.get. Review every experiment in its packet, "
                "then use this proposal worktree to select, combine, rewrite, "
                "or omit code as needed. Run appropriate validation, commit "
                "the coherent proposal, and call consolidation.submit with "
                "the exact base/proposal SHAs and one reasoned decision for "
                "every experiment. Each decision must name its actual Git "
                "integration kind; Merv supplies the experiment branch head "
                "and the runner verifies ancestry. Then call review.request "
                "with target_type="
                "'reflection', this reflection id, and role="
                "'consolidation_reviewer'; end this host session and do not "
                "perform the review yourself. The reflection is authoritative "
                "and cannot be reopened. If this platform has no native MCP "
                "support, invoke tools with `merv-client call TOOL --arguments JSON`."
            )
        else:
            session["instruction"] = (
                f"Resume Merv experiment {target_id} "
                f"({target.get('name') or 'unnamed experiment'}) in project "
                f"{project_id}. Use workflow.status_and_next for this exact "
                "experiment and follow the research-workflow instructions until "
                "the experiment reaches a terminal state. When review is "
                "required, call review.request, then end this host session; do "
                "not spawn or perform the review yourself. Merv will dispatch "
                "the request to a separately authenticated reviewer session. "
                "If this platform has no native MCP support, invoke tools with "
                "`merv-client call TOOL --arguments JSON`."
            )
        instruction = str(session["instruction"])
        assignment = self._agent_assignment(
            project_id=project_id,
            project=plan["snapshot"].project,
            session=session,
            target=target,
            request=request,
            instruction=instruction,
        )
        session = self.agent_sessions.set_assignment(
            session_id=str(session["id"]),
            assignment=assignment,
        )
        session["instruction"] = instruction
        return {"session": session}

    def _agent_assignment(
        self,
        *,
        project_id: str,
        project: dict[str, Any],
        session: dict[str, Any],
        target: dict[str, Any],
        request: dict[str, Any] | None,
        instruction: str,
    ) -> dict[str, Any]:
        """Build the immutable, human-readable packet shown in Auto-run."""
        kind = str(session.get("kind") or "experiment")
        target_type = str(session.get("target_type") or "experiment")
        attempt = max(int(session.get("attempt_index") or 0), 0)
        project_name = str(project.get("name") or "Project")
        target_name = (
            str(target.get("name") or "Experiment")
            if target_type == "experiment"
            else "Project reflection"
        )
        role = str((request or {}).get("role") or "")
        title = "Run experiment"
        task = "Run experiment"
        section = "execution"
        artifact_label = ""
        artifact_id = ""
        if kind == "consolidation":
            title = task = "Consolidate reflection"
            section = ""
        elif kind == "review":
            title, task, section, artifact_role = {
                "design_reviewer": (
                    "Review plan",
                    "Review experiment plan",
                    "design",
                    "plan",
                ),
                "attempt_reviewer": (
                    "Review results",
                    "Review experiment results",
                    "report",
                    "report",
                ),
                "reflection_reviewer": (
                    "Review reflection",
                    "Review project reflection",
                    "",
                    "reflection_doc",
                ),
                "consolidation_reviewer": (
                    "Review consolidation",
                    "Review code consolidation",
                    "",
                    "change_spec",
                ),
            }.get(role, ("Review work", "Review assigned work", "", ""))
            snapshot_artifacts = (request or {}).get("target_snapshot", {}).get(
                "artifacts", []
            )
            artifact_ref = next(
                (
                    str(item.get("artifact_id") or "")
                    for item in snapshot_artifacts
                    if str(item.get("role") or "") == artifact_role
                ),
                "",
            )
            if artifact_ref:
                found = self.artifacts.get(
                    artifact_ids=(artifact_ref,),
                    project_id=project_id,
                )
                if found:
                    artifact = found[0]
                    artifact_id = artifact.id
                    artifact_label = artifact.title or {
                        "plan": "Experiment plan",
                        "report": "Results report",
                        "reflection_doc": "Project reflection",
                        "change_spec": "Change specification",
                    }.get(artifact.role, artifact.path)

        packet: dict[str, Any] = {
            "task": task,
            "project": project_name,
            "attempt": attempt,
        }
        packet["experiment" if target_type == "experiment" else "reflection"] = (
            target_name
        )
        if artifact_label:
            packet["artifact"] = artifact_label
        return {
            "schema_version": 1,
            "title": title,
            "subtitle": target_name,
            "packet": packet,
            "navigation": {
                "type": target_type,
                "target_id": str(session.get("target_id") or ""),
                "section": section,
                "artifact_id": artifact_id,
            },
        }

    def attach_agent_session(
        self,
        *,
        session_id: str,
        runner_id: str,
        host_session_ref: str,
        workspace_ref: str = "",
        base_sha: str = "",
        head_sha: str = "",
        workspace_stats: dict[str, Any] | None = None,
        agent_setup: dict[str, Any] | None = None,
        telemetry: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "session": self.agent_sessions.attach(
                session_id=session_id,
                runner_id=runner_id,
                host_session_ref=host_session_ref,
                workspace_ref=workspace_ref,
                base_sha=base_sha,
                head_sha=head_sha,
                workspace_stats=workspace_stats,
                agent_setup=agent_setup,
                telemetry=telemetry,
            )
        }

    def agent_session_authority(self, *, session_id: str) -> dict[str, str]:
        """The immutable parent authority for one runner-owned session."""
        return self.agent_sessions.authority(session_id=session_id)

    def halt_agent_sessions(self, *, project_id: str) -> dict[str, Any]:
        """Stop every live session now; runners kill their children on reconcile."""
        halted = self.agent_sessions.halt(project_id=project_id)
        return {"halted": halted, **self.agent_sessions.list(project_id=project_id)}

    def release_agent_session(
        self,
        *,
        session_id: str,
        runner_id: str,
        reason: str,
        head_sha: str = "",
        workspace_stats: dict[str, Any] | None = None,
        telemetry: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "session": self.agent_sessions.release(
                session_id=session_id,
                runner_id=runner_id,
                reason=reason,
                head_sha=head_sha,
                workspace_stats=workspace_stats,
                telemetry=telemetry,
            )
        }

    def heartbeat_agent_session(
        self,
        *,
        session_id: str,
        runner_id: str,
        head_sha: str = "",
        workspace_stats: dict[str, Any] | None = None,
        telemetry: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "session": self.agent_sessions.heartbeat(
                session_id=session_id,
                runner_id=runner_id,
                head_sha=head_sha,
                workspace_stats=workspace_stats,
                telemetry=telemetry,
            )
        }

    def heartbeat_agent_runner(
        self,
        *,
        project_id: str,
        runner_id: str,
        machine: dict[str, Any],
        platforms: list[dict[str, Any]],
        capacity: int,
        inventory: dict[str, Any] | None = None,
        applied_version: int | None = None,
    ) -> dict[str, Any]:
        """Record presence and answer with the caller's own desired tuning."""
        response = self.agent_sessions.heartbeat_runner(
            project_id=project_id,
            runner_id=runner_id,
            machine=machine,
            platforms=platforms,
            capacity=capacity,
            inventory=inventory,
            applied_version=applied_version,
        )
        # ``runner`` keeps the pre-existing key for one release; the caller's own
        # row, the desired version, and the desired settings are the contract.
        return {"runner": response["presence"], **response}

    def set_agent_runner_settings(
        self, *, project_id: str, runner_ref: str, settings: dict[str, Any]
    ) -> dict[str, Any]:
        """Owner saves runner tuning; the runner pulls it on its next heartbeat."""
        return {
            "runner": self.agent_sessions.set_desired_settings(
                project_id=project_id, runner_ref=runner_ref, settings=settings
            )
        }

    def record_agent_session_trace(
        self,
        *,
        session_id: str,
        runner_id: str,
        events: list[Any],
        stderr_tail: str,
        complete: bool,
    ) -> dict[str, Any]:
        """The runner mirrors a bounded, redacted excerpt for the job card."""
        return self.agent_sessions.record_trace(
            session_id=session_id,
            runner_id=runner_id,
            events=events,
            stderr_tail=stderr_tail,
            complete=complete,
        )

    def agent_session_trace(self, *, project_id: str, session_id: str) -> dict[str, Any]:
        trace = self.agent_sessions.trace(project_id=project_id, session_id=session_id)
        return {"trace": trace}

    def halt_agent_session(self, *, project_id: str, session_id: str) -> dict[str, Any]:
        """Stop one live session now; its runner kills the child on reconcile."""
        return {
            "session": self.agent_sessions.halt_session(
                project_id=project_id, session_id=session_id
            )
        }

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
    ) -> dict[str, Any]:
        return self._workflow.status_and_next_agent(
            project_id=project_id,
            experiment_id=experiment_id,
            task_id=task_id,
        )

    def project_context(self, *, project_id: str | None = None) -> dict[str, Any]:
        return self._project_context.build(project_id=project_id)

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
        self.objects.pin(project_id=project_id, object_id=ref)
        return str(item["content_sha256"]), str(item.get("producing_experiment_id") or "")

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
            return self.project_context(project_id=resolved)
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

    def experiment_context(
        self,
        *,
        state: dict[str, Any],
        project_id: str | None = None,
        pinned_artifacts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return self._experiment_context.build(
            state=state,
            project_id=project_id,
            pinned_artifacts=pinned_artifacts,
        )

    # Experiments ----------------------------------------------------------

    def create_experiment(self, **kwargs: Any) -> dict[str, Any]:
        return create_experiment(self.research, **kwargs)

    def experiments(
        self, *, project_id: str | None = None, rich: bool = False
    ) -> dict[str, Any] | list[dict[str, Any]]:
        states = self.research.project_experiments(project_id=project_id)
        ids = tuple(str(state.get("id") or "") for state in states if state.get("id"))
        resolved = (
            str(states[0].get("project_id") or project_id or "") if states else ""
        )
        objects = (
            self.objects.by_experiment(project_id=resolved, experiment_ids=ids)
            if ids
            else {}
        )
        workspaces = (
            self.agent_sessions.workspaces(
                project_id=resolved,
                experiment_ids=ids,
            )
            if ids and resolved
            else {}
        )
        consolidations = (
            self.research.experiment_consolidations(
                project_id=resolved,
                experiment_ids=ids,
            )
            if ids and resolved
            else {}
        )
        presented = [
            {
                **(rich_experiment_state if rich else slim_experiment_state)(
                    state,
                    storage_objects=objects.get(str(state.get("id") or ""), []),
                ),
                "code_workspace": workspaces.get(str(state.get("id") or "")),
                "consolidation_history": consolidations.get(
                    str(state.get("id") or ""), []
                ),
            }
            for state in states
        ]
        return presented if rich else {"experiments": presented}

    def list_experiments(self, *, project_id: str | None = None) -> dict[str, Any]:
        return self.experiments(project_id=project_id, rich=False)

    def experiment(
        self,
        *,
        experiment_id: str,
        project_id: str | None = None,
        review_id: str = "",
        rich: bool = False,
    ) -> dict[str, Any]:
        if rich:
            state = self.research.experiment_state(
                experiment_id=experiment_id,
                project_id=project_id,
            )
            resolved_project_id = str(state.get("project_id") or project_id or "")
            response = rich_experiment_state(
                state,
                storage_objects=self.objects.by_experiment(
                    project_id=resolved_project_id,
                    experiment_ids=(experiment_id,),
                )[experiment_id],
                include_legacy_tracking=self._mlflow.enabled,
            )
            response["code_workspace"] = self.agent_sessions.workspaces(
                project_id=resolved_project_id,
                experiment_ids=(experiment_id,),
            ).get(experiment_id)
            response["consolidation_history"] = self.research.experiment_consolidations(
                project_id=resolved_project_id,
                experiment_ids=(experiment_id,),
            ).get(experiment_id, [])
            if not self._mlflow.enabled:
                response.pop("mlflow_run", None)
            else:
                self._mlflow.decorate(
                    response,
                    project_id=resolved_project_id,
                    experiment_id=experiment_id,
                    include_credentials=False,
                    include_guidance=False,
                )
            return response
        state = self.research.experiment_state(
            experiment_id=experiment_id,
            project_id=project_id,
        )
        resolved_project_id = str(state.get("project_id") or project_id or "")
        response = slim_experiment_state(
            state,
            storage_objects=self.objects.by_experiment(
                project_id=resolved_project_id,
                experiment_ids=(experiment_id,),
            )[experiment_id],
            include_legacy_tracking=self._mlflow.enabled,
        )
        response["code_workspace"] = self.agent_sessions.workspaces(
            project_id=resolved_project_id,
            experiment_ids=(experiment_id,),
        ).get(experiment_id)
        response["consolidation_history"] = self.research.experiment_consolidations(
            project_id=resolved_project_id,
            experiment_ids=(experiment_id,),
        ).get(experiment_id, [])
        if review_id:
            body = review_body(state.get("reviews", []), review_id=review_id)
            if body is None:
                known = [
                    str(review.get("id") or "") for review in state.get("reviews", [])
                ]
                raise ValidationError(
                    f"no review {review_id} on this experiment. Reviews here: "
                    f"{', '.join(known) or 'none yet'}.",
                    details={"field": "review_id", "review_ids": known},
                )
            response["review"] = body
        return self._mlflow.decorate(
            response,
            project_id=resolved_project_id,
            experiment_id=experiment_id,
            include_credentials=True,
        )

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
        state = self.research.create_task(
            name=name,
            goal=goal,
            deliverables=deliverables,
            depends_on=depends_on,
            project_id=project_id,
        )
        return dict(slim_task_state(state))

    def tasks(
        self, *, project_id: str | None = None, rich: bool = False
    ) -> dict[str, Any] | list[dict[str, Any]]:
        states = self.research.project_tasks(project_id=project_id)
        presented = [
            dict((rich_task_state if rich else slim_task_state)(state))
            for state in states
        ]
        return presented if rich else {"tasks": presented}

    def list_tasks(self, *, project_id: str | None = None) -> dict[str, Any]:
        return self.tasks(project_id=project_id, rich=False)

    def task(
        self,
        *,
        task_id: str,
        project_id: str | None = None,
        review_id: str = "",
        rich: bool = False,
    ) -> dict[str, Any]:
        state = self.research.task_state(task_id=task_id, project_id=project_id)
        if rich:
            return dict(rich_task_state(state))
        response = dict(slim_task_state(state))
        if review_id:
            body = review_body(state.get("reviews", []), review_id=review_id)
            if body is None:
                known = [
                    str(review.get("id") or "") for review in state.get("reviews", [])
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

    def review_queue(self, *, project_id: str | None = None) -> dict[str, Any]:
        return review_queue(self.research, project_id=project_id)

    def create_reflection(
        self,
        *,
        project_id: str,
        title: str = "",
        lenses: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return present_agent_reflection_state(
            self.research.create_reflection(
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
            self.research.reflection_state(
                project_id=project_id,
                reflection_id=reflection_id,
                include_content=True,
            ),
            include_content=include_content,
        )

    def reflections(self, *, project_id: str) -> dict[str, Any]:
        result = self.research.list_reflections(project_id=project_id)
        return present_reflection_overview(
            {
                "count": result.get(
                    "count",
                    len(result.get("reflections", [])),
                ),
                **result,
            }
        )

    def reflection_overview(self, *, project_id: str) -> dict[str, Any]:
        return present_reflection_overview(
            self.research.reflection_overview(project_id=project_id)
        )

    def transition_reflection(
        self,
        *,
        project_id: str,
        reflection_id: str,
        transition: str,
    ) -> dict[str, Any]:
        return present_agent_reflection_state(
            self.research.transition_reflection(
                project_id=project_id,
                reflection_id=reflection_id,
                transition=transition,
            ),
            include_content=False,
        )

    def consolidation(self, *, project_id: str, reflection_id: str) -> dict[str, Any]:
        state = self.research.reflection_state(
            project_id=project_id,
            reflection_id=reflection_id,
            include_content=True,
        )
        experiment_ids = tuple(
            str(item.get("id") or "")
            for item in (state.get("corpus") or {}).get("terminal_experiments", [])
            if isinstance(item, dict) and item.get("id")
        )
        packet = consolidation_packet(
            state,
            workspaces=self.agent_sessions.workspaces(
                project_id=project_id,
                experiment_ids=experiment_ids,
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
                    and item.get("kind") == "consolidation"
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
        state = self.research.reflection_state(
            project_id=project_id,
            reflection_id=reflection_id,
        )
        experiment_ids = tuple(
            str(item.get("id") or "")
            for item in (state.get("corpus") or {}).get("terminal_experiments", [])
            if isinstance(item, dict) and item.get("id")
        )
        workspaces = self.agent_sessions.workspaces(
            project_id=project_id,
            experiment_ids=experiment_ids,
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
            self.research.submit_consolidation(
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

    def prepare_consolidation_advance(
        self, *, project_id: str, reflection_id: str, runner_id: str
    ) -> dict[str, Any]:
        return self.research.prepare_reflection_advance(
            project_id=project_id,
            reflection_id=reflection_id,
            runner_id=runner_id,
        )

    def pending_consolidation_advance(
        self, *, project_id: str
    ) -> dict[str, Any] | None:
        """Return the one reviewed proposal the runner may try to advance."""
        reflection = self.research.snapshot(project_id=project_id).open_reflection
        if not reflection or reflection.get("status") != "consolidating":
            return None
        state = self.research.reflection_state(
            project_id=project_id,
            reflection_id=str(reflection["id"]),
        )
        consolidation = state.get("consolidation") or {}
        proposal = consolidation.get("proposal") or {}
        advance = consolidation.get("advance") or {}
        review_passed = any(
            item.get("kind") == "review"
            and item.get("role") == "consolidation_reviewer"
            and item.get("satisfied")
            for item in (state.get("gate_checklist") or {}).get("items", [])
        )
        if not proposal or not review_passed:
            return None
        if advance.get("status") == "bound":
            # A durable receipt whose publish was blocked: the Git CAS is
            # done, so the only remaining work is a settle retry — hand the
            # recorded receipt back so the runner (or, after the owner
            # lease, a replacement) can complete the publish.
            return {
                "reflection_id": state["id"],
                "proposal_id": proposal["id"],
                "revision": proposal["revision"],
                "advance_status": "bound",
                "advance_id": advance.get("id"),
                "observed_sha": advance.get("observed_sha") or "",
            }
        if advance.get("status") in {"stale", "failed"}:
            return None
        return {
            "reflection_id": state["id"],
            "proposal_id": proposal["id"],
            "revision": proposal["revision"],
            "advance_status": advance.get("status") or "ready",
        }

    def settle_consolidation_advance(
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
        return present_agent_reflection_state(
            self.research.settle_reflection_advance(
                project_id=project_id,
                advance_id=advance_id,
                runner_id=runner_id,
                observed_sha=observed_sha,
                proposal_parents=proposal_parents,
                diffstat=diffstat,
                ancestry=ancestry,
                error=error,
            ),
            include_content=False,
        )

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
        reviews = self.review_queue(project_id=project_id)
        claims = status["project"]["active_claims"]
        active_experiments = work["active_experiments"]
        active_tasks = work.get("active_tasks", [])
        active_processes = work["active_processes"]
        active = active_experiments[0] if active_experiments else None
        result = {
            "project": status["project"],
            "claims": claims,
            "experiments": experiments,
            "tasks": [dict(rich_task_state(task)) for task in snapshot.tasks],
            "active_experiments": active_experiments,
            "active_tasks": active_tasks,
            "active_processes": active_processes,
            "artifacts": artifacts,
            "reviews": reviews,
            "pending_change_sets": [],
            "recent_events": self.recent_events(
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
        health = self._mlflow.health()
        if health:
            result["mlflow"] = health
        return result

    def tracking_health(self) -> dict[str, Any]:
        return dict(self._mlflow.health())

    def current_project(self, *, tenant_id: str | None = None) -> dict[str, Any]:
        result = self.research.current_project(tenant_id=tenant_id)
        project = result.get("project") or {}
        project_id = str(project.get("id") or "")
        if not result.get("exists") or not project_id:
            return result
        return {
            **result,
            "at_a_glance": project_at_a_glance(
                self.research.snapshot(project_id=project_id)
            ),
        }

    def figure_facts(self, *, project_id: str, experiment_id: str) -> dict[str, Any]:
        """Gather cross-module facts; Surface owns the UI projection."""
        experiment = self.research.experiment_state(
            experiment_id=experiment_id,
            project_id=project_id,
        )
        review_attempts = {
            str(review.get("id")): int(
                self.research.review_snapshot(
                    snapshot_id=str(review.get("target_snapshot_id") or "")
                ).get("attempt_index")
                or 0
            )
            for review in experiment.get("reviews", [])
        }
        sandbox, active = self.sandboxes.figure_snapshot(
            experiment_id=experiment_id,
            project_id=project_id,
        )
        return {
            "experiment": experiment,
            "review_attempts": review_attempts,
            "open_review_requests": self.research.open_experiment_reviews(
                project_id=project_id,
                experiment_id=experiment_id,
            ),
            "sandbox": sandbox,
            "sandbox_active": active,
        }

    def compute_cost(self, *, project_id: str) -> dict[str, Any]:
        spend = self.sandboxes.project_spend(project_id=project_id)
        names = {
            str(experiment.get("id") or ""): str(experiment.get("name") or "")
            for experiment in self.research.project_experiment_summaries(
                project_id=project_id
            )
        }
        for entry in spend["by_experiment"]:
            entry["experiment_name"] = names.get(entry["experiment_id"], "")
        return spend

    def tenant_counters(self, *, tenant_id: str) -> dict[str, Any]:
        return {
            "tenant_id": tenant_id,
            "tool_calls": self.research.tenant_event_count(tenant_id=tenant_id),
            **self.sandboxes.tenant_generation_counters(tenant_id=tenant_id),
        }

    def timeline_signal(self, *, project_id: str) -> str:
        return self.research.project_event_signal(project_id=project_id)

    def recent_events(self, *, project_id: str, limit: int) -> dict[str, Any]:
        result = self.research.recent_events(project_id=project_id, limit=500)
        return {
            **result,
            "events": _visible_events(result.get("events") or [])[:limit],
        }

    def events_since(self, *, project_id: str, after_id: int) -> dict[str, Any]:
        result = self.research.events_since(
            project_id=project_id,
            after_id=after_id,
        )
        return {
            **result,
            "events": _visible_events(result.get("events") or []),
        }

    def experiment_graph(
        self, *, project_id: str, experiment_id: str
    ) -> dict[str, Any]:
        return self._graphs.experiment(
            project_id=project_id,
            experiment_id=experiment_id,
        )

    def project_graph(self, *, project_id: str) -> dict[str, Any]:
        return self._graphs.project(project_id=project_id)

    def reflection_graph(
        self, *, project_id: str, reflection_id: str
    ) -> dict[str, Any]:
        return self._graphs.reflection_graph(
            project_id=project_id,
            reflection_id=reflection_id,
        )

    # Optional MLflow integration -----------------------------------------

    @property
    def tracking_enabled(self) -> bool:
        return self._mlflow.enabled

    def tracking_context(
        self, *, project_id: str, experiment_id: str | None = None
    ) -> dict[str, Any]:
        return self._mlflow.context(
            project_id=project_id,
            experiment_id=experiment_id,
        )

    def finalize_tracking(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run_id: str | None = None,
        status: str | None = "FINISHED",
        wait_seconds: float = 2.0,
    ) -> dict[str, Any]:
        return self._mlflow.finalize(
            project_id=project_id,
            experiment_id=experiment_id,
            run_id=run_id,
            status=status,
            wait_seconds=wait_seconds,
        )

    def tracking_overview(self, *, project_id: str) -> dict[str, Any]:
        return self._mlflow.overview(project_id=project_id)

    def tracking_metrics(
        self, *, project_id: str, experiment_id: str
    ) -> dict[str, Any]:
        return self._mlflow.metrics(
            project_id=project_id,
            experiment_id=experiment_id,
        )


__all__ = ["Application"]


def _visible_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Hide dormant integration events and fields without deleting history."""
    return [
        _strip_legacy_fields(event)
        for event in events
        if "mlflow" not in str(event.get("type") or "").lower()
    ]


def _strip_legacy_fields(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_legacy_fields(item)
            for key, item in value.items()
            if "mlflow" not in str(key).lower()
        }
    if isinstance(value, list):
        return [_strip_legacy_fields(item) for item in value]
    return value
