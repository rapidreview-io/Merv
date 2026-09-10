"""SQL adapter for Surface-owned OAuth state, and the tables behind it."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Any

from ..kernel.env import env_int
from ..kernel.state.schema import Connection, Migration, SchemaModule
from ..kernel.state.store import BaseStateStore, row_to_dict
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
from .project_keys import PROJECT_GRANT

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


# A registration nobody ever authorized: it holds no credential, so deleting it
# revokes nothing. Shared by the scheduled sweep, the bounded prune the
# registration path runs itself, and the at-cap eviction, so the three can never
# drift into disagreeing about which rows are expendable.
_NEVER_USED_PREDICATE = """
  client_id NOT IN (SELECT client_id FROM oauth_authorization_codes)
  AND client_id NOT IN (SELECT client_id FROM oauth_refresh_tokens)
"""
_UNUSED_CLIENT_PREDICATE = f"""
  created_at < ?
  AND {_NEVER_USED_PREDICATE}
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

        Identity is the canonical metadata fingerprint carrying the schema's
        UNIQUE index, so the DATABASE arbitrates the Cursor double-DCR race —
        not merely the store's global writer lock, whose Postgres advisory key
        is a hash of the DSN spelling and therefore does not serialize two
        replicas that name the same database differently (audit AUTH-03). The
        insert defers to that index and re-reads the winner.

        An already-registered client is answered from a plain read, never
        taking the writer lock: the common case must not queue behind the
        prune/eviction work below.
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
            self._prune_unused(
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
                # Ours, or the row a concurrent replica landed first. Either way
                # the caller gets the one client id this metadata now names.
                #
                # The conflict target is the FINGERPRINT index alone: an
                # untargeted clause would also swallow a client_id collision
                # and leave nothing behind, and a missing re-read is treated as
                # the server fault it is rather than answered with a client id
                # this database never stored.
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
        """Free a slot at the cap by evicting the oldest never-used rows.

        Returns how many rows the table still holds. Refusing at the cap would
        make unauthenticated DCR a cheap onboarding denial of service: anyone
        could fill the table with valid metadata and lock every real client out
        until the TTL horizon. Eviction inverts that — the attacker's own
        never-used rows are what gets dropped. Only a table whose every row is
        USED (holds a code or a refresh token, so deleting it would revoke
        someone's live grant) still refuses, and the per-call bound keeps the
        work under the writer lock predictable: an over-cap table converges
        across attempts rather than in one long one.
        """
        total = self._client_count(conn=conn)
        if total < self.max_clients:
            return total
        evicted = self._evict_never_used(
            conn=conn, limit=min(total - self.max_clients + 1, CAP_EVICTION_LIMIT)
        )
        return total - evicted

    def _client_count(self, *, conn: Any) -> int:
        row = row_to_dict(
            row=conn.execute("SELECT COUNT(*) AS total FROM oauth_clients").fetchone()
        )
        return int((row or {}).get("total") or 0)

    def _evict_never_used(self, *, conn: Any, limit: int) -> int:
        """Delete the oldest never-used registrations, ignoring their age."""
        if limit <= 0:
            return 0
        cursor = conn.execute(
            f"""
            DELETE FROM oauth_clients WHERE client_id IN (
              SELECT client_id FROM oauth_clients
              WHERE {_NEVER_USED_PREDICATE}
              ORDER BY created_at, client_id LIMIT ?
            )
            """,
            (limit,),
        )
        return max(0, int(getattr(cursor, "rowcount", 0) or 0))

    def client_by_id(self, *, client_id: str) -> OAuthClient | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM oauth_clients WHERE client_id = ?", (client_id,)
            ).fetchone()
        return _client(row)

    def prune(self, *, now: datetime | None = None) -> dict[str, Any]:
        """Delete registrations past the horizon that never authorized anything.

        Reports its own outcome: a failed sweep says ``ok`` False and names the
        error rather than returning zero, which would read as a healthy pass
        that found nothing (audit OPS-03).
        """
        cutoff = self._cutoff(now)
        try:
            with self._store.transaction() as conn:
                deleted = self._prune_unused(conn=conn, cutoff=cutoff, limit=None)
        except Exception as exc:  # noqa: BLE001 -- one sweep must not abort the pass
            return {"deleted": 0, "ok": False, "cutoff": cutoff, "error": str(exc)[:200]}
        return {"deleted": deleted, "ok": True, "cutoff": cutoff}

    def _cutoff(self, now: datetime | None) -> str:
        return format_iso(
            (now or datetime.now(tz=UTC))
            - timedelta(days=self.unused_client_ttl_days)
        )

    def _prune_unused(self, *, conn: Any, cutoff: str, limit: int | None) -> int:
        """Delete unused registrations older than ``cutoff``, at most ``limit``.

        ``limit`` None is the full scheduled sweep; a number keeps the work a
        registration does on its own behalf bounded and predictable. The
        subquery form (rather than ``DELETE ... LIMIT``) is the one both
        dialects accept.
        """
        if limit is None:
            cursor = conn.execute(
                f"DELETE FROM oauth_clients WHERE {_UNUSED_CLIENT_PREDICATE}", (cutoff,)
            )
        else:
            cursor = conn.execute(
                f"""
                DELETE FROM oauth_clients WHERE client_id IN (
                  SELECT client_id FROM oauth_clients
                  WHERE {_UNUSED_CLIENT_PREDICATE}
                  ORDER BY created_at LIMIT ?
                )
                """,
                (cutoff, limit),
            )
        return max(0, int(getattr(cursor, "rowcount", 0) or 0))

    def insert_code(self, *, code: AuthorizationCode) -> None:
        with self._store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO oauth_authorization_codes (
                  code_digest, client_id, redirect_uri, owner_user_id, project_id,
                  grant_scope, code_challenge, resource, created_at, expires_at,
                  consumed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    code.code_digest,
                    code.client_id,
                    code.redirect_uri,
                    code.owner_user_id,
                    code.project_id,
                    code.grant_scope,
                    code.code_challenge,
                    code.resource,
                    code.created_at,
                    code.expires_at,
                    code.consumed_at,
                ),
            )

    def code_by_digest(self, *, digest: str) -> AuthorizationCode | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM oauth_authorization_codes WHERE code_digest = ?",
                (digest,),
            ).fetchone()
        data = row_to_dict(row=row)
        if data is None:
            return None
        return AuthorizationCode(
            code_digest=str(data["code_digest"]),
            client_id=str(data["client_id"]),
            redirect_uri=str(data["redirect_uri"]),
            owner_user_id=str(data["owner_user_id"]),
            project_id=str(data["project_id"]),
            grant_scope=str(data.get("grant_scope") or PROJECT_GRANT),
            code_challenge=str(data["code_challenge"]),
            resource=str(data["resource"]),
            created_at=str(data["created_at"]),
            expires_at=str(data["expires_at"]),
            consumed_at=(str(data["consumed_at"]) if data.get("consumed_at") else None),
        )

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
                """
                INSERT INTO oauth_refresh_tokens (
                  id, family_id, secret_digest, client_id, owner_user_id, project_id,
                  grant_scope, resource, current_key_id, parent_token_id,
                  created_at, expires_at, consumed_at, revoked_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token.id,
                    token.family_id,
                    token.secret_digest,
                    token.client_id,
                    token.owner_user_id,
                    token.project_id,
                    token.grant_scope,
                    token.resource,
                    token.current_key_id,
                    token.parent_token_id,
                    token.created_at,
                    token.expires_at,
                    token.consumed_at,
                    token.revoked_at,
                ),
            )

    def refresh_token_by_digest(self, *, digest: str) -> RefreshToken | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM oauth_refresh_tokens WHERE secret_digest = ?",
                (digest,),
            ).fetchone()
        return _refresh_token(row)

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
            conn.execute(
                """
                WITH RECURSIVE lineage(id) AS (
                  SELECT id FROM project_api_keys WHERE id = ?
                  UNION ALL
                  SELECT child.id FROM project_api_keys child
                  JOIN lineage parent ON child.parent_key_id = parent.id
                )
                UPDATE project_api_keys SET revoked_at = COALESCE(revoked_at, ?)
                WHERE id IN (SELECT id FROM lineage)
                  AND project_id = ? AND owner_user_id = ?
                """,
                (key_id, revoked_at, project_id, owner_user_id),
            )


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



def _refresh_token(row: Any) -> RefreshToken | None:
    data = row_to_dict(row=row)
    if data is None:
        return None
    return RefreshToken(
        id=str(data["id"]),
        family_id=str(data["family_id"]),
        secret_digest=str(data["secret_digest"]),
        client_id=str(data["client_id"]),
        owner_user_id=str(data["owner_user_id"]),
        project_id=str(data["project_id"]),
        grant_scope=str(data.get("grant_scope") or PROJECT_GRANT),
        resource=str(data["resource"]),
        current_key_id=str(data["current_key_id"]),
        parent_token_id=(
            str(data["parent_token_id"]) if data.get("parent_token_id") else None
        ),
        created_at=str(data["created_at"]),
        expires_at=str(data["expires_at"]),
        consumed_at=(str(data["consumed_at"]) if data.get("consumed_at") else None),
        revoked_at=(str(data["revoked_at"]) if data.get("revoked_at") else None),
    )


__all__ = ["SqlOAuthRepository"]


# -- schema ----------------------------------------------------------------

OAUTH_DDL = """\
-- OAuth 2.1 public DCR registrations (agent-anywhere Phase B). A repeated
-- registration with identical metadata resolves to the SAME client_id, so the
-- Cursor double-DCR race is safe without growing the table; registrations that
-- never authorized anything are swept by CleanupService. Only public clients
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


OAUTH_SCHEMA = SchemaModule(
    name="surface.oauth",
    ddl=OAUTH_DDL,
    migrations=(Migration(66, "drop_retired_oauth_tables", _drop_retired_oauth_tables),),
)
