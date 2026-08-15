# If you update this file, consult agent_sessions.md and keep it under 100 lines.
"""Durable identities and leases for locally hosted coding-agent processes."""

from __future__ import annotations

from contextlib import closing
from datetime import UTC, datetime, timedelta
import json
import re
from typing import Any, Iterable, Mapping

from ..kernel.secret_tokens import hash_secret, secret_digest_matches
from ..kernel.state import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import (
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
    format_iso,
    new_id,
    parse_iso,
)
from merv.shared.runner_settings import RunnerSettingsError, validate_desired_settings


AGENT_SESSION_SECRET_PREFIX = "mas_"
OFFER_LEASE_SECONDS = 5 * 60
ACTIVE_LEASE_SECONDS = 4 * 60 * 60
DEFAULT_HARD_DEADLINE_SECONDS = 24 * 60 * 60
MAX_HARD_DEADLINE_SECONDS = 7 * 24 * 60 * 60
FAILURE_BACKOFF_SECONDS = 5 * 60
FAILURE_REASONS = (
    "workspace_failed",
    "launch_failed",
    "host_process_failed",
    "host_process_crash_loop",
)
LIVE_STATUSES = ("offered", "active")

_PUBLIC_COLUMNS = """
id, project_id, target_type, target_id, attempt_index, kind, review_request_id,
source_sha, runner_id, platform, status, host_session_ref,
workspace_ref, base_sha, head_sha,
assignment_json, agent_setup_json, telemetry_json, telemetry_at,
created_at, activated_at, last_activity_at, lease_expires_at, hard_deadline_at,
closed_at, close_reason
"""

MAX_ASSIGNMENT_BYTES = 64 * 1024
MAX_AGENT_SETUP_BYTES = 8 * 1024
MAX_TELEMETRY_BYTES = 8 * 1024
MAX_RUNNER_PRESENCE_BYTES = 16 * 1024
RUNNER_LIVE_SECONDS = 45
# Trace peek: a bounded, redacted excerpt per session, never the raw trace.
MAX_TRACE_EVENTS = 60
MAX_TRACE_EVENT_BYTES = 4 * 1024
MAX_TRACE_EVENTS_BYTES = 96 * 1024
MAX_TRACE_STDERR_CHARS = 8 * 1024
TRACE_GRACE_AFTER_CLOSE_SECONDS = 15 * 60


