#!/usr/bin/env python3
"""Bounded post-cutover verification inside the new Merv control image.

Default mode reads production research metadata and migrated bytes only.
--write-storage additionally creates uniquely named smoke objects and removes
those exact objects in finally blocks. Never creates projects, feed posts,
research events, or compute. Reports omit credentials, signed URLs and content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import psycopg
from psycopg.rows import dict_row

from merv.brain.infrastructure.client import InfrastructureClient, build_infrastructure_client
from merv.brain.infrastructure.ports import infrastructure_actor, project_namespace
from merv.brain.infrastructure.storage import upload_target
from merv.brain.kernel.state.schema import MIGRATION_ORDER
from merv.brain.kernel.utils import NotFoundError
from merv.brain.surface.config import build_blob_store

MIB = 1024 * 1024


class CheckFailed(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)


def emit(check: str, **safe_fields: Any) -> None:
    print(json.dumps({"check": check, **safe_fields}, sort_keys=True), flush=True)


def safe_failure(exc: BaseException) -> dict[str, Any]:
    # HTTP exceptions often include complete signed URLs. Emit only types and
    # our own bounded assertions; never str(exc) for library/network failures.
    value = {"type": type(exc).__name__}
    if isinstance(exc, CheckFailed):
        value["detail"] = str(exc)
    if isinstance(exc, httpx.HTTPStatusError):
        value["http_status"] = exc.response.status_code
    return value


def bounded_download(url: str, *, size: int, expected_sha: str, full_limit: int) -> dict[str, Any]:
    """Hash a bounded full object or validate a bounded large-object range."""
    require(urlsplit(url).scheme == "https", "storage transfer URL must use HTTPS")
    full = size <= full_limit
    length = size if full else min(MIB, size)
    headers = {} if full else {"Range": f"bytes=0-{length - 1}"}
    digest = hashlib.sha256()
    received = 0
    with httpx.Client(timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as transfer:
        with transfer.stream("GET", url, headers=headers) as response:
            response.raise_for_status()
            if not full:
                require(response.status_code == 206, "large download ignored byte range")
                require(response.headers.get("Content-Range") == f"bytes 0-{length - 1}/{size}",
                        "download range does not match migrated object size")
            for chunk in response.iter_bytes(chunk_size=65536):
                received += len(chunk)
                require(received <= length, "download exceeded configured byte bound")
                digest.update(chunk)
    require(received == length, "download length mismatch")
    if full:
        require(digest.hexdigest() == expected_sha, "download SHA-256 mismatch")
    return {"bytes_read": received, "verification": "full_sha256" if full else "range_and_total_size"}


def available_by_sha(client: InfrastructureClient, *, namespace: str, sha256: str) -> dict[str, Any] | None:
    """Legacy uploads were registered under name = sha256; find the live one."""
    offset = 0
    while True:
        page = client.request("GET", "/storage/objects", namespace=namespace,
                              params={"name": sha256, "limit": 1000, "offset": offset})["objects"]
        for row in page:
            if row["sha256"] == sha256 and row["state"] == "available":
                return row
        if len(page) < 1000:
            return None
        offset += len(page)


def missing_in_namespace(client: InfrastructureClient, object_id: str, namespace: str) -> None:
    for suffix in ("", "/download", "/upload"):
        try:
            client.request("GET", f"/storage/objects/{object_id}{suffix}", namespace=namespace)
        except NotFoundError:
            continue
        raise CheckFailed("foreign namespace obtained object metadata or transfer target")


def verify_schema(conn: Any, *, pre_cutover: bool = False) -> int:
    latest = conn.execute("SELECT max(version) AS version FROM schema_migrations").fetchone()["version"]
    allowed = range(57 if pre_cutover else 59, MIGRATION_ORDER[-1] + 1)
    require(latest in allowed, "research schema version does not match this verification phase")
    if latest >= 58:
        versions = conn.execute("SELECT version,name FROM schema_migrations WHERE version=58").fetchall()
        require(len(versions) == 1 and versions[0]["name"] == "add_remote_sandbox_links", "research schema58 is not installed")
        conn.execute("SELECT project_id,sandbox_uid,experiment_id,public_key FROM remote_sandbox_links LIMIT 0")
    return latest


def research_inventory(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    require(bool(os.environ.get("MERV_DB_URL")), "MERV_DB_URL is required")
    # Connecting directly avoids startup migrations and research logging. The
    # database enforces read-only transactions for the entire session.
    with psycopg.connect(os.environ["MERV_DB_URL"], row_factory=dict_row,
                         options="-c default_transaction_read_only=on -c statement_timeout=30000") as conn:
        version = verify_schema(conn, pre_cutover=args.pre_cutover)
        counts = conn.execute("""SELECT
            (SELECT count(*) FROM projects) AS projects,
            (SELECT count(*) FROM artifacts WHERE status='complete') AS complete_artifacts,
            (SELECT count(*) FROM storage_objects WHERE status='available') AS available_heavy,
            (SELECT count(*) FROM storage_objects WHERE status='uploading') AS uploading_heavy,
            (SELECT count(*) FROM sandboxes WHERE status NOT IN ('terminated','expired','failed','released')) AS active_legacy
        """).fetchone()
        require(counts["active_legacy"] == 0, "legacy active sandboxes remain")
        require(counts["projects"] > 0 and counts["complete_artifacts"] > 0, "research inventory is unexpectedly empty")
        # Oldest bounded artifact in each project exercises history, not just
        # the newest records. A second slice covers recent submissions.
        artifacts = conn.execute("""WITH candidates AS (
            SELECT DISTINCT ON (project_id) id,project_id,content_sha256,size_bytes,created_at
            FROM artifacts WHERE status='complete' AND content_sha256<>'' AND size_bytes BETWEEN 1 AND %s
            ORDER BY project_id,created_at,id)
            SELECT * FROM candidates ORDER BY created_at,id LIMIT %s""",
            (args.full_limit_mib * MIB, args.artifact_samples)).fetchall()
        recent = conn.execute("""SELECT id,project_id,content_sha256,size_bytes,created_at FROM artifacts
            WHERE status='complete' AND content_sha256<>'' AND size_bytes BETWEEN 1 AND %s
            ORDER BY created_at DESC,id LIMIT %s""", (args.full_limit_mib * MIB, args.artifact_samples)).fetchall()
        artifacts = list({row["id"]: row for row in [*artifacts, *recent]}.values())
        heavy = conn.execute("""WITH candidates AS (
            SELECT DISTINCT ON (project_id) id,project_id,namespace,content_sha256,size_bytes
            FROM storage_objects WHERE status='available'
            ORDER BY project_id,size_bytes,id)
            SELECT * FROM candidates ORDER BY project_id LIMIT %s""", (args.heavy_samples,)).fetchall()
        # Exercise a retained large R2 object as well as the small full-hash
        # samples. verify_history limits this transfer to a 1 MiB range.
        heavy += conn.execute("""SELECT id,project_id,namespace,content_sha256,size_bytes
            FROM storage_objects WHERE status='available'
            ORDER BY size_bytes DESC,id LIMIT 1""").fetchall()
        recovered = conn.execute("""SELECT id,project_id,namespace,content_sha256,size_bytes
            FROM storage_objects WHERE status='available' AND project_id=%s ORDER BY size_bytes,id""",
            (args.recovered_project,)).fetchall() if args.recovered_project else []
        if args.recovered_project:
            require(len(recovered) >= args.expected_recovered, "recovered-project available object count is below expectation")
        emit("research_schema", ok=True, version=version, pre_cutover=args.pre_cutover, **counts)
    return artifacts, heavy, recovered


def verify_history(args: argparse.Namespace, client: InfrastructureClient) -> None:
    artifacts, heavy, recovered = research_inventory(args)
    require(bool(artifacts), "no bounded artifact samples available")
    require(bool(heavy), "no heavy-object samples available")
    blobs = build_blob_store(default_root=Path("."))
    budget = args.history_budget_mib * MIB
    consumed = 0
    for row in artifacts:
        require(consumed + row["size_bytes"] <= budget, "historical download budget would be exceeded")
        data = blobs.get(namespace=row["project_id"], sha256=row["content_sha256"], max_bytes=args.full_limit_mib * MIB)
        require(len(data) == row["size_bytes"], "artifact size differs from research metadata")
        require(hashlib.sha256(data).hexdigest() == row["content_sha256"], "artifact full SHA-256 mismatch")
        consumed += len(data)
        emit("historical_artifact", ok=True, id=row["id"], project_id=row["project_id"], bytes_read=len(data), verification="full_sha256")
    rows = {row["id"]: row for row in [*heavy, *recovered]}
    recovered_ids = {row["id"] for row in recovered}
    for row in rows.values():
        namespace = row["namespace"]
        require(namespace == row["project_id"], "historical heavy namespace does not match project")
        native = available_by_sha(client, namespace=namespace, sha256=row["content_sha256"])
        require(native is not None and native["size_bytes"] == row["size_bytes"], "native stat does not match research heavy metadata")
        limit = min(args.full_limit_mib * MIB, max(0, budget - consumed))
        if row["id"] in recovered_ids:
            require(row["size_bytes"] <= limit, "recovered object cannot receive full SHA-256 within byte limits")
        expected_read = row["size_bytes"] if row["size_bytes"] <= limit else min(MIB, row["size_bytes"])
        require(consumed + expected_read <= budget, "historical download budget would be exceeded")
        target = client.request("GET", f"/storage/objects/{native['id']}/download", namespace=namespace)
        verified = bounded_download(target["url"], size=row["size_bytes"], expected_sha=row["content_sha256"], full_limit=limit)
        consumed += verified["bytes_read"]
        emit("historical_heavy", ok=True, id=row["id"], project_id=row["project_id"], recovered=row["id"] in recovered_ids, **verified)
    emit("historical_totals", ok=True, artifact_samples=len(artifacts), heavy_samples=len(rows), recovered_samples=len(recovered), bytes_read=consumed)


def put_part(part: dict[str, Any], *, source: Path, part_size: int, total_size: int) -> None:
    require(urlsplit(part["url"]).scheme == "https", "upload URL must use HTTPS")
    offset = (int(part["part_number"]) - 1) * part_size
    length = min(part_size, total_size - offset)
    require(0 <= offset < total_size and length == int(part["size_bytes"]), "invalid upload part range")
    with source.open("rb") as handle:
        handle.seek(offset)
        body = handle.read(length)
    require(len(body) == length, "smoke file ended before upload part")
    with httpx.Client(timeout=httpx.Timeout(180, connect=15), follow_redirects=False) as transfer:
        response = transfer.put(part["url"], content=body, headers=part.get("headers", {}))
        response.raise_for_status()
        require(bool(response.headers.get("ETag")), "object store returned no upload ETag")


def clean_owned(client: InfrastructureClient, owned: list[tuple[str, str]], deadline_seconds: int = 90) -> bool:
    errors = []
    for namespace, oid in owned:
        try:
            client.request("DELETE", f"/storage/objects/{oid}", namespace=namespace)
        except Exception as exc:
            errors.append({"namespace": namespace, "object_id": oid, **safe_failure(exc)})
    deadline = time.monotonic() + deadline_seconds
    pending = set(owned)
    while pending and time.monotonic() < deadline:
        for namespace, oid in list(pending):
            try:
                row = client.request("GET", f"/storage/objects/{oid}", namespace=namespace)
                if row["state"] == "deleted":
                    pending.remove((namespace, oid))
            except NotFoundError:
                pending.remove((namespace, oid))
            except Exception as exc:
                errors.append({"namespace": namespace, "object_id": oid, **safe_failure(exc)})
        if pending:
            time.sleep(2)
    emit("smoke_cleanup", ok=not pending and not errors,
         pending=[{"namespace": ns, "object_id": oid} for ns, oid in sorted(pending)], errors=errors)
    return not pending and not errors


def verify_artifact_write(run_id: str) -> None:
    """Exercise Merv's R2 bytes and clean the one precomputed content key."""
    blobs = build_blob_store(default_root=Path("."))
    data = (run_id + ":evidence\n").encode() * 64
    digest = hashlib.sha256(data).hexdigest()
    emit("new_blob_intent", namespace=run_id, sha256=digest, bytes=len(data))
    try:
        actual = blobs.put(namespace=run_id, data=data, content_type="text/plain")
        require(actual == digest and blobs.get(namespace=run_id, sha256=digest) == data, "new evidence round-trip failed")
        try:
            blobs.get(namespace=run_id + "_other", sha256=digest)
        except NotFoundError:
            pass
        else:
            raise CheckFailed("another evidence namespace found smoke bytes")
        emit("new_blob", ok=True, namespace=run_id, sha256=digest, bytes=len(data))
    finally:
        # The content address is known before PUT, including when an accepted
        # upload's response is lost. No listing or wildcard deletion is needed.
        blobs.delete(namespace=run_id, sha256=digest)
        try:
            blobs.get(namespace=run_id, sha256=digest)
        except NotFoundError:
            emit("blob_cleanup", ok=True, namespace=run_id, sha256=digest)
        else:
            raise CheckFailed("artifact smoke bytes need exact-key operator cleanup")


