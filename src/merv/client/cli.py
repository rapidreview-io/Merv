"""Onboarding CLI for the universal HTTP MCP endpoint."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from merv.shared.client_config import (
    AGENT_SESSION_KEY_ENV_VAR,
    HOSTED_CONTROL_URL,
    LOCAL_BRAIN_URL,
    resolve_client_config_path,
    resolve_client_control_url,
)
from .storage_upload import StorageUploadError, upload_storage_file

# The context window's agent_id (from agent.hello), for `merv call` from a
# shell that cannot carry it any other way.
AGENT_ID_ENV_VAR = "MERV_AGENT_ID"


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except ClientError as exc:
        print(f"merv-client: {exc}", file=sys.stderr)
        return 2


class ClientError(Exception):
    pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="merv-client",
        description="Configure Merv, MCP clients, and local coding agents.",
    )
    parser.add_argument(
        "--config",
        help=(
            "Machine client config path (default: ~/.merv/client.json, or the "
            "legacy ~/.research_plugin/client.json when that dir exists)."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    configure = sub.add_parser(
        "configure",
        help="Save the Merv server URL for this machine.",
    )
    _add_control_url_arg(configure)
    configure.set_defaults(func=_cmd_configure)

    env = sub.add_parser(
        "env",
        help="Print the .mcp.json HTTP server snippet.",
    )
    env.set_defaults(func=_cmd_env)

    call = sub.add_parser(
        "call",
        help="Call one Merv tool (useful for agents without native MCP support).",
    )
    call.add_argument("tool", help="Public Merv tool name.")
    call.add_argument(
        "--arguments",
        default="{}",
        help="Tool arguments as one JSON object.",
    )
    call.add_argument(
        "--agent-id",
        default=None,
        help=(
            "This context window's agent_id from agent.hello (defaults to "
            f"${AGENT_ID_ENV_VAR}); required by every tool but agent.hello."
        ),
    )
    call.set_defaults(func=_cmd_call)

    agent = sub.add_parser(
        "agent",
        help="Add or update one local coding-agent platform.",
    )
    agent.add_argument(
        "platform",
        help=(
            "Local platform name: codex, claude, gemini, cursor, opencode, "
            "copilot, qwen, hermes, or a custom name"
        ),
    )
    agent.add_argument(
        "--adapter",
        choices=(
            "codex",
            "claude",
            "gemini",
            "cursor",
            "opencode",
            "copilot",
            "qwen",
            "hermes",
            "command",
        ),
        help="Native invocation adapter; custom platforms use command.",
    )
    enabled = agent.add_mutually_exclusive_group()
    enabled.add_argument("--enable", dest="enabled", action="store_true")
    enabled.add_argument("--disable", dest="enabled", action="store_false")
    agent.set_defaults(enabled=None)
    agent.add_argument(
        "--command",
        help="Executable and optional base arguments (parsed as argv, never a shell).",
    )
    agent.add_argument("--model", help="Model passed to a native adapter.")
    agent.add_argument("--effort", help="Reasoning effort passed to a native adapter.")
    agent.add_argument("--parallelism", type=int, help="Maximum simultaneous sessions.")
    agent.set_defaults(func=_cmd_agent)

    agents = sub.add_parser(
        "agents",
        help="Print configured local coding-agent platforms.",
    )
    agents.set_defaults(func=_cmd_agents)

    workspace = sub.add_parser(
        "workspace",
        help="Configure isolated workspaces for local agent sessions.",
    )
    workspace.add_argument(
        "--strategy",
        choices=("git_worktree",),
        default="git_worktree",
    )
    workspace.add_argument(
        "--repository",
        required=True,
        help="Source Git repository used to initialize Merv's central ref.",
    )
    workspace.add_argument(
        "--root",
        help="Parent directory for per-session git worktrees.",
    )
    workspace.add_argument(
        "--base-ref",
        default="HEAD",
        help="Commit-ish frozen when the runner starts (default: HEAD).",
    )
    workspace.set_defaults(func=_cmd_workspace)

    storage_upload = sub.add_parser(
        "storage-upload",
        help="Stream a token-backed multipart Object Storage upload.",
    )
    storage_upload.add_argument("--path", required=True)
    storage_upload.add_argument("--target-url", required=True)
    storage_upload.add_argument("--workers", type=int, default=4)
    storage_upload.set_defaults(func=_cmd_storage_upload)

    harness = sub.add_parser(
        "harness",
        help=(
            "Install the Merv skills for auto-run children and report whether "
            "each configured agent harness is ready to reach Merv."
        ),
    )
    harness.add_argument("--json", action="store_true", help="Machine-readable report.")
    harness.set_defaults(func=_cmd_harness)
    return parser


def _add_control_url_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--control-url",
        default=HOSTED_CONTROL_URL,
        help=(
            f"Merv server URL (default: {HOSTED_CONTROL_URL}; use "
            f"{LOCAL_BRAIN_URL} for a local deployment)."
        ),
    )


def _cmd_configure(args: argparse.Namespace) -> int:
    config_path = _config_path(args)
    config = configure_client(
        config_path=config_path,
        control_url=args.control_url,
    )
    print(f"configured machine client: {config_path}")
    print(f"control_url={config['control_url']}")
    return 0


def _cmd_env(args: argparse.Namespace) -> int:
    control_url = resolve_client_control_url(config_path=_config_path(args))
    snippet = {
        "mcpServers": {
            "merv": {
                "type": "http",
                "url": f"{control_url}/mcp",
                "headers": {
                    "Authorization": "Bearer ${MERV_MCP_KEY}",
                },
            },
        },
    }
    print(json.dumps(snippet, indent=2))
    return 0


def _cmd_call(args: argparse.Namespace) -> int:
    try:
        arguments = json.loads(args.arguments)
    except ValueError as exc:
        raise ClientError("--arguments must be valid JSON") from exc
    if not isinstance(arguments, dict):
        raise ClientError("--arguments must be a JSON object")
    # The agent_id rides as an ordinary argument; the brain lifts it out.
    agent_id = args.agent_id or os.environ.get(AGENT_ID_ENV_VAR) or ""
    if agent_id and args.tool != "agent.hello":
        arguments.setdefault("agent_id", agent_id)
    secret = (
        os.environ.get(AGENT_SESSION_KEY_ENV_VAR)
        or os.environ.get("MERV_MCP_KEY")
        or os.environ.get("RESEARCH_PLUGIN_MCP_KEY")
    )
    if not secret:
        raise ClientError(
            f"{AGENT_SESSION_KEY_ENV_VAR} or MERV_MCP_KEY is required"
        )
    control_url = resolve_client_control_url(config_path=_config_path(args))
    parsed = urlsplit(control_url)
    if not (
        parsed.scheme == "https"
        or (
            parsed.scheme == "http"
            and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
        )
    ):
        raise ClientError(
            "control URL must use HTTPS, except for an explicit loopback host"
        )
    request = urllib.request.Request(
        f"{control_url.rstrip('/')}/mcp/call",
        data=json.dumps(
            {"name": args.tool, "arguments": arguments}
        ).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ClientError(
            f"Merv returned HTTP {exc.code}: {detail[:500]}"
        ) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ClientError("Merv tool call failed") from exc
    if not isinstance(body, dict) or "result" not in body:
        raise ClientError("Merv returned a malformed tool response")
    print(json.dumps(body["result"], indent=2))
    return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _cmd_agent(args: argparse.Namespace) -> int:
    command = tuple(shlex.split(args.command)) if args.command is not None else None
    config = configure_agent(
        config_path=_config_path(args),
        platform=args.platform,
        adapter=args.adapter,
        enabled=args.enabled,
        command=command,
        model=args.model,
        effort=args.effort,
        parallelism=args.parallelism,
    )
    print(json.dumps(config["agent_platforms"][args.platform], indent=2))
    return 0


def _cmd_agents(args: argparse.Namespace) -> int:
    config = _read_config(_config_path(args))
    platforms = config.get("agent_platforms")
    print(json.dumps(platforms if isinstance(platforms, dict) else {}, indent=2))
    return 0


def _cmd_workspace(args: argparse.Namespace) -> int:
    config = configure_workspace(
        config_path=_config_path(args),
        strategy=args.strategy,
        repository=args.repository,
        root=args.root,
        base_ref=args.base_ref,
    )
    print(json.dumps(config["agent_workspace"], indent=2))
    return 0


def _cmd_harness(args: argparse.Namespace) -> int:
    """Setup-time check: skills installed, executables answer, routes known.

    Exit status is non-zero when any enabled platform is not ready, so an
    installer or wizard can gate on it. No model is called.
    """
    # Lazy: the runner module is heavy and this command must stay cheap.
    from . import harness as kit
    from .agent_runner import _runtime_paths, load_platforms

    config_path = _config_path(args)
    _, trace_dir = _runtime_paths(config_path)
    error = ""
    install = None
    try:
        install = kit.install_skills(trace_dir.parent)
    except kit.HarnessError as exc:
        error = str(exc)
    platforms = load_platforms(config_path, include_disabled=True)
    report = kit.readiness(platforms=platforms, install=install)
    if error:
        report["error"] = error
    ready = not error and all(
        entry["ok"] for entry in report["platforms"].values() if entry["enabled"]
    )
    if args.json:
        print(json.dumps(report, indent=2))
        return 0 if ready else 1
    skills = report["skills"]
    if install is not None:
        print(f"skills: {skills['count']} installed at {skills['root']}")
    else:
        print(f"skills: NOT installed ({error})")
    if not report["platforms"]:
        print("platforms: none configured (merv-client agent <name> --enable)")
    for name, entry in report["platforms"].items():
        state = "ready" if entry["ok"] else "NOT ready"
        if not entry["enabled"]:
            state += " (disabled)"
        detail = entry["version"] or entry["executable"] or "no executable"
        print(
            f"{name}: {state}; {detail}; Merv tools via {entry['merv_mcp']}; "
            f"skills {entry['skills']}"
        )
        for problem in entry.get("problems", ()):
            print(f"  - {problem}")
    return 0 if ready else 1


def _cmd_storage_upload(args: argparse.Namespace) -> int:
    if not 1 <= int(args.workers) <= 16:
        raise ClientError("--workers must be between 1 and 16")
    try:
        result = upload_storage_file(
            path=Path(args.path),
            target_url=str(args.target_url),
            workers=int(args.workers),
        )
    except StorageUploadError as exc:
        raise ClientError(str(exc)) from exc
    print(json.dumps(result, indent=2))
    return 0


def configure_client(*, config_path: Path, control_url: str) -> dict[str, Any]:
    normalized = (control_url or HOSTED_CONTROL_URL).strip().rstrip("/")
    if not normalized:
        raise ClientError("control_url is required")
    config = _read_config(config_path)
    config["control_url"] = normalized
    _write_json_private(config_path, config)
    return config


def configure_agent(
    *,
    config_path: Path,
    platform: str,
    adapter: str | None = None,
    enabled: bool | None = None,
    command: Sequence[str] | None = None,
    model: str | None = None,
    effort: str | None = None,
    parallelism: int | None = None,
) -> dict[str, Any]:
    name = platform.strip()
    if not name:
        raise ClientError("platform is required")
    if name.lower() == "aider":
        raise ClientError(
            "Aider is not supported for auto-run because it cannot emit a "
            "complete JSONL interaction trace"
        )
    if parallelism is not None and not 1 <= parallelism <= 32:
        raise ClientError("parallelism must be between 1 and 32")
    if command is not None and (not command or not all(str(item) for item in command)):
        raise ClientError("command must not be empty")

    config = _read_config(config_path)
    platforms = config.get("agent_platforms")
    if not isinstance(platforms, dict):
        platforms = {}
        config["agent_platforms"] = platforms
    current = platforms.get(name)
    settings = dict(current) if isinstance(current, dict) else {}
    settings.setdefault(
        "adapter",
        adapter
        or (
            name
            if name
            in {
                "codex",
                "claude",
                "gemini",
                "cursor",
                "opencode",
                "copilot",
                "qwen",
                "hermes",
            }
            else "command"
        ),
    )
    settings.setdefault("enabled", True if enabled is None else enabled)
    settings.setdefault("command", [name])
    settings.setdefault("parallelism", 1)
    if adapter is not None:
        settings["adapter"] = adapter
    if enabled is not None:
        settings["enabled"] = enabled
    if command is not None:
        settings["command"] = [str(item) for item in command]
    if model is not None:
        settings["model"] = model.strip() or None
    if effort is not None:
        settings["effort"] = effort.strip() or None
    if parallelism is not None:
        settings["parallelism"] = parallelism
    platforms[name] = settings
    _write_json_private(config_path, config)
    return config


def configure_workspace(
    *,
    config_path: Path,
    strategy: str,
    repository: str,
    root: str | None = None,
    base_ref: str = "HEAD",
) -> dict[str, Any]:
    if strategy != "git_worktree":
        raise ClientError("agent workspaces must use persistent Git worktrees")
    repo_path = str(Path(repository).expanduser().resolve())
    settings: dict[str, Any] = {
        "strategy": strategy,
        "repository": repo_path,
    }
    settings["root"] = str(
        Path(root).expanduser().resolve()
        if root
        else (config_path.parent / "worktrees").resolve()
    )
    settings["base_ref"] = (base_ref or "HEAD").strip()
    config = _read_config(config_path)
    config["agent_workspace"] = settings
    _write_json_private(config_path, config)
    return config


def _config_path(args: argparse.Namespace) -> Path:
    if getattr(args, "config", None):
        return Path(args.config).expanduser().resolve()
    return resolve_client_config_path()


def _read_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return dict(value) if isinstance(value, dict) else {}


def _write_json_private(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(payload), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


if __name__ == "__main__":
    raise SystemExit(main())
