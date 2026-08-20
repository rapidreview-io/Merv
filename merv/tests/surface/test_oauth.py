"""OAuth DCR, PKCE consent, token rotation, and MCP integration.

De-profiled port: OAuth access bearers are project (mk_) keys with an immutable
audience binding and NO local/cloud profile. The idempotency-store replay test
from the source branch is intentionally absent — the surface idempotency store
was cut by owner ruling and no tool carries an idempotency key.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import jwt
from starlette.requests import Request
from fastapi.testclient import TestClient

from merv.brain.kernel.state.store import StateStore
from merv.brain.kernel.utils import format_iso, parse_iso
from tests.support.sandbox_backend import FakeSandboxBackend
from merv.brain.surface.auth import SupabaseVerifier
from merv.brain.surface.oauth import (
    DEVICE_GRANT,
    MAX_CLIENTS_ENV_VAR,
    OAuthError,
    OAuthService,
)
from merv.brain.surface.oauth_store import SqlOAuthRepository
from merv.brain.surface.project_keys import ProjectKeys
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from tests.support.brain import TestBrain

SECRET = "oauth-tests-jwt-secret-at-least-32-bytes"
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ISSUER = "https://merv.example"
RESOURCE = f"{ISSUER}/mcp"
REDIRECT_URI = "https://client.example/oauth/callback"
VERIFIER = "a" * 43


def _jwt(user_id: str) -> str:
    return jwt.encode(
        {
            "sub": user_id,
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
            "session_id": f"oauth-{user_id[:4]}",
        },
        SECRET,
        algorithm="HS256",
    )


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _challenge(verifier: str = VERIFIER) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class OAuthSurfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.app = TestBrain(
            repo_root=root,
            db_path=root / "state.sqlite",
            execution_backend=FakeSandboxBackend(),
        )
        self.keys = ProjectKeys(store=self.app.store)
        self.oauth = OAuthService(
            repository=SqlOAuthRepository(store=self.app.store),
            project_keys=self.keys,
            is_project_member=self.app.projects.is_member,
        )
        self.verifier = SupabaseVerifier(
            supabase_url="https://example.supabase.co",
            jwt_secret=SECRET,
            project_keys=self.keys,
        )
        self.client = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                oauth_service=self.oauth,
                oauth_resource_uri=RESOURCE,
                allowed_origins=["https://ui.example"],
                ui_base_url="https://ui.example/merv",
            ),
            base_url=ISSUER,
            raise_server_exceptions=False,
        )
        self.jwt_a = _jwt(USER_A)
        self.jwt_b = _jwt(USER_B)
        self.project_a = self._create_project("OAuth Project A", self.jwt_a)

    def tearDown(self) -> None:
        self.app.shutdown()
        self.tmp.cleanup()

    def _create_project(self, name: str, token: str) -> str:
        response = self.client.post(
            "/api/projects", json={"name": name}, headers=_bearer(token)
        )
        self.assertEqual(response.status_code, 201, response.text)
        return str(response.json()["id"])

    def _register(
        self,
        *,
        redirect_uris: list[str] | None = None,
        grants: list[str] | None = None,
        **metadata,
    ) -> dict:
        response = self.client.post(
            "/oauth/register",
            json={
                "client_name": "Replit Agent",
                "redirect_uris": redirect_uris or [REDIRECT_URI],
                "token_endpoint_auth_method": "none",
                "grant_types": grants or ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                **metadata,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def _authorization_params(
        self,
        client_id: str,
        *,
        redirect_uri: str = REDIRECT_URI,
        verifier: str = VERIFIER,
        state: str = "client-state",
    ) -> dict[str, str]:
        return {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
            "resource": RESOURCE,
        }

    def _authorize(
        self,
        client_id: str,
        *,
        project_id: str | None = None,
        token: str | None = None,
        params: dict[str, str] | None = None,
        grant_scope: str | None = None,
    ) -> tuple[str, dict[str, list[str]]]:
        params = params or self._authorization_params(client_id)
        response = self.client.post(
            "/oauth/authorize",
            json={
                **params,
                "decision": "approve",
                "project_id": project_id or self.project_a,
                **({"grant_scope": grant_scope} if grant_scope else {}),
            },
            headers=_bearer(token or self.jwt_a),
        )
        self.assertEqual(response.status_code, 200, response.text)
        redirect = response.json()["redirect_to"]
        return redirect, parse_qs(urlsplit(redirect).query)

    def _exchange(
        self,
        *,
        client_id: str,
        code: str,
        verifier: str = VERIFIER,
        redirect_uri: str = REDIRECT_URI,
    ):
        return self.client.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
                "resource": RESOURCE,
            },
        )

    def _mcp_overview(self, access_token: str, project_id: str) -> int:
        return self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "project",
                    "arguments": {"action": "overview", "project_id": project_id},
                },
            },
            headers={**_bearer(access_token), "Accept": "application/json"},
        ).status_code

    def _mint_oauth_tokens(self) -> tuple[dict, dict]:
        registration = self._register()
        _redirect, query = self._authorize(registration["client_id"])
        response = self._exchange(
            client_id=registration["client_id"], code=query["code"][0]
        )
        self.assertEqual(response.status_code, 200, response.text)
        return registration, response.json()

    def test_discovery_metadata_and_mcp_challenge_are_exact(self) -> None:
        metadata = self.client.get("/.well-known/oauth-authorization-server")
        self.assertEqual(metadata.status_code, 200, metadata.text)
        self.assertEqual(
            metadata.json(),
            {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/oauth/authorize",
                "token_endpoint": f"{ISSUER}/oauth/token",
                "registration_endpoint": f"{ISSUER}/oauth/register",
                "device_authorization_endpoint": (
                    f"{ISSUER}/oauth/device_authorization"
                ),
                "response_types_supported": ["code"],
                "response_modes_supported": ["query"],
                "grant_types_supported": [
                    "authorization_code",
                    "refresh_token",
                    DEVICE_GRANT,
                ],
                "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"],
                "authorization_response_iss_parameter_supported": True,
                "protected_resources": [RESOURCE],
            },
        )
        protected = self.client.get("/.well-known/oauth-protected-resource/mcp")
        self.assertEqual(
            protected.json(),
            {
                "resource": RESOURCE,
                "authorization_servers": [ISSUER],
                "bearer_methods_supported": ["header"],
            },
        )
        unauthorized = self.client.post("/mcp", json={})
        self.assertEqual(unauthorized.status_code, 401, unauthorized.text)
        self.assertEqual(
            unauthorized.headers["www-authenticate"],
            f'Bearer resource_metadata="{ISSUER}/.well-known/oauth-protected-resource/mcp"',
        )

    def test_dcr_accepts_only_public_strict_redirect_clients(self) -> None:
        registration = self._register(
            redirect_uris=[
                REDIRECT_URI,
                "http://localhost:43110/callback",
                "http://127.0.0.1:19876/mcp/oauth/callback",
                "http://[::1]:43110/callback",
            ]
        )
        self.assertTrue(registration["client_id"].startswith("oauthc_"))
        self.assertNotIn("client_secret", registration)
        self.assertEqual(registration["token_endpoint_auth_method"], "none")
        with self.app.store.connect() as conn:
            row = conn.execute(
                "SELECT * FROM oauth_clients WHERE client_id = ?",
                (registration["client_id"],),
            ).fetchone()
        self.assertEqual(row["client_name"], "Replit Agent")

        rejected = (
            {"redirect_uris": ["http://attacker.example/callback"]},
            {"redirect_uris": ["https://client.example/cb#fragment"]},
            {"redirect_uris": ["https://client.example\\@attacker.example/cb"]},
            {"redirect_uris": ["http://192.168.1.10/callback"]},
            {"token_endpoint_auth_method": "client_secret_basic"},
            {"grant_types": ["implicit"]},
            {"response_types": ["token"]},
            {"scope": "mcp"},
        )
        for override in rejected:
            payload = {
                "client_name": "Rejected client",
                "redirect_uris": [REDIRECT_URI],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
                "response_types": ["code"],
                **override,
            }
            with self.subTest(override=override):
                response = self.client.post("/oauth/register", json=payload)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn(
                    response.json()["error"],
                    {"invalid_redirect_uri", "invalid_client_metadata"},
                )
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_identical_re_registration_returns_the_same_client(self) -> None:
        """AUTH-03: public DCR must not grow a row per client restart."""
        first = self._register()
        again = self._register()
        self.assertEqual(again["client_id"], first["client_id"])
        self.assertEqual(again["client_id_issued_at"], first["client_id_issued_at"])
        # Different metadata is still a different client.
        other = self._register(redirect_uris=["https://other.example/cb"])
        self.assertNotEqual(other["client_id"], first["client_id"])
        with self.app.store.connect() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM oauth_clients").fetchone()
        self.assertEqual(int(count["n"]), 2)

    def test_concurrent_identical_registrations_resolve_to_one_client(self) -> None:
        """AUTH-03: lookup and insert share one transaction, so a race cannot fork.

        Two clients registering the same metadata at the same moment could both
        miss a separate existence check and both insert. Under the store's
        global writer serialization a single get-or-create transaction cannot.
        """
        repository = SqlOAuthRepository(store=self.app.store)
        service = OAuthService(
            repository=repository,
            project_keys=self.keys,
            is_project_member=self.app.projects.is_member,
        )
        metadata = {
            "client_name": "Racing Agent",
            "redirect_uris": [REDIRECT_URI],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        }
        workers = 8
        start = threading.Barrier(workers)
        lock = threading.Lock()
        minted: list[str] = []
        failures: list[Exception] = []

        def register() -> None:
            start.wait(timeout=10)
            try:
                client_id = service.register_client(dict(metadata))["client_id"]
            except Exception as exc:  # noqa: BLE001 -- reported, not swallowed
                with lock:
                    failures.append(exc)
                return
            with lock:
                minted.append(client_id)

        threads = [threading.Thread(target=register) for _ in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual([str(exc) for exc in failures], [])
        self.assertEqual(len(minted), workers)
        self.assertEqual(len(set(minted)), 1, "the race forked the client id")
        with self.app.store.connect() as conn:
            rows = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_clients WHERE client_name = ?",
                ("Racing Agent",),
            ).fetchone()
        self.assertEqual(int(rows["n"]), 1)

    def test_array_order_does_not_fork_the_registration(self) -> None:
        """AUTH-03: the arrays are sets to both sides, so order cannot dedupe-miss."""
        uris = ["https://client.example/a", "https://client.example/b"]
        first = self._register(
            redirect_uris=uris, grants=["authorization_code", "refresh_token"]
        )
        permuted = self._register(
            redirect_uris=list(reversed(uris)),
            grants=["refresh_token", "authorization_code"],
        )
        self.assertEqual(permuted["client_id"], first["client_id"])
        # The response reports the canonical order, and both uris survive it.
        self.assertEqual(sorted(permuted["redirect_uris"]), sorted(uris))
        with self.app.store.connect() as conn:
            count = conn.execute("SELECT COUNT(*) AS n FROM oauth_clients").fetchone()
        self.assertEqual(int(count["n"]), 1)

    def _capped_registrar(self, *, max_clients: int):
        """A registration service on a deliberately tiny client table."""
        repository = SqlOAuthRepository(
            store=self.app.store,
            unused_client_ttl_days=30,
            max_clients=max_clients,
        )
        service = OAuthService(
            repository=repository,
            project_keys=self.keys,
            is_project_member=self.app.projects.is_member,
        )

        def register(name: str) -> dict:
            return service.register_client(
                {
                    "client_name": name,
                    "redirect_uris": [REDIRECT_URI],
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code"],
                    "response_types": ["code"],
                }
            )

        return service, register

    def _client_count(self) -> int:
        with self.app.store.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM oauth_clients").fetchone()
        return int(row["n"])

    def test_the_cap_evicts_the_oldest_unused_client_instead_of_refusing(self) -> None:
        """AUTH-03: the table is bounded without any scheduler AND without
        handing an unauthenticated caller an onboarding denial of service."""
        _service, register = self._capped_registrar(max_clients=2)
        first = register("Agent 1")
        second = register("Agent 2")
        # created_at is second-resolution, so age the two rows apart rather than
        # letting a same-second tie decide which one "oldest" means.
        with self.app.store.transaction() as conn:
            for client_id, days in ((first["client_id"], 3), (second["client_id"], 2)):
                conn.execute(
                    "UPDATE oauth_clients SET created_at = ? WHERE client_id = ?",
                    (format_iso(datetime.now(tz=UTC) - timedelta(days=days)), client_id),
                )
        third = register("Agent 3")

        with self.app.store.connect() as conn:
            surviving = {
                str(row["client_id"])
                for row in conn.execute("SELECT client_id FROM oauth_clients").fetchall()
            }
        self.assertEqual(
            surviving, {second["client_id"], third["client_id"]}, surviving
        )
        self.assertNotIn(
            first["client_id"], surviving, "the oldest unused row was not evicted"
        )

        # The TTL sweep still runs on the registration path for rows that age
        # out on their own, so eviction is the floor, not the whole story.
        stale = format_iso(datetime.now(tz=UTC) - timedelta(days=90))
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE oauth_clients SET created_at = ?", (stale,))
        register("Agent 4")
        self.assertEqual(self._client_count(), 1, "the stale rows were not swept")

    def test_a_table_of_used_clients_refuses_without_naming_the_cap(self) -> None:
        """Eviction may never delete a row someone holds a live grant on, so an
        all-used table is the one case that still refuses — and the refusal
        tells an unauthenticated caller nothing about the knob or its value."""
        used, _tokens = self._mint_oauth_tokens()
        service, register = self._capped_registrar(max_clients=1)
        with self.assertRaises(OAuthError) as ctx:
            register("Agent 1")
        self.assertEqual(ctx.exception.error, "temporarily_unavailable")
        self.assertNotIn(MAX_CLIENTS_ENV_VAR, ctx.exception.description)
        self.assertNotIn("1", ctx.exception.description)
        self.assertIsNotNone(
            SqlOAuthRepository(store=self.app.store).client_by_id(
                client_id=used["client_id"]
            ),
            "the used client was evicted",
        )

        # Over the wire the refusal is a server condition, not bad metadata.
        capped = TestClient(
            create_fastapi_app(
                self.app,
                surface_policy=HttpSurfacePolicy.for_surface(
                    restrict_cors=True, hosted_control=True
                ),
                auth=self.verifier,
                oauth_service=service,
                oauth_resource_uri=RESOURCE,
            ),
            base_url=ISSUER,
            raise_server_exceptions=False,
        )
        refused = capped.post(
            "/oauth/register",
            json={
                "client_name": "Agent 2",
                "redirect_uris": [REDIRECT_URI],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
                "response_types": ["code"],
            },
        )
        self.assertEqual(refused.status_code, 503, refused.text)
        self.assertEqual(refused.json()["error"], "temporarily_unavailable")
        self.assertNotIn(MAX_CLIENTS_ENV_VAR, refused.text)

    @patch("merv.brain.surface.oauth_store.OPPORTUNISTIC_PRUNE_LIMIT", 1)
    @patch("merv.brain.surface.oauth_store.CAP_EVICTION_LIMIT", 1)
    def test_an_over_cap_table_converges_because_refusals_commit_their_work(
        self,
    ) -> None:
        """A refusal must not roll back the deletions it just made: with the
        per-call budget at 1 and the table well past ``max_clients`` + that
        budget, each attempt has to shrink the table until one is admitted."""
        _seeder, seed = self._capped_registrar(max_clients=500)
        for index in range(6):
            seed(f"Seeded Agent {index}")
        self.assertEqual(self._client_count(), 6)

        _service, register = self._capped_registrar(max_clients=2)
        observed: list[int] = []
        admitted = None
        for _attempt in range(10):
            try:
                admitted = register("Latecomer Agent")
                break
            except OAuthError as exc:
                self.assertEqual(exc.error, "temporarily_unavailable")
                observed.append(self._client_count())

        self.assertIsNotNone(admitted, "the over-cap table never converged")
        self.assertEqual(observed, [5, 4, 3, 2], "a refusal rolled back its prune")
        self.assertEqual(self._client_count(), 2)

    def test_a_legacy_unsorted_registration_is_adopted_not_duplicated(self) -> None:
        """Migration 38's backfill fingerprints pre-canonicalization rows from
        their CANONICAL form, so the same client re-registering after the
        canonicalization shipped resolves to its existing row."""
        uris = ["https://client.example/b", "https://client.example/a"]
        with self.app.store.transaction() as conn:
            conn.execute("DROP INDEX IF EXISTS idx_oauth_clients_fingerprint")
            conn.execute(
                "INSERT INTO oauth_clients (client_id, client_name, "
                "redirect_uris_json, grant_types_json, metadata_fingerprint, "
                "created_at) VALUES (?, ?, ?, ?, NULL, ?)",
                (
                    "oauthc_legacy",
                    "Legacy Agent",
                    json.dumps(uris),
                    json.dumps(["refresh_token", "authorization_code"]),
                    format_iso(datetime.now(tz=UTC) - timedelta(days=1)),
                ),
            )
            conn.execute("DELETE FROM schema_migrations WHERE version = 38")
        StateStore(db_path=self.app.store.db_path)  # replays migration 38

        again = self._register(
            client_name="Legacy Agent",
            redirect_uris=list(reversed(uris)),
            grants=["authorization_code", "refresh_token"],
        )
        self.assertEqual(again["client_id"], "oauthc_legacy")
        self.assertEqual(self._client_count(), 1)

    def test_unused_registrations_expire_and_used_ones_survive(self) -> None:
        unused = self._register(client_name="Abandoned Agent")
        used, _tokens = self._mint_oauth_tokens()
        repository = SqlOAuthRepository(
            store=self.app.store, unused_client_ttl_days=30
        )

        fresh = repository.prune(now=datetime.now(tz=UTC))
        self.assertEqual(fresh, {"deleted": 0, "ok": True, "cutoff": fresh["cutoff"]})

        outcome = repository.prune(now=datetime.now(tz=UTC) + timedelta(days=31))
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["deleted"], 1)
        self.assertIsNone(repository.client_by_id(client_id=unused["client_id"]))
        self.assertIsNotNone(repository.client_by_id(client_id=used["client_id"]))

    def test_a_client_with_only_a_live_code_survives_the_prune(self) -> None:
        """One protection, isolated: an unexchanged code alone keeps the row."""
        registration = self._register(client_name="Consenting Agent")
        self._authorize(registration["client_id"])  # a code, never exchanged
        with self.app.store.connect() as conn:
            codes = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_authorization_codes "
                "WHERE client_id = ?",
                (registration["client_id"],),
            ).fetchone()
            refreshes = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE client_id = ?",
                (registration["client_id"],),
            ).fetchone()
        self.assertEqual(int(codes["n"]), 1)
        self.assertEqual(int(refreshes["n"]), 0, "the refresh path must not help here")

        repository = SqlOAuthRepository(
            store=self.app.store, unused_client_ttl_days=30
        )
        outcome = repository.prune(now=datetime.now(tz=UTC) + timedelta(days=31))
        self.assertTrue(outcome["ok"])
        self.assertIsNotNone(
            repository.client_by_id(client_id=registration["client_id"])
        )

    def test_a_client_with_only_a_refresh_token_survives_the_prune(self) -> None:
        """The other protection, isolated: a refresh token alone keeps the row."""
        registration, _tokens = self._mint_oauth_tokens()
        # Drop the spent code so ONLY the refresh-token subquery can save this.
        with self.app.store.transaction() as conn:
            conn.execute(
                "DELETE FROM oauth_authorization_codes WHERE client_id = ?",
                (registration["client_id"],),
            )
        with self.app.store.connect() as conn:
            codes = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_authorization_codes "
                "WHERE client_id = ?",
                (registration["client_id"],),
            ).fetchone()
            refreshes = conn.execute(
                "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE client_id = ?",
                (registration["client_id"],),
            ).fetchone()
        self.assertEqual(int(codes["n"]), 0, "the code path must not help here")
        self.assertEqual(int(refreshes["n"]), 1)

        repository = SqlOAuthRepository(
            store=self.app.store, unused_client_ttl_days=30
        )
        outcome = repository.prune(now=datetime.now(tz=UTC) + timedelta(days=31))
        self.assertTrue(outcome["ok"])
        self.assertIsNotNone(
            repository.client_by_id(client_id=registration["client_id"])
        )

    def test_a_failing_client_sweep_says_so_instead_of_zero(self) -> None:
        class ExplodingStore:
            def transaction(self):
                raise RuntimeError("clients table unreachable")

        outcome = SqlOAuthRepository(store=ExplodingStore()).prune()
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["deleted"], 0)
        self.assertIn("unreachable", outcome["error"])

    def test_code_pkce_exchange_mints_working_key_for_mcp_tools_list(
        self,
    ) -> None:
        registration = self._register()
        params = self._authorization_params(registration["client_id"])
        begun = self.client.get(
            "/oauth/authorize", params=params, follow_redirects=False
        )
        self.assertEqual(begun.status_code, 302, begun.text)
        self.assertTrue(
            begun.headers["location"].startswith(
                "https://ui.example/merv/oauth/authorize?"
            )
        )
        details = self.client.get(
            "/oauth/authorize/details", params=params, headers=_bearer(self.jwt_a)
        )
        self.assertEqual(
            details.json(),
            {
                "client_id": registration["client_id"],
                "client_name": "Replit Agent",
                "resource": RESOURCE,
            },
        )
        redirect, query = self._authorize(registration["client_id"], params=params)
        self.assertTrue(redirect.startswith(f"{REDIRECT_URI}?"))
        self.assertEqual(query["state"], ["client-state"])
        self.assertEqual(query["iss"], [ISSUER])
        code = query["code"][0]

        exchanged = self._exchange(client_id=registration["client_id"], code=code)
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        tokens = exchanged.json()
        self.assertTrue(tokens["access_token"].startswith("mk_"))
        self.assertTrue(tokens["refresh_token"].startswith("mrt_"))
        self.assertEqual(tokens["token_type"], "Bearer")
        self.assertEqual(exchanged.headers["cache-control"], "no-store")
        with self.app.store.connect() as conn:
            stored_code = conn.execute(
                "SELECT * FROM oauth_authorization_codes WHERE code_digest = ?",
                (hashlib.sha256(code.encode()).hexdigest(),),
            ).fetchone()
            key = conn.execute(
                "SELECT * FROM project_api_keys WHERE secret_digest = ?",
                (hashlib.sha256(tokens["access_token"].encode()).hexdigest(),),
            ).fetchone()
            refresh = conn.execute("SELECT * FROM oauth_refresh_tokens").fetchone()
        self.assertNotEqual(stored_code["code_digest"], code)
        code_created = parse_iso(stored_code["created_at"])
        code_expires = parse_iso(stored_code["expires_at"])
        self.assertIsNotNone(code_created)
        self.assertIsNotNone(code_expires)
        assert code_created is not None and code_expires is not None
        self.assertLessEqual((code_expires - code_created).total_seconds(), 60)
        # De-profiled: the minted access bearer carries project + audience +
        # oauth family, and there is no profile column at all.
        self.assertNotIn("profile", key.keys())
        self.assertEqual(key["project_id"], self.project_a)
        self.assertEqual(key["audience"], RESOURCE)
        self.assertEqual(key["oauth_family_id"], refresh["family_id"])
        self.assertIsNone(key["sandbox_seconds_ceiling"])
        self.assertIsNone(key["blob_bytes_ceiling"])
        self.assertNotEqual(refresh["secret_digest"], tokens["refresh_token"])

        forbidden_rest = self.client.get(
            f"/api/projects/{self.project_a}",
            headers=_bearer(tokens["access_token"]),
        )
        self.assertEqual(forbidden_rest.status_code, 403, forbidden_rest.text)
        self.assertEqual(
            forbidden_rest.json()["error_code"], "credential_audience_forbidden"
        )
        legacy_mcp = self.client.get(
            "/mcp/tools", headers=_bearer(tokens["access_token"])
        )
        self.assertEqual(legacy_mcp.status_code, 200, legacy_mcp.text)

        encoded = base64.b64encode(
            f"merv:{tokens['access_token']}".encode()
        ).decode()
        dormant_tracking_gate = self.client.get(
            "/internal/auth/mlflow", headers={"Authorization": f"Basic {encoded}"}
        )
        self.assertEqual(
            dormant_tracking_gate.status_code, 404, dormant_tracking_gate.text
        )

        initialized = self.client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "oauth-test", "version": "1"},
                },
            },
            headers=_bearer(tokens["access_token"]),
        )
        self.assertEqual(initialized.status_code, 200, initialized.text)
        session = initialized.headers["mcp-session-id"]
        headers = {**_bearer(tokens["access_token"]), "Mcp-Session-Id": session}
        ready = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers=headers,
        )
        self.assertEqual(ready.status_code, 202, ready.text)
        listed = self.client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            headers=headers,
        )
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertTrue(listed.json()["result"]["tools"])

        alias = TestClient(self.client.app, base_url="https://alias.example")
        try:
            wrong_origin = alias.get(
                "/mcp/tools", headers=_bearer(tokens["access_token"])
            )
        finally:
            alias.close()
        self.assertEqual(wrong_origin.status_code, 403, wrong_origin.text)
        self.assertEqual(
            wrong_origin.json()["error_code"], "credential_audience_forbidden"
        )

    def test_public_oauth_body_limits_stream_before_buffering(self) -> None:
        with (
            patch(
                "merv.brain.surface.transport.api.oauth._MAX_DCR_BODY_BYTES", 32
            ),
            patch(
                "merv.brain.surface.transport.api.oauth._MAX_TOKEN_BODY_BYTES", 32
            ),
            patch.object(
                Request,
                "body",
                side_effect=AssertionError("OAuth limits must not call request.body"),
            ),
        ):
            registration = self.client.post(
                "/oauth/register",
                content=b"x" * 33,
                headers={"Content-Type": "application/json"},
            )
            token = self.client.post(
                "/oauth/token",
                content=b"x" * 33,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        self.assertEqual(registration.status_code, 400, registration.text)
        self.assertEqual(registration.json()["error"], "invalid_client_metadata")
        self.assertIn("too large", registration.json()["error_description"])
        self.assertEqual(token.status_code, 400, token.text)
        self.assertEqual(token.json()["error"], "invalid_request")
        self.assertIn("too large", token.json()["error_description"])

    def test_codes_are_single_use_expiring_and_pkce_bound(self) -> None:
        registration = self._register(grants=["authorization_code"])
        _redirect, query = self._authorize(registration["client_id"])
        code = query["code"][0]
        wrong = self._exchange(
            client_id=registration["client_id"], code=code, verifier="b" * 43
        )
        self.assertEqual(wrong.status_code, 400, wrong.text)
        self.assertEqual(wrong.json()["error"], "invalid_grant")
        right = self._exchange(client_id=registration["client_id"], code=code)
        self.assertEqual(right.status_code, 200, right.text)
        self.assertNotIn("refresh_token", right.json())
        replay = self._exchange(client_id=registration["client_id"], code=code)
        self.assertEqual(replay.json()["error"], "invalid_grant")

        _redirect, expiring_query = self._authorize(registration["client_id"])
        expiring = expiring_query["code"][0]
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE oauth_authorization_codes SET expires_at = ? WHERE code_digest = ?",
                ("2000-01-01T00:00:00Z", hashlib.sha256(expiring.encode()).hexdigest()),
            )
        expired = self._exchange(client_id=registration["client_id"], code=expiring)
        self.assertEqual(expired.json()["error"], "invalid_grant")

    def test_refresh_rotation_revokes_predecessor_and_replay_fails(self) -> None:
        registration, first = self._mint_oauth_tokens()
        refreshed = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        second = refreshed.json()
        self.assertNotEqual(second["access_token"], first["access_token"])
        self.assertNotEqual(second["refresh_token"], first["refresh_token"])

        old_access = self.client.post(
            "/mcp", json={}, headers=_bearer(first["access_token"])
        )
        self.assertEqual(old_access.status_code, 401, old_access.text)
        new_access = self.client.post(
            "/mcp", json={}, headers=_bearer(second["access_token"])
        )
        self.assertNotEqual(new_access.status_code, 401, new_access.text)
        replay = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(replay.json()["error"], "invalid_grant")
        replay_revoked_access = self.client.post(
            "/mcp", json={}, headers=_bearer(second["access_token"])
        )
        self.assertEqual(replay_revoked_access.status_code, 401)
        replay_revoked_refresh = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": second["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(replay_revoked_refresh.json()["error"], "invalid_grant")

        with self.app.store.connect() as conn:
            keys = conn.execute(
                "SELECT * FROM project_api_keys ORDER BY created_at, id"
            ).fetchall()
            refreshes = conn.execute(
                "SELECT * FROM oauth_refresh_tokens ORDER BY created_at, id"
            ).fetchall()
        self.assertEqual(len(keys), 2)
        predecessor = next(key for key in keys if key["parent_key_id"] is None)
        successor = next(key for key in keys if key["parent_key_id"] is not None)
        self.assertTrue(predecessor["revoked_at"])
        self.assertEqual(successor["parent_key_id"], predecessor["id"])
        first_refresh = next(
            token for token in refreshes if token["parent_token_id"] is None
        )
        second_refresh = next(
            token for token in refreshes if token["parent_token_id"] is not None
        )
        self.assertTrue(first_refresh["consumed_at"])
        self.assertEqual(second_refresh["parent_token_id"], first_refresh["id"])
        self.assertEqual(second_refresh["family_id"], first_refresh["family_id"])
        self.assertTrue(second_refresh["revoked_at"])

        next_registration, next_tokens = self._mint_oauth_tokens()
        next_key = self.keys.verify_secret(secret=next_tokens["access_token"])
        self.assertIsNotNone(next_key)
        assert next_key is not None
        self.keys.revoke(project_id=self.project_a, key_id=next_key.id, owner_user_id=USER_A)
        revoked_refresh = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": next_registration["client_id"],
                "refresh_token": next_tokens["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(revoked_refresh.json()["error"], "invalid_grant")

    def test_account_consent_survives_rotation_and_reaches_every_project(
        self,
    ) -> None:
        """consent(account) -> code -> key -> refresh -> replay, end to end.

        The scope the user agreed to has to survive every hop: it is persisted
        on the code, carried onto the minted key, inherited by each rotation,
        and killed with the family on replay.
        """
        project_b = self._create_project("OAuth Project B", self.jwt_a)
        registration = self._register()
        _redirect, query = self._authorize(
            registration["client_id"], grant_scope="account"
        )
        first = self._exchange(
            client_id=registration["client_id"], code=query["code"][0]
        ).json()

        # The access key carries no project confinement...
        principal = self.verifier.verify_bearer(f"Bearer {first['access_token']}")
        self.assertIsNotNone(principal.key_id)
        self.assertIsNone(principal.key_project_id)
        # ...so it reaches a project that is not the consented home project.
        # OAuth bearers are audience-bound to /mcp (INV-7), so reach is
        # exercised there rather than over REST.
        self.assertEqual(
            self._mcp_overview(first["access_token"], project_b), 200
        )

        refreshed = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        second = refreshed.json()

        # The rotation inherited the scope rather than narrowing to home.
        rotated = self.verifier.verify_bearer(f"Bearer {second['access_token']}")
        self.assertIsNone(rotated.key_project_id)
        self.assertEqual(
            self._mcp_overview(second["access_token"], project_b), 200
        )

        # Replaying the consumed refresh kills the whole family, both scopes
        # alike -- revocation keys on the unchanged home project and owner.
        replay = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(replay.status_code, 400, replay.text)
        self.assertEqual(
            self._mcp_overview(second["access_token"], project_b), 401
        )

    def test_project_consent_still_confines_the_minted_key(self) -> None:
        # The default is unchanged: absent grant_scope means one project.
        project_b = self._create_project("OAuth Project B", self.jwt_a)
        registration = self._register()
        _redirect, query = self._authorize(registration["client_id"])
        minted = self._exchange(
            client_id=registration["client_id"], code=query["code"][0]
        ).json()

        principal = self.verifier.verify_bearer(f"Bearer {minted['access_token']}")
        self.assertEqual(principal.key_project_id, self.project_a)
        self.assertEqual(
            self._mcp_overview(minted["access_token"], project_b), 403
        )
        self.assertEqual(
            self._mcp_overview(minted["access_token"], self.project_a), 200
        )

    def test_consent_rejects_an_unknown_grant_scope(self) -> None:
        registration = self._register()
        response = self.client.post(
            "/oauth/authorize",
            json={
                **self._authorization_params(registration["client_id"]),
                "decision": "approve",
                "project_id": self.project_a,
                "grant_scope": "everything",
            },
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(response.status_code, 200, response.text)
        query = parse_qs(urlsplit(response.json()["redirect_to"]).query)
        self.assertEqual(query["error"], ["invalid_request"])
        self.assertNotIn("code", query)

    def test_oauth_access_keys_of_one_grant_share_the_oauth_family(self) -> None:
        """Rotation keeps a single stable oauth_family_id across access keys —
        the grant-scoped identity that later phases key on (the branch's
        idempotency replay used it; the store itself is cut by ruling)."""
        registration, first = self._mint_oauth_tokens()
        refreshed = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        with self.app.store.connect() as conn:
            families = {
                row["oauth_family_id"]
                for row in conn.execute(
                    "SELECT oauth_family_id FROM project_api_keys ORDER BY created_at, id"
                ).fetchall()
            }
        self.assertEqual(len(families), 1)
        self.assertNotIn(None, families)

    def test_consent_requires_supabase_session_membership_and_never_open_redirects(
        self,
    ) -> None:
        registration = self._register()
        params = self._authorization_params(registration["client_id"])
        no_session = self.client.get("/oauth/authorize/details", params=params)
        self.assertEqual(no_session.status_code, 401, no_session.text)

        _registration, oauth_tokens = self._mint_oauth_tokens()
        project_key_session = self.client.get(
            "/oauth/authorize/details",
            params=params,
            headers=_bearer(oauth_tokens["access_token"]),
        )
        self.assertEqual(project_key_session.status_code, 403, project_key_session.text)
        self.assertEqual(
            project_key_session.json()["error_code"],
            "credential_audience_forbidden",
        )

        project_b = self._create_project("OAuth Project B", self.jwt_b)
        denied_redirect, denied = self._authorize(
            registration["client_id"], project_id=project_b
        )
        self.assertTrue(denied_redirect.startswith(REDIRECT_URI))
        self.assertEqual(denied["error"], ["access_denied"])
        self.assertEqual(denied["state"], ["client-state"])
        self.assertEqual(denied["iss"], [ISSUER])

        for client_id, redirect_uri in (
            (registration["client_id"], "https://attacker.example/callback"),
            ("unknown-client", "https://attacker.example/callback"),
        ):
            with self.subTest(client_id=client_id):
                attack = self.client.get(
                    "/oauth/authorize",
                    params=self._authorization_params(
                        client_id, redirect_uri=redirect_uri
                    ),
                    follow_redirects=False,
                )
                self.assertEqual(attack.status_code, 400, attack.text)
                self.assertNotIn("location", attack.headers)

        invalid_pkce = self._authorization_params(registration["client_id"])
        invalid_pkce["code_challenge_method"] = "plain"
        safe_error = self.client.get(
            "/oauth/authorize", params=invalid_pkce, follow_redirects=False
        )
        self.assertEqual(safe_error.status_code, 302, safe_error.text)
        parsed = urlsplit(safe_error.headers["location"])
        self.assertEqual(
            f"{parsed.scheme}://{parsed.netloc}{parsed.path}", REDIRECT_URI
        )
        error_query = parse_qs(parsed.query)
        self.assertEqual(error_query["error"], ["invalid_request"])
        self.assertEqual(error_query["state"], ["client-state"])
        self.assertEqual(error_query["iss"], [ISSUER])

    def test_token_endpoint_rejects_client_authentication_with_401(self) -> None:
        # RFC 6749 §5.2: a client that presented an Authorization header must
        # get 401 with a matching WWW-Authenticate challenge, not 400.
        registration, first = self._mint_oauth_tokens()
        response = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": first["refresh_token"],
                "resource": RESOURCE,
            },
            headers={"Authorization": "Basic Zm9vOmJhcg=="},
        )
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.headers.get("WWW-Authenticate"), "Basic")
        self.assertEqual(response.json()["error"], "invalid_client")

    def test_concurrent_refresh_replay_revokes_the_family(self) -> None:
        # A refresh token read as unconsumed but lost at the compare-and-set
        # (a concurrent exchange won the race) is reuse: the family must be
        # revoked, exactly as the sequential-replay path does.
        _registration, tokens = self._mint_oauth_tokens()

        class LosingRepository(SqlOAuthRepository):
            atomic_revocation_called = False

            def consume_refresh_token(self, *, token_id: str, consumed_at: str) -> bool:
                return False

            def revoke_refresh_family(self, *, family_id: str, revoked_at: str) -> None:
                raise AssertionError("split refresh-family revocation must not be used")

            def revoke_refresh_family_and_key_lineage(self, **kwargs: str) -> None:
                self.atomic_revocation_called = True
                super().revoke_refresh_family_and_key_lineage(**kwargs)

        repository = LosingRepository(store=self.app.store)
        racing = OAuthService(
            repository=repository,
            project_keys=self.keys,
            is_project_member=self.app.projects.is_member,
        )
        with self.assertRaises(OAuthError) as caught:
            racing.refresh(
                form={
                    "grant_type": "refresh_token",
                    "client_id": _registration["client_id"],
                    "refresh_token": tokens["refresh_token"],
                    "resource": RESOURCE,
                },
                canonical_resource=RESOURCE,
            )
        self.assertEqual(caught.exception.error, "invalid_grant")
        self.assertTrue(repository.atomic_revocation_called)
        with self.app.store.connect() as conn:
            refreshes = conn.execute(
                "SELECT revoked_at FROM oauth_refresh_tokens"
            ).fetchall()
        self.assertTrue(all(row["revoked_at"] for row in refreshes))
        stale = self.keys.verify_secret(secret=tokens["access_token"])
        self.assertIsNone(stale)

    def test_replay_revocation_rolls_back_refresh_and_key_together(self) -> None:
        _registration, tokens = self._mint_oauth_tokens()
        with self.app.store.connect() as conn:
            refresh = conn.execute(
                "SELECT family_id, current_key_id FROM oauth_refresh_tokens"
            ).fetchone()
        with self.app.store.transaction() as conn:
            conn.execute(
                """
                CREATE TRIGGER reject_project_key_revocation
                BEFORE UPDATE OF revoked_at ON project_api_keys
                BEGIN
                  SELECT RAISE(ABORT, 'forced key revocation failure');
                END
                """
            )

        repository = SqlOAuthRepository(store=self.app.store)
        with self.assertRaises(sqlite3.IntegrityError):
            repository.revoke_refresh_family_and_key_lineage(
                family_id=refresh["family_id"],
                key_id=refresh["current_key_id"],
                project_id=self.project_a,
                owner_user_id=USER_A,
                revoked_at="2026-07-22T12:00:00Z",
            )

        with self.app.store.connect() as conn:
            refresh_revoked = conn.execute(
                "SELECT revoked_at FROM oauth_refresh_tokens"
            ).fetchone()["revoked_at"]
            key_revoked = conn.execute(
                "SELECT revoked_at FROM project_api_keys WHERE id = ?",
                (refresh["current_key_id"],),
            ).fetchone()["revoked_at"]
        self.assertIsNone(refresh_revoked)
        self.assertIsNone(key_revoked)
        self.assertIsNotNone(self.keys.verify_secret(secret=tokens["access_token"]))

    # -- device authorization (RFC 8628) ------------------------------------

    def _register_device_client(self, client_name: str = "Merv MCP pairing") -> dict:
        response = self.client.post(
            "/oauth/register",
            json={
                "client_name": client_name,
                "token_endpoint_auth_method": "none",
                "grant_types": [DEVICE_GRANT, "refresh_token"],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def _device_start(self, client_id: str) -> dict:
        response = self.client.post(
            "/oauth/device_authorization",
            data={"client_id": client_id, "resource": RESOURCE},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _device_poll(self, client_id: str, device_code: str, *, resource: str = RESOURCE):
        return self.client.post(
            "/oauth/token",
            data={
                "grant_type": DEVICE_GRANT,
                "client_id": client_id,
                "device_code": device_code,
                "resource": resource,
            },
        )

    def _device_decide(
        self,
        user_code: str,
        *,
        decision: str = "approve",
        token: str | None = None,
        project_id: str | None = None,
        grant_scope: str | None = None,
    ):
        return self.client.post(
            "/oauth/device",
            json={
                "user_code": user_code,
                "decision": decision,
                "project_id": (
                    "" if decision == "deny" else project_id or self.project_a
                ),
                **({"grant_scope": grant_scope} if grant_scope else {}),
            },
            headers=_bearer(token or self.jwt_a),
        )

    def test_device_client_registers_without_redirect_uris(self) -> None:
        registration = self._register_device_client()
        self.assertEqual(registration["redirect_uris"], [])
        self.assertEqual(
            sorted(registration["grant_types"]),
            sorted([DEVICE_GRANT, "refresh_token"]),
        )
        # A redirect-flow client still must register its redirect URIs.
        refused = self.client.post(
            "/oauth/register",
            json={
                "client_name": "Redirect Agent",
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
            },
        )
        self.assertEqual(refused.status_code, 400, refused.text)

    def test_device_flow_mints_working_tokens_that_rotate(self) -> None:
        registration = self._register_device_client()
        start = self._device_start(registration["client_id"])
        self.assertRegex(start["user_code"], r"^[0-9A-Z]{4}-[0-9A-Z]{4}$")
        self.assertTrue(start["device_code"].startswith("mdc_"))
        self.assertEqual(start["interval"], 5)
        self.assertEqual(start["verification_uri"], "https://ui.example/merv/oauth/device")
        self.assertEqual(
            start["verification_uri_complete"],
            f"https://ui.example/merv/oauth/device?user_code={start['user_code']}",
        )

        pending = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(pending.status_code, 400, pending.text)
        self.assertEqual(pending.json()["error"], "authorization_pending")

        details = self.client.get(
            f"/oauth/device/details?user_code={start['user_code']}",
            headers=_bearer(self.jwt_a),
        )
        self.assertEqual(details.status_code, 200, details.text)
        self.assertEqual(details.json()["client_name"], "Merv MCP pairing")
        self.assertEqual(details.json()["resource"], RESOURCE)

        approved = self._device_decide(start["user_code"], grant_scope="account")
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["status"], "approved")

        # The pending poll above stamped last_polled_at; rewind it so this
        # poll is the success rather than a slow_down, without sleeping.
        with self.app.store.transaction() as conn:
            conn.execute("UPDATE oauth_device_grants SET last_polled_at = NULL")
        exchanged = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        tokens = exchanged.json()
        self.assertTrue(tokens["access_token"].startswith("mk_"))
        self.assertTrue(tokens["refresh_token"].startswith("mrt_"))
        self.assertEqual(self._mcp_overview(tokens["access_token"], self.project_a), 200)

        # One-shot: a replayed device code never mints a second bearer.
        replay = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(replay.status_code, 400)
        self.assertEqual(replay.json()["error"], "invalid_grant")

        # The refresh family rotates exactly like the redirect flow's.
        refreshed = self.client.post(
            "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": registration["client_id"],
                "refresh_token": tokens["refresh_token"],
                "resource": RESOURCE,
            },
        )
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        self.assertEqual(
            self._mcp_overview(refreshed.json()["access_token"], self.project_a), 200
        )

    def test_device_poll_enforces_the_interval(self) -> None:
        registration = self._register_device_client()
        start = self._device_start(registration["client_id"])
        first = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(first.json()["error"], "authorization_pending")
        second = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(second.json()["error"], "slow_down")

    def test_device_denial_reaches_the_client_as_access_denied(self) -> None:
        registration = self._register_device_client()
        start = self._device_start(registration["client_id"])
        denied = self._device_decide(start["user_code"], decision="deny")
        self.assertEqual(denied.status_code, 200, denied.text)
        self.assertEqual(denied.json()["status"], "denied")
        poll = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(poll.status_code, 400)
        self.assertEqual(poll.json()["error"], "access_denied")

    def test_an_expired_device_code_is_expired_token(self) -> None:
        registration = self._register_device_client()
        start = self._device_start(registration["client_id"])
        with self.app.store.transaction() as conn:
            conn.execute(
                "UPDATE oauth_device_grants SET expires_at = ?",
                (format_iso(datetime.now(UTC) - timedelta(seconds=1)),),
            )
        poll = self._device_poll(registration["client_id"], start["device_code"])
        self.assertEqual(poll.status_code, 400)
        self.assertEqual(poll.json()["error"], "expired_token")
        # The code no longer names a pending grant on the consent side either.
        approve = self._device_decide(start["user_code"])
        self.assertEqual(approve.status_code, 400)
        self.assertEqual(approve.json()["error"], "invalid_grant")

    def test_device_consent_requires_session_and_membership(self) -> None:
        registration = self._register_device_client()
        start = self._device_start(registration["client_id"])
        # No Supabase session: the gateway refuses before the handler runs.
        anonymous = self.client.get(
            f"/oauth/device/details?user_code={start['user_code']}"
        )
        self.assertNotEqual(anonymous.status_code, 200)
        # A signed-in non-member cannot bind the grant to someone else's project.
        outsider = self._device_decide(
            start["user_code"], token=self.jwt_b, project_id=self.project_a
        )
        self.assertEqual(outsider.status_code, 400)
        self.assertEqual(outsider.json()["error"], "access_denied")
        # An unknown grant scope is refused before any row is touched.
        bad_scope = self._device_decide(start["user_code"], grant_scope="galaxy")
        self.assertEqual(bad_scope.status_code, 400)
        self.assertEqual(bad_scope.json()["error"], "invalid_request")
        # The grant is still pending and approvable by the actual member.
        approved = self._device_decide(start["user_code"])
        self.assertEqual(approved.status_code, 200, approved.text)

    def test_device_code_misses_throttle_per_principal(self) -> None:
        for _ in range(10):
            miss = self._device_decide("QQQQ-QQQ2")
            self.assertEqual(miss.status_code, 400)
            self.assertEqual(miss.json()["error"], "invalid_grant")
        throttled = self._device_decide("QQQQ-QQQ2")
        self.assertEqual(throttled.status_code, 429, throttled.text)

    def test_device_grant_is_bound_to_client_and_resource(self) -> None:
        registration = self._register_device_client()
        other = self._register_device_client(client_name="Other pairing tool")
        self.assertNotEqual(registration["client_id"], other["client_id"])
        start = self._device_start(registration["client_id"])
        stolen = self._device_poll(other["client_id"], start["device_code"])
        self.assertEqual(stolen.status_code, 400)
        self.assertEqual(stolen.json()["error"], "invalid_grant")
        wrong_resource = self._device_poll(
            registration["client_id"], start["device_code"], resource="https://evil.example/mcp"
        )
        self.assertEqual(wrong_resource.status_code, 400)
        self.assertEqual(wrong_resource.json()["error"], "invalid_target")
        # A redirect-only client cannot enter the device lane at all.
        redirect_client = self._register()
        refused = self.client.post(
            "/oauth/device_authorization",
            data={"client_id": redirect_client["client_id"], "resource": RESOURCE},
        )
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"], "unauthorized_client")

    def test_a_client_with_only_a_device_grant_survives_the_prune(self) -> None:
        registration = self._register_device_client()
        self._device_start(registration["client_id"])
        repository = SqlOAuthRepository(
            store=self.app.store, unused_client_ttl_days=30
        )
        outcome = repository.prune(now=datetime.now(tz=UTC) + timedelta(days=31))
        self.assertTrue(outcome["ok"])
        self.assertIsNotNone(
            repository.client_by_id(client_id=registration["client_id"])
        )


if __name__ == "__main__":
    unittest.main()
