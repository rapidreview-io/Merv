from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from merv.brain.agent_sessions import AgentSessions
from merv.brain.kernel.state import StateStore
from merv.brain.kernel.utils import NotFoundError, PermissionDeniedError, ValidationError, WorkflowError, now_iso


@dataclass
class Fact:
    instance_id: str
    revision: int
    terminal: bool = False
    label: str = "Do the work"


class FakeFacts:
    """Research's instance facts, without any research table."""

    def __init__(self) -> None:
        self.rows: dict[str, Fact] = {}

    def instance(self, *, project_id: str, instance_id: str):
        return self.rows.get(instance_id)


PERSISTENT = {
    "read_only": False, "tools": ["widget.transition"], "mutating": ["widget.transition"],
    "scope": [{"field": "widget_id", "source": "instance", "tools": []}], "sandbox": False,
    "workspace": {"mode": "persistent", "namespace": "widgets", "base": "central",
                  "per_base": False, "retain": True, "advances_central": False},
}
EPHEMERAL = {
    "read_only": True, "tools": ["review.start", "review.submit"], "mutating": [],
    "scope": [{"field": "review_request_id", "source": "reference:review_request", "tools": ["review.start", "review.submit"]}],
    "sandbox": False,
    "workspace": {"mode": "ephemeral", "namespace": "reviews", "base": "reference:code",
                  "per_base": False, "retain": False, "advances_central": False},
}


class AgentSessionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.temp.name) / "state.sqlite")
        with self.store.transaction() as tx:
            tx.execute(
                "INSERT INTO projects (id, name, created_at) VALUES ('proj_1', 'Project', ?)",
                (now_iso(),),
            )
        self.facts = FakeFacts()
        self.facts.rows["wf_1"] = Fact("wf_1", 0)
        self.packets: dict[tuple[str, int], dict] = {("wf_1", 0): self.packet("wf_1", 0)}
        self.sessions = AgentSessions(store=self.store, facts=self.facts)
        self.activated: list[str] = []
        self.sessions.bind_workflows(assignment=self.assignment, activate=lambda tx, row: self.activated.append(row["id"]))
        self.candidate = {"instance_id": "wf_1", "revision": 0}

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def packet(instance_id: str, revision: int, *, execution: dict = PERSISTENT, references=(), label="Do the work") -> dict:
        return {
            "instance_id": instance_id, "workflow": "widget", "state": "working", "revision": revision,
            "role": "widget_owner", "label": label, "brief": f"Work on {instance_id}.",
            "execution": execution, "references": list(references),
            "instruction": f"Continue {instance_id} at revision {revision}.",
        }

    def assignment(self, tx, project_id: str, instance_id: str, revision: int) -> dict:
        fact = self.facts.rows.get(instance_id)
        if fact is None or fact.terminal or fact.revision != revision:
            raise WorkflowError("assignment is stale")
        return self.packets[(instance_id, revision)]

    @staticmethod
    def secret(runner: str) -> str:
        """One high-entropy-shaped credential per runner name."""
        return "mas_" + runner.replace("-", "_").ljust(60, "x")

    def claim(self, *, runner: str = "runner", key: str = "retry", candidates=None, platform="codex"):
        return self.sessions.lease(
            project_id="proj_1",
            candidates=[self.candidate] if candidates is None else candidates,
            runner_id=runner,
            platform=platform,
            idempotency_key=key,
            session_secret=self.secret(runner),
        )

    def test_claim_freezes_the_packet_and_one_live_lease_is_database_enforced(self) -> None:
        first = self.claim()
        repeated = self.claim()
        blocked = self.sessions.lease(
            project_id="proj_1", candidates=[self.candidate], runner_id="other", platform="claude",
            idempotency_key="other-retry", session_secret=self.secret("z"),
        )

        self.assertEqual(repeated["id"], first["id"])
        self.assertIsNone(blocked)
        self.assertEqual((first["target_type"], first["target_id"]), ("widget", "wf_1"))
        self.assertEqual((first["workflow_instance_id"], first["workflow_revision"], first["workflow_node"]), ("wf_1", 0, "working"))
        self.assertEqual(first["role"], "widget_owner")
        self.assertEqual(first["execution"], PERSISTENT)
        self.assertEqual(first["references"], [])
        self.assertEqual(first["assignment"]["brief"], "Work on wf_1.")
        self.assertEqual(first["instruction"], "Continue wf_1 at revision 0.")
        self.assertNotIn("secret_digest", first)
        for legacy in ("kind", "review_request_id", "source_sha", "experiment_id"):
            self.assertNotIn(legacy, first)
        with self.assertRaises(PermissionDeniedError):
            self.sessions.lease(
                project_id="proj_1", candidates=[self.candidate], runner_id="runner", platform="codex",
                idempotency_key="retry", session_secret=self.secret("different"),
            )

    def test_candidates_without_a_current_assignment_are_skipped(self) -> None:
        self.facts.rows["wf_2"] = Fact("wf_2", 4)
        self.packets[("wf_2", 4)] = self.packet("wf_2", 4)
        chosen = self.claim(candidates=[{"instance_id": "wf_1", "revision": 1}, {"id": "legacy"}, {"instance_id": "wf_2", "revision": 4}])
        self.assertEqual(chosen["workflow_instance_id"], "wf_2")
        self.assertEqual(chosen["workflow_revision"], 4)

    def test_concurrent_claims_start_only_one_owner(self) -> None:
        def attempt(index: int):
            return self.sessions.lease(
                project_id="proj_1", candidates=[self.candidate], runner_id=f"runner-{index}", platform="codex",
                idempotency_key=f"retry-{index}", session_secret=self.secret(f"runner-{index}"),
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)

    def test_first_use_activates_and_a_changed_or_finished_instance_revokes(self) -> None:
        session = self.claim()
        authenticated = self.sessions.authenticate(session_secret=self.secret("runner"))
        self.assertEqual(authenticated["status"], "active")
        self.assertEqual(authenticated["execution"], PERSISTENT)
        self.assertEqual(authenticated["tenant_id"], "local")
        self.assertEqual(self.activated, [session["id"]])

        self.facts.rows["wf_1"] = Fact("wf_1", 1)
        self.assertIsNone(self.sessions.authenticate(session_secret=self.secret("runner")))
        closed = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual((closed["id"], closed["status"], closed["close_reason"]), (session["id"], "expired", "workflow_assignment_changed"))

        self.packets[("wf_1", 1)] = self.packet("wf_1", 1)
        again = self.claim(runner="second", key="second", candidates=[{"instance_id": "wf_1", "revision": 1}])
        self.facts.rows["wf_1"] = Fact("wf_1", 1, terminal=True)
        self.assertIsNone(self.sessions.authenticate(session_secret=self.secret("second")))
        rows = {row["id"]: row for row in self.sessions.list(project_id="proj_1")["sessions"]}
        self.assertEqual(rows[again["id"]]["close_reason"], "instance_terminal")
        del self.facts.rows["wf_1"]
        self.packets[("wf_3", 0)] = self.packet("wf_3", 0)
        self.facts.rows["wf_3"] = Fact("wf_3", 0)
        third = self.claim(runner="third", key="third", candidates=[{"instance_id": "wf_3", "revision": 0}])
        del self.facts.rows["wf_3"]
        self.assertIsNone(self.sessions.authenticate(session_secret=self.secret("third")))
        rows = {row["id"]: row for row in self.sessions.list(project_id="proj_1")["sessions"]}
        self.assertEqual(rows[third["id"]]["close_reason"], "instance_missing")

    def test_leases_without_instance_facts_fail_closed(self) -> None:
        sessions = AgentSessions(store=self.store)
        sessions.bind_workflows(assignment=self.assignment, activate=lambda tx, row: None)
        session = sessions.lease(
            project_id="proj_1", candidates=[self.candidate], runner_id="blind", platform="codex",
            idempotency_key="blind", session_secret=self.secret("blind"),
        )
        self.assertIsNone(sessions.authenticate(session_secret=self.secret("blind")))
        closed = sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual((closed["id"], closed["close_reason"]), (session["id"], "workflow_authority_unavailable"))

    def test_persistent_workspaces_are_retained_per_instance_and_ephemeral_ones_are_not(self) -> None:
        owner = self.claim()
        self.sessions.authenticate(session_secret=self.secret("runner"))
        self.sessions.attach(
            session_id=owner["id"], runner_id="runner", host_session_ref="pid:1:birth",
            workspace_ref="merv/widgets/proj_1/wf_1", base_sha="1" * 40, head_sha="2" * 40,
            workspace_stats={"commit_count": 2, "files_changed": 3, "insertions": 10, "deletions": 1},
        )
        self.facts.rows["wf_1"] = Fact("wf_1", 1)
        self.packets[("wf_1", 1)] = self.packet("wf_1", 1, execution=EPHEMERAL,
                                                references=[{"kind": "review_request", "id": "rr_1", "label": ""},
                                                            {"kind": "code", "id": "2" * 40, "label": ""}])
        reviewer = self.claim(runner="verifier", key="verify", candidates=[{"instance_id": "wf_1", "revision": 1}], platform="claude")
        self.sessions.authenticate(session_secret=self.secret("verifier"))
        self.sessions.attach(
            session_id=reviewer["id"], runner_id="verifier", host_session_ref="pid:2:birth",
            workspace_ref="merv/reviews/proj_1/wf_1/" + reviewer["id"], base_sha="3" * 40, head_sha="4" * 40,
        )

        self.assertEqual(reviewer["execution"]["read_only"], True)
        self.assertEqual([item["kind"] for item in reviewer["references"]], ["review_request", "code"])
        workspace = self.sessions.workspaces(project_id="proj_1", instance_ids=("wf_1",))["wf_1"]
        self.assertEqual(
            (workspace["branch"], workspace["base_sha"], workspace["head_sha"], workspace["commit_count"]),
            ("merv/widgets/proj_1/wf_1", "1" * 40, "2" * 40, 2),
        )
        self.assertEqual(self.sessions.workspaces(project_id="proj_1", instance_ids=()), {})
        statuses = {row["id"]: row["status"] for row in self.sessions.list(project_id="proj_1")["sessions"]}
        self.assertEqual(statuses, {owner["id"]: "expired", reviewer["id"]: "active"})
        self.assertEqual(self.sessions.live_leases(project_id="proj_1"), {("wf_1", 1)})
        self.assertEqual(self.sessions.workflow_producer(project_id="proj_1", instance_id="wf_1", revision=0), owner["id"])

    def test_attach_is_one_time_and_heartbeat_keeps_the_same_host(self) -> None:
        session = self.claim()
        attached = self.sessions.attach(
            session_id=session["id"], runner_id="runner", host_session_ref="pid:1:birth",
            workspace_ref="merv/proj_1/wf_1/ags_1",
        )
        repeated = self.sessions.attach(
            session_id=session["id"], runner_id="runner", host_session_ref="pid:1:birth",
            workspace_ref="merv/proj_1/wf_1/ags_1",
        )
        self.sessions.authenticate(session_secret=self.secret("runner"))
        self.sessions.heartbeat(session_id=session["id"], runner_id="runner")

        self.assertEqual(attached["host_session_ref"], "pid:1:birth")
        self.assertEqual(repeated["host_session_ref"], "pid:1:birth")
        self.assertEqual(repeated["workspace_ref"], "merv/proj_1/wf_1/ags_1")
        with self.assertRaises(PermissionDeniedError):
            self.sessions.attach(session_id=session["id"], runner_id="runner", host_session_ref="pid:9:other")

    def test_setup_and_live_telemetry_are_public_but_bounded(self) -> None:
        session = self.claim()
        self.sessions.authenticate(session_secret=self.secret("runner"))
        self.sessions.attach(
            session_id=session["id"], runner_id="runner", host_session_ref="pid:1:birth",
            agent_setup={"platform": "Codex", "harness": "codex", "model": "gpt-5.6-sol", "effort": "high", "machine": "research-mac"},
            telemetry={"total_tokens": 1200, "tool_calls": 3},
        )
        self.sessions.heartbeat(
            session_id=session["id"], runner_id="runner",
            telemetry={"input_tokens": 1400, "output_tokens": 600, "total_tokens": 2000, "tool_calls": 5,
                       "raw_event": {"must": "not leave the runner"}},
        )

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["assignment"], self.packets[("wf_1", 0)])
        self.assertEqual(current["agent_setup"]["machine"], "research-mac")
        self.assertEqual(current["telemetry"], {"input_tokens": 1400, "output_tokens": 600, "total_tokens": 2000, "tool_calls": 5})
        with self.assertRaisesRegex(ValidationError, "setup is immutable"):
            self.sessions.attach(
                session_id=session["id"], runner_id="runner", host_session_ref="pid:1:birth",
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
            stderr_tail="warn: refused with Bearer abcdefghijklmnop\n",
            complete=False,
        )
        self.assertEqual(recorded["events"], 3)
        stored = self.sessions.trace(project_id="proj_1", session_id=session["id"])
        # The runner only caps; masking happens here, where it is persisted.
        self.assertEqual(stored["stderr_tail"], "warn: refused with <redacted>\n")
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
        self.facts.rows["wf_2"] = Fact("wf_2", 0)
        self.packets[("wf_2", 0)] = self.packet("wf_2", 0)
        second = self.claim(runner="runner-2", key="second", candidates=[{"instance_id": "wf_2", "revision": 0}])
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
            self.sessions.heartbeat(session_id=session["id"], runner_id="runner")

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["status"], "offered")

    def test_heartbeat_expires_a_due_session_before_renewing_it(self) -> None:
        session = self.claim()
        self.sessions.authenticate(session_secret=self.secret("runner"))
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE agent_sessions SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?",
                (session["id"],),
            )

        with self.assertRaisesRegex(ValidationError, "expired, not live"):
            self.sessions.heartbeat(session_id=session["id"], runner_id="runner")

        current = self.sessions.list(project_id="proj_1")["sessions"][0]
        self.assertEqual(current["status"], "expired")
        self.assertEqual(current["close_reason"], "lease_expired")

    def test_failed_launch_backoff_skips_only_the_same_platform_lease(self) -> None:
        reasons = ("workspace_failed", "launch_failed", "host_process_crash_loop")
        for index in range(len(reasons)):
            for label in ("bad", "later"):
                instance_id = f"wf_{label}_{index}"
                self.facts.rows[instance_id] = Fact(instance_id, 0)
                self.packets[(instance_id, 0)] = self.packet(instance_id, 0)

        for index, reason in enumerate(reasons):
            with self.subTest(reason=reason):
                bad = {"instance_id": f"wf_bad_{index}", "revision": 0}
                later = {"instance_id": f"wf_later_{index}", "revision": 0}
                failed = self.claim(runner=f"failed-{index}", key=f"failed-{index}", candidates=[bad])
                self.sessions.release(session_id=failed["id"], runner_id=f"failed-{index}", reason=reason)

                fallback = self.claim(runner=f"fallback-{index}", key=f"fallback-{index}", candidates=[bad, later])
                self.assertEqual(fallback["workflow_instance_id"], later["instance_id"])
                self.sessions.release(session_id=fallback["id"], runner_id=f"fallback-{index}")

                other_platform = self.claim(runner=f"other-{index}", key=f"other-{index}", candidates=[bad], platform="claude")
                self.assertEqual(other_platform["workflow_instance_id"], bad["instance_id"])
                self.sessions.release(session_id=other_platform["id"], runner_id=f"other-{index}")

    def test_old_closed_leases_and_their_traces_are_swept(self) -> None:
        """A live lease and a recently closed one are not history yet."""
        old = self.claim()
        self.sessions.record_trace(
            session_id=old["id"], runner_id="runner", events=[{"i": 1}], stderr_tail=""
        )
        self.sessions.release(session_id=old["id"], runner_id="runner")
        self.facts.rows["wf_2"] = Fact("wf_2", 0)
        self.packets[("wf_2", 0)] = self.packet("wf_2", 0)
        recent = self.claim(runner="runner-2", key="second",
                            candidates=[{"instance_id": "wf_2", "revision": 0}])
        self.facts.rows["wf_3"] = Fact("wf_3", 0)
        self.packets[("wf_3", 0)] = self.packet("wf_3", 0)
        live = self.claim(runner="runner-3", key="third",
                          candidates=[{"instance_id": "wf_3", "revision": 0}])
        self.sessions.release(session_id=recent["id"], runner_id="runner-2")

        month = datetime.now(UTC) + timedelta(days=31)
        with self.store.transaction() as tx:
            tx.execute(
                "UPDATE agent_sessions SET closed_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00Z", old["id"]),
            )
        self.assertEqual(self.sessions.prune(now=datetime.now(UTC)), 1)
        self.assertIsNone(self.sessions.trace(project_id="proj_1", session_id=old["id"]))
        self.assertEqual(
            {item["id"] for item in self.sessions.list(project_id="proj_1")["sessions"]},
            {recent["id"], live["id"]},
        )

        # A month on, the released lease is history too and the live one stands.
        self.assertEqual(self.sessions.prune(now=month), 1)
        self.assertEqual(
            [item["id"] for item in self.sessions.list(project_id="proj_1")["sessions"]],
            [live["id"]],
        )

    def test_normal_agent_exit_can_resume_the_same_instance_immediately(self) -> None:
        first = self.claim()
        self.sessions.release(session_id=first["id"], runner_id="runner", reason="host_process_stopped")

        resumed = self.claim(runner="replacement", key="replacement")

        self.assertIsNotNone(resumed)
        self.assertEqual(resumed["workflow_instance_id"], "wf_1")
        self.assertNotEqual(resumed["id"], first["id"])
