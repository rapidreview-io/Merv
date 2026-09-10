"""Schema 60 preserves released work and binds the new graph/compositions once."""

from contextlib import closing
from datetime import UTC, datetime, timedelta
import json
import sqlite3
from unittest import mock

from merv.brain.kernel.secret_tokens import hash_secret
from merv.brain.kernel.state.schema import columns_of, ensure_columns
from tests.support.schema import booted_store
from tests.research_core.scenarios import LENSES, VALID_CHANGE_SPEC, VALID_PLAN, ResearchCase
from tests.support.brain import TestBrain


def _remove_runtime(conn):
    conn.execute("DROP INDEX IF EXISTS idx_agent_sessions_one_live_workflow")
    conn.execute("DELETE FROM schema_migrations WHERE version = 63")
    conn.execute("DROP TABLE workflow_actions")
    conn.execute("DROP TABLE workflow_history")
    conn.execute("DROP TABLE workflow_instances")
    conn.execute("DELETE FROM schema_migrations WHERE version = 60")


# The released schema-59 lease table, verbatim: closed target/kind enums, the
# three columns migration 63 retires, and none of the workflow ones migration
# 60 adds. It is written out rather than derived from today's DDL — a fixture
# for a shape the live schema no longer has cannot be spelled by editing it.
LEGACY_AGENT_SESSIONS = """
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('experiment', 'reflection')),
  target_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'experiment'
    CHECK (kind IN ('experiment', 'review', 'consolidation')),
  review_request_id TEXT NOT NULL DEFAULT '',
  source_sha TEXT NOT NULL DEFAULT '',
  runner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('offered', 'active', 'released', 'expired')),
  host_session_ref TEXT NOT NULL DEFAULT '',
  workspace_ref TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  assignment_json TEXT NOT NULL DEFAULT '{}',
  agent_setup_json TEXT NOT NULL DEFAULT '{}',
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  telemetry_at TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_activity_at TEXT,
  lease_expires_at TEXT NOT NULL,
  hard_deadline_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT NOT NULL DEFAULT '',
  source_key_id TEXT,
  source_user_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
)
"""


# What migration 63 retires. A 59-era lease still carries them, so a replay
# that starts from today's table has to put them back first.
LEGACY_LEASE_COLUMNS = {
    "kind": "TEXT NOT NULL DEFAULT 'experiment'",
    "review_request_id": "TEXT NOT NULL DEFAULT ''",
    "source_sha": "TEXT NOT NULL DEFAULT ''",
}


def restore_legacy_lease_columns(conn):
    ensure_columns(conn, "agent_sessions", LEGACY_LEASE_COLUMNS)


def _legacy_session_schema(conn):
    """Recreate the released closed enums, including the referencing trace table."""
    trace_sql = conn.execute("SELECT sql FROM sqlite_master WHERE name = 'agent_session_traces'").fetchone()["sql"]
    assert conn.execute("SELECT COUNT(*) FROM agent_sessions").fetchone()[0] == 0
    conn.execute("DROP TABLE agent_session_traces")
    conn.execute("DROP TABLE agent_sessions")
    conn.execute(LEGACY_AGENT_SESSIONS)
    conn.execute(trace_sql)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_runner_retry"
        "  ON agent_sessions(runner_id, idempotency_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_project"
        "  ON agent_sessions(project_id, created_at)"
    )


def _legacy_session(conn, *, session_id, project_id, target_id, target_type="experiment",
                    kind="experiment", status="active", attempt_index=1, review_request_id="",
                    assignment=None, created_at="2026-09-01T00:00:00+00:00"):
    """Insert one released-shape lease, before or after migration 63.

    `kind` and `review_request_id` exist only until that step retires them, so
    the row is written against whatever columns the table actually has.
    """
    secret = f"mas_legacy_test_{session_id}"
    deadline = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    values = {
        "id": session_id,
        "project_id": project_id,
        "target_type": target_type,
        "target_id": target_id,
        "attempt_index": attempt_index,
        "kind": kind,
        "review_request_id": review_request_id,
        "runner_id": f"runner-{session_id}",
        "platform": "codex",
        "idempotency_key": session_id,
        "secret_digest": hash_secret(secret),
        "status": status,
        "assignment_json": json.dumps(
            {"instruction": "Continue the existing work."} if assignment is None else assignment
        ),
        "created_at": created_at,
        "activated_at": created_at if status == "active" else None,
        "lease_expires_at": deadline,
        "hard_deadline_at": deadline,
    }
    present = set(columns_of(conn, "agent_sessions"))
    columns = [column for column in values if column in present]
    conn.execute(
        f"INSERT INTO agent_sessions ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})",
        [values[column] for column in columns],
    )
    return secret


