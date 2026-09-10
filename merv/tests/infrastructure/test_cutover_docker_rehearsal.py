"""Opt-in real Docker backup/restore rehearsal, confined to uniquely named fixtures.

Requires cached PostgreSQL and Python application images; never pulls an image,
contacts a cloud provider or inspects a pre-existing application container.
"""

from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import socket
import subprocess
import tarfile
import time
import uuid
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("MERV_CUTOVER_DOCKER_REHEARSAL") != "1",
    reason="requires opt-in disposable Docker deployment rehearsal",
)


def docker(*args, **kwargs):
    result = subprocess.run(
        ["docker", *args],
        capture_output=True,
        check=False,
        timeout=60,
        **kwargs,
    )
    if result.returncode:
        raise RuntimeError("disposable rehearsal Docker operation failed")
    return result.stdout


def module(name):
    path = Path(__file__).parents[2] / "deploy" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def seed_legacy(db):
    from datetime import UTC, datetime, timedelta

    exporter = module("export_infrastructure_budgets")
    numeric = {
        "daily_usd_limit",
        "max_price_usd_per_hour",
        "gpu_hours_budget",
        "usd_budget",
        "price_usd_per_hour",
        "quoted_price_usd_per_hour",
    }
    integer = {
        "enabled",
        "tripped",
        "max_concurrent_sandboxes",
        "max_time_limit_seconds",
        "blob_bytes_budget",
        "price_known",
        "created_seq",
        "time_limit",
    }
    for table, projection in exporter.COLUMNS.items():
        definitions = [
            f"{name} {'DOUBLE PRECISION' if name in numeric else 'INTEGER' if name in integer else 'TEXT'}"
            for name in projection.split()
        ]
        if table == "sandbox_provider_settings":
            definitions.extend(
                ["credentials TEXT", "credential_mode TEXT", "verified_at TEXT"]
            )
        db.execute(f"CREATE TABLE {table} ({', '.join(definitions)})")
    db.execute("INSERT INTO projects VALUES ('proj_one', 'tenant-one')")
    db.execute("INSERT INTO project_members VALUES ('proj_one', 'user-one')")
    db.execute("INSERT INTO provider_user_caps VALUES ('old-fake', '', 1)")
    credentials = {
        "MERV_GCP_PROJECT": "fixture-project",
        "MERV_GCP_SERVICE_ACCOUNT_JSON": json.dumps(
            {
                "type": "service_account",
                "project_id": "fixture-project",
                "client_email": "fixture@example.invalid",
                "private_key": "fixture-only-unverified-key",
            }
        ),
    }
    db.execute(
        "INSERT INTO sandbox_provider_settings VALUES ('proj_one', 'gcp', 1, NULL, %s, 'own', NULL)",
        (json.dumps(credentials),),
    )
    now = datetime.now(UTC)
    generation = dict.fromkeys(exporter.COLUMNS["sandbox_generations"].split())
    generation.update(
        id="generation-old",
        tenant_id="tenant-one",
        project_id="proj_one",
        experiment_id="experiment",
        sandbox_id="old-machine",
        sandbox_uid="old-uid",
        provider="old-fake",
        user_id="user-one",
        billing_mode="platform",
        price_usd_per_hour=0.007,
        price_known=1,
        started_at=(now - timedelta(hours=2)).isoformat(),
        ended_at=(now - timedelta(hours=1)).isoformat(),
        created_seq=1,
    )
    db.execute(
        f"INSERT INTO sandbox_generations VALUES ({','.join('%s' for _ in generation)})",
        tuple(generation.values()),
    )


