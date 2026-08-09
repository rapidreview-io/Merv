# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""AWS EC2 Sandbox adapter."""

from __future__ import annotations

import shlex
import subprocess
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol
from ...kernel.env import env_value
from ..remote.bootstrap_tools import BASELINE_APT_PACKAGES, ML_PYTHON_PACKAGES
from ..remote.vm_bootstrap import MGMT_SSH_USER, build_bootstrap_core
from ..remote.vm_ssh import _run_ssh_process, ssh_command, stderr_detail
from ..sandbox_paths import DEFAULT_DATA_DIR, DEFAULT_REMOTE_ROOT, remote_root_of, remote_sessions_dir
from .base import (
    BackendCapabilities,
    BackendUnavailableError,
    BackendValidationError,
    CapacityUnavailableError,
    OnCreated,
    OnQuote,
    OnPhase,
    ProvisionedSandbox,
    SandboxRequest,
    SshInputRunner,
    SshRunner,
    VmSshSandboxBackend,
    _first_env,
    _float_or_none,
    _int_or_zero,
    _norm,
    _positive_int,
    _vm_name as _sandbox_name,
    find_option,
    price_sort_key,
)


# Configuration

DEFAULT_REGION = "us-east-1"
# The Deep Learning Base AMI ships NVIDIA drivers; plain Ubuntu AMIs boot GPU
# instances too but render the GPUs unusable without a manual driver install.
DEFAULT_IMAGE_NAME_PATTERN = (
    "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*"
)
DEFAULT_IMAGE_OWNER = "amazon"
DEFAULT_SSH_USER = "ubuntu"
DEFAULT_ROOT_VOLUME_GIB = 200
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0
# Instances the plugin created carry this tag; listings filter on it so the
# adapter never enumerates (or matches against) unrelated fleet in the account.
SANDBOX_TAG_KEY = "merv-sandbox"
SECURITY_GROUP_NAME = "merv-sandbox-ssh"


