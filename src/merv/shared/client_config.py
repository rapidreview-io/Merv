"""Machine client configuration helpers.

Env-var names resolve dual-spelled here exactly as in ``merv.brain.kernel.env``:
``MERV_X`` primary, ``RESEARCH_PLUGIN_X`` legacy fallback (non-empty wins;
empty counts as unset). The logic is duplicated tiny rather than imported —
this package stays stdlib-only with no backend imports.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .machine_dirs import resolve_machine_state_dir


ENV_PREFIX = "MERV_"
LEGACY_ENV_PREFIX = "RESEARCH_PLUGIN_"
_warned_legacy_names: set[str] = set()


def env_name_pair(name: str) -> tuple[str, str]:
    """The (primary, legacy) spellings of a config var, given either one."""
    if name.startswith(ENV_PREFIX):
        return name, LEGACY_ENV_PREFIX + name[len(ENV_PREFIX):]
    if name.startswith(LEGACY_ENV_PREFIX):
        return ENV_PREFIX + name[len(LEGACY_ENV_PREFIX):], name
    return name, name


def dual_env_value(
    name: str, env: Mapping[str, str] | None = None
) -> str | None:
    """Dual-read a config var: a non-empty stripped value or None.

    When the legacy spelling is the effective source from the real process
    environment, one stderr deprecation line per variable per process names
    the new spelling.
    """
    primary, legacy = env_name_pair(name)
    source = env if env is not None else os.environ
    value = (source.get(primary) or "").strip()
    if value:
        return value
    legacy_value = (source.get(legacy) or "").strip() if legacy != primary else ""
    if legacy_value:
        if env is None and primary not in _warned_legacy_names:
            _warned_legacy_names.add(primary)
            _warn(
                f"[merv] {legacy} is deprecated; set {primary} instead "
                "(the legacy value was used)"
            )
        return legacy_value
    return None


def _warn(text: str) -> None:
    """A note onto stderr, or onto nothing at all — never onto stdout.

    ``print(file=None)`` FALLS BACK TO STDOUT, and a client spawned with fd 2
    closed has exactly that: ``sys.stderr`` is None for the life of the
    process, however the descriptor is reopened afterwards. Clients like
    ``merv-runs-wait`` carry their wake signal on stdout, where a stray note
    reads as a protocol line nobody sent — so a note that cannot reach stderr
    is dropped instead.
    """
    stream = sys.stderr
    if stream is None:
        return
    try:
        stream.write(f"{text}\n")
        stream.flush()
    except (OSError, ValueError, AttributeError):
        pass


CLIENT_CONFIG_ENV_VAR = "MERV_CLIENT_CONFIG"
CONTROL_URL_ENV_VAR = "MERV_CONTROL_URL"
AGENT_SESSION_KEY_ENV_VAR = "MERV_AGENT_SESSION_KEY"
# Brain URL defaults: unconfigured machines dial the hosted brain; local
# deployments opt in via `merv-client configure` or the env var.
HOSTED_CONTROL_URL = "https://experiments.rapidreview.io"
LOCAL_BRAIN_URL = "http://127.0.0.1:8787"


def default_client_config_path() -> Path:
    """Default machine config path; resolved per call (see machine_dirs)."""
    return resolve_machine_state_dir() / "client.json"


def resolve_client_config_path(env: Mapping[str, str] | None = None) -> Path:
    raw = dual_env_value(CLIENT_CONFIG_ENV_VAR, env)
    return Path(raw).expanduser() if raw else default_client_config_path()


def resolve_client_control_url(
    *, config_path: Path | None = None, env: Mapping[str, str] | None = None
) -> str:
    """The brain a client dials: env var, then machine config, then hosted.

    One definition so every client entry point agrees on the precedence; a
    caller that already resolved a config path (``--config``) names it here
    rather than reordering the rest.
    """
    config_env = env
    if config_path is not None:
        config_env = {
            **(env if env is not None else os.environ),
            CLIENT_CONFIG_ENV_VAR: str(config_path),
        }
    configured = read_client_config(config_env).get("control_url")
    return (
        dual_env_value(CONTROL_URL_ENV_VAR, env)
        or (configured if isinstance(configured, str) else "")
        or HOSTED_CONTROL_URL
    ).rstrip("/")


def read_client_config(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    path = resolve_client_config_path(env)
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(key): value for key, value in parsed.items() if value is not None}
