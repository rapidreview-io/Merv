"""Safety bounds for the opt-in production verifier, using no live services."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest


spec = importlib.util.spec_from_file_location(
    "cutover_verifier", Path(__file__).resolve().parents[2] / "deploy" / "verify_sandboxes_cutover.py"
)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
HTTP_CLIENT = httpx.Client


def transport_client(handler):
    return lambda **kwargs: HTTP_CLIENT(transport=httpx.MockTransport(handler), **kwargs)


def test_full_download_verifies_size_and_hash():
    data = b"migrated evidence"
    with patch.object(verifier.httpx, "Client", side_effect=transport_client(lambda request: httpx.Response(200, content=data))):
        result = verifier.bounded_download("https://storage.test/object?secret=not-logged",
            size=len(data), expected_sha=hashlib.sha256(data).hexdigest(), full_limit=32)
    assert result == {"bytes_read": len(data), "verification": "full_sha256"}


def test_large_download_rejects_ignored_range_before_reading_bytes():
    def handler(request):
        assert request.headers["Range"] == "bytes=0-1048575"
        return httpx.Response(200, content=b"wrong response")
    with patch.object(verifier.httpx, "Client", side_effect=transport_client(handler)):
        with pytest.raises(verifier.CheckFailed, match="ignored byte range"):
            verifier.bounded_download("https://storage.test/object", size=100 * verifier.MIB, expected_sha="0" * 64, full_limit=32)


def test_full_download_rejects_wrong_hash():
    with patch.object(verifier.httpx, "Client", side_effect=transport_client(lambda request: httpx.Response(200, content=b"bad"))):
        with pytest.raises(verifier.CheckFailed, match="SHA-256 mismatch"):
            verifier.bounded_download("https://storage.test/object", size=3, expected_sha="0" * 64, full_limit=32)


def test_failure_report_never_echoes_signed_urls():
    url = "https://storage.test/object?credential=very-secret"
    response = httpx.Response(403, request=httpx.Request("GET", url))
    error = httpx.HTTPStatusError("provider rejected " + url, request=response.request, response=response)
    report = verifier.safe_failure(error)
    assert report == {"type": "HTTPStatusError", "http_status": 403}
    assert "very-secret" not in str(report)


def test_failed_blob_upload_still_deletes_only_its_owned_object():
    calls = []

    class Client:
        def request(self, method, path, *, namespace, **kwargs):
            calls.append((method, path, namespace))
            return {"state": "deleted"}

    class Blobs:
        def __init__(self, **kwargs):
            pass

        def put(self, **kwargs):
            raise RuntimeError("accepted upload response was lost")

        def _find(self, **kwargs):
            return [{"id": "obj_smoke_only"}]

    with patch.object(verifier, "RemoteBlobStore", Blobs):
        with pytest.raises(RuntimeError, match="response was lost"):
            verifier.verify_writes(argparse.Namespace(multipart_mib=65), Client())
    assert calls == [("DELETE", "/storage/objects/obj_smoke_only", "merv-blobs"),
                     ("GET", "/storage/objects/obj_smoke_only", "merv-blobs")]
