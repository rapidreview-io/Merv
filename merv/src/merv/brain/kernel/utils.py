"""Cross-cutting helpers for the Merv backend.

Holds the small, dependency-free utilities every layer needs:

  - Identity-preserving re-exports of the shared domain error hierarchy.
  - ``new_id(prefix=...)`` for opaque, prefixed entity ids.
  - ``now_iso()`` / ``format_iso()`` / ``parse_iso()`` for consistent ISO-8601
    timestamp handling.

Keeping these in one module means every service can ``from ..utils import …``
once instead of three times.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from merv.shared.errors import (
    ContentUnavailableError,
    GoneError,
    NotFoundError,
    PermissionDeniedError,
    ResearchPluginError,
    ThrottledError,
    ValidationError,
    WorkflowError,
)
from merv.shared.path_utils import safe_experiment_dirname


# ---------------------------------------------------------------------------
# Identifier + clock helpers
# ---------------------------------------------------------------------------


def new_id(*, prefix: str) -> str:
    """Return an opaque id of the form ``"<prefix>_<12-hex-chars>"``."""
    return f"{prefix}_{uuid4().hex[:12]}"


def now_iso() -> str:
    """Return the current UTC instant as an ISO-8601 string (``…Z``)."""
    return format_iso(datetime.now(UTC))


def iso_after(*, seconds: int) -> str:
    """Return the UTC instant ``seconds`` from now as an ISO-8601 string."""
    return format_iso(datetime.now(UTC) + timedelta(seconds=seconds))


def format_iso(value: datetime) -> str:
    """Return an ISO-8601 UTC timestamp string with second precision."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    else:
        value = value.astimezone(UTC)
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp, normalizing naive values to UTC."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