def test_existing_tasks_are_adopted_once_without_restarting_work(tmp_path):
    path = tmp_path / "state.sqlite"
    store = booted_store(path)
    with store.transaction() as conn:
        project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]
        for index, state in enumerate(("in_progress", "in_review", "done", "failed")):
            conn.execute(
                "INSERT INTO tasks (id, project_id, name, goal, status, created_at, updated_at, revision_context) "
                "VALUES (?, ?, ?, 'Retain this work', ?, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'Keep prior progress')",
                (f"task_old_{index}", project_id, f"task-{index}", state),
            )
        _remove_runtime(conn)
    migrated = booted_store(path)
    with closing(migrated.connect()) as conn:
        instances = conn.execute("SELECT * FROM workflow_instances ORDER BY id").fetchall()
        assert [row["state"] for row in instances] == ["in_progress", "in_review", "done", "failed"]
        assert [row["outcome"] for row in instances] == ["", "", "completed", "failed"]
        assert all(row["version"] == 1 and row["revision"] == 0 for row in instances)
        assert all(row["updated_at"] == "2026-09-02T00:00:00Z" for row in instances)
        assert conn.execute("SELECT kind FROM workflow_actions").fetchall()[0]["kind"] == "review.request"
        history = conn.execute("SELECT action, after_json FROM workflow_history").fetchall()
        assert len(history) == 4 and all(row["action"] == "migrate" for row in history)
        assert all(json.loads(row["after_json"])["version"] == 1 for row in history)
        assert all(row["revision_context"] == "Keep prior progress" for row in conn.execute("SELECT revision_context FROM tasks").fetchall())
    booted_store(path)
    with closing(migrated.connect()) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM workflow_history").fetchone()["n"] == 4


class WorkflowMigrationCase(ResearchCase):
    def migrate(self):
        path = self.app.db_path
        self.app.shutdown()
        with self.app.store.transaction() as conn:
            _remove_runtime(conn)
        self.app = TestBrain(repo_root=self.repo, db_path=path)

    def instance(self, instance_id):
        return self.app.research.workflows.runtime.get(project_id=self.project_id, instance_id=instance_id)

    def count(self, table):
        with self.app.store.connect() as conn:
            return conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]


