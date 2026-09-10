#!/usr/bin/env python3
"""Read-only legacy inventory and conversion into the public account-import format.

No sandbox package, provider connection or Merv runtime is imported. The reviewed
base manifest comes from native account inventories; this converter adds only
Merv-owned legacy policies and charges. Conflicts produce a report, never a
partially usable manifest. Database credentials and provider secrets are omitted.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

# Explicit projections are also the export's secrecy boundary. Never SELECT *.
COLUMNS = {
    "projects": "id tenant_id",
    "project_members": "project_id user_id",
    "provider_user_caps": "provider user_id daily_usd_limit",
    "sandbox_provider_settings": "project_id provider enabled daily_usd_limit",
    "spend_kill_switches": "scope tripped",
    "tenant_quotas": (
        "tenant_id max_concurrent_sandboxes max_time_limit_seconds "
        "max_price_usd_per_hour gpu_hours_budget usd_budget blob_bytes_budget"
    ),
    "sandbox_generations": (
        "id tenant_id project_id experiment_id sandbox_id sandbox_uid provider user_id "
        "billing_mode price_usd_per_hour price_known started_at ended_at created_seq"
    ),
    "remote_sandbox_links": "project_id sandbox_uid experiment_id",
    "sandboxes": (
        "sandbox_uid project_id tenant_id provider status time_limit expires_at "
        "user_id billing_mode quoted_price_usd_per_hour price_usd_per_hour"
    ),
}


class ExportError(ValueError):
    pass


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def identifier(source: str, kind: str, *parts: str) -> str:
    return "legacy-" + kind + "-" + digest([source, kind, *parts])[:40]


def timestamp(value: Any) -> datetime:
    try:
        result = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ExportError("invalid timestamp") from exc
    if result.tzinfo is None:
        raise ExportError("timestamp needs an explicit timezone")
    return result.astimezone(UTC)


def money(value: Any) -> str | None:
    if value is None:
        return None
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ExportError("invalid monetary value") from exc
    if not result.is_finite() or result < 0:
        raise ExportError("monetary value must be finite and nonnegative")
    return format(result.normalize(), "f")


@contextmanager
def source_connection(*, sqlite: Path | None = None, postgres: str | None = None):
    """Both paths take one stable read-only transaction and never run migrations."""
    if sqlite is not None:
        connection = sqlite3.connect(sqlite.resolve().as_uri() + "?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
    else:
        import psycopg
        from psycopg.rows import dict_row

        connection = psycopg.connect(postgres, row_factory=dict_row)
        connection.execute(
            "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        )
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


def inventory(connection: Any, *, source_id: str, as_of: datetime) -> dict[str, Any]:
    if not source_id or as_of.tzinfo is None:
        raise ExportError("source ID and aware snapshot time are required")
    rows = {}
    for table, columns in COLUMNS.items():
        # Identifiers above are fixed in code, never supplied by a file or caller.
        records = connection.execute(
            f"SELECT {', '.join(columns.split())} FROM {table}"
        )
        rows[table] = sorted((dict(row) for row in records.fetchall()), key=canonical)
    result = {
        "version": 1,
        "source_id": source_id,
        "as_of": as_of.isoformat(),
        "tables": rows,
    }
    return {**result, "sha256": digest(result)}


def convert(
    snapshot: dict[str, Any],
    mapping: dict[str, Any],
    base: dict[str, Any],
    native_inventories: list[dict[str, Any]],
) -> dict[str, Any]:
    """Return a review report and, only without conflicts, an importable manifest."""
    if (
        snapshot.get("version") != 1
        or mapping.get("version") != 1
        or base.get("version") != 1
    ):
        raise ExportError("unsupported snapshot, mapping or manifest version")
    if snapshot.get("sha256") != digest(
        {k: v for k, v in snapshot.items() if k != "sha256"}
    ):
        raise ExportError("snapshot checksum mismatch")
    if set(snapshot["tables"]) != set(COLUMNS):
        raise ExportError("snapshot is missing required policy or accounting tables")
    source = snapshot["source_id"]
    if mapping.get("source_id") != source or not base.get("batch_id"):
        raise ExportError("mapping source and an explicit import batch ID are required")
    as_of = timestamp(snapshot["as_of"])
    tables = snapshot["tables"]
    manifest = copy.deepcopy(base)
    for key in (
        "policies",
        "provider_controls",
        "adjustments",
        "subjects",
        "resource_limits",
    ):
        manifest.setdefault(key, [])
    namespaces = {row["name"] for row in base["namespaces"]}
    members = {row["id"] for row in base["members"]}
    projects = mapping.get("projects", {})
    users = mapping.get("users", {})
    application_id = mapping.get("application_id")
    if not isinstance(application_id, str) or not application_id:
        raise ExportError("an application ID is required for external subject bindings")
    providers = mapping.get("providers", {})
    resolutions = mapping.get("generations", {})
    deferred = mapping.get("deferred_generations", {})
    conflicts: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    associations: list[dict[str, Any]] = []

    def conflict(kind: str, record: str, reason: str) -> None:
        conflicts.append({"kind": kind, "record": record, "reason": reason})

    def provider(name: str, record: str) -> str | None:
        result = providers.get(name)
        if not isinstance(result, str) or not result:
            conflict("provider", record, "explicit provider-plugin mapping required")
            return None
        return result

    def add_policy(kind: str, parts: list[str], **terms: Any) -> None:
        entry = {"id": identifier(source, kind, *parts), "currency": "USD", **terms}
        manifest["policies"].append(entry)
        decisions.append({"kind": kind, "source": parts, "policy": entry})

    project_rows = {row["id"]: row for row in tables["projects"]}
    if not projects:
        raise ExportError("select explicit project-to-namespace mappings")
    for project, entry in projects.items():
        if (
            project not in project_rows
            or entry.get("namespace") not in namespaces
            or entry.get("default_member_id") not in members
        ):
            conflict("project", project, "unknown project, namespace or default member")
    if len({entry["namespace"] for entry in projects.values()}) != len(projects):
        conflict("project", "mapping", "projects require distinct resource namespaces")
    for user, member in users.items():
        if not user or member not in members:
            conflict("user", user, "explicit user-to-member binding required")
        else:
            manifest["subjects"].append(
                {"application_id": application_id, "subject": user, "member_id": member}
            )
    # Every authorized user needs a charge identity even without historical use.
    for row in tables["project_members"]:
        if row["project_id"] in projects and row["user_id"] not in users:
            conflict(
                "user", row["user_id"], "project member is missing from ownership map"
            )

    cap_rows = {
        (row["provider"], row["user_id"]): row for row in tables["provider_user_caps"]
    }
    cap_providers = sorted({row["provider"] for row in tables["provider_user_caps"]})
    for legacy_provider in cap_providers:
        default = cap_rows.get((legacy_provider, ""))
        if default is not None:
            plugin = provider(legacy_provider, "default")
            if plugin:
                add_policy(
                    "member-default",
                    [legacy_provider],
                    scope="member_default",
                    target=base["account_id"],
                    window="day",
                    provider=plugin,
                    source="host",
                    cap=money(default["daily_usd_limit"]),
                )
    for user, member in users.items():
        for legacy_provider in cap_providers:
            explicit = cap_rows.get((legacy_provider, user))
            selected = (
                explicit
                if explicit is not None
                else cap_rows.get((legacy_provider, ""))
            )
            if selected is None:
                continue
            plugin = provider(legacy_provider, user)
            if plugin:
                # Keep inheritance dynamic for future account members. Only a
                # saved user-specific override becomes a member policy.
                if explicit is not None:
                    add_policy(
                        "user-cap",
                        [legacy_provider, user],
                        scope="member",
                        target=member,
                        window="day",
                        provider=plugin,
                        source="host",
                        cap=money(selected["daily_usd_limit"]),
                    )
                # Legacy user caps span projects. Dropping another project's
                # history/resources would give this member a fresh allowance.
                other_projects = {
                    row["project_id"]
                    for row in tables["project_members"]
                    if row["user_id"] == user and row["project_id"] not in projects
                } | {
                    row["project_id"]
                    for row in tables["sandbox_generations"]
                    if row["user_id"] == user and row["project_id"] not in projects
                }
                if other_projects:
                    conflict(
                        "user",
                        user,
                        "shared allowance requires all payer projects: "
                        + ",".join(sorted(other_projects)),
                    )
    # Merging distinct legacy users would make formerly independent caps share
    # one balance. Require that policy redesign separately, after migration.
    if len(set(users.values())) != len(users):
        conflict(
            "user",
            "mapping",
            "distinct legacy users require distinct member identities",
        )
    for row in tables["sandbox_provider_settings"]:
        project = row["project_id"]
        if project not in projects:
            continue
        plugin = provider(row["provider"], project)
        if plugin:
            namespace = projects[project]["namespace"]
            add_policy(
                "project-cap",
                [project, row["provider"]],
                scope="namespace",
                target=namespace,
                window="day",
                provider=plugin,
                source=None,
                cap=money(row["daily_usd_limit"]),
            )
            manifest["provider_controls"].append(
                {
                    "scope": "namespace",
                    "target": namespace,
                    "provider": plugin,
                    "enabled": bool(row["enabled"]),
                }
            )
    tenants = {project_rows[p]["tenant_id"] for p in projects if p in project_rows}
    stops = [
        row
        for row in tables["spend_kill_switches"]
        if row["tripped"] and row["scope"] in tenants | {"__global__"}
    ]
    resource_quota_tenants: dict[str, dict[str, Any]] = {}
    resource_fields = {
        "max_concurrent_sandboxes": "max_concurrent",
        "max_time_limit_seconds": "max_lifetime_seconds",
        "max_price_usd_per_hour": "max_hourly_price",
    }
    for row in tables["tenant_quotas"]:
        if row["tenant_id"] in tenants:
            tenant = row["tenant_id"]
            for key, value in row.items():
                if key == "tenant_id" or value is None:
                    continue
                if key == "blob_bytes_budget":
                    decisions.append(
                        {
                            "kind": "dormant-tenant-quota",
                            "tenant_id": tenant,
                            "field": key,
                            "value": value,
                            "treatment": "preserved in report; never enforced by legacy admission",
                        }
                    )
                elif key in {"usd_budget", "gpu_hours_budget", *resource_fields}:
                    # The legacy cumulative ledger selects generation.tenant_id,
                    # not the project's current tenant. Never infer this field
                    # from a project join or omit a departed project's charges.
                    tenant_projects = {
                        p
                        for p, record in project_rows.items()
                        if record["tenant_id"] == tenant
                    }
                    incomplete = any(
                        (
                            generation.get("tenant_id") == tenant
                            and generation["project_id"] not in projects
                        )
                        or (
                            generation["project_id"] in projects
                            and generation.get("tenant_id") != tenant
                        )
                        for generation in tables["sandbox_generations"]
                    )
                    if (
                        mapping.get("tenant_accounts", {}).get(tenant)
                        != base["account_id"]
                        or tenants != {tenant}
                        or not tenant_projects <= set(projects)
                        or incomplete
                    ):
                        conflict(
                            "tenant_quota",
                            tenant + ":" + key,
                            "requires an explicit tenant-to-account mapping, all tenant "
                            "projects and generation attribution; independent tenants "
                            "cannot share one account ceiling",
                        )
                        continue
                    if key in resource_fields:
                        resource_quota_tenants[tenant] = row
                        ceiling: Any = money(value)
                        if key == "max_price_usd_per_hour":
                            ceiling = {"currency": "USD", "amount": ceiling}
                        else:
                            number = Decimal(ceiling)
                            if (
                                number != number.to_integral_value()
                                or number > 2147483647
                            ):
                                conflict(
                                    "tenant_quota",
                                    tenant + ":" + key,
                                    "invalid integer ceiling",
                                )
                                continue
                            ceiling = int(number)
                        entry = {
                            "id": identifier(source, "resource-limit", tenant, key),
                            "scope": "account",
                            "target": base["account_id"],
                            "provider": None,
                            "source": None,
                            resource_fields[key]: ceiling,
                        }
                        manifest["resource_limits"].append(entry)
                        decisions.append(
                            {
                                "kind": "tenant-resource-limit",
                                "field": key,
                                "limit": entry,
                            }
                        )
                        if key == "max_price_usd_per_hour":
                            decisions.append(
                                {
                                    "kind": "admission-semantics-change",
                                    "tenant_id": tenant,
                                    "field": key,
                                    "treatment": "native prices come from the service; "
                                    "unknown prices cannot bypass a configured price ceiling",
                                }
                            )
                        continue
                    add_policy(
                        "tenant-cumulative-usd"
                        if key == "usd_budget"
                        else "tenant-compute-hours",
                        [tenant],
                        scope="account",
                        target=base["account_id"],
                        window="all_time",
                        cap=money(value),
                        metric="money" if key == "usd_budget" else "compute_hours",
                        currency="USD" if key == "usd_budget" else None,
                        provider=None,
                        source=None,
                    )
                    decisions.append(
                        {
                            "kind": "admission-semantics-change",
                            "tenant_id": tenant,
                            "field": key,
                            "treatment": "native admission reserves future lease commitments "
                            "in addition to accrued usage; the allowance never resets",
                        }
                    )
                else:
                    conflict(
                        "tenant_quota",
                        tenant + ":" + key,
                        "requires equivalent native quota; calendar caps are not equivalent",
                    )

    native = {}
    inventoried_namespaces = set()
    for saved in native_inventories:
        if saved.get("version") != 1:
            raise ExportError("unsupported native inventory version")
        inventoried_namespaces.update(row["name"] for row in saved["namespaces"])
        for row in saved["compute"]:
            if row["id"] in native:
                raise ExportError("duplicate resource in native inventories")
            native[row["id"]] = row
    if not namespaces <= inventoried_namespaces:
        conflict(
            "native_inventory",
            "namespaces",
            "all imported namespaces need a native inventory",
        )
    attributed = {row["sandbox_id"]: row for row in base.get("compute", [])}
    # Live legacy resources must remain represented in the native slot count.
    # A generation link is not proof of the current resource's lifetime allowance.
    resource_resolutions = mapping.get("resources", {})
    seen_native_resources: set[str] = set()
    for row in tables["sandboxes"]:
        project = row["project_id"]
        tenant = project_rows.get(project, {}).get("tenant_id")
        if row["status"] not in {"provisioning", "running", "cleanup_pending"}:
            continue
        if tenant not in resource_quota_tenants:
            if row["tenant_id"] in resource_quota_tenants:
                conflict(
                    "resource",
                    row["sandbox_uid"],
                    "live resource project ownership is unresolved",
                )
            continue
        uid = row["sandbox_uid"]
        resolution = resource_resolutions.get(uid, {})
        native_id = resolution.get("native_sandbox_id")
        record = native.get(native_id)
        if (
            project not in projects
            or not record
            or native_id not in attributed
            or record["namespace"] != projects[project]["namespace"]
            or record["stopped_at"] is not None
            or not resolution.get("evidence")
            or native_id in seen_native_resources
        ):
            conflict(
                "resource",
                uid,
                "every live legacy resource needs a distinct, reviewed "
                "native resource mapping with preserved namespace and attribution",
            )
            continue
        seen_native_resources.add(native_id)
        plugin = provider(row["provider"], uid)
        if not plugin or record["plugin"] != plugin:
            conflict(
                "resource", uid, "native provider differs from the live legacy resource"
            )
            continue
        decisions.append(
            {
                "kind": "live-resource",
                "sandbox_uid": uid,
                "native_sandbox_id": native_id,
            }
        )
        if resource_quota_tenants[tenant].get("max_time_limit_seconds") is None:
            continue
        try:
            allowance = Decimal(str(row["time_limit"]))
            if (
                not allowance.is_finite()
                or allowance <= 0
                or allowance != allowance.to_integral_value()
            ):
                raise ExportError(
                    "live resource lifetime allowance must be a positive integer"
                )
            if row["expires_at"]:
                origin = timestamp(row["expires_at"]) - timedelta(
                    seconds=int(allowance)
                )
                if (
                    resolution.get("lifetime_started_at")
                    and timestamp(resolution["lifetime_started_at"]) != origin
                ):
                    raise ExportError(
                        "resolution cannot change the saved lifetime origin"
                    )
            else:
                origin = timestamp(resolution.get("lifetime_started_at"))
            if origin > as_of:
                raise ExportError("lifetime origin cannot be in the future")
            native_origin = timestamp(
                record.get("lifetime_started_at") or record["created_at"]
            )
            if origin < native_origin:
                resolved = {
                    "started_at": origin.isoformat(),
                    "evidence": resolution["evidence"],
                }
                origins = manifest.setdefault("lifetime_resolutions", {})
                existing = origins.get(native_id)
                if existing and timestamp(existing["started_at"]) != origin:
                    raise ExportError(
                        "base manifest has a different lifetime resolution"
                    )
                origins[native_id] = existing or resolved
            elif origin > native_origin:
                decisions.append(
                    {
                        "kind": "admission-semantics-change",
                        "sandbox_uid": uid,
                        "treatment": "preserved earlier native lifetime origin; adoption cannot "
                        "reset lifetime, so the native ceiling is stricter than the legacy allowance",
                    }
                )
        except (ExportError, InvalidOperation, OverflowError) as exc:
            conflict("resource", uid, str(exc))
    selected_generations = {
        row["id"]
        for row in tables["sandbox_generations"]
        if row["project_id"] in projects
    }
    for key in set(resolutions) - selected_generations:
        conflict("generation", key, "resolution does not name a selected generation")
    for key in set(deferred) - selected_generations:
        conflict("generation", key, "deferral does not name a selected generation")
    for row in tables["sandbox_generations"]:
        project, generation = row["project_id"], row["id"]
        if project not in projects:
            continue
        if generation in deferred:
            evidence = deferred[generation]
            if (
                not isinstance(evidence, str)
                or not evidence.strip()
                or len(evidence) > 4096
                or generation in resolutions
            ):
                conflict(
                    "generation",
                    generation,
                    "deferral requires evidence and cannot also resolve",
                )
                continue
            if (
                row["price_known"]
                and row["user_id"]
                and row["provider"]
                and row["billing_mode"] in {"platform", "own"}
            ):
                conflict(
                    "generation",
                    generation,
                    "complete historical charges cannot be deferred",
                )
                continue
            try:
                start, end = timestamp(row["started_at"]), timestamp(row["ended_at"])
                if end < start or end > as_of:
                    raise ExportError(
                        "deferred history requires a closed interval within the snapshot"
                    )
                if row["sandbox_uid"] in native or row["sandbox_id"] in native:
                    raise ExportError(
                        "possible native overlap must be reconciled before deferral"
                    )
                member = users.get(row["user_id"])
                if row["user_id"] and member not in members:
                    raise ExportError("known historical payer needs a member mapping")
                plugin = (
                    provider(row["provider"], generation) if row["provider"] else None
                )
                if row["provider"] and not plugin:
                    continue
                price = money(row["price_usd_per_hour"]) if row["price_known"] else None
                if row["price_known"] and price is None:
                    raise ExportError("known historical price is missing")
            except ExportError as exc:
                conflict("generation", generation, str(exc))
                continue
            gap = {
                "id": identifier(source, "usage-gap", generation),
                "namespace": projects[project]["namespace"],
                "member_id": member,
                "provider": plugin,
                "source": {"platform": "host", "own": "namespace"}.get(
                    row["billing_mode"]
                ),
                "hourly_price": {"currency": "USD", "amount": price}
                if price is not None
                else None,
                "started_at": start.isoformat(),
                "ended_at": end.isoformat(),
                "provenance": {
                    "source_id": source,
                    "record": row,
                    "evidence": evidence,
                },
            }
            existing = next(
                (g for g in manifest.get("usage_gaps", []) if g["id"] == gap["id"]),
                None,
            )
            if existing is not None and existing != gap:
                conflict(
                    "generation",
                    generation,
                    "base historical record differs from source",
                )
                continue
            if existing is None:
                manifest.setdefault("usage_gaps", []).append(gap)
            decisions.append(
                {
                    "kind": "unresolved-history",
                    "generation": generation,
                    "native_id": gap["id"],
                    "treatment": "retained; overlapping finite budgets require reconciliation",
                }
            )
            continue
        resolution = resolutions.get(generation, {})
        member = users.get(row["user_id"])
        if row["user_id"] and resolution.get("member_id", member) != member:
            conflict("generation", generation, "resolution cannot change a known payer")
            continue
        member = member or resolution.get("member_id")
        source_kind = {"platform": "host", "own": "namespace"}.get(row["billing_mode"])
        if source_kind and resolution.get("source", source_kind) != source_kind:
            conflict(
                "generation", generation, "resolution cannot change known charge source"
            )
            continue
        source_kind = source_kind or resolution.get("source")
        plugin = provider(row["provider"], generation)
        if member not in members or source_kind not in {"host", "namespace"}:
            conflict(
                "generation",
                generation,
                "explicit historical payer and source required",
            )
            continue
        if not plugin:
            continue
        try:
            start = timestamp(row["started_at"])
            end = timestamp(
                row["ended_at"]
                or resolution.get("ended_at")
                or (as_of if resolution.get("native_sandbox_id") else None)
            )
            if (
                row["ended_at"]
                and resolution.get("ended_at")
                and timestamp(resolution["ended_at"]) != end
            ):
                raise ExportError("resolution cannot change a known stop time")
            if end < start or end > as_of:
                raise ExportError("generation interval must end within the snapshot")
            if row["price_known"]:
                rate = money(row["price_usd_per_hour"])
                if (
                    "hourly_rate" in resolution
                    and money(resolution["hourly_rate"]) != rate
                ):
                    raise ExportError("resolution cannot change a known price")
            else:
                rate = money(resolution.get("hourly_rate"))
            if rate is None:
                raise ExportError("unknown price requires an explicit reviewed price")
            if resolution and not resolution.get("evidence"):
                raise ExportError("historical resolutions require evidence")
        except ExportError as exc:
            conflict("generation", generation, str(exc))
            continue
        namespace = projects[project]["namespace"]
        native_id = resolution.get("native_sandbox_id")
        if not native_id and (
            row["sandbox_uid"] in native or row["sandbox_id"] in native
        ):
            conflict(
                "generation",
                generation,
                "possible native overlap requires explicit reconciliation",
            )
            continue
        if native_id:
            record, attribution = native.get(native_id), attributed.get(native_id)
            if (
                not record
                or not attribution
                or record["namespace"] != namespace
                or attribution["member_id"] != member
                or attribution["source"] != source_kind
                or record["plugin"] != plugin
                or record["currency"] != "USD"
                or money(record["rate"]) != rate
            ):
                conflict(
                    "generation",
                    generation,
                    "native overlap attribution or price differs",
                )
                continue
            native_start = timestamp(record["created_at"])
            native_end = (
                timestamp(record["stopped_at"]) if record["stopped_at"] else as_of
            )
            if native_end < end or native_start >= end:
                conflict(
                    "generation",
                    generation,
                    "native interval does not cover the claimed overlap",
                )
                continue
            # Import only the portion preceding native accounting. The service
            # already accounts for the overlapping portion, including live usage.
            decisions.append(
                {
                    "kind": "native-overlap",
                    "generation": generation,
                    "sandbox_id": native_id,
                    "from": max(start, native_start).isoformat(),
                    "to": end.isoformat(),
                }
            )
            end = min(end, native_start)
        while start < end:
            upper = min(
                end,
                start.replace(hour=0, minute=0, second=0, microsecond=0)
                + timedelta(days=1),
            )
            seconds = Decimal(str((upper - start).total_seconds()))
            amount = (Decimal(rate) * seconds / Decimal(3600)).quantize(
                Decimal("0.000000000001"), rounding=ROUND_HALF_EVEN
            )
            adjustment_id = identifier(
                source, "usage", generation, start.date().isoformat()
            )
            manifest["adjustments"].append(
                {
                    "id": adjustment_id,
                    "namespace": namespace,
                    "member_id": member,
                    "provider": plugin,
                    "source": source_kind,
                    "currency": "USD",
                    "amount": format(amount, "f"),
                    "compute_hours": format(
                        (seconds / Decimal(3600)).quantize(
                            Decimal("0.000000000001"), rounding=ROUND_HALF_EVEN
                        ),
                        "f",
                    ),
                    "at": start.isoformat(),
                    "provenance": {
                        "application": "merv",
                        "reference": {
                            "application": "merv",
                            "source_id": source,
                            "project_id": project,
                            "experiment_id": row["experiment_id"],
                            "generation_id": generation,
                        },
                        "source_id": source,
                        "generation_id": generation,
                        "project_id": project,
                        "experiment_id": row["experiment_id"],
                        "started_at": start.isoformat(),
                        "ended_at": upper.isoformat(),
                        "hourly_rate": rate,
                        "resolution": resolution,
                    },
                }
            )
            associations.append(
                {
                    "adjustment_id": adjustment_id,
                    "project_id": project,
                    "experiment_id": row["experiment_id"],
                    "generation_id": generation,
                }
            )
            start = upper
    # Reject accidental collisions with the reviewed native base as well as
    # duplicate provider aliases; do not silently overwrite another policy.
    for key in ("policies", "adjustments", "resource_limits"):
        ids = [row["id"] for row in manifest[key]]
        if len(ids) != len(set(ids)):
            conflict(
                key, "manifest", "duplicate identifiers; reconcile the base manifest"
            )
    for key, fields in (
        ("provider_controls", ("scope", "target", "provider")),
        ("subjects", ("application_id", "subject")),
    ):
        unique = {}
        for row in manifest[key]:
            identity = tuple(row[field] for field in fields)
            if identity in unique and unique[identity] != row:
                conflict(key, "manifest", "conflicting values require reconciliation")
            unique[identity] = row
        manifest[key] = list(unique.values())
    report = {
        "version": 1,
        "source_id": source,
        "snapshot_sha256": snapshot["sha256"],
        "mapping_sha256": digest(mapping),
        "base_sha256": digest(base),
        "as_of": as_of.isoformat(),
        "account_id": base["account_id"],
        "projects": sorted(projects),
        "conflicts": conflicts,
        "decisions": decisions,
        "requires_spending_suspension": bool(stops),
        "legacy_stops": stops,
        "associations": associations,
        "ready_for_native_preview": not conflicts,
        "default_caps": [
            row for row in tables["provider_user_caps"] if row["user_id"] == ""
        ],
    }
    if not conflicts:
        report["manifest_sha256"] = digest(manifest)
        # Retained evidence must not change when an operator prepares a later
        # snapshot or resolution map in the same process.
        return copy.deepcopy({"report": report, "manifest": manifest})
    return copy.deepcopy({"report": report})


def write_private(path: Path, value: Any) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True, default=str) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("inventory")
    capture.add_argument("--sqlite", type=Path)
    capture.add_argument(
        "--postgres-env", help="Name of the environment variable containing the DSN"
    )
    capture.add_argument(
        "--source-id", required=True, help="Stable deployment ID across exports"
    )
    capture.add_argument("--output", type=Path, required=True)
    export = commands.add_parser("convert")
    export.add_argument("--snapshot", type=Path, required=True)
    export.add_argument("--mapping", type=Path, required=True)
    export.add_argument("--base-manifest", type=Path, required=True)
    export.add_argument("--native-inventory", type=Path, action="append", default=[])
    export.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "inventory":
            if bool(args.sqlite) == bool(args.postgres_env):
                raise ExportError("select exactly one of --sqlite and --postgres-env")
            postgres = os.environ.get(args.postgres_env) if args.postgres_env else None
            if args.postgres_env and not postgres:
                raise ExportError("database environment variable is unset")
            with source_connection(sqlite=args.sqlite, postgres=postgres) as connection:
                value = inventory(
                    connection, source_id=args.source_id, as_of=datetime.now(UTC)
                )
            write_private(args.output, value)
        else:
            read = lambda path: json.loads(path.read_text())
            result = convert(
                read(args.snapshot),
                read(args.mapping),
                read(args.base_manifest),
                [read(path) for path in args.native_inventory],
            )
            args.output_dir.mkdir(mode=0o700)
            write_private(args.output_dir / "report.json", result["report"])
            if "manifest" not in result:
                print(
                    "Conflicts require resolution; see the private report.json. No manifest written."
                )
                return 2
            write_private(args.output_dir / "account-import.json", result["manifest"])
            print(
                "Wrote reviewed inputs and account-import.json; native preview is required."
            )
        return 0
    except Exception as exc:  # noqa: BLE001 -- operational boundary must not expose DB secrets
        # DB exceptions may contain connection strings or values. Never print them.
        print(
            str(exc)
            if isinstance(exc, ExportError)
            else "Export failed; check input schema, file permissions and database access."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
