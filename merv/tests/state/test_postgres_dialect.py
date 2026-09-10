"""Dual-dialect record-store tests against a dockerized Postgres (Phase 6).

The exit criterion of cloud plan Phase 6: the SAME service code passes the
record-layer suites on SQLite (the 442-test local baseline) and on Postgres.
This module supplies the Postgres half:

  (a) the translated SCHEMA + the ordered ledger apply cleanly;
  (b) events identity ordering, artifacts created_seq ordering, the
      artifact-slot supersede path, and the record_event/recent_events
      round trip behave exactly as on SQLite;
  (c) two concurrent transactions serialize (the advisory-lock emulation of
      SQLite's BEGIN IMMEDIATE single-writer semantics).

A ``postgres:16-alpine`` container is started once per module on a random
host port and torn down at module exit. Everything docker-dependent skips
cleanly (fast ``docker info`` probe) when docker is unavailable; the schema
parity tests at the bottom need no docker and always run.

Scope note (per the plan): the behavioral pass covers the record services —
projects/claims/experiments/artifacts/reviews/syntheses/workflow. Sandbox
rows share the dialect-neutral SQL (created_seq, no rowid) but their
behavioral parity rides with Phase 8's split-mode composition, which is when
a control plane actually serves them.
"""

from __future__ import annotations

from merv.brain.surface.user_settings import UserHfTokenSettings
from merv.brain.workflows import Workflows

import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tests.support.brain import TestBrain
from tests.state.test_schema_snapshot import expected_schema
from tests.state import test_workflow_migration as workflow_migration_cases
from merv.brain.artifacts import Artifacts
from merv.brain.feed.persistence import FEED_SCHEMA
from merv.brain.surface.config import build_state_store, resolve_db_url
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.kernel.state.dialects import (
    PostgresStateStore,
    translate_schema_to_postgres,
)
from merv.brain.infrastructure import persistence as infrastructure_persistence
from merv.brain.kernel.state.schema import MIGRATION_ORDER, has_column, has_table
from merv.brain.kernel.state.store import StateStore, next_created_seq
from merv.brain.research_core.persistence import _EXPERIMENT_MLFLOW_COLUMNS as EXPERIMENT_MLFLOW_COLUMNS
from tests.support.schema import ALL_DDL as SCHEMA, ALL_SCHEMAS, LADDER, install_all_schemas
from merv.brain.kernel.utils import ValidationError, now_iso
from merv.brain.research_core.experiments import ExperimentService
from merv.brain.research_core.artifacts import ResearchArtifacts
from merv.brain.research_core import Research
from tests.fakes import FakeBlobStore


CONTAINER = "rp-test-postgres-dialect"
PASSWORD = "rp-test-pg"

