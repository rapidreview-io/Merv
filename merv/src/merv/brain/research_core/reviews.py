# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Review request, session, and submission logic."""

from __future__ import annotations

from .models import public_record
from ..workflows.definitions.research_state import (
    ReviewRequestCreated, ReviewRequestReused, ReviewRequestSkipped, ReviewRequestOutcome,
)
from ..workflows import REVIEW_KIND as KIND, Public

from contextlib import closing
from collections.abc import Callable, Mapping
from functools import partial
import json
from datetime import UTC, datetime, timedelta
from typing import Any, TYPE_CHECKING

from ..kernel.secret_tokens import hash_secret, mint_secret, secret_digest_matches
from ..kernel.events import StoredEvent, freeze_json_object
from ..kernel.identity import LOCAL_TENANT_ID
from ..kernel.request_context import current_request_context
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
    REVIEW_GATE_EXEMPT_ROLES, ReviewFact, parse_project_settings, review_snapshot_id,
    revision_context_for_review_return, snapshot_from_id, validate_review_role, resolve_review_return,
)
from ..kernel.state.store import Connection, next_created_seq, row_to_dict
if TYPE_CHECKING:
    from .records import Records
from ..workflows import Reference, Snapshot


def verdict_effect(*, records: Records):
    """Record one verdict and let its target take the edge that verdict opens.

    Both writes belong to the review's own ``submit`` transition: the runtime
    runs this on that transition's connection, so a target that refuses its
    edge leaves behind no verdict, no closed session and no closed request.
    """
    def record(conn: Connection, before: Snapshot, after: Snapshot, data) -> None:
        request = conn.execute("SELECT * FROM review_requests WHERE id = ?", (before.id,)).fetchone()
        # The submitted payload arrives frozen, so mappings serialize as objects.
        dump = partial(json.dumps, sort_keys=True, default=dict)
        conn.execute(
            """
            INSERT INTO reviews (
              id, project_id, request_id, session_id, target_snapshot_id, target_type, target_id,
              role, verdict, return_to, notes, synopsis, findings_json, evidence_json, created_at,
              created_seq, submission_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data["review_id"], request["project_id"], before.id, data["session_id"],
             request["target_snapshot_id"], request["target_type"], request["target_id"],
             request["role"], data["verdict"], data["return_to"], data["notes"], data["synopsis"],
             dump(data["findings"]), dump(data["evidence"]), now_iso(),
             next_created_seq(conn=conn, table="reviews"), _graded_round(records, conn, request)),
        )
        conn.execute("UPDATE review_sessions SET status = 'submitted' WHERE id = ?", (data["session_id"],))
        target_id = str(request["target_id"])
        decision = records.runtime.evaluate(conn=conn, project_id=before.project_id, instance_id=target_id)
        selected = decision.suggested
        if (decision.node is not None and decision.node.execution.read_only
                and decision.node.role == request["role"] and selected is not None and selected.available):
            records.runtime.apply_in_transaction(
                conn=conn, project_id=before.project_id, instance_id=target_id,
                expected_revision=decision.snapshot.revision, action=selected.edge.name,
                request_id=f"review:{data['review_id']}",
                payload={**data["evidence"], "review_id": data["review_id"], "notes": data["notes"],
                         "synopsis": data["synopsis"], "revision_context": data["revision_context"]},
            )

    return record


def _graded_round(records: Records, conn: Connection, request) -> str:
    """The sealed submission this verdict graded. The seal ran on the forward
    transition that put the target under review, so the newest submission for
    the pinned attempt is that round."""
    attempt = int(snapshot_from_id(snapshot_id=str(request["target_snapshot_id"])).get("attempt_index") or 0)
    history = records.artifacts.history(tx=conn, target_type=str(request["target_type"]),
                                        target_ids=(str(request["target_id"]),))[str(request["target_id"])]
    latest = max((item for item in history.submissions if item.attempt_index == attempt),
                 key=lambda item: item.order, default=None)
    return "" if latest is None else latest.id


def project_settings(*, conn: Connection, project_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT settings_json FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    return parse_project_settings(row["settings_json"]) if row else {}


def read_review_fact(*, conn: Connection, project_id: str, target_type: str, target_id: str,
                     snapshot_id: str, role: str) -> ReviewFact:
    """Read the latest verdict and request for one project, role and immutable snapshot."""
    scope = (project_id, target_type, target_id, role, snapshot_id)
    row = conn.execute(
        "SELECT r.id, r.verdict, r.return_to, r.notes, r.synopsis, r.findings_json, r.evidence_json, s.independence "
        "FROM reviews r JOIN review_sessions s ON s.id = r.session_id WHERE r.project_id = ? AND r.target_type = ? "
        "AND r.target_id = ? AND r.role = ? AND r.target_snapshot_id = ? AND s.status = 'submitted' "
        "ORDER BY r.created_seq DESC LIMIT 1", scope,
    ).fetchone()
    request = conn.execute(
        "SELECT id, status, expires_at FROM review_requests WHERE project_id = ? AND target_type = ? "
        "AND target_id = ? AND role = ? AND target_snapshot_id = ? ORDER BY created_seq DESC LIMIT 1", scope,
    ).fetchone()
    return ReviewFact(role, snapshot_id, {} if row is None else dict(row),
                      {} if request is None else dict(request),
                      bool(project_settings(conn=conn, project_id=project_id).get("require_verified_reviews")),
                      request is not None and str(request["expires_at"]) <= now_iso())


class ReviewService:
    """Owns review gates and capability-scoped reviewer sessions.

    Reviews are target-polymorphic: an experiment review pins the experiment's
    snapshot and routes rejections to planned/running; a reflection review pins
    the reflection wave's snapshot and routes rejections to
    reflecting/synthesizing. The capability machinery (plaintext returned once,
    snapshot pinning, and producer-session rejection) is shared. Reviewer skills
    provide the procedural read-only boundary.
    """

    def __init__(self, *, records: Records) -> None:
        self.records = records
        self.store = records.store
        self.runtime = records.runtime

    def request(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        reason: str = "",
        producer_session_id: str = "main",
        project_id: str | None = None,
        expected_revision: int | None = None,
        if_current: bool = False,
    ) -> ReviewRequestOutcome:
        validate_review_role(role=role)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            current = self.runtime.get(conn=conn, project_id=project_id, instance_id=target_id)
            if current.workflow != target_type:
                raise NotFoundError(f"workflow {target_type!r} not found in this project: {target_id}")
            if expected_revision is not None:
                if current.revision != expected_revision or current.outcome:
                    return ReviewRequestSkipped()
            self.runtime.lock(conn=conn, project_id=project_id, instance_id=target_id, revision=current.revision)
            target = self._target(conn=conn, target_type=target_type, target_id=target_id, project_id=project_id)
            node = self.runtime.registry.get(current.workflow, current.version).node(current.state)
            self._validate_role_matches_gate(
                target_type=target_type,
                expected=node.role if node is not None and node.execution.read_only else None,
                role=role,
            )
            snapshot_id = review_snapshot_id(target_type=target_type, target=target, snapshot=current)
            if if_current:
                fact = read_review_fact(conn=conn, project_id=project_id, target_type=target_type, target_id=target_id,
                                        snapshot_id=snapshot_id, role=role)
                if fact.passed:
                    return ReviewRequestSkipped(reason="The exact submitted snapshot already passed review.")
                if fact.request_valid:
                    return ReviewRequestReused(review_request_id=fact.request["id"])
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
            for revoked in superseded:
                self._apply(conn=conn, request_id=revoked, action="supersede")
            # The plaintext capability is minted here, returned ONCE to the
            # caller, and never stored; only its SHA-256 digest lands in the row.
            capability = mint_secret(prefix="rp_", nbytes=24)
            expires_at = format_iso(datetime.now(UTC) + timedelta(hours=1))
            request_id = str(self.records.create_in_transaction(
                KIND, conn=conn, project_id=project_id,
                values={"target_type": target_type, "target_id": target_id, "role": role,
                        "reason": reason, "capability_hash": hash_secret(capability),
                        "target_snapshot_id": snapshot_id,
                        "producer_session_id": producer_session_id, "expires_at": expires_at},
                event={"role": role, "target_type": target_type, "target_id": target_id,
                       "superseded_request_ids": superseded},
            )["id"])
            return ReviewRequestCreated(
                review_request_id=request_id, reviewer_capability=capability, role=role,
                target_snapshot_id=snapshot_id, target_snapshot=snapshot_from_id(snapshot_id=snapshot_id),
                expires_at=expires_at,
            )

    def _apply(self, *, conn: Connection, request_id: str, action: str,
               payload: dict[str, Any] | None = None) -> Snapshot:
        """Move one request along the review graph, adopting rows that predate it."""
        row = conn.execute("SELECT project_id, status FROM review_requests WHERE id = ?",
                           (request_id,)).fetchone()
        project_id = str(row["project_id"])
        current = self.runtime.adopt(conn=conn, project_id=project_id, instance_id=request_id,
                                     workflow=KIND.name, version=KIND.workflow.version,
                                     state=str(row["status"]))
        return self.runtime.apply_in_transaction(
            conn=conn, project_id=project_id, instance_id=request_id, action=action,
            expected_revision=current.revision, request_id=f"{action}:{request_id}",
            payload=payload or {})

    def start(
        self,
        *,
        review_request_id: str,
        reviewer_capability: str,
        caller_session_id: str = "",
        tenant_id: str | None = None,
        assigned_agent_session_id: str = "",
        assigned_review_request_id: str = "",
        permits_successor: Callable[..., bool] | None = None,
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
            # A bound mas_ credential replaces the one-time handoff secret.
            capability = None if (bool(assigned_agent_session_id)
                                  and assigned_review_request_id == review_request_id
                                  and caller_session_id == assigned_agent_session_id) else reviewer_capability
            self._validate_request_open(req=req, capability=capability)
            if caller_session_id == req["producer_session_id"]:
                raise PermissionDeniedError(
                    "reviewer session must differ from producer session"
                )
            snapshot_now = self._target_snapshot_id(
                conn=conn, project_id=req["project_id"], target_type=req["target_type"], target_id=req["target_id"], lock=True
            )
            # The workflow lock may have waited behind a capability refresh.
            # Recheck the row after acquiring it so a revoked request cannot reopen.
            req = conn.execute("SELECT * FROM review_requests WHERE id = ?", (review_request_id,)).fetchone()
            self._validate_request_open(req=req, capability=capability)
            if snapshot_now != req["target_snapshot_id"]:
                raise PermissionDeniedError(
                    "target changed after review capability was issued"
                )
            current = self.runtime.get(conn=conn, project_id=req["project_id"], instance_id=req["target_id"])
            assigned = capability is None
            existing = conn.execute(
                "SELECT id, caller_session_id, independence, status FROM review_sessions "
                "WHERE request_id = ?", (review_request_id,),
            ).fetchall()
            own = [row for row in existing if row["caller_session_id"] == caller_session_id]
            active = [row for row in existing if row["status"] == "started"]
            if assigned and (permits_successor is None or not permits_successor(
                conn=conn, project_id=req["project_id"], instance_id=req["target_id"],
                revision=current.revision, role=req["role"], reference_kind="review_request",
                reference_id=review_request_id, caller_id=caller_session_id,
                predecessor_ids=tuple(str(row["caller_session_id"]) for row in existing
                                      if row["caller_session_id"] != caller_session_id),
            )):
                raise PermissionDeniedError("reviewer assignment is not current or its predecessor is not terminal")
            if req["status"] == "started":
                if len(active) != 1 or len(own) > 1 or (own and own[0]["status"] != "started"):
                    raise PermissionDeniedError("the started review has no unambiguous active reviewer session")
                if own:
                    return {
                        "review_session_id": str(own[0]["id"]),
                        "project_id": req["project_id"], "role": req["role"],
                        "target_type": req["target_type"], "target_id": req["target_id"],
                        "target_snapshot_id": req["target_snapshot_id"],
                        "independence": own[0]["independence"], "recovered": True,
                    }
                if not assigned:
                    raise PermissionDeniedError("the started review belongs to another reviewer session")
                # Retain original attribution and request history; only the current
                # native assignee gets a fresh handle after every predecessor closed.
                conn.execute("UPDATE review_sessions SET status = 'superseded' WHERE id = ?",
                             (active[0]["id"],))
            elif existing:
                raise PermissionDeniedError("review request has inconsistent session history")
            session_id = new_id(prefix="rvs")
            # caller_session_id is mandatory, so every new session is verified;
            # 'attested_agent_review' survives only on legacy rows. The session
            # also binds to the verified context window that opened it.
            independence = "verified_agent_review"
            if req["status"] == "requested":
                self._apply(conn=conn, request_id=review_request_id, action="start",
                            payload={"role": req["role"], "session_id": session_id})
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
                    current_request_context().agent_id,
                    caller_session_id,
                    tenant_id if tenant_id is not None else LOCAL_TENANT_ID,
                    independence,
                    now_iso(),
                ),
            )
            snapshot = snapshot_from_id(snapshot_id=str(req["target_snapshot_id"]))
            current = self.runtime.get(conn=conn, project_id=req["project_id"], instance_id=req["target_id"])
            node = self.runtime.registry.get(current.workflow, current.version).node(current.state)
            # Native kinds hydrate their own reviewer context; a plugin graph's
            # reviewer reads the node's assignment.
            generic = req["target_type"] not in self.records.kinds
            context = (self.runtime.assignment(conn=conn, project_id=current.project_id, instance_id=current.id)
                       if generic and node is not None and node.execution.read_only and node.role == req["role"] else None)
            return {
                "review_session_id": session_id,
                "project_id": req["project_id"],
                "role": req["role"],
                "target_type": req["target_type"],
                "target_id": req["target_id"],
                "target_snapshot_id": req["target_snapshot_id"],
                "target_snapshot": snapshot,
                "independence": independence,
                **({"context": context} if context is not None else {}),
            }

    def submit(
        self,
        *,
        review_session_id: str,
        caller_session_id: str = "",
        permits_successor: Callable[..., bool] | None = None,
        verdict: str,
        synopsis: str,
        notes: str = "",
        findings: list[dict[str, Any]] | None = None,
        evidence: dict[str, Any] | None = None,
        return_to: str = "",
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            session = conn.execute(
                "SELECT * FROM review_sessions WHERE id = ?", (review_session_id,)
            ).fetchone()
            if session is None:
                raise NotFoundError(f"review session not found: {review_session_id}")
            if session["status"] != "started":
                raise PermissionDeniedError("review session is no longer started (submitted or superseded)")
            if caller_session_id and session["caller_session_id"] != caller_session_id:
                raise PermissionDeniedError("review session belongs to another reviewer")
            agent_id = current_request_context().agent_id
            if agent_id and session["declared_agent"] and session["declared_agent"] != agent_id:
                raise PermissionDeniedError(
                    f"review session {review_session_id} was started by agent {session['declared_agent']!r}; "
                    "only that context window may submit its verdict")
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
                conn=conn, project_id=req["project_id"], target_type=req["target_type"], target_id=req["target_id"], lock=True
            )
            req = conn.execute("SELECT * FROM review_requests WHERE id = ?", (req["id"],)).fetchone()
            session = conn.execute("SELECT * FROM review_sessions WHERE id = ?", (review_session_id,)).fetchone()
            if req["status"] != "started" or session["status"] != "started":
                raise PermissionDeniedError("review request is no longer open or its session already submitted")
            if snapshot_now != req["target_snapshot_id"]:
                raise PermissionDeniedError(
                    "target changed after this review started; the verdict no "
                    "longer applies — request a fresh review"
                )
            current = self.runtime.get(conn=conn, project_id=req["project_id"], instance_id=req["target_id"])
            kind = self.records.kinds.get(str(req["target_type"]))
            if caller_session_id and (permits_successor is None or not permits_successor(
                conn=conn, project_id=req["project_id"], instance_id=req["target_id"],
                revision=current.revision, role=req["role"], reference_kind="review_request",
                reference_id=req["id"], caller_id=caller_session_id, predecessor_ids=(),
            )):
                raise PermissionDeniedError("reviewer assignment is no longer current")
            route = resolve_review_return(
                kind=kind if current.version == 1 else None,
                role=req["role"], verdict=verdict, return_to=return_to, state=current.state,
                definition=self.runtime.registry.get(current.workflow, current.version))
            return_to = return_to if route is None else route.to_status
            review_id = new_id(prefix="rev")
            self._apply(conn=conn, request_id=str(req["id"]), action="submit", payload={
                "review_id": review_id, "session_id": review_session_id, "verdict": verdict,
                "synopsis": synopsis, "notes": notes, "return_to": return_to,
                "findings": findings or [], "evidence": evidence or {},
                "revision_context": "" if route is None else revision_context_for_review_return(
                    target_type=req["target_type"], role=req["role"], verdict=verdict,
                    notes=notes, findings=findings or [], route=route),
            })
            status = lambda state: state if kind is None else kind.status_of(state)
            before = status(current.state)
            after = status(self.runtime.get(conn=conn, project_id=req["project_id"], instance_id=req["target_id"]).state)
            target = f"{req['target_type']} {req['target_id']}"
            return {
                "id": review_id, "role": req["role"], "verdict": verdict, "return_to": return_to, "synopsis": synopsis,
                "target": {"type": req["target_type"], "id": req["target_id"], "status_before": before, "status_after": after},
                "next_action": (
                    f"Report the verdict to the producer: {target} moved from {before!r} to {after!r} on this verdict, "
                    "so it must call workflow.status_and_next, not a transition."
                    if after != before else
                    f"Report the verdict to the producer: {target} stays {before!r}; "
                    + ("the Merv runner publishes the wave after central advance, no agent transition follows."
                       if verdict == "pass" else "it should call workflow.status_and_next for the next step.")),
            }

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
        """Return the durable event for the newest verdict without appending one.

        A verdict is a transition of its own request, so the event names the
        request; the target it graded is one join away.
        """
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                """
                SELECT e.id, e.project_id, e.type, e.target_type, e.target_id, e.payload_json, e.created_at
                FROM events e JOIN review_requests r ON r.id = e.target_id
                WHERE e.project_id = ? AND e.type = 'review.submitted'
                  AND r.target_type = ? AND r.target_id = ?
                ORDER BY e.id DESC LIMIT 1
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

    def locate(self, *, request_id: Any = None, session_id: Any = None) -> tuple[str, str, str] | None:
        """(project, target type, target id) behind one request or session, or None."""
        if bool(request_id) == bool(session_id):
            raise ValueError("provide exactly one of review_request_id or review_session_id")
        sql = ("SELECT project_id, target_type, target_id FROM review_requests WHERE id = ?" if request_id else
               "SELECT r.project_id, r.target_type, r.target_id FROM review_sessions s "
               "JOIN review_requests r ON r.id = s.request_id WHERE s.id = ?")
        with closing(self.store.connect()) as conn:
            row = conn.execute(sql, (str(request_id or session_id),)).fetchone()
        return None if row is None else (str(row["project_id"]), str(row["target_type"]), str(row["target_id"]))

    def _with_snapshot(self, *, row) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        data["target_snapshot"] = snapshot_from_id(
            snapshot_id=data.get("target_snapshot_id", "")
        )
        return data

    @staticmethod
    def _validate_request_open(*, req, capability: str | None) -> None:
        """``None`` is an assigned session, whose lease already proved itself."""
        # Compare digests in constant time; plaintext capabilities never rest.
        if capability is not None and not secret_digest_matches(
            stored_digest=req["capability_hash"], presented_digest=hash_secret(capability)
        ):
            raise PermissionDeniedError("invalid reviewer capability")
        if req["status"] not in {"requested", "started"}:
            raise PermissionDeniedError("review request is no longer open")
        expires = parse_iso(req["expires_at"])
        if expires is None or datetime.now(UTC) > expires:
            raise PermissionDeniedError("reviewer capability expired")

    def _validate_role_matches_gate(
        self, *, target_type: str, expected: str | None, role: str
    ) -> None:
        if role in REVIEW_GATE_EXEMPT_ROLES:
            return
        if expected is None:
            raise PermissionDeniedError(
                f"{target_type} is not currently awaiting {role}"
            )
        if role != expected:
            raise PermissionDeniedError(f"active gate requires {expected}, not {role}")

    def _target_snapshot_id(self, *, conn: Connection, project_id: str, target_type: str, target_id: str, lock: bool = False) -> str:
        current = self.runtime.get(conn=conn, project_id=project_id, instance_id=target_id)
        if current.workflow != target_type:
            raise NotFoundError(f"workflow {target_type!r} not found in this project: {target_id}")
        if lock:
            self.runtime.lock(conn=conn, project_id=project_id, instance_id=target_id, revision=current.revision)
        target = self._target(conn=conn, project_id=project_id, target_type=target_type, target_id=target_id)
        return review_snapshot_id(target_type=target_type, target=target, snapshot=current)

    def read_fact(self, *, snapshot: Snapshot, reference: Reference, conn: Connection) -> dict[str, Any]:
        if reference.kind not in {"review", "review_snapshot"}:
            raise NotFoundError(f"unknown review fact: {reference.kind}")
        node = self.runtime.registry.get(snapshot.workflow, snapshot.version).node(snapshot.state)
        if reference.kind == "review_snapshot" and reference.id != snapshot.id:
            raise NotFoundError("review snapshot belongs to another workflow instance")
        role = reference.id if reference.kind == "review" else (node.role if node is not None else "")
        snapshot_id = self._target_snapshot_id(conn=conn, project_id=snapshot.project_id,
                                               target_type=snapshot.workflow, target_id=snapshot.id)
        return read_review_fact(conn=conn, project_id=snapshot.project_id, target_type=snapshot.workflow,
                                target_id=snapshot.id, snapshot_id=snapshot_id, role=role).reference(request=reference.kind == "review_snapshot")

    def _target(self, *, conn: Connection, target_type: str, target_id: str, project_id: str | None = None) -> dict[str, Any]:
        """The record under review as a plain mapping, or a table-less instance's pinned artifacts."""
        kind = self.records.kinds.get(target_type)
        if kind is not None:
            return public_record(Public(), self.records.get_state(kind, record_id=target_id, project_id=project_id, conn=conn))
        snapshot = self.runtime.get(conn=conn, project_id=project_id, instance_id=target_id)
        if snapshot.workflow != target_type:
            raise NotFoundError(f"workflow {target_type!r} not found in this project: {target_id}")
        selected = snapshot.data.get("artifacts") or {}
        if not isinstance(selected, Mapping) or any(not isinstance(label, str) or not isinstance(value, str) for label, value in selected.items()):
            raise ValidationError("workflow artifacts must map labels to immutable content IDs")
        if selected:
            self.records.artifacts.contents.assert_complete(artifact_ids=tuple(selected.values()), project_id=project_id, tx=conn)
        return {"id": snapshot.id, "project_id": snapshot.project_id, "status": snapshot.state,
                "attempt_index": int(snapshot.data.get("attempt_index") or 1),
                "current_attempt_artifacts": [{"id": value, "role": label} for label, value in selected.items()]}

    def _hydrate_review(self, *, row) -> dict[str, Any]:
        data = self._with_snapshot(row=row)
        data["findings"] = json.loads(data.pop("findings_json", "[]"))
        data["evidence"] = json.loads(data.pop("evidence_json", "{}"))
        return data
