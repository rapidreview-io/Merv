# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""GCP Compute Engine Sandbox adapter."""

from __future__ import annotations

import time
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from ...kernel.env import env_value
from ..remote.bootstrap_tools import BASELINE_APT_PACKAGES
from ..sandbox_paths import DEFAULT_DATA_DIR, DEFAULT_REMOTE_ROOT
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
    _http_base_url,
    _int_or_zero,
    _norm,
    _positive_int,
    _vm_name as _sandbox_name,
    bearer_json_headers,
    find_option,
    price_sort_key,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://compute.googleapis.com/compute/v1"
DEFAULT_ZONE = "us-central1-a"
# The Deep Learning VM Ubuntu family ships CUDA and (with the metadata flag
# below) auto-installs the NVIDIA driver on first boot; plain Ubuntu images
# boot GPU machine types with the GPUs unusable.
DEFAULT_IMAGE_PROJECT = "deeplearning-platform-release"
DEFAULT_IMAGE_FAMILY = "common-cu123-ubuntu-2204-py310"
DEFAULT_SSH_USER = "root"
DEFAULT_BOOT_DISK_GIB = 200
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0
# Instances carry this network tag; the shared firewall rule targets it so
# port 22 opens only for sandboxes, and listings can filter on the same tag.
SANDBOX_NETWORK_TAG = "merv-sandbox"
FIREWALL_RULE_NAME = "merv-sandbox-allow-ssh"

AUTH_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)


