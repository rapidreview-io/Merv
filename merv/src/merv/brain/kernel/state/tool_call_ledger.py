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

Every write is fail-safe: a ledger failure is counted and announced through
``on_failure``, never raised into the call it was observing.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from .activity import args_digest, error_head, ledger_label, payload_chars, target_of
from .store import Connection
from .tool_call_payloads import ToolCallPayloadStore
from ..env import env_int
from ..request_context import current_request_context
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
# A telemetry row may never make the call it observes wait — and the Python
# writer lock is only the first of three places one can hang. Each gets its own
# deadline: the lock, the database's lock queue, and the statement itself. The
# alternative is a tool call paying the store's ten-second SQLite busy timeout,
# or an unbounded hosted-Postgres lock wait, for a log line.
LEDGER_LOCK_TIMEOUT_SECONDS = 0.25
LEDGER_BUSY_TIMEOUT_MS = 250
LEDGER_STATEMENT_TIMEOUT_MS = 1_000
# A retention batch is observed by nobody, so it gets a deadline sized for a
# 20k-row DELETE rather than the per-row one. It is spent on a connection the
# sweep opens and closes for itself, so no in-path writer ever inherits it.
PRUNE_STATEMENT_TIMEOUT_MS = 30_000
PRUNE_INITIAL_DELAY_SECONDS = 30.0
PRUNE_INTERVAL_SECONDS = 3600.0
# Hard cap on cached writer handles, and therefore on server sessions: a thread
# past the cap has its handle closed and forgotten together, and simply re-dials
# on its next row. Retiring dead threads' handles is the ordinary bound; this is
# what holds in a process whose threads never retire.
LEDGER_MAX_CACHED_CONNECTIONS = 64
# Shutdown waits this long for the writer lock before releasing handles. Every
# use of a cached handle happens under that lock, so holding it is the proof
# that no thread is mid-statement on the connection being closed.
LEDGER_CLOSE_TIMEOUT_SECONDS = 5.0

_STATUSES = frozenset({"ok", "error", "rejected"})


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


class LedgerBusy(RuntimeError):
    """The writer was contended, so the row was dropped rather than waited on."""


class LedgerConnections(Protocol):
    """The single store capability an append-only ledger needs."""

    def connect(self) -> Connection: ...


class DroppedRowSink(Protocol):
    """Told when a row could not be written, so no drop is ever silent."""

    def __call__(self, error: str) -> None: ...


def _set_statement_deadline(*, conn: Connection, timeout_ms: int) -> bool:
    """Bound how long one statement may run; False where the dialect has none.

    Postgres counts milliseconds; SQLite has no statement deadline at all, only
    a lock wait, so there the answer is honestly "no such knob".
    """
    try:
        conn.execute(f"SET SESSION statement_timeout = {int(timeout_ms)}")
    except Exception:  # noqa: BLE001 -- SQLite simply has no such setting
        return False
    return True


def _bound_connection(
    *, conn: Connection, lock_timeout_ms: int, statement_timeout_ms: int
) -> None:
    """Give ONE connection its own deadlines, whichever dialect backs it.

    Applied at open, on the ledger's own connection, so the bound covers the
    database work and not merely the Python lock in front of it. The record
    store's connections keep their patient defaults: a real write is allowed to
    queue, a telemetry row is not.

    Raises when neither dialect's knob took — an undeadlined ledger connection
    breaks the one promise this module makes, so the caller counts a drop
    instead of writing through it.
    """
    if _set_statement_deadline(conn=conn, timeout_ms=statement_timeout_ms):
        conn.execute(f"SET SESSION lock_timeout = {int(lock_timeout_ms)}")
        return
    conn.execute(f"PRAGMA busy_timeout = {int(lock_timeout_ms)}")


