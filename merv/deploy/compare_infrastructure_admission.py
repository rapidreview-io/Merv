#!/usr/bin/env python3
"""Compare recorded legacy decisions with a private native policy review.

This offline migration tool contains no allowance calculation. It compares
captured decisions and requires explicit evidence for changed outcomes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any


class ReviewError(ValueError):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def instant(value: Any) -> datetime:
    try:
        result = datetime.fromisoformat(str(value))
    except ValueError:
        raise ReviewError("decision timestamps must be valid") from None
    if result.tzinfo is None:
        raise ReviewError("decision timestamps require a timezone")
    return result


def indexed(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not rows or len(rows) > 1000:
        raise ReviewError("supply between 1 and 1000 recorded cases")
    result = {}
    for row in rows:
        if not isinstance(row.get("id"), str) or not row["id"] or row["id"] in result:
            raise ReviewError("case IDs must be nonempty and unique")
        if type(row.get("allowed")) is not bool:
            raise ReviewError("each recorded decision requires a boolean allowed value")
        result[row["id"]] = row
    return result


def compare(
    legacy: dict[str, Any],
    native_report: dict[str, Any],
    resolutions: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    native = native_report.get("admission_review", native_report)
    resolutions = resolutions or {}
    if legacy.get("version") != 1 or native.get("version") != 1:
        raise ReviewError("unsupported decision report version")
    if not legacy.get("source_id") or not re.fullmatch(
        "[0-9a-f]{40}", legacy.get("source_revision", "")
    ):
        raise ReviewError(
            "legacy decisions require a deployment ID and immutable source revision"
        )
    if not re.fullmatch("[0-9a-f]{64}", legacy.get("snapshot_sha256", "")):
        raise ReviewError("legacy decisions require the snapshot digest")
    if (
        native.get("reserves_compute") is not False
        or native.get("independent_cases") is not True
    ):
        raise ReviewError(
            "native evidence must be an independent, non-reserving review"
        )
    if native.get("consistency") != "repeatable_read":
        raise ReviewError("native evidence requires one repeatable-read snapshot")
    if native.get("state_sha256") != digest(native["snapshot"]):
        raise ReviewError("native snapshot checksum mismatch")
    before, after = indexed(legacy["cases"]), indexed(native["cases"])
    input_document = {
        "version": 1,
        "account_id": native["account_id"],
        "assume_spending_enabled": native["assume_spending_enabled"],
        "cases": [row["request"] for row in native["cases"]],
    }
    if native.get("input_sha256") != digest(input_document):
        raise ReviewError("native review input checksum mismatch")
    conflicts, differences, matches = [], [], []
    if instant(legacy["as_of"]) != instant(native["as_of"]):
        conflicts.append(
            {
                "kind": "evaluation_time",
                "reason": "replay both engines at the same instant",
            }
        )
    if instant(native["snapshot"]["as_of"]) != instant(native["as_of"]):
        raise ReviewError("native snapshot and decision times differ")
    if before.keys() != after.keys():
        conflicts.append(
            {
                "kind": "case_coverage",
                "legacy_only": sorted(before.keys() - after.keys()),
                "native_only": sorted(after.keys() - before.keys()),
            }
        )
    consumed_resolutions = set()
    for id in sorted(before.keys() & after.keys()):
        old, new = before[id], after[id]
        if new["request"].get("id") != id or new.get("request_sha256") != digest(
            new["request"]
        ):
            raise ReviewError("native request checksum or case ID mismatch")
        if old.get("native_request_sha256") != new["request_sha256"]:
            conflicts.append(
                {
                    "kind": "request_mapping",
                    "id": id,
                    "reason": "legacy decision does not bind this native request",
                }
            )
            continue
        if not isinstance(old.get("evidence"), str) or not old["evidence"].strip():
            raise ReviewError("legacy decisions require execution evidence")
        if (
            "expected_native_reason" not in old
            or (old["allowed"] and old["expected_native_reason"] is not None)
            or (
                not old["allowed"]
                and not isinstance(old["expected_native_reason"], str)
            )
        ):
            raise ReviewError(
                "legacy decisions require an explicit normalized denial reason"
            )
        error = new.get("error", {})
        actual_reason = (
            None
            if new["allowed"]
            else error.get("details", {}).get("reason", error.get("code"))
        )
        if not new["allowed"] and not actual_reason:
            raise ReviewError("native denial has no reason or error code")
        if (
            old["allowed"] == new["allowed"]
            and old["expected_native_reason"] == actual_reason
        ):
            matches.append(id)
            continue
        binding = {
            "legacy_report_sha256": digest(legacy),
            "native_report_sha256": digest(native_report),
            "legacy_snapshot_sha256": legacy["snapshot_sha256"],
            "native_state_sha256": native["state_sha256"],
            "native_request_sha256": new["request_sha256"],
            "legacy_allowed": old["allowed"],
            "native_allowed": new["allowed"],
            "native_reason": actual_reason,
            "legacy_reason": old["expected_native_reason"],
        }
        resolution = resolutions.get(id)
        resolved = bool(
            resolution
            and all(resolution.get(key) == value for key, value in binding.items())
            and isinstance(resolution.get("evidence"), str)
            and 0 < len(resolution["evidence"].strip()) <= 4096
        )
        if resolution is not None:
            consumed_resolutions.add(id)
        differences.append(
            {
                "id": id,
                **binding,
                "resolved": resolved,
                "evidence": resolution["evidence"] if resolved else None,
            }
        )
    for id in sorted(resolutions.keys() - consumed_resolutions):
        conflicts.append({"kind": "unused_resolution", "id": id})
    return {
        "version": 1,
        "source_id": legacy["source_id"],
        "source_revision": legacy["source_revision"],
        "as_of": native["as_of"],
        "legacy_report_sha256": digest(legacy),
        "native_report_sha256": digest(native_report),
        "resolutions_sha256": digest(resolutions),
        "matches": matches,
        "differences": differences,
        "conflicts": conflicts,
        "selected_cases_reconciled": not conflicts
        and all(row["resolved"] for row in differences),
        "coverage": "recorded_cases_only",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-decisions", type=Path, required=True)
    parser.add_argument("--native-review", type=Path, required=True)
    parser.add_argument("--resolutions", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = compare(
            json.loads(args.legacy_decisions.read_text()),
            json.loads(args.native_review.read_text()),
            json.loads(args.resolutions.read_text()) if args.resolutions else None,
        )
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
        print("Wrote private comparison; coverage is limited to the recorded cases.")
        return 0 if report["selected_cases_reconciled"] else 2
    except Exception as exc:  # noqa: BLE001 -- never expose private file content in errors
        print(
            str(exc)
            if isinstance(exc, ReviewError)
            else "Cannot compare the supplied evidence or create the output."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
