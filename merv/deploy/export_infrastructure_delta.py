#!/usr/bin/env python3
"""Append uncovered legacy usage after an applied infrastructure-account import.

This is an offline Merv migration tool. Native policy and installed charges stay
authoritative. A fresh reviewed native base is required; the output uses the
ordinary application-neutral account-import format.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path
from typing import Any


def exporter_module():
    spec = importlib.util.spec_from_file_location(
        "delta_legacy_export",
        Path(__file__).with_name("export_infrastructure_budgets.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def advance(
    snapshot: dict[str, Any],
    mapping: dict[str, Any],
    base: dict[str, Any],
    native_inventories: list[dict[str, Any]],
    *,
    previous: dict[str, Any],
    previous_snapshot: dict[str, Any],
    previous_mapping: dict[str, Any],
) -> dict[str, Any]:
    # Run this offline utility in the native service's operator environment. Use
    # its generic receipt codec instead of copying its schema defaults into Merv.
    from merv_sandboxes.account_import import AccountImport, manifest_fingerprint

    ex = exporter_module()
    old_report, old_manifest = previous["report"], previous["manifest"]
    previous_fingerprint = manifest_fingerprint(
        AccountImport.model_validate(old_manifest)
    )
    receipts = [
        row
        for inventory in native_inventories
        for row in inventory.get("import_batches", [])
        if row["id"] == old_manifest["batch_id"]
    ]
    if (
        len(receipts) != 1
        or receipts[0]["account_id"] != base["account_id"]
        or receipts[0]["sha256"] != previous_fingerprint
    ):
        raise ex.ExportError(
            "previous manifest has no matching applied native receipt; use a fresh full export for an unapplied rehearsal"
        )
    if (
        old_report.get("manifest_sha256") != ex.digest(old_manifest)
        or old_report.get("snapshot_sha256") != previous_snapshot.get("sha256")
        or previous_snapshot.get("sha256")
        != ex.digest({k: v for k, v in previous_snapshot.items() if k != "sha256"})
        or old_report.get("mapping_sha256") != ex.digest(previous_mapping)
        or old_report.get("ready_for_native_preview") is not True
        or old_report.get("conflicts")
    ):
        raise ex.ExportError("previous export and its source evidence do not match")
    if (
        base["account_id"] != old_manifest["account_id"]
        or base["batch_id"] == old_manifest["batch_id"]
        or snapshot["source_id"] != previous_snapshot["source_id"]
        or ex.timestamp(snapshot["as_of"]) < ex.timestamp(previous_snapshot["as_of"])
    ):
        raise ex.ExportError(
            "delta requires the same source/account, a new batch, and a later snapshot"
        )
    for key in (
        "source_id",
        "application_id",
        "projects",
        "users",
        "providers",
        "tenant_accounts",
    ):
        if mapping.get(key) != previous_mapping.get(key):
            raise ex.ExportError(
                "delta identity mappings changed; reconcile ownership separately"
            )

    # Reuse the source converter, but never feed installed charges or policies
    # back into a full conversion. Its candidates describe source coverage only.
    source_base = copy.deepcopy(base)
    for key in (
        "policies",
        "resource_limits",
        "adjustments",
        "provider_controls",
        "subjects",
        "usage_gaps",
    ):
        source_base[key] = []
    fresh = ex.convert(snapshot, mapping, source_base, native_inventories)
    report = {
        **fresh["report"],
        "mode": "applied_delta",
        "base_sha256": ex.digest(base),
        "previous_export_sha256": ex.digest(previous),
        "native_inventory_sha256": [ex.digest(row) for row in native_inventories],
        "policy_authority": "current_native_base",
        "added_adjustments": [],
        "preserved_adjustments": [],
        "rounding_differences": [],
    }
    report.pop("manifest_sha256", None)
    conflicts = report["conflicts"]

    def conflict(record: str, reason: str):
        conflicts.append({"kind": "delta", "record": record, "reason": reason})

    projects = set(mapping["projects"])
    tenants = {
        r["tenant_id"] for r in snapshot["tables"]["projects"] if r["id"] in projects
    }

    def policy_rows(saved):
        tables = saved["tables"]
        return {
            "projects": [r for r in tables["projects"] if r["id"] in projects],
            "project_members": [
                r for r in tables["project_members"] if r["project_id"] in projects
            ],
            "sandbox_provider_settings": [
                r
                for r in tables["sandbox_provider_settings"]
                if r["project_id"] in projects
            ],
            "provider_user_caps": [
                r
                for r in tables["provider_user_caps"]
                if r["provider"] in mapping["providers"]
            ],
            "tenant_quotas": [
                r for r in tables["tenant_quotas"] if r["tenant_id"] in tenants
            ],
            "spend_kill_switches": [
                r
                for r in tables["spend_kill_switches"]
                if r["scope"] in tenants | {"__global__"}
            ],
        }

    old_policies, new_policies = policy_rows(previous_snapshot), policy_rows(snapshot)
    for table in old_policies:
        if sorted(old_policies[table], key=ex.canonical) != sorted(
            new_policies[table], key=ex.canonical
        ):
            conflict(
                table,
                "legacy policy/authority changed during the freeze; reconcile it before a usage delta",
            )
    old_generations = {
        r["id"]: r
        for r in previous_snapshot["tables"]["sandbox_generations"]
        if r["project_id"] in projects
    }
    generations = {
        r["id"]: r
        for r in snapshot["tables"]["sandbox_generations"]
        if r["project_id"] in projects
    }
    for id, old in old_generations.items():
        current = generations.get(id)
        fields = (
            "tenant_id",
            "project_id",
            "experiment_id",
            "sandbox_id",
            "sandbox_uid",
            "provider",
            "user_id",
            "billing_mode",
            "price_known",
            "price_usd_per_hour",
            "started_at",
        )
        if (
            not current
            or any(old.get(key) != current.get(key) for key in fields)
            or (old["ended_at"] and old["ended_at"] != current["ended_at"])
        ):
            conflict(
                id,
                "previous generation history is missing or its immutable facts changed",
            )
    if "manifest" not in fresh:
        report["ready_for_native_preview"] = False
        return {"report": report}

    source = snapshot["source_id"]

    def owned(row):
        provenance = row.get("provenance", {})
        return (
            provenance.get("application") == "merv"
            and provenance.get("source_id") == source
        )

    def indexed(rows):
        result = {row["id"]: row for row in rows}
        if len(result) != len(rows):
            raise ex.ExportError("duplicate adjustment identifiers in delta evidence")
        return result

    def charge(row):
        return {
            **{
                key: row[key]
                for key in (
                    "id",
                    "namespace",
                    "member_id",
                    "provider",
                    "source",
                    "currency",
                    "provenance",
                )
            },
            "amount": ex.money(row["amount"]),
            "compute_hours": ex.money(row.get("compute_hours")),
            "at": ex.timestamp(row["at"]).isoformat(),
        }

    installed = {}
    for inventory in native_inventories:
        if inventory["account"]["id"] != base["account_id"]:
            raise ex.ExportError(
                "applied delta requires inventories from the destination account"
            )
        if ex.timestamp(inventory.get("as_of")) < ex.timestamp(snapshot["as_of"]):
            conflict(
                "native_inventory",
                "capture native state at or after the source cutoff; stale live state cannot prove overlap",
            )
        for row in inventory["adjustments"]:
            if row["account_id"] != base["account_id"] or row["id"] in installed:
                raise ex.ExportError(
                    "native adjustment ownership or identity is ambiguous"
                )
            installed[row["id"]] = row
    previous_charges = indexed(
        [r for r in old_manifest.get("adjustments", []) if owned(r)]
    )
    actual_charges = {id: row for id, row in installed.items() if owned(row)}
    if previous_charges.keys() != actual_charges.keys():
        conflict(
            "installed",
            "native source charges differ from the previous export; inspect the applied batches",
        )
    for id in previous_charges.keys() & actual_charges.keys():
        if charge(previous_charges[id]) != charge(actual_charges[id]):
            conflict(
                id, "installed source charge differs from the previous immutable export"
            )
    if any(row.get("compute_hours") is None for row in actual_charges.values()):
        conflict(
            "compute_hours",
            "source credits require measured hours before interval reconciliation",
        )
        report["ready_for_native_preview"] = False
        return {"report": report}
    base_charges = indexed(base.get("adjustments", []))
    # No invented base entry may be counted as already paid; importer validation
    # remains the final transactional check of every current native policy/row.
    if base_charges.keys() != installed.keys() or any(
        charge(row) != charge(installed[id])
        for id, row in base_charges.items()
        if id in installed
    ):
        conflict(
            "base", "current base must preserve exactly the inventoried native charges"
        )

    candidates = fresh["manifest"]["adjustments"]
    credited = set()
    additions = []
    quantum = Decimal("0.000000000001")
    for candidate in candidates:
        provenance = candidate["provenance"]
        generation = provenance["generation_id"]
        start, end = (
            ex.timestamp(provenance["started_at"]),
            ex.timestamp(provenance["ended_at"]),
        )
        covered = []
        for id, row in actual_charges.items():
            old = row["provenance"]
            if old.get("generation_id") != generation:
                continue
            lower, upper = (
                ex.timestamp(old["started_at"]),
                ex.timestamp(old["ended_at"]),
            )
            if lower < end and upper > start:
                if (
                    lower < start
                    or upper > end
                    or lower >= upper
                    or any(
                        row[key] != candidate[key]
                        for key in (
                            "namespace",
                            "member_id",
                            "provider",
                            "source",
                            "currency",
                        )
                    )
                    or ex.money(old["hourly_rate"])
                    != ex.money(provenance["hourly_rate"])
                    or old.get("project_id") != provenance["project_id"]
                    or old.get("experiment_id") != provenance["experiment_id"]
                ):
                    conflict(
                        id,
                        "credited interval or attribution conflicts with current uncovered source history",
                    )
                    continue
                covered.append((lower, upper, id))
                credited.add(id)
        cursor = start
        gaps = []
        for lower, upper, id in sorted(covered):
            if lower < cursor:
                conflict(id, "installed source credits overlap")
            if lower > cursor:
                gaps.append((cursor, lower))
            cursor = max(cursor, upper)
        if cursor < end:
            gaps.append((cursor, end))
        pieces = []
        for lower, upper in gaps:
            hours = Decimal(str((upper - lower).total_seconds())) / Decimal(3600)
            entry = copy.deepcopy(candidate)
            entry.update(
                id=ex.identifier(
                    source,
                    "usage-delta",
                    generation,
                    lower.isoformat(),
                    upper.isoformat(),
                ),
                amount=format(
                    (hours * Decimal(provenance["hourly_rate"])).quantize(
                        quantum, rounding=ROUND_HALF_EVEN
                    ),
                    "f",
                ),
                compute_hours=format(
                    hours.quantize(quantum, rounding=ROUND_HALF_EVEN), "f"
                ),
                at=lower.isoformat(),
            )
            entry["provenance"].update(
                started_at=lower.isoformat(), ended_at=upper.isoformat()
            )
            pieces.append(entry)
            additions.append(entry)
        for metric in ("amount", "compute_hours"):
            difference = (
                sum(
                    (Decimal(actual_charges[id][metric]) for _, _, id in covered),
                    Decimal(0),
                )
                + sum((Decimal(row[metric]) for row in pieces), Decimal(0))
                - Decimal(candidate[metric])
            )
            if difference:
                report["rounding_differences"].append(
                    {
                        "generation_id": generation,
                        "at": candidate["at"],
                        "metric": metric,
                        "difference": str(difference),
                    }
                )
    for id in actual_charges.keys() - credited:
        conflict(
            id, "credited history is missing, shortened, or now overlaps native compute"
        )
    if any(row["id"] in base_charges for row in additions):
        conflict("new_entries", "delta identifiers collide with installed charges")
    manifest = copy.deepcopy(base)
    manifest["preserve_existing_authority"] = True
    manifest["adjustments"] = [*manifest.get("adjustments", []), *additions]
    candidates_by_id = {
        row["id"]: row for row in fresh["manifest"].get("usage_gaps", [])
    }
    for row in old_manifest.get("usage_gaps", []):
        if candidates_by_id.get(row["id"]) != row:
            conflict(
                row["id"],
                "deferred source history changed; reconcile it in the native service",
            )
    retained_gaps = {row["id"]: row for row in manifest.get("usage_gaps", [])}
    for identifier, row in candidates_by_id.items():
        if identifier in retained_gaps and retained_gaps[identifier] != row:
            conflict(identifier, "current base historical record differs from source")
        else:
            retained_gaps[identifier] = row
    if retained_gaps:
        manifest["usage_gaps"] = list(retained_gaps.values())
    # Earlier lifetime origins remain generic reviewed import resolutions.
    manifest["lifetime_resolutions"] = fresh["manifest"].get("lifetime_resolutions", {})
    report["added_adjustments"] = [row["id"] for row in additions]
    report["preserved_adjustments"] = sorted(base_charges)
    report["associations"] = [
        {
            "adjustment_id": row["id"],
            **{
                key: row["provenance"][key]
                for key in ("project_id", "experiment_id", "generation_id")
            },
        }
        for row in manifest["adjustments"]
        if owned(row)
    ]
    report["ready_for_native_preview"] = not conflicts
    if conflicts:
        return {"report": report}
    report["manifest_sha256"] = ex.digest(manifest)
    return {"report": report, "manifest": manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in (
        "snapshot",
        "mapping",
        "base-manifest",
        "previous-manifest",
        "previous-report",
        "previous-snapshot",
        "previous-mapping",
    ):
        parser.add_argument("--" + option, required=True, type=Path)
    parser.add_argument("--native-inventory", required=True, action="append", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    ex = exporter_module()
    try:
        read = lambda path: json.loads(path.read_text())
        result = advance(
            read(args.snapshot),
            read(args.mapping),
            read(args.base_manifest),
            [read(path) for path in args.native_inventory],
            previous={
                "manifest": read(args.previous_manifest),
                "report": read(args.previous_report),
            },
            previous_snapshot=read(args.previous_snapshot),
            previous_mapping=read(args.previous_mapping),
        )
        args.output_dir.mkdir(mode=0o700)
        ex.write_private(args.output_dir / "report.json", result["report"])
        if "manifest" not in result:
            print(
                "Delta conflicts require reconciliation; see the private report. No manifest written."
            )
            return 2
        ex.write_private(args.output_dir / "account-import.json", result["manifest"])
        print(
            "Wrote private final-delta inputs; native preview and reconciliation are required."
        )
        return 0
    except Exception:  # noqa: BLE001 -- input and account evidence are private
        print(
            "Delta export failed; verify source evidence, native inventory and file permissions."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
