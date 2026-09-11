"""Merv exposes authorized provider discovery and links to native administration."""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

import httpx
import jwt
from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.surface.auth import SupabaseVerifier
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy

SECRET = "sandbox-provider-tests-jwt-secret-32b"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


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


class SandboxProviderSettingsTest(unittest.TestCase):
    """Service + store semantics on a local brain (no HTTP auth in play)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        self.surface = self.brain.server.app
        self.settings = self.surface.sandbox_providers
        self.project_id = str(
            self.surface.research.create_project(name="Providers")["id"]
        )

    def tearDown(self) -> None:
        self.brain.shutdown()
        self.tmp.cleanup()

    def test_discovery_contains_no_credential_or_policy_forms(self) -> None:
        overview = self.settings.overview(project_id=self.project_id)
        self.assertEqual(overview["management_url"], "https://sandboxes.test/ui/settings")
        self.assertEqual({row["provider"] for row in overview["providers"]}, {"fake"})
        for row in overview["providers"]:
            self.assertNotIn("fields", row)
            self.assertNotIn("daily_usd_limit", row)
        for method in ("set_credentials", "set_enabled", "set_daily_limit", "disconnect", "verify"):
            self.assertFalse(hasattr(self.settings, method))



def _postgrest(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=[])


class SandboxProviderHttpBoundaryTest(unittest.TestCase):
    """Machine keys may read the overview; only humans may rewire clouds."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.brain = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
        )
        from merv.brain.surface.project_keys import ProjectKeys

        self.keys = ProjectKeys(store=self.brain.store)
        self.verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co",
            jwt_secret=SECRET,
            service_key="service-key",
            project_keys=self.keys,
        )
        self.verifier._http = httpx.Client(transport=httpx.MockTransport(_postgrest))
        self.client = TestClient(
            create_fastapi_app(
                self.brain,
                surface_policy=HttpSurfacePolicy(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
            ),
            raise_server_exceptions=False,
        )
        self.jwt_a = _token(USER_A)
        created = self.client.post(
            "/api/projects", json={"name": "Clouds"}, headers=_bearer(self.jwt_a)
        )
        assert created.status_code == 201, created.text
        self.project_id = str(created.json()["id"])
        minted = self.client.post(
            f"/api/projects/{self.project_id}/keys",
            json={},
            headers=_bearer(self.jwt_a),
        )
        assert minted.status_code == 201, minted.text
        self.mk_key = minted.json()["secret"]

    def tearDown(self) -> None:
        self.verifier._http.close()
        self.brain.shutdown()
        self.tmp.cleanup()

    def test_browser_and_machine_key_can_only_read_discovery(self) -> None:
        for secret in (self.jwt_a, self.mk_key):
            headers = _bearer(secret)
            base = f"/api/projects/{self.project_id}/sandbox-providers"
            response = self.client.get(base, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["management_url"], "https://sandboxes.test/ui/settings")
            for method, path, body in (
                ("PUT", "/aws", {"values": {"secret_access_key": "secret"}}),
                ("DELETE", "/aws", None),
                ("POST", "/aws/enabled", {"enabled": False}),
                ("POST", "/aws/verify", None),
                ("POST", "/aws/daily-limit", {"daily_usd_limit": 100}),
            ):
                denied = self.client.request(method, base + path, headers=headers, json=body)
                self.assertIn(denied.status_code, {403, 404, 405}, denied.text)

    def test_discovery_requires_project_access(self) -> None:
        response = self.client.get(
            "/api/projects/not-my-project/sandbox-providers", headers=_bearer(self.mk_key),
        )
        self.assertIn(response.status_code, {403, 404}, response.text)



if __name__ == "__main__":
    unittest.main()
