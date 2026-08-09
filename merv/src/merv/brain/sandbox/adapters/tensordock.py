# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Tensordock Sandbox adapter."""

from __future__ import annotations

import re
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
    _float_or_zero,
    _http_base_url,
    _int_or_zero,
    _norm,
    _required_env,
    _vm_name as _sandbox_name,
    bearer_json_headers,
    price_sort_key,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://dashboard.tensordock.com/api/v2"
DEFAULT_IMAGE = "ubuntu2404"
# cloud-init runs as root and the bootstrap authorizes root's key; the image
# default user varies by host, so root is the stable principal.
DEFAULT_SSH_USER = "root"
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class TensorDockCloudConfig:
    token: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "TensorDockCloudConfig":
        return cls(
            token=_required_env(
                "MERV_TENSORDOCK_TOKEN",
                "TENSORDOCK_TOKEN",
                error="TensorDock API token is required; set "
                "MERV_TENSORDOCK_TOKEN or TENSORDOCK_TOKEN",
            ),
            base_url=_http_base_url("MERV_TENSORDOCK_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class TensorDockSandboxConfig:
    cloud: TensorDockCloudConfig
    image: str = DEFAULT_IMAGE
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "TensorDockSandboxConfig":
        return cls(
            cloud=TensorDockCloudConfig.from_env(),
            image=(env_value("MERV_TENSORDOCK_IMAGE") or DEFAULT_IMAGE).strip(),
            ssh_user=(env_value("MERV_TENSORDOCK_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
        )


# Hardware catalog

# Deploy shape defaults per GPU (scaled by count, clipped to location maxima).
DEFAULT_VCPUS_PER_GPU = 8
DEFAULT_RAM_GB_PER_GPU = 32
DEFAULT_STORAGE_GB = 100  # TensorDock's minimum
# RAM must land on one of TensorDock's allowed steps.
RAM_GB_STEPS = (2, 4, 6, 8, 10, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 512)

_INSTANCE_TYPE_RE = re.compile(r"^(\d+)x-(.+)$")


def parse_instance_type(instance_type: str) -> tuple[int, str] | None:
    """'2x-h100-sxm5-80gb' -> (2, 'h100-sxm5-80gb'); None when malformed."""
    match = _INSTANCE_TYPE_RE.match(instance_type.strip())
    if not match:
        return None
    return int(match.group(1)), match.group(2)


def deploy_shape(option: dict[str, Any]) -> dict[str, int]:
    """The vcpu/ram/storage the synthesized option deploys with."""
    return {
        "vcpu_count": int(option["vcpus"]),
        "ram_gb": int(option["memory_gib"]),
        "storage_gb": int(option["storage_gib"]),
    }


def to_agent_options(
    locations: list[dict[str, Any]],
    *,
    gpu: str | None = None,
    region: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    gpu_filter = _norm(gpu)
    region_filter = _norm(region)
    options: list[dict[str, Any]] = []
    for location in locations:
        location_id = str(location.get("id") or "")
        if region_filter and region_filter != location_id.lower():
            continue
        place = ", ".join(
            str(part)
            for part in (location.get("city"), location.get("country"))
            if part
        )
        for entry in location.get("gpus", []) or []:
            if not isinstance(entry, dict):
                continue
            features = (
                entry.get("network_features")
                if isinstance(entry.get("network_features"), dict)
                else {}
            )
            # Port-mapped-only hosts are unusable for us: no dedicated IP, no
            # direct SSH contract.
            if not features.get("dedicated_ip_available"):
                continue
            v0_name = str(entry.get("v0Name") or "")
            display = str(entry.get("displayName") or v0_name)
            max_count = _int_or_zero(entry.get("max_count"))
            available = max_count > 0
            if only_available and not available:
                continue
            if gpu_filter and gpu_filter not in _norm(display) and gpu_filter not in _norm(v0_name):
                continue
            resources = (
                entry.get("resources") if isinstance(entry.get("resources"), dict) else {}
            )
            pricing = (
                entry.get("pricing") if isinstance(entry.get("pricing"), dict) else {}
            )
            for count in sorted({1, max_count} if max_count else {1}):
                if count < 1 or count > max(max_count, 1):
                    continue
                vcpus = min(
                    DEFAULT_VCPUS_PER_GPU * count,
                    _int_or_zero(resources.get("max_vcpus")) or DEFAULT_VCPUS_PER_GPU * count,
                )
                vcpus = max(vcpus - (vcpus % 2), 2)  # vCPU steps of 2
                ram = _ram_step(
                    min(
                        DEFAULT_RAM_GB_PER_GPU * count,
                        _int_or_zero(resources.get("max_ram_gb"))
                        or DEFAULT_RAM_GB_PER_GPU * count,
                    )
                )
                storage_cap = _int_or_zero(resources.get("max_storage_gb"))
                if storage_cap and storage_cap < DEFAULT_STORAGE_GB:
                    continue  # cannot meet the 100 GB minimum here
                # The quote is a SUM, so every term has to be known. A missing
                # or malformed component rate coerced to zero is not a partial
                # price — it is a wrong one, quoted low, and it passes the cost
                # ceiling on the strength of the terms that did parse (audit
                # SAN-04). Any unknown term makes the whole option unpriced.
                rates = (
                    _float_or_none(entry.get("price_per_hr")),
                    _float_or_none(pricing.get("per_vcpu_hr")),
                    _float_or_none(pricing.get("per_gb_ram_hr")),
                    _float_or_none(pricing.get("per_gb_storage_hr")),
                )
                gpu_rate, vcpu_rate, ram_rate, storage_rate = rates
                price = (
                    None
                    if any(rate is None for rate in rates)
                    else round(
                        gpu_rate * count
                        + vcpu_rate * vcpus
                        + ram_rate * ram
                        + storage_rate * DEFAULT_STORAGE_GB,
                        4,
                    )
                )
                options.append(
                    {
                        "instance_type": f"{count}x-{v0_name}",
                        "gpu": _gpu_label(v0_name),
                        "gpu_description": f"{count}x {display}" + (f" @ {place}" if place else ""),
                        "gpu_count": count,
                        "vcpus": vcpus,
                        "memory_gib": ram,
                        "storage_gib": DEFAULT_STORAGE_GB,
                        "price_usd_per_hour": price,
                        "regions": [location_id],
                        "available": available,
                    }
                )
    options.sort(key=price_sort_key)
    return options


def find_option(
    options: list[dict[str, Any]],
    *,
    instance_type: str,
    region: str | None = None,
) -> dict[str, Any] | None:
    wanted = _norm(instance_type)
    for option in options:
        if _norm(option.get("instance_type")) != wanted:
            continue
        if region and region not in (option.get("regions") or []):
            continue
        return option
    return None


def _ram_step(ram_gb: int) -> int:
    """Largest allowed RAM step at or below the requested amount."""
    allowed = [step for step in RAM_GB_STEPS if step <= max(ram_gb, RAM_GB_STEPS[0])]
    return allowed[-1] if allowed else RAM_GB_STEPS[0]


def _gpu_label(v0_name: str) -> str:
    """Short GPU label, e.g. 'H100' from 'h100-sxm5-80gb'."""
    return v0_name.split("-")[0].upper() if v0_name else ""


# Provider API client

class TensorDockClient:
    def __init__(
        self, *, config: TensorDockCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or TensorDockCloudConfig.from_env()
        self.timeout = timeout

    def list_locations(self) -> list[dict[str, Any]]:
        raw = _unwrap(self._request("GET", "/locations"))
        locations = raw.get("locations") if isinstance(raw, dict) else raw
        if not isinstance(locations, list):
            raise BackendUnavailableError("TensorDock returned malformed locations data")
        return [item for item in locations if isinstance(item, dict)]

    def create_instance(
        self,
        *,
        name: str,
        image: str,
        location_id: str,
        vcpu_count: int,
        ram_gb: int,
        storage_gb: int,
        gpus: dict[str, dict[str, int]],
        ssh_key: str,
        cloud_init: dict[str, Any],
    ) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/instances",
            body={
                "data": {
                    "type": "virtualmachine",
                    "attributes": {
                        "name": name,
                        "type": "virtualmachine",
                        "image": image,
                        "resources": {
                            "vcpu_count": vcpu_count,
                            "ram_gb": ram_gb,
                            "storage_gb": storage_gb,
                            "gpus": gpus,
                        },
                        "location_id": location_id,
                        # Port-mapped hosts are unusable for direct SSH; the
                        # catalog only offers dedicated-IP-capable locations.
                        "useDedicatedIp": True,
                        "ssh_key": ssh_key,
                        "cloud_init": cloud_init,
                    },
                }
            },
        )
        instance = _unwrap(data)
        if not isinstance(instance, dict) or not instance.get("id"):
            raise BackendUnavailableError("TensorDock create returned no instance id")
        return instance

    def list_instances(self) -> list[dict[str, Any]]:
        raw = _unwrap(self._request("GET", "/instances"))
        instances = raw.get("instances") if isinstance(raw, dict) else raw
        if not isinstance(instances, list):
            raise BackendUnavailableError("TensorDock returned malformed instances data")
        return [item for item in instances if isinstance(item, dict)]

    def get_instance(self, instance_id: str) -> dict[str, Any]:
        raw = _unwrap(self._request("GET", f"/instances/{instance_id}"))
        if not isinstance(raw, dict):
            raise BackendUnavailableError("TensorDock returned malformed instance data")
        return raw

    def delete_instance(self, instance_id: str) -> None:
        self._request("DELETE", f"/instances/{instance_id}")

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> Any:
        return request_json(
            provider="TensorDock",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers=bearer_json_headers(self.config.token, "merv/0.0013"),
            timeout=self.timeout,
        )


def _unwrap(payload: Any) -> Any:
    """Strip the JSON:API ``data`` envelope (and nested ``attributes``) if present."""
    if isinstance(payload, dict) and "data" in payload:
        payload = payload["data"]
    if (
        isinstance(payload, dict)
        and isinstance(payload.get("attributes"), dict)
        and ("id" in payload or "type" in payload)
    ):
        return {**payload["attributes"], "id": payload.get("id"), "type": payload.get("type")}
    return payload


# Sandbox adapter

ACTIVE_INSTANCE_STATUSES = frozenset({"running"})
# Statuses arrive in mixed casing ("running", "Stopped"); compare lowercased.
TERMINAL_INSTANCE_STATUSES = frozenset({"terminated", "deleted"})

TENSORDOCK_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)

BOOTSTRAP_PATH = "/opt/merv/bootstrap.sh"


class TensorDockSandboxBackend(VmSshSandboxBackend):
    resource_label = "TensorDock instance"
    ready_statuses = ACTIVE_INSTANCE_STATUSES
    terminal_statuses = TERMINAL_INSTANCE_STATUSES
    capabilities = BackendCapabilities(
        name="tensordock",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: TensorDockSandboxConfig | None = None,
        client: TensorDockClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> TensorDockSandboxConfig:
        return self._lazy_provider_config(TensorDockSandboxConfig.from_env)

    @property
    def client(self) -> TensorDockClient:
        return self._lazy_provider_client(TensorDockClient)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        vm_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        instance_type = (request.instance_type or "").strip()
        if not instance_type:
            raise BackendValidationError(
                "TensorDock requires an instance_type (e.g. 1x-h100-sxm5-80gb). "
                "Call sandbox.options, or sandbox.request without an instance_type, "
                "to see live availability, then pick one."
            )
        parsed = parse_instance_type(instance_type)
        if parsed is None:
            raise BackendValidationError(
                f"TensorDock instance_type must look like '<count>x-<gpu>' "
                f"(e.g. 1x-h100-sxm5-80gb), got: {instance_type}"
            )
        gpu_count, v0_name = parsed
        self._notify(on_phase, "checking_capacity", instance_type)
        option = self._resolve_option(
            instance_type=instance_type,
            region=(request.region or "").strip(),
            requested_gpu=request.gpu,
        )
        location_id = str((option.get("regions") or [""])[0])
        shape = deploy_shape(option)

        instance_id = ""
        try:
            self._notify(on_phase, "creating", f"{instance_type} in {location_id}")
            workdir = self._sandbox_workdir(request)
            bootstrap = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=TENSORDOCK_APT_PACKAGES,
            )
            instance = self.client.create_instance(
                name=vm_name,
                image=self.config.image,
                location_id=location_id,
                vcpu_count=shape["vcpu_count"],
                ram_gb=shape["ram_gb"],
                storage_gb=shape["storage_gb"],
                gpus={v0_name: {"count": gpu_count}},
                ssh_key=request.public_key,
                # The bootstrap authorizes root + the management principal;
                # cloud-init runs it as root on first boot.
                cloud_init=_bootstrap_cloud_init(bootstrap),
            )
            instance_id = str(instance.get("id") or "")
            self._notify(on_created, instance_id, vm_name)

            self._notify(on_phase, "connecting", "waiting for running VM and ssh")
            instance = self._wait_for_vm(sandbox_id=instance_id)
            host, port = _ssh_endpoint(instance)
            if not host:
                raise BackendUnavailableError(
                    "TensorDock VM is running without an IP address"
                )
            self._wait_for_ssh(host=host, port=port)
            return ProvisionedSandbox(
                sandbox_id=instance_id,
                ssh_host=host,
                ssh_port=port,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(shape["vcpu_count"]),
                memory=shape["ram_gb"] * 1024,
                instance_type=instance_type,
                region=location_id,
                # Live rate once reported; the synthesized estimate otherwise;
                # both unknown stays None so the ledger records price_known=0
                # instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_zero(instance.get("rateHourly"))
                or _float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if instance_id:
                with suppress(Exception):
                    self.client.delete_instance(instance_id)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_instance(sandbox_id)

    def _resource_status(self, resource: Mapping[str, Any]) -> str:
        return str(resource.get("status") or "").lower()

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(_ssh_endpoint(dict(resource))[0])

    def terminate(self, *, sandbox_id: str) -> bool:
        return self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.delete_instance
        )

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_locations())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        name = _sandbox_name(sandbox_uid or experiment_id)
        # A failed listing propagates: only a successful one that names nothing
        # is authoritative, and the caller must be able to tell the difference.
        for instance in self.client.list_instances():
            attributes = (
                instance.get("attributes")
                if isinstance(instance.get("attributes"), dict)
                else instance
            )
            if (
                str(attributes.get("name") or "") == name
                and str(attributes.get("status") or "").lower()
                not in TERMINAL_INSTANCE_STATUSES
            ):
                return str(instance.get("id") or "") or None
        return None

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """Menu of dedicated-IP-capable GPU shapes across marketplace hosts."""
        options = to_agent_options(
            self.client.list_locations(), gpu=gpu, region=region, only_available=True
        )
        return self._selection_catalog(
            reason=(
                "TensorDock composes machines per host; these options are "
                "synthesized GPU shapes (count x model with default vCPU/RAM/"
                "100GB storage) at locations that support DEDICATED public IPs. "
                "Billing is per-second against the prepaid balance."
            ),
            options=options,
        )

    def _resolve_option(
        self, *, instance_type: str, region: str, requested_gpu: str | None
    ) -> dict[str, Any]:
        options = to_agent_options(self.client.list_locations(), only_available=False)
        option = find_option(
            options, instance_type=instance_type, region=region or None
        )
        if option is None:
            offered = ", ".join(sorted({o["instance_type"] for o in options})) or "(none)"
            raise BackendValidationError(
                "TensorDock shape is not offered"
                + (f" in {region}" if region else "")
                + f": {instance_type}. Offered: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match TensorDock shape "
                f"{instance_type} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        if not option.get("available"):
            raise CapacityUnavailableError(
                f"TensorDock shape {instance_type} has no stock right now. "
                "Call sandbox.options to pick an available shape."
            )
        return option


def _bootstrap_cloud_init(bootstrap: str) -> dict[str, Any]:
    """Wrap the bash bootstrap in TensorDock's structured cloud_init.

    TensorDock's write_files documents no encoding option, so the script rides
    as plain content (JSON strings carry newlines fine).
    """
    return {
        "write_files": [
            {
                "path": BOOTSTRAP_PATH,
                "content": bootstrap,
                "owner": "root:root",
                "permissions": "0755",
            }
        ],
        "runcmd": [f"bash {BOOTSTRAP_PATH}"],
    }


def _ssh_endpoint(instance: dict[str, Any]) -> tuple[str, int]:
    """Dedicated IP + 22; an explicit forward for internal 22 wins if present."""
    host = str(instance.get("ipAddress") or "")
    for forward in instance.get("portForwards") or []:
        if isinstance(forward, dict) and int(forward.get("internal_port") or 0) == 22:
            external = int(forward.get("external_port") or 0)
            if external:
                return host, external
    return host, 22


def build_tensordock_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> TensorDockSandboxBackend:
    # Lazy: the token resolves at call time, not construction.
    return TensorDockSandboxBackend()
