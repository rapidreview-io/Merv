"""``mk_`` key lifecycle and verification policy.

A key's scope is immutable and is one of two shapes. A ``project`` grant binds
one project. An ``account`` grant authorizes every project its owner belongs
to, and its ``project_id`` names only the home project it is administered
from. The presented secret is returned once at mint and only its digest is
stored. There is no local/cloud profile: the key carries scope + audience +
(stored, unenforced) ceilings, nothing else. ``verify_secret`` reads the
database fresh on every call so a revoke is effective immediately (INV-4).
"""

from __future__ import annotations

from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from ..kernel.secret_tokens import hash_secret, mint_secret, secret_digest_matches
from ..kernel.state.store import BaseStateStore, Connection, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, new_id, now_iso, parse_iso

PROJECT_KEY_PREFIX = "mk_"

# A credential is confined to one project, or reaches its owner's whole
# membership. Mirrors the CHECK constraint on every credential table.
PROJECT_GRANT = "project"
ACCOUNT_GRANT = "account"
GRANT_SCOPES = (PROJECT_GRANT, ACCOUNT_GRANT)


@dataclass(frozen=True, slots=True)
class ProjectKeyRecord:
    id: str
    secret_digest: str
    owner_user_id: str
    tenant_id: str
    project_id: str
    grant_scope: str
    audience: str | None
    oauth_family_id: str | None
    created_at: str
    expires_at: str | None
    revoked_at: str | None
    parent_key_id: str | None
    sandbox_seconds_ceiling: int | None
    blob_bytes_ceiling: int | None
    label: str | None = None


# A presented digest must be exactly the stored form ``hash_secret`` produces.
_DIGEST_HEX_LENGTH = 64
MAX_LABEL_CHARS = 120


class ProjectKeyLookup(Protocol):
    def verify_secret(self, *, secret: str) -> ProjectKeyRecord | None: ...
    def active_record(self, *, key_id: str) -> ProjectKeyRecord | None: ...


class ProjectKeyControl(ProjectKeyLookup, Protocol):
    def create(self, **kwargs: object) -> dict[str, object]: ...
    def rotate(self, **kwargs: object) -> dict[str, object]: ...
    def revoke_lineage(self, **kwargs: object) -> dict[str, object]: ...
    def list(self, **kwargs: object) -> dict[str, object]: ...
    def revoke(self, **kwargs: object) -> dict[str, object]: ...


