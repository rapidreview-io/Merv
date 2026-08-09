# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Hyperstack Sandbox adapter."""

from __future__ import annotations

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
    _float_or_none,
    _http_base_url,
    _int_or_zero,
    _norm,
    _required_env,
    _vm_name,
    find_option,
    price_sort_key,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://infrahub-api.nexgencloud.com/v1"
# Exact image name from the Hyperstack docs; override for CUDA-preinstalled
# variants (e.g. "Ubuntu Server 22.04 LTS R535 CUDA 12.2").
DEFAULT_IMAGE_NAME = "Ubuntu Server 24.04 LTS (Noble Numbat)"
DEFAULT_SSH_USER = "ubuntu"
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class HyperstackCloudConfig:
    api_key: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "HyperstackCloudConfig":
        return cls(
            api_key=_required_env(
                "MERV_HYPERSTACK_API_KEY",
                "HYPERSTACK_API_KEY",
                error="Hyperstack API key is required; set "
                "MERV_HYPERSTACK_API_KEY or HYPERSTACK_API_KEY",
            ),
            base_url=_http_base_url("MERV_HYPERSTACK_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class HyperstackSandboxConfig:
    cloud: HyperstackCloudConfig
    # Every Hyperstack VM and keypair lives inside a user-created environment
    # (made once in the console); the environment also fixes the region.
    environment_name: str = ""
    image_name: str = DEFAULT_IMAGE_NAME
    flavor_name: str = ""
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "HyperstackSandboxConfig":
        environment_name = (env_value("MERV_HYPERSTACK_ENVIRONMENT") or "").strip()
        if not environment_name:
            raise BackendValidationError(
                "Hyperstack requires an environment; create one in the console "
                "(it pins the region) and set MERV_HYPERSTACK_ENVIRONMENT"
            )
        return cls(
            cloud=HyperstackCloudConfig.from_env(),
            environment_name=environment_name,
            image_name=(
                env_value("MERV_HYPERSTACK_IMAGE") or DEFAULT_IMAGE_NAME
            ).strip(),
            flavor_name=(env_value("MERV_HYPERSTACK_FLAVOR") or "").strip(),
            ssh_user=(env_value("MERV_HYPERSTACK_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
        )


# Hardware catalog

def to_agent_options(
    flavor_groups: list[dict[str, Any]],
    pricebook: list[dict[str, Any]],
    *,
    gpu: str | None = None,
    region: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    prices = {
        str(entry.get("name") or ""): _float_or_none(entry.get("value"))
        for entry in pricebook
    }
    gpu_filter = _norm(gpu)
    region_filter = _norm(region)
    options: list[dict[str, Any]] = []
    for group in flavor_groups:
        group_gpu = str(group.get("gpu") or "")
        for flavor in group.get("flavors", []) or []:
            if not isinstance(flavor, dict):
                continue
            name = str(flavor.get("name") or "")
            flavor_region = str(flavor.get("region_name") or group.get("region_name") or "")
            flavor_gpu = str(flavor.get("gpu") or group_gpu)
            available = bool(flavor.get("stock_available"))
            if only_available and not available:
                continue
            if region_filter and region_filter != _norm(flavor_region):
                continue
            if gpu_filter and gpu_filter not in _norm(flavor_gpu) and gpu_filter not in _norm(name):
                continue
            options.append(
                {
                    "instance_type": name,
                    "gpu": _gpu_label(flavor_gpu),
                    "gpu_description": flavor_gpu,
                    "gpu_count": _int_or_zero(flavor.get("gpu_count")),
                    "vcpus": _int_or_zero(flavor.get("cpu")),
                    "memory_gib": _int_or_zero(flavor.get("ram")),
                    "storage_gib": _int_or_zero(flavor.get("disk"))
                    + _int_or_zero(flavor.get("ephemeral")),
                    # A flavor the pricebook does not list is UNPRICED, not
                    # free — the cost policy has to be able to refuse it.
                    "price_usd_per_hour": prices.get(name),
                    "regions": [flavor_region] if flavor_region else [],
                    "available": available,
                }
            )
    options.sort(key=price_sort_key)
    return options


def _gpu_label(gpu_description: str) -> str:
    """Short GPU label, e.g. 'H100' from 'H100-80G-PCIe'."""
    text = gpu_description.strip()
    return text.split("-")[0].strip() if text else ""


# Provider API client

class HyperstackClient:
    def __init__(
        self, *, config: HyperstackCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or HyperstackCloudConfig.from_env()
        self.timeout = timeout

    def list_flavors(self, *, region: str | None = None) -> list[dict[str, Any]]:
        path = "/core/flavors" + (f"?region={region}" if region else "")
        raw = self._request("GET", path).get("data")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Hyperstack returned malformed flavors data")
        return [item for item in raw if isinstance(item, dict)]

    def get_pricebook(self) -> list[dict[str, Any]]:
        # Non-standard envelope: /pricebook returns a bare JSON array.
        raw = self._request("GET", "/pricebook", bare=True)
        if not isinstance(raw, list):
            raise BackendUnavailableError("Hyperstack returned malformed pricebook data")
        return [item for item in raw if isinstance(item, dict)]

    def import_keypair(
        self, *, name: str, environment_name: str, public_key: str
    ) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/core/keypairs",
            body={
                "name": name,
                "environment_name": environment_name,
                "public_key": public_key,
            },
        )
        raw = data.get("keypair")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Hyperstack returned malformed keypair data")
        return raw

    def list_keypairs(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/core/keypairs").get("keypairs")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Hyperstack returned malformed keypairs data")
        return [item for item in raw if isinstance(item, dict)]

    def delete_keypair(self, keypair_id: int | str) -> None:
        self._request("DELETE", f"/core/keypair/{keypair_id}")

    def create_vm(
        self,
        *,
        name: str,
        environment_name: str,
        image_name: str,
        flavor_name: str,
        key_name: str,
        user_data: str,
        security_rules: list[dict[str, Any]],
    ) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/core/virtual-machines",
            body={
                "name": name,
                "environment_name": environment_name,
                "image_name": image_name,
                "flavor_name": flavor_name,
                "key_name": key_name,
                "count": 1,
                "assign_floating_ip": True,
                "user_data": user_data,
                "security_rules": security_rules,
            },
        )
        instances = data.get("instances")
        if not isinstance(instances, list) or not instances or not isinstance(instances[0], dict):
            raise BackendUnavailableError("Hyperstack create returned no instance")
        return instances[0]

    def list_vms(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/core/virtual-machines").get("instances")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Hyperstack returned malformed instances data")
        return [item for item in raw if isinstance(item, dict)]

    def get_vm(self, vm_id: str) -> dict[str, Any]:
        raw = self._request("GET", f"/core/virtual-machines/{vm_id}").get("instance")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Hyperstack returned malformed instance data")
        return raw

    def delete_vm(self, vm_id: str) -> None:
        self._request("DELETE", f"/core/virtual-machines/{vm_id}")

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None, bare: bool = False
    ) -> Any:
        return request_json(
            provider="Hyperstack",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers={
                "Accept": "application/json",
                # Hyperstack authenticates with a bare `api_key` header.
                "api_key": self.config.api_key,
                "Content-Type": "application/json",
                "User-Agent": "merv/0.0013",
            },
            timeout=self.timeout,
            require_object=not bare,
        )


# Sandbox adapter

ACTIVE_VM_STATUSES = frozenset({"ACTIVE"})
# Anything not provably gone stays "alive": SHUTOFF and HIBERNATED still hold
# (and bill for) resources, and a conservative False here is what strands a
# billing VM behind a terminated row.
TERMINAL_VM_STATUSES = frozenset({"DELETED", "DELETING", "ERROR"})

HYPERSTACK_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)

# The one inbound rule a sandbox needs; everything else stays closed.
SSH_INGRESS_RULES: list[dict[str, Any]] = [
    {
        "direction": "ingress",
        "protocol": "tcp",
        "ethertype": "IPv4",
        "remote_ip_prefix": "0.0.0.0/0",
        "port_range_min": 22,
        "port_range_max": 22,
    }
]


class HyperstackSandboxBackend(VmSshSandboxBackend):
    resource_label = "Hyperstack VM"
    ready_statuses = ACTIVE_VM_STATUSES
    terminal_statuses = TERMINAL_VM_STATUSES
    capabilities = BackendCapabilities(
        name="hyperstack",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: HyperstackSandboxConfig | None = None,
        client: HyperstackClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        # Lazy config/client (mirrors Lambda): the daemon can boot and report
        # health with only an API key; missing settings surface at call time.
        self._config = config
        self._client = client

    @property
    def config(self) -> HyperstackSandboxConfig:
        return self._lazy_provider_config(HyperstackSandboxConfig.from_env)

    @property
    def client(self) -> HyperstackClient:
        return self._lazy_provider_client(HyperstackClient)

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
        flavor_name = (request.instance_type or self.config.flavor_name or "").strip()
        if not flavor_name:
            raise BackendValidationError(
                "Hyperstack requires an instance_type (a flavor bundling GPU + CPU "
                "+ RAM). Call sandbox.options, or sandbox.request without an "
                "instance_type, to see live availability, then pick one."
            )
        self._notify(on_phase, "checking_capacity", flavor_name)
        option = self._resolve_flavor(flavor_name=flavor_name, requested_gpu=request.gpu)

        keypair_id = ""
        vm_id = ""
        try:
            self._notify(on_phase, "registering_ssh_key", key_name)
            keypair = self.client.import_keypair(
                name=key_name,
                environment_name=self.config.environment_name,
                public_key=request.public_key,
            )
            keypair_id = str(keypair.get("id") or "")

            self._notify(on_phase, "creating", f"{flavor_name} in {self.config.environment_name}")
            workdir = self._sandbox_workdir(request)
            user_data = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=HYPERSTACK_APT_PACKAGES,
            )
            instance = self.client.create_vm(
                name=instance_name,
                environment_name=self.config.environment_name,
                image_name=self.config.image_name,
                flavor_name=flavor_name,
                key_name=key_name,
                user_data=user_data,
                # VMs open ZERO inbound ports by default; without this rule the
                # floating IP exists but SSH never answers.
                security_rules=SSH_INGRESS_RULES,
            )
            vm_id = str(instance.get("id") or "")
            if not vm_id:
                raise BackendUnavailableError("Hyperstack created a VM without an id")
            self._notify(on_created, vm_id, instance_name)

            self._notify(on_phase, "connecting", "waiting for active VM and ssh")
            instance = self._wait_for_vm(sandbox_id=vm_id)
            ip = str(instance.get("floating_ip") or "")
            if not ip:
                raise BackendUnavailableError(
                    "Hyperstack VM became active without a floating IP"
                )
            self._wait_for_ssh(host=ip)
            flavor = instance.get("flavor") if isinstance(instance.get("flavor"), dict) else {}
            return ProvisionedSandbox(
                sandbox_id=vm_id,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or flavor.get("gpu") or request.gpu or ""),
                cpu=float(flavor.get("cpu") or option.get("vcpus") or 0) or None,
                memory=(int(flavor.get("ram") or option.get("memory_gib") or 0) * 1024) or None,
                instance_type=flavor_name,
                region=str(
                    (instance.get("environment") or {}).get("region")
                    or (option.get("regions") or [""])[0]
                ),
                # Tri-state: an unpriced catalog option must stay None so the
            # ledger records price_known=0 instead of a "known" $0.00/hr.
            price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if vm_id:
                with suppress(Exception):
                    self.client.delete_vm(vm_id)
            if keypair_id:
                with suppress(Exception):
                    self.client.delete_keypair(keypair_id)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_vm(sandbox_id)

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(resource.get("floating_ip"))

    def terminate(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        keypair_names = self._keypair_names_for_vm(sandbox_id=sandbox_id)
        if not self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.delete_vm
        ):
            return False
        self._delete_keypairs_by_name(keypair_names)
        return True

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_flavors())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        return self._find_named_resource_id(
            name=_sandbox_name(sandbox_uid or experiment_id),
            resources=self.client.list_vms(),
        )

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """Live menu of in-stock Hyperstack flavors, priced from the pricebook."""
        options = to_agent_options(
            self.client.list_flavors(region=region),
            self.client.get_pricebook(),
            gpu=gpu,
            region=region,
            only_available=True,
        )
        return self._selection_catalog(
            reason=(
                "Hyperstack bundles GPU, CPU, and RAM into fixed flavors; pick one "
                "instance_type. Billing is per-minute while the VM exists."
            ),
            options=options,
        )

    def _resolve_flavor(
        self, *, flavor_name: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        """Validate the flavor exists with stock right now; return its option."""
        options = to_agent_options(
            self.client.list_flavors(), self.client.get_pricebook(), only_available=False
        )
        option = find_option(options, instance_type=flavor_name)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise BackendValidationError(
                f"Hyperstack flavor is not offered: {flavor_name}. Offered: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match Hyperstack flavor "
                f"{flavor_name} ({option.get('gpu_description') or 'no GPU'})"
            )
        if not option.get("available"):
            raise CapacityUnavailableError(
                f"Hyperstack flavor {flavor_name} has no stock right now. "
                "Call sandbox.options to pick an available flavor."
            )
        return option

    def _keypair_names_for_vm(self, *, sandbox_id: str) -> list[str]:
        try:
            instance = self.client.get_vm(sandbox_id)
        except Exception:  # noqa: BLE001
            return []
        keypair = instance.get("keypair")
        name = str(keypair.get("name") or "") if isinstance(keypair, dict) else ""
        return [name] if name.startswith("rp-") else []

    def _delete_keypairs_by_name(self, names: list[str]) -> None:
        if not names:
            return
        wanted = set(names)
        try:
            keypairs = self.client.list_keypairs()
        except Exception:  # noqa: BLE001
            return
        for keypair in keypairs:
            if str(keypair.get("name") or "") in wanted and keypair.get("id"):
                with suppress(Exception):
                    self.client.delete_keypair(keypair["id"])


def _sandbox_name(experiment_id: str) -> str:
    return _vm_name(experiment_id, max_length=50)  # Hyperstack caps VM names at 50 chars


def build_hyperstack_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> HyperstackSandboxBackend:
    # Lazy: credentials/environment resolve at call time, not construction.
    return HyperstackSandboxBackend()
