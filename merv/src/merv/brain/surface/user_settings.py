"""Write-only per-user secret settings (no-dataplane Phase C).

Currently just the per-user Hugging Face token: a member brings their own so no
deployment-wide HF secret exists. The value is WRITE-ONLY — set or cleared here,
never returned by any read — and is consumed only internally at sandbox
provisioning (see ``SandboxEngine._resolve_hf_token``). This module owns the
``user_hf_tokens`` table; the store carries the write path the REST route and
composition depend on.
"""

from __future__ import annotations

from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    has_table,
    table_ddl,
)
from ..kernel.state.store import BaseStateStore
from ..kernel.utils import ValidationError

# A generous cap so a fat-fingered paste (or hostile body) cannot store an
# unbounded blob; real HF tokens are well under this.
_MAX_HF_TOKEN_CHARS = 500


class UserHfTokenSettings:
    """Set/clear a user's Hugging Face token; the value never reads back."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self._store = store
        store.install(USER_SETTINGS_SCHEMA)

    def set_token(self, *, user_id: str, token: str) -> dict[str, object]:
        token = (token or "").strip()
        if not token:
            raise ValidationError("token is required")
        if len(token) > _MAX_HF_TOKEN_CHARS:
            raise ValidationError(
                f"token is too long (max {_MAX_HF_TOKEN_CHARS} characters)"
            )
        self._store.set_user_hf_token(user_id=user_id, token=token)
        return {"status": "set"}

    def clear_token(self, *, user_id: str) -> dict[str, object]:
        self._store.clear_user_hf_token(user_id=user_id)
        return {"status": "cleared"}


USER_SETTINGS_DDL = """\
-- Per-user Hugging Face access token (no-dataplane Phase C). Keyed by the
-- Supabase auth.users UUID; a member brings their own token so no deployment-
-- wide HF secret exists. WRITE-ONLY by contract: the value is set/cleared over
-- the API and read back only internally at sandbox provisioning to inject
-- HF_TOKEN into the provisioning user's sandbox — no API ever returns it. Cross-
-- member exposure WITHIN a shared project is accepted (a teammate can read a
-- sandbox the token was placed in); cross-project exposure is closed because no
-- shared secret exists. Absence = public-models-only graceful degrade.
CREATE TABLE IF NOT EXISTS user_hf_tokens (
  user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


def _add_user_hf_tokens(conn: Connection) -> None:
    """Migration 31: the per-user Hugging Face token."""
    if not has_table(conn, "user_hf_tokens"):
        conn.execute(table_ddl(table="user_hf_tokens"))


USER_SETTINGS_SCHEMA = SchemaModule(
    name="surface.user_settings",
    ddl=USER_SETTINGS_DDL,
    migrations=(Migration(31, "add_user_hf_tokens", _add_user_hf_tokens),),
)


__all__ = ["USER_SETTINGS_SCHEMA", "UserHfTokenSettings"]
