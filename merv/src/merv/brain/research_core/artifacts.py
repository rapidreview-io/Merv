# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research associations and evidence snapshots over immutable artifact content.

The generic store never calls Research. This module owns role policy, current
slots, submission intent, and the association IDs exposed by the research API.
"""

from __future__ import annotations

from contextlib import closing
from typing import Any

from ..workflows import artifact_roles as roles
from merv.shared import markdown_images as markdown
from .content_summaries import content_tldr
from ..artifacts import Artifacts, CompletedFigure, PendingUpload
from ..kernel.state.store import BaseStateStore, Connection, next_created_seq
from ..kernel.utils import NotFoundError, ValidationError, new_id, now_iso
from .artifact_models import (
    Artifact,
    ArtifactTarget,
    CompletedArtifact,
    Submission,
    TargetHistory,
)
from .association_targets import AssociationTargets
from .persistence import RESEARCH_SCHEMA


_VISIBLE = "(active = 1 OR submission_id != '' OR status = 'pending')"


class ResearchArtifacts:
    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts) -> None:
        self._store = store
        self.contents = artifacts
        self._targets = AssociationTargets()
        store.install(RESEARCH_SCHEMA)

    def submit(
        self,
        *,
        target: ArtifactTarget,
        role: str,
        path: str,
        lens_id: str = "",
        title: str = "",
    ) -> PendingUpload:
        _validate_association(
            target_type=target.target_type, role=role, lens_id=lens_id
        )
        with self._store.transaction() as tx:
            target = self._resolve_target(tx=tx, target=target, for_submission=True)
            pending = self.contents.submit(
                project_id=str(target.project_id),
                path=path,
                title=title,
                max_bytes=roles.artifact_byte_cap(role)
                or markdown.MARKDOWN_FIGURE_MAX_BYTES,
                discover_figures=role in roles.MARKDOWN_FIGURE_ROLES,
                tx=tx,
            )
            self._link(
                tx,
                pending.artifact_id,
                target,
                role,
                lens_id,
                active=False,
                association_id=pending.artifact_id,
            )
            return pending

    def upload_cap(self, *, token: str, kind: str) -> int:
        return self.contents.upload_cap(token=token, kind=kind)

    def complete_upload(self, *, token: str, kind: str, data: bytes):
        stale = None
        role = ""
        with self._store.transaction() as tx:
            pending = self.contents.pending(token=token, kind=kind, tx=tx)
            row = tx.execute(
                "SELECT * FROM research_artifacts WHERE id = ?", (pending.id,)
            ).fetchone()
            if row is not None:
                role = str(row["role"])
                stale = self._stale_upload_error(tx=tx, row=row)
            if stale is not None:
                self.contents.cancel_upload(token=token, kind=kind, tx=tx)
            else:
                # The combined V1 operation joins content and acceptance so a
                # failed research event leaves the token retryable. Generic
                # uploads have no association and require a separate attach.
                completed = self.contents.complete_upload(
                    token=token, kind=kind, data=data, tx=tx
                )
                if row is not None and kind == "artifact":
                    self._replace_slot(tx=tx, row=row)
                    tx.execute(
                        "UPDATE research_artifact_links SET active = 1 WHERE id = ?",
                        (row["id"],),
                    )
                    self._event(tx, row, "artifact.submitted")
        if stale is not None:
            raise stale
        if kind == "figure":
            return completed
        return CompletedArtifact(
            artifact_id=completed.artifact_id,
            role=role,
            path=completed.path,
            sha256=completed.sha256,
            size_bytes=completed.size_bytes,
            figures=completed.figures,
        )

    def attach(
        self,
        *,
        artifact_id: str,
        target: ArtifactTarget,
        role: str,
        lens_id: str = "",
        tx: Connection | None = None,
    ) -> Artifact:
        """Accept existing immutable content into a workflow with its own handle."""
        _validate_association(
            target_type=target.target_type, role=role, lens_id=lens_id
        )
        if tx is None:
            with self._store.transaction() as tx:
                return self.attach(
                    artifact_id=artifact_id,
                    target=target,
                    role=role,
                    lens_id=lens_id,
                    tx=tx,
                )
        target = self._resolve_target(tx=tx, target=target, for_submission=True)
        project_id = str(target.project_id)
        self.contents.assert_complete(
            artifact_ids=(artifact_id,), project_id=project_id, tx=tx
        )
        content = self.contents.get(
            artifact_ids=(artifact_id,),
            project_id=project_id,
            include="document",
            tx=tx,
        )[0]
        if content.data is None:
            raise ValidationError("artifact content is unavailable; upload a new version before attaching it")
        cap = roles.artifact_byte_cap(role)
        if cap is not None and content.size_bytes > cap:
            raise ValidationError(
                "artifact exceeds this research role's size limit",
                details={"max_bytes": cap},
            )
        if role in roles.MARKDOWN_FIGURE_ROLES:
            text = (content.data or b"").decode("utf-8", errors="replace")
            for link in markdown.markdown_image_links(text):
                problem = markdown.figure_link_problem(link)
                if problem or link not in content.figures:
                    raise ValidationError(problem or f"missing figure: {link}")
        association_id = self._link(tx, artifact_id, target, role, lens_id, active=True)
        row = tx.execute(
            "SELECT * FROM research_artifacts WHERE id = ?", (association_id,)
        ).fetchone()
        self._replace_slot(tx=tx, row=row)
        self._event(tx, row, "artifact.submitted")
        return Artifact.from_row(row)

    def _link(
        self, tx, artifact_id, target, role, lens_id="", *, active, association_id=None
    ):
        association_id = association_id or new_id(prefix="artref")
        tx.execute(
            """INSERT INTO research_artifact_links
            (id,artifact_id,project_id,target_type,target_id,role,attempt_index,lens_id,active,created_at,created_seq)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                association_id,
                artifact_id,
                target.project_id,
                target.target_type,
                target.target_id,
                role,
                target.attempt_index,
                lens_id,
                int(active),
                now_iso(),
                next_created_seq(conn=tx, table="research_artifact_links"),
            ),
        )
        return association_id

    def get(
        self,
        *,
        artifact_ids: tuple[str, ...],
        project_id: str | None = None,
        include: str = "metadata",
    ) -> tuple[Artifact, ...]:
        ids = tuple(dict.fromkeys(artifact_ids))
        if not ids:
            return ()
        if include not in {"metadata", "content", "document"}:
            raise ValidationError(f"unknown artifact read mode: {include}")
        with closing(self._store.connect()) as tx:
            where, params = [f"id IN ({','.join('?' for _ in ids)})", _VISIBLE], list(
                ids
            )
            if project_id is not None:
                project_id = self._store.require_project_id(
                    conn=tx, project_id=project_id
                )
                where.append("project_id = ?")
                params.append(project_id)
            rows = tx.execute(
                f"SELECT * FROM research_artifacts WHERE {' AND '.join(where)}", params
            ).fetchall()
            content = self.contents.get(
                artifact_ids=tuple(str(r["artifact_id"]) for r in rows),
                project_id=project_id,
                include=include,
                tx=tx,
            )
            by_content = {a.id: a for a in content}
            by_id = {
                str(r["id"]): Artifact.from_row(
                    r,
                    data=by_content[str(r["artifact_id"])].data,
                    figures=by_content[str(r["artifact_id"])].figures,
                )
                for r in rows
            }
            return tuple(by_id[i] for i in ids if i in by_id)

    def scan(
        self, *, project_id=None, target_type="", target_ids=(), roles=()
    ) -> tuple[Artifact, ...]:
        with closing(self._store.connect()) as tx:
            where, params = ["status = 'complete'", _VISIBLE], []
            if project_id is not None:
                where.append("project_id = ?")
                params.append(
                    self._store.require_project_id(conn=tx, project_id=project_id)
                )
            if target_type:
                where.append("target_type = ?")
                params.append(target_type)
            for column, values in (("target_id", target_ids), ("role", roles)):
                if values:
                    where.append(f"{column} IN ({','.join('?' for _ in values)})")
                    params.extend(values)
            rows = tx.execute(
                f"SELECT * FROM research_artifacts WHERE {' AND '.join(where)} "
                "ORDER BY target_type,target_id,attempt_index,role,path,created_seq",
                params,
            ).fetchall()
            return tuple(Artifact.from_row(r) for r in rows)

    def figure(
        self, *, artifact_id: str, link_path: str, project_id: str | None = None
    ):
        found = self.get(artifact_ids=(artifact_id,), project_id=project_id)
        if not found:
            return None
        return self.contents.figure(
            artifact_id=found[0].artifact_id,
            link_path=link_path,
            project_id=found[0].project_id,
        )

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
        if tx is None:
            with self._store.transaction() as tx:
                self.pin(
                    target=target, role=role, path=path, data=data, title=title, tx=tx
                )
                return
        target = self._resolve_target(tx=tx, target=target)
        content = self.contents.create(
            project_id=str(target.project_id),
            path=path,
            data=data,
            title=title,
            created_by=roles.SYSTEM_CREATED_BY,
            tx=tx,
        )
        self._link(tx, content.id, target, role, active=True, association_id=content.id)
        row = tx.execute(
            "SELECT * FROM research_artifacts WHERE id = ?", (content.id,)
        ).fetchone()
        self._replace_slot(tx=tx, row=row, system=True)
        self._event(tx, row, "artifact.pinned")

    def seal(self, *, tx: Connection, target: ArtifactTarget, transition: str,
             association_ids: tuple[str, ...] | None = None) -> None:
        """Commit an explicit immutable evidence selection with the transition."""
        target = self._resolve_target(tx=tx, target=target)
        selected = None if association_ids is None else tuple(dict.fromkeys(association_ids))
        selection = "active=1"
        if selected is not None:
            selection = f"id IN ({','.join('?' for _ in selected)})" if selected else "1=0"
        rows = tx.execute(
            f"""SELECT * FROM research_artifacts
            WHERE project_id=? AND target_type=? AND target_id=? AND attempt_index=?
              AND {selection} AND status='complete' ORDER BY created_seq""",
            (
                target.project_id,
                target.target_type,
                target.target_id,
                target.attempt_index,
                *(selected or ()),
            ),
        ).fetchall()
        if selected is not None and len(rows) != len(selected):
            raise NotFoundError("one or more selected associations are unavailable for this target and attempt")
        self.contents.assert_complete(
            artifact_ids=tuple(str(r["artifact_id"]) for r in rows),
            project_id=str(target.project_id),
            tx=tx,
        )
        submission_id = new_id(prefix="sub")
        tx.execute(
            """INSERT INTO submissions
            (id,project_id,target_type,target_id,attempt_index,transition,created_at,created_seq)
            VALUES (?,?,?,?,?,?,?,?)""",
            (
                submission_id,
                target.project_id,
                target.target_type,
                target.target_id,
                target.attempt_index,
                transition,
                now_iso(),
                next_created_seq(conn=tx, table="submissions"),
            ),
        )
        for row in rows:
            tx.execute(
                "INSERT INTO research_submission_artifacts (submission_id,link_id) VALUES (?,?)",
                (submission_id, row["id"]),
            )
            tx.execute(
                "UPDATE research_artifact_links SET submission_id=? WHERE id=? AND submission_id=''",
                (submission_id, row["id"]),
            )

    def history(
        self, *, tx, target_type, target_ids, summarize=False
    ) -> dict[str, TargetHistory]:
        ids = tuple(dict.fromkeys(target_ids))
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        rows = tx.execute(
            f"SELECT * FROM research_artifacts WHERE status='complete' AND {_VISIBLE} "
            f"AND target_type=? AND target_id IN ({marks}) ORDER BY target_id,attempt_index,role,path,created_seq",
            (target_type, *ids),
        ).fetchall()
        submissions = tx.execute(
            f"SELECT * FROM submissions WHERE target_type=? AND target_id IN ({marks}) ORDER BY created_seq",
            (target_type, *ids),
        ).fetchall()
        members = {}
        for member in tx.execute(
            f"""SELECT m.submission_id,m.link_id
            FROM research_submission_artifacts m JOIN submissions s ON s.id=m.submission_id
            JOIN research_artifact_links l ON l.id=m.link_id
            WHERE s.target_type=? AND s.target_id IN ({marks}) ORDER BY l.created_seq""",
            (target_type, *ids),
        ).fetchall():
            members.setdefault(str(member["submission_id"]), []).append(
                str(member["link_id"])
            )
        artifacts = {i: [] for i in ids}
        seals = {i: [] for i in ids}
        for row in rows:
            tldr = ""
            if summarize:
                try:
                    content = self.contents.get(
                        artifact_ids=(str(row["artifact_id"]),),
                        include="content",
                        tx=tx,
                    )[0]
                    data = content.data
                except Exception:
                    data = None
                tldr = content_tldr(
                    None if data is None else data.decode("utf-8", errors="replace"),
                    role=str(row["role"]),
                    path=str(row["path"]),
                )
            artifacts[str(row["target_id"])].append(Artifact.from_row(row, tldr=tldr))
        for row in submissions:
            seals[str(row["target_id"])].append(
                Submission.from_row(
                    row, artifact_ids=tuple(members.get(str(row["id"]), ()))
                )
            )
        return {
            i: TargetHistory(artifacts=tuple(artifacts[i]), submissions=tuple(seals[i]))
            for i in ids
        }

    def snapshot(self, *, submission_id: str, project_id: str) -> tuple[Artifact, ...]:
        """Read exactly the references frozen in one committed transition."""
        with closing(self._store.connect()) as tx:
            self._store.require_project_id(conn=tx, project_id=project_id)
            found = tx.execute(
                "SELECT id FROM submissions WHERE id=? AND project_id=?",
                (submission_id, project_id),
            ).fetchone()
            if found is None:
                raise NotFoundError(
                    f"submission not found in project {project_id}: {submission_id}"
                )
            rows = tx.execute(
                """SELECT a.* FROM research_artifacts a
                JOIN research_submission_artifacts m ON m.link_id=a.id
                WHERE m.submission_id=? AND a.project_id=? ORDER BY a.created_seq""",
                (submission_id, project_id),
            ).fetchall()
            return tuple(Artifact.from_row(row) for row in rows)

    def _resolve_target(self, *, tx, target, for_submission=False):
        project_id = self._store.require_project_id(
            conn=tx, project_id=target.project_id
        )
        return self._targets.resolve(
            tx=tx,
            target=ArtifactTarget(
                target.target_type, target.target_id, project_id, target.attempt_index
            ),
            for_submission=for_submission,
        )

    def _stale_upload_error(self, *, tx, row):
        try:
            target = self._resolve_target(
                tx=tx,
                target=ArtifactTarget(
                    str(row["target_type"]),
                    str(row["target_id"]),
                    str(row["project_id"]),
                    int(row["attempt_index"]),
                ),
                for_submission=True,
            )
        except (NotFoundError, ValidationError) as exc:
            return ValidationError(
                f"upload refused — {exc}. This upload token has expired; submit new work against a live target"
            )
        if target.attempt_index != int(row["attempt_index"]):
            return ValidationError(
                "upload refused — attempt superseded. Call artifact.upload again for the current attempt"
            )
        return None

    def _replace_slot(self, *, tx, row, system=False):
        where = "project_id=? AND target_type=? AND target_id=? AND role=? AND attempt_index=? AND active=1 AND status='complete' AND id!=?"
        params = [
            row[k]
            for k in (
                "project_id",
                "target_type",
                "target_id",
                "role",
                "attempt_index",
                "id",
            )
        ]
        if not system:
            where += " AND lens_id=? AND path=?"
            params.extend((row["lens_id"], row["path"]))
        for old in tx.execute(
            f"SELECT id FROM research_artifacts WHERE {where}", params
        ).fetchall():
            if not self._targets.is_protected(tx=tx, artifact_id=str(old["id"])):
                tx.execute(
                    "UPDATE research_artifact_links SET active=0 WHERE id=?",
                    (old["id"],),
                )

    def _event(self, tx, row, event_type):
        payload = {
            "artifact_id": str(row["id"]),
            "role": str(row["role"]),
            "path": str(row["path"]),
        }
        if event_type == "artifact.submitted":
            payload["attempt_index"] = int(row["attempt_index"])
        self._store.record_event(
            conn=tx,
            project_id=str(row["project_id"]),
            event_type=event_type,
            target_type=str(row["target_type"]),
            target_id=str(row["target_id"]),
            payload=payload,
        )


