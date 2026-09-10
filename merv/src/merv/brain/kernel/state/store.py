"""Record-store state management: dialect-neutral base + the SQLite dialect.

``BaseStateStore`` defines the contract the services were written against;
``StateStore`` (= ``SqliteStateStore``) is the local-mode SQLite dialect and
the historical default. The Postgres dialect for the cloud control plane
lives in ``dialects.py`` (cloud plan Phase 6).

Tables belong to components, not to this file: each declares a
``SchemaModule`` in its own ``persistence`` module and hands it to
``install``, which runs the idempotent DDL and then the numbered ladder in
``schema.MIGRATION_ORDER``. Kernel's own tables live in ``persistence.py``
beside this one.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator, Mapping
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

from ..events import StoredEvent
from ..utils import NotFoundError, ValidationError
from ..utils import new_id
from ..utils import now_iso
from .persistence import KERNEL_SCHEMA, record_event
from .schema import (
    MIGRATION_ORDER,
    Connection,
    Migration,
    ResultCursor,
    Row,
    SchemaModule,
    declared_tables,
    has_table,
    statements,
)


class BaseStateStore:
    """Dialect-neutral record-store contract and shared persistence helpers.

    The dialect seam (cloud plan Phase 6): subclasses own connections and
    transaction semantics, but must present the same surface the services
    were written against — ``connect()`` returns a connection whose
    ``execute`` accepts ``?`` placeholders and whose rows are mappings
    (``row["col"]`` + ``.keys()``), and ``transaction()`` yields such a
    connection under single-writer semantics. Everything here is plain SQL
    that runs unchanged on both dialects.
    """

    _modules: dict[str, SchemaModule]
    _migrations: dict[int, Migration]

    def connect(self) -> Connection:
        raise NotImplementedError

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        raise NotImplementedError

    @contextmanager
    def _schema_transaction(self) -> Iterator[Connection]:
        """A connection that may reshape tables — see the SQLite override."""
        with self.transaction() as conn:
            yield conn

    @contextmanager
    def _migration_scope(self, *, conn: Connection) -> Iterator[None]:
        """Atomicity for one migration + its ledger row. SQLite already runs
        the pass inside _schema_transaction's BEGIN IMMEDIATE, so the base is
        a no-op; the Postgres dialect (autocommit connections) overrides."""
        yield

    def _translate_ddl(self, ddl: str) -> str:
        """Dialect rendering of a module's DDL. SQLite is the source form."""
        return ddl

    def install(self, module: SchemaModule) -> None:
        """Create ``module``'s tables and advance the ladder as far as it can.

        On a database that already holds some of this module's tables the
        ladder runs first: it may still have to rename or rekey them, and an
        idempotent CREATE TABLE landing before that would strand their rows
        beside an empty twin. On a database that holds none of them the DDL
        goes first, because those same steps create tables whose foreign keys
        Postgres validates against tables only the DDL brings. Re-installing
        an already installed module skips the DDL and keeps only the ladder
        pass, so an operator (or a test) can rewind the ledger and re-converge.
        """
        if not hasattr(self, "_modules"):
            self._modules = {}
            self._migrations = {}
        fresh = self._modules.setdefault(module.name, module) is module
        for migration in module.migrations:
            self._migrations[migration.version] = migration
        with self._schema_transaction() as conn:
            if any(has_table(conn, table) for table in declared_tables(module.ddl)):
                self._apply_migrations(conn=conn)
            if fresh:
                for statement in statements(self._translate_ddl(module.ddl)):
                    conn.execute(statement)
            self._apply_migrations(conn=conn)

    def _apply_migrations(self, *, conn: Connection) -> None:
        """Apply unapplied ledger migrations in order, recording each."""
        if not has_table(conn, "schema_migrations"):
            return  # the pre-DDL pass of kernel's own install
        applied = {
            int(row["version"])
            for row in conn.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for version in MIGRATION_ORDER:
            if version in applied:
                continue
            migration = self._migrations.get(version)
            if migration is None:
                # Its owner has not installed yet. Every handler is guarded on
                # the tables it touches, so a later install converges it.
                continue
            with self._migration_scope(conn=conn):
                migration.apply(conn)
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                    (version, migration.name, now_iso()),
                )

    def record_event(
        self,
        *,
        conn: Connection,
        project_id: str,
        event_type: str,
        target_type: str = "",
        target_id: str = "",
        payload: dict[str, Any] | None = None,
    ) -> StoredEvent:
        return record_event(
            conn=conn,
            project_id=project_id,
            event_type=event_type,
            target_type=target_type,
            target_id=target_id,
            payload=payload,
        )

    def require_project_id(
        self,
        *,
        conn: Connection,
        project_id: str | None,
        tenant_id: str | None = None,
    ) -> str:
        """Resolve and existence-check a project id, optionally tenant-scoped.

        Tenancy enforcement (cloud plan Phase 7): when ``tenant_id`` is given,
        the lookup is scoped to that tenant — a project owned by another tenant
        reads as not-found, so cross-tenant access is denied at the record
        layer. The default (``tenant_id`` unset) is today's behavior exactly, so
        every existing call site is unchanged and local mode (single implicit
        'local' tenant) never threads a tenant.
        """
        if not project_id:
            raise ValidationError("project_id is required")
        if tenant_id is None:
            row = conn.execute(
                "SELECT id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM projects WHERE id = ? AND tenant_id = ?",
                (project_id, tenant_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"project not found: {project_id}")
        return project_id


    def events_since(
        self, *, project_id: str | None, after_id: int, limit: int = 500
    ) -> dict[str, Any]:
        """Ascending tail of the append-only events table — the SSE cursor read."""
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, type, target_type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (project_id, int(after_id), max(1, min(int(limit), 500))),
            ).fetchall()
            events = []
            for row in rows:
                item = row_to_dict(row=row) or {}
                item["payload"] = json.loads(str(item.pop("payload_json", "{}")))
                events.append(item)
            return {"events": events}

    def add_project_member(self, *, project_id: str, user_id: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO project_members (project_id, user_id, added_at)
                VALUES (?, ?, ?)
                ON CONFLICT (project_id, user_id) DO NOTHING
                """,
                (project_id, user_id, now_iso()),
            )

    def remove_project_member(self, *, project_id: str, user_id: str) -> None:
        """Drop one membership, never the last one.

        Every human path into a project — listing, sharing, key minting — keys
        on membership, so emptying the table orphans the project permanently
        with no recovery route (audit AUTH-01). Removing a non-member stays the
        idempotent no-op it has always been.
        """
        with self.transaction() as conn:
            members = {
                str(row["user_id"])
                for row in conn.execute(
                    "SELECT user_id FROM project_members WHERE project_id = ?",
                    (project_id,),
                ).fetchall()
            }
            if members == {user_id}:
                raise ValidationError(
                    f"{user_id} is the only member of {project_id}; add another "
                    "member first — a project with no members can never be "
                    "reached or restored",
                    details={"project_id": project_id, "user_id": user_id},
                )
            conn.execute(
                "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
                (project_id, user_id),
            )

    def is_project_member(self, *, project_id: str, user_id: str) -> bool:
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
                (project_id, user_id),
            ).fetchone()
            return row is not None

    def list_project_members(self, *, project_id: str) -> list[dict[str, Any]]:
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "SELECT user_id, added_at FROM project_members WHERE project_id = ? ORDER BY added_at",
                (project_id,),
            ).fetchall()
            return [row_to_dict(row=row) or {} for row in rows]

    def project_event_signal(self, *, project_id: str | None) -> str:
        """Monotonic per-project signal for the append-only event stream."""
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                """
                SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS count
                FROM events
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
            if row is None:
                return "0:0"
            return f"{int(row['max_id'] or 0)}:{int(row['count'] or 0)}"

    def tenant_event_count(self, *, tenant_id: str) -> int:
        """Count durable project events for one tenant."""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS n
                FROM events e
                JOIN projects p ON p.id = e.project_id
                WHERE p.tenant_id = ?
                """,
                (tenant_id,),
            ).fetchone()
        return int(row["n"]) if row is not None else 0

    def recent_events(
        self, *, project_id: str | None, limit: int = 100
    ) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, type, target_type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (project_id, max(1, min(int(limit), 500))),
            ).fetchall()
            events = []
            for row in rows:
                item = row_to_dict(row=row) or {}
                item["payload"] = json.loads(str(item.pop("payload_json", "{}")))
                events.append(item)
            return {"events": events}


class StateStore(BaseStateStore):
    """The SQLite dialect — local mode's store, and the historical default.

    Records only — the store does not know where a caller's checkout lives.
    The same record layer serves SQLite-backed test composition and hosted
    Postgres without receiving caller filesystem context.
    The Postgres dialect lives in ``dialects.PostgresStateStore``; the name
    ``StateStore`` stays on the SQLite class so every existing call site and
    test keeps working unchanged (``SqliteStateStore`` is an alias).
    """

    def __init__(self, *, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL lets the background reconcile poller read while a submit writes,
        # instead of readers and writers blocking each other (rollback-journal
        # mode upgrades a read lock to write and returns SQLITE_BUSY immediately,
        # which surfaced as "database is locked" on concurrent submits).
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            # IMMEDIATE acquires the write lock up front so busy_timeout governs
            # the wait. A DEFERRED BEGIN takes a read lock first and then fails
            # instantly when it can't upgrade under contention.
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


    @contextmanager
    def _schema_transaction(self) -> Iterator[sqlite3.Connection]:
        """Install/migrate scope: one write lock, foreign keys deferred.

        SQLite can only rebuild a table by copying into a twin and swapping it
        in, which drops a parent out from under its children mid-transaction;
        `PRAGMA foreign_keys` is ignored inside a transaction, so it is set
        here, before BEGIN. Ordinary writes keep enforcement on.
        """
        conn = self.connect()
        try:
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _initialize(self) -> None:
        self.install(KERNEL_SCHEMA)
        with self.transaction() as conn:
            row = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()
            if row is None:
                project_id = new_id(prefix="proj")
                conn.execute(
                    "INSERT INTO projects (id, name, summary, created_at) VALUES (?, ?, ?, ?)",
                    (project_id, "Local Research Project", "", now_iso()),
                )
                self.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="project.created",
                    target_type="project",
                    target_id=project_id,
                    payload={"name": "Local Research Project"},
                )


# primary name stays on the class so call sites and reprs are unchanged.
SqliteStateStore = StateStore


def next_created_seq(*, conn: Connection, table: str) -> int:
    """The next insertion-order value for ``table`` (see created_seq columns).

    MAX+1 inside the caller's open write transaction is race-free under the
    store's single-writer semantics: SQLite's BEGIN IMMEDIATE holds the write
    lock, and the Postgres dialect's transaction() holds the advisory lock,
    so no two writers compute the same value.
    """
    row = conn.execute(
        f"SELECT COALESCE(MAX(created_seq), 0) + 1 AS next_seq FROM {table}"
    ).fetchone()
    return int(row["next_seq"])


def row_to_dict(*, row: Row | Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Plain dict from a row of either dialect (sqlite3.Row or mapping)."""
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def rows_to_dicts(*, rows: Iterable[Row | Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [row_to_dict(row=row) or {} for row in rows]
