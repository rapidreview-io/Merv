"""Run Merv experiment assignments in local coding-agent sessions.

The brain decides which experiment may run.  This process is only the local
actuator: it claims work, starts an independently authenticated coding-agent
process, and reports the process reference back to Merv.

The session credential is supplied to a child only as
``MERV_AGENT_SESSION_KEY``. It is never written to disk, added to argv,
included in the prompt, or logged.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from merv.shared.client_config import (
    AGENT_SESSION_KEY_ENV_VAR,
    CLIENT_CONFIG_ENV_VAR,
    dual_env_value,
    resolve_client_config_path,
    resolve_client_control_url,
)
from .local_control import (
    DEFAULT_PORT,
    LocalControlError,
    local_control,
    pairing_token,
    private_token,
    start_in_background,
)


MCP_KEY_ENV_VAR = "MERV_MCP_KEY"
SESSION_KEY_PREFIX = "mas_"
DEFAULT_POLL_SECONDS = 10.0
RAPID_STOP_SECONDS = 30.0
CRASH_LOOP_WINDOW_SECONDS = 2 * 60.0


class RunnerError(Exception):
    """A configuration, protocol, or local-launch failure."""


@dataclass(frozen=True)
class Platform:
    """One locally configured coding-agent platform."""

    name: str
    adapter: str
    command: tuple[str, ...]
    enabled: bool = True
    model: str | None = None
    effort: str | None = None
    parallelism: int = 1


@dataclass(frozen=True)
class Claim:
    """A Merv-authorized experiment session."""

    session_id: str
    experiment_id: str
    project_id: str
    target_type: str = "experiment"
    target_id: str = ""
    source_sha: str = ""
    instruction: str | None = None
    kind: str = "experiment"
    review_request_id: str | None = None
    attempt_index: int = 0
    assignment: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if not self.target_id:
            object.__setattr__(self, "target_id", self.experiment_id)


@dataclass(frozen=True)
class HostSession:
    """The small machine-local reference Merv needs for reconciliation."""

    ref: str
    pid: int


@dataclass(frozen=True)
class Workspace:
    """Where one agent may modify code without colliding with another."""

    path: Path
    branch: str | None = None
    kind: str = "experiment"
    review_request_id: str | None = None
    base_sha: str = ""
    head_sha: str = ""
    stats: dict[str, int] | None = None


@dataclass(frozen=True)
class WorkspaceSettings:
    strategy: str
    repository: Path
    root: Path | None = None
    base_ref: str = "HEAD"


@dataclass(frozen=True)
class TraceFiles:
    """Private machine-local files for one auto-run agent session."""

    directory: Path
    stdout: Path
    stderr: Path


class AgentHost(Protocol):
    """The only platform-specific process boundary."""

    trace_format: str
    stdout_filename: str
    trace_filename: str | None

    def spawn(
        self,
        *,
        platform: Platform,
        instruction: str,
        child_env: Mapping[str, str],
        stdout_path: Path,
        stderr_path: Path,
        cwd: Path,
    ) -> HostSession: ...

    def inspect(self, session: HostSession) -> str: ...

    def stop(self, session: HostSession) -> None: ...

    def finalize_trace(self, *, platform: Platform, trace_dir: Path) -> None: ...


class CommandHost:
    """A shell-free host for a command that accepts its instruction on stdin."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename: str | None = "trace.jsonl"

    def __init__(self) -> None:
        self._processes: dict[int, subprocess.Popen[bytes]] = {}

    def command_for(self, platform: Platform) -> list[str]:
        return list(platform.command)

    def session_arguments(self, child_env: Mapping[str, str]) -> list[str]:
        """Global CLI arguments that connect this process to its Merv session."""
        return []

    def instruction_arguments(self, instruction: str) -> list[str] | None:
        """Return argv prompt fields, or None when the CLI reads stdin."""
        return None

    def prepare_instruction(self, instruction: str) -> str:
        """Add adapter-specific guidance before choosing stdin or argv."""
        return instruction

    def finalize_trace(self, *, platform: Platform, trace_dir: Path) -> None:
        """Finish provider-specific capture after the child stops."""
        return None

    def spawn(
        self,
        *,
        platform: Platform,
        instruction: str,
        child_env: Mapping[str, str],
        stdout_path: Path,
        stderr_path: Path,
        cwd: Path,
    ) -> HostSession:
        command = self.command_for(platform)
        command[len(platform.command) : len(platform.command)] = self.session_arguments(
            child_env
        )
        instruction = self.prepare_instruction(instruction)
        instruction_arguments = self.instruction_arguments(instruction)
        if instruction_arguments is not None:
            command.extend(instruction_arguments)
        if not command:
            raise RunnerError(f"{platform.name}: command is required")
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
        stderr_path.parent.mkdir(parents=True, exist_ok=True)
        environment = dict(child_env)
        if platform.model:
            environment["MERV_AGENT_MODEL"] = platform.model
        if platform.effort:
            environment["MERV_AGENT_EFFORT"] = platform.effort
        stdout_descriptor = os.open(
            stdout_path,
            os.O_WRONLY | os.O_APPEND | os.O_CREAT,
            0o600,
        )
        try:
            stderr_descriptor = os.open(
                stderr_path,
                os.O_WRONLY | os.O_APPEND | os.O_CREAT,
                0o600,
            )
        except Exception:
            os.close(stdout_descriptor)
            raise
        os.fchmod(stdout_descriptor, 0o600)
        os.fchmod(stderr_descriptor, 0o600)
        with (
            os.fdopen(stdout_descriptor, "ab", buffering=0) as output,
            os.fdopen(stderr_descriptor, "ab", buffering=0) as errors,
        ):
            process: subprocess.Popen[bytes] | None = None
            try:
                process = subprocess.Popen(
                    command,
                    stdin=(
                        subprocess.PIPE
                        if instruction_arguments is None
                        else subprocess.DEVNULL
                    ),
                    stdout=output,
                    stderr=errors,
                    env=environment,
                    cwd=cwd,
                    start_new_session=True,
                )
                if instruction_arguments is None:
                    assert process.stdin is not None
                    process.stdin.write(instruction.encode("utf-8"))
                    process.stdin.close()
            except (OSError, ValueError) as exc:
                if process is not None:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                raise RunnerError(
                    f"{platform.name}: could not start {command[0]!r}: {exc}"
                ) from exc
        assert process is not None
        self._processes[process.pid] = process
        marker = _process_marker(process.pid)
        if marker is None:
            # A process without a birth marker cannot be distinguished from a
            # reused PID after restart, so it cannot be safely supervised.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            self._processes.pop(process.pid, None)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=2)
            raise RunnerError(
                f"{platform.name}: could not record a safe process identity"
            )
        return HostSession(ref=f"pid:{process.pid}:{marker}", pid=process.pid)

    def inspect(self, session: HostSession) -> str:
        process = self._processes.get(session.pid)
        if process is not None:
            if process.poll() is None:
                return "running"
            self._processes.pop(session.pid, None)
            return "stopped"
        try:
            os.kill(session.pid, 0)
        except ProcessLookupError:
            return "stopped"
        except PermissionError:
            return "unknown"
        marker = _session_marker(session)
        if marker is None:
            return "unknown"
        if _process_marker(session.pid) != marker:
            return "stopped"
        return "running"

    def stop(self, session: HostSession) -> None:
        process = self._processes.get(session.pid)
        if process is not None and process.poll() is not None:
            self._processes.pop(session.pid, None)
            return
        if process is None:
            marker = _session_marker(session)
            if marker is None or _process_marker(session.pid) != marker:
                return
        try:
            os.killpg(session.pid, signal.SIGTERM)
        except ProcessLookupError:
            self._processes.pop(session.pid, None)
            return
        process = self._processes.pop(session.pid, None)
        if process is not None:
            try:
                process.wait(timeout=2)
                return
            except subprocess.TimeoutExpired:
                pass
        else:
            time.sleep(0.25)
            if self.inspect(session) == "stopped":
                return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(session.pid, signal.SIGKILL)


class CodexHost(CommandHost):
    """Native non-interactive Codex invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [
            *platform.command,
            "exec",
            "--ignore-user-config",
            "--full-auto",
            "--json",
            "-c",
            "sandbox_workspace_write.network_access=true",
        ]
        if platform.model:
            command.extend(("--model", platform.model))
        if platform.effort:
            command.extend(("-c", f'model_reasoning_effort="{platform.effort}"'))
        command.append("-")
        return command

    def session_arguments(self, child_env: Mapping[str, str]) -> list[str]:
        control_url = _safe_control_url(child_env["MERV_CONTROL_URL"])
        return [
            "-c",
            "mcp_servers.merv_agent_session.url=" + json.dumps(f"{control_url}/mcp"),
            "-c",
            "mcp_servers.merv_agent_session.bearer_token_env_var="
            + json.dumps(AGENT_SESSION_KEY_ENV_VAR),
        ]


class ClaudeHost(CommandHost):
    """Native non-interactive Claude Code invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [*platform.command, "--print"]
        if not _has_option(command, "--permission-mode"):
            command.extend(("--permission-mode", "auto"))
        command.extend(
            (
                "--output-format",
                "stream-json",
                "--verbose",
                "--forward-subagent-text",
            )
        )
        if platform.model:
            command.extend(("--model", platform.model))
        if platform.effort:
            command.extend(("--effort", platform.effort))
        return command

    def session_arguments(self, child_env: Mapping[str, str]) -> list[str]:
        control_url = _safe_control_url(child_env["MERV_CONTROL_URL"])
        config = {
            "mcpServers": {
                "merv_agent_session": {
                    "type": "http",
                    "url": f"{control_url}/mcp",
                    "headers": {
                        "Authorization": (f"Bearer ${{{AGENT_SESSION_KEY_ENV_VAR}}}"),
                    },
                },
            },
        }
        return [
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps(config, separators=(",", ":")),
        ]


