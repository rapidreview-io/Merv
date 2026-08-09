# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Voltage Park Sandbox adapter."""

from __future__ import annotations

import base64
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
    _vm_name as _sandbox_name,
    bearer_json_headers,
    find_option,
    price_sort_key,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://cloud-api.voltagepark.com/api/v1"
DEFAULT_SSH_USER = "root"
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class VoltageParkCloudConfig:
    token: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "VoltageParkCloudConfig":
        return cls(
            token=_required_env(
                "MERV_VOLTAGE_PARK_TOKEN",
                "VOLTAGE_PARK_TOKEN",
                error="Voltage Park API token is required; set "
                "MERV_VOLTAGE_PARK_TOKEN or VOLTAGE_PARK_TOKEN",
            ),
            base_url=_http_base_url("MERV_VOLTAGE_PARK_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class VoltageParkSandboxConfig:
    cloud: VoltageParkCloudConfig
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "VoltageParkSandboxConfig":
        return cls(
            cloud=VoltageParkCloudConfig.from_env(),
            ssh_user=(
                env_value("MERV_VOLTAGE_PARK_SSH_USER") or DEFAULT_SSH_USER
            ).strip()
            or DEFAULT_SSH_USER,
        )


# Hardware catalog

def to_agent_options(
    locations: list[dict[str, Any]],
    *,
    gpu: str | None = None,
    region: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    gpu_filter = _norm(gpu)
    region_filter = _norm(region)
    merged: dict[str, dict[str, Any]] = {}
    for location in locations:
        location_id = str(location.get("id") or "")
        if region_filter and region_filter != location_id.lower():
            continue
        for preset in location.get("available_presets", []) or []:
            if not isinstance(preset, dict):
                continue
            operating_system = str(preset.get("operating_system") or "")
            if operating_system.startswith("Windows"):
                continue
            preset_id = str(preset.get("id") or "")
            if not preset_id:
                continue
            resources = (
                preset.get("resources") if isinstance(preset.get("resources"), dict) else {}
            )
            gpus = resources.get("gpus") if isinstance(resources.get("gpus"), dict) else {}
            gpu_names = sorted(gpus)
            label = _gpu_label(gpu_names[0]) if gpu_names else ""
            if gpu_filter and gpu_filter not in _norm(label) and gpu_filter not in _norm(
                " ".join(gpu_names)
            ):
                continue
            available_vms = _int_or_zero(preset.get("available_vms"))
            option = merged.setdefault(
                preset_id,
                {
                    "instance_type": preset_id,
                    "gpu": label,
                    "gpu_description": ", ".join(gpu_names) + f" ({operating_system})",
                    "gpu_count": sum(
                        _int_or_zero((spec or {}).get("count")) for spec in gpus.values()
                    ),
                    "vcpus": _int_or_zero(resources.get("vcpu_count")),
                    "memory_gib": _int_or_zero(resources.get("ram_gb")),
                    "storage_gib": _int_or_zero(resources.get("storage_gb")),
                    # Compute + storage hourly rates arrive as strings. Either
                    # one missing leaves the TOTAL unknown — a partial sum
                    # would under-quote the machine and slip past a ceiling.
                    "price_usd_per_hour": _sum_rates(
                        _float_or_none(preset.get("compute_rate_hourly")),
                        _float_or_none(preset.get("storage_rate_hourly")),
                    ),
                    "regions": [],
                    "available": False,
                },
            )
            if available_vms > 0:
                option["available"] = True
                if location_id and location_id not in option["regions"]:
                    option["regions"].append(location_id)
    options = [
        option
        for option in merged.values()
        if option["available"] or not only_available
    ]
    for option in options:
        option["regions"].sort()
    options.sort(key=price_sort_key)
    return options


def _sum_rates(*rates: float | None) -> float | None:
    """Total hourly rate, or None when any component is unknown."""
    return None if any(rate is None for rate in rates) else sum(rates)  # type: ignore[arg-type]


def _gpu_label(name: str) -> str:
    """Short GPU label, e.g. 'H100' from 'h100-sxm5-80gb'."""
    return name.split("-")[0].upper() if name else ""


# Provider API client

class VoltageParkClient:
    def __init__(
        self, *, config: VoltageParkCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or VoltageParkCloudConfig.from_env()
        self.timeout = timeout

    def list_instant_locations(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/virtual-machines/instant/locations")
        results = raw.get("results") if isinstance(raw, dict) else raw
        if not isinstance(results, list):
            raise BackendUnavailableError(
                "Voltage Park returned malformed instant locations data"
            )
        return [item for item in results if isinstance(item, dict)]

    def create_instant_vm(
        self,
        *,
        config_id: str,
        name: str,
        ssh_keys: list[str],
        cloud_init: dict[str, Any],
    ) -> str:
        raw = self._request(
            "POST",
            "/virtual-machines/instant",
            body={
                "config_id": config_id,
                "name": name,
                "ssh_keys": ssh_keys,
                "cloud_init": cloud_init,
            },
        )
        vm_id = str(raw.get("vm_id") or "") if isinstance(raw, dict) else ""
        if not vm_id:
            raise BackendUnavailableError("Voltage Park create returned no vm_id")
        return vm_id

    def list_vms(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/virtual-machines/")
        results = raw.get("results") if isinstance(raw, dict) else raw
        if not isinstance(results, list):
            raise BackendUnavailableError("Voltage Park returned malformed VM list data")
        return [item for item in results if isinstance(item, dict)]

    def get_vm(self, vm_id: str) -> dict[str, Any]:
        raw = self._request("GET", f"/virtual-machines/{vm_id}")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Voltage Park returned malformed VM data")
        return raw

    def delete_vm(self, vm_id: str) -> None:
        self._request("DELETE", f"/virtual-machines/{vm_id}")

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> Any:
        return request_json(
            provider="Voltage Park",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers=bearer_json_headers(self.config.token, "merv/0.0013"),
            timeout=self.timeout,
        )


# Sandbox adapter

ACTIVE_VM_STATUSES = frozenset({"Running"})
# Stopped/StoppedDisassociated still hold storage; Outbid is spot-only and
# should not occur for instant (on-demand) VMs but is not provably gone.
TERMINAL_VM_STATUSES = frozenset({"Terminated"})

VOLTAGE_PARK_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)

BOOTSTRAP_PATH = "/opt/merv/bootstrap.sh"


class VoltageParkSandboxBackend(VmSshSandboxBackend):
    resource_label = "Voltage Park VM"
    ready_statuses = ACTIVE_VM_STATUSES
    terminal_statuses = TERMINAL_VM_STATUSES
    capabilities = BackendCapabilities(
        name="voltage_park",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: VoltageParkSandboxConfig | None = None,
        client: VoltageParkClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> VoltageParkSandboxConfig:
        return self._lazy_provider_config(VoltageParkSandboxConfig.from_env)

    @property
    def client(self) -> VoltageParkClient:
        return self._lazy_provider_client(VoltageParkClient)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        vm_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        config_id = (request.instance_type or "").strip()
        if not config_id:
            raise BackendValidationError(
                "Voltage Park requires an instance_type (an instant-deploy preset "
                "id). Call sandbox.options, or sandbox.request without an "
                "instance_type, to see live presets, then pick one."
            )
        self._notify(on_phase, "checking_capacity", config_id)
        option = self._resolve_preset(
            config_id=config_id,
            region=(request.region or "").strip(),
            requested_gpu=request.gpu,
        )

        vm_id = ""
        try:
            self._notify(on_phase, "creating", f"preset {config_id}")
            workdir = self._sandbox_workdir(request)
            bootstrap = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=VOLTAGE_PARK_APT_PACKAGES,
            )
            vm_id = self.client.create_instant_vm(
                config_id=config_id,
                name=vm_name,
                # Per-deploy raw public keys; the bootstrap re-authorizes both
                # for root + the management principal.
                ssh_keys=[
                    key
                    for key in (request.public_key, request.management_public_key)
                    if key
                ],
                cloud_init=_bootstrap_cloud_init(bootstrap),
            )
            self._notify(on_created, vm_id, vm_name)

            self._notify(on_phase, "connecting", "waiting for running VM and ssh")
            vm = self._wait_for_vm(sandbox_id=vm_id)
            host, port = _ssh_endpoint(vm)
            if not host:
                raise BackendUnavailableError(
                    "Voltage Park VM is running without a public IP"
                )
            self._wait_for_ssh(host=host, port=port)
            return ProvisionedSandbox(
                sandbox_id=vm_id,
                ssh_host=host,
                ssh_port=port,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=config_id,
                region=str((option.get("regions") or [""])[0]),
                # Live rate when reported; both unknown stays None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_vm_hourly_rate(vm)
                or _float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if vm_id:
                with suppress(Exception):
                    self.client.delete_vm(vm_id)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_vm(sandbox_id)

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(resource.get("public_ip"))

    def terminate(self, *, sandbox_id: str) -> bool:
        return self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.delete_vm
        )

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_instant_locations())

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
        """Live menu of instant-deploy presets (H100-only on-demand fleet)."""
        options = to_agent_options(
            self.client.list_instant_locations(),
            gpu=gpu,
            region=region,
            only_available=True,
        )
        return self._selection_catalog(
            reason=(
                "Voltage Park sells fixed instant-deploy presets (H100 SXM5 "
                "machines in 1/2/4/8-GPU shapes); pick one options[].instance_type "
                "(a preset id)."
            ),
            options=options,
        )

    def _resolve_preset(
        self, *, config_id: str, region: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        options = to_agent_options(
            self.client.list_instant_locations(), only_available=False
        )
        option = find_option(options, instance_type=config_id)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise BackendValidationError(
                f"Voltage Park preset is not offered: {config_id}. Offered: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match Voltage Park preset "
                f"{config_id} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        if region and region not in (option.get("regions") or []):
            where = ", ".join(option.get("regions") or []) or "(no locations)"
            raise CapacityUnavailableError(
                f"Voltage Park preset {config_id} has no capacity in {region}. "
                f"Locations with capacity now: {where}."
            )
        if not option.get("available"):
            raise CapacityUnavailableError(
                f"Voltage Park preset {config_id} has no available VMs right now. "
                "Call sandbox.options to pick an available preset."
            )
        return option


def _bootstrap_cloud_init(bootstrap: str) -> dict[str, Any]:
    """Wrap the bash bootstrap in the instant API's structured cloud-init."""
    return {
        "write_files": [
            {
                "path": BOOTSTRAP_PATH,
                "content": base64.b64encode(bootstrap.encode("utf-8")).decode("ascii"),
                "encoding": "b64",
                "permissions": "0755",
                "owner": "root:root",
            }
        ],
        "runcmd": [f"bash {BOOTSTRAP_PATH}"],
    }


def _ssh_endpoint(vm: dict[str, Any]) -> tuple[str, int]:
    """Public IP + SSH port; a port forward for internal 22 wins when present."""
    host = str(vm.get("public_ip") or "")
    for forward in vm.get("port_forwards") or []:
        if isinstance(forward, dict) and int(forward.get("internal_port") or 0) == 22:
            external = int(forward.get("external_port") or 0)
            if external:
                return host, external
    return host, 22


def _vm_hourly_rate(vm: dict[str, Any]) -> float:
    pricing = vm.get("pricing")
    if not isinstance(pricing, dict):
        return 0.0
    try:
        return float(pricing.get("total_associated_per_hr") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def build_voltage_park_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> VoltageParkSandboxBackend:
    # Lazy: the token resolves at call time, not construction.
    return VoltageParkSandboxBackend()
