"""Repeated node authentication must not reopen artifact-dependent work start."""

from contextlib import contextmanager
import secrets
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
