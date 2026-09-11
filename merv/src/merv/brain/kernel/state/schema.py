"""Component-owned schema: DDL modules and the ladder above the baseline.

Every component declares one ``SchemaModule``: the idempotent DDL for the
tables it owns, plus any numbered ``Migration`` steps that carry an existing
database past that shape. ``BaseStateStore.install`` executes the DDL and
drives the ladder; the numbering is global because one ``schema_migrations``
ledger records it, which is why kernel owns ``MIGRATION_ORDER`` and nothing
else about a component's tables.

The ladder has a floor. Versions 1..``BASELINE_VERSION`` were squashed into
the DDL once every live database had reached that head: the DDL alone now
states the shape, a fresh install stamps the baseline row, and a database
already at it applies only what came after.
"""

from __future__ import annotations

import re
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


# The squashed ladder's floor: the head every live database had reached when
# versions 1..64 collapsed into the DDL above. A fresh install records it once
# as the ``baseline`` row so later steps apply relative to it; a database that
# already carries it is left alone.
BASELINE_VERSION = 64

# The ladder above the baseline. A component that adds a migration appends its
# version here and the handler to its own module. A version whose owner has
# not installed is skipped, not refused: every handler is guarded on the
# tables it touches, so the next install converges it.
# 71-79 are research's numbers and 80-89 support's, so parallel work never collides.
MIGRATION_ORDER: tuple[int, ...] = (65, 66, 67, 68, 69, 70, 71, 80)


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


def has_column(conn: Connection, table: str, column: str) -> bool:
    """Whether ``table`` still carries ``column`` — the guard a drop step runs."""
    if getattr(conn, "dialect", "sqlite") == "postgres":
        return conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
            "AND table_name = ? AND column_name = ?",
            (table, column),
        ).fetchone() is not None
    return any(
        str(row["name"]) == column
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    )


def has_table(conn: Connection, table: str) -> bool:
    """Whether ``table`` exists — the guard every install pass runs first."""
    if getattr(conn, "dialect", "sqlite") == "postgres":
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = ?",
            (table,),
        ).fetchone()
        return row is not None
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None