_dsn: str | None = None


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return (
            subprocess.run(
                ["docker", "info"], capture_output=True, timeout=10
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


# An explicitly supplied disposable database supports native Postgres runs.
# This suite resets its public schema between tests; never use an app database.
TEST_POSTGRES_DSN = os.environ.get("MERV_TEST_POSTGRES_DSN", "").strip()
REQUIRE_POSTGRES_TESTS = os.environ.get(
    "MERV_REQUIRE_POSTGRES_TESTS", ""
).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
HAVE_DOCKER = not TEST_POSTGRES_DSN and _docker_available()
HAVE_POSTGRES = bool(TEST_POSTGRES_DSN) or HAVE_DOCKER
if REQUIRE_POSTGRES_TESTS and not HAVE_POSTGRES:
    raise RuntimeError(
        "MERV_REQUIRE_POSTGRES_TESTS needs MERV_TEST_POSTGRES_DSN or Docker"
    )


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def setUpModule() -> None:
    """Start one postgres:16-alpine container for the whole module."""
    global _dsn
    if TEST_POSTGRES_DSN:
        import psycopg

        with psycopg.connect(TEST_POSTGRES_DSN, connect_timeout=2) as conn:
            conn.execute("SELECT 1")
        _dsn = TEST_POSTGRES_DSN
        return
    if not HAVE_DOCKER:
        return
    port = _free_port()
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
    subprocess.run(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            CONTAINER,
            "-e",
            f"POSTGRES_PASSWORD={PASSWORD}",
            "-p",
            f"127.0.0.1:{port}:5432",
            "postgres:16-alpine",
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    dsn = f"postgresql://postgres:{PASSWORD}@127.0.0.1:{port}/postgres"
    import psycopg

    deadline = time.monotonic() + 60
    while True:
        try:
            with psycopg.connect(dsn, connect_timeout=2) as conn:
                conn.execute("SELECT 1")
            break
        except psycopg.Error:
            if time.monotonic() > deadline:
                subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
                if REQUIRE_POSTGRES_TESTS:
                    raise RuntimeError("required postgres container never became ready")
                raise unittest.SkipTest("postgres container never became ready")
            time.sleep(0.5)
    _dsn = dsn


def tearDownModule() -> None:
    if HAVE_DOCKER:
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)


class _FakeConnection:
    """A recording stand-in that answers as the Postgres dialect."""

    dialect = "postgres"

    def __init__(self, *, row: dict[str, int] | None) -> None:
        self.calls: list[tuple[str, tuple[str, ...] | None]] = []
        self._row = row

    def execute(self, sql: str, params: tuple[str, ...] | None = None):
        self.calls.append((sql, params))
        return SimpleNamespace(fetchone=lambda: self._row, fetchall=lambda: [])


def _booted_postgres(dsn: str, *, schemas=None) -> PostgresStateStore:
    """A Postgres store with every component installed — composition's schema."""
    store = PostgresStateStore(dsn=dsn)
    for schema in ALL_SCHEMAS if schemas is None else schemas:
        store.install(schema)
    return store


def _reset_database() -> str:
    """A clean public schema in the module's database; returns the DSN."""
    assert _dsn is not None
    import psycopg

    with psycopg.connect(_dsn, autocommit=True) as conn:
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
    return _dsn


def _schema_without_sandbox_tenant() -> str:
    legacy = re.sub(
        r"(CREATE TABLE IF NOT EXISTS sandboxes \(\n"
        r"\s*sandbox_uid TEXT PRIMARY KEY,\n"
        r"\s*project_id TEXT NOT NULL,\n)"
        r"\s*tenant_id TEXT NOT NULL DEFAULT 'local',\n",
        r"\1",
        SCHEMA,
    )
    if legacy == SCHEMA:
        raise AssertionError("failed to remove sandboxes.tenant_id from legacy schema")
    return legacy


def _schema_without_user_hf_tokens() -> str:
    """SCHEMA before the no-dataplane Phase C table: no user_hf_tokens."""
    legacy = re.sub(
        r"\n-- Per-user Hugging Face access token.*?"
        r"CREATE TABLE IF NOT EXISTS user_hf_tokens \(.*?\n\);\n",
        "\n",
        SCHEMA,
        flags=re.DOTALL,
    )
    if legacy == SCHEMA or "user_hf_tokens" in legacy:
        raise AssertionError("failed to build the pre-user-hf-tokens schema")
    return legacy


def _schema_with_legacy_sandbox_identity() -> str:
    """SCHEMA as it stood before the decoupling refactor: sandboxes keyed by
    experiment_id, before tables whose foreign keys require sandbox_uid."""
    legacy = re.sub(
        r"CREATE TABLE IF NOT EXISTS sandboxes \(\n"
        r"\s*sandbox_uid TEXT PRIMARY KEY,\n",
        "CREATE TABLE IF NOT EXISTS sandboxes (\n  experiment_id TEXT PRIMARY KEY,\n",
        SCHEMA,
    )
    for table in ("sandbox_attachments", "sandbox_runs"):
        legacy = re.sub(
            rf"CREATE TABLE IF NOT EXISTS {table} \(.*?\n\);\n",
            "",
            legacy,
            flags=re.DOTALL,
        )
    if legacy == SCHEMA or any(
        f"CREATE TABLE IF NOT EXISTS {table}" in legacy
        for table in ("sandbox_attachments", "sandbox_runs")
    ):
        raise AssertionError("failed to build the legacy sandbox-identity schema")
    return legacy


def _schema_without_experiment_mlflow_columns() -> str:
    legacy = SCHEMA
    for column in EXPERIMENT_MLFLOW_COLUMNS:
        legacy = re.sub(rf"\n\s*{re.escape(column)} [^,\n]+,?", "", legacy)
    if legacy == SCHEMA:
        raise AssertionError("failed to remove experiment MLflow columns")
    for column in EXPERIMENT_MLFLOW_COLUMNS:
        if column in legacy:
            raise AssertionError(f"failed to remove experiments.{column}")
    return legacy


def _schema_without_review_synopsis() -> str:
    legacy = re.sub(r"\n\s*synopsis [^,\n]+,?", "", SCHEMA)
    if legacy == SCHEMA:
        raise AssertionError("failed to remove reviews.synopsis")
    if "synopsis" in legacy:
        raise AssertionError("failed to remove reviews.synopsis")
    return legacy


def _schema_without_project_keys() -> str:
    """SCHEMA before the agent-anywhere Phase-A tables: no project_api_keys
    table and no sandbox_generations.key_id column. The Phase-B OAuth tables
    are stripped too — oauth_refresh_tokens FKs project_api_keys, so a schema
    predating project_api_keys cannot carry them without a dangling reference.
    Newer FK-less attribution columns (agent_sessions.source_key_id) stay: they
    dangle nothing, and migrations 26/27 must upgrade around them anyway."""
    legacy = re.sub(
        r"\n-- Surface-owned project credentials.*?"
        r"CREATE TABLE IF NOT EXISTS project_api_keys \(.*?\n\);\n",
        "\n",
        _schema_without_oauth_tables(),
        flags=re.DOTALL,
    )
    legacy = re.sub(
        r"\n  -- Provisioning credential attribution.*?\n  key_id TEXT,",
        "",
        legacy,
        flags=re.DOTALL,
    )
    legacy = re.sub(r"CREATE TABLE IF NOT EXISTS agent_runner_pairings \(.*?\n\);\n", "", legacy, flags=re.DOTALL)
    if (
        "CREATE TABLE IF NOT EXISTS project_api_keys" in legacy
        or "REFERENCES project_api_keys" in legacy
        or "\n  key_id TEXT," in legacy
    ):
        raise AssertionError("failed to build the pre-project-keys schema")
    return legacy


def _schema_without_oauth_tables() -> str:
    """SCHEMA before the agent-anywhere Phase-B tables: no oauth_clients,
    oauth_authorization_codes, or oauth_refresh_tokens. The three tables are
    consecutive (with interleaved comments), so one DOTALL sweep from the first
    OAuth comment through the refresh-token block's terminator removes them."""
    legacy = re.sub(
        r"\n-- OAuth 2\.1 public DCR registrations.*?"
        r"CREATE TABLE IF NOT EXISTS oauth_refresh_tokens \(.*?\n\);\n",
        "\n",
        SCHEMA,
        flags=re.DOTALL,
    )
    legacy = re.sub(
        r"CREATE TABLE IF NOT EXISTS oauth_(?:handoff_links|device_grants|device_grant_attempts) \(.*?\n\);\n", "", legacy, flags=re.DOTALL
    )
    if legacy == SCHEMA or any(
        table in legacy
        for table in (
            "oauth_clients",
            "oauth_authorization_codes",
            "oauth_refresh_tokens",
        )
    ):
        raise AssertionError("failed to build the pre-oauth schema")
    return legacy


def _schema_without_storage_completion_tokens() -> str:
    """SCHEMA before the no-dataplane Phase-D storage completion-token table."""
    legacy = re.sub(
        r"\n-- Token-curl upload completion.*?"
        r"CREATE TABLE IF NOT EXISTS storage_completion_tokens \(.*?\n\);\n",
        "\n",
        SCHEMA,
        flags=re.DOTALL,
    )
    if legacy == SCHEMA or "storage_completion_tokens" in legacy:
        raise AssertionError("failed to build the pre-completion-token schema")
    return legacy




@unittest.skipUnless(HAVE_POSTGRES, "Postgres unavailable")
class PostgresWorkflowMigrationTest(workflow_migration_cases.ReflectionMigrationTest):
    """Run the same reflection/lens/publication upgrade contracts on PostgreSQL."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(repo_root=self.repo, db_path=self.repo / ".research_plugin" / "unused.sqlite",
                             store=_booted_postgres(_reset_database()))
        self.project_id = self.call("project", action="create", name=self.__class__.__name__)["id"]

    def migrate(self) -> None:
        path = self.app.db_path
        self.app.shutdown()
        with self.app.store.transaction() as conn:
            workflow_migration_cases._remove_runtime(conn)
        self.app = TestBrain(repo_root=self.repo, db_path=path, store=PostgresStateStore(dsn=_dsn))

    def test_schema60_preserves_active_trace_and_fences_the_old_owner_at_review(self) -> None:
        active = self.create_experiment("working-owner")
        reviewing = self.create_experiment("submitted-owner")
        self.submit(target_type="experiment", target_id=reviewing, role="plan", body=workflow_migration_cases.VALID_PLAN)
        self.transition_experiment(reviewing, "submit_design")
        request = self.call("review.request", project_id=self.project_id, target_type="experiment", target_id=reviewing,
                            role="design_reviewer", producer_session_id="old-owner")
        with self.app.store.transaction() as conn:
            workflow_migration_cases.restore_legacy_lease_columns(conn)
            conn.execute("ALTER TABLE agent_sessions ADD CONSTRAINT legacy_target_type CHECK (target_type IN ('experiment', 'reflection'))")
            conn.execute("ALTER TABLE agent_sessions ADD CONSTRAINT legacy_kind CHECK (kind IN ('experiment', 'review', 'consolidation'))")
            active_secret = workflow_migration_cases._legacy_session(conn, session_id="active", project_id=self.project_id, target_id=active)
            owner_secret = workflow_migration_cases._legacy_session(conn, session_id="old-owner", project_id=self.project_id, target_id=reviewing)
            review_secret = workflow_migration_cases._legacy_session(conn, session_id="reviewer", project_id=self.project_id,
                                                                     target_id=reviewing, kind="review", review_request_id=request["review_request_id"])
            conn.execute("INSERT INTO agent_session_traces (session_id, project_id, events_json, stderr_tail, complete, updated_at) "
                         "VALUES ('active', ?, '[{\"message\": \"Retained progress\"}]', 'Retained stderr', 0, ?)", (self.project_id, now_iso()))
            before = dict(conn.execute("SELECT * FROM agent_sessions WHERE id = 'active'").fetchone())
            trace = dict(conn.execute("SELECT * FROM agent_session_traces WHERE session_id = 'active'").fetchone())
        self.migrate()
        with self.app.store.connect() as conn:
            after = dict(conn.execute("SELECT * FROM agent_sessions WHERE id = 'active'").fetchone())
            # Migration 63 retires the three columns the packet already says;
            # everything else the lease carried survives verbatim.
            retired = {"kind", "review_request_id", "source_sha"}
            self.assertFalse(retired & set(after))
            kept = lambda row: {
                key: value
                for key, value in row.items()
                if not key.startswith("workflow_") and key not in retired
            }
            self.assertEqual(kept(before), kept(after))
            self.assertEqual((after["workflow_instance_id"], after["workflow_revision"], after["workflow_node"]), (active, 0, "planned"))
            self.assertEqual(dict(conn.execute("SELECT * FROM agent_session_traces WHERE session_id = 'active'").fetchone()), trace)
            statuses = {row["id"]: row["status"] for row in conn.execute("SELECT id, status FROM agent_sessions").fetchall()}
        self.assertEqual(statuses, {"active": "active", "old-owner": "expired", "reviewer": "active"})
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=owner_secret))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=active_secret))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=review_secret))
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        self.assertEqual(self.count("review_requests"), 1)
        with self.app.store.transaction() as conn:
            workflow_migration_cases._legacy_session(conn, session_id="plugin", project_id=self.project_id,
                                                     target_id="plugin-instance", target_type="new_plugin", kind="workflow", status="released")

    def test_schema60_starts_old_ready_work_once_and_preserves_clock_across_owner_gap(self) -> None:
        ready = self.drive_experiment_to_running("ready-work")
        idle = self.drive_experiment_to_running("started-without-owner")
        offered = self.drive_experiment_to_running("started-resume-offered")
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE experiments SET status = 'ready_to_run' WHERE id = ?", (ready,))
            for experiment_id in (idle, offered):
                self.app.store.record_event(conn=conn, project_id=self.project_id, event_type="experiment.transitioned",
                                            target_type="experiment", target_id=experiment_id, payload={"transition": "start_running"})
                conn.execute("UPDATE experiments SET mlflow_run_id = ? WHERE id = ?", (f"run-{experiment_id}", experiment_id))
            workflow_migration_cases.restore_legacy_lease_columns(conn)
            ready_secret = workflow_migration_cases._legacy_session(conn, session_id="ready", project_id=self.project_id, target_id=ready)
            offered_secret = workflow_migration_cases._legacy_session(conn, session_id="offered", project_id=self.project_id, target_id=offered, status="offered")
        clocks = {experiment_id: self.app.research.attempt_started_running_at(experiment_id=experiment_id) for experiment_id in (idle, offered)}
        self.migrate()
        with self.app.store.connect() as conn:
            markers = {row["id"]: row["started_revision"] for row in conn.execute("SELECT id, started_revision FROM workflow_instances").fetchall()}
        self.assertEqual(markers, {ready: -1, idle: 0, offered: 0})
        self.assertEqual(self.instance(ready).state, "running")
        self.assertIsNone(self.app.research.attempt_started_running_at(experiment_id=ready))
        for secret in (ready_secret, ready_secret, offered_secret, offered_secret):
            self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        self.call("workflow.begin", project_id=self.project_id, instance_id=idle, expected_revision=0)
        self.assertIsNotNone(self.app.research.attempt_started_running_at(experiment_id=ready))
        self.assertEqual({experiment_id: self.app.research.attempt_started_running_at(experiment_id=experiment_id) for experiment_id in clocks}, clocks)
        with self.app.store.connect() as conn:
            starts = conn.execute("SELECT target_id FROM events WHERE type = 'workflow.work_started'").fetchall()
            tracking = conn.execute("SELECT instance_id FROM workflow_actions WHERE kind = 'experiment.start_tracking'").fetchall()
            runs = {row["id"]: row["mlflow_run_id"] for row in conn.execute("SELECT id, mlflow_run_id FROM experiments WHERE id IN (?, ?)", (idle, offered)).fetchall()}
        self.assertEqual([row["target_id"] for row in starts], [ready])
        self.assertEqual([row["instance_id"] for row in tracking], [ready])
        self.assertEqual(runs, {experiment_id: f"run-{experiment_id}" for experiment_id in clocks})


@unittest.skipUnless(HAVE_POSTGRES, "Postgres unavailable")
class PostgresStoreBehaviorTest(unittest.TestCase):
    """(a), (c), (d): schema/ledger application and record-layer semantics."""

    def setUp(self) -> None:
        self.store = _booted_postgres(_reset_database())

    def _seed_project(self, project_id: str = "proj_pg") -> str:
        with self.store.transaction() as conn:
            conn.execute(
                "INSERT INTO projects (id, name, summary, created_at) VALUES (?, ?, ?, ?)",
                (project_id, "PG Project", "", now_iso()),
            )
        return project_id

    def test_fresh_install_matches_the_pre_move_schema_snapshot(self) -> None:
        """Component-owned DDL is a move: the Postgres shape is unchanged."""
        install_all_schemas(self.store)
        conn = self.store.connect()
        try:
            kinds = {
                str(row["table_name"]): str(row["table_type"])
                for row in conn.execute(
                    "SELECT table_name, table_type FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                ).fetchall()
            }
            columns: dict[str, list[str]] = {}
            for row in conn.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            ).fetchall():
                columns.setdefault(str(row["table_name"]), []).append(
                    str(row["column_name"])
                )
        finally:
            conn.close()
        observed = {
            "tables": {
                name: sorted(cols)
                for name, cols in columns.items()
                if kinds.get(name) != "VIEW"
            },
            "views": [
                {"name": name, "columns": sorted(cols)}
                for name, cols in sorted(columns.items())
                if kinds.get(name) == "VIEW"
            ],
        }
        self.assertEqual(observed, expected_schema())

    def test_schema_and_ledger_apply_cleanly_and_idempotently(self) -> None:
        conn = self.store.connect()
        try:
            tables = {
                str(row["table_name"])
                for row in conn.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                ).fetchall()
            }
            for table in _sqlite_schema_tables():
                self.assertIn(table, tables)
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
            # No default-project bootstrap: that is local-mode-only behavior.
            count = conn.execute("SELECT COUNT(*) AS n FROM projects").fetchone()
            self.assertEqual(int(count["n"]), 0)
        finally:
            conn.close()
        # Re-construction against the same database is a no-op (IF NOT EXISTS
        # DDL + already-recorded ledger), exactly like the SQLite store.
        PostgresStateStore(dsn=_dsn)

    def test_projects_default_to_the_local_tenant(self) -> None:
        project_id = self._seed_project()
        conn = self.store.connect()
        try:
            row = conn.execute(
                "SELECT tenant_id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            self.assertEqual(row["tenant_id"], "local")
        finally:
            conn.close()

    def test_legacy_postgres_store_adds_sandbox_tenant_id(self) -> None:
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_sandbox_tenant()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            conn.execute(
                """
                INSERT INTO schema_migrations (version, name, applied_at)
                VALUES (%s, %s, %s)
                """,
                (1, "drop_legacy_jobs_table", now_iso()),
            )
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, tenant_id, created_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                ("proj_old", "Old", "", "tenant_pg", now_iso()),
            )
            conn.execute(
                """
                INSERT INTO sandboxes (
                  sandbox_uid, project_id, status, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s)
                """,
                ("uid_exp_old", "proj_old", "failed", now_iso(), now_iso()),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            col = conn.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'sandboxes'
                  AND column_name = 'tenant_id'
                """
            ).fetchone()
            self.assertIsNotNone(col)
            row = conn.execute(
                "SELECT tenant_id FROM sandboxes WHERE sandbox_uid = ?",
                ("uid_exp_old",),
            ).fetchone()
            self.assertEqual(row["tenant_id"], "tenant_pg")
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_legacy_postgres_store_adds_experiment_mlflow_columns(self) -> None:
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_experiment_mlflow_columns()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 12:
                    continue
                conn.execute(
                    """
                    INSERT INTO schema_migrations (version, name, applied_at)
                    VALUES (%s, %s, %s)
                    """,
                    (version, name, created),
                )
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, created_at)
                VALUES (%s, %s, %s, %s)
                """,
                ("proj_mlflow_old", "Old", "", created),
            )
            conn.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    "exp_mlflow_old",
                    "proj_mlflow_old",
                    "old_mlflow",
                    "legacy experiment",
                    "ready_to_run",
                    created,
                    created,
                ),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            rows = conn.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'experiments'
                  AND column_name LIKE 'mlflow_run_%'
                ORDER BY column_name
                """
            ).fetchall()
            self.assertEqual(
                [str(row["column_name"]) for row in rows],
                sorted(EXPERIMENT_MLFLOW_COLUMNS),
            )
            experiment = conn.execute(
                "SELECT * FROM experiments WHERE id = ?",
                ("exp_mlflow_old",),
            ).fetchone()
            self.assertIsNotNone(experiment)
            for column in EXPERIMENT_MLFLOW_COLUMNS:
                if column == "mlflow_run_created_at":
                    self.assertIsNone(experiment[column])
                else:
                    self.assertEqual(experiment[column], "")
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_legacy_postgres_store_adds_review_synopsis(self) -> None:
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_review_synopsis()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 13:
                    continue
                conn.execute(
                    """
                    INSERT INTO schema_migrations (version, name, applied_at)
                    VALUES (%s, %s, %s)
                    """,
                    (version, name, created),
                )
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, created_at)
                VALUES (%s, %s, %s, %s)
                """,
                ("proj_synopsis_old", "Old", "", created),
            )
            conn.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    "exp_synopsis_old",
                    "proj_synopsis_old",
                    "old_synopsis",
                    "legacy experiment",
                    "experiment_review",
                    created,
                    created,
                ),
            )
            conn.execute(
                """
                INSERT INTO review_requests (
                  id, project_id, target_type, target_id, role, capability_hash,
                  status, target_snapshot_id, expires_at, created_at
                )
                VALUES (%s, %s, 'experiment', %s, 'experiment_reviewer', '', 'submitted', '', %s, %s)
                """,
                (
                    "rr_synopsis_old",
                    "proj_synopsis_old",
                    "exp_synopsis_old",
                    created,
                    created,
                ),
            )
            conn.execute(
                """
                INSERT INTO review_sessions (
                  id, request_id, independence, status, created_at
                )
                VALUES (%s, %s, 'verified_agent_review', 'submitted', %s)
                """,
                ("rvs_synopsis_old", "rr_synopsis_old", created),
            )
            conn.execute(
                """
                INSERT INTO reviews (
                  id, project_id, request_id, session_id, target_snapshot_id,
                  target_type, target_id, role, verdict, created_at
                )
                VALUES (%s, %s, %s, %s, '', 'experiment', %s, 'experiment_reviewer', 'pass', %s)
                """,
                (
                    "rev_synopsis_old",
                    "proj_synopsis_old",
                    "rr_synopsis_old",
                    "rvs_synopsis_old",
                    "exp_synopsis_old",
                    created,
                ),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            rows = conn.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'reviews'
                  AND column_name = 'synopsis'
                """
            ).fetchall()
            self.assertEqual(len(rows), 1)
            review = conn.execute(
                "SELECT * FROM reviews WHERE id = ?", ("rev_synopsis_old",)
            ).fetchone()
            self.assertIsNotNone(review)
            self.assertEqual(review["synopsis"], "")
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_legacy_postgres_store_gains_project_keys_and_generation_key_id(
        self,
    ) -> None:
        """Old-DB upgrade through the agent-anywhere Phase-A block: replay ledger
        rows < 26 against a schema with neither project_api_keys nor
        sandbox_generations.key_id, re-open, and confirm migrations 26/27 add
        both without disturbing an existing generation row.

        The guarantee is idempotent convergence, NOT one-transaction atomicity of
        the schema change with its ledger row. `CREATE TABLE IF NOT EXISTS`
        (translate_schema_to_postgres(SCHEMA)) runs first in its own autocommit,
        separately from the ledger; each migration's `_has_table`/`_has_column`-
        gated handler then commits with its ledger row inside `_migration_scope`.
        Because the handlers are gated, a crash that commits the schema change
        before the ledger row heals on the next migrate (the gated handler
        no-ops, the missing ledger row is (re)inserted) — the shipped 24/25
        pattern. See the SQLite convergence test in test_store_migrations.py."""
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_project_keys()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 26:
                    continue
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (%s, %s, %s)",
                    (version, name, created),
                )
            conn.execute(
                "INSERT INTO projects (id, name, summary, created_at) "
                "VALUES (%s, %s, %s, %s)",
                ("proj_keys_old", "Old", "", created),
            )
            conn.execute(
                """
                INSERT INTO sandbox_generations
                  (id, experiment_id, project_id, tenant_id,
                   price_usd_per_hour, started_at, created_seq)
                VALUES ('sbg_old', 'exp_old', 'proj_keys_old', 'local', 1.0, %s, 1)
                """,
                (created,),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            self.assertTrue(has_table(conn, "project_api_keys"))
            for column in ("audience", "oauth_family_id", "sandbox_seconds_ceiling"):
                self.assertTrue(
                    has_column(conn, "project_api_keys", column
                    ),
                    column,
                )
            self.assertTrue(
                has_column(conn, "sandbox_generations", "key_id"
                )
            )
            key_id = conn.execute(
                "SELECT key_id FROM sandbox_generations WHERE id = 'sbg_old'"
            ).fetchone()
            self.assertIsNone(key_id["key_id"])  # pre-existing row keeps NULL
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_migration_58_preserves_legacy_rows_and_persists_remote_links(self) -> None:
        dsn = _reset_database()
        store = _booted_postgres(dsn)
        with store.transaction() as conn:
            conn.execute("DROP TABLE remote_sandbox_links")
            conn.execute("DELETE FROM schema_migrations WHERE version=58")
            conn.execute("INSERT INTO projects (id,name,created_at) VALUES ('p1','Legacy','2026-09-08')")
            conn.execute("INSERT INTO sandboxes (sandbox_uid,project_id,status,created_at,updated_at) VALUES ('old','p1','terminated','2026-09-08','2026-09-08')")
        upgraded = _booted_postgres(dsn)
        with upgraded.transaction() as conn:
            self.assertEqual(conn.execute("SELECT name FROM schema_migrations WHERE version=58").fetchone()["name"], "add_remote_sandbox_links")
            self.assertEqual(conn.execute("SELECT status FROM sandboxes WHERE sandbox_uid='old'").fetchone()["status"], "terminated")
            conn.execute("INSERT INTO remote_sandbox_links (project_id,sandbox_uid,experiment_id,public_key,created_at) VALUES ('p1','native','exp','ssh-public','2026-09-08')")
        reopened = _booted_postgres(dsn)
        with reopened.transaction() as conn:
            self.assertEqual(conn.execute("SELECT public_key FROM remote_sandbox_links WHERE sandbox_uid='native'").fetchone()["public_key"], "ssh-public")
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=58").fetchone()["n"], 1)

    def test_legacy_postgres_store_gains_oauth_tables(self) -> None:
        """Old-DB upgrade through the agent-anywhere Phase-B block: replay ledger
        rows < 28 against a schema with none of the three OAuth tables, re-open,
        and confirm migrations 28/29/30 create each. Each `_has_table`-gated
        handler commits with its ledger row inside `_migration_scope`; the
        schema CREATE IF NOT EXISTS ran earlier in its own autocommit, so
        convergence — not one-transaction schema+ledger atomicity — is what
        heals a crash between the two. The FK order (clients before
        codes/refresh, refresh before project_api_keys of migration 26) must
        apply cleanly on Postgres."""
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_oauth_tables()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 28:
                    continue
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (%s, %s, %s)",
                    (version, name, created),
                )
            conn.execute(
                "INSERT INTO projects (id, name, summary, created_at) "
                "VALUES (%s, %s, %s, %s)",
                ("proj_oauth_old", "Old", "", created),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            for table in (
                "oauth_clients",
                "oauth_authorization_codes",
                "oauth_refresh_tokens",
            ):
                self.assertTrue(has_table(conn, table), table)
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_feed_installer_upgrades_legacy_postgres_store(self) -> None:
        """Feed, not any other component, creates its tables after a replay."""
        dsn = _reset_database()
        import psycopg

        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(
                translate_schema_to_postgres(SCHEMA.replace(FEED_SCHEMA.ddl, ""))
            )
            for version, name in LADDER:
                if version >= 32:
                    continue
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (%s, %s, %s)",
                    (version, name, created),
                )

        store = _booted_postgres(
            dsn, schemas=[item for item in ALL_SCHEMAS if item is not FEED_SCHEMA]
        )
        conn = store.connect()
        try:
            self.assertFalse(has_table(conn, "feed_upload_tokens"))
        finally:
            conn.close()

        install_all_schemas(store)
        conn = store.connect()
        try:
            self.assertTrue(has_table(conn, "feed_upload_tokens"))
            for column in ("token", "post_id", "media_kind", "expires_at"):
                self.assertTrue(
                    has_column(conn, "feed_upload_tokens", column
                    ),
                    column,
                )
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_legacy_postgres_store_gains_user_hf_tokens(self) -> None:
        """Old-DB upgrade through the no-dataplane Phase C block: replay ledger
        rows < 31 against a schema without user_hf_tokens, re-open, and confirm
        migration 31 creates the table (migration + ledger row inside one
        transaction on the autocommit connection). The write-only round trip
        (set -> resolve) works on the Postgres dialect too."""
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_user_hf_tokens()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 31:
                    continue
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (%s, %s, %s)",
                    (version, name, created),
                )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            self.assertTrue(has_table(conn, "user_hf_tokens"))
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

        # Write-only round trip: set, resolve (internal), clear, resolve empty.
        settings = UserHfTokenSettings(store=store)
        settings.set_token(user_id="user_pg", token="hf_pg_secret")
        self.assertEqual(settings.resolve(user_id="user_pg"), "hf_pg_secret")
        settings.set_token(user_id="user_pg", token="hf_pg_rotated")  # upsert
        self.assertEqual(settings.resolve(user_id="user_pg"), "hf_pg_rotated")
        settings.clear_token(user_id="user_pg")
        self.assertEqual(settings.resolve(user_id="user_pg"), "")

    def test_legacy_postgres_store_gains_storage_completion_tokens(self) -> None:
        """Old-DB upgrade through no-dataplane Phase D: replay ledger rows < 33
        against a schema without storage_completion_tokens, re-open, and confirm
        migration 33 creates the table (SCHEMA-extracted DDL gated by
        _has_table) without disturbing an existing storage object."""
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_without_storage_completion_tokens()
        created = now_iso()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            for version, name in LADDER:
                if version >= 33:
                    continue
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) "
                    "VALUES (%s, %s, %s)",
                    (version, name, created),
                )
            conn.execute(
                "INSERT INTO projects (id, name, summary, created_at) "
                "VALUES (%s, %s, %s, %s)",
                ("proj_tok_old", "Old", "", created),
            )
            conn.execute(
                """
                INSERT INTO storage_objects
                  (id, project_id, name, version, kind, content_sha256, size_bytes,
                   namespace, status, created_at, updated_at)
                VALUES ('sto_old', 'proj_tok_old', 'datasets/x', 1, 'dataset',
                        'a' , 4, 'proj_tok_old', 'available', %s, %s)
                """,
                (created, created),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            self.assertTrue(
                has_table(conn, "storage_completion_tokens")
            )
            for column in (
                "token",
                "project_id",
                "object_id",
                "upload_id",
                "status",
                "expires_at",
                "created_at",
            ):
                self.assertTrue(
                    has_column(conn, "storage_completion_tokens", column
                    ),
                    column,
                )
            # The pre-existing storage object is untouched by the table add.
            obj = conn.execute(
                "SELECT status FROM storage_objects WHERE id = 'sto_old'"
            ).fetchone()
            self.assertEqual(str(obj["status"]), "available")
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_legacy_postgres_sandboxes_gain_uid_and_attachments(self) -> None:
        dsn = _reset_database()
        import psycopg

        legacy_schema = _schema_with_legacy_sandbox_identity()
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(translate_schema_to_postgres(legacy_schema))
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (%s, %s, %s)",
                (1, "drop_legacy_jobs_table", now_iso()),
            )
            conn.execute(
                "INSERT INTO projects (id, name, summary, created_at) VALUES (%s, %s, %s, %s)",
                ("proj_pg", "PG", "", now_iso()),
            )
            # one live box and one already-terminated box under the legacy PK.
            conn.execute(
                """
                INSERT INTO sandboxes (
                  experiment_id, project_id, sandbox_id, status,
                  requested_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    "exp_live",
                    "proj_pg",
                    "sb-live",
                    "running",
                    now_iso(),
                    now_iso(),
                    now_iso(),
                ),
            )
            conn.execute(
                """
                INSERT INTO sandboxes (
                  experiment_id, project_id, sandbox_id, status,
                  requested_at, created_at, updated_at, terminated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    "exp_done",
                    "proj_pg",
                    "sb-done",
                    "terminated",
                    now_iso(),
                    now_iso(),
                    now_iso(),
                    now_iso(),
                ),
            )

        store = _booted_postgres(dsn)
        conn = store.connect()
        try:
            # sandbox_uid is now the sole primary key.
            pk = conn.execute(
                """
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = 'public'
                  AND tc.table_name = 'sandboxes'
                  AND tc.constraint_type = 'PRIMARY KEY'
                """
            ).fetchall()
            self.assertEqual([str(r["column_name"]) for r in pk], ["sandbox_uid"])
            # every legacy row got a distinct uuid.
            rows = conn.execute("SELECT sandbox_uid FROM sandboxes").fetchall()
            self.assertTrue(all(str(r["sandbox_uid"]) for r in rows))
            self.assertEqual(len({str(r["sandbox_uid"]) for r in rows}), 2)
            # one attachment per sandbox: live stays open, terminated is closed.
            att = conn.execute(
                """
                SELECT a.experiment_id, a.detached_at
                FROM sandbox_attachments a
                """
            ).fetchall()
            by_exp = {str(r["experiment_id"]): r["detached_at"] for r in att}
            self.assertEqual(len(att), 2)
            self.assertIsNone(by_exp["exp_live"])
            self.assertIsNotNone(by_exp["exp_done"])
            # the full ledger is recorded exactly once, in order.
            ledger = conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
            self.assertEqual(
                [(int(r["version"]), str(r["name"])) for r in ledger],
                list(LADDER),
            )
        finally:
            conn.close()

    def test_event_ids_are_identity_assigned_and_order_recent_events(self) -> None:
        project_id = self._seed_project()
        with self.store.transaction() as conn:
            for index in range(3):
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type=f"step.{index}",
                    payload={"index": index},
                )
        events = self.store.recent_events(project_id=project_id, limit=10)["events"]
        self.assertEqual([e["type"] for e in events], ["step.2", "step.1", "step.0"])
        self.assertEqual([e["payload"]["index"] for e in events], [2, 1, 0])
        ids = [int(e["id"]) for e in events]
        self.assertEqual(ids, sorted(ids, reverse=True))

    def test_tenant_counters_use_dialect_neutral_state_query(self) -> None:
        project_id = self._seed_project()
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE projects SET tenant_id = ? WHERE id = ?",
                ("tenant_pg", project_id),
            )
            conn.execute(
                """
                INSERT INTO sandbox_generations
                  (id, experiment_id, project_id, tenant_id,
                   price_usd_per_hour, started_at, ended_at, created_seq)
                VALUES ('sbg_pg', 'exp', ?, 'tenant_pg', 1.0, ?, ?, 1)
                """,
                (project_id, "2026-01-01T00:00:00Z", "2026-01-01T02:30:00Z"),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="audit.tenant-counter",
            )

        counts = {
            "tenant_id": "tenant_pg",
            "tool_calls": self.store.tenant_event_count(tenant_id="tenant_pg"),
        }
        self.assertEqual(counts["tenant_id"], "tenant_pg")
        self.assertGreaterEqual(counts["tool_calls"], 1)

    def test_record_event_returns_exact_persisted_postgres_row(self) -> None:
        project_id = self._seed_project()
        with self.store.transaction() as conn:
            event = self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="postgres.returned",
                target_type="test",
                target_id="target_pg",
                payload={"z": [2, {"nested": True}], "a": 1},
            )

        conn = self.store.connect()
        try:
            row = conn.execute(
                "SELECT * FROM events WHERE id = ?", (event.id,)
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(str(row["project_id"]), event.project_id)
        self.assertEqual(str(row["type"]), event.type)
        self.assertEqual(str(row["target_type"]), event.target_type)
        self.assertEqual(str(row["target_id"]), event.target_id)
        self.assertEqual(str(row["created_at"]), event.created_at)
        self.assertEqual(
            str(row["payload_json"]),
            '{"a": 1, "z": [2, {"nested": true}]}',
        )
        self.assertEqual(event.payload["z"], (2, {"nested": True}))
        with self.assertRaises(TypeError):
            event.payload["z"][1]["nested"] = False

    def test_tracking_refresh_returns_exact_persisted_postgres_event(self) -> None:
        project_id = self._seed_project()
        artifacts = ResearchArtifacts(
            store=self.store, artifacts=Artifacts(store=self.store, blobs=FakeBlobStore())
        )
        research = Research(store=self.store, artifacts=artifacts, workflows=Workflows(store=self.store))
        experiments = research._experiments
        created = experiments.create(
            project_id=project_id, name="tracking-refresh", intent="postgres"
        )

        committed = Research(
            store=self.store, artifacts=artifacts
        , workflows=Workflows(store=self.store)).refresh_tracking_run(
            project_id=project_id,
            experiment_id=created["id"],
            run={"run_id": "run_pg", "status": "FINISHED"},
        )

        conn = self.store.connect()
        try:
            row = conn.execute(
                "SELECT * FROM events WHERE id = ?", (committed.event.id,)
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(str(row["type"]), "experiment.mlflow_run_refreshed")
        self.assertEqual(str(row["target_id"]), created["id"])
        self.assertEqual(str(row["created_at"]), committed.event.created_at)
        self.assertEqual(committed.state["mlflow_run"]["run_id"], "run_pg")

    def test_tracking_repair_cannot_overwrite_a_concurrent_new_attachment(self) -> None:
        from concurrent.futures import ThreadPoolExecutor
        import psycopg
        from psycopg.rows import dict_row

        project_id = self._seed_project()
        artifacts = ResearchArtifacts(
            store=self.store, artifacts=Artifacts(store=self.store, blobs=FakeBlobStore())
        )
        research = Research(store=self.store, artifacts=artifacts, workflows=Workflows(store=self.store))
        experiment = research._experiments.create(
            project_id=project_id, name="tracking-race", intent="retain the newer run"
        )
        research.refresh_tracking_run(
            project_id=project_id, experiment_id=experiment["id"],
            run={"run_id": "old_run", "status": "FINISHED"},
        )

        with ThreadPoolExecutor(max_workers=1) as pool:
            # Independent connections need not share the store's advisory lock.
            with psycopg.connect(_dsn, row_factory=dict_row) as writer:
                writer.execute(
                    "UPDATE experiments SET mlflow_run_id = %s WHERE id = %s",
                    ("new_run", experiment["id"]),
                )
                repair = pool.submit(
                    research.refresh_tracking_run,
                    project_id=project_id, experiment_id=experiment["id"],
                    expected_run_id="old_run", run={"run_id": "repaired_run", "status": "RUNNING"},
                )
                deadline = time.monotonic() + 5
                waiting = False
                while time.monotonic() < deadline:
                    if repair.done():
                        repair.result()
                    writer.execute("SELECT pg_stat_clear_snapshot()")
                    waiting = writer.execute(
                        """SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
                           AND query LIKE '%UPDATE experiments%') AS waiting"""
                    ).fetchone()["waiting"]
                    if waiting:
                        break
                    time.sleep(0.01)
                self.assertTrue(waiting, "repair never reached the held experiment row")
            self.assertIsNone(repair.result(timeout=5))

        with self.store.transaction() as conn:
            row = conn.execute("SELECT mlflow_run_id FROM experiments WHERE id = ?", (experiment["id"],)).fetchone()
            self.assertEqual(row["mlflow_run_id"], "new_run")

    def test_event_insert_failure_rolls_back_transition_and_event(self) -> None:
        import psycopg

        project_id = self._seed_project()
        artifacts = ResearchArtifacts(
            store=self.store, artifacts=Artifacts(store=self.store, blobs=FakeBlobStore())
        )
        research = Research(store=self.store, artifacts=artifacts, workflows=Workflows(store=self.store))
        experiments = research._experiments
        created = experiments.create(
            project_id=project_id, name="rollback-event", intent="postgres"
        )
        with self.store.transaction() as conn:
            conn.execute(
                """
                ALTER TABLE events ADD CONSTRAINT reject_transition_event
                CHECK (type <> 'experiment.transitioned')
                """
            )

        with self.assertRaisesRegex(
            psycopg.errors.CheckViolation, "reject_transition_event"
        ):
            experiments.transition_with_event(
                project_id=project_id,
                experiment_id=created["id"],
                transition="mark_failed",
            )

        state = experiments.get_state(
            project_id=project_id, experiment_id=created["id"]
        )
        self.assertEqual(state["status"], "planned")
        conn = self.store.connect()
        try:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM events
                WHERE type = 'experiment.transitioned' AND target_id = ?
                """,
                (created["id"],),
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(int(row["count"]), 0)

    def test_evidence_reads_inside_writer_transaction(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        repo = Path(tmp.name)
        app = TestBrain(
            repo_root=repo,
            db_path=repo / ".research_plugin" / "unused.sqlite",
            store=self.store,
        )
        try:
            project_id = app.call_tool(
                "project", {"action": "create", "name": "Evidence PG"}
            )["id"]
            experiment_id = app.call_tool(
                "experiment.create",
                {
                    "project_id": project_id,
                    "name": "evidence-pg",
                    "intent": "Read evidence under the writer lock.",
                },
            )["id"]
            app.submit_artifact(
                project_id=project_id,
                target_type="experiment",
                target_id=experiment_id,
                role="plan",
                path="plan.md",
                body=(
                    "## Summary\nPostgres evidence.\n\n"
                    "## Objective & hypothesis\nExercise the seam.\n\n"
                    "## Evaluation\nThe read completes.\n"
                ),
            )

            with self.assertRaisesRegex(RuntimeError, "rollback outer"):
                with self.store.transaction() as conn:
                    conn.execute(
                        "UPDATE experiments SET revision_context = ? WHERE id = ?",
                        ("outer postgres write", experiment_id),
                    )
                    artifacts = app.artifacts.history(
                        tx=conn,
                        target_type="experiment",
                        target_ids=(experiment_id,),
                    )[experiment_id].artifacts
                    document = app.artifacts.get(
                        artifact_ids=(artifacts[0].id,),
                        include="content",
                    )[0]
                    raise RuntimeError("rollback outer")
            self.assertEqual(artifacts[0].role, "plan")
            self.assertIn("Postgres evidence", (document.data or b"").decode())
            conn = self.store.connect()
            try:
                row = conn.execute(
                    "SELECT revision_context FROM experiments WHERE id = ?",
                    (experiment_id,),
                ).fetchone()
            finally:
                conn.close()
            self.assertEqual(str(row["revision_context"]), "")
        finally:
            app.shutdown()
            tmp.cleanup()

    def test_created_seq_orders_artifacts(self) -> None:
        project_id = self._seed_project()
        with self.store.transaction() as conn:
            for index in range(3):
                seq = next_created_seq(conn=conn, table="artifacts")
                self.assertEqual(seq, index + 1)
                conn.execute(
                    """
                    INSERT INTO artifacts (
                      id, project_id, path,
                      status, created_at, updated_at, created_seq
                    )
                    VALUES (?, ?, 'notes.md',
                            'complete', ?, ?, ?)
                    """,
                    (f"art_{index}", project_id, now_iso(), now_iso(), seq),
                )
        conn = self.store.connect()
        try:
            rows = conn.execute(
                "SELECT id FROM artifacts WHERE project_id = ? ORDER BY created_seq",
                (project_id,),
            ).fetchall()
            self.assertEqual([r["id"] for r in rows], ["art_0", "art_1", "art_2"])
        finally:
            conn.close()

    def test_artifact_resubmit_supersedes_the_slot_on_postgres(self) -> None:
        """Replacing a research slot keeps both immutable content versions."""
        tmp = tempfile.TemporaryDirectory()
        repo = Path(tmp.name)
        app = TestBrain(
            repo_root=repo,
            db_path=repo / ".research_plugin" / "unused.sqlite",
            store=self.store,
        )
        try:
            project_id = app.call_tool(
                "project", {"action": "create", "name": "Supersede PG"}
            )["id"]
            experiment_id = app.call_tool(
                "experiment.create",
                {
                    "project_id": project_id,
                    "name": "supersede-pg",
                    "intent": "Replace the plan slot on resubmit.",
                },
            )["id"]
            first = app.submit_artifact(
                project_id=project_id,
                target_type="experiment",
                target_id=experiment_id,
                role="plan",
                path="plan.md",
                body="## Summary\nv1\n",
            )
            second = app.submit_artifact(
                project_id=project_id,
                target_type="experiment",
                target_id=experiment_id,
                role="plan",
                path="plan.md",
                body="## Summary\nv2\n",
            )
            self.assertNotEqual(first["artifact_id"], second["artifact_id"])
            conn = self.store.connect()
            try:
                rows = conn.execute(
                    "SELECT id FROM research_artifacts WHERE project_id = ? "
                    "AND status = 'complete' AND active = 1",
                    (project_id,),
                ).fetchall()
            finally:
                conn.close()
            self.assertEqual([r["id"] for r in rows], [second["artifact_id"]])
            with self.store.transaction() as conn:
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND status = 'complete'",
                    (project_id,),
                ).fetchone()["n"], 2)
        finally:
            app.shutdown()
            tmp.cleanup()

    def test_resource_era_database_replays_migrations_24_and_25(self) -> None:
        """Old-DB upgrade on the Postgres dialect: recreate the resource-era
        tables, rewind ledger rows 24/25, and re-open the store — the backfill
        canonicalizes legacy roles, rewrites the pinned snapshot token, and
        migration 25 drops the resource tables (each migration + its ledger
        row inside its own transaction on the autocommit connection)."""
        with patch("merv.brain.kernel.state.store.MIGRATION_ORDER", tuple(v for v in MIGRATION_ORDER if v < 59)):
            self.store = _booted_postgres(_reset_database())
        project_id = self._seed_project()
        conn = self.store.connect()
        try:
            conn.execute("DELETE FROM schema_migrations WHERE version IN (24, 25)")
            conn.execute(
                """
                CREATE TABLE resources (
                  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                  path TEXT NOT NULL, kind TEXT NOT NULL,
                  title TEXT NOT NULL DEFAULT '', current_version_id TEXT,
                  version_token TEXT NOT NULL, mtime_ns BIGINT NOT NULL,
                  size_bytes BIGINT NOT NULL, observed_at TEXT NOT NULL,
                  git_commit TEXT, missing BIGINT NOT NULL DEFAULT 0,
                  deleted BIGINT NOT NULL DEFAULT 0,
                  created_by TEXT NOT NULL DEFAULT 'codex',
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE resource_versions (
                  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL,
                  project_id TEXT NOT NULL, path TEXT NOT NULL,
                  content_sha256 TEXT NOT NULL, size_bytes BIGINT NOT NULL,
                  mtime_ns BIGINT NOT NULL, observed_at TEXT NOT NULL,
                  content_type TEXT NOT NULL DEFAULT 'text/markdown',
                  created_by TEXT NOT NULL DEFAULT 'codex',
                  created_at TEXT NOT NULL, created_seq BIGINT NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE resource_associations (
                  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL,
                  version_id TEXT, target_type TEXT NOT NULL,
                  target_id TEXT NOT NULL, role TEXT NOT NULL,
                  attempt_index BIGINT NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL, created_seq BIGINT NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                INSERT INTO resources
                  (id, project_id, path, kind, version_token, mtime_ns,
                   size_bytes, observed_at, created_at, updated_at)
                VALUES ('res_1', ?, 'project/reflection.md', 'document', 'tok',
                        1, 9, ?, ?, ?)
                """,
                (project_id, now_iso(), now_iso(), now_iso()),
            )
            conn.execute(
                """
                INSERT INTO resource_versions
                  (id, resource_id, project_id, path, content_sha256,
                   size_bytes, mtime_ns, observed_at, created_at, created_seq)
                VALUES ('rver_1', 'res_1', ?, 'project/reflection.md', ?,
                        9, 1, ?, ?, 1)
                """,
                (project_id, "a" * 64, now_iso(), now_iso()),
            )
            conn.execute(
                """
                INSERT INTO resource_associations
                  (id, resource_id, version_id, target_type, target_id, role,
                   attempt_index, created_at, created_seq)
                VALUES ('as_1', 'res_1', 'rver_1', 'reflection', 'ref_1',
                        'synthesis_doc', 1, ?, 1)
                """,
                (now_iso(),),
            )
            conn.execute(
                """
                INSERT INTO review_requests
                  (id, project_id, target_type, target_id, role,
                   capability_hash, status, target_snapshot_id, expires_at,
                   created_at, created_seq)
                VALUES ('req_1', ?, 'reflection', 'ref_1',
                        'reflection_reviewer', 'hash_pg_24', 'requested',
                        'reflection|ref_1|reflection_review|1|res_1:rver_1:synthesis_doc:1',
                        '2099-01-01T00:00:00Z', ?, 1)
                """,
                (project_id, now_iso()),
            )
        finally:
            conn.close()

        replay = _booted_postgres(self.store.dsn)
        conn = replay.connect()
        try:
            artifact = conn.execute(
                "SELECT id, role, lens_id FROM research_artifacts WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            self.assertEqual(str(artifact["role"]), "reflection_doc")
            snapshot = conn.execute(
                "SELECT target_snapshot_id FROM review_requests WHERE id = 'req_1'"
            ).fetchone()
            self.assertEqual(
                str(snapshot["target_snapshot_id"]),
                f"reflection|ref_1|reflection_review|1|{artifact['id']}:reflection_doc:1",
            )
            tables = {
                str(row["table_name"])
                for row in conn.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'public'"
                ).fetchall()
            }
            for table in ("resources", "resource_versions", "resource_associations"):
                self.assertNotIn(table, tables)
            ledger = conn.execute(
                "SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (24, 25)"
            ).fetchone()
            self.assertEqual(int(ledger["n"]), 2)
        finally:
            conn.close()

    def test_concurrent_transactions_serialize_on_the_advisory_lock(self) -> None:
        """(d) Both writers run MAX+1 read-modify-write; without single-writer
        semantics they'd both read 0 and the table would end at 1."""
        self._seed_project()
        conn = self.store.connect()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS txn_probe (n BIGINT NOT NULL)")
        finally:
            conn.close()
        first_in_tx = threading.Event()
        errors: list[Exception] = []

        def writer(*, wait_inside: bool) -> None:
            try:
                with self.store.transaction() as tx:
                    current = tx.execute(
                        "SELECT COALESCE(MAX(n), 0) AS top FROM txn_probe"
                    ).fetchone()
                    if wait_inside:
                        first_in_tx.set()
                        time.sleep(0.5)
                    tx.execute(
                        "INSERT INTO txn_probe (n) VALUES (?)",
                        (int(current["top"]) + 1,),
                    )
            except Exception as exc:  # noqa: BLE001 — surfaced via the list
                errors.append(exc)

        slow = threading.Thread(target=writer, kwargs={"wait_inside": True})
        slow.start()
        self.assertTrue(first_in_tx.wait(timeout=10))
        fast = threading.Thread(target=writer, kwargs={"wait_inside": False})
        fast.start()
        slow.join(timeout=30)
        fast.join(timeout=30)
        self.assertEqual(errors, [])
        conn = self.store.connect()
        try:
            rows = conn.execute("SELECT n FROM txn_probe ORDER BY n").fetchall()
            self.assertEqual([int(r["n"]) for r in rows], [1, 2])
        finally:
            conn.close()

    def test_build_state_store_selects_the_postgres_dialect(self) -> None:
        store = build_state_store(
            db_path=Path("/nonexistent/unused.sqlite"),
            env={"RESEARCH_PLUGIN_DB_URL": _reset_database()},
        )
        self.assertIsInstance(store, PostgresStateStore)


def _columns_by_table(schema_sql: str) -> dict[str, set[str]]:
    """Table → column-name set, parsed from CREATE TABLE statements.

    A deliberately dumb string-level parse (the parity contract is string
    level too): the first token of each body line that is not a constraint
    or a comment is a column name.
    """
    tables: dict[str, set[str]] = {}
    for match in re.finditer(
        r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\s*\);", schema_sql, re.DOTALL
    ):
        name, body = match.group(1), match.group(2)
        columns: set[str] = set()
        for line in body.splitlines():
            token = line.strip().split(" ", 1)[0].rstrip(",")
            if not token or token == "--":
                continue
            if token.upper() in {"PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"}:
                continue
            columns.add(token)
        tables[name] = columns
    return tables


def _sqlite_schema_tables() -> set[str]:
    return set(_columns_by_table(SCHEMA))


class SchemaParityTest(unittest.TestCase):
    """No docker needed: the translated DDL covers the SQLite SCHEMA exactly."""

    def test_translated_ddl_has_every_sqlite_table_and_column(self) -> None:
        sqlite_tables = _columns_by_table(SCHEMA)
        postgres_tables = _columns_by_table(translate_schema_to_postgres(SCHEMA))
        self.assertTrue(sqlite_tables)  # the parse saw the schema at all
        self.assertEqual(set(postgres_tables), set(sqlite_tables))
        for table, columns in sqlite_tables.items():
            self.assertEqual(postgres_tables[table], columns, f"table {table}")

    def test_translation_strips_every_sqlite_ism(self) -> None:
        translated = translate_schema_to_postgres(SCHEMA)
        self.assertNotIn("PRAGMA", translated)
        self.assertNotIn("AUTOINCREMENT", translated)
        self.assertNotRegex(translated, r"\bINTEGER\b")  # 32-bit on Postgres
        self.assertIn("BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY", translated)

    def test_sandboxes_schema_no_longer_unique_by_experiment(self) -> None:
        translated = translate_schema_to_postgres(SCHEMA)
        match = re.search(
            r"CREATE TABLE IF NOT EXISTS sandboxes \((.*?)\n\);",
            translated,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        self.assertNotIn("UNIQUE(experiment_id)", match.group(1))

    def test_postgres_has_column_uses_information_schema_directly(self) -> None:
        """A failed statement aborts an open Postgres transaction, so the
        probe must never try a PRAGMA first."""
        conn = _FakeConnection(row={"exists": 1})

        self.assertTrue(has_column(conn, "projects", "hard_stop_synthesis_id"))
        self.assertFalse([sql for sql, _ in conn.calls if "PRAGMA" in sql.upper()])
        sql, params = conn.calls[-1]
        self.assertIn("information_schema.columns", sql)
        self.assertEqual(params, ("projects", "hard_stop_synthesis_id"))

    def test_postgres_drop_sandbox_experiment_unique_is_constraint_ddl(self) -> None:
        conn = _FakeConnection(row={"exists": 1})
        infrastructure_persistence._drop_sandboxes_experiment_unique(conn)
        self.assertIn(
            "ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_experiment_id_key",
            conn.calls[-1][0],
        )

    def test_postgres_attachment_history_migration_drops_pair_primary_key(self) -> None:
        conn = _FakeConnection(row=None)
        infrastructure_persistence._allow_sandbox_attachment_history(conn)
        self.assertEqual(len(conn.calls), 1)
        self.assertIn(
            "ALTER TABLE sandbox_attachments DROP CONSTRAINT IF EXISTS sandbox_attachments_pkey",
            conn.calls[0][0],
        )

    def test_no_question_marks_inside_sql_string_literals(self) -> None:
        """The dialect's '?' → '%s' translation is string-level; it is only
        sound while no SQL keeps a literal '?' or '%' inside quotes. Walk
        every SQL-looking constant in src/merv/brain/ and keep that invariant."""
        import ast

        from tests.paths import BACKEND_ROOT

        offenders: list[str] = []
        for path in sorted(BACKEND_ROOT.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Constant) or not isinstance(
                    node.value, str
                ):
                    continue
                sql = node.value
                if not re.search(
                    r"\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b", sql.upper()
                ):
                    continue
                for literal in re.findall(r"'(?:[^']|'')*'", sql):
                    if "?" in literal or "%" in literal:
                        offenders.append(f"{path.name}:{node.lineno}: {literal!r}")
        self.assertEqual(offenders, [])

    def test_resolve_db_url_default_and_rejection(self) -> None:
        self.assertIsNone(resolve_db_url(env={}))
        self.assertEqual(
            resolve_db_url(env={"RESEARCH_PLUGIN_DB_URL": "postgres://x/y"}),
            "postgres://x/y",
        )
        with self.assertRaises(ValidationError):
            build_state_store(
                db_path=Path("/nonexistent/unused.sqlite"),
                env={"RESEARCH_PLUGIN_DB_URL": "mysql://nope"},
            )

    def test_build_state_store_defaults_to_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = build_state_store(db_path=Path(tmp) / "state.sqlite", env={})
            self.assertIsInstance(store, StateStore)


if __name__ == "__main__":
    unittest.main()
