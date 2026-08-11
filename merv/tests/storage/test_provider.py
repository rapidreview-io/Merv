"""Heavy-object provider contract, including S3 transfer integrity."""

from __future__ import annotations

import base64
import hashlib
import shutil
import socket
import subprocess
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from merv.brain.kernel.utils import NotFoundError, ValidationError
from tests.storage.test_blobs import BlobStoreContractMixin


class ObjectProviderContractMixin:
    """Behavior required from every heavy-byte provider."""

    def make_store(self):  # pragma: no cover - overridden
        raise NotImplementedError

    def _write_upload(self, target: dict, data: bytes) -> None:
        from urllib.parse import urlsplit
        from urllib.request import url2pathname

        url = urlsplit(target["url"])
        self.assertEqual(url.scheme, "file")
        Path(url2pathname(url.path)).write_bytes(data)

    def _read_download(self, target: dict) -> bytes:
        import urllib.request

        with urllib.request.urlopen(target["url"]) as response:  # noqa: S310
            return response.read()

    def _upload(
        self, store, *, namespace: str, data: bytes, size_bytes: int | None = None
    ):
        sha = hashlib.sha256(data).hexdigest()
        target = store.presign_upload(
            namespace=namespace,
            sha256=sha,
            size_bytes=len(data) if size_bytes is None else size_bytes,
            content_type="text/plain",
            expires_in=300,
        )
        self._write_upload(target, data)
        return sha, store.complete_upload(upload_id=target["upload_id"])

    def test_presign_complete_round_trip(self) -> None:
        store = self.make_store()
        data = b"heavy object bytes"
        sha, stat = self._upload(store, namespace="proj_a", data=data)
        self.assertEqual(stat.sha256, sha)
        self.assertEqual(stat.namespace, "proj_a")
        self.assertEqual(stat.size_bytes, len(data))
        self.assertEqual(stat.content_type, "text/plain")
        self.assertEqual(
            self._read_download(
                store.presign_download(namespace="proj_a", sha256=sha, expires_in=300)
            ),
            data,
        )

    def test_identical_upload_is_idempotent(self) -> None:
        store = self.make_store()
        data = b"dedup me"
        sha1, stat1 = self._upload(store, namespace="proj_a", data=data)
        sha2, stat2 = self._upload(store, namespace="proj_a", data=data)
        self.assertEqual(sha2, sha1)
        self.assertEqual(stat2.sha256, stat1.sha256)
        self.assertEqual(stat2.size_bytes, stat1.size_bytes)

    def test_stat_reports_metadata(self) -> None:
        store = self.make_store()
        sha, _ = self._upload(store, namespace="proj_a", data=b"12345")
        stat = store.stat(namespace="proj_a", sha256=sha)
        self.assertIsNotNone(stat)
        self.assertEqual(stat.size_bytes, 5)
        self.assertEqual(stat.content_type, "text/plain")

    def test_delete(self) -> None:
        store = self.make_store()
        sha, _ = self._upload(store, namespace="proj_a", data=b"gone soon")
        self.assertTrue(store.delete(namespace="proj_a", sha256=sha))
        self.assertFalse(store.delete(namespace="proj_a", sha256=sha))
        self.assertIsNone(store.stat(namespace="proj_a", sha256=sha))
        with self.assertRaises(NotFoundError):
            store.presign_download(namespace="proj_a", sha256=sha, expires_in=300)

    def test_size_cap_rejection_consumes_upload(self) -> None:
        store = self.make_store()
        data = b"five!"
        sha = hashlib.sha256(data).hexdigest()
        target = store.presign_upload(
            namespace="proj_a", sha256=sha, size_bytes=4, expires_in=300
        )
        self._write_upload(target, data)
        with self.assertRaises(ValidationError):
            store.complete_upload(upload_id=target["upload_id"])
        with self.assertRaises(NotFoundError):
            store.complete_upload(upload_id=target["upload_id"])

    def test_checksum_mismatch_rejection_consumes_upload(self) -> None:
        store = self.make_store()
        from urllib.error import HTTPError

        data = b"actual"
        expected_sha = hashlib.sha256(b"expected").hexdigest()
        target = store.presign_upload(
            namespace="proj_a",
            sha256=expected_sha,
            size_bytes=len(data),
            expires_in=300,
        )
        try:
            self._write_upload(target, data)
        except HTTPError:
            pass
        else:
            with self.assertRaises(ValidationError):
                store.complete_upload(upload_id=target["upload_id"])

        self.assertIsNone(store.stat(namespace="proj_a", sha256=expected_sha))
        with self.assertRaises(NotFoundError):
            store.presign_download(
                namespace="proj_a", sha256=expected_sha, expires_in=300
            )

