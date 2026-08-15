"""Device-code pairing of an auto-run runner machine to one project.

The runner generates its own ``mk_`` key and never sends the plaintext: it
presents the sha256 digest when it asks for a pairing code, an owner approves
that code from Settings, and approval registers the digest as a project key
through ``ProjectKeys.register_digest`` inside the pairing transaction. The
runner then learns its project on its next poll and starts heartbeating with
the key it already holds. No browser ever addresses the runner machine.

Shape (RFC 8628 device authorization, trimmed):

- ``create``  → ``{device_code, user_code, interval, expires_in}``. The
  ``device_code`` is a 256-bit secret only the runner knows; only its digest is
  stored. The ``user_code`` is 8 Crockford-base32 characters (40 bits) that a
  human types into Settings.
- ``token``   → pending while unapproved; the approved payload for a short
  window after approval so a lost response or a runner crash before its local
  commit cannot strand a registered key; gone afterwards.
- ``approve`` → owner-only; misses are counted per principal so a code space
  cannot be sprayed by an authenticated attacker.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
import json
from typing import Any, Mapping

from ..kernel.secret_tokens import hash_secret, secret_digest_matches
from ..kernel.state.store import BaseStateStore
from ..kernel.utils import (
    GoneError,
    NotFoundError,
    ThrottledError,
    ValidationError,
    format_iso,
    new_id,
    parse_iso,
)
from .project_keys import PROJECT_GRANT, ProjectKeys, public_key_record

# Crockford base32 minus I, L, O, U: unambiguous when read aloud or typed.
USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
USER_CODE_LENGTH = 8  # 32^8 = 2^40
DEVICE_CODE_BYTES = 32
PAIRING_TTL_SECONDS = 10 * 60
APPROVED_READ_WINDOW_SECONDS = 10 * 60
POLL_INTERVAL_SECONDS = 5
CREATE_PER_IP_PER_MINUTE = 10
PENDING_PER_IP = 5
PENDING_GLOBAL_CAP = 1000
APPROVAL_MISS_LIMIT = 10
APPROVAL_MISS_WINDOW_SECONDS = 10 * 60
MAX_MACHINE_BYTES = 4 * 1024
_DIGEST_HEX_LENGTH = 64


class RunnerPairings:
    """Own the pairing exchange rows; ``ProjectKeys`` owns the key record."""

    def __init__(self, *, store: BaseStateStore, project_keys: ProjectKeys) -> None:
        self._store = store
        self._keys = project_keys

    # -- runner side --------------------------------------------------------

    def create(
        self,
        *,
        key_digest: str,
        runner_id: str,
        machine: Mapping[str, Any] | None,
        client_ip: str,
    ) -> dict[str, Any]:
        digest = _digest(key_digest, field="key_digest")
        runner_id = _required(runner_id, field="runner_id", limit=160)
        client_ip = str(client_ip or "").strip()[:64]
        machine_json = _machine_json(machine)
        now = datetime.now(UTC)
        device_code = secrets.token_urlsafe(DEVICE_CODE_BYTES)
        with self._store.transaction() as tx:
            self._sweep(tx=tx, now=now)
            recent = tx.execute(
                """
                SELECT COUNT(*) AS n FROM agent_runner_pairings
                WHERE client_ip = ? AND created_at > ?
                """,
                (client_ip, format_iso(now - timedelta(minutes=1))),
            ).fetchone()
            pending_ip = tx.execute(
                """
                SELECT COUNT(*) AS n FROM agent_runner_pairings
                WHERE client_ip = ? AND status = 'pending'
                """,
                (client_ip,),
            ).fetchone()
            pending_all = tx.execute(
                "SELECT COUNT(*) AS n FROM agent_runner_pairings WHERE status = 'pending'"
            ).fetchone()
            if (
                int(recent["n"]) >= CREATE_PER_IP_PER_MINUTE
                or int(pending_ip["n"]) >= PENDING_PER_IP
                or int(pending_all["n"]) >= PENDING_GLOBAL_CAP
            ):
                raise ThrottledError(
                    "too many pairing requests; wait a minute and try again",
                    details={"retry_after_seconds": 60},
                )
            existing = tx.execute(
                "SELECT status FROM agent_runner_pairings WHERE key_digest = ?",
                (digest,),
            ).fetchone()
            if existing is not None:
                # A digest that already went through pairing (any state) is
                # not reusable; the runner generates a fresh key per exchange.
                raise ValidationError(
                    "key_digest was already used for a pairing exchange",
                    details={"field": "key_digest"},
                )
            for _attempt in range(8):
                user_code = "".join(
                    secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH)
                )
                inserted = tx.execute(
                    """
                    INSERT INTO agent_runner_pairings (
                      id, device_code_digest, user_code, key_digest, runner_id,
                      machine_json, status, client_ip, created_at, expires_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                    ON CONFLICT (user_code) DO NOTHING
                    RETURNING id
                    """,
                    (
                        new_id(prefix="arp"),
                        hash_secret(device_code),
                        user_code,
                        digest,
                        runner_id,
                        machine_json,
                        client_ip,
                        format_iso(now),
                        format_iso(now + timedelta(seconds=PAIRING_TTL_SECONDS)),
                    ),
                ).fetchone()
                if inserted is not None:
                    break
            else:  # pragma: no cover - 8 consecutive 40-bit collisions
                raise ThrottledError("could not allocate a pairing code; retry")
        return {
            "device_code": device_code,
            "user_code": user_code,
            "interval": POLL_INTERVAL_SECONDS,
            "expires_in": PAIRING_TTL_SECONDS,
        }

    def token(self, *, device_code: str) -> dict[str, Any]:
        """Return ``{status: pending}`` or the approved payload; raise when gone."""
        presented = str(device_code or "").strip()
        if not presented:
            raise ValidationError("device_code is required", details={"field": "device_code"})
        digest = hash_secret(presented)
        now = datetime.now(UTC)
        with self._store.transaction() as tx:
            self._sweep(tx=tx, now=now)
            row = tx.execute(
                """
                SELECT p.id, p.device_code_digest, p.status, p.runner_id, p.project_id,
                       p.key_id, p.expires_at, p.approved_at, p.consumed_at,
                       (SELECT name FROM projects WHERE id = p.project_id) AS project_name
                FROM agent_runner_pairings p
                WHERE p.device_code_digest = ?
                """,
                (digest,),
            ).fetchone()
            if row is None or not secret_digest_matches(
                stored_digest=row["device_code_digest"], presented_digest=digest
            ):
                raise GoneError("unknown or expired pairing", details={"reason": "unknown"})
            status = str(row["status"])
            if status == "pending":
                return {"status": "pending", "interval": POLL_INTERVAL_SECONDS}
            if status in ("approved", "consumed"):
                approved_at = parse_iso(row["approved_at"])
                if approved_at is None or now > approved_at + timedelta(
                    seconds=APPROVED_READ_WINDOW_SECONDS
                ):
                    tx.execute(
                        "UPDATE agent_runner_pairings SET status = 'expired' WHERE id = ?",
                        (row["id"],),
                    )
                    raise GoneError(
                        "pairing approval window passed", details={"reason": "consumed"}
                    )
                if status == "approved":
                    tx.execute(
                        """
                        UPDATE agent_runner_pairings
                        SET status = 'consumed', consumed_at = ?
                        WHERE id = ? AND status = 'approved'
                        """,
                        (format_iso(now), row["id"]),
                    )
                key_id = str(row["key_id"] or "")
                return {
                    "status": "approved",
                    "project_id": str(row["project_id"] or ""),
                    "project_name": str(row["project_name"] or ""),
                    "runner_id": f"key:{key_id}/{row['runner_id']}",
                    "key_id": key_id,
                }
        raise GoneError("pairing expired", details={"reason": "expired"})

    # -- owner side ---------------------------------------------------------

    def approve(
        self,
        *,
        project_id: str,
        user_code: str,
        owner_user_id: str,
        principal_label: str,
    ) -> dict[str, Any]:
        project_id = _required(project_id, field="project_id", limit=160)
        owner_user_id = _required(owner_user_id, field="owner_user_id", limit=160)
        principal_label = _required(principal_label, field="principal", limit=240)
        # A malformed code is a client error, not a guess: it never touches the
        # miss counter and never reveals anything about pending exchanges.
        code = _normalize_user_code(user_code)
        now = datetime.now(UTC)
        window_start = format_iso(now - timedelta(seconds=APPROVAL_MISS_WINDOW_SECONDS))
        with self._store.transaction() as tx:
            self._sweep(tx=tx, now=now)
            tx.execute(
                "DELETE FROM agent_runner_pairing_attempts WHERE attempted_at <= ?",
                (window_start,),
            )
            misses = tx.execute(
                """
                SELECT COUNT(*) AS n FROM agent_runner_pairing_attempts
                WHERE principal = ? AND attempted_at > ?
                """,
                (principal_label, window_start),
            ).fetchone()
            throttled = int(misses["n"]) >= APPROVAL_MISS_LIMIT
            row = (
                None
                if throttled
                else tx.execute(
                    """
                    SELECT id, key_digest, runner_id, machine_json, status, expires_at
                    FROM agent_runner_pairings
                    WHERE user_code = ?
                    """,
                    (code,),
                ).fetchone()
            )
            missed = not throttled and (row is None or str(row["status"]) != "pending")
            if missed:
                # Committed by this transaction even though the call fails, so
                # the counter survives the raise below.
                tx.execute(
                    "INSERT INTO agent_runner_pairing_attempts (principal, attempted_at) "
                    "VALUES (?, ?)",
                    (principal_label, format_iso(now)),
                )
            if throttled or missed:
                row = None
            else:
                approved = self._approve_row(
                    tx=tx,
                    row=row,
                    project_id=project_id,
                    owner_user_id=owner_user_id,
                    now=now,
                )
        if throttled:
            raise ThrottledError(
                "too many failed pairing attempts; wait before trying again",
                details={"retry_after_seconds": APPROVAL_MISS_WINDOW_SECONDS},
            )
        if missed:
            raise NotFoundError(
                "no pending pairing with that code", details={"field": "user_code"}
            )
        return approved

    def _approve_row(
        self,
        *,
        tx: Any,
        row: Any,
        project_id: str,
        owner_user_id: str,
        now: datetime,
    ) -> dict[str, Any]:
        """Register the digest and flip the row, on the caller's transaction."""
        machine = _json_object(row["machine_json"])
        hostname = str(machine.get("hostname") or "").strip() or "runner"
        record = self._keys.register_digest(
            conn=tx,
            project_id=project_id,
            owner_user_id=owner_user_id,
            secret_digest=str(row["key_digest"]),
            label=f"auto-run · {hostname}",
            grant_scope=PROJECT_GRANT,
        )
        tx.execute(
            """
            UPDATE agent_runner_pairings
            SET status = 'approved', project_id = ?, key_id = ?,
                approved_by = ?, approved_at = ?
            WHERE id = ? AND status = 'pending'
            """,
            (project_id, record.id, owner_user_id, format_iso(now), row["id"]),
        )
        return {
            "key": public_key_record(record),
            "runner_id": f"key:{record.id}/{row['runner_id']}",
            "machine": machine,
        }

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _sweep(*, tx: Any, now: datetime) -> None:
        tx.execute(
            """
            UPDATE agent_runner_pairings SET status = 'expired'
            WHERE status = 'pending' AND expires_at <= ?
            """,
            (format_iso(now),),
        )


def _required(value: object, *, field: str, limit: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValidationError(f"{field} is required", details={"field": field})
    if len(text) > limit:
        raise ValidationError(f"{field} is too long", details={"field": field})
    return text


def _digest(value: object, *, field: str) -> str:
    text = str(value or "").strip().lower()
    if len(text) != _DIGEST_HEX_LENGTH or any(c not in "0123456789abcdef" for c in text):
        raise ValidationError(
            f"{field} must be a sha256 hex digest", details={"field": field}
        )
    return text


def _normalize_user_code(value: object) -> str:
    text = "".join(
        character
        for character in str(value or "").upper()
        if character not in " -_\t\r\n"
    )
    # Common transcription slips map onto their Crockford equivalents.
    text = text.replace("I", "1").replace("L", "1").replace("O", "0")
    if len(text) != USER_CODE_LENGTH or any(c not in USER_CODE_ALPHABET for c in text):
        raise ValidationError(
            "user_code must be the 8-character code shown by the runner",
            details={"field": "user_code"},
        )
    return text


def _machine_json(machine: Mapping[str, Any] | None) -> str:
    payload = {
        name: str(machine.get(name) or "").strip()[:240]
        for name in ("hostname", "system", "architecture")
        if isinstance(machine, Mapping) and str(machine.get(name) or "").strip()
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_MACHINE_BYTES:
        raise ValidationError("machine description is too large", details={"field": "machine"})
    return encoded


def _json_object(value: object) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def format_user_code(code: str) -> str:
    """``7Q2KM4B9`` → ``7Q2K-M4B9`` for display."""
    return f"{code[:4]}-{code[4:]}" if len(code) == USER_CODE_LENGTH else code


__all__ = ["RunnerPairings", "format_user_code"]
