# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Per-user per-provider daily-cap enforcement (the budget sweep pass).

Warn at 80%, mark over-budget at the cap, terminate after a grace window.
State transitions are CAS'd so events fire once per change, and everything
recomputes from the ledger each tick — crossing UTC midnight self-heals a
halt without special casing.
"""

from __future__ import annotations

import logging
from contextlib import closing
from datetime import UTC, datetime
from typing import Any

from typing import Protocol

from ..kernel.env import env_float
from ..kernel.state.store import BaseStateStore
from ..kernel.utils import now_iso, parse_iso
from .lifecycle import SandboxLifecycle
from .quotas import QuotaService, _next_utc_midnight, _row_effective_price
from .storage import SandboxStorage

LOGGER = logging.getLogger(__name__)

WARN_RATIO = 0.8
DEFAULT_GRACE_SECONDS = 3600.0


class ProvisionCancel(Protocol):
    """Cancel an in-flight provisioning job (SandboxProvisioner.cancel) so a
    budget-terminated boot aborts cleanly instead of racing its worker."""

    def __call__(self, *, sandbox_uid: str) -> None: ...


class BudgetEnforcer:
    """Owns the maintenance-sweep budget pass; SandboxLifecycle still owns
    every destructive outcome."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        storage: SandboxStorage,
        quotas: QuotaService,
        lifecycle: SandboxLifecycle,
        cancel_provision: ProvisionCancel | None = None,
    ) -> None:
        self.store = store
        self.storage = storage
        self.quotas = quotas
        self.lifecycle = lifecycle
        self.cancel_provision = cancel_provision

    @staticmethod
    def grace_seconds() -> float:
        grace = env_float(
            "MERV_BUDGET_GRACE_SECONDS", None, DEFAULT_GRACE_SECONDS
        )
        return grace if grace >= 0 else DEFAULT_GRACE_SECONDS

    def enforce(self, *, now: datetime | None = None) -> None:
        now_dt = now or datetime.now(tz=UTC)
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in self.storage.list_payer_attributed_rows():
            key = (str(row.get("user_id") or ""), str(row.get("provider") or ""))
            if all(key):
                groups.setdefault(key, []).append(row)
        for (user_id, provider), rows in groups.items():
            try:
                self._enforce_group(
                    user_id=user_id, provider=provider, rows=rows, now=now_dt
                )
            except Exception:  # noqa: BLE001 — one payer never aborts the pass
                LOGGER.exception(
                    "budget enforcement failed for user %s on provider %s",
                    user_id,
                    provider,
                )
                continue

    def _enforce_group(
        self,
        *,
        user_id: str,
        provider: str,
        rows: list[dict[str, Any]],
        now: datetime,
    ) -> None:
        cap = self.store.resolve_provider_user_cap(
            provider=provider, user_id=user_id
        )
        if cap is None:
            # Cap removed while states were set: lift the halt.
            for row in rows:
                self._clear(row=row)
            return
        spent = self.quotas.user_provider_day_spend(
            user_id=user_id, provider=provider, now=now
        )
        # Fail-closed: an active row whose price cannot be established is
        # unbounded unknown billing — treated as an exhausted cap, so it
        # halts acquisition and enters the termination ladder rather than
        # idling at "$0" (plan finding 9). Only the offending rows escalate:
        # admission is already blocked fleet-wide by the inf commitment, and
        # terminating priced under-cap siblings would destroy their work
        # without adding money safety.
        prices = {
            str(row.get("sandbox_uid") or ""): self._row_price(row=row)
            for row in rows
        }
        unpriced_rows = [
            row for row in rows if prices[str(row.get("sandbox_uid") or "")] is None
        ]
        payload_base = {
            "user_id": user_id,
            "provider": provider,
            "spent": spent,
            "limit": cap,
            "resets_at": _next_utc_midnight(now).isoformat(),
            "unpriced": bool(unpriced_rows),
        }
        if spent >= cap:
            for row in rows:
                self._escalate(row=row, now=now, payload=payload_base)
            return
        for row in unpriced_rows:
            self._escalate(row=row, now=now, payload=payload_base)
        priced_rows = [
            row for row in rows if prices[str(row.get("sandbox_uid") or "")] is not None
        ]
        if spent >= WARN_RATIO * cap:
            for row in priced_rows:
                self._warn(row=row, payload=payload_base)
        else:
            for row in priced_rows:
                self._clear(row=row)

    def _row_price(self, *, row: dict[str, Any]) -> float | None:
        quoted = row.get("quoted_price_usd_per_hour")
        if quoted is not None:
            return float(quoted)
        with closing(self.store.connect()) as conn:
            known = conn.execute(
                "SELECT price_known FROM sandbox_generations "
                "WHERE sandbox_uid = ? AND ended_at IS NULL "
                "ORDER BY created_seq DESC LIMIT 1",
                (str(row.get("sandbox_uid") or ""),),
            ).fetchone()
        return _row_effective_price(
            {
                **row,
                "open_price_known": known["price_known"] if known else 0,
            }
        )

    def _emit(self, *, row: dict[str, Any], event_type: str, payload: dict[str, Any]) -> None:
        self.storage.emit_event(
            project_id=str(row.get("project_id") or ""),
            event_type=event_type,
            experiment_id=str(row.get("experiment_id") or ""),
            payload={
                "sandbox_id": str(row.get("sandbox_id") or ""),
                "sandbox_uid": str(row.get("sandbox_uid") or ""),
                **payload,
            },
        )

    def _warn(self, *, row: dict[str, Any], payload: dict[str, Any]) -> None:
        if str(row.get("budget_state") or "") != "":
            return
        if self.storage.transition_budget_state(
            sandbox_uid=str(row.get("sandbox_uid") or ""),
            expected_project_id=str(row.get("project_id") or ""),
            from_states=("",),
            to_state="warned",
        ):
            self._emit(row=row, event_type="sandbox.budget_warning", payload=payload)

    def _clear(self, *, row: dict[str, Any]) -> None:
        if str(row.get("budget_state") or "") == "":
            return
        self.storage.transition_budget_state(
            sandbox_uid=str(row.get("sandbox_uid") or ""),
            expected_project_id=str(row.get("project_id") or ""),
            from_states=("warned", "over_budget"),
            to_state="",
        )

    def _escalate(
        self, *, row: dict[str, Any], now: datetime, payload: dict[str, Any]
    ) -> None:
        state = str(row.get("budget_state") or "")
        if state != "over_budget":
            if self.storage.transition_budget_state(
                sandbox_uid=str(row.get("sandbox_uid") or ""),
                expected_project_id=str(row.get("project_id") or ""),
                from_states=("", "warned"),
                to_state="over_budget",
                over_budget_at=now_iso(),
            ):
                self._emit(
                    row=row,
                    event_type="sandbox.over_budget",
                    payload={
                        **payload,
                        "grace_seconds": self.grace_seconds(),
                    },
                )
            return
        # Already over budget: terminate once the grace window lapses.
        # Reapable: running rows, and provisioning rows whose provider ID is
        # persisted — those are billing at the provider while a long boot
        # (exempt from stale reaping) polls, so grace must reach them too.
        # ID-less provisioning rows have nothing billable yet, and
        # cleanup_pending already sits in the lifecycle retry loop.
        over_since = parse_iso(row.get("over_budget_at"))
        if over_since is None:
            return
        if (now - over_since).total_seconds() < self.grace_seconds():
            return
        fresh = self.storage.get_by_uid(
            sandbox_uid=str(row.get("sandbox_uid") or "")
        )
        status = str(fresh.get("status") or "")
        billable_boot = status == "provisioning" and bool(fresh.get("sandbox_id"))
        if status != "running" and not billable_boot:
            return
        if billable_boot and self.cancel_provision is not None:
            # Stop the worker first so the reap cannot race a publish.
            self.cancel_provision(sandbox_uid=str(fresh.get("sandbox_uid") or ""))
        # Deliberate, owner-requested carve-out from the no-auto-release
        # ruling: budget exhaustion terminates loudly, after grace, through
        # the same observe-then-terminate path as expiry (outputs captured).
        self.lifecycle.reap_row(
            row=fresh,
            event_type="sandbox.budget_terminated",
            payload_extra={**payload, "reason": "budget_exhausted"},
        )