class S3CompatibleObjectStoreClientConfigTest(unittest.TestCase):
    def test_package_export_preserves_the_released_provider_class(self) -> None:
        from merv.brain.object_storage import S3CompatibleObjectStore
        from merv.brain.object_storage.s3_object_store import (
            S3CompatibleObjectStore as concrete,
        )

        self.assertIs(S3CompatibleObjectStore, concrete)

    def test_boto3_client_receives_explicit_credentials_when_both_set(self) -> None:
        from merv.brain.object_storage.s3_object_store import S3CompatibleObjectStore

        captured = {}
        fake_boto3 = types.SimpleNamespace(
            client=lambda service, **kwargs: captured.setdefault(
                "call", {"service": service, "kwargs": kwargs}
            )
        )

        with patch.dict(sys.modules, {"boto3": fake_boto3}):
            store = S3CompatibleObjectStore(
                bucket="bucket",
                endpoint_url="https://x",
                region_name="auto",
                access_key_id="AKIA...",
                secret_access_key="shh",
            )

        self.assertIs(store._s3, captured["call"])
        self.assertEqual(captured["call"]["service"], "s3")
        self.assertEqual(
            captured["call"]["kwargs"],
            {
                "endpoint_url": "https://x",
                "region_name": "auto",
                "aws_access_key_id": "AKIA...",
                "aws_secret_access_key": "shh",
            },
        )

    def test_boto3_client_omits_credentials_unless_both_set(self) -> None:
        from merv.brain.object_storage.s3_object_store import S3CompatibleObjectStore

        calls = []
        fake_boto3 = types.SimpleNamespace(
            client=lambda service, **kwargs: calls.append(
                {"service": service, "kwargs": kwargs}
            )
            or calls[-1]
        )

        with patch.dict(sys.modules, {"boto3": fake_boto3}):
            S3CompatibleObjectStore(
                bucket="bucket",
                endpoint_url="https://x",
                region_name="auto",
            )
            S3CompatibleObjectStore(
                bucket="bucket",
                endpoint_url="https://x",
                region_name="auto",
                access_key_id="AKIA...",
            )

        for call in calls:
            self.assertEqual(call["service"], "s3")
            self.assertEqual(
                call["kwargs"], {"endpoint_url": "https://x", "region_name": "auto"}
            )
            self.assertNotIn("aws_access_key_id", call["kwargs"])
            self.assertNotIn("aws_secret_access_key", call["kwargs"])


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return (
            subprocess.run(["docker", "info"], capture_output=True, timeout=10).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def _boto3_available() -> bool:
    try:
        import boto3  # noqa: F401

        return True
    except ImportError:
        return False


HAVE_MINIO = _docker_available() and _boto3_available()
CONTAINER = "rp-test-minio"
ACCESS_KEY = "rptestkey"
SECRET_KEY = "rptestsecret"
_endpoint: str | None = None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _make_client(endpoint: str):
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        region_name="us-east-1",
    )


