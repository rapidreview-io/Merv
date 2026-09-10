"""One reviewed Lambda lifecycle, through Merv facades and native access."""

# ruff: noqa: BLE001 -- cleanup isolates failures and redacts upstream exceptions.

from __future__ import annotations

import json
import logging
import os
import secrets
import select
import sys
import tempfile
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

os.environ["MERV_DB_URL"] = ""
os.environ["RESEARCH_PLUGIN_DB_URL"] = ""
from verify_sandboxes_cutover import emit, require, safe_failure, verify_connection

from merv.brain.infrastructure import infrastructure_actor
from merv.brain.infrastructure.ports import project_namespace
from merv.brain.kernel.utils import NotFoundError
from merv.brain.surface.surface import build_control_app

PROVIDER = "lambda"
OFFER = "gpu_1x_a10:us-east-1"
PRICE = Decimal("1.29")
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out"}


class CreateReceipt:
    """Remember the facade's exact submission key before a response can be lost."""

    def __init__(self, client, project):
        self.client, self.project, self.key = client, project, None

    def __getattr__(self, name):
        return getattr(self.client, name)

    def request(self, method, path, *, namespace, **kwargs):
        if method == "POST" and path == "/sandboxes":
            require(
                namespace == self.project and self.key is None,
                "smoke permits one create attempt",
            )
            key = kwargs.get("json", {}).get("idempotency_key")
            require(
                isinstance(key, str) and bool(key), "create must have a recoverable key"
            )
            self.key = key
            emit("compute_submission", project_id=namespace, idempotency_key=key)
        return self.client.request(method, path, namespace=namespace, **kwargs)


def read_ssh_result(timeout=60):
    require(
        bool(select.select([sys.stdin], [], [], timeout)[0]),
        "SSH verification response timed out",
    )
    return json.loads(sys.stdin.readline())


def workflow_receipt(client, project, name, sandbox_id):
    after = None
    seen = set()
    matches = []
    for _ in range(50):
        page = client.request(
            "GET",
            "/workflows",
            namespace=project,
            params={"after": after} if after else {},
        )
        for record in page["workflows"]:
            if record.get("name") == name:
                require(
                    any(
                        node.get("kind") == "use_vm"
                        and node.get("sandbox_id") == sandbox_id
                        for node in record["request"]["nodes"]
                    ),
                    "workflow receipt has a different VM",
                )
                matches.append(record)
        after = page.get("next")
        if not after:
            break
        require(after not in seen, "workflow listing repeated a cursor")
        seen.add(after)
    else:
        raise RuntimeError("workflow recovery exceeded its listing bound")
    require(len(matches) == 1, "job submission needs exact workflow reconciliation")
    return matches[0]