async def import_restored_history(service, legacy_url, saved, stage):
    from datetime import UTC, datetime

    from merv_sandboxes.account_import import AccountImport, import_account
    from merv_sandboxes.account_inventory import inventory_account
    from merv_sandboxes.provider_import import ProviderImport, import_providers

    exporter = module("export_infrastructure_budgets")
    with exporter.source_connection(postgres=legacy_url) as source:
        snapshot = exporter.inventory(
            source, source_id="disposable-deployment", as_of=datetime.now(UTC)
        )
    inventory = await inventory_account(service.db, service.clock, saved["account"])
    base = {
        "version": 1,
        "batch_id": "restored-ownership",
        "account_id": saved["account"],
        "name": inventory["account"]["name"],
        "namespaces": [
            {
                "name": "team-one",
                "expected_account_id": saved["account"],
                "default_member_id": saved["member"],
                "approved_native_owners": ["team-one"],
            }
        ],
        "compute": [
            {
                "sandbox_id": row["id"],
                "member_id": row["member_id"],
                "source": row["source"],
            }
            for row in inventory["compute"]
        ],
    }
    for name in (
        "members",
        "policies",
        "resource_limits",
        "adjustments",
        "subjects",
        "provider_controls",
    ):
        model = AccountImport.model_fields[name].annotation.__args__[0]
        base[name] = [
            {key: row[key] for key in model.model_fields if key in row}
            for row in inventory[name]
        ]
    mapping = {
        "version": 1,
        "source_id": "disposable-deployment",
        "application_id": "research",
        "projects": {
            "proj_one": {"namespace": "team-one", "default_member_id": saved["member"]}
        },
        "users": {"user-one": saved["member"]},
        "providers": {"old-fake": "fake", "gcp": "gcp"},
    }
    converted = exporter.convert(snapshot, mapping, base, [inventory])
    assert converted["report"]["conflicts"] == []
    manifest = AccountImport.model_validate(converted["manifest"])
    preview = await import_account(service.db, service.clock, manifest)
    assert preview["preview"] and preview["adjustment_totals"] == {
        "USD": "0.007000000000"
    }
    await import_account(service.db, service.clock, manifest, apply=True)
    assert (await import_account(service.db, service.clock, manifest, apply=True))[
        "replayed"
    ]
    providers = [
        ProviderImport.model_validate(row)
        for row in json.loads((stage / "native-own-provider-import.json").read_text())
    ]
    assert len(providers) == 1
    assert (
        await import_providers(
            service.db, service.clock, service.vault, service.providers, providers
        )
    )["preview"]
    await import_providers(
        service.db,
        service.clock,
        service.vault,
        service.providers,
        providers,
        apply=True,
    )
    await import_providers(
        service.db,
        service.clock,
        service.vault,
        service.providers,
        providers,
        apply=True,
    )
    credential, fields = await service.vault.fields("team-one", "gcp")
    assert credential.verified_at is None and fields == providers[0].fields
    assert (
        await service.jobs.get(namespace="team-one", job_id=saved["job"])
    ).state.value == "running"


async def seed_native(url, data):
    from datetime import UTC, datetime

    from merv_sandboxes.account_inventory import inventory_account
    from merv_sandboxes.config import ProviderInstanceConfig, Settings
    from merv_sandboxes.core.clock import ManualClock
    from merv_sandboxes.jobs.models import JobState, RunJobRequest
    from merv_sandboxes.providers.fake import FakePlugin
    from merv_sandboxes.registry import CreateSandboxRequest
    from merv_sandboxes.runtime import Container

    clock = ManualClock()
    clock.set(datetime.now(UTC))
    service = Container(
        Settings(
            database_url=url,
            data_dir=data,
            providers=[ProviderInstanceConfig(name="fake", plugin="fake")],
        ),
        plugins={"fake": FakePlugin()},
        clock=clock,
    )
    await service.migrate()
    await service.start(run_worker=False)
    try:
        await service.users.create(
            username="team-one", password="fixture-owner-password"
        )
        grant = await service.tokens.create(
            namespace="team-one", application_id="research"
        )
        identity = await service.tokens.authenticate(grant.secret)
        await service.accounts.bind_subject(
            identity.account_id, "research", "user-one", identity.member_id
        )
        offer = await service.providers.offer(
            "team-one", provider="fake", offer_id="tiny:east"
        )
        machine = await service.registry.create(
            namespace="team-one",
            member_id=identity.member_id,
            grant_id=grant.token_id,
            request=CreateSandboxRequest(
                provider="fake", offer_id="tiny:east", lease_seconds=3600
            ),
            offer=offer,
            login_user="root",
        )
        for _ in range(20):
            await service.worker.tick()
            if await service.queue.pending_count() == 0:
                break
            clock.advance(5)
        assert (await service.registry.get_by_id(machine.id)).state.value == "ready"
        job = await service.jobs.run(
            namespace="team-one",
            sandbox_id=machine.id,
            request=RunJobRequest(command="fixture-only running job"),
        )
        # Seed a pre-existing running job/output fixture through the durable
        # services. No command is executed and no SSH connection is attempted.
        await service.jobs.transition(job.id, to=JobState.LAUNCHING)
        await service.jobs.transition(job.id, to=JobState.RUNNING)
        await service.jobs.outputs.append(
            job.id, "stdout", start=0, data=b"retained job output\n"
        )
        await service.jobs.record_output(
            job.id, "stdout", total_length=20, complete=False
        )
        await service.vault.save(
            namespace="team-one",
            name="retained",
            plugin="fake",
            fields={"test_key": "fixture-only-private-value"},
            settings={},
            access="inbound",
            verified=False,
        )
        await service.registry.billing.suspend(identity.account_id, True)
        inventory = await inventory_account(
            service.db, service.clock, identity.account_id
        )
        return {
            "account": identity.account_id,
            "member": identity.member_id,
            "token": grant.secret,
            "machine": machine.id,
            "job": job.id,
            "inventory": inventory,
        }
    finally:
        await service.stop()


