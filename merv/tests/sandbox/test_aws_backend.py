"""AWS EC2 backend: acquire flow, SSH-pushed bootstrap, liveness, GPU catalog."""

from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from tests.sandbox.driver_conformance import (
    assert_catalog_envelope,
    assert_driver_surface,
)
from merv.brain.sandbox.adapters import sandbox_driver_descriptor
from merv.brain.sandbox.adapters.aws import (
    AwsCloudConfig,
    AwsEc2Client,
    AwsSandboxBackend,
    AwsSandboxConfig,
    to_agent_options,
)
from merv.brain.sandbox.models import (
    BackendUnavailableError,
    BackendValidationError,
    CapacityUnavailableError,
    SandboxRequest,
)


INSTANCE_TYPES = [
    {
        "InstanceType": "g5.xlarge",
        "GpuInfo": {
            "Gpus": [{"Name": "A10G", "Manufacturer": "NVIDIA", "Count": 1}]
        },
        "VCpuInfo": {"DefaultVCpus": 4},
        "MemoryInfo": {"SizeInMiB": 16384},
    },
    {
        "InstanceType": "p4d.24xlarge",
        "GpuInfo": {
            "Gpus": [{"Name": "A100", "Manufacturer": "NVIDIA", "Count": 8}]
        },
        "VCpuInfo": {"DefaultVCpus": 96},
        "MemoryInfo": {"SizeInMiB": 1179648},
    },
    {
        # No GpuInfo: CPU SKU that slipped through the family filter.
        "InstanceType": "g5g-metal-lookalike",
        "VCpuInfo": {"DefaultVCpus": 64},
        "MemoryInfo": {"SizeInMiB": 131072},
    },
]
OFFERED = {"g5.xlarge"}


class FakeAwsClient:
    def __init__(self) -> None:
        self.config = AwsCloudConfig(region="us-east-1")
        self.keys_imported: list[dict] = []
        self.keys_deleted: list[str] = []
        self.instances_created: list[dict] = []
        self.instances_terminated: list[str] = []
        self.instances: dict[str, dict] = {}
        self.describe_calls = 0
        self.duplicate_key = False
        self.security_group_ensured = 0

    def list_gpu_instance_types(self):
        return INSTANCE_TYPES

    def list_offered_instance_types(self):
        return set(OFFERED)

    def resolve_image_id(self):
        return "ami-0deadbeef"

    def import_key_pair(self, *, name, public_key):
        if self.duplicate_key and name not in self.keys_deleted:
            raise BackendUnavailableError(
                "InvalidKeyPair.Duplicate: keypair already exists"
            )
        self.keys_imported.append({"name": name, "public_key": public_key})

    def delete_key_pair(self, *, name):
        self.keys_deleted.append(name)

    def ensure_security_group(self):
        self.security_group_ensured += 1
        return "sg-123"

    def run_instance(self, **kwargs):
        self.instances_created.append(kwargs)
        instance = {
            "InstanceId": "i-0abc",
            "State": {"Name": "pending"},
            "Tags": [
                {"Key": "Name", "Value": kwargs["name"]},
                {"Key": "merv-sandbox", "Value": "1"},
            ],
        }
        self.instances["i-0abc"] = instance
        return instance

    def describe_instance(self, instance_id):
        instance = self.instances.get(str(instance_id))
        if instance is None:
            raise BackendUnavailableError("not found", status=404)
        self.describe_calls += 1
        if self.describe_calls >= 2:
            instance = {
                **instance,
                "State": {"Name": "running"},
                "PublicIpAddress": "34.201.10.20",
            }
        return instance

    def list_instances(self):
        return list(self.instances.values())

    def terminate_instance(self, instance_id):
        self.instances_terminated.append(str(instance_id))
        self.instances.pop(str(instance_id), None)


def _backend(client: FakeAwsClient) -> AwsSandboxBackend:
    config = AwsSandboxConfig(
        cloud=client.config,
        poll_timeout_seconds=5,
        poll_interval_seconds=0.001,
    )
    ok = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
    return AwsSandboxBackend(
        config=config,
        client=client,  # type: ignore[arg-type]
        ssh_runner=lambda command: ok,
        ssh_input_runner=lambda command, stdin: ok,
        bootstrap_runner=lambda command, script, timeout: ok,
    )


def _request(**overrides) -> SandboxRequest:
    fields = {
        "experiment_id": "exp_1",
        "project_id": "proj_1",
        "public_key": "ssh-ed25519 AAAA caller",
        "sandbox_uid": "uid123",
        "management_public_key": "ssh-ed25519 BBBB mgmt",
        "management_key_path": "/keys/mgmt",
        "instance_type": "g5.xlarge",
    }
    fields.update(overrides)
    return SandboxRequest(**fields)