class GeminiHost(CommandHost):
    """Native Gemini CLI headless invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [
            *platform.command,
            "--approval-mode=yolo",
            "--output-format",
            "stream-json",
        ]
        if platform.model:
            command.extend(("--model", platform.model))
        return command


class CursorHost(CommandHost):
    """Native Cursor Agent headless invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [
            *platform.command,
            "--print",
            "--force",
            "--output-format",
            "stream-json",
        ]
        if platform.model:
            command.extend(("--model", platform.model))
        return command

    def instruction_arguments(self, instruction: str) -> list[str]:
        return [instruction]


class OpenCodeHost(CommandHost):
    """Native OpenCode non-interactive invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [*platform.command, "run", "--auto", "--format", "json"]
        if platform.model:
            command.extend(("--model", platform.model))
        if platform.effort:
            command.extend(("--variant", platform.effort))
        return command

    def instruction_arguments(self, instruction: str) -> list[str]:
        return [instruction]


class CopilotHost(CommandHost):
    """Native GitHub Copilot CLI autonomous invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [
            *platform.command,
            "--autopilot",
            "--yolo",
            "--no-ask-user",
            "--output-format=json",
        ]
        if platform.model:
            command.extend(("--model", platform.model))
        return command

    def instruction_arguments(self, instruction: str) -> list[str]:
        return ["--prompt", instruction]


class QwenHost(CommandHost):
    """Native Qwen Code headless invocation."""

    trace_format = "jsonl"
    stdout_filename = "trace.jsonl"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = [
            *platform.command,
            "--approval-mode",
            "yolo",
            "--input-format",
            "text",
            "--output-format",
            "stream-json",
        ]
        if platform.model:
            command.extend(("--model", platform.model))
        return command


