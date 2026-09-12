from __future__ import annotations

import base64
import hashlib
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import url2pathname

from fastapi.testclient import TestClient

from merv.brain.infrastructure import RemoteObjects
from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import ValidationError
from merv.brain.surface.surface import build_local_server
from merv.brain.surface.transport.api import create_fastapi_app
from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient

def _parse_submit_run(run: str) -> tuple[str, str]:
    """Pull the presigned PUT URL and the completion token out of the compound
    `run` command. Test data carries no single quotes, so a naive scan is safe."""
    put_cmd, complete_cmd = run.split(" && ", 1)
    quoted = re.findall(r"'([^']*)'", put_cmd)
    presigned = quoted[-1]  # curl ... -T '<path>' '<presigned>'
    token = re.search(r"/api/storage/u/([^/]+)/complete", complete_cmd).group(1)
    return presigned, token


class StorageHttpApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        store = StateStore(db_path=self.repo / ".research_plugin" / "state.sqlite")
        self.sandboxes = FakeInfrastructureClient()
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            infrastructure_client=self.sandboxes,
            store=store,
            storage_enabled=True,
        )
        self.client = TestClient(create_fastapi_app(self.app))
        self.project_id = self._request(
            "POST", "/api/projects", {"name": "Storage HTTP Project"}
        )["id"]

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def test_meta_advertises_storage(self) -> None:
        self.assertTrue(self.client.get("/api/meta").json()["capabilities"]["storage"])
        self.assertIsInstance(self.app.storage, RemoteObjects)

    def test_storage_routes_list_get_download_pin_renew_delete(self) -> None:
        obj = self._submit_and_complete(path="datasets/train.tar", kind="dataset", data=b"data")[0]

        listed = self._request("GET", f"/api/projects/{self.project_id}/storage")
        self.assertEqual(listed["count"], 1)
        entry = listed["objects"][0]
        self.assertEqual(entry["id"], obj["id"])
        # The UI's keys, supplied by the service; ledger-only fields are gone.
        for key in ("id", "name", "version", "kind", "size_bytes", "created_at",
                    "expires_at", "status", "content_sha256", "content_type"):
            self.assertIn(key, entry)
        for key in ("last_accessed_at", "producing_experiment_id", "producing_run",
                    "source_uri", "notes", "namespace", "upload_id"):
            self.assertNotIn(key, entry)
        # Query filters the old UI sends are tolerated; status filters work.
        self.assertEqual(
            self._request("GET", f"/api/projects/{self.project_id}/storage?include_expired=true&kind=dataset")["count"], 1,
        )
        self.assertEqual(
            self._request("GET", f"/api/projects/{self.project_id}/storage?status=uploading")["objects"], [],
        )

        got = self._request("GET", f"/api/projects/{self.project_id}/storage/{obj['id']}")
        self.assertEqual(got["object"]["id"], obj["id"])
        self.assertNotIn("download", got)

        downloaded = self._request(
            "POST", f"/api/projects/{self.project_id}/storage/{obj['id']}/download"
        )
        self.assertTrue(downloaded["download"]["url"].startswith("file://"))
        self.assertGreaterEqual(downloaded["object"]["expires_at"], obj["expires_at"])

        renewed = self._request("POST", f"/api/projects/{self.project_id}/storage/{obj['id']}/renew")
        self.assertIsNotNone(renewed["object"]["expires_at"])
        pinned = self._request("POST", f"/api/projects/{self.project_id}/storage/{obj['id']}/pin")
        self.assertIsNone(pinned["object"]["expires_at"])

        self.assertIsNone(
            self._request("GET", f"/api/projects/{self.project_id}/storage/{obj['id']}")["object"]["expires_at"]
        )

        deleted = self._request("DELETE", f"/api/projects/{self.project_id}/storage/{obj['id']}")
        self.assertTrue(deleted["deleted"])
        self.assertEqual(deleted["object"]["status"], "delete_pending")
        self.assertEqual(
            self._request("GET", f"/api/projects/{self.project_id}/storage")["objects"],
            [],
        )
        missing = self.client.get(f"/api/projects/{self.project_id}/storage/obj_none")
        self.assertEqual(missing.status_code, 404, missing.text)

    def test_storage_submit_returns_token_curl_command_and_round_trips(self) -> None:
        data = b"tool bytes"
        sha = hashlib.sha256(data).hexdigest()
        submitted = self.app.call_tool(
            "storage.submit",
            {
                "project_id": self.project_id,
                "path": "experiments/storage_demo/run.log",
                "kind": "other",
                "sha256": sha,
                "size_bytes": len(data),
            },
        )
        # The service created the object; the compound command is a signed
        # PUT followed by the completion POST.
        self.assertFalse(submitted["uploaded"])
        self.assertEqual(
            submitted["object"]["name"], "experiments/storage_demo/run.log"
        )
        self.assertEqual(submitted["object"]["status"], "uploading")
        self.assertEqual(submitted["upload_id"], submitted["object"]["id"])
        run = submitted["run"]
        self.assertIn("-H 'Content-Type: ", run)
        self.assertIn("-T 'experiments/storage_demo/run.log'", run)
        self.assertRegex(
            run,
            r"^curl -sS --fail-with-body -X PUT .* && curl -sS --fail-with-body -X POST "
            r"'http://[^']+/api/storage/u/[^/']+/complete'$",
        )
        create = next(call for call in self.sandboxes.calls if call[:2] == ("POST", "/storage/objects"))
        self.assertEqual(create[3]["sha256"], sha)
        self.assertNotIn("kind", create[3])

        # Drive the command: the agent's PUT lands the bytes at the presigned
        # target, then the auth-exempt completion POST asks the service to verify.
        presigned, token = _parse_submit_run(run)
        Path(url2pathname(urlsplit(presigned).path)).write_bytes(data)
        completed = self.client.post(f"/api/storage/u/{token}/complete")
        self.assertEqual(completed.status_code, 200, completed.text)
        obj = completed.json()["object"]
        self.assertEqual(obj["status"], "available")
        self.assertEqual(obj["content_sha256"], sha)
        self.assertEqual(obj["version"], 1)

        # Single-use: replaying the same token 404s (row deleted on success).
        replay = self.client.post(f"/api/storage/u/{token}/complete")
        self.assertEqual(replay.status_code, 404, replay.text)

        # Submitting the same name again gets the next service version.
        again = self.app.call_tool(
            "storage.submit",
            {"project_id": self.project_id, "path": "experiments/storage_demo/run.log",
             "kind": "other", "sha256": sha, "size_bytes": len(data)},
        )
        self.assertEqual(again["object"]["version"], 2)
        self.assertNotEqual(again["object"]["id"], obj["id"])

    def test_storage_submit_rejects_control_chars_in_content_type(self) -> None:
        with self.assertRaises(ValidationError):
            self.app.call_tool(
                "storage.submit",
                {
                    "project_id": self.project_id,
                    "path": "f.bin",
                    "kind": "other",
                    "sha256": hashlib.sha256(b"x").hexdigest(),
                    "size_bytes": 1,
                    "content_type": "text/plain\r\nX-Injected: 1",
                },
            )

    def test_storage_submit_multipart_and_size_cap(self) -> None:
        # Files above the service part size get the token-backed client command.
        self.sandboxes.storage_part_bytes = 4
        data = b"0123456789"
        submitted = self.app.storage.submit(
            project_id=self.project_id,
            path="big.bin",
            kind="other",
            sha256=hashlib.sha256(data).hexdigest(),
            size_bytes=len(data),
            base_url="https://merv.test",
        )
        self.assertIn("merv-client storage-upload", submitted["run"])
        token = re.search(r"/api/storage/u/([^/']+)", submitted["run"]).group(1)
        target = self.client.get(f"/api/storage/u/{token}").json()["upload"]
        self.assertEqual(len(target["parts"]), 3)
        self.assertEqual(base64.b64decode(target["checksum_sha256"]).hex(), hashlib.sha256(data).hexdigest())
        self.sandboxes.upload_bytes(submitted["object"]["id"], data)
        completed = self.client.post(
            f"/api/storage/u/{token}/complete",
            json={"parts": [{"part_number": 2, "etag": '"two"'}, {"part_number": 1, "etag": '"one"'}]},
        )
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertEqual(completed.json()["object"]["status"], "available")

        # The server-wide ceiling rejects before the service is asked.
        capped = RemoteObjects(client=self.sandboxes, store=self.app.store, max_upload_bytes=1024)
        calls = len(self.sandboxes.calls)
        with self.assertRaises(ValidationError) as ctx:
            capped.submit(
                project_id=self.project_id, path="over.bin", kind="other",
                sha256="0" * 64, size_bytes=2048,
            )
        self.assertIn("maximum", str(ctx.exception).lower())
        self.assertEqual(len(self.sandboxes.calls), calls)

    def test_storage_completion_token_first_404_before_object_work(self) -> None:
        target = self.client.get("/api/storage/u/nonexistent-token")
        self.assertEqual(target.status_code, 404, target.text)
        resp = self.client.post("/api/storage/u/nonexistent-token/complete")
        self.assertEqual(resp.status_code, 404, resp.text)
        self.assertFalse(any(path.startswith("/storage/objects/") for _, path, _, _ in self.sandboxes.calls))

    def test_storage_fetch_returns_download_and_verify_command(self) -> None:
        data = b"fetch me"
        obj = self._submit_and_complete(path="datasets/f.bin", kind="dataset", data=data)[0]
        sha = hashlib.sha256(data).hexdigest()
        fetched = self.app.call_tool(
            "storage.fetch",
            {"project_id": self.project_id, "object_id": obj["id"], "path": "local/copy.bin"},
        )
        self.assertEqual(fetched["object"]["id"], obj["id"])
        run = fetched["run"]
        self.assertRegex(run, r"^curl -sSf -o 'local/copy\.bin' '[^']+' && ")
        self.assertIn(f"printf '%s  %s\\n' {sha} 'local/copy.bin' | shasum -a 256 -c", run)

    def test_experiment_state_surfaces_objects_and_hides_deleted_rows(self) -> None:
        exp = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": "storage-visible",
             "intent": "Retain heavy artifacts in storage."},
        )
        submitted_calls = len(self.sandboxes.calls)
        obj, _submitted = self._submit_and_complete(
            path="experiments/storage-visible/model.bin",
            kind="model",
            data=b"model bytes",
            producing_experiment_id=exp["id"],
            producing_run="run-001",
            notes="checkpoint retained for reviewer inspection",
        )
        service_calls = len(self.sandboxes.calls)
        state = self.app.call_tool(
            "experiment.get_state",
            {"project_id": self.project_id, "experiment_id": exp["id"]},
        )
        objects = state["storage_objects"]
        self.assertEqual(len(objects), 1)
        self.assertEqual(objects[0]["id"], obj["id"])
        self.assertEqual(objects[0]["kind"], "model")
        self.assertEqual(objects[0]["producing_run"], "run-001")
        self.assertEqual(objects[0]["notes"], "checkpoint retained for reviewer inspection")
        self.assertEqual(objects[0]["content_sha256"], hashlib.sha256(b"model bytes").hexdigest())
        self.assertEqual(objects[0]["size_bytes"], len(b"model bytes"))
        for key in ("namespace", "status", "expires_at", "producing_experiment_id"):
            self.assertNotIn(key, objects[0])
        # Experiment reads come from Research's snapshot, never the service.
        self.assertEqual(len(self.sandboxes.calls), service_calls)
        self.assertGreater(service_calls, submitted_calls)

        # An experiment of another project cannot claim the object.
        with self.assertRaises(Exception):
            self.app.call_tool(
                "storage.submit",
                {"project_id": self.project_id, "path": "x.bin", "kind": "model",
                 "sha256": "1" * 64, "size_bytes": 1, "producing_experiment_id": "exp_missing"},
            )

        self.app.call_tool(
            "storage.object",
            {"project_id": self.project_id, "object_id": obj["id"], "action": "delete"},
        )
        state = self.app.call_tool(
            "experiment.get_state",
            {"project_id": self.project_id, "experiment_id": exp["id"]},
        )
        self.assertEqual(state["storage_objects"], [])

    def test_candidate_pointer_pins_the_object_and_finds_its_experiment(self) -> None:
        exp = self.app.call_tool(
            "experiment.create",
            {"project_id": self.project_id, "name": "candidate-source", "intent": "Produce a model."},
        )
        obj = self._submit_and_complete(
            path="models/best.bin", kind="model", data=b"best", producing_experiment_id=exp["id"],
        )[0]
        sha, source = self.app.application._candidate_pointer(
            project_id=self.project_id, kind="storage_object", ref=obj["id"]
        )
        self.assertEqual((sha, source), (hashlib.sha256(b"best").hexdigest(), exp["id"]))
        self.assertIsNone(
            self._request("GET", f"/api/projects/{self.project_id}/storage/{obj['id']}")["object"]["expires_at"]
        )

    def test_storage_find_lists_or_resolves(self) -> None:
        a = self._submit_and_complete(path="datasets/a.tar", kind="dataset", data=b"aa")[0]
        b = self._submit_and_complete(path="models/b.bin", kind="model", data=b"bbbb")[0]

        listed = self.app.call_tool("storage.find", {"project_id": self.project_id})
        self.assertEqual(listed["count"], 2)
        self.assertEqual({o["id"] for o in listed["objects"]}, {a["id"], b["id"]})

        resolved = self.app.call_tool(
            "storage.find", {"project_id": self.project_id, "object_id": a["id"]}
        )
        self.assertEqual(resolved["object"]["id"], a["id"])
        self.assertIn("url", resolved["download"])

        by_name = self.app.call_tool(
            "storage.find",
            {"project_id": self.project_id, "name": "models/b.bin", "include_download": False},
        )
        self.assertEqual(by_name["object"]["id"], b["id"])
        self.assertNotIn("download", by_name)

        # The research kind filter is gone with the ledger.
        with self.assertRaises(ValidationError):
            self.app.call_tool("storage.find", {"project_id": self.project_id, "kind": "model"})

    def test_storage_object_dispatches_each_lifecycle_action(self) -> None:
        obj = self._submit_and_complete(path="datasets/train.tar", kind="dataset", data=b"data")[0]
        oid = obj["id"]

        renewed = self.app.call_tool(
            "storage.object", {"project_id": self.project_id, "object_id": oid, "action": "renew"},
        )
        self.assertIsNotNone(renewed["expires_at"])
        pinned = self.app.call_tool(
            "storage.object", {"project_id": self.project_id, "object_id": oid, "action": "pin"},
        )
        self.assertIsNone(pinned["expires_at"])
        deleted = self.app.call_tool(
            "storage.object", {"project_id": self.project_id, "object_id": oid, "action": "delete"},
        )
        self.assertTrue(deleted["deleted"])
        self.assertNotIn("reclaimed", deleted)

    def test_put_object_registers_an_upload_that_complete_upload_finalizes(self) -> None:
        data = b"registered object bytes"
        registered = self.app.storage.put_object(
            project_id=self.project_id, name="registered-object", kind="other",
            sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data),
            content_type="text/plain", notes="registered directly, without a submit token",
        )
        target = urlsplit(registered["upload"]["url"])
        self.assertEqual(target.scheme, "file")
        Path(url2pathname(target.path)).write_bytes(data)
        completed = self.app.storage.complete_upload(
            project_id=self.project_id, upload_id=registered["upload"]["upload_id"],
        )
        self.assertEqual((completed["id"], completed["status"]), (registered["object"]["id"], "available"))

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        response = self.client.request(method, path, json=body)
        self.assertLess(response.status_code, 400, response.text)
        return response.json()

    def _submit_and_complete(
        self, *, path: str, kind: str, data: bytes, **extra: object
    ) -> tuple[dict, dict]:
        """Full token-curl round-trip: storage.submit -> presigned PUT (to the
        fake target) -> auth-exempt completion POST. Returns (object, submit)."""
        sha = hashlib.sha256(data).hexdigest()
        submitted = self.app.call_tool(
            "storage.submit",
            {
                "project_id": self.project_id,
                "path": path,
                "kind": kind,
                "sha256": sha,
                "size_bytes": len(data),
                **extra,
            },
        )
        presigned, token = _parse_submit_run(submitted["run"])
        Path(url2pathname(urlsplit(presigned).path)).write_bytes(data)
        completed = self.client.post(f"/api/storage/u/{token}/complete")
        self.assertEqual(completed.status_code, 200, completed.text)
        return completed.json()["object"], submitted


class StorageCompositionTest(unittest.TestCase):
    def test_local_mode_disables_storage_when_unconfigured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict(
                os.environ,
                {
                    "RESEARCH_PLUGIN_EXECUTION_BACKEND": "lambda_labs",
                    "MERV_SANDBOXES_URL": "",
                },
            ):
                server = build_local_server(state_dir=root)
                app = server.app
            try:
                self.assertIsNone(app.storage)
                self.assertFalse(
                    {tool["name"] for tool in app.tools.list_tools()}
                    & {"storage.put_object", "storage.find", "storage.object"}
                )
                with TestClient(server.fastapi_app) as client:
                    self.assertFalse(
                        client.get("/api/meta").json()["capabilities"]["storage"]
                    )
            finally:
                server.shutdown()

    def test_storage_needs_the_service_connection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = build_local_server(state_dir=root, infrastructure_client=FakeInfrastructureClient())
            try:
                self.assertIsNotNone(server.app.storage)
                self.assertIn("storage.submit", {tool["name"] for tool in server.app.tools.list_tools()})
            finally:
                server.shutdown()


if __name__ == "__main__":
    unittest.main()
