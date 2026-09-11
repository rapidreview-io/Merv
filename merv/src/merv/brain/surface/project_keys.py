"""``mk_`` key lifecycle and verification policy.

A key's scope is immutable and is one of two shapes. A ``project`` grant binds
one project. An ``account`` grant authorizes every project its owner belongs
to, and its ``project_id`` names only the home project it is administered
from. The presented secret is returned once at mint and only its digest is
stored. The key carries research scope and audience; infrastructure allowances
belong to the independent sandbox service. ``verify_secret`` reads the
database fresh on every call so a revoke is effective immediately (INV-4).
"""

from __future__ import annotations

from contextlib import closing
from dataclasses import asdict, astuple, dataclass, fields
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from ..kernel.secret_tokens import hash_secret, mint_secret
from ..kernel.state.schema import SchemaModule
from ..kernel.retention import RETENTION_BATCH_ROWS, drain
from ..kernel.state.store import BaseStateStore, Connection, deleted_rows, row_to_dict
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    format_iso,
    new_id,
    now_iso,
    parse_iso,
)

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
    label: str | None = None


# OAuth mints a fresh access key every hour and revokes the one before it, so
# rotation exhaust — not the keys an owner minted — is what grows this table. A
# dead one is kept a month, then goes once nothing can still reach it.
OAUTH_KEY_RETENTION_DAYS = 30

# A presented digest must be exactly the stored form ``hash_secret`` produces.
_DIGEST_HEX_LENGTH = 64
MAX_LABEL_CHARS = 120


class ProjectKeyLookup(Protocol):
    def verify_secret(self, *, secret: str) -> ProjectKeyRecord | None: ...
    def active_record(self, *, key_id: str) -> ProjectKeyRecord | None: ...


class ProjectKeyControl(ProjectKeyLookup, Protocol):
    def create(self, **kwargs: object) -> dict[str, object]: ...
    def rotate(self, **kwargs: object) -> dict[str, object]: ...
    def list(self, **kwargs: object) -> dict[str, object]: ...
    def revoke(self, **kwargs: object) -> dict[str, object]: ...


