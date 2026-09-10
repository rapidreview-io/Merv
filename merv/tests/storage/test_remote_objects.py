"""RemoteObjects: Merv's heavy-object facade over a fake merv-sandboxes service."""

from __future__ import annotations

import hashlib
import re
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

from merv.brain.infrastructure import RemoteObjects
from merv.brain.infrastructure.objects import STORAGE_DEFAULT_TTL_SECONDS
from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import NotFoundError, ValidationError, parse_iso
from tests.support.infrastructure import FakeInfrastructureClient


class RecordingLifecycle:
    """Captures the hook calls the facade makes, and can refuse a submission."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.refuse: Exception | None = None

    def submitted(self, *, project_id, record, attributes) -> None:
        self.calls.append(("submitted", {"project_id": project_id, "record": record,
                                         "attributes": dict(attributes)}))
        if self.refuse is not None:
            raise self.refuse

    def completed(self, *, project_id, record) -> None:
        self.calls.append(("completed", {"project_id": project_id, "record": record}))

    def deleted(self, *, project_id, object_id) -> None:
        self.calls.append(("deleted", {"project_id": project_id, "object_id": object_id}))


def _presigned_and_token(run: str) -> tuple[str, str]:
    put_cmd, complete_cmd = run.split(" && ", 1)
    presigned = re.findall(r"'([^']*)'", put_cmd)[-1]
    token = re.search(r"/api/storage/u/([^/]+)/complete", complete_cmd).group(1)
    return presigned, token


class RemoteObjectsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(db_path=Path(self.tmp.name) / "state.sqlite")
        with closing(self.store.connect()) as conn:
            self.project_id = str(conn.execute("SELECT id FROM projects LIMIT 1").fetchone()["id"])
        self.client = FakeInfrastructureClient()
        self.lifecycle = RecordingLifecycle()
        self.objects = RemoteObjects(client=self.client, store=self.store, lifecycle=self.lifecycle)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _submit(self, data: bytes, *, path: str = "datasets/train.bin", **extra) -> dict:
        return self.objects.submit(
            project_id=self.project_id, path=path,
            sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), **extra,
        )

    def _submit_and_complete(self, data: bytes, **extra) -> dict:
        submitted = self._submit(data, **extra)
        presigned, token = _presigned_and_token(submitted["run"])
        Path(url2pathname(urlsplit(presigned).path)).write_bytes(data)
        return self.objects.complete_via_token(token=token)["object"]

    def test_submit_creates_service_object_and_completion_finalizes_it(self) -> None:
        data = b"bytes for the service"
        submitted = self._submit(data, kind="dataset", notes="kept")
        obj = submitted["object"]
        self.assertEqual(obj["name"], "datasets/train.bin")
        self.assertEqual(obj["version"], 1)
        self.assertEqual(obj["status"], "uploading")
        self.assertEqual(obj["content_sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(submitted["upload_id"], obj["id"])
        self.assertFalse(submitted["uploaded"])
        # The service was asked for Merv's retention window, nothing research.
        create = next(call for call in self.client.calls if call[:2] == ("POST", "/storage/objects"))
        self.assertEqual(create[3]["expires_in_seconds"], STORAGE_DEFAULT_TTL_SECONDS)
        self.assertNotIn("kind", create[3])
        self.assertNotIn("notes", create[3])
        # Research attributes reached the hook verbatim.
        self.assertEqual(self.lifecycle.calls[0][0], "submitted")
        self.assertEqual(self.lifecycle.calls[0][1]["attributes"], {"kind": "dataset", "notes": "kept"})

        presigned, token = _presigned_and_token(submitted["run"])
        self.assertRegex(submitted["run"], r"^curl -sf -X PUT .* && curl -sf -X POST 'http://[^']+/api/storage/u/[^/']+/complete'$")
        Path(url2pathname(urlsplit(presigned).path)).write_bytes(data)
        completed = self.objects.complete_via_token(token=token)["object"]
        self.assertEqual(completed["status"], "available")
        self.assertIsNotNone(completed["expires_at"])
        self.assertEqual(self.lifecycle.calls[-1][0], "completed")
        self.assertEqual(self.lifecycle.calls[-1][1]["record"]["id"], obj["id"])
        # Single-use token.
        with self.assertRaises(NotFoundError):
            self.objects.complete_via_token(token=token)

    def test_service_assigns_versions_instead_of_deduplicating(self) -> None:
        first = self._submit_and_complete(b"v1", kind="other")
        second = self._submit_and_complete(b"v1", kind="other")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual((first["version"], second["version"]), (1, 2))

    def test_multipart_target_round_trips_through_the_token(self) -> None:
        self.client.storage_part_bytes = 4
        data = b"0123456789"
        submitted = self._submit(data, path="big.bin", kind="other")
        self.assertIn("merv-client storage-upload", submitted["run"])
        token = re.search(r"/api/storage/u/([^/']+)", submitted["run"]).group(1)
        target = self.objects.upload_target_via_token(token=token)["upload"]
        self.assertEqual([part["part_number"] for part in target["parts"]], [1, 2, 3])
        self.assertEqual(target["part_count"], 3)
        self.assertNotIn("url", target)
        self.client.upload_bytes(submitted["object"]["id"], data)
        completed = self.objects.complete_via_token(
            token=token, parts=[{"part_number": 2, "etag": "b"}, {"part_number": 1, "etag": "a"}]
        )
        self.assertEqual(completed["object"]["status"], "available")

    def test_mismatched_bytes_fail_completion_and_keep_the_token(self) -> None:
        submitted = self._submit(b"declared", kind="other")
        presigned, token = _presigned_and_token(submitted["run"])
        Path(url2pathname(urlsplit(presigned).path)).write_bytes(b"other!!!")
        with self.assertRaises(ValidationError):
            self.objects.complete_via_token(token=token)
        self.assertNotIn("completed", [name for name, _ in self.lifecycle.calls])

    def test_refused_submission_removes_the_service_object(self) -> None:
        self.lifecycle.refuse = ValidationError("invalid storage kind")
        with self.assertRaisesRegex(ValidationError, "invalid storage kind"):
            self._submit(b"x", kind="bogus")
        self.assertIn(("DELETE", "/storage/objects/obj_1"), [call[:2] for call in self.client.calls])
        listed = self.objects.find(project_id=self.project_id, status="uploading")
        self.assertEqual(listed["objects"], [])

    def test_list_defaults_to_available_and_paginates(self) -> None:
        a = self._submit_and_complete(b"aa", path="datasets/a.tar", kind="dataset")
        b = self._submit_and_complete(b"bbbb", path="models/b.bin", kind="model")
        self._submit(b"pending", path="models/c.bin", kind="model")
        listed = self.objects.find(project_id=self.project_id)
        self.assertEqual([item["id"] for item in listed["objects"]], [a["id"], b["id"]])
        self.assertEqual((listed["count"], listed["total"], listed["has_more"]), (2, 2, False))
        self.assertTrue(listed["guidance"]["enabled"])
        page = self.objects.find(project_id=self.project_id, limit=1, offset=1, compact=True)
        self.assertEqual([item["id"] for item in page["objects"]], [b["id"]])
        self.assertEqual(set(page["objects"][0]), {
            "id", "project_id", "name", "version", "kind", "content_sha256",
            "size_bytes", "status", "expires_at", "updated_at",
        })
        self.assertFalse(page["has_more"])
        uploading = self.objects.find(project_id=self.project_id, status="uploading")
        self.assertEqual([item["name"] for item in uploading["objects"]], ["models/c.bin"])
        with self.assertRaises(ValidationError):
            self.objects.find(project_id=self.project_id, status="expired")

    def test_list_entries_carry_service_facts_only(self) -> None:
        obj = self._submit_and_complete(b"facts", kind="model", producing_run="run-1", notes="n")
        entry = self.objects.find(project_id=self.project_id)["objects"][0]
        self.assertEqual(entry["id"], obj["id"])
        self.assertEqual(set(entry), {
            "id", "project_id", "name", "version", "kind", "status", "content_sha256",
            "size_bytes", "content_type", "expires_at", "created_at", "updated_at",
            "producer_job_id", "error",
        })
        self.assertEqual(entry["kind"], "file")
        self.assertTrue(entry["created_at"].endswith("Z"))

    def test_resolve_by_name_picks_latest_available_and_renews_retention(self) -> None:
        first = self._submit_and_complete(b"one", path="models/w.bin", kind="model")
        second = self._submit_and_complete(b"two", path="models/w.bin", kind="model")
        self._submit(b"three", path="models/w.bin", kind="model")  # still uploading
        latest = self.objects.find(project_id=self.project_id, name="models/w.bin", include_download=False)
        self.assertEqual(latest["object"]["id"], second["id"])
        self.assertNotIn("download", latest)
        pinned_version = self.objects.find(project_id=self.project_id, name="models/w.bin", version=1)
        self.assertEqual(pinned_version["object"]["id"], first["id"])
        self.assertTrue(pinned_version["download"]["url"].startswith("file://"))
        before = parse_iso(first["expires_at"])
        after = parse_iso(pinned_version["object"]["expires_at"])
        self.assertGreaterEqual(after, before)
        with self.assertRaises(NotFoundError):
            self.objects.find(project_id=self.project_id, name="models/w.bin", version=3)
        with self.assertRaises(ValidationError):
            self.objects.find(project_id=self.project_id, object_id=first["id"], name="x")

    def test_fetch_returns_verified_download_command(self) -> None:
        data = b"fetch me"
        obj = self._submit_and_complete(data, kind="dataset")
        fetched = self.objects.fetch(project_id=self.project_id, object_id=obj["id"], path="local/copy.bin")
        self.assertEqual(fetched["object"]["id"], obj["id"])
        self.assertRegex(fetched["run"], r"^curl -sf -o 'local/copy\.bin' 'file://[^']+' && ")
        self.assertIn(f"printf '%s  %s\\n' {hashlib.sha256(data).hexdigest()} 'local/copy.bin' | shasum -a 256 -c", fetched["run"])

    def test_pin_renew_and_delete(self) -> None:
        obj = self._submit_and_complete(b"lifecycle", kind="other")
        renewed = self.objects.manage(project_id=self.project_id, object_id=obj["id"], action="renew")
        self.assertGreaterEqual(parse_iso(renewed["expires_at"]), parse_iso(obj["expires_at"]))
        pinned = self.objects.manage(project_id=self.project_id, object_id=obj["id"], action="pin")
        self.assertIsNone(pinned["expires_at"])
        # Pinned stays pinned: the service only extends retention.
        still = self.objects.manage(project_id=self.project_id, object_id=obj["id"], action="renew")
        self.assertIsNone(still["expires_at"])
        deleted = self.objects.manage(project_id=self.project_id, object_id=obj["id"], action="delete")
        self.assertTrue(deleted["deleted"])
        self.assertEqual(deleted["object"]["status"], "delete_pending")
        self.assertNotIn("reclaimed", deleted)
        self.assertEqual(self.lifecycle.calls[-1], ("deleted", {"project_id": self.project_id, "object_id": obj["id"]}))
        with self.assertRaises(NotFoundError):
            self.objects.find(project_id=self.project_id, object_id=obj["id"])
        with self.assertRaises(ValidationError):
            self.objects.manage(project_id=self.project_id, object_id=obj["id"], action="thaw")

    def test_size_cap_name_rule_and_object_id_validation(self) -> None:
        capped = RemoteObjects(client=self.client, store=self.store, max_upload_bytes=8)
        with self.assertRaises(ValidationError) as ctx:
            capped.submit(project_id=self.project_id, path="big.bin", sha256="0" * 64, size_bytes=9)
        self.assertEqual(ctx.exception.details["max_bytes"], 8)
        with self.assertRaisesRegex(ValidationError, "relative path"):
            self._submit(b"x", path="/abs/file.bin")
        with self.assertRaises(ValidationError):
            self._submit(b"x", path="")
        with self.assertRaises(ValidationError):
            self.objects.get_object(project_id=self.project_id, object_id="obj_1/../obj_2")
        self.assertEqual(len([c for c in self.client.calls if c[1] == "/storage/objects"]), 0)

    def test_disabled_facade_refuses_service_work_and_tokens(self) -> None:
        disabled = RemoteObjects(client=None, store=self.store)
        self.assertFalse(disabled.enabled)
        with self.assertRaisesRegex(NotFoundError, "not enabled"):
            disabled.find(project_id=self.project_id)
        with self.assertRaises(NotFoundError):
            disabled.upload_target_via_token(token="nope")

    def test_tokens_expire_and_ignore_unknown_values(self) -> None:
        submitted = self._submit(b"t", kind="other")
        _, token = _presigned_and_token(submitted["run"])
        with self.store.transaction() as conn:
            conn.execute(
                "UPDATE storage_completion_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE token = ?",
                (token,),
            )
        with self.assertRaises(NotFoundError):
            self.objects.upload_target_via_token(token=token)
        with self.assertRaises(NotFoundError):
            self.objects.complete_via_token(token="unknown-token")
        with closing(self.store.connect()) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM storage_completion_tokens").fetchone()[0], 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
