"""Supabase auth + project-membership enforcement on the HTTP surface.

Local-mode neutrality is proven by test_http_api.py (no auth argument, no
Authorization headers, all green). This file exercises the hosted shape:
create_fastapi_app(auth=SupabaseVerifier(...)) with minted HS256 JWTs and a
MockTransport-backed PostgREST for the rr_sk_ API-key path.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import jwt
from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.auth import SupabaseVerifier, UnauthorizedError
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from merv.brain.kernel.version import CLIENT_VERSION_HEADER

SECRET = "test-jwt-secret"
USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"
KNOWN_KEY = "rr_sk_known"
KNOWN_KEY_HASH = hashlib.sha256(KNOWN_KEY.encode()).hexdigest()


def _token(sub: str = USER_A, **overrides) -> str:
    payload = {
        "sub": sub,
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
        "session_id": "sess-1",
        **overrides,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _bearer(sub: str = USER_A, **overrides) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub=sub, **overrides)}"}


def _postgrest_mock(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/rpc/lookup_user_for_share"):
        email = json.loads(request.content)["target_email"].lower()
        rows = (
            [{"id": USER_B, "email": "friend@example.com", "is_anonymous": False}]
            if email == "friend@example.com"
            else []
        )
        return httpx.Response(200, json=rows)
    if request.url.path.endswith("/rpc/user_display_profiles"):
        requested = set(json.loads(request.content)["user_ids"])
        profiles = {
            USER_A: {
                "id": USER_A,
                "email": "owner@example.com",
                "full_name": "Owner",
                "avatar_url": None,
            },
            USER_B: {
                "id": USER_B,
                "email": "friend@example.com",
                "full_name": "Friend",
                "avatar_url": "https://example.com/friend.png",
            },
        }
        return httpx.Response(
            200, json=[profile for uid, profile in profiles.items() if uid in requested]
        )
    # Fake Supabase: api_keys lookups — only the known hash resolves.
    if f"eq.{KNOWN_KEY_HASH}" in str(request.url):
        return httpx.Response(200, json=[{"user_id": USER_B}])
    return httpx.Response(200, json=[])


def _verifier() -> SupabaseVerifier:
    verifier = SupabaseVerifier(
        supabase_url="https://example.supabase.co",
        jwt_secret=SECRET,
        service_key="service-key",
        anon_key="anon-key",
    )
    verifier._http = httpx.Client(transport=httpx.MockTransport(_postgrest_mock))
    return verifier


class SupabaseVerifierTest(unittest.TestCase):
    def setUp(self) -> None:
        self.verifier = _verifier()

    def test_valid_jwt_yields_user_principal(self) -> None:
        principal = self.verifier.verify_bearer(f"Bearer {_token()}")
        self.assertEqual(principal.user_id, USER_A)
        self.assertTrue(principal.client_id.startswith("jwt:"))

    def test_missing_expired_and_wrong_audience_are_rejected(self) -> None:
        for authorization in (
            None,
            "Bearer ",
            f"Bearer {_token(exp=int(time.time()) - 10)}",
            f"Bearer {jwt.encode({'sub': USER_A, 'aud': 'other', 'exp': int(time.time()) + 60}, SECRET, algorithm='HS256')}",
            f"Bearer {jwt.encode({'sub': USER_A, 'aud': 'authenticated', 'exp': int(time.time()) + 60}, 'wrong-secret', algorithm='HS256')}",
        ):
            with self.assertRaises(UnauthorizedError):
                self.verifier.verify_bearer(authorization)

    def test_anonymous_sessions_are_rejected(self) -> None:
        with self.assertRaises(UnauthorizedError):
            self.verifier.verify_bearer(f"Bearer {_token(is_anonymous=True)}")

    def test_api_key_resolves_owner_and_unknown_key_fails(self) -> None:
        principal = self.verifier.verify_bearer(f"Bearer {KNOWN_KEY}")
        self.assertEqual(principal.user_id, USER_B)
        self.assertTrue(principal.client_id.startswith("key:"))
        with self.assertRaises(UnauthorizedError):
            self.verifier.verify_bearer("Bearer rr_sk_unknown")

    def test_api_key_lookup_is_cached(self) -> None:
        self.verifier.verify_bearer(f"Bearer {KNOWN_KEY}")
        # Swap the transport for a failing one: the cache must answer.
        self.verifier._http = httpx.Client(
            transport=httpx.MockTransport(lambda _req: httpx.Response(500))
        )
        principal = self.verifier.verify_bearer(f"Bearer {KNOWN_KEY}")
        self.assertEqual(principal.user_id, USER_B)

    def test_basic_credential_carries_key_or_jwt_in_password_slot(self) -> None:
        encoded = base64.b64encode(f"rp:{KNOWN_KEY}".encode()).decode()
        principal = self.verifier.verify_basic_or_bearer(f"Basic {encoded}")
        self.assertEqual(principal.user_id, USER_B)
        encoded_jwt = base64.b64encode(f"rp:{_token()}".encode()).decode()
        principal = self.verifier.verify_basic_or_bearer(f"Basic {encoded_jwt}")
        self.assertEqual(principal.user_id, USER_A)

    def test_meta_exposes_public_values_only(self) -> None:
        meta = self.verifier.meta()
        self.assertEqual(
            meta,
            {
                "required": True,
                "supabase_url": "https://example.supabase.co",
                "supabase_anon_key": "anon-key",
            },
        )

    def test_directory_resolves_email_and_profiles(self) -> None:
        self.assertEqual(
            self.verifier.find_user_by_email("friend@example.com")["id"], USER_B
        )
        self.assertIsNone(self.verifier.find_user_by_email("missing@example.com"))
        profiles = self.verifier.user_profiles([USER_A, USER_B])
        self.assertEqual(profiles[USER_A]["display_name"], "Owner")
        self.assertEqual(profiles[USER_B]["email"], "friend@example.com")


class AuthedSurfaceTest(unittest.TestCase):
    """The hosted app shape: auth verifier + membership enforcement."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=self.repo,
            db_path=self.repo / ".research_plugin" / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )
        self.verifier = _verifier()
        self.client = TestClient(
            create_fastapi_app(
                self.app,
                allowed_origins=["https://ui.example"],
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                user_directory=self.verifier,
            ),
            raise_server_exceptions=False,
        )

    def tearDown(self) -> None:
        self.verifier._http.close()
        self.app.shutdown()
        self.tmp.cleanup()

    def _create_project(self, name: str, headers: dict[str, str]) -> str:
        response = self.client.post(
            "/api/projects", json={"name": name}, headers=headers
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def test_health_and_meta_stay_open_and_meta_advertises_auth(self) -> None:
        self.assertEqual(self.client.get("/health").status_code, 200)
        meta = self.client.get("/api/meta")
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(
            meta.json()["auth"],
            {
                "required": True,
                "supabase_url": "https://example.supabase.co",
                "supabase_anon_key": "anon-key",
            },
        )
        self.assertTrue(meta.json()["capabilities"]["project_member_directory"])

    def test_missing_or_bad_credential_is_401_with_cors(self) -> None:
        response = self.client.get(
            "/api/projects", headers={"Origin": "https://ui.example"}
        )
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["error_code"], "unauthorized")
        # CORS must decorate the middleware short-circuit (426 precedent) or
        # the browser reports an opaque "Load failed" instead of a login cue.
        self.assertEqual(
            response.headers.get("access-control-allow-origin"), "https://ui.example"
        )
        bad = self.client.get(
            "/api/projects", headers={"Authorization": "Bearer nonsense"}
        )
        self.assertEqual(bad.status_code, 401)

    def test_version_floor_beats_auth(self) -> None:
        response = self.client.get(
            "/api/projects", headers={CLIENT_VERSION_HEADER: "0.0001"}
        )
        self.assertEqual(response.status_code, 426, response.text)
        self.assertEqual(response.json()["error_code"], "client_too_old")

    def test_membership_scopes_listing_reads_and_mutations(self) -> None:
        project_id = self._create_project("Alpha", _bearer(USER_A))
        # Creator is a member: sees it in the list and can read project routes.
        listed = self.client.get("/api/projects", headers=_bearer(USER_A)).json()
        self.assertEqual([p["id"] for p in listed["projects"]], [project_id])
        home = self.client.get(
            f"/api/projects/{project_id}/home", headers=_bearer(USER_A)
        )
        self.assertEqual(home.status_code, 200, home.text)
        # Non-member sees an empty list and 404s on direct reads.
        self.assertEqual(
            self.client.get("/api/projects", headers=_bearer(USER_B)).json()[
                "projects"
            ],
            [],
        )
        denied = self.client.get(
            f"/api/projects/{project_id}/home", headers=_bearer(USER_B)
        )
        self.assertEqual(denied.status_code, 404, denied.text)
        self.assertEqual(denied.json()["error_code"], "not_found")

    def test_membership_scopes_feed_boundaries(self) -> None:
        project_id = self._create_project("Scoped", _bearer(USER_A))

        owner_feed = self.client.get(
            f"/api/projects/{project_id}/feed", headers=_bearer(USER_A)
        )
        self.assertEqual(owner_feed.status_code, 200, owner_feed.text)
        denied_feed = self.client.get(
            f"/api/projects/{project_id}/feed", headers=_bearer(USER_B)
        )
        self.assertEqual(denied_feed.status_code, 404, denied_feed.text)

    def test_path_scope_cannot_be_overridden_by_request_body(self) -> None:
        project_a = self._create_project("Alpha", _bearer(USER_A))
        project_b = self._create_project("Beta", _bearer(USER_B))

        attempts = (
            (
                "post",
                f"/api/projects/{project_a}/claims",
                {"project_id": project_b, "statement": "must not cross scope"},
                ["project_id"],
            ),
            (
                "patch",
                f"/api/projects/{project_a}",
                {"project_id": project_b, "name": "Compromised"},
                ["project_id"],
            ),
            (
                "post",
                f"/api/projects/{project_a}/reviews/request",
                {"project_id": project_b},
                ["project_id"],
            ),
            (
                "post",
                f"/api/projects/{project_a}/experiments",
                {"project_id": project_b, "name": "foreign"},
                ["project_id"],
            ),
            (
                "post",
                f"/api/projects/{project_a}/experiments/exp-a/transition",
                {
                    "project_id": project_b,
                    "experiment_id": "exp-b",
                    "transition": "submit_design",
                },
                ["project_id", "experiment_id"],
            ),
        )
        for method, path, body, fields in attempts:
            with self.subTest(path=path):
                response = self.client.request(
                    method, path, json=body, headers=_bearer(USER_A)
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["error_code"], "validation_error")
                self.assertEqual(response.json()["fields"], fields)

        project = self.client.get(f"/api/projects/{project_b}", headers=_bearer(USER_B))
        self.assertEqual(project.status_code, 200, project.text)
        self.assertEqual(project.json()["name"], "Beta")
        claims = self.client.get(
            f"/api/projects/{project_b}/claims", headers=_bearer(USER_B)
        )
        self.assertEqual(claims.status_code, 200, claims.text)
        self.assertEqual(claims.json()["claims"], [])

    def test_sharing_grants_and_revokes_access(self) -> None:
        project_id = self._create_project("Shared", _bearer(USER_A))
        added = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": USER_B},
            headers=_bearer(USER_A),
        )
        self.assertEqual(added.status_code, 201, added.text)
        self.assertEqual(
            sorted(m["user_id"] for m in added.json()["members"]), [USER_A, USER_B]
        )
        # Both members now see the same project.
        for user in (USER_A, USER_B):
            listed = self.client.get("/api/projects", headers=_bearer(user)).json()
            self.assertEqual([p["id"] for p in listed["projects"]], [project_id])
        removed = self.client.delete(
            f"/api/projects/{project_id}/members/{USER_B}", headers=_bearer(USER_A)
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(
            self.client.get(
                f"/api/projects/{project_id}", headers=_bearer(USER_B)
            ).status_code,
            404,
        )

    def test_sharing_by_email_uses_the_injected_directory(self) -> None:
        project_id = self._create_project("Shared by email", _bearer(USER_A))
        added = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"email": "FRIEND@example.com"},
            headers=_bearer(USER_A),
        )
        self.assertEqual(added.status_code, 201, added.text)
        members = {member["user_id"]: member for member in added.json()["members"]}
        self.assertEqual(members[USER_B]["display_name"], "Friend")
        self.assertEqual(members[USER_B]["email"], "friend@example.com")
        self.assertTrue(members[USER_A]["is_self"])
        self.assertFalse(members[USER_B]["is_self"])

        visible = self.client.get(
            f"/api/projects/{project_id}", headers=_bearer(USER_B)
        )
        self.assertEqual(visible.status_code, 200, visible.text)
        missing = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"email": "missing@example.com"},
            headers=_bearer(USER_A),
        )
        self.assertEqual(missing.status_code, 404, missing.text)

    def test_email_sharing_is_optional_and_raw_user_ids_still_work(self) -> None:
        client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=False, hosted_control=True
                ),
                auth=self.verifier,
            ),
            raise_server_exceptions=False,
        )
        project_id = self._create_project("Optional directory", _bearer(USER_A))
        meta = client.get("/api/meta").json()
        self.assertFalse(meta["capabilities"]["project_member_directory"])
        unavailable = client.post(
            f"/api/projects/{project_id}/members",
            json={"email": "friend@example.com"},
            headers=_bearer(USER_A),
        )
        self.assertEqual(unavailable.status_code, 503, unavailable.text)
        raw = client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": USER_B},
            headers=_bearer(USER_A),
        )
        self.assertEqual(raw.status_code, 201, raw.text)

    def test_a_machine_key_cannot_change_membership(self) -> None:
        """AUTH-01: only a human decides who belongs to a project."""
        project_id = self._create_project("Keyed", _bearer(USER_A))
        self.app.projects.add_member(project_id=project_id, user_id=USER_B)
        key = {"Authorization": f"Bearer {KNOWN_KEY}"}  # rr_sk_, resolves to USER_B

        added = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": "cccccccc-cccc-cccc-cccc-cccccccccccc"},
            headers=key,
        )
        self.assertEqual(added.status_code, 403, added.text)
        self.assertEqual(added.json()["error_code"], "human_session_required")

        removed = self.client.delete(
            f"/api/projects/{project_id}/members/{USER_A}", headers=key
        )
        self.assertEqual(removed.status_code, 403, removed.text)
        self.assertEqual(removed.json()["error_code"], "human_session_required")

        # The member list the key tried to rewrite is untouched.
        members = self.client.get(
            f"/api/projects/{project_id}/members", headers=_bearer(USER_A)
        )
        self.assertEqual(
            sorted(m["user_id"] for m in members.json()["members"]), [USER_A, USER_B]
        )

    def test_the_last_member_of_a_project_cannot_be_removed(self) -> None:
        project_id = self._create_project("Solo", _bearer(USER_A))
        refused = self.client.delete(
            f"/api/projects/{project_id}/members/{USER_A}", headers=_bearer(USER_A)
        )
        self.assertEqual(refused.status_code, 400, refused.text)
        self.assertEqual(refused.json()["error_code"], "validation_error")
        self.assertIn("only member", refused.json()["detail"])
        # Still reachable by its owner, i.e. not orphaned.
        self.assertEqual(
            self.client.get(
                f"/api/projects/{project_id}", headers=_bearer(USER_A)
            ).status_code,
            200,
        )
        # With a second member present the same removal succeeds.
        self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": USER_B},
            headers=_bearer(USER_A),
        )
        allowed = self.client.delete(
            f"/api/projects/{project_id}/members/{USER_A}", headers=_bearer(USER_A)
        )
        self.assertEqual(allowed.status_code, 200, allowed.text)
        self.assertEqual(
            [m["user_id"] for m in allowed.json()["members"]], [USER_B]
        )

    def test_non_member_cannot_manage_membership(self) -> None:
        project_id = self._create_project("Fortress", _bearer(USER_A))
        response = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": USER_B},
            headers=_bearer(USER_B),
        )
        self.assertEqual(response.status_code, 404, response.text)

    def test_the_operator_token_can_re_staff_an_orphaned_project(self) -> None:
        """The last-member rule protects new projects; old ones can be orphaned.

        A project with no members left answers 404 to everyone, and the
        membership gate runs before the route's own author check — so without a
        bypass the operator's documented recovery path is unreachable.
        """
        project_id = self._create_project("Orphan", _bearer(USER_A))
        # The last-member rule now refuses this, so the row is emptied the way a
        # project orphaned BEFORE that rule already sits in the database.
        with self.app.store.transaction() as conn:
            conn.execute(
                "DELETE FROM project_members WHERE project_id = ?", (project_id,)
            )
        self.assertEqual(self.app.projects.members(project_id=project_id)["members"], [])

        stranded = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": USER_A},
            headers=_bearer(USER_A),
        )
        self.assertEqual(stranded.status_code, 404, stranded.text)

        with patch.dict(os.environ, {"MERV_ADMIN_TOKEN": "op-secret"}):
            recovered = self.client.post(
                f"/api/projects/{project_id}/members",
                json={"user_id": USER_A},
                headers={**_bearer(USER_A), "X-Admin-Token": "op-secret"},
            )
            self.assertEqual(recovered.status_code, 201, recovered.text)
            # The bypass is scoped to membership mutation only: every other
            # route still 404s for a non-member, operator token or not.
            for path in (
                f"/api/projects/{project_id}",
                f"/api/projects/{project_id}/claims",
            ):
                with self.subTest(path=path):
                    other = self.client.get(
                        path, headers={**_bearer(USER_B), "X-Admin-Token": "op-secret"}
                    )
                    self.assertEqual(other.status_code, 404, other.text)
            # A wrong token buys nothing on the membership routes either.
            forged = self.client.delete(
                f"/api/projects/{project_id}/members/{USER_A}",
                headers={**_bearer(USER_B), "X-Admin-Token": "not-the-token"},
            )
            self.assertEqual(forged.status_code, 404, forged.text)

        self.assertEqual(
            [m["user_id"] for m in self.app.projects.members(project_id=project_id)["members"]],
            [USER_A],
        )

    def test_activity_requires_project_scope_and_membership(self) -> None:
        project_id = self._create_project("Audited", _bearer(USER_A))
        unscoped = self.client.get("/api/activity", headers=_bearer(USER_A))
        self.assertEqual(unscoped.status_code, 400, unscoped.text)
        member = self.client.get(
            f"/api/activity?project_id={project_id}", headers=_bearer(USER_A)
        )
        self.assertEqual(member.status_code, 200, member.text)
        stranger = self.client.get(
            f"/api/activity?project_id={project_id}", headers=_bearer(USER_B)
        )
        self.assertEqual(stranger.status_code, 404, stranger.text)

    def test_mcp_call_enforces_membership(self) -> None:
        # A public tool: membership (checked before dispatch) is the only gate.
        # Internal tools are separately refused over MCP for any non-local
        # caller (see test_internal_tools_blocked_over_mcp_for_non_local).
        project_id = self._create_project("Tooling", _bearer(USER_A))
        member = self.client.post(
            "/mcp/call",
            json={
                "name": "workflow.status_and_next",
                "arguments": {"project_id": project_id},
            },
            headers=_bearer(USER_A),
        )
        self.assertEqual(member.status_code, 200, member.text)
        stranger = self.client.post(
            "/mcp/call",
            json={
                "name": "workflow.status_and_next",
                "arguments": {"project_id": project_id},
            },
            headers=_bearer(USER_B),
        )
        self.assertEqual(stranger.status_code, 404, stranger.text)

    def test_internal_tools_blocked_over_mcp_for_non_local(self) -> None:
        # INV-5: an internal tool is refused over MCP for any non-local caller
        # (here a raw JWT, which carries no key_id) on both transports.
        project_id = self._create_project("Fortress internal", _bearer(USER_A))
        legacy = self.client.post(
            "/mcp/call",
            json={"name": "claim.list", "arguments": {"project_id": project_id}},
            headers=_bearer(USER_A),
        )
        self.assertEqual(legacy.status_code, 403, legacy.text)
        self.assertEqual(legacy.json()["error_code"], "tool_visibility_forbidden")

    def test_api_key_authenticates_as_its_owner(self) -> None:
        project_id = self._create_project("Keyed", _bearer(USER_B))
        listed = self.client.get(
            "/api/projects", headers={"Authorization": f"Bearer {KNOWN_KEY}"}
        ).json()
        self.assertEqual([p["id"] for p in listed["projects"]], [project_id])

    def test_mlflow_auth_route_is_absent_from_default_product(self) -> None:
        encoded = base64.b64encode(f"rp:{KNOWN_KEY}".encode()).decode()
        for headers in (
            None,
            _bearer(USER_A),
            {"Authorization": f"Basic {encoded}"},
        ):
            response = self.client.get("/internal/auth/mlflow", headers=headers)
            self.assertEqual(response.status_code, 404, response.text)

    def test_legacy_suspension_env_does_not_reintroduce_mlflow_auth_route(self) -> None:
        encoded = base64.b64encode(f"rp:{KNOWN_KEY}".encode()).decode()
        with patch.dict(os.environ, {"MERV_MLFLOW_SUSPENDED": "1"}, clear=False):
            for headers in (
                None,
                _bearer(USER_A),
                {"Authorization": f"Basic {encoded}"},
            ):
                response = self.client.get("/internal/auth/mlflow", headers=headers)
                self.assertEqual(response.status_code, 404, response.text)


if __name__ == "__main__":
    unittest.main()
