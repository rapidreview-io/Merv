from __future__ import annotations

import base64
import hashlib
from unittest.mock import patch

import httpx
import pytest

from merv.brain.infrastructure.storage import RemoteBlobStore, RemoteObjectProvider, _encode_upload
from merv.shared.errors import ValidationError


SHA = hashlib.sha256(b"abc").hexdigest()


def record(**overrides):
    return {"id": "obj_test", "namespace": "merv-project-proj_a", "name": SHA,
            "sha256": SHA, "size_bytes": 3, "content_type": "application/octet-stream",
            "state": "available", **overrides}


class Client:
    def __init__(self, handler):
        self.calls = []
        self.handler = handler

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        return self.handler(method, path, **kwargs)


def test_resume_keeps_noncontiguous_missing_parts_and_follows_all_pages():
    def handler(method, path, **kwargs):
        part = kwargs.get("params", {}).get("start_part", 1)
        return {"object": record(state="uploading", size_bytes=101), "part_size": 1,
                "part_count": 101, "completed_parts": [2],
                "parts": [{"part_number": n, "url": f"https://store.test/{n}"}
                          for n in (range(1, 101) if part == 1 else [101]) if n != 2],
                "next_part": 101 if part == 1 else None}

    client = Client(handler)
    provider = RemoteObjectProvider(client=client)
    target = provider.resume_upload(upload_id=_encode_upload("proj_a", "obj_test"), expires_in=60)
    assert len(target["parts"]) == 100
    assert target["parts"][-1]["part_number"] == 101
    assert target["completed_parts"] == [2]
    assert all(call[2]["namespace"] == "merv-project-proj_a" for call in client.calls)


def test_completion_uses_service_verified_object_identity():
    client = Client(lambda *args, **kwargs: record())
    result = RemoteObjectProvider(client=client).complete_upload(
        upload_id=_encode_upload("proj_a", "obj_test"), parts=[{"part_number": 1, "etag": "untrusted"}])
    assert (result.namespace, result.sha256, result.size_bytes) == ("proj_a", SHA, 3)
    assert client.calls == [("POST", "/storage/objects/obj_test/complete", {"namespace": "merv-project-proj_a"})]


def test_stat_and_download_resolve_existing_names_without_cross_project_lookup():
    client = Client(lambda method, path, **kwargs: {"objects": [record(state="deleted"), record()]}
                    if path == "/storage/objects" else {"url": "https://store.test/signed"})
    provider = RemoteObjectProvider(client=client)
    assert provider.stat(namespace="proj_a", sha256=SHA).size_bytes == 3
    assert provider.presign_download(namespace="proj_a", sha256=SHA, expires_in=60)["url"].startswith("https://")
    assert all(call[2]["namespace"] == "merv-project-proj_a" for call in client.calls)
    assert client.calls[0][2]["params"]["name"] == SHA


def test_blob_download_verifies_bytes_and_preserves_original_namespace():
    client = Client(lambda method, path, **kwargs: {"objects": [record()]}
                    if path == "/storage/objects" else {"url": "https://store.test/signed"})
    blobs = RemoteBlobStore(client=client)
    with patch("merv.brain.infrastructure.storage.httpx.get", return_value=httpx.Response(
        200, content=b"corrupt", request=httpx.Request("GET", "https://store.test/signed"))):
        with pytest.raises(ValidationError, match="checksum"):
            blobs.get(namespace="artifact-fixtures", sha256=SHA)
    assert client.calls[0][2]["namespace"] == "merv-blobs"
    assert client.calls[0][2]["params"]["name"] == "artifact-fixtures/" + SHA


def test_existing_blob_put_extends_retention_without_reupload():
    client = Client(lambda method, path, **kwargs: {"objects": [record()]}
                    if path == "/storage/objects" else record())
    blobs = RemoteBlobStore(client=client)
    assert blobs.put(namespace="artifacts", data=b"abc", expires_at=None) == SHA
    assert [call[0] for call in client.calls] == ["GET", "PATCH"]
    assert client.calls[-1][2]["json"] == {"expires_at": None}


def test_upload_identity_cannot_escape_api_path():
    client = Client(lambda *args, **kwargs: pytest.fail("must not call service"))
    for bad in ["old-upload", _encode_upload("proj_a", "obj_../../victim"), "msbx_!"]:
        with pytest.raises(ValidationError):
            RemoteObjectProvider(client=client).complete_upload(upload_id=bad)


def test_empty_file_has_no_byte_parts_but_completes():
    empty_sha = hashlib.sha256(b"").hexdigest()
    client = Client(lambda method, path, **kwargs: {
        "object": record(sha256=empty_sha, size_bytes=0, state="uploading"),
        "parts": [], "completed_parts": [], "part_count": 0, "part_size": 8388608, "next_part": None})
    result = RemoteObjectProvider(client=client).presign_upload(
        namespace="proj_a", sha256=empty_sha, size_bytes=0, expires_in=60)
    assert result["parts"] == []
    assert base64.b64decode(result["checksum_sha256"]).hex() == empty_sha
