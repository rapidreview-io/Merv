#!/usr/bin/env python3
"""Copy Merv evidence from native merv-blobs into Merv-owned R2.

Default is an inventory plan. --apply copies missing keys and reads back every
destination; --verify-only performs the same integrity checks without writes.
Reruns verify existing bytes instead of trusting an earlier report. Source
objects and native dataset/model namespaces are never mutated. Quiesce Merv
writes for the final inventory/verification before switching its blob config.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
from typing import Any
from urllib.parse import urlsplit

import httpx

from merv.brain.artifacts.r2 import R2BlobStore
from merv.brain.infrastructure.client import build_infrastructure_client
from merv.brain.kernel.ports.blob_store import validate_blob_keys
from merv.brain.kernel.utils import NotFoundError


SOURCE_NAMESPACE = "merv-blobs"


class CheckFailed(Exception):
    """Static operator error code; never includes response bodies or secrets."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise CheckFailed(code)


def read_env(path: Path | None) -> dict[str, str]:
    if path is None:
        return dict(os.environ)
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.removeprefix("export ").partition("=")
        require(bool(separator) and bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key.strip())), "invalid_env_file")
        value = value.strip()
        if value.startswith(("'", '"')):
            parts = shlex.split(value)
            require(len(parts) == 1, "invalid_env_value")
            value = parts[0]
        env[key.strip()] = value
    return env


def inventory(client: Any, *, page_size: int = 1000) -> tuple[list[dict], int]:
    require(1 <= page_size <= 1000, "invalid_page_size")
    offset, unavailable = 0, 0
    seen: set[str] = set()
    records: dict[tuple[str, str], dict] = {}
    while True:
        page = client.request("GET", "/storage/objects", namespace=SOURCE_NAMESPACE,
                              params={"limit": page_size, "offset": offset}).get("objects")
        require(isinstance(page, list) and len(page) <= page_size, "invalid_inventory_page")
        for row in page:
            require(isinstance(row, dict) and row.get("namespace") == SOURCE_NAMESPACE, "invalid_source_namespace")
            oid = row.get("id", "")
            require(isinstance(oid, str) and bool(re.fullmatch(r"obj_[A-Za-z0-9_-]+", oid)), "invalid_object_id")
            require(oid not in seen, "inventory_changed_retry_after_quiescing_writes")
            seen.add(oid)
            if row.get("state") != "available":
                unavailable += 1
                continue
            namespace, separator, digest = str(row.get("name", "")).partition("/")
            require(bool(separator) and digest == row.get("sha256"), "invalid_content_name")
            validate_blob_keys(namespace=namespace, sha256=digest)
            require(type(row.get("size_bytes")) is int and row["size_bytes"] >= 0, "invalid_content_size")
            key = namespace, digest
            require(key not in records or records[key]["size_bytes"] == row["size_bytes"], "conflicting_content_size")
            records.setdefault(key, {**row, "blob_namespace": namespace})
        offset += len(page)
        if len(page) < page_size:
            return sorted(records.values(), key=lambda row: row["name"]), unavailable


def verify_bytes(data: bytes, row: dict, source: str) -> None:
    require(len(data) == row["size_bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"], source + "_integrity_failed")


def transfer_one(row: dict, *, client: Any, destination: Any,
                 transfer: httpx.Client, apply: bool) -> str:
    key = {"namespace": row["blob_namespace"], "sha256": row["sha256"]}
    try:
        existing = destination.get(**key)
    except NotFoundError:
        existing = None
    if existing is not None:
        verify_bytes(existing, row, "destination")
        return "verified_existing"
    require(apply, "destination_missing")
    target = client.request("GET", f"/storage/objects/{row['id']}/download", namespace=SOURCE_NAMESPACE)
    url = urlsplit(target.get("url", ""))
    require(url.scheme == "https" and bool(url.hostname) and not url.username and not url.password, "invalid_download_url")
    with transfer.stream("GET", target["url"]) as response:
        response.raise_for_status()
        data = bytearray()
        for chunk in response.iter_bytes(64 * 1024):
            data.extend(chunk)
            require(len(data) <= row["size_bytes"], "source_size_exceeded")
    content = bytes(data)
    verify_bytes(content, row, "source")
    digest = destination.put(namespace=row["blob_namespace"], data=content,
                             content_type=row.get("content_type") or "application/octet-stream")
    require(digest == row["sha256"], "destination_identity_changed")
    verify_bytes(destination.get(**key), row, "destination")
    return "copied"


def migrate(*, client: Any, destination: Any = None, mode: str = "plan",
            workers: int = 8, page_size: int = 1000,
            transfer: httpx.Client | None = None) -> dict:
    require(mode in {"plan", "apply", "verify"}, "invalid_mode")
    require(1 <= workers <= 32, "invalid_workers")
    rows, unavailable = inventory(client, page_size=page_size)
    identity = [(row["name"], row["sha256"], row["size_bytes"]) for row in rows]
    report = {
        "mode": mode, "source_namespace": SOURCE_NAMESPACE,
        "source_objects": len(rows), "source_bytes": sum(row["size_bytes"] for row in rows),
        "unavailable_records": unavailable,
        "inventory_sha256": hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest(),
        "copied": 0, "verified_existing": 0, "verified_bytes": 0, "failures": [],
    }
    if mode == "plan":
        return report
    require(destination is not None, "destination_required")
    own_transfer = transfer is None
    transfer = transfer or httpx.Client(timeout=httpx.Timeout(120, connect=10), follow_redirects=False)

    def process(row: dict) -> tuple[str | None, dict | None]:
        try:
            return transfer_one(row, client=client, destination=destination,
                                transfer=transfer, apply=mode == "apply"), None
        except Exception as exc:
            return None, {"object_id": row["id"], "error": str(exc) if isinstance(exc, CheckFailed) else type(exc).__name__}

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            # Bound queued work as well as concurrent downloads; bytes live
            # only inside workers, never in the inventory or result queue.
            for start in range(0, len(rows), workers):
                batch = rows[start:start + workers]
                for row, (outcome, failure) in zip(batch, pool.map(process, batch)):
                    if failure is not None:
                        report["failures"].append(failure)
                    else:
                        report[outcome] += 1
                        report["verified_bytes"] += row["size_bytes"]
    finally:
        if own_transfer:
            transfer.close()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-env", type=Path)
    parser.add_argument("--destination-env", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=8)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--apply", action="store_true")
    modes.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    client = None
    try:
        client = build_infrastructure_client(read_env(args.source_env))
        require(client is not None, "source_configuration_missing")
        mode = "apply" if args.apply else "verify" if args.verify_only else "plan"
        destination = None
        if mode != "plan":
            env = read_env(args.destination_env)
            destination = R2BlobStore(
                bucket=env.get("MERV_BLOB_BUCKET", ""), endpoint_url=env.get("MERV_BLOB_ENDPOINT_URL", ""),
                access_key_id=env.get("MERV_BLOB_ACCESS_KEY_ID", ""), secret_access_key=env.get("MERV_BLOB_SECRET_ACCESS_KEY", ""),
                region=env.get("MERV_BLOB_REGION", "auto"), prefix=env.get("MERV_BLOB_PREFIX", ""),
            )
        report = migrate(client=client, destination=destination, mode=mode, workers=args.workers)
    except Exception as exc:
        report = {"failures": [{"error": str(exc) if isinstance(exc, CheckFailed) else type(exc).__name__}]}
    finally:
        if client is not None:
            client.close()
    with os.fdopen(os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps(report, sort_keys=True))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
