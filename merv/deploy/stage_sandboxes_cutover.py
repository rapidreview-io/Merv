#!/usr/bin/env python3
"""Stage restricted backups and credential/configuration transfers on the Docker host.

This makes no service restart, database import, or sandbox/storage mutation.
Run as the deployment operator with Docker and source-volume read access.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


def run(*command: str, **kwargs: Any) -> str:
    kwargs.setdefault("stderr", subprocess.PIPE)
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


def validate_plan(plan: dict[str, Any]) -> None:
    """The deployment operator supplies identities; names never imply ownership."""
    if (
        plan.get("version") != 1
        or not plan.get("projects")
        or not plan.get("application_id")
    ):
        raise ValueError("version 1, application_id and explicit projects are required")
    origin = urlsplit(plan.get("service_url", ""))
    if (
        origin.scheme != "https"
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.path not in {"", "/"}
        or origin.query
        or origin.fragment
    ):
        raise ValueError("service_url must be an HTTPS origin")
    namespaces = set()
    for project_id, entry in plan["projects"].items():
        if (
            not re.fullmatch(r"[A-Za-z0-9_.-]+", project_id)
            or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", entry.get("namespace", ""))
            or not entry.get("account_id")
            or not entry.get("subjects")
            or any(
                not subject or not member
                for subject, member in entry["subjects"].items()
            )
        ):
            raise ValueError(
                "each project needs a namespace, account and subject/member mapping"
            )
        if entry["namespace"] in namespaces:
            raise ValueError("projects must have distinct namespaces")
        namespaces.add(entry["namespace"])
    for provider, selected in plan.get("host_provider_namespaces", {}).items():
        if provider not in {"lambda", "thunder_compute"} or not isinstance(
            selected, list
        ):
            raise ValueError("unsupported host provider transfer")
        if not set(selected) <= namespaces:
            raise ValueError("host provider scope must use reviewed namespaces")
    if "deployment" in plan:
        deployment = plan["deployment"]
        required = {
            "containers",
            "databases",
            "files",
            "volumes",
        }
        if (
            not isinstance(deployment, dict)
            or not required <= set(deployment)
            or set(deployment) - required - {"additional_files"}
        ):
            raise ValueError(
                "custom deployment must specify all source containers, databases, files and volumes"
            )
        if set(deployment["containers"]) != {"merv", "native", "worker"} or set(
            deployment["databases"]
        ) != {"merv", "native"}:
            raise ValueError("custom deployment source roles are incomplete")
        names = list(deployment["containers"].values())
        for database in deployment["databases"].values():
            if set(database) != {"container", "user", "database"}:
                raise ValueError(
                    "database source requires container, user and database"
                )
            names.extend(database.values())
        if (
            len(set(deployment["containers"].values())) != 3
            or len({row["container"] for row in deployment["databases"].values()}) != 2
        ):
            raise ValueError(
                "source application and database containers must be distinct within their roles"
            )
        if set(deployment["volumes"]) != {"native-data", "merv-management"}:
            raise ValueError("custom deployment must name both retained volumes")
        names.extend(deployment["volumes"].values())
        if any(
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name)
            for name in names
        ):
            raise ValueError("invalid source container, database or volume identifier")
        if set(deployment["files"]) != set(DEFAULT_FILES) | {"native-original.env"}:
            raise ValueError(
                "custom deployment must name every retained configuration file"
            )
        if any(
            not isinstance(value, str) or not Path(value).is_absolute()
            for value in deployment["files"].values()
        ):
            raise ValueError("source configuration files require absolute paths")
        additional = deployment.get("additional_files", {})
        if not isinstance(additional, dict) or any(
            not isinstance(name, str)
            or not re.fullmatch(r"extra-[A-Za-z0-9][A-Za-z0-9_.-]*", name)
            or not isinstance(source, str)
            or not Path(source).is_absolute()
            for name, source in additional.items()
        ):
            raise ValueError(
                "additional configuration requires extra-prefixed filenames and absolute source paths"
            )


DEFAULT_FILES = {
    "merv-provider-original.env": "/home/azureuser/research-suite-vm/provider-secrets.env",
    "merv-supabase-original.env": "/home/azureuser/research-suite-vm/supabase-db.env",
    "merv-compose-original.yml": "/home/azureuser/research-suite-vm/docker-compose.azure.yml",
    "merv-launcher-original.sh": "/home/azureuser/research-suite-vm/control-up.sh",
    "Caddyfile-original": "/etc/caddy/Caddyfile",
}


def file_evidence(path: Path) -> dict[str, Any]:
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    return {"sha256": checksum, "bytes": path.stat().st_size}


def prepare(directory: Path, plan: dict[str, Any]) -> None:
    validate_plan(plan)
    os.umask(0o077)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    protected_write(directory / "approved-plan.json", json.dumps(plan, indent=2))
    deployment = plan.get("deployment")
    containers = (
        deployment["containers"]
        if deployment
        else {
            "merv": "deploy-control-1",
            "native": "sandboxes-control-1",
            "worker": "sandboxes-pipelines-worker-1",
        }
    )
    databases = (
        deployment["databases"]
        if deployment
        else {
            "merv": {
                "container": "deploy-supabase-db-1",
                "user": "postgres",
                "database": "postgres",
            },
            "native": {
                "container": "sandboxes-postgres-1",
                "user": "sandboxes",
                "database": "sandboxes",
            },
        }
    )
    snapshots = {}
    for name in containers.values():
        snapshot = json.loads(run("docker", "inspect", name))[0]
        snapshots[name] = snapshot
        protected_write(
            directory / f"{name}.inspect.json", json.dumps(snapshot, indent=2)
        )
    old = dict(
        entry.split("=", 1) for entry in snapshots[containers["merv"]]["Config"]["Env"]
    )
    native = snapshots[containers["native"]]
    for name, snapshot in snapshots.items():
        run(
            "docker",
            "tag",
            snapshot["Image"],
            f"merv-cutover-rollback-{name}:{directory.name}",
        )
    for source in databases.values():
        name, user, database = source["container"], source["user"], source["database"]
        path = directory / f"{name}.dump"
        with path.open("wb") as output:
            subprocess.run(
                ["docker", "exec", name, "pg_dump", "-U", user, "-d", database, "-Fc"],
                stdout=output,
                stderr=subprocess.PIPE,
                check=True,
            )
        with path.open("rb") as source:
            listing = run(
                "docker", "exec", "-i", name, "pg_restore", "--list", stdin=source
            )
        protected_write(path.with_suffix(".toc"), listing)
    copies = (
        {**deployment["files"], **deployment.get("additional_files", {})}
        if deployment
        else {
            **DEFAULT_FILES,
            "native-original.env": str(
                Path(
                    native["Config"]["Labels"]["com.docker.compose.project.working_dir"]
                )
                / ".env"
            ),
        }
    )
    for name, source in copies.items():
        shutil.copyfile(source, directory / name)
        (directory / name).chmod(0o600)
    volumes = (
        deployment["volumes"]
        if deployment
        else {
            "native-data": "sandboxes_sandboxes-data",
            "merv-management": "deploy_mgmtkey",
        }
    )
    for name, volume in volumes.items():
        # Verify existence first: Docker otherwise creates an empty missing volume.
        run("docker", "volume", "inspect", volume)
        with (directory / f"{name}.tar.gz").open("wb") as output:
            subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--pull",
                    "never",
                    "--network",
                    "none",
                    "--user",
                    "0",
                    "--mount",
                    f"type=volume,source={volume},target=/source,readonly",
                    "--entrypoint",
                    "tar",
                    native["Image"],
                    "-czf",
                    "-",
                    "-C",
                    "/source",
                    ".",
                ],
                stdout=output,
                stderr=subprocess.PIPE,
                check=True,
            )
    providers = []
    provider_env = ""
    for name, plugin, source_key, destination_key in [
        ("lambda", "lambda", "LAMBDA_LABS_API_KEY", "IMPORTED_LAMBDA_KEY"),
        (
            "thunder_compute",
            "thunder_compute",
            "THUNDER_COMPUTE_API_KEY",
            "IMPORTED_THUNDER_KEY",
        ),
    ]:
        if not old.get(source_key):
            continue
        if name not in plan.get("host_provider_namespaces", {}):
            raise ValueError(
                "each existing host credential needs an explicit namespace selection"
            )
        providers.append(
            {
                "name": name,
                "plugin": plugin,
                "credential": "env:" + destination_key,
                "namespaces": plan["host_provider_namespaces"][name],
            }
        )
        provider_env += env_line(destination_key, old[source_key])
    protected_write(directory / "native-provider.env", provider_env)
    protected_write(
        directory / "native-provider-additions.json", json.dumps(providers, indent=2)
    )
    # Preserve Merv's own research artifact storage. Heavy infrastructure storage
    # settings belong to the native deployment and are not rewritten here.
    keep = [key for key in old if key.startswith(("SUPABASE_", "MERV_BLOB_"))] + [
        "MERV_DB_URL",
        "MERV_ADMIN_TOKEN",
        "MERV_ALLOWED_ORIGINS",
        "MERV_UI_BASE_URL",
        "MERV_OAUTH_RESOURCE_URI",
        "MERV_REQUIRE_AUTH",
        "MERV_ALLOW_OPEN_CONTROL",
        "MERV_WAIT_SECRET",
        "MERV_STORAGE_MAX_UPLOAD_BYTES",
    ]
    merv_env = {key: old[key] for key in keep if key in old}
    protected_write(
        directory / "merv-base.env",
        "".join(env_line(k, v) for k, v in merv_env.items()),
    )
    native_overlay = {
        "services": {
            name: {"env_file": [str(directory / "native-provider.env")]}
            for name in ["control", "pipelines-worker"]
        }
    }
    protected_write(
        directory / "native-provider-env-overlay.json",
        json.dumps(native_overlay, indent=2),
    )
    extractor = """import json,os,psycopg
