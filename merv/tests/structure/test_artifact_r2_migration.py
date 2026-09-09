"""Operator copy contracts without native service or R2 credentials."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import httpx
import pytest

from merv.brain.kernel.utils import NotFoundError


spec = importlib.util.spec_from_file_location(
    "artifact_r2_migration", Path(__file__).resolve().parents[2] / "deploy" / "migrate_artifacts_to_r2.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def record(index: int, body: bytes = b"abc", **changes) -> dict:
    digest = hashlib.sha256(body).hexdigest()
    return {"id": f"obj_{index}", "namespace": "merv-blobs", "state": "available",
            "name": f"proj_{index}/{digest}", "sha256": digest,
            "size_bytes": len(body), "content_type": "text/plain", **changes}


class Native:
    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.calls = []

    def request(self, method, path, *, namespace, params=None):
        assert method == "GET" and namespace == "merv-blobs"
        self.calls.append((path, params))
        if path == "/storage/objects":
            return {"objects": self.rows[params["offset"]:params["offset"] + params["limit"]]}
        return {"url": "https://bytes.test/" + path.split("/")[3] + "?secret=never-print"}


class Destination:
    def __init__(self):
        self.data = {}
        self.reads, self.writes = [], []

    def get(self, *, namespace, sha256):
        self.reads.append((namespace, sha256))
        if (namespace, sha256) not in self.data:
            raise NotFoundError("absent")
        return self.data[namespace, sha256]

    def put(self, *, namespace, data, content_type):
        digest = hashlib.sha256(data).hexdigest()
        self.writes.append((namespace, digest, content_type))
        self.data[namespace, digest] = data
        return digest


def transfer(body: bytes = b"abc", status: int = 200):
    return httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(status, content=body, request=request)
    ))


def test_plan_pages_inventory_without_any_transfer_and_keeps_heavy_storage_out():
    source = Native([record(1), record(2, state="uploading"), record(3), record(4)])
    result = migration.migrate(client=source, page_size=2)
    assert result["source_objects"] == 3 and result["source_bytes"] == 9
    assert result["unavailable_records"] == 1
    assert [params["offset"] for _, params in source.calls] == [0, 2, 4]
    assert result["copied"] == result["verified_bytes"] == 0


def test_apply_verifies_existing_and_readback_then_rerun_checks_every_key():
    source, destination = Native([record(1), record(2), record(3)]), Destination()
    destination.data["proj_1", record(1)["sha256"]] = b"abc"
    with transfer() as http:
        result = migration.migrate(client=source, destination=destination, mode="apply", workers=2, page_size=2, transfer=http)
        assert (result["copied"], result["verified_existing"], result["verified_bytes"]) == (2, 1, 9)
        reads_before, writes_before = len(destination.reads), len(destination.writes)
        downloads_before = sum(path.endswith("/download") for path, _ in source.calls)
        repeated = migration.migrate(client=source, destination=destination, mode="apply", transfer=http)
    assert repeated["inventory_sha256"] == result["inventory_sha256"]
    assert repeated["copied"] == 0 and repeated["verified_existing"] == 3
    assert len(destination.reads) - reads_before == 3
    assert len(destination.writes) == writes_before == 2
    assert sum(path.endswith("/download") for path, _ in source.calls) == downloads_before


def test_verify_only_reports_missing_without_downloading_or_writing():
    source, destination = Native([record(1)]), Destination()
    with transfer() as http:
        result = migration.migrate(client=source, destination=destination, mode="verify", transfer=http)
    assert result["failures"] == [{"object_id": "obj_1", "error": "destination_missing"}]
    assert not destination.writes
    assert all(path == "/storage/objects" for path, _ in source.calls)


@pytest.mark.parametrize("body,error", [(b"xyz", "source_integrity_failed"), (b"abcdef", "source_size_exceeded")])
def test_invalid_source_bytes_never_reach_destination(body, error):
    destination = Destination()
    with transfer(body) as http:
        result = migration.migrate(client=Native([record(1)]), destination=destination, mode="apply", transfer=http)
    assert result["failures"][0]["error"] == error
    assert not destination.writes


def test_existing_corruption_is_not_a_successful_resume():
    destination = Destination()
    destination.data["proj_1", record(1)["sha256"]] = b"xyz"
    with transfer() as http:
        result = migration.migrate(client=Native([record(1)]), destination=destination, mode="apply", transfer=http)
    assert result["failures"][0]["error"] == "destination_integrity_failed"
    assert result["verified_existing"] == result["verified_bytes"] == 0


def test_reports_never_expose_signed_urls_from_http_errors():
    with transfer(status=403) as http:
        result = migration.migrate(client=Native([record(1)]), destination=Destination(), mode="apply", transfer=http)
    assert result["failures"][0]["error"] == "HTTPStatusError"
    assert "never-print" not in json.dumps(result) and "https://" not in json.dumps(result)


def test_repeated_page_identity_and_cross_namespace_records_abort_inventory():
    with pytest.raises(migration.CheckFailed, match="inventory_changed"):
        migration.inventory(Native([record(1), record(1)]), page_size=1)
    with pytest.raises(migration.CheckFailed, match="invalid_source_namespace"):
        migration.inventory(Native([record(1, namespace="merv-project-proj_1")]))


def test_duplicate_content_versions_copy_once_but_conflicting_sizes_abort():
    duplicate = record(1, id="obj_duplicate")
    rows, _ = migration.inventory(Native([record(1), duplicate]))
    assert len(rows) == 1
    with pytest.raises(migration.CheckFailed, match="conflicting_content_size"):
        migration.inventory(Native([record(1), {**duplicate, "size_bytes": 999}]))


def test_env_file_reads_literal_secrets_without_shell_expansion(tmp_path):
    config = tmp_path / "source.env"
    config.write_text('# config\nexport MERV_SANDBOXES_JWT_SECRET="literal$(touch bad)`literal`"\nMERV_SANDBOXES_URL=https://native.test\n')
    env = migration.read_env(config)
    assert env["MERV_SANDBOXES_JWT_SECRET"] == "literal$(touch bad)`literal`"
    assert env["MERV_SANDBOXES_URL"] == "https://native.test"