async def verify_restored_native(url, data, saved):
    from merv_sandboxes.config import Settings
    from merv_sandboxes.jobs.models import ByteRange
    from merv_sandboxes.runtime import Container

    service = Container(Settings(database_url=url, data_dir=data))
    await service.start(run_worker=False)
    try:
        identity = await service.tokens.authenticate(saved["token"])
        assert (identity.account_id, identity.member_id) == (
            saved["account"],
            saved["member"],
        )
        machine = await service.registry.get(
            namespace="team-one", sandbox_id=saved["machine"]
        )
        assert machine.id == saved["machine"]
        job = await service.jobs.get(namespace="team-one", job_id=saved["job"])
        assert job.state.value == "running"
        output = await service.jobs.read(
            namespace="team-one",
            job_id=saved["job"],
            stream="stdout",
            ranges=[ByteRange(start=0, end=20)],
        )
        assert output.data == b"retained job output\n"
        assert (await service.vault.fields("team-one", "retained"))[1] == {
            "test_key": "fixture-only-private-value"
        }
        assert (await service.accounts.get(saved["account"]))["suspended"]
    finally:
        await service.stop()


def certificate(directory):
    import ipaddress
    from datetime import UTC, datetime, timedelta

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "disposable-rehearsal")]
    )
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    key_path, cert_path = directory / "tls.key", directory / "tls.pem"
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key_path, cert_path


