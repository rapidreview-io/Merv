"""Heavy objects through merv-sandboxes.

The service is the catalog: names, versions, state, checksum verification,
retention (null pins permanently; retention only extends), quota and bytes.
Merv keeps the transfer glue — one-time completion tokens and run commands —
and an opaque lifecycle hook whose facts it never interprets.
"""

from __future__ import annotations

import re
import secrets
from contextlib import closing, suppress
from typing import Any, Mapping, Protocol

from merv.shared.storage_guidance import DEFAULT_STORAGE_MAX_UPLOAD_BYTES

from ..kernel.ports.blob_store import validate_blob_keys
from ..kernel.state import BaseStateStore
from ..kernel.utils import (
    NotFoundError, ValidationError, format_iso, iso_after, now_iso, parse_iso,
)
from .ports import InfrastructureTransport, project_namespace
from .storage import (
    storage_fetch_command, storage_multipart_submit_command,
    storage_submit_command, upload_target,
)
from .persistence import INFRASTRUCTURE_SCHEMA

# Merv's retention window: applied at creation and by ``renew``; reads that
# hand out a download renew it too, so objects in active use never lapse.
STORAGE_DEFAULT_TTL_SECONDS = 60 * 24 * 3600
# The presigned transfer window plus an hour to finalize after it expires.
COMPLETION_TOKEN_TTL_SECONDS = 24 * 3600 + 3600
# The server-wide ceiling for one submission; the service enforces quota.
DEFAULT_MAX_UPLOAD_BYTES = DEFAULT_STORAGE_MAX_UPLOAD_BYTES
STORAGE_STATES = frozenset({"uploading", "completing", "available", "delete_pending", "deleted"})
_CATALOG_PAGE = 1000
_OBJECT_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
_COMPACT_FIELDS = (
    "id", "project_id", "name", "version", "kind", "content_sha256",
    "size_bytes", "status", "expires_at", "updated_at",
)


class ObjectLifecycle(Protocol):
    """Bookkeeping hooks for objects Merv submits; ``attributes`` are the
    caller's own submission fields, echoed verbatim and never read back."""

    def submitted(
        self, *, project_id: str, record: Mapping[str, Any], attributes: Mapping[str, Any]
    ) -> None: ...

    def completed(self, *, project_id: str, record: Mapping[str, Any]) -> None: ...

    def deleted(self, *, project_id: str, object_id: str) -> None: ...


def _stamp(value: Any) -> str | None:
    parsed = parse_iso(value)
    return format_iso(parsed) if parsed is not None else (str(value) if value else None)


def present(record: Mapping[str, Any], *, project_id: str) -> dict[str, Any]:
    """Project one service object record onto Merv's storage entry."""
    return {
        "id": str(record["id"]),
        "project_id": project_id,
        "name": str(record["name"]),
        "version": int(record["version"]),
        "kind": record.get("kind"),
        "status": str(record["state"]),
        "content_sha256": str(record["sha256"]),
        "size_bytes": int(record["size_bytes"]),
        "content_type": str(record.get("content_type") or "application/octet-stream"),
        "expires_at": _stamp(record.get("expires_at")),
        "created_at": _stamp(record.get("created_at")),
        "updated_at": _stamp(record.get("updated_at")),
        "producer_job_id": record.get("producer_job_id"),
        "error": record.get("error"),
    }


def _object_path(object_id: str) -> str:
    if not _OBJECT_ID.fullmatch(str(object_id or "")):
        raise ValidationError(f"invalid storage object id: {object_id!r}")
    return f"/storage/objects/{object_id}"


def _pick(records: list[dict[str, Any]], version: int | None) -> dict[str, Any] | None:
    """The named version, or the latest available one."""
    if version is not None:
        return next((row for row in records if int(row["version"]) == int(version)), None)
    available = [row for row in records if str(row.get("state")) == "available"]
    return max(available, key=lambda row: int(row["version"]), default=None)


def _validate_name(name: str) -> str:
    """Mirror the service's relative-path rule with a message agents can act on."""
    if (
        not name
        or "\\" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
        or any(ord(char) < 32 or ord(char) == 127 for char in name)
        or len(name.encode()) > 1024
    ):
        raise ValidationError(
            "storage object name must be a relative path without empty, '.' or "
            "'..' segments; pass name= to choose one when path is absolute"
        )
    return name


