"""Streaming multipart uploader used by ``storage.submit`` run commands."""

from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable


_READ_CHUNK_BYTES = 1024 * 1024


class StorageUploadError(Exception):
    pass


def upload_storage_file(
    *, path: Path, target_url: str, workers: int = 4
) -> dict[str, Any]:
    """Verify and stream one file through a token-backed multipart target."""
    try:
        size_bytes = path.stat().st_size
    except OSError as exc:
        raise StorageUploadError(f"cannot read upload file: {path}") from exc
    target = _request_json(target_url)
    upload = target.get("upload") if isinstance(target, dict) else None
    if not isinstance(upload, dict) or not isinstance(upload.get("parts"), list):
        raise StorageUploadError("Merv returned a malformed multipart target")
    expected_size = _positive_int(upload.get("size_bytes"), field="size_bytes")
    part_size = _positive_int(upload.get("part_size"), field="part_size")
    if size_bytes != expected_size:
        raise StorageUploadError(
            f"file size changed since storage.submit: {size_bytes} != {expected_size}"
        )
    _verify_sha256(path=path, checksum_b64=str(upload.get("checksum_sha256") or ""))

    parts = sorted(upload["parts"], key=lambda item: int(item["part_number"]))
    expected_numbers = list(range(1, len(parts) + 1))
    if [int(part.get("part_number") or 0) for part in parts] != expected_numbers:
        raise StorageUploadError("Merv returned non-contiguous multipart targets")
    worker_count = max(1, min(int(workers), len(parts)))
    completed: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(
                _upload_part,
                path=path,
                url=str(part.get("url") or ""),
                part_number=int(part["part_number"]),
                offset=(int(part["part_number"]) - 1) * part_size,
                length=min(
                    part_size,
                    expected_size - ((int(part["part_number"]) - 1) * part_size),
                ),
            ): int(part["part_number"])
            for part in parts
        }
        for future in as_completed(futures):
            completed.append(future.result())
            print(f"uploaded part {len(completed)}/{len(parts)}", flush=True)

    completed.sort(key=lambda item: int(item["part_number"]))
    complete_url = f"{target_url.rstrip('/')}/complete"
    return _request_json(
        complete_url,
        method="POST",
        payload={"parts": completed},
    )


def _verify_sha256(*, path: Path, checksum_b64: str) -> None:
    try:
        expected = base64.b64decode(checksum_b64, validate=True).hex()
    except (ValueError, TypeError) as exc:
        raise StorageUploadError("Merv returned an invalid upload checksum") from exc
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(8 * _READ_CHUNK_BYTES):
                digest.update(chunk)
    except OSError as exc:
        raise StorageUploadError(f"cannot read upload file: {path}") from exc
    if digest.hexdigest() != expected:
        raise StorageUploadError("file checksum changed since storage.submit")


def _upload_part(
    *, path: Path, url: str, part_number: int, offset: int, length: int
) -> dict[str, Any]:
    if not url or length <= 0:
        raise StorageUploadError(f"invalid upload target for part {part_number}")
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url,
                data=_file_slice(path=path, offset=offset, length=length),
                method="PUT",
                headers={"Content-Length": str(length)},
            )
            with urllib.request.urlopen(request, timeout=3600) as response:  # noqa: S310
                etag = str(response.headers.get("ETag") or "").strip()
            if not etag:
                raise StorageUploadError(
                    f"object store returned no ETag for part {part_number}"
                )
            return {"part_number": part_number, "etag": etag}
        except (urllib.error.URLError, OSError) as exc:
            if attempt == 2:
                raise StorageUploadError(
                    f"upload failed for part {part_number} after 3 attempts"
                ) from exc
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def _file_slice(*, path: Path, offset: int, length: int) -> Iterable[bytes]:
    with path.open("rb") as source:
        source.seek(offset)
        remaining = length
        while remaining:
            chunk = source.read(min(_READ_CHUNK_BYTES, remaining))
            if not chunk:
                raise StorageUploadError("upload file ended before its declared size")
            remaining -= len(chunk)
            yield chunk


def _request_json(
    url: str, *, method: str = "GET", payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise StorageUploadError(
            f"Merv returned HTTP {exc.code}: {detail[:500]}"
        ) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise StorageUploadError("Merv upload request failed") from exc
    if not isinstance(body, dict):
        raise StorageUploadError("Merv returned a malformed upload response")
    return body


def _positive_int(value: Any, *, field: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise StorageUploadError(f"Merv returned an invalid {field}") from exc
    if parsed <= 0:
        raise StorageUploadError(f"Merv returned an invalid {field}")
    return parsed


__all__ = ["StorageUploadError", "upload_storage_file"]
