"""Byte transfer through merv-sandboxes storage.

The service owns object names, versions, state, retention and physical bytes.
This module only shapes resumable transfer targets from the service's upload
status and renders the one-line commands agents run to move bytes. Artifact
and figure bytes use the independent Merv-owned R2 adapter.
"""

from __future__ import annotations

import base64
from typing import Any

from merv.shared.shell_commands import api_base, shell_quote

from ..kernel.utils import ValidationError
from .ports import InfrastructureTransport

_PART_PAGE = 100


def checksum_sha256_b64(sha256: str) -> str:
    """Encode the checksum format required by S3."""
    return base64.b64encode(bytes.fromhex(sha256)).decode("ascii")


def storage_submit_command(
    *,
    base_url: str,
    path: str,
    presigned_url: str,
    checksum_b64: str,
    content_type: str,
    token: str,
    headers: dict[str, str] | None = None,
) -> str:
    """Build the direct single-PUT upload and completion command."""
    base = api_base(base_url)
    # Provider-specific signed headers are opaque service output. The fallback
    # preserves existing callers of this command builder.
    signed_headers = headers if headers is not None else {
        "x-amz-checksum-sha256": checksum_b64, "Content-Type": content_type,
    }
    header_flags = " ".join(
        f"-H {shell_quote(f'{key}: {value}')}" for key, value in signed_headers.items()
    )
    put = (
        f"curl -sS --fail-with-body -X PUT {header_flags} "
        f"-T {shell_quote(path)} {shell_quote(presigned_url)}"
    )
    complete = (
        f"curl -sS --fail-with-body -X POST {shell_quote(f'{base}/api/storage/u/{token}/complete')}"
    )
    return f"{put} && {complete}"


def storage_multipart_submit_command(*, base_url: str, path: str, token: str) -> str:
    """Build the client-assisted multipart upload command.

    The one-time URL contains no presigned provider credentials. ``merv-client``
    fetches fresh part URLs from it, streams the parts concurrently, and posts
    back to its ``/complete`` child route.
    """
    base = api_base(base_url)
    target_url = f"{base}/api/storage/u/{token}"
    return (
        f"merv-client storage-upload --path {shell_quote(path)} "
        f"--target-url {shell_quote(target_url)}"
    )


def storage_fetch_command(*, path: str, presigned_url: str, sha256: str) -> str:
    """Build a direct download with checksum verification."""
    fetch = f"curl -sSf -o {shell_quote(path)} {shell_quote(presigned_url)}"
    verify = f"printf '%s  %s\\n' {sha256} {shell_quote(path)} | shasum -a 256 -c"
    return f"{fetch} && {verify}"


def upload_target(
    client: InfrastructureTransport, *, namespace: str, status: dict[str, Any]
) -> dict[str, Any]:
    """Assemble one resumable transfer target from a service upload status.

    Part URLs arrive in pages; every page is followed so ``merv-client`` sees
    the complete contiguous set. A single-part upload also exposes ``url`` and
    its signed ``headers`` for the plain ``curl -T`` command.
    """
    obj = status["object"]
    parts = list(status.get("parts", []))
    completed = list(status.get("completed_parts", []))
    next_part = status.get("next_part")
    seen: set[int] = set()
    while next_part is not None:
        if next_part in seen:
            raise ValidationError("invalid upload pagination from merv-sandboxes")
        seen.add(next_part)
        page = client.request(
            "GET", f"/storage/objects/{obj['id']}/upload", namespace=namespace,
            params={"start_part": next_part, "limit": _PART_PAGE},
        )
        parts.extend(page.get("parts", []))
        completed.extend(page.get("completed_parts", []))
        next_part = page.get("next_part")
    target: dict[str, Any] = {
        "upload_id": obj["id"],
        "parts": parts,
        "completed_parts": sorted(set(completed)),
        "part_count": status["part_count"],
        "part_size": status["part_size"],
        "size_bytes": obj["size_bytes"],
        "content_type": obj["content_type"],
        "checksum_sha256": checksum_sha256_b64(obj["sha256"]),
    }
    if status["part_count"] == 1 and len(parts) == 1 and not completed:
        target.update(url=parts[0]["url"], headers=parts[0].get("headers", {}))
    return target


__all__ = [
    "checksum_sha256_b64",
    "storage_fetch_command",
    "storage_multipart_submit_command",
    "storage_submit_command",
    "upload_target",
]
