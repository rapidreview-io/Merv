"""SQL adapter for Surface-owned OAuth state, and the tables behind it."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import astuple
from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Any

from ..kernel.env import env_int
from ..kernel.state.schema import Connection, Migration, SchemaModule
from ..kernel.retention import RETENTION_BATCH_ROWS, drain
from ..kernel.state.store import BaseStateStore, deleted_rows, row_to_dict
from ..kernel.utils import format_iso
from .oauth import (
    CAP_EVICTION_LIMIT,
    DEFAULT_MAX_CLIENTS,
    DEFAULT_UNUSED_CLIENT_TTL_DAYS,
    MAX_CLIENTS_ENV_VAR,
    OPPORTUNISTIC_PRUNE_LIMIT,
    UNUSED_CLIENT_TTL_DAYS_ENV_VAR,
    AuthorizationCode,
    OAuthClient,
    OAuthError,
    RefreshToken,
)
from .project_keys import revoke_key_lineage

LOGGER = logging.getLogger(__name__)


def _json_list(values: tuple[str, ...] | list[str]) -> str:
    return json.dumps(list(values), separators=(",", ":"))


def oauth_client_fingerprint(
    *, client_name: str, redirect_uris_json: str, grant_types_json: str
) -> str:
    """The identity of one OAuth DCR registration's metadata (migration 38).

    The writes above and the migration that backfills the column must agree, or
    the UNIQUE index enforces two notions of "the same thing"; this is that one
    definition. Both arrays are sorted, because their order carries no meaning
    to either side and a client that shuffles its own list must not fork a
    second row. Unparseable stored JSON fingerprints as its own literal text
    rather than raising — a legacy row is still entitled to a stable identity.
    Public metadata, not secret material, so deliberately not secret_tokens.
    """
    payload = json.dumps(
        {
            "client_name": client_name,
            "grant_types": _canonical_json_list(grant_types_json),
            "redirect_uris": _canonical_json_list(redirect_uris_json),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _canonical_json_list(raw: str) -> list[str]:
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return [raw]
    if not isinstance(parsed, list):
        return [raw]
    return sorted(str(item) for item in parsed)


def _fingerprint(client: OAuthClient) -> str:
    return oauth_client_fingerprint(
        client_name=client.client_name,
        redirect_uris_json=_json_list(client.redirect_uris),
        grant_types_json=_json_list(client.grant_types),
    )


# A spent refresh token is kept a week past its expiry, so no sweep can race a
# request still holding one. A spent code is kept for the client's whole
# unused horizon: it is the evidence the never-used predicate reads, and a
# client that only ever authorizes (no refresh grant) has no other.
EXPIRED_REFRESH_GRACE_DAYS = 7

# A registration holding no credential: it authorizes nothing, so deleting it
# revokes nothing. Expired codes and tokens are deleted before this runs, which
# is how a client that once authorized something becomes collectable at all.
_NEVER_USED_PREDICATE = """
  client_id NOT IN (SELECT client_id FROM oauth_authorization_codes)
  AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
