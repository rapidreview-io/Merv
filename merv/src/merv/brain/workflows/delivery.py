"""Retry committed effects with stable keys and fenced delivery leases."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ..kernel.events import freeze_json_object
from ..kernel.state.store import BaseStateStore
from ..kernel.utils import iso_after, new_id, now_iso
from .graph import Data


@dataclass(frozen=True, slots=True)
class Delivery:
    id: str
    project_id: str
    instance_id: str
    revision: int
    kind: str
    data: Data
    lease_token: str
    attempts: int
    event_id: int = 0


class Deliveries:
    """Handlers must deduplicate by Delivery.id, including after process failure."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self.store = store

    def claim(self, *, project_id: str | None = None, lease_seconds: int = 60) -> Delivery | None:
        if lease_seconds < 1:
            raise ValueError("delivery lease must be positive")
        with self.store.transaction() as conn:
            scope, parameters = ("", ()) if project_id is None else (" AND project_id = ?", (project_id,))
            row = conn.execute(
                "SELECT * FROM workflow_actions WHERE "
                "((status = 'pending' AND next_attempt_at <= ?) OR (status = 'delivering' AND lease_until <= ?))"
                + scope + " ORDER BY created_at, id LIMIT 1",
                (now_iso(), now_iso(), *parameters),
            ).fetchone()
            if row is None:
                return None
            token = new_id(prefix="wfl")
            row = conn.execute(
                "UPDATE workflow_actions SET status = 'delivering', lease_token = ?, lease_until = ?, "
                "attempts = attempts + 1 WHERE id = ? AND "
                "((status = 'pending' AND next_attempt_at <= ?) OR (status = 'delivering' AND lease_until <= ?)) "
                "RETURNING *",
                (token, iso_after(seconds=lease_seconds), row["id"], now_iso(), now_iso()),
            ).fetchone()
            if row is None:
                return None
            return Delivery(
                id=row["id"], project_id=row["project_id"], instance_id=row["instance_id"],
                revision=int(row["revision"]), kind=row["kind"], data=freeze_json_object(json.loads(row["data_json"])),
                lease_token=token, attempts=int(row["attempts"]),
                event_id=int(row["event_id"] or 0),
            )

    def renew(self, kind: str, *, interval_seconds: int = 30) -> None:
        """Reconcile a renewable support capability while its node still waits."""
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE workflow_actions SET status = 'pending', next_attempt_at = '' "
                "WHERE kind = ? AND status = 'delivered' AND delivered_at <= ? "
                "AND EXISTS (SELECT 1 FROM workflow_instances w WHERE w.id = workflow_actions.instance_id "
                "AND w.revision = workflow_actions.revision AND w.outcome = '')",
                (kind, iso_after(seconds=-interval_seconds)),
            )

    def history(self, *, project_id: str, instance_id: str):
        with self.store.transaction() as conn:
            return [dict(row) for row in conn.execute(
                "SELECT id, revision, kind, status, attempts, last_error, event_id "
                "FROM workflow_actions WHERE project_id = ? AND instance_id = ? ORDER BY created_at, id",
                (project_id, instance_id),
            ).fetchall()]

    def settle(self, delivery: Delivery, *, error: str = "") -> bool:
        with self.store.transaction() as conn:
            row = conn.execute(
                "UPDATE workflow_actions SET status = ?, lease_token = '', lease_until = '', "
                "last_error = ?, next_attempt_at = ?, delivered_at = ? "
                "WHERE id = ? AND status = 'delivering' AND lease_token = ? RETURNING id",
                ("pending" if error else "delivered", error[:2000],
                 iso_after(seconds=min(3600, 2 ** min(delivery.attempts, 12))) if error else "",
                 None if error else now_iso(), delivery.id, delivery.lease_token),
            ).fetchone()
            return row is not None

    def drain(
        self, handlers: Mapping[str, Callable[[Delivery], None]], *,
        project_id: str | None = None, limit: int = 100,
    ) -> dict[str, int]:
        counts = {"delivered": 0, "failed": 0}
        for _ in range(limit):
            delivery = self.claim(project_id=project_id)
            if delivery is None:
                break
            try:
                handlers[delivery.kind](delivery)
            except Exception as exc:
                if self.settle(delivery, error=str(exc) or type(exc).__name__):
                    counts["failed"] += 1
            else:
                if self.settle(delivery):
                    counts["delivered"] += 1
        return counts
