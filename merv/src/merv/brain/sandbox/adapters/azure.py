# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Azure Sandbox adapter."""

from __future__ import annotations

import base64
import json
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
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

DEFAULT_BASE_URL = "https://management.azure.com"
DEFAULT_LOGIN_URL = "https://login.microsoftonline.com"
DEFAULT_LOCATION = "eastus"
# The Ubuntu HPC image ships NVIDIA drivers (and InfiniBand tooling); plain
# Ubuntu URNs boot GPU sizes with the GPUs unusable.
DEFAULT_IMAGE_URN = "microsoft-dsvm:ubuntu-hpc:2204:latest"
DEFAULT_SSH_USER = "ubuntu"
DEFAULT_OS_DISK_GIB = 200
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 1200
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0
SANDBOX_TAG_KEY = "merv-sandbox"

COMPUTE_API_VERSION = "2024-07-01"
NETWORK_API_VERSION = "2023-11-01"
RESOURCE_API_VERSION = "2021-04-01"
SKUS_API_VERSION = "2021-07-01"

# The osProfile customData limit; our cloud-init payload stays well under it.
CUSTOM_DATA_MAX_BYTES = 64 * 1024


@dataclass(frozen=True)
class AzureCloudConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    subscription_id: str
    base_url: str = DEFAULT_BASE_URL
    login_url: str = DEFAULT_LOGIN_URL

    @classmethod
    def from_env(cls) -> "AzureCloudConfig":
        tenant_id = _first_env("MERV_AZURE_TENANT_ID", "AZURE_TENANT_ID")
        client_id = _first_env("MERV_AZURE_CLIENT_ID", "AZURE_CLIENT_ID")
        client_secret = _first_env("MERV_AZURE_CLIENT_SECRET", "AZURE_CLIENT_SECRET")
        subscription_id = _first_env(
            "MERV_AZURE_SUBSCRIPTION_ID", "AZURE_SUBSCRIPTION_ID"
        )
        if not (tenant_id and client_id and client_secret and subscription_id):
            raise BackendValidationError(
                "Azure service-principal credentials are required; set "
                "MERV_AZURE_TENANT_ID, MERV_AZURE_CLIENT_ID, "
                "MERV_AZURE_CLIENT_SECRET, and MERV_AZURE_SUBSCRIPTION_ID "
                "(AZURE_* variants also accepted; create them with "
                "`az ad sp create-for-rbac --role Contributor`)"
            )
        return cls(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
            subscription_id=subscription_id,
            base_url=_http_base_url("MERV_AZURE_API_BASE", DEFAULT_BASE_URL),
            login_url=_http_base_url("MERV_AZURE_LOGIN_BASE", DEFAULT_LOGIN_URL),
        )


