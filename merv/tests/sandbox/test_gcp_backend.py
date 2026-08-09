"""GCP backend: acquire flow, firewall ensure, liveness, GPU catalog."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from tests.sandbox.driver_conformance import (
    assert_catalog_envelope,
    assert_driver_surface,
)
from merv.brain.sandbox.adapters import sandbox_driver_descriptor
from merv.brain.sandbox.adapters.gcp import (
    GcpCloudConfig,
    GcpSandboxBackend,
    GcpSandboxConfig,
    to_agent_options,
)
from merv.brain.sandbox.models import (
    BackendUnavailableError,
    BackendValidationError,
    CapacityUnavailableError,
    SandboxRequest,
)


MACHINE_TYPES = [
    {
        "name": "g2-standard-8",
        "guestCpus": 8,
        "memoryMb": 32768,
        "accelerators": [
            {"guestAcceleratorType": "nvidia-l4", "guestAcceleratorCount": 1}
        ],
    },
    {
        "name": "a2-highgpu-1g",
        "guestCpus": 12,
        "memoryMb": 87040,
        "accelerators": [
            {
                "guestAcceleratorType": "nvidia-tesla-a100",
                "guestAcceleratorCount": 1,
            }
        ],
    },
    {
        # CPU machine type: no accelerators, excluded from the menu.
        "name": "n2-standard-8",
        "guestCpus": 8,
        "memoryMb": 32768,
    },
    {
        # Deprecated GPU shape: excluded from the menu.
        "name": "a2-old-1g",
        "guestCpus": 12,
        "memoryMb": 87040,
        "accelerators": [
            {
                "guestAcceleratorType": "nvidia-tesla-a100",
                "guestAcceleratorCount": 1,
            }
        ],
        "deprecated": {"state": "DEPRECATED"},
    },
]


class FakeGcpClient:
    def __init__(self) -> None:
        self.config = GcpCloudConfig(project="proj-test", zone="us-central1-a")
        self.instances_created: list[dict] = []
        self.instances_deleted: list[str] = []
        self.instances: dict[str, dict] = {}
        self.get_calls = 0
        self.firewall_exists = False
        self.firewalls_created: list[dict] = []

    def list_machine_types(self):
        return MACHINE_TYPES

    def get_instance(self, name):
        instance = self.instances.get(str(name))
        if instance is None:
            raise BackendUnavailableError("not found", status=404)
        self.get_calls += 1
        if self.get_calls >= 2:
            instance = {
                **instance,
                "status": "RUNNING",
                "networkInterfaces": [
                    {
                        "networkIP": "10.128.0.2",
                        "accessConfigs": [{"natIP": "35.238.10.20"}],
                    }
                ],
            }
        return instance

    def list_instances(self):
        return list(self.instances.values())

    def insert_instance(self, body):
        self.instances_created.append(body)
        self.instances[body["name"]] = {
            "name": body["name"],
            "status": "PROVISIONING",
            "networkInterfaces": [],
        }
        return {"name": "operation-1"}

    def delete_instance(self, name):
        if str(name) not in self.instances:
            raise BackendUnavailableError("not found", status=404)
        self.instances_deleted.append(str(name))
        self.instances.pop(str(name), None)

    def get_firewall(self, name):
        if not self.firewall_exists:
            raise BackendUnavailableError("not found", status=404)
        return {"name": name}

    def insert_firewall(self, body):
        self.firewall_exists = True
        self.firewalls_created.append(body)
        return {"name": "operation-2"}


def _backend(client: FakeGcpClient) -> GcpSandboxBackend:
    config = GcpSandboxConfig(
        cloud=client.config,
        poll_timeout_seconds=5,
        poll_interval_seconds=0.001,
    )
    return GcpSandboxBackend(config=config, client=client)  # type: ignore[arg-type]


def _request(**overrides) -> SandboxRequest:
    fields = {
        "experiment_id": "exp_1",
        "project_id": "proj_1",
        "public_key": "ssh-ed25519 AAAA caller",
        "sandbox_uid": "uid123",
        "management_public_key": "ssh-ed25519 BBBB mgmt",
        "instance_type": "g2-standard-8",
    }
    fields.update(overrides)
    return SandboxRequest(**fields)


class GcpAcquireTest(unittest.TestCase):
    def test_acquire_creates_firewall_and_returns_external_ip(self) -> None:
        client = FakeGcpClient()
        backend = _backend(client)
        with patch.object(GcpSandboxBackend, "_wait_for_ssh"):
            provisioned = backend.acquire(request=_request())

        # Instances are addressed by name; the name is the durable id.
        self.assertEqual(provisioned.sandbox_id, "rp-uid123")
        self.assertEqual(provisioned.ssh_host, "35.238.10.20")  # NAT, not networkIP
        self.assertEqual(provisioned.region, "us-central1-a")
        self.assertEqual(provisioned.gpu, "L4")
        # GCE quotes no price: the tri-state None must survive to storage as
        # price_known=0, never a coerced "known" $0.00/hr the caps skip.
        self.assertIsNone(provisioned.price_usd_per_hour)
        self.assertEqual(len(client.firewalls_created), 1)
        body = client.instances_created[0]
        metadata = {i["key"]: i["value"] for i in body["metadata"]["items"]}
        self.assertIn("#!/usr/bin/env bash", metadata["user-data"])
        self.assertEqual(metadata["install-nvidia-driver"], "True")
        self.assertEqual(metadata["enable-oslogin"], "FALSE")
        self.assertEqual(body["tags"]["items"], ["merv-sandbox"])
        self.assertEqual(
            body["scheduling"], {"onHostMaintenance": "TERMINATE", "automaticRestart": False}
        )

    def test_acquire_skips_firewall_create_when_rule_exists(self) -> None:
        client = FakeGcpClient()
        client.firewall_exists = True
        backend = _backend(client)
        with patch.object(GcpSandboxBackend, "_wait_for_ssh"):
            backend.acquire(request=_request())
        self.assertEqual(client.firewalls_created, [])

    def test_acquire_requires_instance_type(self) -> None:
        backend = _backend(FakeGcpClient())
        with self.assertRaisesRegex(BackendValidationError, "instance_type"):
            backend.acquire(request=_request(instance_type=""))

    def test_acquire_unknown_machine_type_lists_gpu_shapes(self) -> None:
        backend = _backend(FakeGcpClient())
        with self.assertRaisesRegex(CapacityUnavailableError, "g2-standard-8"):
            backend.acquire(request=_request(instance_type="a3-megagpu-8g"))

    def test_acquire_gpu_mismatch_is_rejected(self) -> None:
        backend = _backend(FakeGcpClient())
        with self.assertRaisesRegex(BackendValidationError, "does not match"):
            backend.acquire(request=_request(gpu="H100"))

    def test_acquire_failure_deletes_instance(self) -> None:
        client = FakeGcpClient()
        backend = _backend(client)
        with patch.object(
            GcpSandboxBackend,
            "_wait_for_vm",
            side_effect=BackendUnavailableError("boom"),
        ):
            with self.assertRaises(BackendUnavailableError):
                backend.acquire(request=_request())
        self.assertEqual(client.instances_deleted, ["rp-uid123"])


class GcpLifecycleTest(unittest.TestCase):
    def test_stopped_instance_still_counts_as_alive(self) -> None:
        # GCE TERMINATED means stopped-but-billing-disks, not deleted.
        client = FakeGcpClient()
        client.instances["rp-x"] = {"name": "rp-x", "status": "TERMINATED"}
        client.get_calls = -100  # keep the stored status
        backend = _backend(client)
        self.assertTrue(backend.is_alive(sandbox_id="rp-x"))

    def test_deleted_instance_is_gone(self) -> None:
        backend = _backend(FakeGcpClient())
        self.assertFalse(backend.is_alive(sandbox_id="rp-missing"))

    def test_terminate_treats_404_as_success(self) -> None:
        backend = _backend(FakeGcpClient())
        self.assertTrue(backend.terminate(sandbox_id="rp-missing"))

    def test_find_sandbox_id_returns_the_name(self) -> None:
        client = FakeGcpClient()
        client.instances["rp-uid123"] = {"name": "rp-uid123", "status": "RUNNING"}
        backend = _backend(client)
        self.assertEqual(
            backend.find_sandbox_id(experiment_id="exp_1", sandbox_uid="uid123"),
            "rp-uid123",
        )


class GcpCatalogTest(unittest.TestCase):
    def test_options_offer_only_current_gpu_machine_types(self) -> None:
        options = to_agent_options(MACHINE_TYPES, zone="us-central1-a")
        self.assertEqual(
            sorted(o["instance_type"] for o in options),
            ["a2-highgpu-1g", "g2-standard-8"],
        )
        by_name = {o["instance_type"]: o for o in options}
        self.assertEqual(by_name["a2-highgpu-1g"]["gpu"], "A100")
        self.assertEqual(by_name["g2-standard-8"]["memory_gib"], 32)
        self.assertIsNone(by_name["g2-standard-8"]["price_usd_per_hour"])

    def test_surface_and_catalog_conformance(self) -> None:
        descriptor = sandbox_driver_descriptor("gcp")
        backend = _backend(FakeGcpClient())
        assert_driver_surface(self, descriptor=descriptor, backend=backend)
        catalog = assert_catalog_envelope(self, descriptor=descriptor, backend=backend)
        self.assertIn("quota", catalog["reason"])


if __name__ == "__main__":
    unittest.main()