class AgentSessions:
    """Own the small server-side half of local coding-agent execution."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        terminal_experiment_statuses: Iterable[str] = (),
    ) -> None:
        self.store = store
        self.terminal_experiment_statuses = tuple(
            sorted(set(terminal_experiment_statuses))
        )

    def claim(
        self,
        *,
        project_id: str,
        candidates: Iterable[Mapping[str, Any]],
        runner_id: str,
        platform: str,
        idempotency_key: str,
        session_secret: str,
        source_key_id: str = "",
        source_user_id: str = "",
        hard_deadline_seconds: int = DEFAULT_HARD_DEADLINE_SECONDS,
    ) -> dict[str, Any] | None:
        """Offer the first unchanged experiment, review, or consolidation task."""
        runner_id = _required(runner_id, "runner_id", limit=160)
        platform = _required(platform, "platform", limit=80)
        idempotency_key = _required(idempotency_key, "idempotency_key", limit=160)
        digest = _secret_digest(session_secret)
        deadline_seconds = max(
            OFFER_LEASE_SECONDS,
            min(int(hard_deadline_seconds), MAX_HARD_DEADLINE_SECONDS),
        )
        now = datetime.now(UTC)
        now_text = format_iso(now)

        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            self._close_invalid_targets(tx=tx, now=now)
            self._expire_due(tx=tx, now=now)
            retry = tx.execute(
                """
                SELECT project_id, platform, secret_digest, source_key_id,
                       source_user_id
                FROM agent_sessions
                WHERE runner_id = ? AND idempotency_key = ?
                """,
                (runner_id, idempotency_key),
            ).fetchone()
            if retry is not None:
                if not secret_digest_matches(
                    stored_digest=retry["secret_digest"], presented_digest=digest
                ):
                    raise PermissionDeniedError(
                        "idempotency key is already bound to a different session secret"
                    )
                stable = (
                    str(retry["project_id"]) == project_id
                    and str(retry["platform"]) == platform
                    and str(retry["source_key_id"] or "") == source_key_id
                    and str(retry["source_user_id"] or "") == source_user_id
                )
                if not stable:
                    raise PermissionDeniedError(
                        "idempotency key is already bound to a different claim"
                    )
                return self._find_retry(
                    tx=tx, runner_id=runner_id, idempotency_key=idempotency_key
                )

            recent_failures = self._recent_failures(
                tx=tx,
                project_id=project_id,
                platform=platform,
                since=now - timedelta(seconds=FAILURE_BACKOFF_SECONDS),
            )
            for candidate in candidates:
                target_type = str(candidate.get("target_type") or "experiment")
                target_id = str(candidate.get("target_id") or candidate.get("id") or "")
                expected_status = str(candidate.get("status") or "")
                expected_attempt = int(candidate.get("attempt_index") or 0)
                kind = str(candidate.get("kind") or "experiment")
                review_request_id = str(candidate.get("review_request_id") or "")
                source_sha = _sha(candidate.get("source_sha") or "", allow_empty=True)
                if (
                    target_type not in {"experiment", "reflection"}
                    or not target_id
                    or not expected_status
                    or expected_attempt < 1
                    or kind not in {"experiment", "review", "consolidation"}
                ):
                    continue
                if not self._target_matches(
                    tx=tx,
                    project_id=project_id,
                    target_type=target_type,
                    target_id=target_id,
                    status=expected_status,
                    attempt_index=expected_attempt,
                ):
                    continue
                if kind == "review":
                    review = tx.execute(
                        """
                        SELECT id FROM review_requests
                        WHERE id = ? AND project_id = ?
                          AND target_type = ? AND target_id = ?
                          AND status IN ('requested', 'started') AND expires_at > ?
                        """,
                        (
                            review_request_id,
                            project_id,
                            target_type,
                            target_id,
                            now_text,
                        ),
                    ).fetchone()
                    if review is None:
                        continue
                elif kind == "experiment" and target_type != "experiment":
                    continue
                elif kind == "consolidation" and target_type != "reflection":
                    continue
                if (
                    target_type,
                    target_id,
                    kind,
                    review_request_id,
                ) in recent_failures:
                    continue
                session_id = new_id(prefix="ags")
                inserted = tx.execute(
                    """
                    INSERT INTO agent_sessions (
                      id, project_id, target_type, target_id, attempt_index, kind,
                      review_request_id, source_sha, runner_id, platform, idempotency_key,
                      secret_digest, status, created_at, lease_expires_at,
                      hard_deadline_at, source_key_id, source_user_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?, ?)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                    """,
                    (
                        session_id,
                        project_id,
                        target_type,
                        target_id,
                        expected_attempt,
                        kind,
                        review_request_id,
                        source_sha,
                        runner_id,
                        platform,
                        idempotency_key,
                        digest,
                        now_text,
                        format_iso(now + timedelta(seconds=OFFER_LEASE_SECONDS)),
                        format_iso(now + timedelta(seconds=deadline_seconds)),
                        source_key_id or None,
                        source_user_id,
                    ),
                ).fetchone()
                if inserted is None:
                    continue
                return self._find(tx=tx, session_id=session_id)
        return None

    def set_assignment(
        self, *, session_id: str, assignment: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Freeze the human-readable packet Application assigned this session."""
        encoded = _bounded_json_object(
            assignment,
            field="assignment",
            limit=MAX_ASSIGNMENT_BYTES,
        )
        with self.store.transaction() as tx:
            row = tx.execute(
                "SELECT assignment_json FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"agent session not found: {session_id}")
            existing = str(row["assignment_json"] or "{}")
            if existing not in {"", "{}"} and existing != encoded:
                raise ValidationError("agent session assignment is immutable")
            tx.execute(
                "UPDATE agent_sessions SET assignment_json = ? WHERE id = ?",
                (encoded, session_id),
            )
            return self._find(tx=tx, session_id=session_id)

    def authenticate(self, *, session_secret: str) -> dict[str, Any] | None:
        """Validate, activate, and touch a session credential in one write."""
        digest = hash_secret(session_secret)
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            self._expire_due(tx=tx, now=now)
            row = tx.execute(
                """
                SELECT s.*, p.tenant_id,
                       e.status AS experiment_status,
                       e.attempt_index AS current_attempt_index,
                       r.status AS reflection_status,
                       r.attempt_index AS current_reflection_attempt_index,
                       rr.status AS review_status,
                       rr.role AS review_role
                FROM agent_sessions s
                JOIN projects p ON p.id = s.project_id
                LEFT JOIN experiments e
                  ON s.target_type = 'experiment' AND e.id = s.target_id
                LEFT JOIN reflections r
                  ON s.target_type = 'reflection' AND r.id = s.target_id
                LEFT JOIN review_requests rr ON rr.id = s.review_request_id
                WHERE s.secret_digest = ?
                """,
                (digest,),
            ).fetchone()
            if row is None or str(row["status"]) not in LIVE_STATUSES:
                return None
            invalid_reason = self._invalid_target_reason(row=row)
            if invalid_reason:
                self._close(tx=tx, row=row, now=now, reason=invalid_reason)
                return None
            hard_deadline = parse_iso(row["hard_deadline_at"])
            lease_until = min(
                now + timedelta(seconds=ACTIVE_LEASE_SECONDS),
                hard_deadline or now,
            )
            now_text = format_iso(now)
            tx.execute(
                """
                UPDATE agent_sessions
                SET status = 'active',
                    activated_at = COALESCE(activated_at, ?),
                    last_activity_at = ?,
                    lease_expires_at = ?
                WHERE id = ?
                """,
                (now_text, now_text, format_iso(lease_until), row["id"]),
            )
            authenticated = row_to_dict(row=row) or {}
            authenticated["status"] = "active"
            return authenticated

    def attach(
        self,
        *,
        session_id: str,
        runner_id: str,
        host_session_ref: str,
        workspace_ref: str = "",
        base_sha: str = "",
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        agent_setup: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        host_session_ref = _required(host_session_ref, "host_session_ref", limit=500)
        workspace_ref = str(workspace_ref or "").strip()[:500]
        base_sha = _sha(base_sha, allow_empty=True)
        head_sha = _sha(head_sha, allow_empty=True)
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            self._expire_due(tx=tx, now=now)
            self._close_invalid_targets(tx=tx, now=now)
            row = self._owned_live(tx=tx, session_id=session_id, runner_id=runner_id)
            existing = str(row["host_session_ref"] or "")
            existing_workspace = str(row["workspace_ref"] or "")
            if existing == host_session_ref and existing_workspace == workspace_ref:
                self._record_observability(
                    tx=tx,
                    row=row,
                    agent_setup=agent_setup,
                    telemetry=telemetry,
                )
                self._record_workspace(
                    tx=tx,
                    row=row,
                    workspace_ref=workspace_ref,
                    base_sha=base_sha,
                    head_sha=head_sha,
                    stats=workspace_stats,
                )
                return self._find(tx=tx, session_id=session_id)
            if existing or existing_workspace:
                raise PermissionDeniedError(
                    "agent session is already attached to another host process"
                )
            tx.execute(
                """
                UPDATE agent_sessions
                SET host_session_ref = ?, workspace_ref = ?,
                    base_sha = ?, head_sha = ?
                WHERE id = ?
                """,
                (host_session_ref, workspace_ref, base_sha, head_sha, session_id),
            )
            self._record_observability(
                tx=tx,
                row=row,
                agent_setup=agent_setup,
                telemetry=telemetry,
            )
            self._record_workspace(
                tx=tx,
                row=row,
                workspace_ref=workspace_ref,
                base_sha=base_sha,
                head_sha=head_sha,
                stats=workspace_stats,
            )
            return self._find(tx=tx, session_id=session_id)

    def heartbeat(
        self,
        *,
        session_id: str,
        runner_id: str,
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Renew a lease only after the owning runner confirms a live child."""
        now = datetime.now(UTC)
        head_sha = _sha(head_sha, allow_empty=True)
        with self.store.transaction() as tx:
            self._expire_due(tx=tx, now=now)
            self._close_invalid_targets(tx=tx, now=now)
            row = self._owned_live(tx=tx, session_id=session_id, runner_id=runner_id)
            if str(row["status"]) != "active":
                raise ValidationError("agent session is offered, not active")
            hard_deadline = parse_iso(row["hard_deadline_at"])
            lease_until = min(
                now + timedelta(seconds=ACTIVE_LEASE_SECONDS),
                hard_deadline or now,
            )
            tx.execute(
                """
                UPDATE agent_sessions
                SET last_activity_at = ?, lease_expires_at = ?,
                    head_sha = CASE WHEN ? = '' THEN head_sha ELSE ? END
                WHERE id = ?
                """,
                (
                    format_iso(now),
                    format_iso(lease_until),
                    head_sha,
                    head_sha,
                    session_id,
                ),
            )
            self._record_observability(
                tx=tx,
                row=row,
                telemetry=telemetry,
            )
            self._record_workspace(
                tx=tx,
                row=row,
                workspace_ref=str(row["workspace_ref"] or ""),
                base_sha=str(row["base_sha"] or ""),
                head_sha=head_sha or str(row["head_sha"] or ""),
                stats=workspace_stats,
            )
            return self._find(tx=tx, session_id=session_id)

    def release(
        self,
        *,
        session_id: str,
        runner_id: str,
        reason: str = "runner_released",
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        reason = (reason or "runner_released").strip()[:200]
        head_sha = _sha(head_sha, allow_empty=True)
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            row = tx.execute(
                "SELECT * FROM agent_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"agent session not found: {session_id}")
            if str(row["runner_id"]) != runner_id:
                raise PermissionDeniedError("agent session belongs to another runner")
            if str(row["status"]) in LIVE_STATUSES:
                tx.execute(
                    """
                    UPDATE agent_sessions
                    SET status = 'released', closed_at = ?, close_reason = ?,
                        head_sha = CASE WHEN ? = '' THEN head_sha ELSE ? END
                    WHERE id = ?
                    """,
                    (format_iso(now), reason, head_sha, head_sha, session_id),
                )
                self._record_observability(
                    tx=tx,
                    row=row,
                    telemetry=telemetry,
                )
                self._record_workspace(
                    tx=tx,
                    row=row,
                    workspace_ref=str(row["workspace_ref"] or ""),
                    base_sha=str(row["base_sha"] or ""),
                    head_sha=head_sha or str(row["head_sha"] or ""),
                    stats=workspace_stats,
                )
            return self._find(tx=tx, session_id=session_id)

    def heartbeat_runner(
        self,
        *,
        project_id: str,
        runner_id: str,
        machine: Mapping[str, Any],
        platforms: Iterable[Mapping[str, Any]],
        capacity: int,
        inventory: Mapping[str, Any] | None = None,
        applied_version: int | None = None,
    ) -> dict[str, Any]:
        """Remember a polling runner and hand back its own desired tuning.

        Nothing secret travels either way: the runner reports machine identity,
        its platform inventory (enabled or not, native or CLI-only), workspace
        paths, resolvable executables, and which settings version it has
        applied; the brain answers with that runner's own row and the desired
        settings an owner saved. Executable argv never appears in either.
        """
        runner_id = _required(runner_id, "runner_id", limit=240)
        machine_payload = {
            name: str(machine.get(name) or "").strip()[:240]
            for name in ("hostname", "system", "architecture")
            if str(machine.get(name) or "").strip()
        }
        platform_items: list[dict[str, Any]] = []
        for item in platforms:
            if not isinstance(item, Mapping):
                continue
            projected: dict[str, Any] = {}
            for name in ("name", "harness", "model", "effort"):
                text = str(item.get(name) or "").strip()
                if text:
                    projected[name] = text[:240]
            parallelism = item.get("parallelism")
            if isinstance(parallelism, int) and not isinstance(parallelism, bool):
                projected["parallelism"] = max(parallelism, 0)
            for flag in ("enabled", "managed"):
                if isinstance(item.get(flag), bool):
                    projected[flag] = item[flag]
            platform_items.append(projected)
        encoded_machine = _bounded_json_object(
            machine_payload,
            field="machine",
            limit=MAX_RUNNER_PRESENCE_BYTES,
        )
        encoded_platforms = _bounded_json_object(
            {"items": platform_items[:32]},
            field="platforms",
            limit=MAX_RUNNER_PRESENCE_BYTES,
        )
        encoded_inventory = _bounded_json_object(
            _inventory_projection(inventory),
            field="inventory",
            limit=MAX_RUNNER_PRESENCE_BYTES,
        )
        applied = (
            max(int(applied_version), 0)
            if isinstance(applied_version, int) and not isinstance(applied_version, bool)
            else None
        )
        now = format_iso(datetime.now(UTC))
        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            tx.execute(
                """
                INSERT INTO agent_runners (
                  project_id, runner_id, machine_json, platforms_json,
                  capacity, started_at, last_seen_at, inventory_json, applied_version
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, runner_id) DO UPDATE SET
                  machine_json = excluded.machine_json,
                  platforms_json = excluded.platforms_json,
                  capacity = excluded.capacity,
                  last_seen_at = excluded.last_seen_at,
                  inventory_json = excluded.inventory_json,
                  applied_version = COALESCE(?, agent_runners.applied_version)
                """,
                (
                    project_id,
                    runner_id,
                    encoded_machine,
                    encoded_platforms,
                    max(int(capacity), 0),
                    now,
                    now,
                    encoded_inventory,
                    applied if applied is not None else 0,
                    applied,
                ),
            )
            own = self.runner_row(tx=tx, project_id=project_id, runner_id=runner_id) or {}
            return {
                "presence": own,
                "desired_version": int(own.get("desired_version") or 0),
                "desired_settings": own.get("desired_settings") or {},
            }

    def set_desired_settings(
        self, *, project_id: str, runner_ref: str, settings: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Store what an owner wants a paired runner to apply; bump the version.

        The browser names the runner by its opaque ``runner_ref``; only a
        runner that has heartbeated at least once has a row, and the browser
        only ever offers the runners it can see.
        """
        ref = _required(runner_ref, "runner_ref", limit=64)
        try:
            desired = validate_desired_settings(settings)
        except RunnerSettingsError as exc:
            raise ValidationError(str(exc), details={"field": "settings"}) from exc
        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            match = next(
                (
                    row
                    for row in tx.execute(
                        "SELECT runner_id, desired_settings_json FROM agent_runners "
                        "WHERE project_id = ?",
                        (project_id,),
                    ).fetchall()
                    if runner_ref_matches(
                        project_id=project_id, runner_id=str(row["runner_id"]), ref=ref
                    )
                ),
                None,
            )
            if match is None:
                raise NotFoundError("runner not found")
            runner_id = str(match["runner_id"])
            # Fold into what is already desired: a PUT that carries only a
            # probe (Test) must not erase platform or workspace wishes a
            # machine has not pulled yet. Platform entries replace by name,
            # workspace replaces whole, a probe stays until the next probe.
            existing = _json_column(match["desired_settings_json"])
            merged: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
            if "platforms" in desired:
                current = merged.get("platforms")
                merged["platforms"] = {
                    **(current if isinstance(current, dict) else {}),
                    **desired["platforms"],
                }
            if "workspace" in desired:
                merged["workspace"] = desired["workspace"]
            if "probe" in desired:
                merged["probe"] = desired["probe"]
            encoded = _bounded_json_object(
                merged, field="settings", limit=MAX_RUNNER_PRESENCE_BYTES
            )
            tx.execute(
                """
                UPDATE agent_runners
                SET desired_settings_json = ?, desired_version = desired_version + 1
                WHERE project_id = ? AND runner_id = ?
                """,
                (encoded, project_id, runner_id),
            )
            return self.runner_row(tx=tx, project_id=project_id, runner_id=runner_id) or {}

    def list(self, *, project_id: str) -> dict[str, Any]:
        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            now = datetime.now(UTC)
            self._close_invalid_targets(tx=tx, now=now)
            self._expire_due(tx=tx, now=now)
            rows = tx.execute(
                f"""
                SELECT {_PUBLIC_COLUMNS},
                  (SELECT name FROM experiments
                   WHERE id = agent_sessions.target_id
                     AND agent_sessions.target_type = 'experiment') AS target_name,
                  (SELECT role FROM review_requests
                   WHERE id = agent_sessions.review_request_id) AS review_role,
                  (SELECT name FROM projects
                   WHERE id = agent_sessions.project_id) AS project_name
                FROM agent_sessions
                WHERE project_id = ?
                ORDER BY
                  CASE WHEN status IN ('offered', 'active') THEN 0 ELSE 1 END,
                  created_at DESC, id DESC
                LIMIT 250
                """,
                (project_id,),
            ).fetchall()
            runners = self.list_runners(tx=tx, project_id=project_id, now=now)
            return {
                "sessions": [_public_row(row) for row in rows],
                # Every machine that has heartbeated for this project, most
                # recently seen first. ``runner`` keeps the pre-existing
                # single-row shape for one release.
                "runners": runners,
                "runner": runners[0] if runners else None,
            }

    def live_targets(self, *, project_id: str) -> set[tuple[str, ...]]:
        """Keys of every offered/active session, shaped like the one-live-
        session indexes: ``("review", request_id)`` for reviews, else
        ``(kind, target_type, target_id)``. What the dispatch queue subtracts."""
        with self.store.transaction() as tx:
            rows = tx.execute(
                """
                SELECT kind, target_type, target_id, review_request_id
                FROM agent_sessions
                WHERE project_id = ? AND status IN ('offered', 'active')
                """,
                (project_id,),
            ).fetchall()
        keys: set[tuple[str, ...]] = set()
        for row in rows:
            kind = str(row["kind"] or "experiment")
            if kind == "review":
                keys.add(("review", str(row["review_request_id"] or "")))
            else:
                keys.add((kind, str(row["target_type"] or ""), str(row["target_id"] or "")))
        return keys

    def runner_row(
        self,
        *,
        project_id: str,
        runner_id: str,
        tx: Any | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any] | None:
        """One caller-scoped runner row, or None before its first heartbeat."""
        if tx is None:
            with closing(self.store.connect()) as conn:
                row = conn.execute(
                    f"{_RUNNER_SELECT} WHERE project_id = ? AND runner_id = ?",
                    (project_id, runner_id),
                ).fetchone()
        else:
            row = tx.execute(
                f"{_RUNNER_SELECT} WHERE project_id = ? AND runner_id = ?",
                (project_id, runner_id),
            ).fetchone()
        return None if row is None else _runner_view(row, now=now)

    def list_runners(
        self, *, project_id: str, tx: Any | None = None, now: datetime | None = None
    ) -> list[dict[str, Any]]:
        sql = f"{_RUNNER_SELECT} WHERE project_id = ? ORDER BY last_seen_at DESC, runner_id"
        if tx is None:
            with closing(self.store.connect()) as conn:
                rows = conn.execute(sql, (project_id,)).fetchall()
        else:
            rows = tx.execute(sql, (project_id,)).fetchall()
        return [_runner_view(row, now=now) for row in rows]

    @staticmethod
    def _record_observability(
        *,
        tx: Any,
        row: Any,
        agent_setup: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> None:
        if agent_setup is not None:
            encoded_setup = _bounded_json_object(
                agent_setup,
                field="agent_setup",
                limit=MAX_AGENT_SETUP_BYTES,
            )
            existing = str(row["agent_setup_json"] or "{}")
            if existing not in {"", "{}"} and existing != encoded_setup:
                raise ValidationError("agent session setup is immutable")
            tx.execute(
                "UPDATE agent_sessions SET agent_setup_json = ? WHERE id = ?",
                (encoded_setup, row["id"]),
            )
        if telemetry is not None:
            encoded_telemetry = _bounded_json_object(
                _telemetry_projection(telemetry),
                field="telemetry",
                limit=MAX_TELEMETRY_BYTES,
            )
            tx.execute(
                """
                UPDATE agent_sessions
                SET telemetry_json = ?, telemetry_at = ?
                WHERE id = ?
                """,
                (encoded_telemetry, format_iso(datetime.now(UTC)), row["id"]),
            )

    def workspaces(
        self, *, project_id: str, experiment_ids: Iterable[str] = ()
    ) -> dict[str, dict[str, Any]]:
        ids = tuple(dict.fromkeys(str(item) for item in experiment_ids if item))
        if not ids:
            return {}
        placeholders = ", ".join("?" for _ in ids)
        with closing(self.store.connect()) as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            rows = tx.execute(
                f"""
                SELECT * FROM experiment_workspaces
                WHERE project_id = ? AND experiment_id IN ({placeholders})
                """,
                (project_id, *ids),
            ).fetchall()
            return {
                str(row["experiment_id"]): row_to_dict(row=row) or {} for row in rows
            }

    def authority(self, *, session_id: str) -> dict[str, str]:
        """Return the immutable parent authority for runner control."""
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                """
                SELECT project_id, source_key_id, source_user_id
                FROM agent_sessions
                WHERE id = ?
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"agent session not found: {session_id}")
        return {
            "project_id": str(row["project_id"]),
            "source_key_id": str(row["source_key_id"] or ""),
            "source_user_id": str(row["source_user_id"] or ""),
        }

    def reconcile(self, *, now: datetime | None = None) -> int:
        """Close sessions whose lease or absolute deadline has passed."""
        with self.store.transaction() as tx:
            current = now or datetime.now(UTC)
            return self._close_invalid_targets(tx=tx, now=current) + self._expire_due(
                tx=tx, now=current
            )

    def halt(self, *, project_id: str, reason: str = "dispatch_halted") -> int:
        """Close every live session in a project so runners stop their children.

        Runners already terminate a child whose session has left ``offered`` or
        ``active``, so closing the rows here is the whole stop signal.
        """
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            rows = tx.execute(
                """
                SELECT id FROM agent_sessions
                WHERE project_id = ? AND status IN ('offered', 'active')
                """,
                (project_id,),
            ).fetchall()
            for row in rows:
                self._close(tx=tx, row=row, now=now, reason=reason[:200])
            return len(rows)

    def record_trace(
        self,
        *,
        session_id: str,
        runner_id: str,
        events: Iterable[Any],
        stderr_tail: str = "",
        complete: bool = False,
    ) -> dict[str, Any]:
        """Store the runner's bounded, redacted excerpt for one session.

        The owning runner may write it while the session is live and shortly
        after it closes (final capture, Hermes export). The row is capped and
        overwritten; the raw trace never leaves the machine.
        """
        encoded_events, kept = _trace_events_projection(events)
        tail = str(stderr_tail or "")[-MAX_TRACE_STDERR_CHARS:]
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            row = tx.execute(
                "SELECT id, project_id, runner_id, closed_at FROM agent_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"agent session not found: {session_id}")
            if str(row["runner_id"]) != runner_id:
                raise PermissionDeniedError("agent session belongs to another runner")
            closed_at = parse_iso(row["closed_at"])
            if closed_at is not None and now - closed_at > timedelta(
                seconds=TRACE_GRACE_AFTER_CLOSE_SECONDS
            ):
                raise ValidationError("agent session closed too long ago for a trace")
            tx.execute(
                """
                INSERT INTO agent_session_traces (
                  session_id, project_id, events_json, stderr_tail, complete, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (session_id) DO UPDATE SET
                  events_json = excluded.events_json,
                  stderr_tail = excluded.stderr_tail,
                  complete = excluded.complete,
                  updated_at = excluded.updated_at
                """,
                (
                    session_id,
                    str(row["project_id"]),
                    encoded_events,
                    tail,
                    1 if complete else 0,
                    format_iso(now),
                ),
            )
        return {"session_id": session_id, "events": kept, "complete": bool(complete)}

    def trace(self, *, project_id: str, session_id: str) -> dict[str, Any] | None:
        """The stored excerpt for the browser, or None when nothing was mirrored."""
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                """
                SELECT t.events_json, t.stderr_tail, t.complete, t.updated_at
                FROM agent_session_traces t
                JOIN agent_sessions s ON s.id = t.session_id
                WHERE t.session_id = ? AND s.project_id = ?
                """,
                (session_id, project_id),
            ).fetchone()
        if row is None:
            return None
        try:
            events = json.loads(str(row["events_json"] or "[]"))
        except ValueError:
            events = []
        return {
            "session_id": session_id,
            "events": events if isinstance(events, list) else [],
            "stderr_tail": str(row["stderr_tail"] or ""),
            "complete": bool(row["complete"]),
            "updated_at": str(row["updated_at"]),
        }

    def halt_session(
        self, *, project_id: str, session_id: str, reason: str = "halted_by_user"
    ) -> dict[str, Any]:
        """Close exactly one live session; the owning runner stops its child."""
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            self.store.require_project_id(conn=tx, project_id=project_id)
            row = tx.execute(
                "SELECT * FROM agent_sessions WHERE id = ? AND project_id = ?",
                (session_id, project_id),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"agent session not found: {session_id}")
            if str(row["status"]) in LIVE_STATUSES:
                self._close(tx=tx, row=row, now=now, reason=reason[:200])
            return self._find(tx=tx, session_id=session_id)

    def invalidate(self, *, session_id: str, reason: str) -> None:
        """Close a credential when Surface detects lost parent authority."""
        now = datetime.now(UTC)
        with self.store.transaction() as tx:
            row = tx.execute(
                "SELECT * FROM agent_sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if row is not None and str(row["status"]) in LIVE_STATUSES:
                self._close(
                    tx=tx,
                    row=row,
                    now=now,
                    reason=reason[:200],
                )

    @staticmethod
    def _target_matches(
        *,
        tx: Any,
        project_id: str,
        target_type: str,
        target_id: str,
        status: str,
        attempt_index: int,
    ) -> bool:
        table = "experiments" if target_type == "experiment" else "reflections"
        row = tx.execute(
            f"""
            SELECT 1 FROM {table}
            WHERE id = ? AND project_id = ? AND status = ? AND attempt_index = ?
            """,
            (target_id, project_id, status, attempt_index),
        ).fetchone()
        return row is not None

    @staticmethod
    def _record_workspace(
        *,
        tx: Any,
        row: Any,
        workspace_ref: str,
        base_sha: str,
        head_sha: str,
        stats: Mapping[str, Any] | None,
    ) -> None:
        if (
            str(row["target_type"]) != "experiment"
            or str(row["kind"]) != "experiment"
            or not workspace_ref
            or not base_sha
            or not head_sha
        ):
            return
        values = dict(stats or {})
        tx.execute(
            """
            INSERT INTO experiment_workspaces (
              experiment_id, project_id, branch, base_sha, head_sha,
              commit_count, files_changed, insertions, deletions, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (experiment_id) DO UPDATE SET
              branch = excluded.branch,
              base_sha = excluded.base_sha,
              head_sha = excluded.head_sha,
              commit_count = excluded.commit_count,
              files_changed = excluded.files_changed,
              insertions = excluded.insertions,
              deletions = excluded.deletions,
              updated_at = excluded.updated_at
            """,
            (
                row["target_id"],
                row["project_id"],
                workspace_ref,
                base_sha,
                head_sha,
                max(int(values.get("commit_count") or 0), 0),
                max(int(values.get("files_changed") or 0), 0),
                max(int(values.get("insertions") or 0), 0),
                max(int(values.get("deletions") or 0), 0),
                format_iso(datetime.now(UTC)),
            ),
        )

    def _close_invalid_targets(self, *, tx: Any, now: datetime) -> int:
        rows = tx.execute(
            """
            SELECT s.*, e.status AS experiment_status,
                   e.attempt_index AS current_attempt_index,
                   r.status AS reflection_status,
                   r.attempt_index AS current_reflection_attempt_index,
                   rr.status AS review_status,
                   rr.role AS review_role
            FROM agent_sessions s
            LEFT JOIN experiments e
              ON s.target_type = 'experiment' AND e.id = s.target_id
            LEFT JOIN reflections r
              ON s.target_type = 'reflection' AND r.id = s.target_id
            LEFT JOIN review_requests rr ON rr.id = s.review_request_id
            WHERE s.status IN ('offered', 'active')
            """
        ).fetchall()
        invalid = [(row, self._invalid_target_reason(row=row)) for row in rows]
        invalid = [(row, reason) for row, reason in invalid if reason]
        for row, reason in invalid:
            self._close(
                tx=tx,
                row=row,
                now=now,
                reason=reason,
            )
        return len(invalid)

    def _expire_due(self, *, tx: Any, now: datetime) -> int:
        rows = tx.execute(
            """
            SELECT id, project_id, target_type, target_id,
                   lease_expires_at, hard_deadline_at
            FROM agent_sessions
            WHERE status IN ('offered', 'active')
              AND (lease_expires_at <= ? OR hard_deadline_at <= ?)
            """,
            (format_iso(now), format_iso(now)),
        ).fetchall()
        for row in rows:
            hard = parse_iso(row["hard_deadline_at"])
            reason = (
                "hard_deadline" if hard is not None and hard <= now else "lease_expired"
            )
            self._close(tx=tx, row=row, now=now, reason=reason)
        return len(rows)

    @staticmethod
    def _recent_failures(
        *,
        tx: Any,
        project_id: str,
        platform: str,
        since: datetime,
    ) -> set[tuple[str, str, str, str]]:
        placeholders = ", ".join("?" for _ in FAILURE_REASONS)
        rows = tx.execute(
            f"""
            SELECT target_type, target_id, kind, review_request_id
            FROM agent_sessions
            WHERE project_id = ? AND platform = ?
              AND close_reason IN ({placeholders})
              AND closed_at > ?
            """,
            (project_id, platform, *FAILURE_REASONS, format_iso(since)),
        ).fetchall()
        return {
            (
                str(row["target_type"]),
                str(row["target_id"]),
                str(row["kind"]),
                str(row["review_request_id"] or ""),
            )
            for row in rows
        }

    def _invalid_target_reason(self, *, row: Any) -> str:
        target_type = str(row["target_type"])
        kind = str(row["kind"])
        if target_type == "experiment":
            if row["experiment_status"] is None:
                return "experiment_missing"
            if int(row["current_attempt_index"]) != int(row["attempt_index"]):
                return "experiment_attempt_changed"
            if (
                kind == "experiment"
                and str(row["experiment_status"]) in self.terminal_experiment_statuses
            ):
                return "experiment_terminal"
        elif target_type == "reflection":
            if row["reflection_status"] is None:
                return "reflection_missing"
            if int(row["current_reflection_attempt_index"]) != int(
                row["attempt_index"]
            ):
                return "reflection_attempt_changed"
        else:
            return "target_type_invalid"
        if kind == "review" and str(row["review_status"]) not in {
            "requested",
            "started",
        }:
            return "review_closed"
        if target_type == "reflection":
            role = str(row["review_role"] or "")
            reflection_status = str(row["reflection_status"])
            if kind == "review" and role == "reflection_reviewer":
                if reflection_status != "reflection_review":
                    return "reflection_not_reviewing"
            elif kind == "consolidation" or (
                kind == "review" and role == "consolidation_reviewer"
            ):
                if reflection_status != "consolidating":
                    return "reflection_not_consolidating"
            else:
                return "reflection_session_invalid"
        return ""

    def _close(
        self,
        *,
        tx: Any,
        row: Any,
        now: datetime,
        reason: str,
    ) -> None:
        tx.execute(
            """
            UPDATE agent_sessions
            SET status = ?, closed_at = ?, close_reason = ?
            WHERE id = ? AND status IN ('offered', 'active')
            """,
            ("expired", format_iso(now), reason, row["id"]),
        )

    def _owned_live(self, *, tx: Any, session_id: str, runner_id: str) -> Any:
        row = tx.execute(
            "SELECT * FROM agent_sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"agent session not found: {session_id}")
        if str(row["runner_id"]) != runner_id:
            raise PermissionDeniedError("agent session belongs to another runner")
        if str(row["status"]) not in LIVE_STATUSES:
            raise ValidationError(f"agent session is {row['status']}, not live")
        return row

    @staticmethod
    def _find(*, tx: Any, session_id: str) -> dict[str, Any]:
        row = tx.execute(
            f"SELECT {_PUBLIC_COLUMNS} FROM agent_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if row is None:  # pragma: no cover - same transaction inserted it
            raise RuntimeError("agent session disappeared")
        return _public_row(row)

    @staticmethod
    def _find_retry(*, tx: Any, runner_id: str, idempotency_key: str) -> dict[str, Any]:
        row = tx.execute(
            f"""
            SELECT {_PUBLIC_COLUMNS} FROM agent_sessions
            WHERE runner_id = ? AND idempotency_key = ?
            """,
            (runner_id, idempotency_key),
        ).fetchone()
        if row is None:  # pragma: no cover - caller found this row already
            raise RuntimeError("agent session retry disappeared")
        return _public_row(row)


def _required(value: str, field: str, *, limit: int) -> str:
    clean = str(value or "").strip()
    if not clean:
        raise ValidationError(f"{field} is required", details={"field": field})
    if len(clean) > limit:
        raise ValidationError(
            f"{field} is too long", details={"field": field, "max_length": limit}
        )
    return clean


def _secret_digest(secret: str) -> str:
    if not secret.startswith(AGENT_SESSION_SECRET_PREFIX) or len(secret) < 43:
        raise ValidationError(
            "session_secret must be a high-entropy mas_ credential",
            details={"field": "session_secret"},
        )
    return hash_secret(secret)


def _sha(value: Any, *, allow_empty: bool = False) -> str:
    clean = str(value or "").strip().lower()
    if allow_empty and not clean:
        return ""
    if not (40 <= len(clean) <= 64) or any(
        char not in "0123456789abcdef" for char in clean
    ):
        raise ValidationError("Git SHA must be a full hexadecimal object id")
    return clean


def _bounded_json_object(
    value: Mapping[str, Any], *, field: str, limit: int
) -> str:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{field} must be an object", details={"field": field})
    try:
        encoded = json.dumps(
            dict(value),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValidationError(
            f"{field} must contain JSON values", details={"field": field}
        ) from exc
    if len(encoded.encode("utf-8")) > limit:
        raise ValidationError(
            f"{field} is too large",
            details={"field": field, "max_bytes": limit},
        )
    return encoded


def _telemetry_projection(value: Mapping[str, Any]) -> dict[str, Any]:
    """Keep aggregate counters only; provider events stay on the runner."""
    result: dict[str, Any] = {}
    for name in (
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "total_tokens",
        "tool_calls",
        "messages",
    ):
        raw = value.get(name)
        if isinstance(raw, int) and not isinstance(raw, bool):
            result[name] = max(raw, 0)
    for name in ("last_event_at", "provider_session", "reporting"):
        raw = value.get(name)
        if isinstance(raw, str) and raw.strip():
            result[name] = raw.strip()[:240]
    if isinstance(value.get("final"), bool):
        result["final"] = value["final"]
    return result


def _json_column(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


_SECRET_KEY = re.compile(r"(?i)(api[-_]?key|token|secret|password|credential|authorization)")
_SECRET_VALUE = re.compile(r"\b(?:mk_|mas_|rr_sk_|sk-|ghp_|xox[a-z]-)[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]{8,}")


def _redact(value: Any, *, depth: int = 0) -> Any:
    """Drop secret-looking keys and mask secret-looking strings, recursively."""
    if depth > 12:
        return "<nested>"
    if isinstance(value, Mapping):
        return {
            str(key)[:120]: ("<redacted>" if _SECRET_KEY.search(str(key)) else _redact(item, depth=depth + 1))
            for key, item in list(value.items())[:64]
        }
    if isinstance(value, list):
        return [_redact(item, depth=depth + 1) for item in value[:64]]
    if isinstance(value, str):
        return _SECRET_VALUE.sub("<redacted>", value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:240]


def _trace_events_projection(events: Iterable[Any]) -> tuple[str, int]:
    """Keep the last few events, each capped and redacted; return JSON and count."""
    kept: list[Any] = []
    for raw in list(events)[-MAX_TRACE_EVENTS:]:
        cleaned = _redact(raw)
        encoded = json.dumps(cleaned, sort_keys=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_TRACE_EVENT_BYTES:
            cleaned = {
                "truncated": True,
                "preview": encoded[: MAX_TRACE_EVENT_BYTES // 2],
            }
        kept.append(cleaned)
    encoded_all = json.dumps(kept, sort_keys=True, separators=(",", ":"))
    while len(encoded_all.encode("utf-8")) > MAX_TRACE_EVENTS_BYTES and kept:
        kept.pop(0)
        encoded_all = json.dumps(kept, sort_keys=True, separators=(",", ":"))
    return encoded_all, len(kept)


_RUNNER_SELECT = """
SELECT project_id, runner_id, machine_json, platforms_json, capacity, started_at,
       last_seen_at, desired_settings_json, desired_version, applied_version,
       inventory_json
FROM agent_runners
"""


def runner_ref(*, project_id: str, runner_id: str) -> str:
    """Opaque, stable browser handle for a runner row.

    Runner identity itself (the principal-prefixed machine id) stays private to
    the runner and the brain; the browser addresses settings by this digest.
    """
    return hash_secret(f"merv-runner-ref:{project_id}:{runner_id}")[:24]


def runner_ref_matches(*, project_id: str, runner_id: str, ref: str) -> bool:
    return secret_digest_matches(
        stored_digest=runner_ref(project_id=project_id, runner_id=runner_id),
        presented_digest=ref,
    )


def _runner_view(row: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """The non-secret runner row the browser and the runner itself both see."""
    seen = parse_iso(row["last_seen_at"])
    current = now or datetime.now(UTC)
    platforms = _json_column(row["platforms_json"]).get("items")
    desired_version = int(row["desired_version"] or 0)
    applied_version = int(row["applied_version"] or 0)
    return {
        "runner_ref": runner_ref(
            project_id=str(row["project_id"]), runner_id=str(row["runner_id"])
        ),
        "machine": _json_column(row["machine_json"]),
        "platforms": platforms if isinstance(platforms, list) else [],
        "capacity": max(int(row["capacity"] or 0), 0),
        "started_at": str(row["started_at"]),
        "last_seen_at": str(row["last_seen_at"]),
        "live": bool(
            seen is not None and (current - seen).total_seconds() <= RUNNER_LIVE_SECONDS
        ),
        "desired_settings": _json_column(row["desired_settings_json"]),
        "desired_version": desired_version,
        "applied_version": applied_version,
        "settings_pending": applied_version < desired_version,
        "inventory": _json_column(row["inventory_json"]),
    }


def _inventory_projection(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Keep the runner's non-secret self-report; drop anything unexpected."""
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    workspace = value.get("workspace")
    if isinstance(workspace, Mapping):
        result["workspace"] = {
            name: str(workspace.get(name) or "").strip()[:1024]
            for name in ("repository", "root", "base_ref")
            if str(workspace.get(name) or "").strip()
        }
    commands = value.get("available_commands")
    if isinstance(commands, Mapping):
        result["available_commands"] = {
            str(name)[:80]: bool(flag)
            for name, flag in sorted(commands.items())[:64]
            if str(name).strip()
        }
    local_sessions = value.get("local_sessions")
    if isinstance(local_sessions, Mapping):
        result["local_sessions"] = {
            name: max(int(local_sessions[name]), 0)
            for name in ("running", "uncertain")
            if isinstance(local_sessions.get(name), int)
            and not isinstance(local_sessions.get(name), bool)
        }
    pending = value.get("pending")
    if isinstance(pending, Mapping) and str(pending.get("reason") or "").strip():
        result["pending"] = {"reason": str(pending["reason"]).strip()[:240]}
    for name in ("settings_error", "runner_version"):
        raw = value.get(name)
        if isinstance(raw, str) and raw.strip():
            result[name] = raw.strip()[:240]
    harness = _harness_projection(value.get("harness"))
    if harness:
        result["harness"] = harness
    return result


def _harness_projection(value: Any) -> dict[str, Any]:
    """The runner's per-platform readiness: executables, versions, and how
    each harness reaches Merv skills and tools. Never argv, never secrets."""
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, Any] = {}
    skills = value.get("skills")
    if isinstance(skills, Mapping):
        projected: dict[str, Any] = {}
        count = skills.get("count")
        if isinstance(count, int) and not isinstance(count, bool):
            projected["count"] = max(count, 0)
        for name in ("root", "digest", "error"):
            raw = skills.get(name)
            if isinstance(raw, str) and raw.strip():
                projected[name] = raw.strip()[:1024 if name == "root" else 240]
        if projected:
            result["skills"] = projected
    platforms = value.get("platforms")
    if isinstance(platforms, Mapping):
        entries: dict[str, Any] = {}
        for name, raw in sorted(platforms.items())[:32]:
            if not str(name).strip() or not isinstance(raw, Mapping):
                continue
            entry: dict[str, Any] = {"ok": bool(raw.get("ok"))}
            for field in ("adapter", "executable", "version", "merv_mcp", "skills"):
                text = raw.get(field)
                if isinstance(text, str) and text.strip():
                    entry[field] = text.strip()[:1024 if field == "executable" else 120]
            if isinstance(raw.get("enabled"), bool):
                entry["enabled"] = raw["enabled"]
            problems = raw.get("problems")
            if isinstance(problems, list):
                entry["problems"] = [
                    str(item).strip()[:240] for item in problems[:8] if str(item).strip()
                ]
            # Sign-in signal / evidence, quota evidence, and the last test call:
            # small string-valued objects, whitelisted field by field.
            for block, fields in (
                ("auth", ("status", "via", "detail", "line", "at")),
                ("quota", ("status", "detail", "line", "at")),
                ("smoke", ("status", "at", "detail", "kind", "nonce", "why")),
            ):
                raw_block = raw.get(block)
                if not isinstance(raw_block, Mapping):
                    continue
                projected: dict[str, Any] = {}
                for field in fields:
                    text = raw_block.get(field)
                    if isinstance(text, str) and text.strip():
                        projected[field] = text.strip()[:240]
                if block == "smoke":
                    duration = raw_block.get("duration_ms")
                    if isinstance(duration, int) and not isinstance(duration, bool):
                        projected["duration_ms"] = max(duration, 0)
                if projected:
                    entry[block] = projected
            entries[str(name)[:80]] = entry
        if entries:
            result["platforms"] = entries
    error = value.get("error")
    if isinstance(error, str) and error.strip():
        result["error"] = error.strip()[:240]
    return result


def _fallback_assignment(result: Mapping[str, Any]) -> dict[str, Any]:
    kind = str(result.get("kind") or "experiment")
    role = str(result.get("review_role") or "")
    target_type = str(result.get("target_type") or "")
    target_name = str(result.get("target_name") or "").strip()
    project_name = str(result.get("project_name") or "").strip()
    title = "Run experiment"
    if kind == "consolidation":
        title = "Consolidate reflection"
    elif kind == "review":
        title = {
            "design_reviewer": "Review plan",
            "attempt_reviewer": "Review results",
            "reflection_reviewer": "Review reflection",
            "consolidation_reviewer": "Review consolidation",
        }.get(role, "Review work")
    subtitle = target_name or ("Project reflection" if target_type == "reflection" else "Experiment")
    packet: dict[str, Any] = {
        "task": title,
        "attempt": max(int(result.get("attempt_index") or 0), 0),
    }
    if project_name:
        packet["project"] = project_name
    packet["reflection" if target_type == "reflection" else "experiment"] = subtitle
    return {"title": title, "subtitle": subtitle, "packet": packet}


def _public_row(row: Any) -> dict[str, Any]:
    result = row_to_dict(row=row) or {}
    assignment = _json_column(result.pop("assignment_json", "{}"))
    result["assignment"] = assignment or _fallback_assignment(result)
    result["agent_setup"] = _json_column(result.pop("agent_setup_json", "{}"))
    result["telemetry"] = _json_column(result.pop("telemetry_json", "{}"))
    target_type = str(result.get("target_type") or "")
    target_id = str(result.get("target_id") or "")
    result["experiment_id"] = target_id if target_type == "experiment" else ""
    result["reflection_id"] = target_id if target_type == "reflection" else ""
    return result
