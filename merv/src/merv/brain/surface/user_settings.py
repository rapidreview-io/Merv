"""Write-only per-user secret settings (no-dataplane Phase C).

Currently just the per-user Hugging Face token: a member brings their own so no
deployment-wide HF secret exists. The value is WRITE-ONLY — set or cleared
here, never returned by any read, and ``resolve`` is the internal-only reader a
provisioning path would use. This module owns the ``user_hf_tokens`` table, its
DDL, and the statements that touch it.
"""

from __future__ import annotations

from contextlib import closing

from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    has_table,
    table_ddl,
)
from ..kernel.state.store import BaseStateStore
from ..kernel.utils import ValidationError, now_iso

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
        # Dialect-neutral upsert; `excluded` works on SQLite >= 3.24 and
        # Postgres alike, and one row per user is the whole model.
        with self._store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO user_hf_tokens (user_id, token, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO UPDATE
                  SET token = excluded.token, updated_at = excluded.updated_at
                """,
                (user_id, token, now_iso()),
            )
        return {"status": "set"}

    def clear_token(self, *, user_id: str) -> dict[str, object]:
        with self._store.transaction() as conn:
            conn.execute("DELETE FROM user_hf_tokens WHERE user_id = ?", (user_id,))
        return {"status": "cleared"}

    def resolve(self, *, user_id: str) -> str:
        """The token, for provisioning only. INTERNAL — never return it from an
        API. Empty when unset or unauthenticated, which a provisioning path
        treats as public-models-only graceful degrade."""
        if not user_id:
            return ""
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT token FROM user_hf_tokens WHERE user_id = ?", (user_id,)
            ).fetchone()
        return str(row["token"]) if row and row["token"] else ""


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