class RemoteObjects:
    """Merv's heavy-object API backed exclusively by merv-sandboxes objects."""

    def __init__(
        self, *, client: InfrastructureTransport | None, store: BaseStateStore,
        lifecycle: ObjectLifecycle | None = None,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    ) -> None:
        self.client = client
        self._store = store
        self.lifecycle = lifecycle
        store.install(INFRASTRUCTURE_SCHEMA)
        self.max_upload_bytes = int(max_upload_bytes)

    @property
    def enabled(self) -> bool:
        return self.client is not None

    # Transport -------------------------------------------------------------

    def _project(self, project_id: str | None) -> str:
        with closing(self._store.connect()) as conn:
            return self._store.require_project_id(conn=conn, project_id=project_id)

    def _call(
        self, method: str, path: str, *, project_id: str, **kwargs: Any
    ) -> dict[str, Any]:
        if self.client is None:
            raise NotFoundError("storage is not enabled on this backend")
        return self.client.request(
            method, path, namespace=project_namespace(project_id), **kwargs
        )

    def _catalog(self, *, project_id: str, name: str | None = None) -> list[dict[str, Any]]:
        """Every non-deleted object the service holds for the project."""
        records: list[dict[str, Any]] = []
        offset = 0
        while True:
            params: dict[str, Any] = {"limit": _CATALOG_PAGE, "offset": offset}
            if name:
                params["name"] = name
            page = self._call("GET", "/storage/objects", project_id=project_id, params=params)
            rows = list(page.get("objects", []))
            records.extend(rows)
            if len(rows) < _CATALOG_PAGE:
                return records
            offset += len(rows)

    # Submission ------------------------------------------------------------

    def put_object(
        self, *, project_id: str | None, name: str, sha256: str, size_bytes: int,
        content_type: str = "application/octet-stream", **attributes: Any,
    ) -> dict[str, Any]:
        """Create the object in the service and return its transfer target.

        Extra keyword arguments are the caller's own attributes: they reach the
        lifecycle hook untouched and never influence the service request.
        """
        project_id = self._project(project_id)
        name = _validate_name(str(name).strip())
        validate_blob_keys(namespace=project_namespace(project_id), sha256=sha256)
        self._enforce_upload_size(size_bytes=int(size_bytes))
        content_type = content_type or "application/octet-stream"
        status = self._call(
            "POST",
            "/storage/objects",
            project_id=project_id,
            json={"name": name, "sha256": sha256, "size_bytes": int(size_bytes),
                  "content_type": content_type,
                  "expires_in_seconds": STORAGE_DEFAULT_TTL_SECONDS},
        )
        record = present(status["object"], project_id=project_id)
        if self.lifecycle is not None:
            try:
                self.lifecycle.submitted(
                    project_id=project_id, record=record, attributes=dict(attributes)
                )
            except Exception:
                # The service object exists only for the refused submission.
                with suppress(Exception):
                    self._call("DELETE", _object_path(record["id"]), project_id=project_id)
                raise
        return {
            "object": record,
            "upload": upload_target(
                self.client, namespace=project_namespace(project_id), status=status
            ),
        }

    def submit(
        self, *, project_id: str | None, path: str, sha256: str, size_bytes: int,
        name: str = "", content_type: str = "", base_url: str = "", **attributes: Any,
    ) -> dict[str, Any]:
        """Create an object and return the one-line command that uploads it."""
        if not str(path).strip():
            raise ValidationError("path is required (the local file to upload)")
        registered = self.put_object(
            project_id=project_id,
            name=str(name).strip() or str(path).strip(),
            sha256=sha256,
            size_bytes=int(size_bytes),
            content_type=content_type or "application/octet-stream",
            **attributes,
        )
        obj, upload = registered["object"], registered["upload"]
        token = self._mint_completion_token(
            project_id=str(obj["project_id"]), object_id=str(obj["id"])
        )
        run = (
            storage_submit_command(
                base_url=base_url, path=str(path), presigned_url=str(upload["url"]),
                checksum_b64=str(upload["checksum_sha256"]),
                content_type=str(upload.get("content_type") or content_type),
                token=token, headers=upload.get("headers"),
            )
            if "url" in upload
            else storage_multipart_submit_command(base_url=base_url, path=str(path), token=token)
        )
        return {"object_id": str(obj["id"]), "name": obj["name"], "version": obj["version"], "run": run}

    def complete_upload(
        self, *, project_id: str | None, upload_id: str,
        parts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Finalize by handle (the service object id). The service lists and
        verifies the parts itself, so ``parts`` is accepted and not forwarded."""
        del parts
        project_id = self._project(project_id)
        record = self._call(
            "POST", f"{_object_path(upload_id)}/complete", project_id=project_id
        )
        if record.get("state") != "available":
            raise ValidationError(
                "merv-sandboxes has not completed the upload",
                details={"state": record.get("state")},
            )
        entry = present(record, project_id=project_id)
        if self.lifecycle is not None:
            self.lifecycle.completed(project_id=project_id, record=entry)
        return entry

    # Completion tokens -----------------------------------------------------

    def upload_target_via_token(self, *, token: str) -> dict[str, Any]:
        """Return fresh transfer URLs for a pending token-backed upload."""
        row = self._completion_token_row(token=token)
        project_id = str(row["project_id"])
        status = self._call(
            "GET", f"{_object_path(str(row['object_id']))}/upload", project_id=project_id
        )
        return {"upload": upload_target(
            self.client, namespace=project_namespace(project_id), status=status
        )}

    def complete_via_token(
        self, *, token: str, parts: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        """Finalize through an expiring token consumed only after success."""
        del parts
        row = self._completion_token_row(token=token)
        completed = self.complete_upload(
            project_id=str(row["project_id"]), upload_id=str(row["object_id"])
        )
        with self._store.transaction() as conn:
            conn.execute(
                "DELETE FROM storage_completion_tokens WHERE token = ?", (token,)
            )
        return {"object": completed}

    def _mint_completion_token(self, *, project_id: str, object_id: str) -> str:
        token = secrets.token_urlsafe(24)
        with self._store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO storage_completion_tokens
                  (token, project_id, object_id, upload_id, status, expires_at, created_at)
                VALUES (?, ?, ?, ?, 'pending', ?, ?)
                """,
                (token, project_id, object_id, object_id,
                 iso_after(seconds=COMPLETION_TOKEN_TTL_SECONDS), now_iso()),
            )
        return token

    def _completion_token_row(self, *, token: str) -> Any:
        with self._store.transaction() as conn:
            conn.execute(
                "DELETE FROM storage_completion_tokens WHERE expires_at < ?", (now_iso(),)
            )
            row = conn.execute(
                """
                SELECT project_id, object_id
                FROM storage_completion_tokens
                WHERE token = ? AND status = 'pending' AND expires_at > ?
                """,
                (token, now_iso()),
            ).fetchone()
        if row is None:
            raise NotFoundError("unknown, used, or expired storage completion token")
        return row

    # Reads -----------------------------------------------------------------

    def find(
        self, *, project_id: str | None = None, object_id: str | None = None,
        name: str | None = None, version: int | None = None,
        include_download: bool = True, status: str | None = None,
        limit: int | None = None, offset: int = 0, compact: bool = False,
        select_one: bool | None = None,
    ) -> dict[str, Any]:
        """One catalog read: resolve the object a selector names, or page the list.

        A selector (``object_id``, or ``name`` with an optional ``version``)
        answers with that one available object and, when ``include_download``,
        a presigned URL whose issue renews retention. Without one the objects
        are listed by ``status`` (available by default) and paged;
        ``select_one=False`` forces that so the browser can filter by name.
        """
        project_id = self._project(project_id)
        if select_one is None:
            select_one = bool(object_id or name)
        if select_one:
            if bool(object_id) == bool(name):
                raise ValidationError("provide exactly one of object_id or name")
            record = (
                self._call("GET", _object_path(object_id), project_id=project_id)
                if object_id
                else _pick(self._catalog(project_id=project_id, name=str(name)), version)
            )
            if record is None or str(record.get("state")) != "available":
                target = object_id or (f"{name}@{version}" if version is not None else name)
                raise NotFoundError(
                    f"storage object not available in project {project_id}: {target}"
                )
            if not include_download:
                return {"object": present(record, project_id=project_id)}
            target_id = str(record["id"])
            download = self._call(
                "GET", f"{_object_path(target_id)}/download", project_id=project_id
            )
            renewed = self._retention(
                project_id=project_id, object_id=target_id,
                expires_at=iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS),
            )
            return {"object": present(renewed, project_id=project_id),
                    "download": {"url": str(download["url"])}}
        if status is not None and status not in STORAGE_STATES:
            raise ValidationError(
                f"invalid storage status: {status}; allowed: {', '.join(sorted(STORAGE_STATES))}"
            )
        rows = [
            record
            for record in self._catalog(project_id=project_id, name=name)
            if str(record.get("state")) == (status or "available")
        ]
        rows.sort(key=lambda record: (str(record["name"]), -int(record["version"])))
        start = int(offset)
        page = rows[start:] if limit is None else rows[start : start + int(limit)]
        objects = [
            {key: entry.get(key) for key in _COMPACT_FIELDS} if compact else entry
            for entry in (present(record, project_id=project_id) for record in page)
        ]
        return {
            "objects": objects, "count": len(objects), "returned": len(objects),
            "total": len(rows), "offset": start, "compact": bool(compact),
            "has_more": (start + len(objects)) < len(rows),
        }

    def get_object(self, *, project_id: str | None, object_id: str) -> dict[str, Any]:
        """One object in any state, as the browser's detail read needs it."""
        project_id = self._project(project_id)
        record = self._call("GET", _object_path(object_id), project_id=project_id)
        return {"object": present(record, project_id=project_id)}

    def fetch(
        self, *, project_id: str | None, path: str, object_id: str | None = None,
        name: str | None = None, version: int | None = None,
    ) -> dict[str, Any]:
        """Resolve an object and return its verified download command."""
        if not str(path).strip():
            raise ValidationError("path is required (the local destination file)")
        resolved = self.find(
            project_id=project_id, object_id=object_id, name=name, version=version,
            select_one=True,
        )
        obj = resolved["object"]
        return {
            "object": obj,
            "run": storage_fetch_command(
                path=str(path),
                presigned_url=str(resolved["download"]["url"]),
                sha256=str(obj["content_sha256"]),
            ),
        }

    # Lifecycle -------------------------------------------------------------

    def manage(
        self, *, object_id: str, action: str, project_id: str | None = None
    ) -> dict[str, Any]:
        """pin (retention removed), renew (extend by Merv's window), delete."""
        project_id = self._project(project_id)
        if action == "delete":
            entry = present(
                self._call("DELETE", _object_path(object_id), project_id=project_id),
                project_id=project_id,
            )
            if self.lifecycle is not None:
                self.lifecycle.deleted(project_id=project_id, object_id=str(entry["id"]))
            return {"deleted": True, "object": entry}
        if action not in ("pin", "renew"):
            raise ValidationError(f"unknown storage object action: {action}")
        return present(
            self._retention(
                project_id=project_id,
                object_id=object_id,
                expires_at=(
                    None if action == "pin" else iso_after(seconds=STORAGE_DEFAULT_TTL_SECONDS)
                ),
            ),
            project_id=project_id,
        )

    def _retention(
        self, *, project_id: str, object_id: str, expires_at: str | None
    ) -> dict[str, Any]:
        return self._call(
            "PATCH",
            f"{_object_path(object_id)}/retention",
            project_id=project_id,
            json={"expires_at": expires_at},
        )

    def _enforce_upload_size(self, *, size_bytes: int) -> None:
        if size_bytes < 0:
            raise ValidationError("size_bytes must be non-negative")
        if size_bytes > self.max_upload_bytes:
            raise ValidationError(
                f"upload is {size_bytes} bytes; the maximum is "
                f"{self.max_upload_bytes} bytes on this backend",
                details={"size_bytes": size_bytes, "max_bytes": self.max_upload_bytes,
                         "server_max_bytes": self.max_upload_bytes},
            )


__all__ = [
    "COMPLETION_TOKEN_TTL_SECONDS", "DEFAULT_MAX_UPLOAD_BYTES",
    "STORAGE_DEFAULT_TTL_SECONDS", "STORAGE_STATES", "ObjectLifecycle",
    "RemoteObjects", "present",
]
