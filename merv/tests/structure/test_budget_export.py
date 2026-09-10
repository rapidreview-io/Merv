"""Read-only migration inventory and lossless policy/charge conversion."""

from __future__ import annotations

import copy
import importlib.util
import json
import sqlite3
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest


@pytest.fixture
def exporter():
    path = Path(__file__).parents[2] / "deploy" / "export_infrastructure_budgets.py"
    spec = importlib.util.spec_from_file_location("budget_export", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def inputs(exporter):
    tables = {key: [] for key in exporter.COLUMNS}
    tables.update(
        {
            "projects": [{"id": "p", "tenant_id": "t"}],
            "project_members": [{"project_id": "p", "user_id": "u"}],
            "provider_user_caps": [
                {"provider": "lambda_labs", "user_id": "", "daily_usd_limit": 50}
            ],
            "sandbox_provider_settings": [
                {
                    "project_id": "p",
                    "provider": "lambda_labs",
                    "enabled": 0,
                    "daily_usd_limit": 10,
                }
            ],
            "sandbox_generations": [
                {
                    "id": "g",
                    "tenant_id": "t",
                    "project_id": "p",
                    "experiment_id": "exp",
                    "sandbox_id": "old",
                    "sandbox_uid": "uid-old",
                    "provider": "lambda_labs",
                    "user_id": "u",
                    "billing_mode": "platform",
                    "price_usd_per_hour": 2,
                    "price_known": 1,
                    "started_at": "2026-09-07T23:30:00Z",
                    "ended_at": "2026-09-08T01:00:00Z",
                }
            ],
        }
    )
    snapshot = {
        "version": 1,
        "source_id": "deployment-1",
        "as_of": "2026-09-09T00:00:00Z",
        "tables": tables,
    }
    snapshot["sha256"] = exporter.digest(snapshot)
    mapping = {
        "version": 1,
        "source_id": "deployment-1",
        "application_id": "research",
        "projects": {"p": {"namespace": "ns", "default_member_id": "member"}},
        "users": {"u": "member"},
        "providers": {"lambda_labs": "lambda"},
    }
    base = {
        "version": 1,
        "batch_id": "batch-1",
        "account_id": "account",
        "name": "Owner",
        "members": [{"id": "member", "name": "User"}],
        "namespaces": [
            {
                "name": "ns",
                "expected_account_id": "old-account",
                "default_member_id": "member",
            }
        ],
    }
    native = [{"version": 1, "namespaces": [{"name": "ns"}], "compute": []}]
    return snapshot, mapping, base, native


def resign(exporter, snapshot):
    snapshot["sha256"] = exporter.digest(
        {k: v for k, v in snapshot.items() if k != "sha256"}
    )


def test_explicit_deferral_retains_unknown_history_without_zero_charges(
    exporter, inputs
):
    snapshot, mapping, base, native = inputs
    row = snapshot["tables"]["sandbox_generations"][0]
    row.update(provider="", user_id="", billing_mode="", price_known=0)
    resign(exporter, snapshot)
    assert exporter.convert(snapshot, mapping, base, native)["report"]["conflicts"]
    mapping["deferred_generations"] = {
        "g": "Owner approved retaining unresolved historical usage"
    }
    result = exporter.convert(snapshot, mapping, base, native)
    assert not result["report"]["conflicts"]
    manifest = result["manifest"]
    assert manifest["adjustments"] == []
    assert len(manifest["usage_gaps"]) == 1
    gap = manifest["usage_gaps"][0]
    assert gap["member_id"] is None and gap["provider"] is None
    assert gap["source"] is None and gap["hourly_price"] is None
    assert gap["provenance"]["record"] == row
    assert any(d["kind"] == "unresolved-history" for d in result["report"]["decisions"])


@pytest.mark.parametrize(
    "problem", ["complete", "no-evidence", "open", "unknown-id", "also-resolved"]
)
def test_deferral_cannot_discard_known_charges_or_live_usage(exporter, inputs, problem):
    snapshot, mapping, base, native = inputs
    mapping["deferred_generations"] = {"g": "Reviewed"}
    row = snapshot["tables"]["sandbox_generations"][0]
    if problem != "complete":
        row["price_known"] = 0
    if problem == "no-evidence":
        mapping["deferred_generations"]["g"] = " "
    elif problem == "open":
        row["ended_at"] = None
    elif problem == "unknown-id":
        mapping["deferred_generations"] = {"missing": "Reviewed"}
    elif problem == "also-resolved":
        mapping["generations"] = {"g": {"hourly_rate": "2", "evidence": "Invoice"}}
    resign(exporter, snapshot)
    result = exporter.convert(snapshot, mapping, base, native)
    assert result["report"]["conflicts"] and result.get("manifest") is None


@pytest.fixture
def delta_inputs(exporter, inputs):
    native_import = pytest.importorskip("merv_sandboxes.account_import")
    path = Path(__file__).parents[2] / "deploy" / "export_infrastructure_delta.py"
    spec = importlib.util.spec_from_file_location("budget_delta", path)
    delta = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(delta)
    snapshot, mapping, base, native = inputs
    snapshot["tables"]["sandbox_generations"][0]["ended_at"] = None
    mapping["generations"] = {
        "g": {
            "ended_at": "2026-09-08T01:00:00Z",
            "evidence": "reviewed capture boundary",
        }
    }
    resign(exporter, snapshot)
    previous = exporter.convert(*inputs)
    previous_snapshot, previous_mapping = copy.deepcopy((snapshot, mapping))
    base = copy.deepcopy(previous["manifest"])
    base["batch_id"] = "delta-1"
    base["namespaces"][0]["expected_account_id"] = "account"
    native[0].update(
        account={"id": "account"},
        as_of="2026-09-09T01:00:00Z",
        adjustments=[
            {**copy.deepcopy(row), "account_id": "account"}
            for row in base["adjustments"]
        ],
        import_batches=[
            {
                "id": "batch-1",
                "account_id": "account",
                "sha256": native_import.manifest_fingerprint(
                    native_import.AccountImport.model_validate(previous["manifest"])
                ),
            }
        ],
    )
    snapshot["as_of"] = "2026-09-09T01:00:00Z"
    mapping["generations"]["g"]["ended_at"] = "2026-09-08T02:00:00Z"
    resign(exporter, snapshot)
    return (
        delta,
        (snapshot, mapping, base, native),
        {
            "previous": previous,
            "previous_snapshot": previous_snapshot,
            "previous_mapping": previous_mapping,
        },
    )


def test_applied_delta_preserves_native_edits_and_only_appends_uncovered_hours(
    delta_inputs,
):
    delta, args, history = delta_inputs
    args[2]["policies"][0]["cap"] = "7"
    before = copy.deepcopy((args, history))
    result = delta.advance(*args, **history)
    assert result["report"]["conflicts"] == []
    assert result["manifest"]["policies"] == args[2]["policies"]
    assert result["manifest"]["provider_controls"] == args[2]["provider_controls"]
    assert result["manifest"]["adjustments"][:-1] == args[2]["adjustments"]
    added = result["manifest"]["adjustments"][-1]
    assert Decimal(added["amount"]) == 2 and Decimal(added["compute_hours"]) == 1
    assert added["provenance"]["started_at"] == "2026-09-08T01:00:00+00:00"
    assert added["provenance"]["ended_at"] == "2026-09-08T02:00:00+00:00"
    assert result["report"]["added_adjustments"] == [added["id"]]
    assert delta.advance(*args, **history) == result
    assert (args, history) == before


def test_delta_preserves_deferred_history_and_rejects_removal(exporter, inputs):
    native_import = pytest.importorskip("merv_sandboxes.account_import")
    spec = importlib.util.spec_from_file_location(
        "budget_delta_history",
        Path(__file__).parents[2] / "deploy" / "export_infrastructure_delta.py",
    )
    delta = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(delta)
    snapshot, mapping, base, native = inputs
    snapshot["tables"]["sandbox_generations"][0]["price_known"] = 0
    mapping["deferred_generations"] = {"g": "Owner approved retaining unresolved usage"}
    resign(exporter, snapshot)
    previous = exporter.convert(snapshot, mapping, base, native)
    old_snapshot, old_mapping = copy.deepcopy((snapshot, mapping))
    base = copy.deepcopy(previous["manifest"])
    base["batch_id"] = "delta-history"
    base["namespaces"][0]["expected_account_id"] = "account"
    native[0].update(
        account={"id": "account"},
        as_of="2026-09-09T01:00:00Z",
        adjustments=[],
        import_batches=[
            {
                "id": "batch-1",
                "account_id": "account",
                "sha256": native_import.manifest_fingerprint(
                    native_import.AccountImport.model_validate(previous["manifest"])
                ),
            }
        ],
    )
    snapshot["as_of"] = "2026-09-09T01:00:00Z"
    resign(exporter, snapshot)
    history = {
        "previous": previous,
        "previous_snapshot": old_snapshot,
        "previous_mapping": old_mapping,
    }
    result = delta.advance(snapshot, mapping, base, native, **history)
    assert result["report"]["conflicts"] == []
    assert result["manifest"]["usage_gaps"] == previous["manifest"]["usage_gaps"]
    mapping["deferred_generations"] = {}
    assert delta.advance(snapshot, mapping, base, native, **history)["report"][
        "conflicts"
    ]


@pytest.mark.parametrize(
    "changed",
    [
        "missing_charge",
        "changed_charge",
        "invented_base_charge",
        "missing_generation",
        "payer",
        "rate",
        "shortened",
        "policy",
        "receipt",
        "stale_native",
    ],
)
def test_applied_delta_blocks_lost_or_rewritten_evidence(
    exporter, delta_inputs, changed
):
    delta, args, history = delta_inputs
    snapshot, mapping, base, native = args
    if changed == "missing_charge":
        native[0]["adjustments"].pop()
    elif changed == "changed_charge":
        native[0]["adjustments"][0]["amount"] = "100"
    elif changed == "invented_base_charge":
        base["adjustments"].append({**base["adjustments"][0], "id": "invented"})
    elif changed == "missing_generation":
        snapshot["tables"]["sandbox_generations"] = []
        mapping["generations"] = {}
    elif changed in {"payer", "rate"}:
        key, value = (
            ("user_id", "someone") if changed == "payer" else ("price_usd_per_hour", 3)
        )
        snapshot["tables"]["sandbox_generations"][0][key] = value
    elif changed == "shortened":
        mapping["generations"]["g"]["ended_at"] = "2026-09-08T00:30:00Z"
    elif changed == "policy":
        snapshot["tables"]["provider_user_caps"][0]["daily_usd_limit"] = 200
    elif changed == "stale_native":
        native[0]["as_of"] = "2026-09-08T00:00:00Z"
    else:
        native[0]["import_batches"] = []
        with pytest.raises(ValueError, match="matching applied native receipt"):
            delta.advance(*args, **history)
        return
    resign(exporter, snapshot)
    result = delta.advance(*args, **history)
    assert result["report"]["conflicts"] and "manifest" not in result


def test_second_delta_and_unchanged_recovery_never_credit_twice(exporter, delta_inputs):
    from merv_sandboxes.account_import import AccountImport, manifest_fingerprint

    delta, args, history = delta_inputs
    previous = delta.advance(*args, **history)
    snapshot, mapping, base, native = args
    history = {
        "previous": previous,
        "previous_snapshot": copy.deepcopy(snapshot),
        "previous_mapping": copy.deepcopy(mapping),
    }
    base = copy.deepcopy(previous["manifest"])
    base["batch_id"] = "delta-2"
    native[0]["adjustments"] = [
        {**copy.deepcopy(row), "account_id": "account"} for row in base["adjustments"]
    ]
    native[0]["import_batches"].append(
        {
            "id": "delta-1",
            "account_id": "account",
            "sha256": manifest_fingerprint(
                AccountImport.model_validate(previous["manifest"])
            ),
        }
    )
    unchanged = delta.advance(snapshot, mapping, base, native, **history)
    assert unchanged["report"]["added_adjustments"] == []
    mapping["generations"]["g"]["ended_at"] = "2026-09-08T03:00:00Z"
    result = delta.advance(snapshot, mapping, base, native, **history)
    assert result["report"]["conflicts"] == []
    assert len(result["report"]["added_adjustments"]) == 1
    assert sum(Decimal(r["amount"]) for r in result["manifest"]["adjustments"]) == 7


@pytest.mark.parametrize("native_start,conflicts", [("01:30", False), ("00:30", True)])
def test_delta_excludes_native_overlap_and_rejects_already_credited_overlap(
    delta_inputs, native_start, conflicts
):
    delta, args, history = delta_inputs
    _snapshot, mapping, base, native = args
    native[0]["compute"] = [
        {
            "id": "live",
            "namespace": "ns",
            "member_id": "member",
            "plugin": "lambda",
            "source": "host",
            "currency": "USD",
            "rate": "2",
            "created_at": f"2026-09-08T{native_start}:00Z",
            "stopped_at": None,
        }
    ]
    base["compute"] = [{"sandbox_id": "live", "member_id": "member", "source": "host"}]
    mapping["generations"]["g"]["native_sandbox_id"] = "live"
    result = delta.advance(*args, **history)
    assert bool(result["report"]["conflicts"]) is conflicts
    if not conflicts:
        assert Decimal(result["manifest"]["adjustments"][-1]["amount"]) == 1
        assert (
            result["manifest"]["adjustments"][-1]["provenance"]["ended_at"]
            == "2026-09-08T01:30:00+00:00"
        )
    else:
        assert "manifest" not in result


def test_delta_reports_rounding_without_rewriting_installed_amounts(
    exporter, delta_inputs
):
    from merv_sandboxes.account_import import AccountImport, manifest_fingerprint

    delta, args, history = delta_inputs
    snapshot, mapping, base, native = args
    old_snapshot = history["previous_snapshot"]
    row = old_snapshot["tables"]["sandbox_generations"][0]
    row.update(started_at="2026-09-08T00:00:00Z", price_usd_per_hour=1)
    old_mapping = history["previous_mapping"]
    old_mapping["generations"]["g"]["ended_at"] = "2026-09-08T00:00:01Z"
    resign(exporter, old_snapshot)
    source_base = {
        key: value
        for key, value in base.items()
        if key not in {"policies", "adjustments", "provider_controls", "subjects"}
    }
    source_base["batch_id"] = "rounded-initial"
    previous = exporter.convert(old_snapshot, old_mapping, source_base, native)
    history["previous"] = previous
    snapshot["tables"]["sandbox_generations"] = copy.deepcopy(
        old_snapshot["tables"]["sandbox_generations"]
    )
    resign(exporter, snapshot)
    mapping["generations"]["g"]["ended_at"] = "2026-09-08T00:00:03Z"
    base["adjustments"] = copy.deepcopy(previous["manifest"]["adjustments"])
    native[0]["adjustments"] = [
        {**r, "account_id": "account"} for r in base["adjustments"]
    ]
    native[0]["import_batches"] = [
        {
            "id": "rounded-initial",
            "account_id": "account",
            "sha256": manifest_fingerprint(
                AccountImport.model_validate(previous["manifest"])
            ),
        }
    ]
    result = delta.advance(*args, **history)
    assert result["report"]["conflicts"] == []
    assert result["manifest"]["adjustments"][0] == base["adjustments"][0]
    assert {
        row["metric"]: Decimal(row["difference"])
        for row in result["report"]["rounding_differences"]
    } == {"amount": Decimal("1e-12"), "compute_hours": Decimal("1e-12")}


def test_delta_cli_writes_private_evidence_and_refuses_overwrite(
    delta_inputs, tmp_path, monkeypatch
):
    delta, args, history = delta_inputs
    values = dict(
        zip(
            ("snapshot", "mapping", "base-manifest", "native-inventory"),
            args,
            strict=True,
        )
    )
    values["native-inventory"] = args[3][0]
    values.update(
        {
            "previous-manifest": history["previous"]["manifest"],
            "previous-report": history["previous"]["report"],
            "previous-snapshot": history["previous_snapshot"],
            "previous-mapping": history["previous_mapping"],
        }
    )
    arguments = ["delta"]
    for option, value in values.items():
        path = tmp_path / f"{option}.json"
        path.write_text(json.dumps(value))
        arguments.extend(["--" + option, str(path)])
    output = tmp_path / "output"
    arguments.extend(["--output-dir", str(output)])
    monkeypatch.setattr("sys.argv", arguments)
    assert delta.main() == 0
    original = (output / "account-import.json").read_bytes()
    assert output.stat().st_mode & 0o777 == 0o700
    assert (output / "report.json").stat().st_mode & 0o777 == 0o600
    assert (output / "account-import.json").stat().st_mode & 0o777 == 0o600
    assert (
        delta.main() == 1 and (output / "account-import.json").read_bytes() == original
    )


def test_inherited_cap_source_filter_midnight_split_and_stable_ids(exporter, inputs):
    result = exporter.convert(*inputs)
    assert result["report"]["ready_for_native_preview"]
    manifest = result["manifest"]
    caps = {row["scope"]: row for row in manifest["policies"]}
    assert (caps["member_default"]["cap"], caps["member_default"]["source"]) == (
        "50",
        "host",
    )
    assert "member" not in caps
    assert (caps["namespace"]["cap"], caps["namespace"]["source"]) == ("10", None)
    assert manifest["provider_controls"][0]["enabled"] is False
    assert manifest["subjects"] == [
        {"application_id": "research", "subject": "u", "member_id": "member"}
    ]
    charges = manifest["adjustments"]
    assert [Decimal(row["amount"]) for row in charges] == [Decimal(1), Decimal(2)]
    assert [Decimal(row["compute_hours"]) for row in charges] == [
        Decimal("0.5"),
        Decimal(1),
    ]
    assert [row["at"][:10] for row in charges] == ["2026-09-07", "2026-09-08"]
    assert {row["experiment_id"] for row in result["report"]["associations"]} == {"exp"}
    later = copy.deepcopy(inputs)
    later[0]["as_of"] = "2026-09-10T00:00:00Z"
    resign(exporter, later[0])
    assert exporter.convert(*later)["manifest"]["adjustments"] == charges


@pytest.mark.parametrize("override,expected", [(None, None), (0, "0"), (5, "5")])
def test_user_override_is_not_combined_with_inherited_default(
    exporter, inputs, override, expected
):
    inputs[0]["tables"]["provider_user_caps"].append(
        {
            "provider": "lambda_labs",
            "user_id": "u",
            "daily_usd_limit": override,
        }
    )
    resign(exporter, inputs[0])
    policies = exporter.convert(*inputs)["manifest"]["policies"]
    assert [row["cap"] for row in policies if row["scope"] == "member"] == [expected]


def test_unknown_source_price_and_open_interval_require_review(exporter, inputs):
    row = inputs[0]["tables"]["sandbox_generations"][0]
    row.update(
        user_id="", billing_mode="", price_known=0, price_usd_per_hour=0, ended_at=None
    )
    resign(exporter, inputs[0])
    refused = exporter.convert(*inputs)
    assert "manifest" not in refused
    inputs[1]["generations"] = {
        "g": {
            "member_id": "member",
            "source": "host",
            "hourly_rate": "0",
            "ended_at": "2026-09-08T01:00:00Z",
            "evidence": "provider receipt reviewed by owner",
        }
    }
    accepted = exporter.convert(*inputs)
    assert "manifest" in accepted
    assert all(
        Decimal(row["amount"]) == 0 for row in accepted["manifest"]["adjustments"]
    )


def test_shared_payer_cannot_be_split_and_tenant_quota_cannot_disappear(
    exporter, inputs
):
    inputs[0]["tables"]["project_members"].append(
        {"project_id": "other", "user_id": "u"}
    )
    inputs[0]["tables"]["tenant_quotas"].append({"tenant_id": "t", "usd_budget": 1})
    inputs[0]["tables"]["spend_kill_switches"].append(
        {"scope": "__global__", "tripped": 1}
    )
    resign(exporter, inputs[0])
    result = exporter.convert(*inputs)
    assert "manifest" not in result
    assert {row["kind"] for row in result["report"]["conflicts"]} == {
        "user",
        "tenant_quota",
    }
    assert result["report"]["requires_spending_suspension"]


def test_native_overlap_imports_only_preceding_usage_and_requires_explicit_evidence(
    exporter, inputs
):
    inputs[3][0]["compute"] = [
        {
            "id": "uid-old",
            "namespace": "ns",
            "plugin": "lambda",
            "currency": "USD",
            "rate": "2",
            "created_at": "2026-09-08T00:00:00Z",
            "stopped_at": None,
        }
    ]
    inputs[2]["compute"] = [
        {"sandbox_id": "uid-old", "member_id": "member", "source": "host"}
    ]
    result = exporter.convert(*inputs)
    assert "manifest" not in result
    inputs[1]["generations"] = {
        "g": {
            "native_sandbox_id": "uid-old",
            "evidence": "same provider instance adopted at midnight",
        }
    }
    result = exporter.convert(*inputs)
    assert len(result["manifest"]["adjustments"]) == 1
    assert Decimal(result["manifest"]["adjustments"][0]["amount"]) == 1
    assert Decimal(result["manifest"]["adjustments"][0]["compute_hours"]) == Decimal(
        "0.5"
    )
    assert any(row["kind"] == "native-overlap" for row in result["report"]["decisions"])
    inputs[3][0]["compute"][0]["rate"] = "10"
    assert "manifest" not in exporter.convert(*inputs)


def test_fractional_usage_has_ledger_precision_and_checksum_is_checked(
    exporter, inputs
):
    inputs[0]["tables"]["sandbox_generations"][0].update(
        started_at="2026-09-08T00:00:00Z",
        ended_at="2026-09-08T00:00:01Z",
        price_usd_per_hour=1,
    )
    with pytest.raises(exporter.ExportError, match="checksum"):
        exporter.convert(*inputs)
    resign(exporter, inputs[0])
    row = exporter.convert(*inputs)["manifest"]["adjustments"][0]
    assert row["amount"] == "0.000277777778"
    assert row["compute_hours"] == "0.000277777778"


def test_snapshot_is_read_only_and_never_reads_credential_columns(exporter, tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as connection:
        for table, columns in exporter.COLUMNS.items():
            connection.execute(f"CREATE TABLE {table} ({', '.join(columns.split())})")
        connection.execute("ALTER TABLE sandbox_provider_settings ADD credentials TEXT")
        connection.execute(
            "INSERT INTO sandbox_provider_settings VALUES (?, ?, ?, ?, ?)",
            ("p", "lambda_labs", 1, 20, "PRIVATE-PROVIDER-SECRET"),
        )
    before = path.read_bytes()
    with exporter.source_connection(sqlite=path) as connection:
        result = exporter.inventory(
            connection, source_id="deployment-1", as_of=datetime(2026, 9, 9, tzinfo=UTC)
        )
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("DELETE FROM projects")
    assert "PRIVATE-PROVIDER-SECRET" not in json.dumps(result)
    assert "credentials" not in json.dumps(result)
    assert path.read_bytes() == before
    target = tmp_path / "snapshot.json"
    exporter.write_private(target, result)
    assert target.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        exporter.write_private(target, result)


@pytest.mark.parametrize("cap", [0, 25])
@pytest.mark.parametrize("field", ["usd_budget", "gpu_hours_budget"])
def test_cumulative_tenant_limit_exports_only_after_explicit_full_scope_mapping(
    exporter, inputs, cap, field
):
    inputs[0]["tables"]["tenant_quotas"] = [{"tenant_id": "t", field: cap}]
    resign(exporter, inputs[0])
    assert "manifest" not in exporter.convert(*inputs)
    inputs[1]["tenant_accounts"] = {"t": "account"}
    result = exporter.convert(*inputs)
    cumulative = next(
        row for row in result["manifest"]["policies"] if row["window"] == "all_time"
    )
    assert (cumulative["scope"], cumulative["target"], cumulative["cap"]) == (
        "account",
        "account",
        str(cap),
    )
    assert cumulative["metric"] == (
        "money" if field == "usd_budget" else "compute_hours"
    )
    assert cumulative["currency"] == ("USD" if field == "usd_budget" else None)
    assert cumulative["source"] is None and cumulative["provider"] is None
    assert any(
        row["kind"] == "admission-semantics-change"
        for row in result["report"]["decisions"]
    )


@pytest.mark.parametrize(
    "missing", ["project", "generation", "attribution", "second_tenant"]
)
def test_cumulative_export_rejects_partial_or_combined_tenant_history(
    exporter, inputs, missing
):
    tables = inputs[0]["tables"]
    tables["tenant_quotas"] = [{"tenant_id": "t", "usd_budget": 25}]
    inputs[1]["tenant_accounts"] = {"t": "account"}
    if missing == "project":
        tables["projects"].append({"id": "excluded", "tenant_id": "t"})
    elif missing == "generation":
        # The legacy ledger retains tenant attribution even if its project is
        # missing from today's project inventory. A project join loses this cost.
        tables["sandbox_generations"].append(
            {
                **tables["sandbox_generations"][0],
                "id": "orphan",
                "project_id": "departed",
            }
        )
    elif missing == "attribution":
        tables["sandbox_generations"][0].pop("tenant_id")
    else:
        tables["projects"].append({"id": "second", "tenant_id": "other"})
        inputs[1]["projects"]["second"] = {
            "namespace": "ns2",
            "default_member_id": "member",
        }
        inputs[2]["namespaces"].append(
            {
                "name": "ns2",
                "expected_account_id": "old-account",
                "default_member_id": "member",
            }
        )
        inputs[3][0]["namespaces"].append({"name": "ns2"})
    resign(exporter, inputs[0])
    result = exporter.convert(*inputs)
    assert "manifest" not in result
    assert any(row["kind"] == "tenant_quota" for row in result["report"]["conflicts"])


def test_dormant_blob_allowance_is_preserved_without_inventing_enforcement(
    exporter, inputs
):
    inputs[0]["tables"]["tenant_quotas"] = [
        {"tenant_id": "t", "blob_bytes_budget": 4096}
    ]
    resign(exporter, inputs[0])
    result = exporter.convert(*inputs)
    assert result["report"]["ready_for_native_preview"]
    dormant = next(
        row
        for row in result["report"]["decisions"]
        if row["kind"] == "dormant-tenant-quota"
    )
    assert dormant["value"] == 4096
    assert dormant["tenant_id"] == "t"
    assert dormant["field"] == "blob_bytes_budget"
    assert not any(row["scope"] == "account" for row in result["manifest"]["policies"])


@pytest.mark.parametrize(
    "field,native_field,value",
    [
        ("max_concurrent_sandboxes", "max_concurrent", 0),
        ("max_time_limit_seconds", "max_lifetime_seconds", 7200),
        ("max_price_usd_per_hour", "max_hourly_price", 1.25),
    ],
)
def test_resource_ceiling_exports_under_complete_tenant_scope(
    exporter, inputs, field, native_field, value
):
    inputs[0]["tables"]["tenant_quotas"] = [{"tenant_id": "t", field: value}]
    resign(exporter, inputs[0])
    assert "manifest" not in exporter.convert(*inputs)
    inputs[1]["tenant_accounts"] = {"t": "account"}
    result = exporter.convert(*inputs)
    limit = result["manifest"]["resource_limits"][0]
    assert limit["scope"] == "account" and limit["target"] == "account"
    assert limit[native_field] == (
        {"amount": "1.25", "currency": "USD"}
        if field == "max_price_usd_per_hour"
        else value
    )


def test_live_resources_need_mapping_and_preserved_lifetime_origin(exporter, inputs):
    snapshot, mapping, base, native = inputs
    snapshot["tables"]["tenant_quotas"] = [
        {
            "tenant_id": "t",
            "max_concurrent_sandboxes": 2,
            "max_time_limit_seconds": 7200,
        }
    ]
    snapshot["tables"]["sandboxes"] = [
        {
            "sandbox_uid": "live-old",
            "project_id": "p",
            "tenant_id": "t",
            "provider": "lambda_labs",
            "status": "running",
            "time_limit": 7200,
            "expires_at": "2026-09-09T01:00:00Z",
        }
    ]
    mapping["tenant_accounts"] = {"t": "account"}
    resign(exporter, snapshot)
    assert "manifest" not in exporter.convert(*inputs)
    native[0]["compute"] = [
        {
            "id": "native-live",
            "namespace": "ns",
            "plugin": "lambda",
            "created_at": "2026-09-08T23:30:00Z",
            "stopped_at": None,
            "lifetime_started_at": "2026-09-08T23:30:00Z",
        }
    ]
    base["compute"] = [
        {"sandbox_id": "native-live", "member_id": "member", "source": "host"}
    ]
    mapping["resources"] = {
        "live-old": {
            "native_sandbox_id": "native-live",
            "evidence": "Reviewed the provider resource and saved lease",
        }
    }
    result = exporter.convert(*inputs)
    assert (
        result["manifest"]["lifetime_resolutions"]["native-live"]["started_at"]
        == "2026-09-08T23:00:00+00:00"
    )
    native[0]["compute"][0]["lifetime_started_at"] = "2026-09-08T22:00:00Z"
    result = exporter.convert(*inputs)
    assert not result["manifest"].get("lifetime_resolutions")
    assert any(
        "earlier native lifetime" in row.get("treatment", "")
        for row in result["report"]["decisions"]
    )
    # A reviewed mapping cannot claim a stopped resource is still the live machine.
    native[0]["compute"][0]["stopped_at"] = "2026-09-08T23:55:00Z"
    assert "manifest" not in exporter.convert(*inputs)
    native[0]["compute"][0]["stopped_at"] = None
    mapping["resources"]["live-old"]["lifetime_started_at"] = "2026-09-08T23:30:00Z"
    # Evidence does not authorize changing a known saved origin.
    assert "manifest" not in exporter.convert(*inputs)
    mapping["resources"]["live-old"].pop("lifetime_started_at")
    snapshot["tables"]["sandboxes"].append(
        {**snapshot["tables"]["sandboxes"][0], "sandbox_uid": "another-live"}
    )
    mapping["resources"]["another-live"] = mapping["resources"]["live-old"].copy()
    resign(exporter, snapshot)
    # Two legacy slots cannot become one native resource during reconciliation.
    assert "manifest" not in exporter.convert(*inputs)


def test_resource_quota_cannot_omit_another_tenant_project(exporter, inputs):
    inputs[0]["tables"]["tenant_quotas"] = [
        {"tenant_id": "t", "max_concurrent_sandboxes": 2}
    ]
    inputs[0]["tables"]["projects"].append({"id": "missing", "tenant_id": "t"})
    inputs[1]["tenant_accounts"] = {"t": "account"}
    resign(exporter, inputs[0])
    assert "manifest" not in exporter.convert(*inputs)


@pytest.mark.parametrize(
    "scope,halted",
    [("__global__", True), ("t", True), ("global", False), ("unrelated", False)],
)
def test_spending_halt_uses_the_actual_legacy_global_scope(
    exporter, inputs, scope, halted
):
    # quotas.py at 55c1a1c894bdf83b7f32b2389002b46528329487 declares
    # GLOBAL_SCOPE = "__global__". An ordinary tenant called "global" is different.
    inputs[0]["tables"]["spend_kill_switches"] = [{"scope": scope, "tripped": 1}]
    resign(exporter, inputs[0])
    report = exporter.convert(*inputs)["report"]
    assert report["requires_spending_suspension"] is halted
    assert report["legacy_stops"] == (
        [{"scope": scope, "tripped": 1}] if halted else []
    )