def _dispose(
    *, conn: Connection, owner: threading.Thread, quiesced: bool = True
) -> None:
    """Release a handle, closing it only where closing is legal.

    Two separate legalities, and both have to hold:

    - A SQLite connection may only be closed on the thread that opened it, so
      from anywhere else the correct disposal is to drop the last reference and
      let refcounting do it.
    - Any other dialect is a network handle, and psycopg's ``close()`` does NOT
      wait behind an in-flight statement — it finishes the socket underneath
      one. So it may only be closed when the owner is provably not using it:
      the owner is dead, the owner is us, or the caller holds the writer lock
      every use of a cached handle is taken under (``quiesced``). Otherwise the
      reference is dropped and the session outlives us by the owner's lifetime,
      which is the lesser of the two evils.
    """
    if isinstance(conn, sqlite3.Connection):
        if owner is not threading.current_thread():
            return
    elif not (quiesced or owner is threading.current_thread() or not owner.is_alive()):
        return
    with suppress(Exception):
        conn.close()


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
        # The writer lock is also the handle-cache lock. That is the whole
        # safety argument: a cached handle is opened, used, and released only
        # under it, so anything holding it may close any cached handle without
        # racing the thread that owns it. Re-entrant because _write holds it
        # across _connection() and _discard().
        self._lock = threading.RLock()
        # Keyed by thread ident and owned HERE rather than in a threading.local,
        # so evicting a handle really releases it: a thread-local slot we cannot
        # reach would keep the session open behind our backs. The stored thread
        # is what proves an entry belongs to today's owner of a recycled ident.
        self._handles: dict[int, tuple[threading.Thread, Connection]] = {}
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

    def record(
        self,
        *,
        tool: str = "",
        source: str = "",
        status: str = "ok",
        duration_ms: int = 0,
        arguments: dict[str, Any] | None = None,
        result: Any | None = None,
        error: str = "",
        error_code: str = "",
        project_id: str = "",
    ) -> None:
        """Persist one call outcome. Never raises — this is telemetry."""
        try:
            self._insert(
                tool=tool,
                source=source,
                status=status if status in _STATUSES else "error",
                duration_ms=duration_ms,
                arguments=arguments or {},
                result=result,
                error=error,
                error_code=error_code,
                project_id=project_id,
            )
        except Exception as exc:  # noqa: BLE001 -- a dropped row is not a failed call
            self.failures += 1
            if self._on_failure is not None:
                with suppress(Exception):
                    self._on_failure(error_head(error=str(exc)) or type(exc).__name__)

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
        """Ledger a refusal that never reached the dispatcher."""
        self.record(
            tool=tool,
            source=source,
            status="rejected",
            duration_ms=duration_ms,
            error=error,
            error_code=error_code,
            project_id=project_id,
        )

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
        closes it on the way out. Three problems dissolve rather than being
        managed: no in-path writer's connection is ever borrowed and left at 30
        seconds (operator cleanup calls this on a synchronous HTTP worker whose
        handle the next tool call reuses); no long DELETE runs on a handle the
        writer lock is protecting; and no cached corpse can leave retention
        disabled until process restart, because there is no cached handle here
        at all. One dial an hour is not a cost worth optimizing.
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
                "error": error_head(error=str(exc)) or type(exc).__name__,
            }
        finally:
            if conn is not None:
                with suppress(Exception):
                    conn.close()
        return {"deleted": deleted, "ok": True, "cutoff": cutoff, "more": more}

    def close(self) -> None:
        """Release every cached connection. Called on composition shutdown.

        Stops the retention timer, then takes the writer lock: that is what
        makes closing another
        thread's psycopg handle safe rather than a socket pulled out from under
        an in-flight statement. If the lock does not come free in time a writer
        is still mid-row, so its handle is only forgotten, never closed — the
        composition's shutdown order (background daemons stopped BEFORE this)
        is what keeps that path from being the normal one.

        A retention sweep owns a connection this cache never held and closes it
        itself.
        """
        self._retention_stop.set()
        if (
            self._retention_thread is not None
            and self._retention_thread is not threading.current_thread()
        ):
            self._retention_thread.join(timeout=2.0)
        acquired = self._lock.acquire(timeout=LEDGER_CLOSE_TIMEOUT_SECONDS)
        try:
            handles = list(self._handles.values())
            self._handles = {}
        finally:
            if acquired:
                self._lock.release()
        for owner, conn in handles:
            _dispose(conn=conn, owner=owner, quiesced=acquired)

    def _insert(
        self,
        *,
        tool: str,
        source: str,
        status: str,
        duration_ms: int,
        arguments: dict[str, Any],
        result: Any | None,
        error: str,
        error_code: str,
        project_id: str,
    ) -> None:
        context = current_request_context()
        target_type, target_id = target_of(arguments)
        scope = project_id or (
            str(arguments.get("project_id") or "") if isinstance(arguments, dict) else ""
        )
        # Mirrors the in-memory ring exactly: an error's received size is the
        # error text the caller got back, not a result it never saw.
        received = (
            len(error or "") if status != "ok" else payload_chars(value=result)
        )
        ts = now_iso()
        agent_id = ledger_label(context.agent_id)
        mcp_session_id = ledger_label(context.mcp_session_id)
        payload_ref = self._write_payload(
            ts=ts,
            agent_id=agent_id,
            request_id=ledger_label(context.request_id),
            principal_id=ledger_label(context.principal_id),
            mcp_session_id=mcp_session_id,
            tool=ledger_label(tool),
            source=ledger_label(source),
            project_id=ledger_label(scope),
            status=status,
            duration_ms=duration_ms,
            arguments=arguments,
            result=result,
            error=error,
            error_code=ledger_label(error_code),
        )
        # Every label is capped and scrubbed HERE, at the one writer, so no
        # transport can put a multi-kilobyte or token-bearing value into an
        # indexed column by forgetting to sanitize its own call site.
        self._write(
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
                ledger_label(context.request_id),
                ledger_label(context.principal_id),
                ledger_label(tool),
                ledger_label(source),
                ledger_label(scope),
                ledger_label(target_type or ""),
                ledger_label(target_id or ""),
                status,
                ledger_label(error_code),
                error_head(error=error),
                int(duration_ms or 0),
                payload_chars(value=arguments),
                int(received),
                args_digest(arguments=arguments),
                agent_id,
                mcp_session_id,
                payload_ref,
            ),
        )

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
            self.failures += 1
            if self._on_failure is not None:
                with suppress(Exception):
                    self._on_failure(
                        "payload: " + (error_head(error=str(exc)) or type(exc).__name__)
                    )
            return ""

    def _write(self, sql: str, params: tuple[Any, ...]) -> None:
        """One append, serialized and time-bounded.

        Append-only, so a plain connection is enough: no read-then-write means
        no need for the store's single-writer transaction on every call. The
        lock keeps concurrent rows from contending for the database write lock
        with each other; its timeout plus the connection's own lock/statement
        deadlines (see ``_bound_connection``) are together the promise that a
        contended ledger drops a row instead of delaying the call it observed.
        """
        if not self._lock.acquire(timeout=LEDGER_LOCK_TIMEOUT_SECONDS):
            raise LedgerBusy("tool-call ledger writer is busy")
        try:
            conn = self._connection()
            try:
                conn.execute(sql, params)
                conn.commit()
            except Exception:
                self._discard()  # a failed handle may be a dead one
                raise
        finally:
            self._lock.release()

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

    def _connection(self) -> Connection:
        """This thread's cached connection, opened once, deadlined, and reused.

        Callers must hold ``self._lock`` — the cache is the lock's invariant,
        not merely protected data.

        Cached per THREAD rather than per instance because rows are written
        from the HTTP threadpool and the reaper thread, and a SQLite handle may
        only be used on the thread that opened it. What the database feels is
        the same thing either way: one connection per worker instead of a fresh
        connect, insert, commit, and close on every single row.
        """
        thread = threading.current_thread()
        entry = self._handles.get(thread.ident)
        if entry is not None:
            if entry[0] is thread:
                return entry[1]
            # A recycled ident: the thread that opened this handle is gone, so
            # its session is ours to close before we take the slot.
            del self._handles[thread.ident]
            _dispose(conn=entry[1], owner=entry[0])
        conn = self._dial(statement_timeout_ms=LEDGER_STATEMENT_TIMEOUT_MS)
        self._handles[thread.ident] = (thread, conn)
        self._bound_cache(keep=thread.ident)
        return conn

    def _bound_cache(self, *, keep: int | None) -> None:
        """Close every handle this ledger no longer needs to be holding.

        Two bounds, in the order that matters. First the ordinary one: a
        retired worker's handle is otherwise held open by this cache alone —
        one server session per thread the pool ever churned through. Then the
        backstop for a process whose threads never retire: past the cap the
        OLDEST live thread's handle is closed and forgotten *together*, so the
        advertised cap bounds real sessions and not merely dict entries; that
        thread re-dials on its next row. Closing under the writer lock is legal
        precisely because no cached handle is ever used without it.

        Run only when a NEW connection is opened, which is the one moment
        worker turnover can have happened, so no row on the hot path pays.
        """
        for ident, (owner, conn) in list(self._handles.items()):
            if not owner.is_alive():
                del self._handles[ident]
                _dispose(conn=conn, owner=owner)
        overflow = len(self._handles) - LEDGER_MAX_CACHED_CONNECTIONS
        for ident, (owner, conn) in list(self._handles.items()):
            if overflow <= 0:
                break
            if ident == keep:  # the caller is about to write through this one
                continue
            del self._handles[ident]
            _dispose(conn=conn, owner=owner)
            overflow -= 1

    def _discard(self) -> None:
        """Drop a connection that just failed so the next row reconnects.

        Callers must hold ``self._lock``.
        """
        entry = self._handles.pop(threading.current_thread().ident, None)
        if entry is not None:
            _dispose(conn=entry[1], owner=entry[0])

    def _delete_before(self, *, conn: Connection, cutoff: str) -> tuple[int, bool]:
        """Delete one batch; report what it removed and whether more remain.

        Runs on the sweep's own connection and OUTSIDE the writer lock: a
        20k-row DELETE holding it would drop every concurrent tool-call row for
        the duration of the sweep.
        """
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
    "LEDGER_CLOSE_TIMEOUT_SECONDS",
    "LEDGER_MAX_CACHED_CONNECTIONS",
    "LEDGER_STATEMENT_TIMEOUT_MS",
    "PRUNE_BATCH_ROWS",
    "PRUNE_MAX_BATCHES",
    "PRUNE_STATEMENT_TIMEOUT_MS",
    "TOOL_CALL_RETENTION_DAYS_ENV_VAR",
    "LedgerBusy",
    "ToolCallLedger",
    "configured_retention_days",
]
