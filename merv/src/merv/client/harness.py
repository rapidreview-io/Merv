"""Make each local coding-agent harness ready for Merv before it launches.

An interactive user gets Merv through the plugin: it installs the skills the
brain's instructions name and registers the Merv MCP server. Auto-run children
never see that plugin. The runner deliberately launches Codex with
``--ignore-user-config`` and Claude with ``--strict-mcp-config`` so no owner
credential leaks into a session-scoped process, which also drops every plugin
skill; and the runner is installed independently of any plugin at all. So the
runner must carry the skills itself, mount them where each harness discovers
skills natively, tell every child where they live, and be able to say whether
a configured harness can actually see Merv.

Nothing here knows about sessions or claims. It is stdlib-only because it
ships inside the standalone runner archive.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any


SKILLS_DIRNAME = "skills"
MANIFEST_NAME = ".manifest.json"
EXCLUDE_BEGIN = "# >>> merv skills (managed by merv-agent-runner; do not edit)"
EXCLUDE_END = "# <<< merv skills"
VERSION_TIMEOUT_SECONDS = 8.0

# Where each native harness discovers project skills relative to its working
# root. Adapters missing here get only the instruction note.
NATIVE_SKILL_MOUNTS: dict[str, str] = {
    "codex": ".agents/skills",
    "claude": ".claude/skills",
}

# Adapters whose child receives a native, session-scoped Merv MCP server. The
# rest reach Merv through ``merv-client call``.
NATIVE_MCP_ADAPTERS = frozenset({"codex", "claude"})

# Provider sign-in is each harness's own business; Merv never holds it. What
# the runner can do is notice a sign-in *signal* — a credential file the CLI
# keeps or a provider variable in the runner's environment — and report
# "present" or "unknown". Absence is never reported as "not signed in": only
# evidence (a failed launch, a failed test call) may say that. Existence checks
# only; nothing is read.
AUTH_SIGNALS: dict[str, dict[str, tuple[str, ...]]] = {
    "codex": {
        "env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
        "files": ("~/.codex/auth.json",),
    },
    "claude": {
        "env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
        "files": ("~/.claude/.credentials.json",),
    },
    "gemini": {
        "env": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"),
        "files": ("~/.gemini/oauth_creds.json",),
    },
    "cursor": {"env": ("CURSOR_API_KEY",), "files": ()},
    "opencode": {
        "env": ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"),
        "files": ("~/.local/share/opencode/auth.json",),
    },
    "copilot": {
        "env": ("GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"),
        "files": (
            "~/.config/gh/hosts.yml",
            "~/.config/github-copilot/hosts.json",
            "~/.config/github-copilot/apps.json",
        ),
    },
    "qwen": {
        "env": ("OPENAI_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"),
        "files": ("~/.qwen/oauth_creds.json",),
    },
    "hermes": {"env": (), "files": ()},
}

# The one-line remedy per harness, in the harness's own terms. Shown next to
# a failure the CLI itself reported; never as installation documentation.
SIGN_IN_HINTS: dict[str, str] = {
    "codex": "run `codex login` on this machine (or set OPENAI_API_KEY for the runner)",
    "claude": "run `claude` on this machine once and sign in (or set ANTHROPIC_API_KEY for the runner)",
    "gemini": "run `gemini` on this machine once and sign in (or set GEMINI_API_KEY for the runner)",
    "cursor": "run `cursor-agent login` on this machine",
    "opencode": "run `opencode auth login` on this machine",
    "copilot": "run `gh auth login` on this machine",
    "qwen": "run `qwen` on this machine once and sign in",
    "hermes": "sign in to hermes on this machine",
}

# What a harness prints when the provider will not talk to it. Matched against
# its stderr; the matching line travels with the classification so the user
# reads the CLI's own words.
_AUTH_FAILURE = re.compile(
    r"(not logged in|not authenticated|unauthori[sz]ed|\b401\b|invalid[ _-]?api[ _-]?key|"
    r"incorrect api key|api key (?:is )?(?:missing|invalid|required|not set)|no api key|"
    r"missing (?:api key|credentials)|authentication[ _](?:failed|required|error)|"
    r"please (?:log ?in|sign ?in|run .{0,40}login)|login required|sign in required|"
    r"(?:expired|invalid) (?:token|credentials?)|token (?:has )?expired|"
    r"credentials? (?:not found|missing|invalid|expired)|permission_error|"
    r"forbidden|\b403\b)",
    re.IGNORECASE,
)
_QUOTA_FAILURE = re.compile(
    r"(insufficient[_ ]quota|quota exceeded|exceeded your current quota|billing|"
    r"rate[ _-]?limit|too many requests|\b429\b|out of credits|usage limit)",
    re.IGNORECASE,
)


def auth_signal(
    adapter: str,
    environment: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> dict[str, str]:
    """``{"status": "present"|"unknown"|"n/a", "via": ...}`` for one adapter.

    ``present`` names the signal (a variable name or a path — never a value);
    ``unknown`` means no signal was found, which is not the same as absent
    (some harnesses keep credentials in a keychain); ``n/a`` is the custom
    ``command`` adapter, whose auth is its own affair.
    """
    if adapter not in AUTH_SIGNALS:
        return {"status": "n/a", "via": ""}
    environment = dict(os.environ if environment is None else environment)
    home_dir = home if home is not None else Path.home()
    signals = AUTH_SIGNALS[adapter]
    for name in signals["env"]:
        if environment.get(name, "").strip():
            return {"status": "present", "via": f"env {name}"}
    for raw in signals["files"]:
        candidate = (
            Path(raw.replace("~", str(home_dir), 1)) if raw.startswith("~") else Path(raw)
        )
        try:
            if candidate.is_file():
                return {"status": "present", "via": raw}
        except OSError:
            continue
    return {"status": "unknown", "via": ""}


def classify_failure(adapter: str, stderr_text: str) -> dict[str, str] | None:
    """Read a dead harness's stderr and say, in its own words, why it died.

    Returns ``{"kind": "auth"|"quota", "line": <the matching line>,
    "hint": <what to do on this machine>}`` or ``None`` when nothing in the
    tail is recognisable. Auth wins over quota when both appear.
    """
    lines = [line.strip() for line in str(stderr_text or "").splitlines() if line.strip()]
    for pattern, kind in ((_AUTH_FAILURE, "auth"), (_QUOTA_FAILURE, "quota")):
        for line in reversed(lines):
            if pattern.search(line):
                hint = (
                    SIGN_IN_HINTS.get(adapter, "sign in to this harness on this machine")
                    if kind == "auth"
                    else (
                        "the provider refused for quota or billing reasons; check the "
                        "account this harness signs in with"
                    )
                )
                return {"kind": kind, "line": line[:240], "hint": hint}
    return None


class HarnessError(Exception):
    """The machine cannot prepare a harness for Merv."""


@dataclass(frozen=True)
class SkillsInstall:
    """The machine-local copy of the Merv skills every child may read."""

    root: Path
    names: tuple[str, ...]
    digest: str


def bundled_skills_root() -> Any:
    """The skills shipped with this runner, as a traversable directory.

    Inside the standalone archive the build copies ``merv/skills`` to
    ``merv/client/skills``; in a source checkout the plugin directory itself is
    authoritative.
    """
    packaged = resources.files(__package__).joinpath(SKILLS_DIRNAME)
    if packaged.is_dir():
        return packaged
    checkout = Path(__file__).resolve().parents[3] / SKILLS_DIRNAME
    if checkout.is_dir():
        return checkout
    raise HarnessError("this runner build carries no Merv skills")


def _walk(root: Any, prefix: str = "") -> Iterable[tuple[str, bytes]]:
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        name = entry.name
        if name.startswith(".") or name == "__pycache__":
            continue
        relative = f"{prefix}{name}"
        if entry.is_dir():
            yield from _walk(entry, f"{relative}/")
        elif entry.is_file():
            yield relative, entry.read_bytes()


def _digest(files: Sequence[tuple[str, bytes]]) -> str:
    hasher = hashlib.sha256()
    for relative, content in files:
        hasher.update(relative.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(hashlib.sha256(content).digest())
    return hasher.hexdigest()


def install_skills(state_dir: Path) -> SkillsInstall:
    """Materialize the bundled skills under ``state_dir/skills`` idempotently.

    The copy is replaced atomically only when its content digest changes, so a
    running child never reads a half-written skill and restarts are free.
    """
    files = list(_walk(bundled_skills_root()))
    names = tuple(
        sorted(
            {
                relative.split("/", 1)[0]
                for relative, _ in files
                if relative.endswith("/SKILL.md") and relative.count("/") == 1
            }
        )
    )
    if not names:
        raise HarnessError("bundled Merv skills contain no SKILL.md")
    digest = _digest(files)
    root = state_dir.expanduser() / SKILLS_DIRNAME
    manifest = root / MANIFEST_NAME
    try:
        current = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = None
    if isinstance(current, dict) and current.get("digest") == digest:
        return SkillsInstall(root=root, names=names, digest=digest)

    state_dir.mkdir(parents=True, exist_ok=True)
    scratch = state_dir / f"{SKILLS_DIRNAME}.{uuid.uuid4().hex}.tmp"
    scratch.mkdir(mode=0o755)
    try:
        for relative, content in files:
            target = scratch / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (scratch / MANIFEST_NAME).write_text(
            json.dumps({"digest": digest, "skills": list(names)}, indent=1) + "\n",
            encoding="utf-8",
        )
        previous = state_dir / f"{SKILLS_DIRNAME}.{uuid.uuid4().hex}.old"
        if root.exists():
            root.rename(previous)
        scratch.rename(root)
        shutil.rmtree(previous, ignore_errors=True)
    except OSError as exc:
        shutil.rmtree(scratch, ignore_errors=True)
        raise HarnessError(f"could not install Merv skills under {root}: {exc}") from exc
    return SkillsInstall(root=root, names=names, digest=digest)


def native_skill_mount(adapter: str) -> str | None:
    """Relative directory a harness scans for project skills, if any."""
    return NATIVE_SKILL_MOUNTS.get(adapter)


def mount_skills(
    *,
    adapter: str,
    workspace: Path,
    install: SkillsInstall,
    exclude_file: Path | None = None,
) -> tuple[str, ...]:
    """Link the installed skills into a workspace where ``adapter`` looks.

    Links are per skill, never a whole directory, so a repository that already
    ships its own skills keeps them; an existing non-Merv entry is left alone.
    ``exclude_file`` is the central repository's ``info/exclude``; the link
    names are recorded there so a WIP capture never commits them.
    """
    mount = native_skill_mount(adapter)
    if mount is None:
        return ()
    directory = workspace / mount
    directory.mkdir(parents=True, exist_ok=True)
    mounted: list[str] = []
    for name in install.names:
        link = directory / name
        target = install.root / name
        if link.is_symlink():
            if os.readlink(link) != str(target):
                if link.exists():
                    # A live link somewhere else is the repository's own.
                    continue
                link.unlink()
                os.symlink(target, link)
        elif link.exists():
            continue
        else:
            os.symlink(target, link)
        mounted.append(f"{mount}/{name}")
    if exclude_file is not None:
        _write_exclude_block(
            exclude_file,
            sorted(
                f"/{prefix}/{name}"
                for prefix in NATIVE_SKILL_MOUNTS.values()
                for name in install.names
            ),
        )
    return tuple(mounted)


def _write_exclude_block(path: Path, patterns: Sequence[str]) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        text = ""
    except OSError as exc:
        raise HarnessError(f"cannot read git exclude file {path}: {exc}") from exc
    block = "\n".join([EXCLUDE_BEGIN, *patterns, EXCLUDE_END]) + "\n"
    begin = text.find(EXCLUDE_BEGIN)
    end = text.find(EXCLUDE_END)
    if begin != -1 and end != -1 and end > begin:
        end += len(EXCLUDE_END)
        if text[end : end + 1] == "\n":
            end += 1
        updated = text[:begin] + block + text[end:]
    else:
        updated = text + ("" if not text or text.endswith("\n") else "\n") + block
    if updated == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    scratch = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        scratch.write_text(updated, encoding="utf-8")
        scratch.replace(path)
    finally:
        scratch.unlink(missing_ok=True)


def skills_note(install: SkillsInstall, *, adapter: str) -> str:
    """One instruction line so no child has to search the disk for a skill."""
    listed = ", ".join(install.names)
    if native_skill_mount(adapter) is not None:
        how = (
            "They are also mounted in this workspace, so use them as native "
            "skills when your platform lists them."
        )
    else:
        how = "Your platform does not load them natively."
    return (
        f"Merv skills ({listed}) are installed at {install.root}. {how} "
        "Whenever this instruction names a skill, read "
        f"{install.root}/<skill>/SKILL.md before acting on it; do not search "
        "the machine for skill or tool documentation."
    )


def _version_of(command: Sequence[str], environment: Mapping[str, str]) -> str:
    try:
        completed = subprocess.run(
            [command[0], "--version"],
            capture_output=True,
            text=True,
            timeout=VERSION_TIMEOUT_SECONDS,
            env=dict(environment),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0:
        return ""
    for stream in (completed.stdout, completed.stderr):
        line = stream.strip().splitlines()[0].strip() if stream.strip() else ""
        if line:
            return line[:120]
    return ""


def readiness(
    *,
    platforms: Iterable[Any],
    install: SkillsInstall | None,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Static readiness of every configured platform; no model call.

    ``platforms`` are objects with ``name``, ``adapter``, ``command`` and
    ``enabled``. The result is safe to publish: executables, versions, and
    what each harness will receive from the runner, never argv or secrets.
    """
    environment = dict(os.environ if environment is None else environment)
    report: dict[str, Any] = {
        "skills": (
            {
                "root": str(install.root),
                "count": len(install.names),
                "digest": install.digest[:16],
            }
            if install is not None
            else {"count": 0, "error": "no bundled skills"}
        ),
        "platforms": {},
    }
    for platform in platforms:
        command = tuple(getattr(platform, "command", ()) or ())
        adapter = str(getattr(platform, "adapter", "") or "")
        problems: list[str] = []
        executable = shutil.which(command[0], path=environment.get("PATH")) if command else None
        if not command:
            problems.append("no command configured")
        elif executable is None:
            problems.append(f"{command[0]!r} is not on PATH")
        version = _version_of(command, environment) if executable else ""
        if executable and not version:
            problems.append(f"{command[0]!r} did not answer --version")
        if install is None:
            problems.append("Merv skills are not installed")
        entry = {
            "adapter": adapter,
            "enabled": bool(getattr(platform, "enabled", True)),
            "executable": executable or "",
            "version": version,
            "merv_mcp": "native" if adapter in NATIVE_MCP_ADAPTERS else "merv-client",
            "skills": (
                "mounted" if native_skill_mount(adapter) is not None else "instruction"
            ),
            "auth": auth_signal(adapter, environment),
            "ok": not problems,
        }
        if problems:
            entry["problems"] = problems
        report["platforms"][str(getattr(platform, "name", adapter))] = entry
    return report