"""
_BY_FINGERPRINT = """
SELECT * FROM oauth_clients WHERE metadata_fingerprint = ?
"""

class SqlOAuthRepository:
    def __init__(
        self,
        *,
        store: BaseStateStore,
        unused_client_ttl_days: int | None = None,
        max_clients: int | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self._store = store
        store.install(OAUTH_SCHEMA)
        configured = (
            int(unused_client_ttl_days)
            if unused_client_ttl_days is not None
            else env_int(
                UNUSED_CLIENT_TTL_DAYS_ENV_VAR,
                DEFAULT_UNUSED_CLIENT_TTL_DAYS,
                env=env,
                strict=False,
            )
        )
        # A zero/negative horizon would delete a client mid-authorization.
        self.unused_client_ttl_days = max(1, configured)
        cap = (
            int(max_clients)
            if max_clients is not None
            else env_int(MAX_CLIENTS_ENV_VAR, DEFAULT_MAX_CLIENTS, env=env, strict=False)
        )
        # A zero/negative cap would refuse the very first registration.
        self.max_clients = max(1, cap)

    def get_or_create_client(self, *, client: OAuthClient) -> OAuthClient:
        """Resolve identical metadata to one row, or insert it.

        The fingerprint's UNIQUE index lets the database arbitrate two
        registrations racing with the same metadata: the insert defers to it
        and re-reads the winner. A known client is answered from a plain read,
        never queueing behind the prune and eviction below.
        """
        fingerprint = _fingerprint(client)
        with closing(self._store.connect()) as conn:
            existing = _client(conn.execute(_BY_FINGERPRINT, (fingerprint,)).fetchone())
        if existing is not None:
            return existing
        with self._store.transaction() as conn:
            existing = _client(conn.execute(_BY_FINGERPRINT, (fingerprint,)).fetchone())
            if existing is not None:
                return existing
            # Cleanup that does not depend on anyone scheduling it: every
            # registration pays for a bounded slice of the sweep, then makes
            # room at the cap if it must.
            self._delete_never_used(
                conn=conn, cutoff=self._cutoff(None), limit=OPPORTUNISTIC_PRUNE_LIMIT
            )
            occupied = self._make_room(conn=conn)
            if occupied < self.max_clients:
                conn.execute(
                    """
                    INSERT INTO oauth_clients (
                      client_id, client_name, redirect_uris_json, grant_types_json,
                      metadata_fingerprint, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (metadata_fingerprint) DO NOTHING
                    """,
                    (
                        client.client_id,
                        client.client_name,
                        _json_list(client.redirect_uris),
                        _json_list(client.grant_types),
                        fingerprint,
                        client.created_at,
                    ),
                )
                # Ours, or the row a concurrent replica landed first; a missing
                # re-read is a server fault, never a client id nothing stored.
                stored = _client(
                    conn.execute(_BY_FINGERPRINT, (fingerprint,)).fetchone()
                )
                if stored is None:
                    LOGGER.error(
                        "OAuth registration insert left no row for fingerprint %s",
                        fingerprint,
                    )
                    raise OAuthError(
                        "temporarily_unavailable",
                        "client registration is temporarily unavailable; retry shortly",
                    )
                return stored
        # Outside the transaction on purpose: the prune and eviction above are
        # COMMITTED before this refusal, so an over-cap table shrinks on every
        # attempt instead of rolling its own progress back forever.
        LOGGER.warning(
            "refusing an OAuth registration: %s clients remain against the %s "
            "cap of %s and no never-used row is left to evict",
            occupied,
            MAX_CLIENTS_ENV_VAR,
            self.max_clients,
        )
        # Deliberately says neither the cap nor the knob that sets it: an
        # unauthenticated caller learns only that this is a server condition.
        raise OAuthError(
            "temporarily_unavailable",
            "client registration is temporarily unavailable; retry shortly",
        )

    def _make_room(self, *, conn: Any) -> int:
        """Free a slot at the cap by evicting the oldest never-used rows;
        returns how many rows the table still holds.

        Refusing at the cap would let anyone fill the table with valid metadata
        and lock real clients out; eviction drops the filler's own rows instead,
        bounded per call so an over-cap table converges across attempts.
        """
        row = row_to_dict(
            row=conn.execute("SELECT COUNT(*) AS total FROM oauth_clients").fetchone()
        )
        total = int((row or {}).get("total") or 0)
        if total < self.max_clients:
            return total
        return total - self._delete_never_used(
            conn=conn,
            cutoff=None,
            limit=min(total - self.max_clients + 1, CAP_EVICTION_LIMIT),
        )

    def client_by_id(self, *, client_id: str) -> OAuthClient | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM oauth_clients WHERE client_id = ?", (client_id,)
            ).fetchone()
        return _client(row)

    def prune(self, *, now: datetime | None = None) -> dict[str, Any]:
        """Delete spent credentials, then the registrations left holding none.

        The order is the mechanism: with its codes and tokens gone, a client
        that once authorized becomes collectable, so the cap is not a lifetime
        ceiling. A failed sweep reports ``ok`` False and the error rather than
        a healthy-looking zero.
        """
        moment = now or datetime.now(tz=UTC)
        cutoff = self._cutoff(moment)
        try:
            codes = drain(lambda: self._delete_batch(
                """
                DELETE FROM oauth_authorization_codes WHERE code_digest IN (
                  SELECT code_digest FROM oauth_authorization_codes
                  WHERE expires_at < ? ORDER BY expires_at LIMIT ?
                )
                """, (cutoff, RETENTION_BATCH_ROWS),
            ))
            # A rotation chain leaves whole or not at all: parent_token_id
            # names the row before it, so half a chain would dangle, and the
            # member that expires last is the one that says the grant is over.
            tokens = drain(lambda: self._delete_batch(
                """
                DELETE FROM oauth_refresh_tokens WHERE family_id IN (
                  SELECT family_id FROM oauth_refresh_tokens
                  GROUP BY family_id HAVING MAX(expires_at) < ?
                  ORDER BY MAX(expires_at) LIMIT ?
                )
                """, (_horizon(moment, EXPIRED_REFRESH_GRACE_DAYS), RETENTION_BATCH_ROWS),
            ))
            deleted = drain(lambda: self._delete_never_used_batch(cutoff=cutoff))
        except Exception as exc:  # noqa: BLE001 -- one sweep must not abort the pass
            return {"deleted": 0, "codes": 0, "tokens": 0, "ok": False,
                    "cutoff": cutoff, "error": str(exc)[:200]}
        return {"deleted": deleted, "codes": codes, "tokens": tokens,
                "ok": True, "cutoff": cutoff}

    def _delete_batch(self, sql: str, params: tuple[Any, ...]) -> int:
        with self._store.transaction() as conn:
            return deleted_rows(conn.execute(sql, params))

    def _delete_never_used_batch(self, *, cutoff: str) -> int:
        with self._store.transaction() as conn:
            return self._delete_never_used(conn=conn, cutoff=cutoff, limit=RETENTION_BATCH_ROWS)

    def _cutoff(self, now: datetime | None) -> str:
        return _horizon(
            now or datetime.now(tz=UTC), self.unused_client_ttl_days
        )

    @staticmethod
    def _delete_never_used(*, conn: Any, cutoff: str | None, limit: int) -> int:
        """Delete up to ``limit`` never-used registrations, older than
        ``cutoff`` if given (the subquery form is what both dialects accept)."""
        if limit <= 0:
            return 0
        aged = "" if cutoff is None else "created_at < ? AND"
        params = () if cutoff is None else (cutoff,)
        return deleted_rows(conn.execute(
            f"""
            DELETE FROM oauth_clients WHERE client_id IN (
              SELECT client_id FROM oauth_clients
              WHERE {aged} {_NEVER_USED_PREDICATE}
              ORDER BY created_at, client_id LIMIT ?
            )
            """,
            (*params, limit),
        ))

    def insert_code(self, *, code: AuthorizationCode) -> None:
        # Column order is the dataclass's field order, for both credential tables.
        with self._store.transaction() as conn:
            conn.execute(
                "INSERT INTO oauth_authorization_codes ("
                "  code_digest, client_id, redirect_uri, owner_user_id, project_id,"
                "  grant_scope, code_challenge, resource, created_at, expires_at, consumed_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                astuple(code),
            )

    def code_by_digest(self, *, digest: str) -> AuthorizationCode | None:
        with closing(self._store.connect()) as conn:
            data = row_to_dict(row=conn.execute(
                "SELECT * FROM oauth_authorization_codes WHERE code_digest = ?", (digest,)
            ).fetchone())
        return None if data is None else AuthorizationCode(**data)

    def consume_code(self, *, digest: str, consumed_at: str) -> bool:
        with self._store.transaction() as conn:
            row = conn.execute(
                """
                SELECT code_digest FROM oauth_authorization_codes
                WHERE code_digest = ? AND consumed_at IS NULL AND expires_at > ?
                """,
                (digest, consumed_at),
            ).fetchone()
            if row is None:
                return False
            conn.execute(
                """
                UPDATE oauth_authorization_codes SET consumed_at = ?
                WHERE code_digest = ? AND consumed_at IS NULL
                """,
                (consumed_at, digest),
            )
        return True

    def insert_refresh_token(self, *, token: RefreshToken) -> None:
        with self._store.transaction() as conn:
            conn.execute(
                "INSERT INTO oauth_refresh_tokens ("
                "  id, family_id, secret_digest, client_id, owner_user_id, project_id,"
                "  grant_scope, resource, current_key_id, parent_token_id,"
                "  created_at, expires_at, consumed_at, revoked_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                astuple(token),
            )

    def refresh_token_by_digest(self, *, digest: str) -> RefreshToken | None:
        with closing(self._store.connect()) as conn:
            data = row_to_dict(row=conn.execute(
                "SELECT * FROM oauth_refresh_tokens WHERE secret_digest = ?", (digest,)
            ).fetchone())
        return None if data is None else RefreshToken(**data)

    def consume_refresh_token(self, *, token_id: str, consumed_at: str) -> bool:
        with self._store.transaction() as conn:
            row = conn.execute(
                """
                SELECT r.id FROM oauth_refresh_tokens r
                JOIN project_api_keys k ON k.id = r.current_key_id
                WHERE r.id = ? AND r.consumed_at IS NULL AND r.revoked_at IS NULL
                  AND r.expires_at > ? AND k.revoked_at IS NULL
                """,
                (token_id, consumed_at),
            ).fetchone()
            if row is None:
                return False
            conn.execute(
                """
                UPDATE oauth_refresh_tokens SET consumed_at = ?
                WHERE id = ? AND consumed_at IS NULL
                """,
                (consumed_at, token_id),
            )
        return True

    def revoke_refresh_family_and_key_lineage(
        self,
        *,
        family_id: str,
        key_id: str,
        project_id: str,
        owner_user_id: str,
        revoked_at: str,
    ) -> None:
        """Revoke replay authority and every derived bearer in one commit."""
        with self._store.transaction() as conn:
            conn.execute(
                """
                UPDATE oauth_refresh_tokens
                SET revoked_at = COALESCE(revoked_at, ?)
                WHERE family_id = ?
                """,
                (revoked_at, family_id),
            )
            revoke_key_lineage(
                conn,
                project_id=project_id,
                key_id=key_id,
                owner_user_id=owner_user_id,
                revoked_at=revoked_at,
            )


def _horizon(now: datetime, days: int) -> str:
    """The timestamp a row must be older than to be swept."""
    return format_iso(now - timedelta(days=days))


def _client(row: Any) -> OAuthClient | None:
    data = row_to_dict(row=row)
    if data is None:
        return None
    return OAuthClient(
        client_id=str(data["client_id"]),
        client_name=str(data["client_name"]),
        redirect_uris=tuple(json.loads(str(data["redirect_uris_json"]))),
        grant_types=tuple(json.loads(str(data["grant_types_json"]))),
        created_at=str(data["created_at"]),
    )



__all__ = ["SqlOAuthRepository"]


# -- schema ----------------------------------------------------------------

OAUTH_DDL = """\
-- OAuth 2.1 public DCR registrations (agent-anywhere Phase B). A repeated
-- registration with identical metadata resolves to the SAME client_id, so the
-- Cursor double-DCR race is safe without growing the table; the retention
-- clock sweeps registrations left holding no credential. Only public clients
-- (token_endpoint_auth_method=none) exist, so no client secret is stored.
-- ``metadata_fingerprint`` is that "identical metadata" statement made a
-- database fact: a digest over the CANONICAL (sorted-array) metadata, under
-- the UNIQUE index below. NULL is the one legal duplicate — a legacy row whose
-- canonical twin already holds the fingerprint (both dialects treat NULLs as
-- distinct in a unique index), which stays reachable by client_id while new
-- registrations resolve to the twin.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  metadata_fingerprint TEXT,
  created_at TEXT NOT NULL
);

