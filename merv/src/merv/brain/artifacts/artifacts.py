# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Project-scoped immutable content and single-use uploads.

Consumers own associations and snapshots. This module knows only content,
upload limits, and fixed document attachment manifests.
"""

from __future__ import annotations

from contextlib import closing, nullcontext
import mimetypes
import secrets
from typing import Any

from merv.shared import markdown_images as markdown

from ..kernel.ports.blob_store import EvidenceBlobStore
from ..kernel.state.store import BaseStateStore, Connection, Row, next_created_seq
from ..kernel.utils import NotFoundError, ValidationError, iso_after, new_id, now_iso
from .models import (
    Artifact, CompletedArtifact, CompletedFigure, PendingFigure, PendingUpload,
    ReadMode, UploadKind,
)
from .persistence import ARTIFACT_SCHEMA


UPLOAD_TOKEN_TTL_SECONDS = 15 * 60
MAX_ARTIFACT_BYTES = 5_000_000
_CONTENT_TYPES = {".md": "text/markdown", ".json": "application/json"}


class Artifacts:
    """Store independent content versions; completed bytes never change."""

    def __init__(self, *, store: BaseStateStore, blobs: EvidenceBlobStore) -> None:
        self._store = store
        self._blobs = blobs
        store.install(ARTIFACT_SCHEMA)

    def submit(
        self,
        *,
        project_id: str,
        path: str,
        title: str = "",
        created_by: str = "agent",
        max_bytes: int = MAX_ARTIFACT_BYTES,
        discover_figures: bool = False,
        tx: Connection | None = None,
    ) -> PendingUpload:
        """Reserve a new content version with a bounded, expiring upload."""
        path = _clean_path(path)
        if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes < 1:
            raise ValidationError("max_bytes must be a positive integer")
        with (nullcontext(tx) if tx is not None else self._store.transaction()) as conn:
            self._sweep_expired(tx=conn)
            project_id = self._store.require_project_id(conn=conn, project_id=project_id)
            artifact_id, token, now = new_id(prefix="art"), secrets.token_urlsafe(24), now_iso()
            conn.execute(
                """
                INSERT INTO artifacts (
                  id, project_id, path, title, status, upload_token, expires_at,
                  created_by, created_at, updated_at, created_seq,
                  max_bytes, discover_figures
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id, project_id, path, title, token,
                    iso_after(seconds=UPLOAD_TOKEN_TTL_SECONDS), created_by, now, now,
                    next_created_seq(conn=conn, table="artifacts"), max_bytes,
                    int(discover_figures),
                ),
            )
        return PendingUpload(artifact_id=artifact_id, token=token, path=path)

    def create(
        self,
        *,
        project_id: str,
        path: str,
        data: bytes,
        title: str = "",
        created_by: str = "system",
        tx: Connection | None = None,
    ) -> Artifact:
        """Store a new immutable version from trusted, already available bytes."""
        path = _clean_path(path)
        with (nullcontext(tx) if tx is not None else self._store.transaction()) as conn:
            project_id = self._store.require_project_id(conn=conn, project_id=project_id)
            content_type = _content_type(path)
            sha256 = self._blobs.put(namespace=project_id, data=data, content_type=content_type)
            artifact_id, now = new_id(prefix="art"), now_iso()
            conn.execute(
                """
                INSERT INTO artifacts (
                  id, project_id, path, title, content_sha256, size_bytes,
                  content_type, status, created_by, created_at, updated_at, created_seq
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)
                """,
                (
                    artifact_id, project_id, path, title, sha256, len(data), content_type,
                    created_by, now, now, next_created_seq(conn=conn, table="artifacts"),
                ),
            )
            row = conn.execute("SELECT * FROM artifacts WHERE id = ?", (artifact_id,)).fetchone()
            return Artifact.from_row(row)

    def pending(
        self, *, token: str, kind: UploadKind, tx: Connection | None = None,
    ) -> Artifact:
        """Resolve a live upload credential to its owning content record."""
        self._sweep_expired(tx=tx)
        with (nullcontext(tx) if tx is not None else closing(self._store.connect())) as conn:
            return Artifact.from_row(self._pending(tx=conn, token=token, kind=kind))

    def upload_cap(self, *, token: str, kind: UploadKind) -> int:
        """Validate a credential and return its cap before reading the body."""
        self._sweep_expired()
        with closing(self._store.connect()) as tx:
            row = self._pending(tx=tx, token=token, kind=kind)
            return markdown.MARKDOWN_FIGURE_MAX_BYTES if kind == "figure" else int(row["max_bytes"])

    def complete_upload(
        self, *, token: str, kind: UploadKind, data: bytes,
        tx: Connection | None = None,
    ) -> CompletedArtifact | CompletedFigure:
        """Commit bytes independently, or join an explicit caller transaction."""
        self._sweep_expired(tx=tx)
        with (nullcontext(tx) if tx is not None else self._store.transaction()) as conn:
            artifact = self._pending(tx=conn, token=token, kind=kind)
            if kind == "figure":
                row = conn.execute(
                    "SELECT * FROM artifact_figures WHERE upload_token = ? AND status = 'pending'",
                    (token,),
                ).fetchone()
                path, cap = str(row["link_path"]), markdown.MARKDOWN_FIGURE_MAX_BYTES
            else:
                row = artifact
                path, cap = str(row["path"]), int(row["max_bytes"])
            if len(data) > cap:
                raise ValidationError(
                    f"{path} is {len(data)} bytes; the maximum for this upload is {cap} bytes",
                    details={"size_bytes": len(data), "max_bytes": cap},
                )
            content_type = _content_type(path)
            sha256 = self._blobs.put(
                namespace=str(artifact["project_id"]), data=data, content_type=content_type,
            )
            if kind == "figure":
                conn.execute(
                    """
                    UPDATE artifact_figures
                    SET status = 'complete', upload_token = '', expires_at = NULL,
                        content_sha256 = ?, size_bytes = ?
                    WHERE id = ?
                    """,
                    (sha256, len(data), row["id"]),
                )
                return CompletedFigure(
                    artifact_id=str(artifact["id"]), link_path=path,
                    sha256=sha256, size_bytes=len(data),
                )
            figures = self._create_figure_uploads(tx=conn, row=artifact, data=data)
            conn.execute(
                """
                UPDATE artifacts
                SET status = 'complete', upload_token = '', expires_at = NULL,
                    content_sha256 = ?, size_bytes = ?, content_type = ?, updated_at = ?
                WHERE id = ?
                """,
                (sha256, len(data), content_type, now_iso(), artifact["id"]),
            )
            return CompletedArtifact(
                artifact_id=str(artifact["id"]), path=path, sha256=sha256,
                size_bytes=len(data), figures=figures,
            )

    def cancel_upload(self, *, token: str, kind: UploadKind, tx: Connection) -> None:
        """Retire an unconsumed credential without altering completed content."""
        self._pending(tx=tx, token=token, kind=kind)
        if kind == "artifact":
            tx.execute("DELETE FROM artifacts WHERE upload_token = ? AND status = 'pending'", (token,))
        else:
            tx.execute(
                """
                UPDATE artifact_figures SET status = 'expired', upload_token = '', expires_at = NULL
                WHERE upload_token = ? AND status = 'pending'
                """, (token,),
            )

    def get(
        self,
        *,
        artifact_ids: tuple[str, ...],
        project_id: str | None = None,
        include: ReadMode = "metadata",
        tx: Connection | None = None,
    ) -> tuple[Artifact, ...]:
        """Read versions in request order, with optional bytes and attachments."""
        ids = tuple(dict.fromkeys(str(item) for item in artifact_ids if item))
        if not ids:
            return ()
        if include not in ("metadata", "content", "document"):
            raise ValidationError(f"unknown artifact read mode: {include}")
        placeholders = ", ".join("?" for _ in ids)
        with (nullcontext(tx) if tx is not None else closing(self._store.connect())) as conn:
            where, params = f"id IN ({placeholders})", ids
            if project_id is not None:
                project_id = self._store.require_project_id(conn=conn, project_id=project_id)
                where += " AND project_id = ?"
                params = (*ids, project_id)
            rows = conn.execute(f"SELECT * FROM artifacts WHERE {where}", params).fetchall()
            links: dict[str, list[str]] = {}
            if include == "document":
                for row in conn.execute(
                    f"""
                    SELECT artifact_id, link_path FROM artifact_figures
                    WHERE artifact_id IN ({placeholders}) AND status = 'complete'
                    ORDER BY link_path
                    """, ids,
                ).fetchall():
                    links.setdefault(str(row["artifact_id"]), []).append(str(row["link_path"]))
        by_id = {str(row["id"]): row for row in rows}
        result: list[Artifact] = []
        for artifact_id in ids:
            row = by_id.get(artifact_id)
            if row is None:
                continue
            data = None
            if include != "metadata":
                try:
                    data = self._content(row)
                except Exception:
                    if include == "document":
                        raise
            result.append(Artifact.from_row(row, data=data, figures=tuple(links.get(artifact_id, ()))))
        return tuple(result)

    def figure(
        self, *, artifact_id: str, link_path: str, project_id: str | None = None,
    ) -> bytes | None:
        """Read one immutable attachment within its project's scope."""
        with closing(self._store.connect()) as tx:
            where = ["f.artifact_id = ?", "f.link_path = ?", "f.status = 'complete'"]
            params: list[Any] = [artifact_id, link_path]
            if project_id is not None:
                project_id = self._store.require_project_id(conn=tx, project_id=project_id)
                where.append("a.project_id = ?")
                params.append(project_id)
            row = tx.execute(
                f"""
                SELECT a.project_id, f.content_sha256
                FROM artifact_figures f JOIN artifacts a ON a.id = f.artifact_id
                WHERE {' AND '.join(where)}
                """, params,
            ).fetchone()
        if row is None:
            return None
        try:
            return self._blobs.get(namespace=str(row["project_id"]), sha256=str(row["content_sha256"]))
        except NotFoundError:
            return None

    def assert_complete(
        self, *, artifact_ids: tuple[str, ...], project_id: str, tx: Connection,
    ) -> None:
        """Require immutable content and a fully populated attachment manifest."""
        ids = tuple(dict.fromkeys(artifact_ids))
        artifacts = self.get(artifact_ids=ids, project_id=project_id, tx=tx)
        if len(artifacts) != len(ids):
            raise NotFoundError("one or more artifacts are unavailable in this project")
        for artifact in artifacts:
            if artifact.status != "complete" or not artifact.sha256:
                raise ValidationError(f"artifact {artifact.id} has no completed content")
        if ids:
            placeholders = ", ".join("?" for _ in ids)
            missing = tx.execute(
                f"""
                SELECT artifact_id, link_path FROM artifact_figures
                WHERE artifact_id IN ({placeholders}) AND status != 'complete'
                ORDER BY artifact_id, link_path
                """, ids,
            ).fetchone()
            if missing is not None:
                raise ValidationError(
                    f"artifact {missing['artifact_id']} has no completed content "
                    f"for figure {missing['link_path']!r}"
                )

    def _pending(self, *, tx: Connection, token: str, kind: UploadKind) -> Row:
        if not token:
            raise NotFoundError("an upload token is required")
        if kind == "artifact":
            where = "upload_token = ? AND status = 'pending'"
        elif kind == "figure":
            where = "id = (SELECT artifact_id FROM artifact_figures WHERE upload_token = ? AND status = 'pending')"
        else:
            raise ValidationError(f"unknown upload kind: {kind}")
        row = tx.execute(f"SELECT * FROM artifacts WHERE {where}", (token,)).fetchone()
        if row is None:
            raise NotFoundError(f"unknown, used, or expired {kind} upload token — create a new upload")
        return row

    def _create_figure_uploads(
        self, *, tx: Connection, row: Row, data: bytes,
    ) -> tuple[PendingFigure, ...]:
        if not row["discover_figures"]:
            return ()
        pending: list[PendingFigure] = []
        for link_path in dict.fromkeys(markdown.markdown_image_links(data.decode("utf-8", errors="replace"))):
            problem = markdown.figure_link_problem(link_path)
            if problem:
                raise ValidationError(f"{problem} — fix the link and re-upload")
            token = secrets.token_urlsafe(24)
            tx.execute(
                """
                INSERT INTO artifact_figures (
                  id, artifact_id, link_path, status, upload_token, expires_at
                ) VALUES (?, ?, ?, 'pending', ?, ?)
                """,
                (new_id(prefix="fig"), row["id"], link_path, token, iso_after(seconds=UPLOAD_TOKEN_TTL_SECONDS)),
            )
            pending.append(PendingFigure(link_path=link_path, token=token))
        return tuple(pending)

    def _content(self, row: Row) -> bytes | None:
        if str(row["status"]) != "complete" or not row["content_sha256"]:
            return None
        try:
            return self._blobs.get(namespace=str(row["project_id"]), sha256=str(row["content_sha256"]))
        except NotFoundError:
            return None

    def _sweep_expired(self, *, tx: Connection | None = None) -> None:
        with (nullcontext(tx) if tx is not None else self._store.transaction()) as conn:
            now = now_iso()
            # Keep the manifest so expiry can never make an incomplete document
            # appear complete; only its upload credential is retired.
            conn.execute(
                """
                UPDATE artifact_figures SET status = 'expired', upload_token = '', expires_at = NULL
                WHERE status = 'pending' AND expires_at < ?
                """, (now,),
            )
            conn.execute("DELETE FROM artifacts WHERE status = 'pending' AND expires_at < ?", (now,))


def _clean_path(path: str) -> str:
    cleaned = str(path).strip().replace("\\", "/").lstrip("/")
    if not cleaned:
        raise ValidationError("path is required (a display name for the content)")
    return cleaned


def _content_type(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    suffix = ("." + name.rsplit(".", 1)[-1]).lower() if "." in name else ""
    return _CONTENT_TYPES.get(suffix) or mimetypes.guess_type(name)[0] or "application/octet-stream"
