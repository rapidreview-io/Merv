# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Review request, session, and submission logic."""

from __future__ import annotations

from contextlib import closing
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from ..artifacts import Artifacts
from ..kernel.secret_tokens import hash_secret, mint_secret, secret_digest_matches
from ..kernel.events import StoredEvent, freeze_json_object
from ..kernel.identity import LOCAL_TENANT_ID
from ..kernel.utils import (
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
    format_iso,
    new_id,
    now_iso,
    parse_iso,
)
from .policy import (
    is_review_gate_exempt,
    review_snapshot_id,
    revision_context_for_review_return,
    snapshot_from_id,
    validate_review_role,
    validate_review_verdict,
    validate_synopsis,
)
from .experiment_workflow import EXPERIMENT_WORKFLOW
from .reflection_workflow import REFLECTION_WORKFLOW
from .task_workflow import TASK_WORKFLOW
from .workflow_schema import resolve_review_return
from ..kernel.state.store import BaseStateStore, next_created_seq, row_to_dict
from .experiments import ExperimentService
from .reflections import ReflectionService
from .tasks import TaskService


_WORKFLOW_BY_TARGET = {
    EXPERIMENT_WORKFLOW.target_type: EXPERIMENT_WORKFLOW,
    REFLECTION_WORKFLOW.target_type: REFLECTION_WORKFLOW,
    TASK_WORKFLOW.target_type: TASK_WORKFLOW,
}


