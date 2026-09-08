#!/usr/bin/env python3
"""Export a legacy Docker deployment, then adopt/copy bytes in merv-sandboxes.

The export contains credentials and must stay in a mode-0600 operator directory.
Run the worker inside the new service container. Only the explicit mapping step
updates the Merv DB. Source bytes are retained and re-running is idempotent.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def docker(*args: str) -> str:
    return subprocess.check_output(["docker", *args], text=True)


def export_source(args: argparse.Namespace) -> None:
    inspected = json.loads(docker("inspect", args.source_control))[0]
    env = dict(entry.split("=", 1) for entry in inspected["Config"]["Env"])
    sql = """SELECT json_build_object(
      'active_sandboxes', (SELECT count(*) FROM sandboxes WHERE status NOT IN
          ('terminated','released','failed','expired')),
      'storage_objects', (SELECT coalesce(json_agg(t),'[]'::json) FROM
          (SELECT id,project_id,namespace,content_sha256,size_bytes,content_type,
                  status,upload_id,expires_at FROM storage_objects
           WHERE status IN ('available','uploading')) t))"""
    inventory = json.loads(
        docker(
            "exec",
            args.source_database,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-Atc",
            sql,
        )
    )
    if inventory["active_sandboxes"]:
        raise SystemExit("Refusing cutover export while legacy sandboxes are active")
    source = {
        "version": 1,
        "source_image": inspected["Image"],
        "source_release": inspected["Config"]["Labels"].get(
            "com.docker.compose.project.working_dir"
        ),
        "blobs": {
            "bucket": env["MERV_BLOB_BUCKET"],
            "endpoint_url": args.blob_endpoint,
            "region_name": env.get("AWS_DEFAULT_REGION", "us-east-1"),
            "aws_access_key_id": env["AWS_ACCESS_KEY_ID"],
            "aws_secret_access_key": env["AWS_SECRET_ACCESS_KEY"],
        },
        "heavy": {
            "bucket": env["MERV_STORAGE_BUCKET"],
            "endpoint_url": env["MERV_STORAGE_ENDPOINT_URL"],
            "region_name": env.get("MERV_STORAGE_REGION", "auto"),
            "aws_access_key_id": env["MERV_STORAGE_ACCESS_KEY_ID"],
            "aws_secret_access_key": env["MERV_STORAGE_SECRET_ACCESS_KEY"],
        },
        **inventory,
    }
    destination = Path(args.export)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(source, handle)
    print(
        json.dumps(
            {
                "export": str(destination),
                "storage_rows": len(source["storage_objects"]),
                "active_sandboxes": 0,
                "contains_credentials": True,
            }
        )
    )


def apply_upload_mapping(args: argparse.Namespace) -> None:
    report = json.loads(Path(args.apply_upload_mapping).read_text())
    if not report.get("applied") or report.get("failures"):
        raise SystemExit(
            "Upload mapping requires a successful applied migration report"
        )
    rows = report["upload_id_mapping"]
    for row in rows:
        old_size = int(row["size_bytes"])
        new_size = int(row.get("canonical_size_bytes", old_size))
        if min(old_size, new_size) < 0:
            raise SystemExit("Upload mapping sizes must be nonnegative")
        if old_size != new_size and (
            not row.get("canonical_object_id")
            or row.get("canonical_verification") != "provider_sha256"
        ):
            raise SystemExit("Size repair requires a fully verified canonical object")
        row["canonical_size_bytes"] = str(new_size)
        row.setdefault("canonical_object_id", "")
    if not rows:
        print('{"upload_ids_updated":0}')
        return

    def literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    values = ",\n".join(
        "("
        + ",".join(
            literal(row[key])
            for key in [
                "id",
                "project_id",
                "old_upload_id",
                "new_upload_id",
                "sha256",
                "size_bytes",
                "canonical_size_bytes",
                "canonical_object_id",
            ]
        )
        + ")"
        for row in rows
    )
    sql = (
        """BEGIN;