with psycopg.connect(os.environ['MERV_DB_URL']) as db:
 rows=db.execute('select project_id,provider,credentials,enabled,credential_mode,verified_at from sandbox_provider_settings').fetchall()
print(json.dumps([dict(project_id=r[0],provider=r[1],credentials=json.loads(r[2] or '{}'),enabled=bool(r[3]),credential_mode=r[4],verified_at=r[5]) for r in rows]))
"""
    raw = run(
        "docker", "exec", "-i", containers["merv"], "python", "-", input=extractor
    )
    legacy_providers = json.loads(raw)
    protected_write(directory / "legacy-provider-settings.json", raw)
    own = []
    for record in legacy_providers:
        creds = record["credentials"]
        if not creds:
            continue
        if record.get("credential_mode") not in {None, "", "own"}:
            raise ValueError(
                "saved credentials with non-own mode need explicit migration review"
            )
        target = plan["projects"].get(record["project_id"])
        if target is None:
            raise ValueError(
                "every credential-bearing project needs reviewed ownership"
            )
        if record["provider"] != "gcp" or set(creds) - {
            "MERV_GCP_PROJECT",
            "MERV_GCP_SERVICE_ACCOUNT_JSON",
        }:
            raise ValueError(
                "provider credential translation needs explicit implementation"
            )
        own.append(
            {
                "namespace": target["namespace"],
                "account_id": target["account_id"],
                "name": "gcp",
                "plugin": "gcp",
                "fields": {
                    "service_account_json": creds["MERV_GCP_SERVICE_ACCOUNT_JSON"]
                },
                "settings": {"project": creds["MERV_GCP_PROJECT"]},
                "access": "inbound",
                "enabled": record["enabled"],
            }
        )
    protected_write(directory / "native-own-provider-import.json", json.dumps(own))
    summary = {
        "stage_directory": str(directory),
        "plan_sha256": hashlib.sha256(
            (directory / "approved-plan.json").read_bytes()
        ).hexdigest(),
        "backups": [p.name for p in directory.glob("*.dump")],
        "rollback_images": {name: value["Image"] for name, value in snapshots.items()},
        "shared_providers": [p["name"] for p in providers],
        "shared_provider_namespaces": {p["name"]: p["namespaces"] for p in providers},
        "own_providers": [
            {k: p[k] for k in ["namespace", "name", "enabled"]} for p in own
        ],
        "services_restarted": False,
        "databases_imported": False,
        "artifacts": {
            path.name: file_evidence(path)
            for path in sorted(directory.iterdir())
            if path.is_file()
        },
    }
    protected_write(directory / "staging-summary.json", json.dumps(summary, indent=2))
    print(json.dumps(summary))


def finalize(
    directory: Path, connections: dict[str, Any], *, transport=None
) -> dict[str, Any]:
    """Read actual destination grants, then write reviewable activation files.

    This step follows account import and owner grant issuance. It does not mint
    tokens, edit policies, install secrets in a running service or restart it.
    """
    import httpx

    if not directory.is_dir() or directory.stat().st_mode & 0o077:
        raise ValueError("staging directory must be private (mode 0700)")
    plan_bytes = (directory / "approved-plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    validate_plan(plan)
    # A partial preparation must not produce activation files.
    if not (directory / "staging-summary.json").is_file():
        raise ValueError("preparation did not complete")
    prepared = json.loads((directory / "staging-summary.json").read_text())
    if prepared.get("plan_sha256") != hashlib.sha256(plan_bytes).hexdigest():
        raise ValueError("reviewed plan changed after preparation")
    artifacts = prepared.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise ValueError("preparation lacks backup evidence; capture a new stage")
    for name, evidence in artifacts.items():
        if (
            Path(name).name != name
            or not (directory / name).is_file()
            or file_evidence(directory / name) != evidence
        ):
            raise ValueError("a prepared artifact is missing or changed")
    if set(connections) != set(plan["projects"]):
        raise ValueError("connections must cover exactly the reviewed projects")
    for project, entry in connections.items():
        if (
            not isinstance(entry, dict)
            or set(entry) != {"namespace", "token"}
            or entry["namespace"] != plan["projects"][project]["namespace"]
            or not isinstance(entry["token"], str)
            or not re.fullmatch(r"sbxt_[A-Za-z0-9_-]+", entry["token"])
        ):
            raise ValueError("invalid consumer connection for reviewed project")
    destination = directory / "activation"
    if destination.exists():
        raise ValueError(
            "activation already exists; use a new reviewed stage for rotation"
        )
    verified = []
    with httpx.Client(
        timeout=30, follow_redirects=False, transport=transport
    ) as client:
        for project, entry in connections.items():
            expected = plan["projects"][project]
            for subject, member in expected["subjects"].items():
                response = client.get(
                    plan["service_url"].rstrip("/") + "/v1/auth/me",
                    headers={
                        "Authorization": "Bearer " + entry["token"],
                        "X-Sandbox-Namespace": entry["namespace"],
                        "X-Sandbox-Subject": subject,
                    },
                )
                if response.status_code != 200:
                    raise ValueError("destination grant authentication failed")
                identity = response.json()
                required = {
                    "role": "consumer",
                    "namespace": entry["namespace"],
                    "account_id": expected["account_id"],
                    "member_id": member,
                    "application_id": plan["application_id"],
                }
                if any(identity.get(key) != value for key, value in required.items()):
                    raise ValueError(
                        "destination grant does not match reviewed ownership"
                    )
                verified.append({"project_id": project, "subject": subject, **required})
    # Publish the directory only once every request and file write succeeds.
    temporary = directory / "activation.pending"
    temporary.mkdir(mode=0o700, exist_ok=False)
    try:
        protected_write(
            temporary / "connections.json", json.dumps(connections, indent=2)
        )
        environment = (directory / "merv-base.env").read_text()
        environment += env_line("MERV_SANDBOXES_URL", plan["service_url"])
        environment += env_line(
            "MERV_SANDBOXES_CONNECTIONS_FILE", "/run/secrets/merv_sandbox_connections"
        )
        protected_write(temporary / "merv.env", environment)
        overlay = {
            "services": {
                "control": {
                    "env_file": [str(destination / "merv.env")],
                    "environment": {
                        "MERV_SANDBOXES_URL": plan["service_url"],
                        "MERV_SANDBOXES_CONNECTIONS_FILE": "/run/secrets/merv_sandbox_connections",
                    },
                    "secrets": ["merv_sandbox_connections"],
                }
            },
            "secrets": {
                "merv_sandbox_connections": {
                    "file": str(destination / "connections.json")
                }
            },
        }
        protected_write(
            temporary / "merv-connection-overlay.json", json.dumps(overlay, indent=2)
        )
        report = {
            "plan_sha256": hashlib.sha256(plan_bytes).hexdigest(),
            "verified": verified,
            "services_restarted": False,
            "databases_imported": False,
        }
        protected_write(temporary / "verification.json", json.dumps(report, indent=2))
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    preparation = sub.add_parser("prepare")
    preparation.add_argument("--stage-directory", type=Path, required=True)
    preparation.add_argument("--plan", type=Path, required=True)
    activation = sub.add_parser("finalize")
    activation.add_argument("--stage-directory", type=Path, required=True)
    activation.add_argument("--connections", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.stage_directory.resolve(), json.loads(args.plan.read_text()))
        else:
            print(
                json.dumps(
                    finalize(
                        args.stage_directory.resolve(),
                        json.loads(args.connections.read_text()),
                    )
                )
            )
    except Exception as exc:  # noqa: BLE001 - never echo credential-bearing tool errors
        # Exception messages from Docker, HTTP or credential parsing can contain
        # secrets. Keep diagnostics structural; private backup files retain detail.
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}))
        raise SystemExit(1)
