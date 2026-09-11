"""Repeated node authentication must not reopen artifact-dependent work start."""

from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import secrets
from threading import Event
from unittest.mock import patch

from merv.shared.errors import WorkflowError
from tests.research_core.scenarios import LENSES, ResearchCase, VALID_PLAN


class AuthenticationContentionTest(ResearchCase):
    def setUp(self):
        super().setUp()
        self.experiment_id = self.create_experiment("authentication-contention")
        self.submit(target_type="experiment", target_id=self.experiment_id,
                    role="plan", path="plan.md", body=VALID_PLAN)
        self.runtime = self.app.research.workflows.runtime
        self.secret = "mas_" + secrets.token_urlsafe(32)
        candidate = self.runtime.assignment(project_id=self.project_id, instance_id=self.experiment_id)
        self.session = self.app.agent_sessions.lease(
            project_id=self.project_id, candidates=[candidate], runner_id="contention-probe",
            platform="codex", idempotency_key="contention-probe", session_secret=self.secret)
        self.assertIsNotNone(self.session)

    def test_repeated_authentication_does_not_read_blobs_under_writer_lock(self):
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        transaction = self.app.store.transaction
        get = self.app.blobs.get
        writer_connections = []
        reads = []

        @contextmanager
        def tracked_transaction():
            with transaction() as conn:
                writer_connections.append(conn)
                try:
                    yield conn
                finally:
                    writer_connections.pop()

        def tracked_get(**kwargs):
            reads.append(any(conn.in_transaction for conn in writer_connections))
            return get(**kwargs)

        with patch.object(self.app.store, "transaction", tracked_transaction), \
                patch.object(self.app.blobs, "get", tracked_get):
            self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        self.assertEqual(reads, [], "repeated authentication fetched blobs; True means writer lock was held")

    def test_blob_outage_does_not_break_repeated_authentication(self):
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        with patch.object(self.app.blobs, "get", side_effect=OSError("blob service unavailable")) as get:
            self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        get.assert_not_called()

    def test_candidate_hints_do_not_take_the_writer_transaction(self):
        expected = self.runtime.candidates(project_id=self.project_id)
        with patch.object(self.app.store, "transaction", side_effect=AssertionError("candidate scan took writer lock")):
            self.assertEqual(self.runtime.candidates(project_id=self.project_id), expected)

    def test_standalone_workflow_reads_do_not_take_the_writer_transaction(self):
        for name in ("evaluate", "assignment", "describe"):
            with self.subTest(name=name):
                read = getattr(self.runtime, name)
                expected = read(project_id=self.project_id, instance_id=self.experiment_id)
                with patch.object(self.app.store, "transaction", side_effect=AssertionError("read took writer lock")):
                    self.assertEqual(read(project_id=self.project_id, instance_id=self.experiment_id), expected)

    def test_disabled_dispatch_does_not_prepare_or_hydrate_candidates(self):
        with patch.object(self.app.application, "_dispatch_plan", side_effect=AssertionError("dispatch was disabled")):
            result = self.app.application.lease_agent_session(
                project_id=self.project_id, runner_id="disabled", platform="codex",
                idempotency_key="disabled", session_secret="mas_" + secrets.token_urlsafe(32))
        self.assertEqual(result, {"session": None, "reason": "agent_dispatch_disabled"})

    def test_slow_blob_reader_does_not_hold_up_an_independent_writer(self):
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        entered, release = Event(), Event()
        get = self.app.blobs.get

        def slow_get(**kwargs):
            entered.set()
            release.wait(5)
            return get(**kwargs)

        def independent_writer():
            with self.app.store.transaction() as conn:
                conn.execute("UPDATE projects SET summary = summary WHERE id = ?", (self.project_id,))

        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.app.blobs, "get", slow_get):
            authentication = pool.submit(self.app.agent_sessions.authenticate, session_secret=self.secret)
            try:
                entered.wait(0.1)
                pool.submit(independent_writer).result(timeout=2)
                self.assertIsNotNone(authentication.result(timeout=2))
                self.assertFalse(entered.is_set())
            finally:
                release.set()

    def test_invalid_exit_artifact_does_not_block_work_but_still_blocks_transition(self):
        self.submit(target_type="experiment", target_id=self.experiment_id,
                    role="plan", path="plan.md", body="Incomplete draft.")
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=self.secret))
        with self.assertRaisesRegex(WorkflowError, "plan"):
            self.transition_experiment(self.experiment_id, "submit_design")

    def test_lens_authentication_does_not_hydrate_parent_documents(self):
        reflection_id = self.create_reflection()
        self.submit(target_type="reflection", target_id=reflection_id, role="reflection_lens_doc",
                    path="lens.md", lens_id=LENSES[0]["id"], body="# Lens\n\n## Summary\nRetained prior contribution.")
        parent = self.runtime.get(project_id=self.project_id, instance_id=reflection_id)
        candidate = self.runtime.assignment(project_id=self.project_id, instance_id=parent.children[1].id)
        secret = "mas_" + secrets.token_urlsafe(32)
        self.assertIsNotNone(self.app.agent_sessions.lease(
            project_id=self.project_id, candidates=[candidate], runner_id="lens-probe", platform="codex",
            idempotency_key="lens-probe", session_secret=secret))
        self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        with patch.object(self.app.blobs, "get", wraps=self.app.blobs.get) as get:
            self.assertIsNotNone(self.app.agent_sessions.authenticate(session_secret=secret))
        get.assert_not_called()
