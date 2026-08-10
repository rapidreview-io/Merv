# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Passive values exchanged by the Artifacts component.

These types describe the evidence lifecycle but perform no I/O and own no
workflow policy. Row conversion lives here so the workflow remains readable
without duplicating the stored artifact shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from ..kernel.state.store import Connection, Row


UploadKind = Literal["artifact", "figure"]
ReadMode = Literal["metadata", "content", "document"]


@dataclass(frozen=True, slots=True)
class ArtifactTarget:
    target_type: str
    target_id: str
    project_id: str | None = None
    attempt_index: int = 0


class ArtifactTargets(Protocol):
    """Research-owned facts needed while an artifact is being written."""

    def resolve(
        self,
        *,
        tx: Connection,
        target: ArtifactTarget,
        for_submission: bool = False,
    ) -> ArtifactTarget: ...

    def is_protected(
        self,
        *,
        tx: Connection,
        artifact_id: str,
    ) -> bool:
        """Whether a published reflection has permanently pinned this artifact."""
        ...


@dataclass(frozen=True, slots=True)
class PendingUpload:
    artifact_id: str
    token: str
    path: str


@dataclass(frozen=True, slots=True)
class PendingFigure:
    link_path: str
    token: str


@dataclass(frozen=True, slots=True)
class CompletedArtifact:
    artifact_id: str
    role: str
    path: str
    sha256: str
    size_bytes: int
    figures: tuple[PendingFigure, ...] = ()


@dataclass(frozen=True, slots=True)
class CompletedFigure:
    artifact_id: str
    link_path: str
    sha256: str
    size_bytes: int


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
            expires_at=(
                None if row["expires_at"] is None else str(row["expires_at"])
            ),
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

    @classmethod
    def from_row(cls, row: Row) -> Submission:
        return cls(
            id=str(row["id"]),
            target_id=str(row["target_id"]),
            attempt_index=int(row["attempt_index"]),
            transition=str(row["transition"] or ""),
            created_at=str(row["created_at"]),
            order=int(row["created_seq"] or 0),
        )


@dataclass(frozen=True, slots=True)
class TargetHistory:
    artifacts: tuple[Artifact, ...]
    submissions: tuple[Submission, ...]
