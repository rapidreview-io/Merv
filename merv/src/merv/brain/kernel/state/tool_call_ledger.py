"""Durable tool-call ledger: one row per call and per pre-dispatch refusal.

Sizes, digests, and outcomes ONLY in the table. The in-memory rings keep
serving the debug UI the raw request/response it drills into; this table exists
so agent friction — retry loops, gate bounces, poll churn, per-tool latency and
context bloat — survives a restart, and it must never grow into a second
payload store (BACKEND_AUDIT §15.2). The payload a call carried is instead
written beside the row, as one blob in the content-addressed store
(``tool_call_payloads``), and only for calls attributed to an agent context
window; the row keeps its key in ``payload_ref`` and the retention sweep
deletes blob and row together.

Every write is fail-safe in both senses. In errors: a ledger failure is counted
and announced through ``on_failure``, never raised into the call it was
observing. In latency: ``record`` hands the row to ONE writer thread through a
bounded queue and returns, so no tool call ever waits behind a database. A full
queue is the same counted drop a failed insert is.
"""

from __future__ import annotations

import queue
import threading
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from .activity import ToolCallRecord, args_digest, error_head, ledger_label
from .store import Connection
from .tool_call_payloads import ToolCallPayloadStore
from ..env import env_int
from ..request_context import RequestContext, current_request_context
from ..utils import format_iso, now_iso

TOOL_CALL_RETENTION_DAYS_ENV_VAR = "MERV_TOOL_CALL_RETENTION_DAYS"
# Rows and their payload records share one horizon: an agent's trace is kept
# for half a year, then row and blob go together.
DEFAULT_RETENTION_DAYS = 180
# One DELETE removes at most this many rows, so retention never holds the write
# lock for an unbounded span; one sweep runs at most this many of them, so a
# backlog is actually cleared instead of merely reported as `more`.
PRUNE_BATCH_ROWS = 20_000
PRUNE_MAX_BATCHES = 50
# How many rows may be waiting on the writer. Past this a row is dropped rather
# than queued: a database that has stopped answering must cost this process a
# bounded number of kilobytes, not its heap.
LEDGER_QUEUE_ROWS = 1_024
# The writer is one thread, but it may still hang in two places the database
# owns: the lock queue and the statement itself. Each gets its own deadline, so
# a wedged row is dropped and the next one is tried rather than the queue
# filling behind a single statement waiting out the store's ten-second busy
# timeout or an unbounded hosted-Postgres lock wait.
LEDGER_BUSY_TIMEOUT_MS = 250
LEDGER_STATEMENT_TIMEOUT_MS = 1_000
# A retention batch is observed by nobody, so it gets a deadline sized for a
# 20k-row DELETE rather than the per-row one. It is spent on a connection the
# sweep opens and closes for itself, so no writer ever inherits it.
PRUNE_STATEMENT_TIMEOUT_MS = 30_000
PRUNE_INITIAL_DELAY_SECONDS = 30.0
PRUNE_INTERVAL_SECONDS = 3600.0
# How long a drain (``flush``, and shutdown's ``close``) waits for the writer.
# Bounded because a process must be able to exit past a database that has
# stopped answering; rows still queued at the deadline are lost, which is what
# telemetry is allowed to do.
LEDGER_DRAIN_TIMEOUT_SECONDS = 5.0


def configured_retention_days(*, env: Mapping[str, str] | None = None) -> int:
    """The ledger horizon, shared by rows and their payload records.

    A zero or negative horizon would delete the ledger it is protecting, so
    the floor is one day.
    """
    return max(
        1,
        env_int(
            TOOL_CALL_RETENTION_DAYS_ENV_VAR,
            DEFAULT_RETENTION_DAYS,
            env=env,
            strict=False,
        ),
    )


class LedgerConnections(Protocol):
    """The single store capability an append-only ledger needs."""

    def connect(self) -> Connection: ...


class DroppedRowSink(Protocol):
    """Told when a row could not be written, so no drop is ever silent."""

    def __call__(self, error: str) -> None: ...


def _reason(exc: BaseException) -> str:
    """One capped, scrubbed line naming why a row was dropped."""
    return error_head(error=str(exc)) or type(exc).__name__


def _bound_connection(
    *, conn: Connection, lock_timeout_ms: int, statement_timeout_ms: int
) -> None:
    """Give ONE connection its own deadlines, whichever dialect backs it.

    Postgres counts milliseconds; SQLite has no statement deadline at all,
    only a lock wait, so the failing SET is how the dialect answers "no such
    knob". Applied at open, on the ledger's own connection, so the bound
    covers the database work and not merely the queue in front of it: the
    record store's connections keep their patient defaults, because a real
    write is allowed to queue and a telemetry row is not.

    Raises when neither dialect's knob took — an undeadlined ledger connection
    breaks the one promise this module makes, so the caller counts a drop
    instead of writing through it.
    """
    try:
        conn.execute(f"SET SESSION statement_timeout = {int(statement_timeout_ms)}")
    except Exception:  # noqa: BLE001 -- SQLite simply has no such setting
        conn.execute(f"PRAGMA busy_timeout = {int(lock_timeout_ms)}")
        return
    conn.execute(f"SET SESSION lock_timeout = {int(lock_timeout_ms)}")


