"""Runner side of the brain-mediated connection: pairing and brain-held tuning.

The brain half lives in tests/state/test_runner_pairing.py and
tests/surface/test_runner_pairing_api.py; these tests drive the machine-local
runner against fake HTTP answers and check what lands on disk and in memory.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from merv.client.agent_runner import (
    AgentRunner,
    Platform,
    RunnerCredentialError,
    SessionLedger,
    Workspace,
    WorkspaceManager,
    WorkspaceSettings,
    SETTINGS_VERSION_KEY,
    load_platforms,
    main as runner_main,
    merge_desired_settings,
)
from merv.client.cli import configure_agent, configure_client, configure_workspace
from merv.client.runner_pairing import (
    PairingError,
    PairingState,
    credential_path,
    load_pairing,
    pair,
    pairing_path,
    save_pairing,
)


class _ScriptedPairingClient:
    """Answers pairing/create and pairing/token from a script of outcomes."""

    def __init__(self, outcomes, *, project_id="proj_123", project_name="Paired"):
        self.outcomes = list(outcomes)
        self.created = []
        self.polls = 0
        self.project_id = project_id
        self.project_name = project_name

    def create(self, *, key_digest, runner_id, machine):
        self.created.append({"key_digest": key_digest, "runner_id": runner_id, "machine": dict(machine)})
        return {"device_code": "device-secret", "user_code": "7Q2KM4B9", "interval": 5, "expires_in": 600}

    def token(self, *, device_code):
        assert device_code == "device-secret"
        self.polls += 1
        outcome = self.outcomes.pop(0) if self.outcomes else "pending"
        if outcome == "approved":
            return "approved", {"status": "approved", "project_id": self.project_id, "project_name": self.project_name}
        if outcome == "gone":
            return "gone", {"reason": "expired"}
        return "pending", {"status": "pending"}


class _FakeSettingsClient:
    """Enough of AgentSessionsClient for report_presence/apply_desired/reconcile."""

    control_url = "https://merv.test"
    last_claim_reason = ""

    def __init__(self, response=None):
        self.response = response or {"desired_version": 0, "desired_settings": {}}
        self.heartbeats = []
        self.remote_sessions = []
        self.pending = None

    def heartbeat_runner(self, **payload):
        self.heartbeats.append(payload)
        return dict(self.response)

    def list(self, *, project_id):
        return self.remote_sessions

    def pending_advance(self, *, project_id):
        return self.pending

    def claim(self, **kwargs):
        return None


def _digest(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


class RunnerPairingClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = self.root / "client.json"
        self.machine = {"hostname": "lucia.local", "system": "Darwin", "architecture": "arm64"}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _pair(self, client, **overrides):
        kwargs = dict(
            config_path=self.config,
            control_url="https://merv.test",
            runner_id="runner-uuid",
            machine=self.machine,
            client=client,
            out=io.StringIO(),
            sleep=lambda _seconds: None,
        )
        kwargs.update(overrides)
        return pair(**kwargs)

    def test_key_stays_in_the_pairing_file_until_approval_then_promotes(self) -> None:
        client = _ScriptedPairingClient(["pending", "pending", "approved"])
        out = io.StringIO()
        project_id = self._pair(client, out=out)

        self.assertEqual(project_id, "proj_123")
        self.assertIn("7Q2K-M4B9", out.getvalue())
        self.assertIn("Paired with Paired", out.getvalue())
        self.assertEqual(client.polls, 3)
        key_file = credential_path(self.config)
        key = key_file.read_text().strip()
        self.assertRegex(key, r"^mk_[A-Za-z0-9_-]{43}$")
        self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
        self.assertEqual(client.created[0]["key_digest"], _digest(key))
        self.assertEqual(json.loads(self.config.read_text())["project_id"], "proj_123")
        self.assertFalse(pairing_path(self.config).exists())

    def test_pending_exchange_keeps_no_credential_and_resumes_the_same_code(self) -> None:
        # First process: create + poll once, then "crash" (we stop after 1 poll).
        first = _ScriptedPairingClient(["pending"])
        with self.assertRaises(StopIteration):
            def sleep_and_stop(_seconds):
                raise StopIteration
            self._pair(first, sleep=sleep_and_stop)
        self.assertFalse(credential_path(self.config).exists())
        state = load_pairing(pairing_path(self.config))
        self.assertIsNotNone(state)
        self.assertEqual(state.user_code, "7Q2KM4B9")
        digest_before = state.key_digest

        # Second process resumes: no new create, same device code, then approved.
        second = _ScriptedPairingClient(["approved"])
        out = io.StringIO()
        self._pair(second, out=out)
        self.assertEqual(second.created, [])
        self.assertIn("7Q2K-M4B9", out.getvalue())
        self.assertEqual(_digest(credential_path(self.config).read_text().strip()), digest_before)

    def test_crash_after_key_write_finishes_on_the_idempotent_answer(self) -> None:
        client = _ScriptedPairingClient(["approved"])

        def explode(_config_path, _project_id):
            raise OSError("disk full")

        with self.assertRaises(OSError):
            self._pair(client, project_writer=explode)
        # Key landed, project id did not, pairing file still knows the project.
        self.assertTrue(credential_path(self.config).exists())
        self.assertFalse(self.config.exists())
        state = load_pairing(pairing_path(self.config))
        self.assertEqual(state.project_id, "proj_123")

        # The brain keeps answering "approved" for ten minutes; the retry finishes.
        retry = _ScriptedPairingClient(["approved"])
        self.assertEqual(self._pair(retry), "proj_123")
        self.assertEqual(retry.created, [])
        self.assertEqual(json.loads(self.config.read_text())["project_id"], "proj_123")
        self.assertFalse(pairing_path(self.config).exists())

    def test_gone_after_local_promotion_is_treated_as_done(self) -> None:
        # Simulate: promoted key + project id on disk, pairing file left behind.
        key = "mk_" + "a" * 43
        credential_path(self.config).parent.mkdir(parents=True, exist_ok=True)
        credential_path(self.config).write_text(key + "\n")
        self.config.write_text(json.dumps({"project_id": "proj_123"}))
        save_pairing(
            pairing_path(self.config),
            PairingState(
                key=key,
                key_digest=_digest(key),
                device_code="device-secret",
                user_code="7Q2KM4B9",
                control_url="https://merv.test",
                expires_at=9e12,
                project_id="proj_123",
            ),
        )
        client = _ScriptedPairingClient(["gone"])
        self.assertEqual(self._pair(client), "proj_123")
        self.assertFalse(pairing_path(self.config).exists())

    def test_gone_without_promotion_discards_and_explains(self) -> None:
        client = _ScriptedPairingClient(["gone"])
        with self.assertRaisesRegex(PairingError, "merv-agent-runner pair"):
            self._pair(client)
        self.assertFalse(credential_path(self.config).exists())
        self.assertFalse(pairing_path(self.config).exists())

    def test_expired_pending_file_is_discarded_and_a_new_code_requested(self) -> None:
        save_pairing(
            pairing_path(self.config),
            PairingState(
                key="mk_" + "b" * 43,
                key_digest=_digest("mk_" + "b" * 43),
                device_code="old-device",
                user_code="OLDCODE1",
                control_url="https://merv.test",
                expires_at=1.0,
            ),
        )
        client = _ScriptedPairingClient(["approved"])
        out = io.StringIO()
        self._pair(client, out=out)
        self.assertEqual(len(client.created), 1)
        self.assertNotIn("OLDC-ODE1", out.getvalue())
        self.assertFalse(credential_path(self.config).read_text().startswith("mk_bbbb"))


class RunnerSettingsApplyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.config = self.root / "client.json"
        configure_client(config_path=self.config, control_url="https://merv.test")
        configure_agent(config_path=self.config, platform="codex", model="gpt-old", parallelism=2)
        configure_workspace(
            config_path=self.config,
            strategy="git_worktree",
            repository=str(self.root / "repo"),
            root=str(self.root / "worktrees"),
            base_ref="main",
        )
        # A CLI-only custom agent that brain-held settings must never touch.
        document = json.loads(self.config.read_text())
        document["agent_platforms"]["agent-1"] = {
            "adapter": "command",
            "command": ["/opt/my-agent", "--jsonl"],
            "enabled": True,
            "parallelism": 1,
        }
        self.config.write_text(json.dumps(document, indent=2))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _runner(self, client=None, platforms=None):
        ledger = SessionLedger(self.root / "sessions.json")
        return AgentRunner(
            project_id="proj_1",
            platforms=platforms if platforms is not None else load_platforms(self.config, include_disabled=True),
            client=client or _FakeSettingsClient(),
            ledger=ledger,
            workspaces=WorkspaceManager(WorkspaceSettings("git_worktree", self.root / "repo", self.root / "worktrees", "main")),
            trace_dir=self.root / "traces",
            runner_secret=b"r" * 32,
            config_path=self.config,
        )

    def test_merge_touches_only_native_tuning_and_creates_with_default_executable(self) -> None:
        document = json.loads(self.config.read_text())
        merged = merge_desired_settings(
            document,
            {
                "platforms": {
                    "codex": {"enabled": True, "model": "gpt-new", "effort": "high", "parallelism": 3},
                    "cursor": {"enabled": True},
                    "agent-1": {"enabled": False},  # would be rejected upstream; merge must still ignore
                },
                "workspace": {"repository": "/srv/repo", "root": "/srv/repo-worktrees", "base_ref": "dev"},
            },
        )
        self.assertEqual(merged["agent_platforms"]["agent-1"], document["agent_platforms"]["agent-1"])
        codex = merged["agent_platforms"]["codex"]
        self.assertEqual((codex["model"], codex["effort"], codex["parallelism"], codex["enabled"]), ("gpt-new", "high", 3, True))
        self.assertEqual(codex["command"], document["agent_platforms"]["codex"]["command"])
        self.assertEqual(merged["agent_platforms"]["cursor"]["command"], ["cursor-agent"])
        self.assertEqual(merged["agent_workspace"], {"repository": "/srv/repo", "root": "/srv/repo-worktrees", "base_ref": "dev", "strategy": "git_worktree"})

    def test_load_platforms_defaults_cursor_to_cursor_agent_and_reports_disabled(self) -> None:
        document = json.loads(self.config.read_text())
        document["agent_platforms"]["cursor"] = {"enabled": False}
        self.config.write_text(json.dumps(document))
        enabled_only = load_platforms(self.config)
        every = load_platforms(self.config, include_disabled=True)
        self.assertEqual({item.name for item in enabled_only}, {"codex", "agent-1"})
        cursor = next(item for item in every if item.name == "cursor")
        self.assertEqual(cursor.command, ("cursor-agent",))
        self.assertFalse(cursor.enabled)

    def test_apply_desired_writes_client_json_hot_applies_and_reports_versions(self) -> None:
        client = _FakeSettingsClient(
            {
                "desired_version": 3,
                "desired_settings": {
                    "platforms": {"codex": {"model": "gpt-new", "parallelism": 4}, "claude": {"enabled": True, "model": "opus"}}
                },
            }
        )
        runner = self._runner(client)
        with redirect_stdout(io.StringIO()):
            response = runner.report_presence()
            runner.apply_desired(response)

        self.assertEqual(client.heartbeats[0]["applied_version"], 0)
        by_name = {item.name: item for item in runner.platforms}
        self.assertEqual(by_name["codex"].model, "gpt-new")
        self.assertEqual(by_name["codex"].parallelism, 4)
        self.assertEqual(by_name["claude"].command, ("claude",))
        self.assertTrue(by_name["claude"].enabled)
        self.assertEqual(by_name["agent-1"].command, ("/opt/my-agent", "--jsonl"))
        self.assertEqual(runner.applied_settings_version, 3)
        document = json.loads(self.config.read_text())
        self.assertEqual(document[SETTINGS_VERSION_KEY], 3)
        self.assertEqual(document["agent_platforms"]["codex"]["model"], "gpt-new")
        with redirect_stdout(io.StringIO()):
            runner.report_presence()
        self.assertEqual(client.heartbeats[1]["applied_version"], 3)
        inventory = client.heartbeats[1]["inventory"]
        self.assertIn("available_commands", inventory)
        self.assertEqual(inventory["local_sessions"], {"running": 0, "uncertain": 0})
        self.assertNotIn("pending", inventory)
        platforms = {item["name"]: item for item in client.heartbeats[1]["platforms"]}
        self.assertTrue(platforms["codex"]["managed"])
        self.assertFalse(platforms["agent-1"]["managed"])
        for item in client.heartbeats[1]["platforms"]:
            self.assertNotIn("command", item)

    def test_rejected_payload_changes_nothing_and_reports_the_error(self) -> None:
        client = _FakeSettingsClient(
            {"desired_version": 2, "desired_settings": {"platforms": {"codex": {"command": ["rm", "-rf", "/"]}}}}
        )
        runner = self._runner(client)
        before = self.config.read_text()
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            runner.apply_desired(runner.report_presence())
            runner.report_presence()
        self.assertEqual(self.config.read_text(), before)
        self.assertEqual(runner.applied_settings_version, 0)
        self.assertIn("command", client.heartbeats[1]["inventory"]["settings_error"])

    def test_disabling_a_platform_with_a_live_session_drains_instead_of_removing(self) -> None:
        client = _FakeSettingsClient(
            {"desired_version": 1, "desired_settings": {"platforms": {"codex": {"enabled": False}}}}
        )
        runner = self._runner(client)
        # A live local session on codex.
        from merv.client.agent_runner import Claim
        session = runner.ledger.reserve(Claim("ags_1", "exp_1", "proj_1"), runner._platform("codex"))
        session.status = "running"
        with redirect_stdout(io.StringIO()):
            runner.apply_desired(runner.report_presence())
        codex = runner._platform("codex")  # still resolvable for reconcile/telemetry
        self.assertFalse(codex.enabled)
        self.assertEqual(runner.fill_available_slots(), 0)  # never claims for it
        capacity = client.heartbeats[-1]["capacity"]
        with redirect_stdout(io.StringIO()):
            runner.report_presence()
        self.assertEqual(client.heartbeats[-1]["capacity"], 1)  # only agent-1 counts

    def test_workspace_change_waits_for_idle_and_reports_why(self) -> None:
        client = _FakeSettingsClient(
            {
                "desired_version": 5,
                "desired_settings": {"workspace": {"repository": str(self.root / "other"), "root": str(self.root / "other-worktrees"), "base_ref": "main"}},
            }
        )
        runner = self._runner(client)
        from merv.client.agent_runner import Claim
        session = runner.ledger.reserve(Claim("ags_1", "exp_1", "proj_1"), runner._platform("codex"))
        session.status = "running"
        with redirect_stdout(io.StringIO()):
            runner.apply_desired(runner.report_presence())
        self.assertEqual(runner.workspaces.settings.repository, self.root / "repo")  # not swapped
        self.assertEqual(runner.applied_settings_version, 0)
        with redirect_stdout(io.StringIO()):
            runner.report_presence()
        self.assertIn("waits for 1 running job", client.heartbeats[-1]["inventory"]["pending"]["reason"])
        # client.json already holds the new workspace; the manager swaps once idle.
        self.assertEqual(json.loads(self.config.read_text())["agent_workspace"]["repository"], str(self.root / "other"))
        session.status = "stopped"
        with redirect_stdout(io.StringIO()):
            runner.apply_desired(runner.report_presence())
        self.assertEqual(runner.workspaces.settings.repository, self.root / "other")
        self.assertEqual(runner.applied_settings_version, 5)

    def test_prune_frees_a_slot_only_for_a_visibly_closed_dead_session(self) -> None:
        client = _FakeSettingsClient()
        runner = self._runner(client)
        from merv.client.agent_runner import Claim
        stuck = runner.ledger.reserve(Claim("ags_stuck", "exp_1", "proj_1"), runner._platform("codex"))
        stuck.status = "uncertain"
        held = runner.ledger.reserve(Claim("ags_held", "exp_2", "proj_1"), runner._platform("codex"))
        held.status = "uncertain"
        client.remote_sessions = [{"id": "ags_stuck", "status": "expired"}]  # ags_held absent
        with redirect_stderr(io.StringIO()):
            runner.reconcile()
        self.assertEqual(runner.ledger.sessions["ags_stuck"].status, "expired")
        self.assertEqual(runner.ledger.sessions["ags_held"].status, "uncertain")


class RunnerMainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.config = self.root / "client.json"
        configure_client(config_path=self.config, control_url="https://merv.test")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_first_run_pairs_then_dispatches_with_zero_platforms(self) -> None:
        def fake_pair(**kwargs):
            credential_path(kwargs["config_path"]).write_text("mk_" + "c" * 43 + "\n")
            document = json.loads(kwargs["config_path"].read_text())
            document["project_id"] = "proj_paired"
            kwargs["config_path"].write_text(json.dumps(document))
            return "proj_paired"

        with (
            patch("merv.client.agent_runner.pair_runner", side_effect=fake_pair) as paired,
            patch("merv.client.agent_runner._run_runner") as run,
            redirect_stdout(io.StringIO()) as out,
        ):
            code = runner_main(["--config", str(self.config)])
        self.assertEqual(code, 0)
        self.assertEqual(paired.call_count, 1)
        runner = run.call_args.args[0]
        self.assertEqual(runner.project_id, "proj_paired")
        self.assertEqual(runner.platforms, ())
        self.assertIn("no agents enabled yet", out.getvalue())

        # Second run: paired already, project remembered, no pairing.
        with (
            patch("merv.client.agent_runner.pair_runner") as paired,
            patch("merv.client.agent_runner._run_runner") as run,
            redirect_stdout(io.StringIO()),
        ):
            code = runner_main(["--config", str(self.config)])
        self.assertEqual(code, 0)
        self.assertEqual(paired.call_count, 0)
        self.assertEqual(run.call_args.args[0].project_id, "proj_paired")

    def test_pair_command_forces_a_new_exchange_even_when_paired(self) -> None:
        credential_path(self.config).write_text("mk_" + "d" * 43 + "\n")
        with (
            patch("merv.client.agent_runner.pair_runner", return_value="proj_again") as paired,
            patch("merv.client.agent_runner._run_runner"),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()) as err,
        ):
            code = runner_main(["pair", "--config", str(self.config)])
        self.assertEqual(code, 0)
        self.assertEqual(paired.call_count, 1)
        self.assertIn("previous credential stays registered", err.getvalue())

    def test_revoked_credential_stops_with_a_repair_instruction(self) -> None:
        credential_path(self.config).write_text("mk_" + "e" * 43 + "\n")
        document = json.loads(self.config.read_text())
        document["project_id"] = "proj_x"
        self.config.write_text(json.dumps(document))
        with (
            patch("merv.client.agent_runner._run_runner", side_effect=RunnerCredentialError("Merv rejected this runner's credential; run `merv-agent-runner pair`")),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()) as err,
        ):
            code = runner_main(["--config", str(self.config)])
        self.assertEqual(code, 2)
        self.assertIn("merv-agent-runner pair", err.getvalue())

    def test_loopback_brain_needs_no_pairing_but_needs_a_project(self) -> None:
        configure_client(config_path=self.config, control_url="http://127.0.0.1:8787")
        with (
            patch("merv.client.agent_runner.pair_runner") as paired,
            patch("merv.client.agent_runner._run_runner") as run,
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()) as err,
        ):
            missing = runner_main(["--config", str(self.config)])
            ok = runner_main(["--config", str(self.config), "--project", "proj_local"])
        self.assertEqual(missing, 2)
        self.assertIn("--project is required", err.getvalue())
        self.assertEqual(ok, 0)
        self.assertEqual(paired.call_count, 0)
        self.assertEqual(run.call_args.args[0].project_id, "proj_local")


if __name__ == "__main__":
    unittest.main()