def verify_connection(client: InfrastructureClient, project_id: str) -> dict[str, Any]:
    require(bool(project_id), "an explicit configured verification project is required")
    namespace = client.namespace_for_project(project_namespace(project_id))
    identity = client.request("GET", "/auth/me", namespace=project_id)
    require(identity.get("role") == "consumer" and identity.get("namespace") == namespace,
            "verification requires a consumer grant for the configured namespace")
    return identity


def verify_writes(args: argparse.Namespace, client: InfrastructureClient) -> None:
    run_id = "smoke_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(4)
    namespace = project_namespace(args.project_id)
    wrong_namespace = project_namespace(args.other_project_id)
    primary = verify_connection(client, namespace)
    other = verify_connection(client, wrong_namespace)
    require(primary["namespace"] != other["namespace"], "isolation verification requires different namespaces")
    owned: list[tuple[str, str]] = []
    cleanup_ok = False
    try:
        verify_artifact_write(run_id)
        with tempfile.TemporaryDirectory(prefix="merv-storage-smoke-") as temporary:
            source = Path(temporary) / "payload.bin"
            digesting = hashlib.sha256()
            length = args.multipart_mib * MIB
            with source.open("wb") as handle:
                for _ in range(args.multipart_mib):
                    block = os.urandom(MIB)
                    handle.write(block)
                    digesting.update(block)
            sha = digesting.hexdigest()
            emit("new_heavy_intent", namespace=namespace, sha256=sha, bytes=length)
            try:
                status = client.request("POST", "/storage/objects", namespace=namespace,
                                        json={"name": sha, "sha256": sha, "size_bytes": length,
                                              "content_type": "application/octet-stream"})
                target = upload_target(client, namespace=namespace, status=status)
            finally:
                # Recover an accepted create whose HTTP response was lost.
                owned.extend((namespace, row["id"]) for row in client.request(
                    "GET", "/storage/objects", namespace=namespace,
                    params={"name": sha, "limit": 1000, "offset": 0})["objects"] if row["sha256"] == sha)
            oid = target["upload_id"]
            owned.append((namespace, oid))
            emit("new_heavy_created", object_id=oid, namespace=namespace, bytes=length, parts=target["part_count"])
            require(target["part_count"] >= 2, "configured smoke payload did not exercise multipart upload")
            first = target["parts"][0]
            put_part(first, source=source, part_size=target["part_size"], total_size=length)
            resumed = upload_target(client, namespace=namespace, status=client.request(
                "GET", f"/storage/objects/{oid}/upload", namespace=namespace))
            require(first["part_number"] in resumed["completed_parts"], "resume did not recognize the uploaded first part")
            require(all(part["part_number"] != first["part_number"] for part in resumed["parts"]), "resume requested retransmission of completed part")
            for part in resumed["parts"]:
                put_part(part, source=source, part_size=resumed["part_size"], total_size=length)
            completed = client.request("POST", f"/storage/objects/{oid}/complete", namespace=namespace)
            require(completed["state"] == "available" and completed["sha256"] == sha
                    and completed["size_bytes"] == length, "completed smoke upload metadata differs")
            # Cleanup tracks exact IDs and requires worker-confirmed deletion
            # before reporting pass.
            found = available_by_sha(client, namespace=namespace, sha256=sha)
            require(found is not None and found["id"] == oid, "service catalog disagrees after completion")
            download = client.request("GET", f"/storage/objects/{oid}/download", namespace=namespace)
            checked = bounded_download(download["url"], size=length, expected_sha=sha, full_limit=length)
            missing_in_namespace(client, oid, wrong_namespace)
            require(available_by_sha(client, namespace=wrong_namespace, sha256=sha) is None, "another project found smoke content")
            emit("new_heavy", ok=True, object_id=oid, namespace=namespace, resume_verified=True, **checked)
        # Exercise the service deletion path; final cleanup verifies physical
        # deletion after the service worker acknowledges it.
        deleted = client.request("DELETE", f"/storage/objects/{oid}", namespace=namespace)
        require(deleted["state"] in {"delete_pending", "deleted"}, "heavy deletion did not find smoke object")
    finally:
        cleanup_ok = clean_owned(client, list(dict.fromkeys(owned)))
    require(cleanup_ok, "smoke objects need operator cleanup using the reported exact IDs")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-id", default=os.environ.get("MERV_VERIFY_PROJECT_ID"),
                        help="configured project reference for the consumer connection")
    parser.add_argument("--other-project-id", default=os.environ.get("MERV_VERIFY_OTHER_PROJECT_ID"),
                        help="independently configured namespace for storage isolation checks")
    parser.add_argument("--subject", default=os.environ.get("MERV_VERIFY_SUBJECT"),
                        help="mapped external subject for multi-member application grants")
    parser.add_argument("--pre-cutover", action="store_true", help="allow schema57 for strictly read-only research checks before the production switch")
    parser.add_argument("--write-storage", action="store_true", help="also create and delete uniquely named smoke bytes")
    parser.add_argument("--artifact-samples", type=int, default=5, help="old project samples plus this many recent artifacts")
    parser.add_argument("--heavy-samples", type=int, default=5)
    parser.add_argument("--recovered-project", default="proj_d0b83f01b61a")
    parser.add_argument("--expected-recovered", type=int, default=26)
    parser.add_argument("--full-limit-mib", type=int, default=32)
    parser.add_argument("--history-budget-mib", type=int, default=256)
    parser.add_argument("--multipart-mib", type=int, default=65)
    args = parser.parse_args()
    require(bool(args.project_id), "--project-id or MERV_VERIFY_PROJECT_ID is required")
    require(not args.write_storage or bool(args.other_project_id),
            "--write-storage also requires --other-project-id")
    require(1 <= args.artifact_samples <= 20 and 1 <= args.heavy_samples <= 20, "sample counts must be1–20")
    require(1 <= args.full_limit_mib <= 64 and 1 <= args.history_budget_mib <= 512, "historical byte limits outside bound")
    require(6 <= args.multipart_mib <= 128, "multipart payload must be6–128MiB")
    return args


def main() -> int:
    client = None
    try:
        args = parse_args()
        client = build_infrastructure_client()
        require(client is not None, "new infrastructure configuration is missing")
        with infrastructure_actor(args.subject):
            whoami = verify_connection(client, args.project_id)
            emit("consumer_auth", ok=True, namespace=whoami["namespace"])
            verify_history(args, client)
            if args.write_storage:
                verify_writes(args, client)
        emit("complete", ok=True, writes_enabled=args.write_storage)
        return 0
    except Exception as exc:
        emit("failed", ok=False, **safe_failure(exc))
        return 1
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
