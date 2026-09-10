"""Exercise the reviewed smoke flow without purchasing or contacting compute."""

import importlib.util
import io
import logging
import os
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.structure.test_sandboxes_verifier import verifier
from tests.support.infrastructure import FakeInfrastructureClient


class NativeSmoke(FakeInfrastructureClient):
    def __init__(self, *, lost_create=False, lost_job=False, foreign=False):
        super().__init__()
        self.offer.update(
            provider="lambda",
            plugin="lambda",
            offer_id="gpu_1x_a10:us-east-1",
            instance_type="gpu_1x_a10",
        )
        self.offer["hourly_price"]["amount"] = "1.29"
        self.offer["resources"].update(gpu_count=1, gpu="A10")
        self.snapshots = {}
        self.lost_create = lost_create
        self.lost_job = lost_job
        self.foreign = foreign
        self.workflows = {}
        self.auth_calls = []

    def namespace_for_project(self, project_id):
        return project_id

    def request(self, method, path, *, namespace, json=None, params=None):
        if path == "/providers":
            self.providers[namespace] = {
                "lambda": {
                    "name": "lambda",
                    "plugin": "lambda",
                    "source": "host",
                    "health": {"status": "ok"},
                }
            }
        if path == "/auth/me":
            self.auth_calls.append(namespace)
            return {"role": "consumer", "namespace": namespace}
        if path == "/workflows":
            return {
                "workflows": deepcopy(list(self.workflows.get(namespace, {}).values())),
                "next": None,
            }
        if path.startswith("/workflows/"):
            identifier = path.split("/")[2]
            if path.endswith("/cancel"):
                self.workflows[namespace][identifier]["state"] = "cancelled"
            return deepcopy(self.workflows[namespace][identifier])
        if path.startswith("/access/certificates/"):
            return {}
        if path == "/spend":
            return {"month_to_date": [{"currency": "USD", "amount": "0.01"}]}
        if path == "/snapshots":
            return {
                "snapshots": deepcopy(list(self.snapshots.get(namespace, {}).values()))
            }
        if path.startswith("/snapshots/"):
            oid = path.rsplit("/", 1)[1]
            if oid not in self.snapshots.get(namespace, {}):
                raise verifier.NotFoundError("not found")
            if method == "DELETE":
                self.snapshots[namespace][oid]["state"] = "deleted"
            return deepcopy(self.snapshots[namespace][oid])
        result = super().request(
            method, path, namespace=namespace, json=json, params=params
        )
        if path == "/sandboxes" and method == "POST":
            self.records[namespace][result["id"]]["lease_expires_at"] = (
                datetime.now(UTC) + timedelta(seconds=600)
            ).isoformat()
            result = deepcopy(self.records[namespace][result["id"]])
            if self.foreign:
                self.seed(
                    namespace,
                    "sbx_unrelated",
                    request={"idempotency_key": "another-application"},
                )
            if self.lost_create:
                raise RuntimeError("accepted create response was lost")
        if path == "/access/certificates":
            result["serial"] = 1
        if path.startswith("/sandboxes/") and path.endswith("/jobs"):
            self.jobs[namespace][result["id"]].update(
                state="succeeded", exit_code=0, artifact_id="snap_smoke"
            )
            result = deepcopy(self.jobs[namespace][result["id"]])
            self.snapshots[namespace] = {
                "snap_smoke": {
                    "id": "snap_smoke",
                    "sandbox_id": result["sandbox_id"],
                    "artifact_of": result["id"],
                    "state": "ready",
                    "manifest_id": "manifest_smoke",
                    "files": 1,
                    "bytes": len(b"merv-job-smoke\n"),
                }
            }
            self.workflows[namespace] = {
                "wf_smoke": {
                    "id": "wf_smoke",
                    "name": json["name"],
                    "state": "completed",
                    "request": {
                        "nodes": [
                            {"kind": "use_vm", "sandbox_id": result["sandbox_id"]}
                        ]
                    },
                    "nodes": {"run": {"result": {"job_id": result["id"]}}},
                }
            }
            if self.foreign:
                self.snapshots[namespace]["snap_unrelated"] = {
                    "id": "snap_unrelated",
                    "sandbox_id": result["sandbox_id"],
                    "artifact_of": "job_another",
                    "state": "ready",
                }
            if self.lost_job:
                self.workflows[namespace]["wf_smoke"]["state"] = "running"
                raise RuntimeError("accepted job response was lost")
        return result

    def request_bytes(self, method, path, *, namespace, params=None):
        return (
            b"merv-job-smoke\n"
            if params["stream"] == "stdout"
            else b"merv-job-stderr\n",
            {"x-output-complete": "1"},
        )