def cleanup_compute(
    app,
    client,
    project,
    receipt,
    sandbox_id,
    job_name,
    job_attempted,
    job_id,
    job_succeeded,
    certificate_serial,
):
    errors = []
    machine = None
    workflow = None
    snapshots = []
    verified_cost = None
    stopped = receipt.key is None
    if receipt.key is not None:
        try:
            records = client.request(
                "GET",
                "/sandboxes",
                namespace=project,
                params={"include_stopped": "true"},
            )["sandboxes"]
            owned = [
                row
                for row in records
                if row.get("request", {}).get("idempotency_key") == receipt.key
            ]
            require(len(owned) == 1, "create submission needs exact-key reconciliation")
            machine = owned[0]
            require(
                sandbox_id is None or machine["id"] == sandbox_id,
                "create receipt ID mismatch",
            )
        except Exception as exc:
            errors.append(safe_failure(exc))
    if machine is not None:
        if job_attempted:
            try:
                candidate = workflow_receipt(client, project, job_name, machine["id"])
                recovered_job = (
                    candidate["nodes"].get("run", {}).get("result", {}).get("job_id")
                )
                require(
                    not job_id or recovered_job == job_id, "job receipt ID mismatch"
                )
                job_id = recovered_job
                workflow = candidate
                if workflow["state"] not in {"completed", "failed", "cancelled"}:
                    client.request(
                        "POST",
                        "/workflows/" + workflow["id"] + "/cancel",
                        namespace=project,
                    )
            except Exception as exc:
                errors.append(safe_failure(exc))
        try:
            if machine["state"] != "stopped":
                app.sandboxes.release(
                    project_id=project, sandbox_uid=machine["id"], confirm_retained=True
                )
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                machine = client.request(
                    "GET", "/sandboxes/" + machine["id"], namespace=project
                )
                if machine["state"] == "stopped":
                    stopped = True
                    break
                time.sleep(3)
            require(stopped, "smoke resource deletion still pending")
        except Exception as exc:
            errors.append(safe_failure(exc))
        if workflow is not None:
            try:
                deadline = time.monotonic() + 120
                while (
                    workflow["state"] not in {"completed", "failed", "cancelled"}
                    and time.monotonic() < deadline
                ):
                    workflow = client.request(
                        "GET", "/workflows/" + workflow["id"], namespace=project
                    )
                    time.sleep(2)
                require(
                    workflow["state"] in {"completed", "failed", "cancelled"},
                    "output workflow cleanup still pending",
                )
                job_id = (
                    workflow["nodes"].get("run", {}).get("result", {}).get("job_id")
                    or job_id
                )
                if job_id:
                    candidates = client.request(
                        "GET",
                        "/snapshots",
                        namespace=project,
                        params={"sandbox_id": machine["id"], "include_deleted": "true"},
                    )["snapshots"]
                    snapshots = [
                        row
                        for row in candidates
                        if row.get("sandbox_id") == machine["id"]
                        and row.get("artifact_of") == job_id
                    ]
                    for snapshot in snapshots:
                        if snapshot["state"] != "deleted":
                            client.request(
                                "DELETE",
                                "/snapshots/" + snapshot["id"],
                                namespace=project,
                            )
                    deadline = time.monotonic() + 120
                    while (
                        any(row["state"] != "deleted" for row in snapshots)
                        and time.monotonic() < deadline
                    ):
                        snapshots = [
                            client.request(
                                "GET", "/snapshots/" + row["id"], namespace=project
                            )
                            for row in snapshots
                        ]
                        if any(row["state"] != "deleted" for row in snapshots):
                            time.sleep(3)
                    require(
                        all(row["state"] == "deleted" for row in snapshots),
                        "smoke snapshot deletion still pending",
                    )
                if job_succeeded:
                    retained = app.sandboxes.job(
                        project_id=project, job_id=job_id, stream="stdout", limit=1024
                    )
                    require(
                        retained["state"] == "succeeded"
                        and retained["output"]["text"] == "merv-job-smoke\n",
                        "job output did not survive release",
                    )
            except Exception as exc:
                errors.append(safe_failure(exc))
        try:
            cost = machine.get("cost_so_far")
            require(
                cost is not None
                and cost["currency"] == "USD"
                and 0 <= Decimal(cost["amount"]) <= 1,
                "smoke resource cost could not be verified within the approved bound",
            )
            verified_cost = {"currency": "USD", "amount": str(Decimal(cost["amount"]))}
        except Exception as exc:
            errors.append(safe_failure(exc))
    if certificate_serial is not None:
        try:
            client.request(
                "DELETE",
                "/access/certificates/" + str(certificate_serial),
                namespace=project,
            )
        except Exception as exc:
            errors.append(safe_failure(exc))
    emit(
        "compute_cleanup",
        ok=stopped and not errors,
        project_id=project,
        sandbox_id=machine["id"] if machine else sandbox_id,
        idempotency_key=receipt.key,
        job_name=job_name if job_attempted else None,
        workflow_id=workflow["id"] if workflow else None,
        snapshot_ids=[row["id"] for row in snapshots],
        stopped=stopped,
        resource_cost=verified_cost,
        errors=errors,
    )
    return stopped and not errors


def absent(client, path, namespace):
    try:
        client.request("GET", path, namespace=namespace)
    except NotFoundError:
        return
    raise RuntimeError("foreign namespace obtained smoke resource")


def run() -> None:
    with infrastructure_actor(os.environ.get("MERV_SMOKE_SUBJECT")):
        _run()


