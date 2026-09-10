"""Optional real-service contract test: export, native import, Merv and another app.

Run with the sibling service installed and MERV_SANDBOXES_TEST_DATABASE_URL set
to a disposable PostgreSQL maintenance database. Creates/drops its own database;
the only configured compute provider is the in-process fake.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sqlite3
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from merv.brain.infrastructure.client import InfrastructureClient
from merv.brain.infrastructure.ports import infrastructure_actor
from merv.shared.errors import ValidationError

pytestmark = pytest.mark.skipif(
    not os.environ.get("MERV_SANDBOXES_TEST_DATABASE_URL"),
    reason="requires the optional native-service PostgreSQL contract environment",
)


@pytest.mark.parametrize(
    "period",
    ["day", "all_time", "compute_hours", "concurrency", "lifetime", "hourly_price"],
)
def test_export_import_and_two_clients_share_the_native_allowance(tmp_path, period):
    psycopg = pytest.importorskip("psycopg")
    pytest.importorskip("merv_sandboxes")
    from sqlalchemy.engine import make_url

    maintenance = os.environ["MERV_SANDBOXES_TEST_DATABASE_URL"]
    database = "merv_contract_" + uuid.uuid4().hex[:12]
    url = (
        make_url(maintenance)
        .set(database=database)
        .render_as_string(hide_password=False)
    )
    with psycopg.connect(maintenance, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{database}"')
    try:
        asyncio.run(_exercise_contract(tmp_path, url, period))
    finally:
        with psycopg.connect(maintenance, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')


async def _exercise_contract(tmp_path, database_url, period):
    from merv_sandboxes.account_import import AccountImport, import_account
    from merv_sandboxes.account_inventory import inventory_account
    from merv_sandboxes.admission_review import (
        AdmissionCase,
        AdmissionReview,
        review_admission,
    )
    from merv_sandboxes.api import create_app
    from merv_sandboxes.config import ProviderInstanceConfig, Settings
    from merv_sandboxes.core.clock import ManualClock
    from merv_sandboxes.db.migrate import upgrade_async
    from merv_sandboxes.providers.fake import FakePlugin
    from merv_sandboxes.runtime import Container

    await upgrade_async(database_url)
    clock = ManualClock()
    clock.set(datetime(2026, 1, 1, 12, tzinfo=UTC))
    settings = Settings(
        data_dir=tmp_path / "native",
        database_url=database_url,
        providers=[ProviderInstanceConfig(name="fake", plugin="fake")],
    )
    service = Container(settings, clock=clock, plugins={"fake": FakePlugin()})
    await service.start(run_worker=False)
    try:
        native_ns = await service.accounts.ensure_native_namespace("research")
        await service.registry.billing.suspend(native_ns["account_id"], True)
        native_inventory = await inventory_account(
            service.db, clock, native_ns["account_id"]
        )
        path = Path(__file__).parents[2] / "deploy" / "export_infrastructure_budgets.py"
        spec = importlib.util.spec_from_file_location("budget_contract_export", path)
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        source = tmp_path / "legacy.sqlite"
        with sqlite3.connect(source) as conn:
            for table, columns in exporter.COLUMNS.items():
                conn.execute(f"CREATE TABLE {table} ({', '.join(columns.split())})")
            conn.execute("INSERT INTO projects VALUES ('p', 't')")
            conn.execute("INSERT INTO project_members VALUES ('p', 'u')")
            conn.execute(
                "INSERT INTO provider_user_caps VALUES ('old-cloud', '', ?)",
                (0.01 if period == "day" else None,),
            )
            conn.execute(
                "INSERT INTO sandbox_generations VALUES ("
                "'g', 't', 'p', 'exp', 'old', 'uid-old', 'old-cloud', 'u', 'platform', "
                "0.007, 1, '2026-01-01T11:00:00Z', '2026-01-01T11:30:00Z', 1)"
            )
            if period == "all_time":
                conn.execute(
                    "INSERT INTO tenant_quotas (tenant_id, usd_budget) VALUES ('t', 0.01)"
                )
            elif period == "compute_hours":
                conn.execute(
                    "INSERT INTO tenant_quotas (tenant_id, gpu_hours_budget) VALUES ('t', 1.4)"
                )
            elif period == "concurrency":
                conn.execute(
                    "INSERT INTO tenant_quotas (tenant_id, max_concurrent_sandboxes) VALUES ('t', 1)"
                )
            elif period == "lifetime":
                conn.execute(
                    "INSERT INTO tenant_quotas (tenant_id, max_time_limit_seconds) VALUES ('t', 1800)"
                )
            elif period == "hourly_price":
                conn.execute(
                    "INSERT INTO tenant_quotas (tenant_id, max_price_usd_per_hour) VALUES ('t', 0.007)"
                )
        with exporter.source_connection(sqlite=source) as conn:
            snapshot = exporter.inventory(
                conn, source_id="legacy-deployment", as_of=clock.now()
            )
        base = {
            "version": 1,
            "batch_id": "contract-import",
            "account_id": "acct_imported",
            "name": "Infrastructure owner",
            "members": [{"id": "payer", "name": "User"}],
            "namespaces": [
                {
                    "name": "research",
                    "expected_account_id": native_ns["account_id"],
                    "default_member_id": "payer",
                }
            ],
        }
        mapping = {
            "version": 1,
            "source_id": "legacy-deployment",
            "application_id": "research-client",
            "tenant_accounts": {"t": "acct_imported"},
            "projects": {"p": {"namespace": "research", "default_member_id": "payer"}},
            "users": {"u": "payer"},
            "providers": {"old-cloud": "fake"},
        }
        converted = exporter.convert(snapshot, mapping, base, [native_inventory])
        assert converted["report"]["conflicts"] == []
        manifest = AccountImport.model_validate(converted["manifest"])
        preview = await import_account(service.db, clock, manifest)
        assert preview["preview"] and preview["adjustment_totals"] == {
            "USD": "0.003500000000"
        }
        await import_account(service.db, clock, manifest, apply=True)
        assert (await import_account(service.db, clock, manifest, apply=True))[
            "replayed"
        ]
        await service.registry.billing.suspend("acct_imported", False)
        grants = [
            await service.tokens.create(
                namespace="research",
                account_id="acct_imported",
                member_id="payer",
                application_id=app,
            )
            for app in ("research-client", "independent-client")
        ]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(service, run_worker=False)),
            base_url="http://native",
        ) as native_http:
            loop = asyncio.get_running_loop()

            def forward(request):
                future = asyncio.run_coroutine_threadsafe(
                    native_http.request(
                        request.method,
                        request.url.path,
                        headers=request.headers,
                        content=request.content,
                    ),
                    loop,
                )
                response = future.result(timeout=10)
                return httpx.Response(
                    response.status_code,
                    headers=response.headers,
                    content=response.content,
                    request=request,
                )

            merv = InfrastructureClient(
                url="http://native",
                connections={
                    "p": {"namespace": "research", "token": grants[0].secret},
                },
                transport=httpx.MockTransport(forward),
            )
            try:

                def merv_create(seconds=1800, offer_id="tiny:east"):
                    with infrastructure_actor("u"):
                        return merv.request(
                            "POST",
                            "/sandboxes",
                            namespace="p",
                            json={
                                "provider": "fake",
                                "offer_id": offer_id,
                                "lease_seconds": seconds,
                            },
                        )

                rented = await asyncio.to_thread(merv_create)
                assert rented["namespace"] == "research"
                reason = {
                    "concurrency": "concurrency_exceeded",
                    "lifetime": "lifetime_exceeded",
                    "hourly_price": "hourly_price_exceeded",
                }.get(period, "budget_exceeded")
                seconds = 3600 if period == "lifetime" else 1800
                offer_id = "gpu-a10:west" if period == "hourly_price" else "tiny:east"
                # Prior usage .0035 + Merv's .0035 reservation leaves .003.
                denied = await native_http.post(
                    "/v1/sandboxes",
                    headers={
                        "Authorization": "Bearer " + grants[1].secret,
                    },
                    json={
                        "provider": "fake",
                        "offer_id": offer_id,
                        "lease_seconds": seconds,
                    },
                )
                assert denied.status_code == 400
                assert denied.json()["error"]["details"]["reason"] == reason
                # The non-reserving review agrees with the actual native HTTP
                # decision before comparing with the pinned legacy quota engine.
                offer = await service.providers.offer(
                    "research", provider="fake", offer_id=offer_id
                )
                shadow = await review_admission(
                    service.db,
                    clock,
                    settings,
                    AdmissionReview(
                        account_id="acct_imported",
                        cases=[
                            AdmissionCase(
                                id="denied",
                                namespace="research",
                                member_id="payer",
                                offer=offer,
                                source="host",
                                lease_seconds=seconds,
                                evidence="Protocol fixture: the same fake offer and actual HTTP request",
                            )
                        ],
                    ),
                )
                assert not shadow["cases"][0]["allowed"]
                assert shadow["cases"][0]["error"]["details"]["reason"] == reason
                comparison_path = path.with_name("compare_infrastructure_admission.py")
                comparison_spec = importlib.util.spec_from_file_location(
                    "bridge_comparison", comparison_path
                )
                comparison = importlib.util.module_from_spec(comparison_spec)
                comparison_spec.loader.exec_module(comparison)
                # Reproduce the native CLI's JSON serialization, including dates.
                shadow = json.loads(json.dumps(shadow, default=str, sort_keys=True))
                # Reflect the accepted zero-age resource in the legacy snapshot
                # so both engines see the same live slot and commitment.
                legacy_snapshot = json.loads(json.dumps(snapshot))
                live = shadow["snapshot"]["compute"][0]
                legacy_snapshot["tables"]["sandboxes"].append(
                    {
                        "sandbox_uid": "legacy-live",
                        "project_id": "p",
                        "tenant_id": "t",
                        "provider": "old-cloud",
                        "status": "provisioning",
                        "time_limit": 1800,
                        "expires_at": live["lease_expires_at"],
                        "user_id": "u",
                        "billing_mode": "platform",
                        "quoted_price_usd_per_hour": 0.007,
                        "price_usd_per_hour": 0.007,
                    }
                )
                legacy_snapshot["sha256"] = exporter.digest(
                    {
                        key: value
                        for key, value in legacy_snapshot.items()
                        if key != "sha256"
                    }
                )
                legacy_mapping = {
                    **mapping,
                    "cases": {
                        "denied": {
                            "project_id": "p",
                            "user_id": "u",
                            "provider": "old-cloud",
                            "price_unknown_reason": "",
                        }
                    },
                }
                replay_spec = importlib.util.spec_from_file_location(
                    "bridge_replay", path.with_name("replay_legacy_admission.py")
                )
                replay = importlib.util.module_from_spec(replay_spec)
                replay_spec.loader.exec_module(replay)
                recorded = await asyncio.to_thread(
                    replay.replay,
                    legacy_snapshot,
                    legacy_mapping,
                    shadow,
                    Path(__file__).parents[3],
                )
                changed = period in {"all_time", "compute_hours"}
                assert recorded["cases"][0]["allowed"] is changed
                result = comparison.compare(recorded, shadow)
                assert result["selected_cases_reconciled"] is not changed
                if changed:
                    difference = result["differences"][0]
                    assert comparison.compare(
                        recorded,
                        shadow,
                        {
                            "denied": {
                                **difference,
                                "evidence": "Test review: native reserves future commitments; "
                                "the pinned legacy cumulative gate checks accrued usage only",
                            }
                        },
                    )["selected_cases_reconciled"]
                # The same denial reaches Merv through its real client adapter.
                with pytest.raises(ValidationError) as raised:
                    await asyncio.to_thread(merv_create, seconds, offer_id)
                assert raised.value.details["reason"] == reason
                if period == "lifetime":
                    clock.advance(60)
                    renewal = await native_http.post(
                        f"/v1/sandboxes/{rented['id']}/renew",
                        headers={"Authorization": "Bearer " + grants[1].secret},
                        json={"lease_seconds": 1800},
                    )
                    assert renewal.status_code == 400
                    assert (
                        renewal.json()["error"]["details"]["reason"]
                        == "lifetime_exceeded"
                    )
                if period in {"concurrency", "lifetime", "hourly_price"}:
                    return
                usage = await service.registry.billing.usage("acct_imported")
                allowance = next(
                    row
                    for row in usage["budgets"]
                    if (
                        row.get("inherited_from")
                        if period == "day"
                        else row["window"] == "all_time"
                    )
                )
                assert allowance["available"] == Decimal(
                    "0.4" if period == "compute_hours" else "0.003"
                )
                if period == "all_time":
                    await _exercise_delta_recovery(
                        service, clock, exporter, snapshot, mapping, converted
                    )
            finally:
                merv.close()
    finally:
        await service.stop()


async def _exercise_delta_recovery(
    service, clock, exporter, snapshot, mapping, previous
):
    """Repair history after native admissions; interrupted imports roll back."""
    import copy
    from contextlib import asynccontextmanager

    from merv_sandboxes.account_import import AccountImport, import_account
    from merv_sandboxes.account_inventory import inventory_account
    from merv_sandboxes.billing import Policy

    account = "acct_imported"
    # A native owner has changed the budget after authority switched. Historical
    # source values must never overwrite this independently administered policy.
    policy = previous["manifest"]["policies"][0]
    await service.registry.billing.set_policy(
        account,
        policy["id"],
        Policy.model_validate(
            {
                **{key: value for key, value in policy.items() if key != "id"},
                "cap": "100",
            }
        ),
    )
    grant = await service.tokens.create(
        namespace="research",
        account_id=account,
        member_id="payer",
        application_id="independent-recovery-client",
    )
    clock.advance(1800)
    await service.registry.billing.suspend(account, True)
    inventory = await inventory_account(service.db, clock, account)
    base = {
        "version": 1,
        "batch_id": "final-delta",
        "account_id": account,
        "name": inventory["account"]["name"],
        "namespaces": [
            {
                "name": row["name"],
                "expected_account_id": account,
                "default_member_id": row["default_member_id"],
            }
            for row in inventory["namespaces"]
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
    for key in (
        "members",
        "policies",
        "resource_limits",
        "adjustments",
        "subjects",
        "provider_controls",
    ):
        model = AccountImport.model_fields[key].annotation.__args__[0]
        base[key] = [
            {field: row[field] for field in model.model_fields if field in row}
            for row in inventory[key]
        ]
    current = copy.deepcopy(snapshot)
    current["as_of"] = clock.now().isoformat()
    current["tables"]["sandbox_generations"].append(
        {
            **current["tables"]["sandbox_generations"][0],
            "id": "late-generation",
            "sandbox_id": "late-machine",
            "sandbox_uid": "late-uid",
            "created_seq": 2,
            "started_at": "2026-01-01T12:00:00Z",
            "ended_at": "2026-01-01T12:15:00Z",
        }
    )
    current["sha256"] = exporter.digest(
        {key: value for key, value in current.items() if key != "sha256"}
    )
    path = Path(__file__).parents[2] / "deploy" / "export_infrastructure_delta.py"
    spec = importlib.util.spec_from_file_location("contract_delta", path)
    delta = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(delta)
    converted = delta.advance(
        current,
        mapping,
        base,
        [inventory],
        previous=previous,
        previous_snapshot=snapshot,
        previous_mapping=mapping,
    )
    assert converted["report"]["conflicts"] == []
    assert len(converted["report"]["added_adjustments"]) == 1
    manifest = AccountImport.model_validate(converted["manifest"])
    preview = await import_account(service.db, clock, manifest)
    assert preview["preview"] and preview["adjustment_totals"] == {
        "USD": "0.005250000000"
    }
    assert await inventory_account(service.db, clock, account) == inventory
    real_transaction = service.db.transaction

    @asynccontextmanager
    async def interrupted_transaction():
        async with real_transaction() as conn:
            yield conn
            raise RuntimeError("simulated interruption before commit")

    service.db.transaction = interrupted_transaction
    try:
        with pytest.raises(RuntimeError, match="simulated interruption"):
            await import_account(service.db, clock, manifest, apply=True)
    finally:
        service.db.transaction = real_transaction
    assert await inventory_account(service.db, clock, account) == inventory
    applied = await import_account(service.db, clock, manifest, apply=True)
    replayed = await import_account(service.db, clock, manifest, apply=True)
    assert replayed == {**applied, "replayed": True}
    after = await inventory_account(service.db, clock, account)
    assert after["compute"] == inventory["compute"]
    assert after["grants"] == inventory["grants"]
    assert after["provider_connections"] == inventory["provider_connections"]
    assert after["policies"] == inventory["policies"]
    assert len(after["adjustments"]) == 2 and len(after["import_batches"]) == 2
    assert (await service.tokens.authenticate(grant.secret)).member_id == "payer"
    await service.registry.billing.suspend(account, False)
