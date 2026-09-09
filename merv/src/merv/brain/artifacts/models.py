# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Content records and upload receipts, independent of their consumers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..kernel.state.store import Row


UploadKind = Literal["artifact", "figure"]
ReadMode = Literal["metadata", "content", "document"]


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
    data: bytes | None = None
    figures: tuple[str, ...] = ()

    @classmethod
    def from_row(
        cls,
        row: Row,
        *,
        data: bytes | None = None,
        figures: tuple[str, ...] = (),
    ) -> Artifact:
        return cls(
            id=str(row["id"]), project_id=str(row["project_id"]),
            path=str(row["path"] or ""), title=str(row["title"] or ""),
            sha256=str(row["content_sha256"] or ""), size_bytes=int(row["size_bytes"] or 0),
            content_type=str(row["content_type"] or ""), status=str(row["status"]),
            created_by=str(row["created_by"] or ""), created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]), order=int(row["created_seq"] or 0),
            expires_at=None if row["expires_at"] is None else str(row["expires_at"]),
            data=data, figures=figures,
        )
