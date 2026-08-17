# If you update this file, you must consult object_storage.md to see whether object_storage.md needs to be updated. object_storage.md must not exceed 100 lines.
"""S3 content-addressed bytes for Artifacts and Feed."""

from __future__ import annotations

import hashlib
from typing import Any

from ..kernel.ports.blob_store import validate_blob_keys
from ..kernel.utils import NotFoundError, now_iso

# Ignore staging keys left by the retired binary transfer flow.
_UPLOAD_PREFIX = ".uploads/"


class S3BlobStore:
    """BlobStore over an S3-compatible bucket (boto3; gated import)."""

    def __init__(
        self,
        *,
        bucket: str,
        client: Any | None = None,
    ) -> None:
        self.bucket = bucket
        if client is not None:
            self._s3 = client
        else:
            import boto3  # gated: control profile only

            self._s3 = boto3.client("s3")

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
        key = self._key(namespace=namespace, sha256=sha)
        existing = self._head(key=key)
        if existing is not None:
            # Re-puts may extend expiry but never shorten it.
            self._maybe_extend_expiry(key=key, head=existing, expires_at=expires_at)
            return sha
        meta = {"sha256": sha, "namespace": namespace}
        if expires_at:
            meta["expires_at"] = expires_at
        self._s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            Metadata=meta,
        )
        return sha

    def get(self, *, namespace: str, sha256: str) -> bytes:
        validate_blob_keys(namespace=namespace, sha256=sha256)
        key = self._key(namespace=namespace, sha256=sha256)
        try:
            obj = self._s3.get_object(Bucket=self.bucket, Key=key)
        except self._s3.exceptions.NoSuchKey as exc:
            raise NotFoundError(f"blob not found: {namespace}/{sha256}") from exc
        except Exception as exc:  # noqa: BLE001 — map a 404 ClientError too
            if _is_not_found(exc):
                raise NotFoundError(f"blob not found: {namespace}/{sha256}") from exc
            raise
        return obj["Body"].read()

    def delete(self, *, namespace: str, sha256: str) -> bool:
        """Remove one blob; True if it existed."""
        validate_blob_keys(namespace=namespace, sha256=sha256)
        key = self._key(namespace=namespace, sha256=sha256)
        if self._head(key=key) is None:
            return False
        self._s3.delete_object(Bucket=self.bucket, Key=key)
        return True

    def sweep_expired(self, *, now: str | None = None) -> int:
        cutoff = now or now_iso()
        swept = 0
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket):
            for item in page.get("Contents", []) or []:
                key = str(item["Key"])
                if key.startswith(_UPLOAD_PREFIX):
                    continue
                head = self._head(key=key)
                if head is None:
                    continue
                expires_at = (head.get("Metadata") or {}).get("expires_at")
                if not expires_at or str(expires_at) > cutoff:
                    continue
                self._s3.delete_object(Bucket=self.bucket, Key=key)
                swept += 1
        return swept

    def _key(self, *, namespace: str, sha256: str) -> str:
        return f"{namespace}/{sha256}"

    def _head(self, *, key: str) -> dict[str, Any] | None:
        try:
            return self._s3.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            if _is_not_found(exc):
                return None
            raise

    def _maybe_extend_expiry(
        self, *, key: str, head: dict[str, Any], expires_at: str | None
    ) -> None:
        meta = dict(head.get("Metadata") or {})
        current = meta.get("expires_at")
        if current is None:
            return  # already pinned forever
        if expires_at is None or str(expires_at) > str(current):
            new_meta = dict(meta)
            if expires_at is None:
                new_meta.pop("expires_at", None)
            else:
                new_meta["expires_at"] = expires_at
            # S3 metadata replacement requires a self-copy and resets ContentType.
            self._s3.copy_object(
                Bucket=self.bucket,
                Key=key,
                CopySource={"Bucket": self.bucket, "Key": key},
                Metadata=new_meta,
                MetadataDirective="REPLACE",
                ContentType=head.get("ContentType") or "application/octet-stream",
            )


def _is_not_found(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "") if hasattr(exc, "response") else ""
    return code in {"404", "NoSuchKey", "NotFound"} or exc.__class__.__name__ in {
        "NoSuchKey",
        "404",
    }
