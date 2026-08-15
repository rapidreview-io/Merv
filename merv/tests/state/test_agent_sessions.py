from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from merv.brain.agent_sessions import AgentSessions
from merv.brain.kernel.secret_tokens import hash_secret
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import NotFoundError, PermissionDeniedError, ValidationError, now_iso


class AgentSessionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.temp.name) / "state.sqlite")
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO projects (id, name, created_at)
                VALUES ('proj_1', 'Project', ?)
                """,
                (now_iso(),),
            )
            tx.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, attempt_index,
                  created_at, updated_at
                )
                VALUES ('exp_1', 'proj_1', 'Experiment', 'Test it',
                        'planned', 1, ?, ?)
                """,
                (now_iso(), now_iso()),
            )
        self.sessions = AgentSessions(
            store=self.store,
            terminal_experiment_statuses={"complete", "inconclusive", "failed"},
        )
        self.candidate = {
            "id": "exp_1",
            "status": "planned",
            "attempt_index": 1,
            "kind": "experiment",
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def secret(suffix: str) -> str:
        return "mas_" + suffix * 43

    def claim(self, *, runner: str = "runner", key: str = "retry"):
        return self.sessions.claim(
            project_id="proj_1",
            candidates=[self.candidate],
            runner_id=runner,
            platform="codex",
            idempotency_key=key,
            session_secret=self.secret(runner[0]),
        )

    def test_claim_is_idempotent_and_one_live_owner_is_database_enforced(self) -> None:
        first = self.claim()
        repeated = self.claim()
        blocked = self.sessions.claim(
            project_id="proj_1",
            candidates=[self.candidate],
            runner_id="other",
            platform="claude",
            idempotency_key="other-retry",
            session_secret=self.secret("z"),
        )

        self.assertEqual(repeated["id"], first["id"])
        self.assertIsNone(blocked)
        with self.assertRaises(PermissionDeniedError):
            self.sessions.claim(
                project_id="proj_1",
                candidates=[self.candidate],
                runner_id="runner",
                platform="codex",
                idempotency_key="retry",
                session_secret=self.secret("x"),
            )

    def test_concurrent_claims_start_only_one_owner(self) -> None:
        def attempt(index: int):
            return self.sessions.claim(
                project_id="proj_1",
                candidates=[self.candidate],
                runner_id=f"runner-{index}",
                platform="codex",
                idempotency_key=f"retry-{index}",
                session_secret=self.secret(str(index + 1)),
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)

    def test_first_use_activates_and_attempt_change_revokes(self) -> None:
        session = self.claim()
        authenticated = self.sessions.authenticate(session_secret=self.secret("r"))
        self.assertEqual(authenticated["status"], "active")
        self.assertEqual(authenticated["attempt_index"], 1)

        with self.store.transaction() as tx:
            tx.execute("UPDATE experiments SET attempt_index = 2 WHERE id = 'exp_1'")
        self.assertIsNone(self.sessions.authenticate(session_secret=self.secret("r")))
        closed = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(closed["status"], "expired")
        self.assertEqual(closed["close_reason"], "experiment_attempt_changed")
        self.assertEqual(closed["id"], session["id"])

    def test_independent_reviewer_can_coexist_with_experiment_owner(self) -> None:
        owner = self.claim()
        self.sessions.authenticate(session_secret=self.secret("r"))
        self.sessions.attach(
            session_id=owner["id"],
            runner_id="runner",
            host_session_ref="pid:1:birth",
            workspace_ref="merv/experiments/proj_1/exp_1",
            base_sha="1" * 40,
            head_sha="2" * 40,
        )
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO review_requests (
                  id, project_id, target_type, target_id, role, reason,
                  capability_hash, status, target_snapshot_id,
                  producer_session_id, expires_at, created_at, created_seq
                )
                VALUES (
                  'rr_1', 'proj_1', 'experiment', 'exp_1',
                  'design_reviewer', '', ?, 'requested', 'snapshot',
                  ?, '2999-01-01T00:00:00Z', ?, 1
                )
                """,
                (hash_secret("rp_capability"), owner["id"], now_iso()),
            )
        reviewer = self.sessions.claim(
            project_id="proj_1",
            candidates=[
                {
                    **self.candidate,
                    "kind": "review",
                    "review_request_id": "rr_1",
                }
            ],
            runner_id="review-runner",
            platform="claude",
            idempotency_key="review-retry",
            session_secret=self.secret("v"),
        )
        self.sessions.authenticate(session_secret=self.secret("v"))
        self.sessions.attach(
            session_id=reviewer["id"],
            runner_id="review-runner",
            host_session_ref="pid:2:birth",
            workspace_ref="merv/reviews/rr_1",
            base_sha="3" * 40,
            head_sha="4" * 40,
        )

        self.assertEqual(reviewer["kind"], "review")
        self.assertEqual(reviewer["review_request_id"], "rr_1")
        workspace = self.sessions.workspaces(
            project_id="proj_1", experiment_ids=("exp_1",)
        )["exp_1"]
        self.assertEqual(
            (workspace["branch"], workspace["base_sha"], workspace["head_sha"]),
            (
                "merv/experiments/proj_1/exp_1",
                "1" * 40,
                "2" * 40,
            ),
        )
        self.assertEqual(
            {
                item["kind"]
                for item in self.sessions.list(project_id="proj_1")["sessions"]
            },
            {"experiment", "review"},
        )
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE review_requests SET status = 'started' WHERE id = 'rr_1'"
            )
        self.sessions.release(
            session_id=reviewer["id"],
            runner_id="review-runner",
            reason="reviewer_process_stopped",
            head_sha="5" * 40,
        )
        replacement = self.sessions.claim(
            project_id="proj_1",
            candidates=[
                {
                    **self.candidate,
                    "kind": "review",
                    "review_request_id": "rr_1",
                }
            ],
            runner_id="replacement-reviewer",
            platform="codex",
            idempotency_key="replacement-review",
            session_secret=self.secret("w"),
        )
        self.assertEqual(replacement["review_request_id"], "rr_1")

    def test_failed_review_backoff_does_not_delay_a_new_review_request(self) -> None:
        with self.store.transaction() as tx:
            for index in (1, 2):
                tx.execute(
                    """
                    INSERT INTO review_requests (
                      id, project_id, target_type, target_id, role, reason,
                      capability_hash, status, target_snapshot_id,
                      producer_session_id, expires_at, created_at, created_seq
                    )
                    VALUES (
                      ?, 'proj_1', 'experiment', 'exp_1',
                      'design_reviewer', '', ?, 'requested', 'snapshot',
                      'producer', '2999-01-01T00:00:00Z', ?, ?
                    )
                    """,
                    (
                        f"rr_{index}",
                        hash_secret(f"rp_capability_{index}"),
                        now_iso(),
                        index,
                    ),
                )
        failed = self.sessions.claim(
            project_id="proj_1",
            candidates=[
                {
                    **self.candidate,
                    "kind": "review",
                    "review_request_id": "rr_1",
                }
            ],
            runner_id="failed-reviewer",
            platform="codex",
            idempotency_key="failed-review",
            session_secret=self.secret("f"),
        )
        self.sessions.release(
            session_id=failed["id"],
            runner_id="failed-reviewer",
            reason="host_process_stopped",
        )

        replacement = self.sessions.claim(
            project_id="proj_1",
            candidates=[
                {
                    **self.candidate,
                    "kind": "review",
                    "review_request_id": "rr_2",
                }
            ],
            runner_id="new-reviewer",
            platform="codex",
            idempotency_key="new-review",
            session_secret=self.secret("n"),
        )

        self.assertEqual(replacement["review_request_id"], "rr_2")

    def test_attach_is_one_time_and_heartbeat_keeps_the_same_host(self) -> None:
        session = self.claim()
        attached = self.sessions.attach(
            session_id=session["id"],
            runner_id="runner",
            host_session_ref="pid:1:birth",
            workspace_ref="merv/proj_1/exp_1/ags_1",
        )
        repeated = self.sessions.attach(
            session_id=session["id"],
            runner_id="runner",
            host_session_ref="pid:1:birth",
            workspace_ref="merv/proj_1/exp_1/ags_1",
        )
        self.sessions.authenticate(session_secret=self.secret("r"))
        self.sessions.heartbeat(session_id=session["id"], runner_id="runner")

        self.assertEqual(attached["host_session_ref"], "pid:1:birth")
        self.assertEqual(repeated["host_session_ref"], "pid:1:birth")
        self.assertEqual(repeated["workspace_ref"], "merv/proj_1/exp_1/ags_1")

    def test_assignment_setup_and_live_telemetry_are_public_but_bounded(self) -> None:
        session = self.claim()
        assignment = {
            "title": "Run experiment",
            "subtitle": "Experiment",
            "packet": {
                "task": "Run experiment",
                "project": "Project",
                "experiment": "Experiment",
                "attempt": 1,
            },
            "navigation": {
                "type": "experiment",
                "target_id": "exp_1",
                "section": "execution",
            },
        }
        self.sessions.set_assignment(session_id=session["id"], assignment=assignment)
        self.sessions.authenticate(session_secret=self.secret("r"))
        self.sessions.attach(
            session_id=session["id"],
            runner_id="runner",
            host_session_ref="pid:1:birth",
            agent_setup={
                "platform": "Codex",
                "harness": "codex",
                "model": "gpt-5.6-sol",
                "effort": "high",
                "machine": "research-mac",
            },
            telemetry={"total_tokens": 1200, "tool_calls": 3},
        )
        self.sessions.heartbeat(
            session_id=session["id"],
            runner_id="runner",
            telemetry={
                "input_tokens": 1400,
                "output_tokens": 600,
                "total_tokens": 2000,
                "tool_calls": 5,
                "raw_event": {"must": "not leave the runner"},
            },
        )

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["assignment"], assignment)
        self.assertEqual(current["agent_setup"]["machine"], "research-mac")
        self.assertEqual(
            current["telemetry"],
            {
                "input_tokens": 1400,
                "output_tokens": 600,
                "total_tokens": 2000,
                "tool_calls": 5,
            },
        )
        self.assertTrue(current["telemetry_at"])
        with self.assertRaisesRegex(ValidationError, "assignment is immutable"):
            self.sessions.set_assignment(
                session_id=session["id"], assignment={**assignment, "title": "Changed"}
            )
        with self.assertRaisesRegex(ValidationError, "setup is immutable"):
            self.sessions.attach(
                session_id=session["id"],
                runner_id="runner",
                host_session_ref="pid:1:birth",
                agent_setup={"platform": "Claude"},
            )

    def test_idle_runner_presence_names_the_live_machine(self) -> None:
        response = self.sessions.heartbeat_runner(
            project_id="proj_1",
            runner_id="runner",
            machine={
                "hostname": "research-mac",
                "system": "Darwin",
                "architecture": "arm64",
                "secret": "discard me",
            },
            platforms=[
                {
                    "name": "Codex",
                    "harness": "codex",
                    "model": "gpt-5.6-sol",
                    "parallelism": 2,
                    "enabled": True,
                    "managed": True,
                    "command": ["must", "not", "leave"],
                }
            ],
            capacity=2,
            inventory={
                "workspace": {"repository": "/repo", "root": "/repo-worktrees"},
                "available_commands": {"codex": True, "claude": False},
                "local_sessions": {"running": 0, "uncertain": 0},
                "secret": "discard me too",
                "harness": {
                    "skills": {"root": "/home/r/.merv/skills", "count": 8, "digest": "abc"},
                    "platforms": {
                        "Codex": {
                            "adapter": "codex",
                            "executable": "/usr/local/bin/codex",
                            "version": "codex-cli 0.144.4",
                            "merv_mcp": "native",
                            "skills": "mounted",
                            "ok": True,
                            "argv": ["must", "not", "leave"],
                        },
                        "Hermes": {
                            "adapter": "hermes",
                            "ok": False,
                            "problems": ["'hermes' is not on PATH"],
                        },
                    },
                },
            },
            applied_version=0,
        )

        presence = response["presence"]
        self.assertTrue(presence["live"])
        self.assertNotIn("runner_id", presence)
        self.assertEqual(len(presence["runner_ref"]), 24)
        self.assertEqual(presence["machine"]["hostname"], "research-mac")
        self.assertNotIn("secret", presence["machine"])
        self.assertEqual(presence["capacity"], 2)
        self.assertEqual(presence["inventory"]["available_commands"], {"claude": False, "codex": True})
        self.assertNotIn("secret", presence["inventory"])
        harness = presence["inventory"]["harness"]
        self.assertEqual(harness["skills"], {"root": "/home/r/.merv/skills", "count": 8, "digest": "abc"})
        self.assertEqual(harness["platforms"]["Codex"]["version"], "codex-cli 0.144.4")
        self.assertEqual(harness["platforms"]["Codex"]["merv_mcp"], "native")
        self.assertTrue(harness["platforms"]["Codex"]["ok"])
        self.assertNotIn("argv", harness["platforms"]["Codex"])
        self.assertEqual(harness["platforms"]["Hermes"]["problems"], ["'hermes' is not on PATH"])
        self.assertEqual(response["desired_version"], 0)
        self.assertEqual(response["desired_settings"], {})
        listing = self.sessions.list(project_id="proj_1")
        self.assertEqual(listing["runner"], presence)
        self.assertEqual(listing["runners"], [presence])
        self.assertNotIn("command", presence["platforms"][0])
        self.assertTrue(presence["platforms"][0]["enabled"])
        self.assertTrue(presence["platforms"][0]["managed"])

    def test_heartbeat_response_is_scoped_to_the_calling_runner(self) -> None:
        refs = {}
        for runner_id in ("runner-a", "runner-b"):
            refs[runner_id] = self.sessions.heartbeat_runner(
                project_id="proj_1",
                runner_id=runner_id,
                machine={"hostname": runner_id},
                platforms=[],
                capacity=0,
            )["presence"]["runner_ref"]
        self.assertNotEqual(refs["runner-a"], refs["runner-b"])
        saved = self.sessions.set_desired_settings(
            project_id="proj_1",
            runner_ref=refs["runner-a"],
            settings={
                "platforms": {"claude": {"enabled": True, "model": "opus", "parallelism": 2}},
                "workspace": {"repository": "/Users/me/repo", "root": "/Users/me/repo-worktrees", "base_ref": "main"},
            },
        )
        self.assertEqual(saved["desired_version"], 1)
        self.assertTrue(saved["settings_pending"])

        # runner-b heartbeated most recently, but runner-a still gets its own row.
        response = self.sessions.heartbeat_runner(
            project_id="proj_1",
            runner_id="runner-a",
            machine={"hostname": "runner-a"},
            platforms=[],
            capacity=0,
            applied_version=1,
        )
        self.assertEqual(response["presence"]["runner_ref"], refs["runner-a"])
        self.assertEqual(response["presence"]["machine"]["hostname"], "runner-a")
        self.assertEqual(response["desired_version"], 1)
        self.assertEqual(response["desired_settings"]["platforms"]["claude"]["model"], "opus")
        self.assertFalse(response["presence"]["settings_pending"])
        other = self.sessions.heartbeat_runner(
            project_id="proj_1",
            runner_id="runner-b",
            machine={"hostname": "runner-b"},
            platforms=[],
            capacity=0,
        )
        self.assertEqual(other["desired_version"], 0)
        listed = self.sessions.list(project_id="proj_1")["runners"]
        self.assertEqual({item["runner_ref"] for item in listed}, set(refs.values()))
        self.assertTrue(all("runner_id" not in item for item in listed))

        with self.assertRaises(ValidationError):
            self.sessions.set_desired_settings(
                project_id="proj_1",
                runner_ref=refs["runner-a"],
                settings={"platforms": {"claude": {"command": ["evil"]}}},
            )
        with self.assertRaises(ValidationError):
            self.sessions.set_desired_settings(
                project_id="proj_1",
                runner_ref=refs["runner-a"],
                settings={"platforms": {"agent-1": {"enabled": True}}},
            )
        with self.assertRaises(NotFoundError):
            self.sessions.set_desired_settings(
                project_id="proj_1", runner_ref="0" * 24, settings={}
            )

    def test_trace_excerpt_is_bounded_redacted_and_owner_only(self) -> None:
        session = self.claim()
        events = [
            {"type": "message", "text": "hello", "authorization": "Bearer abcdefghijklmnop"},
            {"type": "tool_call", "name": "workflow.status_and_next", "args": {"key": "mk_" + "a" * 43}},
            {"type": "big", "blob": "x" * 10_000},
        ]
        recorded = self.sessions.record_trace(
            session_id=session["id"],
            runner_id="runner",
            events=events,
            stderr_tail="warn: something\n",
            complete=False,
        )
        self.assertEqual(recorded["events"], 3)
        stored = self.sessions.trace(project_id="proj_1", session_id=session["id"])
        self.assertEqual(stored["stderr_tail"], "warn: something\n")
        self.assertFalse(stored["complete"])
        self.assertEqual(stored["events"][0]["authorization"], "<redacted>")
        self.assertEqual(stored["events"][1]["args"]["key"], "<redacted>")
        self.assertTrue(stored["events"][2].get("truncated"))
        with self.assertRaises(PermissionDeniedError):
            self.sessions.record_trace(
                session_id=session["id"], runner_id="other", events=[], stderr_tail=""
            )
        # Overwrite keeps the row bounded; a foreign project reads nothing.
        self.sessions.record_trace(
            session_id=session["id"],
            runner_id="runner",
            events=[{"i": index} for index in range(200)],
            stderr_tail="tail",
            complete=True,
        )
        again = self.sessions.trace(project_id="proj_1", session_id=session["id"])
        self.assertLessEqual(len(again["events"]), 60)
        self.assertEqual(again["events"][-1], {"i": 199})
        self.assertTrue(again["complete"])
        self.assertIsNone(self.sessions.trace(project_id="proj_other", session_id=session["id"]))

    def test_halt_session_closes_exactly_one_live_row(self) -> None:
        first = self.claim()
        with self.store.transaction() as tx:
            tx.execute(
                """
                INSERT INTO experiments (
                  id, project_id, name, intent, status, attempt_index,
                  created_at, updated_at
                )
                VALUES ('exp_2', 'proj_1', 'Second', 'Test it',
                        'planned', 1, ?, ?)
                """,
                (now_iso(), now_iso()),
            )
        second = self.sessions.claim(
            project_id="proj_1",
            candidates=[{"id": "exp_2", "status": "planned", "attempt_index": 1, "kind": "experiment"}],
            runner_id="runner",
            platform="codex",
            idempotency_key="second",
            session_secret="mas_" + "b" * 60,
        )
        halted = self.sessions.halt_session(project_id="proj_1", session_id=first["id"])
        self.assertEqual(halted["status"], "expired")
        self.assertEqual(halted["close_reason"], "halted_by_user")
        remaining = {
            item["id"]: item["status"]
            for item in self.sessions.list(project_id="proj_1")["sessions"]
        }
        self.assertEqual(remaining[second["id"]], "offered")
        with self.assertRaises(NotFoundError):
            self.sessions.halt_session(project_id="proj_1", session_id="ags_missing")

    def test_heartbeat_rejects_an_offer_until_the_agent_authenticates(self) -> None:
        session = self.claim()

        with self.assertRaisesRegex(ValidationError, "offered, not active"):
            self.sessions.heartbeat(
                session_id=session["id"],
                runner_id="runner",
            )

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["status"], "offered")

    def test_heartbeat_expires_a_due_session_before_renewing_it(self) -> None:
        session = self.claim()
        self.sessions.authenticate(session_secret=self.secret("r"))
        with self.store.transaction() as tx:
            tx.execute(
                """
                UPDATE agent_sessions
                SET lease_expires_at = '2000-01-01T00:00:00Z'
                WHERE id = ?
                """,
                (session["id"],),
            )

        with self.assertRaisesRegex(ValidationError, "expired, not live"):
            self.sessions.heartbeat(
                session_id=session["id"],
                runner_id="runner",
            )

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["status"], "expired")
        self.assertEqual(current["close_reason"], "lease_expired")

    def test_failed_launch_backoff_skips_only_the_same_platform_task(self) -> None:
        reasons = (
            "workspace_failed",
            "launch_failed",
            "host_process_crash_loop",
        )
        with self.store.transaction() as tx:
            for index in range(len(reasons)):
                for label in ("bad", "later"):
                    tx.execute(
                        """
                        INSERT INTO experiments (
                          id, project_id, name, intent, status, attempt_index,
                          created_at, updated_at
                        )
                        VALUES (?, 'proj_1', ?, 'Test dispatch recovery',
                                'planned', 1, ?, ?)
                        """,
                        (
                            f"exp_{label}_{index}",
                            f"{label.title()} {index}",
                            now_iso(),
                            now_iso(),
                        ),
                    )

        for index, reason in enumerate(reasons):
            with self.subTest(reason=reason):
                bad = {
                    **self.candidate,
                    "id": f"exp_bad_{index}",
                }
                later = {
                    **self.candidate,
                    "id": f"exp_later_{index}",
                }
                failed = self.sessions.claim(
                    project_id="proj_1",
                    candidates=[bad],
                    runner_id=f"failed-{index}",
                    platform="codex",
                    idempotency_key=f"failed-{index}",
                    session_secret=self.secret(f"f{index}"),
                )
                self.sessions.release(
                    session_id=failed["id"],
                    runner_id=f"failed-{index}",
                    reason=reason,
                )

                fallback = self.sessions.claim(
                    project_id="proj_1",
                    candidates=[bad, later],
                    runner_id=f"fallback-{index}",
                    platform="codex",
                    idempotency_key=f"fallback-{index}",
                    session_secret=self.secret(f"b{index}"),
                )
                self.assertEqual(fallback["target_id"], later["id"])
                self.sessions.release(
                    session_id=fallback["id"],
                    runner_id=f"fallback-{index}",
                )

                other_platform = self.sessions.claim(
                    project_id="proj_1",
                    candidates=[bad],
                    runner_id=f"other-{index}",
                    platform="claude",
                    idempotency_key=f"other-{index}",
                    session_secret=self.secret(f"o{index}"),
                )
                self.assertEqual(other_platform["target_id"], bad["id"])
                self.sessions.release(
                    session_id=other_platform["id"],
                    runner_id=f"other-{index}",
                )

    def test_normal_agent_exit_can_resume_the_same_experiment_immediately(self) -> None:
        first = self.claim()
        self.sessions.release(
            session_id=first["id"],
            runner_id="runner",
            reason="host_process_stopped",
        )

        resumed = self.sessions.claim(
            project_id="proj_1",
            candidates=[self.candidate],
            runner_id="replacement",
            platform="codex",
            idempotency_key="replacement",
            session_secret=self.secret("q"),
        )

        self.assertIsNotNone(resumed)
        self.assertEqual(resumed["target_id"], "exp_1")