class ProjectKeys:
    """Mint, verify, rotate, list, and revoke project credentials."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self._store = store

    def create(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        expires_at: str | None = None,
        parent_key_id: str | None = None,
        sandbox_seconds_ceiling: int | None = None,
        blob_bytes_ceiling: int | None = None,
        audience: str | None = None,
        oauth_family_id: str | None = None,
        grant_scope: str = PROJECT_GRANT,
    ) -> dict[str, object]:
        record, secret = self._new_record(
            project_id=project_id,
            owner_user_id=owner_user_id,
            expires_at=expires_at,
            parent_key_id=parent_key_id,
            sandbox_seconds_ceiling=sandbox_seconds_ceiling,
            blob_bytes_ceiling=blob_bytes_ceiling,
            audience=audience,
            oauth_family_id=oauth_family_id,
            grant_scope=grant_scope,
        )
        self._insert(record)
        return {"key": _public_record(record), "secret": secret}

    def rotate(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        parent_key_id: str,
        expires_at: str | None = None,
        sandbox_seconds_ceiling: int | None = None,
        blob_bytes_ceiling: int | None = None,
        audience: str | None = None,
        oauth_family_id: str | None = None,
        grant_scope: str = PROJECT_GRANT,
    ) -> dict[str, object]:
        """Atomically revoke one active parent while inserting its child."""
        record, secret = self._new_record(
            project_id=project_id,
            owner_user_id=owner_user_id,
            expires_at=expires_at,
            parent_key_id=_required(parent_key_id, field="parent_key_id"),
            sandbox_seconds_ceiling=sandbox_seconds_ceiling,
            blob_bytes_ceiling=blob_bytes_ceiling,
            audience=audience,
            oauth_family_id=oauth_family_id,
            grant_scope=grant_scope,
        )
        if not self._rotate_record(record, revoked_at=now_iso()):
            raise NotFoundError(f"project key not found: {parent_key_id}")
        return {"key": _public_record(record), "secret": secret}

    def register_digest(
        self,
        *,
        conn: Connection,
        project_id: str,
        owner_user_id: str,
        secret_digest: str,
        label: str | None = None,
        grant_scope: str = PROJECT_GRANT,
        expires_at: str | None = None,
    ) -> ProjectKeyRecord:
        """Register a key whose secret was generated elsewhere (runner pairing).

        The caller owns the transaction: this executes on ``conn`` so it can
        compose with the pairing row update instead of opening a nested
        ``BEGIN IMMEDIATE``. Only the sha256 digest is ever received or stored,
        exactly like a minted key; the plaintext never touches the brain.
        """
        project_id = _required(project_id, field="project_id")
        owner_user_id = _required(owner_user_id, field="owner_user_id")
        digest = str(secret_digest or "").strip().lower()
        if len(digest) != _DIGEST_HEX_LENGTH or any(
            character not in "0123456789abcdef" for character in digest
        ):
            raise ValidationError(
                "secret_digest must be a sha256 hex digest",
                details={"field": "secret_digest"},
            )
        tenant_row = conn.execute(
            "SELECT tenant_id FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if tenant_row is None:
            raise NotFoundError(f"project not found: {project_id}")
        record = ProjectKeyRecord(
            id=new_id(prefix="mkey"),
            secret_digest=digest,
            owner_user_id=owner_user_id,
            tenant_id=str(tenant_row["tenant_id"]),
            project_id=project_id,
            grant_scope=_grant_scope(grant_scope),
            audience=None,
            oauth_family_id=None,
            created_at=now_iso(),
            expires_at=_expiry(expires_at),
            revoked_at=None,
            parent_key_id=None,
            sandbox_seconds_ceiling=None,
            blob_bytes_ceiling=None,
            label=_label(label),
        )
        conn.execute(_INSERT_SQL, _insert_params(record))
        return record

    def _new_record(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        expires_at: str | None,
        parent_key_id: str | None,
        sandbox_seconds_ceiling: int | None,
        blob_bytes_ceiling: int | None,
        audience: str | None,
        oauth_family_id: str | None,
        grant_scope: str,
    ) -> tuple[ProjectKeyRecord, str]:
        project_id = _required(project_id, field="project_id")
        owner_user_id = _required(owner_user_id, field="owner_user_id")
        grant_scope = _grant_scope(grant_scope)
        expires_at = _expiry(expires_at)
        sandbox_seconds_ceiling = _ceiling(
            sandbox_seconds_ceiling, field="sandbox_seconds_ceiling"
        )
        blob_bytes_ceiling = _ceiling(blob_bytes_ceiling, field="blob_bytes_ceiling")
        parent_key_id = str(parent_key_id or "").strip() or None
        if parent_key_id:
            parent = self._record_by_id(parent_key_id)
            if (
                parent is None
                or parent.project_id != project_id
                or parent.owner_user_id != owner_user_id
                # A rotation inherits scope; it can never widen or narrow it.
                or parent.grant_scope != grant_scope
            ):
                raise NotFoundError(f"project key not found: {parent_key_id}")
        secret = mint_secret(prefix=PROJECT_KEY_PREFIX, nbytes=32)
        record = ProjectKeyRecord(
            id=new_id(prefix="mkey"),
            secret_digest=hash_secret(secret),
            owner_user_id=owner_user_id,
            tenant_id=self._project_tenant(project_id),
            project_id=project_id,
            grant_scope=grant_scope,
            audience=str(audience or "").strip() or None,
            oauth_family_id=str(oauth_family_id or "").strip() or None,
            created_at=now_iso(),
            expires_at=expires_at,
            revoked_at=None,
            parent_key_id=parent_key_id,
            sandbox_seconds_ceiling=sandbox_seconds_ceiling,
            blob_bytes_ceiling=blob_bytes_ceiling,
        )
        return record, secret

    def list(self, *, project_id: str, owner_user_id: str) -> dict[str, object]:
        return {
            "keys": [
                _public_record(record)
                for record in self._records_for_owner(
                    _required(project_id, field="project_id"),
                    _required(owner_user_id, field="owner_user_id"),
                )
            ]
        }

    def revoke(
        self, *, project_id: str, key_id: str, owner_user_id: str
    ) -> dict[str, object]:
        """Revoke this key AND every rotation descendant of it.

        Revoking one row would not be a kill switch: OAuth refresh rotates the
        underlying key, so the id an owner just read may already have been
        superseded, and the live successor would survive. Killing the lineage
        also stops refresh, because rotation requires an unrevoked parent.
        """
        project_id = _required(project_id, field="project_id")
        key_id = _required(key_id, field="key_id")
        owner_user_id = _required(owner_user_id, field="owner_user_id")
        record = self._revoke_record(
            project_id,
            key_id,
            owner_user_id,
            revoked_at=now_iso(),
        )
        if record is None:
            raise NotFoundError(f"project key not found: {key_id}")
        self._revoke_lineage_rows(
            project_id,
            key_id,
            owner_user_id,
            revoked_at=now_iso(),
        )
        return {"key": _public_record(record)}

    def revoke_lineage(
        self, *, project_id: str, key_id: str, owner_user_id: str
    ) -> dict[str, object]:
        """Revoke one key and every rotation descendant in its grant lineage."""
        project_id = _required(project_id, field="project_id")
        key_id = _required(key_id, field="key_id")
        owner_user_id = _required(owner_user_id, field="owner_user_id")
        if not self._revoke_lineage_rows(
            project_id,
            key_id,
            owner_user_id,
            revoked_at=now_iso(),
        ):
            raise NotFoundError(f"project key not found: {key_id}")
        return {"revoked": True, "root_key_id": key_id}

    def verify_secret(self, *, secret: str) -> ProjectKeyRecord | None:
        """Resolve one bearer with a fresh database read on every call."""
        digest = hash_secret(secret)
        record = self._record_by_digest(digest)
        if not secret_digest_matches(
            stored_digest=record.secret_digest if record is not None else None,
            presented_digest=digest,
        ):
            return None
        if record is None or record.revoked_at:
            return None
        expiry = parse_iso(record.expires_at)
        if record.expires_at and expiry is None:
            return None
        if expiry is not None and expiry <= datetime.now(UTC):
            return None
        return record

    def active_record(self, *, key_id: str) -> ProjectKeyRecord | None:
        """Resolve delegated authority by id with the same fresh checks."""
        record = self._record_by_id(key_id)
        if record is None or record.revoked_at:
            return None
        expiry = parse_iso(record.expires_at)
        if record.expires_at and expiry is None:
            return None
        if expiry is not None and expiry <= datetime.now(UTC):
            return None
        return record

    def _project_tenant(self, project_id: str) -> str:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT tenant_id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"project not found: {project_id}")
        return str(row["tenant_id"])

    def _insert(self, record: ProjectKeyRecord) -> None:
        with self._store.transaction() as conn:
            conn.execute(_INSERT_SQL, _insert_params(record))

    def _rotate_record(self, record: ProjectKeyRecord, *, revoked_at: str) -> bool:
        with self._store.transaction() as conn:
            parent = conn.execute(
                """
                SELECT id FROM project_api_keys
                WHERE id = ? AND project_id = ? AND owner_user_id = ?
                  AND revoked_at IS NULL
                """,
                (record.parent_key_id, record.project_id, record.owner_user_id),
            ).fetchone()
            if parent is None:
                return False
            conn.execute(_INSERT_SQL, _insert_params(record))
            conn.execute(
                "UPDATE project_api_keys SET revoked_at = ? WHERE id = ?",
                (revoked_at, record.parent_key_id),
            )
        return True

    def _record_by_digest(self, digest: str) -> ProjectKeyRecord | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM project_api_keys WHERE secret_digest = ?", (digest,)
            ).fetchone()
        return _record(row)

    def _record_by_id(self, key_id: str) -> ProjectKeyRecord | None:
        with closing(self._store.connect()) as conn:
            row = conn.execute(
                "SELECT * FROM project_api_keys WHERE id = ?", (key_id,)
            ).fetchone()
        return _record(row)

    def _records_for_owner(
        self, project_id: str, owner_user_id: str
    ) -> list[ProjectKeyRecord]:
        with closing(self._store.connect()) as conn:
            rows = conn.execute(
                """
                SELECT * FROM project_api_keys
                WHERE project_id = ? AND owner_user_id = ?
                ORDER BY created_at, id
                """,
                (project_id, owner_user_id),
            ).fetchall()
        return [record for row in rows if (record := _record(row)) is not None]

    def _revoke_record(
        self,
        project_id: str,
        key_id: str,
        owner_user_id: str,
        *,
        revoked_at: str,
    ) -> ProjectKeyRecord | None:
        with self._store.transaction() as conn:
            row = conn.execute(
                """
                SELECT * FROM project_api_keys
                WHERE id = ? AND project_id = ? AND owner_user_id = ?
                """,
                (key_id, project_id, owner_user_id),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE project_api_keys SET revoked_at = COALESCE(revoked_at, ?)
                WHERE id = ?
                """,
                (revoked_at, key_id),
            )
            updated = conn.execute(
                "SELECT * FROM project_api_keys WHERE id = ?", (key_id,)
            ).fetchone()
        return _record(updated)

    def _revoke_lineage_rows(
        self,
        project_id: str,
        key_id: str,
        owner_user_id: str,
        *,
        revoked_at: str,
    ) -> bool:
        with self._store.transaction() as conn:
            root = conn.execute(
                """
                SELECT id FROM project_api_keys
                WHERE id = ? AND project_id = ? AND owner_user_id = ?
                """,
                (key_id, project_id, owner_user_id),
            ).fetchone()
            if root is None:
                return False
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
        return True