class ToolCallLedger:
    """Append-only writer + retention sweep for the ``tool_calls`` table."""

    def __init__(
        self,
        *,
        store: LedgerConnections,
        retention_days: int | None = None,
        env: Mapping[str, str] | None = None,
        on_failure: DroppedRowSink | None = None,
        payloads: ToolCallPayloadStore | None = None,
    ) -> None:
        self._store = store
        # Where an agent-attributed call's request/response record goes.
        # Absent in narrow compositions: rows are still written, without refs.
        self.payloads = payloads
        self.retention_days = (
            max(1, int(retention_days))
            if retention_days is not None
            else configured_retention_days(env=env)
        )
        self._on_failure = on_failure
        self.failures = 0
        # One writer thread owning one connection is the whole concurrency
        # story. A caller never holds a lock, never opens a handle, and never
        # waits; the connection is opened, used, and closed on a single thread,
        # which is both what SQLite requires of its handles and what makes
        # closing a psycopg one safe without proving who else might be using it.
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=LEDGER_QUEUE_ROWS)
        self._writer: threading.Thread | None = None
        self._writer_lock = threading.Lock()
        self._retention_stop = threading.Event()
        self._retention_thread: threading.Thread | None = None

    def start_retention(self) -> None:
        """Start the bounded retention timer owned by this ledger."""
        if self._retention_thread is not None and self._retention_thread.is_alive():
            return
        self._retention_stop.clear()
        self._retention_thread = threading.Thread(
            target=self._retention_loop,
            name="tool-call-retention",
            daemon=True,
        )
        self._retention_thread.start()

    def _retention_loop(self) -> None:
        if self._retention_stop.wait(PRUNE_INITIAL_DELAY_SECONDS):
            return
        while True:
            self.prune()
            if self._retention_stop.wait(PRUNE_INTERVAL_SECONDS):
                return

    def record(self, call: ToolCallRecord) -> None:
        """Hand one call outcome to the writer. Never blocks, never raises.

        The correlation identity is read HERE, on the calling thread: it lives
        in a contextvar the writer thread was not created inside.
        """
        try:
            self._start_writer()
            self._queue.put_nowait((call, current_request_context()))
        except queue.Full:
            self._dropped("tool-call ledger queue is full")
        except Exception as exc:  # noqa: BLE001 -- telemetry never raises into a call
            self._dropped(_reason(exc))

    def reject(
        self,
        *,
        tool: str = "",
        source: str = "",
        error_code: str = "",
        error: str = "",
        project_id: str = "",
        duration_ms: int = 0,
    ) -> None:
        """Ledger a refusal that never reached the dispatcher.

        These callers have no dispatcher record to fan out, so this is where a
        refusal is shaped like every other row.
        """
        self.record(
            ToolCallRecord(
                tool=tool,
                source=source,
                status="rejected",
                duration_ms=duration_ms,
                error=error,
                error_code=error_code,
                project_id=project_id,
            )
        )

    def flush(self, *, timeout: float = LEDGER_DRAIN_TIMEOUT_SECONDS) -> bool:
        """Wait until every row queued so far has reached the table.

        The marker rides the queue itself, so "so far" means exactly that: no
        inspection of the writer's state, and no row queued later is waited on.
        """
        writer = self._writer
        if writer is None or not writer.is_alive():
            return True
        drained = threading.Event()
        try:
            self._queue.put_nowait(drained)
        except queue.Full:
            return False
        return drained.wait(timeout)

    def prune(
        self, *, now: datetime | None = None, max_batches: int = PRUNE_MAX_BATCHES
    ) -> dict[str, Any]:
        """Delete rows past the retention horizon, reporting what happened.

        Batches until the horizon is clear or the iteration bound is spent: one
        20k batch per sweep cannot outrun a call rate that mints more rows than
        that in a day. A failed sweep says so (``ok`` False) instead of
        reporting zero deleted — a silent 0 is indistinguishable from a healthy
        no-op (audit OPS-03).

        The sweep opens its OWN connection, at the wide retention deadline, and
        closes it on the way out, so a 30-second DELETE never runs on the
        writer's handle and no dead handle can leave retention disabled until
        process restart. One dial an hour is not a cost worth optimizing.
        """
        cutoff = format_iso(
            (now or datetime.now(tz=UTC)) - timedelta(days=self.retention_days)
        )
        deleted = 0
        more = False
        conn: Connection | None = None
        try:
            conn = self._dial(statement_timeout_ms=PRUNE_STATEMENT_TIMEOUT_MS)
            for _ in range(max(1, int(max_batches))):
                batch, more = self._delete_before(conn=conn, cutoff=cutoff)
                deleted += batch
                if not more:
                    break
        except Exception as exc:  # noqa: BLE001 -- one sweep must not abort the pass
            self.failures += 1
            return {
                "deleted": deleted,
                "ok": False,
                "cutoff": cutoff,
                "error": _reason(exc),
            }
        finally:
            if conn is not None:
                with suppress(Exception):
                    conn.close()
        return {"deleted": deleted, "ok": True, "cutoff": cutoff, "more": more}

    def close(self) -> None:
        """Stop retention, drain what is queued, and let the writer go.

        Bounded at both steps: shutdown may not hang on a database that has
        stopped answering, so rows still queued at the deadline are lost. The
        writer closes its own connection on the way out, so nothing here ever
        finishes a socket underneath a statement someone else is running — a
        retention sweep's connection included, which this has never held.
        """
        self._retention_stop.set()
        if (
            self._retention_thread is not None
            and self._retention_thread is not threading.current_thread()
        ):
            self._retention_thread.join(timeout=2.0)
        writer = self._writer
        if writer is None or not writer.is_alive():
            return
        with suppress(queue.Full):
            self._queue.put(None, timeout=LEDGER_DRAIN_TIMEOUT_SECONDS)
        writer.join(timeout=LEDGER_DRAIN_TIMEOUT_SECONDS)

    def _dropped(self, reason: str) -> None:
        """Count a row this ledger could not write; never drop one silently."""
        self.failures += 1
        if self._on_failure is not None:
            with suppress(Exception):
                self._on_failure(reason)

    def _start_writer(self) -> None:
        """Start the writer on its first row.

        Lazily, because most ledgers built in a narrow composition never see
        one and a thread parked on an empty queue forever is not free.
        """
        if self._writer is not None and self._writer.is_alive():
            return
        with self._writer_lock:
            if self._writer is not None and self._writer.is_alive():
                return
            self._writer = threading.Thread(
                target=self._writer_loop, name="tool-call-ledger", daemon=True
            )
            self._writer.start()

    def _writer_loop(self) -> None:
        """Own one connection and drain the queue until told to stop.

        A failed statement drops the handle with it — it may be a dead one —
        and the next row re-dials.
        """
        conn: Connection | None = None
        while True:
            item = self._queue.get()
            if item is None:
                break
            if isinstance(item, threading.Event):
                item.set()  # a drain marker: everything queued before it is in
                continue
            try:
                if conn is None:
                    conn = self._dial(statement_timeout_ms=LEDGER_STATEMENT_TIMEOUT_MS)
                self._insert(conn=conn, call=item[0], context=item[1])
            except Exception as exc:  # noqa: BLE001 -- a dropped row is not a failed call
                self._dropped(_reason(exc))
                if conn is not None:
                    with suppress(Exception):
                        conn.close()
                    conn = None
        if conn is not None:
            with suppress(Exception):
                conn.close()

    def _insert(
        self, *, conn: Connection, call: ToolCallRecord, context: RequestContext
    ) -> None:
        ts = now_iso()
        # Every label is capped and scrubbed HERE, at the one writer, so no
        # transport can put a multi-kilobyte or token-bearing value into an
        # indexed column by forgetting to sanitize its own call site — and the
        # payload record beside the row is given the same scrubbed values,
        # rather than each of them scrubbing the same field again.
        label = {name: ledger_label(value) for name, value in (
            ("request_id", context.request_id),
            ("principal_id", context.principal_id),
            ("agent_id", context.agent_id),
            ("mcp_session_id", context.mcp_session_id),
            ("tool", call.tool), ("source", call.source),
            ("project_id", call.project_id), ("error_code", call.error_code),
        )}
        payload_ref = self._write_payload(
            ts=ts,
            status=call.status,
            duration_ms=call.duration_ms,
            arguments=call.arguments,
            result=call.result,
            error=call.error,
            **label,
        )
        conn.execute(
            """
            INSERT INTO tool_calls
              (ts, request_id, principal_id, tool, source, project_id,
               target_type, target_id, status, error_code, error_head,
               duration_ms, sent_chars, received_chars, args_digest,
               agent_id, mcp_session_id, payload_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ts,
                label["request_id"],
                label["principal_id"],
                label["tool"],
                label["source"],
                label["project_id"],
                ledger_label(call.target_type),
                ledger_label(call.target_id),
                call.status,
                label["error_code"],
                error_head(error=call.error),
                call.duration_ms,
                call.sent_chars,
                call.received_chars,
                args_digest(arguments=call.arguments),
                label["agent_id"],
                label["mcp_session_id"],
                payload_ref,
            ),
        )
        conn.commit()

    def _write_payload(self, **facts: Any) -> str:
        """The payload record's blob key, or "" when none is written.

        Only agent-attributed calls get a record, and a payload failure never
        costs the row: it is counted like a dropped row and the row goes in
        with an empty ref, so the trace shows the call happened even when
        what it carried could not be kept.
        """
        if self.payloads is None or not facts.get("agent_id"):
            return ""
        try:
            return str(self.payloads.write(**facts) or "")
        except Exception as exc:  # noqa: BLE001 -- the row must still be written
            self._dropped("payload: " + _reason(exc))
            return ""

    def _dial(self, *, statement_timeout_ms: int) -> Connection:
        """Open one connection and give it its deadlines, or open none at all.

        A connection that can wait forever is worse than no connection: the
        caller counts a drop, which is exactly the promised behavior.
        """
        conn = self._store.connect()
        try:
            _bound_connection(
                conn=conn,
                lock_timeout_ms=LEDGER_BUSY_TIMEOUT_MS,
                statement_timeout_ms=statement_timeout_ms,
            )
        except Exception:
            with suppress(Exception):
                conn.close()
            raise
        return conn

    def _delete_before(self, *, conn: Connection, cutoff: str) -> tuple[int, bool]:
        """Delete one batch; report what it removed and whether more remain."""
        # Bound the sweep by id rather than by a LIMIT on DELETE, which neither
        # dialect supports portably. The count comes from the same subquery, so
        # it is exactly what the DELETE below removes: the batch is the first
        # `PRUNE_BATCH_ROWS` expired ids in order, so no expired row sits under
        # the boundary without being in it.
        row = conn.execute(
            """
            SELECT MAX(id) AS boundary, COUNT(*) AS expiring FROM (
              SELECT id FROM tool_calls WHERE ts < ? ORDER BY id LIMIT ?
            ) AS batch
            """,
            (cutoff, PRUNE_BATCH_ROWS),
        ).fetchone()
        boundary = int((row["boundary"] if row else None) or 0)
        deleted = int((row["expiring"] if row else 0) or 0)
        if boundary <= 0 or deleted <= 0:
            return 0, False
        # Payload blobs go first, keyed straight off the rows about to leave:
        # the rows are the only index to them, so a row deleted before its
        # blob would orphan the blob until the namespace sweep found it.
        self._delete_payloads(conn=conn, boundary=boundary, cutoff=cutoff)
        conn.execute(
            "DELETE FROM tool_calls WHERE id <= ? AND ts < ?", (boundary, cutoff)
        )
        conn.commit()
        # `more` is the state of the table, not the size of the batch: exactly
        # PRUNE_BATCH_ROWS expired rows with none behind them reports False. A
        # short batch proves the horizon is clear without asking again.
        if deleted < PRUNE_BATCH_ROWS:
            return deleted, False
        remaining = conn.execute(
            "SELECT id FROM tool_calls WHERE ts < ? LIMIT 1", (cutoff,)
        ).fetchone()
        return deleted, remaining is not None

    def _delete_payloads(self, *, conn: Connection, boundary: int, cutoff: str) -> None:
        """Delete every payload blob the expiring batch references.

        Best-effort per blob: a store that cannot delete one key today must
        not keep the whole batch of rows alive; the blob's own ``expires_at``
        still gets it in the namespace sweep.
        """
        if self.payloads is None:
            return
        rows = conn.execute(
            """
            SELECT payload_ref FROM tool_calls
            WHERE id <= ? AND ts < ? AND payload_ref <> ''
            """,
            (boundary, cutoff),
        ).fetchall()
        for row in rows:
            ref = str(row["payload_ref"] or "")
            if not ref:
                continue
            try:
                self.payloads.delete(ref=ref)
            except Exception:  # noqa: BLE001 -- one blob must not stall the sweep
                self.failures += 1


__all__ = [
    "DEFAULT_RETENTION_DAYS",
    "LEDGER_DRAIN_TIMEOUT_SECONDS",
    "LEDGER_QUEUE_ROWS",
    "LEDGER_STATEMENT_TIMEOUT_MS",
    "PRUNE_BATCH_ROWS",
    "PRUNE_MAX_BATCHES",
    "PRUNE_STATEMENT_TIMEOUT_MS",
    "TOOL_CALL_RETENTION_DAYS_ENV_VAR",
    "ToolCallLedger",
    "configured_retention_days",
]
