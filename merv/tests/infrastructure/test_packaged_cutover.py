"""Opt-in full packaged startup/restore check with an isolated fixture network.

Uses an older Merv image to create the complete source research schema. All
credentials are fixtures; the only configured compute provider is native fake.
No host ports are published and the Docker network has no external routing.
"""

import json
import os
import subprocess
import time
import uuid

import unittest
from tempfile import TemporaryDirectory
from pathlib import Path


LEGACY_SEED = """
import inspect,json,os
from merv.brain.kernel.state.dialects import PostgresStateStore
from merv.brain.surface.project_keys import ProjectKeys
assert 'sandbox_seconds_ceiling' in inspect.signature(ProjectKeys.create).parameters
store=PostgresStateStore(dsn=os.environ['MERV_DB_URL'])
stamp='2026-09-01T00:00:00Z'
with store.transaction() as conn:
    conn.execute("INSERT INTO projects (id,name,summary,tenant_id,created_at) VALUES (?,?,?,?,?)",
                 ('proj_restore','Retained research','migration fixture','local',stamp))
    conn.execute("INSERT INTO project_members VALUES (?,?,?)",('proj_restore','user-one',stamp))
    conn.execute("INSERT INTO experiments (id,project_id,name,intent,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                 ('exp_restore','proj_restore','Retained experiment','preserve this claim','planned',stamp,stamp))
    conn.execute("INSERT INTO provider_user_caps (provider,user_id,daily_usd_limit,updated_at) VALUES (?,?,?,?)",
                 ('fake','user-one',0,stamp))
key=ProjectKeys(store=store).create(project_id='proj_restore',owner_user_id='user-one',
                                  sandbox_seconds_ceiling=17,blob_bytes_ceiling=67)
with store.connect() as conn:
    version=conn.execute('SELECT MAX(version) AS version FROM schema_migrations').fetchone()['version']
print(json.dumps({'secret':key['secret'],'version':version}))
"""

HTTP_REQUEST = """
import json,sys,urllib.request,urllib.error
data=json.load(sys.stdin)
body=data.pop('body',None)
request=urllib.request.Request(data['url'],method=data['method'],headers=data['headers'],
    data=None if body is None else json.dumps(body).encode())
try:
    response=urllib.request.urlopen(request,timeout=8)
except urllib.error.HTTPError as error:
    response=error
content=response.read()
try: body=json.loads(content)
except ValueError: body=content.decode(errors='replace')
print(json.dumps({'status':response.status,'body':body}))
"""


