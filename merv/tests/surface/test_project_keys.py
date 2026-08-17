"""Project-scoped API-key lifecycle and the Phase-A authorization boundaries.

De-profiled: keys carry no local/cloud profile. The minted record exposes no
``profile`` attribute and ``create()`` rejects a ``profile`` kwarg.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
import jwt
from fastapi.testclient import TestClient

from tests.support.brain import TestBrain
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.auth import (
    ALLOW_OPEN_CONTROL_ENV_VAR,
    SupabaseVerifier,
    UnauthorizedError,
)
from merv.brain.surface.project_keys import ProjectKeyRecord, ProjectKeys
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy

SECRET = "project-key-tests-jwt-secret-32-bytes"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
RR_KEY = "rr_sk_regression"
RR_DIGEST = hashlib.sha256(RR_KEY.encode()).hexdigest()


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


def _postgrest(request: httpx.Request) -> httpx.Response:
    if f"eq.{RR_DIGEST}" in str(request.url):
        return httpx.Response(200, json=[{"user_id": USER_B}])
    return httpx.Response(200, json=[])


class ProjectKeySurfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=self.root,
            db_path=self.root / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.keys = ProjectKeys(store=self.app.store)
        self.verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co",
            jwt_secret=SECRET,
            service_key="service-key",
            project_keys=self.keys,
        )
        self.verifier._http = httpx.Client(transport=httpx.MockTransport(_postgrest))
        self.client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
            ),
            raise_server_exceptions=False,
        )
        self.jwt_a = _token(USER_A)
        self.jwt_b = _token(USER_B)
        self.project_a = self._create_project("Key Project A", self.jwt_a)
        self.project_b = self._create_project("Key Project B", self.jwt_a)
        minted = self._mint(
            project_id=self.project_a,
            sandbox_seconds_ceiling=3600,
            blob_bytes_ceiling=8,
        )
        self.key = minted["secret"]
        self.key_id = minted["key"]["id"]

    def tearDown(self) -> None:
        self.verifier._http.close()
        self.app.shutdown()
        self.tmp.cleanup()

    def _create_project(self, name: str, credential: str) -> str:
        response = self.client.post(
            "/api/projects", json={"name": name}, headers=_bearer(credential)
        )
        self.assertEqual(response.status_code, 201, response.text)
        return str(response.json()["id"])

    def _mint(self, *, project_id: str, **fields: object) -> dict:
        response = self.client.post(
            f"/api/projects/{project_id}/keys",
            json=dict(fields),
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def _add_member(self, project_id: str, user_id: str) -> None:
        added = self.client.post(
            f"/api/projects/{project_id}/members",
            json={"user_id": user_id},
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(added.status_code, 201, added.text)

    def test_mint_verify_lineage_expiry_and_owner_only_listing(self) -> None:
        self.assertTrue(self.key.startswith("mk_"))
        principal = self.verifier.verify_bearer(f"Bearer {self.key}")
        self.assertEqual(principal.key_id, self.key_id)
        self.assertEqual(principal.key_project_id, self.project_a)
        self.assertEqual(principal.key_sandbox_seconds_ceiling, 3600)
        self.assertEqual(principal.key_blob_bytes_ceiling, 8)

        with self.app.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM project_api_keys WHERE id = ?", (self.key_id,)
            ).fetchone()
        self.assertEqual(
            row["secret_digest"], hashlib.sha256(self.key.encode()).hexdigest()
        )
        self.assertNotEqual(row["secret_digest"], self.key)
        self.assertEqual(row["tenant_id"], "local")
        self.assertIsNone(row["audience"])  # owner mints never carry an audience

        child = self._mint(project_id=self.project_a, parent_key_id=self.key_id)
        self.assertEqual(child["key"]["parent_key_id"], self.key_id)
        listed = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=_bearer(self.jwt_a)
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(
            {item["id"] for item in listed.json()["keys"]},
            {self.key_id, child["key"]["id"]},
        )
        self.assertNotIn("secret", json.dumps(listed.json()))
        self.assertNotIn("secret_digest", json.dumps(listed.json()))

        self._add_member(self.project_a, USER_B)
        other_owner = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=_bearer(self.jwt_b)
        )
        self.assertEqual(other_owner.json(), {"keys": []})
        nonowner_revoke = self.client.post(
            f"/api/projects/{self.project_a}/keys/{self.key_id}/revoke",
            headers=_bearer(self.jwt_b),
        )
        self.assertEqual(nonowner_revoke.status_code, 404, nonowner_revoke.text)

        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE project_api_keys SET expires_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00Z", child["key"]["id"]),
            )
        with self.assertRaises(UnauthorizedError):
            self.verifier.verify_bearer(f"Bearer {child['secret']}")

    def test_owner_mint_keeps_rest_authority_when_resource_uri_configured(self) -> None:
        # Hosted deploys set MERV_OAUTH_RESOURCE_URI; stamping that audience
        # on owner-minted keys 403'd them off every REST route (including the
        # agent-sessions runner). The audience column belongs to OAuth-issued
        # keys only.
        client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                oauth_resource_uri="https://brain.example/mcp",
            ),
            raise_server_exceptions=False,
        )
        minted = client.post(
            f"/api/projects/{self.project_a}/keys",
            json={},
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(minted.status_code, 201, minted.text)
        key_id = minted.json()["key"]["id"]
        with self.app.store.connect() as conn:
            row = conn.execute(
                "SELECT audience FROM project_api_keys WHERE id = ?", (key_id,)
            ).fetchone()
        self.assertIsNone(row["audience"])
        listed = client.get(
            "/api/projects", headers=_bearer(minted.json()["secret"])
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(
            {project["id"] for project in listed.json()["projects"]},
            {self.project_a},
        )

    def test_minted_record_has_no_profile_and_create_rejects_profile_kwarg(self) -> None:
        result = self.keys.create(project_id=self.project_a, owner_user_id=USER_A)
        self.assertNotIn("profile", result["key"])
        record = self.keys.verify_secret(secret=str(result["secret"]))
        self.assertIsInstance(record, ProjectKeyRecord)
        self.assertFalse(hasattr(record, "profile"))
        with self.assertRaises(TypeError):
            self.keys.create(
                project_id=self.project_a, owner_user_id=USER_A, profile="cloud"
            )
        # The REST create rejects any unknown field rather than 201-ing and
        # silently dropping it (FIX 7).
        over_http = self.client.post(
            f"/api/projects/{self.project_a}/keys",
            json={"profile": "cloud"},
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(over_http.status_code, 400, over_http.text)
        self.assertEqual(over_http.json()["fields"], ["profile"])

    def test_revocation_is_immediate_after_a_successful_lookup(self) -> None:
        self.assertEqual(
            self.verifier.verify_bearer(f"Bearer {self.key}").key_id, self.key_id
        )
        revoked = self.client.post(
            f"/api/projects/{self.project_a}/keys/{self.key_id}/revoke",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertTrue(revoked.json()["key"]["revoked_at"])
        with self.assertRaises(UnauthorizedError):
            self.verifier.verify_bearer(f"Bearer {self.key}")

    def test_key_management_requires_a_supabase_session(self) -> None:
        self._add_member(self.project_a, USER_B)
        for credential in (self.key, RR_KEY):
            requests = (
                self.client.post(
                    f"/api/projects/{self.project_a}/keys",
                    json={},
                    headers=_bearer(credential),
                ),
                self.client.get(
                    f"/api/projects/{self.project_a}/keys",
                    headers=_bearer(credential),
                ),
                self.client.post(
                    f"/api/projects/{self.project_a}/keys/{self.key_id}/revoke",
                    headers=_bearer(credential),
                ),
            )
            for response in requests:
                with self.subTest(credential=credential[:6]):
                    self.assertEqual(response.status_code, 403, response.text)
                    self.assertEqual(
                        response.json()["error_code"], "human_session_required"
                    )
        # The key still authenticates for ordinary use.
        self.assertEqual(
            self.verifier.verify_bearer(f"Bearer {self.key}").key_id, self.key_id
        )

    def test_exact_scope_precedes_membership_on_rest_and_mcp(self) -> None:
        same = self.client.get(
            f"/api/projects/{self.project_a}", headers=_bearer(self.key)
        )
        self.assertEqual(same.status_code, 200, same.text)
        cross = self.client.get(
            f"/api/projects/{self.project_b}", headers=_bearer(self.key)
        )
        self.assertEqual(cross.status_code, 403, cross.text)
        self.assertEqual(cross.json()["error_code"], "project_scope_forbidden")

        legacy = self.client.post(
            "/mcp/call",
            json={
                "name": "workflow.status_and_next",
                "arguments": {"project_id": self.project_b},
            },
            headers=_bearer(self.key),
        )
        self.assertEqual(legacy.status_code, 403, legacy.text)
        self.assertEqual(legacy.json()["error_code"], "project_scope_forbidden")

        streamable = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "workflow.status_and_next",
                    "arguments": {"project_id": self.project_b},
                },
            },
            headers={**_bearer(self.key), "Accept": "application/json"},
        )
        self.assertEqual(streamable.status_code, 403, streamable.text)
        self.assertEqual(
            streamable.json()["error"]["data"]["error_code"],
            "project_scope_forbidden",
        )

        admin = self.client.post("/api/admin/cleanup", headers=_bearer(self.key))
        self.assertEqual(admin.status_code, 403, admin.text)
        self.assertEqual(admin.json()["error_code"], "project_scope_forbidden")

    def test_removed_key_owner_cannot_read_implicit_bound_project(self) -> None:
        # A project keeps at least one member (audit AUTH-01), so the owner
        # leaves a project someone else still holds.
        self._add_member(self.project_a, USER_B)
        self.app.projects.remove_member(project_id=self.project_a, user_id=USER_A)
        self.assertEqual(
            self.verifier.verify_bearer(f"Bearer {self.key}").key_id, self.key_id
        )

        for action in ("current", "overview"):
            call = {"name": "project", "arguments": {"action": action}}
            with self.subTest(transport="legacy", action=action):
                legacy = self.client.post(
                    "/mcp/call", json=call, headers=_bearer(self.key)
                )
                self.assertEqual(legacy.status_code, 404, legacy.text)
                self.assertEqual(legacy.json()["error_code"], "not_found")

            with self.subTest(transport="streamable", action=action):
                streamable = self.client.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0",
                        "id": 20,
                        "method": "tools/call",
                        "params": call,
                    },
                    headers={**_bearer(self.key), "Accept": "application/json"},
                )
                self.assertEqual(streamable.status_code, 404, streamable.text)
                self.assertEqual(
                    streamable.json()["error"]["data"]["error_code"], "not_found"
                )

    def test_internal_tool_forbidden_over_mcp_for_key(self) -> None:
        # Same project, but claim.list is internal → refused over both transports.
        legacy = self.client.post(
            "/mcp/call",
            json={"name": "claim.list", "arguments": {"project_id": self.project_a}},
            headers=_bearer(self.key),
        )
        self.assertEqual(legacy.status_code, 403, legacy.text)
        self.assertEqual(legacy.json()["error_code"], "tool_visibility_forbidden")
        streamable = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "claim.list",
                    "arguments": {"project_id": self.project_a},
                },
            },
            headers={**_bearer(self.key), "Accept": "application/json"},
        )
        self.assertEqual(streamable.status_code, 403, streamable.text)
        self.assertEqual(
            streamable.json()["error"]["data"]["error_code"],
            "tool_visibility_forbidden",
        )

    def test_key_project_list_returns_only_the_bound_project(self) -> None:
        # The key's owner (USER_A) belongs to both project_a and project_b, but
        # one key = one project: project.list must return the bound one only.
        listed = self.client.get("/api/projects", headers=_bearer(self.key))
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(
            {project["id"] for project in listed.json()["projects"]}, {self.project_a}
        )
        # The JWT owner still sees every project they belong to.
        owner = self.client.get("/api/projects", headers=_bearer(self.jwt_a))
        self.assertEqual(
            {project["id"] for project in owner.json()["projects"]},
            {self.project_a, self.project_b},
        )

    def test_key_cannot_create_projects_over_rest_or_mcp(self) -> None:
        rest = self.client.post(
            "/api/projects", json={"name": "sneaky"}, headers=_bearer(self.key)
        )
        self.assertEqual(rest.status_code, 403, rest.text)
        self.assertEqual(rest.json()["error_code"], "project_scope_forbidden")
        streamable = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {
                    "name": "project",
                    "arguments": {"action": "create", "name": "sneaky"},
                },
            },
            headers={**_bearer(self.key), "Accept": "application/json"},
        )
        self.assertEqual(streamable.status_code, 403, streamable.text)
        self.assertEqual(
            streamable.json()["error"]["data"]["error_code"], "project_scope_forbidden"
        )

    def test_project_key_cannot_access_operator_diagnostics(self) -> None:
        for path in (
            f"/api/activity?project_id={self.project_a}",
            f"/api/debug/tool-calls?project_id={self.project_a}",
        ):
            response = self.client.get(path, headers=_bearer(self.key))
            with self.subTest(path=path):
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(
                    response.json()["error_code"], "project_scope_forbidden"
                )
        # A JWT MEMBER reads its OWN project's diagnostics — membership, not
        # operator status, grants it (the read is scoped to the caller's
        # memberships; global mutators are operator-only — see the next test).
        self.assertEqual(
            self.client.get(
                f"/api/activity?project_id={self.project_a}", headers=_bearer(self.jwt_a)
            ).status_code,
            200,
        )

    def test_diagnostics_scope_to_membership_and_mutators_are_operator_only(self) -> None:
        import os
        from unittest.mock import patch

        # A recorded tool call belonging to project_b (jwt_a is a member of B).
        recorded = self.client.post(
            "/mcp/call",
            json={
                "name": "workflow.status_and_next",
                "arguments": {"project_id": self.project_b},
            },
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(recorded.status_code, 200, recorded.text)
        stats = self.client.get(
            f"/api/debug/tool-calls?project_id={self.project_b}",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(stats.status_code, 200, stats.text)
        call_ids = [call["id"] for call in stats.json()["calls"]]
        self.assertTrue(call_ids, stats.text)
        call_id = call_ids[0]
        # The owner (member of B) can read that call...
        own = self.client.get(
            f"/api/debug/tool-calls/{call_id}?project_id={self.project_b}",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(own.status_code, 200, own.text)

        # ...but a member of project_a ONLY cannot read a project_b call, even
        # supplying ?project_id=project_a to satisfy the membership gate (INV-11:
        # the fetch is scoped to the caller's memberships, not the query param).
        self._add_member(self.project_a, USER_B)
        leaked = self.client.get(
            f"/api/debug/tool-calls/{call_id}?project_id={self.project_a}",
            headers=_bearer(self.jwt_b),
        )
        self.assertEqual(leaked.status_code, 404, leaked.text)

        # A global mutator (telemetry clear) is operator-only in hosted mode: a
        # JWT owner is 403 without MERV_ADMIN_TOKEN, 200 with the matching token.
        clear_path = f"/api/debug/tool-calls/clear?project_id={self.project_a}"
        no_token = self.client.post(clear_path, headers=_bearer(self.jwt_a))
        self.assertEqual(no_token.status_code, 403, no_token.text)
        self.assertEqual(no_token.json()["error_code"], "operator_forbidden")
        with patch.dict(os.environ, {"MERV_ADMIN_TOKEN": "op-secret"}):
            wrong = self.client.post(
                clear_path, headers={**_bearer(self.jwt_a), "X-Admin-Token": "nope"}
            )
            self.assertEqual(wrong.status_code, 403, wrong.text)
            ok = self.client.post(
                clear_path,
                headers={**_bearer(self.jwt_a), "X-Admin-Token": "op-secret"},
            )
            self.assertEqual(ok.status_code, 200, ok.text)

    def test_key_cannot_submit_foreign_project_review_session(self) -> None:
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                INSERT INTO review_requests (
                  id, project_id, target_type, target_id, role, capability_hash,
                  status, target_snapshot_id, expires_at, created_at
                ) VALUES (?, ?, 'experiment', 'exp_foreign', 'design_reviewer',
                          ?, 'started', 'foreign-snapshot', ?, ?)
                """,
                (
                    "rreq_foreign",
                    self.project_b,
                    "a" * 64,
                    "2099-01-01T00:00:00Z",
                    "2026-07-22T00:00:00Z",
                ),
            )
            conn.execute(
                """
                INSERT INTO review_sessions (
                  id, request_id, caller_session_id, independence, status, created_at
                ) VALUES (?, ?, 'foreign-reviewer', 'verified_agent_review',
                          'started', ?)
                """,
                ("rvs_foreign", "rreq_foreign", "2026-07-22T00:00:00Z"),
            )
        response = self.client.post(
            "/mcp/call",
            json={
                "name": "review.submit",
                "arguments": {
                    "review_session_id": "rvs_foreign",
                    "verdict": "pass",
                    "synopsis": (
                        "The foreign design was reviewed, and its evidence supports "
                        "the stated decision."
                    ),
                },
            },
            headers=_bearer(self.key),
        )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["error_code"], "project_scope_forbidden")

    def test_jwt_and_rr_principals_carry_no_key_context(self) -> None:
        jwt_principal = self.verifier.verify_bearer(f"Bearer {self.jwt_a}")
        rr_principal = self.verifier.verify_bearer(f"Bearer {RR_KEY}")
        for principal in (jwt_principal, rr_principal):
            self.assertIsNone(principal.key_id)
            self.assertIsNone(principal.key_project_id)
            self.assertFalse(hasattr(principal, "profile"))
        self.assertTrue(jwt_principal.client_id.startswith("jwt:"))
        self.assertEqual(rr_principal.user_id, USER_B)
        self.assertTrue(rr_principal.client_id.startswith("key:"))

    def test_admin_routes_are_operator_only(self) -> None:
        import os
        from unittest.mock import patch

        class _Cleanup:
            def run_all(self) -> "_Cleanup":
                return self

            def as_dict(self) -> dict[str, int]:
                return {"swept": 1}

        admin_client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                cleanup=_Cleanup(),
                tenant_counters=lambda *, tenant_id: {"tenant_id": tenant_id},
            ),
            raise_server_exceptions=False,
        )
        # An mk_ key is refused at the operator boundary (before the token gate).
        key_denied = admin_client.post("/api/admin/cleanup", headers=_bearer(self.key))
        self.assertEqual(key_denied.status_code, 403, key_denied.text)
        self.assertEqual(key_denied.json()["error_code"], "project_scope_forbidden")
        # A JWT owner needs MERV_ADMIN_TOKEN on every global admin route.
        for path, method in (
            ("/api/admin/cleanup", admin_client.post),
            ("/api/admin/tenants/local/counters", admin_client.get),
        ):
            denied = method(path, headers=_bearer(self.jwt_a))
            self.assertEqual(denied.status_code, 403, path)
            self.assertEqual(denied.json()["error_code"], "operator_forbidden")
            with patch.dict(os.environ, {"MERV_ADMIN_TOKEN": "op-secret"}):
                allowed = method(
                    path, headers={**_bearer(self.jwt_a), "X-Admin-Token": "op-secret"}
                )
                self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_open_hosted_mode_still_operator_gates_global_mutators(self) -> None:
        """Hosted control WITHOUT a verifier (OPEN misconfiguration) must not
        leave /api/admin/* open to the network: callers are unauthenticated,
        not trusted LOCAL, so the operator token is required unconditionally."""
        import os
        from unittest.mock import patch

        class _Cleanup:
            def run_all(self) -> "_Cleanup":
                return self

            def as_dict(self) -> dict[str, int]:
                return {"swept": 1}

        open_client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=None,
                cleanup=_Cleanup(),
                tenant_counters=lambda *, tenant_id: {"tenant_id": tenant_id},
                # An open hosted surface is only composable when named (SEC-02).
                env={ALLOW_OPEN_CONTROL_ENV_VAR: "1"},
            ),
            raise_server_exceptions=False,
        )
        for path, method in (
            ("/api/admin/cleanup", open_client.post),
            ("/api/admin/tenants/local/counters", open_client.get),
            ("/api/debug/tool-calls/clear", open_client.post),
        ):
            denied = method(path)
            self.assertEqual(denied.status_code, 403, path)
            self.assertEqual(denied.json()["error_code"], "operator_forbidden")
            with patch.dict(os.environ, {"MERV_ADMIN_TOKEN": "op-secret"}):
                allowed = method(path, headers={"X-Admin-Token": "op-secret"})
                self.assertEqual(allowed.status_code, 200, allowed.text)
        # The gate covers only global mutators; open mode otherwise serves.
        self.assertEqual(open_client.get("/api/meta").status_code, 200)

    def test_mlflow_auth_route_is_absent_for_every_credential_audience(self) -> None:
        for credential in (self.key, self.jwt_a, RR_KEY):
            response = self.client.get(
                "/internal/auth/mlflow", headers=_bearer(credential)
            )
            self.assertEqual(response.status_code, 404, response.text)

    # ---- per-user Hugging Face token (no-dataplane Phase C) ----

    def test_hf_token_set_and_clear_over_a_browser_session(self) -> None:
        set_response = self.client.put(
            "/api/user/hf-token",
            json={"token": "hf_browser_secret"},
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(set_response.status_code, 200, set_response.text)
        self.assertEqual(set_response.json()["status"], "set")
        # Stored and resolvable ONLY internally (there is no read route).
        self.assertEqual(self.app.store.user_hf_token(user_id=USER_A), "hf_browser_secret")
        clear_response = self.client.delete(
            "/api/user/hf-token", headers=_bearer(self.jwt_a)
        )
        self.assertEqual(clear_response.status_code, 200, clear_response.text)
        self.assertEqual(clear_response.json()["status"], "cleared")
        self.assertEqual(self.app.store.user_hf_token(user_id=USER_A), "")

    def test_hf_token_write_requires_a_browser_session(self) -> None:
        # A project (mk_) key and an rr_sk_ key cannot set a personal token.
        for credential in (self.key, RR_KEY):
            denied = self.client.put(
                "/api/user/hf-token", json={"token": "x"}, headers=_bearer(credential)
            )
            self.assertEqual(denied.status_code, 403, denied.text)
            self.assertEqual(denied.json()["error_code"], "human_session_required")
        # The rejected writes stored nothing.
        self.assertEqual(self.app.store.user_hf_token(user_id=USER_B), "")

    def test_hf_token_empty_body_is_rejected(self) -> None:
        response = self.client.put(
            "/api/user/hf-token", json={"token": "   "}, headers=_bearer(self.jwt_a)
        )
        self.assertEqual(response.status_code, 400, response.text)


if __name__ == "__main__":
    unittest.main()
