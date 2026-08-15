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

from typing import Any, Mapping

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
WORKSPACE_FIELDS = ("repository", "root", "base_ref")
MIN_PARALLELISM = 1
MAX_PARALLELISM = 32
MAX_TEXT_CHARS = 200
MAX_PATH_CHARS = 1024
MAX_SETTINGS_BYTES = 16 * 1024


class RunnerSettingsError(ValueError):
    """The payload is outside the closed schema; nothing was applied."""


def validate_desired_settings(payload: object) -> dict[str, Any]:
    """Return a normalized ``{platforms, workspace}`` document or raise.

    Both halves are optional; an absent half means "no change". Present
    entries are validated field by field. Unknown keys anywhere reject.
    """
    if not isinstance(payload, Mapping):
        raise RunnerSettingsError("settings must be an object")
    unknown = sorted(set(payload) - {"platforms", "workspace"})
    if unknown:
        raise RunnerSettingsError(f"unsupported settings key(s): {', '.join(unknown)}")
    result: dict[str, Any] = {}
    if "platforms" in payload:
        result["platforms"] = _platforms(payload["platforms"])
    if "workspace" in payload:
        result["workspace"] = _workspace(payload["workspace"])
    return result


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
            parallelism = raw_entry["parallelism"]
            if isinstance(parallelism, bool) or not isinstance(parallelism, int):
                raise RunnerSettingsError(f"{name}: parallelism must be an integer")
            if not MIN_PARALLELISM <= parallelism <= MAX_PARALLELISM:
                raise RunnerSettingsError(
                    f"{name}: parallelism must be between "
                    f"{MIN_PARALLELISM} and {MAX_PARALLELISM}"
                )
            entry["parallelism"] = parallelism
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
    "WORKSPACE_FIELDS",
    "validate_desired_settings",
]
