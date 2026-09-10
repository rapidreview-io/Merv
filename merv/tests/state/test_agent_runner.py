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
    Lease,
    CommandHost,
    HOSTS,
    HostSession,
    Platform,
    RunnerError,
    SessionLedger,
    Workspace,
    WorkspaceManager,
    WorkspacePolicy,
    WorkspaceSettings,
    _child_environment,
    _runner_key,
    _read_trace_telemetry,
    _run_runner,
    _trace_excerpt,
    _session_key,
    load_platforms,
    load_workspace_settings,
    main as runner_main,
)
from merv.shared.client_config import ClientError, safe_control_url
from merv.client.cli import (
    configure_agent,
    configure_client,
    configure_workspace,
    main,
)
from merv.client.private_files import private_token


def _lease(session_id: str, instance_id: str = "wf_1", **fields: object) -> Lease:
    """A leased assignment carrying the packet fields the runner reads."""
    fields.setdefault("project_id", "proj_1")
    return Lease(session_id=session_id, instance_id=instance_id, **fields)


def _execution(
    *,
    mode: str = "persistent",
    namespace: str = "workflows",
    base: str = "central",
    per_base: bool = False,
    retain: bool = True,
    read_only: bool = False,
) -> dict[str, object]:
    """The JSON form of a node's execution policy, as the packet carries it."""
    return {
        "read_only": read_only,
        "tools": [],
        "mutating": [],
        "scope": [],
        "sandbox": False,
        "workspace": {
            "mode": mode,
            "namespace": namespace,
            "base": base,
            "per_base": per_base,
            "retain": retain,
            "advances_central": False,
        },
    }


def _code(sha: str) -> list[dict[str, str]]:
    return [{"kind": "code", "id": sha, "label": "base commit"}]


def _git_repository(path: Path) -> Path:
    path.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(path)], check=True, capture_output=True)
    (path / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "README.md"], check=True)
    _commit(path, "base")
    return path


def _commit(path: Path, message: str) -> None:
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(
        [
            "git", "-C", str(path),
            "-c", "user.name=Merv Test", "-c", "user.email=merv@test.invalid",
            "commit", "-m", message,
        ],
        check=True,
        capture_output=True,
    )


