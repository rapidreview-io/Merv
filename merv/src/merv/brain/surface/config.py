"""Central deployment-preset and adapter configuration for the brain.

``local`` and ``control`` use the same brain composition. The preset selects
loopback/small-store defaults or hosted durable adapters. Unknown preset values
fail at startup.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from merv.shared.client_config import (
    CONTROL_URL_ENV_VAR,
    read_client_config,
)

from ..kernel.env import env_int, env_value
from ..kernel.ports.blob_store import BlobStore
from ..kernel.utils import ValidationError
from .auth import (  # noqa: F401 -- re-exported operator knobs, see below
    ALLOW_OPEN_CONTROL_ENV_VAR,
    REQUIRE_AUTH_ENV_VAR,
)

if TYPE_CHECKING:  # the store import stays lazy at runtime (see build_state_store)
    from ..kernel.state import BaseStateStore


MODE_ENV_VAR = "MERV_MODE"

# Record-store selection. Absent means the SQLite default used by the local
# preset. A postgres:// or postgresql:// URL selects the hosted Postgres dialect.
DB_URL_ENV_VAR = "MERV_DB_URL"

# Blob and storage adapter configuration.
STORAGE_MAX_UPLOAD_BYTES_ENV_VAR = "MERV_STORAGE_MAX_UPLOAD_BYTES"
ALLOWED_ORIGINS_ENV_VAR = "MERV_ALLOWED_ORIGINS"
CONTROL_RESTRICT_CORS_ENV_VAR = "MERV_CONTROL_RESTRICT_CORS"
# Where the hosted UI's OAuth consent page lives. Unlike a CORS origin this
# may carry a path (e.g. https://rapidreview.io/merv) for path-mounted UIs.
UI_BASE_URL_ENV_VAR = "MERV_UI_BASE_URL"
# Canonical RFC 8707 resource URI for the /mcp audience. Owner-minted project
# keys carry it so they are audience-bound once OAuth enforcement lands; unset
# leaves keys un-audienced (Phase A has no audience enforcement yet).
OAUTH_RESOURCE_URI_ENV_VAR = "MERV_OAUTH_RESOURCE_URI"
# MLflow-extension env config (MLFLOW_MODE/TRACKING_URI/SERVER_URI/DASHBOARD)
# lives in src/merv/brain/mlflow/config.py — the extension owns its own knobs.
# The enforcement knob below is composition policy, so it stays here.
REQUIRE_AGENT_MLFLOW_ENV_VAR = "MERV_REQUIRE_AGENT_MLFLOW"
REQUIRE_SANDBOX_BACKEND_ENV_VAR = "MERV_REQUIRE_SANDBOX_BACKEND"
# MERV_REQUIRE_AUTH and MERV_ALLOW_OPEN_CONTROL are defined in surface/auth.py
# alongside the Supabase knobs (SUPABASE_URL/JWT_SECRET/...) they name: the
# decision they drive is taken where a hosted-policy app is composed, which is
# delivery, not bootstrap. They are imported above so this module still lists
# every operator-facing knob.

_POSTGRES_URL_PREFIXES = ("postgres://", "postgresql://")


def sandbox_feature_enabled(env: Mapping[str, str] | None = None) -> bool:
    """Whether this Merv instance exposes and runs its Sandbox capability.

    This is deliberately a machine setting, not an evaluation-mode branch.
    An external evaluator can point ``MERV_CLIENT_CONFIG`` at an isolated
    settings file containing ``{"features": {"sandbox": false}}``; ordinary
    installations keep the feature enabled when the setting is absent.
    """
    features = read_client_config(env).get("features", {})
    if features is None:
        return True
    if not isinstance(features, dict):
        raise ValidationError("features must be an object")
    enabled = features.get("sandbox", True)
    if not isinstance(enabled, bool):
        raise ValidationError("features.sandbox must be true or false")
    return enabled


class Mode(str, Enum):
    """Brain deployment preset. ``local`` is the default."""

    LOCAL = "local"
    CONTROL = "control"


def resolve_mode(env: Mapping[str, str] | None = None) -> Mode:
    """Resolve the process mode from the environment, failing fast.

    Unknown values refuse to start rather than silently running the wrong
    topology. Mode-specific fail-fast validation lives in the composition
    roots, not here, so this stays a pure parse.
    """
    raw = (env_value(MODE_ENV_VAR, env=env) or Mode.LOCAL.value).lower()
    try:
        return Mode(raw)
    except ValueError as exc:
        raise ValidationError(
            f"unknown {MODE_ENV_VAR}: {raw!r} "
            "(expected 'local' or 'control')",
            details={"mode": raw},
        ) from exc


def resolve_db_url(env: Mapping[str, str] | None = None) -> str | None:
    """The configured record-store URL, or None for the SQLite path default."""
    return env_value(DB_URL_ENV_VAR, env=env)


def resolve_control_url(env: Mapping[str, str] | None = None) -> str | None:
    """The configured brain URL (hosted or localhost), or None."""
    raw = env_value(CONTROL_URL_ENV_VAR, env=env) or ""
    if not raw:
        configured = read_client_config(env).get("control_url", "")
        raw = configured if isinstance(configured, str) else ""
    return raw.rstrip("/") or None


def storage_feature_enabled(env: Mapping[str, str] | None = None) -> bool:
    return bool(env_value("MERV_SANDBOXES_URL", env=env))


def resolve_storage_max_upload_bytes(env: Mapping[str, str] | None = None) -> int:
    """Absolute server-side ceiling for a storage.submit upload (default 50 GiB).
    A non-integer value falls back to the default rather than failing startup."""
    from ..object_storage.storage import DEFAULT_MAX_UPLOAD_BYTES

    return env_int(
        STORAGE_MAX_UPLOAD_BYTES_ENV_VAR,
        DEFAULT_MAX_UPLOAD_BYTES,
        env=env,
        strict=False,
    )


def resolve_allowed_origins(env: Mapping[str, str] | None = None) -> list[str]:
    """Hosted-control CORS allowlist from a comma-separated env var."""
    raw = env_value(ALLOWED_ORIGINS_ENV_VAR, env=env) or ""
    if not raw:
        return []
    origins: list[str] = []
    for part in raw.split(","):
        origin = part.strip().rstrip("/")
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValidationError(
                f"invalid {ALLOWED_ORIGINS_ENV_VAR} origin: {origin!r} "
                "(expected http:// or https:// origin with no path, query, or fragment)",
                details={"origin": origin},
            )
        origins.append(origin)
    return origins


def resolve_oauth_resource_uri(env: Mapping[str, str] | None = None) -> str:
    """Canonical /mcp resource URI for the key/OAuth audience, or "" when unset."""
    return (env_value(OAUTH_RESOURCE_URI_ENV_VAR, env=env) or "").strip()


def resolve_ui_base_url(env: Mapping[str, str] | None = None) -> str:
    """Hosted UI base for the sign-in handoff, or "" when unset."""
    raw = (env_value(UI_BASE_URL_ENV_VAR, env=env) or "").rstrip("/")
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValidationError(
            f"invalid {UI_BASE_URL_ENV_VAR}: {raw!r} "
            "(expected an http:// or https:// URL, path suffix allowed)",
            details={"url": raw},
        )
    return raw


def build_blob_store(*, default_root: Path, env=None, client=None) -> BlobStore:
    """Submitted evidence lives in the independently operated service."""
    from ..infrastructure.client import build_infrastructure_client
    from ..infrastructure.storage import RemoteBlobStore, UnconfiguredBlobStore

    client = client or build_infrastructure_client(env)
    return RemoteBlobStore(client=client) if client else UnconfiguredBlobStore()


def build_object_store(*, default_root: Path, env=None, client=None):
    """Heavy transfers use the same native service and project namespaces."""
    from ..infrastructure.client import build_infrastructure_client
    from ..infrastructure.storage import RemoteObjectProvider

    client = client or build_infrastructure_client(env)
    return RemoteObjectProvider(client=client) if client else None


def build_state_store(
    *, db_path: Path, env: Mapping[str, str] | None = None
) -> "BaseStateStore":
    """The record store the configuration selects, fail-fast like the mode.

    No URL selects the SQLite store at ``db_path``.
    A postgres:// URL selects the Postgres dialect (psycopg imported only on
    that branch, so local installs never need it). Any other scheme refuses
    to start rather than guessing a dialect.
    """
    url = resolve_db_url(env)
    if url is None:
        from ..kernel.state import StateStore

        return StateStore(db_path=db_path)
    if url.startswith(_POSTGRES_URL_PREFIXES):
        from ..kernel.state.dialects import PostgresStateStore

        return PostgresStateStore(dsn=url)
    raise ValidationError(
        f"unsupported {DB_URL_ENV_VAR} scheme: {url!r} "
        "(expected postgres:// or postgresql://, or unset for SQLite)",
        details={"db_url": url},
    )
