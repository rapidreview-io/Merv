# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Merv-owned artifact bytes on R2's S3 API; no compute-service dependency."""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Protocol
from urllib.parse import urlsplit

from botocore.exceptions import BotoCoreError, ClientError

from ..kernel.ports.blob_store import validate_blob_keys
from ..kernel.utils import ContentUnavailableError, NotFoundError, ValidationError


class S3Client(Protocol):
    def put_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_object(self, **kwargs: Any) -> dict[str, Any]: ...
    def delete_object(self, **kwargs: Any) -> dict[str, Any]: ...


class UnconfiguredBlobStore:
    """Allow record-only composition, but never silently choose another store."""

    def put(self, **kwargs: Any) -> str:
        raise ContentUnavailableError("configure MERV_BLOB_BUCKET and MERV_BLOB_* R2 credentials to store artifact bytes")

    def get(self, **kwargs: Any) -> bytes:
        raise ContentUnavailableError("configure MERV_BLOB_BUCKET and MERV_BLOB_* R2 credentials to read artifact bytes")

    def delete(self, **kwargs: Any) -> bool:
        raise ContentUnavailableError("configure MERV_BLOB_BUCKET and MERV_BLOB_* R2 credentials to delete artifact bytes")


class R2BlobStore:
    """Content addressing and exact deletion over boto3's bounded object calls.

    Expiration is owned by the caller's durable reference ledger. This adapter
    never creates lifecycle rules or TTL tags that could expire shared content.
    """

    def __init__(
        self, *, bucket: str, endpoint_url: str, access_key_id: str,
        secret_access_key: str, region: str = "auto", prefix: str = "",
        client: S3Client | None = None,
    ) -> None:
        endpoint = urlsplit(endpoint_url)
        if (
            endpoint.scheme != "https" or not endpoint.netloc
            or endpoint.username or endpoint.password or endpoint.query
            or endpoint.fragment or endpoint.path not in {"", "/"}
        ):
            raise ValidationError("MERV_BLOB_ENDPOINT_URL must be an https origin")
        if not bucket or not access_key_id or not secret_access_key:
            raise ValidationError("artifact R2 bucket and credentials must all be configured")
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        if any(part in {"", ".", ".."} for part in self.prefix.split("/")) and self.prefix:
            raise ValidationError("MERV_BLOB_PREFIX must contain nonempty path segments without '.' or '..'")
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "s3", endpoint_url=endpoint_url, region_name=region,
                aws_access_key_id=access_key_id, aws_secret_access_key=secret_access_key,
                config=Config(
                    signature_version="s3v4", connect_timeout=10, read_timeout=120,
                    retries={"mode": "standard", "max_attempts": 3},
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                ),
            )
        self._client = client

    def _key(self, namespace: str, sha256: str) -> str:
        validate_blob_keys(namespace=namespace, sha256=sha256)
        return "/".join(part for part in (self.prefix, namespace, sha256) if part)

    def put(
        self, *, namespace: str, data: bytes,
        content_type: str = "application/octet-stream", expires_at: str | None = None,
    ) -> str:
        sha256 = hashlib.sha256(data).hexdigest()
        key = self._key(namespace, sha256)
        try:
            self._client.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                ContentMD5=base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii"),
                IfNoneMatch="*",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in {"PreconditionFailed", "412"}:
                raise ContentUnavailableError("artifact upload to R2 failed") from exc
        except BotoCoreError as exc:
            raise ContentUnavailableError("artifact upload to R2 failed") from exc
        return sha256

    def get(self, *, namespace: str, sha256: str, max_bytes: int | None = None) -> bytes:
        key = self._key(namespace, sha256)
        try:
            response = self._client.get_object(Bucket=self.bucket, Key=key)
            body = response["Body"]
            try:
                if max_bytes is not None and response["ContentLength"] > max_bytes:
                    raise ValidationError("artifact content exceeds maximum read size")
                data = body.read() if max_bytes is None else body.read(max_bytes + 1)
                if max_bytes is not None and len(data) > max_bytes:
                    raise ValidationError("artifact content exceeds maximum read size")
            finally:
                body.close()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "NotFound", "404"}:
                raise NotFoundError(f"artifact content not found: {namespace}/{sha256}") from exc
            raise ContentUnavailableError("artifact download from R2 failed") from exc
        except BotoCoreError as exc:
            raise ContentUnavailableError("artifact download from R2 failed") from exc
        if hashlib.sha256(data).hexdigest() != sha256:
            raise ValidationError("stored artifact checksum mismatch")
        return data

    def delete(self, *, namespace: str, sha256: str) -> bool:
        """Acknowledge idempotent exact-key removal, including an absent key."""
        key = self._key(namespace, sha256)
        try:
            self._client.delete_object(Bucket=self.bucket, Key=key)
        except (ClientError, BotoCoreError) as exc:
            raise ContentUnavailableError("artifact deletion from R2 failed") from exc
        return True
