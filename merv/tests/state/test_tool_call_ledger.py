"""Migration 37 and the durable tool-call ledger it creates.

Two halves: the ladder (the table and every index arrive on a fresh database
AND on one that predates them) and the writer (a call becomes a row of sizes,
digests, and outcomes — never payloads — and a broken ledger never breaks the
call it was observing).
"""

from __future__ import annotations

import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

from merv.brain.kernel.request_context import begin_request, bind_principal, reset_request
from merv.brain.kernel.state import tool_call_ledger as ledger_module
from merv.brain.kernel.state.activity import LEDGER_LABEL_MAX_CHARS
from merv.brain.kernel.state.store import (
    MIGRATIONS,
    SCHEMA,
    TOOL_CALL_LEDGER_INDEXES,
    StateStore,
)
from merv.brain.kernel.state.tool_call_ledger import (
    DEFAULT_RETENTION_DAYS,
    LEDGER_BUSY_TIMEOUT_MS,
    LEDGER_STATEMENT_TIMEOUT_MS,
    PRUNE_STATEMENT_TIMEOUT_MS,
    TOOL_CALL_RETENTION_DAYS_ENV_VAR,
    ToolCallLedger,
)


class CountingStore:
    """A store that reports how many connections the ledger actually opened."""

    def __init__(self, store: StateStore) -> None:
        self._store = store
        self.connects = 0
        self.handles: list = []

    def connect(self):
        self.connects += 1
        conn = self._store.connect()
        self.handles.append(conn)
        return conn


class StubPostgresConnection:
    """A connection that speaks SET SESSION and rejects PRAGMA, as PG does.

    The hosted dialect is the one this module's deadlines exist for and the one
    no test database can be, so it is stood in for at the connection seam.
    """

    def __init__(self, *, fail_write: str = "", stall: "Stall | None" = None) -> None:
        self.statements: list[str] = []
        self.closed = False
        # A close that lands while a statement is in flight is the psycopg
        # hazard this module has to avoid; the stub notices rather than tolerates.
        self.closed_mid_statement = False
        self._busy = False
        self._fail_write = fail_write
        self._stall = stall

    def execute(self, sql, parameters=()):
        statement = " ".join(str(sql).split())
        if statement.startswith("PRAGMA"):
            raise RuntimeError('syntax error at or near "PRAGMA"')
        self._busy = True
        try:
            if self._stall is not None and statement.startswith("SELECT"):
                self._stall.hold()
            self.statements.append(statement)
            if self._fail_write and statement.startswith("INSERT"):
                raise RuntimeError(self._fail_write)
        finally:
            self._busy = False
        return self

    def fetchone(self):
        return None

    def commit(self) -> None:
        return None

    def close(self) -> None:
        if self._busy:
            self.closed_mid_statement = True
        self.closed = True


