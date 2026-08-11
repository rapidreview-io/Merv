# If you update this file, you must consult object_storage.md to see whether object_storage.md needs to be updated. object_storage.md must not exceed 100 lines.
"""Project-scoped heavy-object lifecycle and metadata."""

from __future__ import annotations

import base64
import json
import secrets
from contextlib import closing
from datetime import datetime
from typing import Any, TypedDict, cast

from merv.shared.storage_guidance import (
    DEFAULT_STORAGE_MAX_UPLOAD_BYTES,
    STORAGE_MAX_UPLOAD_BYTES_SETTING,
    storage_guidance,
)

from ..kernel.ports.blob_store import validate_blob_keys
from ..kernel.state.store import (
    BaseStateStore,
    Connection,
    Row,
    next_created_seq,
    row_to_dict,
)
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    format_iso,
    iso_after,
    new_id,
    now_iso,
)
from .provider import CompletedPart, ObjectProvider


STORAGE_KINDS = {"dataset", "model", "other"}
STORAGE_STATUSES = {"uploading", "completing", "available", "expired", "deleted"}
STORAGE_DEFAULT_TTL_SECONDS = 60 * 24 * 3600
PRESIGN_TTL_SECONDS = 24 * 3600
# S3's hard single-PUT limit; larger submissions use multipart transfer.
SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024
DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_STORAGE_MAX_UPLOAD_BYTES
# Leave time to finalize after the presigned PUT expires.
COMPLETION_TOKEN_TTL_SECONDS = PRESIGN_TTL_SECONDS + 3600
_LOCAL_API_BASE = "http://127.0.0.1:8787"


class ProducedObject(TypedDict):
    """Hosted-safe heavy-object fields exposed to experiment views."""

    id: str
    name: str
    version: int
    kind: str
    content_sha256: str
    size_bytes: int
    content_type: str
    status: str
    expires_at: str | None
    producing_run: str
    source_uri: str
    notes: str
    created_at: str
    updated_at: str
    last_accessed_at: str | None


def _shell_quote(value: str) -> str:
    """Quote one POSIX shell argument."""
    return "'" + value.replace("'", "'\\''") + "'"


def _checksum_sha256_b64(sha256: str) -> str:
    """Encode the checksum format required by S3."""
    return base64.b64encode(bytes.fromhex(sha256)).decode("ascii")


def storage_submit_command(
    *,
    base_url: str,
    path: str,
    presigned_url: str,
    checksum_b64: str,
    content_type: str,
    token: str,
) -> str:
    """Build the direct upload and completion command."""
    base = (base_url or _LOCAL_API_BASE).rstrip("/")
    # Both signed headers must be shell-quoted; content_type is caller supplied.
    checksum_header = _shell_quote(f"x-amz-checksum-sha256:{checksum_b64}")
    content_type_header = _shell_quote(f"Content-Type: {content_type}")
    put = (
        f"curl -sf -X PUT -H {checksum_header} -H {content_type_header} "
        f"-T {_shell_quote(path)} {_shell_quote(presigned_url)}"
    )
    complete = (
        f"curl -sf -X POST {_shell_quote(f'{base}/api/storage/u/{token}/complete')}"
    )
    return f"{put} && {complete}"


def storage_multipart_submit_command(*, base_url: str, path: str, token: str) -> str:
    """Build the client-assisted multipart upload command.

    The one-time URL contains no presigned provider credentials. ``merv-client``
    fetches fresh part URLs from it, streams the parts concurrently, and posts
    the returned ETags back to its ``/complete`` child route.
    """
    base = (base_url or _LOCAL_API_BASE).rstrip("/")
    target_url = f"{base}/api/storage/u/{token}"
    return (
        f"merv-client storage-upload --path {_shell_quote(path)} "
        f"--target-url {_shell_quote(target_url)}"
    )


def storage_fetch_command(*, path: str, presigned_url: str, sha256: str) -> str:
    """Build a direct download with checksum verification."""
    fetch = f"curl -sf -o {_shell_quote(path)} {_shell_quote(presigned_url)}"
    verify = f"printf '%s  %s\\n' {sha256} {_shell_quote(path)} | shasum -a 256 -c"
    return f"{fetch} && {verify}"