CREATE TEMP TABLE merv_upload_cutover(id text, project_id text, old_id text, new_id text, sha256 text, size_bytes bigint, canonical_size_bytes bigint, canonical_object_id text, PRIMARY KEY(id));
INSERT INTO merv_upload_cutover VALUES """
        + values
        + ";\n"
        + """
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM merv_upload_cutover m LEFT JOIN storage_objects s ON s.id=m.id
             WHERE s.id IS NULL OR s.project_id<>m.project_id OR s.status<>'uploading'
                OR s.content_sha256<>m.sha256 OR s.upload_id IS NULL
                OR NOT ((s.upload_id=m.old_id AND s.size_bytes=m.size_bytes)
                     OR (s.upload_id=m.new_id AND s.size_bytes=m.canonical_size_bytes))) THEN
    RAISE EXCEPTION 'legacy upload changed after migration snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM merv_upload_cutover m LEFT JOIN storage_objects c ON c.id=m.canonical_object_id
             WHERE m.canonical_object_id<>'' AND (c.id IS NULL OR c.project_id<>m.project_id
                OR c.status<>'available' OR c.content_sha256<>m.sha256
                OR c.size_bytes<>m.canonical_size_bytes)) THEN
    RAISE EXCEPTION 'canonical verified object changed after migration snapshot';
  END IF;
END $$;
UPDATE storage_objects s SET upload_id=m.new_id, size_bytes=m.canonical_size_bytes FROM merv_upload_cutover m WHERE s.id=m.id;
UPDATE storage_completion_tokens t SET upload_id=m.new_id FROM merv_upload_cutover m
  WHERE t.project_id=m.project_id AND t.object_id=m.id AND t.upload_id=m.old_id;
