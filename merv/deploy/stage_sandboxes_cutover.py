#!/usr/bin/env python3
"""Stage restricted backups and credential/configuration transfers on the Docker host.

This makes no service restart, database import, or sandbox/storage mutation.
Run as the deployment operator with Docker and source-volume read access.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path
from typing import Any


def run(*command: str, **kwargs: Any) -> str:
    return subprocess.check_output(command, text=True, **kwargs)


def protected_write(path: Path, content: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(content)


def env_line(key: str, value: str) -> str:
    if "\n" in value or "\r" in value or "'" in value:
        raise ValueError(
            "multiline/quoted configuration requires an explicit operator encoding"
        )
    return f"{key}='{value}'\n"


def stage(directory: Path) -> None:
    os.umask(0o077)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    snapshots = {}
    for name in [
        "deploy-control-1",
        "sandboxes-control-1",
        "sandboxes-pipelines-worker-1",
    ]:
        snapshot = json.loads(run("docker", "inspect", name))[0]
        snapshots[name] = snapshot
        protected_write(
            directory / f"{name}.inspect.json", json.dumps(snapshot, indent=2)
        )
    old = dict(
        entry.split("=", 1) for entry in snapshots["deploy-control-1"]["Config"]["Env"]
    )
    native = snapshots["sandboxes-control-1"]
    native_release = Path(
        native["Config"]["Labels"]["com.docker.compose.project.working_dir"]
    )
    for name, snapshot in snapshots.items():
        run(
            "docker",
            "tag",
            snapshot["Image"],
            f"merv-cutover-rollback-{name}:{directory.name}",
        )
    for name, user in [
        ("deploy-supabase-db-1", "postgres"),
        ("sandboxes-postgres-1", "sandboxes"),
    ]:
        database = "postgres" if user == "postgres" else "sandboxes"
        path = directory / f"{name}.dump"
        with path.open("wb") as output:
            subprocess.run(
                ["docker", "exec", name, "pg_dump", "-U", user, "-d", database, "-Fc"],
                stdout=output,
                check=True,
            )
        with path.open("rb") as source:
            listing = run(
                "docker", "exec", "-i", name, "pg_restore", "--list", stdin=source
            )
        protected_write(path.with_suffix(".toc"), listing)
    copies = {
        "native-original.env": native_release / ".env",
        "merv-provider-original.env": Path(
            "/home/azureuser/research-suite-vm/provider-secrets.env"
        ),
        "merv-supabase-original.env": Path(
            "/home/azureuser/research-suite-vm/supabase-db.env"
        ),
        "merv-compose-original.yml": Path(
            "/home/azureuser/research-suite-vm/docker-compose.azure.yml"
        ),
        "merv-launcher-original.sh": Path(
            "/home/azureuser/research-suite-vm/control-up.sh"
        ),
        "Caddyfile-original": Path("/etc/caddy/Caddyfile"),
    }
    for name, source in copies.items():
        shutil.copyfile(source, directory / name)
        (directory / name).chmod(0o600)
    for name, volume in [
        ("native-data", "sandboxes_sandboxes-data"),
        ("merv-management", "deploy_mgmtkey"),
    ]:
        mount = run(
            "docker", "volume", "inspect", volume, "--format", "{{.Mountpoint}}"
        ).strip()
        subprocess.run(
            ["tar", "-czf", str(directory / f"{name}.tar.gz"), "-C", mount, "."],
            check=True,
        )
    token = secrets.token_urlsafe(48)
    providers = []
    provider_env = ""
    for name, plugin, source_key, destination_key in [
        ("lambda", "lambda", "LAMBDA_LABS_API_KEY", "MERV_SHARED_LAMBDA_KEY"),
        (
            "thunder_compute",
            "thunder_compute",
            "THUNDER_COMPUTE_API_KEY",
            "MERV_SHARED_THUNDER_KEY",
        ),
    ]:
        if not old.get(source_key):
            continue
        providers.append(
            {
                "name": name,
                "plugin": plugin,
                "credential": "env:" + destination_key,
                "namespace_prefixes": ["merv-project-"],
            }
        )
        provider_env += env_line(destination_key, old[source_key])
    provider_env += env_line(
        "SANDBOXES_PROVIDERS", json.dumps(providers, separators=(",", ":"))
    )
    protected_write(directory / "native-provider.env", provider_env)
    original = (directory / "native-original.env").read_text()
    replacements = {
        "SANDBOXES_MERV_JWT_SECRET": token,
        "SANDBOXES_STORAGE__ADOPTED_BUCKETS": json.dumps([old["MERV_STORAGE_BUCKET"]]),
        "SANDBOXES_STORAGE__NAMESPACE_MAX_BYTES": str(5 * 1024**4),
    }
    retained = [
        line
        for line in original.splitlines()
        if line.split("=", 1)[0] not in replacements
    ]
    protected_write(
        directory / "native.env",
        "\n".join(retained)
        + "\n"
        + "".join(env_line(k, v) for k, v in replacements.items()),
    )
    keep = [key for key in old if key.startswith("SUPABASE_")] + [
        "MERV_DB_URL",
        "MERV_ADMIN_TOKEN",
        "MERV_ALLOWED_ORIGINS",
        "MERV_UI_BASE_URL",
        "MERV_OAUTH_RESOURCE_URI",
        "MERV_REQUIRE_AUTH",
        "MERV_ALLOW_OPEN_CONTROL",
        "MERV_WAIT_SECRET",
    ]
    merv_env = {key: old[key] for key in keep if key in old}
    merv_env.update(
        MERV_SANDBOXES_URL="https://sandboxes.rapidreview.io",
        MERV_SANDBOXES_JWT_SECRET=token,
        MERV_REQUIRE_SANDBOX_BACKEND="1",
    )
    protected_write(
        directory / "merv.env", "".join(env_line(k, v) for k, v in merv_env.items())
    )
    native_overlay = {
        "services": {
            name: {"env_file": [str(directory / "native-provider.env")]}
            for name in ["control", "pipelines-worker"]
        }
    }
    protected_write(
        directory / "native-merv-overlay.json", json.dumps(native_overlay, indent=2)
    )
    merv_overlay = {
        "services": {
            "control": {
                "env_file": [str(directory / "merv.env")],
                "restart": "unless-stopped",
            }
        }
    }
    protected_write(
        directory / "merv-production-overlay.json", json.dumps(merv_overlay, indent=2)
    )
    extractor = """import json,os,psycopg
