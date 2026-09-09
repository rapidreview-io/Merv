from __future__ import annotations

import base64
import hashlib
import json

import pytest

from merv.brain.infrastructure.storage import RemoteObjectProvider, _decode_upload, _encode_upload
from merv.brain.kernel.state import StateStore
from merv.brain.object_storage import ObjectStorage
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


@pytest.mark.parametrize("identity", [
    ["proj_a", "obj_test", "sto_one"],
    ["proj_a", "obj_test"],
])
def test_upload_decoder_accepts_original_and_row_specific_handles(identity):
    handle = "msbx_" + base64.urlsafe_b64encode(json.dumps(identity).encode()).decode().rstrip("=")
    assert _decode_upload(handle) == ("proj_a", "obj_test")


@pytest.mark.parametrize("identity", [
    ["proj_a", "obj_test", ""], ["proj_a", "obj_test", "sto_"],
    ["proj_a", "obj_test", "other_one"], ["proj_a", "obj_test", "sto_../escape"],
    ["proj_a", "obj_test", "sto_one\n"], ["proj_a", "obj_test", 7],
    ["proj_a", "obj_test", "sto_one", "extra"], {"proj_a": "obj_test"},
])
def test_upload_decoder_rejects_invalid_row_discriminators(identity):
    handle = "msbx_" + base64.urlsafe_b64encode(json.dumps(identity).encode()).decode().rstrip("=")
    with pytest.raises(ValidationError):
        _decode_upload(handle)


def test_duplicate_migrated_rows_resume_and_complete_independently(tmp_path):
    store = StateStore(db_path=tmp_path / "state.db")
    with store.connect() as conn:
        project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]

    def handler(method, path, **kwargs):
        assert kwargs["namespace"] == "merv-project-" + project_id
        if method == "GET" and path == "/storage/objects":
            return {"objects": []}
        if path.endswith("/complete"):
            return record()
        return {"object": record(state="uploading"), "parts": [], "completed_parts": [],
                "part_count": 0, "part_size": 8388608, "next_part": None}

    client = Client(handler)
    storage = ObjectStorage(store=store, provider=RemoteObjectProvider(client=client))
    entries = [storage.put_object(project_id=project_id, name="datasets/" + name,
                                  kind="dataset", sha256=SHA, size_bytes=3)
               for name in ("first", "second")]
    tokens = []
    for entry in entries:
        row_id = entry["object"]["id"]
        handle = _encode_upload(project_id, "obj_test", row_id=row_id)
        with store.transaction() as conn:
            conn.execute("UPDATE storage_objects SET upload_id=? WHERE id=?", (handle, row_id))
        token = storage._mint_completion_token(project_id=project_id, object_id=row_id, upload_id=handle)
        tokens.append(token)
        assert storage.upload_target_via_token(token=token)["upload"]["upload_id"] == handle

    first = storage.complete_via_token(token=tokens[0])["object"]
    assert first["id"] == entries[0]["object"]["id"] and first["status"] == "available"
    with store.connect() as conn:
        assert conn.execute("SELECT status FROM storage_objects WHERE id=?", (entries[1]["object"]["id"],)).fetchone()[0] == "uploading"
        assert conn.execute("SELECT count(*) FROM storage_completion_tokens").fetchone()[0] == 1
    second = storage.complete_via_token(token=tokens[1])["object"]
    assert second["id"] == entries[1]["object"]["id"] and second["status"] == "available"
    with store.connect() as conn:
        assert conn.execute("SELECT count(*) FROM storage_objects WHERE status='available'").fetchone()[0] == 2
        assert conn.execute("SELECT count(*) FROM storage_completion_tokens").fetchone()[0] == 0
    assert sum(path == "/storage/objects/obj_test/complete" for _, path, _ in client.calls) == 2