async def activate_restored_native(
    url, legacy_url, data, saved, staging, stage, listener, key_path, cert_path
):
    import httpx
    import uvicorn
    from merv_sandboxes.api import create_app
    from merv_sandboxes.config import ProviderInstanceConfig, Settings
    from merv_sandboxes.providers.fake import FakePlugin
    from merv_sandboxes.runtime import Container

    from merv.brain.infrastructure.client import build_infrastructure_client
    from merv.brain.infrastructure.ports import infrastructure_actor
    from merv.shared.errors import ValidationError

    additions = json.loads((stage / "native-provider-additions.json").read_text())
    native_providers = [
        ProviderInstanceConfig(name="fake", plugin="fake"),
        *[ProviderInstanceConfig.model_validate(row) for row in additions],
    ]
    assert {row.name for row in native_providers} == {"fake", "lambda"}
    service = Container(
        Settings(
            database_url=url,
            data_dir=data,
            providers=native_providers,
        ),
        plugins={"fake": FakePlugin()},
        environ={"IMPORTED_LAMBDA_KEY": "fixture-host-key"},
    )
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(service, run_worker=False),
            log_level="error",
            access_log=False,
            ssl_keyfile=str(key_path),
            ssl_certfile=str(cert_path),
        )
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    client = None
    try:
        deadline = asyncio.get_running_loop().time() + 20
        while not server.started:
            if task.done():
                await task
                raise RuntimeError(
                    "restored native HTTPS server stopped before startup"
                )
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError("restored native HTTPS server did not start")
            await asyncio.sleep(0.01)
        await import_restored_history(service, legacy_url, saved, stage)
        with pytest.raises(ValueError, match="authentication failed"):
            await asyncio.to_thread(
                staging.finalize,
                stage,
                {"proj_one": {"namespace": "team-one", "token": saved["token"]}},
            )
        origin = json.loads((stage / "approved-plan.json").read_text())["service_url"]
        async with httpx.AsyncClient(base_url=origin) as http:
            login = await http.post(
                "/v1/auth/login",
                json={"username": "team-one", "password": "fixture-owner-password"},
            )
            assert login.status_code == 200
            issued = await http.post(
                f"/v1/accounts/{saved['account']}/grants",
                headers={"Authorization": "Bearer " + login.json()["token"]},
                json={
                    "application_id": "research",
                    "members": [saved["member"]],
                    "namespaces": ["team-one"],
                },
            )
            assert issued.status_code == 201
            connections = {
                "proj_one": {"namespace": "team-one", "token": issued.json()["token"]}
            }
        real_write = staging.protected_write

        def interrupted_write(path, content):
            if path.name == "merv.env":
                raise OSError("simulated activation write interruption")
            real_write(path, content)

        staging.protected_write = interrupted_write
        try:
            with pytest.raises(OSError, match="simulated activation"):
                await asyncio.to_thread(staging.finalize, stage, connections)
        finally:
            staging.protected_write = real_write
        assert (
            not (stage / "activation").exists()
            and not (stage / "activation.pending").exists()
        )
        verified = await asyncio.to_thread(staging.finalize, stage, connections)
        assert verified["verified"][0]["member_id"] == saved["member"]
        origin = json.loads((stage / "approved-plan.json").read_text())["service_url"]
        client = build_infrastructure_client(
            {
                "MERV_SANDBOXES_URL": origin,
                "MERV_SANDBOXES_CONNECTIONS_FILE": str(
                    stage / "activation" / "connections.json"
                ),
            }
        )

        def merv_request(method, path, **kwargs):
            with infrastructure_actor("user-one"):
                return client.request(method, path, namespace="proj_one", **kwargs)

        resource = await asyncio.to_thread(
            merv_request, "GET", "/sandboxes/" + saved["machine"]
        )
        assert resource["id"] == saved["machine"]

        def merv_output():
            with infrastructure_actor("user-one"):
                return client.request_bytes(
                    "GET", "/jobs/" + saved["job"] + "/output", namespace="proj_one"
                )

        assert (await asyncio.to_thread(merv_output))[0] == b"retained job output\n"
        # Real native owner login and administration after restoration. Neither
        # Merv's connection file nor the agent receives the new numeric allowance.
        async with httpx.AsyncClient(base_url=origin) as http:
            login = await http.post(
                "/v1/auth/login",
                json={"username": "team-one", "password": "fixture-owner-password"},
            )
            assert login.status_code == 200
            admin = {"Authorization": "Bearer " + login.json()["token"]}
            cap = await http.put(
                f"/v1/accounts/{saved['account']}/budgets/rehearsal",
                headers=admin,
                json={
                    "scope": "account",
                    "target": saved["account"],
                    "window": "day",
                    "cap": "0",
                    "currency": "USD",
                },
            )
            assert cap.status_code == 200
            resume = await http.put(
                f"/v1/accounts/{saved['account']}/suspension",
                headers=admin,
                json={"suspended": False},
            )
            assert resume.status_code == 204
            issued = await http.post(
                f"/v1/accounts/{saved['account']}/grants",
                headers=admin,
                json={
                    "application_id": "another-application",
                    "members": [saved["member"]],
                    "namespaces": ["team-one"],
                },
            )
            assert issued.status_code == 201
            request = {"provider": "fake", "offer_id": "tiny:east", "lease_seconds": 60}
            other = await http.post(
                "/v1/sandboxes",
                headers={"Authorization": "Bearer " + issued.json()["token"]},
                json=request,
            )
            assert (
                other.status_code == 400
                and other.json()["error"]["details"]["reason"] == "budget_exceeded"
            )
            with pytest.raises(ValidationError) as denied:
                await asyncio.to_thread(
                    merv_request, "POST", "/sandboxes", json=request
                )
            assert denied.value.details["reason"] == "budget_exceeded"
        assert (
            json.loads((stage / "activation" / "connections.json").read_text())
            == connections
        )
    finally:
        if client is not None:
            client.close()
        server.should_exit = True
        await asyncio.wait_for(task, 20)


