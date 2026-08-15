from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from merv.client.agent_runner import (
    AgentRunner,
    AgentSessionsClient,
    Claim,
    ClaudeHost,
    CodexHost,
    CommandHost,
    CopilotHost,
    CursorHost,
    GeminiHost,
    HermesHost,
    HostSession,
    OpenCodeHost,
    Platform,
    QwenHost,
    RunnerError,
    SessionLedger,
    Workspace,
    WorkspaceManager,
    WorkspaceSettings,
    _child_environment,
    _detected_commands,
    _local_status,
    _runner_key,
    _read_trace_telemetry,
    _run_runner,
    _safe_control_url,
    _session_key,
    load_platforms,
    load_workspace_settings,
    main as runner_main,
)
from merv.client.cli import (
    ClientError,
    configure_agent,
    configure_client,
    configure_workspace,
    main,
)
from merv.client.local_control import (
    local_control,
    pairing_token,
    private_token,
    start_in_background,
)


class AgentConfigurationTest(unittest.TestCase):
    def test_settings_service_hands_the_same_process_to_the_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            config_path = root / "client.json"
            configure_client(
                config_path=config_path,
                control_url="http://127.0.0.1:8787",
            )
            configure_agent(config_path=config_path, platform="codex")
            configure_workspace(
                config_path=config_path,
                strategy="git_worktree",
                repository=str(root / "repository"),
                root=str(root / "worktrees"),
                base_ref="main",
            )

            calls: list[dict[str, object]] = []

            class FakeServer:
                def __init__(self, start=None) -> None:
                    self.start = start

                def serve_forever(self) -> None:
                    self.start("proj_123")

                def shutdown(self) -> None:
                    return

                def server_close(self) -> None:
                    return

            def fake_local_control(**kwargs):
                calls.append(kwargs)
                return FakeServer(kwargs.get("start"))

            with (
                patch(
                    "merv.client.agent_runner.local_control",
                    side_effect=fake_local_control,
                ),
                patch("merv.client.agent_runner.start_in_background"),
                patch("merv.client.agent_runner._run_runner") as run,
                redirect_stdout(io.StringIO()),
            ):
                result = runner_main(
                    ["--settings-only", "--config", str(config_path)]
                )

            self.assertEqual(result, 0)
            self.assertEqual(len(calls), 2)
            self.assertIsNotNone(calls[0]["start"])
            self.assertIsNone(calls[1].get("start"))
            launched = run.call_args.args[0]
            self.assertEqual(launched.project_id, "proj_123")
            settings_changed = calls[1].get("settings_changed")
            self.assertIsNotNone(settings_changed)

            configure_agent(
                config_path=config_path,
                platform="codex",
                model="gpt-tuned",
                effort="medium",
            )
            self.assertFalse(settings_changed(config_path))
            self.assertEqual(launched.platforms[0].model, "gpt-tuned")
            self.assertEqual(launched.platforms[0].effort, "medium")

            configure_workspace(
                config_path=config_path,
                strategy="git_worktree",
                repository=str(root / "repository"),
                root=str(root / "worktrees"),
                base_ref="release",
            )
            self.assertTrue(settings_changed(config_path))

    def test_agent_command_updates_machine_settings_without_losing_server(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            configure_client(config_path=path, control_url="https://merv.test")

            with redirect_stdout(io.StringIO()):
                result = main(
                    [
                        "--config",
                        str(path),
                        "agent",
                        "local-codex",
                        "--adapter",
                        "codex",
                        "--enable",
                        "--command",
                        "/opt/codex --profile research",
                        "--model",
                        "gpt-test",
                        "--effort",
                        "high",
                        "--parallelism",
                        "3",
                    ]
                )

            self.assertEqual(result, 0)
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")),
                {
                    "agent_platforms": {
                        "local-codex": {
                            "adapter": "codex",
                            "command": ["/opt/codex", "--profile", "research"],
                            "effort": "high",
                            "enabled": True,
                            "model": "gpt-test",
                            "parallelism": 3,
                        }
                    },
                    "control_url": "https://merv.test",
                },
            )
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_built_in_names_select_native_adapters(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            configure_agent(config_path=path, platform="codex")
            configure_agent(config_path=path, platform="claude", enabled=False)

            configured = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(configured["agent_platforms"]["codex"]["adapter"], "codex")
            self.assertEqual(
                configured["agent_platforms"]["claude"]["adapter"], "claude"
            )
            self.assertFalse(configured["agent_platforms"]["claude"]["enabled"])
            for name in (
                "gemini",
                "cursor",
                "opencode",
                "copilot",
                "qwen",
                "hermes",
            ):
                configure_agent(config_path=path, platform=name, enabled=False)
            configured = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(
                {
                    name: configured["agent_platforms"][name]["adapter"]
                    for name in (
                        "codex",
                        "claude",
                        "gemini",
                        "cursor",
                        "opencode",
                        "copilot",
                        "qwen",
                        "hermes",
                    )
                },
                {
                    name: name
                    for name in (
                        "codex",
                        "claude",
                        "gemini",
                        "cursor",
                        "opencode",
                        "copilot",
                        "qwen",
                        "hermes",
                    )
                },
            )

    def test_load_platforms_validates_and_returns_only_enabled_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            path.write_text(
                json.dumps(
                    {
                        "agent_platforms": {
                            "codex-fast": {
                                "adapter": "codex",
                                "enabled": True,
                                "command": ["codex"],
                                "model": "gpt-test",
                                "effort": "medium",
                                "parallelism": 2,
                            },
                            "claude-off": {
                                "adapter": "claude",
                                "enabled": False,
                                "command": ["claude"],
                            },
                        }
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                load_platforms(path),
                (
                    Platform(
                        name="codex-fast",
                        adapter="codex",
                        command=("codex",),
                        model="gpt-test",
                        effort="medium",
                        parallelism=2,
                    ),
                ),
            )

            path.write_text(
                '{"agent_platforms":{"bad":{"adapter":"command",'
                '"command":["x"],"parallelism":0}}}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RunnerError, "between 1 and 32"):
                load_platforms(path)

    def test_aider_is_not_available_for_auto_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            with self.assertRaisesRegex(
                ClientError,
                "Aider is not supported for auto-run",
            ):
                configure_agent(config_path=path, platform="aider")

            path.write_text(
                '{"agent_platforms":{"aider":{"adapter":"command",'
                '"command":["aider"]}}}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                RunnerError,
                "Aider is not supported for auto-run",
            ):
                load_platforms(path)

    def test_status_reports_which_agent_executables_this_machine_has(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            fake = bin_dir / "fake-agent"
            fake.write_text("#!/bin/sh\n", encoding="utf-8")
            fake.chmod(0o755)
            config_path = Path(tmp) / "client.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agent_platforms": {
                            "custom": {
                                "adapter": "command",
                                "command": ["fake-agent", "--flag"],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.dict("os.environ", {"PATH": str(bin_dir)}),
                patch("merv.client.agent_runner.socket.gethostname", return_value="lab-mac"),
                patch("merv.client.agent_runner.platform.system", return_value="Darwin"),
                patch("merv.client.agent_runner.platform.release", return_value="25.0.0"),
                patch("merv.client.agent_runner.platform.machine", return_value="arm64"),
            ):
                detected = _detected_commands(config_path)
                status = _local_status(
                    project_id=None,
                    runner_active=False,
                    ledger=None,
                    config_path=config_path,
                )
            # Configured commands are probed alongside every adapter default.
            self.assertTrue(detected["fake-agent"])
            self.assertFalse(detected["codex"])
            self.assertIn("cursor-agent", detected)
            self.assertEqual(status["available_commands"], detected)
            self.assertEqual(
                status["machine"],
                {
                    "hostname": "lab-mac",
                    "system": "Darwin",
                    "release": "25.0.0",
                    "architecture": "arm64",
                    "runner_id": None,
                },
            )
            ledger = SessionLedger(Path(tmp) / "sessions.json")
            identified = _local_status(
                project_id="proj_1",
                runner_active=True,
                ledger=ledger,
            )
            self.assertEqual(identified["machine"]["runner_id"], ledger.runner_id)
            without = _local_status(
                project_id=None, runner_active=False, ledger=None
            )
            self.assertNotIn("available_commands", without)

    def test_workspace_settings_require_persistent_git_worktrees(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / "client.json"
            configure_workspace(
                config_path=path,
                strategy="git_worktree",
                repository=str(root / "repo"),
                root=str(root / "workers"),
                base_ref="main",
            )
            self.assertEqual(
                load_workspace_settings(path),
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=root / "repo",
                    root=root / "workers",
                    base_ref="main",
                ),
            )
            path.write_text(
                json.dumps(
                    {
                        "agent_workspace": {
                            "strategy": "existing",
                            "repository": str(root),
                        }
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RunnerError, "persistent Git worktrees"):
                load_workspace_settings(path)

    def test_call_command_gives_non_mcp_agents_a_shell_safe_tool_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "client.json"
            configure_client(config_path=path, control_url="https://merv.test")
            response = MagicMock()
            response.read.return_value = b'{"result":{"status":"planned"}}'
            response.__enter__.return_value = response
            opener = MagicMock()
            opener.open.return_value = response
            with (
                patch(
                    "merv.client.cli.urllib.request.build_opener",
                    return_value=opener,
                ),
                patch.dict(
                    "os.environ",
                    {
                        "MERV_AGENT_SESSION_KEY": "mas_session",
                        "MERV_MCP_KEY": "mk_machine",
                    },
                    clear=False,
                ),
                redirect_stdout(io.StringIO()) as output,
            ):
                result = main(
                    [
                        "--config",
                        str(path),
                        "call",
                        "workflow.status_and_next",
                        "--arguments",
                        '{"project_id":"proj_1","experiment_id":"exp_1"}',
                    ]
                )

            self.assertEqual(result, 0)
            self.assertIn('"status": "planned"', output.getvalue())
            request = opener.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://merv.test/mcp/call")
            self.assertEqual(request.headers["Authorization"], "Bearer mas_session")


class AgentHostTest(unittest.TestCase):
    def test_native_hosts_build_shell_free_commands(self) -> None:
        codex = Platform(
            "codex",
            "codex",
            ("/opt/codex",),
            model="gpt-test",
            effort="high",
        )
        claude = Platform(
            "claude",
            "claude",
            ("/opt/claude",),
            model="opus",
            effort="medium",
        )

        self.assertEqual(
            CodexHost().command_for(codex),
            [
                "/opt/codex",
                "exec",
                "--ignore-user-config",
                "--full-auto",
                "--json",
                "-c",
                "sandbox_workspace_write.network_access=true",
                "--model",
                "gpt-test",
                "-c",
                'model_reasoning_effort="high"',
                "-",
            ],
        )
        self.assertEqual(
            CodexHost().session_arguments(
                {"MERV_CONTROL_URL": "http://127.0.0.1:8878"}
            ),
            [
                "-c",
                'mcp_servers.merv_agent_session.url="http://127.0.0.1:8878/mcp"',
                "-c",
                "mcp_servers.merv_agent_session.bearer_token_env_var="
                '"MERV_AGENT_SESSION_KEY"',
            ],
        )
        self.assertEqual(
            ClaudeHost().session_arguments(
                {"MERV_CONTROL_URL": "http://127.0.0.1:8878"}
            ),
            [
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{"merv_agent_session":{"type":"http",'
                '"url":"http://127.0.0.1:8878/mcp","headers":{'
                '"Authorization":"Bearer ${MERV_AGENT_SESSION_KEY}"}}}}',
            ],
        )
        self.assertEqual(
            ClaudeHost().command_for(claude),
            [
                "/opt/claude",
                "--print",
                "--permission-mode",
                "auto",
                "--output-format",
                "stream-json",
                "--verbose",
                "--forward-subagent-text",
                "--model",
                "opus",
                "--effort",
                "medium",
            ],
        )
        explicit_mode = Platform(
            "claude-safe",
            "claude",
            ("/opt/claude", "--permission-mode", "acceptEdits"),
        )
        self.assertEqual(
            ClaudeHost().command_for(explicit_mode),
            [
                "/opt/claude",
                "--permission-mode",
                "acceptEdits",
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--forward-subagent-text",
            ],
        )
        instruction = "Run the assigned experiment."
        native = {
            "gemini": (
                GeminiHost(),
                [
                    "gemini",
                    "--approval-mode=yolo",
                    "--output-format",
                    "stream-json",
                ],
                None,
            ),
            "cursor": (
                CursorHost(),
                [
                    "cursor-agent",
                    "--print",
                    "--force",
                    "--output-format",
                    "stream-json",
                ],
                [instruction],
            ),
            "opencode": (
                OpenCodeHost(),
                ["opencode", "run", "--auto", "--format", "json"],
                [instruction],
            ),
            "copilot": (
                CopilotHost(),
                [
                    "copilot",
                    "--autopilot",
                    "--yolo",
                    "--no-ask-user",
                    "--output-format=json",
                ],
                ["--prompt", instruction],
            ),
            "qwen": (
                QwenHost(),
                [
                    "qwen",
                    "--approval-mode",
                    "yolo",
                    "--input-format",
                    "text",
                    "--output-format",
                    "stream-json",
                ],
                None,
            ),
            "hermes": (
                HermesHost(),
                ["hermes"],
                ["-z", instruction],
            ),
        }
        for name, (host, command, prompt) in native.items():
            with self.subTest(name=name):
                platform = Platform(name, name, (command[0],))
                self.assertEqual(host.command_for(platform), command)
                self.assertEqual(host.instruction_arguments(instruction), prompt)

        hermes = Platform(
            "hermes-opus",
            "hermes",
            ("/opt/hermes", "--profile", "research"),
            model="anthropic/claude-opus-4-6",
            effort="high",
        )
        self.assertEqual(
            HermesHost().command_for(hermes),
            [
                "/opt/hermes",
                "--profile",
                "research",
                "--model",
                "anthropic/claude-opus-4-6",
            ],
        )
        self.assertEqual(HermesHost().session_arguments({}), [])
        hermes_instruction = HermesHost().prepare_instruction(instruction)
        self.assertIn("invoke every Merv tool", hermes_instruction)
        self.assertIn("merv-client call TOOL --arguments JSON", hermes_instruction)
        self.assertNotIn("MERV_AGENT_SESSION_KEY", hermes_instruction)
        hostile_instruction = "Review `$(touch /tmp/nope)`.\n--model attacker"
        self.assertEqual(
            HermesHost().instruction_arguments(hostile_instruction),
            ["-z", hostile_instruction],
        )

    def test_child_environment_replaces_every_parent_merv_credential(self) -> None:
        child = _child_environment(
            {
                "PATH": "/bin",
                "HOME": "/home/researcher",
                "ANTHROPIC_API_KEY": "provider-secret",
                "MERV_MCP_KEY": "owner-secret",
                "MERV_OTHER_SECRET": "hidden",
                "RESEARCH_PLUGIN_MCP_KEY": "legacy-owner-secret",
            },
            session_key="session-secret",
            control_url="https://merv.test",
            session_id="ags_1",
        )

        self.assertEqual(child["MERV_AGENT_SESSION_KEY"], "session-secret")
        self.assertNotIn("MERV_MCP_KEY", child)
        self.assertEqual(child["MERV_CONTROL_URL"], "https://merv.test")
        self.assertEqual(child["MERV_AGENT_SESSION_ID"], "ags_1")
        self.assertNotIn("MERV_OTHER_SECRET", child)
        self.assertNotIn("RESEARCH_PLUGIN_MCP_KEY", child)
        self.assertEqual(child["ANTHROPIC_API_KEY"], "provider-secret")
        self.assertTrue(child["PATH"].endswith(":/bin"))
        self.assertTrue(Path(child["PATH"].split(":", 1)[0], "merv-client").is_file())

    def test_a_process_without_a_birth_marker_is_killed_before_returning(self) -> None:
        process = MagicMock()
        process.pid = 41
        process.stdin = io.BytesIO()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch(
                    "merv.client.agent_runner.subprocess.Popen",
                    return_value=process,
                ),
                patch(
                    "merv.client.agent_runner._process_marker",
                    return_value=None,
                ),
                patch("merv.client.agent_runner.os.killpg") as killpg,
                self.assertRaisesRegex(RunnerError, "safe process identity"),
            ):
                CommandHost().spawn(
                    platform=platform,
                    instruction="work",
                    child_env={"PATH": "/bin"},
                    stdout_path=root / "stdout.log",
                    stderr_path=root / "stderr.log",
                    cwd=root,
                )
            killpg.assert_called_once_with(41, signal.SIGKILL)

    def test_command_host_keeps_json_stdout_separate_from_stderr(self) -> None:
        script = (
            "import json, sys; prompt = sys.stdin.read(); "
            "print(json.dumps({'type':'message','prompt':prompt})); "
            "print('provider warning', file=sys.stderr)"
        )
        platform = Platform(
            "custom",
            "command",
            (sys.executable, "-c", script),
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stdout_path = root / "trace.jsonl"
            stderr_path = root / "stderr.log"
            host = CommandHost()
            with patch(
                "merv.client.agent_runner._process_marker",
                return_value="birth-marker",
            ):
                session = host.spawn(
                    platform=platform,
                    instruction="assigned work",
                    child_env=dict(os.environ),
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    cwd=root,
                )
            host._processes[session.pid].wait(timeout=5)

            stdout = stdout_path.read_text(encoding="utf-8")
            stderr = stderr_path.read_text(encoding="utf-8")
            self.assertEqual(json.loads(stdout)["type"], "message")
            self.assertIn("assigned work", stdout)
            self.assertNotIn("provider warning", stdout)
            self.assertEqual(stderr, "provider warning\n")
            self.assertEqual(stdout_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(stderr_path.stat().st_mode & 0o777, 0o600)

    def test_hermes_exports_the_completed_session_as_jsonl(self) -> None:
        platform = Platform("hermes", "hermes", ("hermes",))
        with tempfile.TemporaryDirectory() as tmp:
            trace_dir = Path(tmp)
            (trace_dir / "hermes-usage.json").write_text(
                '{"session_id":"session-123"}\n',
                encoding="utf-8",
            )

            def export(command, **kwargs):
                destination = Path(command[3])
                destination.write_text(
                    '{"session_id":"session-123","messages":[]}\n',
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch(
                "merv.client.agent_runner.subprocess.run",
                side_effect=export,
            ) as run:
                HermesHost().finalize_trace(
                    platform=platform,
                    trace_dir=trace_dir,
                )

            self.assertEqual(
                json.loads((trace_dir / "trace.jsonl").read_text(encoding="utf-8"))[
                    "session_id"
                ],
                "session-123",
            )
            self.assertEqual((trace_dir / "trace.jsonl").stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                run.call_args.args[0],
                [
                    "hermes",
                    "sessions",
                    "export",
                    str(trace_dir / "trace.jsonl.tmp"),
                    "--session-id",
                    "session-123",
                ],
            )

    def test_credentials_are_refused_over_nonlocal_http(self) -> None:
        self.assertEqual(
            _safe_control_url("http://127.0.0.1:8787/"),
            "http://127.0.0.1:8787",
        )
        self.assertEqual(
            _safe_control_url("https://merv.example/"), "https://merv.example"
        )
        with self.assertRaisesRegex(RunnerError, "must use HTTPS"):
            _safe_control_url("http://192.0.2.10:8787")

    def test_git_workspace_persists_one_branch_per_experiment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repository = root / "repo"
            repository.mkdir()
            subprocess.run(
                ["git", "init", "-b", "main", str(repository)],
                check=True,
                capture_output=True,
            )
            (repository / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(repository), "add", "README.md"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository),
                    "-c",
                    "user.name=Merv Test",
                    "-c",
                    "user.email=merv@test.invalid",
                    "commit",
                    "-m",
                    "base",
                ],
                check=True,
                capture_output=True,
            )
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=repository,
                    root=root / "workers",
                    base_ref="main",
                )
            )
            one = manager.prepare(Claim("ags_1", "exp_1", "proj_1"))
            two = manager.prepare(Claim("ags_2", "exp_2", "proj_1"))
            resumed = manager.prepare(Claim("ags_3", "exp_1", "proj_1"))

            self.assertEqual(
                one.path, root / "workers" / "experiments" / "proj_1" / "exp_1"
            )
            self.assertEqual(
                two.path, root / "workers" / "experiments" / "proj_1" / "exp_2"
            )
            self.assertNotEqual(one.branch, two.branch)
            self.assertEqual(resumed.path, one.path)
            self.assertEqual(resumed.branch, one.branch)
            self.assertEqual(one.base_sha, two.base_sha)
            self.assertEqual(manager.central_sha(), one.base_sha)
            bare = manager._canonical_repository()
            self.assertEqual(manager._git(bare, "remote").strip(), "")

            shutil.rmtree(one.path)
            restored = manager.prepare(Claim("ags_4", "exp_1", "proj_1"))
            self.assertEqual(restored.path, one.path)
            self.assertEqual(restored.branch, one.branch)

            # Plan and result reviews are pinned to Merv evidence, not
            # necessarily to code. They still receive an isolated clean
            # checkout; consolidation reviews override this with proposal SHA.
            review = manager.prepare(
                Claim(
                    "ags_review",
                    "exp_1",
                    "proj_1",
                    kind="review",
                    review_request_id="rr_1",
                )
            )
            self.assertIsNone(review.branch)
            self.assertEqual(review.base_sha, manager.central_sha())
            self.assertTrue(review.path.exists())
            manager.close(review)
            self.assertFalse(review.path.exists())

    def test_central_advance_records_verified_experiment_ancestry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repository = root / "repo"
            repository.mkdir()
            subprocess.run(
                ["git", "init", "-b", "main", str(repository)],
                check=True,
                capture_output=True,
            )
            (repository / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(repository), "add", "README.md"],
                check=True,
            )
            commit_command = [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=Merv Test",
                "-c",
                "user.email=merv@test.invalid",
                "commit",
                "-m",
                "base",
            ]
            subprocess.run(commit_command, check=True, capture_output=True)
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=repository,
                    root=root / "workers",
                    base_ref="main",
                )
            )
            experiment = manager.prepare(Claim("ags_exp", "exp_1", "proj_1"))
            (experiment.path / "model.py").write_text("score = 1\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(experiment.path), "add", "model.py"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(experiment.path),
                    "-c",
                    "user.name=Merv Test",
                    "-c",
                    "user.email=merv@test.invalid",
                    "commit",
                    "-m",
                    "experiment",
                ],
                check=True,
                capture_output=True,
            )
            experiment = manager.observe(
                path=experiment.path,
                branch=experiment.branch,
                base_sha=experiment.base_sha,
                kind="experiment",
            )
            pinned_review = manager.prepare(
                Claim(
                    "ags_review",
                    "",
                    "proj_1",
                    target_type="reflection",
                    target_id="ref_1",
                    source_sha=experiment.head_sha,
                    kind="review",
                    review_request_id="rr_1",
                )
            )
            self.assertEqual(pinned_review.head_sha, experiment.head_sha)
            self.assertEqual(pinned_review.base_sha, experiment.head_sha)
            manager.close(pinned_review)
            consolidation = manager.prepare(
                Claim(
                    "ags_con",
                    "",
                    "proj_1",
                    target_type="reflection",
                    target_id="ref_1",
                    kind="consolidation",
                )
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(consolidation.path),
                    "-c",
                    "user.name=Merv Test",
                    "-c",
                    "user.email=merv@test.invalid",
                    "merge",
                    "--no-ff",
                    str(experiment.branch),
                    "-m",
                    "consolidate",
                ],
                check=True,
                capture_output=True,
            )
            target = subprocess.run(
                ["git", "-C", str(consolidation.path), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()

            receipt = manager.advance(
                expected_sha=experiment.base_sha,
                target_sha=target,
                sources=[
                    {
                        "experiment_id": "exp_1",
                        "source_sha": experiment.head_sha,
                        "integration_kind": "merge",
                    }
                ],
            )

            self.assertEqual(receipt["observed_sha"], target)
            self.assertEqual(receipt["ancestry"], {"exp_1": True})
            self.assertEqual(manager.central_sha(), target)

    def test_stale_consolidation_retry_gets_a_fresh_base_specific_branch(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repository = root / "repo"
            repository.mkdir()
            subprocess.run(
                ["git", "init", "-b", "main", str(repository)],
                check=True,
                capture_output=True,
            )
            (repository / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(repository), "add", "README.md"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository),
                    "-c",
                    "user.name=Merv Test",
                    "-c",
                    "user.email=merv@test.invalid",
                    "commit",
                    "-m",
                    "base",
                ],
                check=True,
                capture_output=True,
            )
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=repository,
                    root=root / "workers",
                    base_ref="main",
                )
            )
            old_base = manager.central_sha()
            old = manager.prepare(
                Claim(
                    "ags_old",
                    "",
                    "proj_1",
                    target_type="reflection",
                    target_id="ref_1",
                    source_sha=old_base,
                    kind="consolidation",
                )
            )
            central_change = manager.prepare(Claim("ags_exp", "exp_1", "proj_1"))
            (central_change.path / "advance.py").write_text(
                "advanced = True\n", encoding="utf-8"
            )
            subprocess.run(
                ["git", "-C", str(central_change.path), "add", "advance.py"],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(central_change.path),
                    "-c",
                    "user.name=Merv Test",
                    "-c",
                    "user.email=merv@test.invalid",
                    "commit",
                    "-m",
                    "advance central",
                ],
                check=True,
                capture_output=True,
            )
            new_base = manager.observe(
                path=central_change.path,
                branch=central_change.branch,
                base_sha=central_change.base_sha,
                kind="experiment",
            ).head_sha
            manager.advance(
                expected_sha=old_base,
                target_sha=new_base,
                sources=[],
            )

            fresh = manager.prepare(
                Claim(
                    "ags_fresh",
                    "",
                    "proj_1",
                    target_type="reflection",
                    target_id="ref_1",
                    source_sha=new_base,
                    kind="consolidation",
                )
            )

            self.assertNotEqual(fresh.branch, old.branch)
            self.assertNotEqual(fresh.path, old.path)
            self.assertEqual(fresh.base_sha, new_base)
            self.assertTrue(old.path.exists())


class _CapturingClient(AgentSessionsClient):
    def __init__(self):
        self.calls: list[tuple[str, dict[str, object], bool]] = []

    def _post(self, path, payload, *, allow_empty=False):
        self.calls.append((path, dict(payload), allow_empty))
        return {
            "session": {
                "id": "ags_1",
                "project_id": "proj_1",
                "experiment_id": "exp_1",
                "status": "offered",
                "instruction": "do the experiment",
                "attempt_index": 3,
            }
        }


class AgentSessionProtocolTest(unittest.TestCase):
    def test_claim_wire_contract_is_concentrated_in_client(self) -> None:
        client = _CapturingClient()

        claim = client.claim(
            project_id="proj_1",
            platform="codex",
            runner_id="runner_1",
            idempotency_key="delivery_1",
            session_key="mas_child-secret-with-enough-entropy-123456789",
        )

        self.assertEqual(
            claim,
            Claim(
                session_id="ags_1",
                experiment_id="exp_1",
                project_id="proj_1",
                instruction="do the experiment",
                attempt_index=3,
            ),
        )
        self.assertEqual(
            client.calls,
            [
                (
                    "/api/agent-sessions/claim",
                    {
                        "project_id": "proj_1",
                        "platform": "codex",
                        "runner_id": "runner_1",
                        "idempotency_key": "delivery_1",
                        "session_secret": "mas_child-secret-with-enough-entropy-123456789",
                    },
                    True,
                )
            ],
        )

    def test_jsonl_telemetry_is_incremental_and_deduplicates_tool_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            trace = Path(tmp) / "trace.jsonl"
            trace.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in (
                        {
                            "type": "item.started",
                            "item": {"id": "tool_1", "type": "command_execution"},
                        },
                        {
                            "type": "item.completed",
                            "item": {"id": "tool_1", "type": "command_execution"},
                        },
                        {
                            "type": "turn.completed",
                            "usage": {
                                "input_tokens": 900,
                                "output_tokens": 300,
                                "cached_input_tokens": 100,
                            },
                        },
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            offset, state = _read_trace_telemetry(
                path=trace, offset=0, state=None, adapter="codex"
            )
            self.assertEqual(state["tool_calls"], 1)
            self.assertEqual(state["total_tokens"], 1200)
            self.assertEqual(state["cached_tokens"], 100)

            with trace.open("a", encoding="utf-8") as output:
                output.write(
                    json.dumps(
                        {
                            "type": "tool_use",
                            "tool_id": "tool_2",
                            "tool_name": "read_file",
                        }
                    )
                    + "\n"
                )
                output.write('{"type":"message"')
            next_offset, state = _read_trace_telemetry(
                path=trace, offset=offset, state=state, adapter="codex"
            )
            self.assertEqual(state["tool_calls"], 2)
            self.assertGreater(next_offset, offset)
            self.assertLess(next_offset, trace.stat().st_size)

    def test_runner_presence_wire_contract_contains_no_command(self) -> None:
        client = _CapturingClient()
        client.heartbeat_runner(
            project_id="proj_1",
            runner_id="runner_1",
            machine={"hostname": "research-mac"},
            platforms=[
                {
                    "name": "Codex",
                    "harness": "codex",
                    "model": "gpt-5.6-sol",
                    "parallelism": 2,
                }
            ],
            capacity=2,
        )

        path, payload, _ = client.calls[-1]
        self.assertEqual(
            path, "/api/projects/proj_1/agent-runners/heartbeat"
        )
        self.assertEqual(payload["machine"], {"hostname": "research-mac"})
        self.assertEqual(payload["capacity"], 2)
        self.assertNotIn("command", payload["platforms"][0])

    def test_closed_idempotent_claim_is_never_launched(self) -> None:
        client = _CapturingClient()

        def closed(path, payload, *, allow_empty=False):
            return {
                "session": {
                    "id": "ags_old",
                    "project_id": "proj_1",
                    "experiment_id": "exp_old",
                    "status": "released",
                }
            }

        client._post = closed
        self.assertIsNone(
            client.claim(
                project_id="proj_1",
                platform="codex",
                runner_id="runner_1",
                idempotency_key="old_delivery",
                session_key="mas_child-secret-with-enough-entropy-123456789",
            )
        )


class _FakeHost:
    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def __init__(self):
        self.spawns: list[dict[str, object]] = []
        self.stopped: list[HostSession] = []

    def spawn(self, **kwargs):
        self.spawns.append(kwargs)
        return HostSession(ref="pid:41", pid=41)

    def inspect(self, session):
        return "running"

    def stop(self, session):
        self.stopped.append(session)

    def finalize_trace(self, *, platform, trace_dir):
        return None


class _FakeClient:
    control_url = "https://merv.test"
    last_claim_reason = ""

    def __init__(self, claim: Claim):
        self.claim_result = claim
        self.claim_calls: list[dict[str, object]] = []
        self.attached: list[tuple[str, str]] = []
        self.released: list[tuple[str, str]] = []
        self.heartbeats: list[str] = []
        self.remote_sessions: list[dict[str, object]] = []
        self.pending: dict[str, object] | None = None
        self.advance: dict[str, object] | None = None
        self.prepared: list[dict[str, object]] = []
        self.settled: list[dict[str, object]] = []

    def claim(self, **kwargs):
        self.claim_calls.append(kwargs)
        return self.claim_result

    def attach(
        self,
        *,
        session_id,
        runner_id,
        host_session_ref,
        workspace_ref="",
        **workspace,
    ):
        self.attached.append((session_id, host_session_ref, workspace_ref))

    def release(self, *, session_id, runner_id, reason, **workspace):
        self.released.append((session_id, reason))

    def heartbeat(self, *, session_id, runner_id, **workspace):
        self.heartbeats.append(session_id)

    def list(self, *, project_id):
        return self.remote_sessions

    def pending_advance(self, *, project_id):
        return self.pending

    def prepare_advance(self, **kwargs):
        self.prepared.append(kwargs)
        return self.advance

    def settle_advance(self, **kwargs):
        self.settled.append(kwargs)


class _FakeWorkspaces:
    def __init__(self, root: Path):
        self.root = root

    def prepare(self, claim):
        return Workspace(
            path=self.root / claim.session_id,
            branch=f"merv/{claim.session_id}",
            base_sha="1" * 40,
            head_sha="1" * 40,
            stats={
                "commit_count": 0,
                "files_changed": 0,
                "insertions": 0,
                "deletions": 0,
            },
        )

    def observe(self, *, path, branch, base_sha, kind):
        return Workspace(
            path=path,
            branch=branch,
            base_sha=base_sha,
            head_sha="2" * 40,
            stats={"commit_count": 1, "files_changed": 1},
        )

    def capture(self, *, path, branch, base_sha, kind, **kwargs):
        return self.observe(
            path=path,
            branch=branch,
            base_sha=base_sha,
            kind=kind,
        )

    def close(self, workspace):
        return None

    def advance(self, **kwargs):
        return {
            "observed_sha": kwargs["target_sha"],
            "proposal_parents": [kwargs["expected_sha"]],
            "diffstat": {"commit_count": 1},
            "ancestry": {
                str(source["experiment_id"]): False
                for source in kwargs.get("sources", [])
            },
            "error": "",
        }

    def central_sha(self):
        return "1" * 40


class AgentRunnerTest(unittest.TestCase):
    def test_daemon_retries_a_transient_control_plane_failure(self) -> None:
        runner = MagicMock()
        runner.reconcile.side_effect = [RunnerError("temporary outage"), None]
        with (
            patch(
                "merv.client.agent_runner.time.sleep",
                side_effect=[None, KeyboardInterrupt],
            ),
            redirect_stderr(io.StringIO()),
            self.assertRaises(KeyboardInterrupt),
        ):
            _run_runner(runner, once=False, poll_seconds=1)

        self.assertEqual(runner.reconcile.call_count, 2)
        self.assertEqual(runner.report_presence.call_count, 2)
        runner.advance_ready.assert_called_once_with()
        runner.fill_available_slots.assert_called_once_with()

    def test_reviewed_consolidation_advances_and_settles_once(self) -> None:
        client = _FakeClient(Claim("unused", "exp_1", "proj_1"))
        client.pending = {"reflection_id": "ref_1"}
        client.advance = {
            "id": "adv_1",
            "expected_sha": "1" * 40,
            "target_sha": "2" * 40,
            "sources": [
                {
                    "experiment_id": "exp_1",
                    "source_sha": "a" * 40,
                    "integration_kind": "rewrite",
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            self.assertTrue(runner.advance_ready())

        self.assertEqual(len(client.settled), 1)
        receipt = client.settled[0]
        self.assertEqual(receipt["advance_id"], "adv_1")
        self.assertEqual(receipt["observed_sha"], "2" * 40)
        self.assertEqual(receipt["ancestry"], {"exp_1": False})

    def test_bound_pending_advance_retries_settle_without_git_work(self) -> None:
        # A bound receipt whose publish was blocked: the Git CAS is done, so
        # the runner must go straight to settle — no prepare, no Git.
        client = _FakeClient(Claim("unused", "exp_1", "proj_1"))
        client.pending = {
            "reflection_id": "ref_1",
            "advance_status": "bound",
            "advance_id": "adv_9",
            "observed_sha": "2" * 40,
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(),
                client=client,
                ledger=SessionLedger(root / "sessions.json"),
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )
            self.assertTrue(runner.advance_ready())
        self.assertEqual(client.prepared, [])
        self.assertEqual(len(client.settled), 1)
        receipt = client.settled[0]
        self.assertEqual(receipt["advance_id"], "adv_9")
        self.assertEqual(receipt["observed_sha"], "2" * 40)

    def test_launch_is_reserved_first_and_secret_reaches_only_child_env(self) -> None:
        claim = Claim(
            "ags_1",
            "exp_1",
            "proj_1",
            source_sha="a" * 40,
            instruction="Execute the assigned work with the supplied context.",
            attempt_index=2,
        )
        client = _FakeClient(claim)
        host = _FakeHost()
        platform = Platform(
            "custom",
            "command",
            ("agent", "--api-key", "provider-secret"),
            model="model-1",
            effort="high",
            parallelism=1,
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
                environment={
                    "PATH": "/bin",
                    "MERV_MCP_KEY": "runner-secret",
                },
            )
            with (
                patch.dict(
                    "merv.client.agent_runner.HOSTS",
                    {"command": host},
                    clear=True,
                ),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(runner.fill_available_slots(), 1)

            self.assertEqual(len(host.spawns), 1)
            launch = host.spawns[0]
            claim_call = client.claim_calls[0]
            self.assertEqual(
                launch["child_env"]["MERV_AGENT_SESSION_KEY"],
                _session_key(
                    runner_secret=b"r" * 32,
                    idempotency_key=claim_call["idempotency_key"],
                ),
            )
            self.assertNotIn("runner-secret", launch["instruction"])
            self.assertNotIn(
                launch["child_env"]["MERV_AGENT_SESSION_KEY"],
                launch["instruction"],
            )
            self.assertNotIn(
                launch["child_env"]["MERV_AGENT_SESSION_KEY"], platform.command
            )
            self.assertEqual(launch["cwd"], root / "ags_1")
            self.assertEqual(
                client.attached,
                [("ags_1", "pid:41", "merv/ags_1")],
            )
            self.assertTrue(ledger.sessions["ags_1"].launch_attempted)
            trace_dir = root / "traces" / "ags_1"
            metadata = json.loads(
                (trace_dir / "metadata.json").read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["merv_agent_session_id"], "ags_1")
            self.assertEqual(
                metadata["work_item"]["instruction"], launch["instruction"]
            )
            self.assertEqual(metadata["work_item"]["experiment_id"], "exp_1")
            self.assertEqual(metadata["work_item"]["attempt_index"], 2)
            self.assertEqual(metadata["work_item"]["source_sha"], "a" * 40)
            self.assertEqual(metadata["agent_setup"]["harness"], "command")
            self.assertEqual(metadata["agent_setup"]["model"], "model-1")
            self.assertEqual(metadata["agent_setup"]["effort"], "high")
            self.assertEqual(metadata["agent_setup"]["trace_file"], "trace.jsonl")
            self.assertEqual(
                metadata["agent_setup"]["command"],
                ["agent", "--api-key", "<redacted>"],
            )
            self.assertNotIn("provider-secret", json.dumps(metadata))
            self.assertEqual(launch["stdout_path"], trace_dir / "trace.jsonl")
            self.assertEqual(launch["stderr_path"], trace_dir / "stderr.log")
            self.assertEqual(
                launch["child_env"]["MERV_AGENT_TRACE_DIR"], str(trace_dir)
            )
            self.assertEqual(trace_dir.stat().st_mode & 0o777, 0o700)
            self.assertEqual(
                (trace_dir / "metadata.json").stat().st_mode & 0o777,
                0o600,
            )

            # Even if the remote claim is replayed after the process stops,
            # the durable launch record makes a second spawn impossible.
            ledger.sessions["ags_1"].status = "stopped"
            with patch.dict(
                "merv.client.agent_runner.HOSTS",
                {"command": host},
                clear=True,
            ):
                self.assertEqual(runner.fill_available_slots(), 0)
            self.assertEqual(len(host.spawns), 1)

    def test_lost_claim_response_reuses_identity_without_storing_the_secret(
        self,
    ) -> None:
        claim = Claim("ags_1", "exp_1", "proj_1")
        client = _FakeClient(claim)
        client.claim = MagicMock(side_effect=[RunnerError("response lost"), claim])
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )
            with (
                patch.dict(
                    "merv.client.agent_runner.HOSTS",
                    {"command": host},
                    clear=True,
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(runner.fill_available_slots(), 0)
                first_ledger = ledger.path.read_text(encoding="utf-8")
                self.assertNotIn("mas_", first_ledger)
                self.assertEqual(runner.fill_available_slots(), 1)

            first = client.claim.call_args_list[0].kwargs
            second = client.claim.call_args_list[1].kwargs
            self.assertEqual(first["idempotency_key"], second["idempotency_key"])
            self.assertEqual(first["session_key"], second["session_key"])
            self.assertEqual(ledger.pending_claims, {})
            self.assertEqual(len(host.spawns), 1)

    def test_one_bad_platform_does_not_stop_other_launches(self) -> None:
        bad = Platform("bad", "bad", ("missing-agent",))
        good = Platform("good", "good", ("working-agent",))
        client = _FakeClient(Claim("unused", "exp_1", "proj_1"))

        def claim_for_platform(**kwargs):
            name = kwargs["platform"]
            return Claim(f"ags_{name}", f"exp_{name}", "proj_1")

        client.claim = claim_for_platform
        bad_host = _FakeHost()
        bad_host.spawn = MagicMock(side_effect=RunnerError("binary missing"))
        good_host = _FakeHost()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(bad, good),
                client=client,
                ledger=SessionLedger(root / "sessions.json"),
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )
            with (
                patch.dict(
                    "merv.client.agent_runner.HOSTS",
                    {"bad": bad_host, "good": good_host},
                    clear=True,
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(runner.fill_available_slots(), 1)
            self.assertEqual(len(good_host.spawns), 1)
            self.assertIn(("ags_bad", "launch_failed"), client.released)

    def test_reconcile_stops_a_process_revoked_by_merv(self) -> None:
        claim = Claim("ags_1", "exp_1", "proj_1")
        client = _FakeClient(claim)
        client.remote_sessions = [{"id": "ags_1", "status": "expired"}]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(claim, platform)
            session.host_ref = "pid:41"
            session.pid = 41
            session.status = "running"
            ledger.save()
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            with patch.dict(
                "merv.client.agent_runner.HOSTS",
                {"command": host},
                clear=True,
            ):
                runner.reconcile()

            self.assertEqual(host.stopped, [HostSession(ref="pid:41", pid=41)])

    def test_second_rapid_stop_without_progress_is_backed_off(self) -> None:
        first = Claim("ags_1", "exp_1", "proj_1")
        second = Claim("ags_2", "exp_1", "proj_1")
        client = _FakeClient(second)
        client.remote_sessions = [{"id": "ags_2", "status": "active"}]
        host = _FakeHost()
        host.inspect = MagicMock(return_value="stopped")
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            prior = ledger.reserve(first, platform)
            prior.status = "stopped"
            prior.started_at = time.time() - 10
            prior.base_sha = prior.head_sha = "1" * 40
            current = ledger.reserve(second, platform)
            current.status = "running"
            current.started_at = time.time() - 5
            current.host_ref = "pid:42"
            current.pid = 42
            current.cwd = str(root / "ags_2")
            current.branch = "merv/ags_2"
            current.base_sha = current.head_sha = "1" * 40
            ledger.save()
            workspaces = _FakeWorkspaces(root)
            workspaces.capture = MagicMock(
                return_value=Workspace(
                    path=root / "ags_2",
                    branch="merv/ags_2",
                    base_sha="1" * 40,
                    head_sha="1" * 40,
                    stats={"commit_count": 0, "files_changed": 0},
                )
            )
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=workspaces,
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            with patch.dict(
                "merv.client.agent_runner.HOSTS",
                {"command": host},
                clear=True,
            ):
                runner.reconcile()

            self.assertIn(("ags_2", "host_process_crash_loop"), client.released)

    def test_capture_failure_does_not_wedge_a_finished_session(self) -> None:
        claim = Claim("ags_1", "exp_1", "proj_1")
        client = _FakeClient(claim)
        client.remote_sessions = [{"id": "ags_1", "status": "expired"}]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(claim, platform)
            session.host_ref = "pid:41"
            session.pid = 41
            session.cwd = str(root / "ags_1")
            session.branch = "merv/ags_1"
            session.base_sha = "1" * 40
            session.status = "running"
            workspaces = _FakeWorkspaces(root)
            workspaces.capture = MagicMock(
                side_effect=RunnerError("capture unavailable")
            )
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=workspaces,
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            with (
                patch.dict(
                    "merv.client.agent_runner.HOSTS",
                    {"command": host},
                    clear=True,
                ),
                redirect_stderr(io.StringIO()),
            ):
                runner.reconcile()

            self.assertEqual(session.status, "expired")
            self.assertIn(("ags_1", "remote_expired"), client.released)

    def test_recovery_without_a_persisted_pid_waits_out_the_lease(self) -> None:
        claim = Claim("ags_1", "exp_1", "proj_1")
        client = _FakeClient(claim)
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(claim, platform)
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            runner.reconcile()

            self.assertEqual(session.status, "uncertain")
            self.assertEqual(client.released, [])
            self.assertEqual(ledger.sessions["ags_1"].status, "uncertain")

    def test_reconcile_heartbeats_only_after_host_is_confirmed_alive(self) -> None:
        claim = Claim("ags_1", "exp_1", "proj_1")
        client = _FakeClient(claim)
        client.remote_sessions = [
            {
                "id": "ags_1",
                "status": "active",
                "host_session_ref": "pid:41",
            }
        ]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(claim, platform)
            session.host_ref = "pid:41"
            session.pid = 41
            session.attached = True
            session.status = "running"
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            with patch.dict(
                "merv.client.agent_runner.HOSTS",
                {"command": host},
                clear=True,
            ):
                runner.reconcile()

            self.assertEqual(client.heartbeats, ["ags_1"])
            self.assertEqual(client.attached, [])

    def test_one_broken_session_does_not_stop_peer_reconciliation(self) -> None:
        client = _FakeClient(Claim("unused", "exp_1", "proj_1"))
        client.remote_sessions = [
            {"id": "ags_bad", "status": "active", "host_session_ref": "pid:40"},
            {"id": "ags_good", "status": "active", "host_session_ref": "pid:41"},
        ]
        platform = Platform("custom", "command", ("agent",))
        host = _FakeHost()

        def inspect(session):
            if session.pid == 40:
                raise RunnerError("bad process inspection")
            return "running"

        host.inspect = inspect
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            for session_id, experiment_id, pid in (
                ("ags_bad", "exp_bad", 40),
                ("ags_good", "exp_good", 41),
            ):
                session = ledger.reserve(
                    Claim(session_id, experiment_id, "proj_1"),
                    platform,
                )
                session.host_ref = f"pid:{pid}"
                session.pid = pid
                session.attached = True
                session.status = "running"
            ledger.save()
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )

            with (
                patch.dict(
                    "merv.client.agent_runner.HOSTS",
                    {"command": host},
                    clear=True,
                ),
                redirect_stderr(io.StringIO()),
            ):
                runner.reconcile()

            self.assertEqual(ledger.sessions["ags_bad"].status, "uncertain")
            self.assertEqual(ledger.sessions["ags_good"].status, "running")
            self.assertEqual(client.heartbeats, ["ags_good"])


class LocalControlTest(unittest.TestCase):
    def test_pairing_token_is_stable_and_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pairing.token"
            first, created = pairing_token(path)
            second, created_again = pairing_token(path)
            runner_path = Path(tmp) / "agent-runner.secret"
            runner_secret, _ = private_token(runner_path)

            self.assertTrue(created)
            self.assertFalse(created_again)
            self.assertEqual(first, second)
            self.assertNotEqual(first, runner_secret)
            self.assertGreaterEqual(len(first), 32)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(runner_path.stat().st_mode & 0o777, 0o600)

    def test_paired_loopback_settings_and_runner_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            config_path = root / "client.json"
            started: list[str] = []
            configure_client(
                config_path=config_path,
                control_url="https://merv.test",
            )
            server = local_control(
                config_path=config_path,
                token="pairing-secret",
                credential_path=root / "agent-runner.key",
                validate=lambda path: (
                    load_platforms(path),
                    load_workspace_settings(path),
                ),
                status=lambda: {
                    "runner_active": False,
                    "project_id": None,
                    "sessions": [],
                },
                start=started.append,
                port=0,
                origins={"https://experiments.rapidreview.io"},
            )
            thread = start_in_background(server)
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urllib.request.urlopen(f"{base}/health") as response:
                    self.assertEqual(
                        json.load(response),
                        {"ok": True, "service": "merv-agent-runner"},
                    )

                bridge_origin = "https://experiments.rapidreview.io"
                bridge_url = (
                    f"{base}/bridge?origin="
                    f"{urllib.parse.quote(bridge_origin, safe='')}"
                )
                with urllib.request.urlopen(bridge_url) as response:
                    bridge = response.read().decode()
                    self.assertIn("merv-runner-bridge-v1", bridge)
                    self.assertIn('"/start"', bridge)
                    self.assertIn('"POST"', bridge)
                    self.assertIn(json.dumps(bridge_origin), bridge)
                    self.assertNotIn("pairing-secret", bridge)
                    self.assertIn(
                        "default-src 'none'",
                        response.headers["Content-Security-Policy"],
                    )
                    self.assertEqual(response.headers["X-Frame-Options"], "DENY")
                with self.assertRaises(urllib.error.HTTPError) as bad_bridge:
                    urllib.request.urlopen(
                        f"{base}/bridge?origin=https%3A%2F%2Fevil.example"
                    )
                self.assertEqual(bad_bridge.exception.code, 403)

                with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                    urllib.request.urlopen(f"{base}/settings")
                self.assertEqual(unauthorized.exception.code, 401)

                unpaired_start = urllib.request.Request(
                    f"{base}/start",
                    data=json.dumps({"project_id": "proj_123"}).encode(),
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                    urllib.request.urlopen(unpaired_start)
                self.assertEqual(unauthorized.exception.code, 401)

                credential = "mk_" + ("x" * 43)
                unpaired_credential = urllib.request.Request(
                    f"{base}/credential",
                    data=json.dumps({"key": credential}).encode(),
                    method="PUT",
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                    urllib.request.urlopen(unpaired_credential)
                self.assertEqual(unauthorized.exception.code, 401)

                invalid_credential = urllib.request.Request(
                    f"{base}/credential",
                    data=json.dumps({"key": "not-a-key"}).encode(),
                    method="PUT",
                    headers={
                        "Authorization": "Bearer pairing-secret",
                        "Content-Type": "application/json",
                        "Origin": base,
                    },
                )
                with self.assertRaises(urllib.error.HTTPError) as invalid:
                    urllib.request.urlopen(invalid_credential)
                self.assertEqual(invalid.exception.code, 400)

                credential_request = urllib.request.Request(
                    f"{base}/credential",
                    data=json.dumps({"key": credential}).encode(),
                    method="PUT",
                    headers={
                        "Authorization": "Bearer pairing-secret",
                        "Content-Type": "application/json",
                        "Origin": "https://experiments.rapidreview.io",
                    },
                )
                with urllib.request.urlopen(credential_request) as response:
                    self.assertEqual(
                        json.load(response), {"configured": True, "ok": True}
                    )
                credential_path = root / "agent-runner.key"
                with patch.dict(
                    os.environ,
                    {"MERV_MCP_KEY": "", "RESEARCH_PLUGIN_MCP_KEY": ""},
                ):
                    self.assertEqual(_runner_key(config_path), credential)
                self.assertEqual(credential_path.stat().st_mode & 0o777, 0o600)

                payload = json.dumps(
                    {
                        "agent_platforms": {
                            "codex": {
                                "adapter": "codex",
                                "enabled": True,
                                "command": ["codex"],
                                "parallelism": 2,
                            }
                        },
                        "agent_workspace": {
                            "strategy": "git_worktree",
                            "repository": None,
                            "root": None,
                            "base_ref": "HEAD",
                        },
                        "features": {"sandbox": False},
                    }
                ).encode()
                request = urllib.request.Request(
                    f"{base}/settings",
                    data=payload,
                    method="PUT",
                    headers={
                        "Authorization": "Bearer pairing-secret",
                        "Content-Type": "application/json",
                        "Origin": "https://experiments.rapidreview.io",
                    },
                )
                with urllib.request.urlopen(request) as response:
                    result = json.load(response)
                    self.assertTrue(result["restart_required"])
                    self.assertEqual(
                        response.headers["Access-Control-Allow-Origin"],
                        "https://experiments.rapidreview.io",
                    )

                stored = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(stored["control_url"], "https://merv.test")
                self.assertEqual(stored["agent_platforms"]["codex"]["parallelism"], 2)
                self.assertFalse(stored["features"]["sandbox"])

                invalid_start = urllib.request.Request(
                    f"{base}/start",
                    data=json.dumps({"project_id": "not-a-project"}).encode(),
                    method="POST",
                    headers={
                        "Authorization": "Bearer pairing-secret",
                        "Content-Type": "application/json",
                        "Origin": "https://experiments.rapidreview.io",
                    },
                )
                with self.assertRaises(urllib.error.HTTPError) as invalid:
                    urllib.request.urlopen(invalid_start)
                self.assertEqual(invalid.exception.code, 400)

                start = urllib.request.Request(
                    f"{base}/start",
                    data=json.dumps({"project_id": "proj_123"}).encode(),
                    method="POST",
                    headers={
                        "Authorization": "Bearer pairing-secret",
                        "Content-Type": "application/json",
                        "Origin": "https://experiments.rapidreview.io",
                    },
                )
                with urllib.request.urlopen(start) as response:
                    self.assertEqual(response.status, 202)
                    self.assertEqual(
                        json.load(response),
                        {
                            "ok": True,
                            "project_id": "proj_123",
                            "state": "starting",
                        },
                    )
                deadline = time.monotonic() + 1
                while not started and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(started, ["proj_123"])

                with self.assertRaises(urllib.error.HTTPError) as duplicate:
                    urllib.request.urlopen(start)
                self.assertEqual(duplicate.exception.code, 409)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
