"""One clock for every retention sweep in the process.

Each owner registers its own bounded ``prune`` and this runs them all on one
daemon timer, in isolation: a sweep that raises is reported through
``on_error`` and the others still run. No owner needs a thread of its own or a
write path to ride, and this knows nothing about what any of them delete.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import suppress
from typing import Protocol

# Never during start-up, then once an hour for the life of the process.
PRUNE_INITIAL_DELAY_SECONDS = 30.0
PRUNE_INTERVAL_SECONDS = 3600.0
# A sweep deletes in batches, each its own short transaction, so it never holds
# the store's single write lock across a backlog; a pass gives up after this
# many and the next tick carries on.
RETENTION_BATCH_ROWS = 5_000
RETENTION_MAX_BATCHES = 20


def drain(batch: Callable[[], int]) -> int:
    """Run one bounded deletion until it removes nothing or the pass is spent."""
    total = 0
    for _ in range(RETENTION_MAX_BATCHES):
        removed = batch()
        total += removed
        if removed == 0:
            break
    return total


class SweepFailureSink(Protocol):
    """Told which sweep raised, so no failure is ever silent."""

    def __call__(self, name: str, error: BaseException) -> None: ...


class Retention:
    """Run every registered sweep, every interval, on one daemon thread."""

    def __init__(
        self,
        *,
        on_error: SweepFailureSink | None = None,
        initial_delay: float = PRUNE_INITIAL_DELAY_SECONDS,
        interval: float = PRUNE_INTERVAL_SECONDS,
    ) -> None:
        self._on_error, self._initial_delay, self._interval = (
            on_error, initial_delay, interval)
        self._sweeps: dict[str, Callable[[], object]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def add(self, name: str, sweep: Callable[[], object]) -> None:
        """Register one sweep; a running clock picks it up on its next tick."""
        with self._lock:
            self._sweeps[name] = sweep

    def run_once(self) -> dict[str, object]:
        """Run every sweep once, each isolated from the rest."""
        with self._lock:
            sweeps = list(self._sweeps.items())
        outcomes: dict[str, object] = {}
        for name, sweep in sweeps:
            try:
                outcomes[name] = sweep()
            except Exception as exc:  # noqa: BLE001 -- the others still run
                outcomes[name] = exc
                if self._on_error is not None:
                    with suppress(Exception):
                        self._on_error(name, exc)
        return outcomes

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="retention", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _loop(self) -> None:
        if self._stop.wait(self._initial_delay):
            return
        while not self._stop.is_set():
            self.run_once()
            self._stop.wait(self._interval)