class WorkflowLeaseMigrationTest(WorkflowMigrationCase):
    def test_closed_enums_expand_with_active_credentials_and_trace_content_preserved(self):
        experiment_id = self.create_experiment()
        with self.app.store.transaction() as conn:
            _legacy_session_schema(conn)
            secret = _legacy_session(conn, session_id="owner", project_id=self.project_id, target_id=experiment_id)
            conn.execute("INSERT INTO agent_session_traces (session_id, project_id, events_json, stderr_tail, complete, updated_at) "
                         "VALUES ('owner', ?, '[{\"message\": \"Retained progress\"}]', 'last stderr line', 0, '2026-09-01T00:00:00+00:00')", (self.project_id,))
            old = dict(conn.execute("SELECT * FROM agent_sessions WHERE id = 'owner'").fetchone())
            trace = dict(conn.execute("SELECT * FROM agent_session_traces WHERE session_id = 'owner'").fetchone())
        self.migrate()
        with self.app.store.connect() as conn:
            adopted = dict(conn.execute("SELECT * FROM agent_sessions WHERE id = 'owner'").fetchone())
            # Migration 63 retires the three columns the packet already says.
            retired = {"kind", "review_request_id", "source_sha"}
            self.assertFalse(retired & set(adopted))
            self.assertEqual(
                {key: adopted[key] for key in old if key not in retired},
                {key: value for key, value in old.items() if key not in retired},
            )
            self.assertEqual(adopted["workflow_instance_id"], experiment_id)
            self.assertEqual(adopted["workflow_node"], "planned")
            self.assertEqual(adopted["workflow_revision"], 0)
            self.assertEqual(dict(conn.execute("SELECT * FROM agent_session_traces WHERE session_id = 'owner'").fetchone()), trace)
            self.assertFalse(conn.execute("PRAGMA foreign_key_check").fetchall())
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        self.assertEqual(self.count("agent_session_traces"), 1)
        with self.app.store.transaction() as conn:
            _legacy_session(conn, session_id="plugin", project_id=self.project_id, target_id="new-plugin-instance",
                            target_type="new_plugin", kind="workflow", status="released")
        with self.assertRaises(sqlite3.IntegrityError), self.app.store.transaction() as conn:
            conn.execute("UPDATE agent_sessions SET status = 'invented' WHERE id = 'plugin'")

    def test_submitted_gate_preserves_reviewer_and_expires_superseded_owner(self):
        experiment_id = self.create_experiment()
        self.submit(target_type="experiment", target_id=experiment_id, role="plan", body=VALID_PLAN)
        self.transition_experiment(experiment_id, "submit_design")
        request = self.call("review.request", project_id=self.project_id, target_type="experiment", target_id=experiment_id,
                            role="design_reviewer", producer_session_id="owner")
        with self.app.store.transaction() as conn:
            _legacy_session_schema(conn)
            owner_secret = _legacy_session(conn, session_id="owner", project_id=self.project_id, target_id=experiment_id)
            review_secret = _legacy_session(conn, session_id="reviewer", project_id=self.project_id, target_id=experiment_id,
                                            kind="review", review_request_id=request["review_request_id"])
        self.migrate()
        with self.app.store.connect() as conn:
            sessions = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM agent_sessions").fetchall()}
        self.assertEqual(sessions["owner"]["status"], "expired")
        self.assertEqual(sessions["owner"]["close_reason"], "workflow_migration_stale_lease")
        self.assertEqual(sessions["reviewer"]["status"], "active")
        self.assertEqual(sessions["reviewer"]["workflow_node"], "design_review")
        self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=owner_secret))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=review_secret))
        with self.assertRaises(sqlite3.IntegrityError), self.app.store.transaction() as conn:
            _legacy_session(conn, session_id="duplicate", project_id=self.project_id, target_id=experiment_id, kind="workflow")
            conn.execute("UPDATE agent_sessions SET workflow_instance_id = ?, workflow_revision = 0 WHERE id = 'duplicate'", (experiment_id,))

    def test_changed_attempts_terminal_work_and_unfinished_offers_are_fenced(self):
        changed = self.create_experiment("changed-attempt")
        terminal = self.create_experiment("terminal-work")
        empty_offer = self.create_experiment("unfinished-offer")
        complete_offer = self.create_experiment("complete-offer")
        self.transition_experiment(terminal, "abandon")
        with self.app.store.transaction() as conn:
            _legacy_session_schema(conn)
            conn.execute("UPDATE experiments SET attempt_index = 2 WHERE id = ?", (changed,))
            secrets = {
                "changed": _legacy_session(conn, session_id="changed", project_id=self.project_id, target_id=changed),
                "terminal": _legacy_session(conn, session_id="terminal", project_id=self.project_id, target_id=terminal),
                "empty": _legacy_session(conn, session_id="empty", project_id=self.project_id, target_id=empty_offer, status="offered", assignment={}),
                "complete": _legacy_session(conn, session_id="complete", project_id=self.project_id, target_id=complete_offer, status="offered"),
            }
        self.migrate()
        with self.app.store.connect() as conn:
            statuses = {row["id"]: row["status"] for row in conn.execute("SELECT id, status FROM agent_sessions").fetchall()}
        self.assertEqual(statuses, {"changed": "expired", "terminal": "expired", "empty": "expired", "complete": "offered"})
        for session_id in ("changed", "terminal", "empty"):
            self.assertIsNone(self.app.agent_sessions.authenticate(session_secret=secrets[session_id]))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secrets["complete"]))

    def test_old_ready_lease_starts_execution_once_while_started_work_keeps_its_clock(self):
        ready = self.drive_experiment_to_running("ready-before-upgrade")
        running = self.drive_experiment_to_running("already-running")
        with self.app.store.transaction() as conn:
            _legacy_session_schema(conn)
            conn.execute("UPDATE experiments SET status = 'ready_to_run' WHERE id = ?", (ready,))
            self.app.store.record_event(conn=conn, project_id=self.project_id, event_type="experiment.transitioned",
                                        target_type="experiment", target_id=running, payload={"transition": "start_running"})
            conn.execute("UPDATE experiments SET mlflow_run_id = 'retained-run', mlflow_run_name = 'retained-name' WHERE id = ?", (running,))
            ready_secret = _legacy_session(conn, session_id="ready", project_id=self.project_id, target_id=ready)
            running_secret = _legacy_session(conn, session_id="running", project_id=self.project_id, target_id=running)
        started_at = self.app.research.attempt_started_running_at(experiment_id=running)
        self.assertIsNotNone(started_at)
        self.migrate()
        self.assertEqual(self.instance(ready).state, "running")
        self.assertIsNone(self.app.research.attempt_started_running_at(experiment_id=ready))
        with self.app.store.connect() as conn:
            markers = {row["id"]: row["started_revision"] for row in conn.execute("SELECT id, started_revision FROM workflow_instances").fetchall()}
        self.assertEqual(markers[ready], -1)
        self.assertEqual(markers[running], 0)
        for secret in (ready_secret, ready_secret, running_secret, running_secret):
            self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        self.assertIsNotNone(self.app.research.attempt_started_running_at(experiment_id=ready))
        self.assertEqual(self.app.research.attempt_started_running_at(experiment_id=running), started_at)
        with self.app.store.connect() as conn:
            starts = conn.execute("SELECT target_id FROM events WHERE type = 'workflow.work_started'").fetchall()
            tracking = conn.execute("SELECT instance_id FROM workflow_actions WHERE kind = 'experiment.start_tracking'").fetchall()
            retained = conn.execute("SELECT mlflow_run_id, mlflow_run_name FROM experiments WHERE id = ?", (running,)).fetchone()
        self.assertEqual([row["target_id"] for row in starts], [ready])
        self.assertEqual([row["instance_id"] for row in tracking], [ready])
        self.assertEqual(tuple(retained), ("retained-run", "retained-name"))

    def test_previously_started_execution_is_not_restarted_after_an_owner_gap(self):
        idle = self.drive_experiment_to_running("running-without-owner")
        offered = self.drive_experiment_to_running("running-resume-offered")
        with self.app.store.transaction() as conn:
            _legacy_session_schema(conn)
            for experiment_id in (idle, offered):
                self.app.store.record_event(conn=conn, project_id=self.project_id, event_type="experiment.transitioned",
                                            target_type="experiment", target_id=experiment_id, payload={"transition": "start_running"})
            secret = _legacy_session(conn, session_id="resume", project_id=self.project_id, target_id=offered, status="offered")
        self.migrate()
        with self.app.store.connect() as conn:
            markers = {row["id"]: row["started_revision"] for row in conn.execute("SELECT id, started_revision FROM workflow_instances").fetchall()}
        self.assertEqual(markers, {idle: 0, offered: 0})
        self.call("workflow.begin", project_id=self.project_id, instance_id=idle, expected_revision=0)
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        with self.app.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events WHERE type = 'workflow.work_started'").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM workflow_actions WHERE kind = 'experiment.start_tracking'").fetchone()[0], 0)


