# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Cross-component housekeeping triggered by an operator or scheduler."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Callable, Protocol

class PrunableLedger(Protocol):
    """Bounded retention sweep that reports its own outcome, not just a count."""

    def prune(self, *, now: datetime | None = None) -> dict[str, Any]: ...

class SessionMaintenance(Protocol):
    """Lease sweep owned by the coding-agent session module."""

    def reconcile(self, *, now: datetime | None = None) -> int: ...


SKIPPED_PRUNE: dict[str, Any] = {"deleted": 0, "ok": True, "skipped": True}


def _sweep_failure(exc: Exception) -> dict[str, Any]:
    return {"deleted": 0, "ok": False, "error": str(exc)[:200]}


@dataclass(frozen=True)
class CleanupReport:
    """Counts returned by one idempotent maintenance pass."""

    tool_calls_pruned: dict[str, Any] = field(
        default_factory=lambda: dict(SKIPPED_PRUNE)
    )
    oauth_clients_pruned: dict[str, Any] = field(
        default_factory=lambda: dict(SKIPPED_PRUNE)
    )
    agent_sessions_expired: int = 0
    # Count-reporting sweeps that raised instead: name -> error. A failed
    # sweep must degrade to its report line, never abort the pass — the
    # remaining record and token sweeps always get their turn.
    sweep_errors: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        """Whether every subsystem that reports an outcome reported success."""
        return not self.sweep_errors and all(
            bool(outcome.get("ok"))
            for outcome in (
                self.tool_calls_pruned,
                self.oauth_clients_pruned,
            )
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            # Leading, so an operator reading the cleanup response sees whether
            # anything failed before reading any count.
            "ok": self.ok,
            "tool_calls_pruned": dict(self.tool_calls_pruned),
            "oauth_clients_pruned": dict(self.oauth_clients_pruned),
            "agent_sessions_expired": self.agent_sessions_expired,
            "sweep_errors": dict(self.sweep_errors),
        }


class CleanupService:
    """Run adapter-neutral, clock-injectable housekeeping sweeps."""

    def __init__(
        self,
        *,
        tool_call_ledger: PrunableLedger | None = None,
        oauth_clients: PrunableLedger | None = None,
        agent_sessions: SessionMaintenance | None = None,
    ) -> None:
        self.tool_call_ledger = tool_call_ledger
        self.oauth_clients = oauth_clients
        self.agent_sessions = agent_sessions

    def run_all(self, *, now: datetime | None = None) -> CleanupReport:
        now_dt = now or datetime.now(tz=UTC)
        errors: dict[str, str] = {}

        def counted(name: str, run: Callable[[], int]) -> int:
            # The count-returning sweeps get the same isolation the dict
            # sweeps build in: one DB failure must not cancel other cleanup.
            try:
                return int(run())
            except Exception as exc:  # noqa: BLE001 -- degrade to the report
                errors[name] = str(exc)[:200]
                return 0

        return CleanupReport(
            tool_calls_pruned=self.prune_tool_calls(now=now_dt),
            oauth_clients_pruned=self.prune_oauth_clients(now=now_dt),
            agent_sessions_expired=counted(
                "agent_sessions", lambda: self.reconcile_agent_sessions(now=now_dt)
            ),
            sweep_errors=errors,
        )

    def prune_tool_calls(self, *, now: datetime | None = None) -> dict[str, Any]:
        """Bounded retention sweep over the durable tool-call ledger.

        One call clears the horizon in batches, so an operator pass is not
        rate-limited to a single batch. It is a supplement, not the schedule:
        the ledger's prune also rides the brain's own in-process timer.
        """
        return self._prune(ledger=self.tool_call_ledger, now=now)

    def prune_oauth_clients(self, *, now: datetime | None = None) -> dict[str, Any]:
        """Expire OAuth registrations that never authorized anything."""
        return self._prune(ledger=self.oauth_clients, now=now)

    def reconcile_agent_sessions(self, *, now: datetime | None = None) -> int:
        """Close coding-agent sessions beyond their lease or hard deadline."""
        if self.agent_sessions is None:
            return 0
        return int(self.agent_sessions.reconcile(now=now))

    def _prune(
        self, *, ledger: PrunableLedger | None, now: datetime | None
    ) -> dict[str, Any]:
        """Run one retention sweep and return its own report.

        A failure says ``ok`` False and names the error — it does NOT return
        zero, which would read as a healthy pass that found nothing (OPS-03).
        """
        if ledger is None:
            return dict(SKIPPED_PRUNE)
        try:
            return dict(ledger.prune(now=now))
        except (
            Exception
        ) as exc:  # noqa: BLE001 -- one GC adapter must not abort the pass
            return _sweep_failure(exc)