def smoke_module():
    spec = importlib.util.spec_from_file_location(
        "compute_verifier",
        Path(__file__).resolve().parents[2] / "deploy" / "verify_merv_compute.py",
    )
    module = importlib.util.module_from_spec(spec)
    with (
        patch.dict(sys.modules, {"verify_sandboxes_cutover": verifier}),
        patch.dict(os.environ),
    ):
        spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("lost_create", [False, True])
def test_compute_cleanup_and_no_provisioning_retry(lost_create):
    logging_disabled_before = logging.root.manager.disable
    module = smoke_module()
    native = NativeSmoke(lost_create=lost_create)
    public = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm test"
    with (
        patch.dict(
            os.environ,
            {
                "MERV_SMOKE_PUBLIC_KEY": public,
                "MERV_DB_URL": "",
                "RESEARCH_PLUGIN_DB_URL": "",
                "MERV_SMOKE_PROJECT_ID": "proj_smoke",
                "MERV_SMOKE_OTHER_PROJECT_ID": "proj_other",
            },
            clear=True,
        ),
        patch.dict(
            module.build_control_app.__globals__,
            {"build_infrastructure_client": lambda *args: native},
        ),
        patch.object(
            module.read_ssh_result.__globals__["sys"],
            "stdin",
            io.StringIO('{"ssh_ok": true}\n'),
        ),
        patch.object(module, "read_ssh_result", return_value={"ssh_ok": True}),
    ):
        if lost_create:
            with pytest.raises(RuntimeError, match="response was lost"):
                module.run()
        else:
            module.run()
    creates = [call for call in native.calls if call[:2] == ("POST", "/sandboxes")]
    assert len(creates) == 1
    assert all(
        row["state"] == "stopped"
        for records in native.records.values()
        for row in records.values()
    )
    assert all(
        row["state"] == "deleted"
        for rows in native.snapshots.values()
        for row in rows.values()
    )
    assert "merv_budget" not in creates[0][3]
    assert all(call[:2] != ("PUT", "/spend/budget") for call in native.calls)
    assert logging.root.manager.disable == logging_disabled_before


def run_smoke(native, module, **overrides):
    environment = {
        "MERV_SMOKE_PUBLIC_KEY": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm test",
        "MERV_SMOKE_PROJECT_ID": "proj_smoke",
        "MERV_SMOKE_OTHER_PROJECT_ID": "proj_other",
        **overrides,
    }
    with (
        patch.dict(os.environ, environment, clear=True),
        patch.dict(
            module.build_control_app.__globals__,
            {"build_infrastructure_client": lambda *args: native},
        ),
        patch.object(module, "read_ssh_result", return_value={"ssh_ok": True}),
    ):
        module.run()


@pytest.mark.parametrize("lost", ["none", "create", "job"])
def test_cleanup_preserves_unrelated_resources_and_recovers_its_own_work(lost):
    module = smoke_module()
    native = NativeSmoke(
        foreign=True, lost_create=lost == "create", lost_job=lost == "job"
    )
    if lost != "none":
        with pytest.raises(RuntimeError, match="response was lost"):
            run_smoke(native, module)
    else:
        run_smoke(native, module)
    assert (
        len([call for call in native.calls if call[:2] == ("POST", "/sandboxes")]) == 1
    )
    assert native.records["proj_smoke"]["sbx_1"]["state"] == "stopped"
    assert native.records["proj_smoke"]["sbx_unrelated"]["state"] == "ready"
    if lost != "create":
        assert native.snapshots["proj_smoke"]["snap_smoke"]["state"] == "deleted"
        assert native.snapshots["proj_smoke"]["snap_unrelated"]["state"] == "ready"
    if lost == "job":
        assert native.workflows["proj_smoke"]["wf_smoke"]["state"] == "cancelled"