class ReviewService:
    """Owns review gates and capability-scoped reviewer sessions.

    Reviews are target-polymorphic: an experiment review pins the experiment's
    snapshot and routes rejections to planned/running; a reflection review pins
    the reflection wave's snapshot and routes rejections to
    reflecting/synthesizing. The capability machinery (plaintext returned once,
    snapshot pinning, and producer-session rejection) is shared. Reviewer skills
    provide the procedural read-only boundary.
    """

    def __init__(
        self,
        *,
        store: BaseStateStore,
        experiments: ExperimentService,
        reflections: ReflectionService,
        artifacts: Artifacts,
        tasks: TaskService | None = None,
    ) -> None:
        self.store = store
        self.experiments = experiments
        self.reflections = reflections
        self.artifacts = artifacts
        self.tasks = tasks if tasks is not None else TaskService(store=store, artifacts=artifacts)

    def request(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        reason: str = "",
        producer_session_id: str = "main",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        validate_review_role(role=role)
        if target_type not in {"experiment", "reflection", "task"}:
            raise ValidationError(
                "review targets must be 'experiment', 'reflection', or 'task'"
            )
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            target, gate = self._target_with_gate(
                conn=conn,
                target_type=target_type,
                target_id=target_id,
                project_id=project_id,
            )
            self._validate_role_matches_gate(
                target_type=target_type,
                expected=None if gate.review is None else gate.review.role,
                role=role,
            )
            if target_type == "reflection" and role == "consolidation_reviewer":
                self.reflections.require_consolidation_proposal(
                    conn=conn,
                    reflection=target,
                )
            # Refresh is revoke-and-reissue: a new capability for the same gate
            # closes every prior open request, so a lost or stale capability can
            # never race the fresh one to submit.
            superseded = [
                str(row["id"])
                for row in conn.execute(
                    """
                    SELECT id FROM review_requests
                    WHERE project_id = ? AND target_type = ? AND target_id = ?
                      AND role = ? AND status IN ('requested', 'started')
                    """,
                    (project_id, target_type, target_id, role),
                ).fetchall()
            ]
            if superseded:
                placeholders = ", ".join("?" for _ in superseded)
                conn.execute(
                    f"UPDATE review_requests SET status = 'superseded' WHERE id IN ({placeholders})",
                    (*superseded,),
                )
            request_id = new_id(prefix="rr")
            # The plaintext capability is minted here, returned ONCE to the
            # caller, and never stored; only its SHA-256 digest lands in the row.
            capability = mint_secret(prefix="rp_", nbytes=24)
            expires_at = format_iso(datetime.now(UTC) + timedelta(hours=1))
            snapshot_id = review_snapshot_id(target_type=target_type, target=target)
            conn.execute(
                """
                INSERT INTO review_requests (
                  id, project_id, target_type, target_id, role, reason, capability_hash,
                  status, target_snapshot_id, producer_session_id, expires_at, created_at,
                  created_seq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    project_id,
                    target_type,
                    target_id,
                    role,
                    reason,
                    hash_secret(capability),
                    snapshot_id,
                    producer_session_id,
                    expires_at,
                    now_iso(),
                    next_created_seq(conn=conn, table="review_requests"),
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="review.requested",
                target_type=target_type,
                target_id=target_id,
                payload={
                    "role": role,
                    "request_id": request_id,
                    "superseded_request_ids": superseded,
                },
            )
            return {
                "review_request_id": request_id,
                "reviewer_capability": capability,
                "role": role,
                "target_snapshot_id": snapshot_id,
                "target_snapshot": snapshot_from_id(snapshot_id=snapshot_id),
                "expires_at": expires_at,
            }

    def start(
        self,
        *,
        review_request_id: str,
        reviewer_capability: str,
        declared_agent: str = "",
        caller_session_id: str = "",
        tenant_id: str | None = None,
        assigned_agent_session_id: str = "",
        assigned_review_request_id: str = "",
    ) -> dict[str, Any]:
        # A supplied tenant scopes the capability; None preserves local mode.
        caller_session_id = caller_session_id.strip()
        if not caller_session_id:
            raise ValidationError(
                "caller_session_id is required: pass the reviewer's own "
                "session identity (any stable identifier for the reviewing "
                "agent's session, distinct from the producer session that "
                "requested the review) so reviewer independence can be "
                "verified"
            )
        with self.store.transaction() as conn:
            req = conn.execute(
                "SELECT * FROM review_requests WHERE id = ?", (review_request_id,)
            ).fetchone()
            if req is None:
                raise NotFoundError(f"review request not found: {review_request_id}")
            if tenant_id is not None:
                owner = conn.execute(
                    "SELECT tenant_id FROM projects WHERE id = ?", (req["project_id"],)
                ).fetchone()
                if owner is None or str(owner["tenant_id"]) != tenant_id:
                    # Same shape as an unknown request: do not confirm the
                    # target exists to a foreign tenant.
                    raise NotFoundError(
                        f"review request not found: {review_request_id}"
                    )
            assigned = (
                bool(assigned_agent_session_id)
                and assigned_review_request_id == review_request_id
                and caller_session_id == assigned_agent_session_id
            )
            if assigned:
                self._validate_assigned_request_open(req=req)
            else:
                self._validate_request_open(req=req, capability=reviewer_capability)
            if caller_session_id == req["producer_session_id"]:
                raise PermissionDeniedError(
                    "reviewer session must differ from producer session"
                )
            snapshot_now = self._target_snapshot_id(
                conn=conn, target_type=req["target_type"], target_id=req["target_id"]
            )
            if snapshot_now != req["target_snapshot_id"]:
                raise PermissionDeniedError(
                    "target changed after review capability was issued"
                )
            session_id = new_id(prefix="rvs")
            # caller_session_id is mandatory, so every new session is verified;
            # 'attested_agent_review' survives only on legacy rows.
            independence = "verified_agent_review"
            conn.execute(
                """
                INSERT INTO review_sessions (
                  id, request_id, declared_agent, caller_session_id, tenant_id,
                  independence, status, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 'started', ?)
                """,
                (
                    session_id,
                    review_request_id,
                    declared_agent,
                    caller_session_id,
                    tenant_id if tenant_id is not None else LOCAL_TENANT_ID,
                    independence,
                    now_iso(),
                ),
            )
            conn.execute(
                "UPDATE review_requests SET status = 'started' WHERE id = ?",
                (review_request_id,),
            )
            self.store.record_event(
                conn=conn,
                project_id=req["project_id"],
                event_type="review.started",
                target_type=req["target_type"],
                target_id=req["target_id"],
                payload={
                    "role": req["role"],
                    "request_id": review_request_id,
                    "session_id": session_id,
                },
            )
            snapshot = snapshot_from_id(snapshot_id=str(req["target_snapshot_id"]))
            return {
                "review_session_id": session_id,
                "project_id": req["project_id"],
                "role": req["role"],
                "target_type": req["target_type"],
                "target_id": req["target_id"],
                "target_snapshot_id": req["target_snapshot_id"],
                "target_snapshot": snapshot,
                "independence": independence,
            }

    def submit(
        self,
        *,
        review_session_id: str,
        verdict: str,
        synopsis: str,
        notes: str = "",
        findings: list[dict[str, Any]] | None = None,
        evidence: dict[str, Any] | None = None,
        return_to: str = "",
    ) -> dict[str, Any]:
        validate_review_verdict(verdict=verdict)
        try:
            synopsis = validate_synopsis(synopsis)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        with self.store.transaction() as conn:
            session = conn.execute(
                "SELECT * FROM review_sessions WHERE id = ?", (review_session_id,)
            ).fetchone()
            if session is None:
                raise NotFoundError(f"review session not found: {review_session_id}")
            if session["status"] == "submitted":
                raise PermissionDeniedError("review session already submitted")
            req = conn.execute(
                "SELECT * FROM review_requests WHERE id = ?", (session["request_id"],)
            ).fetchone()
            if req is None:
                raise NotFoundError(
                    f"review request not found: {session['request_id']}"
                )
            if req["status"] != "started":
                raise PermissionDeniedError(
                    "review request is no longer open (superseded by a fresh "
                    "capability or already submitted)"
                )
            # The verdict applies to the pinned snapshot the reviewer graded.
            # If the target moved on (e.g. a sibling review already passed the
            # gate), a stale session must not mutate it.
            snapshot_now = self._target_snapshot_id(
                conn=conn, target_type=req["target_type"], target_id=req["target_id"]
            )
            if snapshot_now != req["target_snapshot_id"]:
                raise PermissionDeniedError(
                    "target changed after this review started; the verdict no "
                    "longer applies — request a fresh review"
                )
            workflow = _WORKFLOW_BY_TARGET.get(str(req["target_type"]))
            if workflow is None:
                raise ValidationError(
                    f"unknown review target type: {req['target_type']}"
                )
            try:
                route = resolve_review_return(
                    workflow=workflow,
                    role=req["role"],
                    verdict=verdict,
                    return_to=return_to,
                )
            except ValueError as exc:
                raise ValidationError(str(exc)) from exc
            return_to = "" if route is None else route.to_status
            snapshot = snapshot_from_id(snapshot_id=str(req["target_snapshot_id"]))
            attempt_index = int(snapshot.get("attempt_index") or 0)
            target_history = self.artifacts.history(
                tx=conn,
                target_type=str(req["target_type"]),
                target_ids=(str(req["target_id"]),),
            )[str(req["target_id"])]
            latest_submission = max(
                (
                    submission
                    for submission in target_history.submissions
                    if submission.attempt_index == attempt_index
                ),
                key=lambda submission: submission.order,
                default=None,
            )
            review_id = new_id(prefix="rev")
            conn.execute(
                """
                INSERT INTO reviews (
                  id, project_id, request_id, session_id, target_snapshot_id, target_type, target_id,
                  role, verdict, return_to, notes, synopsis, findings_json, evidence_json, created_at,
                  created_seq, submission_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    review_id,
                    req["project_id"],
                    req["id"],
                    review_session_id,
                    req["target_snapshot_id"],
                    req["target_type"],
                    req["target_id"],
                    req["role"],
                    verdict,
                    return_to,
                    notes,
                    synopsis,
                    json.dumps(findings or [], sort_keys=True),
                    json.dumps(evidence or {}, sort_keys=True),
                    now_iso(),
                    next_created_seq(conn=conn, table="reviews"),
                    # The round this verdict graded. The seal ran on the
                    # forward transition that put the target under review, so
                    # the newest submission for this attempt is that round.
                    "" if latest_submission is None else latest_submission.id,
                ),
            )
            conn.execute(
                "UPDATE review_sessions SET status = 'submitted' WHERE id = ?",
                (review_session_id,),
            )
            conn.execute(
                "UPDATE review_requests SET status = 'submitted' WHERE id = ?",
                (req["id"],),
            )
            self.store.record_event(
                conn=conn,
                project_id=req["project_id"],
                event_type="review.submitted",
                target_type=req["target_type"],
                target_id=req["target_id"],
                payload={
                    "role": req["role"],
                    "verdict": verdict,
                    "review_id": review_id,
                    "return_to": return_to,
                    "synopsis": synopsis,
                },
            )
            if verdict in {"needs_changes", "fail"}:
                if route is None:
                    raise RuntimeError("rejected review has no return route")
                revision_context = revision_context_for_review_return(
                    target_type=req["target_type"],
                    role=req["role"],
                    verdict=verdict,
                    notes=notes,
                    findings=findings or [],
                    route=route,
                )
                if req["target_type"] == "experiment":
                    self.experiments.return_from_review(
                        conn=conn,
                        experiment_id=req["target_id"],
                        route=route,
                        revision_context=revision_context,
                    )
                elif req["target_type"] == "reflection":
                    self.reflections.return_from_review(
                        conn=conn,
                        reflection_id=req["target_id"],
                        route=route,
                        revision_context=revision_context,
                    )
                elif req["target_type"] == "task":
                    self.tasks.return_from_review(
                        conn=conn,
                        task_id=req["target_id"],
                        route=route,
                        revision_context=revision_context,
                    )
            review = conn.execute(
                "SELECT * FROM reviews WHERE id = ?", (review_id,)
            ).fetchone()
            return self._hydrate_review(row=review)

    def status(
        self, *, target_type: str, target_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            requests = conn.execute(
                """
                SELECT id, target_type, target_id, role, status, target_snapshot_id,
                       producer_session_id, expires_at, created_at
                FROM review_requests
                WHERE project_id = ? AND target_type = ? AND target_id = ?
                ORDER BY created_seq DESC
                """,
                (project_id, target_type, target_id),
            ).fetchall()
            reviews = conn.execute(
                "SELECT * FROM reviews WHERE project_id = ? AND target_type = ? AND target_id = ? ORDER BY created_seq DESC",
                (project_id, target_type, target_id),
            ).fetchall()
            return {
                "requests": [self._with_snapshot(row=row) for row in requests],
                "reviews": [self._hydrate_review(row=row) for row in reviews],
            }

    def latest_submitted_event(
        self, *, target_type: str, target_id: str, project_id: str | None = None
    ) -> StoredEvent | None:
        """Return the durable event for the newest verdict without appending one."""
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                """
                SELECT id, project_id, type, target_type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ? AND type = 'review.submitted'
                  AND target_type = ? AND target_id = ?
                ORDER BY id DESC LIMIT 1
                """,
                (project_id, target_type, target_id),
            ).fetchone()
        if row is None:
            return None
        return StoredEvent(
            id=int(row["id"]),
            project_id=str(row["project_id"]),
            type=str(row["type"]),
            target_type=str(row["target_type"]),
            target_id=str(row["target_id"]),
            payload=freeze_json_object(json.loads(str(row["payload_json"]))),
            created_at=str(row["created_at"]),
        )

    def queue(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            req_rows = conn.execute(
                """
                SELECT id, target_type, target_id, role, status, reason, target_snapshot_id,
                       producer_session_id, expires_at, created_at
                FROM review_requests
                WHERE project_id = ?
                ORDER BY created_seq DESC
                """,
                (project_id,),
            ).fetchall()
            review_rows = conn.execute(
                """
                SELECT id, request_id, target_snapshot_id, target_type, target_id, role, verdict,
                       notes, synopsis, created_at
                FROM reviews
                WHERE project_id = ?
                ORDER BY created_seq DESC
                """,
                (project_id,),
            ).fetchall()
            return {
                "requests": [self._with_snapshot(row=row) for row in req_rows],
                "reviews": [self._with_snapshot(row=row) for row in review_rows],
            }

    def open_requests_for_target(
        self,
        *,
        project_id: str | None,
        experiment_id: str,
        statuses: tuple[str, ...] = ("requested", "started"),
    ) -> list[dict[str, Any]]:
        if not statuses:
            return []
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            placeholders = ", ".join("?" for _ in statuses)
            rows = conn.execute(
                f"""
                SELECT id, role, status, reason, created_at
                FROM review_requests
                WHERE project_id = ? AND target_type = 'experiment' AND target_id = ?
                  AND status IN ({placeholders})
                ORDER BY created_seq
                """,
                (project_id, experiment_id, *statuses),
            ).fetchall()
            return [row_to_dict(row=row) or {} for row in rows]

    def assert_request_in_project(
        self, *, project_id: str | None, review_request_id: Any
    ) -> None:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if not review_request_id:
                raise ValidationError("review_request_id is required")
            row = conn.execute(
                "SELECT project_id FROM review_requests WHERE id = ?",
                (review_request_id,),
            ).fetchone()
            if row is None or row["project_id"] != project_id:
                raise NotFoundError(
                    f"review request not found in project {project_id}: {review_request_id}"
                )

    def request_project_id(self, *, review_request_id: Any) -> str | None:
        if not review_request_id:
            return None
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT project_id FROM review_requests WHERE id = ?",
                (str(review_request_id),),
            ).fetchone()
            return str(row["project_id"]) if row else None

    def target_for(
        self,
        *,
        review_request_id: Any = None,
        review_session_id: Any = None,
    ) -> tuple[str, str, str] | None:
        """Resolve a review capability to (project, target type, target id)."""
        if bool(review_request_id) == bool(review_session_id):
            raise ValueError(
                "provide exactly one of review_request_id or review_session_id"
            )
        with closing(self.store.connect()) as conn:
            if review_request_id:
                row = conn.execute(
                    """
                    SELECT project_id, target_type, target_id
                    FROM review_requests WHERE id = ?
                    """,
                    (str(review_request_id),),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT rr.project_id, rr.target_type, rr.target_id
                    FROM review_sessions rs
                    JOIN review_requests rr ON rr.id = rs.request_id
                    WHERE rs.id = ?
                    """,
                    (str(review_session_id),),
                ).fetchone()
        if row is None:
            return None
        return (
            str(row["project_id"]),
            str(row["target_type"]),
            str(row["target_id"]),
        )

    def session_project_id(self, *, review_session_id: Any) -> str | None:
        if not review_session_id:
            return None
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                """
                SELECT rr.project_id AS project_id
                FROM review_sessions rs
                JOIN review_requests rr ON rr.id = rs.request_id
                WHERE rs.id = ?
                """,
                (str(review_session_id),),
            ).fetchone()
            return str(row["project_id"]) if row else None

    def request_id_for_session(self, *, review_session_id: Any) -> str | None:
        if not review_session_id:
            return None
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT request_id FROM review_sessions WHERE id = ?",
                (str(review_session_id),),
            ).fetchone()
        return str(row["request_id"]) if row else None

    def assert_session_in_project(
        self, *, project_id: str | None, review_session_id: Any
    ) -> None:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if not review_session_id:
                raise ValidationError("review_session_id is required")
            row = conn.execute(
                """
                SELECT rr.project_id AS project_id
                FROM review_sessions rs
                JOIN review_requests rr ON rr.id = rs.request_id
                WHERE rs.id = ?
                """,
                (review_session_id,),
            ).fetchone()
            if row is None or row["project_id"] != project_id:
                raise NotFoundError(
                    f"review session not found in project {project_id}: {review_session_id}"
                )

    def _with_snapshot(self, *, row) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        data["target_snapshot"] = snapshot_from_id(
            snapshot_id=data.get("target_snapshot_id", "")
        )
        return data

    def _validate_request_open(self, *, req, capability: str) -> None:
        # Compare digests in constant time; plaintext capabilities never rest.
        presented = hash_secret(capability)
        if not secret_digest_matches(
            stored_digest=req["capability_hash"], presented_digest=presented
        ):
            raise PermissionDeniedError("invalid reviewer capability")
        if req["status"] not in {"requested", "started"}:
            raise PermissionDeniedError("review request is no longer open")
        expires = parse_iso(req["expires_at"])
        if expires is None or datetime.now(UTC) > expires:
            raise PermissionDeniedError("reviewer capability expired")

    @staticmethod
    def _validate_assigned_request_open(*, req: Any) -> None:
        """The bound mas_ credential replaces the one-time handoff secret."""
        if req["status"] not in {"requested", "started"}:
            raise PermissionDeniedError("review request is no longer open")
        expires = parse_iso(req["expires_at"])
        if expires is None or datetime.now(UTC) > expires:
            raise PermissionDeniedError("reviewer capability expired")

    def _validate_role_matches_gate(
        self, *, target_type: str, expected: str | None, role: str
    ) -> None:
        if is_review_gate_exempt(role=role):
            return
        if expected is None:
            raise PermissionDeniedError(
                f"{target_type} is not currently awaiting {role}"
            )
        if role != expected:
            raise PermissionDeniedError(f"active gate requires {expected}, not {role}")

    def _target_snapshot_id(self, *, conn, target_type: str, target_id: str) -> str:
        target, _gate = self._target_with_gate(
            conn=conn,
            target_type=target_type,
            target_id=target_id,
        )
        return review_snapshot_id(target_type=target_type, target=target)

    def _target_with_gate(
        self,
        *,
        conn,
        target_type: str,
        target_id: str,
        project_id: str | None = None,
    ):
        if target_type == "experiment":
            return self.experiments.get_state_with_gate(
                experiment_id=target_id,
                project_id=project_id,
                conn=conn,
            )
        if target_type == "reflection":
            return self.reflections.get_state_with_gate(
                reflection_id=target_id,
                project_id=project_id,
                conn=conn,
            )
        if target_type == "task":
            return self.tasks.get_state_with_gate(
                task_id=target_id,
                project_id=project_id,
                conn=conn,
            )
        raise ValidationError(f"unknown review target type: {target_type}")

    def _hydrate_review(self, *, row) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        data["findings"] = json.loads(data.pop("findings_json", "[]"))
        data["evidence"] = json.loads(data.pop("evidence_json", "{}"))
        data["target_snapshot"] = snapshot_from_id(
            snapshot_id=data.get("target_snapshot_id", "")
        )
        return data
