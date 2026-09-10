#!/usr/bin/env python3
"""Replay pinned legacy quota code in a temporary database, without a Merv server.

Only the migration snapshot is loaded. Provider credentials are never restored,
and the worker refuses network connections and subprocess creation. Budget math
comes from the pinned source, not a new implementation in Merv.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import math
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import types
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REVISION = "55c1a1c894bdf83b7f32b2389002b46528329487"


class ReplayError(ValueError):
    pass


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def read_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def instant(value: Any) -> datetime:
    result = datetime.fromisoformat(str(value))
    if result.tzinfo is None:
        raise ReplayError("replay timestamps require a timezone")
    return result.astimezone(UTC)


def finite_json(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {key: finite_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [finite_json(item) for item in value]
    return value


def worker(source: Path, payload: dict[str, Any], directory: Path) -> dict[str, Any]:
    os.umask(0o077)

    def offline(event, args):
        if event in {
            "socket.connect",
            "socket.getaddrinfo",
            "subprocess.Popen",
            "os.system",
        }:
            raise ReplayError("legacy replay attempted an external operation")

    sys.addaudithook(offline)
    # Do not start package-level application surfaces. The actual quota module,
    # store methods and their utility dependencies still come from the archive.
    for name in (
        "merv",
        "merv.brain",
        "merv.brain.kernel",
        "merv.brain.kernel.state",
        "merv.brain.sandbox",
        "merv.shared",
    ):
        package = types.ModuleType(name)
        package.__path__ = [str(source.joinpath(*name.split(".")))]
        sys.modules[name] = package
    from merv.brain.sandbox import quotas

    from merv.brain.kernel.state.store import BaseStateStore
    from merv.shared.errors import PermissionDeniedError

    as_of = instant(payload["as_of"])

    class ReplayClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return as_of.astimezone(tz) if tz else as_of.replace(tzinfo=None)

    quotas.datetime = ReplayClock
    database = directory / "snapshot.sqlite"
    exporter = read_module(
        Path(__file__).with_name("export_infrastructure_budgets.py"), "replay_exporter"
    )
    extras = {
        "sandbox_provider_settings": {
            "credentials": "{}",
            "credential_mode": "",
            "verified_at": "",
            "updated_at": "",
        },
        "spend_kill_switches": {"reason": "Retained snapshot halt", "tripped_at": None},
    }
    with sqlite3.connect(database) as conn:
        for table, projection in exporter.COLUMNS.items():
            columns = projection.split()
            extra = extras.get(table, {})
            all_columns = [*columns, *extra]
            conn.execute(f"CREATE TABLE {table} ({', '.join(all_columns)})")
            for row in payload["snapshot"]["tables"][table]:
                conn.execute(
                    f"INSERT INTO {table} VALUES ({','.join('?' for _ in all_columns)})",
                    [*[row[key] for key in columns], *extra.values()],
                )

    class SnapshotStore(BaseStateStore):
        def connect(self):
            conn = sqlite3.connect(database)
            conn.row_factory = sqlite3.Row
            return conn

    store = SnapshotStore()
    service = quotas.QuotaService(store=store)
    cases = []
    reasons = {
        "usd_budget": "budget_exceeded",
        "gpu_hours_budget": "budget_exceeded",
        "provider_daily_usd_limit": "budget_exceeded",
        "provider_user_daily_usd_limit": "budget_exceeded",
        "max_concurrent_sandboxes": "concurrency_exceeded",
        "max_time_limit_seconds": "lifetime_exceeded",
        "max_price_usd_per_hour": "hourly_price_exceeded",
        "price_required_by_cost_policy": "unpriced_offer",
    }
    for case in payload["cases"]:
        result = {
            "id": case["id"],
            "native_request_sha256": case["native_request_sha256"],
            "evidence": f"Pinned QuotaService at {REVISION}; isolated snapshot replay",
            "legacy_request": case["legacy_request"],
        }
        conn = store.connect()
        try:
            conn.execute("BEGIN")
            if case["operation"] == "create":
                service.check_admission(
                    request=quotas.AdmissionRequest(**case["legacy_request"]), conn=conn
                )
            else:
                args = dict(case["legacy_request"])
                uid = args.pop("sandbox_uid")
                row = dict(
                    conn.execute(
                        "SELECT * FROM sandboxes WHERE sandbox_uid = ?", (uid,)
                    ).fetchone()
                )
                service.check_lifetime_extension(**args, conn=conn, row=row)
            result.update(allowed=True, expected_native_reason=None)
        except PermissionDeniedError as exc:
            details = exc.details
            reason = (
                "spending_suspended"
                if details.get("kill_switch")
                else reasons.get(details.get("quota"))
            )
            if reason is None:
                raise ReplayError(
                    "legacy denial needs an explicit reason mapping"
                ) from None
            result.update(
                allowed=False,
                expected_native_reason=reason,
                legacy_error={"message": str(exc), "details": finite_json(details)},
            )
        finally:
            conn.rollback()
            conn.close()
        cases.append(result)
    return {
        "cases": cases,
        "source_sha256": {
            relative: hashlib.sha256((source / relative).read_bytes()).hexdigest()
            for relative in (
                "merv/brain/sandbox/quotas.py",
                "merv/brain/kernel/state/store.py",
            )
        },
    }


def replay(
    snapshot: dict[str, Any],
    mapping: dict[str, Any],
    native_report: dict[str, Any],
    repository: Path,
) -> dict[str, Any]:
    exporter = read_module(
        Path(__file__).with_name("export_infrastructure_budgets.py"), "legacy_exporter"
    )
    native = native_report.get("admission_review", native_report)
    if (
        snapshot.get("version") != 1
        or mapping.get("version") != 1
        or native.get("version") != 1
    ):
        raise ReplayError("unsupported replay input version")
    if snapshot.get("sha256") != digest(
        {key: value for key, value in snapshot.items() if key != "sha256"}
    ):
        raise ReplayError("legacy snapshot checksum mismatch")
    if mapping.get("source_id") != snapshot["source_id"]:
        raise ReplayError("mapping and snapshot deployment IDs differ")
    if set(snapshot["tables"]) != set(exporter.COLUMNS) or any(
        not set(projection.split()) <= row.keys()
        for table, projection in exporter.COLUMNS.items()
        for row in snapshot["tables"].get(table, [])
    ):
        raise ReplayError("capture a current snapshot with all legacy replay columns")
    if (
        native.get("reserves_compute") is not False
        or native.get("independent_cases") is not True
        or native.get("consistency") != "repeatable_read"
    ):
        raise ReplayError(
            "use independent non-reserving repeatable-read native evidence"
        )
    if native.get("state_sha256") != digest(native["snapshot"]):
        raise ReplayError("native snapshot checksum mismatch")
    if native.get("input_sha256") != digest(
        {
            "version": 1,
            "account_id": native["account_id"],
            "assume_spending_enabled": native["assume_spending_enabled"],
            "cases": [row["request"] for row in native["cases"]],
        }
    ):
        raise ReplayError("native input checksum mismatch")
    as_of = instant(native["as_of"])
    if (
        instant(native["snapshot"]["as_of"]) != as_of
        or native["snapshot"]["account"]["id"] != native["account_id"]
    ):
        raise ReplayError("native account or evaluation time differs from its snapshot")
    if instant(snapshot["as_of"]) > as_of:
        raise ReplayError("legacy snapshot is newer than the evaluation instant")
    keys = {
        "projects": ("id",),
        "project_members": ("project_id", "user_id"),
        "provider_user_caps": ("provider", "user_id"),
        "sandbox_provider_settings": ("project_id", "provider"),
        "spend_kill_switches": ("scope",),
        "tenant_quotas": ("tenant_id",),
        "sandbox_generations": ("id",),
        "sandboxes": ("sandbox_uid",),
    }
    for table, columns in keys.items():
        rows = snapshot["tables"][table]
        if len({tuple(row[key] for key in columns) for row in rows}) != len(rows):
            raise ReplayError("legacy snapshot contains duplicate record identities")
    projects = {row["id"]: row for row in snapshot["tables"]["projects"]}
    resources = {row["sandbox_uid"]: row for row in snapshot["tables"]["sandboxes"]}
    native_resources = {row["id"]: row for row in native["snapshot"]["compute"]}
    case_map = mapping.get("cases", {})
    ids = [row["id"] for row in native["cases"]]
    if (
        not 1 <= len(ids) <= 1000
        or len(set(ids)) != len(ids)
        or any(not isinstance(id, str) or not id for id in ids)
    ):
        raise ReplayError("supply between 1 and 1000 uniquely identified native cases")
    if set(case_map) != {row["id"] for row in native["cases"]}:
        raise ReplayError("map every native review case exactly once")
    cases = []
    for recorded in native["cases"]:
        id, request = recorded["id"], recorded["request"]
        if request["id"] != id or recorded["request_sha256"] != digest(request):
            raise ReplayError("native case checksum mismatch")
        selected = case_map[id]
        project, user, provider = (
            selected.get("project_id"),
            selected.get("user_id"),
            selected.get("provider"),
        )
        if (
            project not in projects
            or mapping.get("projects", {}).get(project, {}).get("namespace")
            != request["namespace"]
        ):
            raise ReplayError("case project does not map to the native namespace")
        tenant = projects[project]["tenant_id"]
        if mapping.get("tenant_accounts", {}).get(tenant) != native["account_id"]:
            raise ReplayError("case tenant needs an explicit native account mapping")
        resource = (
            native_resources.get(request.get("sandbox_id"))
            if request.get("sandbox_id")
            else None
        )
        if request.get("sandbox_id") and resource is None:
            raise ReplayError("native renewal resource is missing from the snapshot")
        member = resource["member_id"] if resource else request.get("member_id")
        plugin = resource["plugin"] if resource else request["offer"]["plugin"]
        if (
            not user
            or mapping.get("users", {}).get(user) != member
            or mapping.get("providers", {}).get(provider) != plugin
        ):
            raise ReplayError("case payer/provider mapping differs from native facts")
        if request.get("sandbox_id"):
            uid = selected.get("sandbox_uid")
            row = resources.get(uid)
            if (
                not resource
                or not row
                or resource["namespace"] != request["namespace"]
                or resource["stopped_at"] is not None
                or row["status"] != "running"
                or row["project_id"] != project
                or row["user_id"] != user
                or row["provider"] != provider
                or mapping.get("resources", {}).get(uid, {}).get("native_sandbox_id")
                != request["sandbox_id"]
            ):
                raise ReplayError(
                    "renewal requires a reviewed live resource with its saved payer"
                )
            extra = (
                (as_of + timedelta(seconds=request["lease_seconds"]))
                - instant(row["expires_at"])
            ).total_seconds()
            if extra <= 0 or not extra.is_integer():
                raise ReplayError(
                    "native renewal has no exact positive legacy extension equivalent"
                )
            if resource["currency"] != "USD" or row["price_usd_per_hour"] != float(
                resource["rate"]
            ):
                raise ReplayError("renewal prices differ")
            if row["billing_mode"] != (
                "platform" if resource["source"] == "host" else "own"
            ):
                raise ReplayError("renewal charge sources differ")
            args = {
                "tenant_id": tenant,
                "sandbox_uid": uid,
                "total_time_limit_seconds": int(row["time_limit"]) + int(extra),
                "price_usd_per_hour": row["price_usd_per_hour"],
                "added_seconds": int(extra),
            }
            operation = "renew"
        else:
            price = request["offer"]["hourly_price"]
            if price is not None and price["currency"] != "USD":
                raise ReplayError("legacy quota code cannot represent a non-USD quote")
            if not isinstance(selected.get("price_unknown_reason"), str):
                raise ReplayError(
                    "record the legacy caller's price_unknown_reason explicitly"
                )
            args = {
                "tenant_id": tenant,
                "project_id": project,
                "user_id": user,
                "provider": provider,
                "time_limit_seconds": request["lease_seconds"],
                "billing_mode": "platform" if request["source"] == "host" else "own",
                "price_usd_per_hour": float(price["amount"]) if price else None,
                "price_unknown_reason": selected["price_unknown_reason"],
            }
            operation = "create"
        cases.append(
            {
                "id": id,
                "native_request_sha256": recorded["request_sha256"],
                "operation": operation,
                "legacy_request": args,
            }
        )
    payload = {"snapshot": snapshot, "cases": cases, "as_of": native["as_of"]}
    with tempfile.TemporaryDirectory(prefix="merv-legacy-replay-") as temporary:
        # macOS exposes /var through /private/var; compare canonical paths on
        # both sides without weakening the archive traversal check.
        root = Path(temporary).resolve()
        archive = subprocess.run(
            ["git", "-C", str(repository), "archive", REVISION, "merv/src"],
            check=True,
            capture_output=True,
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar.getmembers():
                if member.isdir():
                    continue
                if not member.isfile() or not member.name.startswith("merv/src/"):
                    raise ReplayError("legacy archive contains an unsupported entry")
                target = root / member.name
                if not target.resolve().is_relative_to(root):
                    raise ReplayError(
                        "legacy archive path is outside the temporary directory"
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
        data = root / "request.json"
        data.write_text(json.dumps(payload))
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                str(Path(__file__).resolve()),
                "--worker",
                str(root / "merv/src"),
                str(data),
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=60,
            env={
                key: value
                for key, value in os.environ.items()
                if key in {"PATH", "LANG", "SYSTEMROOT"}
            },
        )
        if result.returncode:
            raise ReplayError("isolated legacy replay failed; no decisions produced")
        output = json.loads(result.stdout)
    return {
        "version": 1,
        "source_id": snapshot["source_id"],
        "source_revision": REVISION,
        "snapshot_sha256": snapshot["sha256"],
        "mapping_sha256": digest(mapping),
        "native_report_sha256": digest(native_report),
        "as_of": native["as_of"],
        "scope": "legacy_quota_service",
        "provider_selection": "not_evaluated",
        "grant_authentication": "not_evaluated",
        **output,
    }


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "--worker":
        try:
            payload_path = Path(sys.argv[3])
            result = worker(
                Path(sys.argv[2]),
                json.loads(payload_path.read_text()),
                payload_path.parent,
            )
            print(json.dumps(result, allow_nan=False))
            return 0
        except Exception as exc:  # noqa: BLE001 -- keep private input out of worker diagnostics
            print(type(exc).__name__, file=sys.stderr)
            return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--native-review", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = replay(
            json.loads(args.snapshot.read_text()),
            json.loads(args.mapping.read_text()),
            json.loads(args.native_review.read_text()),
            args.repository,
        )
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(result, handle, indent=2, sort_keys=True, allow_nan=False)
        print(
            "Wrote private decisions from the pinned legacy quota engine; no infrastructure changed."
        )
        return 0
    except Exception as exc:  # noqa: BLE001 -- avoid exposing snapshots or database details
        print(
            str(exc)
            if isinstance(exc, ReplayError)
            else "Legacy replay failed; verify input files and source revision availability."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
