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
import pytest

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


@pytest.fixture
def backend():
    client = boto3.client(
        "s3", endpoint_url=CONFIG["MERV_BLOB_ENDPOINT_URL"], region_name="auto",
        aws_access_key_id="test-access-key", aws_secret_access_key="test-secret-key",
    )
    with Stubber(client) as stub:
        store = R2BlobStore(
            bucket="merv-artifacts", endpoint_url=CONFIG["MERV_BLOB_ENDPOINT_URL"],
            access_key_id="test-access-key", secret_access_key="test-secret-key", client=client,
        )
        yield store, stub
        stub.assert_no_pending_responses()


def put_params():
    return {
        "Bucket": "merv-artifacts", "Key": f"project_a/{SHA}", "Body": DATA,
        "ContentType": "text/plain", "IfNoneMatch": "*",
        "ContentMD5": base64.b64encode(hashlib.md5(DATA, usedforsecurity=False).digest()).decode("ascii"),
    }


def test_put_uses_content_address_conditional_create_and_upload_checksum(backend):
    store, stub = backend
    stub.add_response("put_object", {}, put_params())
    assert store.put(namespace="project_a", data=DATA, content_type="text/plain", expires_at="2026-09-09T00:00:00Z") == SHA


def test_duplicate_put_keeps_existing_object_and_does_not_shorten_retention(backend):
    store, stub = backend
    stub.add_client_error("put_object", "PreconditionFailed", http_status_code=412, expected_params=put_params())
    assert store.put(namespace="project_a", data=DATA, content_type="text/plain") == SHA


@pytest.mark.parametrize("data", [DATA, b"corrupted evidence"])
def test_get_verifies_digest_and_closes_body(backend, data):
    store, stub = backend
    raw = io.BytesIO(data)
    stub.add_response("get_object", {"Body": StreamingBody(raw, len(data)), "ContentLength": len(data)},
                      {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
    if data == DATA:
        assert store.get(namespace="project_a", sha256=SHA) == DATA
    else:
        with pytest.raises(ValidationError, match="checksum"):
            store.get(namespace="project_a", sha256=SHA)
    assert raw.closed


def test_read_bound_refuses_larger_remote_object_without_consuming_body(backend):
    store, stub = backend
    raw = io.BytesIO(DATA)
    stub.add_response("get_object", {"Body": StreamingBody(raw, len(DATA)), "ContentLength": len(DATA)},
                      {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
    with pytest.raises(ValidationError, match="maximum read size"):
        store.get(namespace="project_a", sha256=SHA, max_bytes=2)
    assert raw.closed


def test_missing_content_and_provider_failure_are_distinct(backend):
    store, stub = backend
    params = {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"}
    stub.add_client_error("get_object", "NoSuchKey", http_status_code=404, expected_params=params)
    stub.add_client_error("get_object", "AccessDenied", "secret provider detail", http_status_code=403, expected_params=params)
    with pytest.raises(NotFoundError):
        store.get(namespace="project_a", sha256=SHA)
    with pytest.raises(ContentUnavailableError, match="download from R2 failed") as error:
        store.get(namespace="project_a", sha256=SHA)
    assert "secret provider detail" not in str(error.value)


def test_delete_is_idempotent_and_scoped_to_one_key(backend):
    store, stub = backend
    stub.add_response("delete_object", {}, {"Bucket": "merv-artifacts", "Key": f"project_a/{SHA}"})
    assert store.delete(namespace="project_a", sha256=SHA)


def test_invalid_namespace_or_digest_never_calls_r2(backend):
    store, _ = backend
    with pytest.raises(ValidationError):
        store.put(namespace="../other_project", data=DATA)
    with pytest.raises(ValidationError):
        store.get(namespace="project_a", sha256="not-a-sha256")


def test_native_configuration_cannot_select_or_supply_artifact_storage():
    with patch("boto3.client") as client:
        store = build_blob_store(default_root=Path("unused"), env={
            "MERV_SANDBOXES_URL": "https://native.test",
            "MERV_SANDBOXES_JWT_SECRET": "native-secret",
        })
    assert isinstance(store, UnconfiguredBlobStore)
    client.assert_not_called()
    with pytest.raises(ContentUnavailableError, match="MERV_BLOB_BUCKET"):
        store.put(namespace="project_a", data=DATA)


@pytest.mark.parametrize("env", [{"MERV_BLOB_BUCKET": "merv-artifacts"}, {"MERV_BLOB_REGION": "auto"}])
def test_partial_r2_configuration_fails_closed_without_creating_client(env):
    with patch("boto3.client") as client, pytest.raises(ValidationError, match="incomplete artifact R2 configuration"):
        build_blob_store(default_root=Path("unused"), env=env)
    client.assert_not_called()


def test_explicit_r2_configuration_uses_boto3_and_optional_prefix():
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


@pytest.mark.parametrize("override", [
    {"MERV_BLOB_ENDPOINT_URL": "http://test-account.r2.cloudflarestorage.com"},
    {"MERV_BLOB_ENDPOINT_URL": "https://user:secret@test-account.r2.cloudflarestorage.com"},
    {"MERV_BLOB_PREFIX": "../other"},
])
def test_invalid_endpoint_or_prefix_is_rejected_before_client_creation(override):
    with patch("boto3.client") as client, pytest.raises(ValidationError):
        build_blob_store(default_root=Path("unused"), env={**CONFIG, **override})
    client.assert_not_called()
