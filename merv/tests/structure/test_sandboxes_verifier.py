"""Safety bounds for the opt-in production verifier, using no live services."""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import sys
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

    class Blobs:
        def put(self, **kwargs):
            raise RuntimeError("accepted upload response was lost")

        def delete(self, **kwargs):
            calls.append(kwargs)
            return True

        def get(self, **kwargs):
            raise verifier.NotFoundError("missing")

    with patch.object(verifier, "build_blob_store", return_value=Blobs()):
        with pytest.raises(RuntimeError, match="response was lost"):
            verifier.verify_artifact_write("smoke_only")
    assert calls == [{"namespace": "smoke_only", "sha256": hashlib.sha256(b"smoke_only:evidence\n" * 64).hexdigest()}]


class SchemaConnection:
    def __init__(self, version):
        self.version = version
        self.statements = []

    def execute(self, sql):
        self.statements.append(sql)
        assert sql.startswith("SELECT ")
        return self

    def fetchone(self):
        return {"version": self.version}

    def fetchall(self):
        return [{"version": self.version, "name": "add_remote_sandbox_links"}]


def test_pre_cutover_schema57_is_read_only_and_does_not_query_new_table():
    connection = SchemaConnection(57)
    assert verifier.verify_schema(connection, pre_cutover=True) == 57
    assert connection.statements == ["SELECT max(version) AS version FROM schema_migrations"]


def test_final_verification_rejects_schema57():
    with pytest.raises(verifier.CheckFailed, match="verification phase"):
        verifier.verify_schema(SchemaConnection(57))


def test_schema59_checks_persisted_remote_links_in_both_phases():
    for pre_cutover in (False, True):
        connection = SchemaConnection(59)
        assert verifier.verify_schema(connection, pre_cutover=pre_cutover) == 59
        assert "FROM remote_sandbox_links" in connection.statements[-1]


def test_schema58_remains_readable_before_artifact_cutover_only():
    assert verifier.verify_schema(SchemaConnection(58), pre_cutover=True) == 58
    with pytest.raises(verifier.CheckFailed, match="verification phase"):
        verifier.verify_schema(SchemaConnection(58))


def test_disposable_composition_uses_synthetic_database_and_authentication(capsys):
    from tests.support.infrastructure import FakeInfrastructureClient

    class NativeClient(FakeInfrastructureClient):
        def request(self, method, path, *, namespace, **kwargs):
            if path == "/auth/me":
                return {"namespace": namespace, "token_id": "svc_smoke"}
            return super().request(method, path, namespace=namespace, **kwargs)

    composition_spec = importlib.util.spec_from_file_location(
        "composition_verifier", Path(__file__).resolve().parents[2] / "deploy" / "verify_merv_composition.py"
    )
    composition = importlib.util.module_from_spec(composition_spec)
    composition_spec.loader.exec_module(composition)
    env = {"MERV_DB_URL": "postgresql://must-never-connect/production",
           "RESEARCH_PLUGIN_DB_URL": "postgresql://must-never-connect/production",
           "SUPABASE_URL": "https://auth.test", "SUPABASE_JWT_SECRET": "synthetic-secret-for-test-only-12345",
           "MERV_WAIT_SECRET": "synthetic-wait-secret-only-123456789", "MERV_REQUIRE_AUTH": "1"}
    with patch.dict(os.environ, env, clear=True), patch.dict(sys.modules, {"verify_sandboxes_cutover": verifier}), \
            patch("merv.brain.surface.surface.build_infrastructure_client", return_value=NativeClient()):
        composition.verify_composition()
        assert os.environ["MERV_DB_URL"] == "" and os.environ["RESEARCH_PLUGIN_DB_URL"] == ""
    assert '"synthetic_mcp_credential_verified": true' in capsys.readouterr().out
