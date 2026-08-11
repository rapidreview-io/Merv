# If you update this file, you must consult object_storage.md to see whether object_storage.md needs to be updated. object_storage.md must not exceed 100 lines.
"""Heavy-byte provider boundary for Object Storage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, TypedDict


@dataclass(frozen=True)
class ObjectStat:
    sha256: str
    namespace: str
    size_bytes: int
    content_type: str


class UploadPart(TypedDict):
    part_number: int
    url: str


class CompletedPart(TypedDict):
    part_number: int
    etag: str


class _UploadIdentity(TypedDict):
    upload_id: str


class UploadTarget(_UploadIdentity, total=False):
    url: str
    parts: list[UploadPart]
    part_size: int
    size_bytes: int
    content_type: str
    checksum_sha256: str


class DownloadTarget(TypedDict):
    url: str


class ObjectProvider(Protocol):
    """Move heavy bytes without owning their project lifecycle or metadata."""

    def presign_upload(
        self,
        *,
        namespace: str,
        sha256: str,
        size_bytes: int,
        content_type: str = "application/octet-stream",
        expires_in: int,
    ) -> UploadTarget:
        ...

    def resume_upload(self, *, upload_id: str, expires_in: int) -> UploadTarget:
        """Mint a fresh transfer target for an existing pending upload."""
        ...

    def complete_upload(
        self, *, upload_id: str, parts: list[CompletedPart] | None = None
    ) -> ObjectStat:
        ...

    def presign_download(
        self, *, namespace: str, sha256: str, expires_in: int
    ) -> DownloadTarget:
        ...

    def stat(self, *, namespace: str, sha256: str) -> ObjectStat | None: ...

    def delete(self, *, namespace: str, sha256: str) -> bool: ...


__all__ = [
    "CompletedPart",
    "DownloadTarget",
    "ObjectProvider",
    "ObjectStat",
    "UploadPart",
    "UploadTarget",
]