class AwsAcquireTest(unittest.TestCase):
    def test_acquire_bootstraps_over_ssh_with_management_key(self) -> None:
        client = FakeAwsClient()
        backend = _backend(client)
        with patch.object(AwsSandboxBackend, "_wait_for_ssh"):
            provisioned = backend.acquire(request=_request())

        self.assertEqual(provisioned.sandbox_id, "i-0abc")
        self.assertEqual(provisioned.ssh_host, "34.201.10.20")
        self.assertEqual(provisioned.ssh_user, "ubuntu")
        self.assertEqual(provisioned.region, "us-east-1")
        self.assertEqual(provisioned.gpu, "A10G")
        # EC2 quotes no price: the tri-state None must survive to storage as
        # price_known=0, never a coerced "known" $0.00/hr the caps skip.
        self.assertIsNone(provisioned.price_usd_per_hour)
        # The create key is the management key; the caller key arrives via the
        # SSH-pushed bootstrap (EC2 user_data is too small for it).
        self.assertEqual(client.keys_imported[0]["public_key"], "ssh-ed25519 BBBB mgmt")
        created = client.instances_created[0]
        self.assertEqual(created["image_id"], "ami-0deadbeef")
        self.assertEqual(created["security_group_id"], "sg-123")
        self.assertEqual(client.security_group_ensured, 1)

    def test_acquire_requires_management_key(self) -> None:
        backend = _backend(FakeAwsClient())
        with self.assertRaisesRegex(BackendValidationError, "management"):
            backend.acquire(request=_request(management_public_key=""))

    def test_acquire_requires_instance_type(self) -> None:
        backend = _backend(FakeAwsClient())
        with self.assertRaisesRegex(BackendValidationError, "instance_type"):
            backend.acquire(request=_request(instance_type=""))

    def test_acquire_unoffered_type_raises_capacity_error(self) -> None:
        backend = _backend(FakeAwsClient())
        with self.assertRaises(CapacityUnavailableError):
            backend.acquire(request=_request(instance_type="p4d.24xlarge"))

    def test_acquire_replaces_leftover_duplicate_key(self) -> None:
        client = FakeAwsClient()
        client.duplicate_key = True
        backend = _backend(client)
        with patch.object(AwsSandboxBackend, "_wait_for_ssh"):
            backend.acquire(request=_request())
        self.assertEqual(client.keys_deleted, ["rp-uid123-key"])
        self.assertEqual(len(client.keys_imported), 1)

    def test_acquire_failure_terminates_instance_and_key(self) -> None:
        client = FakeAwsClient()
        backend = _backend(client)
        with patch.object(
            AwsSandboxBackend,
            "_wait_for_vm",
            side_effect=BackendUnavailableError("boom"),
        ):
            with self.assertRaises(BackendUnavailableError):
                backend.acquire(request=_request())

        self.assertEqual(client.instances_terminated, ["i-0abc"])
        self.assertIn("rp-uid123-key", client.keys_deleted)


class AwsLifecycleTest(unittest.TestCase):
    def test_stopped_instance_still_counts_as_alive(self) -> None:
        # Stopped instances keep billing their EBS volumes.
        client = FakeAwsClient()
        client.instances["i-1"] = {"InstanceId": "i-1", "State": {"Name": "stopped"}}
        client.describe_calls = -100  # keep the stored state
        backend = _backend(client)
        self.assertTrue(backend.is_alive(sandbox_id="i-1"))

    def test_terminated_instance_is_gone(self) -> None:
        client = FakeAwsClient()
        client.instances["i-1"] = {"InstanceId": "i-1", "State": {"Name": "terminated"}}
        client.describe_calls = -100
        backend = _backend(client)
        self.assertFalse(backend.is_alive(sandbox_id="i-1"))

    def test_terminate_removes_instance_and_its_named_key(self) -> None:
        client = FakeAwsClient()
        client.instances["i-1"] = {
            "InstanceId": "i-1",
            "State": {"Name": "running"},
            "Tags": [{"Key": "Name", "Value": "rp-uid123"}],
        }
        client.describe_calls = -100
        backend = _backend(client)
        self.assertTrue(backend.terminate(sandbox_id="i-1"))
        self.assertEqual(client.instances_terminated, ["i-1"])
        self.assertEqual(client.keys_deleted, ["rp-uid123-key"])

    def test_find_sandbox_id_matches_the_name_tag(self) -> None:
        client = FakeAwsClient()
        client.instances["i-9"] = {
            "InstanceId": "i-9",
            "State": {"Name": "running"},
            "Tags": [{"Key": "Name", "Value": "rp-uid123"}],
        }
        backend = _backend(client)
        self.assertEqual(
            backend.find_sandbox_id(experiment_id="exp_1", sandbox_uid="uid123"),
            "i-9",
        )


class AwsCatalogTest(unittest.TestCase):
    def test_options_offer_only_gpu_skus_offered_in_region(self) -> None:
        options = to_agent_options(
            INSTANCE_TYPES, offered=OFFERED, region="us-east-1"
        )
        self.assertEqual([o["instance_type"] for o in options], ["g5.xlarge"])
        option = options[0]
        self.assertEqual(option["gpu"], "A10G")
        self.assertEqual(option["vcpus"], 4)
        self.assertEqual(option["memory_gib"], 16)
        self.assertIsNone(option["price_usd_per_hour"])  # EC2 exposes no price

    def test_surface_and_catalog_conformance(self) -> None:
        descriptor = sandbox_driver_descriptor("aws")
        backend = _backend(FakeAwsClient())
        assert_driver_surface(self, descriptor=descriptor, backend=backend)
        catalog = assert_catalog_envelope(self, descriptor=descriptor, backend=backend)
        self.assertIn("quota", catalog["reason"])

    def test_client_lazily_requires_boto3_only_at_call_time(self) -> None:
        # Construction must not import boto3; only touching .ec2 needs it.
        client = AwsEc2Client(config=AwsCloudConfig(region="us-east-1"))
        self.assertEqual(client.config.region, "us-east-1")


if __name__ == "__main__":
    unittest.main()
