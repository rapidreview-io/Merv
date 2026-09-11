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

from merv.brain.programs import INSTALLED, PROGRAM
from merv.brain.workflows import Workflows
from merv.brain.agent_sessions import WorkspaceAdvances

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

from tests.support.brain import TestBrain
from tests.state.test_schema_snapshot import expected_schema
from merv.brain.artifacts import Artifacts
from merv.brain.surface.config import build_state_store, resolve_db_url
from merv.brain.kernel.state.dialects import (
    PostgresStateStore,
    translate_schema_to_postgres,
)
from merv.brain.kernel.state.store import StateStore, next_created_seq
from tests.support.schema import (
    ALL_DDL as SCHEMA,
    ALL_SCHEMAS,
    LADDER,
    install_all_schemas,
)
from merv.brain.kernel.utils import ValidationError, now_iso
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

    def test_fresh_install_matches_the_pre_squash_schema_snapshot(self) -> None:
        """Squashing the ladder is a move: the Postgres shape is unchanged."""
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

    def test_event_insert_failure_rolls_back_transition_and_event(self) -> None:
        import psycopg

        project_id = self._seed_project()
        artifacts = ResearchArtifacts(
            store=self.store, artifacts=Artifacts(store=self.store, blobs=FakeBlobStore())
        )
        research = Research(store=self.store, advances=WorkspaceAdvances(store=self.store), artifacts=artifacts, workflows=Workflows(store=self.store, programs=INSTALLED), program=PROGRAM)
        experiments = research.experiments
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
                experiment_id=created.id,
                transition="mark_failed",
            )

        state = experiments.get_state(
            project_id=project_id, experiment_id=created.id
        )
        self.assertEqual(state.status, "planned")
        conn = self.store.connect()
        try:
            row = conn.execute(
                """
                SELECT COUNT(*) AS count FROM events
                WHERE type = 'experiment.transitioned' AND target_id = ?
                """,
                (created.id,),
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