-- OAuth authorization codes are opaque one-shot credentials. Only a digest
-- is stored; every security-relevant request value is bound into the row.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_digest TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- Carries the consent decision through to the minted key (see
  -- project_api_keys.grant_scope).
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Refresh tokens rotate once. Their opaque value is never persisted, and the
-- current project-key link makes the existing key revocation path authoritative
-- for refresh authority as well as direct bearer use.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- Preserved across every rotation so a refreshed key keeps the scope the
  -- user consented to (see project_api_keys.grant_scope).
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  resource TEXT NOT NULL,
  current_key_id TEXT NOT NULL,
  parent_token_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(current_key_id) REFERENCES project_api_keys(id),
  FOREIGN KEY(parent_token_id) REFERENCES oauth_refresh_tokens(id)
);

-- The get-or-create arbiter for a repeated registration. NULLs are distinct
-- on both dialects, which is exactly the escape hatch legacy duplicates need.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_fingerprint
  ON oauth_clients(metadata_fingerprint);

-- `client_id NOT IN (SELECT client_id FROM ...)` on the registration sweep,
-- the expiry sweeps, and the per-principal/per-IP rate windows.
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client
  ON oauth_authorization_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client
  ON oauth_refresh_tokens(client_id);
"""


# The device grant and the consent handoff link are gone: a machine with no
# browser holds a project key, so neither exchange has anything left to carry.
_RETIRED_OAUTH_TABLES = (
    "oauth_device_grant_attempts",
    "oauth_device_grants",
    "oauth_handoff_links",
)


def _drop_retired_oauth_tables(conn: Connection) -> None:
    """Migration 66: OAuth keeps only the redirect flow's own rows."""
    for table in _RETIRED_OAUTH_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")


def _drop_user_hf_tokens(conn: Connection) -> None:
    """Migration 80: the per-user Hugging Face token had writers and no reader."""
    conn.execute("DROP TABLE IF EXISTS user_hf_tokens")


OAUTH_SCHEMA = SchemaModule(
    name="surface.oauth",
    ddl=OAUTH_DDL,
    migrations=(
        Migration(66, "drop_retired_oauth_tables", _drop_retired_oauth_tables),
        Migration(80, "drop_user_hf_tokens", _drop_user_hf_tokens),
    ),
)