@dataclass(frozen=True)
class AzureSandboxConfig:
    cloud: AzureCloudConfig
    location: str = DEFAULT_LOCATION
    vm_size: str = ""
    image_urn: str = DEFAULT_IMAGE_URN
    ssh_user: str = DEFAULT_SSH_USER
    os_disk_gib: int = DEFAULT_OS_DISK_GIB
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "AzureSandboxConfig":
        return cls(
            cloud=AzureCloudConfig.from_env(),
            location=(env_value("MERV_AZURE_LOCATION") or DEFAULT_LOCATION).strip()
            or DEFAULT_LOCATION,
            vm_size=(env_value("MERV_AZURE_VM_SIZE") or "").strip(),
            image_urn=(env_value("MERV_AZURE_IMAGE") or DEFAULT_IMAGE_URN).strip()
            or DEFAULT_IMAGE_URN,
            ssh_user=(env_value("MERV_AZURE_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
            os_disk_gib=_positive_int(
                env_value("MERV_AZURE_OS_DISK_GIB") or DEFAULT_OS_DISK_GIB,
                field="MERV_AZURE_OS_DISK_GIB",
            ),
        )


def _parse_image_urn(urn: str) -> dict[str, str]:
    parts = urn.split(":")
    if len(parts) != 4 or not all(parts):
        raise BackendValidationError(
            "MERV_AZURE_IMAGE must be a publisher:offer:sku:version URN"
        )
    return {
        "publisher": parts[0],
        "offer": parts[1],
        "sku": parts[2],
        "version": parts[3],
    }


# Hardware catalog

def to_agent_options(
    skus: list[dict[str, Any]],
    *,
    location: str = "",
    gpu: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    gpu_filter = _norm(gpu)
    options: list[dict[str, Any]] = []
    for item in skus:
        if _norm(item.get("resourceType")) != "virtualmachines":
            continue
        name = str(item.get("name") or "")
        capabilities = {
            str(cap.get("name") or ""): str(cap.get("value") or "")
            for cap in item.get("capabilities", []) or []
            if isinstance(cap, dict)
        }
        gpu_count = _int_or_zero(capabilities.get("GPUs"))
        if not name or gpu_count <= 0:
            continue
        restricted = _subscription_restricted(item)
        if only_available and restricted:
            continue
        model = _gpu_label(name)
        if gpu_filter and gpu_filter not in _norm(model) and gpu_filter not in _norm(name):
            continue
        memory_gib = _float_or_none(capabilities.get("MemoryGB")) or 0.0
        options.append(
            {
                "instance_type": name,
                "gpu": model,
                "gpu_description": f"{gpu_count}x {model}".strip(),
                "gpu_count": gpu_count,
                "vcpus": _int_or_zero(capabilities.get("vCPUs")),
                "memory_gib": int(memory_gib),
                # The managed OS disk is sized by the adapter, not the SKU.
                "storage_gib": 0,
                # Filled from the Retail Prices API when reachable; unknown
                # stays None so spend policy fails closed.
                "price_usd_per_hour": None,
                "regions": [location] if location else [],
                "available": not restricted,
            }
        )
    options.sort(key=price_sort_key)
    return options


def _subscription_restricted(sku: dict[str, Any]) -> bool:
    return any(
        _norm(r.get("reasonCode")) == "notavailableforsubscription"
        for r in sku.get("restrictions", []) or []
        if isinstance(r, dict)
    )


_GPU_NAME_MARKERS: tuple[tuple[str, str], ...] = (
    ("_MI300X", "MI300X"),
    ("_H200", "H200"),
    ("_H100", "H100"),
    ("_A100", "A100"),
    ("_A10", "A10"),
    ("_T4", "T4"),
    ("_V100", "V100"),
    ("_P40", "P40"),
    ("_P100", "P100"),
)
# Families whose GPU is not spelled out in the size name.
_GPU_FAMILY_FALLBACKS: tuple[tuple[str, str], ...] = (
    ("Standard_NCads_H100", "H100"),
    ("Standard_ND", "V100"),
    ("Standard_NC", "K80"),
    ("Standard_NV", "M60"),
)


def _gpu_label(size_name: str) -> str:
    """Short GPU label from an Azure size name, e.g. 'A100' from
    'Standard_NC24ads_A100_v4'."""
    upper = size_name.upper()
    for marker, label in _GPU_NAME_MARKERS:
        if marker in upper:
            return label
    for prefix, label in _GPU_FAMILY_FALLBACKS:
        if upper.startswith(prefix.upper()):
            return label
    return "GPU"


# Provider API client

# Refresh this many seconds before the token's stated expiry.
TOKEN_EXPIRY_SLACK_SECONDS = 60.0


class AzureClient:
    """ARM REST client: client-credentials OAuth2 over the stdlib only."""

    def __init__(
        self, *, config: AzureCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or AzureCloudConfig.from_env()
        self.timeout = timeout
        self._token = ""
        self._token_expires_at = 0.0

    # ---------- catalog ----------

    def list_gpu_skus(self, *, location: str) -> list[dict[str, Any]]:
        escaped = location.replace("'", "''")
        location_filter = quote(f"location eq '{escaped}'")
        data = self._request(
            "GET",
            f"/providers/Microsoft.Compute/skus"
            f"?api-version={SKUS_API_VERSION}"
            f"&$filter={location_filter}",
        )
        return [
            item for item in data.get("value", []) or [] if isinstance(item, dict)
        ]

    def retail_price(self, *, sku_name: str, location: str) -> float | None:
        """Best-effort $/hr from the public (unauthenticated) price sheet."""
        query = urlencode(
            {
                "$filter": (
                    "serviceName eq 'Virtual Machines' and priceType eq "
                    f"'Consumption' and armRegionName eq '{location}' and "
                    f"armSkuName eq '{sku_name}'"
                )
            }
        )
        try:
            request = Request(
                f"https://prices.azure.com/api/retail/prices?{query}",
                headers={"Accept": "application/json", "User-Agent": "merv/0.0014"},
            )
            with urlopen(request, timeout=10) as response:  # noqa: S310
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001 — pricing is advisory, never blocking
            return None
        prices = [
            _float_or_none(item.get("retailPrice"))
            for item in payload.get("Items", []) or []
            if isinstance(item, dict)
            # Skip Windows-licensed and low-priority meters.
            and "Windows" not in str(item.get("productName") or "")
            and "Spot" not in str(item.get("meterName") or "")
            and "Low Priority" not in str(item.get("meterName") or "")
        ]
        known = [price for price in prices if price is not None]
        return min(known) if known else None

    # ---------- resource lifecycle ----------

    def put_resource_group(self, *, name: str, location: str) -> None:
        self._request(
            "PUT",
            f"/resourcegroups/{name}?api-version={RESOURCE_API_VERSION}",
            body={"location": location, "tags": {SANDBOX_TAG_KEY: "1"}},
            subscription=True,
        )

    def get_resource_group(self, name: str) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/resourcegroups/{name}?api-version={RESOURCE_API_VERSION}",
            subscription=True,
        )

    def delete_resource_group(self, name: str) -> None:
        """Deletes every sandbox resource at once; ARM finishes it async."""
        self._request(
            "DELETE",
            f"/resourcegroups/{name}?api-version={RESOURCE_API_VERSION}",
            subscription=True,
        )

    def put_network_resource(
        self, *, resource_group: str, kind: str, name: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return self._resource_request(
            "PUT",
            resource_group=resource_group,
            provider="Microsoft.Network",
            kind=kind,
            name=name,
            api_version=NETWORK_API_VERSION,
            body=body,
        )

    def get_network_resource(
        self, *, resource_group: str, kind: str, name: str
    ) -> dict[str, Any]:
        return self._resource_request(
            "GET",
            resource_group=resource_group,
            provider="Microsoft.Network",
            kind=kind,
            name=name,
            api_version=NETWORK_API_VERSION,
        )

    def put_vm(
        self, *, resource_group: str, name: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return self._resource_request(
            "PUT",
            resource_group=resource_group,
            provider="Microsoft.Compute",
            kind="virtualMachines",
            name=name,
            api_version=COMPUTE_API_VERSION,
            body=body,
        )

    def get_vm(self, *, resource_group: str, name: str) -> dict[str, Any]:
        return self._resource_request(
            "GET",
            resource_group=resource_group,
            provider="Microsoft.Compute",
            kind="virtualMachines",
            name=name,
            api_version=COMPUTE_API_VERSION,
        )

    def list_vms(self) -> list[dict[str, Any]]:
        data = self._request(
            "GET",
            f"/providers/Microsoft.Compute/virtualMachines"
            f"?api-version={COMPUTE_API_VERSION}",
            subscription=True,
        )
        return [
            item for item in data.get("value", []) or [] if isinstance(item, dict)
        ]

    def _resource_request(
        self,
        method: str,
        *,
        resource_group: str,
        provider: str,
        kind: str,
        name: str,
        api_version: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self._request(
            method,
            f"/resourceGroups/{resource_group}/providers/{provider}/{kind}/{name}"
            f"?api-version={api_version}",
            body=body,
            subscription=True,
        )

    # ---------- auth ----------

    def _bearer_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        form = urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "scope": f"{self.config.base_url}/.default",
            }
        ).encode("utf-8")
        request = Request(
            f"{self.config.login_url}/{self.config.tenant_id}/oauth2/v2.0/token",
            data=form,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "merv/0.0014",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise BackendUnavailableError(
                f"Azure token request failed with HTTP {exc.code}: {detail}",
                status=exc.code,
            ) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise BackendUnavailableError(
                f"Azure token endpoint is unreachable: {exc}"
            ) from exc
        token = str(payload.get("access_token") or "") if isinstance(payload, dict) else ""
        if not token:
            raise BackendUnavailableError("Azure OAuth2 returned no access token")
        self._token = token
        expires_in = float(payload.get("expires_in") or 0.0)
        self._token_expires_at = time.monotonic() + max(
            expires_in - TOKEN_EXPIRY_SLACK_SECONDS, 30.0
        )
        return self._token

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        subscription: bool = False,
    ) -> dict[str, Any]:
        prefix = (
            f"/subscriptions/{self.config.subscription_id}" if subscription else ""
        )
        data = request_json(
            provider="Azure",
            method=method,
            base_url=self.config.base_url,
            path=f"{prefix}{path}",
            body=body,
            headers=bearer_json_headers(self._bearer_token(), "merv/0.0014"),
            timeout=self.timeout,
        )
        return data if isinstance(data, dict) else {}


# Sandbox adapter

READY_PROVISIONING_STATES = frozenset({"Succeeded"})
FAILED_PROVISIONING_STATES = frozenset({"Failed"})

AZURE_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)


def _resource_group_name(vm_name: str) -> str:
    return f"{vm_name}-rg"


class AzureSandboxBackend(VmSshSandboxBackend):
    resource_label = "Azure VM"
    ready_statuses = READY_PROVISIONING_STATES
    terminal_statuses = FAILED_PROVISIONING_STATES
    capabilities = BackendCapabilities(
        name="azure",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: AzureSandboxConfig | None = None,
        client: AzureClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> AzureSandboxConfig:
        return self._lazy_provider_config(AzureSandboxConfig.from_env)

    @property
    def client(self) -> AzureClient:
        return self._lazy_provider_client(AzureClient)

    def _status_is_live(self, status: str) -> bool:
        """Every fetchable VM (even Failed/deallocated) still holds billable
        disks in its resource group; only a 404 is gone."""
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
        vm_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        vm_size = (request.instance_type or self.config.vm_size or "").strip()
        if not vm_size:
            raise BackendValidationError(
                "Azure requires an instance_type (a GPU VM size, e.g. "
                "Standard_NC24ads_A100_v4). Call sandbox.options, or "
                "sandbox.request without an instance_type, to see the GPU "
                "sizes this subscription can deploy, then pick one."
            )
        self._notify(on_phase, "checking_capacity", vm_size)
        option = self._resolve_option(vm_size=vm_size, requested_gpu=request.gpu)

        location = self.config.location
        resource_group = _resource_group_name(vm_name)
        group_created = False
        try:
            self._notify(on_phase, "creating", f"{vm_size} in {location}")
            self.client.put_resource_group(name=resource_group, location=location)
            group_created = True
            # The whole sandbox lives in one resource group, so `on_created`
            # can fire before the VM PUT: cleanup deletes the group either way.
            self._notify(on_created, vm_name, vm_name)

            nic_id = self._create_network(
                resource_group=resource_group, vm_name=vm_name, location=location
            )
            workdir = self._sandbox_workdir(request)
            user_data = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=AZURE_APT_PACKAGES,
            )
            custom_data = base64.b64encode(user_data.encode("utf-8")).decode("ascii")
            if len(custom_data) > CUSTOM_DATA_MAX_BYTES:
                raise BackendValidationError(
                    "Azure customData exceeds the 64 KiB osProfile limit"
                )
            self.client.put_vm(
                resource_group=resource_group,
                name=vm_name,
                body=_vm_body(
                    name=vm_name,
                    location=location,
                    vm_size=vm_size,
                    image=_parse_image_urn(self.config.image_urn),
                    os_disk_gib=self.config.os_disk_gib,
                    ssh_user=self.config.ssh_user,
                    public_key=request.public_key,
                    custom_data=custom_data,
                    nic_id=nic_id,
                ),
            )

            self._notify(on_phase, "connecting", "waiting for provisioned VM and ssh")
            self._wait_for_vm(sandbox_id=vm_name)
            ip = self._public_ip(resource_group=resource_group, vm_name=vm_name)
            if not ip:
                raise BackendUnavailableError(
                    "Azure VM provisioned without a public IP address"
                )
            self._wait_for_ssh(host=ip)
            return ProvisionedSandbox(
                sandbox_id=vm_name,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=vm_size,
                region=location,
                # Tri-state: an unpriced catalog option must stay None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if group_created:
                with suppress(Exception):
                    self.client.delete_resource_group(resource_group)
            raise

    def _create_network(
        self, *, resource_group: str, vm_name: str, location: str
    ) -> str:
        """NSG -> VNet -> public IP -> NIC, each awaited before it is referenced."""
        nsg = self._await_network(
            resource_group=resource_group,
            kind="networkSecurityGroups",
            name=f"{vm_name}-nsg",
            body={
                "location": location,
                "properties": {
                    "securityRules": [
                        {
                            "name": "allow-ssh",
                            "properties": {
                                "priority": 1000,
                                "direction": "Inbound",
                                "access": "Allow",
                                "protocol": "Tcp",
                                "sourceAddressPrefix": "*",
                                "sourcePortRange": "*",
                                "destinationAddressPrefix": "*",
                                "destinationPortRange": "22",
                            },
                        }
                    ]
                },
            },
        )
        vnet = self._await_network(
            resource_group=resource_group,
            kind="virtualNetworks",
            name=f"{vm_name}-vnet",
            body={
                "location": location,
                "properties": {
                    "addressSpace": {"addressPrefixes": ["10.10.0.0/16"]},
                    "subnets": [
                        {
                            "name": "sandbox",
                            "properties": {
                                "addressPrefix": "10.10.0.0/24",
                                "networkSecurityGroup": {"id": str(nsg.get("id") or "")},
                            },
                        }
                    ],
                },
            },
        )
        subnets = vnet.get("properties", {}).get("subnets", []) or []
        subnet_id = str(subnets[0].get("id") or "") if subnets else ""
        if not subnet_id:
            raise BackendUnavailableError("Azure VNet was created without a subnet id")
        public_ip = self._await_network(
            resource_group=resource_group,
            kind="publicIPAddresses",
            name=f"{vm_name}-ip",
            body={
                "location": location,
                "sku": {"name": "Standard"},
                "properties": {"publicIPAllocationMethod": "Static"},
            },
        )
        nic = self._await_network(
            resource_group=resource_group,
            kind="networkInterfaces",
            name=f"{vm_name}-nic",
            body={
                "location": location,
                "properties": {
                    "ipConfigurations": [
                        {
                            "name": "primary",
                            "properties": {
                                "subnet": {"id": subnet_id},
                                "publicIPAddress": {
                                    "id": str(public_ip.get("id") or "")
                                },
                            },
                        }
                    ]
                },
            },
        )
        nic_id = str(nic.get("id") or "")
        if not nic_id:
            raise BackendUnavailableError("Azure NIC was created without an id")
        return nic_id

    def _await_network(
        self, *, resource_group: str, kind: str, name: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """PUT the resource, then poll until ARM reports it Succeeded."""
        resource = self.client.put_network_resource(
            resource_group=resource_group, kind=kind, name=name, body=body
        )
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        while time.monotonic() < deadline:
            state = str(resource.get("properties", {}).get("provisioningState") or "")
            if state in READY_PROVISIONING_STATES:
                return resource
            if state in FAILED_PROVISIONING_STATES:
                raise BackendUnavailableError(
                    f"Azure {kind}/{name} reached provisioning state {state}"
                )
            time.sleep(self.config.poll_interval_seconds)
            resource = self.client.get_network_resource(
                resource_group=resource_group, kind=kind, name=name
            )
        raise BackendUnavailableError(
            f"Azure {kind}/{name} did not finish provisioning before timeout"
        )

    def _public_ip(self, *, resource_group: str, vm_name: str) -> str:
        resource = self.client.get_network_resource(
            resource_group=resource_group,
            kind="publicIPAddresses",
            name=f"{vm_name}-ip",
        )
        return str(resource.get("properties", {}).get("ipAddress") or "")

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_vm(
            resource_group=_resource_group_name(sandbox_id), name=sandbox_id
        )

    def _resource_status(self, resource: Mapping[str, Any]) -> str:
        properties = resource.get("properties")
        if not isinstance(properties, Mapping):
            return ""
        return str(properties.get("provisioningState") or "")

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        _ = resource  # the public IP is a sibling resource, checked after wait
        return True

    def terminate(self, *, sandbox_id: str) -> bool:
        """One group delete removes VM, NIC, IP, VNet, NSG, and disks."""
        if not sandbox_id:
            return False
        return self._delete_with_404(
            sandbox_id=_resource_group_name(sandbox_id),
            delete=self.client.delete_resource_group,
        )

    def health(self) -> dict:
        return self._probe_health(
            lambda: self.client.list_gpu_skus(location=self.config.location)
        )

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        name = _sandbox_name(sandbox_uid or experiment_id)
        for vm in self.client.list_vms():
            tags = vm.get("tags") if isinstance(vm.get("tags"), dict) else {}
            if str(vm.get("name") or "") == name and SANDBOX_TAG_KEY in tags:
                return name
        return None

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """GPU VM sizes this subscription can deploy in the configured location."""
        location = self.config.location
        if region and _norm(region) != _norm(location):
            options: list[dict[str, Any]] = []
        else:
            options = to_agent_options(
                self.client.list_gpu_skus(location=location),
                location=location,
                gpu=gpu,
                only_available=True,
            )
        return self._selection_catalog(
            reason=(
                "Azure sells fixed GPU VM sizes (NC/ND/NV families); pick one "
                f"instance_type. This deployment provisions in {location} "
                "(MERV_AZURE_LOCATION); each sandbox lives in its own resource "
                "group and terminate deletes the whole group. Fresh "
                "subscriptions have a zero vCPU quota for GPU families — "
                "request an increase once under Quotas > Compute."
            ),
            regions=[location],
            options=options,
        )

    def _resolve_option(
        self, *, vm_size: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        location = self.config.location
        options = to_agent_options(
            self.client.list_gpu_skus(location=location),
            location=location,
            only_available=False,
        )
        option = find_option(options, instance_type=vm_size)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise BackendValidationError(
                f"Azure GPU size is not offered in {location}: {vm_size}. "
                f"GPU sizes there: {offered}."
            )
        if not option.get("available"):
            raise CapacityUnavailableError(
                f"Azure size {vm_size} is restricted for this subscription in "
                f"{location}; request the quota/region unlock or pick another "
                "size via sandbox.options."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match Azure size "
                f"{vm_size} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        with suppress(Exception):
            option["price_usd_per_hour"] = self.client.retail_price(
                sku_name=vm_size, location=location
            )
        return option


def _vm_body(
    *,
    name: str,
    location: str,
    vm_size: str,
    image: dict[str, str],
    os_disk_gib: int,
    ssh_user: str,
    public_key: str,
    custom_data: str,
    nic_id: str,
) -> dict[str, Any]:
    return {
        "location": location,
        "tags": {SANDBOX_TAG_KEY: "1"},
        "properties": {
            "hardwareProfile": {"vmSize": vm_size},
            "storageProfile": {
                "imageReference": image,
                "osDisk": {
                    "createOption": "FromImage",
                    "diskSizeGB": int(os_disk_gib),
                    "deleteOption": "Delete",
                    "managedDisk": {"storageAccountType": "StandardSSD_LRS"},
                },
            },
            "osProfile": {
                "computerName": name,
                "adminUsername": ssh_user,
                # The caller key lands via osProfile so SSH answers even if
                # cloud-init is slow; the bootstrap then takes over principals.
                "customData": custom_data,
                "linuxConfiguration": {
                    "disablePasswordAuthentication": True,
                    "ssh": {
                        "publicKeys": [
                            {
                                "path": f"/home/{ssh_user}/.ssh/authorized_keys",
                                "keyData": public_key,
                            }
                        ]
                    },
                },
            },
            "networkProfile": {
                "networkInterfaces": [
                    {"id": nic_id, "properties": {"deleteOption": "Delete"}}
                ]
            },
        },
    }


def build_azure_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> AzureSandboxBackend:
    # Lazy: service-principal credentials resolve at call time, not construction.
    return AzureSandboxBackend()