def _validate_association(*, target_type: str, role: str, lens_id: str = "") -> None:
    if target_type not in roles.ARTIFACT_TARGET_TYPES:
        allowed = sorted(roles.ARTIFACT_TARGET_TYPES)
        raise ValidationError(
            f"unknown artifact target type: {target_type}. Allowed target types: {', '.join(allowed)}",
            details={"allowed_target_types": allowed},
        )
    if role in roles.LEGACY_ROLE_REPLACEMENTS:
        replacement = roles.LEGACY_ROLE_REPLACEMENTS[role]
        raise ValidationError(
            f"legacy artifact role {role!r} is read-only for old records; use {replacement!r}",
            details={"legacy_role": role, "replacement_role": replacement},
        )
    if target_type == "reflection" and role == roles.LEGACY_PROJECT_GRAPH_ROLE:
        raise ValidationError(
            "use role 'project_graph' for reflection-wave project graphs; role 'graph' is only for experiment logic graphs",
            details={
                "legacy_role": roles.LEGACY_PROJECT_GRAPH_ROLE,
                "replacement_role": roles.PROJECT_GRAPH_ROLE,
            },
        )
    if target_type == "task" and role == roles.TASK_BRIEF_ROLE:
        raise ValidationError(
            "a task's brief is rendered by Merv from the immutable goal at creation and cannot be submitted or replaced"
        )
    if role not in roles.SUBMITTABLE_ROLES:
        allowed = sorted(roles.SUBMITTABLE_ROLES)
        raise ValidationError(
            f"unknown artifact role: {role}. Allowed roles: {', '.join(allowed)}",
            details={"allowed_roles": allowed, "recommended_result_role": "result"},
        )
    if role == roles.REFLECTION_LENS_DOC_ROLE and not lens_id:
        raise ValidationError(
            "lens_id is required for reflection_lens_doc artifacts — pass the roster lens this reflection covers"
        )
    if lens_id and role != roles.REFLECTION_LENS_DOC_ROLE:
        raise ValidationError("lens_id only applies to reflection_lens_doc artifacts")