class AgentConfigurationTest(unittest.TestCase):


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

    def test_harness_command_installs_skills_and_gates_on_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / "client.json"
            fake_bin = root / "bin"
            fake_bin.mkdir()
            codex = fake_bin / "codex"
            codex.write_text("#!/bin/sh\necho codex-cli 9.9.9\n", encoding="utf-8")
            codex.chmod(0o755)
            configure_agent(config_path=path, platform="codex", command=["codex"])
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"PATH": str(fake_bin)}),
                redirect_stdout(output),
            ):
                self.assertEqual(main(["--config", str(path), "harness", "--json"]), 0)
            report = json.loads(output.getvalue())
            self.assertEqual(report["skills"]["root"], str(root / "skills"))
            self.assertTrue((root / "skills" / "research-workflow" / "SKILL.md").is_file())
            self.assertTrue(report["platforms"]["codex"]["ok"])
            self.assertEqual(report["platforms"]["codex"]["version"], "codex-cli 9.9.9")

            configure_agent(config_path=path, platform="hermes", command=["absent-agent"])
            output = io.StringIO()
            with (
                patch.dict(os.environ, {"PATH": str(fake_bin)}),
                redirect_stdout(output),
            ):
                self.assertEqual(main(["--config", str(path), "harness"]), 1)
            text = output.getvalue()
            self.assertIn("codex: ready", text)
            self.assertIn("hermes: NOT ready", text)
            self.assertIn("'absent-agent' is not on PATH", text)

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
                        '{"project_id":"proj_1","instance_id":"wf_1"}',
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
            HOSTS["codex"].command_for(codex),
            [
                "/opt/codex",
                "exec",
                "--ignore-user-config",
                "--sandbox",
                "workspace-write",
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

        # Codex removed ``--full-auto`` in favor of an explicit sandbox mode.
        # Keep the runner on the supported spelling so a test call reaches the
        # model instead of dying in argument parsing.
        codex_command = HOSTS["codex"].command_for(codex)
        self.assertNotIn("--full-auto", codex_command)
        self.assertEqual(
            codex_command[codex_command.index("--sandbox") + 1],
            "workspace-write",
        )
        codex_session = [
            "-c",
            'mcp_servers.merv_agent_session.url="http://127.0.0.1:8878/mcp"',
            "-c",
            "mcp_servers.merv_agent_session.bearer_token_env_var="
            '"MERV_AGENT_SESSION_KEY"',
            "-c",
            'mcp_servers.merv_agent_session.default_tools_approval_mode="approve"',
        ]
        self.assertEqual(
            HOSTS["codex"].session_arguments(
                {"MERV_CONTROL_URL": "http://127.0.0.1:8878"}
            ),
            codex_session,
        )
        # ``codex exec`` drops ``-c`` overrides that precede the subcommand,
        # so the session wiring must sit after ``exec`` and before the stdin
        # marker; a claude session keeps its arguments right after argv[0].
        composed = HOSTS["codex"].compose(codex, {"MERV_CONTROL_URL": "http://127.0.0.1:8878"})
        self.assertGreater(composed.index(codex_session[1]), composed.index("exec"))
        self.assertEqual(composed[-1], "-")
        self.assertEqual(composed[-len(codex_session) - 1 : -1], codex_session)
        self.assertEqual(
            HOSTS["claude"].compose(claude, {"MERV_CONTROL_URL": "http://127.0.0.1:8878"})[
                1:3
            ],
            ["--strict-mcp-config", "--mcp-config"],
        )
        self.assertEqual(
            HOSTS["claude"].session_arguments(
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
            HOSTS["claude"].command_for(claude),
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
            HOSTS["claude"].command_for(explicit_mode),
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
        instruction = "Run the assigned work."
        native = {
            "gemini": (
                HOSTS["gemini"],
                [
                    "gemini",
                    "--approval-mode=yolo",
                    "--output-format",
                    "stream-json",
                ],
                None,
            ),
            "cursor": (
                HOSTS["cursor"],
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
                HOSTS["opencode"],
                ["opencode", "run", "--auto", "--format", "json"],
                [instruction],
            ),
            "copilot": (
                HOSTS["copilot"],
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
                HOSTS["qwen"],
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
                HOSTS["hermes"],
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
            HOSTS["hermes"].command_for(hermes),
            [
                "/opt/hermes",
                "--profile",
                "research",
                "--model",
                "anthropic/claude-opus-4-6",
            ],
        )
        self.assertEqual(HOSTS["hermes"].session_arguments({}), [])
        hermes_instruction = HOSTS["hermes"].prepare_instruction(instruction)
        self.assertIn("invoke every Merv tool", hermes_instruction)
        self.assertIn("merv-client call TOOL --arguments JSON", hermes_instruction)
        self.assertNotIn("MERV_AGENT_SESSION_KEY", hermes_instruction)
        hostile_instruction = "Review `$(touch /tmp/nope)`.\n--model attacker"
        self.assertEqual(
            HOSTS["hermes"].instruction_arguments(hostile_instruction),
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
                HOSTS["hermes"].finalize_trace(
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
            safe_control_url("http://127.0.0.1:8787/"),
            "http://127.0.0.1:8787",
        )
        self.assertEqual(
            safe_control_url("https://merv.example/"), "https://merv.example"
        )
        with self.assertRaisesRegex(ClientError, "must use HTTPS"):
            safe_control_url("http://192.0.2.10:8787")

    def test_git_workspace_follows_the_declared_policy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=_git_repository(root / "repo"),
                    root=root / "workers",
                    base_ref="main",
                )
            )
            persistent = _execution(namespace="experiments")
            one = manager.prepare(_lease("ags_1", "exp_1", execution=persistent))
            two = manager.prepare(_lease("ags_2", "exp_2", execution=persistent))
            resumed = manager.prepare(_lease("ags_3", "exp_1", execution=persistent))

            # Directory and branch names come from the namespace the node
            # declared, so deployed branches keep the names they have.
            self.assertEqual(
                one.path, root / "workers" / "experiments" / "proj_1" / "exp_1"
            )
            self.assertEqual(one.branch, "merv/experiments/proj_1/exp_1")
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
            restored = manager.prepare(_lease("ags_4", "exp_1", execution=persistent))
            self.assertEqual(restored.path, one.path)
            self.assertEqual(restored.branch, one.branch)
            manager.close(restored)
            self.assertTrue(restored.path.exists())

            # An ephemeral checkout whose base reference is absent starts from
            # central, lives under its namespace per session, and goes at
            # close when the node did not ask to retain it.
            ephemeral = _execution(
                mode="ephemeral", namespace="reviews", base="reference:code",
                retain=False, read_only=True,
            )
            checkout = manager.prepare(
                _lease(
                    "ags_r1", "exp_1", execution=ephemeral,
                    references=[{"kind": "review_request", "id": "rr_1", "label": "x"}],
                )
            )
            self.assertIsNone(checkout.branch)
            self.assertEqual(checkout.mode, "ephemeral")
            self.assertFalse(checkout.retain)
            self.assertEqual(checkout.base_sha, manager.central_sha())
            self.assertEqual(
                checkout.path,
                root / "workers" / "reviews" / "proj_1" / "exp_1" / "ags_r1",
            )
            self.assertTrue(checkout.path.exists())
            with self.assertRaisesRegex(RunnerError, "refusing to reuse"):
                manager.prepare(_lease("ags_r1", "exp_1", execution=ephemeral))
            manager.close(checkout)
            self.assertFalse(checkout.path.exists())

            # The default namespace; progress survives across sessions.
            work = manager.prepare(_lease("ags_plugin", "wf_replication", execution=_execution()))
            self.assertEqual(work.path, root / "workers" / "workflows" / "proj_1" / "wf_replication")
            (work.path / "progress.md").write_text("retained progress\n", encoding="utf-8")
            captured = manager.capture(
                path=work.path, branch=work.branch, base_sha=work.base_sha,
                session_id="ags_plugin", mode=work.mode, writable=True,
            )
            resumed = manager.prepare(_lease("ags_plugin_resume", "wf_replication", execution=_execution()))
            self.assertEqual(resumed.path, captured.path)
            self.assertEqual(resumed.head_sha, captured.head_sha)
            self.assertEqual((resumed.path / "progress.md").read_text(), "retained progress\n")

            # retain: false on a persistent node drops the worktree, never the
            # branch: the next session on the instance checks it out again.
            dropped = manager.prepare(_lease("ags_drop", "wf_drop", execution=_execution(retain=False)))
            (dropped.path / "note.md").write_text("kept in the branch\n", encoding="utf-8")
            dropped = manager.capture(
                path=dropped.path, branch=dropped.branch, base_sha=dropped.base_sha,
                session_id="ags_drop", mode=dropped.mode, writable=True, retain=False,
            )
            manager.close(dropped)
            self.assertFalse(dropped.path.exists())
            back = manager.prepare(_lease("ags_drop_2", "wf_drop", execution=_execution(retain=False)))
            self.assertEqual(back.head_sha, dropped.head_sha)
            self.assertEqual((back.path / "note.md").read_text(), "kept in the branch\n")

            # mode none: a scratch directory per session, removed at close.
            scratch = manager.prepare(_lease("ags_scratch", "wf_note", execution=_execution(mode="none")))
            self.assertEqual(scratch.mode, "none")
            self.assertEqual(scratch.path, root / "workers" / "sessions" / "proj_1" / "ags_scratch")
            self.assertFalse((scratch.path / ".git").exists())
            self.assertEqual(
                manager.capture(
                    path=scratch.path, branch=None, base_sha="",
                    session_id="ags_scratch", mode="none", writable=False,
                ),
                scratch,
            )
            manager.close(scratch)
            self.assertFalse(scratch.path.exists())

            # A policy this build cannot apply is refused before any Git work.
            with self.assertRaisesRegex(RunnerError, "unknown workspace mode"):
                manager.prepare(_lease("ags_bad", "wf_bad", execution={"workspace": {"mode": "shared"}}))
            with self.assertRaisesRegex(RunnerError, "unknown workspace base"):
                manager.prepare(_lease("ags_bad", "wf_bad", execution={"workspace": {"base": "upstream"}}))
            with self.assertRaisesRegex(RunnerError, "not a path segment"):
                manager.prepare(_lease("ags_bad", "wf_bad", execution={"workspace": {"namespace": "a/b"}}))

    def test_central_advance_records_verified_source_ancestry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=_git_repository(root / "repo"),
                    root=root / "workers",
                    base_ref="main",
                )
            )
            work = manager.prepare(_lease("ags_src", "src_1", execution=_execution(namespace="experiments")))
            (work.path / "model.py").write_text("score = 1\n", encoding="utf-8")
            _commit(work.path, "source work")
            work = manager.observe(
                path=work.path, branch=work.branch, base_sha=work.base_sha, mode="persistent",
            )

            # An ephemeral checkout pinned to a code reference sits at that commit.
            pinned = manager.prepare(
                _lease(
                    "ags_pinned", "ref_1",
                    execution=_execution(mode="ephemeral", namespace="reviews", base="reference:code", retain=False),
                    references=_code(work.head_sha),
                )
            )
            self.assertEqual(pinned.head_sha, work.head_sha)
            self.assertEqual(pinned.base_sha, work.head_sha)
            manager.close(pinned)
            self.assertFalse(pinned.path.exists())

            # A per-base persistent branch with no code reference starts from
            # central and is keyed by that base.
            integration = manager.prepare(
                _lease(
                    "ags_int", "ref_1",
                    execution=_execution(namespace="consolidations", base="reference:code", per_base=True),
                )
            )
            base12 = manager.central_sha()[:12]
            self.assertEqual(integration.branch, f"merv/consolidations/proj_1/ref_1/{base12}")
            self.assertEqual(
                integration.path,
                root / "workers" / "consolidations" / "proj_1" / "ref_1" / base12,
            )
            subprocess.run(
                [
                    "git", "-C", str(integration.path),
                    "-c", "user.name=Merv Test", "-c", "user.email=merv@test.invalid",
                    "merge", "--no-ff", str(work.branch), "-m", "integrate",
                ],
                check=True,
                capture_output=True,
            )
            target = subprocess.run(
                ["git", "-C", str(integration.path), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            sources = [{"id": "src_1", "sha": work.head_sha}]

            receipt = manager.advance(
                expected_sha=work.base_sha, target_sha=target, sources=sources,
            )

            self.assertEqual(receipt["observed_sha"], target)
            self.assertEqual(receipt["ancestry"], {"src_1": True})
            self.assertEqual(receipt["error"], "")
            self.assertEqual(manager.central_sha(), target)
            # Idempotent: the same advance settles again without moving anything.
            again = manager.advance(
                expected_sha=work.base_sha, target_sha=target, sources=sources,
            )
            self.assertEqual(again["observed_sha"], target)
            self.assertEqual(again["ancestry"], {"src_1": True})
            self.assertEqual(again["error"], "")
            with self.assertRaisesRegex(RunnerError, "source lineage"):
                manager.advance(
                    expected_sha=target, target_sha=target, sources=[{"id": "src_2"}],
                )

    def test_per_base_branch_follows_a_moved_base(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            manager = WorkspaceManager(
                WorkspaceSettings(
                    strategy="git_worktree",
                    repository=_git_repository(root / "repo"),
                    root=root / "workers",
                    base_ref="main",
                )
            )
            per_base = _execution(namespace="consolidations", base="reference:code", per_base=True)
            old_base = manager.central_sha()
            old = manager.prepare(_lease("ags_old", "ref_1", execution=per_base, references=_code(old_base)))
            same = manager.prepare(_lease("ags_same", "ref_1", execution=per_base, references=_code(old_base)))
            self.assertEqual(same.branch, old.branch)

            central_change = manager.prepare(_lease("ags_src", "src_1", execution=_execution(namespace="experiments")))
            (central_change.path / "advance.py").write_text("advanced = True\n", encoding="utf-8")
            _commit(central_change.path, "advance central")
            new_base = manager.observe(
                path=central_change.path, branch=central_change.branch,
                base_sha=central_change.base_sha, mode="persistent",
            ).head_sha
            manager.advance(expected_sha=old_base, target_sha=new_base, sources=[])

            fresh = manager.prepare(_lease("ags_fresh", "ref_1", execution=per_base, references=_code(new_base)))

            self.assertNotEqual(fresh.branch, old.branch)
            self.assertNotEqual(fresh.path, old.path)
            self.assertEqual(fresh.base_sha, new_base)
            self.assertTrue(old.path.exists())

            # A persistent branch not keyed by base keeps the base it was
            # created on; pinning it elsewhere later is refused, not rebased.
            single = _execution(base="reference:code")
            manager.prepare(_lease("ags_one", "wf_pin", execution=single, references=_code(old_base)))
            with self.assertRaisesRegex(RunnerError, "wrong base"):
                manager.prepare(_lease("ags_two", "wf_pin", execution=single, references=_code(new_base)))


_PACKET: dict[str, object] = {
    "instance_id": "wf_1",
    "workflow": "replication",
    "state": "running",
    "revision": 4,
    "project_id": "proj_1",
    "role": "worker",
    "label": "Reproduce the baseline",
    "brief": "Reproduce the baseline on the pinned commit.",
    "execution": _execution(namespace="experiments"),
    "references": [
        {"kind": "code", "id": "a" * 40, "label": "base commit"},
        {"kind": "review_request", "id": "rr_1", "label": "open request"},
    ],
    "handoff": "Complete only this node's assignment, then hand off and exit.",
    "instruction": "do the work",
}

_SESSION: dict[str, object] = {
    "id": "ags_1",
    "project_id": "proj_1",
    "status": "offered",
    "workflow_instance_id": "wf_1",
    "workflow_revision": 4,
    "target_type": "replication",
    "target_id": "wf_1",
    "role": "worker",
    "label": "Reproduce the baseline",
    "execution": _PACKET["execution"],
    "references": _PACKET["references"],
    "instruction": "do the work",
    "assignment": _PACKET,
}


class _CapturingClient(AgentSessionsClient):
    def __init__(self, session: dict[str, object] | None = None):
        self.calls: list[tuple[str, dict[str, object], bool]] = []
        self.session = dict(_SESSION if session is None else session)

    def _post(self, path, payload, *, allow_empty=False):
        self.calls.append((path, dict(payload), allow_empty))
        return {"session": self.session}


class AgentSessionProtocolTest(unittest.TestCase):
    def test_lease_wire_contract_is_concentrated_in_client(self) -> None:
        client = _CapturingClient()

        lease = client.lease(
            project_id="proj_1",
            platform="codex",
            runner_id="runner_1",
            idempotency_key="delivery_1",
            session_key="mas_child-secret-with-enough-entropy-123456789",
        )

        self.assertEqual(
            lease,
            Lease(
                session_id="ags_1",
                project_id="proj_1",
                instance_id="wf_1",
                target_type="replication",
                target_id="wf_1",
                role="worker",
                label="Reproduce the baseline",
                execution=_execution(namespace="experiments"),
                references=list(_PACKET["references"]),
                instruction="do the work",
                assignment=_PACKET,
            ),
        )
        # Reference kinds the policy names are resolved; nothing else is read.
        self.assertEqual(lease.reference("code"), "a" * 40)
        self.assertEqual(lease.reference("review_request"), "rr_1")
        self.assertEqual(lease.reference("missing"), "")
        self.assertEqual(lease.workspace, WorkspacePolicy(namespace="experiments"))
        self.assertFalse(lease.read_only)
        self.assertEqual(
            client.calls,
            [
                (
                    "/api/agent-sessions/lease",
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

    def test_lease_reads_packet_fields_from_the_assignment_when_the_row_lacks_them(self) -> None:
        client = _CapturingClient(
            {"id": "ags_2", "project_id": "proj_1", "status": "active", "assignment": _PACKET}
        )

        lease = client.lease(
            project_id="proj_1",
            platform="codex",
            runner_id="runner_1",
            idempotency_key="delivery_2",
            session_key="mas_child-secret-with-enough-entropy-123456789",
        )

        self.assertEqual(lease.session_id, "ags_2")
        self.assertEqual(lease.instance_id, "wf_1")
        self.assertEqual(lease.target_type, "replication")
        self.assertEqual(lease.target_id, "wf_1")
        self.assertEqual(lease.role, "worker")
        self.assertEqual(lease.label, "Reproduce the baseline")
        self.assertEqual(lease.execution, _execution(namespace="experiments"))
        self.assertEqual(lease.references, _PACKET["references"])
        self.assertEqual(lease.instruction, "do the work")

    def test_lease_refuses_a_packet_this_runner_cannot_apply(self) -> None:
        def lease(session):
            return _CapturingClient(session).lease(
                project_id="proj_1",
                platform="codex",
                runner_id="runner_1",
                idempotency_key="delivery_3",
                session_key="mas_child-secret-with-enough-entropy-123456789",
            )

        with self.assertRaisesRegex(RunnerError, "unknown workspace mode"):
            lease({**_SESSION, "execution": {"workspace": {"mode": "shared"}}})
        with self.assertRaisesRegex(RunnerError, "missing instance id"):
            lease({"id": "ags_3", "project_id": "proj_1", "status": "offered"})
        with self.assertRaisesRegex(RunnerError, "references must be a list"):
            lease({**_SESSION, "references": {"kind": "code"}})
        # Defaults are the spec's: persistent, retained, from central.
        bare = lease(
            {
                **_SESSION,
                "execution": {"read_only": True},
                "references": [],
                "assignment": {},
            }
        )
        self.assertEqual(bare.workspace, WorkspacePolicy())
        self.assertTrue(bare.read_only)
        self.assertEqual(bare.reference("code"), "")
        self.assertEqual(bare.reference("review_request"), "")

    def test_trace_excerpt_is_the_redacted_tail_and_changes_signature(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            trace_dir = Path(tmp)
            self.assertIsNone(_trace_excerpt(trace_dir, complete=False))
            lines = [json.dumps({"type": "message", "n": index}) for index in range(100)]
            lines.append(json.dumps({"type": "tool", "authorization": "Bearer abcdefghijklmnop", "note": "key mk_" + "b" * 43}))
            lines.append("not json at all")
            lines.append(json.dumps({"type": "huge", "blob": "y" * 20_000}))
            (trace_dir / "trace.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
            (trace_dir / "stderr.log").write_text("boot\n" + "z" * 20_000 + "\nlast line\n", encoding="utf-8")

            excerpt = _trace_excerpt(trace_dir, complete=False)
            events = excerpt["events"]
            self.assertLessEqual(len(events), 60)
            self.assertEqual(events[-1].get("truncated"), True)
            self.assertEqual(events[-2], {"raw": "not json at all"})
            self.assertEqual(events[-3]["authorization"], "<redacted>")
            self.assertEqual(events[-3]["note"], "key <redacted>")
            self.assertEqual(events[0], {"type": "message", "n": 100 - (60 - 3)})
            self.assertTrue(excerpt["stderr_tail"].endswith("last line\n"))
            self.assertLessEqual(len(excerpt["stderr_tail"].encode("utf-8")), 8 * 1024)
            first = excerpt["signature"]
            self.assertEqual(_trace_excerpt(trace_dir, complete=False)["signature"], first)
            with (trace_dir / "trace.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"type": "message", "n": 999}) + "\n")
            self.assertNotEqual(_trace_excerpt(trace_dir, complete=False)["signature"], first)
            self.assertNotEqual(_trace_excerpt(trace_dir, complete=True)["signature"], first)

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

    def test_closed_idempotent_lease_is_never_launched(self) -> None:
        client = _CapturingClient()

        def closed(path, payload, *, allow_empty=False):
            return {
                "session": {
                    "id": "ags_old",
                    "project_id": "proj_1",
                    "workflow_instance_id": "wf_old",
                    "status": "released",
                }
            }

        client._post = closed
        self.assertIsNone(
            client.lease(
                project_id="proj_1",
                platform="codex",
                runner_id="runner_1",
                idempotency_key="old_delivery",
                session_key="mas_child-secret-with-enough-entropy-123456789",
            )
        )


    def test_ledger_keeps_rows_written_by_an_earlier_runner(self) -> None:
        # The ledger is the at-most-once launch record for every session this
        # machine ever started; a row from a build that stored other fields
        # must still load, or the runner could not start after an upgrade.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sessions.json"
            path.write_text(
                json.dumps(
                    {
                        "runner_id": "runner_1",
                        "pending_leases": {},
                        "sessions": [
                            {
                                "session_id": "ags_old",
                                "experiment_id": "exp_old",
                                "project_id": "proj_1",
                                "platform": "codex",
                                "launch_attempted": True,
                                "target_type": "experiment",
                                "target_id": "exp_old",
                                "kind": "experiment",
                                "attempt_index": 2,
                                "workspace_mode": "work",
                                "status": "stopped",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            ledger = SessionLedger(path)
            row = ledger.sessions["ags_old"]
            self.assertEqual(row.status, "stopped")
            self.assertEqual(row.target_id, "exp_old")
            self.assertEqual(row.instance_id, "")
            self.assertTrue(row.workspace_retain)
            with self.assertRaisesRegex(RunnerError, "already has a launch record"):
                ledger.reserve(_lease("ags_old"), Platform("codex", "codex", ("codex",)))
            ledger.save()
            self.assertEqual(SessionLedger(path).sessions["ags_old"].status, "stopped")


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
    last_lease_reason = ""

    def __init__(self, lease: Lease):
        self.lease_result = lease
        self.lease_calls: list[dict[str, object]] = []
        self.attached: list[tuple[str, str]] = []
        self.released: list[tuple[str, str]] = []
        self.heartbeats: list[str] = []
        self.traces: list[dict[str, object]] = []
        self.remote_sessions: list[dict[str, object]] = []
        self.pending: dict[str, object] | None = None
        self.advance: dict[str, object] | None = None
        self.prepared: list[dict[str, object]] = []
        self.settled: list[dict[str, object]] = []

    def lease(self, **kwargs):
        self.lease_calls.append(kwargs)
        return self.lease_result

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

    def record_trace(self, *, session_id, runner_id, events, stderr_tail, complete):
        self.traces.append(
            {"session_id": session_id, "events": list(events), "stderr_tail": stderr_tail, "complete": complete}
        )

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

    def prepare(self, lease):
        return Workspace(
            path=self.root / lease.session_id,
            branch=f"merv/{lease.session_id}",
            base_sha="1" * 40,
            head_sha="1" * 40,
            stats={
                "commit_count": 0,
                "files_changed": 0,
                "insertions": 0,
                "deletions": 0,
            },
        )

    def observe(self, *, path, branch, base_sha, mode, retain=True):
        return Workspace(
            path=path,
            branch=branch,
            mode=mode,
            retain=retain,
            base_sha=base_sha,
            head_sha="2" * 40,
            stats={"commit_count": 1, "files_changed": 1},
        )

    def capture(self, *, path, branch, base_sha, mode, retain=True, **kwargs):
        return self.observe(
            path=path,
            branch=branch,
            base_sha=base_sha,
            mode=mode,
            retain=retain,
        )

    def close(self, workspace):
        return None

    def advance(self, **kwargs):
        return {
            "observed_sha": kwargs["target_sha"],
            "proposal_parents": [kwargs["expected_sha"]],
            "diffstat": {"commit_count": 1},
            "ancestry": {
                str(source["id"]): False for source in kwargs.get("sources", [])
            },
            "error": "",
        }

    def central_sha(self):
        return "1" * 40

    def exclude_file(self):
        return self.root / "central.git" / "info" / "exclude"


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

    def test_pending_advance_is_leased_swapped_and_settled_once(self) -> None:
        client = _FakeClient(_lease("unused"))
        advance = {
            "advance_id": "adv_1",
            "instance_id": "wf_1",
            "revision": 7,
            "expected_sha": "1" * 40,
            "target_sha": "2" * 40,
            "sources": [{"id": "src_1", "sha": "a" * 40}],
        }
        client.pending = dict(advance)
        client.advance = dict(advance)
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

            self.assertEqual(
                client.prepared,
                [{"project_id": "proj_1", "instance_id": "wf_1", "runner_id": ledger.runner_id}],
            )
        self.assertEqual(len(client.settled), 1)
        receipt = client.settled[0]
        self.assertEqual(receipt["project_id"], "proj_1")
        self.assertEqual(receipt["advance_id"], "adv_1")
        self.assertEqual(receipt["observed_sha"], "2" * 40)
        self.assertEqual(receipt["proposal_parents"], ["1" * 40])
        self.assertEqual(receipt["ancestry"], {"src_1": False})
        self.assertEqual(receipt["error"], "")

    def test_advance_waits_until_the_brain_grants_the_lease(self) -> None:
        client = _FakeClient(_lease("unused"))
        client.pending = {"advance_id": "adv_1", "instance_id": "wf_1", "revision": 7}
        client.advance = None
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
            self.assertFalse(runner.advance_ready())
            self.assertEqual(len(client.prepared), 1)
            client.pending = None
            self.assertFalse(runner.advance_ready())
            self.assertEqual(len(client.prepared), 1)
            client.pending = {"advance_id": "adv_1"}
            with self.assertRaisesRegex(RunnerError, "no instance id"):
                runner.advance_ready()
        self.assertEqual(client.settled, [])

    def test_a_failed_swap_is_settled_with_its_error(self) -> None:
        client = _FakeClient(_lease("unused"))
        advance = {
            "advance_id": "adv_2",
            "instance_id": "wf_1",
            "revision": 7,
            "expected_sha": "1" * 40,
            "target_sha": "3" * 40,
            "sources": [],
        }
        client.pending = dict(advance)
        client.advance = dict(advance)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspaces = _FakeWorkspaces(root)
            workspaces.advance = MagicMock(side_effect=RunnerError("central moved"))
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(),
                client=client,
                ledger=SessionLedger(root / "sessions.json"),
                workspaces=workspaces,
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )
            self.assertFalse(runner.advance_ready())
        receipt = client.settled[0]
        self.assertEqual(receipt["advance_id"], "adv_2")
        self.assertEqual(receipt["observed_sha"], "1" * 40)
        self.assertEqual(receipt["error"], "central moved")

    def test_launch_is_reserved_first_and_secret_reaches_only_child_env(self) -> None:
        lease = _lease(
            "ags_1",
            "wf_1",
            target_type="replication",
            role="worker",
            label="Reproduce the baseline",
            execution=_execution(namespace="experiments"),
            references=_code("a" * 40),
            instruction="Execute the assigned work with the supplied context.",
            assignment={"instance_id": "wf_1", "role": "worker", "brief": "the brief"},
        )
        client = _FakeClient(lease)
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
            lease_call = client.lease_calls[0]
            self.assertEqual(
                launch["child_env"]["MERV_AGENT_SESSION_KEY"],
                _session_key(
                    runner_secret=b"r" * 32,
                    idempotency_key=lease_call["idempotency_key"],
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
            self.assertEqual(metadata["schema_version"], 2)
            self.assertEqual(
                metadata["assignment"],
                {"instance_id": "wf_1", "role": "worker", "brief": "the brief"},
            )
            work_item = metadata["work_item"]
            self.assertEqual(work_item["instance_id"], "wf_1")
            self.assertEqual(work_item["target_type"], "replication")
            self.assertEqual(work_item["target_id"], "wf_1")
            self.assertEqual(work_item["role"], "worker")
            self.assertEqual(work_item["label"], "Reproduce the baseline")
            self.assertEqual(work_item["source_sha"], "a" * 40)
            self.assertIsNone(work_item["review_request_id"])
            self.assertEqual(work_item["execution"], _execution(namespace="experiments"))
            self.assertEqual(work_item["references"], _code("a" * 40))
            self.assertEqual(work_item["workspace"]["mode"], "persistent")
            self.assertTrue(work_item["workspace"]["retain"])
            ledger_row = ledger.sessions["ags_1"]
            self.assertEqual(ledger_row.instance_id, "wf_1")
            self.assertEqual(ledger_row.role, "worker")
            self.assertEqual(ledger_row.workspace_mode, "persistent")
            self.assertTrue(ledger_row.workspace_retain)
            self.assertFalse(ledger_row.read_only)
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

            # Even if the remote lease is replayed after the process stops,
            # the durable launch record makes a second spawn impossible.
            ledger.sessions["ags_1"].status = "stopped"
            with patch.dict(
                "merv.client.agent_runner.HOSTS",
                {"command": host},
                clear=True,
            ):
                self.assertEqual(runner.fill_available_slots(), 0)
            self.assertEqual(len(host.spawns), 1)

    def test_lost_lease_response_reuses_identity_without_storing_the_secret(
        self,
    ) -> None:
        lease = _lease("ags_1")
        client = _FakeClient(lease)
        client.lease = MagicMock(side_effect=[RunnerError("response lost"), lease])
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

            first = client.lease.call_args_list[0].kwargs
            second = client.lease.call_args_list[1].kwargs
            self.assertEqual(first["idempotency_key"], second["idempotency_key"])
            self.assertEqual(first["session_key"], second["session_key"])
            self.assertEqual(ledger.pending_leases, {})
            self.assertEqual(len(host.spawns), 1)

    def test_launch_mounts_skills_and_tells_the_child_where_they_are(self) -> None:
        lease = _lease(
            "ags_1",
            instruction="Resume the assignment and follow the research-workflow skill.",
        )
        client = _FakeClient(lease)
        host = _FakeHost()
        platform = Platform("codex", "codex", ("codex",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=SessionLedger(root / "sessions.json"),
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
                environment={"PATH": "/bin"},
            )
            self.assertIsNotNone(runner.skills)
            self.assertEqual(runner.skills.root, root / "skills")
            with (
                patch.dict("merv.client.agent_runner.HOSTS", {"codex": host}, clear=True),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(runner.fill_available_slots(), 1)
            launch = host.spawns[0]
            self.assertEqual(launch["child_env"]["MERV_SKILLS_DIR"], str(root / "skills"))
            self.assertIn(str(root / "skills"), launch["instruction"])
            self.assertIn("research-workflow", launch["instruction"])
            link = root / "ags_1" / ".agents" / "skills" / "research-workflow"
            self.assertTrue(link.is_symlink())
            self.assertTrue((link / "SKILL.md").is_file())
            exclude = root / "central.git" / "info" / "exclude"
            self.assertIn("/.agents/skills/research-workflow", exclude.read_text())

            inventory = runner.inventory()
            self.assertEqual(
                inventory["harness"]["skills"]["count"], len(runner.skills.names)
            )
            self.assertEqual(
                inventory["harness"]["platforms"]["codex"]["merv_mcp"], "native"
            )
            self.assertEqual(
                inventory["harness"]["platforms"]["codex"]["skills"], "mounted"
            )

    def test_one_bad_platform_does_not_stop_other_launches(self) -> None:
        bad = Platform("bad", "bad", ("missing-agent",))
        good = Platform("good", "good", ("working-agent",))
        client = _FakeClient(_lease("unused"))

        def lease_for_platform(**kwargs):
            name = kwargs["platform"]
            return _lease(f"ags_{name}", f"wf_{name}")

        client.lease = lease_for_platform
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
        lease = _lease("ags_1")
        client = _FakeClient(lease)
        client.remote_sessions = [{"id": "ags_1", "status": "expired"}]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(lease, platform)
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
        first = _lease("ags_1", "wf_1", role="worker")
        second = _lease("ags_2", "wf_1", role="worker")
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
        lease = _lease("ags_1")
        client = _FakeClient(lease)
        client.remote_sessions = [{"id": "ags_1", "status": "expired"}]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(lease, platform)
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
        lease = _lease("ags_1")
        client = _FakeClient(lease)
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(lease, platform)
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
        lease = _lease("ags_1")
        client = _FakeClient(lease)
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
            session = ledger.reserve(lease, platform)
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

    def test_reconcile_mirrors_the_trace_excerpt_on_change_and_finally_complete(self) -> None:
        lease = _lease("ags_1")
        client = _FakeClient(lease)
        client.remote_sessions = [
            {"id": "ags_1", "status": "active", "host_session_ref": "pid:41"}
        ]
        host = _FakeHost()
        platform = Platform("custom", "command", ("agent",))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            trace_dir = root / "traces" / "ags_1"
            trace_dir.mkdir(parents=True)
            (trace_dir / "trace.jsonl").write_text(
                json.dumps({"type": "message", "text": "first"}) + "\n", encoding="utf-8"
            )
            (trace_dir / "stderr.log").write_text("boot\n", encoding="utf-8")
            ledger = SessionLedger(root / "sessions.json")
            session = ledger.reserve(lease, platform)
            session.host_ref = "pid:41"
            session.pid = 41
            session.attached = True
            session.status = "running"
            session.trace_dir = str(trace_dir)
            runner = AgentRunner(
                project_id="proj_1",
                platforms=(platform,),
                client=client,
                ledger=ledger,
                workspaces=_FakeWorkspaces(root),
                trace_dir=root / "traces",
                runner_secret=b"r" * 32,
            )
            with patch.dict("merv.client.agent_runner.HOSTS", {"command": host}, clear=True):
                runner.reconcile()
                runner.reconcile()  # unchanged trace → no second mirror
            self.assertEqual(len(client.traces), 1)
            self.assertEqual(client.traces[0]["events"], [{"type": "message", "text": "first"}])
            self.assertEqual(client.traces[0]["stderr_tail"], "boot\n")
            self.assertFalse(client.traces[0]["complete"])

            with (trace_dir / "trace.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"type": "message", "text": "second"}) + "\n")
            host.inspect = lambda _session: "stopped"
            with patch.dict("merv.client.agent_runner.HOSTS", {"command": host}, clear=True):
                runner.reconcile()
            self.assertEqual(len(client.traces), 2)
            self.assertEqual([event["text"] for event in client.traces[1]["events"]], ["first", "second"])
            self.assertTrue(client.traces[1]["complete"])
            self.assertEqual(session.status, "stopped")

    def test_one_broken_session_does_not_stop_peer_reconciliation(self) -> None:
        client = _FakeClient(_lease("unused"))
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
            for session_id, instance_id, pid in (
                ("ags_bad", "wf_bad", 40),
                ("ags_good", "wf_good", 41),
            ):
                session = ledger.reserve(_lease(session_id, instance_id), platform)
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


if __name__ == "__main__":
    unittest.main()
