# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Durable Sandbox rows, attachments, accounting, and atomic transitions.

This module performs no provider or remote I/O.
"""

from __future__ import annotations

from contextlib import closing
import json
import uuid
from typing import Any

from .models import (
    ACTIVE_SANDBOX_STATUSES,
    CLEANUP_PENDING_STATUS,
    TERMINAL_SANDBOX_STATUSES,
    cleanup_attempt_phase,
    cleanup_inflight_phase,
)
from .models import ProvisionedSandbox, SandboxRequest
from .sandbox_paths import DEFAULT_DATA_DIR, remote_experiment_dir
from ..kernel.state.store import BaseStateStore, next_created_seq, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, iso_after, new_id, now_iso


class SandboxStorage:
    def __init__(self, *, store: BaseStateStore) -> None:
        self.store = store

    def _hydrate_row(self, *, row: Any, conn: Any) -> dict[str, Any]:
        rows = self._hydrate_attachments(
            conn=conn,
            rows=[row_to_dict(row=row) or {}],
        )
        return rows[0]

    def _hydrate_attachments(
        self, *, conn: Any, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        uids = [str(row.get("sandbox_uid") or "") for row in rows]
        uids = [uid for uid in uids if uid]
        if not uids:
            return rows
        placeholders = ", ".join("?" for _ in uids)
        attachments = conn.execute(
            f"""
            SELECT sandbox_uid, experiment_id, attached_at, detached_at
            FROM sandbox_attachments
            WHERE sandbox_uid IN ({placeholders})
            ORDER BY attached_at, experiment_id
            """,
            uids,
        ).fetchall()
        active: dict[str, list[str]] = {uid: [] for uid in uids}
        latest: dict[str, str] = {}
        for attachment in attachments:
            uid = str(attachment["sandbox_uid"] or "")
            experiment_id = str(attachment["experiment_id"] or "")
            if not uid or not experiment_id:
                continue
            latest[uid] = experiment_id
            if attachment["detached_at"] is None:
                active.setdefault(uid, []).append(experiment_id)
        for row in rows:
            uid = str(row.get("sandbox_uid") or "")
            row["active_experiment_ids"] = active.get(uid, [])
            if not row.get("experiment_id"):
                row["experiment_id"] = (active.get(uid) or [latest.get(uid, "")])[0]
        return rows

    # ---------- reads ----------

    def load_row(self, *, experiment_id: str) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            sandbox_uid = self._preferred_uid(
                conn=conn, experiment_id=experiment_id
            )
            if sandbox_uid is None:
                raise NotFoundError(f"sandbox not found: {experiment_id}")
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (sandbox_uid,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"sandbox not found: {experiment_id}")
            return self._hydrate_row(row=row, conn=conn)

    def get_by_uid(self, *, sandbox_uid: str) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (sandbox_uid,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"sandbox not found: {sandbox_uid}")
            return self._hydrate_row(row=row, conn=conn)

    def list_for_experiment(
        self,
        *,
        experiment_id: str,
        project_id: str | None = None,
    ) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            values: list[Any] = [experiment_id]
            project_clause = ""
            if project_id is not None:
                project_id = self.store.require_project_id(
                    conn=conn,
                    project_id=project_id,
                )
                project_clause = " AND s.project_id = ?"
                values.append(project_id)
            rows = conn.execute(
                f"""
                SELECT s.*
                FROM sandboxes s
                JOIN sandbox_attachments a ON a.sandbox_uid = s.sandbox_uid
                WHERE a.experiment_id = ?
                  AND a.detached_at IS NULL{project_clause}
                ORDER BY s.created_seq DESC
                """,
                values,
            ).fetchall()
            return self._hydrate_attachments(
                conn=conn,
                rows=[row_to_dict(row=row) or {} for row in rows],
            )

    def active_experiment_ids(
        self, *, sandbox_uid: str, conn: Any | None = None
    ) -> list[str]:
        if conn is None:
            with closing(self.store.connect()) as owned:
                return self.active_experiment_ids(sandbox_uid=sandbox_uid, conn=owned)
        rows = conn.execute(
            """
            SELECT experiment_id
            FROM sandbox_attachments
            WHERE sandbox_uid = ? AND detached_at IS NULL
            ORDER BY attached_at, experiment_id
            """,
            (sandbox_uid,),
        ).fetchall()
        return [str(row["experiment_id"]) for row in rows]

    def tenant_for_project(
        self, *, project_id: str, conn: Any | None = None
    ) -> str:
        if conn is None:
            with closing(self.store.connect()) as owned:
                return self.tenant_for_project(project_id=project_id, conn=owned)
        row = conn.execute(
            "SELECT tenant_id FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        return str(row["tenant_id"]) if row is not None else "local"

    def raw_row_in(
        self, *, conn: Any, sandbox_uid: str
    ) -> dict[str, Any] | None:
        """Unhydrated row read on the caller's transaction — the fresh
        re-read inside extend's cap-lock window."""
        row = conn.execute(
            "SELECT * FROM sandboxes WHERE sandbox_uid = ?",
            (str(sandbox_uid or ""),),
        ).fetchone()
        return row_to_dict(row=row) if row is not None else None

    def fetch_scoped(
        self,
        *,
        experiment_id: str | None,
        project_id: str | None,
        tenant_id: str | None = None,
        sandbox_uid: str | None = None,
    ) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            if project_id is not None or tenant_id is not None:
                project_id = self.store.require_project_id(
                    conn=conn, project_id=project_id, tenant_id=tenant_id
                )
            target_uid = (sandbox_uid or "").strip()
            if target_uid:
                row = conn.execute(
                    "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (target_uid,)
                ).fetchone()
            else:
                if not experiment_id:
                    raise NotFoundError("sandbox_uid or experiment_id is required")
                target_uid = self._preferred_uid(
                    conn=conn, experiment_id=experiment_id
                ) or ""
                row = (
                    conn.execute(
                        "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (target_uid,)
                    ).fetchone()
                    if target_uid
                    else None
                )
            if row is None:
                if target_uid:
                    raise NotFoundError(f"sandbox not found: {target_uid}")
                raise NotFoundError(f"no sandbox for experiment: {experiment_id}")
            if experiment_id:
                attached = conn.execute(
                    """
                    SELECT 1 FROM sandbox_attachments
                    WHERE sandbox_uid = ? AND experiment_id = ? AND detached_at IS NULL
                    LIMIT 1
                    """,
                    (row["sandbox_uid"], experiment_id),
                ).fetchone()
                if attached is None and str(row["status"]) in TERMINAL_SANDBOX_STATUSES:
                    # Going terminal is exactly what closes every attachment,
                    # so a dead box never has an open one — and refusing it here
                    # makes its final receipts unreadable at the one moment they
                    # matter: a caller naming both a terminal sandbox_uid and
                    # its experiment would be told "not found" rather than how
                    # the run ended. Match the HISTORICAL attachment instead of
                    # dropping the check, so the experiment binding still holds.
                    attached = conn.execute(
                        """
                        SELECT 1 FROM sandbox_attachments
                        WHERE sandbox_uid = ? AND experiment_id = ?
                        LIMIT 1
                        """,
                        (row["sandbox_uid"], experiment_id),
                    ).fetchone()
                if attached is None:
                    raise NotFoundError(f"no sandbox for experiment: {experiment_id}")
            if project_id is not None and row["project_id"] != project_id:
                raise NotFoundError(
                    f"sandbox not found in project {project_id}: {experiment_id}"
                )
            return self._hydrate_row(row=row, conn=conn)

    def exists(self, *, experiment_id: str) -> bool:
        with closing(self.store.connect()) as conn:
            return (
                conn.execute(
                    """
                    SELECT 1
                    FROM sandbox_attachments
                    WHERE experiment_id = ? AND detached_at IS NULL
                    """,
                    (experiment_id,),
                ).fetchone()
                is not None
            )

    def list_for_project(self, *, project_id: str | None) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                "SELECT * FROM sandboxes WHERE project_id = ? ORDER BY created_seq DESC",
                (project_id,),
            ).fetchall()
            return self._hydrate_attachments(
                conn=conn,
                rows=[row_to_dict(row=row) or {} for row in rows],
            )

    def list_running_rows(self) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM sandboxes WHERE status = 'running' ORDER BY created_seq DESC"
            ).fetchall()
            return self._hydrate_attachments(
                conn=conn,
                rows=[row_to_dict(row=row) or {} for row in rows],
            )

    def list_rows_by_status(self, *, status: str) -> list[dict[str, Any]]:
        """Cross-project rows for fleet cleanup sweeps."""
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM sandboxes WHERE status = ? ORDER BY created_seq DESC",
                (status,),
            ).fetchall()
            return self._hydrate_attachments(
                conn=conn,
                rows=[row_to_dict(row=row) or {} for row in rows],
            )

    def list_payer_attributed_rows(self) -> list[dict[str, Any]]:
        """Every billable platform-billed row with a payer of record —
        the budget sweep's working set, cross-project by design."""
        statuses = tuple(sorted(("provisioning", "running", "cleanup_pending")))
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT * FROM sandboxes "
                "WHERE user_id != '' AND billing_mode = 'platform' "
                f"AND status IN ({', '.join('?' for _ in statuses)}) "
                "ORDER BY created_seq DESC",
                statuses,
            ).fetchall()
            return self._hydrate_attachments(
                conn=conn,
                rows=[row_to_dict(row=row) or {} for row in rows],
            )

    def transition_budget_state(
        self,
        *,
        sandbox_uid: str,
        expected_project_id: str,
        from_states: tuple[str, ...],
        to_state: str,
        over_budget_at: str | None = None,
    ) -> bool:
        """CAS a row's budget ladder state; True only when this call moved it.

        Transition-only semantics keep the sweep idempotent — events fire
        exactly once per state change, never per tick.
        """
        clause = (
            f" AND budget_state IN ({', '.join('?' for _ in from_states)})"
        )
        with self.store.transaction() as conn:
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=sandbox_uid,
                    assignments=(
                        "budget_state = ?, over_budget_at = ?, updated_at = ?"
                    ),
                    values=[to_state, over_budget_at, now_iso()],
                    expected_project_id=expected_project_id,
                    extra_clause=clause,
                    extra_values=list(from_states),
                )
                == 1
            )

    def _preferred_uid(self, *, conn: Any, experiment_id: str) -> str | None:
        """Prefer a live sandbox, otherwise keep the newest nonterminal one visible."""
        active = tuple(sorted(ACTIVE_SANDBOX_STATUSES))
        terminal = tuple(sorted(TERMINAL_SANDBOX_STATUSES))
        active_slots = ", ".join("?" for _ in active)
        terminal_slots = ", ".join("?" for _ in terminal)
        row = conn.execute(
            f"""
            SELECT s.sandbox_uid
            FROM sandboxes s
            JOIN sandbox_attachments a ON a.sandbox_uid = s.sandbox_uid
            WHERE a.experiment_id = ?
              AND a.detached_at IS NULL
              AND s.status NOT IN ({terminal_slots})
            ORDER BY CASE WHEN s.status IN ({active_slots}) THEN 0 ELSE 1 END,
                     s.created_seq DESC
            LIMIT 1
            """,
            (experiment_id, *terminal, *active),
        ).fetchone()
        return (
            str(row["sandbox_uid"]) if row is not None and row["sandbox_uid"] else None
        )

    def has_active_for_experiment(
        self, *, experiment_id: str, exclude_sandbox_uid: str | None = None
    ) -> bool:
        """Include parked siblings that a broad orphan lookup could destroy."""
        statuses = tuple(
            {*ACTIVE_SANDBOX_STATUSES, "provisioning", CLEANUP_PENDING_STATUS}
        )
        if not statuses:
            return False
        placeholders = ", ".join("?" for _ in statuses)
        params: list[Any] = [experiment_id, *statuses]
        clause = ""
        exclude = (exclude_sandbox_uid or "").strip()
        if exclude:
            clause = "AND sandboxes.sandbox_uid != ?"
            params.append(exclude)
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                f"""
                SELECT 1 FROM sandboxes
                JOIN sandbox_attachments a ON a.sandbox_uid = sandboxes.sandbox_uid
                WHERE a.experiment_id = ?
                  AND a.detached_at IS NULL
                  AND sandboxes.status IN ({placeholders}) {clause}
                LIMIT 1
                """,
                params,
            ).fetchone()
            return row is not None

    def active_reservation(
        self, *, conn: Any, experiment_id: str
    ) -> dict[str, Any] | None:
        """Read inside the serialized write transaction used for reservation.

        SQLite uses ``BEGIN IMMEDIATE``; Postgres uses an advisory lock.
        """
        if not experiment_id:
            return None
        row = conn.execute(
            """
            SELECT s.*, a.experiment_id
            FROM sandboxes s
            JOIN sandbox_attachments a ON a.sandbox_uid = s.sandbox_uid
            WHERE a.experiment_id = ?
              AND a.detached_at IS NULL
              AND s.status IN ('provisioning', 'running')
            ORDER BY s.created_seq DESC
            LIMIT 1
            """,
            (experiment_id,),
        ).fetchone()
        return self._hydrate_row(row=row, conn=conn) if row is not None else None

    # ---------- writes ----------

    def new_sandbox_uid(self) -> str:
        return uuid.uuid4().hex

    def _guarded_update(
        self,
        *,
        conn: Any,
        sandbox_uid: str,
        assignments: str,
        values: list[Any],
        expected_project_id: str,
        extra_clause: str = "",
        extra_values: list[Any] | None = None,
    ) -> int:
        """Bind a UID update to its project owner and return the rowcount."""
        row = conn.execute(
            "SELECT project_id FROM sandboxes WHERE sandbox_uid = ?", (sandbox_uid,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"sandbox not found: {sandbox_uid}")
        owner_clause, owner_values = _owner_guard(
            row=row, expected_project_id=expected_project_id, uid=sandbox_uid
        )
        cursor = conn.execute(
            f"UPDATE sandboxes SET {assignments} "
            f"WHERE sandbox_uid = ?{owner_clause}{extra_clause}",
            [*values, sandbox_uid, *owner_values, *(extra_values or [])],
        )
        return int(getattr(cursor, "rowcount", 0))

    def _upsert(
        self,
        *,
        conn: Any,
        experiment_id: str,
        sandbox_uid: str,
        expected_project_id: str = "",
        **fields: Any,
    ) -> None:
        now = now_iso()
        expected = str(expected_project_id or "").strip()
        target_uid = str(sandbox_uid or "").strip()
        if not target_uid:
            raise ValueError("sandbox_uid is required")
        exists = conn.execute(
            "SELECT sandbox_uid, project_id, tenant_id FROM sandboxes "
            "WHERE sandbox_uid = ?",
            (target_uid,),
        ).fetchone()
        payload = dict(fields)
        payload.pop("experiment_id", None)
        if expected:
            incoming = str(payload.get("project_id") or "")
            if incoming and incoming != expected:
                raise ValidationError(
                    f"sandbox {target_uid}: expected project {expected} does "
                    f"not match the project being written ({incoming})",
                    details={"sandbox_uid": target_uid, "field": "project_id"},
                )
            payload.setdefault("project_id", expected)
        if payload.get("project_id") and not payload.get("tenant_id"):
            tenant_row = conn.execute(
                "SELECT tenant_id FROM projects WHERE id = ?",
                (payload["project_id"],),
            ).fetchone()
            payload["tenant_id"] = (
                str(tenant_row["tenant_id"]) if tenant_row is not None else "local"
            )
        payload["updated_at"] = now
        if exists is None:
            payload["sandbox_uid"] = target_uid
            payload.setdefault("created_at", now)
            payload["created_seq"] = next_created_seq(conn=conn, table="sandboxes")
            columns = ", ".join(payload)
            placeholders = ", ".join("?" for _ in payload)
            conn.execute(
                f"INSERT INTO sandboxes ({columns}) VALUES ({placeholders})",
                list(payload.values()),
            )
            self._ensure_attachment(
                conn=conn,
                sandbox_uid=str(payload["sandbox_uid"]),
                experiment_id=experiment_id,
                attached_at=str(payload["created_at"]),
            )
            return
        row_uid = str(exists["sandbox_uid"] or target_uid)
        owner_clause, owner_values = _owner_guard(
            row=exists, expected_project_id=expected, uid=row_uid
        )
        _reject_ownership_change(row=exists, payload=payload, uid=row_uid)
        assignments = ", ".join(f"{key} = ?" for key in payload)
        cursor = conn.execute(
            f"UPDATE sandboxes SET {assignments} "
            f"WHERE sandbox_uid = ?{owner_clause}",
            [*payload.values(), row_uid, *owner_values],
        )
        if int(getattr(cursor, "rowcount", 0)) != 1:
            raise NotFoundError(f"sandbox not found: {row_uid}")
        if row_uid and str(payload.get("status") or "") not in {
            "",
            "terminated",
            "failed",
        }:
            self._ensure_attachment(
                conn=conn,
                sandbox_uid=row_uid,
                experiment_id=experiment_id,
                attached_at=now,
            )

    def attach(
        self,
        *,
        sandbox_uid: str,
        experiment_id: str,
        project_id: str,
    ) -> dict[str, Any]:
        """Attach only within the sandbox's existing project ownership."""
        now = now_iso()
        with self.store.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (sandbox_uid,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"sandbox not found: {sandbox_uid}")
            owner_clause, owner_values = _owner_guard(
                row=row, expected_project_id=project_id, uid=sandbox_uid
            )
            cursor = conn.execute(
                f"""
                UPDATE sandboxes
                SET updated_at = ?
                WHERE sandbox_uid = ?{owner_clause} AND status = 'running'
                """,
                (now, sandbox_uid, *owner_values),
            )
            if int(getattr(cursor, "rowcount", 0)) != 1:
                raise ValidationError("sandbox.attach requires a running sandbox")
            self._ensure_attachment(
                conn=conn,
                sandbox_uid=sandbox_uid,
                experiment_id=experiment_id,
                attached_at=now,
            )
            fresh = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (sandbox_uid,)
            ).fetchone()
            return self._hydrate_row(row=fresh, conn=conn)

    def reserve_provisioning(
        self,
        *,
        conn: Any,
        experiment_id: str,
        project_id: str,
        request: SandboxRequest,
        provider: str,
        quoted_price: float | None = None,
    ) -> None:
        """Write the complete durable reservation shape in the caller's transaction."""
        now = now_iso()
        workdir = request.remote_workdir or remote_experiment_dir(
            experiment_id=experiment_id
        )
        self._upsert(
            conn=conn,
            experiment_id=experiment_id,
            sandbox_uid=request.sandbox_uid,
            expected_project_id=project_id,
            project_id=project_id,
            status="provisioning",
            phase="starting",
            detail="",
            error="",
            sandbox_id="",
            sandbox_name="",
            ssh_host="",
            ssh_port=0,
            ssh_user="root",
            workdir=workdir,
            sync_dir=workdir,
            unsynced_dir=DEFAULT_DATA_DIR,
            mgmt_key_ref=request.sandbox_uid if request.management_public_key else "",
            public_key_source=request.public_key_source,
            gpu=request.gpu or "",
            cpu=request.cpu,
            memory=request.memory,
            provider=provider,
            instance_type=request.instance_type or "",
            region=request.region or "",
            time_limit=request.time_limit,
            # Payer of record + admitted tri-state quote (migration 44): every
            # reservation is attributable and priceable from birth, so the
            # commitment scan can see it before any generation exists.
            user_id=request.user_id,
            billing_mode=request.billing_mode,
            quoted_price_usd_per_hour=quoted_price,
            budget_state="",
            over_budget_at=None,
            requested_at=now,
            provision_started_at=now,
            expires_at="",
            last_seen_at=now,
            terminated_at="",
        )

    def complete_provision(
        self,
        *,
        experiment_id: str,
        sandbox_uid: str,
        project_id: str,
        provisioned: ProvisionedSandbox,
        request: SandboxRequest,
        provider: str,
    ) -> str | None:
        """Publish availability and its billable generation atomically."""
        now = now_iso()
        instance_type = provisioned.instance_type or (request.instance_type or "")
        gpu = provisioned.gpu or (request.gpu or "")
        payload = {
            "status": "running",
            "sandbox_id": provisioned.sandbox_id,
            "provider": provider,
            "gpu": gpu,
            "cpu": provisioned.cpu if provisioned.cpu is not None else request.cpu,
            "memory": (
                provisioned.memory
                if provisioned.memory is not None
                else int(request.memory)
            ),
            "instance_type": instance_type,
            "region": provisioned.region or (request.region or ""),
            # The legacy column is a NOT NULL floor; the nullable quoted
            # column preserves unknown (None) so it never reads as $0.
            # Both are finalized inside the transaction, where an adapter
            # that lost its quote falls back to the admission-stamped one.
            "price_usd_per_hour": 0.0,
            "quoted_price_usd_per_hour": None,
            "ssh_host": provisioned.ssh_host,
            "ssh_port": provisioned.ssh_port,
            "ssh_user": provisioned.ssh_user,
            "workdir": provisioned.workdir,
            "sync_dir": provisioned.sync_dir or provisioned.workdir,
            "unsynced_dir": provisioned.unsynced_dir or provisioned.sandbox_data_dir,
            "sandbox_data_dir": provisioned.sandbox_data_dir,
            "volume_name": provisioned.volume_name,
            "expires_at": iso_after(seconds=request.time_limit),
            "last_seen_at": now,
            "phase": "",
            "detail": "",
            "error": "",
            "terminated_at": "",
            "updated_at": now,
        }
        generation_id = new_id(prefix="sbg")
        with self.store.transaction() as conn:
            effective_price = provisioned.price_usd_per_hour
            if effective_price is None:
                # Adapter lost its quote at provision time: keep the
                # admission-validated stamp rather than degrading a priced
                # reservation to NULL (which would halt the payer's fleet).
                stamped = conn.execute(
                    "SELECT quoted_price_usd_per_hour FROM sandboxes "
                    "WHERE sandbox_uid = ?",
                    (sandbox_uid,),
                ).fetchone()
                if (
                    stamped is not None
                    and stamped["quoted_price_usd_per_hour"] is not None
                ):
                    effective_price = float(stamped["quoted_price_usd_per_hour"])
            payload["price_usd_per_hour"] = float(effective_price or 0.0)
            payload["quoted_price_usd_per_hour"] = effective_price
            assignments = ", ".join(f"{column} = ?" for column in payload)
            updated = self._guarded_update(
                conn=conn,
                sandbox_uid=sandbox_uid,
                assignments=assignments,
                values=list(payload.values()),
                expected_project_id=project_id,
                extra_clause=" AND status = 'provisioning'",
            )
            if updated != 1:
                return None
            self._ensure_attachment(
                conn=conn,
                sandbox_uid=sandbox_uid,
                experiment_id=experiment_id,
                attached_at=now,
            )
            tenant_row = conn.execute(
                "SELECT tenant_id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            tenant_id = (
                str(tenant_row["tenant_id"]) if tenant_row is not None else "local"
            )
            # price_known = (final price is not None): an allowed unknown-price
            # completion stores the floor 0 with price_known=0, distinguishable
            # from genuine $0 and still subject to the exhausted sentinel.
            price = float(effective_price or 0.0)
            price_known = 1 if effective_price is not None else 0
            open_gen = conn.execute(
                "SELECT id FROM sandbox_generations "
                "WHERE sandbox_uid = ? AND ended_at IS NULL "
                "ORDER BY created_seq DESC LIMIT 1",
                (sandbox_uid,),
            ).fetchone()
            if open_gen is not None:
                # record_created already opened the ledger row at instance
                # creation; completion finalizes specs and price atomically
                # with publishing running.
                generation_id = str(open_gen["id"])
                conn.execute(
                    "UPDATE sandbox_generations "
                    "SET sandbox_id = ?, instance_type = ?, gpu = ?, "
                    "    price_usd_per_hour = ?, price_known = ? "
                    "WHERE id = ?",
                    (
                        provisioned.sandbox_id,
                        instance_type,
                        gpu,
                        price,
                        price_known,
                        generation_id,
                    ),
                )
            else:
                # Adapter without the on_created hook: open at completion, the
                # pre-migration behavior plus payer attribution.
                conn.execute(
                    """
                    INSERT INTO sandbox_generations (
                      id, experiment_id, project_id, tenant_id, sandbox_id,
                      provider, instance_type, gpu, price_usd_per_hour,
                      price_known, key_id, user_id, billing_mode, sandbox_uid,
                      started_at, created_seq
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        generation_id,
                        experiment_id,
                        project_id,
                        tenant_id,
                        provisioned.sandbox_id,
                        provider,
                        instance_type,
                        gpu,
                        price,
                        price_known,
                        request.key_id or None,
                        request.user_id,
                        request.billing_mode,
                        sandbox_uid,
                        now,
                        next_created_seq(conn=conn, table="sandbox_generations"),
                    ),
                )
        return generation_id

    def record_created(
        self,
        *,
        sandbox_uid: str,
        expected_project_id: str,
        experiment_id: str,
        sandbox_id: str,
        sandbox_name: str,
        request: SandboxRequest,
        provider: str,
    ) -> bool:
        """Atomically persist the provider ID and open the billable generation.

        One transaction, fence first: the provider-ID write is the same
        status='provisioning' + owner guarded update set_provision uses, and
        the generation is inserted only after it lands — a release/reaper
        that already made the row terminal gets False (the worker raises
        _Canceled and the adapter terminates the fresh resource). Accrual
        therefore starts when the billable resource starts, boot included.
        """
        now = now_iso()
        with self.store.transaction() as conn:
            updated = self._guarded_update(
                conn=conn,
                sandbox_uid=sandbox_uid,
                assignments="sandbox_id = ?, sandbox_name = ?, updated_at = ?",
                values=[sandbox_id, sandbox_name, now],
                expected_project_id=expected_project_id,
                extra_clause=" AND status = 'provisioning'",
            )
            if updated != 1:
                return False
            row = conn.execute(
                "SELECT project_id, tenant_id, quoted_price_usd_per_hour "
                "FROM sandboxes WHERE sandbox_uid = ?",
                (sandbox_uid,),
            ).fetchone()
            quoted = row["quoted_price_usd_per_hour"] if row is not None else None
            tenant_id = str(row["tenant_id"] or "local") if row is not None else "local"
            conn.execute(
                """
                INSERT INTO sandbox_generations (
                  id, experiment_id, project_id, tenant_id, sandbox_id,
                  provider, instance_type, gpu, price_usd_per_hour,
                  price_known, key_id, user_id, billing_mode, sandbox_uid,
                  started_at, created_seq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id(prefix="sbg"),
                    experiment_id,
                    expected_project_id,
                    tenant_id,
                    sandbox_id,
                    provider,
                    request.instance_type or "",
                    request.gpu or "",
                    float(quoted or 0.0),
                    1 if quoted is not None else 0,
                    request.key_id or None,
                    request.user_id,
                    request.billing_mode,
                    sandbox_uid,
                    now,
                    next_created_seq(conn=conn, table="sandbox_generations"),
                ),
            )
        return True

    def stamp_quoted_price(
        self,
        *,
        conn: Any,
        sandbox_uid: str,
        expected_project_id: str,
        price: float | None,
    ) -> bool:
        """Record the validated pre-launch quote inside the caller's
        transaction (the on_quote cap-lock), still provisioning-fenced."""
        return (
            self._guarded_update(
                conn=conn,
                sandbox_uid=sandbox_uid,
                assignments="quoted_price_usd_per_hour = ?, updated_at = ?",
                values=[price, now_iso()],
                expected_project_id=expected_project_id,
                extra_clause=" AND status = 'provisioning'",
            )
            == 1
        )

    def update_provisioning(
        self,
        *,
        sandbox_uid: str,
        expected_project_id: str,
        fields: dict[str, Any],
    ) -> bool:
        """Publish progress only while the row remains provisioning."""
        if not fields:
            return True
        payload = {**fields, "updated_at": now_iso()}
        with self.store.transaction() as conn:
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=sandbox_uid,
                    assignments=", ".join(f"{column} = ?" for column in payload),
                    values=list(payload.values()),
                    expected_project_id=expected_project_id,
                    extra_clause=" AND status = 'provisioning'",
                )
                == 1
            )

    def touch_alive(
        self, *, sandbox_uid: str, expected_project_id: str
    ) -> bool:
        now = now_iso()
        with self.store.transaction() as conn:
            target_uid = str(sandbox_uid or "").strip()
            if not target_uid:
                return False
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=target_uid,
                    assignments="last_seen_at = ?, updated_at = ?",
                    values=[now, now],
                    expected_project_id=expected_project_id,
                    extra_clause=" AND status = 'running'",
                )
                == 1
            )

    def update_endpoint(
        self,
        *,
        sandbox_uid: str,
        ssh_host: str,
        ssh_port: int,
        expected_project_id: str,
    ) -> dict[str, Any] | None:
        """Publish a refreshed endpoint only while the sandbox is running."""
        now = now_iso()
        with self.store.transaction() as conn:
            updated = self._guarded_update(
                conn=conn,
                sandbox_uid=sandbox_uid,
                assignments="ssh_host = ?, ssh_port = ?, updated_at = ?",
                values=[ssh_host, int(ssh_port), now],
                expected_project_id=expected_project_id,
                extra_clause=" AND status = 'running'",
            )
            if updated != 1:
                return None
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?",
                (sandbox_uid,),
            ).fetchone()
            return self._hydrate_row(row=row, conn=conn)

    def extend_lifetime(
        self,
        *,
        sandbox_uid: str,
        expires_at: str,
        time_limit: int,
        expected_project_id: str,
        conn: Any | None = None,
    ) -> dict[str, Any]:
        """``conn`` lets the caller hold one transaction across the cap-row
        lock, the quota recompute, and this guarded update (sandbox.extend)."""
        if conn is None:
            with self.store.transaction() as owned:
                return self.extend_lifetime(
                    sandbox_uid=sandbox_uid,
                    expires_at=expires_at,
                    time_limit=time_limit,
                    expected_project_id=expected_project_id,
                    conn=owned,
                )
        now = now_iso()
        target_uid = str(sandbox_uid or "").strip()
        if not target_uid:
            raise NotFoundError("sandbox not found")
        # Status-guarded: extending a row the reaper just terminated would
        # resurrect a fresh expires_at onto a dead sandbox.
        self._guarded_update(
            conn=conn,
            sandbox_uid=target_uid,
            assignments="expires_at = ?, time_limit = ?, updated_at = ?",
            values=[expires_at, int(time_limit), now],
            expected_project_id=expected_project_id,
            extra_clause=" AND status = 'running'",
        )
        row = conn.execute(
            "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (target_uid,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"sandbox not found: {target_uid}")
        if str(row["status"]) != "running":
            raise ValidationError(
                f"sandbox {target_uid} is {row['status']}; only a running "
                "sandbox can be extended"
            )
        return self._hydrate_row(row=row, conn=conn)

    def stamp_runs_observed(
        self,
        *,
        sandbox_uid: str,
        expected_project_id: str,
        expected_phase: str = "",
    ) -> None:
        """Fence the final receipt stamp that distinguishes ``lost`` from unknown."""
        target_uid = str(sandbox_uid or "").strip()
        if not target_uid:
            return
        with self.store.transaction() as conn:
            self._guarded_update(
                conn=conn,
                sandbox_uid=target_uid,
                assignments="runs_final_observed_at = ?",
                values=[now_iso()],
                expected_project_id=expected_project_id,
                extra_clause=" AND phase = ?" if expected_phase else "",
                extra_values=[expected_phase] if expected_phase else None,
            )

    def heartbeat_snapshot(self, *, row: dict[str, Any]) -> dict[str, Any] | None:
        try:
            data = json.loads(str(row.get("heartbeat_snapshot_json") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def record_heartbeat(
        self,
        *,
        sandbox_uid: str,
        idle_since: str | None,
        snapshot: dict[str, Any],
        expected_project_id: str,
    ) -> bool:
        now = now_iso()
        with self.store.transaction() as conn:
            target_uid = str(sandbox_uid or "").strip()
            if not target_uid:
                return False
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=target_uid,
                    assignments=(
                        "idle_since = ?, heartbeat_snapshot_json = ?, updated_at = ?"
                    ),
                    values=[idle_since, json.dumps(snapshot, sort_keys=True), now],
                    expected_project_id=expected_project_id,
                    extra_clause=" AND status = 'running'",
                )
                == 1
            )

    def command_snapshot(self, *, row: dict[str, Any]) -> dict[str, Any] | None:
        command_id = str(row.get("last_command_id") or "")
        command_status = str(row.get("last_command_status") or "")
        if not command_id and not command_status:
            return None
        exit_code_raw = row.get("last_command_exit_code")
        exit_code = int(exit_code_raw) if exit_code_raw is not None else None
        return {
            "command_id": command_id or None,
            "command": str(row.get("last_command_text") or ""),
            "started_at": row.get("last_command_started_at"),
            "status": command_status or "unknown",
            "exit_code": exit_code,
            "finished_at": row.get("last_command_finished_at"),
            "output_tail": str(row.get("last_command_output_tail") or ""),
            "snapshot_at": row.get("last_command_snapshot_at"),
        }

    def record_command_snapshot(
        self, *, sandbox_uid: str, snapshot: dict[str, Any], expected_project_id: str
    ) -> dict[str, Any]:
        now = now_iso()
        command_id = str(snapshot.get("command_id") or "")
        with self.store.transaction() as conn:
            target_uid = str(sandbox_uid or "").strip()
            if not target_uid:
                return {**snapshot, "snapshot_at": now}
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (target_uid,)
            ).fetchone()
            if row is not None:
                # Even read-back shortcuts must enforce project ownership.
                _owner_guard(
                    row=row,
                    expected_project_id=expected_project_id,
                    uid=target_uid,
                )
            existing = (
                self.command_snapshot(row=row_to_dict(row=row) or {})
                if row is not None
                else None
            )
            if existing is not None:
                # An older transcript must not regress a finished/newer command.
                unchanged = all(
                    existing.get(key) == snapshot.get(key)
                    for key in (
                        "command_id",
                        "command",
                        "started_at",
                        "status",
                        "exit_code",
                        "finished_at",
                        "output_tail",
                    )
                )
                existing_id = str(existing.get("command_id") or "")
                same_command_regressed = (
                    existing_id == command_id
                    and bool(existing.get("finished_at"))
                    and not snapshot.get("finished_at")
                )
                older_command = (
                    existing_id != command_id
                    and bool(existing.get("started_at"))
                    and bool(snapshot.get("started_at"))
                    and str(snapshot["started_at"]) < str(existing["started_at"])
                )
                if unchanged or same_command_regressed or older_command:
                    return existing
            self._guarded_update(
                conn=conn,
                sandbox_uid=target_uid,
                assignments=(
                    "last_command_id = ?, "
                    "last_command_text = ?, "
                    "last_command_started_at = ?, "
                    "last_command_status = ?, "
                    "last_command_exit_code = ?, "
                    "last_command_finished_at = ?, "
                    "last_command_output_tail = ?, "
                    "last_command_snapshot_at = ?"
                ),
                values=[
                    command_id,
                    str(snapshot.get("command") or ""),
                    snapshot.get("started_at"),
                    str(snapshot.get("status") or "unknown"),
                    snapshot.get("exit_code"),
                    snapshot.get("finished_at"),
                    str(snapshot.get("output_tail") or ""),
                    now,
                ],
                expected_project_id=expected_project_id,
            )
        return {**snapshot, "snapshot_at": now}

    def mark_terminated(
        self,
        *,
        experiment_id: str,
        sandbox_uid: str,
        expected_project_id: str,
        expected_phase: str | None = None,
    ) -> dict[str, Any]:
        return self._mark_terminal(
            experiment_id=experiment_id,
            sandbox_uid=sandbox_uid,
            status="terminated",
            expected_project_id=expected_project_id,
            expected_phase=expected_phase,
        )

    def mark_failed(
        self,
        *,
        experiment_id: str,
        error: str,
        sandbox_uid: str,
        expected_project_id: str,
        expected_phase: str | None = None,
    ) -> dict[str, Any]:
        return self._mark_terminal(
            experiment_id=experiment_id,
            sandbox_uid=sandbox_uid,
            status="failed",
            error=error,
            expected_project_id=expected_project_id,
            expected_phase=expected_phase,
        )

    def mark_cleanup_pending(
        self,
        *,
        sandbox_uid: str,
        detail: str,
        expected_project_id: str,
        attempts: int = 1,
        error: str | None = None,
        expected_phase: str | None = None,
    ) -> bool:
        """Park unconfirmed deletion without closing attachments or spend.

        Status and phase CAS prevent a stale worker from resurrecting a
        terminal row or overwriting a reclaimed attempt.
        """
        target_uid = str(sandbox_uid or "").strip()
        if not target_uid:
            return False
        now = now_iso()
        assignments = ["status = ?", "phase = ?", "detail = ?", "updated_at = ?"]
        values: list[Any] = [
            CLEANUP_PENDING_STATUS,
            cleanup_attempt_phase(attempts=attempts),
            detail,
            now,
        ]
        if error is not None:
            assignments.append("error = ?")
            values.append(error)
        terminal = tuple(sorted(TERMINAL_SANDBOX_STATUSES))
        extra_clause = (
            " AND status NOT IN ("
            + ", ".join(f"'{status}'" for status in terminal)
            + ")"
        )
        extra_values: list[Any] = []
        if expected_phase is not None:
            extra_clause += " AND phase = ?"
            extra_values.append(expected_phase)
        with self.store.transaction() as conn:
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=target_uid,
                    assignments=", ".join(assignments),
                    values=values,
                    expected_project_id=expected_project_id,
                    extra_clause=extra_clause,
                    extra_values=extra_values,
                )
                == 1
            )

    def claim_cleanup_attempt(
        self,
        *,
        sandbox_uid: str,
        phase: str,
        attempts: int,
        expected_project_id: str,
        claimed_at: str,
        token: str,
        expected_status: str = CLEANUP_PENDING_STATUS,
        expected_updated_at: str | None = None,
        due_before: str | None = None,
        stale_before: str | None = None,
    ) -> bool:
        """Claim one destructive attempt by status, phase, and time CAS.

        The in-flight token fences late writers. ``due_before`` enforces retry
        backoff; ``stale_before`` permits safe reclamation after the hard
        deadline.
        """
        target_uid = str(sandbox_uid or "").strip()
        if not target_uid:
            return False
        extra_clause = " AND status = ? AND phase = ?"
        extra_values: list[Any] = [str(expected_status or ""), str(phase or "")]
        if expected_updated_at is not None:
            extra_clause += " AND updated_at = ?"
            extra_values.append(expected_updated_at)
        # An unstamped row has no remaining backoff window.
        cutoff = stale_before if stale_before is not None else due_before
        if cutoff is not None:
            extra_clause += " AND (updated_at IS NULL OR updated_at <= ?)"
            extra_values.append(cutoff)
        with self.store.transaction() as conn:
            return (
                self._guarded_update(
                    conn=conn,
                    sandbox_uid=target_uid,
                    assignments="status = ?, phase = ?, updated_at = ?",
                    values=[
                        CLEANUP_PENDING_STATUS,
                        cleanup_inflight_phase(attempts=int(attempts) + 1, token=token),
                        claimed_at or now_iso(),
                    ],
                    expected_project_id=expected_project_id,
                    extra_clause=extra_clause,
                    extra_values=extra_values,
                )
                == 1
            )

    def _mark_terminal(
        self,
        *,
        experiment_id: str,
        sandbox_uid: str,
        status: str,
        expected_project_id: str,
        error: str | None = None,
        expected_phase: str | None = None,
    ) -> dict[str, Any]:
        """Atomically close a row, attachments, and spend generation.

        ``expected_phase`` makes a reclaimed worker settle nothing.
        """
        now = now_iso()
        landed = True
        with self.store.transaction() as conn:
            target_uid = str(sandbox_uid or "").strip()
            row = (
                conn.execute(
                    "SELECT sandbox_id, sandbox_uid, project_id, provider "
                    "FROM sandboxes "
                    "WHERE sandbox_uid = ?",
                    (target_uid,),
                ).fetchone()
                if target_uid
                else None
            )
            sandbox_id = str(row["sandbox_id"] or "") if row is not None else None
            provider = str(row["provider"] or "") if row is not None else ""
            row_uid = str(row["sandbox_uid"] or "") if row is not None else target_uid
            if row is not None:
                # A bare UID never authorizes another project's terminal write.
                owner_clause, owner_values = _owner_guard(
                    row=row, expected_project_id=expected_project_id, uid=row_uid
                )
            else:
                owner_clause, owner_values = "", []
            phase_clause = " AND phase = ?" if expected_phase is not None else ""
            phase_values = [expected_phase] if expected_phase is not None else []
            if error is None:
                cursor = conn.execute(
                    f"""
                    UPDATE sandboxes
                    SET status = ?, phase = '', terminated_at = ?, updated_at = ?
                    WHERE sandbox_uid = ?{owner_clause}{phase_clause}
                    """,
                    (status, now, now, row_uid, *owner_values, *phase_values),
                )
            else:
                cursor = conn.execute(
                    f"""
                    UPDATE sandboxes
                    SET status = ?, error = ?, phase = '', detail = '',
                        terminated_at = ?, updated_at = ?
                    WHERE sandbox_uid = ?{owner_clause}{phase_clause}
                    """,
                    (status, error, now, now, row_uid, *owner_values, *phase_values),
                )
            # Preserve legacy no-op behavior only for unfenced marks.
            if expected_phase is not None:
                landed = int(getattr(cursor, "rowcount", 0)) == 1
            if row is not None and landed:
                conn.execute(
                    """
                    UPDATE sandbox_attachments
                    SET detached_at = ?
                    WHERE sandbox_uid = ? AND detached_at IS NULL
                    """,
                    (now, row_uid),
                )
                if row_uid:
                    # Migration-44 rows link durably by sandbox_uid — this
                    # closes generations opened at instance creation even
                    # when the terminal path never learned a native ID.
                    conn.execute(
                        "UPDATE sandbox_generations SET ended_at = ? "
                        "WHERE sandbox_uid = ? AND ended_at IS NULL",
                        (now, row_uid),
                    )
                if sandbox_id:
                    # Native IDs can collide across providers.
                    conn.execute(
                        "UPDATE sandbox_generations SET ended_at = ? "
                        "WHERE sandbox_id = ? AND provider = ? "
                        "AND ended_at IS NULL",
                        (now, sandbox_id, provider),
                    )
                elif not row_uid:
                    conn.execute(
                        "UPDATE sandbox_generations SET ended_at = ? "
                        "WHERE experiment_id = ? AND ended_at IS NULL",
                        (now, experiment_id),
                    )
        # sandbox_id is "" when the row never recorded one, None when the row
        # itself does not exist (the update still ran).
        return {"sandbox_id": sandbox_id, "sandbox_uid": row_uid, "landed": landed}

    def emit_event(
        self,
        *,
        project_id: str,
        event_type: str,
        experiment_id: str,
        payload: dict[str, Any],
    ) -> None:
        with self.store.transaction() as conn:
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type=event_type,
                target_type="sandbox",
                target_id=experiment_id or str(payload.get("sandbox_uid") or ""),
                payload=payload,
            )

    # ---------- terminal hook plumbing ----------

    def _ensure_attachment(
        self,
        *,
        conn: Any,
        sandbox_uid: str,
        experiment_id: str,
        attached_at: str,
    ) -> None:
        if not sandbox_uid or not experiment_id:
            return
        conn.execute(
            """
            INSERT INTO sandbox_attachments (
              sandbox_uid, experiment_id, attached_at, detached_at
            )
            SELECT ?, ?, ?, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM sandbox_attachments
              WHERE sandbox_uid = ? AND experiment_id = ? AND detached_at IS NULL
            )
            """,
            (sandbox_uid, experiment_id, attached_at, sandbox_uid, experiment_id),
        )

def _owner_guard(
    *, row: Any, expected_project_id: str, uid: str
) -> tuple[str, list[Any]]:
    """Bind UID writes to the expected or stored project owner."""
    owner = str(row["project_id"] or "")
    expected = str(expected_project_id or "").strip()
    if expected and owner and expected != owner:
        raise NotFoundError(
            f"sandbox not found in project {expected}: {uid}",
            details={"sandbox_uid": uid, "project_id": expected},
        )
    guard = expected or owner
    return (" AND project_id = ?", [guard]) if guard else ("", [])


def _reject_ownership_change(*, row: Any, payload: dict[str, Any], uid: str) -> None:
    """Keep project and tenant ownership immutable after insert."""
    for column in ("project_id", "tenant_id"):
        stored = str(row[column] or "")
        incoming = str(payload.get(column) or "")
        if incoming and stored and incoming != stored:
            raise ValidationError(
                f"sandbox {uid} belongs to another {column[:-3]}; sandbox "
                "ownership is immutable — call sandbox.request for a new one "
                "instead of rebinding this row",
                details={"sandbox_uid": uid, "field": column},
            )


__all__ = ["SandboxStorage"]
