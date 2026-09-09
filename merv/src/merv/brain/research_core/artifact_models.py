# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research-owned artifact associations and frozen evidence projections."""

from __future__ import annotations
from dataclasses import dataclass
from ..artifacts import PendingFigure
from ..kernel.state.store import Row


@dataclass(frozen=True, slots=True)
class ArtifactTarget:
    target_type: str
    target_id: str
    project_id: str | None = None
    attempt_index: int = 0


@dataclass(frozen=True, slots=True)
class CompletedArtifact:
    artifact_id: str
    role: str
    path: str
    sha256: str
    size_bytes: int
    figures: tuple[PendingFigure, ...] = ()


@dataclass(frozen=True, slots=True)
class Artifact:
    id: str
    project_id: str
    target_type: str
    target_id: str
    role: str
    attempt_index: int
    lens_id: str
    path: str
    title: str
    sha256: str
    size_bytes: int
    content_type: str
    status: str
    created_by: str
    created_at: str
    updated_at: str
    order: int
    expires_at: str | None = None
    submission_id: str = ""
    data: bytes | None = None
    figures: tuple[str, ...] = ()
    tldr: str = ""
    artifact_id: str = ""

    @classmethod
    def from_row(
        cls,
        row: Row,
        *,
        data: bytes | None = None,
        figures: tuple[str, ...] = (),
        tldr: str = "",
    ) -> Artifact:
        return cls(
            id=str(row["id"]),
            artifact_id=str(row["artifact_id"]),
            project_id=str(row["project_id"]),
            target_type=str(row["target_type"]),
            target_id=str(row["target_id"]),
            role=str(row["role"]),
            attempt_index=int(row["attempt_index"]),
            lens_id=str(row["lens_id"] or ""),
            path=str(row["path"] or ""),
            title=str(row["title"] or ""),
            sha256=str(row["content_sha256"] or ""),
            size_bytes=int(row["size_bytes"] or 0),
            content_type=str(row["content_type"] or ""),
            status=str(row["status"]),
            created_by=str(row["created_by"] or ""),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            order=int(row["created_seq"] or 0),
            expires_at=(None if row["expires_at"] is None else str(row["expires_at"])),
            submission_id=str(row["submission_id"] or ""),
            data=data,
            figures=figures,
            tldr=tldr,
        )


@dataclass(frozen=True, slots=True)
class Submission:
    id: str
    target_id: str
    attempt_index: int
    transition: str
    created_at: str
    order: int
    artifact_ids: tuple[str, ...] = ()

    @classmethod
    def from_row(cls, row: Row, *, artifact_ids: tuple[str, ...] = ()) -> Submission:
        return cls(
            id=str(row["id"]),
            target_id=str(row["target_id"]),
            attempt_index=int(row["attempt_index"]),
            transition=str(row["transition"] or ""),
            artifact_ids=artifact_ids,
            created_at=str(row["created_at"]),
            order=int(row["created_seq"] or 0),
        )


@dataclass(frozen=True, slots=True)
class TargetHistory:
    artifacts: tuple[Artifact, ...]
    submissions: tuple[Submission, ...]
