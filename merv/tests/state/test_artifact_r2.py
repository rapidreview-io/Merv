"""R2 wire contracts and storage isolation, with no network or credentials."""

from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path
from unittest.mock import patch

import boto3
from botocore.response import StreamingBody
from botocore.stub import Stubber
import unittest

from merv.brain.artifacts.r2 import R2BlobStore, UnconfiguredBlobStore
from merv.brain.kernel.utils import ContentUnavailableError, NotFoundError, ValidationError
from merv.brain.surface.config import build_blob_store


DATA = b"immutable evidence"
SHA = hashlib.sha256(DATA).hexdigest()
CONFIG = {
    "MERV_BLOB_BUCKET": "merv-artifacts",
    "MERV_BLOB_ENDPOINT_URL": "https://test-account.r2.cloudflarestorage.com",
    "MERV_BLOB_ACCESS_KEY_ID": "test-access-key",
    "MERV_BLOB_SECRET_ACCESS_KEY": "test-secret-key",
}


def put_params():
    return {
        "Bucket": "merv-artifacts", "Key": f"project_a/{SHA}", "Body": DATA,
        "ContentType": "text/plain", "IfNoneMatch": "*",
        "ContentMD5": base64.b64encode(hashlib.md5(DATA, usedforsecurity=False).digest()).decode("ascii"),
    }


