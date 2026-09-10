"""Component-owned schema: DDL modules, the numbered ladder, dialect probes.

Every component declares one ``SchemaModule``: the idempotent DDL for the
tables it owns plus the numbered ``Migration`` steps that carry an existing
database to that shape. ``BaseStateStore.install`` executes the DDL and drives
the ladder; the numbering is global because one ``schema_migrations`` ledger
records it, which is why kernel owns ``MIGRATION_ORDER`` and nothing else about
a component's tables.

A migration handler receives only a connection, so the probes and column
helpers it needs live here as functions rather than store methods. They pick
the dialect from the connection, which is also why the Postgres dialect no
longer needs its own copies: a failed ``PRAGMA`` inside an open Postgres
transaction aborts it, and none of these ever issues one.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Protocol


class Row(Protocol):
    """Mapping-shaped database row shared by the SQLite and Postgres dialects."""

    def __getitem__(self, key: str) -> Any: ...

    def keys(self) -> Iterable[str]: ...


class ResultCursor(Protocol):
    """Cursor result surface used by record services."""

    def fetchone(self) -> Row | Mapping[str, Any] | None: ...

    def fetchall(self) -> list[Row | Mapping[str, Any]]: ...


class Connection(Protocol):
    """Small database connection surface exposed through ``BaseStateStore``."""

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> ResultCursor: ...

    def __enter__(self) -> Connection: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...


class MigrationStep(Protocol):
    """What one ladder step does to a database."""

    def __call__(self, conn: Connection) -> None: ...


@dataclass(frozen=True, slots=True)
class Migration:
    """One numbered, once-per-database step, owned by the component it changes."""

    version: int
    name: str
    apply: MigrationStep


@dataclass(frozen=True)
class SchemaModule:
    """One component's tables: idempotent DDL plus its ladder steps."""

    name: str
    ddl: str
    migrations: tuple[Migration, ...] = ()

    def __post_init__(self) -> None:
        _DECLARED[self.name] = self


# Declared modules, by name. Declaration is import time and installation is
# composition time: a migration that has to rebuild another component's table
# reads its shape from here (``table_ddl``) without importing it.
_DECLARED: dict[str, SchemaModule] = {}


# The global ladder order. Versions 55 and 56 were never released. A component
# that adds a migration appends its version here and the handler to its own
# module. A version whose owner has not installed is skipped, not refused:
# every handler is guarded on the tables it touches, so the next install
# converges it.
MIGRATION_ORDER: tuple[int, ...] = (
    *range(1, 55),
    *range(57, 65),
)


def table_ddl(*, table: str, name: str | None = None) -> str:
    """The CREATE TABLE block for ``table``, from whichever module declares it.

    ``name`` renames the created table, which is how the SQLite rebuilds copy
    into a twin before swapping it in.
    """
    for module in _DECLARED.values():
        match = re.search(
            rf"^CREATE TABLE IF NOT EXISTS {table} \((?:.*?)\n\);",
            module.ddl,
            re.DOTALL | re.MULTILINE,
        )
        if match is None:
            continue
        ddl = match.group(0)
        if name is not None:
            ddl = ddl.replace(
                f"CREATE TABLE IF NOT EXISTS {table}", f"CREATE TABLE {name}", 1
            )
        return ddl
    raise RuntimeError(f"no schema module declares table: {table}")


def declared_tables(ddl: str) -> tuple[str, ...]:
    """Every table name a DDL script creates."""
    return tuple(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+) \(", ddl))


def statements(sql: str) -> tuple[str, ...]:
    """Split a DDL script into executable statements.

    Both dialect connections take one statement per call, so the script is cut
    on the semicolons that are neither inside a quoted literal nor inside a
    ``--`` comment. Comments stay attached: SQLite keeps the statement text
    verbatim in ``sqlite_master``.
    """
    chunks: list[str] = []
    current: list[str] = []
    quoted = False
    comment = False
    for index, char in enumerate(sql):
        if comment:
            comment = char != "\n"
        elif quoted:
            quoted = char != "'"
        elif char == "'":
            quoted = True
        elif char == "-" and sql[index : index + 2] == "--":
            comment = True
        elif char == ";":
            chunks.append("".join(current).strip())
            current = []
            continue
        current.append(char)
    tail = "".join(current).strip()
    if tail:
        chunks.append(tail)
    return tuple(chunk for chunk in chunks if chunk)


def is_sqlite(conn: Connection) -> bool:
    """Which dialect this connection speaks.

    The Postgres connection facade says so on itself, and test wrappers
    delegate attribute access, so a wrapped connection answers correctly
    either way. Probing the database instead would mean issuing a statement
    that fails on one of them, and a failed statement aborts an open Postgres
    transaction — which is exactly what a migration pass runs inside.
    """
    return isinstance(conn, sqlite3.Connection) or (
        getattr(conn, "dialect", "sqlite") != "postgres"
    )


def has_table(conn: Connection, table: str) -> bool:
    if is_sqlite(conn):
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        return row is not None
    row = conn.execute(
        "SELECT 1 FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name = ?",
        (table,),
    ).fetchone()
    return row is not None


def has_column(conn: Connection, table: str, column: str) -> bool:
    """False when the column is absent — and when the table itself is.

    A migration may run before the module that owns a table it touches has
    installed; the table then arrives in its final shape, so "not there yet"
    and "already right" both mean the same thing to the caller: do nothing.
    """
    if not has_table(conn, table):
        return False
    if is_sqlite(conn):
        return any(
            str(row["name"]) == column
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        )
    row = conn.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = ? AND column_name = ?",
        (table, column),
    ).fetchone()
    return row is not None


def columns_of(conn: Connection, table: str) -> list[str]:
    if is_sqlite(conn):
        return [
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        ]
    return [
        str(row["column_name"])
        for row in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = ? "
            "ORDER BY ordinal_position",
            (table,),
        ).fetchall()
    ]


def ensure_columns(
    conn: Connection, table: str, columns: Mapping[str, str]
) -> set[str]:
    """Add the missing columns; returns the names actually added."""
    if not has_table(conn, table):
        return set()
    existing = set(columns_of(conn, table))
    added = set()
    for column, definition in columns.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            added.add(column)
    return added


def drop_columns(conn: Connection, table: str, columns: Iterable[str]) -> None:
    """Drop columns that no longer appear in the live schema, if present."""
    if not has_table(conn, table):
        return
    existing = set(columns_of(conn, table))
    for column in columns:
        if column in existing:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