_INSERT_SQL = """
INSERT INTO project_api_keys (
  id, secret_digest, owner_user_id, tenant_id, project_id, grant_scope,
  audience, oauth_family_id, created_at, expires_at, revoked_at, parent_key_id,
  sandbox_seconds_ceiling, blob_bytes_ceiling, label
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _insert_params(record: ProjectKeyRecord) -> tuple[Any, ...]:
    return (
        record.id,
        record.secret_digest,
        record.owner_user_id,
        record.tenant_id,
        record.project_id,
        record.grant_scope,
        record.audience,
        record.oauth_family_id,
        record.created_at,
        record.expires_at,
        record.revoked_at,
        record.parent_key_id,
        record.sandbox_seconds_ceiling,
        record.blob_bytes_ceiling,
        record.label,
    )


def _label(value: object) -> str | None:
    text = " ".join(str(value or "").split())
    if not text:
        return None
    if len(text) > MAX_LABEL_CHARS:
        raise ValidationError(
            f"label must be at most {MAX_LABEL_CHARS} characters",
            details={"field": "label"},
        )
    return text


def _record(row: Any) -> ProjectKeyRecord | None:
    data = row_to_dict(row=row)
    if data is None:
        return None
    return ProjectKeyRecord(
        id=str(data["id"]),
        secret_digest=str(data["secret_digest"]),
        owner_user_id=str(data["owner_user_id"]),
        tenant_id=str(data["tenant_id"]),
        project_id=str(data["project_id"]),
        grant_scope=str(data.get("grant_scope") or PROJECT_GRANT),
        audience=str(data["audience"]) if data.get("audience") else None,
        oauth_family_id=(
            str(data["oauth_family_id"]) if data.get("oauth_family_id") else None
        ),
        created_at=str(data["created_at"]),
        expires_at=str(data["expires_at"]) if data.get("expires_at") else None,
        revoked_at=str(data["revoked_at"]) if data.get("revoked_at") else None,
        parent_key_id=(
            str(data["parent_key_id"]) if data.get("parent_key_id") else None
        ),
        sandbox_seconds_ceiling=(
            int(data["sandbox_seconds_ceiling"])
            if data.get("sandbox_seconds_ceiling") is not None
            else None
        ),
        blob_bytes_ceiling=(
            int(data["blob_bytes_ceiling"])
            if data.get("blob_bytes_ceiling") is not None
            else None
        ),
        label=str(data["label"]) if data.get("label") else None,
    )


def _public_record(record: ProjectKeyRecord) -> dict[str, object]:
    result = asdict(record)
    result.pop("secret_digest")
    result.pop("audience")
    result.pop("oauth_family_id")
    return result


def public_key_record(record: ProjectKeyRecord) -> dict[str, object]:
    """The non-secret projection other surface components may return."""
    return _public_record(record)


def _grant_scope(value: object) -> str:
    text = str(value or "").strip() or PROJECT_GRANT
    if text not in GRANT_SCOPES:
        raise ValidationError(
            f"grant_scope must be one of {', '.join(GRANT_SCOPES)}",
            details={"field": "grant_scope"},
        )
    return text


def _required(value: object, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValidationError(f"{field} is required", details={"field": field})
    return text


def _ceiling(value: object, *, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValidationError(f"{field} must be a nonnegative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{field} must be a nonnegative integer") from exc
    if parsed < 0:
        raise ValidationError(f"{field} must be a nonnegative integer")
    return parsed


def _expiry(value: object) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    parsed = parse_iso(text)
    if parsed is None:
        raise ValidationError(
            "expires_at must be an ISO-8601 timestamp", details={"field": "expires_at"}
        )
    if parsed <= datetime.now(UTC):
        raise ValidationError(
            "expires_at must be in the future", details={"field": "expires_at"}
        )
    return text


__all__ = [
    "ACCOUNT_GRANT",
    "GRANT_SCOPES",
    "PROJECT_GRANT",
    "PROJECT_KEY_PREFIX",
    "ProjectKeyControl",
    "ProjectKeyLookup",
    "ProjectKeyRecord",
    "ProjectKeys",
]