class ProjectKeys:
    """Mint, verify, rotate, list, and revoke project credentials."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self._store = store
        store.install(PROJECT_KEY_SCHEMA)

    def create(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        expires_at: str | None = None,
        parent_key_id: str | None = None,
        audience: str | None = None,
        oauth_family_id: str | None = None,
        grant_scope: str = PROJECT_GRANT,
    ) -> dict[str, object]:
        record, secret = self._new_record(
            project_id=project_id,
            owner_user_id=owner_user_id,
            expires_at=expires_at,
            parent_key_id=parent_key_id,
            audience=audience,
            oauth_family_id=oauth_family_id,
            grant_scope=grant_scope,
        )
        self._insert(record)
        return {"key": public_key_record(record), "secret": secret}

    def rotate(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        parent_key_id: str,
        expires_at: str | None = None,
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
            audience=audience,
            oauth_family_id=oauth_family_id,
            grant_scope=grant_scope,
        )
        if not self._rotate_record(record, revoked_at=now_iso()):
            raise NotFoundError(f"project key not found: {parent_key_id}")
        return {"key": public_key_record(record), "secret": secret}

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
            label=_label(label),
        )
        conn.execute(_INSERT_SQL, astuple(record))
        return record

    def _new_record(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        expires_at: str | None,
        parent_key_id: str | None,
        audience: str | None,
        oauth_family_id: str | None,
        grant_scope: str,
    ) -> tuple[ProjectKeyRecord, str]:
        project_id = _required(project_id, field="project_id")
        owner_user_id = _required(owner_user_id, field="owner_user_id")
        grant_scope = _grant_scope(grant_scope)
        expires_at = _expiry(expires_at)
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
        )
        return record, secret

    def list(self, *, project_id: str, owner_user_id: str) -> dict[str, object]:
        return {
            "keys": [
                public_key_record(record)
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
        with self._store.transaction() as conn:
            revoked = revoke_key_lineage(
                conn, project_id=project_id, key_id=key_id,
                owner_user_id=owner_user_id, revoked_at=now_iso(),
            )
            if not revoked:
                raise NotFoundError(f"project key not found: {key_id}")
            record = _record(conn.execute(
                "SELECT * FROM project_api_keys WHERE id = ?", (key_id,)
            ).fetchone())
        return {"key": public_key_record(record)}

    def prune(self, *, now: datetime | None = None) -> int:
        """Delete dead OAuth-minted keys nothing can still reach.

        Direct ``mk_`` keys are never deleted, revoked or not: there is one row
        per key an owner minted, and it is the owner's visible record that they
        minted and killed it. A rotated key goes only once no refresh token
        names it as current and no child names it as parent, so neither a live
        grant nor a lineage walk can lose its footing. A chain therefore drains
        from its newest end, one link per batch, and only once its family has
        expired: an always-on grant keeps every link parented.
        """
        cutoff = format_iso(
            (now or datetime.now(UTC)) - timedelta(days=OAUTH_KEY_RETENTION_DAYS)
        )

        def batch() -> int:
            with self._store.transaction() as conn:
                return deleted_rows(conn.execute(
                    """
                    DELETE FROM project_api_keys WHERE id IN (
                      SELECT id FROM project_api_keys
                      WHERE oauth_family_id IS NOT NULL
                        AND expires_at < ? AND (revoked_at IS NULL OR revoked_at < ?)
                        AND id NOT IN (SELECT current_key_id FROM oauth_refresh_tokens)
                        AND id NOT IN (
                          SELECT parent_key_id FROM project_api_keys
                          WHERE parent_key_id IS NOT NULL
                        )
                      ORDER BY expires_at LIMIT ?
                    )
                    """,
                    (cutoff, cutoff, RETENTION_BATCH_ROWS),
                ))

        return drain(batch)

    def verify_secret(self, *, secret: str) -> ProjectKeyRecord | None:
        """Resolve one bearer with a fresh database read on every call."""
        return _live(self._record_by_digest(hash_secret(secret)))

    def active_record(self, *, key_id: str) -> ProjectKeyRecord | None:
        """Resolve delegated authority by id with the same fresh checks."""
        return _live(self._record_by_id(key_id))

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
            conn.execute(_INSERT_SQL, astuple(record))

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
            conn.execute(_INSERT_SQL, astuple(record))
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



def revoke_key_lineage(
    conn: Connection,
    *,
    project_id: str,
    key_id: str,
    owner_user_id: str,
    revoked_at: str,
) -> bool:
    """Revoke a key and every rotation descendant, in the caller's transaction.

    ``False`` when this owner holds no such key in this project. The OAuth
    store calls it inside its own transaction so a replayed refresh token
    revokes the family and every bearer derived from it in one commit.
    """
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
  audience, oauth_family_id, created_at, expires_at, revoked_at, parent_key_id, label
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


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


_RECORD_FIELDS = tuple(field.name for field in fields(ProjectKeyRecord))


def _record(row: Any) -> ProjectKeyRecord | None:
    """The row as a record; the table carries columns the record does not."""
    data = row_to_dict(row=row)
    return None if data is None else ProjectKeyRecord(**{name: data[name] for name in _RECORD_FIELDS})


def _live(record: ProjectKeyRecord | None) -> ProjectKeyRecord | None:
    """The record if it is neither revoked nor expired (an unreadable expiry counts as expired)."""
    if record is None or record.revoked_at:
        return None
    if record.expires_at:
        expiry = parse_iso(record.expires_at)
        if expiry is None or expiry <= datetime.now(UTC):
            return None
    return record


def public_key_record(record: ProjectKeyRecord) -> dict[str, object]:
    """The non-secret projection: never the digest, audience, or family."""
    result = asdict(record)
    for secret in ("secret_digest", "audience", "oauth_family_id"):
        del result[secret]
    return result


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
    "revoke_key_lineage",
]


# -- schema ----------------------------------------------------------------

PROJECT_KEY_DDL = """\
-- Surface-owned project credentials (agent-anywhere). The presented mk_ secret
-- is returned once at mint; only its SHA-256 digest is authoritative here. Key
-- scope is immutable: there is no update path for either scope column.
-- Ceilings are stored but not yet enforced (enforcement is a later phase).
CREATE TABLE IF NOT EXISTS project_api_keys (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- 'project' confines the credential to project_id. 'account' authorizes
  -- every project the owner is a member of, and project_id is then only the
  -- home project the key is administered from (listed and revoked under the
  -- existing /api/projects/{id}/keys routes), never a limit on its reach.
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  -- OAuth access keys bind this to their full RFC 8707 resource URI. Direct
  -- project keys keep NULL and retain their existing REST + MCP authority.
  audience TEXT,
  -- Stable grant identity for OAuth access-key rotations. Direct project keys
  -- keep NULL and use their immutable key id for idempotency instead.
  oauth_family_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  parent_key_id TEXT,
  sandbox_seconds_ceiling BIGINT CHECK (sandbox_seconds_ceiling IS NULL OR sandbox_seconds_ceiling >= 0),
  blob_bytes_ceiling BIGINT CHECK (blob_bytes_ceiling IS NULL OR blob_bytes_ceiling >= 0),
  -- Optional human-readable name (e.g. "auto-run · lucia.local") so an owner
  -- can tell which key belongs to which paired runner machine. Never secret.
  label TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(parent_key_id) REFERENCES project_api_keys(id)
);

-- Keys are listed per owner and project, and a revocation walks the lineage
-- down parent_key_id.
CREATE INDEX IF NOT EXISTS idx_project_api_keys_owner
  ON project_api_keys(project_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_project_api_keys_parent ON project_api_keys(parent_key_id);
"""


PROJECT_KEY_SCHEMA = SchemaModule(
    name="surface.project_keys", ddl=PROJECT_KEY_DDL
)
