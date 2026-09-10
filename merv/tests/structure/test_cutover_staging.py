"""Exercise preparation and grant validation without Docker or real credentials."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    "cutover_staging",
    Path(__file__).resolve().parents[2] / "deploy" / "stage_sandboxes_cutover.py",
)
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


def plan():
    return {
        "version": 1,
        "service_url": "https://infra.example",
        "application_id": "research",
        "projects": {
            "proj_one": {
                "namespace": "team-one",
                "account_id": "acct_destination",
                "subjects": {"user-one": "member-one", "user-two": "member-two"},
            }
        },
        "host_provider_namespaces": {"lambda": ["team-one"]},
    }


def prepared(tmp_path, environment="MERV_BLOB_BUCKET='research-artifacts'\n"):
    directory = tmp_path / "prepared"
    directory.mkdir(mode=0o700)
    raw = json.dumps(plan())
    staging.protected_write(directory / "approved-plan.json", raw)
    staging.protected_write(directory / "merv-base.env", environment)
    staging.protected_write(
        directory / "staging-summary.json",
        json.dumps(
            {
                "plan_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                "artifacts": {
                    path.name: staging.file_evidence(path)
                    for path in directory.iterdir()
                },
            }
        ),
    )
    return directory


def connections():
    return {"proj_one": {"namespace": "team-one", "token": "sbxt_private_credential"}}


def identity(request):
    assert (
        request.method == "GET"
        and str(request.url) == "https://infra.example/v1/auth/me"
    )
    assert request.headers["X-Sandbox-Namespace"] == "team-one"
    assert request.headers["Authorization"] == "Bearer sbxt_private_credential"
    subject = request.headers["X-Sandbox-Subject"]
    return {
        "role": "consumer",
        "namespace": "team-one",
        "account_id": "acct_destination",
        "application_id": "research",
        "member_id": plan()["projects"]["proj_one"]["subjects"][subject],
    }


def test_finalize_checks_every_subject_then_writes_only_private_connection_artifacts(
    tmp_path,
):
    directory = prepared(tmp_path)
    seen = []

    def handler(request):
        seen.append(request.headers["X-Sandbox-Subject"])
        return httpx.Response(200, json=identity(request))

    report = staging.finalize(
        directory, connections(), transport=httpx.MockTransport(handler)
    )
    assert seen == ["user-one", "user-two"]
    assert "private_credential" not in str(report)
    activation = directory / "activation"
    assert activation.stat().st_mode & 0o777 == 0o700
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in activation.iterdir())
    assert json.loads((activation / "connections.json").read_text()) == connections()
    environment = (activation / "merv.env").read_text()
    assert (
        "MERV_BLOB_BUCKET" in environment
        and "MERV_SANDBOXES_CONNECTIONS_FILE" in environment
    )
    assert "private_credential" not in environment and "JWT" not in environment
    overlay = json.loads((activation / "merv-connection-overlay.json").read_text())
    assert overlay["secrets"]["merv_sandbox_connections"]["file"] == str(
        activation / "connections.json"
    )
    with pytest.raises(ValueError, match="already exists"):
        staging.finalize(
            directory, connections(), transport=httpx.MockTransport(handler)
        )


@pytest.mark.parametrize(
    "change",
    ["role", "account_id", "member_id", "namespace", "application_id", "revoked"],
)
def test_invalid_destination_authority_never_publishes_activation(tmp_path, change):
    directory = prepared(tmp_path)

    def handler(request):
        result = identity(request)
        # Reject the last member, after an earlier member already passed.
        if request.headers["X-Sandbox-Subject"] == "user-two":
            if change == "revoked":
                return httpx.Response(401, json={"error": "private_credential"})
            result[change] = "wrong"
        return httpx.Response(200, json=result)

    with pytest.raises(ValueError):
        staging.finalize(
            directory, connections(), transport=httpx.MockTransport(handler)
        )
    assert not (directory / "activation").exists()
    assert not (directory / "activation.pending").exists()


def test_incomplete_or_changed_preparation_cannot_be_finalized(tmp_path):
    directory = prepared(tmp_path)
    changed = plan()
    changed["application_id"] = "different"
    (directory / "approved-plan.json").write_text(json.dumps(changed))
    with pytest.raises(ValueError, match="changed"):
        staging.finalize(directory, connections())
    (directory / "staging-summary.json").unlink()
    with pytest.raises(ValueError, match="did not complete"):
        staging.finalize(directory, connections())


@pytest.mark.parametrize("changed", ["modify", "remove", "old_summary"])
def test_changed_preparation_evidence_fails_before_authentication(tmp_path, changed):
    directory = prepared(tmp_path)
    if changed == "modify":
        (directory / "merv-base.env").write_text("modified")
    elif changed == "remove":
        (directory / "merv-base.env").unlink()
    else:
        path = directory / "staging-summary.json"
        summary = json.loads(path.read_text())
        del summary["artifacts"]
        path.write_text(json.dumps(summary))
    with pytest.raises(ValueError, match="artifact|backup evidence"):
        staging.finalize(directory, connections())
    assert not (directory / "activation").exists()


@pytest.mark.parametrize(
    "changed",
    [
        "incomplete",
        "container",
        "database",
        "file",
        "volume",
        "extra-traversal",
        "extra-relative",
        "extra-collision",
    ],
)
def test_invalid_custom_sources_never_fall_back_to_the_original_host(tmp_path, changed):
    reviewed = plan()
    deployment = {
        "containers": {
            "merv": "test-merv",
            "native": "test-native",
            "worker": "test-worker",
        },
        "databases": {
            "merv": {
                "container": "test-merv-db",
                "user": "postgres",
                "database": "merv",
            },
            "native": {
                "container": "test-native-db",
                "user": "postgres",
                "database": "native",
            },
        },
        "files": {
            name: str(tmp_path / name)
            for name in {*staging.DEFAULT_FILES, "native-original.env"}
        },
        "volumes": {
            "native-data": "test-native-data",
            "merv-management": "test-management",
        },
    }
    reviewed["deployment"] = deployment
    if changed == "incomplete":
        del deployment["databases"]
    elif changed == "container":
        deployment["containers"]["native"] = "--unsafe"
    elif changed == "database":
        del deployment["databases"]["native"]["user"]
    elif changed == "file":
        deployment["files"]["native-original.env"] = "relative.env"
    elif changed == "volume":
        del deployment["volumes"]["native-data"]
    else:
        deployment["additional_files"] = {
            "extra-traversal": {"extra-../../escape": "/srv/overlay.json"},
            "extra-relative": {"extra-overlay.json": "relative.json"},
            "extra-collision": {"approved-plan.json": "/srv/overlay.json"},
        }[changed]
    destination = tmp_path / "must-not-be-created"
    with pytest.raises(ValueError):
        staging.prepare(destination, reviewed)
    assert not destination.exists()


@pytest.mark.parametrize("extra_configuration", [False, True])
def test_preparation_preserves_backups_and_artifact_settings_without_minting_grants(
    tmp_path, monkeypatch, capsys, extra_configuration
):
    old_env = [
        "MERV_DB_URL=postgresql://private",
        "MERV_BLOB_BUCKET=research-artifacts",
        "MERV_BLOB_SECRET_ACCESS_KEY=artifact-secret",
        "MERV_STORAGE_MAX_UPLOAD_BYTES=123456",
        "LAMBDA_LABS_API_KEY=provider-secret",
        "MERV_SANDBOXES_JWT_SECRET=retired-secret",
    ]

    def run(*command, **kwargs):
        if command[:2] == ("docker", "inspect"):
            return json.dumps(
                [
                    {
                        "Image": "sha256:old-image",
                        "Config": {
                            "Env": old_env if command[2] == "deploy-control-1" else [],
                            "Labels": {
                                "com.docker.compose.project.working_dir": str(tmp_path)
                            },
                        },
                    }
                ]
            )
        if command[:3] == ("docker", "volume", "inspect"):
            return str(tmp_path)
        if "pg_restore" in command:
            return "archive contents"
        if command[:2] == ("docker", "tag"):
            return ""
        if command[:3] == ("docker", "exec", "-i"):
            return json.dumps(
                [
                    {
                        "project_id": "proj_one",
                        "provider": "gcp",
                        "enabled": True,
                        "verified_at": "past",
                        "credentials": {
                            "MERV_GCP_PROJECT": "cloud-project",
                            "MERV_GCP_SERVICE_ACCOUNT_JSON": "private-service-account",
                        },
                    }
                ]
            )
        raise AssertionError(command)

    def subprocess_run(command, **kwargs):
        if command[0] == "tar":
            Path(command[2]).write_bytes(b"archive")
        else:
            kwargs["stdout"].write(b"database backup")

    monkeypatch.setattr(staging, "run", run)
    monkeypatch.setattr(staging.subprocess, "run", subprocess_run)
    monkeypatch.setattr(
        staging.shutil, "copyfile", lambda source, target: target.write_text("original")
    )
    previous_mask = os.umask(0o022)
    directory = tmp_path / "stage"
    reviewed = plan()
    if extra_configuration:
        reviewed["deployment"] = {
            "containers": {
                "merv": "deploy-control-1",
                "native": "sandboxes-control-1",
                "worker": "sandboxes-pipelines-worker-1",
            },
            "databases": {
                "merv": {
                    "container": "merv-db",
                    "user": "postgres",
                    "database": "merv",
                },
                "native": {
                    "container": "native-db",
                    "user": "sandboxes",
                    "database": "sandboxes",
                },
            },
            "volumes": {"native-data": "native-data", "merv-management": "management"},
            "files": {
                name: str(tmp_path / name)
                for name in {*staging.DEFAULT_FILES, "native-original.env"}
            },
            "additional_files": {
                "extra-active-overlay.json": str(tmp_path / "active.json")
            },
        }
    try:
        staging.prepare(directory, reviewed)
    finally:
        os.umask(previous_mask)
    assert directory.stat().st_mode & 0o777 == 0o700
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in directory.iterdir())
    assert (directory / "merv-base.env").read_text().find("artifact-secret") >= 0
    assert (
        "MERV_STORAGE_MAX_UPLOAD_BYTES='123456'"
        in (directory / "merv-base.env").read_text()
    )
    additions = json.loads((directory / "native-provider-additions.json").read_text())
    assert additions[0]["namespaces"] == ["team-one"]
    assert "SANDBOXES_PROVIDERS" not in (directory / "native-provider.env").read_text()
    owned = json.loads((directory / "native-own-provider-import.json").read_text())
    assert (
        owned[0]["namespace"] == "team-one"
        and owned[0]["account_id"] == "acct_destination"
    )
    assert "verified" not in owned[0]
    assert not (directory / "activation").exists()
    if extra_configuration:
        extra = directory / "extra-active-overlay.json"
        assert extra.read_text() == "original"
        summary = json.loads((directory / "staging-summary.json").read_text())
        assert summary["artifacts"][extra.name] == staging.file_evidence(extra)
        extra.write_text("changed after review")
        with pytest.raises(ValueError, match="artifact"):
            staging.finalize(directory, connections())
        assert not (directory / "activation").exists()
    assert "secret" not in capsys.readouterr().out


def test_generated_overlay_resolves_with_reference_compose_without_changing_auth(
    tmp_path,
):
    import shutil
    import subprocess

    if not shutil.which("docker"):
        pytest.skip("Docker Compose configuration parser is unavailable")
    values = {
        "MERV_BLOB_BUCKET": "research-artifacts",
        "MERV_BLOB_ENDPOINT_URL": "https://objects.example",
        "MERV_BLOB_ACCESS_KEY_ID": "test-access",
        "MERV_BLOB_SECRET_ACCESS_KEY": "test-secret${literal}",
        "MERV_DB_URL": "postgresql://user:password@database/research",
        "MERV_WAIT_SECRET": "test-wait-key",
        "SUPABASE_URL": "https://auth.example",
    }
    directory = prepared(
        tmp_path, "".join(staging.env_line(key, value) for key, value in values.items())
    )
    staging.finalize(
        directory,
        connections(),
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=identity(request))
        ),
    )
    activation = directory / "activation"
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("MERV_", "SUPABASE_"))
    }
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(activation / "merv.env"),
            "-f",
            str(Path(__file__).resolve().parents[2] / "deploy" / "docker-compose.yml"),
            "-f",
            str(activation / "merv-connection-overlay.json"),
            "config",
            "--format",
            "json",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    rendered = json.loads(result.stdout)
    interpolation = subprocess.run(
        [*result.args[:-2], "--environment"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert interpolation.returncode == 0, interpolation.stderr
    interpolated_values = dict(
        line.split("=", 1) for line in interpolation.stdout.splitlines() if "=" in line
    )
    environment = rendered["services"]["control"]["environment"]
    for key, value in values.items():
        assert interpolated_values[key] == value
        # `config` emits a reusable Compose document, escaping literal dollars.
        assert environment[key] == value.replace("$", "$$")
    assert (
        environment["MERV_SANDBOXES_CONNECTIONS_FILE"]
        == "/run/secrets/merv_sandbox_connections"
    )
    assert rendered["secrets"]["merv_sandbox_connections"]["file"] == str(
        activation / "connections.json"
    )