@unittest.skipIf(os.environ.get('MERV_CUTOVER_IMAGE_REHEARSAL') != '1', 'requires locally built current release images and cached legacy image')
class PackagedCutoverTests(unittest.TestCase):
    def setUp(self):
        self.tmp_path = Path(self.enterContext(TemporaryDirectory()))

    def test_packaged_services_restore_research_auth_and_native_authority(self):
        tmp_path = self.tmp_path
        def docker(*args, **kwargs):
            result = subprocess.run(
                ["docker", *args], capture_output=True, timeout=60, check=False, **kwargs
            )
            if result.returncode:
                log = tmp_path / ("docker-error-" + uuid.uuid4().hex + ".log")
                log.write_bytes(result.stdout + result.stderr)
                log.chmod(0o600)
                raise RuntimeError(f"fixture Docker operation failed; private log: {log}")
            return result.stdout + result.stderr if args[0] == "logs" else result.stdout

        current = os.environ["MERV_CUTOVER_CURRENT_MERV_IMAGE"]
        native = os.environ["MERV_CUTOVER_CURRENT_NATIVE_IMAGE"]
        legacy = os.environ.get("MERV_CUTOVER_LEGACY_IMAGE", "deploy-control:latest")
        pg_image = "postgres:17-alpine"
        prefix = "merv-packaged-" + uuid.uuid4().hex[:10]
        names = {role: prefix + "-" + role for role in ("db", "native", "merv", "probe")}
        volumes = {role: prefix + "-" + role for role in ("source-data", "data", "secrets")}
        for image in (current, native, legacy, pg_image):
            docker("image", "inspect", image)

        def db_url(name):
            owner = "merv_app" if name.startswith("merv") else "native_app"
            return f"postgresql://{owner}:fixture-password@{names['db']}:5432/{name}"

        def sql(statement, database="postgres"):
            return docker(
                "exec",
                "-i",
                names["db"],
                "psql",
                "-U",
                "postgres",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-At",
                input=statement.encode(),
            )

        def request(service, path, *, token="", method="GET", body=None, expected=200):
            port = 8000 if service == "native" else 8787
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            response = json.loads(
                docker(
                    "exec",
                    "-i",
                    names["probe"],
                    "python",
                    "-c",
                    HTTP_REQUEST,
                    input=json.dumps(
                        {
                            "url": f"http://{names[service]}:{port}{path}",
                            "method": method,
                            "headers": headers,
                            "body": body,
                        }
                    ).encode(),
                )
            )
            assert response["status"] == expected, (service, path, response)
            return response["body"]

        def ready(service):
            path = "/healthz" if service == "native" else "/api/meta"
            deadline = time.monotonic() + 45
            while True:
                try:
                    return request(service, path)
                except (RuntimeError, AssertionError):
                    state = json.loads(docker("inspect", names[service]))[0]["State"]
                    if not state["Running"] or time.monotonic() >= deadline:
                        # These services only contain fixtures. Save diagnostics
                        # privately without making the test dump credentials.
                        log = tmp_path / (service + "-startup.log")
                        log.write_bytes(docker("logs", names[service]))
                        log.chmod(0o600)
                        raise AssertionError(
                            f"{service} startup failed; private log: {log}"
                        )
                    time.sleep(0.25)

        def start_native(database, volume):
            docker(
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                names["native"],
                "--network",
                prefix,
                "--mount",
                f"type=volume,source={volume},target=/data",
                "-e",
                "SANDBOXES_DATABASE_URL=" + db_url(database),
                "-e",
                'SANDBOXES_PROVIDERS=[{"name":"fake","plugin":"fake"}]',
                native,
            )
            ready("native")

        def start_merv():
            environment = {
                "MERV_DB_URL": db_url("merv_restored"),
                "MERV_SANDBOXES_URL": f"http://{names['native']}:8000",
                "MERV_SANDBOXES_CONNECTIONS_FILE": "/run/secrets/connection.json",
                "MERV_REQUIRE_SANDBOX_BACKEND": "1",
                "MERV_REQUIRE_AUTH": "1",
                "SUPABASE_URL": "https://fixture.invalid",
                "SUPABASE_JWT_SECRET": "fixture-only-research-signing-key-32-bytes",
                "MERV_BLOB_BUCKET": "fixture-research",
                "MERV_BLOB_ENDPOINT_URL": "https://unused-fixture-storage.invalid",
                "MERV_BLOB_ACCESS_KEY_ID": "fixture-access-key",
                "MERV_BLOB_SECRET_ACCESS_KEY": "fixture-secret-key",
            }
            args = [
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                names["merv"],
                "--network",
                prefix,
                "--mount",
                f"type=volume,source={volumes['secrets']},target=/run/secrets,readonly",
            ]
            for key, value in environment.items():
                args.extend(("-e", key + "=" + value))
            docker(*args, current)
            meta = ready("merv")
            assert meta["auth"]["required"] is True

        try:
            docker("network", "create", "--internal", prefix)
            for volume in volumes.values():
                docker("volume", "create", volume)
            docker(
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                names["probe"],
                "--network",
                prefix,
                "--entrypoint",
                "python",
                current,
                "-c",
                "import time; time.sleep(600)",
            )
            docker(
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                names["db"],
                "--network",
                prefix,
                "--tmpfs",
                "/var/lib/postgresql/data",
                "-e",
                "POSTGRES_PASSWORD=fixture-password",
                pg_image,
            )
            deadline = time.monotonic() + 30
            while True:
                try:
                    # The image's temporary init server only listens on its Unix
                    # socket. Wait for TCP so its shutdown cannot race role setup.
                    docker("exec", names["db"], "pg_isready", "-h", "127.0.0.1", "-U", "postgres")
                    break
                except RuntimeError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.25)
            for owner in ("merv_app", "native_app"):
                sql(
                    f"CREATE ROLE {owner} LOGIN PASSWORD 'fixture-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;"
                )
            for database in (
                "merv_source",
                "native_source",
                "merv_restored",
                "native_restored",
            ):
                owner = database.split("_")[0] + "_app"
                sql(f"CREATE DATABASE {database} OWNER {owner};")
            seeded = json.loads(
                docker(
                    "run",
                    "--rm",
                    "--pull",
                    "never",
                    "--network",
                    prefix,
                    "-e",
                    "MERV_DB_URL=" + db_url("merv_source"),
                    "--entrypoint",
                    "python",
                    legacy,
                    "-c",
                    LEGACY_SEED,
                )
            )
            start_native("native_source", volumes["source-data"])
            login = request(
                "native",
                "/v1/auth/signup",
                method="POST",
                expected=201,
                body={"username": "team-one", "password": "fixture-owner-password"},
            )
            admin = login["token"]
            identity = request("native", "/v1/auth/me", token=admin)
            account, member = identity["account_id"], identity["member_id"]
            root = "/v1/accounts/" + account
            second = request(
                "native",
                root + "/members",
                token=admin,
                method="POST",
                body={"name": "other-member"},
                expected=201,
            )
            request(
                "native",
                root + "/subjects/research/user-one",
                token=admin,
                method="PUT",
                body={"member_id": member},
                expected=204,
            )
            grant = request(
                "native",
                root + "/grants",
                token=admin,
                method="POST",
                expected=201,
                body={
                    "application_id": "research",
                    "namespaces": ["team-one"],
                    "members": [member, second["id"]],
                },
            )
            independent = request(
                "native",
                root + "/grants",
                token=admin,
                method="POST",
                expected=201,
                body={
                    "application_id": "independent",
                    "namespaces": ["team-one"],
                    "members": [member],
                },
            )
            policy = {
                "scope": "account",
                "target": account,
                "metric": "money",
                "window": "day",
                "currency": "USD",
                "cap": "1",
            }
            request(
                "native", root + "/budgets/shared", token=admin, method="PUT", body=policy
            )
            docker("stop", "-t", "15", names["native"])
            docker("rm", "-v", names["native"])

            # Frozen sources are restored with their application owners, never a
            # superuser runtime. The old research policy/key columns stay intact.
            for service in ("merv", "native"):
                dump = docker(
                    "exec",
                    names["db"],
                    "pg_dump",
                    "-U",
                    service + "_app",
                    "-d",
                    service + "_source",
                    "-Fc",
                )
                docker(
                    "exec",
                    "-i",
                    names["db"],
                    "pg_restore",
                    "-U",
                    service + "_app",
                    "-d",
                    service + "_restored",
                    "--exit-on-error",
                    input=dump,
                )
            archive = docker(
                "run",
                "--rm",
                "--pull",
                "never",
                "--network",
                "none",
                "--user",
                "0",
                "--mount",
                f"type=volume,source={volumes['source-data']},target=/source,readonly",
                "--entrypoint",
                "tar",
                native,
                "-cf",
                "-",
                "-C",
                "/source",
                ".",
            )
            docker(
                "run",
                "--rm",
                "-i",
                "--pull",
                "never",
                "--network",
                "none",
                "--user",
                "0",
                "--mount",
                f"type=volume,source={volumes['data']},target=/target",
                "--entrypoint",
                "tar",
                native,
                "-xf",
                "-",
                "-C",
                "/target",
                input=archive,
            )
            connections = {
                "proj_restore": {"namespace": "team-one", "token": grant["token"]}
            }
            install = """import json,os,pathlib,sys
p=pathlib.Path('/fixture/connection.json'); p.write_text(sys.stdin.read())
p.chmod(0o600); os.chown(p,10001,10001)
"""
            docker(
                "run",
                "--rm",
                "-i",
                "--pull",
                "never",
                "--network",
                "none",
                "--user",
                "0",
                "--mount",
                f"type=volume,source={volumes['secrets']},target=/fixture",
                "--entrypoint",
                "python",
                current,
                "-c",
                install,
                input=json.dumps(connections).encode(),
            )
            start_native("native_restored", volumes["data"])
            start_merv()
            key = seeded["secret"]
            request("merv", "/api/projects", expected=401)
            projects = request("merv", "/api/projects", token=key)
            assert "Retained research" in json.dumps(projects)
            experiments = request(
                "merv", "/api/projects/proj_restore/experiments", token=key
            )
            assert "preserve this claim" in json.dumps(experiments)
            assert (
                request("merv", "/api/projects/proj_restore/compute-cost", token=key)[
                    "total_usd"
                ]
                == 0
            )
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

            public_key = (
                Ed25519PrivateKey.generate()
                .public_key()
                .public_bytes(
                    serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
                )
                .decode()
            )
            agent = request(
                "merv",
                "/mcp/call",
                token=key,
                method="POST",
                body={"name": "agent.hello", "arguments": {}},
            )["result"]["agent_id"]
            # A real Merv tool request uses native allowance even though the restored
            # local cap is zero and the old project-key lease ceiling is 17 seconds.
            machine = request(
                "merv",
                "/mcp/call",
                token=key,
                method="POST",
                body={
                    "name": "sandbox.request",
                    "arguments": {
                        "project_id": "proj_restore",
                        "experiment_id": "exp_restore",
                        "agent_id": agent,
                        "provider": "fake",
                        "instance_type": "tiny:east",
                        "time_limit": 600,
                        "public_key": public_key,
                    },
                },
            )["result"]
            machine_id = machine["sandbox_uid"]
            deadline = time.monotonic() + 25
            while (
                request(
                    "native", "/v1/sandboxes/" + machine_id, token=independent["token"]
                )["state"]
                != "ready"
            ):
                assert time.monotonic() < deadline
                time.sleep(0.25)
            assert machine_id in json.dumps(
                request("merv", "/api/projects/proj_restore/sandboxes", token=key)
            )
            cost = request("merv", "/api/projects/proj_restore/compute-cost", token=key)
            assert cost["open_generations"] == 1
            assert cost["total_usd"] >= 0
            policy["cap"] = "0"
            request(
                "native", root + "/budgets/shared", token=admin, method="PUT", body=policy
            )
            denied = request(
                "native",
                "/v1/sandboxes",
                token=independent["token"],
                method="POST",
                expected=400,
                body={"provider": "fake", "offer_id": "tiny:east", "lease_seconds": 60},
            )
            assert denied["error"]["details"]["reason"] == "budget_exceeded"
            denied_renewal = request(
                "merv",
                "/mcp/call",
                token=key,
                method="POST",
                expected=400,
                body={
                    "name": "sandbox.extend",
                    "arguments": {
                        "project_id": "proj_restore",
                        "sandbox_uid": machine_id,
                        "agent_id": agent,
                        "seconds": 60,
                    },
                },
            )
            assert denied_renewal["reason"] == "budget_exceeded"

            # Native authority and lifecycle continue while Merv is stopped.
            docker("stop", "-t", "15", names["merv"])
            docker("rm", names["merv"])
            request(
                "native",
                "/v1/sandboxes/" + machine_id,
                token=independent["token"],
                method="DELETE",
                expected=202,
            )
            deadline = time.monotonic() + 25
            while (
                request(
                    "native", "/v1/sandboxes/" + machine_id, token=independent["token"]
                )["state"]
                != "stopped"
            ):
                assert time.monotonic() < deadline
                time.sleep(0.25)
            start_merv()
            assert "Retained research" in json.dumps(
                request("merv", "/api/projects", token=key)
            )
            assert (
                request("merv", "/api/projects/proj_restore/compute-cost", token=key)[
                    "open_generations"
                ]
                == 0
            )
            request(
                "native",
                root + "/grants/" + grant["grant_id"],
                token=admin,
                method="DELETE",
                expected=204,
            )
            revoked = request(
                "merv", "/api/projects/proj_restore/compute-cost", token=key, expected=400
            )
            assert revoked["error_code"] == "permission_denied"
            assert revoked["upstream_code"] == "authentication"
            for database in ("merv_source", "merv_restored"):
                assert (
                    sql(
                        "SELECT daily_usd_limit FROM provider_user_caps WHERE provider='fake' AND user_id='user-one';",
                        database,
                    ).strip()
                    == b"0"
                )
                assert (
                    sql(
                        "SELECT sandbox_seconds_ceiling,blob_bytes_ceiling FROM project_api_keys;",
                        database,
                    ).strip()
                    == b"17|67"
                )
            restored_version = int(
                sql("SELECT MAX(version) FROM schema_migrations;", "merv_restored")
            )
            assert restored_version >= seeded["version"]
            assert (
                sql(
                    "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ('merv_app','native_app') ORDER BY rolname;"
                ).strip()
                == b"merv_app|f|f|f\nnative_app|f|f|f"
            )
            evidence = tmp_path / "packaged-release-evidence.json"
            evidence.write_text(
                json.dumps(
                    {
                        "images": {
                            name: json.loads(docker("image", "inspect", image))[0]["Id"]
                            for name, image in (
                                ("merv", current),
                                ("native", native),
                                ("legacy_merv", legacy),
                            )
                        },
                        "source_research_schema_version": seeded["version"],
                        "restored_research_schema_version": restored_version,
                        "application_database_roles_are_not_superusers": True,
                        "existing_project_key_authenticated": True,
                        "research_rows_retained": True,
                        "native_allowance_controls_merv_tool_and_independent_client": True,
                        "native_cleanup_completed_while_merv_stopped": True,
                        "revoked_native_grant_denied_after_merv_restart": True,
                        "compute_provider": "fake",
                    },
                    indent=2,
                )
                + "\n"
            )
            evidence.chmod(0o600)
        finally:
            for name in reversed(list(names.values())):
                if docker(
                    "container", "ls", "-aq", "--filter", "name=^/" + name + "$"
                ).strip():
                    docker("container", "rm", "-f", "-v", name)
            for volume in volumes.values():
                if docker(
                    "volume", "ls", "-q", "--filter", "name=^" + volume + "$"
                ).strip():
                    docker("volume", "rm", volume)
            if docker("network", "ls", "-q", "--filter", "name=^" + prefix + "$").strip():
                docker("network", "rm", prefix)
            assert not docker(
                "container", "ls", "-aq", "--filter", "name=" + prefix
            ).strip()
            assert not docker("volume", "ls", "-q", "--filter", "name=" + prefix).strip()