def test_real_prepare_restores_databases_keys_and_volume_permissions(
    tmp_path, monkeypatch
):
    psycopg = pytest.importorskip("psycopg")
    pytest.importorskip("merv_sandboxes")
    staging = module("stage_sandboxes_cutover")
    prefix = "merv-cutover-" + uuid.uuid4().hex[:10]
    app_image = os.environ.get("MERV_CUTOVER_LEGACY_IMAGE", "deploy-control:latest")
    native_image = os.environ.get(
        "MERV_CUTOVER_NATIVE_IMAGE", "sandboxes-smoke-control:latest"
    )
    pg_image = "postgres:17-alpine"
    for image in (app_image, native_image, pg_image):
        docker("image", "inspect", image)
    containers = {role: prefix + "-" + role for role in ("merv", "native", "worker")}
    databases = {
        role: {
            "container": prefix + "-" + role + "-db",
            "user": "postgres",
            "database": role,
        }
        for role in ("merv", "native")
    }
    volumes = {role: prefix + "-" + role for role in ("native-data", "merv-management")}
    restored_volumes = {role: name + "-restored" for role, name in volumes.items()}
    all_containers = [
        *containers.values(),
        *(row["container"] for row in databases.values()),
    ]
    stages = [tmp_path / "interrupted", tmp_path / "prepared"]
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    key_path, cert_path = certificate(tmp_path)
    monkeypatch.setenv("SSL_CERT_FILE", str(cert_path))
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    try:
        docker("network", "create", prefix)
        for volume in [*volumes.values(), *restored_volumes.values()]:
            docker("volume", "create", volume)
        urls = {}
        for role, database in databases.items():
            name = database["container"]
            docker(
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                name,
                "--network",
                prefix,
                "--tmpfs",
                "/var/lib/postgresql/data",
                "-p",
                "127.0.0.1::5432",
                "-e",
                "POSTGRES_PASSWORD=fixture-password",
                "-e",
                "POSTGRES_DB=" + role,
                pg_image,
            )
            port = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"][
                "5432/tcp"
            ][0]["HostPort"]
            urls[role] = (
                f"postgresql://postgres:fixture-password@127.0.0.1:{port}/{role}"
            )
            deadline = time.monotonic() + 30
            while True:
                try:
                    with psycopg.connect(urls[role], connect_timeout=1):
                        break
                except psycopg.OperationalError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.2)
        with psycopg.connect(urls["merv"]) as db:
            seed_legacy(db)
            db.execute(
                "CREATE TABLE retained_research (id TEXT PRIMARY KEY, body JSONB)"
            )
            db.execute(
                'INSERT INTO retained_research VALUES (\'experiment\', \'{"status":"running","artifact":"existing-output"}\')'
            )
        native_data = tmp_path / "native-data"
        native_data.mkdir()
        saved = asyncio.run(seed_native(urls["native"], native_data))
        # Copy actual native key material into the source volume. Root-owned and
        # UID-10001 files ensure the archive is tested for permissions, not names.
        seed = io.BytesIO()
        with tarfile.open(fileobj=seed, mode="w") as archive:
            archive.add(native_data, arcname=".")
        for role, volume in volumes.items():
            content = seed.getvalue()
            if role == "merv-management":
                other = io.BytesIO()
                with tarfile.open(fileobj=other, mode="w") as archive:
                    info = tarfile.TarInfo("management.key")
                    info.uid = info.gid = 10001
                    info.mode = 0o600
                    body = b"fixture-only-management-key"
                    info.size = len(body)
                    archive.addfile(info, io.BytesIO(body))
                content = other.getvalue()
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
                f"type=volume,source={volume},target=/data",
                "--entrypoint",
                "tar",
                native_image,
                "-xf",
                "-",
                "-C",
                "/data",
                input=content,
            )
        config = tmp_path / "source-config"
        config.mkdir()
        files = {}
        for name in {*staging.DEFAULT_FILES, "native-original.env"}:
            path = config / name
            path.write_text("# retained private rehearsal configuration\n")
            path.chmod(0o600)
            files[name] = str(path)
        plan = {
            "version": 1,
            "service_url": f"https://127.0.0.1:{listener.getsockname()[1]}",
            "application_id": "research",
            "projects": {
                "proj_one": {
                    "namespace": "team-one",
                    "account_id": saved["account"],
                    "subjects": {"user-one": saved["member"]},
                }
            },
            "host_provider_namespaces": {"lambda": ["team-one"]},
            "deployment": {
                "containers": containers,
                "databases": databases,
                "files": files,
                "volumes": volumes,
            },
        }
        legacy_url = f"postgresql://postgres:fixture-password@{databases['merv']['container']}:5432/merv"
        for role, name in containers.items():
            env = (
                [
                    "-e",
                    "MERV_DB_URL=" + legacy_url,
                    "-e",
                    "MERV_BLOB_BUCKET=retained-research",
                    "-e",
                    "LAMBDA_LABS_API_KEY=fixture-host-key",
                ]
                if role == "merv"
                else []
            )
            docker(
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                name,
                "--network",
                prefix,
                *env,
                "--entrypoint",
                "python",
                app_image if role == "merv" else native_image,
                "-c",
                "import time; time.sleep(600)",
            )
        before = {
            name: json.loads(docker("inspect", name))[0]["State"]["StartedAt"]
            for name in all_containers
        }
        # A failure after dumps retains private evidence, but never marks a stage
        # complete. A clean retry uses a new directory.
        original = Path(files["Caddyfile-original"])
        original.rename(original.with_suffix(".held"))
        with pytest.raises(FileNotFoundError):
            staging.prepare(stages[0], plan)
        assert (
            list(stages[0].glob("*.dump"))
            and not (stages[0] / "staging-summary.json").exists()
        )
        with pytest.raises(ValueError, match="did not complete"):
            staging.finalize(stages[0], {})
        original.with_suffix(".held").rename(original)
        staging.prepare(stages[1], plan)
        stage = stages[1]
        summary = json.loads((stage / "staging-summary.json").read_text())
        assert (
            summary["services_restarted"] is False
            and summary["databases_imported"] is False
        )
        assert all(
            staging.file_evidence(stage / name) == value
            for name, value in summary["artifacts"].items()
        )
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in stage.iterdir())
        for role, database in databases.items():
            restore = role + "_restored"
            docker("exec", database["container"], "createdb", "-U", "postgres", restore)
            docker(
                "exec",
                "-i",
                database["container"],
                "pg_restore",
                "-U",
                "postgres",
                "--exit-on-error",
                "-d",
                restore,
                input=(stage / (database["container"] + ".dump")).read_bytes(),
            )
        with psycopg.connect(
            urls["merv"].removesuffix("/merv") + "/merv_restored"
        ) as db:
            assert db.execute(
                "SELECT body FROM retained_research WHERE id='experiment'"
            ).fetchone()[0] == {"status": "running", "artifact": "existing-output"}
        restored_native_data = tmp_path / "restored-native-data"
        restored_native_data.mkdir()
        for role, volume in restored_volumes.items():
            data = (stage / (role + ".tar.gz")).read_bytes()
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
                f"type=volume,source={volume},target=/data",
                "--entrypoint",
                "tar",
                native_image,
                "-xzf",
                "-",
                "-C",
                "/data",
                input=data,
            )
            if role == "native-data":
                with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                    archive.extractall(restored_native_data, filter="data")
            else:
                restored = json.loads(
                    docker(
                        "run",
                        "--rm",
                        "--pull",
                        "never",
                        "--network",
                        "none",
                        "--user",
                        "10001",
                        "--mount",
                        f"type=volume,source={volume},target=/data,readonly",
                        "--entrypoint",
                        "python",
                        native_image,
                        "-c",
                        "import json,pathlib; p=pathlib.Path('/data/management.key'); s=p.stat(); print(json.dumps([p.read_text(),s.st_uid,s.st_gid,s.st_mode&511]))",
                    )
                )
                assert restored == ["fixture-only-management-key", 10001, 10001, 0o600]
        asyncio.run(
            verify_restored_native(
                urls["native"].removesuffix("/native") + "/native_restored",
                restored_native_data,
                saved,
            )
        )
        asyncio.run(
            activate_restored_native(
                urls["native"].removesuffix("/native") + "/native_restored",
                urls["merv"].removesuffix("/merv") + "/merv_restored",
                restored_native_data,
                saved,
                staging,
                stage,
                listener,
                key_path,
                cert_path,
            )
        )
        assert before == {
            name: json.loads(docker("inspect", name))[0]["State"]["StartedAt"]
            for name in all_containers
        }
        with psycopg.connect(urls["merv"]) as db:
            assert (
                db.execute("SELECT count(*) FROM retained_research").fetchone()[0] == 1
            )
    finally:
        listener.close()
        # Names are generated locally for this invocation. Never prune Docker or
        # touch a pre-existing container, volume, database, image or network.
        for name in all_containers:
            subprocess.run(
                ["docker", "rm", "-fv", name], capture_output=True, check=False
            )
        for volume in [*volumes.values(), *restored_volumes.values()]:
            subprocess.run(
                ["docker", "volume", "rm", volume], capture_output=True, check=False
            )
        subprocess.run(
            ["docker", "network", "rm", prefix], capture_output=True, check=False
        )
        for stage in stages:
            for name in containers.values():
                subprocess.run(
                    [
                        "docker",
                        "image",
                        "rm",
                        f"merv-cutover-rollback-{name}:{stage.name}",
                    ],
                    capture_output=True,
                    check=False,
                )
        remaining = docker(
            "ps", "-a", "--filter", "name=" + prefix, "--format", "{{.Names}}"
        )
        assert not remaining.strip()
        assert not docker(
            "volume", "ls", "--filter", "name=" + prefix, "--format", "{{.Name}}"
        ).strip()
