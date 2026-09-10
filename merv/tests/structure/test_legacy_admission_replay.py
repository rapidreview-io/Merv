"""Execute the pinned legacy engine without importing it into Merv's runtime."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def replay_tool():
    path = Path(__file__).parents[2] / "deploy" / "replay_legacy_admission.py"
    spec = importlib.util.spec_from_file_location("legacy_replay_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seal(tool, snapshot, native):
    snapshot["sha256"] = tool.digest(
        {key: value for key, value in snapshot.items() if key != "sha256"}
    )
    native["state_sha256"] = tool.digest(native["snapshot"])
    for case in native["cases"]:
        case["request_sha256"] = tool.digest(case["request"])
    native["input_sha256"] = tool.digest(
        {
            "version": 1,
            "account_id": native["account_id"],
            "assume_spending_enabled": native["assume_spending_enabled"],
            "cases": [row["request"] for row in native["cases"]],
        }
    )


@pytest.fixture
def inputs(replay_tool):
    exporter = replay_tool.read_module(
        Path(replay_tool.__file__).with_name("export_infrastructure_budgets.py"),
        "legacy_replay_export",
    )
    snapshot = {
        "version": 1,
        "source_id": "fixture",
        "as_of": "2026-01-01T12:00:00+00:00",
        "tables": {table: [] for table in exporter.COLUMNS},
    }
    snapshot["tables"]["projects"] = [{"id": "p", "tenant_id": "t"}]
    snapshot["tables"]["tenant_quotas"] = [
        {
            **dict.fromkeys(exporter.COLUMNS["tenant_quotas"].split()),
            "tenant_id": "t",
        }
    ]
    mapping = {
        "version": 1,
        "source_id": "fixture",
        "tenant_accounts": {"t": "account"},
        "projects": {"p": {"namespace": "one"}},
        "users": {"u": "member"},
        "providers": {"old": "fake"},
        "cases": {
            "case": {
                "project_id": "p",
                "user_id": "u",
                "provider": "old",
                "price_unknown_reason": "",
            }
        },
    }
    request = {
        "id": "case",
        "namespace": "one",
        "member_id": "member",
        "lease_seconds": 3600,
        "offer": {"plugin": "fake", "hourly_price": {"currency": "USD", "amount": "1"}},
        "source": "host",
        "sandbox_id": None,
    }
    native = {
        "version": 1,
        "account_id": "account",
        "as_of": snapshot["as_of"],
        "snapshot": {
            "account": {"id": "account"},
            "as_of": snapshot["as_of"],
            "compute": [],
        },
        "assume_spending_enabled": False,
        "independent_cases": True,
        "reserves_compute": False,
        "consistency": "repeatable_read",
        "cases": [{"id": "case", "request": request, "allowed": True}],
    }
    return snapshot, mapping, native


def run(tool, inputs):
    snapshot, _mapping, native = inputs
    seal(tool, snapshot, native)
    before = copy.deepcopy(inputs)
    output = tool.replay(*inputs, repository=Path(__file__).parents[3])
    assert inputs == before
    assert output["scope"] == "legacy_quota_service"
    assert output["source_revision"] == tool.REVISION
    assert all(len(value) == 64 for value in output["source_sha256"].values())
    return output


@pytest.mark.parametrize(
    "scope,denied", [("__global__", True), ("t", True), ("global", False)]
)
def test_replays_actual_reserved_global_halt(replay_tool, inputs, scope, denied):
    inputs[0]["tables"]["spend_kill_switches"] = [{"scope": scope, "tripped": 1}]
    case = run(replay_tool, inputs)["cases"][0]
    assert case["allowed"] is not denied
    assert case["expected_native_reason"] == ("spending_suspended" if denied else None)


@pytest.mark.parametrize("reason,denied", [("catalog has no quote", True), ("", False)])
def test_preserves_legacy_unknown_price_caller_semantics(
    replay_tool, inputs, reason, denied
):
    snapshot, mapping, native = inputs
    snapshot["tables"]["tenant_quotas"][0]["usd_budget"] = 100
    mapping["cases"]["case"]["price_unknown_reason"] = reason
    native["cases"][0]["request"]["offer"]["hourly_price"] = None
    case = run(replay_tool, inputs)["cases"][0]
    assert case["allowed"] is not denied
    assert case["expected_native_reason"] == ("unpriced_offer" if denied else None)


def test_saved_payer_renewal_uses_fixed_clock_and_does_not_mutate_source(
    replay_tool, inputs
):
    snapshot, mapping, native = inputs
    snapshot["tables"]["sandboxes"] = [
        {
            "sandbox_uid": "old-vm",
            "project_id": "p",
            "tenant_id": "t",
            "provider": "old",
            "status": "running",
            "time_limit": 3600,
            "expires_at": "2026-01-01T12:30:00+00:00",
            "user_id": "u",
            "billing_mode": "platform",
            "quoted_price_usd_per_hour": 1,
            "price_usd_per_hour": 1,
        }
    ]
    snapshot["tables"]["provider_user_caps"] = [
        {"provider": "old", "user_id": "u", "daily_usd_limit": 0.75}
    ]
    native["snapshot"]["compute"] = [
        {
            "id": "vm",
            "namespace": "one",
            "member_id": "member",
            "plugin": "fake",
            "source": "host",
            "currency": "USD",
            "rate": "1",
            "stopped_at": None,
        }
    ]
    native["cases"][0]["request"].update(
        sandbox_id="vm", member_id=None, offer=None, source=None
    )
    mapping["resources"] = {
        "old-vm": {"native_sandbox_id": "vm", "evidence": "fixture mapping"}
    }
    mapping["cases"]["case"]["sandbox_uid"] = "old-vm"
    case = run(replay_tool, inputs)["cases"][0]
    assert not case["allowed"] and case["expected_native_reason"] == "budget_exceeded"
    assert case["legacy_request"]["added_seconds"] == 1800
    assert case["legacy_request"]["total_time_limit_seconds"] == 5400
    # Explicit unlimited override must replace the inherited daily cap, including
    # the row-touch serialization performed by the original extension method.
    snapshot["tables"]["provider_user_caps"][0]["daily_usd_limit"] = None
    snapshot["tables"]["provider_user_caps"].append(
        {"provider": "old", "user_id": "", "daily_usd_limit": 0}
    )
    assert run(replay_tool, inputs)["cases"][0]["allowed"]
    native["cases"][0]["request"]["lease_seconds"] = 60
    seal(replay_tool, snapshot, native)
    with pytest.raises(replay_tool.ReplayError, match="no exact positive"):
        replay_tool.replay(*inputs, repository=Path(__file__).parents[3])


@pytest.mark.parametrize(
    "change",
    [
        "payer",
        "provider",
        "project",
        "missing_resource",
        "duplicate",
        "clock",
        "consistency",
        "missing_reason",
    ],
)
def test_invalid_review_mapping_fails_before_legacy_execution(
    replay_tool, inputs, change, monkeypatch
):
    snapshot, mapping, native = inputs
    if change in {"payer", "provider", "project"}:
        key = {"payer": "user_id", "provider": "provider", "project": "project_id"}[
            change
        ]
        mapping["cases"]["case"][key] = "wrong"
    elif change == "missing_resource":
        native["cases"][0]["request"].update(
            sandbox_id="absent", member_id=None, offer=None
        )
    elif change == "duplicate":
        snapshot["tables"]["projects"] *= 2
    elif change == "clock":
        native["snapshot"]["as_of"] = "2026-01-01T12:00:01+00:00"
    elif change == "consistency":
        native["consistency"] = "read_committed"
    else:
        del mapping["cases"]["case"]["price_unknown_reason"]
    seal(replay_tool, snapshot, native)

    def no_subprocess(*args, **kwargs):
        pytest.fail("invalid mapping reached source execution")

    monkeypatch.setattr(replay_tool.subprocess, "run", no_subprocess)
    with pytest.raises(replay_tool.ReplayError):
        replay_tool.replay(*inputs, repository=Path(__file__).parents[3])


def test_cli_retains_private_evidence_and_never_overwrites(
    replay_tool, inputs, tmp_path, monkeypatch
):
    seal(replay_tool, inputs[0], inputs[2])
    arguments = ["replay"]
    for option, data in zip(
        ("snapshot", "mapping", "native-review"), inputs, strict=True
    ):
        path = tmp_path / f"{option}.json"
        path.write_text(json.dumps(data))
        arguments.extend([f"--{option}", str(path)])
    output = tmp_path / "decisions.json"
    arguments.extend(
        ["--repository", str(Path(__file__).parents[3]), "--output", str(output)]
    )
    monkeypatch.setattr("sys.argv", arguments)
    assert replay_tool.main() == 0
    original = output.read_bytes()
    assert output.stat().st_mode & 0o777 == 0o600
    assert replay_tool.main() == 1 and output.read_bytes() == original
