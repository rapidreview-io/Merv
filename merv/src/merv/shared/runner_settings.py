"""The closed schema for brain-held auto-run runner tuning.

Shared by the brain (which validates what an owner saves) and the machine-local
runner (which validates what it pulls before touching ``client.json``), so a
value that passes on one side passes on the other. Dependency-free on purpose:
this module ships inside the standalone runner archive.

The schema is deliberately narrow. Native platforms are keyed by adapter name
and carry only tuning; executable ``command`` argv, adapter overrides, custom
``command``-adapter agents, and the workspace strategy are never expressed here
and remain machine-local. Anything outside the schema rejects the whole payload
so a partially applied document can never exist.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .client_config import ClientError

# Native process adapters and the executable each resolves to on PATH when a
# platform entry carries no explicit command. The custom ``command`` adapter has
# no default and is not part of this schema.
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
NATIVE_ADAPTERS = tuple(DEFAULT_PLATFORM_EXECUTABLES)

PLATFORM_FIELDS = ("enabled", "model", "effort", "parallelism")
# The aggregate counters a session may report and the brain may keep. Both
# sides project against this, so a field one of them invented never appears.
TELEMETRY_COUNTERS = (
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "total_tokens",
    "tool_calls",
    "messages",
)
TELEMETRY_LABELS = ("last_event_at", "provider_session", "reporting")
WORKSPACE_FIELDS = ("repository", "root", "base_ref")
# The only workspace layout the runner implements; stored so a document says
# what it is rather than relying on the reader's default.
WORKSPACE_STRATEGY = "git_worktree"
PROBE_FIELDS = ("platform", "nonce")
MAX_NONCE_CHARS = 64
MIN_PARALLELISM = 1
MAX_PARALLELISM = 32
MAX_TEXT_CHARS = 200
MAX_PATH_CHARS = 1024
MAX_SETTINGS_BYTES = 16 * 1024


class RunnerSettingsError(ClientError):
    """The payload is outside the closed schema; nothing was applied."""


def platform_problem(name: str, parallelism: object = None) -> str:
    """Why this platform cannot be configured here, or ``""``.

    The one place the two standing refusals live: an agent that cannot emit a
    complete trace, and a slot count outside what one machine may run. Callers
    raise their own error type with the sentence this returns.
    """
    if name.strip().lower() == "aider":
        return (
            "Aider is not supported for auto-run because it cannot emit a "
            "complete JSONL interaction trace"
        )
    if parallelism is None:
        return ""
    if isinstance(parallelism, bool) or not isinstance(parallelism, int):
        return f"{name}: parallelism must be an integer"
    if not MIN_PARALLELISM <= parallelism <= MAX_PARALLELISM:
        return (
            f"{name}: parallelism must be between "
            f"{MIN_PARALLELISM} and {MAX_PARALLELISM}"
        )
    return ""


def platform_entry(
    current: Mapping[str, Any] | None,
    *,
    name: str,
    tuning: Mapping[str, Any] = {},
    adapter: str | None = None,
    command: Sequence[str] | None = None,
    default_enabled: bool = True,
) -> dict[str, Any]:
    """One ``agent_platforms`` entry, whether an owner or the brain asked.

    An entry that does not exist yet is created around its adapter's default
    executable; an entry that does keeps everything the caller did not name,
    so a ``command``-adapter agent's local argv survives a settings push.
    Blank model/effort remove the field rather than storing emptiness.
    """
    entry: dict[str, Any] = dict(current) if isinstance(current, Mapping) else {
        "adapter": name if name in NATIVE_ADAPTERS else "command",
        "command": [DEFAULT_PLATFORM_EXECUTABLES.get(name, name)],
        "enabled": default_enabled,
        "parallelism": MIN_PARALLELISM,
    }
    if adapter is not None:
        entry["adapter"] = adapter
    if command is not None:
        entry["command"] = [str(item) for item in command]
    for field in PLATFORM_FIELDS:
        if field not in tuning:
            continue
        if field in ("model", "effort") and not tuning[field]:
            entry.pop(field, None)
        else:
            entry[field] = tuning[field]
    return entry


def workspace_entry(
    current: Mapping[str, Any] | None, values: Mapping[str, Any]
) -> dict[str, Any]:
    """The ``agent_workspace`` entry: the fields named, on the one strategy."""
    entry: dict[str, Any] = dict(current) if isinstance(current, Mapping) else {}
    for field in WORKSPACE_FIELDS:
        if field not in values:
            continue
        if values[field]:
            entry[field] = values[field]
        else:
            entry.pop(field, None)
    entry["strategy"] = WORKSPACE_STRATEGY
    return entry


def validate_desired_settings(payload: object) -> dict[str, Any]:
    """Return a normalized ``{platforms, workspace, probe}`` document or raise.

    Every part is optional; an absent part means "no change". Present entries
    are validated field by field. Unknown keys anywhere reject. ``probe`` is
    the one non-persistent part: an owner asking the machine to run one test
    call through a platform (``{"platform", "nonce"}``); the runner runs it
    once per nonce and reports the outcome in its inventory.
    """
    if not isinstance(payload, Mapping):
        raise RunnerSettingsError("settings must be an object")
    unknown = sorted(set(payload) - {"platforms", "workspace", "probe"})
    if unknown:
        raise RunnerSettingsError(f"unsupported settings key(s): {', '.join(unknown)}")
    result: dict[str, Any] = {}
    if "platforms" in payload:
        result["platforms"] = _platforms(payload["platforms"])
    if "workspace" in payload:
        result["workspace"] = _workspace(payload["workspace"])
    if "probe" in payload:
        result["probe"] = _probe(payload["probe"])
    return result


def _probe(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise RunnerSettingsError("probe must be an object")
    unknown = sorted(set(value) - set(PROBE_FIELDS))
    if unknown:
        raise RunnerSettingsError(f"unsupported probe field(s): {', '.join(unknown)}")
    platform = _text(value.get("platform"), field="probe.platform")
    if platform not in NATIVE_ADAPTERS:
        raise RunnerSettingsError(
            f"probe.platform must be a native platform ({', '.join(NATIVE_ADAPTERS)})"
        )
    nonce = _text(value.get("nonce"), field="probe.nonce", limit=MAX_NONCE_CHARS)
    if not nonce or not all(ch.isalnum() or ch in "-_" for ch in nonce):
        raise RunnerSettingsError("probe.nonce must be 1-64 letters, digits, '-' or '_'")
    return {"platform": platform, "nonce": nonce}


def _platforms(value: object) -> dict[str, dict[str, Any]]:
    if not isinstance(value, Mapping):
        raise RunnerSettingsError("platforms must be an object keyed by platform name")
    platforms: dict[str, dict[str, Any]] = {}
    for raw_name, raw_entry in value.items():
        name = str(raw_name or "").strip()
        if name not in NATIVE_ADAPTERS:
            raise RunnerSettingsError(
                f"{name or '<empty>'}: only native platforms can be tuned here "
                f"({', '.join(NATIVE_ADAPTERS)}); custom command agents stay local"
            )
        if not isinstance(raw_entry, Mapping):
            raise RunnerSettingsError(f"{name}: platform entry must be an object")
        unknown = sorted(set(raw_entry) - set(PLATFORM_FIELDS))
        if unknown:
            raise RunnerSettingsError(
                f"{name}: unsupported platform field(s): {', '.join(unknown)}"
            )
        entry: dict[str, Any] = {}
        if "enabled" in raw_entry:
            if not isinstance(raw_entry["enabled"], bool):
                raise RunnerSettingsError(f"{name}: enabled must be true or false")
            entry["enabled"] = raw_entry["enabled"]
        for field in ("model", "effort"):
            if field in raw_entry:
                entry[field] = _text(raw_entry[field], field=f"{name}: {field}")
        if "parallelism" in raw_entry:
            problem = platform_problem(name, raw_entry["parallelism"])
            if problem:
                raise RunnerSettingsError(problem)
            entry["parallelism"] = raw_entry["parallelism"]
        platforms[name] = entry
    return platforms


def _workspace(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise RunnerSettingsError("workspace must be an object")
    unknown = sorted(set(value) - set(WORKSPACE_FIELDS))
    if unknown:
        raise RunnerSettingsError(f"unsupported workspace field(s): {', '.join(unknown)}")
    workspace: dict[str, str] = {}
    for field in ("repository", "root"):
        if field in value:
            text = _text(value[field], field=f"workspace.{field}", limit=MAX_PATH_CHARS)
            if text and not _is_absolute(text):
                raise RunnerSettingsError(f"workspace.{field} must be an absolute path")
            workspace[field] = text
    if "base_ref" in value:
        workspace["base_ref"] = _text(value["base_ref"], field="workspace.base_ref")
    return workspace


def _text(value: object, *, field: str, limit: int = MAX_TEXT_CHARS) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RunnerSettingsError(f"{field} must be a string")
    text = value.strip()
    if len(text) > limit:
        raise RunnerSettingsError(f"{field} is too long")
    if any(character in text for character in "\x00\r\n"):
        raise RunnerSettingsError(f"{field} contains control characters")
    return text


def _is_absolute(path: str) -> bool:
    if path.startswith("/") or path.startswith("~"):
        return True
    # Windows drive or UNC.
    return (len(path) > 2 and path[1] == ":" and path[2] in "\\/") or path.startswith("\\\\")


__all__ = [
    "DEFAULT_PLATFORM_EXECUTABLES",
    "MAX_PARALLELISM",
    "MAX_SETTINGS_BYTES",
    "MIN_PARALLELISM",
    "NATIVE_ADAPTERS",
    "PLATFORM_FIELDS",
    "RunnerSettingsError",
    "TELEMETRY_COUNTERS",
    "TELEMETRY_LABELS",
    "WORKSPACE_FIELDS",
    "WORKSPACE_STRATEGY",
    "platform_entry",
    "platform_problem",
    "validate_desired_settings",
    "workspace_entry",
]