with psycopg.connect(os.environ['MERV_DB_URL']) as db:
 rows=db.execute('select project_id,provider,credentials,enabled,credential_mode,verified_at from sandbox_provider_settings').fetchall()
print(json.dumps([dict(project_id=r[0],provider=r[1],credentials=json.loads(r[2] or '{}'),enabled=bool(r[3]),credential_mode=r[4],verified_at=r[5]) for r in rows]))
"""
    raw = run(
        "docker", "exec", "-i", "deploy-control-1", "python", "-", input=extractor
    )
    legacy_providers = json.loads(raw)
    protected_write(directory / "legacy-provider-settings.json", raw)
    own = []
    for record in legacy_providers:
        creds = record["credentials"]
        if not creds:
            continue
        if record["provider"] != "gcp" or set(creds) - {
            "MERV_GCP_PROJECT",
            "MERV_GCP_SERVICE_ACCOUNT_JSON",
        }:
            raise ValueError(
                "provider credential translation needs explicit implementation"
            )
        own.append(
            {
                "namespace": "merv-project-" + record["project_id"],
                "name": "gcp",
                "plugin": "gcp",
                "fields": {
                    "service_account_json": creds["MERV_GCP_SERVICE_ACCOUNT_JSON"]
                },
                "settings": {"project": creds["MERV_GCP_PROJECT"]},
                "access": "inbound",
                "enabled": record["enabled"],
                "verified": bool(record["verified_at"]),
            }
        )
    protected_write(directory / "native-own-provider-import.json", json.dumps(own))
    summary = {
        "stage_directory": str(directory),
        "backups": [p.name for p in directory.glob("*.dump")],
        "rollback_images": {name: value["Image"] for name, value in snapshots.items()},
        "shared_providers": [p["name"] for p in providers],
        "shared_namespace_prefix": "merv-project-",
        "own_providers": [
            {k: p[k] for k in ["namespace", "name", "enabled"]} for p in own
        ],
        "services_restarted": False,
        "databases_imported": False,
    }
    protected_write(directory / "staging-summary.json", json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-directory", type=Path, required=True)
    stage(parser.parse_args().stage_directory)