def setUpModule() -> None:
    global _endpoint
    if not HAVE_MINIO:
        return
    port = _free_port()
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
    subprocess.run(
        [
            "docker", "run", "-d", "--rm", "--name", CONTAINER,
            "-e", f"MINIO_ROOT_USER={ACCESS_KEY}",
            "-e", f"MINIO_ROOT_PASSWORD={SECRET_KEY}",
            "-p", f"127.0.0.1:{port}:9000",
            "minio/minio", "server", "/data",
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    endpoint = f"http://127.0.0.1:{port}"
    client = _make_client(endpoint)
    deadline = time.monotonic() + 60
    while True:
        try:
            client.list_buckets()
            break
        except Exception:  # noqa: BLE001
            if time.monotonic() > deadline:
                subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
                raise unittest.SkipTest("minio container never became ready")
            time.sleep(0.5)
    _endpoint = endpoint


def tearDownModule() -> None:
    if HAVE_MINIO:
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)


@unittest.skipUnless(HAVE_MINIO, "docker or boto3 unavailable")
class S3BlobStoreTest(BlobStoreContractMixin, unittest.TestCase):
    _bucket_seq = 0

    def make_store(self):
        from merv.brain.object_storage.s3_blobs import S3BlobStore

        assert _endpoint is not None
        client = _make_client(_endpoint)
        type(self)._bucket_seq += 1
        bucket = f"rp-blobs-{type(self)._bucket_seq}"
        client.create_bucket(Bucket=bucket)
        return S3BlobStore(bucket=bucket, client=client)


@unittest.skipUnless(HAVE_MINIO, "docker or boto3 unavailable")
class S3CompatibleObjectProviderTest(ObjectProviderContractMixin, unittest.TestCase):
    _bucket_seq = 0

    def make_store(self, **kwargs):
        from merv.brain.object_storage.s3_object_store import S3CompatibleObjectStore

        assert _endpoint is not None
        client = _make_client(_endpoint)
        type(self)._bucket_seq += 1
        bucket = f"rp-objects-{type(self)._bucket_seq}"
        client.create_bucket(Bucket=bucket)
        return S3CompatibleObjectStore(bucket=bucket, client=client, **kwargs)

    def _write_upload(self, target: dict, data: bytes) -> None:
        import urllib.request

        req = urllib.request.Request(
            target["url"],
            data=data,
            method="PUT",
            headers={
                "Content-Type": target.get("content_type", "application/octet-stream"),
                "x-amz-checksum-sha256": base64.b64encode(
                    hashlib.sha256(data).digest()
                ).decode("ascii"),
            },
        )
        with urllib.request.urlopen(req) as resp:  # noqa: S310
            self.assertIn(resp.status, (200, 204))

    def test_multipart_upload_completes_to_content_key(self) -> None:
        import httpx

        part_size = 5 * 1024 * 1024
        store = self.make_store(
            multipart_threshold_bytes=1,
            multipart_part_bytes=part_size,
        )
        data = (b"a" * part_size) + b"tail"
        sha = hashlib.sha256(data).hexdigest()
        target = store.presign_upload(
            namespace="proj_a",
            sha256=sha,
            size_bytes=len(data),
            content_type="application/octet-stream",
            expires_in=300,
        )
        resumed = store.resume_upload(upload_id=target["upload_id"], expires_in=300)
        self.assertEqual(
            [part["part_number"] for part in resumed["parts"]],
            [part["part_number"] for part in target["parts"]],
        )
        target = resumed
        completed_parts = []
        # urllib trips on a 5 MiB PUT to MinIO (no Expect: 100-continue); httpx
        # (botocore's own HTTP client) rides the presigned part seam cleanly.
        with httpx.Client(timeout=60) as client:
            for part in target["parts"]:
                part_number = int(part["part_number"])
                start = (part_number - 1) * part_size
                chunk = data[start : start + part_size]
                resp = client.put(part["url"], content=chunk)
                resp.raise_for_status()
                completed_parts.append(
                    {"PartNumber": part_number, "ETag": resp.headers["ETag"]}
                )

        stat = store.complete_upload(upload_id=target["upload_id"], parts=completed_parts)

        self.assertEqual(stat.sha256, sha)
        self.assertEqual(stat.size_bytes, len(data))
        self.assertIsNotNone(store.stat(namespace="proj_a", sha256=sha))
        uploads = store._s3.list_objects_v2(Bucket=store.bucket, Prefix=".uploads/")
        self.assertEqual(uploads.get("Contents", []), [])


if __name__ == "__main__":
    unittest.main()
