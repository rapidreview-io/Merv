"""Migration comparisons bind outcomes, mapped requests and immutable evidence."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def comparator():
    path = Path(__file__).parents[2] / "deploy" / "compare_infrastructure_admission.py"
    spec = importlib.util.spec_from_file_location("admission_comparison", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def evidence(comparator):
    request = {"id": "case", "namespace": "one", "lease_seconds": 3600}
    state = {"as_of": "2026-09-09T00:00:00+00:00", "account": {"id": "account"}}
    native = {
        "version": 1,
        "account_id": "account",
        "as_of": state["as_of"],
        "snapshot": state,
        "state_sha256": comparator.digest(state),
        "assume_spending_enabled": True,
        "independent_cases": True,
        "reserves_compute": False,
        "consistency": "repeatable_read",
        "cases": [
            {
                "id": "case",
                "request": request,
                "request_sha256": comparator.digest(request),
                "allowed": False,
                "error": {
                    "code": "validation",
                    "details": {"reason": "budget_exceeded"},
                },
            }
        ],
    }
    native["input_sha256"] = comparator.digest(
        {
            "version": 1,
            "account_id": "account",
            "assume_spending_enabled": True,
            "cases": [request],
        }
    )
    legacy = {
        "version": 1,
        "source_id": "test-fixture",
        "source_revision": "a" * 40,
        "snapshot_sha256": "b" * 64,
        "as_of": state["as_of"],
        "cases": [
            {
                "id": "case",
                "native_request_sha256": comparator.digest(request),
                "allowed": True,
                "expected_native_reason": None,
                "evidence": "Synthetic comparison fixture, not a production replay",
            }
        ],
    }
    return legacy, native


def test_changed_outcome_needs_evidence_bound_to_exact_reports(comparator, evidence):
    legacy, native = evidence
    report = comparator.compare(legacy, native)
    assert not report["selected_cases_reconciled"]
    change = report["differences"][0]
    assert change["legacy_allowed"] and not change["native_allowed"]
    resolutions = {
        "case": {
            **change,
            "evidence": "Reviewed intended future-commitment reservation",
        }
    }
    assert comparator.compare(legacy, native, resolutions)["selected_cases_reconciled"]
    native["cases"][0]["error"]["details"]["reason"] = "provider_disabled"
    assert not comparator.compare(legacy, native, resolutions)[
        "selected_cases_reconciled"
    ]


def test_matching_denials_need_no_resolution_and_unused_approvals_are_rejected(
    comparator, evidence
):
    legacy, native = evidence
    legacy["cases"][0].update(allowed=False, expected_native_reason="budget_exceeded")
    report = comparator.compare(legacy, {"admission_review": native})
    assert report["selected_cases_reconciled"] and report["matches"] == ["case"]
    assert not comparator.compare(legacy, native, {"case": {"evidence": "stale"}})[
        "selected_cases_reconciled"
    ]


@pytest.mark.parametrize("changed", ["snapshot", "request", "input", "case_id"])
def test_modified_native_evidence_fails_checksums(comparator, evidence, changed):
    legacy, native = evidence
    if changed == "snapshot":
        native["snapshot"]["account"]["id"] = "different"
    elif changed == "request":
        native["cases"][0]["request"]["lease_seconds"] = 60
    elif changed == "input":
        native["assume_spending_enabled"] = False
    else:
        native["cases"][0]["id"] = "different"
        legacy["cases"][0]["id"] = "different"
    with pytest.raises(comparator.ReviewError):
        comparator.compare(legacy, native)


@pytest.mark.parametrize("changed", ["clock", "mapping", "missing_case"])
def test_changed_case_scope_clock_or_mapping_blocks_reconciliation(
    comparator, evidence, changed
):
    legacy, native = evidence
    if changed == "clock":
        legacy["as_of"] = "2026-09-09T00:00:01+00:00"
    elif changed == "mapping":
        legacy["cases"][0]["native_request_sha256"] = "c" * 64
    else:
        legacy["cases"].append({**legacy["cases"][0], "id": "missing"})
    report = comparator.compare(legacy, native)
    assert report["conflicts"] and not report["selected_cases_reconciled"]


def test_change_in_legacy_reason_invalidates_previously_reviewed_difference(
    comparator, evidence
):
    legacy, native = evidence
    legacy["cases"][0].update(allowed=False, expected_native_reason="authorization")
    change = comparator.compare(legacy, native)["differences"][0]
    resolution = {"case": {**change, "evidence": "Reviewed this specific change"}}
    assert comparator.compare(legacy, native, resolution)["selected_cases_reconciled"]
    legacy["cases"][0]["expected_native_reason"] = "concurrency_exceeded"
    assert not comparator.compare(legacy, native, resolution)[
        "selected_cases_reconciled"
    ]


def test_cli_preserves_private_evidence_and_refuses_overwrite(
    comparator, evidence, tmp_path, monkeypatch
):
    legacy, native = copy.deepcopy(evidence)
    legacy_file, native_file, output = (
        tmp_path / "legacy.json",
        tmp_path / "native.json",
        tmp_path / "result.json",
    )
    legacy_file.write_text(json.dumps(legacy))
    native_file.write_text(json.dumps(native))
    monkeypatch.setattr(
        "sys.argv",
        [
            "compare",
            "--legacy-decisions",
            str(legacy_file),
            "--native-review",
            str(native_file),
            "--output",
            str(output),
        ],
    )
    assert comparator.main() == 2
    saved = output.read_bytes()
    assert output.stat().st_mode & 0o777 == 0o600
    assert comparator.main() == 1 and output.read_bytes() == saved