class Stall:
    """One statement parked mid-flight until the test lets it go."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()

    def hold(self) -> None:
        self.entered.set()
        self.release.wait(timeout=5)


class StubPostgresStore:
    def __init__(self, *, fail_write: str = "", stall: Stall | None = None) -> None:
        self.connections: list[StubPostgresConnection] = []
        self._fail_write = fail_write
        self._stall = stall

    def connect(self) -> StubPostgresConnection:
        conn = StubPostgresConnection(fail_write=self._fail_write, stall=self._stall)
        self.connections.append(conn)
        return conn

    def live(self) -> list[StubPostgresConnection]:
        return [conn for conn in self.connections if not conn.closed]

LEDGER_INDEX_NAMES = frozenset(
    statement.split("IF NOT EXISTS ")[1].split()[0]
    for statement in TOOL_CALL_LEDGER_INDEXES
)


def _schema_without_tool_calls() -> str:
    """SCHEMA as it stood before migration 37: no tool_calls table at all."""
    return ";".join(
        block
        for block in SCHEMA.split(";")
        if "CREATE TABLE IF NOT EXISTS tool_calls" not in block
    )


def _indexes(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        ).fetchall()
    }


class Migration37Test(unittest.TestCase):
    def test_fresh_database_gets_the_table_and_every_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(db_path=Path(tmp) / "state.sqlite")
            with store.transaction() as conn:
                columns = {
                    str(row["name"])
                    for row in conn.execute("PRAGMA table_info(tool_calls)").fetchall()
                }
                self.assertEqual(
                    columns,
                    {
                        "id", "ts", "request_id", "principal_id", "tool", "source",
                        "project_id", "target_type", "target_id", "status",
                        "error_code", "error_head", "duration_ms", "sent_chars",
                        "received_chars", "args_digest",
                        # Migration 50: agent attribution + payload key.
                        "agent_id", "mcp_session_id", "payload_ref",
                    },
                )
                self.assertLessEqual(LEDGER_INDEX_NAMES, _indexes(conn))
                applied = {
                    int(row["version"])
                    for row in conn.execute(
                        "SELECT version FROM schema_migrations"
                    ).fetchall()
                }
                self.assertIn(37, applied)

    def test_database_that_predates_the_ledger_converges(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "legacy.sqlite"
            conn = sqlite3.connect(db_path)
            conn.executescript(_schema_without_tool_calls())
            for version, name, _ in MIGRATIONS:
                if version < 37:
                    conn.execute(
                        "INSERT OR IGNORE INTO schema_migrations "
                        "(version, name, applied_at) VALUES (?, ?, '2026-01-01T00:00:00Z')",
                        (version, name),
                    )
            conn.commit()
            tables = {
                str(row[0])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            self.assertNotIn("tool_calls", tables, "fixture must start without it")
            self.assertFalse(LEDGER_INDEX_NAMES & _indexes(conn))
            conn.close()

            StateStore(db_path=db_path)

            conn = sqlite3.connect(db_path)
            try:
                tables = {
                    str(row[0])
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
                self.assertIn("tool_calls", tables)
                # Every index, including the ones on the pre-existing tables.
                self.assertLessEqual(LEDGER_INDEX_NAMES, _indexes(conn))
            finally:
                conn.close()

    def test_schema_declares_no_index_at_all(self) -> None:
        """The migration-36 outage in general form: SCHEMA runs before the
        ladder, so migration 37's indexes may only live in the migration."""
        for name in LEDGER_INDEX_NAMES:
            self.assertNotIn(name, SCHEMA)

    def test_reapplying_the_migration_is_a_no_op(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "state.sqlite"
            store = StateStore(db_path=db_path)
            with store.transaction() as conn:
                conn.execute("DELETE FROM schema_migrations WHERE version = 37")
            StateStore(db_path=db_path)  # boots without raising


class ToolCallLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "state.sqlite"
        self.store = StateStore(db_path=self.db_path)
        self.ledger = ToolCallLedger(store=self.store, env={})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _rows(self) -> list[dict[str, object]]:
        with self.store.transaction() as conn:
            return [
                {key: row[key] for key in row.keys()}
                for row in conn.execute(
                    "SELECT * FROM tool_calls ORDER BY id"
                ).fetchall()
            ]

    def test_ok_call_records_sizes_digest_and_correlation(self) -> None:
        scope = begin_request(request_id="req-abc")
        bind_principal(principal_id="key:pk_1")
        try:
            self.ledger.record(
                tool="experiment.get_state",
                source="mcp",
                status="ok",
                duration_ms=17,
                arguments={"project_id": "proj_1", "experiment_id": "exp_1"},
                result={"status": "running"},
            )
        finally:
            reset_request(scope)
        (row,) = self._rows()
        self.assertEqual(row["request_id"], "req-abc")
        self.assertEqual(row["principal_id"], "key:pk_1")
        self.assertEqual(row["tool"], "experiment.get_state")
        self.assertEqual(row["source"], "mcp")
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["project_id"], "proj_1")
        self.assertEqual((row["target_type"], row["target_id"]), ("experiment", "exp_1"))
        self.assertEqual(row["duration_ms"], 17)
        self.assertGreater(int(row["sent_chars"]), 0)
        self.assertEqual(row["received_chars"], len('{"status": "running"}'))
        self.assertEqual(len(str(row["args_digest"])), 16)
        self.assertEqual(row["error_head"], "")

    def test_error_call_records_one_scrubbed_capped_line(self) -> None:
        self.ledger.record(
            tool="review.submit",
            source="mcp",
            status="error",
            duration_ms=3,
            arguments={"project_id": "proj_1"},
            error="gate refused: " + "x" * 500 + "\nstack frame that never lands",
            error_code="review_gate",
        )
        (row,) = self._rows()
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error_code"], "review_gate")
        head = str(row["error_head"])
        self.assertEqual(len(head), 200)
        self.assertTrue(head.startswith("gate refused: "))
        self.assertNotIn("stack frame", head)

    def test_secrets_never_reach_the_row_or_its_digest(self) -> None:
        secret = {"project_id": "proj_1", "reviewer_capability": "rp_supersecret"}
        self.ledger.record(tool="review.start", source="mcp", arguments=secret)
        redacted = dict(secret, reviewer_capability="[redacted]")
        self.ledger.record(tool="review.start", source="mcp", arguments=redacted)
        first, second = self._rows()
        self.assertNotIn("rp_supersecret", str(first))
        # Redaction happens before the hash, so the capability cannot be
        # brute-forced back out of the digest either.
        self.assertEqual(first["args_digest"], second["args_digest"])

    def test_every_label_column_is_capped_before_it_is_indexed(self) -> None:
        """Storage amplification, closed at the writer: an indexed column can
        never take a caller's multi-kilobyte string."""
        self.ledger.reject(
            tool="tools/" + "z" * 4000,
            source="m" * 500,
            error_code="e" * 500,
            project_id="p" * 3000,
        )
        (row,) = self._rows()
        for column in ("tool", "source", "project_id", "error_code"):
            with self.subTest(column=column):
                self.assertLessEqual(len(str(row[column])), LEDGER_LABEL_MAX_CHARS)

    def test_a_token_bearing_label_never_lands_verbatim(self) -> None:
        """The reviewer's scenario: an unauthenticated caller puts a credential
        in ?project_id= or in an MCP method name and it is persisted."""
        self.ledger.reject(
            tool="Authorization: Bearer sk-livetoken0123456789abcdef",
            source="http",
            project_id="mk_" + "a" * 40,
            error="denied for mk_" + "b" * 40,
        )
        (row,) = self._rows()
        printed = str(row)
        self.assertNotIn("sk-livetoken0123456789abcdef", printed)
        self.assertNotIn("a" * 40, printed)
        self.assertNotIn("b" * 40, printed)
        self.assertIn("<redacted>", str(row["tool"]))
        self.assertIn("<redacted>", str(row["error_head"]))

    def test_a_short_prefixed_key_is_scrubbed_like_a_long_one(self) -> None:
        """The verifier accepts an ``rr_sk_`` value by PREFIX alone, so the
        scrubber may not be stricter than the thing it protects: the repo's own
        ``rr_sk_known`` fixture is a live credential with a 5-character tail."""
        self.ledger.reject(
            tool="rr_sk_known",
            source="http",
            project_id="mk_x",
            error="rejected key rr_sk_known",
        )
        (row,) = self._rows()
        printed = str(row)
        self.assertNotIn("rr_sk_known", printed)
        self.assertNotIn("mk_x", printed)
        self.assertEqual(row["tool"], "<redacted>")
        self.assertIn("<redacted>", str(row["error_head"]))

    def test_control_characters_never_reach_a_label(self) -> None:
        self.ledger.reject(tool="tools/\x00call\nnext", source="mcp")
        (row,) = self._rows()
        self.assertNotIn("\x00", str(row["tool"]))
        self.assertNotIn("\n", str(row["tool"]))

    def test_a_jwt_in_an_error_is_scrubbed(self) -> None:
        token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlZmFrZQ"
        self.ledger.record(
            tool="project", source="http", status="error", error=f"bad token {token}"
        )
        (row,) = self._rows()
        self.assertNotIn(token, str(row["error_head"]))
        self.assertIn("<redacted>", str(row["error_head"]))

    def test_the_writer_opens_one_connection_and_reuses_it(self) -> None:
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})
        for _ in range(5):
            ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertEqual(store.connects, 1)
        self.assertEqual(len(self._rows()), 5)
        ledger.close()

    def test_a_failed_write_drops_its_connection_and_reconnects(self) -> None:
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        with self.store.transaction() as conn:
            conn.execute("DROP TABLE tool_calls")
        ledger.record(tool="claim.list", source="mcp", arguments={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertEqual(ledger.failures, 2)
        # One dial, then exactly one re-dial: the handle that failed was
        # discarded rather than cached forever, and no row re-dials needlessly.
        self.assertEqual(store.connects, 2)
        ledger.close()

    def test_a_postgres_connection_gets_lock_and_statement_deadlines_at_open(
        self,
    ) -> None:
        """The bound has to cover the DATABASE, not just the Python lock: on
        hosted Postgres a held lock would otherwise stall the in-path write and
        therefore the tool call it was observing, forever."""
        store = StubPostgresStore()
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        (conn,) = store.connections
        self.assertEqual(ledger.failures, 0)
        self.assertEqual(
            conn.statements[:2],
            [
                f"SET SESSION statement_timeout = {LEDGER_STATEMENT_TIMEOUT_MS}",
                f"SET SESSION lock_timeout = {LEDGER_BUSY_TIMEOUT_MS}",
            ],
        )
        self.assertTrue(conn.statements[2].startswith("INSERT INTO tool_calls"))
        ledger.close()

    def test_a_timed_out_write_is_a_counted_drop_not_a_raise(self) -> None:
        dropped: list[str] = []
        store = StubPostgresStore(
            fail_write="canceling statement due to statement timeout"
        )
        ledger = ToolCallLedger(store=store, env={}, on_failure=dropped.append)
        ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["canceling statement due to statement timeout"])

    def test_a_connection_that_accepts_no_deadline_is_refused_outright(self) -> None:
        """An undeadlined ledger connection is worse than no connection: it can
        wait forever, which is the one thing this writer promises not to do."""

        class DeadlinelessConnection:
            def __init__(self) -> None:
                self.closed = False

            def execute(self, sql, parameters=()):
                raise RuntimeError("no such setting")

            def close(self) -> None:
                self.closed = True

        class DeadlinelessStore:
            def __init__(self) -> None:
                self.connections: list[DeadlinelessConnection] = []

            def connect(self) -> DeadlinelessConnection:
                conn = DeadlinelessConnection()
                self.connections.append(conn)
                return conn

        dropped: list[str] = []
        store = DeadlinelessStore()
        ledger = ToolCallLedger(store=store, env={}, on_failure=dropped.append)
        ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["no such setting"])
        (conn,) = store.connections
        self.assertTrue(conn.closed, "a refused handle is not left dangling")

    def test_the_sqlite_ledger_connection_carries_its_own_busy_timeout(self) -> None:
        """Set on the LEDGER's connection as part of opening it, not left to a
        generic pragma pass that hands out the record store's patient 10s."""
        self.ledger.record(tool="claim.list", source="mcp", arguments={})
        (_, conn), = self.ledger._handles.values()  # noqa: SLF001 -- setup under test
        self.assertEqual(
            conn.execute("PRAGMA busy_timeout").fetchone()[0], LEDGER_BUSY_TIMEOUT_MS
        )
        store_conn = self.store.connect()
        try:
            self.assertEqual(
                store_conn.execute("PRAGMA busy_timeout").fetchone()[0], 10_000
            )
        finally:
            store_conn.close()

    def test_a_retired_threads_connection_is_swept_on_the_next_open(self) -> None:
        """Worker turnover must not accumulate connections: a retired thread's
        slot is unreachable to everyone else, so this cache is the only thing
        still holding its handle — one PG server session per retired worker."""
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})

        worker = threading.Thread(
            target=lambda: ledger.record(tool="claim.list", source="mcp", arguments={})
        )
        worker.start()
        worker.join(timeout=5)

        cached = list(ledger._handles.values())  # noqa: SLF001 -- cache under test
        self.assertEqual(len(cached), 1)
        (retired, handle) = cached[0]
        self.assertFalse(retired.is_alive())

        ledger.record(tool="claim.list", source="mcp", arguments={})

        surviving = list(ledger._handles.values())  # noqa: SLF001 -- cache under test
        self.assertEqual([owner for owner, _ in surviving], [threading.current_thread()])
        self.assertNotIn(handle, [conn for _, conn in surviving])
        self.assertEqual(store.connects, 2)
        ledger.close()

    def test_overflow_from_live_threads_closes_real_sessions(self) -> None:
        """The cap has to bound SESSIONS, not cache entries. Forgetting an
        overflow handle owned by a live thread bounds nothing: the thread keeps
        writing through it and the server keeps the session — this is the
        hosted-Postgres connection-exhaustion path in miniature."""
        store = StubPostgresStore()
        ledger = ToolCallLedger(store=store, env={})
        written = threading.Semaphore(0)
        release = threading.Event()

        def worker() -> None:
            ledger.record(tool="claim.list", source="mcp", arguments={})
            written.release()
            release.wait(timeout=5)  # every owner stays ALIVE across the trim

        workers = [threading.Thread(target=worker, daemon=True) for _ in range(5)]
        with mock.patch.object(ledger_module, "LEDGER_MAX_CACHED_CONNECTIONS", 2):
            for thread in workers:  # one at a time: the cache, not the lock
                thread.start()
                self.assertTrue(written.acquire(timeout=5))
            cached = len(ledger._handles)  # noqa: SLF001 -- the cache under test
            live = store.live()

        release.set()
        for thread in workers:
            thread.join(timeout=5)

        self.assertEqual(ledger.failures, 0)
        self.assertEqual(len(store.connections), 5)
        self.assertEqual(cached, 2, "the cache is trimmed to the cap, not cap + 1")
        # The three trimmed handles were CLOSED, not merely dropped: what the
        # cache tracks and what the server holds are the same number.
        self.assertEqual(len(live), cached)
        self.assertFalse([c for c in store.connections if c.closed_mid_statement])
        ledger.close()

    def test_a_contended_writer_drops_the_row_instead_of_waiting(self) -> None:
        """Fail-safe LATENCY, not just fail-safe errors: a held writer must
        never make the tool call it observes wait out a database timeout."""
        dropped: list[str] = []
        ledger = ToolCallLedger(store=self.store, env={}, on_failure=dropped.append)
        holding = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with ledger._lock:  # noqa: SLF001 -- the contention under test
                holding.set()
                release.wait(timeout=5)

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.assertTrue(holding.wait(timeout=5))
        started = time.monotonic()
        ledger.record(tool="claim.list", source="mcp", arguments={})
        elapsed = time.monotonic() - started
        release.set()
        holder.join(timeout=5)

        self.assertLess(elapsed, 2.0)  # nowhere near the store's 10s busy timeout
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["tool-call ledger writer is busy"])
        self.assertEqual(self._rows(), [])

    def test_rejection_is_its_own_status(self) -> None:
        self.ledger.reject(
            source="http", error_code="project_scope_forbidden", error="wrong project"
        )
        (row,) = self._rows()
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["tool"], "")
        self.assertEqual(row["error_head"], "wrong project")

    def test_a_broken_ledger_counts_the_drop_and_raises_nothing(self) -> None:
        dropped: list[str] = []

        class BrokenStore:
            def connect(self):
                raise sqlite3.OperationalError("database is locked")

        ledger = ToolCallLedger(
            store=BrokenStore(), env={}, on_failure=dropped.append
        )
        ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["database is locked"])

    def test_prune_deletes_only_expired_rows_and_reports_honestly(self) -> None:
        now = datetime.now(tz=UTC)
        self.ledger.record(tool="claim.list", source="mcp", arguments={})
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO tool_calls (ts, tool, source, status) VALUES (?, ?, ?, ?)",
                ("2020-01-01T00:00:00Z", "ancient", "mcp", "ok"),
            )
        outcome = self.ledger.prune(now=now)
        self.assertEqual(outcome["deleted"], 1)
        self.assertTrue(outcome["ok"])
        self.assertFalse(outcome["more"])
        self.assertEqual([row["tool"] for row in self._rows()], ["claim.list"])
        # A second pass finds nothing, and says so as a healthy zero.
        self.assertEqual(self.ledger.prune(now=now), {
            "deleted": 0, "ok": True, "cutoff": outcome["cutoff"], "more": False
        })

    def test_a_failed_prune_reports_not_ok_rather_than_zero(self) -> None:
        class BrokenStore:
            def connect(self):
                raise sqlite3.OperationalError("no such table: tool_calls")

        outcome = ToolCallLedger(store=BrokenStore(), env={}).prune()
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["deleted"], 0)
        self.assertIn("no such table", outcome["error"])

    def test_a_prune_handle_never_outlives_its_sweep(self) -> None:
        """Retention may not stay off until process restart: a cached sweep
        handle that Postgres closed would have every later hourly tick reuse
        the same corpse. A sweep owns its connection and closes it, so the next
        tick cannot inherit anything — healthy or dead."""
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})
        self._ancient(1)
        self.assertTrue(ledger.prune()["ok"])
        self._ancient(1)
        self.assertEqual(ledger.prune()["deleted"], 1)

        self.assertEqual(store.connects, 2)  # one dial per sweep, never a cache
        for handle in store.handles:
            with self.assertRaises(sqlite3.ProgrammingError):
                handle.execute("SELECT 1")
        self.assertEqual(ledger._handles, {})  # noqa: SLF001 -- retention is not a writer
        ledger.close()

    def test_a_sweep_never_leaves_a_writers_deadline_widened(self) -> None:
        """Operator cleanup calls prune on a synchronous HTTP worker, and the
        next tool call on that worker reuses its connection. A sweep that
        borrowed that handle and failed to hand back the 1s deadline would
        leave an in-path writer able to stall for the retention deadline."""
        store = StubPostgresStore()
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        (writer,) = store.connections

        self.assertTrue(ledger.prune()["ok"])

        sweep = store.connections[-1]
        self.assertIsNot(sweep, writer, "the sweep may not borrow an in-path handle")
        self.assertTrue(sweep.closed)
        self.assertFalse(writer.closed)
        self.assertEqual(
            [s for s in writer.statements if s.startswith("SET SESSION")],
            [
                f"SET SESSION statement_timeout = {LEDGER_STATEMENT_TIMEOUT_MS}",
                f"SET SESSION lock_timeout = {LEDGER_BUSY_TIMEOUT_MS}",
            ],
        )
        self.assertIn(
            f"SET SESSION statement_timeout = {PRUNE_STATEMENT_TIMEOUT_MS}",
            sweep.statements,
        )
        ledger.close()

    def test_shutdown_leaves_an_in_flight_sweep_its_own_connection(self) -> None:
        """The reaper joins for 2s and a sweep may run for 30; psycopg's close()
        does not wait behind a running statement, it finishes the socket under
        one. Shutdown must therefore never hold the sweep's handle at all."""
        stall = Stall()
        store = StubPostgresStore(stall=stall)
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        (writer,) = store.connections

        outcome: list[dict] = []
        sweeper = threading.Thread(target=lambda: outcome.append(ledger.prune()))
        sweeper.start()
        self.assertTrue(stall.entered.wait(timeout=5))
        sweep = store.connections[-1]

        started = time.monotonic()
        ledger.close()  # shutdown, with the sweep parked mid-SELECT
        self.assertLess(time.monotonic() - started, 2.0, "close waited on the sweep")
        self.assertTrue(writer.closed)
        self.assertFalse(sweep.closed, "the sweep's handle is not shutdown's to close")

        stall.release.set()
        sweeper.join(timeout=5)
        self.assertEqual([o["ok"] for o in outcome], [True])
        self.assertTrue(sweep.closed, "the sweep closes its own handle on the way out")
        self.assertFalse([c for c in store.connections if c.closed_mid_statement])

    def test_close_never_pulls_a_handle_from_a_writer_mid_row(self) -> None:
        """The other half of the same rule: a cached handle is only ever used
        under the writer lock, so close() takes that lock as its proof of
        quiescence — and when it cannot get it, forgets rather than closes."""
        store = StubPostgresStore()
        ledger = ToolCallLedger(store=store, env={})
        holding = threading.Event()
        release = threading.Event()

        def writer_thread() -> None:
            ledger.record(tool="claim.list", source="mcp", arguments={})
            with ledger._lock:  # noqa: SLF001 -- stands in for a row mid-flight
                holding.set()
                release.wait(timeout=5)

        holder = threading.Thread(target=writer_thread, daemon=True)
        holder.start()
        self.assertTrue(holding.wait(timeout=5))
        (writer,) = store.connections

        with mock.patch.object(ledger_module, "LEDGER_CLOSE_TIMEOUT_SECONDS", 0.1):
            ledger.close()
        self.assertFalse(writer.closed, "a live writer's socket is not cut mid-row")

        release.set()
        holder.join(timeout=5)
        self.assertFalse(writer.closed_mid_statement)

    def test_the_ledger_writes_and_prunes_again_once_the_database_recovers(
        self,
    ) -> None:
        """Recovery for real, not merely a counted failure: the table comes
        back and both paths work on the connection the ledger re-dialed."""
        ledger = ToolCallLedger(store=self.store, env={})
        ledger.record(tool="claim.list", source="mcp", arguments={})
        with self.store.transaction() as conn:
            conn.execute("DROP TABLE tool_calls")
        ledger.record(tool="claim.list", source="mcp", arguments={})
        self.assertFalse(ledger.prune()["ok"])
        self.assertEqual(ledger.failures, 2)

        StateStore(db_path=self.db_path)  # the table is back

        ledger.record(tool="claim.list", source="mcp", arguments={})
        self._ancient(1)
        outcome = ledger.prune()
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["deleted"], 1)
        self.assertEqual([row["tool"] for row in self._rows()], ["claim.list"])
        self.assertEqual(ledger.failures, 2, "no new drops after recovery")
        ledger.close()

    def test_retention_is_env_overridable_and_never_collapses_to_zero(self) -> None:
        self.assertEqual(
            ToolCallLedger(store=self.store, env={}).retention_days,
            DEFAULT_RETENTION_DAYS,
        )
        self.assertEqual(
            ToolCallLedger(
                store=self.store, env={TOOL_CALL_RETENTION_DAYS_ENV_VAR: "7"}
            ).retention_days,
            7,
        )
        for hostile in ("0", "-5", "not-a-number"):
            with self.subTest(value=hostile):
                ledger = ToolCallLedger(
                    store=self.store, env={TOOL_CALL_RETENTION_DAYS_ENV_VAR: hostile}
                )
                self.assertGreaterEqual(ledger.retention_days, 1)

    def _ancient(self, count: int) -> None:
        with self.store.transaction() as conn:
            for index in range(count):
                conn.execute(
                    "INSERT INTO tool_calls (ts, tool, source, status) "
                    "VALUES (?, ?, ?, ?)",
                    ("2020-01-01T00:00:00Z", f"ancient-{index}", "mcp", "ok"),
                )

    def test_one_sweep_batches_until_the_horizon_is_clear(self) -> None:
        """A single 20k batch per pass cannot outrun a call rate that mints
        more than that a day; the sweep loops instead of merely saying `more`."""
        self._ancient(5)
        with mock.patch.object(ledger_module, "PRUNE_BATCH_ROWS", 2):
            outcome = self.ledger.prune()
        self.assertEqual(outcome["deleted"], 5)
        self.assertFalse(outcome["more"])
        self.assertEqual(self._rows(), [])

    def test_the_batch_bound_is_honored_and_reports_the_backlog(self) -> None:
        self._ancient(5)
        with mock.patch.object(ledger_module, "PRUNE_BATCH_ROWS", 2):
            outcome = self.ledger.prune(max_batches=1)
        self.assertEqual(outcome["deleted"], 2)
        self.assertTrue(outcome["more"])
        self.assertEqual(len(self._rows()), 3)

    def test_a_full_batch_that_empties_the_horizon_reports_no_more(self) -> None:
        """`more` is the state of the table, not `deleted >= batch size`."""
        self._ancient(2)
        with mock.patch.object(ledger_module, "PRUNE_BATCH_ROWS", 2):
            outcome = self.ledger.prune(max_batches=1)
        self.assertEqual(outcome["deleted"], 2)
        self.assertFalse(outcome["more"])

    def test_prune_keeps_rows_inside_the_horizon(self) -> None:
        self.ledger.record(tool="claim.list", source="mcp", arguments={})
        just_inside = datetime.now(tz=UTC) + timedelta(
            days=DEFAULT_RETENTION_DAYS - 1
        )
        self.assertEqual(self.ledger.prune(now=just_inside)["deleted"], 0)
        self.assertEqual(len(self._rows()), 1)


if __name__ == "__main__":
    unittest.main()
