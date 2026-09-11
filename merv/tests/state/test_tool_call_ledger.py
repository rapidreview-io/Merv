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
from merv.brain.kernel.state.activity import (
    LEDGER_LABEL_MAX_CHARS,
    ToolCallRecord,
    register_activity_vocabulary,
)
from merv.brain.research_core import ACTIVITY_VOCABULARY

# Research names its own argument fields; Surface registers them before it
# builds anything that can log. A ledger built without composition, as these
# tests do, has to say so itself.
register_activity_vocabulary(**ACTIVITY_VOCABULARY)
from merv.brain.kernel.state.store import StateStore
from tests.support.schema import booted_store
from merv.brain.kernel.state.tool_call_ledger import (
    DEFAULT_RETENTION_DAYS,
    LEDGER_BUSY_TIMEOUT_MS,
    LEDGER_STATEMENT_TIMEOUT_MS,
    PRUNE_STATEMENT_TIMEOUT_MS,
    TOOL_CALL_RETENTION_DAYS_ENV_VAR,
    ToolCallLedger,
)


def _call(**facts) -> ToolCallRecord:
    """One shaped tool-call record, the only thing the ledger accepts."""
    return ToolCallRecord(**{"tool": "claim.list", "source": "mcp", **facts})


class CountingStore:
    """A store that reports how many connections the ledger actually opened."""

    def __init__(self, store: StateStore) -> None:
        self._store = store
        self.connects = 0
        self.handles: list = []

    def dial(self):
        self.connects += 1
        conn = self._store.dial()
        self.handles.append(conn)
        return conn


class StubPostgresConnection:
    """A connection that speaks SET SESSION and rejects PRAGMA, as PG does.

    The hosted dialect is the one this module's deadlines exist for and the one
    no test database can be, so it is stood in for at the connection seam.
    """

    def __init__(self, *, fail_write: str = "") -> None:
        self.statements: list[str] = []
        self.closed = False
        self._fail_write = fail_write

    def execute(self, sql, parameters=()):
        statement = " ".join(str(sql).split())
        if statement.startswith("PRAGMA"):
            raise RuntimeError('syntax error at or near "PRAGMA"')
        self.statements.append(statement)
        if self._fail_write and statement.startswith("INSERT"):
            raise RuntimeError(self._fail_write)
        return self

    def fetchone(self):
        return None

    def commit(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class StubPostgresStore:
    def __init__(self, *, fail_write: str = "") -> None:
        self.connections: list[StubPostgresConnection] = []
        self._fail_write = fail_write

    def dial(self) -> StubPostgresConnection:
        conn = StubPostgresConnection(fail_write=self._fail_write)
        self.connections.append(conn)
        return conn

# The read-path indexes the kernel DDL declares over the ledger and the event
# log beside it. Losing one is a silent full scan, not a failure, so the names
# are asserted rather than inferred.
LEDGER_INDEX_NAMES = frozenset(
    {
        "idx_tool_calls_project",
        "idx_tool_calls_status",
        "idx_tool_calls_tool",
        "idx_tool_calls_agent",
        "idx_events_project",
        "idx_events_target",
    }
)


class ToolCallLedgerSchemaTest(unittest.TestCase):
    def test_a_fresh_database_gets_the_ledger_and_every_read_path_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = booted_store(db_path=Path(tmp) / "state.sqlite")
            with store.transaction() as conn:
                columns = {
                    str(row["name"])
                    for row in conn.execute("PRAGMA table_info(tool_calls)").fetchall()
                }
                indexes = {
                    str(row["name"])
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    ).fetchall()
                }
        self.assertEqual(
            columns,
            {
                "id", "ts", "request_id", "principal_id", "tool", "source",
                "project_id", "target_type", "target_id", "status",
                "error_code", "error_head", "duration_ms", "sent_chars",
                "received_chars", "args_digest",
                # Agent attribution + payload key.
                "agent_id", "mcp_session_id", "payload_ref",
            },
        )
        self.assertLessEqual(LEDGER_INDEX_NAMES, indexes)


class ToolCallLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "state.sqlite"
        self.store = booted_store(db_path=self.db_path)
        self.ledger = ToolCallLedger(store=self.store, env={})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _rows(self, ledger: ToolCallLedger | None = None) -> list[dict[str, object]]:
        self.assertTrue((ledger or self.ledger).flush())
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
            self.ledger.record(_call(
                tool="experiment.get_state",
                duration_ms=17,
                arguments={"project_id": "proj_1", "experiment_id": "exp_1"},
                result={"status": "running"},
            ))
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
        self.ledger.record(_call(
            tool="review.submit",
            status="error",
            duration_ms=3,
            arguments={"project_id": "proj_1"},
            error="gate refused: " + "x" * 500 + "\nstack frame that never lands",
            error_code="review_gate",
        ))
        (row,) = self._rows()
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["error_code"], "review_gate")
        head = str(row["error_head"])
        self.assertEqual(len(head), 200)
        self.assertTrue(head.startswith("gate refused: "))
        self.assertNotIn("stack frame", head)

    def test_secrets_never_reach_the_row_or_its_digest(self) -> None:
        secret = {"project_id": "proj_1", "reviewer_capability": "rp_supersecret"}
        self.ledger.record(_call(tool="review.start", arguments=secret))
        redacted = dict(secret, reviewer_capability="[redacted]")
        self.ledger.record(_call(tool="review.start", arguments=redacted))
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
        """A prefixed value is a credential however short its tail. The
        verifier accepts an ``mk_`` key by PREFIX alone, and the scrubber still
        covers RapidReview ``rr_sk_`` keys that reach a payload as text."""
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
        self.ledger.record(_call(
            tool="project", source="http", status="error", error=f"bad token {token}"
        ))
        (row,) = self._rows()
        self.assertNotIn(token, str(row["error_head"]))
        self.assertIn("<redacted>", str(row["error_head"]))

    def test_the_writer_opens_one_connection_and_reuses_it(self) -> None:
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})
        for _ in range(5):
            ledger.record(_call())
        self.assertEqual(len(self._rows(ledger)), 5)
        self.assertEqual(store.connects, 1)
        ledger.close()

    def test_a_failed_write_drops_its_connection_and_reconnects(self) -> None:
        store = CountingStore(self.store)
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        with self.store.transaction() as conn:
            conn.execute("DROP TABLE tool_calls")
        ledger.record(_call())
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        self.assertEqual(ledger.failures, 2)
        # One dial, then exactly one re-dial: the handle that failed was
        # dropped with the row, and no later row re-dials needlessly.
        self.assertEqual(store.connects, 2)
        ledger.close()

    def test_a_postgres_connection_gets_lock_and_statement_deadlines_at_open(
        self,
    ) -> None:
        """The bound has to cover the DATABASE: on hosted Postgres a held lock
        would otherwise park the writer thread, and the queue behind it, on a
        single row until the server gave up."""
        store = StubPostgresStore()
        ledger = ToolCallLedger(store=store, env={})
        ledger.record(_call())
        self.assertTrue(ledger.flush())
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
        ledger.record(_call())
        self.assertTrue(ledger.flush())
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

            def dial(self) -> DeadlinelessConnection:
                conn = DeadlinelessConnection()
                self.connections.append(conn)
                return conn

        dropped: list[str] = []
        store = DeadlinelessStore()
        ledger = ToolCallLedger(store=store, env={}, on_failure=dropped.append)
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["no such setting"])
        (conn,) = store.connections
        self.assertTrue(conn.closed, "a refused handle is not left dangling")

    def test_the_sqlite_ledger_connection_carries_its_own_busy_timeout(self) -> None:
        """Set on the LEDGER's connection as part of opening it, not left to a
        generic pragma pass that hands out the record store's patient 10s."""
        conn = self.ledger._dial(  # noqa: SLF001 -- opening is what is under test
            statement_timeout_ms=LEDGER_STATEMENT_TIMEOUT_MS
        )
        store_conn = self.store.connect()
        try:
            self.assertEqual(
                conn.execute("PRAGMA busy_timeout").fetchone()[0], LEDGER_BUSY_TIMEOUT_MS
            )
            self.assertEqual(
                store_conn.execute("PRAGMA busy_timeout").fetchone()[0], 10_000
            )
        finally:
            conn.close()
            store_conn.close()

    def test_a_backed_up_writer_drops_the_row_instead_of_waiting(self) -> None:
        """Fail-safe LATENCY, not just fail-safe errors: a database that has
        stopped answering must cost the call it observes nothing at all."""
        dropped: list[str] = []
        wedged = threading.Event()
        release = threading.Event()

        class WedgedStore:
            def dial(self):
                wedged.set()
                release.wait(timeout=5)
                raise sqlite3.OperationalError("database is locked")

        with mock.patch.object(ledger_module, "LEDGER_QUEUE_ROWS", 1):
            ledger = ToolCallLedger(
                store=WedgedStore(), env={}, on_failure=dropped.append
            )
            ledger.record(_call())  # the writer takes this one and wedges on it
            self.assertTrue(wedged.wait(timeout=5))
            ledger.record(_call())  # fills the one waiting slot
            started = time.monotonic()
            ledger.record(_call())  # nowhere to go: dropped, never waited on
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 2.0)  # nowhere near the store's 10s timeout
            self.assertEqual(dropped, ["tool-call ledger queue is full"])
            self.assertEqual(ledger.failures, 1)
        release.set()
        ledger.close()

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
            def dial(self):
                raise sqlite3.OperationalError("database is locked")

        ledger = ToolCallLedger(
            store=BrokenStore(), env={}, on_failure=dropped.append
        )
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        self.assertEqual(ledger.failures, 1)
        self.assertEqual(dropped, ["database is locked"])

    def test_prune_deletes_only_expired_rows_and_reports_honestly(self) -> None:
        now = datetime.now(tz=UTC)
        self.ledger.record(_call())
        self.assertTrue(self.ledger.flush())
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
            def dial(self):
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
        ledger.close()

    def test_the_ledger_writes_and_prunes_again_once_the_database_recovers(
        self,
    ) -> None:
        """Recovery for real, not merely a counted failure: the table comes
        back and both paths work on the connection the ledger re-dialed."""
        ledger = ToolCallLedger(store=self.store, env={})
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        with self.store.transaction() as conn:
            conn.execute("DROP TABLE tool_calls")
        ledger.record(_call())
        self.assertTrue(ledger.flush())
        self.assertFalse(ledger.prune()["ok"])
        self.assertEqual(ledger.failures, 2)

        booted_store(db_path=self.db_path)  # the table is back

        ledger.record(_call())
        self.assertTrue(ledger.flush())
        self._ancient(1)
        outcome = ledger.prune()
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["deleted"], 1)
        self.assertEqual([row["tool"] for row in self._rows(ledger)], ["claim.list"])
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
        self.ledger.record(_call())
        self.assertTrue(self.ledger.flush())
        just_inside = datetime.now(tz=UTC) + timedelta(
            days=DEFAULT_RETENTION_DAYS - 1
        )
        self.assertEqual(self.ledger.prune(now=just_inside)["deleted"], 0)
        self.assertEqual(len(self._rows()), 1)


if __name__ == "__main__":
    unittest.main()