def _run() -> None:
    pid = project_namespace(os.environ["MERV_SMOKE_PROJECT_ID"])
    wrong = project_namespace(os.environ["MERV_SMOKE_OTHER_PROJECT_ID"])
    require(pid != wrong, "isolation check requires two configured projects")
    with tempfile.TemporaryDirectory(prefix="merv-compute-smoke-") as temporary:
        app = build_control_app(repo_root=Path(temporary), env=dict(os.environ))
        with app._store.transaction() as conn:
            conn.execute(
                "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)",
                (
                    pid,
                    "Temporary compute smoke",
                    datetime.now(UTC).isoformat(),
                ),
            )
        namespace = project_namespace(pid)
        client = app.infrastructure_client
        # Use an empty dedicated namespace, while still guarding against work
        # arriving concurrently: cleanup requires exact submission receipts.
        try:
            primary = verify_connection(client, pid)
            other = verify_connection(client, wrong)
            require(
                primary["namespace"] != other["namespace"],
                "isolation check requires different namespaces",
            )
            require(
                not client.request("GET", "/sandboxes", namespace=namespace)[
                    "sandboxes"
                ],
                "smoke requires an empty dedicated namespace",
            )
            require(
                not client.request("GET", "/snapshots", namespace=namespace)[
                    "snapshots"
                ],
                "smoke namespace contains snapshots",
            )
        except Exception:
            app.shutdown()
            raise
        sandbox_id = None
        job_id = None
        certificate_serial = None
        job_succeeded = False
        stopped = False
        created_at = None
        receipt = CreateReceipt(client, pid)
        app.sandboxes.client = receipt
        job_name = "merv-smoke-" + secrets.token_hex(12)
        job_attempted = False
        try:
            require(
                app._store.db_path.is_relative_to(Path(temporary)),
                "compute research state must remain temporary",
            )
            # The operator provisions an exclusive empty namespace and a consumer
            # grant with budgets in the native UI before running this smoke.
            whoami = client.request("GET", "/auth/me", namespace=namespace)
            require(whoami["role"] == "consumer", "smoke requires a consumer grant")
            offers = client.request(
                "GET",
                "/options",
                namespace=namespace,
                params={"provider": PROVIDER, "all_options": "true", "refresh": "true"},
            )["offers"]
            offer = next(row for row in offers if row["offer_id"] == OFFER)
            require(
                offer["available"] and offer["resources"]["gpu_count"] == 1,
                "approved single-GPU offer is unavailable",
            )
            require(
                offer["hourly_price"]["currency"] == "USD"
                and Decimal(offer["hourly_price"]["amount"]) <= PRICE,
                "offer price increased beyond approval",
            )
            emit(
                "compute_intent",
                namespace=namespace,
                provider=PROVIDER,
                offer_id=OFFER,
                initial_lease_seconds=600,
                maximum_total_lease_seconds=900,
                total_budget_usd="1",
                hourly_usd="1.29",
            )
            created_at = time.monotonic()
            facts = app.sandboxes.request(
                project_id=pid,
                provider=PROVIDER,
                instance_type=OFFER,
                time_limit=600,
                public_key=os.environ["MERV_SMOKE_PUBLIC_KEY"],
            )
            sandbox_id = facts["sandbox_uid"]
            emit("compute_created", sandbox_id=sandbox_id, namespace=namespace)
            ready_deadline = created_at + 480
            while time.monotonic() < ready_deadline:
                record = client.request(
                    "GET",
                    "/sandboxes/" + sandbox_id,
                    namespace=namespace,
                    params={"wait": 10},
                )
                if record["state"] == "ready":
                    break
                require(
                    record["state"] == "provisioning",
                    "smoke provisioning failed or became uncertain",
                )
                time.sleep(2)
            require(record["state"] == "ready", "smoke readiness deadline exceeded")
            require(
                "merv_budget" not in record["request"],
                "application budget claims must not be persisted",
            )
            require(
                record["request"].get("idempotency_key") == receipt.key,
                "created resource does not match the submission key",
            )
            original_expiry = datetime.fromisoformat(record["lease_expires_at"])
            emit(
                "compute_ready",
                sandbox_id=sandbox_id,
                namespace=namespace,
                seconds=round(time.monotonic() - created_at, 2),
            )
            facts = app.sandboxes.get(project_id=pid, sandbox_uid=sandbox_id)
            require(
                facts["status"] == "running" and facts["ssh"]["host_public_key"],
                "Merv caller SSH projection failed",
            )
            access = client.request(
                "POST",
                "/access/certificates",
                namespace=namespace,
                json={
                    "public_key": os.environ["MERV_SMOKE_PUBLIC_KEY"],
                    "sandbox_id": sandbox_id,
                    "ttl_seconds": 60,
                },
            )
            certificate_serial = access["serial"]
            print(
                json.dumps(
                    {
                        "bridge": "ssh",
                        "sandbox_id": sandbox_id,
                        "certificate": access["certificate"],
                        "gateway": access["gateway"],
                    }
                ),
                flush=True,
            )
            response = read_ssh_result()
            require(
                response == {"ssh_ok": True}, "strict host-key-pinned caller SSH failed"
            )
            emit("compute_ssh", ok=True, sandbox_id=sandbox_id, certificate_seconds=60)
            command = "mkdir -p /workspace/merv-smoke-output\nprintf 'merv-job-smoke\\n' > /workspace/merv-smoke-output/result.txt\nprintf 'merv-job-smoke\\n'\nprintf 'merv-job-stderr\\n' >&2\n"
            emit(
                "compute_job_submission",
                project_id=pid,
                name=job_name,
                idempotency_key=job_name,
            )
            job_attempted = True
            job = app.sandboxes.run(
                project_id=pid,
                sandbox_uid=sandbox_id,
                name=job_name,
                command=command,
                cwd="/workspace",
                timeout_seconds=30,
                outputs="/workspace/merv-smoke-output",
                idempotency_key=job_name,
            )
            job_id = job["id"]
            require(
                job.get("sandbox_id") == sandbox_id and job.get("name") == job_name,
                "job response does not match the smoke submission",
            )
            emit("compute_job_started", sandbox_id=sandbox_id, job_id=job_id)
            deadline = min(created_at + 570, time.monotonic() + 150)
            while job["state"] not in TERMINAL and time.monotonic() < deadline:
                job = app.sandboxes.job(
                    project_id=pid,
                    job_id=job_id,
                    after=job.get("cursor"),
                    wait_seconds=10,
                )
            require(
                job["state"] == "succeeded" and job["exit_code"] == 0,
                "durable smoke job failed or timed out",
            )
            for stream, marker in [
                ("stdout", "merv-job-smoke\n"),
                ("stderr", "merv-job-stderr\n"),
            ]:
                output = app.sandboxes.job(
                    project_id=pid, job_id=job_id, stream=stream, limit=1024
                )["output"]
                require(
                    output["text"] == marker
                    and output["complete"]
                    and not output["truncated"],
                    "durable job output mismatch",
                )
            job_succeeded = True
            # Artifact capture completes asynchronously after the command.
            while not job.get("artifact_id") and time.monotonic() < deadline:
                job = app.sandboxes.job(
                    project_id=pid,
                    job_id=job_id,
                    after=job.get("cursor"),
                    wait_seconds=5,
                )
            require(
                bool(job.get("artifact_id")),
                "durable outputs snapshot was not retained",
            )
            snapshot = client.request(
                "GET", "/snapshots/" + job["artifact_id"], namespace=namespace
            )
            while snapshot["state"] == "pending" and time.monotonic() < deadline:
                time.sleep(2)
                snapshot = client.request(
                    "GET", "/snapshots/" + job["artifact_id"], namespace=namespace
                )
            require(
                snapshot["state"] == "ready"
                and snapshot.get("sandbox_id") == sandbox_id
                and snapshot.get("artifact_of") == job_id
                and snapshot["manifest_id"]
                and snapshot["files"] == 1
                and snapshot["bytes"] == len(b"merv-job-smoke\n"),
                "output snapshot manifest does not match the retained file",
            )
            for path in [
                "/sandboxes/" + sandbox_id,
                "/jobs/" + job_id,
                "/jobs/" + job_id + "/output",
                "/snapshots/" + job["artifact_id"],
            ]:
                absent(client, path, wrong)
            emit(
                "compute_job",
                ok=True,
                job_id=job_id,
                snapshot_id=job["artifact_id"],
                snapshot_files=snapshot["files"],
                snapshot_bytes=snapshot["bytes"],
                namespace_isolation=True,
            )
            require(
                time.monotonic() - created_at < 580,
                "smoke exceeded renewal readiness bound",
            )
            renewed = app.sandboxes.extend(
                project_id=pid, sandbox_uid=sandbox_id, seconds=300
            )
            renewed_expiry = datetime.fromisoformat(renewed["expires_at"])
            require(
                299 <= (renewed_expiry - original_expiry).total_seconds() <= 302,
                "Merv additive renewal did not advance by300seconds",
            )
            emit(
                "compute_renewal",
                ok=True,
                sandbox_id=sandbox_id,
                extended_seconds=round(
                    (renewed_expiry - original_expiry).total_seconds()
                ),
            )
        finally:
            try:
                stopped = cleanup_compute(
                    app,
                    client,
                    pid,
                    receipt,
                    sandbox_id,
                    job_name,
                    job_attempted,
                    job_id,
                    job_succeeded,
                    certificate_serial,
                )
            finally:
                app.shutdown()
        require(stopped, "smoke cleanup needs operator attention")
        emit(
            "compute_complete",
            ok=True,
            namespace=namespace,
            sandbox_id=sandbox_id,
            job_id=job_id,
        )


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        run()
    except Exception as exc:
        emit("compute_failed", ok=False, **safe_failure(exc))
        raise SystemExit(1)
