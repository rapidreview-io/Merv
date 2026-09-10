from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from merv.brain.surface.surface import build_control_app
from merv.brain.surface import surface as control_mode
from merv.brain.surface.config import (
    ALLOW_OPEN_CONTROL_ENV_VAR,
    ALLOWED_ORIGINS_ENV_VAR,
    CONTROL_RESTRICT_CORS_ENV_VAR,
    DB_URL_ENV_VAR,
    REQUIRE_AGENT_MLFLOW_ENV_VAR,
    REQUIRE_AUTH_ENV_VAR,
    REQUIRE_SANDBOX_BACKEND_ENV_VAR,
)
from merv.brain.surface.auth import (
    SUPABASE_JWT_SECRET_ENV_VAR,
    SUPABASE_URL_ENV_VAR,
)
from merv.brain.mlflow.config import (
    MLFLOW_MODE_ENV_VAR,
    MLFLOW_SERVER_URI_ENV_VAR,
    MLFLOW_TRACKING_URI_ENV_VAR,
)
from merv.brain.mlflow import CentralMlflowService
from tests.support.infrastructure import FakeInfrastructureClient, seed_sandbox
from merv.brain.surface.transport.api import create_fastapi_app
from merv.brain.surface.transport.http_policy import HttpSurfacePolicy
from merv.brain.kernel.state import StateStore
from tests.support.blobs import LocalDirBlobStore
from merv.brain.kernel.utils import ValidationError
from merv.brain.kernel.version import CLIENT_VERSION_HEADER
from merv.shared.client_config import CLIENT_CONFIG_ENV_VAR


def _mounted_mgmt_key_env(root: Path) -> dict[str, str]:
    key_path = root / "managed_key"
    key_path.write_text("PRIVATE KEY\n", encoding="utf-8")
    key_path.chmod(0o600)
    return {
        "MERV_MGMT_KEY_PATH": str(key_path),
        "MERV_MGMT_PUBLIC_KEY": "ssh-ed25519 AAAAmanaged",
        # Hosted control keeps no writable state root, so the run-wait signing
        # key is mounted configuration like the management key beside it.
        "MERV_WAIT_SECRET": "hosted-wait-secret-0123456789abcdef",
    }


def _open_control_env(root: Path) -> dict[str, str]:
    """Composition env for a test that serves an UNAUTHENTICATED hosted surface.

    Hosted control fails closed without a verifier (audit SEC-02); the tests
    below make tokenless requests on purpose, so they name the open mode.
    """
    return {**_mounted_mgmt_key_env(root), ALLOW_OPEN_CONTROL_ENV_VAR: "1"}


