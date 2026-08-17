# If you update this file, you must consult object_storage.md to see whether object_storage.md needs to be updated. object_storage.md must not exceed 100 lines.
"""Local content-addressed bytes for Artifacts and Feed."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import suppress
from pathlib import Path

from ..kernel.ports.blob_store import (
    BlobStore,
    validate_blob_keys,
)
from ..kernel.utils import NotFoundError, now_iso


class LocalDirBlobStore:
    """Local blob store with namespace-scoped SHA-256 paths and metadata."""

    def __init__(self, *, root: Path) -> None:
        self.root = root

    def put(
        self,
        *,
        namespace: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        expires_at: str | None = None,
    ) -> str:
        validate_blob_keys(namespace=namespace)
        sha = hashlib.sha256(data).hexdigest()
        blob_path = self._blob_path(namespace=namespace, sha256=sha)
        meta_path = self._meta_path(namespace=namespace, sha256=sha)
        if blob_path.exists():
            self._extend_expiry(meta_path=meta_path, expires_at=expires_at)
            return sha
        blob_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = blob_path.with_suffix(".tmp")
        tmp_path.write_bytes(data)
        os.replace(tmp_path, blob_path)
        meta = {
            "sha256": sha,
            "namespace": namespace,
            "size_bytes": len(data),
            "content_type": content_type,
            "created_at": now_iso(),
            "expires_at": expires_at,
        }
        meta_path.write_text(json.dumps(meta, sort_keys=True), encoding="utf-8")
        return sha

    def get(self, *, namespace: str, sha256: str) -> bytes:
        validate_blob_keys(namespace=namespace, sha256=sha256)
        blob_path = self._blob_path(namespace=namespace, sha256=sha256)
        if not blob_path.exists():
            raise NotFoundError(f"blob not found: {namespace}/{sha256}")
        return blob_path.read_bytes()

    def delete(self, *, namespace: str, sha256: str) -> bool:
        """Remove one blob (and its metadata); True if it existed."""
        return self._delete(namespace=namespace, sha256=sha256)

    def _delete(self, *, namespace: str, sha256: str) -> bool:
        validate_blob_keys(namespace=namespace, sha256=sha256)
        blob_path = self._blob_path(namespace=namespace, sha256=sha256)
        meta_path = self._meta_path(namespace=namespace, sha256=sha256)
        existed = blob_path.exists()
        for path in (blob_path, meta_path):
            with suppress(FileNotFoundError):
                path.unlink()
        return existed

    def sweep_expired(self, *, now: str | None = None) -> int:
        cutoff = now or now_iso()
        swept = 0
        if not self.root.exists():
            return 0
        for meta_path in self.root.glob("*/*/*.meta.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            expires_at = meta.get("expires_at")
            if not expires_at or str(expires_at) > cutoff:
                continue
            if self._delete(
                namespace=str(meta["namespace"]), sha256=str(meta["sha256"])
            ):
                swept += 1
        return swept

    def _blob_path(self, *, namespace: str, sha256: str) -> Path:
        return self.root / namespace / sha256[:2] / sha256

    def _meta_path(self, *, namespace: str, sha256: str) -> Path:
        return self.root / namespace / sha256[:2] / f"{sha256}.meta.json"

    def _extend_expiry(self, *, meta_path: Path, expires_at: str | None) -> None:
        """Never shorten an existing blob's lifetime."""
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        current = meta.get("expires_at")
        if current is None:
            return
        if expires_at is None or str(expires_at) > str(current):
            meta["expires_at"] = expires_at
            meta_path.write_text(json.dumps(meta, sort_keys=True), encoding="utf-8")


__all__ = [
    "BlobStore",
    "LocalDirBlobStore",
]
