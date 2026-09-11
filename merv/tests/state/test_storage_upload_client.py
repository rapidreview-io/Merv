from __future__ import annotations

import base64
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.client.storage_upload import StorageUploadError, upload_storage_file


class _Response:
    def __init__(self, body: bytes = b"", *, headers: dict[str, str] | None = None):
        self._body = io.BytesIO(body)
        self.headers = headers or {}

    def read(self) -> bytes:
        return self._body.read()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class StorageUploadClientTest(unittest.TestCase):
    def test_streams_ordered_parts_and_completes(self) -> None:
        data = b"abcdefghij"
        target_url = "https://merv.test/api/storage/u/token"
        target = {
            "upload": {
                "size_bytes": len(data),
                "part_size": 4,
                "checksum_sha256": base64.b64encode(
                    hashlib.sha256(data).digest()
                ).decode("ascii"),
                "parts": [
                    {"part_number": 1, "url": "https://store.test/1"},
                    {"part_number": 2, "url": "https://store.test/2"},
                    {"part_number": 3, "url": "https://store.test/3"},
                ],
            }
        }
        uploaded: dict[int, bytes] = {}
        completion: dict = {}

        def open_url(request, timeout):  # noqa: ARG001
            method = request.get_method()
            if method == "GET":
                return _Response(json.dumps(target).encode("utf-8"))
            if method == "PUT":
                part_number = int(request.full_url.rsplit("/", 1)[1])
                uploaded[part_number] = b"".join(request.data)
                return _Response(headers={"ETag": f'"etag-{part_number}"'})
            completion.update(json.loads(request.data.decode("utf-8")))
            return _Response(json.dumps({"object": {"status": "available"}}).encode())

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "archive.bin"
            path.write_bytes(data)
            with patch(
                "merv.client.storage_upload._open",
                side_effect=open_url,
            ):
                result = upload_storage_file(
                    path=path, target_url=target_url, workers=3
                )

        self.assertEqual(uploaded, {1: b"abcd", 2: b"efgh", 3: b"ij"})
        self.assertEqual(
            completion["parts"],
            [
                {"part_number": 1, "etag": '"etag-1"'},
                {"part_number": 2, "etag": '"etag-2"'},
                {"part_number": 3, "etag": '"etag-3"'},
            ],
        )
        self.assertEqual(result["object"]["status"], "available")

    def test_resume_streams_only_missing_parts_and_preserves_signed_headers(self) -> None:
        data = b"abcdefghij"
        target = {"upload": {"size_bytes": 10, "part_size": 4, "part_count": 3,
            "checksum_sha256": base64.b64encode(hashlib.sha256(data).digest()).decode(),
            "completed_parts": [1, 3],
            "parts": [{"part_number": 2, "url": "https://store.test/2",
                       "headers": {"x-amz-checksum-sha256": "signed-checksum"}}]}}
        writes = []
        completion = {}

        def open_url(request, timeout):
            if request.get_method() == "GET":
                return _Response(json.dumps(target).encode())
            if request.get_method() == "PUT":
                writes.append((request.full_url, b"".join(request.data),
                               request.get_header("X-amz-checksum-sha256")))
                return _Response(headers={"ETag": '"second"'})
            completion.update(json.loads(request.data))
            return _Response(b'{"object":{"status":"available"}}')

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "file"
            path.write_bytes(data)
            with patch("merv.client.storage_upload._open", side_effect=open_url):
                upload_storage_file(path=path, target_url="https://merv.test/u")
        self.assertEqual(writes, [("https://store.test/2", b"efgh", "signed-checksum")])
        self.assertEqual(completion["parts"], [{"part_number": 2, "etag": '"second"'}])

    def test_empty_file_upload_and_already_uploaded_resume(self) -> None:
        for already_uploaded in (False, True):
            with self.subTest(already_uploaded=already_uploaded):
                target = {"upload": {"size_bytes": 0, "part_size": 4, "part_count": 1,
                    "checksum_sha256": base64.b64encode(hashlib.sha256(b"").digest()).decode(),
                    "completed_parts": [1] if already_uploaded else [],
                    "parts": [] if already_uploaded else [{"part_number": 1, "url": "https://store.test/1"}]}}
                writes = []

                def open_url(request, timeout):
                    if request.get_method() == "GET":
                        return _Response(json.dumps(target).encode())
                    if request.get_method() == "PUT":
                        writes.append(b"".join(request.data))
                        self.assertEqual(request.get_header("Content-length"), "0")
                        return _Response(headers={"ETag": '"empty"'})
                    return _Response(b'{"object":{"status":"available"}}')

                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "empty"
                    path.write_bytes(b"")
                    with patch("merv.client.storage_upload._open", side_effect=open_url):
                        upload_storage_file(path=path, target_url="https://merv.test/u")
                self.assertEqual(writes, [] if already_uploaded else [b""])

    def test_rejects_changed_file_before_upload(self) -> None:
        target = {
            "upload": {
                "size_bytes": 4,
                "part_size": 4,
                "checksum_sha256": base64.b64encode(
                    hashlib.sha256(b"expected").digest()
                ).decode("ascii"),
                "parts": [{"part_number": 1, "url": "https://store.test/1"}],
            }
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "archive.bin"
            path.write_bytes(b"nope")
            with patch(
                "merv.client.storage_upload._open",
                return_value=_Response(json.dumps(target).encode()),
            ):
                with self.assertRaises(StorageUploadError) as ctx:
                    upload_storage_file(path=path, target_url="https://merv.test/u")
        self.assertIn("checksum changed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
