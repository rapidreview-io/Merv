"""SQL adapter for Surface-owned OAuth state."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Any

from ..kernel.env import env_int
from ..kernel.secret_tokens import secret_digest_matches
from ..kernel.state.fingerprints import oauth_client_fingerprint
from ..kernel.state.store import BaseStateStore, row_to_dict
from ..kernel.utils import ThrottledError, format_iso, parse_iso
from .oauth import (
    CAP_EVICTION_LIMIT,
    DEFAULT_MAX_CLIENTS,
    DEFAULT_UNUSED_CLIENT_TTL_DAYS,
    DEVICE_CREATE_PER_IP_PER_MINUTE,
    DEVICE_MISS_LIMIT,
    DEVICE_MISS_WINDOW_SECONDS,
    DEVICE_PENDING_GLOBAL_CAP,
    DEVICE_PENDING_PER_IP,
    MAX_CLIENTS_ENV_VAR,
    OPPORTUNISTIC_PRUNE_LIMIT,
    UNUSED_CLIENT_TTL_DAYS_ENV_VAR,
    AuthorizationCode,
    DeviceGrant,
    OAuthClient,
    OAuthError,
    RefreshToken,
)
from .project_keys import PROJECT_GRANT

LOGGER = logging.getLogger(__name__)


def _json_list(values: tuple[str, ...] | list[str]) -> str:
    return json.dumps(list(values), separators=(",", ":"))


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
  AND client_id NOT IN (SELECT client_id FROM oauth_device_grants)
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

        Identity is the canonical metadata fingerprint carrying migration 38's
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

    # -- device authorization grants (RFC 8628) -----------------------------

    def create_device_grant(
        self, *, grant: DeviceGrant, user_codes: Callable[[], str]
    ) -> str:
        """Insert a pending grant under the runner-pairing rate budgets.

        ``user_codes`` yields candidate codes so the secret material stays in
        policy; the unique index arbitrates collisions inside the transaction.
        """
        now = datetime.now(UTC)
        with self._store.transaction() as conn:
            self._sweep_device_grants(conn=conn, now=now)
            recent = conn.execute(
                """
                SELECT COUNT(*) AS n FROM oauth_device_grants
                WHERE client_ip = ? AND created_at > ?
                """,
                (grant.client_ip, format_iso(now - timedelta(minutes=1))),
            ).fetchone()
            pending_ip = conn.execute(
                """
                SELECT COUNT(*) AS n FROM oauth_device_grants
                WHERE client_ip = ? AND status = 'pending'
                """,
                (grant.client_ip,),
            ).fetchone()
            pending_all = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_device_grants WHERE status = 'pending'"
            ).fetchone()
            if (
                int(recent["n"]) >= DEVICE_CREATE_PER_IP_PER_MINUTE
                or int(pending_ip["n"]) >= DEVICE_PENDING_PER_IP
                or int(pending_all["n"]) >= DEVICE_PENDING_GLOBAL_CAP
            ):
                raise ThrottledError(
                    "too many device authorization requests; wait a minute and "
                    "try again",
                    details={"retry_after_seconds": 60},
                )
            for _attempt in range(8):
                user_code = user_codes()
                inserted = conn.execute(
                    """
                    INSERT INTO oauth_device_grants (
                      id, device_code_digest, user_code, client_id, resource,
                      status, client_ip, created_at, expires_at
                    )
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                    ON CONFLICT (user_code) DO NOTHING
                    RETURNING user_code
                    """,
                    (
                        grant.id,
                        grant.device_code_digest,
                        user_code,
                        grant.client_id,
                        grant.resource,
                        grant.client_ip,
                        grant.created_at,
                        grant.expires_at,
                    ),
                ).fetchone()
                if inserted is not None:
                    return str(inserted["user_code"])
            # 8 consecutive 40-bit collisions.
            raise ThrottledError(  # pragma: no cover
                "could not allocate a device code; retry"
            )

    def device_grant_for_consent(
        self, *, user_code: str, principal: str
    ) -> DeviceGrant | None:
        grant, throttled, missed = self._consent_lookup(
            user_code=user_code, principal=principal
        )
        if throttled:
            raise ThrottledError(
                "too many failed device-code attempts; wait before trying again",
                details={"retry_after_seconds": DEVICE_MISS_WINDOW_SECONDS},
            )
        return None if missed else grant

    def decide_device_grant(
        self,
        *,
        user_code: str,
        principal: str,
        approved: bool,
        owner_user_id: str,
        project_id: str,
        grant_scope: str,
    ) -> DeviceGrant | None:
        now = datetime.now(UTC)
        grant, throttled, missed = self._consent_lookup(
            user_code=user_code, principal=principal
        )
        if throttled:
            raise ThrottledError(
                "too many failed device-code attempts; wait before trying again",
                details={"retry_after_seconds": DEVICE_MISS_WINDOW_SECONDS},
            )
        if missed or grant is None:
            return None
        with self._store.transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE oauth_device_grants
                SET status = ?, owner_user_id = ?, project_id = ?,
                    grant_scope = ?, decided_at = ?
                WHERE id = ? AND status = 'pending'
                """,
                (
                    "approved" if approved else "denied",
                    owner_user_id,
                    project_id or None,
                    grant_scope or None,
                    format_iso(now),
                    grant.id,
                ),
            )
            if int(getattr(cursor, "rowcount", 0) or 0) != 1:
                # A concurrent decision or the expiry sweep won; the caller's
                # code no longer names a pending grant.
                return None
        return grant

    def poll_device_grant(
        self, *, digest: str, client_id: str, interval_seconds: int
    ) -> tuple[str, DeviceGrant | None]:
        now = datetime.now(UTC)
        with self._store.transaction() as conn:
            self._sweep_device_grants(conn=conn, now=now)
            row = conn.execute(
                "SELECT * FROM oauth_device_grants WHERE device_code_digest = ?",
                (digest,),
            ).fetchone()
            grant = _device_grant(row)
            if (
                grant is None
                or not secret_digest_matches(
                    stored_digest=grant.device_code_digest, presented_digest=digest
                )
                or grant.client_id != client_id
            ):
                return ("unknown", None)
            if grant.status == "pending":
                last = (
                    parse_iso(grant.last_polled_at) if grant.last_polled_at else None
                )
                conn.execute(
                    "UPDATE oauth_device_grants SET last_polled_at = ? WHERE id = ?",
                    (format_iso(now), grant.id),
                )
                if last is not None and now < last + timedelta(
                    seconds=interval_seconds
                ):
                    return ("slow_down", None)
                return ("pending", None)
            if grant.status == "denied":
                return ("denied", None)
            if grant.status == "expired":
                return ("expired", None)
            if grant.status == "approved":
                cursor = conn.execute(
                    """
                    UPDATE oauth_device_grants
                    SET status = 'consumed', consumed_at = ?
                    WHERE id = ? AND status = 'approved'
                    """,
                    (format_iso(now), grant.id),
                )
                # The compare-and-set is what makes the exchange one-shot: a
                # concurrent poll that lost the race must not mint a second
                # bearer from the same approval.
                if int(getattr(cursor, "rowcount", 0) or 0) != 1:
                    return ("unknown", None)
                return ("approved", grant)
            # 'consumed': a replayed device code after a successful exchange.
            return ("unknown", None)

    def _consent_lookup(
        self, *, user_code: str, principal: str
    ) -> tuple[DeviceGrant | None, bool, bool]:
        """Resolve a typed code to its pending grant, counting misses.

        Mirrors runner pairing exactly: the miss row is committed by this
        transaction even though the caller then fails, so the counter survives
        the raise; a throttled principal never learns whether a code exists.
        """
        now = datetime.now(UTC)
        window_start = format_iso(
            now - timedelta(seconds=DEVICE_MISS_WINDOW_SECONDS)
        )
        with self._store.transaction() as conn:
            self._sweep_device_grants(conn=conn, now=now)
            conn.execute(
                "DELETE FROM oauth_device_grant_attempts WHERE attempted_at <= ?",
                (window_start,),
            )
            misses = conn.execute(
                """
                SELECT COUNT(*) AS n FROM oauth_device_grant_attempts
                WHERE principal = ? AND attempted_at > ?
                """,
                (principal, window_start),
            ).fetchone()
            throttled = int(misses["n"]) >= DEVICE_MISS_LIMIT
            row = (
                None
                if throttled
                else conn.execute(
                    "SELECT * FROM oauth_device_grants WHERE user_code = ?",
                    (user_code,),
                ).fetchone()
            )
            grant = _device_grant(row)
            missed = not throttled and (grant is None or grant.status != "pending")
            if missed:
                conn.execute(
                    "INSERT INTO oauth_device_grant_attempts "
                    "(principal, attempted_at) VALUES (?, ?)",
                    (principal, format_iso(now)),
                )
        return (None if missed else grant, throttled, missed)

    @staticmethod
    def _sweep_device_grants(*, conn: Any, now: datetime) -> None:
        conn.execute(
            """
            UPDATE oauth_device_grants SET status = 'expired'
            WHERE status IN ('pending', 'approved') AND expires_at <= ?
            """,
            (format_iso(now),),
        )
        # A row a day past expiry holds nothing revocable — the device code is
        # useless and any minted bearer lives in project_api_keys — so delete
        # it and keep the table bounded without anyone scheduling a sweep.
        conn.execute(
            "DELETE FROM oauth_device_grants WHERE expires_at <= ?",
            (format_iso(now - timedelta(days=1)),),
        )

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


def _device_grant(row: Any) -> DeviceGrant | None:
    data = row_to_dict(row=row)
    if data is None:
        return None
    return DeviceGrant(
        id=str(data["id"]),
        device_code_digest=str(data["device_code_digest"]),
        user_code=str(data["user_code"]),
        client_id=str(data["client_id"]),
        resource=str(data["resource"]),
        status=str(data["status"]),
        owner_user_id=(
            str(data["owner_user_id"]) if data.get("owner_user_id") else None
        ),
        project_id=(str(data["project_id"]) if data.get("project_id") else None),
        grant_scope=(str(data["grant_scope"]) if data.get("grant_scope") else None),
        client_ip=str(data.get("client_ip") or ""),
        created_at=str(data["created_at"]),
        expires_at=str(data["expires_at"]),
        last_polled_at=(
            str(data["last_polled_at"]) if data.get("last_polled_at") else None
        ),
        decided_at=(str(data["decided_at"]) if data.get("decided_at") else None),
        consumed_at=(str(data["consumed_at"]) if data.get("consumed_at") else None),
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