@pytest.mark.parametrize(
    "invalid", ["admin", "unconfigured", "same_namespace", "same_project"]
)
def test_both_connections_are_validated_before_any_compute(invalid):
    module = smoke_module()

    class InvalidConnection(NativeSmoke):
        def namespace_for_project(self, project_id):
            if invalid == "unconfigured" and project_id == "proj_other":
                raise ValueError("project is unconfigured")
            return "shared" if invalid == "same_namespace" else project_id

        def request(self, method, path, *, namespace, **kwargs):
            result = super().request(method, path, namespace=namespace, **kwargs)
            if path == "/auth/me":
                if invalid == "admin" and namespace == "proj_other":
                    result["role"] = "admin"
                if invalid == "same_namespace":
                    result["namespace"] = "shared"
            return result

    native = InvalidConnection()
    with pytest.raises((ValueError, RuntimeError)):
        run_smoke(
            native,
            module,
            MERV_SMOKE_OTHER_PROJECT_ID="proj_smoke"
            if invalid == "same_project"
            else "proj_other",
        )
    assert not [call for call in native.calls if call[0] in {"POST", "PUT", "DELETE"}]


def test_unresolved_create_key_is_a_failed_cleanup_without_deleting_neighbors():
    from types import SimpleNamespace

    module = smoke_module()
    native = NativeSmoke()
    native.seed("proj_smoke", "unrelated", request={"idempotency_key": "different"})
    receipt = module.CreateReceipt(native, "proj_smoke")
    receipt.key = "submitted-but-unresolved"
    app = SimpleNamespace(
        sandboxes=SimpleNamespace(
            release=lambda **kwargs: pytest.fail("must not delete a neighbor")
        )
    )
    assert not module.cleanup_compute(
        app, native, "proj_smoke", receipt, None, "job-name", False, None, False, None
    )
    assert native.records["proj_smoke"]["unrelated"]["state"] == "ready"


def test_ssh_handshake_has_a_deadline(monkeypatch):
    module = smoke_module()
    monkeypatch.setattr(module.select, "select", lambda *args: ([], [], []))
    with pytest.raises(RuntimeError, match="timed out"):
        module.read_ssh_result(timeout=1)


def test_conflicting_job_receipt_does_not_cancel_or_delete_other_work():
    from types import SimpleNamespace

    module = smoke_module()
    native = NativeSmoke()
    native.seed("proj_smoke", "own", request={"idempotency_key": "owned-key"})
    native.workflows["proj_smoke"] = {
        "other": {
            "id": "other",
            "name": "smoke-name",
            "state": "running",
            "request": {"nodes": [{"kind": "use_vm", "sandbox_id": "own"}]},
            "nodes": {"run": {"result": {"job_id": "another-job"}}},
        }
    }
    native.snapshots["proj_smoke"] = {
        "other": {
            "id": "other",
            "sandbox_id": "own",
            "artifact_of": "another-job",
            "state": "ready",
        }
    }
    receipt = module.CreateReceipt(native, "proj_smoke")
    receipt.key = "owned-key"
    app = SimpleNamespace(
        sandboxes=SimpleNamespace(
            release=lambda **kwargs: native.request(
                "DELETE", "/sandboxes/own", namespace="proj_smoke"
            )
        )
    )
    assert not module.cleanup_compute(
        app,
        native,
        "proj_smoke",
        receipt,
        "own",
        "smoke-name",
        True,
        "expected-job",
        False,
        None,
    )
    assert native.records["proj_smoke"]["own"]["state"] == "stopped"
    assert native.workflows["proj_smoke"]["other"]["state"] == "running"
    assert native.snapshots["proj_smoke"]["other"]["state"] == "ready"


def test_snapshot_delete_failure_still_releases_vm_and_revokes_certificate(capsys):
    module = smoke_module()

    class FailedSnapshot(NativeSmoke):
        revoked = False

        def request(self, method, path, *, namespace, **kwargs):
            if method == "DELETE" and path.startswith("/snapshots/"):
                raise RuntimeError("private-signed-url")
            if method == "DELETE" and path.startswith("/access/certificates/"):
                self.revoked = True
            return super().request(method, path, namespace=namespace, **kwargs)

    native = FailedSnapshot()
    with pytest.raises(RuntimeError, match="cleanup needs operator attention"):
        run_smoke(native, module)
    assert native.records["proj_smoke"]["sbx_1"]["state"] == "stopped"
    assert native.revoked
    assert "private-signed-url" not in capsys.readouterr().out
