"""Deploy-artifact structural lints (cloud plan Phase 9).

Pure file parsing — no docker — that the reference deploy stack references the
right entrypoints, extras, and config, and that no secrets are committed. Keeps
the Dockerfile/compose from silently drifting away from the console scripts and
the §3.4 config matrix the rest of the phase wired.
"""

from __future__ import annotations

import tomllib
import unittest

from tests.paths import PLUGIN_ROOT


DEPLOY = PLUGIN_ROOT / "deploy"


class DeployArtifactsTest(unittest.TestCase):
    def test_deploy_dir_has_the_expected_files(self) -> None:
        for name in (
            "Dockerfile",
            "Dockerfile.dockerignore",
            "docker-compose.yml",
            "docker-compose.postgres.yml",
            "docker-compose.supabase.yml",
            "db_preflight.py",
            "doctor.py",
            "README.md",
            ".dockerignore",
            ".env.example",
            "supabase.env.example",
        ):
            with self.subTest(file=name):
                self.assertTrue((DEPLOY / name).is_file(), f"missing deploy/{name}")
        self.assertFalse(
            (DEPLOY / "Dockerfile.mlflow").exists(),
            "temporarily removed tracking must not ship a deploy image",
        )

    def test_dockerfile_installs_control_extra_and_runs_control_entrypoint(self) -> None:
        text = (DEPLOY / "Dockerfile").read_text(encoding="utf-8")
        # Installs the `control` extra (Postgres + object store + provider SDK).
        self.assertIn('.[control,gcp]', text)
        # The whole src/ tree (brain + proxy + shared) must be present before
        # the wheel/install step runs in the image.
        self.assertIn("COPY src ./src", text)
        # Runs the control console-script entrypoint, not a raw module.
        self.assertIn("merv-control", text)
        self.assertIn("deploy/db_preflight.py", text)
        # Non-root user.
        self.assertIn("USER ", text)
        self.assertIn("useradd", text)
        # HEALTHCHECK hits the version handshake (or /health).
        self.assertIn("HEALTHCHECK", text)
        self.assertTrue("/api/meta" in text or "/health" in text)
        # Hosted control needs ssh for Lambda management operations, and the
        # reference compose key-init job needs ssh-keygen.
        self.assertIn("openssh-client", text)
        # The hosted control entrypoint now runs without a checkout/staging dir.
        self.assertNotIn("MERV_REPO_ROOT", text)
        self.assertNotIn("RESEARCH_PLUGIN_REPO_ROOT", text)

    def test_control_entrypoint_exists_in_pyproject(self) -> None:
        with (PLUGIN_ROOT / "pyproject.toml").open("rb") as handle:
            pyproject = tomllib.load(handle)
        scripts = pyproject["project"]["scripts"]
        self.assertEqual(
            scripts.get("merv-control"),
            "merv.brain.surface.transport.http_server:control_main",
        )
        # The control extra exists and carries the Postgres + object-store deps.
        control_extra = " ".join(
            pyproject["project"]["optional-dependencies"]["control"]
        )
        self.assertIn("psycopg", control_extra)
        self.assertIn("boto3", control_extra)
        self.assertNotIn("mlflow", control_extra)

    def test_compose_base_wires_control_object_store_and_management_key(self) -> None:
        text = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
        # Database-neutral base: application + object store + management key.
        for service in ("control:", "minio:", "mgmtkey:"):
            self.assertIn(service, text)
        self.assertNotIn("  postgres:\n", text)
        self.assertIn("MERV_DB_URL", text)
        self.assertIn("MERV_BLOB_BUCKET", text)
        self.assertIn("MERV_MGMT_KEY_PATH", text)
        self.assertIn("MERV_REQUIRE_SANDBOX_BACKEND", text)
        self.assertIn("MERV_EXECUTION_BACKEND", text)
        self.assertIn("MERV_PROVIDER_ENV_FILE", text)
        # Host-side substitutions dual-read: a host exporting only the legacy
        # spelling keeps its value at compose-interpolation level.
        self.assertIn(
            "${MERV_STORAGE_ENDPOINT_URL:-"
            "${RESEARCH_PLUGIN_STORAGE_ENDPOINT_URL:-http://minio:9000}}",
            text,
        )
        self.assertIn("${AWS_ENDPOINT_URL_S3:-http://minio:9000}", text)
        self.assertIn("ssh-keygen", text)
        self.assertIn("mgmtkey:/run/secrets/research_plugin_mgmt_key:ro", text)
        # Builds from the deploy Dockerfile.
        self.assertIn("dockerfile: deploy/Dockerfile", text)
        self.assertNotIn("mlflow", text.lower())

    def test_database_overlays_are_hot_swappable_and_isolated(self) -> None:
        postgres = (DEPLOY / "docker-compose.postgres.yml").read_text(encoding="utf-8")
        supabase = (DEPLOY / "docker-compose.supabase.yml").read_text(encoding="utf-8")

        self.assertIn("  postgres:", postgres)
        self.assertIn("postgres:16-alpine", postgres)
        self.assertIn("MERV_DB_URL: postgresql://", postgres)

        for service in ("supabase-db:", "supabase-meta:", "supabase-studio:"):
            self.assertIn(service, supabase)
        self.assertIn("MERV_DB_URL: postgresql://merv_app:", supabase)
        self.assertIn("127.0.0.1:${MERV_DB_SUPABASE_STUDIO_PORT", supabase)
        self.assertIn("127.0.0.1:${MERV_DB_SUPABASE_POSTGRES_PORT", supabase)
        self.assertNotIn("supabase-storage:", supabase)
        self.assertNotIn("supabase-auth:", supabase)

        bootstrap = (DEPLOY / "supabase" / "bootstrap.sql").read_text(encoding="utf-8")
        hosted = (DEPLOY / "supabase" / "hosted-bootstrap.sql").read_text(
            encoding="utf-8"
        )
        for sql in (bootstrap, hosted):
            self.assertIn("merv_app", sql)
            self.assertIn("SCHEMA public", sql)
            self.assertIn("NOBYPASSRLS", sql)
        defaults = (DEPLOY / "supabase" / "app-default-privileges.sql").read_text(
            encoding="utf-8"
        )
        self.assertIn("ALTER DEFAULT PRIVILEGES", defaults)
        self.assertIn("authenticated", defaults)

    def test_compose_does_not_override_provider_env_file_with_empty_secrets(self) -> None:
        text = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
        for var in (
            "MERV_LAMBDA_API_KEY:",
            "RESEARCH_PLUGIN_LAMBDA_API_KEY:",
            "LAMBDA_LABS_API_KEY:",
            "LAMBDA_API_KEY:",
            "MERV_THUNDER_API_KEY:",
            "RESEARCH_PLUGIN_THUNDER_API_KEY:",
            "THUNDER_COMPUTE_API_KEY:",
            "MODAL_TOKEN_ID:",
            "MODAL_TOKEN_SECRET:",
            "HF_TOKEN:",
            "HUGGING_FACE_HUB_TOKEN:",
        ):
            with self.subTest(variable=var):
                self.assertNotIn(var, text)

    def test_env_example_documents_control_matrix(self) -> None:
        text = (DEPLOY / ".env.example").read_text(encoding="utf-8")
        for var in (
            "MERV_MODE",
            "MERV_DB_URL",
            "MERV_BLOB_BUCKET",
            "MERV_MGMT_KEY_PATH",
            "MERV_MGMT_PUBLIC_KEY",
            "MERV_ALLOWED_ORIGINS",
            "MERV_EXECUTION_BACKEND",
            "MERV_REQUIRE_SANDBOX_BACKEND",
            "MERV_PROVIDER_ENV_FILE",
            "MERV_LAMBDA_API_KEY",
            "AWS_ENDPOINT_URL_S3",
        ):
            self.assertIn(var, text)
        self.assertNotIn("mlflow", text.lower())

    def test_doctor_script_covers_startup_readiness_sweep(self) -> None:
        text = (DEPLOY / "doctor.py").read_text(encoding="utf-8")
        for token in (
            "/api/meta",
            "/api/sandboxes/health",
            "sandbox.options",
            "storage.put_object",
            "storage.complete_upload",
            "RP_DOCTOR_URL_REWRITE",
            "RP_DOCTOR_BEARER_TOKEN",
            "Authorization",
        ):
            self.assertIn(token, text)
        self.assertNotIn("mlflow", text.lower())

    def test_database_preflight_checks_merv_postgres_requirements(self) -> None:
        text = (DEPLOY / "db_preflight.py").read_text(encoding="utf-8")
        for token in (
            "MERV_DB_URL",
            "6543",
            "public",
            "pg_try_advisory_lock",
            "CREATE TABLE",
            "--require-tls",
        ):
            self.assertIn(token, text)

    def test_no_real_secrets_committed(self) -> None:
        # .env.example must only carry placeholders, never a filled-in token.
        text = (DEPLOY / ".env.example").read_text(encoding="utf-8")
        self.assertIn("CHANGE_ME", text)
        # No real HF token prefix (hf_<chars>) in the example file.
        import re

        self.assertIsNone(
            re.search(r"\bhf_[A-Za-z0-9]{8,}", text),
            "deploy/.env.example appears to contain a real HF token",
        )
        # Dockerfile.dockerignore is the file Docker actually uses when the
        # context is merv/ and the Dockerfile is deploy/Dockerfile.
        for name in (".dockerignore", "Dockerfile.dockerignore"):
            ignore = (DEPLOY / name).read_text(encoding="utf-8")
            self.assertIn(".env", ignore)
            self.assertIn(".env.*", ignore)
            self.assertIn("credentials.json", ignore)
            self.assertIn("research_state_ui/", ignore)


if __name__ == "__main__":
    unittest.main()