COMMIT;
"""
    )
    subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            args.source_database,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=sql,
        text=True,
        check=True,
    )
    print(json.dumps({"upload_ids_updated": len(rows)}))


async def migrate(args: argparse.Namespace) -> None:
    import boto3
    from botocore.config import Config
    from merv_sandboxes.config import Settings
    from merv_sandboxes.db import create_database
    from merv_sandboxes.errors import NotFoundError
    from merv_sandboxes.storage.models import ObjectUploadRequest
    from merv_sandboxes.storage.service import ObjectStorage

    source = json.load(sys.stdin)
    settings = Settings.load()
    database = create_database(settings.database_url)
    service = ObjectStorage(database, settings)
    counts: collections.Counter[str] = collections.Counter()
    failures: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    native_ids: dict[tuple[str, str], str] = {}
    verified_sha_sizes: dict[tuple[str, str], int] = {}
    sdk_config = Config(
        signature_version="s3v4",
        max_pool_connections=args.workers + 4,
        retries={"max_attempts": 5},
        connect_timeout=15,
        read_timeout=120,
    )

    def client(config: dict[str, Any]) -> Any:
        return boto3.client(
            "s3",
            config=sdk_config,
            **{key: value for key, value in config.items() if key != "bucket"},
        )

    heavy_client, blob_client = client(source["heavy"]), client(source["blobs"])
    heavy_bucket, blob_bucket = source["heavy"]["bucket"], source["blobs"]["bucket"]
    if heavy_bucket not in settings.storage.adopted_buckets:
        raise SystemExit(
            "Configure SANDBOXES_STORAGE__ADOPTED_BUCKETS before migration"
        )
    if source["heavy"]["endpoint_url"].rstrip("/") != settings.storage.endpoint.rstrip(
        "/"
    ):
        raise SystemExit("Adoption requires the same S3 endpoint in the new service")
    semaphore = asyncio.Semaphore(args.workers)

    def head_or_none(s3: Any, bucket: str, key: str) -> dict[str, Any] | None:
        try:
            return s3.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
        except Exception as exc:
            if getattr(exc, "response", {}).get("Error", {}).get("Code") in {
                "404",
                "NoSuchKey",
                "NotFound",
            }:
                return None
            raise

    def read_bytes(s3: Any, bucket: str, key: str) -> bytes:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def read_blob(key: str) -> tuple[bytes, str, datetime | None]:
        response = blob_client.get_object(Bucket=blob_bucket, Key=key)
        body = response["Body"]
        try:
            data = body.read()
        finally:
            body.close()
        raw_expiry = response.get("Metadata", {}).get("expires_at")
        expiry = (
            datetime.fromisoformat(raw_expiry.replace("Z", "+00:00"))
            if raw_expiry
            else None
        )
        if expiry is not None and expiry.utcoffset() is None:
            raise ValueError("legacy blob expiry requires a timezone")
        return data, response.get("ContentType") or "application/octet-stream", expiry

    async def copy_verified(
        s3: Any,
        bucket: str,
        key: str,
        sha: str,
        size: int,
        target_key: str,
        content_type: str,
    ) -> None:
        data = await asyncio.to_thread(read_bytes, s3, bucket, key)
        if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
            raise ValueError("legacy bytes failed size or SHA-256 verification")
        if args.apply:
            await asyncio.to_thread(
                service.provider.client.put_object,
                Bucket=settings.storage.bucket,
                Key=target_key,
                Body=data,
                ContentType=content_type,
                ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(),
            )

    async def heavy(row: dict[str, Any]) -> None:
        async with semaphore:
            try:
                sha = row["content_sha256"]
                key = row["namespace"] + "/" + sha
                head = await asyncio.to_thread(
                    head_or_none, heavy_client, heavy_bucket, key
                )
                locator = "s3://" + heavy_bucket + "/" + key
                if head is None and row["status"] == "available":
                    for old_bucket in args.legacy_heavy_bucket:
                        old_head = await asyncio.to_thread(
                            head_or_none, blob_client, old_bucket, key
                        )
                        if old_head is None:
                            continue
                        locator = settings.storage.prefix + "/merv-import/heavy/" + key
                        await copy_verified(
                            blob_client,
                            old_bucket,
                            key,
                            sha,
                            row["size_bytes"],
                            locator,
                            row["content_type"] or "application/octet-stream",
                        )
                        head = {
                            "ContentLength": row["size_bytes"],
                            "ChecksumSHA256": base64.b64encode(
                                bytes.fromhex(sha)
                            ).decode(),
                        }
                        counts["heavy_recovered_from_minio"] += 1
                        break
                if head is None or int(head["ContentLength"]) != row["size_bytes"]:
                    if row["status"] == "uploading":
                        pending.append(
                            {
                                "id": row["id"],
                                "project_id": row["project_id"],
                                "upload_id": row["upload_id"],
                                "source_key": key,
                                "reason": "source missing or incomplete",
                            }
                        )
                        counts["pending_source_incomplete"] += 1
                        if args.apply:
                            upload = await service.begin_upload(
                                namespace="merv-project-" + row["project_id"],
                                request=ObjectUploadRequest(
                                    name=sha,
                                    sha256=sha,
                                    size_bytes=row["size_bytes"],
                                    content_type=row["content_type"]
                                    or "application/octet-stream",
                                    idempotency_key="merv-pending-" + sha,
                                ),
                            )
                            native_ids[row["project_id"], sha] = upload.object.id
                        return
                    raise ValueError("available legacy object missing or size differs")
                checksum = head.get("ChecksumSHA256")
                if (
                    checksum
                    and checksum != base64.b64encode(bytes.fromhex(sha)).decode()
                ):
                    raise ValueError("legacy provider SHA-256 differs from ledger")
                if checksum:
                    verified_sha_sizes[row["project_id"], sha] = row["size_bytes"]
                mode = (
                    "provider_sha256"
                    if checksum
                    else "legacy_manifest_sha256_size_verified"
                )
                if not checksum and not args.trust_legacy_multipart:
                    raise ValueError(
                        "legacy full SHA-256 absent; use explicit legacy manifest trust"
                    )
                if args.apply:
                    native, mode = await service.adopt_existing(
                        namespace="merv-project-" + row["project_id"],
                        request=ObjectUploadRequest(
                            name=sha,
                            sha256=sha,
                            size_bytes=row["size_bytes"],
                            content_type=row["content_type"]
                            or "application/octet-stream",
                            idempotency_key="merv-adopt-" + sha,
                        ),
                        object_key=locator,
                        trust_legacy_digest=args.trust_legacy_multipart,
                    )
                    native_ids[row["project_id"], sha] = native.id
                counts["heavy_" + mode] += 1
                counts["heavy_bytes"] += row["size_bytes"]
                if row["status"] == "uploading":
                    counts["pending_bytes_adopted"] += 1
            except Exception as exc:  # noqa: BLE001 - report every failed object, then fail the run.
                failures.append(
                    {
                        "kind": "heavy",
                        "id": row["id"],
                        "error": str(exc).split("\n")[0][:300],
                    }
                )

    async def blob(item: dict[str, Any]) -> None:
        async with semaphore:
            key = item["Key"]
            try:
                _namespace, separator, sha = key.rpartition("/")
                if (
                    not separator
                    or len(sha) != 64
                    or any(c not in "0123456789abcdef" for c in sha)
                ):
                    raise ValueError("unexpected legacy blob key")
                data, content_type, expires_at = await asyncio.to_thread(read_blob, key)
                if len(data) != item["Size"] or hashlib.sha256(data).hexdigest() != sha:
                    raise ValueError("legacy blob size or SHA-256 differs")
                expired = expires_at is not None and expires_at <= datetime.now(
                    timezone.utc
                )
                if expired:
                    counts["blobs_already_expired"] += 1
                if args.apply and not expired:
                    # Deterministic key permits restart after bytes copied but before publication.
                    target_key = settings.storage.prefix + "/merv-import/blobs/" + key
                    try:
                        existing = await service.resolve(
                            namespace="merv-blobs", name=key
                        )
                    except NotFoundError:
                        existing = None
                    if existing is not None:
                        if (
                            existing.name != key
                            or existing.sha256 != sha
                            or existing.size_bytes != len(data)
                            or existing.content_type != content_type
                        ):
                            raise ValueError(
                                "native blob metadata differs from verified source"
                            )
                        # Every replay still hashes source bytes and freshly verifies
                        # the immutable native copy, without uploading it again.
                        await asyncio.to_thread(
                            service.provider.verify_adoption,
                            target_key,
                            len(data),
                            sha,
                        )
                        if existing.expires_at is not None and (
                            expires_at is None or expires_at > existing.expires_at
                        ):
                            await service.extend_retention(
                                namespace="merv-blobs",
                                object_id=existing.id,
                                expires_at=expires_at,
                            )
                        counts["blobs_reused"] += 1
                        counts["blobs_verified"] += 1
                        counts["blob_bytes"] += len(data)
                        if counts["blobs_verified"] % 500 == 0:
                            print(
                                json.dumps(
                                    {
                                        "progress": dict(counts),
                                        "failures": len(failures),
                                    }
                                ),
                                flush=True,
                            )
                        return
                    await asyncio.to_thread(
                        service.provider.client.put_object,
                        Bucket=settings.storage.bucket,
                        Key=target_key,
                        Body=data,
                        ContentType=content_type,
                        ChecksumSHA256=base64.b64encode(bytes.fromhex(sha)).decode(),
                    )
                    await service.adopt_existing(
                        namespace="merv-blobs",
                        request=ObjectUploadRequest(
                            name=key,
                            sha256=sha,
                            size_bytes=len(data),
                            content_type=content_type,
                            idempotency_key="merv-blob-"
                            + hashlib.sha256(key.encode()).hexdigest(),
                        ),
                        object_key=target_key,
                        expires_at=expires_at,
                    )
                counts["blobs_verified"] += 1
                counts["blob_bytes"] += len(data)
                if counts["blobs_verified"] % 500 == 0:
                    print(
                        json.dumps(
                            {"progress": dict(counts), "failures": len(failures)}
                        ),
                        flush=True,
                    )
            except Exception as exc:  # noqa: BLE001 - report every failed object, then fail the run.
                failures.append(
                    {"kind": "blob", "key": key, "error": str(exc).split("\n")[0][:300]}
                )

    try:
        counts.update(
            {
                "source_" + state + "_rows": sum(
                    row["status"] == state for row in source["storage_objects"]
                )
                for state in ("available", "uploading")
            }
        )
        unique: dict[tuple[str, str], dict[str, Any]] = {}
        for row in source["storage_objects"]:
            identity = row["project_id"], row["content_sha256"]
            prior = unique.get(identity)
            if prior is None or row["status"] == "available":
                unique[identity] = row
        await asyncio.gather(*(heavy(row) for row in unique.values()))
        for page in blob_client.get_paginator("list_objects_v2").paginate(
            Bucket=blob_bucket
        ):
            await asyncio.gather(*(blob(item) for item in page.get("Contents", [])))
        mapping = []
        if args.apply:
            for row in source["storage_objects"]:
                if row["status"] != "uploading":
                    continue
                native_id = native_ids.get((row["project_id"], row["content_sha256"]))
                if not native_id:
                    failures.append(
                        {
                            "kind": "upload_mapping",
                            "id": row["id"],
                            "error": "native upload target unavailable",
                        }
                    )
                    continue
                encoded = (
                    base64.urlsafe_b64encode(
                        json.dumps(
                            [row["project_id"], native_id, row["id"]],
                            separators=(",", ":"),
                        ).encode()
                    )
                    .decode()
                    .rstrip("=")
                )
                canonical = unique[row["project_id"], row["content_sha256"]]
                repair = {}
                if row["size_bytes"] != canonical["size_bytes"]:
                    if (
                        canonical["status"] != "available"
                        or verified_sha_sizes.get(
                            (row["project_id"], row["content_sha256"])
                        )
                        != canonical["size_bytes"]
                    ):
                        failures.append(
                            {
                                "kind": "size_repair",
                                "id": row["id"],
                                "error": "canonical size requires full SHA verification",
                            }
                        )
                        continue
                    repair = {
                        "canonical_object_id": canonical["id"],
                        "canonical_size_bytes": str(canonical["size_bytes"]),
                        "canonical_verification": "provider_sha256",
                    }
                mapping.append(
                    {
                        "id": row["id"],
                        "project_id": row["project_id"],
                        "old_upload_id": row["upload_id"],
                        "new_upload_id": "msbx_" + encoded,
                        "sha256": row["content_sha256"],
                        "size_bytes": str(row["size_bytes"]),
                        **repair,
                    }
                )
        report = {
            "applied": args.apply,
            "counts": dict(counts),
            "failures": failures,
            "upload_id_mapping": mapping,
            "size_repairs": [row for row in mapping if row.get("canonical_object_id")],
            "pending_uploads": pending,
            "source_image": source["source_image"],
            "source_release": source["source_release"],
        }
        print(json.dumps(report, sort_keys=True), flush=True)
        if args.report:
            fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(json.dumps(report, indent=2) + "\n")
        if failures:
            raise SystemExit(1)
    finally:
        await database.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", metavar="FILE")
    parser.add_argument("--apply-upload-mapping", metavar="REPORT")
    parser.add_argument("--source-control", default="deploy-control-1")
    parser.add_argument("--source-database", default="deploy-supabase-db-1")
    parser.add_argument("--blob-endpoint", default="https://experiments.rapidreview.io")
    parser.add_argument(
        "--legacy-heavy-bucket",
        action="append",
        default=["research-plugin-storage"],
        help="Old MinIO buckets to recover available objects missing from R2",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--trust-legacy-multipart",
        action="store_true",
        help="Preserve historical hashes when old multipart objects have no full checksum",
    )
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--report")
    args = parser.parse_args()
    if not 1 <= args.workers <= 64:
        parser.error("workers must be between 1 and 64")
    if args.export:
        export_source(args)
    elif args.apply_upload_mapping:
        apply_upload_mapping(args)
    else:
        asyncio.run(migrate(args))


if __name__ == "__main__":
    main()
