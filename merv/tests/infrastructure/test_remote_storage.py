"""Byte-transfer helpers over merv-sandboxes: targets, commands, and the token loop."""

from __future__ import annotations

import base64
import hashlib
import shlex

import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from merv.brain.infrastructure import RemoteObjects
from merv.brain.infrastructure.storage import (
    storage_fetch_command,
    storage_multipart_submit_command,
    storage_submit_command,
    upload_target,
)
from merv.brain.kernel.state import StateStore
from merv.shared.errors import NotFoundError, ValidationError


SHA = hashlib.sha256(b"abc").hexdigest()


def record(**overrides):
    return {"id": "obj_test", "namespace": "proj_a", "name": "datasets/abc.bin", "version": 1,
            "kind": "file", "sha256": SHA, "size_bytes": 3, "content_type": "application/octet-stream",
            "state": "available", "created_at": "2026-09-01T00:00:00+00:00",
            "updated_at": "2026-09-01T00:00:00+00:00", "expires_at": None, **overrides}


class Client:
    def __init__(self, handler):
        self.calls = []
        self.handler = handler

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        return self.handler(method, path, **kwargs)


class RemoteStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp_path = Path(self.enterContext(TemporaryDirectory()))

    def test_upload_target_keeps_noncontiguous_missing_parts_and_follows_all_pages(self):
        def handler(method, path, **kwargs):
            part = kwargs.get("params", {}).get("start_part", 1)
            return {"object": record(state="uploading", size_bytes=101), "part_size": 1,
                    "part_count": 101, "completed_parts": [2],
                    "parts": [{"part_number": n, "url": f"https://store.test/{n}"}
                              for n in (range(1, 101) if part == 1 else [101]) if n != 2],
                    "next_part": 101 if part == 1 else None}

        client = Client(handler)
        first = handler("GET", "/storage/objects/obj_test/upload", params={"start_part": 1})
        target = upload_target(client, namespace="proj_a", status=first)
        assert target["upload_id"] == "obj_test"
        assert len(target["parts"]) == 100
        assert target["parts"][-1]["part_number"] == 101
        assert target["completed_parts"] == [2]
        assert "url" not in target
        assert client.calls == [("GET", "/storage/objects/obj_test/upload",
                                 {"namespace": "proj_a", "params": {"start_part": 101, "limit": 100}})]

    def test_upload_target_rejects_looping_pagination(self):
        client = Client(lambda *args, **kwargs: {"parts": [], "completed_parts": [], "next_part": 2})
        status = {"object": record(state="uploading"), "part_size": 1, "part_count": 3,
                  "parts": [], "completed_parts": [], "next_part": 2}
        with self.assertRaises(ValidationError):
            upload_target(client, namespace="proj_a", status=status)

    def test_single_part_target_exposes_signed_url_and_headers(self):
        status = {"object": record(state="uploading"), "part_size": 8388608, "part_count": 1,
                  "parts": [{"part_number": 1, "url": "https://store.test/put",
                             "headers": {"Content-Type": "application/octet-stream"}}],
                  "completed_parts": [], "next_part": None}
        target = upload_target(Client(lambda *a, **k: self.fail("no pages")), namespace="proj_a", status=status)
        assert target["url"] == "https://store.test/put"
        assert target["headers"] == {"Content-Type": "application/octet-stream"}
        assert base64.b64decode(target["checksum_sha256"]).hex() == SHA

    def test_empty_file_has_no_byte_parts_but_a_target(self):
        empty_sha = hashlib.sha256(b"").hexdigest()
        status = {"object": record(sha256=empty_sha, size_bytes=0, state="uploading"),
                  "parts": [], "completed_parts": [], "part_count": 0, "part_size": 8388608, "next_part": None}
        target = upload_target(Client(lambda *a, **k: self.fail("no pages")), namespace="proj_a", status=status)
        assert target["parts"] == []
        assert "url" not in target
        assert base64.b64decode(target["checksum_sha256"]).hex() == empty_sha

    def test_submit_command_keeps_untrusted_values_as_single_shell_words(self):
        payload = "application/x' ; touch /tmp/pwned ; echo '"
        run = storage_submit_command(
            base_url="https://x", path="f.bin", presigned_url="https://s3/put",
            checksum_b64="YWJj", content_type=payload, token="tok",
        )
        put_cmd, complete_cmd = run.split(" && ", 1)
        tokens = shlex.split(put_cmd)
        assert "touch" not in tokens and ";" not in tokens
        assert f"Content-Type: {payload}" in tokens
        assert complete_cmd == "curl -sf -X POST 'https://x/api/storage/u/tok/complete'"
        # Signed headers from the service replace the default checksum headers.
        signed = storage_submit_command(
            base_url="", path="f.bin", presigned_url="https://s3/put", checksum_b64="YWJj",
            content_type="text/plain", token="tok", headers={"x-signed": "1"},
        )
        assert "-H 'x-signed: 1'" in signed and "x-amz-checksum" not in signed
        assert "http://127.0.0.1:8787/api/storage/u/tok/complete" in signed

    def test_multipart_and_fetch_commands(self):
        multipart = storage_multipart_submit_command(base_url="https://x/", path="big bin", token="tok")
        assert multipart == "merv-client storage-upload --path 'big bin' --target-url 'https://x/api/storage/u/tok'"
        fetch = storage_fetch_command(path="out.bin", presigned_url="https://s3/get", sha256=SHA)
        assert fetch == f"curl -sf -o 'out.bin' 'https://s3/get' && printf '%s  %s\\n' {SHA} 'out.bin' | shasum -a 256 -c"

    def test_token_loop_names_the_service_object_and_consumes_the_token(self):
        tmp_path = self.tmp_path
        store = StateStore(db_path=tmp_path / "state.db")
        with store.connect() as conn:
            project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]

        def handler(method, path, **kwargs):
            assert kwargs["namespace"] == project_id
            if method == "POST" and path == "/storage/objects":
                return {"object": record(state="uploading"), "parts": [{"part_number": 1, "url": "https://s3/put"}],
                        "completed_parts": [], "part_count": 1, "part_size": 8388608, "next_part": None}
            if path.endswith("/upload"):
                return {"object": record(state="uploading"), "parts": [], "completed_parts": [1],
                        "part_count": 1, "part_size": 8388608, "next_part": None}
            if path.endswith("/complete"):
                return record()
            raise AssertionError(path)

        client = Client(handler)
        objects = RemoteObjects(client=client, store=store)
        submitted = objects.submit(project_id=project_id, path="datasets/abc.bin", sha256=SHA, size_bytes=3)
        token = submitted["run"].rsplit("/api/storage/u/", 1)[1].split("/", 1)[0]
        resumed = objects.upload_target_via_token(token=token)["upload"]
        assert resumed["upload_id"] == "obj_test" and resumed["completed_parts"] == [1]
        completed = objects.complete_via_token(token=token)["object"]
        assert (completed["id"], completed["status"], completed["content_sha256"]) == ("obj_test", "available", SHA)
        assert completed["created_at"] == "2026-09-01T00:00:00Z"
        with store.connect() as conn:
            assert conn.execute("SELECT count(*) FROM storage_completion_tokens").fetchone()[0] == 0
        with self.assertRaises(NotFoundError):
            objects.complete_via_token(token=token)
        assert [call[1] for call in client.calls] == [
            "/storage/objects", "/storage/objects/obj_test/upload", "/storage/objects/obj_test/complete",
        ]

    def test_completion_refuses_objects_the_service_did_not_publish(self):
        tmp_path = self.tmp_path
        store = StateStore(db_path=tmp_path / "state.db")
        with store.connect() as conn:
            project_id = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"]
        client = Client(lambda *args, **kwargs: record(state="completing"))
        with self.assertRaises(ValidationError):
            RemoteObjects(client=client, store=store).complete_upload(project_id=project_id, upload_id="obj_test")
        for bad in ["obj_../victim", "obj?x", "", "a/b"]:
            with self.assertRaises(ValidationError):
                RemoteObjects(client=client, store=store).get_object(project_id=project_id, object_id=bad)
