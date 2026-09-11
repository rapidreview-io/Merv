"""Enforcement boundaries keyed on credential SHAPE, not project binding.

An account-scoped (``mk_``) key carries ``key_id`` but no ``key_project_id``.
Every deny-rule that used to test the binding would fail open for such a key,
so each rule now tests ``is_external_key``. These cases construct the principal
directly: the mint path for unbound keys arrives with the ``grant_scope``
column, and these boundaries must already hold before it does.
"""

from __future__ import annotations

import unittest
from typing import Any

from starlette.requests import Request

from merv.brain.surface.identity import (
    LOCAL_PRINCIPAL,
    Principal,
    ProjectKeyScopeError,
)
from merv.brain.surface.transport.api.gateway import (
    ProjectAuthorizer,
    ToolInvocationGateway,
)
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy

PROJECT_A = "proj-a"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

# A key bound to one project: key_id AND key_project_id.
BOUND_KEY = Principal(
    tenant_id="local", client_id="project-key:k1", user_id=USER_A,
    key_id="k1", key_project_id=PROJECT_A,
)
# An account-scoped key: key_id, but NO project binding. The shape that made
# every `if key_project_id and ...` rule fail open.
ACCOUNT_KEY = Principal(
    tenant_id="local", client_id="project-key:k2", user_id=USER_A, key_id="k2",
)
# A browser session carries no key_id at all; its reach is deliberately unchanged.
JWT = Principal(tenant_id="local", client_id="jwt:session", user_id=USER_A)


class _Projects:
    """Membership stub: every deny-rule under test short-circuits before this."""

    def is_project_member(self, *, project_id: str, user_id: str) -> bool:
        return True

    def review_project_id(self, **_kwargs: Any) -> str:
        return ""


def _request(path: str, principal: Principal, query: str = "") -> Request:
    request = Request(
        {
            "type": "http", "method": "GET", "path": path,
            "query_string": query.encode(), "headers": [],
        }
    )
    request.state.principal = principal
    return request


class OperatorDiagnosticsShapeTest(unittest.TestCase):
    """INV-11: no external key reaches operator diagnostics, bound or not."""

    def setUp(self) -> None:
        self.authorizer = ProjectAuthorizer(research=_Projects())

    def _denial(self, path: str, principal: Principal, query: str = ""):
        return self.authorizer.http_denial(_request(path, principal, query))

    def test_every_external_key_shape_is_denied_operator_diagnostics(self) -> None:
        for path in ("/api/activity", "/api/debug/state", "/api/admin/keys"):
            for label, principal in (("bound", BOUND_KEY), ("account", ACCOUNT_KEY)):
                with self.subTest(path=path, key=label):
                    denial = self._denial(path, principal)
                    self.assertIsNotNone(
                        denial, f"{label} key reached operator diagnostics at {path}"
                    )
                    self.assertEqual(denial.status_code, 403)

    def test_non_key_credentials_keep_their_existing_reach(self) -> None:
        # /api/activity is membership-scoped, hence the explicit project_id.
        denial = self._denial(
            "/api/activity", JWT, query=f"project_id={PROJECT_A}"
        )
        self.assertIsNone(denial)


class ProjectCreateShapeTest(unittest.TestCase):
    """An account-scoped key is still a machine credential: no project.create."""

    def setUp(self) -> None:
        projects = _Projects()
        self.gateway = ToolInvocationGateway(
            tools=None, research=projects, sandboxes=None,
            surface=HttpSurfacePolicy(restrict_cors=True, hosted_control=True),
            projects=ProjectAuthorizer(research=projects),
        )

    def _create(self, principal: Principal) -> None:
        self.gateway.plan(
            name="project", arguments={"action": "create", "name": "New Project"},
            activity_source="mcp", principal=principal,
        )

    def test_every_external_key_shape_is_barred_from_project_create(self) -> None:
        for label, principal in (("bound", BOUND_KEY), ("account", ACCOUNT_KEY)):
            with self.subTest(key=label):
                with self.assertRaises(ProjectKeyScopeError):
                    self._create(principal)

    def test_human_and_local_credentials_may_still_create(self) -> None:
        for label, principal in (("jwt", JWT), ("local", LOCAL_PRINCIPAL)):
            with self.subTest(credential=label):
                self._create(principal)  # no raise