class HermesHost(CommandHost):
    """Native Hermes Agent scripted invocation.

    Hermes has no per-run MCP configuration flag. Claimed sessions therefore
    use the scoped ``merv-client call`` bridge described in their instruction
    while preserving the user's normal Hermes model and skill configuration.
    """

    trace_format = "jsonl-export"
    stdout_filename = "stdout.log"
    trace_filename = "trace.jsonl"

    def command_for(self, platform: Platform) -> list[str]:
        command = list(platform.command)
        if platform.model:
            command.extend(("--model", platform.model))
        return command

    def instruction_arguments(self, instruction: str) -> list[str]:
        # Scripted mode is the only Hermes one-shot surface; it also enables
        # non-interactive tool approvals.
        return ["-z", instruction]

    def session_arguments(self, child_env: Mapping[str, str]) -> list[str]:
        trace_dir = child_env.get("MERV_AGENT_TRACE_DIR")
        return (
            ["--usage-file", str(Path(trace_dir) / "hermes-usage.json")]
            if trace_dir
            else []
        )

    def prepare_instruction(self, instruction: str) -> str:
        return (
            instruction
            + "\nRunner-owned Hermes session: invoke every Merv tool with "
            "`merv-client call TOOL --arguments JSON`. Do not use an ambient "
            "native Merv MCP registration; the runner deliberately removed "
            "its owner credential and supplied only this session's scoped "
            "credential to merv-client.\n"
        )

    def finalize_trace(self, *, platform: Platform, trace_dir: Path) -> None:
        usage_path = trace_dir / "hermes-usage.json"
        if not usage_path.is_file():
            raise RunnerError("Hermes did not write its usage report")
        os.chmod(usage_path, 0o600)
        try:
            usage = json.loads(usage_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RunnerError("Hermes wrote an unreadable usage report") from exc
        session = usage.get("session") if isinstance(usage, dict) else None
        session_id = str(
            (usage.get("session_id") if isinstance(usage, dict) else "")
            or (session.get("id") if isinstance(session, dict) else "")
            or ""
        ).strip()
        if not session_id:
            raise RunnerError("Hermes usage report has no session id")
        destination = trace_dir / "trace.jsonl"
        temporary = trace_dir / "trace.jsonl.tmp"
        result = subprocess.run(
            [
                *platform.command,
                "sessions",
                "export",
                str(temporary),
                "--session-id",
                session_id,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        if result.returncode:
            message = result.stderr.strip() or result.stdout.strip() or "export failed"
            raise RunnerError(f"Hermes trace export failed: {message}")
        if not temporary.is_file():
            raise RunnerError("Hermes trace export produced no file")
        os.chmod(temporary, 0o600)
        temporary.replace(destination)


HOSTS: dict[str, AgentHost] = {
    "codex": CodexHost(),
    "claude": ClaudeHost(),
    "gemini": GeminiHost(),
    "cursor": CursorHost(),
    "opencode": OpenCodeHost(),
    "copilot": CopilotHost(),
    "qwen": QwenHost(),
    "hermes": HermesHost(),
    "command": CommandHost(),
}


@dataclass
class LocalSession:
    """Durable launch intent; a session id is never spawned twice."""

    session_id: str
    experiment_id: str
    project_id: str
    platform: str
    launch_attempted: bool
    target_type: str = "experiment"
    target_id: str = ""
    source_sha: str = ""
    adapter: str | None = None
    host_ref: str | None = None
    pid: int | None = None
    attached: bool = False
    cwd: str | None = None
    branch: str | None = None
    base_sha: str = ""
    head_sha: str = ""
    workspace_stats: dict[str, int] | None = None
    status: str = "launching"
    started_at: float | None = None
    kind: str = "experiment"
    review_request_id: str | None = None
    attempt_index: int = 0
    trace_dir: str | None = None
    trace_offset: int = 0
    telemetry: dict[str, Any] | None = None

    def host_session(self) -> HostSession | None:
        if not self.host_ref or not self.pid:
            return None
        return HostSession(ref=self.host_ref, pid=self.pid)


class SessionLedger:
    """Private local crash record for at-most-once launch decisions."""

    def __init__(self, path: Path):
        self.path = path
        self.runner_id, self.sessions, self.pending_claims = self._read()

    def _read(
        self,
    ) -> tuple[str, dict[str, LocalSession], dict[str, str]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return uuid.uuid4().hex, {}, {}
        except OSError as exc:
            raise RunnerError(f"cannot read runner ledger: {self.path}") from exc
        except ValueError as exc:
            raise RunnerError(
                f"runner ledger is malformed; refusing to lose launch history: "
                f"{self.path}"
            ) from exc
        if not isinstance(raw, dict):
            raise RunnerError(f"runner ledger must contain an object: {self.path}")
        runner_id = str(raw.get("runner_id") or uuid.uuid4().hex)
        sessions: dict[str, LocalSession] = {}
        for value in raw.get("sessions") or []:
            if not isinstance(value, dict):
                raise RunnerError(f"runner ledger contains a malformed session")
            try:
                session = LocalSession(**value)
            except (TypeError, ValueError) as exc:
                raise RunnerError(
                    "runner ledger contains an unreadable session; "
                    "refusing to risk a duplicate launch"
                ) from exc
            sessions[session.session_id] = session
        pending = raw.get("pending_claims") or {}
        if not isinstance(pending, dict) or not all(
            isinstance(name, str) and isinstance(key, str) and name and key
            for name, key in pending.items()
        ):
            raise RunnerError(
                "runner ledger contains malformed pending claims; "
                "refusing to lose retry identity"
            )
        return runner_id, sessions, dict(pending)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        payload = {
            "runner_id": self.runner_id,
            "pending_claims": self.pending_claims,
            "sessions": [asdict(item) for item in self.sessions.values()],
        }
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        temporary.replace(self.path)

    def claim_key(self, platform: str) -> str:
        key = self.pending_claims.get(platform)
        if key is None:
            key = uuid.uuid4().hex
            self.pending_claims[platform] = key
            self.save()
        return key

    def clear_claim(self, platform: str) -> None:
        if self.pending_claims.pop(platform, None) is not None:
            self.save()

    def reserve(self, claim: Claim, platform: Platform) -> LocalSession:
        existing = self.sessions.get(claim.session_id)
        if existing is not None:
            raise RunnerError(f"session {claim.session_id} already has a launch record")
        session = LocalSession(
            session_id=claim.session_id,
            experiment_id=claim.experiment_id,
            project_id=claim.project_id,
            platform=platform.name,
            launch_attempted=True,
            target_type=claim.target_type,
            target_id=claim.target_id or claim.experiment_id,
            source_sha=claim.source_sha,
            adapter=platform.adapter,
            kind=claim.kind,
            review_request_id=claim.review_request_id,
            attempt_index=claim.attempt_index,
        )
        self.sessions[claim.session_id] = session
        self.pending_claims.pop(platform.name, None)
        self.save()
        return session

    def running_count(self, platform: str) -> int:
        return sum(
            session.platform == platform
            and session.status in {"launching", "running", "uncertain"}
            for session in self.sessions.values()
        )


class RunnerLock:
    """One process owns a machine ledger at a time."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = path.open("a+")
        try:
            fcntl.flock(self._handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._handle.close()
            raise RunnerError("another merv-agent-runner owns this config") from exc

    def close(self) -> None:
        self._handle.close()


class WorkspaceManager:
    """Own the bare central repository and persistent per-experiment worktrees."""

    def __init__(self, settings: WorkspaceSettings):
        self.settings = settings
        self._bare_repository: Path | None = None

    def prepare(self, claim: Claim) -> Workspace:
        bare = self._canonical_repository()
        self._git(bare, "worktree", "prune")
        root = self.settings.root
        if root is None:
            raise RunnerError("git_worktree requires a workspace root")
        root = root.expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        target_id = _safe_name(claim.target_id or claim.experiment_id)
        project_id = _safe_name(claim.project_id)
        if claim.kind == "review":
            # Consolidation reviews carry an exact proposal SHA. Experiment
            # plan/result reviews are evidence reviews and may have no code
            # snapshot at all; give those reviewers a clean central checkout
            # instead of making an unrelated Git fact a launch prerequisite.
            review_sha = claim.source_sha or self.central_sha()
            path = (
                root
                / "reviews"
                / project_id
                / _safe_name(claim.review_request_id or claim.session_id)
                / _safe_name(claim.session_id)
            )
            if path.exists():
                raise RunnerError(f"refusing to reuse reviewer workspace: {path}")
            path.parent.mkdir(parents=True, exist_ok=True)
            self._git(
                bare,
                "worktree",
                "add",
                "--detach",
                str(path),
                review_sha,
            )
            return self._workspace(
                path=path,
                branch=None,
                base_sha=review_sha,
                kind="review",
                review_request_id=claim.review_request_id,
            )

        if claim.kind == "consolidation":
            # A rejected proposal keeps its declared base and therefore resumes
            # this exact revision branch. A stale central advance supplies a new
            # observed base, selecting a fresh worktree while preserving the old
            # proposal for review and audit.
            base_sha = claim.source_sha or self.central_sha()
            revision = base_sha[:12]
            category = "consolidations"
            branch = f"merv/{category}/{project_id}/{target_id}/{revision}"
            path = root / category / project_id / target_id / revision
            base_ref = f"refs/merv/bases/{category}/{project_id}/{target_id}/{revision}"
        else:
            base_sha = ""
            category = "experiments"
            branch = f"merv/{category}/{project_id}/{target_id}"
            path = root / category / project_id / target_id
            base_ref = f"refs/merv/bases/{category}/{project_id}/{target_id}"
        branch_ref = f"refs/heads/{branch}"
        branch_head = self._try_rev_parse(bare, branch_ref)
        if branch_head:
            recorded_base = self._try_rev_parse(bare, base_ref)
            if not recorded_base:
                raise RunnerError(f"persistent branch has no recorded base: {branch}")
            if base_sha and recorded_base != base_sha:
                raise RunnerError(
                    f"persistent consolidation branch has the wrong base: {branch}"
                )
            base_sha = recorded_base
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                self._git(bare, "worktree", "add", str(path), branch)
            return self._workspace(
                path=path,
                branch=branch,
                base_sha=base_sha,
                kind=claim.kind,
            )

        base_sha = base_sha or claim.source_sha or self.central_sha()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._git(
            bare,
            "worktree",
            "add",
            "-b",
            branch,
            str(path),
            base_sha,
        )
        self._git(bare, "update-ref", base_ref, base_sha)
        return self._workspace(
            path=path,
            branch=branch,
            base_sha=base_sha,
            kind=claim.kind,
        )

    def capture(
        self,
        *,
        path: Path,
        branch: str | None,
        base_sha: str,
        session_id: str,
        kind: str,
        writable: bool,
    ) -> Workspace:
        """Commit bounded WIP so a conversation ending cannot lose an experiment."""
        if writable and self._git(path, "status", "--porcelain").strip():
            changed = self._git(
                path,
                "ls-files",
                "--modified",
                "--others",
                "--exclude-standard",
                "-z",
            )
            oversized = [
                path / relative
                for relative in changed.split("\0")
                if relative
                and (path / relative).is_file()
                and not (path / relative).is_symlink()
                and (path / relative).stat().st_size > 50 * 1024 * 1024
            ]
            if oversized:
                raise RunnerError(
                    "refusing to auto-commit files larger than 50 MiB: "
                    + ", ".join(str(item.relative_to(path)) for item in oversized[:5])
                )
            self._git(path, "add", "-A")
            self._git(
                path,
                "-c",
                "user.name=Merv Agent Runner",
                "-c",
                "user.email=merv@localhost",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-m",
                f"merv: capture {session_id}",
            )
        return self._workspace(
            path=path,
            branch=branch,
            base_sha=base_sha or self._rev_parse(path, "HEAD"),
            kind=kind,
        )

    def observe(
        self,
        *,
        path: Path,
        branch: str | None,
        base_sha: str,
        kind: str,
    ) -> Workspace:
        return self._workspace(
            path=path,
            branch=branch,
            base_sha=base_sha or self._rev_parse(path, "HEAD"),
            kind=kind,
        )

    def close(self, workspace: Workspace) -> None:
        """Remove temporary reviewer worktrees; durable branches stay put."""
        if workspace.kind != "review" or not workspace.path.exists():
            return
        self._git(
            self._canonical_repository(),
            "worktree",
            "remove",
            "--force",
            str(workspace.path),
        )

    def central_sha(self) -> str:
        return self._rev_parse(self._canonical_repository(), "refs/merv/central")

    def advance(
        self,
        *,
        expected_sha: str,
        target_sha: str,
        sources: Sequence[Mapping[str, Any]] = (),
    ) -> dict[str, Any]:
        """Perform the sole judgment-free central compare-and-swap."""
        bare = self._canonical_repository()
        observed = self.central_sha()
        if observed == target_sha:
            return self._advance_result(
                expected_sha=expected_sha,
                target_sha=target_sha,
                observed_sha=observed,
                sources=sources,
            )
        if observed != expected_sha:
            return {
                **self._advance_result(
                    expected_sha=expected_sha,
                    target_sha=target_sha,
                    observed_sha=observed,
                    sources=sources,
                ),
                "error": "central moved before compare-and-swap",
            }
        self._rev_parse(bare, target_sha)
        ancestor = subprocess.run(
            [
                "git",
                "--git-dir",
                str(bare),
                "merge-base",
                "--is-ancestor",
                expected_sha,
                target_sha,
            ],
            capture_output=True,
            check=False,
        )
        if ancestor.returncode:
            raise RunnerError("consolidation proposal is not a descendant of central")
        self._git(
            bare,
            "update-ref",
            "refs/merv/central",
            target_sha,
            expected_sha,
        )
        return self._advance_result(
            expected_sha=expected_sha,
            target_sha=target_sha,
            observed_sha=self.central_sha(),
            sources=sources,
        )

    def _advance_result(
        self,
        *,
        expected_sha: str,
        target_sha: str,
        observed_sha: str,
        sources: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        bare = self._canonical_repository()
        parents_line = self._git(
            bare,
            "rev-list",
            "--parents",
            "-n",
            "1",
            target_sha,
        ).split()
        return {
            "observed_sha": observed_sha,
            "proposal_parents": parents_line[1:],
            "diffstat": self._diffstat(
                repository=bare,
                base_sha=expected_sha,
                head_sha=target_sha,
            ),
            "ancestry": self._ancestry(
                repository=bare,
                target_sha=target_sha,
                sources=sources,
            ),
            "error": "",
        }

    @staticmethod
    def _ancestry(
        *,
        repository: Path,
        target_sha: str,
        sources: Sequence[Mapping[str, Any]],
    ) -> dict[str, bool]:
        result: dict[str, bool] = {}
        for source in sources:
            experiment_id = str(source.get("experiment_id") or "")
            source_sha = str(source.get("source_sha") or "")
            if not experiment_id or not source_sha:
                raise RunnerError("central advance is missing experiment lineage")
            WorkspaceManager._rev_parse(repository, source_sha)
            check = subprocess.run(
                [
                    "git",
                    "--git-dir",
                    str(repository),
                    "merge-base",
                    "--is-ancestor",
                    source_sha,
                    target_sha,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if check.returncode not in {0, 1}:
                message = check.stderr.strip() or "git ancestry check failed"
                raise RunnerError(message)
            result[experiment_id] = check.returncode == 0
        return result

    def _workspace(
        self,
        *,
        path: Path,
        branch: str | None,
        base_sha: str,
        kind: str,
        review_request_id: str | None = None,
    ) -> Workspace:
        head_sha = self._rev_parse(path, "HEAD")
        return Workspace(
            path=path,
            branch=branch,
            kind=kind,
            review_request_id=review_request_id,
            base_sha=base_sha,
            head_sha=head_sha,
            stats=self._diffstat(
                repository=path,
                base_sha=base_sha,
                head_sha=head_sha,
            ),
        )

    def _canonical_repository(self) -> Path:
        if self._bare_repository is not None:
            return self._bare_repository
        root = self.settings.root
        if root is None:
            raise RunnerError("git_worktree requires a workspace root")
        root = root.expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        bare = root / ".merv-repository.git"
        if not bare.exists():
            source = self.settings.repository.expanduser().resolve()
            source_base = self._rev_parse(source, self.settings.base_ref)
            result = subprocess.run(
                ["git", "clone", "--bare", str(source), str(bare)],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
            if result.returncode:
                message = result.stderr.strip() or result.stdout.strip() or "git failed"
                raise RunnerError(f"could not create Merv repository: {message}")
            self._git(bare, "update-ref", "refs/merv/central", source_base)
        elif not self._try_rev_parse(bare, "refs/merv/central"):
            self._git(
                bare,
                "update-ref",
                "refs/merv/central",
                self._rev_parse(bare, self.settings.base_ref),
            )
        if "origin" in self._git(bare, "remote").splitlines():
            self._git(bare, "remote", "remove", "origin")
        self._bare_repository = bare
        return bare

    @staticmethod
    def _diffstat(*, repository: Path, base_sha: str, head_sha: str) -> dict[str, int]:
        if not base_sha or not head_sha:
            return {
                "commit_count": 0,
                "files_changed": 0,
                "insertions": 0,
                "deletions": 0,
            }
        count = WorkspaceManager._git(
            repository, "rev-list", "--count", f"{base_sha}..{head_sha}"
        ).strip()
        short = WorkspaceManager._git(
            repository, "diff", "--shortstat", base_sha, head_sha
        )
        numbers = {
            label: int(match.group(1)) if match else 0
            for label, pattern in {
                "files_changed": r"(\d+) files? changed",
                "insertions": r"(\d+) insertions?",
                "deletions": r"(\d+) deletions?",
            }.items()
            for match in [re.search(pattern, short)]
        }
        return {"commit_count": int(count or 0), **numbers}

    @staticmethod
    def _rev_parse(repository: Path, ref: str) -> str:
        value = (
            WorkspaceManager._git(
                repository, "rev-parse", "--verify", f"{ref}^{{commit}}"
            )
            .strip()
            .lower()
        )
        if not re.fullmatch(r"[0-9a-f]{40,64}", value):
            raise RunnerError(f"Git did not resolve a full commit for {ref!r}")
        return value

    @staticmethod
    def _try_rev_parse(repository: Path, ref: str) -> str:
        try:
            return WorkspaceManager._rev_parse(repository, ref)
        except RunnerError:
            return ""

    @staticmethod
    def _git(repository: Path, *arguments: str) -> str:
        prefix = (
            ["git", "--git-dir", str(repository)]
            if repository.name.endswith(".git") and not (repository / ".git").exists()
            else ["git", "-C", str(repository)]
        )
        try:
            result = subprocess.run(
                [*prefix, *arguments],
                capture_output=True,
                text=True,
                check=False,
                timeout=60,
            )
        except subprocess.TimeoutExpired as exc:
            raise RunnerError(
                f"Git {' '.join(arguments[:2])} timed out"
            ) from exc
        if result.returncode:
            message = result.stderr.strip() or result.stdout.strip() or "git failed"
            raise RunnerError(f"Git {' '.join(arguments[:2])} failed: {message}")
        return result.stdout


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AgentSessionsClient:
    """All assumptions about the Merv Agent Sessions HTTP contract."""

    def __init__(
        self,
        *,
        control_url: str,
        runner_key: str | None,
        timeout: float = 15.0,
    ):
        self.control_url = _safe_control_url(control_url)
        self.runner_key = runner_key
        self.timeout = timeout
        self.last_claim_reason = ""
        self._opener = urllib.request.build_opener(_NoRedirect())

    def claim(
        self,
        *,
        project_id: str,
        platform: str,
        runner_id: str,
        idempotency_key: str,
        session_key: str,
    ) -> Claim | None:
        result = self._post(
            "/api/agent-sessions/claim",
            {
                "project_id": project_id,
                "platform": platform,
                "runner_id": runner_id,
                "idempotency_key": idempotency_key,
                "session_secret": session_key,
            },
            allow_empty=True,
        )
        if result is None or result.get("session") is None:
            self.last_claim_reason = str((result or {}).get("reason") or "")
            return None
        self.last_claim_reason = ""
        session = result.get("session")
        if not isinstance(session, dict):
            raise RunnerError("malformed claim response: session must be an object")
        if str(session.get("status") or "") not in {"offered", "active"}:
            return None
        try:
            return Claim(
                session_id=str(session.get("session_id") or session["id"]),
                experiment_id=str(session.get("experiment_id") or ""),
                project_id=str(session.get("project_id") or project_id),
                target_type=str(session.get("target_type") or "experiment"),
                target_id=str(
                    session.get("target_id") or session.get("experiment_id") or ""
                ),
                source_sha=str(session.get("source_sha") or ""),
                instruction=_optional_text(
                    session.get("instruction") or session.get("prompt")
                ),
                kind=str(session.get("kind") or result.get("kind") or "experiment"),
                review_request_id=_optional_text(
                    session.get("review_request_id") or result.get("review_request_id")
                ),
                attempt_index=int(session.get("attempt_index") or 0),
                assignment=(
                    dict(session.get("assignment") or {})
                    if isinstance(session.get("assignment"), dict)
                    else None
                ),
            )
        except KeyError as exc:
            raise RunnerError(
                f"malformed claim response: missing {exc.args[0]}"
            ) from exc

    def attach(
        self,
        *,
        session_id: str,
        runner_id: str,
        host_session_ref: str,
        workspace_ref: str = "",
        base_sha: str = "",
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        agent_setup: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> None:
        self._post(
            f"/api/agent-sessions/{session_id}/attach",
            {
                "runner_id": runner_id,
                "host_session_ref": host_session_ref,
                "workspace_ref": workspace_ref,
                "base_sha": base_sha,
                "head_sha": head_sha,
                "workspace_stats": dict(workspace_stats or {}),
                "agent_setup": dict(agent_setup or {}),
                "telemetry": dict(telemetry or {}),
            },
        )

    def release(
        self,
        *,
        session_id: str,
        runner_id: str,
        reason: str,
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> None:
        self._post(
            f"/api/agent-sessions/{session_id}/release",
            {
                "runner_id": runner_id,
                "reason": reason,
                "head_sha": head_sha,
                "workspace_stats": dict(workspace_stats or {}),
                "telemetry": dict(telemetry or {}),
            },
        )

    def heartbeat(
        self,
        *,
        session_id: str,
        runner_id: str,
        head_sha: str = "",
        workspace_stats: Mapping[str, Any] | None = None,
        telemetry: Mapping[str, Any] | None = None,
    ) -> None:
        self._post(
            f"/api/agent-sessions/{session_id}/heartbeat",
            {
                "runner_id": runner_id,
                "head_sha": head_sha,
                "workspace_stats": dict(workspace_stats or {}),
                "telemetry": dict(telemetry or {}),
            },
        )

    def prepare_advance(
        self, *, project_id: str, reflection_id: str, runner_id: str
    ) -> dict[str, Any] | None:
        result = self._post(
            f"/api/projects/{project_id}/consolidation/prepare",
            {
                "reflection_id": reflection_id,
                "runner_id": runner_id,
            },
            allow_empty=True,
        )
        if result is None:
            return None
        advance = result.get("advance")
        return advance if isinstance(advance, dict) else None

    def pending_advance(self, *, project_id: str) -> dict[str, Any] | None:
        result = self._get(f"/api/projects/{project_id}/consolidation/pending")
        pending = result.get("pending")
        return pending if isinstance(pending, dict) else None

    def settle_advance(
        self,
        *,
        project_id: str,
        advance_id: str,
        runner_id: str,
        observed_sha: str,
        proposal_parents: Sequence[str],
        diffstat: Mapping[str, Any],
        ancestry: Mapping[str, bool],
        error: str = "",
    ) -> None:
        self._post(
            f"/api/projects/{project_id}/consolidation/settle",
            {
                "advance_id": advance_id,
                "runner_id": runner_id,
                "observed_sha": observed_sha,
                "proposal_parents": list(proposal_parents),
                "diffstat": dict(diffstat),
                "ancestry": dict(ancestry),
                "error": error,
            },
        )

    def list(self, *, project_id: str) -> list[dict[str, Any]]:
        result = self._get(f"/api/projects/{project_id}/agent-sessions")
        sessions = result.get("sessions")
        if not isinstance(sessions, list) or not all(
            isinstance(item, dict) for item in sessions
        ):
            raise RunnerError("malformed agent session list")
        return sessions

    def heartbeat_runner(
        self,
        *,
        project_id: str,
        runner_id: str,
        machine: Mapping[str, Any],
        platforms: Sequence[Mapping[str, Any]],
        capacity: int,
    ) -> None:
        self._post(
            f"/api/projects/{project_id}/agent-runners/heartbeat",
            {
                "runner_id": runner_id,
                "machine": dict(machine),
                "platforms": [dict(item) for item in platforms],
                "capacity": max(int(capacity), 0),
            },
        )

    def _get(self, path: str) -> dict[str, Any]:
        return self._request(path, method="GET", payload=None) or {}

    def _post(
        self,
        path: str,
        payload: Mapping[str, Any],
        *,
        allow_empty: bool = False,
    ) -> dict[str, Any] | None:
        return self._request(
            path,
            method="POST",
            payload=payload,
            allow_empty=allow_empty,
        )

    def _request(
        self,
        path: str,
        *,
        method: str,
        payload: Mapping[str, Any] | None,
        allow_empty: bool = False,
    ) -> dict[str, Any] | None:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.runner_key:
            headers["Authorization"] = f"Bearer {self.runner_key}"
        request = urllib.request.Request(
            f"{self.control_url}{path}",
            data=(
                json.dumps(dict(payload)).encode("utf-8")
                if payload is not None
                else None
            ),
            method=method,
            headers=headers,
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if allow_empty and exc.code in {204, 404, 409}:
                return None
            raise RunnerError(f"Merv returned HTTP {exc.code} for {path}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RunnerError(f"could not reach Merv at {self.control_url}") from exc
        if not body.strip():
            return None if allow_empty else {}
        try:
            result = json.loads(body)
        except ValueError as exc:
            raise RunnerError(f"Merv returned malformed JSON for {path}") from exc
        if not isinstance(result, dict):
            raise RunnerError(f"Merv returned a non-object for {path}")
        return result


class AgentRunner:
    """Claim available slots and reconcile their local processes."""

    def __init__(
        self,
        *,
        project_id: str,
        platforms: Sequence[Platform],
        client: AgentSessionsClient,
        ledger: SessionLedger,
        workspaces: WorkspaceManager,
        trace_dir: Path,
        runner_secret: bytes,
        environment: Mapping[str, str] | None = None,
    ):
        self.project_id = project_id
        self.platforms = tuple(platforms)
        self.client = client
        self.ledger = ledger
        self.workspaces = workspaces
        self.trace_dir = trace_dir
        if len(runner_secret) < 32:
            raise RunnerError("runner secret is missing or too short")
        self.runner_secret = runner_secret
        self.environment = environment if environment is not None else os.environ
        self._idle_reason = ""

    def reconcile(self) -> None:
        remote = {
            str(item.get("id")): item
            for item in self.client.list(project_id=self.project_id)
            if item.get("id")
        }
        for session in self.ledger.sessions.values():
            if session.status not in {"launching", "running", "uncertain"}:
                continue
            try:
                self._reconcile_session(
                    session=session,
                    remote_session=remote.get(session.session_id) or {},
                )
            except Exception as exc:  # noqa: BLE001 -- one worker cannot stop peers
                session.status = "uncertain"
                print(
                    f"{session.session_id}: reconciliation failed: {exc}",
                    file=sys.stderr,
                )
        self.ledger.save()

    def report_presence(self) -> None:
        self.client.heartbeat_runner(
            project_id=self.project_id,
            runner_id=self.ledger.runner_id,
            machine={
                "hostname": socket.gethostname(),
                "system": platform.system(),
                "architecture": platform.machine(),
            },
            platforms=[
                {
                    "name": configured.name,
                    "harness": configured.adapter,
                    "model": configured.model or "",
                    "effort": configured.effort or "",
                    "parallelism": configured.parallelism,
                }
                for configured in self.platforms
            ],
            capacity=sum(configured.parallelism for configured in self.platforms),
        )

    def _reconcile_session(
        self,
        *,
        session: LocalSession,
        remote_session: Mapping[str, Any],
    ) -> None:
        remote_status = str(remote_session.get("status") or "")
        host_session = session.host_session()
        if host_session is None:
            if remote_status and remote_status not in {"offered", "active"}:
                session.status = remote_status
                return
            # Spawn may have crossed the process boundary before the runner
            # could persist its PID. Do not release and risk a duplicate child;
            # the offer lease closes naturally when no process authenticates.
            session.status = "uncertain"
            return
        adapter = session.adapter or self._platform(session.platform).adapter
        host = HOSTS[adapter]
        if remote_status and remote_status not in {"offered", "active"}:
            host.stop(host_session)
            self._finalize_trace(session=session, host=host)
            telemetry = self._observe_telemetry(session)
            workspace = self._capture_after_stop(session)
            self.client.release(
                session_id=session.session_id,
                runner_id=self.ledger.runner_id,
                reason=f"remote_{remote_status}",
                head_sha=workspace.head_sha if workspace else "",
                workspace_stats=workspace.stats if workspace else None,
                telemetry=telemetry,
            )
            if workspace is not None:
                self.workspaces.close(workspace)
            session.status = remote_status
            return

        state = host.inspect(host_session)
        if state == "stopped":
            self._finalize_trace(session=session, host=host)
            telemetry = self._observe_telemetry(session)
            workspace = self._capture_after_stop(session)
            reason = (
                "host_process_crash_loop"
                if self._is_repeated_rapid_stop(session)
                else "host_process_stopped"
            )
            self.client.release(
                session_id=session.session_id,
                runner_id=self.ledger.runner_id,
                reason=reason,
                head_sha=workspace.head_sha if workspace else "",
                workspace_stats=workspace.stats if workspace else None,
                telemetry=telemetry,
            )
            if workspace is not None:
                self.workspaces.close(workspace)
            session.status = "stopped"
            return
        if state != "running" or not remote_status:
            session.status = "uncertain"
            return

        session.status = "running"
        telemetry = self._observe_telemetry(session)
        workspace = self._observe_workspace(session)
        if remote_session.get("host_session_ref") == host_session.ref:
            session.attached = True
        if not session.attached:
            self.client.attach(
                session_id=session.session_id,
                runner_id=self.ledger.runner_id,
                host_session_ref=host_session.ref,
                workspace_ref=session.branch or "",
                base_sha=session.base_sha,
                head_sha=session.head_sha,
                workspace_stats=session.workspace_stats,
                agent_setup=self._agent_setup(session),
                telemetry=telemetry,
            )
            session.attached = True
        if remote_status == "active":
            self.client.heartbeat(
                session_id=session.session_id,
                runner_id=self.ledger.runner_id,
                head_sha=workspace.head_sha if workspace else "",
                workspace_stats=workspace.stats if workspace else None,
                telemetry=telemetry,
            )

    def _is_repeated_rapid_stop(self, session: LocalSession) -> bool:
        """Throttle a broken CLI without delaying an ordinary completed turn."""
        now = time.time()
        if (
            session.started_at is None
            or now - session.started_at >= RAPID_STOP_SECONDS
            or session.head_sha != session.base_sha
        ):
            return False
        cutoff = now - CRASH_LOOP_WINDOW_SECONDS
        return any(
            previous.session_id != session.session_id
            and previous.platform == session.platform
            and previous.kind == session.kind
            and previous.target_id == session.target_id
            and previous.status == "stopped"
            and previous.started_at is not None
            and previous.started_at >= cutoff
            and previous.head_sha == previous.base_sha
            for previous in self.ledger.sessions.values()
        )

    def advance_ready(self) -> bool:
        """Advance one independently reviewed consolidation, if one is ready."""
        pending = self.client.pending_advance(project_id=self.project_id)
        if pending is None:
            return False
        reflection_id = str(pending.get("reflection_id") or "")
        if not reflection_id:
            raise RunnerError("pending consolidation has no reflection id")
        if str(pending.get("advance_status") or "") == "bound":
            # The central ref already moved; a prior settle bound the receipt
            # but its publish was blocked. No Git work remains — retry the
            # settle so the brain can complete the publish.
            self.client.settle_advance(
                project_id=self.project_id,
                advance_id=str(pending.get("advance_id") or ""),
                runner_id=self.ledger.runner_id,
                observed_sha=str(pending.get("observed_sha") or ""),
                proposal_parents=[],
                diffstat={},
                ancestry={},
            )
            return True
        advance = self.client.prepare_advance(
            project_id=self.project_id,
            reflection_id=reflection_id,
            runner_id=self.ledger.runner_id,
        )
        if advance is None:
            return False
        expected_sha = str(advance.get("expected_sha") or "")
        target_sha = str(advance.get("target_sha") or "")
        try:
            receipt = self.workspaces.advance(
                expected_sha=expected_sha,
                target_sha=target_sha,
                sources=(
                    advance.get("sources")
                    if isinstance(advance.get("sources"), list)
                    else []
                ),
            )
        except RunnerError as exc:
            receipt = {
                "observed_sha": self.workspaces.central_sha(),
                "proposal_parents": [],
                "diffstat": {},
                "ancestry": {},
                "error": str(exc),
            }
        self.client.settle_advance(
            project_id=self.project_id,
            advance_id=str(advance.get("id") or ""),
            runner_id=self.ledger.runner_id,
            observed_sha=str(receipt["observed_sha"]),
            proposal_parents=receipt.get("proposal_parents") or [],
            diffstat=receipt.get("diffstat") or {},
            ancestry=receipt.get("ancestry") or {},
            error=str(receipt.get("error") or ""),
        )
        return not receipt.get("error")

    def _observe_workspace(self, session: LocalSession) -> Workspace | None:
        if not session.cwd:
            return None
        workspace = self.workspaces.observe(
            path=Path(session.cwd),
            branch=session.branch,
            base_sha=session.base_sha,
            kind=session.kind,
        )
        self._remember_workspace(session, workspace)
        return workspace

    def _capture_workspace(self, session: LocalSession) -> Workspace | None:
        if not session.cwd:
            return None
        workspace = self.workspaces.capture(
            path=Path(session.cwd),
            branch=session.branch,
            base_sha=session.base_sha,
            session_id=session.session_id,
            kind=session.kind,
            writable=session.kind in {"experiment", "consolidation"},
        )
        self._remember_workspace(session, workspace)
        return workspace

    def _capture_after_stop(self, session: LocalSession) -> Workspace | None:
        try:
            return self._capture_workspace(session)
        except Exception as exc:  # noqa: BLE001 -- a failed capture must free the slot
            print(
                f"{session.session_id}: workspace capture failed; "
                f"files remain in {session.cwd}: {exc}",
                file=sys.stderr,
            )
            return None

    def _finalize_trace(self, *, session: LocalSession, host: AgentHost) -> None:
        if not session.trace_dir:
            return
        finalize = getattr(host, "finalize_trace", None)
        if not callable(finalize):
            return
        try:
            finalize(
                platform=self._platform(session.platform),
                trace_dir=Path(session.trace_dir),
            )
        except Exception as exc:  # noqa: BLE001 -- trace failure cannot wedge work
            message = f"trace finalization failed: {exc}"
            _append_private_text(Path(session.trace_dir) / "stderr.log", message + "\n")
            print(f"{session.session_id}: {message}", file=sys.stderr)

    @staticmethod
    def _remember_workspace(session: LocalSession, workspace: Workspace) -> None:
        session.base_sha = workspace.base_sha
        session.head_sha = workspace.head_sha
        session.workspace_stats = workspace.stats

    def fill_available_slots(self) -> int:
        launched = 0
        remaining = {
            platform.name: max(
                platform.parallelism - self.ledger.running_count(platform.name),
                0,
            )
            for platform in self.platforms
        }
        while any(remaining.values()):
            for platform in self.platforms:
                if remaining[platform.name] < 1:
                    continue
                remaining[platform.name] -= 1
                try:
                    if self._claim_and_launch(platform):
                        launched += 1
                    else:
                        remaining[platform.name] = 0
                except Exception as exc:  # noqa: BLE001 -- isolate bad platforms
                    print(
                        f"{platform.name}: launch cycle failed: {exc}",
                        file=sys.stderr,
                    )
                    remaining[platform.name] = 0
        return launched

    def _claim_and_launch(self, platform: Platform) -> bool:
        idempotency_key = self.ledger.claim_key(platform.name)
        session_key = _session_key(
            runner_secret=self.runner_secret,
            idempotency_key=idempotency_key,
        )
        claim = self.client.claim(
            project_id=self.project_id,
            platform=platform.name,
            runner_id=self.ledger.runner_id,
            idempotency_key=idempotency_key,
            session_key=session_key,
        )
        if claim is None:
            self.ledger.clear_claim(platform.name)
            self._note_idle(self.client.last_claim_reason)
            return False
        self._idle_reason = ""
        session = self.ledger.reserve(claim, platform)
        host = HOSTS[platform.adapter]
        workspace: Workspace | None = None
        try:
            if claim.kind == "review" and not claim.instruction:
                raise RunnerError(
                    "review assignment is missing its reviewer instruction"
                )
            instruction = claim.instruction or _default_instruction(claim)
            workspace = self.workspaces.prepare(claim)
            session.cwd = str(workspace.path)
            session.branch = workspace.branch
            self._remember_workspace(session, workspace)
            instruction += (
                "\nGit workspace: "
                f"{workspace.branch or 'detached'} at {workspace.head_sha}; "
                f"base {workspace.base_sha}.\n"
            )
            trace_files = _prepare_trace(
                root=self.trace_dir,
                claim=claim,
                platform=platform,
                host=host,
                instruction=instruction,
                workspace=workspace,
            )
            session.trace_dir = str(trace_files.directory)
            child_environment = _child_environment(
                self.environment,
                session_key=session_key,
                control_url=self.client.control_url,
                session_id=claim.session_id,
            )
            child_environment["MERV_AGENT_TRACE_DIR"] = str(trace_files.directory)
            self.ledger.save()
            host_session = host.spawn(
                platform=platform,
                instruction=instruction,
                child_env=child_environment,
                stdout_path=trace_files.stdout,
                stderr_path=trace_files.stderr,
                cwd=workspace.path,
            )
        except Exception:
            session.status = (
                "launch_failed" if session.cwd is not None else "workspace_failed"
            )
            self.ledger.save()
            self.client.release(
                session_id=claim.session_id,
                runner_id=self.ledger.runner_id,
                reason=session.status,
                telemetry=self._observe_telemetry(session),
            )
            if workspace is not None:
                self.workspaces.close(workspace)
            raise
        session.host_ref = host_session.ref
        session.pid = host_session.pid
        session.status = "running"
        session.started_at = time.time()
        self.ledger.save()
        self.client.attach(
            session_id=claim.session_id,
            runner_id=self.ledger.runner_id,
            host_session_ref=host_session.ref,
            workspace_ref=workspace.branch or "",
            base_sha=workspace.base_sha,
            head_sha=workspace.head_sha,
            workspace_stats=workspace.stats,
            agent_setup=self._agent_setup(session),
            telemetry=self._observe_telemetry(session),
        )
        session.attached = True
        self.ledger.save()
        print(
            f"started {platform.name} session {claim.session_id} "
            f"for {claim.target_type} {claim.target_id or claim.experiment_id}"
        )
        return True

    def _note_idle(self, reason: str) -> None:
        """Explain a silent poll once per change, not on every cycle."""
        if reason == self._idle_reason:
            return
        self._idle_reason = reason
        if reason == "agent_dispatch_disabled":
            print(
                f"{self.project_id}: automatic dispatch is off for this "
                "project; turn it on in project settings to claim work"
            )

    def _agent_setup(self, session: LocalSession) -> dict[str, Any]:
        platform = self._platform(session.platform)
        return {
            "platform": platform.name,
            "harness": platform.adapter,
            "model": platform.model or "",
            "effort": platform.effort or "",
            "machine": socket.gethostname(),
        }

    def _observe_telemetry(self, session: LocalSession) -> dict[str, Any]:
        if not session.trace_dir:
            return _public_telemetry(session.telemetry or {})
        platform = self._platform(session.platform)
        host = HOSTS[session.adapter or platform.adapter]
        filename = str(getattr(host, "trace_filename", "trace.jsonl") or "")
        if not filename:
            return _public_telemetry(session.telemetry or {})
        path = Path(session.trace_dir) / filename
        session.trace_offset, session.telemetry = _read_trace_telemetry(
            path=path,
            offset=session.trace_offset,
            state=session.telemetry,
            adapter=platform.adapter,
        )
        return _public_telemetry(session.telemetry)

    def _platform(self, name: str) -> Platform:
        for platform in self.platforms:
            if platform.name == name:
                return platform
        raise RunnerError(f"platform {name!r} is no longer configured")


def load_platforms(config_path: Path) -> tuple[Platform, ...]:
    """Enabled agent platforms from the machine client settings."""
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        document = {}
    configured = document.get("agent_platforms") if isinstance(document, dict) else {}
    if not isinstance(configured, dict):
        raise RunnerError("agent_platforms must be an object")
    platforms: list[Platform] = []
    for name, raw in configured.items():
        if not isinstance(raw, dict) or not raw.get("enabled", True):
            continue
        if str(name).lower() == "aider":
            raise RunnerError(
                "Aider is not supported for auto-run because it cannot emit a "
                "complete JSONL interaction trace"
            )
        adapter = str(raw.get("adapter") or name)
        if adapter not in HOSTS:
            raise RunnerError(
                f"{name}: adapter must be one of {', '.join(sorted(HOSTS))}"
            )
        command = raw.get("command") or [name]
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(item, str) and item for item in command)
        ):
            raise RunnerError(f"{name}: command must be a non-empty string array")
        parallelism = raw.get("parallelism", 1)
        if not isinstance(parallelism, int) or isinstance(parallelism, bool):
            raise RunnerError(f"{name}: parallelism must be an integer")
        if not 1 <= parallelism <= 32:
            raise RunnerError(f"{name}: parallelism must be between 1 and 32")
        platforms.append(
            Platform(
                name=str(name),
                adapter=adapter,
                command=tuple(command),
                enabled=True,
                model=_optional_text(raw.get("model")),
                effort=_optional_text(raw.get("effort")),
                parallelism=parallelism,
            )
        )
    return tuple(platforms)


def load_workspace_settings(
    config_path: Path, *, default_repository: Path | None = None
) -> WorkspaceSettings:
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        document = {}
    raw = document.get("agent_workspace") if isinstance(document, dict) else {}
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise RunnerError("agent_workspace must be an object")
    strategy = str(raw.get("strategy") or "git_worktree")
    if strategy != "git_worktree":
        raise RunnerError("agent workspaces must use persistent Git worktrees")
    repository = Path(
        str(raw.get("repository") or default_repository or Path.cwd())
    ).expanduser()
    root = Path(str(raw.get("root") or config_path.parent / "worktrees")).expanduser()
    return WorkspaceSettings(
        strategy=strategy,
        repository=repository,
        root=root,
        base_ref=str(raw.get("base_ref") or "HEAD"),
    )


def _child_environment(
    source: Mapping[str, str],
    *,
    session_key: str,
    control_url: str,
    session_id: str,
) -> dict[str, str]:
    """Explicit child environment with every parent Merv credential removed."""
    environment = {
        key: value
        for key, value in source.items()
        if not key.startswith("MERV_") and not key.startswith("RESEARCH_PLUGIN_")
    }
    environment.update(
        {
            AGENT_SESSION_KEY_ENV_VAR: session_key,
            "MERV_CONTROL_URL": control_url,
            "MERV_AGENT_SESSION_ID": session_id,
        }
    )
    standalone_bin = str(source.get("MERV_RUNNER_BIN_DIR") or "").strip()
    bundle_bin = (
        Path(standalone_bin).expanduser()
        if standalone_bin
        else Path(__file__).resolve().parents[3] / "bin"
    )
    if (bundle_bin / "merv-client").is_file():
        inherited_path = environment.get("PATH", "")
        environment["PATH"] = (
            str(bundle_bin)
            if not inherited_path
            else f"{bundle_bin}{os.pathsep}{inherited_path}"
        )
    return environment


def _prepare_trace(
    *,
    root: Path,
    claim: Claim,
    platform: Platform,
    host: AgentHost,
    instruction: str,
    workspace: Workspace,
) -> TraceFiles:
    """Create the private recording envelope for one claimed auto-run session."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    directory = root / _safe_name(claim.session_id)
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError as exc:
        raise RunnerError(
            f"trace directory already exists for session {claim.session_id}"
        ) from exc
    stdout_filename = str(getattr(host, "stdout_filename", "trace.jsonl"))
    trace_filename = getattr(host, "trace_filename", "trace.jsonl")
    command_for = getattr(host, "command_for", None)
    harness_command = (
        command_for(platform) if callable(command_for) else list(platform.command)
    )
    metadata = {
        "schema_version": 1,
        "merv_agent_session_id": claim.session_id,
        "assignment": dict(claim.assignment or {}),
        "work_item": {
            "project_id": claim.project_id,
            "experiment_id": claim.experiment_id,
            "kind": claim.kind,
            "target_type": claim.target_type,
            "target_id": claim.target_id,
            "attempt_index": claim.attempt_index,
            "review_request_id": claim.review_request_id,
            "source_sha": claim.source_sha,
            "instruction": instruction,
            "workspace": {
                "path": str(workspace.path),
                "branch": workspace.branch,
                "base_sha": workspace.base_sha,
                "head_sha": workspace.head_sha,
            },
        },
        "agent_setup": {
            "platform": platform.name,
            "harness": platform.adapter,
            "command": _sanitized_command(harness_command),
            "model": platform.model,
            "effort": platform.effort,
            "trace_format": str(getattr(host, "trace_format", "jsonl")),
            "trace_file": str(trace_filename) if trace_filename else None,
            "stdout_file": stdout_filename,
            "stderr_file": "stderr.log",
        },
    }
    _write_private_json(directory / "metadata.json", metadata)
    return TraceFiles(
        directory=directory,
        stdout=directory / stdout_filename,
        stderr=directory / "stderr.log",
    )


def _read_trace_telemetry(
    *,
    path: Path,
    offset: int,
    state: Mapping[str, Any] | None,
    adapter: str,
) -> tuple[int, dict[str, Any]]:
    """Incrementally normalize aggregate usage from an append-only JSONL trace."""
    current = dict(state or {})
    current.setdefault("reporting", "provider")
    current.setdefault("tool_calls", 0)
    current.setdefault("messages", 0)
    try:
        size = path.stat().st_size
    except OSError:
        return offset, current
    if size < offset:
        offset = 0
        current = {"reporting": "provider", "tool_calls": 0, "messages": 0}
    try:
        with path.open("rb") as source:
            source.seek(offset)
            raw = source.read()
    except OSError:
        return offset, current
    if not raw:
        return offset, current
    complete_at = raw.rfind(b"\n")
    if complete_at < 0:
        return offset, current
    complete = raw[: complete_at + 1]
    next_offset = offset + len(complete)
    for index, line in enumerate(complete.splitlines()):
        if not line.strip():
            continue
        try:
            event = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue
        if isinstance(event, dict):
            _apply_trace_event(
                state=current,
                event=event,
                adapter=adapter,
                fallback_id=f"{offset}:{index}",
            )
    return next_offset, current


def _apply_trace_event(
    *, state: dict[str, Any], event: Mapping[str, Any], adapter: str, fallback_id: str
) -> None:
    event_type = str(event.get("type") or "").lower()
    usage = _event_usage(event)
    if usage:
        final_usage = event_type in {
            "result",
            "turn.completed",
            "turn_completed",
            "session_end",
            "final",
        }
        usage_id = _event_identity(event) or fallback_id
        seen_usage = set(str(item) for item in state.get("_usage_ids") or [])
        if usage_id not in seen_usage:
            seen_usage.add(usage_id)
            state["_usage_ids"] = sorted(seen_usage)
            for name, amount in usage.items():
                if final_usage:
                    state[name] = max(int(state.get(name) or 0), amount)
                else:
                    state[name] = int(state.get(name) or 0) + amount
        if final_usage:
            state["final"] = True

    seen_tools = set(str(item) for item in state.get("_tool_ids") or [])
    for tool_id in _tool_call_ids(event, fallback_id=fallback_id):
        seen_tools.add(tool_id)
    state["_tool_ids"] = sorted(seen_tools)
    state["tool_calls"] = len(seen_tools)

    message_id = _assistant_message_id(event)
    if message_id:
        seen_messages = set(str(item) for item in state.get("_message_ids") or [])
        seen_messages.add(message_id)
        state["_message_ids"] = sorted(seen_messages)
        state["messages"] = len(seen_messages)

    provider_session = (
        event.get("session_id")
        or event.get("sessionID")
        or (
            event.get("session", {}).get("id")
            if isinstance(event.get("session"), dict)
            else ""
        )
    )
    if provider_session:
        state["provider_session"] = str(provider_session)[:240]
    timestamp = event.get("timestamp") or event.get("created_at")
    if timestamp:
        state["last_event_at"] = str(timestamp)[:240]
    if event_type in {"result", "turn.completed", "turn_completed", "session_end"}:
        state["final"] = True
    state["adapter"] = adapter


def _event_usage(event: Mapping[str, Any]) -> dict[str, int]:
    candidates: list[Mapping[str, Any]] = []
    for value in (event.get("usage"), event.get("stats"), event.get("tokens")):
        if isinstance(value, Mapping):
            candidates.append(value)
    message = event.get("message")
    if isinstance(message, Mapping) and isinstance(message.get("usage"), Mapping):
        candidates.append(message["usage"])
    part = event.get("part")
    if isinstance(part, Mapping):
        for value in (part.get("usage"), part.get("tokens")):
            if isinstance(value, Mapping):
                candidates.append(value)
    if not candidates:
        return {}
    source = candidates[0]

    def count(*names: str) -> int:
        for name in names:
            raw = source.get(name)
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                return max(int(raw), 0)
        return 0

    cache = source.get("cache") if isinstance(source.get("cache"), Mapping) else {}

    def cache_count(name: str) -> int:
        raw = cache.get(name)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            return max(int(raw), 0)
        return 0

    values = {
        "input_tokens": count("input_tokens", "input"),
        "output_tokens": count("output_tokens", "output"),
        "cached_tokens": max(
            count(
                "cached_input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "cached",
            ),
            cache_count("read") + cache_count("write"),
        ),
        "total_tokens": count("total_tokens", "total"),
    }
    if not values["total_tokens"]:
        values["total_tokens"] = values["input_tokens"] + values["output_tokens"]
    return {name: amount for name, amount in values.items() if amount}


def _event_identity(event: Mapping[str, Any]) -> str:
    message = event.get("message")
    return str(
        event.get("id")
        or event.get("event_id")
        or (message.get("id") if isinstance(message, Mapping) else "")
        or ""
    )


def _tool_call_ids(event: Mapping[str, Any], *, fallback_id: str) -> set[str]:
    found: set[str] = set()

    def visit(value: Any, path: str) -> None:
        if isinstance(value, Mapping):
            kind = str(value.get("type") or "").lower()
            item = value.get("item")
            if kind in {"tool_use", "tool_call", "function_call"}:
                identifier = (
                    value.get("id")
                    or value.get("tool_id")
                    or value.get("call_id")
                    or f"{fallback_id}:{path}"
                )
                found.add(str(identifier))
            elif kind in {"item.started", "item.completed"} and isinstance(
                item, Mapping
            ):
                item_type = str(item.get("type") or "").lower()
                if item_type in {
                    "command_execution",
                    "mcp_tool_call",
                    "function_call",
                    "web_search",
                }:
                    identifier = item.get("id") or item.get("call_id")
                    if identifier:
                        found.add(str(identifier))
            for key, child in value.items():
                if key not in {"output", "result"}:
                    visit(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]")

    visit(event, "event")
    return found


def _assistant_message_id(event: Mapping[str, Any]) -> str:
    event_type = str(event.get("type") or "").lower()
    role = str(event.get("role") or "").lower()
    message = event.get("message")
    if isinstance(message, Mapping):
        role = str(message.get("role") or role).lower()
    if role != "assistant" and event_type not in {"assistant", "agent_message"}:
        return ""
    return _event_identity(event) or str(event.get("timestamp") or "")


def _public_telemetry(state: Mapping[str, Any] | None) -> dict[str, Any]:
    current = dict(state or {})
    allowed = {
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "total_tokens",
        "tool_calls",
        "messages",
        "last_event_at",
        "provider_session",
        "reporting",
        "final",
    }
    return {name: current[name] for name in allowed if name in current}


def _sanitized_command(command: Sequence[str]) -> list[str]:
    """Keep harness configuration useful without persisting obvious secrets."""
    sensitive = re.compile(
        r"(?i)(?:api[-_]?key|token|secret|password|credential|authorization)"
    )
    result: list[str] = []
    redact_next = False
    for argument in command:
        if redact_next:
            result.append("<redacted>")
            redact_next = False
            continue
        if "=" in argument:
            name, _ = argument.split("=", 1)
            if sensitive.search(name):
                result.append(f"{name}=<redacted>")
                continue
        if sensitive.search(argument):
            result.append(argument if argument.startswith("-") else "<redacted>")
            redact_next = argument.startswith("-")
            continue
        result.append(argument)
    return result


def _write_private_json(path: Path, payload: Mapping[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(json.dumps(dict(payload), indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def _append_private_text(path: Path, value: str) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_APPEND | os.O_CREAT,
        0o600,
    )
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as output:
        output.write(value)


def _session_key(*, runner_secret: bytes, idempotency_key: str) -> str:
    """Re-create a claim credential after a lost response without storing it."""
    digest = hmac.new(
        runner_secret,
        f"merv-agent-session:{idempotency_key}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    encoded = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return SESSION_KEY_PREFIX + encoded


def _default_instruction(claim: Claim) -> str:
    return (
        "Own this Merv experiment until it reaches a terminal state.\n"
        f"Project: {claim.project_id}\n"
        f"Experiment: {claim.experiment_id}\n"
        "Use the research-workflow skill. Start with workflow.status_and_next, "
        "follow every gate, preserve evidence, and do not work on another "
        "experiment in this session. If native MCP is unavailable, call tools "
        "with `merv-client call TOOL --arguments JSON`.\n"
    )


def _process_marker(pid: int) -> str | None:
    """Stable-enough process birth marker; prevents killing a reused PID."""
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    started = result.stdout.strip()
    if result.returncode or not started:
        return None
    return hashlib.sha256(started.encode("utf-8")).hexdigest()[:16]


def _session_marker(session: HostSession) -> str | None:
    parts = session.ref.split(":")
    if len(parts) != 3 or parts[0] != "pid" or parts[1] != str(session.pid):
        return None
    return parts[2]


def _safe_control_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}:
        return url
    raise RunnerError(
        "control URL must use HTTPS, except for an explicit loopback host"
    )


def _is_loopback_url(raw: str) -> bool:
    return urlsplit(raw).hostname in {"127.0.0.1", "::1", "localhost"}


def _optional_text(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _has_option(command: Sequence[str], option: str) -> bool:
    return any(item == option or item.startswith(f"{option}=") for item in command)


def _safe_name(value: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value)).strip(".-")
    if not clean:
        raise RunnerError("workspace identifier is empty")
    return clean[:80]


def _runtime_paths(config_path: Path) -> tuple[Path, Path]:
    state_dir = config_path.parent
    return state_dir / "agent-sessions.json", state_dir / "agent-traces"


def _credential_path(config_path: Path) -> Path:
    return config_path.parent / "agent-runner.key"


def _stored_runner_key(config_path: Path) -> str | None:
    path = _credential_path(config_path)
    try:
        secret = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RunnerError(f"cannot read runner credential: {path}") from exc
    if not re.fullmatch(r"mk_[A-Za-z0-9_-]{43}", secret):
        raise RunnerError(f"runner credential is malformed: {path}")
    path.chmod(0o600)
    return secret


def _runner_key(config_path: Path) -> str | None:
    return dual_env_value(MCP_KEY_ENV_VAR) or _stored_runner_key(config_path)


def _has_runner_credential(config_path: Path) -> bool:
    if dual_env_value(MCP_KEY_ENV_VAR):
        return True
    try:
        return _stored_runner_key(config_path) is not None
    except RunnerError:
        return False


def _validate_settings(config_path: Path) -> None:
    load_platforms(config_path)
    load_workspace_settings(config_path)


# Default executable per native adapter, for Settings-side detection of which
# agents this machine can actually launch. The command adapter has no default.
DEFAULT_PLATFORM_EXECUTABLES: dict[str, str] = {
    "codex": "codex",
    "claude": "claude",
    "gemini": "gemini",
    "cursor": "cursor-agent",
    "opencode": "opencode",
    "copilot": "copilot",
    "qwen": "qwen",
    "hermes": "hermes",
}


def _detected_commands(config_path: Path) -> dict[str, bool]:
    """Which agent executables resolve on this machine's PATH.

    Covers every adapter default plus the first argument of each configured
    platform command, so custom executables are probed too.
    """
    names = set(DEFAULT_PLATFORM_EXECUTABLES.values())
    try:
        document = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        document = {}
    configured = document.get("agent_platforms") if isinstance(document, dict) else {}
    if isinstance(configured, dict):
        for raw in configured.values():
            command = raw.get("command") if isinstance(raw, dict) else None
            if isinstance(command, list) and command and isinstance(command[0], str):
                names.add(command[0])
    return {
        name: shutil.which(name) is not None for name in sorted(names) if name.strip()
    }


def _local_status(
    *,
    project_id: str | None,
    runner_active: bool,
    ledger: SessionLedger | None,
    config_path: Path | None = None,
) -> dict[str, Any]:
    sessions = []
    if ledger is not None:
        sessions = [
            {
                "id": item.session_id,
                "project_id": item.project_id,
                "experiment_id": item.experiment_id,
                "platform": item.platform,
                "status": item.status,
                "kind": item.kind,
                "review_request_id": item.review_request_id,
                "pid": item.pid,
                "cwd": item.cwd,
                "branch": item.branch,
            }
            for item in ledger.sessions.values()
        ]
    status: dict[str, Any] = {
        "runner_active": runner_active,
        "project_id": project_id,
        "machine": {
            "hostname": socket.gethostname(),
            "system": platform.system(),
            "release": platform.release(),
            "architecture": platform.machine(),
            "runner_id": ledger.runner_id if ledger is not None else None,
        },
        "sessions": sessions,
    }
    if config_path is not None:
        status["available_commands"] = _detected_commands(config_path)
        status["credential_configured"] = _has_runner_credential(config_path)
        status["credential_required"] = not _is_loopback_url(
            resolve_client_control_url(config_path=config_path)
        )
    return status


def _run_runner(
    runner: AgentRunner,
    *,
    once: bool,
    poll_seconds: float,
) -> None:
    """Keep a daemon alive across transient control-plane failures."""
    interval = max(poll_seconds, 1.0)
    failures = 0
    while True:
        try:
            runner.report_presence()
            runner.reconcile()
            runner.advance_ready()
            runner.fill_available_slots()
        except RunnerError as exc:
            if once:
                raise
            failures += 1
            delay = min(
                interval * (2 ** min(failures - 1, 5)),
                max(interval, 60.0),
            )
            print(
                f"runner cycle failed; retrying in {delay:g}s: {exc}",
                file=sys.stderr,
            )
        else:
            if once:
                return
            failures = 0
            delay = interval
        time.sleep(delay)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="merv-agent-runner",
        description="Run Merv experiments in configured local coding agents.",
    )
    parser.add_argument("--project", help="Merv project id")
    parser.add_argument("--config", help="Machine client settings path")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Reconcile and fill available slots once, then exit.",
    )
    parser.add_argument(
        "--settings-only",
        action="store_true",
        help="Serve the paired loopback settings API without dispatching.",
    )
    parser.add_argument(
        "--settings-port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Loopback settings port (default: {DEFAULT_PORT}).",
    )
    parser.add_argument(
        "--no-local-control",
        action="store_true",
        help="Do not serve the loopback Settings integration.",
    )
    parser.add_argument(
        "--show-pairing-token",
        action="store_true",
        help="Print the private local Settings pairing token and exit.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=DEFAULT_POLL_SECONDS,
        help=f"Reconciliation interval (default: {DEFAULT_POLL_SECONDS:g}).",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config_path = (
            Path(args.config).expanduser().resolve()
            if args.config
            else resolve_client_config_path()
        )
        token_path = config_path.parent / "agent-control.token"
        token, _ = pairing_token(token_path)
        if args.show_pairing_token:
            print(token)
            return 0
        if args.settings_only:
            ledger_path, _ = _runtime_paths(config_path)
            settings_ledger = SessionLedger(ledger_path)
            handoff_projects: list[str] = []
            server_ref: dict[str, Any] = {}

            def start_runner(project_id: str) -> None:
                handoff_projects.append(project_id)
                server_ref["server"].shutdown()

            server = local_control(
                config_path=config_path,
                token=token,
                validate=_validate_settings,
                credential_path=_credential_path(config_path),
                status=lambda: _local_status(
                    project_id=None,
                    runner_active=False,
                    ledger=settings_ledger,
                    config_path=config_path,
                ),
                start=start_runner,
                port=args.settings_port,
            )
            server_ref["server"] = server
            print(f"local settings: http://127.0.0.1:{args.settings_port}")
            print(f"pairing token: {token}")
            try:
                server.serve_forever()
            finally:
                server.server_close()
            if not handoff_projects:
                return 0
            args.project = handoff_projects[0]
            args.settings_only = False
            print(f"starting runner for project: {args.project}")
        if not args.project:
            raise RunnerError("--project is required unless --settings-only is used")
        platforms = load_platforms(config_path)
        if not platforms:
            raise RunnerError(
                "no enabled agent platforms; configure one with merv-client agent"
            )
        control_url = resolve_client_control_url(config_path=config_path)
        runner_key = _runner_key(config_path)
        if not runner_key and not _is_loopback_url(control_url):
            raise RunnerError(f"{MCP_KEY_ENV_VAR} is required")
        ledger_path, trace_dir = _runtime_paths(config_path)
        ledger = SessionLedger(ledger_path)
        runner_secret, _ = private_token(config_path.parent / "agent-runner.secret")
        workspace_settings = load_workspace_settings(config_path)
        runner = AgentRunner(
            project_id=args.project,
            platforms=platforms,
            client=AgentSessionsClient(
                control_url=control_url,
                runner_key=runner_key,
            ),
            ledger=ledger,
            workspaces=WorkspaceManager(workspace_settings),
            trace_dir=trace_dir,
            runner_secret=runner_secret.encode("utf-8"),
        )
        lock = RunnerLock(config_path.parent / "agent-runner.lock")
        server = None
        try:
            if not args.no_local_control:
                server = local_control(
                    config_path=config_path,
                    token=token,
                    validate=_validate_settings,
                    credential_path=_credential_path(config_path),
                    status=lambda: _local_status(
                        project_id=args.project,
                        runner_active=True,
                        ledger=ledger,
                        config_path=config_path,
                    ),
                    port=args.settings_port,
                )
                start_in_background(server)
                print(f"local settings: http://127.0.0.1:{args.settings_port}")
            _run_runner(
                runner,
                once=args.once,
                poll_seconds=args.poll_seconds,
            )
            return 0
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            lock.close()
    except (RunnerError, LocalControlError) as exc:
        print(f"merv-agent-runner: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
