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
                "merv.client.storage_upload.urllib.request.urlopen",
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
                "merv.client.storage_upload.urllib.request.urlopen",
                return_value=_Response(json.dumps(target).encode()),
            ):
                with self.assertRaises(StorageUploadError) as ctx:
                    upload_storage_file(path=path, target_url="https://merv.test/u")
        self.assertIn("checksum changed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