@dataclass(frozen=True)
class AwsCloudConfig:
    region: str
    access_key_id: str = ""
    secret_access_key: str = ""
    session_token: str = ""

    @classmethod
    def from_env(cls) -> "AwsCloudConfig":
        # Keys are optional on purpose: when absent, boto3's default chain
        # (shared credentials file, SSO cache, instance profile) still applies,
        # so a brain hosted inside AWS needs no long-lived secret at all.
        return cls(
            region=(
                _first_env("MERV_AWS_REGION", "AWS_REGION", "AWS_DEFAULT_REGION")
                or DEFAULT_REGION
            ),
            access_key_id=_first_env("MERV_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
            secret_access_key=_first_env(
                "MERV_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"
            ),
            session_token=_first_env("MERV_AWS_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
        )


@dataclass(frozen=True)
class AwsSandboxConfig:
    cloud: AwsCloudConfig
    image_id: str = ""
    instance_type: str = ""
    ssh_user: str = DEFAULT_SSH_USER
    root_volume_gib: int = DEFAULT_ROOT_VOLUME_GIB
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "AwsSandboxConfig":
        return cls(
            cloud=AwsCloudConfig.from_env(),
            image_id=(env_value("MERV_AWS_IMAGE_ID") or "").strip(),
            instance_type=(env_value("MERV_AWS_INSTANCE_TYPE") or "").strip(),
            ssh_user=(env_value("MERV_AWS_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
            root_volume_gib=_positive_int(
                env_value("MERV_AWS_VOLUME_GIB") or DEFAULT_ROOT_VOLUME_GIB,
                field="MERV_AWS_VOLUME_GIB",
            ),
        )


# Hardware catalog

def to_agent_options(
    instance_types: list[dict[str, Any]],
    *,
    offered: set[str] | None = None,
    region: str = "",
    gpu: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    gpu_filter = _norm(gpu)
    options: list[dict[str, Any]] = []
    for item in instance_types:
        name = str(item.get("InstanceType") or "")
        gpu_info = item.get("GpuInfo")
        if not name or not isinstance(gpu_info, dict):
            continue
        gpus = [g for g in gpu_info.get("Gpus", []) or [] if isinstance(g, dict)]
        if not gpus:
            continue
        model = str(gpus[0].get("Name") or "")
        manufacturer = str(gpus[0].get("Manufacturer") or "")
        count = sum(_int_or_zero(g.get("Count")) for g in gpus)
        available = offered is None or name in offered
        if only_available and not available:
            continue
        if gpu_filter and gpu_filter not in _norm(model) and gpu_filter not in _norm(name):
            continue
        vcpu_info = item.get("VCpuInfo") if isinstance(item.get("VCpuInfo"), dict) else {}
        memory_info = (
            item.get("MemoryInfo") if isinstance(item.get("MemoryInfo"), dict) else {}
        )
        options.append(
            {
                "instance_type": name,
                "gpu": model,
                "gpu_description": f"{count}x {manufacturer} {model}".strip(),
                "gpu_count": count,
                "vcpus": _int_or_zero(vcpu_info.get("DefaultVCpus")),
                "memory_gib": _int_or_zero(memory_info.get("SizeInMiB")) // 1024,
                # The root EBS volume is sized by the adapter, not the SKU.
                "storage_gib": 0,
                # EC2 exposes no price in the compute API; unknown stays None so
                # spend policy fails closed instead of billing "free" GPUs.
                "price_usd_per_hour": None,
                "regions": [region] if region else [],
                "available": available,
            }
        )
    options.sort(key=price_sort_key)
    return options


# Provider API client

# Provider codes that authoritatively mean "this resource does not exist".
_NOT_FOUND_ERROR_CODES = frozenset(
    {
        "InvalidInstanceID.NotFound",
        "InvalidInstanceID.Malformed",
        "InvalidKeyPair.NotFound",
        "InvalidGroup.NotFound",
    }
)
# Retryable lack of stock, distinct from bad requests and quota policy.
_CAPACITY_ERROR_CODES = frozenset(
    {"InsufficientInstanceCapacity", "Unsupported"}
)


def _load_boto3() -> Any:
    try:
        import boto3  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise BackendUnavailableError(
            "boto3 is required for the aws sandbox driver; "
            "pip install 'merv[aws]' (or boto3) on the brain host"
        ) from exc
    return boto3


class AwsEc2Client:
    """Thin, fake-able wrapper over the EC2 API via a lazily imported boto3."""

    def __init__(
        self, *, config: AwsCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or AwsCloudConfig.from_env()
        self.timeout = timeout
        self._ec2 = None

    @property
    def ec2(self) -> Any:
        if self._ec2 is None:
            boto3 = _load_boto3()
            credentials: dict[str, str] = {}
            if self.config.access_key_id and self.config.secret_access_key:
                credentials = {
                    "aws_access_key_id": self.config.access_key_id,
                    "aws_secret_access_key": self.config.secret_access_key,
                }
                if self.config.session_token:
                    credentials["aws_session_token"] = self.config.session_token
            self._ec2 = boto3.client(
                "ec2", region_name=self.config.region, **credentials
            )
        return self._ec2

    def _call(self, operation: str, **kwargs: Any) -> dict[str, Any]:
        from botocore.exceptions import BotoCoreError, ClientError  # type: ignore

        try:
            response = getattr(self.ec2, operation)(**kwargs)
        except ClientError as exc:
            error = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
            code = str(error.get("Code") or "")
            message = str(error.get("Message") or exc)
            if code in _CAPACITY_ERROR_CODES:
                raise CapacityUnavailableError(
                    f"AWS EC2 has no capacity for this request: {code}: {message}"
                ) from exc
            metadata = exc.response.get("ResponseMetadata", {})
            status = metadata.get("HTTPStatusCode")
            if code in _NOT_FOUND_ERROR_CODES:
                status = 404
            raise BackendUnavailableError(
                f"AWS EC2 {operation} failed: {code}: {message}",
                status=int(status) if status else None,
            ) from exc
        except BotoCoreError as exc:
            raise BackendUnavailableError(f"AWS EC2 is unreachable: {exc}") from exc
        return response if isinstance(response, dict) else {}

    def list_gpu_instance_types(self) -> list[dict[str, Any]]:
        """Every GPU-bearing SKU family the API can describe (paginated)."""
        items: list[dict[str, Any]] = []
        token = ""
        while True:
            kwargs: dict[str, Any] = {
                "Filters": [
                    # p* and g* are the NVIDIA/AMD GPU families; everything else
                    # (inf/trn accelerators, CPU fleets) stays out of the menu.
                    {"Name": "instance-type", "Values": ["p*", "g*"]},
                    {"Name": "supported-usage-class", "Values": ["on-demand"]},
                ],
                "MaxResults": 100,
            }
            if token:
                kwargs["NextToken"] = token
            data = self._call("describe_instance_types", **kwargs)
            items.extend(
                item for item in data.get("InstanceTypes", []) if isinstance(item, dict)
            )
            token = str(data.get("NextToken") or "")
            if not token:
                return items

    def list_offered_instance_types(self) -> set[str]:
        """SKUs actually offered in the configured region."""
        offered: set[str] = set()
        token = ""
        while True:
            kwargs: dict[str, Any] = {
                "LocationType": "region",
                "Filters": [
                    {"Name": "instance-type", "Values": ["p*", "g*"]},
                    {"Name": "location", "Values": [self.config.region]},
                ],
                "MaxResults": 1000,
            }
            if token:
                kwargs["NextToken"] = token
            data = self._call("describe_instance_type_offerings", **kwargs)
            offered.update(
                str(item.get("InstanceType") or "")
                for item in data.get("InstanceTypeOfferings", [])
                if isinstance(item, dict)
            )
            token = str(data.get("NextToken") or "")
            if not token:
                return offered

    def resolve_image_id(self) -> str:
        data = self._call(
            "describe_images",
            Owners=[DEFAULT_IMAGE_OWNER],
            Filters=[
                {"Name": "name", "Values": [DEFAULT_IMAGE_NAME_PATTERN]},
                {"Name": "state", "Values": ["available"]},
                {"Name": "architecture", "Values": ["x86_64"]},
            ],
        )
        images = [item for item in data.get("Images", []) if isinstance(item, dict)]
        if not images:
            raise BackendUnavailableError(
                "no Deep Learning Base GPU AMI is visible in "
                f"{self.config.region}; set MERV_AWS_IMAGE_ID explicitly"
            )
        newest = max(images, key=lambda item: str(item.get("CreationDate") or ""))
        return str(newest.get("ImageId") or "")

    def import_key_pair(self, *, name: str, public_key: str) -> None:
        self._call(
            "import_key_pair",
            KeyName=name,
            PublicKeyMaterial=public_key.encode("utf-8"),
        )

    def delete_key_pair(self, *, name: str) -> None:
        self._call("delete_key_pair", KeyName=name)

    def ensure_security_group(self) -> str:
        """Find-or-create the shared SSH-only ingress group."""
        data = self._call(
            "describe_security_groups",
            Filters=[{"Name": "group-name", "Values": [SECURITY_GROUP_NAME]}],
        )
        groups = data.get("SecurityGroups", [])
        if groups and isinstance(groups[0], dict) and groups[0].get("GroupId"):
            return str(groups[0]["GroupId"])
        created = self._call(
            "create_security_group",
            GroupName=SECURITY_GROUP_NAME,
            Description="merv sandbox: inbound SSH only",
        )
        group_id = str(created.get("GroupId") or "")
        if not group_id:
            raise BackendUnavailableError("AWS created a security group without an id")
        try:
            self._call(
                "authorize_security_group_ingress",
                GroupId=group_id,
                IpPermissions=[
                    {
                        "IpProtocol": "tcp",
                        "FromPort": 22,
                        "ToPort": 22,
                        "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
                    }
                ],
            )
        except BackendUnavailableError as exc:
            # A concurrent acquire may have authorized the same rule already.
            if "Duplicate" not in str(exc):
                raise
        return group_id

    def run_instance(
        self,
        *,
        name: str,
        instance_type: str,
        image_id: str,
        key_name: str,
        security_group_id: str,
        root_volume_gib: int,
    ) -> dict[str, Any]:
        data = self._call(
            "run_instances",
            MinCount=1,
            MaxCount=1,
            InstanceType=instance_type,
            ImageId=image_id,
            KeyName=key_name,
            SecurityGroupIds=[security_group_id],
            BlockDeviceMappings=[
                {
                    "DeviceName": "/dev/sda1",
                    "Ebs": {
                        "VolumeSize": int(root_volume_gib),
                        "VolumeType": "gp3",
                        "DeleteOnTermination": True,
                    },
                }
            ],
            TagSpecifications=[
                {
                    "ResourceType": "instance",
                    "Tags": [
                        {"Key": "Name", "Value": name},
                        {"Key": SANDBOX_TAG_KEY, "Value": "1"},
                    ],
                }
            ],
        )
        instances = data.get("Instances", [])
        if not instances or not isinstance(instances[0], dict) or not instances[0].get(
            "InstanceId"
        ):
            raise BackendUnavailableError("AWS run_instances returned no instance")
        return instances[0]

    def describe_instance(self, instance_id: str) -> dict[str, Any]:
        data = self._call("describe_instances", InstanceIds=[instance_id])
        for reservation in data.get("Reservations", []) or []:
            for instance in reservation.get("Instances", []) or []:
                if isinstance(instance, dict):
                    return instance
        raise BackendUnavailableError(
            f"AWS instance not found: {instance_id}", status=404
        )

    def list_instances(self) -> list[dict[str, Any]]:
        data = self._call(
            "describe_instances",
            Filters=[{"Name": "tag-key", "Values": [SANDBOX_TAG_KEY]}],
        )
        instances: list[dict[str, Any]] = []
        for reservation in data.get("Reservations", []) or []:
            instances.extend(
                instance
                for instance in reservation.get("Instances", []) or []
                if isinstance(instance, dict)
            )
        return instances

    def terminate_instance(self, instance_id: str) -> None:
        self._call("terminate_instances", InstanceIds=[instance_id])


# Sandbox adapter

BOOTSTRAP_SSH_TIMEOUT_SECONDS = 900
ACTIVE_INSTANCE_STATUSES = frozenset({"running"})
# "stopped" instances still bill their EBS volumes; only these are provably done.
TERMINAL_INSTANCE_STATUSES = frozenset({"shutting-down", "terminated"})

AWS_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)


class BootstrapProcessRunner(Protocol):
    """Runs the bootstrap script through an SSH subprocess."""

    def __call__(
        self, command: list[str], script: str, timeout: int
    ) -> "subprocess.CompletedProcess[str]": ...


class AwsSandboxBackend(VmSshSandboxBackend):
    resource_label = "AWS EC2 instance"
    ready_statuses = ACTIVE_INSTANCE_STATUSES
    terminal_statuses = TERMINAL_INSTANCE_STATUSES
    capabilities = BackendCapabilities(
        name="aws",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: AwsSandboxConfig | None = None,
        client: AwsEc2Client | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
        bootstrap_runner: BootstrapProcessRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client
        self._bootstrap_runner = bootstrap_runner or _run_bootstrap

    @property
    def config(self) -> AwsSandboxConfig:
        return self._lazy_provider_config(AwsSandboxConfig.from_env)

    @property
    def client(self) -> AwsEc2Client:
        return self._lazy_provider_client(AwsEc2Client)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        instance_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        key_name = f"{instance_name}-key"
        instance_type = (request.instance_type or self.config.instance_type or "").strip()
        if not instance_type:
            raise BackendValidationError(
                "AWS requires an instance_type (a GPU EC2 SKU, e.g. g5.xlarge). "
                "Call sandbox.options, or sandbox.request without an "
                "instance_type, to see the offered GPU SKUs, then pick one."
            )
        if not request.management_public_key or not request.management_key_path:
            raise BackendValidationError("AWS requires a management SSH key")
        self._notify(on_phase, "checking_capacity", instance_type)
        option = self._resolve_option(
            instance_type=instance_type, requested_gpu=request.gpu
        )
        image_id = self.config.image_id or self.client.resolve_image_id()

        instance_id = ""
        try:
            self._notify(on_phase, "registering_ssh_key", key_name)
            self._ensure_key_pair(
                name=key_name, public_key=request.management_public_key
            )
            security_group_id = self.client.ensure_security_group()

            self._notify(on_phase, "creating", f"{instance_type} in {self.client.config.region}")
            instance = self.client.run_instance(
                name=instance_name,
                instance_type=instance_type,
                image_id=image_id,
                key_name=key_name,
                security_group_id=security_group_id,
                root_volume_gib=self.config.root_volume_gib,
            )
            instance_id = str(instance["InstanceId"])
            self._notify(on_created, instance_id, instance_name)

            self._notify(on_phase, "connecting", "waiting for running instance and ssh")
            instance = self._wait_for_vm(sandbox_id=instance_id)
            ip = str(instance.get("PublicIpAddress") or "")
            if not ip:
                raise BackendUnavailableError(
                    "AWS instance became running without a public IPv4; the "
                    "default subnet may have auto-assign public IP disabled"
                )
            self._wait_for_ssh(host=ip)

            # EC2 user_data caps at 16 KiB and our bootstrap brushes against
            # it, so the bootstrap is pushed over SSH instead (Thunder-style).
            workdir = self._sandbox_workdir(request)
            self._notify(on_phase, "bootstrapping", "installing sandbox ssh wrapper")
            self._bootstrap_vm(
                host=ip, request=request, workdir=workdir, on_phase=on_phase
            )
            return ProvisionedSandbox(
                sandbox_id=instance_id,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=instance_type,
                region=self.client.config.region,
                # Tri-state: an unpriced catalog option must stay None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if instance_id:
                with suppress(Exception):
                    self.client.terminate_instance(instance_id)
            with suppress(Exception):
                self.client.delete_key_pair(name=key_name)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.describe_instance(sandbox_id)

    def _resource_status(self, resource: Mapping[str, Any]) -> str:
        state = resource.get("State")
        return str(state.get("Name") or "") if isinstance(state, Mapping) else ""

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(resource.get("PublicIpAddress"))

    def terminate(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        key_name = self._key_name_for_instance(sandbox_id=sandbox_id)
        if not self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.terminate_instance
        ):
            return False
        if key_name:
            with suppress(Exception):
                self.client.delete_key_pair(name=key_name)
        return True

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_offered_instance_types())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        name = _sandbox_name(sandbox_uid or experiment_id)
        for instance in self.client.list_instances():
            if _name_tag(instance) == name and self._status_is_live(
                self._resource_status(instance)
            ):
                found = str(instance.get("InstanceId") or "")
                if found:
                    return found
        return None

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """GPU EC2 SKUs offered in the configured region."""
        configured = self.client.config.region
        if region and _norm(region) != _norm(configured):
            options: list[dict[str, Any]] = []
        else:
            options = to_agent_options(
                self.client.list_gpu_instance_types(),
                offered=self.client.list_offered_instance_types(),
                region=configured,
                gpu=gpu,
                only_available=True,
            )
        return self._selection_catalog(
            reason=(
                "AWS EC2 sells fixed GPU SKUs (g*/p* families); pick one "
                f"instance_type. This deployment provisions in {configured} "
                "(MERV_AWS_REGION). Prices are not exposed by the EC2 API and "
                "stay unknown. Fresh accounts have a zero vCPU quota for "
                "G/P families — request a quota increase once in the AWS "
                "console under Service Quotas > Amazon EC2."
            ),
            regions=[configured],
            options=options,
        )

    def _resolve_option(
        self, *, instance_type: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        options = to_agent_options(
            self.client.list_gpu_instance_types(),
            offered=self.client.list_offered_instance_types(),
            region=self.client.config.region,
            only_available=False,
        )
        option = find_option(options, instance_type=instance_type)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise BackendValidationError(
                f"AWS GPU instance type is not describable: {instance_type}. "
                f"GPU SKUs: {offered}."
            )
        if not option.get("available"):
            raise CapacityUnavailableError(
                f"AWS instance type {instance_type} is not offered in "
                f"{self.client.config.region}. Call sandbox.options for the "
                "SKUs this region serves."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match AWS instance type "
                f"{instance_type} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        return option

    def _ensure_key_pair(self, *, name: str, public_key: str) -> None:
        """Import the key; a same-named leftover from a failed run is replaced."""
        try:
            self.client.import_key_pair(name=name, public_key=public_key)
        except BackendUnavailableError as exc:
            if "Duplicate" not in str(exc):
                raise
            self.client.delete_key_pair(name=name)
            self.client.import_key_pair(name=name, public_key=public_key)

    def _key_name_for_instance(self, *, sandbox_id: str) -> str:
        """The rp-named key registered for this instance, resolved by tag."""
        try:
            instance = self.client.describe_instance(sandbox_id)
        except Exception:  # noqa: BLE001
            return ""
        name = _name_tag(instance)
        return f"{name}-key" if name.startswith("rp-") else ""

    def _bootstrap_vm(
        self,
        *,
        host: str,
        request: SandboxRequest,
        workdir: str,
        on_phase: OnPhase | None = None,
    ) -> None:
        script = build_aws_bootstrap_script(
            public_key=request.public_key,
            management_public_key=request.management_public_key,
            experiment_id=request.experiment_id,
            workdir=workdir,
            sessions_dir=remote_sessions_dir(
                experiment_id=request.experiment_id, root=remote_root_of(workdir)
            ),
            sandbox_data_dir=self.config.sandbox_data_dir,
        )
        command = ssh_command(
            host=host,
            port=22,
            user=self.config.ssh_user,
            key_path=request.management_key_path,
            remote_command="sudo -n bash -s",
        )
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        last_error = ""
        while time.monotonic() < deadline:
            self._notify(on_phase, "bootstrapping", "running bootstrap over ssh")
            try:
                result = self._bootstrap_runner(
                    command, script, BOOTSTRAP_SSH_TIMEOUT_SECONDS
                )
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
            else:
                if result.returncode == 0:
                    self._wait_for_management_ssh(
                        host=host,
                        key_path=request.management_key_path,
                        on_phase=on_phase,
                    )
                    return
                last_error = stderr_detail(result)
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(f"AWS VM bootstrap failed: {last_error}")

    def _wait_for_management_ssh(
        self, *, host: str, key_path: str, on_phase: OnPhase | None = None
    ) -> None:
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        last_error = ""
        while time.monotonic() < deadline:
            self._notify(on_phase, "bootstrapping", "waiting for management ssh")
            result = self._ssh_runner(
                ssh_command(
                    host=host,
                    port=22,
                    user=MGMT_SSH_USER,
                    key_path=key_path,
                    remote_command="test -x /opt/merv/rec.sh && true",
                )
            )
            if result.returncode == 0:
                return
            last_error = stderr_detail(result)
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(
            f"AWS management SSH never became ready: {last_error}"
        )


def build_aws_bootstrap_script(
    *,
    public_key: str,
    management_public_key: str,
    experiment_id: str,
    workdir: str,
    sessions_dir: str,
    sandbox_data_dir: str,
) -> str:
    apt_packages = " ".join(shlex.quote(pkg) for pkg in AWS_APT_PACKAGES)
    python_packages = " ".join(shlex.quote(pkg) for pkg in ML_PYTHON_PACKAGES)
    bootstrap_core = build_bootstrap_core(
        public_key=public_key,
        experiment_id=experiment_id,
        workdir=workdir,
        sessions_dir=sessions_dir,
        sandbox_data_dir=sandbox_data_dir,
        management_public_key=management_public_key,
        sshd_apply_command="systemctl reload ssh || systemctl reload sshd || service ssh reload || true",
    )
    return f"""#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

{bootstrap_core}
apt-get update
apt-get install -y --no-install-recommends {apt_packages}
ln -sf /usr/bin/fdfind /usr/local/bin/fd || true
python3 -m pip install --break-system-packages --upgrade pip uv || python3 -m pip install --user --upgrade pip uv || true
if [ -x /root/.local/bin/uv ]; then
  install -m 0755 /root/.local/bin/uv /usr/local/bin/uv
fi
install_with_uv_or_pip() {{
  if command -v uv >/dev/null 2>&1; then
    uv pip install --system "$@" || python3 -m pip install --break-system-packages "$@"
  else
    python3 -m pip install --break-system-packages "$@"
  fi
}}
install_with_uv_or_pip {python_packages} || true
"""


def _name_tag(instance: Mapping[str, Any]) -> str:
    for tag in instance.get("Tags", []) or []:
        if isinstance(tag, Mapping) and str(tag.get("Key") or "") == "Name":
            return str(tag.get("Value") or "")
    return ""


def _run_bootstrap(
    command: list[str], script: str, timeout: int
) -> subprocess.CompletedProcess[str]:
    return _run_ssh_process(command, stdin=script, timeout=timeout)


def build_aws_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> AwsSandboxBackend:
    # Lazy: credentials (or the boto3 default chain) resolve at call time.
    return AwsSandboxBackend()