class AccountKeyOverTheWireTest(unittest.TestCase):
    """A real account-scoped key against the real surface.

    Everything here was unconstructible before the scope column existed, which
    is why the fail-open it guards against could not be caught by any test.
    """

    def setUp(self) -> None:
        from tests.surface.test_project_keys import (
            SECRET, USER_A, _bearer, _postgrest, _token,
        )

        import tempfile
        from pathlib import Path

        import httpx
        from fastapi.testclient import TestClient

        from tests.support.infrastructure import FakeInfrastructureClient
        from merv.brain.surface.auth import SupabaseVerifier
        from merv.brain.surface.project_keys import ProjectKeys
        from merv.brain.surface.transport.api import create_fastapi_app
        from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
        from tests.support.brain import TestBrain

        self._bearer = _bearer
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        # Not an identity test: agent_id is merely recorded here (see test_agent_identity.py).
        self.app = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            infrastructure_client=FakeInfrastructureClient(),
            env={"MERV_AGENT_IDENTITY": "optional"},
        )
        self.keys = ProjectKeys(store=self.app.store)
        self.verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co", jwt_secret=SECRET,
            service_key="service-key", project_keys=self.keys,
        )
        self.verifier._http = httpx.Client(transport=httpx.MockTransport(_postgrest))
        self.client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
            ),
            raise_server_exceptions=False,
        )
        self.jwt = _token(USER_A)
        self.project_a = self._project("Account Project A")
        self.project_b = self._project("Account Project B")
        # Home project is A; the grant reaches B all the same.
        self.key = str(
            self.client.post(
                f"/api/projects/{self.project_a}/keys",
                json={"grant_scope": "account"},
                headers=_bearer(self.jwt),
            ).json()["secret"]
        )

    def tearDown(self) -> None:
        self.verifier._http.close()
        self.app.shutdown()
        self.tmp.cleanup()

    def _project(self, name: str) -> str:
        response = self.client.post(
            "/api/projects", json={"name": name}, headers=self._bearer(self.jwt)
        )
        self.assertEqual(response.status_code, 201, response.text)
        return str(response.json()["id"])

    def _leave_home_project(self):
        """USER_A hands project A to somebody else and walks out.

        A project always keeps a member (audit AUTH-01), so leaving means
        handing over — which is the real-world shape of this scenario anyway.
        """
        handover = self.client.post(
            f"/api/projects/{self.project_a}/members",
            json={"user_id": USER_B_ID},
            headers=self._bearer(self.jwt),
        )
        self.assertEqual(handover.status_code, 201, handover.text)
        return self.client.delete(
            f"/api/projects/{self.project_a}/members/{USER_A}",
            headers=self._bearer(self.jwt),
        )

    def test_the_principal_carries_no_project_confinement(self) -> None:
        principal = self.verifier.verify_bearer(f"Bearer {self.key}")
        self.assertIsNotNone(principal.key_id)  # still an external key
        self.assertIsNone(principal.key_project_id)  # but confined to nothing

    def test_it_reaches_every_project_its_owner_belongs_to(self) -> None:
        for label, project_id in (("home", self.project_a), ("other", self.project_b)):
            with self.subTest(project=label):
                response = self.client.get(
                    f"/api/projects/{project_id}", headers=self._bearer(self.key)
                )
                self.assertEqual(response.status_code, 200, response.text)

    def test_it_stops_at_the_edge_of_membership(self) -> None:
        # A project belonging to somebody else stays invisible: the account
        # grant widens reach to the owner's membership, never past it.
        outsider = self.app.projects.create(
            name="Someone Else", user_id=USER_B_ID
        )["id"]
        response = self.client.get(
            f"/api/projects/{outsider}", headers=self._bearer(self.key)
        )
        self.assertEqual(response.status_code, 404, response.text)

    def test_it_is_still_barred_from_operator_diagnostics(self) -> None:
        # The phase-1 fail-open, now exercised by a real credential.
        for path in ("/api/activity", "/api/admin/cleanup"):
            with self.subTest(path=path):
                response = self.client.post(path, headers=self._bearer(self.key))
                if response.status_code == 405:
                    response = self.client.get(path, headers=self._bearer(self.key))
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(
                    response.json()["error_code"], "project_scope_forbidden"
                )

    def _tool(self, name: str, arguments: dict):
        return self.client.post(
            "/mcp/call",
            json={"name": name, "arguments": arguments},
            headers=self._bearer(self.key),
        )

    def _result(self, name: str, arguments: dict) -> dict:
        response = self._tool(name, arguments)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def test_it_can_self_navigate_to_every_project_it_reaches(self) -> None:
        projects = self._result("project", {"action": "list"})["projects"]

        by_name = {project["name"]: project for project in projects}
        self.assertEqual(
            set(by_name), {"Account Project A", "Account Project B"}
        )
        # Requirement: not just ids -- enough to choose between them.
        for project in projects:
            self.assertTrue(project["id"])
            self.assertTrue(project["created_at"])
            self.assertIn("summary", project)

        # And an id taken from that list is immediately usable.
        chosen = by_name["Account Project B"]["id"]
        overview = self._result(
            "project", {"action": "overview", "project_id": chosen}
        )
        self.assertEqual(overview["project"]["id"], chosen)

    def test_current_hands_back_the_list_instead_of_a_mint_nudge(self) -> None:
        body = self._result("project", {"action": "current"})
        self.assertFalse(body["exists"])
        self.assertNotIn("Mint", body["hint"])
        self.assertEqual(len(body["projects"]), 2)

    def test_overview_without_a_project_id_fails_closed_naming_the_fix(self) -> None:
        response = self._tool("project", {"action": "overview"})
        self.assertEqual(response.status_code, 400, response.text)
        body = response.json()
        self.assertEqual(body["error_code"], "validation_error")
        self.assertIn('project(action="list")', body["detail"])

    def test_it_stays_revokable_after_the_owner_leaves_its_home_project(self) -> None:
        """An account key must never outlive the owner's ability to kill it.

        The home project is where the key is administered, not a limit on its
        reach -- so losing membership there shrinks what the key can touch but
        must not strand it live and unrevokable. Any member can remove any
        member, so this is reachable without an attacker.
        """
        listed = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=self._bearer(self.jwt)
        )
        key_id = listed.json()["keys"][0]["id"]

        removed = self._leave_home_project()
        self.assertEqual(removed.status_code, 200, removed.text)

        # The key legitimately still works against the owner's other projects.
        still_live = self.client.get(
            f"/api/projects/{self.project_b}", headers=self._bearer(self.key)
        )
        self.assertEqual(still_live.status_code, 200, still_live.text)

        # ...so the owner must still be able to see it and revoke it.
        relisted = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=self._bearer(self.jwt)
        )
        self.assertEqual(relisted.status_code, 200, relisted.text)
        self.assertIn(key_id, [key["id"] for key in relisted.json()["keys"]])

        revoked = self.client.post(
            f"/api/projects/{self.project_a}/keys/{key_id}/revoke",
            headers=self._bearer(self.jwt),
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)

        dead = self.client.get(
            f"/api/projects/{self.project_b}", headers=self._bearer(self.key)
        )
        self.assertEqual(dead.status_code, 401, dead.text)

    def test_losing_membership_still_blocks_minting_under_that_project(self) -> None:
        # The revocation exemption must not extend to creation.
        self._leave_home_project()
        minted = self.client.post(
            f"/api/projects/{self.project_a}/keys",
            json={},
            headers=self._bearer(self.jwt),
        )
        self.assertEqual(minted.status_code, 404, minted.text)

    def test_streamable_mcp_stops_it_at_a_non_member_project(self) -> None:
        # The preflight path denies before the SSE stream can open, so the
        # membership edge has to hold on /mcp as well as /mcp/call.
        outsider = self.app.projects.create(
            name="Not Mine", user_id=USER_B_ID
        )["id"]
        response = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "workflow.status_and_next",
                    "arguments": {"project_id": outsider},
                },
            },
            headers={**self._bearer(self.key), "Accept": "application/json"},
        )
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(
            response.json()["error"]["data"]["error_code"], "not_found"
        )

    def test_revoking_a_rotated_key_kills_its_successors_too(self) -> None:
        """Revoke must mean "this grant is dead", not "this row is dead".

        OAuth refresh rotates the underlying key, so an owner who lists a key
        and then revokes it can easily be naming a link that refresh has
        already superseded. If only that row died, the successor would stay
        live -- and for an account grant that successor reaches every project
        the owner has.
        """
        listed = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=self._bearer(self.jwt)
        )
        stale_id = listed.json()["keys"][0]["id"]

        # What an OAuth refresh does between the list and the revoke.
        rotated = self.keys.rotate(
            project_id=self.project_a,
            owner_user_id=USER_A,
            parent_key_id=stale_id,
            grant_scope="account",
        )
        successor = str(rotated["secret"])
        self.assertEqual(
            self.client.get(
                f"/api/projects/{self.project_b}", headers=self._bearer(successor)
            ).status_code,
            200,
        )

        revoked = self.client.post(
            f"/api/projects/{self.project_a}/keys/{stale_id}/revoke",
            headers=self._bearer(self.jwt),
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)

        # The successor the owner never saw must be dead as well.
        self.assertEqual(
            self.client.get(
                f"/api/projects/{self.project_b}", headers=self._bearer(successor)
            ).status_code,
            401,
        )

    def test_a_rotation_cannot_change_the_scope_it_inherited(self) -> None:
        # Defence in depth behind the OAuth path: even a direct rotate call
        # cannot turn an account grant into a project grant or the reverse.
        from merv.brain.kernel.utils import NotFoundError

        listed = self.client.get(
            f"/api/projects/{self.project_a}/keys", headers=self._bearer(self.jwt)
        )
        parent_id = listed.json()["keys"][0]["id"]

        with self.assertRaises(NotFoundError):
            self.keys.rotate(
                project_id=self.project_a,
                owner_user_id=USER_A,
                parent_key_id=parent_id,
                grant_scope="project",  # parent is account-scoped
            )
        rotated = self.keys.rotate(
            project_id=self.project_a,
            owner_user_id=USER_A,
            parent_key_id=parent_id,
            grant_scope="account",
        )
        self.assertEqual(rotated["key"]["grant_scope"], "account")

    def test_it_is_still_barred_from_creating_projects(self) -> None:
        response = self.client.post(
            "/mcp/call",
            json={"name": "project", "arguments": {"action": "create", "name": "X"}},
            headers=self._bearer(self.key),
        )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["error_code"], "project_scope_forbidden")


if __name__ == "__main__":
    unittest.main()
