"""Provider connections behind Sandboxes → Configure.

Covers the write-only credential contract (secrets never echo, non-secret
values re-render), partial-update semantics at the store, the request-time
disable gate wired into SandboxEngine, and the human-session boundary on the
HTTP writes.
"""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
import jwt
from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.infrastructure import FakeInfrastructureClient
from merv.brain.kernel.utils import NotFoundError, ValidationError
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

    def test_catalog_and_required_fields_come_from_the_service(self) -> None:
        overview = self.settings.overview(project_id=self.project_id)
        self.assertEqual({row["provider"] for row in overview["providers"]}, {"fake", "aws"})
        aws = next(row for row in overview["providers"] if row["provider"] == "aws")
        self.assertEqual({field["key"] for field in aws["fields"]}, {"access_key_id", "secret_access_key"})
        self.assertFalse(aws["connected"])
        self.assertTrue(aws["credentials_replace"])

    def test_credentials_replace_remotely_and_never_persist_or_echo(self) -> None:
        entry = self.settings.set_credentials(project_id=self.project_id, provider="aws",
            values={"access_key_id": "AKIAEXAMPLE", "secret_access_key": "private-key"})
        self.assertTrue(entry["connected"])
        self.assertNotIn("private-key", json.dumps(entry))
        self.assertTrue(all(field["value"] == "" for field in entry["fields"]))
        self.assertEqual(self.brain.store.sandbox_provider_credentials(project_id=self.project_id, provider="aws"), "{}")
        with self.assertRaises(ValidationError):
            self.settings.set_credentials(project_id=self.project_id, provider="aws", values={"access_key_id": "partial"})

    def test_unknown_provider_and_field_are_rejected(self) -> None:
        with self.assertRaises(NotFoundError):
            self.settings.set_credentials(project_id=self.project_id, provider="missing", values={"X": "y"})
        with self.assertRaises(ValidationError):
            self.settings.set_credentials(project_id=self.project_id, provider="aws", values={"unknown": "x"})

    def test_connections_are_project_scoped(self) -> None:
        other = self.surface.research.create_project(name="Other")["id"]
        self.settings.set_credentials(project_id=self.project_id, provider="aws",
            values={"access_key_id": "AKIAEXAMPLE", "secret_access_key": "private-key"})
        aws = next(row for row in self.settings.overview(project_id=other)["providers"] if row["provider"] == "aws")
        self.assertFalse(aws["connected"])

    def test_verify_and_disconnect_use_the_service(self) -> None:
        self.settings.set_credentials(project_id=self.project_id, provider="aws",
            values={"access_key_id": "AKIAEXAMPLE", "secret_access_key": "private-key"})
        self.assertTrue(self.settings.verify(project_id=self.project_id, provider="aws")["ok"])
        overview = self.settings.disconnect(project_id=self.project_id, provider="aws")
        self.assertFalse(next(row for row in overview["providers"] if row["provider"] == "aws")["connected"])


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
                surface_policy=HttpSurfacePolicy.for_surface(
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

    def test_browser_session_saves_and_disconnects(self) -> None:
        saved = self.client.put(
            f"/api/projects/{self.project_id}/sandbox-providers/aws",
            json={"values": {"access_key_id": "AKIA1", "secret_access_key": "secret"}},
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["connected"])
        toggled = self.client.delete(
            f"/api/projects/{self.project_id}/sandbox-providers/aws",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(toggled.status_code, 200, toggled.text)
        overview = self.client.get(
            f"/api/projects/{self.project_id}/sandbox-providers",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(overview.status_code, 200, overview.text)
        aws = next(
            e for e in overview.json()["providers"] if e["provider"] == "aws"
        )
        self.assertFalse(aws["enabled"])

    def test_enabled_requires_a_real_boolean(self) -> None:
        # bool("false") is True — a string must not flip the switch.
        for bad in ("false", "true", 1, None):
            rejected = self.client.post(
                f"/api/projects/{self.project_id}/sandbox-providers/aws/enabled",
                json={"enabled": bad},
                headers=_bearer(self.jwt_a),
            )
            self.assertEqual(rejected.status_code, 400, rejected.text)

    def test_machine_key_reads_but_cannot_write(self) -> None:
        overview = self.client.get(
            f"/api/projects/{self.project_id}/sandbox-providers",
            headers=_bearer(self.mk_key),
        )
        self.assertEqual(overview.status_code, 200, overview.text)
        denied_save = self.client.put(
            f"/api/projects/{self.project_id}/sandbox-providers/aws",
            json={"values": {"access_key_id": "AKIA1", "secret_access_key": "secret"}},
            headers=_bearer(self.mk_key),
        )
        self.assertEqual(denied_save.status_code, 403, denied_save.text)
        denied_toggle = self.client.post(
            f"/api/projects/{self.project_id}/sandbox-providers/aws/enabled",
            json={"enabled": False},
            headers=_bearer(self.mk_key),
        )
        self.assertEqual(denied_toggle.status_code, 403, denied_toggle.text)


if __name__ == "__main__":
    unittest.main()
