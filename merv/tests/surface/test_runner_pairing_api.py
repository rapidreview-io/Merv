"""Hosted-auth surface test for device-code runner pairing and brain-held tuning.

Exercises the full loop the standalone runner and the Settings page perform:
the runner asks for a code with only a key digest, an owner approves it from a
browser session, the runner polls the outcome with its device code, then
heartbeats with the key it generated and receives owner-saved settings.
"""

from __future__ import annotations

import hashlib
import secrets
import tempfile
import time
import unittest
from pathlib import Path

import httpx
import jwt
from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.auth import SupabaseVerifier
from merv.brain.surface.project_keys import ProjectKeys
from merv.brain.surface.runner_pairing import APPROVAL_MISS_LIMIT, RunnerPairings
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy

SECRET = "runner-pairing-tests-jwt-secret-32-bytes"
OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def _token(user_id: str) -> str:
    return jwt.encode(
        {
            "sub": user_id,
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
            "session_id": f"session-{user_id[:4]}",
        },
        SECRET,
        algorithm="HS256",
    )


def _bearer(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


class RunnerPairingApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )
        self.keys = ProjectKeys(store=self.app.store)
        self.verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co",
            jwt_secret=SECRET,
            service_key="service-key",
            project_keys=self.keys,
        )
        self.verifier._http = httpx.Client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=[]))
        )
        self.client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                runner_pairings=RunnerPairings(store=self.app.store, project_keys=self.keys),
            ),
            raise_server_exceptions=False,
        )
        self.owner_jwt = _token(OWNER)
        self.stranger_jwt = _token(STRANGER)
        created = self.client.post(
            "/api/projects", json={"name": "Paired"}, headers=_bearer(self.owner_jwt)
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.project_id = str(created.json()["id"])

    def tearDown(self) -> None:
        self.verifier._http.close()
        self.app.shutdown()
        self.tmp.cleanup()

    def _start_pairing(self) -> tuple[str, dict]:
        key = "mk_" + secrets.token_urlsafe(32)
        started = self.client.post(
            "/api/agent-runners/pairing",
            json={
                "key_digest": hashlib.sha256(key.encode()).hexdigest(),
                "runner_id": "runner-uuid",
                "machine": {"hostname": "lucia.local", "system": "Darwin", "architecture": "arm64"},
            },
        )
        self.assertEqual(started.status_code, 201, started.text)
        return key, started.json()

    def test_pair_approve_poll_heartbeat_and_settings(self) -> None:
        key, started = self._start_pairing()
        self.assertEqual(len(started["user_code"]), 8)
        self.assertEqual(started["interval"], 5)

        # Unapproved: the runner keeps polling; a stranger cannot approve.
        pending = self.client.post(
            "/api/agent-runners/pairing/token", json={"device_code": started["device_code"]}
        )
        self.assertEqual(pending.status_code, 200, pending.text)
        self.assertEqual(pending.json()["status"], "pending")
        denied = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/pairings/approve",
            json={"user_code": started["user_code"]},
            headers=_bearer(self.stranger_jwt),
        )
        self.assertIn(denied.status_code, (403, 404), denied.text)
        # The runner's not-yet-registered key cannot heartbeat.
        early = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/heartbeat",
            json={"runner_id": "runner-uuid", "machine": {}, "platforms": [], "capacity": 0},
            headers=_bearer(key),
        )
        self.assertEqual(early.status_code, 401, early.text)

        approved = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/pairings/approve",
            json={"user_code": f"{started['user_code'][:4]}-{started['user_code'][4:].lower()}"},
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["key"]["label"], "auto-run · lucia.local")
        self.assertNotIn("secret", approved.json())
        key_id = approved.json()["key"]["id"]

        outcome = self.client.post(
            "/api/agent-runners/pairing/token", json={"device_code": started["device_code"]}
        )
        self.assertEqual(outcome.status_code, 200, outcome.text)
        self.assertEqual(outcome.json()["status"], "approved")
        self.assertEqual(outcome.json()["project_id"], self.project_id)
        self.assertEqual(outcome.json()["project_name"], "Paired")
        self.assertEqual(outcome.json()["runner_id"], f"key:{key_id}/runner-uuid")
        again = self.client.post(
            "/api/agent-runners/pairing/token", json={"device_code": started["device_code"]}
        )
        self.assertEqual(again.json(), outcome.json())  # idempotent read

        # The runner-generated key now heartbeats; the brain answers with its
        # own row and (still empty) desired settings.
        beat = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/heartbeat",
            json={
                "runner_id": "runner-uuid",
                "machine": {"hostname": "lucia.local", "system": "Darwin", "architecture": "arm64"},
                "platforms": [],
                "capacity": 0,
                "inventory": {"available_commands": {"claude": True}},
                "applied_version": 0,
            },
            headers=_bearer(key),
        )
        self.assertEqual(beat.status_code, 200, beat.text)
        body = beat.json()
        self.assertEqual(body["desired_version"], 0)
        runner_ref = body["presence"]["runner_ref"]
        self.assertTrue(body["presence"]["live"])
        self.assertEqual(body["presence"]["inventory"]["available_commands"], {"claude": True})

        # Owner saves tuning by ref; a runner key or a hand-built argv is refused.
        saved = self.client.put(
            f"/api/projects/{self.project_id}/agent-runners/settings",
            json={
                "runner_ref": runner_ref,
                "settings": {
                    "platforms": {"claude": {"enabled": True, "model": "opus", "effort": "high", "parallelism": 2}},
                    "workspace": {"repository": "/Users/me/repo", "root": "/Users/me/repo-worktrees", "base_ref": "main"},
                },
            },
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["runner"]["desired_version"], 1)
        self.assertTrue(saved.json()["runner"]["settings_pending"])
        argv = self.client.put(
            f"/api/projects/{self.project_id}/agent-runners/settings",
            json={"runner_ref": runner_ref, "settings": {"platforms": {"claude": {"command": ["rm", "-rf"]}}}},
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(argv.status_code, 400, argv.text)
        by_runner = self.client.put(
            f"/api/projects/{self.project_id}/agent-runners/settings",
            json={"runner_ref": runner_ref, "settings": {}},
            headers=_bearer(key),
        )
        self.assertEqual(by_runner.status_code, 400, by_runner.text)

        # Next heartbeat carries the desired settings; reporting applied clears pending.
        pulled = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/heartbeat",
            json={"runner_id": "runner-uuid", "machine": {}, "platforms": [], "capacity": 2, "applied_version": 1},
            headers=_bearer(key),
        )
        self.assertEqual(pulled.status_code, 200, pulled.text)
        self.assertEqual(pulled.json()["desired_version"], 1)
        self.assertEqual(pulled.json()["desired_settings"]["platforms"]["claude"]["model"], "opus")
        self.assertFalse(pulled.json()["presence"]["settings_pending"])
        listed = self.client.get(
            f"/api/projects/{self.project_id}/agent-sessions", headers=_bearer(self.owner_jwt)
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual([item["runner_ref"] for item in listed.json()["runners"]], [runner_ref])
        self.assertNotIn("runner_id", listed.json()["runners"][0])

        # Test = a probe-only PUT. It folds into what is already desired (the
        # claude tuning above must survive), bumps the version, and the
        # runner's next heartbeat carries it; the runner reports the outcome
        # in its harness inventory, which the row exposes field by field.
        probed = self.client.put(
            f"/api/projects/{self.project_id}/agent-runners/settings",
            json={"runner_ref": runner_ref, "settings": {"probe": {"platform": "claude", "nonce": "t1abc"}}},
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(probed.status_code, 200, probed.text)
        self.assertEqual(probed.json()["runner"]["desired_version"], 2)
        desired = probed.json()["runner"]["desired_settings"]
        self.assertEqual(desired["probe"], {"platform": "claude", "nonce": "t1abc"})
        self.assertEqual(desired["platforms"]["claude"]["model"], "opus")
        self.assertEqual(desired["workspace"]["base_ref"], "main")
        bad_probe = self.client.put(
            f"/api/projects/{self.project_id}/agent-runners/settings",
            json={"runner_ref": runner_ref, "settings": {"probe": {"platform": "claude", "nonce": "no spaces"}}},
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(bad_probe.status_code, 400, bad_probe.text)
        reported = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/heartbeat",
            json={
                "runner_id": "runner-uuid", "machine": {}, "platforms": [], "capacity": 2, "applied_version": 2,
                "inventory": {"harness": {"platforms": {"claude": {
                    "adapter": "claude", "ok": True,
                    "auth": {"status": "present", "via": "~/.claude/.credentials.json", "secret": "never"},
                    "smoke": {"status": "ok", "at": "2026-08-15T12:00:00Z", "duration_ms": 4100, "nonce": "t1abc", "why": "requested"},
                }}}},
            },
            headers=_bearer(key),
        )
        self.assertEqual(reported.status_code, 200, reported.text)
        row = self.client.get(
            f"/api/projects/{self.project_id}/agent-sessions", headers=_bearer(self.owner_jwt)
        ).json()["runners"][0]
        claude = row["inventory"]["harness"]["platforms"]["claude"]
        self.assertEqual(claude["auth"], {"status": "present", "via": "~/.claude/.credentials.json"})
        self.assertEqual(claude["smoke"]["status"], "ok")
        self.assertEqual(claude["smoke"]["duration_ms"], 4100)
        self.assertFalse(row["settings_pending"])

    def test_pairing_routes_need_no_credential_but_approval_needs_an_owner(self) -> None:
        _, started = self._start_pairing()
        unauth = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/pairings/approve",
            json={"user_code": started["user_code"]},
        )
        self.assertEqual(unauth.status_code, 401, unauth.text)
        gone = self.client.post("/api/agent-runners/pairing/token", json={"device_code": "nope"})
        self.assertEqual(gone.status_code, 410, gone.text)
        self.assertEqual(gone.json()["error_code"], "gone")

    def test_approval_misses_are_throttled_per_owner(self) -> None:
        for _ in range(APPROVAL_MISS_LIMIT):
            miss = self.client.post(
                f"/api/projects/{self.project_id}/agent-runners/pairings/approve",
                json={"user_code": "0000AAAA"},
                headers=_bearer(self.owner_jwt),
            )
            self.assertEqual(miss.status_code, 404, miss.text)
        throttled = self.client.post(
            f"/api/projects/{self.project_id}/agent-runners/pairings/approve",
            json={"user_code": "0000AAAA"},
            headers=_bearer(self.owner_jwt),
        )
        self.assertEqual(throttled.status_code, 429, throttled.text)
        self.assertEqual(throttled.json()["error_code"], "throttled")


if __name__ == "__main__":
    unittest.main()
