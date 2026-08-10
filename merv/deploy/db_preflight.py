#!/usr/bin/env python3
"""Validate a PostgreSQL target before Merv applies startup migrations.

The check is intentionally provider-neutral: ordinary PostgreSQL, hosted
Supabase, and self-hosted Supabase all enter Merv through MERV_DB_URL.
Passwords and the full DSN are never printed.
"""

from __future__ import annotations

import argparse
import os
import secrets
import sys
from urllib.parse import urlsplit


class PreflightError(RuntimeError):
    """A database setting that is unsafe or incompatible with Merv."""


def _target(dsn: str) -> tuple[str, int | None, str]:
    parsed = urlsplit(dsn)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise PreflightError("MERV_DB_URL must be a postgres:// or postgresql:// URL")
    try:
        port = parsed.port
    except ValueError as exc:
        raise PreflightError("MERV_DB_URL contains an invalid port") from exc
    database = parsed.path.removeprefix("/") or "postgres"
    return parsed.hostname, port, database


def _check(*, dsn: str, require_tls: bool) -> list[str]:
    host, port, configured_database = _target(dsn)
    if port == 6543:
        raise PreflightError(
            "Supabase port 6543 is the transaction pooler; Merv requires the "
            "direct connection or session pooler because it uses session advisory locks"
        )

    try:
        import psycopg
        from psycopg import sql
    except ImportError as exc:  # pragma: no cover - depends on operator environment
        raise PreflightError(
            "psycopg is unavailable; run this from the Merv control image or install "
            "the control extra"
        ) from exc

    checks: list[str] = []
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            row = conn.execute(
                """
                SELECT current_database(), current_user, current_schema(),
                       current_setting('transaction_read_only'),
                       current_setting('server_version')
                """
            ).fetchone()
            database, user, schema, read_only, server_version = row
            if read_only != "off":
                raise PreflightError("database connection is read-only")
            if schema != "public":
                raise PreflightError(
                    f"current schema is {schema!r}; Merv currently requires the public schema"
                )
            checks.append(
                f"connection host={host} port={port or 5432} "
                f"database={database} user={user} PostgreSQL={server_version}"
            )
            if database != configured_database:
                checks.append(
                    f"server selected database={database} (URL path named {configured_database})"
                )

            can_use, can_create = conn.execute(
                """
                SELECT has_schema_privilege(current_user, 'public', 'USAGE'),
                       has_schema_privilege(current_user, 'public', 'CREATE')
                """
            ).fetchone()
            if not can_use or not can_create:
                raise PreflightError(
                    "application role needs USAGE and CREATE on schema public so startup "
                    "migrations can create and alter Merv-owned tables"
                )
            checks.append("schema public: USAGE and CREATE granted")

            tls = bool(
                conn.execute(
                    "SELECT COALESCE((SELECT ssl FROM pg_stat_ssl "
                    "WHERE pid = pg_backend_pid()), false)"
                ).fetchone()[0]
            )
            if require_tls and not tls:
                raise PreflightError("TLS is required but this database session is not encrypted")
            checks.append(f"TLS: {'enabled' if tls else 'not enabled (allowed by this run)'}")

            lock_key = secrets.randbits(62)
            locked = bool(
                conn.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,)).fetchone()[0]
            )
            if not locked:
                raise PreflightError("could not acquire a session advisory lock")
            try:
                held = bool(
                    conn.execute(
                        """
                        SELECT EXISTS (
                          SELECT 1 FROM pg_locks
                          WHERE pid = pg_backend_pid()
                            AND locktype = 'advisory'
                            AND granted
                        )
                        """
                    ).fetchone()[0]
                )
                if not held:
                    raise PreflightError(
                        "session advisory lock did not survive a round trip; use a direct "
                        "connection or session pooler, not transaction pooling"
                    )
            finally:
                conn.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
            checks.append("session advisory locks: supported")

            probe = f"merv_preflight_{os.getpid()}_{secrets.token_hex(4)}"
            conn.execute("BEGIN")
            try:
                conn.execute(
                    sql.SQL("CREATE TABLE public.{} (id bigint PRIMARY KEY)").format(
                        sql.Identifier(probe)
                    )
                )
                conn.execute(
                    sql.SQL("ALTER TABLE public.{} ADD COLUMN checked boolean").format(
                        sql.Identifier(probe)
                    )
                )
                conn.execute(sql.SQL("DROP TABLE public.{}").format(sql.Identifier(probe)))
            finally:
                conn.execute("ROLLBACK")
            checks.append("transactional CREATE/ALTER/DROP: supported")

            migration_table = bool(
                conn.execute(
                    "SELECT to_regclass('public.schema_migrations') IS NOT NULL"
                ).fetchone()[0]
            )
            if migration_table:
                owner = conn.execute(
                    """
                    SELECT pg_get_userbyid(c.relowner)
                    FROM pg_class c
                    WHERE c.oid = 'public.schema_migrations'::regclass
                    """
                ).fetchone()[0]
                if owner != user:
                    raise PreflightError(
                        f"schema_migrations is owned by {owner!r}, not the application "
                        f"role {user!r}; Merv may be unable to alter existing tables"
                    )
                version = conn.execute(
                    "SELECT COALESCE(MAX(version), 0) FROM public.schema_migrations"
                ).fetchone()[0]
                checks.append(f"existing Merv schema: migration {version}, owner={owner}")
            else:
                checks.append("existing Merv schema: none (startup will initialize it)")
    except PreflightError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise PreflightError(f"database check failed: {type(exc).__name__}: {exc}") from exc
    return checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-tls",
        action="store_true",
        help="Fail unless the active database connection is encrypted (recommended when hosted).",
    )
    args = parser.parse_args(argv)
    dsn = os.environ.get("MERV_DB_URL", "").strip()
    if not dsn:
        print("[FAIL] MERV_DB_URL is empty", file=sys.stderr)
        return 2
    try:
        checks = _check(dsn=dsn, require_tls=args.require_tls)
    except PreflightError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 1
    for check in checks:
        print(f"[ok] {check}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