_PRODUCED_OBJECT_COLUMNS = tuple(ProducedObject.__annotations__)
_EXPERIMENT_ID_BATCH_SIZE = 400


class ObjectStorage:
    """Heavy-object metadata, lifecycle, and provider transfer root."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        provider: ObjectProvider | None,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    ) -> None:
        self.store = store
        self._provider = provider
        self.max_upload_bytes = int(max_upload_bytes)

    @property
    def enabled(self) -> bool:
        return self._provider is not None

    @property
    def _provider_required(self) -> ObjectProvider:
        if self._provider is None:
            raise NotFoundError("storage is not enabled on this backend")
        return self._provider

    def put_object(
        self,
        *,
        project_id: str | None,
        name: str,
        kind: str,
        sha256: str,
        size_bytes: int,
        content_type: str = "application/octet-stream",
        created_by: str = "codex",
        producing_experiment_id: str = "",
        producing_run: str = "",
        source_uri: str = "",
        notes: str = "",
    ) -> dict[str, Any]:
        self._validate_kind(kind)
        self._validate_name(name)
        content_type = content_type or "application/octet-stream"
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            namespace = self._namespace(project_id=project_id)
            validate_blob_keys(namespace=namespace, sha256=sha256)
            existing = conn.execute(
                """
                SELECT *
                FROM storage_objects
                WHERE project_id = ? AND name = ? AND content_sha256 = ?
                  AND status = 'available'
                ORDER BY version DESC, created_seq DESC
                LIMIT 1
                """,
                (project_id, name, sha256),
            ).fetchone()
            if existing is not None:
                return {
                    "deduped": False,
                    "idempotent": True,
                    "object": self._hydrate(row=existing),
                }

            version = self._next_version(conn=conn, project_id=project_id, name=name)
            stat = self._provider_required.stat(namespace=namespace, sha256=sha256)
            if stat is not None:
                registered_size = int(stat.size_bytes)
                registered_content_type = str(stat.content_type or content_type)
                status = "available"
                upload_id = None
                expires_at = iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS)
            else:
                upload = self._provider_required.presign_upload(
                    namespace=namespace,
                    sha256=sha256,
                    size_bytes=int(size_bytes),
                    content_type=content_type,
                    expires_in=PRESIGN_TTL_SECONDS,
                )
                registered_size = int(size_bytes)
                registered_content_type = content_type
                status = "uploading"
                upload_id = str(upload["upload_id"])
                expires_at = None
            row = self._insert_object(
                conn=conn,
                project_id=project_id,
                name=name,
                version=version,
                kind=kind,
                sha256=sha256,
                size_bytes=registered_size,
                content_type=registered_content_type,
                namespace=namespace,
                status=status,
                upload_id=upload_id,
                expires_at=expires_at,
                created_by=created_by,
                producing_experiment_id=producing_experiment_id,
                producing_run=producing_run,
                source_uri=source_uri,
                notes=notes,
            )
            self._record(
                conn=conn,
                project_id=project_id,
                event_type="storage.registered",
                row=row,
            )
            if stat is not None:
                return {"deduped": True, "object": self._hydrate(row=row)}
            return {"object": self._hydrate(row=row), "upload": upload}

    def complete_upload(
        self,
        *,
        project_id: str | None,
        upload_id: str,
        parts: list[CompletedPart] | None = None,
    ) -> dict[str, Any]:
        recovering = False
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = self._get_by_upload(
                conn=conn, project_id=project_id, upload_id=upload_id
            )
            status = str(row["status"])
            if status == "uploading":
                # Reserve before provider work so delete cannot orphan bytes.
                cursor = conn.execute(
                    """
                    UPDATE storage_objects
                    SET status = 'completing', updated_at = ?
                    WHERE project_id = ? AND upload_id = ? AND status = 'uploading'
                    """,
                    (now_iso(), project_id, upload_id),
                )
                if int(getattr(cursor, "rowcount", 0)) != 1:
                    raise NotFoundError(
                        f"upload not found in project {project_id}: {upload_id}"
                    )
                row = self._get_by_upload(
                    conn=conn, project_id=project_id, upload_id=upload_id
                )
            elif status == "completing":
                recovering = True
            else:
                raise NotFoundError(
                    f"upload not found in project {project_id}: {upload_id}"
                )
        try:
            if recovering:
                # Provider completion may have consumed its sidecar before a crash.
                stat = self._provider_required.stat(
                    namespace=str(row["namespace"]),
                    sha256=str(row["content_sha256"]),
                )
                if stat is None:
                    raise NotFoundError(
                        f"completed object not found for upload: {upload_id}"
                    )
                if int(stat.size_bytes) > int(row["size_bytes"]):
                    raise ValidationError(
                        f"completed object exceeds its size cap for upload {upload_id}: "
                        f"{stat.size_bytes} > {row['size_bytes']} bytes"
                    )
            else:
                stat = self._provider_required.complete_upload(
                    upload_id=upload_id, parts=parts
                )
        except Exception:
            if not recovering:
                with self.store.transaction() as conn:
                    project_id = self.store.require_project_id(
                        conn=conn, project_id=project_id
                    )
                    conn.execute(
                        """
                        UPDATE storage_objects
                        SET status = 'uploading', updated_at = ?
                        WHERE project_id = ? AND upload_id = ? AND status = 'completing'
                        """,
                        (now_iso(), project_id, upload_id),
                    )
            raise
        if str(stat.namespace) != str(row["namespace"]) or str(stat.sha256) != str(
            row["content_sha256"]
        ):
            raise ValidationError(
                f"upload {upload_id} completed with unexpected object identity"
            )
        now = now_iso()
        expires_at = iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS)
        try:
            with self.store.transaction() as conn:
                project_id = self.store.require_project_id(
                    conn=conn, project_id=project_id
                )
                cursor = conn.execute(
                    """
                    UPDATE storage_objects
                    SET status = 'available', size_bytes = ?, content_type = ?,
                        expires_at = ?, last_accessed_at = ?, updated_at = ?
                    WHERE project_id = ? AND upload_id = ? AND status = 'completing'
                    """,
                    (
                        int(stat.size_bytes),
                        str(stat.content_type or "application/octet-stream"),
                        expires_at,
                        now,
                        now,
                        project_id,
                        upload_id,
                    ),
                )
                if int(getattr(cursor, "rowcount", 0)) != 1:
                    raise NotFoundError(
                        f"upload not completing in project {project_id}: {upload_id}"
                    )
                updated = self._get_by_upload(
                    conn=conn, project_id=project_id, upload_id=upload_id
                )
                self._record(
                    conn=conn,
                    project_id=project_id,
                    event_type="storage.completed",
                    row=updated,
                )
                return self._hydrate(row=updated)
        except Exception:
            self._reclaim_if_unreferenced_after_commit(
                namespace=str(row["namespace"]),
                sha256=str(row["content_sha256"]),
            )
            raise

    def submit(
        self,
        *,
        project_id: str | None,
        path: str,
        kind: str,
        sha256: str,
        size_bytes: int,
        name: str = "",
        content_type: str = "",
        created_by: str = "agent",
        producing_experiment_id: str = "",
        producing_run: str = "",
        source_uri: str = "",
        notes: str = "",
        base_url: str = "",
    ) -> dict[str, Any]:
        """Register an object and return its direct-upload command."""
        if not str(path).strip():
            raise ValidationError("path is required (the local file to upload)")
        self._enforce_upload_size(
            project_id=project_id, size_bytes=int(size_bytes)
        )
        content_type = content_type or "application/octet-stream"
        registered = self.put_object(
            project_id=project_id,
            name=str(name).strip() or str(path).strip(),
            kind=kind,
            sha256=sha256,
            size_bytes=int(size_bytes),
            content_type=content_type,
            created_by=created_by,
            producing_experiment_id=producing_experiment_id,
            producing_run=producing_run,
            source_uri=source_uri,
            notes=notes,
        )
        obj = registered["object"]
        upload = registered.get("upload")
        if upload is None:
            return {
                "object": obj,
                "uploaded": True,
                "deduped": bool(registered.get("deduped")),
                "idempotent": bool(registered.get("idempotent")),
                "run": "",
            }
        token = self._mint_completion_token(
            project_id=str(obj["project_id"]),
            object_id=str(obj["id"]),
            upload_id=str(upload["upload_id"]),
        )
        if "parts" in upload:
            run = storage_multipart_submit_command(
                base_url=base_url, path=str(path), token=token
            )
        else:
            run = storage_submit_command(
                base_url=base_url,
                path=str(path),
                presigned_url=str(upload["url"]),
                checksum_b64=_checksum_sha256_b64(sha256),
                content_type=str(upload.get("content_type") or content_type),
                token=token,
            )
        return {
            "object": obj,
            "upload_id": str(upload["upload_id"]),
            "uploaded": False,
            "run": run,
        }

    def fetch(
        self,
        *,
        project_id: str | None,
        path: str,
        object_id: str | None = None,
        name: str | None = None,
        version: int | None = None,
    ) -> dict[str, Any]:
        """Resolve an object and return its verified download command."""
        if not str(path).strip():
            raise ValidationError("path is required (the local destination file)")
        resolved = self.resolve(
            project_id=project_id,
            object_id=object_id,
            name=name,
            version=version,
            include_download=True,
        )
        obj = resolved["object"]
        run = storage_fetch_command(
            path=str(path),
            presigned_url=str(resolved["download"]["url"]),
            sha256=str(obj["content_sha256"]),
        )
        return {"object": obj, "run": run}

    def find(
        self,
        *,
        project_id: str | None = None,
        object_id: str | None = None,
        name: str | None = None,
        version: int | None = None,
        include_download: bool = True,
        kind: str | None = None,
        status: str | None = None,
        include_expired: bool = False,
        limit: int | None = None,
        offset: int = 0,
        compact: bool = False,
    ) -> dict[str, Any]:
        """Resolve one object when selected; otherwise list the project ledger."""
        if object_id or name:
            return self.resolve(
                project_id=project_id,
                object_id=object_id,
                name=name,
                version=version,
                include_download=include_download,
            )
        return self.list_objects(
            project_id=project_id,
            kind=kind,
            status=status,
            include_expired=include_expired,
            limit=limit,
            offset=offset,
            compact=compact,
        )

    def upload_target_via_token(self, *, token: str) -> dict[str, Any]:
        """Return fresh provider URLs for a pending token-backed upload."""
        row = self._completion_token_row(token=token)
        return {
            "upload": self._provider_required.resume_upload(
                upload_id=str(row["upload_id"]), expires_in=PRESIGN_TTL_SECONDS
            )
        }

    def complete_via_token(
        self, *, token: str, parts: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        """Finalize through an expiring token consumed only after success."""
        row = self._completion_token_row(token=token)
        completed_parts = self._canonical_completed_parts(parts)
        completed = self.complete_upload(
            project_id=str(row["project_id"]),
            upload_id=str(row["upload_id"]),
            parts=cast(list[CompletedPart] | None, completed_parts),
        )
        with self.store.transaction() as conn:
            conn.execute(
                "DELETE FROM storage_completion_tokens WHERE token = ?", (token,)
            )
        return {"object": completed}

    def list_objects(
        self,
        *,
        project_id: str | None,
        kind: str | None = None,
        name: str | None = None,
        status: str | None = None,
        include_expired: bool = False,
        limit: int | None = None,
        offset: int = 0,
        compact: bool = False,
    ) -> dict[str, Any]:
        if kind is not None:
            self._validate_kind(kind)
        if status is not None:
            self._validate_status(status)
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            where = ["project_id = ?"]
            params: list[Any] = [project_id]
            if kind:
                where.append("kind = ?")
                params.append(kind)
            if name:
                where.append("name = ?")
                params.append(name)
            if status:
                where.append("status = ?")
                params.append(status)
            else:
                where.append(
                    "status IN ('available', 'expired')"
                    if include_expired
                    else "status = 'available'"
                )
            base = f"FROM storage_objects WHERE {' AND '.join(where)}"
            total_row = conn.execute(
                f"SELECT COUNT(*) AS total {base}", params
            ).fetchone()
            total = int(total_row["total"] if total_row is not None else 0)
            query = f"SELECT * {base} ORDER BY name, version DESC, created_seq DESC"
            page_params = list(params)
            if limit is not None:
                query += " LIMIT ? OFFSET ?"
                page_params += [int(limit), int(offset)]
            elif offset:
                query += " LIMIT ? OFFSET ?"
                page_params += [2_147_483_647, int(offset)]
            rows = conn.execute(query, page_params).fetchall()
            objects = [self._hydrate(row=row, compact=compact) for row in rows]
            returned = len(objects)
            return {
                "objects": objects,
                "count": returned,
                "returned": returned,
                "total": total,
                "offset": int(offset),
                "has_more": (int(offset) + returned) < total,
                "compact": bool(compact),
                "guidance": storage_guidance(enabled=True),
            }

    def get_object(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return {
                "object": self._hydrate(
                    row=self._get_by_id(
                        conn=conn, project_id=project_id, object_id=object_id
                    )
                )
            }

    def resolve(
        self,
        *,
        project_id: str | None,
        object_id: str | None = None,
        name: str | None = None,
        version: int | None = None,
        include_download: bool = True,
    ) -> dict[str, Any]:
        if bool(object_id) == bool(name):
            raise ValidationError("provide exactly one of object_id or name")
        now = now_iso()
        next_expiry = iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = self._resolve_row(
                conn=conn,
                project_id=project_id,
                object_id=object_id,
                name=name,
                version=version,
            )
            if row is None or str(row["status"]) != "available":
                target = (
                    object_id
                    if object_id
                    else (f"{name}@{version}" if version is not None else name)
                )
                raise NotFoundError(
                    f"storage object not available in project {project_id}: {target}"
                )
            expires_at = row["expires_at"]
            if expires_at is not None and str(next_expiry) > str(expires_at):
                conn.execute(
                    """
                    UPDATE storage_objects
                    SET expires_at = ?, last_accessed_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (next_expiry, now, now, row["id"]),
                )
            else:
                conn.execute(
                    """
                    UPDATE storage_objects
                    SET last_accessed_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (now, now, row["id"]),
                )
            row = self._get_by_id(
                conn=conn, project_id=project_id, object_id=str(row["id"])
            )
            obj = self._hydrate(row=row)
        result: dict[str, Any] = {"object": obj}
        if include_download:
            result["download"] = self._provider_required.presign_download(
                namespace=str(obj["namespace"]),
                sha256=str(obj["content_sha256"]),
                expires_in=PRESIGN_TTL_SECONDS,
            )
        return result

    def pin(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        return self._set_expiry(
            project_id=project_id, object_id=object_id, expires_at=None
        )

    def unpin(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        return self._set_expiry(
            project_id=project_id,
            object_id=object_id,
            expires_at=iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS),
        )

    def renew(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        return self.unpin(project_id=project_id, object_id=object_id)

    def manage(
        self, *, object_id: str, action: str, project_id: str | None = None
    ) -> dict[str, Any]:
        operation = {
            "pin": self.pin,
            "unpin": self.unpin,
            "renew": self.renew,
            "delete": self.delete,
        }.get(action)
        if operation is None:
            raise ValidationError(f"unknown storage object action: {action}")
        return operation(project_id=project_id, object_id=object_id)

    def delete(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = self._get_by_id(conn=conn, project_id=project_id, object_id=object_id)
            if str(row["status"]) == "deleted":
                return {
                    "deleted": False,
                    "reclaimed": False,
                    "object": self._hydrate(row=row),
                }
            if str(row["status"]) == "completing":
                raise ValidationError(
                    f"storage object is completing and cannot be deleted: {object_id}"
                )
            now = now_iso()
            conn.execute(
                "UPDATE storage_objects SET status = 'deleted', updated_at = ? WHERE id = ?",
                (now, object_id),
            )
            updated = self._get_by_id(
                conn=conn, project_id=project_id, object_id=object_id
            )
            self._record(
                conn=conn,
                project_id=project_id,
                event_type="storage.deleted",
                row=updated,
            )
            obj = self._hydrate(row=updated)
            namespace = str(row["namespace"])
            sha256 = str(row["content_sha256"])
        reclaimed = self._reclaim_if_unreferenced_after_commit(
            namespace=namespace, sha256=sha256
        )
        return {"deleted": True, "reclaimed": reclaimed, "object": obj}

    def sweep_expired(self, *, now: str | datetime | None = None) -> int:
        cutoff = self._cutoff(now=now)
        swept = 0
        freed: list[tuple[str, str]] = []
        with self.store.transaction() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM storage_objects
                WHERE status = 'available' AND expires_at IS NOT NULL AND expires_at <= ?
                ORDER BY created_seq
                """,
                (cutoff,),
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE storage_objects SET status = 'expired', updated_at = ? WHERE id = ?",
                    (cutoff, row["id"]),
                )
                updated = self._get_by_id(
                    conn=conn,
                    project_id=str(row["project_id"]),
                    object_id=str(row["id"]),
                )
                self._record(
                    conn=conn,
                    project_id=str(row["project_id"]),
                    event_type="storage.expired",
                    row=updated,
                )
                freed.append((str(row["namespace"]), str(row["content_sha256"])))
                swept += 1
        for namespace, sha256 in freed:
            self._reclaim_if_unreferenced_after_commit(
                namespace=namespace, sha256=sha256
            )
        return swept

    def by_experiment(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[ProducedObject]]:
        """Batch hosted-safe object facts without requiring a byte provider."""
        ids = tuple(dict.fromkeys(str(item) for item in experiment_ids if item))
        result: dict[str, list[ProducedObject]] = {item: [] for item in ids}
        if not ids:
            return result
        columns = ", ".join(_PRODUCED_OBJECT_COLUMNS)
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            for start in range(0, len(ids), _EXPERIMENT_ID_BATCH_SIZE):
                batch = ids[start : start + _EXPERIMENT_ID_BATCH_SIZE]
                placeholders = ", ".join("?" for _ in batch)
                rows = conn.execute(
                    f"""
                    SELECT {columns}, producing_experiment_id
                    FROM storage_objects
                    WHERE project_id = ?
                      AND producing_experiment_id IN ({placeholders})
                      AND status != 'deleted'
                    ORDER BY producing_experiment_id, kind, name,
                             version DESC, created_seq DESC
                    """,
                    (project_id, *batch),
                ).fetchall()
                for row in rows:
                    data = row_to_dict(row=row) or {}
                    experiment_id = str(data.pop("producing_experiment_id"))
                    result[experiment_id].append(cast(ProducedObject, data))
        return result

    def _insert_object(
        self,
        *,
        conn: Connection,
        project_id: str,
        name: str,
        version: int,
        kind: str,
        sha256: str,
        size_bytes: int,
        content_type: str,
        namespace: str,
        status: str,
        upload_id: str | None,
        expires_at: str | None,
        created_by: str,
        producing_experiment_id: str,
        producing_run: str,
        source_uri: str,
        notes: str,
    ) -> Row:
        now = now_iso()
        object_id = new_id(prefix="sto")
        conn.execute(
            """
            INSERT INTO storage_objects (
              id, project_id, name, version, kind, content_sha256, size_bytes,
              content_type, namespace, status, upload_id, expires_at, created_by,
              producing_experiment_id, producing_run, source_uri, notes,
              created_at, updated_at, last_accessed_at, created_seq
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            """,
            (
                object_id,
                project_id,
                name,
                int(version),
                kind,
                sha256,
                int(size_bytes),
                content_type,
                namespace,
                status,
                upload_id,
                expires_at,
                created_by,
                producing_experiment_id,
                producing_run,
                source_uri,
                notes,
                now,
                now,
                next_created_seq(conn=conn, table="storage_objects"),
            ),
        )
        return self._get_by_id(conn=conn, project_id=project_id, object_id=object_id)

    def _set_expiry(
        self, *, project_id: str | None, object_id: str, expires_at: str | None
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            self._get_by_id(conn=conn, project_id=project_id, object_id=object_id)
            conn.execute(
                "UPDATE storage_objects SET expires_at = ?, updated_at = ? WHERE id = ?",
                (expires_at, now_iso(), object_id),
            )
            return self._hydrate(
                row=self._get_by_id(
                    conn=conn, project_id=project_id, object_id=object_id
                )
            )

    def _resolve_row(
        self,
        *,
        conn: Connection,
        project_id: str,
        object_id: str | None,
        name: str | None,
        version: int | None,
    ) -> Row | None:
        if object_id:
            return conn.execute(
                "SELECT * FROM storage_objects WHERE project_id = ? AND id = ?",
                (project_id, object_id),
            ).fetchone()
        if version is None:
            return conn.execute(
                """
                SELECT *
                FROM storage_objects
                WHERE project_id = ? AND name = ? AND status = 'available'
                ORDER BY version DESC, created_seq DESC
                LIMIT 1
                """,
                (project_id, name),
            ).fetchone()
        return conn.execute(
            """
            SELECT *
            FROM storage_objects
            WHERE project_id = ? AND name = ? AND version = ?
            """,
            (project_id, name, int(version)),
        ).fetchone()

    def _get_by_id(self, *, conn: Connection, project_id: str, object_id: str) -> Row:
        row = conn.execute(
            "SELECT * FROM storage_objects WHERE project_id = ? AND id = ?",
            (project_id, object_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(
                f"storage object not found in project {project_id}: {object_id}"
            )
        return row

    def _get_by_upload(
        self, *, conn: Connection, project_id: str, upload_id: str
    ) -> Row:
        row = conn.execute(
            "SELECT * FROM storage_objects WHERE project_id = ? AND upload_id = ?",
            (project_id, upload_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(
                f"upload not found in project {project_id}: {upload_id}"
            )
        return row

    def _next_version(self, *, conn: Connection, project_id: str, name: str) -> int:
        row = conn.execute(
            """
            SELECT COALESCE(MAX(version), 0) + 1 AS next_version
            FROM storage_objects
            WHERE project_id = ? AND name = ?
            """,
            (project_id, name),
        ).fetchone()
        return int(row["next_version"])

    def _reclaim_if_unreferenced_after_commit(
        self, *, namespace: str, sha256: str
    ) -> bool:
        with self.store.transaction() as conn:
            return self._reclaim_if_unreferenced(
                conn=conn, namespace=namespace, sha256=sha256
            )

    def _reclaim_if_unreferenced(
        self, *, conn: Connection, namespace: str, sha256: str
    ) -> bool:
        remaining = conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM storage_objects
            WHERE namespace = ? AND content_sha256 = ?
              AND status IN ('uploading', 'completing', 'available')
            """,
            (namespace, sha256),
        ).fetchone()
        if int(remaining["count"]) > 0:
            return False
        return self._provider_required.delete(namespace=namespace, sha256=sha256)

    def _record(
        self, *, conn: Connection, project_id: str, event_type: str, row: Row
    ) -> None:
        self.store.record_event(
            conn=conn,
            project_id=project_id,
            event_type=event_type,
            target_type="storage_object",
            target_id=str(row["id"]),
            payload={
                "name": row["name"],
                "version": int(row["version"]),
                "sha256": row["content_sha256"],
                "status": row["status"],
            },
        )

    def effective_max_upload_bytes(self, *, project_id: str | None) -> int:
        """Resolve the project's limit, bounded by the server-side ceiling."""
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT settings_json FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"project not found: {project_id}")
        try:
            settings = json.loads(str(row["settings_json"] or "{}"))
        except (TypeError, ValueError):
            settings = {}
        configured = (
            settings.get(STORAGE_MAX_UPLOAD_BYTES_SETTING)
            if isinstance(settings, dict)
            else None
        )
        project_limit = (
            int(configured)
            if isinstance(configured, int)
            and not isinstance(configured, bool)
            and configured > 0
            else DEFAULT_MAX_UPLOAD_BYTES
        )
        return min(project_limit, self.max_upload_bytes)

    def _enforce_upload_size(
        self, *, project_id: str | None, size_bytes: int
    ) -> None:
        if size_bytes < 0:
            raise ValidationError("size_bytes must be non-negative")
        effective_limit = self.effective_max_upload_bytes(project_id=project_id)
        if size_bytes > effective_limit:
            raise ValidationError(
                f"upload is {size_bytes} bytes; the maximum is "
                f"{effective_limit} bytes for this project",
                details={
                    "size_bytes": size_bytes,
                    "max_bytes": effective_limit,
                    "server_max_bytes": self.max_upload_bytes,
                },
            )

    def _completion_token_row(self, *, token: str) -> Row:
        self._sweep_completion_tokens()
        with closing(self.store.connect()) as conn:
            row = conn.execute(
                """
                SELECT project_id, upload_id
                FROM storage_completion_tokens
                WHERE token = ? AND status = 'pending' AND expires_at > ?
                """,
                (token, now_iso()),
            ).fetchone()
        if row is None:
            raise NotFoundError("unknown, used, or expired storage completion token")
        return row

    @staticmethod
    def _canonical_completed_parts(
        parts: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        if parts is None:
            return None
        if not isinstance(parts, list):
            raise ValidationError("parts must be a list")
        canonical: list[dict[str, Any]] = []
        seen: set[int] = set()
        for part in parts:
            if not isinstance(part, dict):
                raise ValidationError("each completed part must be an object")
            raw_number = part.get("part_number", part.get("PartNumber"))
            etag = str(part.get("etag", part.get("ETag", ""))).strip()
            try:
                part_number = int(raw_number)
            except (TypeError, ValueError) as exc:
                raise ValidationError(
                    "each completed part needs an integer part_number"
                ) from exc
            if part_number < 1 or part_number in seen or not etag:
                raise ValidationError(
                    "completed parts need unique positive part_number and etag"
                )
            seen.add(part_number)
            canonical.append({"part_number": part_number, "etag": etag})
        canonical.sort(key=lambda item: int(item["part_number"]))
        return canonical

    def _mint_completion_token(
        self, *, project_id: str, object_id: str, upload_id: str
    ) -> str:
        token = secrets.token_urlsafe(24)
        with self.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO storage_completion_tokens
                  (token, project_id, object_id, upload_id, status, expires_at, created_at)
                VALUES (?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    token,
                    project_id,
                    object_id,
                    upload_id,
                    iso_after(seconds=COMPLETION_TOKEN_TTL_SECONDS),
                    now_iso(),
                ),
            )
        return token

    def _sweep_completion_tokens(self) -> None:
        with self.store.transaction() as conn:
            conn.execute(
                "DELETE FROM storage_completion_tokens WHERE expires_at < ?",
                (now_iso(),),
            )

    def _namespace(self, *, project_id: str) -> str:
        return project_id

    def _hydrate(self, *, row: Row, compact: bool = False) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        if compact:
            fields = (
                "id",
                "project_id",
                "name",
                "version",
                "kind",
                "content_sha256",
                "size_bytes",
                "status",
                "expires_at",
                "updated_at",
            )
            return {key: data.get(key) for key in fields}
        return data

    def _cutoff(self, *, now: str | datetime | None) -> str:
        if isinstance(now, datetime):
            return format_iso(now)
        return str(now) if now is not None else now_iso()

    def _validate_kind(self, kind: str) -> None:
        if kind not in STORAGE_KINDS:
            raise ValidationError(
                f"invalid storage kind: {kind}; allowed: {', '.join(sorted(STORAGE_KINDS))}"
            )

    def _validate_status(self, status: str) -> None:
        if status not in STORAGE_STATUSES:
            raise ValidationError(
                f"invalid storage status: {status}; allowed: {', '.join(sorted(STORAGE_STATUSES))}"
            )

    def _validate_name(self, name: str) -> None:
        if not name:
            raise ValidationError("storage object name is required")


__all__ = [
    "COMPLETION_TOKEN_TTL_SECONDS",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "PRESIGN_TTL_SECONDS",
    "SINGLE_PUT_MAX_BYTES",
    "STORAGE_DEFAULT_TTL_SECONDS",
    "STORAGE_KINDS",
    "ObjectStorage",
    "storage_fetch_command",
    "storage_multipart_submit_command",
    "storage_submit_command",
]