@dataclass(frozen=True)
class GcpCloudConfig:
    project: str
    zone: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "GcpCloudConfig":
        project = _first_env(
            "MERV_GCP_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT"
        )
        if not project:
            raise BackendValidationError(
                "GCP project id is required; set MERV_GCP_PROJECT (or "
                "GOOGLE_CLOUD_PROJECT). Credentials come from "
                "GOOGLE_APPLICATION_CREDENTIALS or the ambient service account."
            )
        return cls(
            project=project,
            zone=_first_env("MERV_GCP_ZONE") or DEFAULT_ZONE,
            base_url=_http_base_url("MERV_GCP_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class GcpSandboxConfig:
    cloud: GcpCloudConfig
    machine_type: str = ""
    image_project: str = DEFAULT_IMAGE_PROJECT
    image_family: str = DEFAULT_IMAGE_FAMILY
    ssh_user: str = DEFAULT_SSH_USER
    boot_disk_gib: int = DEFAULT_BOOT_DISK_GIB
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "GcpSandboxConfig":
        return cls(
            cloud=GcpCloudConfig.from_env(),
            machine_type=(env_value("MERV_GCP_MACHINE_TYPE") or "").strip(),
            image_project=(
                env_value("MERV_GCP_IMAGE_PROJECT") or DEFAULT_IMAGE_PROJECT
            ).strip(),
            image_family=(
                env_value("MERV_GCP_IMAGE_FAMILY") or DEFAULT_IMAGE_FAMILY
            ).strip(),
            ssh_user=(env_value("MERV_GCP_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
            boot_disk_gib=_positive_int(
                env_value("MERV_GCP_BOOT_DISK_GIB") or DEFAULT_BOOT_DISK_GIB,
                field="MERV_GCP_BOOT_DISK_GIB",
            ),
        )


# Hardware catalog

def to_agent_options(
    machine_types: list[dict[str, Any]],
    *,
    zone: str = "",
    gpu: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    """GPU-bundled machine types (a2/a3/g2); N1+attach shapes are not composed."""
    _ = only_available  # a listed, undeprecated machine type is requestable
    gpu_filter = _norm(gpu)
    options: list[dict[str, Any]] = []
    for item in machine_types:
        name = str(item.get("name") or "")
        accelerators = [
            a for a in item.get("accelerators", []) or [] if isinstance(a, dict)
        ]
        if not name or not accelerators:
            continue
        if isinstance(item.get("deprecated"), dict):
            continue
        model = _gpu_label(str(accelerators[0].get("guestAcceleratorType") or ""))
        count = sum(
            _int_or_zero(a.get("guestAcceleratorCount")) for a in accelerators
        )
        if gpu_filter and gpu_filter not in _norm(model) and gpu_filter not in _norm(name):
            continue
        options.append(
            {
                "instance_type": name,
                "gpu": model,
                "gpu_description": f"{count}x {model}".strip(),
                "gpu_count": count,
                "vcpus": _int_or_zero(item.get("guestCpus")),
                "memory_gib": _int_or_zero(item.get("memoryMb")) // 1024,
                # The boot disk is sized by the adapter, not the machine type.
                "storage_gib": 0,
                # Compute API exposes no price; unknown stays None so spend
                # policy fails closed instead of billing "free" GPUs.
                "price_usd_per_hour": None,
                "regions": [zone] if zone else [],
                "available": True,
            }
        )
    options.sort(key=price_sort_key)
    return options


def _gpu_label(accelerator_type: str) -> str:
    """Short GPU label, e.g. 'A100' from 'nvidia-tesla-a100' or 'nvidia-l4'."""
    tail = accelerator_type.rsplit("/", 1)[-1]
    for prefix in ("nvidia-tesla-", "nvidia-"):
        if tail.startswith(prefix):
            return tail[len(prefix):].upper().replace("-", " ")
    return tail.upper()


# Provider API client

# Refresh this many seconds before the token's stated expiry.
TOKEN_EXPIRY_SLACK_SECONDS = 60.0


def _load_google_auth() -> Any:
    try:
        import google.auth  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise BackendUnavailableError(
            "google-auth is required for the gcp sandbox driver; "
            "pip install 'merv[gcp]' (or google-auth + requests) on the brain host"
        ) from exc
    return google.auth


class GcpClient:
    """Compute Engine REST client; google-auth mints tokens, urllib carries them."""

    def __init__(
        self, *, config: GcpCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or GcpCloudConfig.from_env()
        self.timeout = timeout
        self._credentials = None
        self._token = ""
        self._token_expires_at = 0.0

    def list_machine_types(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        token = ""
        while True:
            path = f"/zones/{self.config.zone}/machineTypes?maxResults=500"
            if token:
                path += f"&pageToken={token}"
            data = self._request("GET", path)
            items.extend(
                item for item in data.get("items", []) or [] if isinstance(item, dict)
            )
            token = str(data.get("nextPageToken") or "")
            if not token:
                return items

    def get_instance(self, name: str) -> dict[str, Any]:
        return self._request(
            "GET", f"/zones/{self.config.zone}/instances/{name}"
        )

    def list_instances(self) -> list[dict[str, Any]]:
        data = self._request(
            "GET",
            f"/zones/{self.config.zone}/instances"
            f"?filter=labels.{SANDBOX_NETWORK_TAG.replace('-', '_')}=1",
        )
        return [
            item for item in data.get("items", []) or [] if isinstance(item, dict)
        ]

    def insert_instance(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._request(
            "POST", f"/zones/{self.config.zone}/instances", body=body
        )

    def delete_instance(self, name: str) -> None:
        self._request("DELETE", f"/zones/{self.config.zone}/instances/{name}")

    def get_firewall(self, name: str) -> dict[str, Any]:
        return self._request("GET", f"/global/firewalls/{name}")

    def insert_firewall(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/global/firewalls", body=body)

    # ---------- auth ----------

    def _bearer_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        google_auth = _load_google_auth()
        if self._credentials is None:
            # Honors GOOGLE_APPLICATION_CREDENTIALS, gcloud ADC, and the GCE
            # metadata service, in that order — the user picks by environment.
            self._credentials, _project = google_auth.default(scopes=list(AUTH_SCOPES))
        try:
            from google.auth.transport.requests import Request  # type: ignore

            self._credentials.refresh(Request())
        except Exception as exc:  # noqa: BLE001
            raise BackendUnavailableError(
                f"GCP token refresh failed: {exc}"
            ) from exc
        self._token = str(self._credentials.token or "")
        if not self._token:
            raise BackendUnavailableError("GCP auth returned no access token")
        expiry = getattr(self._credentials, "expiry", None)
        lifetime = 300.0
        if expiry is not None:
            with suppress(Exception):
                lifetime = max(expiry.timestamp() - time.time(), 30.0)
        self._token_expires_at = time.monotonic() + max(
            lifetime - TOKEN_EXPIRY_SLACK_SECONDS, 30.0
        )
        return self._token

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return request_json(
            provider="GCP",
            method=method,
            base_url=f"{self.config.base_url}/projects/{self.config.project}",
            path=path,
            body=body,
            headers=bearer_json_headers(self._bearer_token(), "merv/0.0014"),
            timeout=self.timeout,
            require_object=True,
        )


# Sandbox adapter

ACTIVE_INSTANCE_STATUSES = frozenset({"RUNNING"})
# GCE "TERMINATED" means stopped-but-billing-disks; only a 404 is gone. The
# wait loop still treats it as a failed boot.
FAILED_BOOT_STATUSES = frozenset({"TERMINATED", "SUSPENDED"})

GCP_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)


class GcpSandboxBackend(VmSshSandboxBackend):
    resource_label = "GCP instance"
    ready_statuses = ACTIVE_INSTANCE_STATUSES
    terminal_statuses = FAILED_BOOT_STATUSES
    capabilities = BackendCapabilities(
        name="gcp",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: GcpSandboxConfig | None = None,
        client: GcpClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> GcpSandboxConfig:
        return self._lazy_provider_config(GcpSandboxConfig.from_env)

    @property
    def client(self) -> GcpClient:
        return self._lazy_provider_client(GcpClient)

    def _status_is_live(self, status: str) -> bool:
        """Every fetchable instance holds billable disks; only a 404 is gone."""
        _ = status
        return True

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        instance_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        machine_type = (
            request.instance_type or self.config.machine_type or ""
        ).strip()
        if not machine_type:
            raise BackendValidationError(
                "GCP requires an instance_type (a GPU machine type, e.g. "
                "g2-standard-8 or a2-highgpu-1g). Call sandbox.options, or "
                "sandbox.request without an instance_type, to see the zone's "
                "GPU machine types, then pick one."
            )
        self._notify(on_phase, "checking_capacity", machine_type)
        option = self._resolve_option(
            machine_type=machine_type, requested_gpu=request.gpu
        )

        created = False
        try:
            self._ensure_firewall_rule()

            zone = self.client.config.zone
            self._notify(on_phase, "creating", f"{machine_type} in {zone}")
            workdir = self._sandbox_workdir(request)
            user_data = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=GCP_APT_PACKAGES,
            )
            self.client.insert_instance(
                _instance_body(
                    name=instance_name,
                    zone=zone,
                    machine_type=machine_type,
                    image_project=self.config.image_project,
                    image_family=self.config.image_family,
                    boot_disk_gib=self.config.boot_disk_gib,
                    user_data=user_data,
                )
            )
            created = True
            # Instances are addressed by name within the zone; the name is the id.
            self._notify(on_created, instance_name, instance_name)

            self._notify(on_phase, "connecting", "waiting for running instance and ssh")
            instance = self._wait_for_vm(sandbox_id=instance_name)
            ip = _external_ip(instance)
            if not ip:
                raise BackendUnavailableError(
                    "GCP instance became RUNNING without an external IP"
                )
            self._wait_for_ssh(host=ip)
            return ProvisionedSandbox(
                sandbox_id=instance_name,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=machine_type,
                region=zone,
                # Tri-state: an unpriced catalog option must stay None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if created:
                with suppress(Exception):
                    self.client.delete_instance(instance_name)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_instance(sandbox_id)

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(_external_ip(dict(resource)))

    def terminate(self, *, sandbox_id: str) -> bool:
        return self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.delete_instance
        )

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_machine_types())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        return self._find_named_resource_id(
            name=_sandbox_name(sandbox_uid or experiment_id),
            resources=self.client.list_instances(),
        )

    def _find_named_resource_id(
        self,
        *,
        name: str,
        resources: Iterable[Mapping[str, Any]],
        name_field: str = "name",
    ) -> str | None:
        # GCE instances have no separate id worth persisting; the name is the
        # zone-scoped identifier every other operation uses.
        for resource in resources:
            if str(resource.get(name_field) or "") == name:
                return name
        return None

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """GPU-bundled machine types in the configured zone."""
        zone = self.client.config.zone
        if region and _norm(region) != _norm(zone):
            options: list[dict[str, Any]] = []
        else:
            options = to_agent_options(
                self.client.list_machine_types(), zone=zone, gpu=gpu
            )
        return self._selection_catalog(
            reason=(
                "GCP bundles GPUs into a2/a3/g2 machine types; pick one "
                f"instance_type. This deployment provisions in {zone} "
                "(MERV_GCP_ZONE). Prices are not exposed by the Compute API "
                "and stay unknown. Fresh projects have a zero GPU quota — "
                "request an increase once in the console under IAM & Admin > "
                "Quotas (GPUS_ALL_REGIONS)."
            ),
            regions=[zone],
            options=options,
        )

    def _resolve_option(
        self, *, machine_type: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        options = to_agent_options(
            self.client.list_machine_types(), zone=self.client.config.zone
        )
        option = find_option(options, instance_type=machine_type)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise CapacityUnavailableError(
                f"GCP machine type {machine_type} is not offered in "
                f"{self.client.config.zone}. GPU machine types there: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match GCP machine type "
                f"{machine_type} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        return option

    def _ensure_firewall_rule(self) -> None:
        """SSH-only ingress for tagged sandboxes; racing creators tolerate 409."""
        try:
            self.client.get_firewall(FIREWALL_RULE_NAME)
            return
        except BackendUnavailableError as exc:
            if exc.status != 404:
                raise
        try:
            self.client.insert_firewall(
                {
                    "name": FIREWALL_RULE_NAME,
                    "direction": "INGRESS",
                    "network": "global/networks/default",
                    "allowed": [{"IPProtocol": "tcp", "ports": ["22"]}],
                    "sourceRanges": ["0.0.0.0/0"],
                    "targetTags": [SANDBOX_NETWORK_TAG],
                }
            )
        except BackendUnavailableError as exc:
            if exc.status != 409:
                raise


def _instance_body(
    *,
    name: str,
    zone: str,
    machine_type: str,
    image_project: str,
    image_family: str,
    boot_disk_gib: int,
    user_data: str,
) -> dict[str, Any]:
    return {
        "name": name,
        "machineType": f"zones/{zone}/machineTypes/{machine_type}",
        "disks": [
            {
                "boot": True,
                "autoDelete": True,
                "initializeParams": {
                    "sourceImage": (
                        f"projects/{image_project}/global/images/family/{image_family}"
                    ),
                    "diskSizeGb": str(int(boot_disk_gib)),
                    "diskType": f"zones/{zone}/diskTypes/pd-ssd",
                },
            }
        ],
        "networkInterfaces": [
            {
                "network": "global/networks/default",
                "accessConfigs": [
                    {"type": "ONE_TO_ONE_NAT", "name": "External NAT"}
                ],
            }
        ],
        "metadata": {
            "items": [
                # Ubuntu images run cloud-init over the user-data key; the DLVM
                # agent reads install-nvidia-driver and installs on first boot.
                {"key": "user-data", "value": user_data},
                {"key": "install-nvidia-driver", "value": "True"},
                # The bootstrap owns SSH principals; project-level OS Login
                # would silently override authorized_keys management.
                {"key": "enable-oslogin", "value": "FALSE"},
            ]
        },
        # GPU instances cannot live-migrate.
        "scheduling": {"onHostMaintenance": "TERMINATE", "automaticRestart": False},
        "labels": {SANDBOX_NETWORK_TAG.replace("-", "_"): "1"},
        "tags": {"items": [SANDBOX_NETWORK_TAG]},
    }


def _external_ip(instance: dict[str, Any]) -> str:
    for interface in instance.get("networkInterfaces", []) or []:
        if not isinstance(interface, dict):
            continue
        for access in interface.get("accessConfigs", []) or []:
            if isinstance(access, dict) and access.get("natIP"):
                return str(access["natIP"])
    return ""


def build_gcp_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> GcpSandboxBackend:
    # Lazy: project id and application-default credentials resolve at call time.
    return GcpSandboxBackend()
