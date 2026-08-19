# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Typed artifact records, blob uploads, figures, and immutable history.

Bytes are stored before rows point at them. Research supplies target facts;
``seal`` joins Research's transaction so a workflow transition stays atomic.
"""

from __future__ import annotations

from contextlib import closing
import mimetypes
import secrets
from typing import Any

from merv.shared import artifact_roles as roles
from merv.shared import markdown_images as markdown
from merv.shared.content_summaries import content_tldr

from ..kernel.ports.blob_store import EvidenceBlobStore
from ..kernel.state.store import BaseStateStore, Connection, Row, next_created_seq
from ..kernel.utils import (
    NotFoundError, ValidationError, iso_after, new_id, now_iso,
)
from .models import (
    Artifact, ArtifactTarget, ArtifactTargets, CompletedArtifact, CompletedFigure,
    PendingFigure, PendingUpload, ReadMode, Submission, TargetHistory, UploadKind,
)


UPLOAD_TOKEN_TTL_SECONDS = 15 * 60
MAX_SUBMITTED_TEXT_BYTES = 16_000

_CONTENT_TYPES = {".md": "text/markdown", ".json": "application/json"}


class Artifacts:
    """Submit evidence, store its bytes, read it, and seal immutable history."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        blobs: EvidenceBlobStore,
        targets: ArtifactTargets,
    ) -> None:
        self._store = store
        self._blobs = blobs
        self._targets = targets

    # Agent upload lifecycle

    def submit(
        self,
        *,
        target: ArtifactTarget,
        role: str,
        path: str,
        lens_id: str = "",
        title: str = "",
    ) -> PendingUpload:
        """Create a pending artifact and return its one-time upload token."""
        _validate_association(target_type=target.target_type, role=role)
        if role == roles.REFLECTION_LENS_DOC_ROLE and not lens_id:
            raise ValidationError(
                "lens_id is required for reflection_lens_doc artifacts — pass "
                "the roster lens this reflection covers"
            )
        if lens_id and role != roles.REFLECTION_LENS_DOC_ROLE:
            raise ValidationError(
                "lens_id only applies to reflection_lens_doc artifacts"
            )

        path = _clean_path(path)
        if not path:
            raise ValidationError("path is required (the local file you wrote)")

        self._sweep_expired()
        with self._store.transaction() as tx:
            target = self._resolve_target(tx=tx, target=target, for_submission=True)
            project_id = str(target.project_id)
            artifact_id = new_id(prefix="art")
            token = secrets.token_urlsafe(24)
            now = now_iso()
            tx.execute(
                """
                INSERT INTO artifacts (
                  id, project_id, target_type, target_id, role, attempt_index,
                  lens_id, path, title, status, upload_token, expires_at,
                  created_by, created_at, updated_at, created_seq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    project_id,
                    target.target_type,
                    target.target_id,
                    role,
                    target.attempt_index,
                    lens_id,
                    path,
                    title,
                    token,
                    iso_after(seconds=UPLOAD_TOKEN_TTL_SECONDS),
                    "agent",
                    now,
                    now,
                    next_created_seq(conn=tx, table="artifacts"),
                ),
            )
        return PendingUpload(artifact_id=artifact_id, token=token, path=path)

    def upload_cap(self, *, token: str, kind: UploadKind) -> int:
        """Validate a token and return its byte cap before the body is read."""
        self._sweep_expired()
        with closing(self._store.connect()) as tx:
            if kind == "figure":
                row = tx.execute(
                    """
                    SELECT 1 FROM artifact_figures
                    WHERE upload_token = ? AND status = 'pending'
                    """,
                    (token,),
                ).fetchone()
                if row is None:
                    raise NotFoundError(
                        "unknown, used, or expired figure token — resubmit the "
                        "document to mint fresh figure uploads"
                    )
                return markdown.MARKDOWN_FIGURE_MAX_BYTES
            if kind != "artifact":
                raise ValidationError(f"unknown upload kind: {kind}")

            row = tx.execute(
                """
                SELECT role FROM artifacts
                WHERE upload_token = ? AND status = 'pending'
                """,
                (token,),
            ).fetchone()
        if row is None:
            raise NotFoundError(
                "unknown, used, or expired upload token — call artifact.submit again"
            )
        cap = roles.artifact_byte_cap(str(row["role"]))
        return markdown.MARKDOWN_FIGURE_MAX_BYTES if cap is None else cap

    def complete_upload(
        self,
        *,
        token: str,
        kind: UploadKind,
        data: bytes,
    ) -> CompletedArtifact | CompletedFigure:
        """Consume an artifact or figure token and pin the uploaded bytes."""
        self._sweep_expired()
        if kind == "figure":
            return self._complete_figure(token=token, data=data)
        if kind == "artifact":
            return self._complete_artifact(token=token, data=data)
        raise ValidationError(f"unknown upload kind: {kind}")

    # Reads

    def get(
        self,
        *,
        artifact_ids: tuple[str, ...],
        project_id: str | None = None,
        include: ReadMode = "metadata",
    ) -> tuple[Artifact, ...]:
        """Read artifacts by id, preserving first-seen request order."""
        ids = tuple(dict.fromkeys(str(item) for item in artifact_ids if item))
        if not ids:
            return ()
        if include not in ("metadata", "content", "document"):
            raise ValidationError(f"unknown artifact read mode: {include}")

        placeholders = ", ".join("?" for _ in ids)
        with closing(self._store.connect()) as tx:
            if project_id is not None:
                project_id = self._store.require_project_id(
                    conn=tx, project_id=project_id
                )
            where = f"id IN ({placeholders})"
            params: tuple[Any, ...] = ids
            if project_id is not None:
                where += " AND project_id = ?"
                params = (*ids, project_id)
            rows = tx.execute(
                f"SELECT * FROM artifacts WHERE {where}",
                params,
            ).fetchall()

            figure_links: dict[str, list[str]] = {}
            if include == "document":
                for row in tx.execute(
                    f"""
                    SELECT artifact_id, link_path FROM artifact_figures
                    WHERE artifact_id IN ({placeholders}) AND status = 'complete'
                    ORDER BY link_path
                    """,
                    ids,
                ).fetchall():
                    figure_links.setdefault(str(row["artifact_id"]), []).append(
                        str(row["link_path"])
                    )

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
            result.append(
                Artifact.from_row(
                    row,
                    data=data,
                    figures=tuple(figure_links.get(artifact_id, ())),
                )
            )
        return tuple(result)

    def scan(
        self,
        *,
        project_id: str | None = None,
        target_type: str = "",
        target_ids: tuple[str, ...] = (),
        roles: tuple[str, ...] = (),
    ) -> tuple[Artifact, ...]:
        """List complete artifact metadata with optional target filters."""
        ids = tuple(dict.fromkeys(str(item) for item in target_ids if item))
        role_names = tuple(dict.fromkeys(str(item) for item in roles if item))
        where = ["status = 'complete'"]
        params: list[Any] = []

        with closing(self._store.connect()) as tx:
            if project_id is not None:
                project_id = self._store.require_project_id(
                    conn=tx, project_id=project_id
                )
                where.append("project_id = ?")
                params.append(project_id)
            if target_type:
                where.append("target_type = ?")
                params.append(target_type)
            if ids:
                placeholders = ", ".join("?" for _ in ids)
                where.append(f"target_id IN ({placeholders})")
                params.extend(ids)
            if role_names:
                placeholders = ", ".join("?" for _ in role_names)
                where.append(f"role IN ({placeholders})")
                params.extend(role_names)

            rows = tx.execute(
                f"""
                SELECT * FROM artifacts
                WHERE {' AND '.join(where)}
                ORDER BY target_type, target_id, attempt_index, role, path
                """,
                params,
            ).fetchall()

        return tuple(Artifact.from_row(row) for row in rows)

    def figure(
        self,
        *,
        artifact_id: str,
        link_path: str,
        project_id: str | None = None,
    ) -> bytes | None:
        """Return one submitted figure, or ``None`` when it is unavailable."""
        with closing(self._store.connect()) as tx:
            if project_id is not None:
                project_id = self._store.require_project_id(
                    conn=tx, project_id=project_id
                )
            where = [
                "f.artifact_id = ?",
                "f.link_path = ?",
                "f.status = 'complete'",
            ]
            params: list[Any] = [artifact_id, link_path]
            if project_id is not None:
                where.append("a.project_id = ?")
                params.append(project_id)
            row = tx.execute(
                f"""
                SELECT a.project_id, f.content_sha256
                FROM artifact_figures f
                JOIN artifacts a ON a.id = f.artifact_id
                WHERE {' AND '.join(where)}
                """,
                params,
            ).fetchone()
        if row is None:
            return None
        try:
            return self._blobs.get(
                namespace=str(row["project_id"]),
                sha256=str(row["content_sha256"]),
            )
        except NotFoundError:
            return None

    # System writes and immutable history

    def pin(
        self,
        *,
        target: ArtifactTarget,
        role: str,
        path: str,
        data: bytes,
        title: str = "",
        tx: Connection | None = None,
    ) -> None:
        """Write a complete system-created artifact without an upload token.

        Pass ``tx`` to pin inside a caller's open transaction (a reflection
        publish pins each proposed task's brief this way); otherwise the pin
        runs in its own transaction.
        """
        path = _clean_path(path)
        if tx is not None:
            self._pin(tx=tx, target=target, role=role, path=path, data=data, title=title)
            return
        with self._store.transaction() as tx:
            self._pin(tx=tx, target=target, role=role, path=path, data=data, title=title)

    def _pin(
        self,
        *,
        tx: Connection,
        target: ArtifactTarget,
        role: str,
        path: str,
        data: bytes,
        title: str,
    ) -> None:
        target = self._resolve_target(tx=tx, target=target)
        project_id = str(target.project_id)
        content_type = _content_type(path)
        sha256 = self._blobs.put(
            namespace=project_id,
            data=data,
            content_type=content_type,
        )
        artifact_id = new_id(prefix="art")
        now = now_iso()
        order = next_created_seq(conn=tx, table="artifacts")

        # Keep sealed rounds; replace only the live system artifact.
        tx.execute(
            """
            DELETE FROM artifacts
            WHERE project_id = ? AND target_type = ? AND target_id = ?
              AND role = ? AND attempt_index = ? AND submission_id = ''
            """,
            (
                project_id,
                target.target_type,
                target.target_id,
                role,
                target.attempt_index,
            ),
        )
        tx.execute(
            """
            INSERT INTO artifacts (
              id, project_id, target_type, target_id, role, attempt_index,
              lens_id, path, title, content_sha256, size_bytes, content_type,
              status, upload_token, created_by, created_at, updated_at, created_seq
            )
            VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'complete', '', ?, ?, ?, ?)
            """,
            (
                artifact_id,
                project_id,
                target.target_type,
                target.target_id,
                role,
                target.attempt_index,
                path,
                title,
                sha256,
                len(data),
                content_type,
                roles.SYSTEM_CREATED_BY,
                now,
                now,
                order,
            ),
        )
        self._store.record_event(
            conn=tx,
            project_id=project_id,
            event_type="artifact.pinned",
            target_type=target.target_type,
            target_id=target.target_id,
            payload={
                "artifact_id": artifact_id,
                "role": role,
                "path": path,
            },
        )

    def seal(
        self,
        *,
        tx: Connection,
        target: ArtifactTarget,
        transition: str,
    ) -> None:
        """Freeze the target's live composition on Research's transaction."""
        target = self._resolve_target(tx=tx, target=target)
        project_id = str(target.project_id)
        submission_id = new_id(prefix="sub")
        created_at = now_iso()
        order = next_created_seq(conn=tx, table="submissions")
        tx.execute(
            """
            INSERT INTO submissions (
              id, project_id, target_type, target_id, attempt_index,
              transition, created_at, created_seq
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                submission_id,
                project_id,
                target.target_type,
                target.target_id,
                target.attempt_index,
                transition,
                created_at,
                order,
            ),
        )
        tx.execute(
            """
            UPDATE artifacts SET submission_id = ?
            WHERE project_id = ? AND target_type = ? AND target_id = ?
              AND attempt_index = ? AND status = 'complete' AND submission_id = ''
            """,
            (
                submission_id,
                project_id,
                target.target_type,
                target.target_id,
                target.attempt_index,
            ),
        )

    def history(
        self,
        *,
        tx: Connection,
        target_type: str,
        target_ids: tuple[str, ...],
        summarize: bool = False,
    ) -> dict[str, TargetHistory]:
        """Read artifact and submission history for many targets at once."""
        ids = tuple(dict.fromkeys(str(item) for item in target_ids if item))
        if not ids:
            return {}
        placeholders = ", ".join("?" for _ in ids)

        artifact_rows = tx.execute(
            f"""
            SELECT * FROM artifacts
            WHERE status = 'complete' AND target_type = ?
              AND target_id IN ({placeholders})
            ORDER BY target_id, attempt_index, role, path
            """,
            (target_type, *ids),
        ).fetchall()
        submission_rows = tx.execute(
            f"""
            SELECT id, target_id, attempt_index, transition, created_at, created_seq
            FROM submissions
            WHERE target_type = ? AND target_id IN ({placeholders})
            ORDER BY created_seq
            """,
            (target_type, *ids),
        ).fetchall()

        artifacts: dict[str, list[Artifact]] = {target_id: [] for target_id in ids}
        submissions: dict[str, list[Submission]] = {
            target_id: [] for target_id in ids
        }
        for row in artifact_rows:
            tldr = ""
            if summarize:
                try:
                    data = self._content(row)
                except Exception:
                    # History is durable even when a best-effort blob read is not.
                    data = None
                text = (
                    None
                    if data is None
                    else data.decode("utf-8", errors="replace")
                )
                tldr = content_tldr(
                    text,
                    role=str(row["role"] or ""),
                    path=str(row["path"] or ""),
                )
            artifacts[str(row["target_id"])].append(
                Artifact.from_row(row, tldr=tldr)
            )
        for row in submission_rows:
            target_id = str(row["target_id"])
            submissions[target_id].append(Submission.from_row(row))
        return {
            target_id: TargetHistory(
                artifacts=tuple(artifacts[target_id]),
                submissions=tuple(submissions[target_id]),
            )
            for target_id in ids
        }

    # Upload internals

    def _complete_artifact(
        self,
        *,
        token: str,
        data: bytes,
    ) -> CompletedArtifact:
        stale_error: ValidationError | None = None
        completed: CompletedArtifact | None = None
        with self._store.transaction() as tx:
            row = tx.execute(
                """
                SELECT * FROM artifacts
                WHERE upload_token = ? AND status = 'pending'
                """,
                (token,),
            ).fetchone()
            if row is None:
                raise NotFoundError(
                    "unknown, used, or expired upload token — call artifact.submit again"
                )

            stale_error = self._stale_upload_error(tx=tx, row=row)
            if stale_error is not None:
                # Commit the deletion before raising so the stale token dies.
                tx.execute(
                    "DELETE FROM artifact_figures WHERE artifact_id = ?",
                    (row["id"],),
                )
                tx.execute("DELETE FROM artifacts WHERE id = ?", (row["id"],))
            else:
                role = str(row["role"])
                path = str(row["path"])
                cap = roles.artifact_byte_cap(role)
                if cap is not None and len(data) > cap:
                    raise ValidationError(
                        f"{path} is {len(data)} bytes; the maximum for a "
                        f"role-{role!r} artifact is {cap} bytes — slim the file "
                        "(move raw data/outputs elsewhere and reference them) "
                        "and resubmit",
                        details={
                            "role": role,
                            "size_bytes": len(data),
                            "max_bytes": cap,
                        },
                    )

                project_id = str(row["project_id"])
                content_type = _content_type(path)
                sha256 = self._blobs.put(
                    namespace=project_id,
                    data=data,
                    content_type=content_type,
                )
                self._replace_slot(tx=tx, row=row)
                tx.execute(
                    """
                    UPDATE artifacts
                    SET status = 'complete', upload_token = '', expires_at = NULL,
                        content_sha256 = ?, size_bytes = ?, content_type = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        sha256,
                        len(data),
                        content_type,
                        now_iso(),
                        row["id"],
                    ),
                )
                self._store.record_event(
                    conn=tx,
                    project_id=project_id,
                    event_type="artifact.submitted",
                    target_type=str(row["target_type"]),
                    target_id=str(row["target_id"]),
                    payload={
                        "artifact_id": str(row["id"]),
                        "role": role,
                        "path": path,
                        "attempt_index": int(row["attempt_index"]),
                    },
                )
                figures = self._create_figure_uploads(tx=tx, row=row, data=data)
                completed = CompletedArtifact(
                    artifact_id=str(row["id"]),
                    role=role,
                    path=path,
                    sha256=sha256,
                    size_bytes=len(data),
                    figures=figures,
                )

        if stale_error is not None:
            raise stale_error
        assert completed is not None
        return completed

    def _complete_figure(
        self,
        *,
        token: str,
        data: bytes,
    ) -> CompletedFigure:
        stale_error: ValidationError | None = None
        completed: CompletedFigure | None = None
        with self._store.transaction() as tx:
            row = tx.execute(
                """
                SELECT f.*, a.project_id, a.target_type, a.target_id,
                       a.attempt_index
                FROM artifact_figures f
                JOIN artifacts a ON a.id = f.artifact_id
                WHERE f.upload_token = ? AND f.status = 'pending'
                """,
                (token,),
            ).fetchone()
            if row is None:
                raise NotFoundError(
                    "unknown, used, or expired figure token — resubmit the "
                    "document to mint fresh figure uploads"
                )

            link_path = str(row["link_path"])
            stale_error = self._stale_upload_error(tx=tx, row=row)
            if stale_error is not None:
                tx.execute(
                    """
                    DELETE FROM artifact_figures
                    WHERE artifact_id = ? AND status = 'pending'
                    """,
                    (row["artifact_id"],),
                )
            else:
                if len(data) > markdown.MARKDOWN_FIGURE_MAX_BYTES:
                    raise ValidationError(
                        f"figure {link_path!r} is {len(data)} bytes; the maximum "
                        f"is {markdown.MARKDOWN_FIGURE_MAX_BYTES} bytes",
                        details={
                            "size_bytes": len(data),
                            "max_bytes": markdown.MARKDOWN_FIGURE_MAX_BYTES,
                        },
                    )
                sha256 = self._blobs.put(
                    namespace=str(row["project_id"]),
                    data=data,
                    content_type=_content_type(link_path),
                )
                tx.execute(
                    """
                    UPDATE artifact_figures
                    SET status = 'complete', upload_token = '', expires_at = NULL,
                        content_sha256 = ?, size_bytes = ?
                    WHERE id = ?
                    """,
                    (sha256, len(data), row["id"]),
                )
                completed = CompletedFigure(
                    artifact_id=str(row["artifact_id"]),
                    link_path=link_path,
                    sha256=sha256,
                    size_bytes=len(data),
                )

        if stale_error is not None:
            raise stale_error
        assert completed is not None
        return completed

    def _stale_upload_error(
        self,
        *,
        tx: Connection,
        row: Row,
    ) -> ValidationError | None:
        """Return the error to raise after its stale token is deleted."""
        try:
            target = self._resolve_target(
                tx=tx,
                target=ArtifactTarget(
                    target_type=str(row["target_type"]),
                    target_id=str(row["target_id"]),
                    project_id=str(row["project_id"]),
                    attempt_index=int(row["attempt_index"]),
                ),
                for_submission=True,
            )
        except (NotFoundError, ValidationError) as exc:
            reason = getattr(exc, "message", None) or str(exc)
            return ValidationError(
                f"upload refused — {reason}. This upload token has expired; "
                "submit new work against a live target with artifact.submit"
            )

        minted_for = int(row["attempt_index"])
        if target.attempt_index != minted_for:
            return ValidationError(
                "upload refused — attempt superseded. This token was minted for "
                f"attempt {minted_for} and attempt {target.attempt_index} is now "
                "open; call artifact.submit again to upload into the current one"
            )
        return None

    def _resolve_target(
        self,
        *,
        tx: Connection,
        target: ArtifactTarget,
        for_submission: bool = False,
    ) -> ArtifactTarget:
        project_id = self._store.require_project_id(
            conn=tx, project_id=target.project_id
        )
        return self._targets.resolve(
            tx=tx,
            target=ArtifactTarget(
                target.target_type,
                target.target_id,
                project_id,
                target.attempt_index,
            ),
            for_submission=for_submission,
        )

    def _replace_slot(self, *, tx: Connection, row: Row) -> None:
        """Replace only unsealed rows in the same artifact slot."""
        stale = tx.execute(
            """
            SELECT id FROM artifacts
            WHERE project_id = ? AND target_type = ? AND target_id = ?
              AND role = ? AND attempt_index = ? AND lens_id = ? AND path = ?
              AND status = 'complete' AND submission_id = '' AND id != ?
            """,
            (
                row["project_id"],
                row["target_type"],
                row["target_id"],
                row["role"],
                row["attempt_index"],
                row["lens_id"],
                row["path"],
                row["id"],
            ),
        ).fetchall()
        for old in stale:
            artifact_id = str(old["id"])
            if self._targets.is_protected(tx=tx, artifact_id=artifact_id):
                continue
            tx.execute(
                "DELETE FROM artifact_figures WHERE artifact_id = ?",
                (artifact_id,),
            )
            tx.execute("DELETE FROM artifacts WHERE id = ?", (artifact_id,))

    def _create_figure_uploads(
        self,
        *,
        tx: Connection,
        row: Row,
        data: bytes,
    ) -> tuple[PendingFigure, ...]:
        if str(row["role"]) not in markdown.MARKDOWN_FIGURE_ROLES:
            return ()

        pending: list[PendingFigure] = []
        text = data.decode("utf-8", errors="replace")
        for link_path in dict.fromkeys(markdown.markdown_image_links(text)):
            problem = markdown.figure_link_problem(link_path)
            if problem:
                raise ValidationError(
                    f"{problem} — fix the link and re-upload"
                )
            token = secrets.token_urlsafe(24)
            tx.execute(
                """
                INSERT INTO artifact_figures (
                  id, artifact_id, link_path, status, upload_token, expires_at
                )
                VALUES (?, ?, ?, 'pending', ?, ?)
                """,
                (
                    new_id(prefix="fig"),
                    row["id"],
                    link_path,
                    token,
                    iso_after(seconds=UPLOAD_TOKEN_TTL_SECONDS),
                ),
            )
            pending.append(PendingFigure(link_path=link_path, token=token))
        return tuple(pending)

    def _content(self, row: Row) -> bytes | None:
        if str(row["status"]) != "complete" or not row["content_sha256"]:
            return None
        try:
            return self._blobs.get(
                namespace=str(row["project_id"]),
                sha256=str(row["content_sha256"]),
            )
        except NotFoundError:
            return None

    def _sweep_expired(self) -> None:
        """Expire tokens in their own transaction so failed access still sweeps."""
        now = now_iso()
        with self._store.transaction() as tx:
            tx.execute(
                """
                DELETE FROM artifact_figures
                WHERE status = 'pending' AND expires_at < ?
                """,
                (now,),
            )
            tx.execute(
                """
                DELETE FROM artifacts
                WHERE status = 'pending' AND expires_at < ?
                """,
                (now,),
            )

def _clean_path(path: str) -> str:
    return str(path).strip().replace("\\", "/").lstrip("/")


def _content_type(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    suffix = ("." + name.rsplit(".", 1)[-1]).lower() if "." in name else ""
    return (
        _CONTENT_TYPES.get(suffix)
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream"
    )


def _validate_association(*, target_type: str, role: str) -> None:
    if target_type not in roles.ARTIFACT_TARGET_TYPES:
        allowed = sorted(roles.ARTIFACT_TARGET_TYPES)
        raise ValidationError(
            f"unknown artifact target type: {target_type}. "
            f"Allowed target types: {', '.join(allowed)}",
            details={"allowed_target_types": allowed},
        )
    if role in roles.LEGACY_ROLE_REPLACEMENTS:
        replacement = roles.LEGACY_ROLE_REPLACEMENTS[role]
        raise ValidationError(
            f"legacy artifact role {role!r} is read-only for old records; "
            f"use {replacement!r}",
            details={"legacy_role": role, "replacement_role": replacement},
        )
    if target_type == "reflection" and role == roles.LEGACY_PROJECT_GRAPH_ROLE:
        raise ValidationError(
            "use role 'project_graph' for reflection-wave project graphs; "
            "role 'graph' is only for experiment logic graphs",
            details={
                "legacy_role": roles.LEGACY_PROJECT_GRAPH_ROLE,
                "replacement_role": roles.PROJECT_GRAPH_ROLE,
            },
        )
    if role not in roles.SUBMITTABLE_ROLES:
        allowed = sorted(roles.SUBMITTABLE_ROLES)
        raise ValidationError(
            f"unknown artifact role: {role}. Allowed roles: {', '.join(allowed)}",
            details={
                "allowed_roles": allowed,
                "recommended_result_role": "result",
            },
        )