class SurfaceTest(unittest.TestCase):
    def test_machine_setting_disables_sandbox_surface_and_provider(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            settings = root / "client.json"
            settings.write_text(
                '{"features": {"sandbox": false}}', encoding="utf-8"
            )
            backend = FakeInfrastructureClient()
            app = build_control_app(
                repo_root=root,
                env={
                    **_mounted_mgmt_key_env(root),
                    CLIENT_CONFIG_ENV_VAR: str(settings),
                },
                infrastructure_client=backend,
            )
            self.addCleanup(app.shutdown)

            self.assertFalse(app.sandbox_enabled)
            self.assertFalse(app.sandboxes.health(details=True)["ok"])
            self.assertIsNone(app.sandboxes.client)
            self.assertFalse(
                any(
                    tool["name"].startswith("sandbox.")
                    for tool in app.tools.list_tools()
                )
            )
            client = TestClient(create_fastapi_app(app=app))
            self.assertEqual(client.get("/api/sandboxes/health").status_code, 404)

    def test_surface_records_scoped_activity_without_local_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env=_mounted_mgmt_key_env(root),
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)
            client = TestClient(
                create_fastapi_app(
                    app=app,
                    surface_policy=HttpSurfacePolicy.for_surface(
                        restrict_cors=True,
                        hosted_control=True,
                    ),
                    env=_open_control_env(root),
                ),
                raise_server_exceptions=False,
            )

            created = client.post(
                "/api/projects", json={"name": "Control Telemetry"}
            )
            self.assertEqual(created.status_code, 201, created.text)
            project_id = created.json()["id"]
            claim = client.post(
                f"/api/projects/{project_id}/claims",
                json={"statement": "A scoped control-plane claim."},
            )
            self.assertEqual(claim.status_code, 201, claim.text)

            stats = app.tool_calls.stats(project_id=project_id)
            self.assertGreaterEqual(stats["totals"]["calls"], 1)
            self.assertIn("filter", stats)
            app.tool_calls.record(
                tool="review.start",
                source="http",
                status="ok",
                duration_ms=1,
                arguments={
                    "project_id": project_id,
                    "reviewer_capability": "rp_arg",
                },
                result={"capability": "rp_result"},
            )
            listed = client.get(
                "/api/debug/tool-calls?source=all&status=all",
            )
            self.assertEqual(listed.status_code, 200, listed.text)
            calls = listed.json()["calls"]
            self.assertGreaterEqual(len(calls), 1)
            self.assertTrue(listed.json()["by_tool"])
            review_call = next(call for call in calls if call["tool"] == "review.start")
            detail = client.get(
                f"/api/debug/tool-calls/{review_call['id']}",
            )
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()["args"]["reviewer_capability"], "[redacted]")
            self.assertEqual(detail.json()["result"]["capability"], "[redacted]")
            activity = client.get("/api/activity")
            self.assertEqual(activity.status_code, 200, activity.text)
            self.assertGreaterEqual(activity.json()["summary"]["total"], 1)
            names = {tool["name"] for tool in app.tools.list_tools()}
            self.assertIn("claim.create", names)
            self.assertNotIn("resource.register", names)

    def test_hosted_control_cors_allows_authorized_ui_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env=_mounted_mgmt_key_env(root),
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)
            client = TestClient(
                create_fastapi_app(
                    app=app,
                    allowed_origins=["http://localhost:5173"],
                    surface_policy=HttpSurfacePolicy.for_surface(
                        restrict_cors=True,
                        hosted_control=True,
                    ),
                    env=_open_control_env(root),
                ),
                raise_server_exceptions=False,
            )

            preflight = client.options(
                "/api/projects",
                headers={
                    "Origin": "http://localhost:5173",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": (
                        "authorization,x-rp-client-version,content-type"
                    ),
                },
            )

            self.assertEqual(preflight.status_code, 200, preflight.text)
            self.assertEqual(
                preflight.headers.get("access-control-allow-origin"),
                "http://localhost:5173",
            )
            allowed_headers = preflight.headers.get(
                "access-control-allow-headers", ""
            ).lower()
            self.assertIn("authorization", allowed_headers)
            self.assertIn("x-rp-client-version", allowed_headers)

    def test_version_gate_426_carries_cors_headers_cross_origin(self) -> None:
        # Regression: the version-gate 426 short-circuits the middleware stack.
        # CORS must be the OUTERMOST middleware so it decorates that response
        # too; otherwise a cross-origin UI (e.g. the Vercel build) can't read
        # the 426 and reports an opaque "Load failed" instead of the upgrade
        # error. The preflight passes either way (OPTIONS is let through), so
        # this must assert on the actual gated GET, not just the preflight.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env=_mounted_mgmt_key_env(root),
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)
            client = TestClient(
                create_fastapi_app(
                    app=app,
                    allowed_origins=["http://localhost:5173"],
                    surface_policy=HttpSurfacePolicy.for_surface(
                        restrict_cors=True,
                        hosted_control=True,
                    ),
                    env=_open_control_env(root),
                ),
                raise_server_exceptions=False,
            )

            gated = client.get(
                "/api/projects",
                headers={
                    "Origin": "http://localhost:5173",
                    CLIENT_VERSION_HEADER: "0.0001",
                },
            )
            self.assertEqual(gated.status_code, 426, gated.text)
            self.assertEqual(gated.json()["error_code"], "client_too_old")
            self.assertEqual(
                gated.headers.get("access-control-allow-origin"),
                "http://localhost:5173",
            )




    def test_surface_ignores_legacy_mlflow_env_without_injection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env={
                    **_mounted_mgmt_key_env(root),
                    MLFLOW_MODE_ENV_VAR: "external",
                    MLFLOW_TRACKING_URI_ENV_VAR: "https://mlflow.example.test/",
                    MLFLOW_SERVER_URI_ENV_VAR: "http://mlflow:5000/",
                    REQUIRE_AGENT_MLFLOW_ENV_VAR: "1",
                    REQUIRE_SANDBOX_BACKEND_ENV_VAR: "1",
                },
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)

            self.assertIsNone(app._tracking)
            tool_names = {tool["name"] for tool in app.tools.list_tools()}
            self.assertNotIn("mlflow.context", tool_names)
            self.assertNotIn("mlflow.finalize_run", tool_names)
            self.assertNotIn("mlflow", app.sandboxes.health(details=True))

    def test_legacy_mlflow_requirement_env_is_inert_without_injection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env={
                    **_mounted_mgmt_key_env(root),
                    MLFLOW_MODE_ENV_VAR: "external",
                    MLFLOW_SERVER_URI_ENV_VAR: "http://mlflow:5000",
                    REQUIRE_AGENT_MLFLOW_ENV_VAR: "1",
                },
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)

            self.assertIsNone(app._tracking)

    def test_surface_can_require_healthy_sandbox_backend(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend = FakeInfrastructureClient()
            backend.healthy = False
            with self.assertRaises(ValidationError) as ctx:
                build_control_app(
                    repo_root=root,
                    env={
                        **_mounted_mgmt_key_env(root),
                        REQUIRE_SANDBOX_BACKEND_ENV_VAR: "1",
                    },
                    infrastructure_client=backend,
                )

        self.assertIn("merv-sandboxes", ctx.exception.message)
        self.assertIn("startup health check", ctx.exception.message)

    def test_surface_lazy_central_metrics_record_without_archive(self) -> None:
        snapshot = {
            "source": "mlflow",
            "base_url": "http://mlflow:5000",
            "experiments": [
                {
                    "name": "central",
                    "runs": [
                        {
                            "run_id": "run_1",
                            "metrics": {"loss": {"last": 0.2}},
                            "params": {},
                            "history": {},
                        }
                    ],
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env=_mounted_mgmt_key_env(root),
                infrastructure_client=FakeInfrastructureClient(),
                mlflow_tracking=CentralMlflowService(
                    tracking_uri="https://mlflow.example.test/",
                    server_uri="http://mlflow:5000/",
                ),
            )
            self.addCleanup(app.shutdown)
            project_id = app.tools.call_tool("project", {"action": "create", "name": "Control Metrics"})["id"]
            exp_id = app.tools.call_tool(
                "experiment.create",
                {"project_id": project_id, "name": "exp", "intent": "measure"},
            )["id"]
            seed_sandbox(
                app.sandboxes,
                experiment_id=exp_id,
                sandbox_uid="uid_control_metrics",
                project_id=project_id,
                status="running",
                sandbox_id="sbx_control",
            )

            with patch(
                "merv.brain.mlflow.tracking.snapshot_mlflow",
                return_value=dict(snapshot),
            ) as capture:
                result = app._tracking.results_metrics(
                    experiment_id=exp_id, project_id=project_id
                )

            capture.assert_called_once()
            self.assertEqual(capture.call_args.args[0], "http://mlflow:5000")
            self.assertTrue(result["available"])
            self.assertNotIn("base_url", result)
            self.assertEqual(result["experiments"][0]["name"], "central")

    def test_surface_without_repo_root_requires_durable_config(self) -> None:
        with self.assertRaises(ValidationError) as ctx:
            build_control_app(repo_root=None, env={}, infrastructure_client=FakeInfrastructureClient())

        self.assertIn(DB_URL_ENV_VAR, ctx.exception.message)
        self.assertIn("MERV_SANDBOXES_URL", ctx.exception.message)
        self.assertIn("MERV_SANDBOXES_CONNECTIONS_FILE", ctx.exception.message)

    def test_surface_without_repo_root_uses_non_created_compat_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mounted_env = _mounted_mgmt_key_env(root)
            store = StateStore(db_path=root / "state.sqlite")
            blobs = LocalDirBlobStore(root=root / "blobs")
            env = {
                **mounted_env,
                DB_URL_ENV_VAR: "postgresql://user:pass@db/research_plugin",
                "MERV_SANDBOXES_URL": "https://sandboxes.test",
                "MERV_SANDBOXES_CONNECTIONS_FILE": str(root / "connections.json"),
            }
            with (
                patch(
                    "merv.brain.surface.surface.build_state_store",
                    return_value=store,
                ) as state_factory,
                patch(
                    "merv.brain.surface.surface.build_blob_store",
                    return_value=blobs,
                ) as blob_factory,
            ):
                app = build_control_app(
                    repo_root=None,
                    env=env,
                    infrastructure_client=FakeInfrastructureClient(),
                )
            self.addCleanup(app.shutdown)

            self.assertFalse(hasattr(app, "workspace"))
            self.assertEqual(
                state_factory.call_args.kwargs["db_path"],
                control_mode.CONTROL_COMPAT_REPO_ROOT / "state.sqlite",
            )
            self.assertEqual(
                blob_factory.call_args.kwargs["default_root"],
                control_mode.CONTROL_COMPAT_REPO_ROOT / "blobs",
            )

    def test_hosted_control_refuses_to_boot_without_a_verifier(self) -> None:
        """SEC-02: an unauthenticated hosted surface is never the default."""
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValidationError) as ctx:
                build_control_server(repo_root=root, env=_mounted_mgmt_key_env(root))
        self.assertIn(SUPABASE_URL_ENV_VAR, ctx.exception.message)
        self.assertIn(SUPABASE_JWT_SECRET_ENV_VAR, ctx.exception.message)
        self.assertIn(ALLOW_OPEN_CONTROL_ENV_VAR, ctx.exception.message)

    def test_composing_a_hosted_app_directly_fails_closed_too(self) -> None:
        """SEC-02: the outer server builder is not the only way in.

        ``build_control_app`` + ``create_fastapi_app(surface_policy=hosted)``
        is a public composition path. If the verifier/open decision only lived
        in ``build_control_server``, this route would serve tokenless writes on
        a hosted-policy surface — which is exactly what a committed test used
        to do. The decision has to live where the hosted app is composed.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = build_control_app(
                repo_root=root,
                env=_mounted_mgmt_key_env(root),
                infrastructure_client=FakeInfrastructureClient(),
            )
            self.addCleanup(app.shutdown)
            hosted = HttpSurfacePolicy.for_surface(
                restrict_cors=True, hosted_control=True
            )
            with self.assertRaises(ValidationError) as ctx:
                create_fastapi_app(app=app, surface_policy=hosted, env={})
            self.assertIn(ALLOW_OPEN_CONTROL_ENV_VAR, ctx.exception.message)

            # Naming the open mode is the only way through, and it works.
            opened = create_fastapi_app(
                app=app,
                surface_policy=hosted,
                env={ALLOW_OPEN_CONTROL_ENV_VAR: "1"},
            )
            client = TestClient(opened, raise_server_exceptions=False)
            self.assertEqual(client.get("/api/projects").status_code, 200)

            # The local preset is untouched: no flag, no verifier, still serves.
            local = TestClient(
                create_fastapi_app(app=app, env={}),
                raise_server_exceptions=False,
            )
            self.assertEqual(local.get("/api/projects").status_code, 200)

    def test_a_misspelled_open_flag_fails_the_boot_instead_of_opening(self) -> None:
        """The flag turns a security control off, so it is parsed strictly."""
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValidationError) as ctx:
                build_control_server(
                    repo_root=root,
                    env={
                        **_mounted_mgmt_key_env(root),
                        ALLOW_OPEN_CONTROL_ENV_VAR: "ture",
                    },
                )
        # Names the variable and what it will accept, rather than guessing.
        self.assertIn(ALLOW_OPEN_CONTROL_ENV_VAR, ctx.exception.message)
        self.assertIn("true", ctx.exception.message)
        self.assertIn("1", ctx.exception.message)
        self.assertEqual(ctx.exception.details["value"], "ture")

    def test_an_explicit_off_value_keeps_the_plane_closed(self) -> None:
        from merv.brain.surface.surface import build_control_server

        for value in ("0", "false", "off", "no"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with self.assertRaises(ValidationError) as ctx:
                    build_control_server(
                        repo_root=root,
                        env={
                            **_mounted_mgmt_key_env(root),
                            ALLOW_OPEN_CONTROL_ENV_VAR: value,
                        },
                    )
                self.assertIn(SUPABASE_URL_ENV_VAR, ctx.exception.message)

    def test_require_auth_without_credentials_still_names_the_missing_ones(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValidationError) as ctx:
                build_control_server(
                    repo_root=root,
                    env={**_mounted_mgmt_key_env(root), REQUIRE_AUTH_ENV_VAR: "1"},
                )
        self.assertIn(REQUIRE_AUTH_ENV_VAR, ctx.exception.message)
        self.assertEqual(
            ctx.exception.details["missing"],
            [SUPABASE_URL_ENV_VAR, SUPABASE_JWT_SECRET_ENV_VAR],
        )

    def test_the_open_flag_boots_an_open_plane_and_says_so(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertLogs("merv.brain.surface.auth", level="WARNING") as logs:
                server = build_control_server(
                    repo_root=root, env=_open_control_env(root)
                )
            self.addCleanup(server.shutdown)
            self.assertIn("OPEN CONTROL PLANE", "\n".join(logs.output))
            client = TestClient(server.fastapi_app, raise_server_exceptions=False)
            self.assertEqual(client.get("/api/projects").status_code, 200)

    def test_the_cleanup_pass_sweeps_oauth_registrations(self) -> None:
        # AUTH-03: the sweep only runs if composition hands it the repository.
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = build_control_server(repo_root=root, env=_open_control_env(root))
            self.addCleanup(server.shutdown)
            outcome = server.cleanup.run_all().as_dict()["oauth_clients_pruned"]
            self.assertTrue(outcome["ok"])
            self.assertNotIn("skipped", outcome)

    def test_local_deployment_keeps_its_unauthenticated_default(self) -> None:
        # Loopback single-user mode never had a verifier and still does not
        # need the open-mode flag.
        from merv.brain.surface.surface import build_local_server

        with tempfile.TemporaryDirectory() as tmp:
            server = build_local_server(state_dir=Path(tmp), env={})
            self.addCleanup(server.shutdown)
            client = TestClient(server.fastapi_app, raise_server_exceptions=False)
            self.assertEqual(client.get("/api/projects").status_code, 200)

    def test_control_server_reads_allowed_origins_from_env(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = build_control_server(
                repo_root=root,
                env={
                    **_open_control_env(root),
                    ALLOWED_ORIGINS_ENV_VAR: (
                        "https://ui.example.com, http://localhost:5173"
                    )
                },
            )
            self.addCleanup(server.shutdown)
            client = TestClient(server.fastapi_app, raise_server_exceptions=False)

            allowed = client.options(
                "/api/projects",
                headers={
                    "Origin": "https://ui.example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )
            self.assertEqual(
                allowed.headers.get("access-control-allow-origin"),
                "https://ui.example.com",
            )
            blocked = client.options(
                "/api/projects",
                headers={
                    "Origin": "https://evil.example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )
            self.assertNotEqual(
                blocked.headers.get("access-control-allow-origin"),
                "https://evil.example.com",
            )

    def test_control_server_warns_when_allowed_origins_empty(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertLogs(
                "merv.brain.surface.surface", level="WARNING"
            ) as logs:
                server = build_control_server(
                    repo_root=root,
                    env=_open_control_env(root),
                )
            self.addCleanup(server.shutdown)
            self.assertIn(ALLOWED_ORIGINS_ENV_VAR, "\n".join(logs.output))

    def test_control_server_private_surface_and_cors_are_configured_independently(self) -> None:
        from merv.brain.surface.surface import build_control_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # CORS is deliberately unrestricted, so the composition must not
            # warn about empty origins. Auth is deliberately unconfigured too,
            # but that warning belongs to the auth module now, leaving this
            # logger silent — which is the assertion this test wants.
            with self.assertNoLogs(
                "merv.brain.surface.surface", level="WARNING"
            ):
                server = build_control_server(
                    repo_root=root,
                    env={
                        **_open_control_env(root),
                        CONTROL_RESTRICT_CORS_ENV_VAR: "false",
                    },
                )
            self.addCleanup(server.shutdown)
            client = TestClient(server.fastapi_app, raise_server_exceptions=False)

            projects = client.get("/api/projects")
            self.assertEqual(projects.status_code, 200, projects.text)

            old_daemon_poll = client.get("/api/daemon/tasks?wait=0")
            self.assertEqual(old_daemon_poll.status_code, 410, old_daemon_poll.text)
            self.assertEqual(
                old_daemon_poll.json().get("error_code"), "daemon_retired"
            )

            # Even the private/no-verifier control surface operator-gates
            # global mutators; the deploy cron must send MERV_ADMIN_TOKEN.
            import os

            bare_cleanup = client.post("/api/admin/cleanup")
            self.assertEqual(bare_cleanup.status_code, 403, bare_cleanup.text)
            with patch.dict(os.environ, {"MERV_ADMIN_TOKEN": "op-secret"}):
                op = {"X-Admin-Token": "op-secret"}
                admin_cleanup = client.post("/api/admin/cleanup", headers=op)
                self.assertEqual(admin_cleanup.status_code, 200, admin_cleanup.text)

                counters = client.get("/api/admin/tenants/local/counters", headers=op)
                self.assertEqual(counters.status_code, 200, counters.text)

            old_proxy = client.get(
                "/api/projects",
                headers={CLIENT_VERSION_HEADER: "0.0001"},
            )
            self.assertEqual(old_proxy.status_code, 426, old_proxy.text)

            # The retired data-plane submission route is absent.
            data_plane_write = client.post(
                "/api/data-plane/feed/validate-post",
                json={
                    "project_id": "proj_retired",
                    "handle": "main",
                    "text": "control-surface probe",
                },
            )
            self.assertEqual(data_plane_write.status_code, 404, data_plane_write.text)

            meta = client.get("/api/meta")
            self.assertEqual(meta.status_code, 200, meta.text)
            body = meta.json()
            self.assertEqual(body["mode"], "control")
            self.assertTrue(body["capabilities"]["hosted_control"])
            self.assertTrue(body["capabilities"]["mcp"])
            self.assertTrue(body["capabilities"]["token_uploads"])

            preflight = client.options(
                "/api/projects",
                headers={
                    "Origin": "https://dev.example.com",
                    "Access-Control-Request-Method": "GET",
                },
            )
            self.assertEqual(
                preflight.headers.get("access-control-allow-origin"), "*"
            )


if __name__ == "__main__":
    unittest.main()