class ReflectionMigrationTest(WorkflowMigrationCase):
    def proposal(self, reflection_id, *, sha="2"):
        return self.app.application.submit_consolidation(
            project_id=self.project_id, reflection_id=reflection_id,
            base_sha="1" * 40, proposal_sha=sha * 40, summary="No code changes were needed.",
            validation={"tests": "not_applicable"}, decisions=[], producer_session_id="consolidator",
        )

    def approved_reflection(self):
        reflection_id = self.drive_reflection_to_review()
        self.pass_review(target_type="reflection", target_id=reflection_id, role="reflection_reviewer")
        return reflection_id

    def test_partial_lens_adoption_keeps_its_exact_unsealed_document_after_replacement(self):
        reflection_id = self.create_reflection()
        lens_id = LENSES[0]["id"]
        original = self.submit(target_type="reflection", target_id=reflection_id, role="reflection_lens_doc",
                               lens_id=lens_id, path=f"reflections/{lens_id}.md", body="## Summary\nThe original retained finding.")
        self.migrate()
        adopted = self.instance(reflection_id)
        completed = next(child for child in adopted.children if child.key == lens_id)
        self.assertEqual(completed.outcome, "submitted")
        self.assertEqual(completed.data["artifact_id"], original)
        self.assertEqual(sum(not child.outcome for child in adopted.children), 4)
        replacement = self.submit(target_type="reflection", target_id=reflection_id, role="reflection_lens_doc",
                                  lens_id=lens_id, path=f"reflections/{lens_id}.md", body="## Summary\nA later different finding.")
        native = self.call("reflection.get", project_id=self.project_id, reflection_id=reflection_id)
        current_ids = {item["id"] for item in native["current_attempt_artifacts"]}
        self.assertIn(original, current_ids)
        self.assertNotIn(replacement, current_ids)
        self.app.research.initialize_workflows()
        self.assertEqual(self.instance(reflection_id), adopted)

    def test_completed_lens_set_advances_without_rerunning_the_contributions(self):
        reflection_id = self.create_reflection()
        self.submit_lenses(reflection_id)
        old = self.call("reflection.get", project_id=self.project_id, reflection_id=reflection_id)
        old_ids = {item["id"] for item in old["current_attempt_artifacts"]}
        self.migrate()
        adopted = self.instance(reflection_id)
        self.assertEqual(adopted.state, "synthesizing")
        self.assertEqual(set(adopted.data["lens_artifacts"].values()), old_ids)
        with self.app.store.connect() as conn:
            children = conn.execute("SELECT id, state, outcome, revision FROM workflow_instances WHERE parent_id = ?", (reflection_id,)).fetchall()
        self.assertEqual(len(children), 5)
        self.assertTrue(all(child["state"] == "submitted" and child["outcome"] == "submitted" and child["revision"] == 0 for child in children))
        self.app.research.initialize_workflows()
        self.assertEqual(self.instance(reflection_id), adopted)

    def test_lens_adoption_and_completion_seal_only_their_own_ready_evidence(self):
        reflection_id = self.create_reflection()
        ready_id = self.submit(target_type="reflection", target_id=reflection_id, role="reflection_lens_doc",
                               lens_id=LENSES[0]["id"], path="reflections/ready.md", body="## Summary\nA complete retained lens.")
        pending_id = self.submit(target_type="reflection", target_id=reflection_id, role="reflection_doc",
                                 path="reflections/pending.md",
                                 body="## Summary\nThis draft still needs its figure.\n\n![Measurement](missing.png)")
        with self.app.store.connect() as conn:
            self.assertEqual(conn.execute("SELECT status FROM artifact_figures WHERE artifact_id = ?", (pending_id,)).fetchone()["status"], "pending")
        self.migrate()
        wave = self.instance(reflection_id)
        outcomes = {child.key: child.outcome for child in wave.children}
        self.assertEqual(outcomes[LENSES[0]["id"]], "submitted")
        self.assertEqual(outcomes[LENSES[1]["id"]], "")
        other = next(child for child in wave.children if child.key == LENSES[2]["id"])
        content = self.app.artifacts.contents.create(project_id=self.project_id, path="reflections/third.md",
                                                    data=b"## Summary\nA third independently completed lens.", created_by="third-lens")
        self.call("workflow.transition", project_id=self.project_id, instance_id=other.id, action="submit",
                  expected_revision=0, request_id="third-lens", payload={"artifact_id": content.id})
        self.assertEqual(self.instance(other.id).outcome, "submitted")
        with self.app.store.connect() as conn:
            ready = conn.execute("SELECT submission_id FROM research_artifact_links WHERE id = ?", (ready_id,)).fetchone()
            pending = conn.execute("SELECT submission_id FROM research_artifact_links WHERE id = ?", (pending_id,)).fetchone()
        self.assertTrue(ready["submission_id"])
        self.assertFalse(pending["submission_id"])

    def test_old_passing_reflection_review_advances_without_a_second_review(self):
        reflection_id = self.drive_reflection_to_review()
        runtime = self.app.research.workflows.runtime
        # The released system recorded a pass before a separate advancement
        # command. Suppress only today's automatic edge to recreate that state.
        with mock.patch.object(runtime, "apply_in_transaction", return_value=self.instance(reflection_id)):
            self.pass_review(target_type="reflection", target_id=reflection_id, role="reflection_reviewer")
        self.assertEqual(self.instance(reflection_id).state, "reflection_review")
        requests = self.count("review_requests")
        self.migrate()
        self.assertEqual(self.instance(reflection_id).state, "consolidating")
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        self.assertEqual(self.count("review_requests"), requests)
        self.assertEqual(self.count("consolidation_proposals"), 0)

    def test_passed_final_proposal_review_waits_for_runner_without_being_repeated(self):
        reflection_id = self.approved_reflection()
        proposed = self.proposal(reflection_id)
        proposal_id = proposed["consolidation"]["proposal"]["id"]
        self.pass_review(target_type="reflection", target_id=reflection_id, role="consolidation_reviewer")
        requests = self.count("review_requests")
        self.migrate()
        migrated = self.instance(reflection_id)
        self.assertEqual(migrated.state, "consolidation_review")
        self.assertEqual(migrated.data["proposal_id"], proposal_id)
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        self.assertEqual(self.count("review_requests"), requests)
        packets = self.app.research.workflows.candidates(project_id=self.project_id)
        self.assertFalse(any(packet["instance_id"] == reflection_id for packet in packets))
        self.assertEqual(self.count("consolidation_proposals"), 1)

    def test_rejected_current_proposal_resumes_code_work_with_its_pin(self):
        reflection_id = self.approved_reflection()
        proposed = self.proposal(reflection_id)
        proposal_id = proposed["consolidation"]["proposal"]["id"]
        self.review(target_type="reflection", target_id=reflection_id, role="consolidation_reviewer", verdict="needs_changes", return_to="consolidating")
        self.migrate()
        migrated = self.instance(reflection_id)
        self.assertEqual(migrated.state, "consolidating")
        self.assertEqual(migrated.data["proposal_id"], proposal_id)
        self.assertEqual(self.count("consolidation_proposals"), 1)
        with self.app.store.connect() as conn:
            actions = conn.execute("SELECT kind FROM workflow_actions WHERE instance_id = ?", (reflection_id,)).fetchall()
        self.assertFalse(actions)

    def test_bound_approved_proposal_finishes_publication_once_during_bootstrap(self):
        reflection_id = self.approved_reflection()
        self.proposal(reflection_id)
        self.pass_review(target_type="reflection", target_id=reflection_id, role="consolidation_reviewer")
        advance = self.app.research.prepare_reflection_advance(project_id=self.project_id, reflection_id=reflection_id, runner_id="runner")
        # A released runner may have committed its exact receipt before a
        # process stop prevented the subsequent publication transaction.
        with mock.patch.object(self.app.reflection_waves, "_publish_bound_advance", return_value={}):
            self.app.research.settle_reflection_advance(
                project_id=self.project_id, advance_id=advance["id"], runner_id="runner", observed_sha="2" * 40,
                proposal_parents=["1" * 40], diffstat={"commit_count": 0, "files_changed": 0, "insertions": 0, "deletions": 0}, ancestry={},
            )
        requests = self.count("review_requests")
        self.migrate()
        self.assertEqual(self.instance(reflection_id).state, "published")
        self.assertEqual(self.count("reflection_experiments"), 1)
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        self.assertEqual(self.count("review_requests"), requests)
        after = self.instance(reflection_id)
        self.app.research.initialize_workflows()
        self.assertEqual(self.instance(reflection_id), after)
        self.assertEqual(self.count("reflection_experiments"), 1)

    def test_old_rejected_proposal_does_not_hide_a_new_unreviewed_proposal(self):
        reflection_id = self.approved_reflection()
        self.proposal(reflection_id)
        self.review(target_type="reflection", target_id=reflection_id, role="consolidation_reviewer", verdict="needs_changes", return_to="consolidating")
        latest = self.proposal(reflection_id, sha="3")
        latest_id = latest["consolidation"]["proposal"]["id"]
        self.migrate()
        self.assertEqual(self.instance(reflection_id).state, "consolidation_review")
        self.assertEqual(self.instance(reflection_id).data["proposal_id"], latest_id)
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        with self.app.store.connect() as conn:
            request = conn.execute("SELECT role, target_snapshot_id FROM review_requests WHERE target_id = ? ORDER BY created_seq DESC LIMIT 1", (reflection_id,)).fetchone()
        self.assertEqual(request["role"], "consolidation_reviewer")
        self.assertTrue(request["target_snapshot_id"].endswith(f"|{latest_id}|{'3' * 40}"))

    def test_only_latest_published_wave_joins_existing_members_and_preserves_completed_work(self):
        older_id = self.approved_reflection()
        older = self.consolidate_and_publish(older_id)
        older_experiment = older["materialized_experiments"][0]["experiment_id"]
        reflection_id = self.create_reflection("Latest wave")
        self.submit_lenses(reflection_id)
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection_id, transition="submit_reflections")
        spec = json.loads(VALID_CHANGE_SPEC)
        spec["decision"]["experiments"] = [
            {"key": name, "name": name, "intent": "Run the next check.", "tested_claim_refs": ["transfer"]}
            for name in ("finished-check", "remaining-check")
        ]
        spec["decision"]["tasks"] = [{"key": "finished-task", "name": "finished-task", "goal": "Retain a concise research memo.",
                                         "deliverables": ["A retained memo that cites the reviewed evidence."]}]
        self.submit_reflection_bundle(reflection_id, change_spec=json.dumps(spec))
        self.call("reflection.transition", project_id=self.project_id, reflection_id=reflection_id, transition="submit_reflection_artifacts")
        self.pass_review(target_type="reflection", target_id=reflection_id, role="reflection_reviewer")
        published = self.consolidate_and_publish(reflection_id)
        experiments = {item["name"]: item["experiment_id"] for item in published["materialized_experiments"]}
        task_id = published["materialized_tasks"][0]["task_id"]
        # Recreate released terminal records directly: schema adoption must
        # preserve their outcome without rerunning submission or review gates.
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE experiments SET status = 'complete' WHERE id = ?", (experiments["finished-check"],))
            conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (task_id,))
        self.migrate()
        with self.app.store.connect() as conn:
            starts = conn.execute("SELECT instance_id, data_json FROM workflow_actions WHERE kind = 'workflow.start'").fetchall()
        self.assertEqual([row["instance_id"] for row in starts], [reflection_id])
        self.assertEqual(json.loads(starts[0]["data_json"])["request_id"], f"reflection-wave:{reflection_id}")
        members = {experiments["finished-check"], experiments["remaining-check"], task_id}
        before = {instance_id: self.instance(instance_id) for instance_id in members}
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        with self.app.store.connect() as conn:
            waves = conn.execute("SELECT id FROM workflow_instances WHERE workflow = 'research_wave'").fetchall()
            older_parent = conn.execute("SELECT parent_id FROM workflow_instances WHERE id = ?", (older_experiment,)).fetchone()["parent_id"]
        self.assertEqual(len(waves), 1)
        self.assertIsNone(older_parent)
        wave_id = waves[0]["id"]
        wave = self.instance(wave_id)
        self.assertEqual({child.id for child in wave.children}, members)
        self.assertEqual(sum(child.outcome == "completed" for child in wave.children), 2)
        self.assertEqual({instance_id: self.instance(instance_id) for instance_id in members}, before)
        self.app.application.workflow_deliveries.run_once(project_id=self.project_id)
        self.app.research.initialize_workflows()
        self.assertEqual(self.instance(wave_id), wave)
        self.call("workflow.transition", project_id=self.project_id, instance_id=experiments["remaining-check"],
                  action="mark_failed", expected_revision=0, request_id="unavailable-source", payload={"reason": "The source data is unavailable."})
        self.assertEqual(self.instance(wave_id).outcome, "needs_replanning")
        self.assertEqual(self.count("reflections"), 2)
