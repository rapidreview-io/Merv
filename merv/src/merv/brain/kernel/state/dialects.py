"""Postgres dialect for the brain record store.

``PostgresStateStore`` serves the exact surface the services were written
against on SQLite: ``connect()`` returns a connection whose ``execute``
accepts ``?`` placeholders and returns mapping rows, and ``transaction()``
yields one under single-writer semantics. The seam is deliberately thin —
a string-level placeholder translation (the codebase never uses ``?`` or
``%`` inside SQL string literals; tests/state/test_postgres_dialect.py keeps
that invariant honest) plus a DDL translation of each component's schema
module as it installs.

Single-writer semantics: SQLite gets them from ``BEGIN IMMEDIATE``; here a
``pg_advisory_xact_lock`` keyed on the DSN serializes every write transaction.
The UI's recent activity/tool-I/O rings are process-local diagnostics and are
not part of this record-store dialect.

psycopg is imported lazily so SQLite-backed test and development compositions
do not import it.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator, Sequence
from contextlib import contextmanager, suppress
from types import TracebackType
from typing import Any

from .persistence import KERNEL_SCHEMA
from .schema import Connection
from .store import BaseStateStore


def translate_schema_to_postgres(schema_sql: str) -> str:
    """A component's SQLite schema module rendered as Postgres DDL.

    Translation rules (everything else — CREATE TABLE IF NOT EXISTS, TEXT,
    constraints, ``--`` comments — is already valid on both):

    - PRAGMA lines are SQLite-only; dropped.
    - ``CREATE VIEW IF NOT EXISTS`` is SQLite's spelling of an idempotent
      view; Postgres spells the same thing ``CREATE OR REPLACE VIEW``.
    - ``INTEGER PRIMARY KEY AUTOINCREMENT`` (events.id) becomes a BIGINT
      identity column (plan §3.1: "identity column for events").
    - ``INTEGER`` becomes ``BIGINT``: SQLite INTEGER is 64-bit while Postgres
      INTEGER is 32-bit, and nanosecond-scale counters overflow 32 bits today.
    - ``REAL`` becomes ``DOUBLE PRECISION`` (SQLite REAL is an 8-byte float;
      Postgres REAL is only 4).
    - BLOB is unused (verified; guarded below so it stays that way until the
      translation learns a mapping for it).
    """
    if re.search(r"\bBLOB\b", schema_sql):
        raise ValueError(
            "a schema module grew a BLOB column; teach translate_schema_to_postgres "
            "the BYTEA mapping before using it"
        )
    lines = [
        line
        for line in schema_sql.splitlines()
        if not line.strip().upper().startswith("PRAGMA")
    ]
    sql = "\n".join(lines)
    sql = sql.replace("CREATE VIEW IF NOT EXISTS", "CREATE OR REPLACE VIEW")
    sql = sql.replace(
        "INTEGER PRIMARY KEY AUTOINCREMENT",
        "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
    )
    sql = re.sub(r"\bINTEGER\b", "BIGINT", sql)
    sql = re.sub(r"\bREAL\b", "DOUBLE PRECISION", sql)
    return sql


class PostgresConnection:
    """sqlite3-shaped facade over one psycopg connection.

    Translates ``?`` placeholders to ``%s`` at the string level (safe: no SQL
    in the codebase puts ``?`` or ``%`` inside a string literal) and leaves
    row shaping to psycopg's ``dict_row`` factory, whose dicts satisfy the
    same ``row["col"]`` / ``row.keys()`` access the services use on
    ``sqlite3.Row``. The underlying connection runs in autocommit; explicit
    transactions are driven by ``PostgresStateStore.transaction()`` via BEGIN.
    """

    # Read by kernel.state.schema.is_sqlite; every other connection in the
    # codebase is a sqlite3 one, or a test wrapper that delegates to one.
    dialect = "postgres"

    def __init__(self, raw: Any) -> None:
        self._raw = raw

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> Any:
        translated = sql.replace("?", "%s")
        if parameters:
            return self._raw.execute(translated, tuple(parameters))
        # No parameters: skip psycopg's client-side processing entirely so
        # multi-statement strings (a translated schema module — the executescript
        # analog) execute in one round trip.
        return self._raw.execute(translated)

    def __enter__(self) -> Connection:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc_type is None:
            self.commit()
        else:
            self.rollback()

    def commit(self) -> None:
        # Autocommit means reads/writes outside transaction() are already
        # durable; an explicit BEGIN (transaction()) commits through here.
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        self._raw.close()


class PostgresStateStore(BaseStateStore):
    """The Postgres dialect — the cloud control plane's record store.

    Differences from the SQLite dialect, all deliberate:

    - No default-project bootstrap: that is local-mode behavior (one machine,
      one implicit project); control-plane projects are created explicitly
      per tenant (plan §3.1).
    - No introspective legacy convergence (``_ensure_columns`` and friends):
      there are no pre-ledger Postgres databases. Fresh DDL plus the ordered
      ``schema_migrations`` ledger is the entire story.
    """

    def __init__(self, *, dsn: str) -> None:
        self.dsn = dsn
        # One advisory-lock key per database identity: every store pointed at
        # this DSN serializes its write transactions on the same key. Hashing
        # the DSN string is deliberately coarse (two spellings of the same
        # database would not contend) — fine while the control plane is the
        # only writer; see the module docstring for the FOR UPDATE follow-up.
        self._advisory_lock_key = int.from_bytes(
            hashlib.sha256(dsn.encode("utf-8")).digest()[:8], "big", signed=True
        )
        self._initialize()

    def connect(self) -> Connection:
        psycopg, dict_row = _psycopg()
        raw = psycopg.connect(self.dsn, row_factory=dict_row, autocommit=True)
        return PostgresConnection(raw)

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN")
            # SQLite's BEGIN IMMEDIATE emulated: one writer per database at a
            # time, lock released automatically at COMMIT/ROLLBACK.
            conn.execute(
                "SELECT pg_advisory_xact_lock(?)", (self._advisory_lock_key,)
            )
            yield conn
            conn.execute("COMMIT")
        except Exception:
            with suppress(Exception):  # connection may already be dead
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    @contextmanager
    def _migration_scope(self, *, conn: Any) -> Iterator[None]:
        """One migration + its ledger row commit or roll back together —
        autocommit connections would otherwise persist half a migration."""
        conn.execute("BEGIN")
        try:
            yield
            conn.execute("COMMIT")
        except Exception:
            with suppress(Exception):
                conn.execute("ROLLBACK")
            raise

    def _translate_ddl(self, ddl: str) -> str:
        return translate_schema_to_postgres(ddl)

    @contextmanager
    def _schema_transaction(self) -> Iterator[Connection]:
        """Install/migrate scope: an autocommit connection under the session
        advisory lock (same key as transaction()), so concurrent replicas
        booting the same upgrade serialize their check-then-ALTER passes
        instead of crashing on duplicate-column/duplicate-key errors. Each
        migration commits inside _migration_scope."""
        conn = self.connect()
        try:
            conn.execute("SELECT pg_advisory_lock(?)", (self._advisory_lock_key,))
            try:
                yield conn
            finally:
                conn.execute("SELECT pg_advisory_unlock(?)", (self._advisory_lock_key,))
        finally:
            conn.close()

    def _initialize(self) -> None:
        self.install(KERNEL_SCHEMA)


def _psycopg() -> tuple[Any, Any]:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:  # pragma: no cover — environment-dependent
        raise RuntimeError(
            "PostgresStateStore requires psycopg (pip install 'psycopg[binary]'); "
            "it is a control-profile/test dependency — local mode never needs it"
        ) from exc
    return psycopg, dict_row


__all__ = [
    "PostgresConnection",
    "PostgresStateStore",
    "translate_schema_to_postgres",
]