class ArtifactR2Tests(unittest.TestCase):
    def setUp(self):
        client = boto3.client(
            "s3", endpoint_url=CONFIG["MERV_BLOB_ENDPOINT_URL"], region_name="auto",
            aws_access_key_id="test-access-key", aws_secret_access_key="test-secret-key",
        )
        stub = self.enterContext(Stubber(client))
        self.addCleanup(stub.assert_no_pending_responses)
        store = R2BlobStore(
            bucket="merv-artifacts", endpoint_url=CONFIG["MERV_BLOB_ENDPOINT_URL"],
            access_key_id="test-access-key", secret_access_key="test-secret-key", client=client,
        )
        self.backend = store, stub

    def test_put_uses_content_address_conditional_create_and_upload_checksum(self):
        store, stub = self.backend
        stub.add_response("put_object", {}, put_params())
        assert store.put(namespace="project_a", data=DATA, content_type="text/plain", expires_at="2026-09-09T00:00:00Z") == SHA

    def test_duplicate_put_keeps_existing_object_and_does_not_shorten_retention(self):
        store, stub = self.backend
        stub.add_client_error("put_object", "PreconditionFailed", http_status_code=412, expected_params=put_params())
        assert store.put(namespace="project_a", data=DATA, content_type="text/plain") == SHA

    def _check_get_verifies_digest_and_closes_body(self, data):
        store, stub = self.backend
        raw = io.BytesIO(data)
        stub.add_response("get_object", {"Body": StreamingBody(raw, len(data)), "ContentLength": len(data)},
                          {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
        if data == DATA:
            assert store.get(namespace="project_a", sha256=SHA) == DATA
        else:
            with self.assertRaisesRegex(ValidationError, "checksum"):
                store.get(namespace="project_a", sha256=SHA)
        assert raw.closed

    def test_get_verifies_digest_and_closes_body_1(self):
        self._check_get_verifies_digest_and_closes_body(DATA)

    def test_get_verifies_digest_and_closes_body_2(self):
        self._check_get_verifies_digest_and_closes_body(b'corrupted evidence')

    def test_read_bound_refuses_larger_remote_object_without_consuming_body(self):
        store, stub = self.backend
        raw = io.BytesIO(DATA)
        stub.add_response("get_object", {"Body": StreamingBody(raw, len(DATA)), "ContentLength": len(DATA)},
                          {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
        with self.assertRaisesRegex(ValidationError, "maximum read size"):
            store.get(namespace="project_a", sha256=SHA, max_bytes=2)
        assert raw.closed

    def test_missing_content_and_provider_failure_are_distinct(self):
        store, stub = self.backend
        params = {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"}
        stub.add_client_error("get_object", "NoSuchKey", http_status_code=404, expected_params=params)
        stub.add_client_error("get_object", "AccessDenied", "secret provider detail", http_status_code=403, expected_params=params)
        with self.assertRaises(NotFoundError):
            store.get(namespace="project_a", sha256=SHA)
        with self.assertRaisesRegex(ContentUnavailableError, "download from R2 failed") as error:
            store.get(namespace="project_a", sha256=SHA)
        assert "secret provider detail" not in str(error.exception)

    def test_delete_is_idempotent_and_scoped_to_one_key(self):
        store, stub = self.backend
        stub.add_response("delete_object", {}, {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
        assert store.delete(namespace="project_a", sha256=SHA)

    def test_invalid_namespace_or_digest_never_calls_r2(self):
        store, _ = self.backend
        with self.assertRaises(ValidationError):
            store.put(namespace="../other_project", data=DATA)
        with self.assertRaises(ValidationError):
            store.get(namespace="project_a", sha256="not-a-sha256")

    def test_native_configuration_cannot_select_or_supply_artifact_storage(self):
        with patch("boto3.client") as client:
            store = build_blob_store(default_root=Path("unused"), env={
                "MERV_SANDBOXES_URL": "https://native.test",
                "MERV_SANDBOXES_JWT_SECRET": "native-secret",
            })
        assert isinstance(store, UnconfiguredBlobStore)
        client.assert_not_called()
        with self.assertRaisesRegex(ContentUnavailableError, "MERV_BLOB_BUCKET"):
            store.put(namespace="project_a", data=DATA)

    def _check_partial_r2_configuration_fails_closed_without_creating_client(self, env):
        with patch("boto3.client") as client, self.assertRaisesRegex(ValidationError, "incomplete artifact R2 configuration"):
            build_blob_store(default_root=Path("unused"), env=env)
        client.assert_not_called()

    def test_partial_r2_configuration_fails_closed_without_creating_client_1(self):
        self._check_partial_r2_configuration_fails_closed_without_creating_client({'MERV_BLOB_BUCKET': 'merv-artifacts'})

    def test_partial_r2_configuration_fails_closed_without_creating_client_2(self):
        self._check_partial_r2_configuration_fails_closed_without_creating_client({'MERV_BLOB_REGION': 'auto'})

    def test_explicit_r2_configuration_uses_boto3_and_optional_prefix(self):
        with patch("boto3.client") as client:
            store = build_blob_store(default_root=Path("unused"), env={**CONFIG, "MERV_BLOB_PREFIX": "evidence/v1"})
        assert isinstance(store, R2BlobStore)
        args, kwargs = client.call_args
        assert args == ("s3",)
        assert kwargs["endpoint_url"] == CONFIG["MERV_BLOB_ENDPOINT_URL"]
        assert kwargs["aws_access_key_id"] == CONFIG["MERV_BLOB_ACCESS_KEY_ID"]
        assert kwargs["aws_secret_access_key"] == CONFIG["MERV_BLOB_SECRET_ACCESS_KEY"]
        assert kwargs["region_name"] == "auto"
        assert store._key("project_a", SHA) == f"evidence/v1/project_a/{SHA}"

    def _check_invalid_endpoint_or_prefix_is_rejected_before_client_creation(self, override):
        with patch("boto3.client") as client, self.assertRaises(ValidationError):
            build_blob_store(default_root=Path("unused"), env={**CONFIG, **override})
        client.assert_not_called()

    def test_invalid_endpoint_or_prefix_is_rejected_before_client_creation_1(self):
        self._check_invalid_endpoint_or_prefix_is_rejected_before_client_creation({'MERV_BLOB_ENDPOINT_URL': 'http://test-account.r2.cloudflarestorage.com'})

    def test_invalid_endpoint_or_prefix_is_rejected_before_client_creation_2(self):
        self._check_invalid_endpoint_or_prefix_is_rejected_before_client_creation({'MERV_BLOB_ENDPOINT_URL': 'https://user:secret@test-account.r2.cloudflarestorage.com'})

    def test_invalid_endpoint_or_prefix_is_rejected_before_client_creation_3(self):
        self._check_invalid_endpoint_or_prefix_is_rejected_before_client_creation({'MERV_BLOB_PREFIX': '../other'})
