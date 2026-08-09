# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Digitalocean Sandbox adapter."""

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
    _vm_name as _sandbox_name,
    bearer_json_headers,
    find_option,
    price_sort_key,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://api.digitalocean.com/v2"
# The AI/ML-ready Ubuntu image (NVIDIA drivers preinstalled). Plain Ubuntu
# slugs boot GPU droplets too but ship no drivers; override for CPU sizes.
DEFAULT_IMAGE = "gpu-h100x1-base"
DEFAULT_SSH_USER = "root"
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class DigitalOceanCloudConfig:
    token: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "DigitalOceanCloudConfig":
        return cls(
            token=_required_env(
                "MERV_DIGITALOCEAN_TOKEN",
                "DIGITALOCEAN_TOKEN",
                "DIGITALOCEAN_ACCESS_TOKEN",
                error="DigitalOcean API token is required; set "
                "MERV_DIGITALOCEAN_TOKEN, DIGITALOCEAN_TOKEN, or "
                "DIGITALOCEAN_ACCESS_TOKEN",
            ),
            base_url=_http_base_url("MERV_DIGITALOCEAN_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class DigitalOceanSandboxConfig:
    cloud: DigitalOceanCloudConfig
    image: str = DEFAULT_IMAGE
    region: str = ""
    size: str = ""
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "DigitalOceanSandboxConfig":
        return cls(
            cloud=DigitalOceanCloudConfig.from_env(),
            image=(env_value("MERV_DIGITALOCEAN_IMAGE") or DEFAULT_IMAGE).strip(),
            region=(env_value("MERV_DIGITALOCEAN_REGION") or "").strip(),
            size=(env_value("MERV_DIGITALOCEAN_SIZE") or "").strip(),
            ssh_user=(
                env_value("MERV_DIGITALOCEAN_SSH_USER") or DEFAULT_SSH_USER
            ).strip()
            or DEFAULT_SSH_USER,
        )


# Hardware catalog

def to_agent_options(
    sizes: list[dict[str, Any]],
    *,
    gpu: str | None = None,
    region: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    gpu_filter = _norm(gpu)
    region_filter = _norm(region)
    options: list[dict[str, Any]] = []
    for size in sizes:
        gpu_info = size.get("gpu_info")
        if not isinstance(gpu_info, dict):
            continue
        slug = str(size.get("slug") or "")
        model = _gpu_label(str(gpu_info.get("model") or ""))
        regions = [str(r) for r in size.get("regions", []) or []]
        available = bool(size.get("available")) and bool(regions)
        if only_available and not available:
            continue
        if region_filter and region_filter not in {r.lower() for r in regions}:
            continue
        if gpu_filter and gpu_filter not in _norm(model) and gpu_filter not in _norm(slug):
            continue
        options.append(
            {
                "instance_type": slug,
                "gpu": model,
                "gpu_description": str(size.get("description") or model),
                "gpu_count": _int_or_zero(gpu_info.get("count")),
                "vcpus": _int_or_zero(size.get("vcpus")),
                # DigitalOcean reports droplet memory in MiB.
                "memory_gib": _int_or_zero(size.get("memory")) // 1024,
                "storage_gib": _int_or_zero(size.get("disk")),
                # None, never 0.0: an unpriced SKU must stay unknown so the
                # cost policy fails closed instead of billing "free" hardware.
                "price_usd_per_hour": _float_or_none(size.get("price_hourly")),
                "regions": regions,
                "available": available,
            }
        )
    options.sort(key=price_sort_key)
    return options


def _gpu_label(model: str) -> str:
    """Short GPU label, e.g. 'H100' from 'nvidia_h100'."""
    return model.split("_")[-1].upper() if model else ""


# Provider API client

class DigitalOceanClient:
    def __init__(
        self, *, config: DigitalOceanCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or DigitalOceanCloudConfig.from_env()
        self.timeout = timeout

    def list_sizes(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/sizes?per_page=200").get("sizes")
        if not isinstance(raw, list):
            raise BackendUnavailableError("DigitalOcean returned malformed sizes data")
        return [item for item in raw if isinstance(item, dict)]

    def create_ssh_key(self, *, name: str, public_key: str) -> dict[str, Any]:
        data = self._request(
            "POST", "/account/keys", body={"name": name, "public_key": public_key}
        )
        raw = data.get("ssh_key")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("DigitalOcean returned malformed SSH key data")
        return raw

    def list_ssh_keys(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/account/keys?per_page=200").get("ssh_keys")
        if not isinstance(raw, list):
            raise BackendUnavailableError("DigitalOcean returned malformed SSH keys data")
        return [item for item in raw if isinstance(item, dict)]

    def delete_ssh_key(self, key_id: int | str) -> None:
        self._request("DELETE", f"/account/keys/{key_id}")

    def create_droplet(
        self,
        *,
        name: str,
        region: str,
        size: str,
        image: str,
        ssh_key_ids: list[int | str],
        user_data: str,
    ) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/droplets",
            body={
                "name": name,
                "region": region,
                "size": size,
                "image": image,
                "ssh_keys": ssh_key_ids,
                "user_data": user_data,
                "tags": ["merv-sandbox"],
            },
        )
        raw = data.get("droplet")
        if not isinstance(raw, dict) or not raw.get("id"):
            raise BackendUnavailableError("DigitalOcean create returned no droplet")
        return raw

    def list_droplets(self) -> list[dict[str, Any]]:
        raw = self._request(
            "GET", "/droplets?per_page=200&tag_name=merv-sandbox"
        ).get("droplets")
        if not isinstance(raw, list):
            raise BackendUnavailableError("DigitalOcean returned malformed droplets data")
        return [item for item in raw if isinstance(item, dict)]

    def get_droplet(self, droplet_id: str) -> dict[str, Any]:
        raw = self._request("GET", f"/droplets/{droplet_id}").get("droplet")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("DigitalOcean returned malformed droplet data")
        return raw

    def delete_droplet(self, droplet_id: str) -> None:
        self._request("DELETE", f"/droplets/{droplet_id}")

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return request_json(
            provider="DigitalOcean",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers=bearer_json_headers(self.config.token, "merv/0.0013"),
            timeout=self.timeout,
            require_object=True,
        )


# Sandbox adapter

ACTIVE_DROPLET_STATUSES = frozenset({"active"})
# "off" droplets still bill; only "archive" (and 404) mean gone.
LIVE_DROPLET_STATUSES = frozenset({"new", "active", "off"})

# The droplet API rejects user_data over 64 KiB.
USER_DATA_MAX_BYTES = 64 * 1024

DIGITALOCEAN_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)


class DigitalOceanSandboxBackend(VmSshSandboxBackend):
    resource_label = "DigitalOcean droplet"
    live_statuses = LIVE_DROPLET_STATUSES
    ready_statuses = ACTIVE_DROPLET_STATUSES
    terminal_statuses = frozenset({"archive"})
    capabilities = BackendCapabilities(
        name="digitalocean",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: DigitalOceanSandboxConfig | None = None,
        client: DigitalOceanClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> DigitalOceanSandboxConfig:
        return self._lazy_provider_config(DigitalOceanSandboxConfig.from_env)

    @property
    def client(self) -> DigitalOceanClient:
        return self._lazy_provider_client(DigitalOceanClient)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        droplet_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        size = (request.instance_type or self.config.size or "").strip()
        if not size:
            raise BackendValidationError(
                "DigitalOcean requires an instance_type (a GPU droplet size slug). "
                "Call sandbox.options, or sandbox.request without an instance_type, "
                "to see the available GPU sizes, then pick one."
            )
        self._notify(on_phase, "checking_capacity", size)
        option, region = self._resolve_placement(
            size=size,
            region=(request.region or self.config.region or "").strip(),
            requested_gpu=request.gpu,
        )

        key_id: int | str = ""
        droplet_id = ""
        try:
            self._notify(on_phase, "registering_ssh_key", f"{droplet_name}-key")
            key_id = self._ensure_ssh_key(
                name=f"{droplet_name}-key", public_key=request.public_key
            )

            self._notify(on_phase, "creating", f"{size} in {region}")
            workdir = self._sandbox_workdir(request)
            user_data = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=DIGITALOCEAN_APT_PACKAGES,
            )
            if len(user_data.encode("utf-8")) > USER_DATA_MAX_BYTES:
                raise BackendValidationError(
                    "DigitalOcean user_data exceeds the 64 KiB droplet limit"
                )
            droplet = self.client.create_droplet(
                name=droplet_name,
                region=region,
                size=size,
                image=self.config.image,
                ssh_key_ids=[key_id],
                user_data=user_data,
            )
            droplet_id = str(droplet["id"])
            self._notify(on_created, droplet_id, droplet_name)

            self._notify(on_phase, "connecting", "waiting for active droplet and ssh")
            droplet = self._wait_for_vm(sandbox_id=droplet_id)
            ip = _public_ipv4(droplet)
            if not ip:
                raise BackendUnavailableError(
                    "DigitalOcean droplet became active without a public IPv4"
                )
            self._wait_for_ssh(host=ip)
            return ProvisionedSandbox(
                sandbox_id=droplet_id,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=size,
                region=region,
                # Tri-state: an unpriced catalog option must stay None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if droplet_id:
                with suppress(Exception):
                    self.client.delete_droplet(droplet_id)
            if key_id:
                with suppress(Exception):
                    self.client.delete_ssh_key(key_id)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_droplet(sandbox_id)

    def _resource_is_addressable(self, resource: Mapping[str, Any]) -> bool:
        return bool(_public_ipv4(dict(resource)))

    def terminate(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        key_ids = self._ssh_key_ids_for_droplet(sandbox_id=sandbox_id)
        if not self._delete_with_404(
            sandbox_id=sandbox_id, delete=self.client.delete_droplet
        ):
            return False
        for key_id in key_ids:
            with suppress(Exception):
                self.client.delete_ssh_key(key_id)
        return True

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_sizes())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        return self._find_named_resource_id(
            name=_sandbox_name(sandbox_uid or experiment_id),
            resources=self.client.list_droplets(),
        )

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """Menu of the GPU droplet sizes the account can currently see."""
        options = to_agent_options(
            self.client.list_sizes(), gpu=gpu, region=region, only_available=True
        )
        reason = (
            "DigitalOcean GPU droplets bundle GPU, CPU, and RAM into fixed size "
            "slugs; pick one instance_type. Destroyed droplets stop billing — "
            "powered-off ones do not."
        )
        if not options:
            reason += (
                " No GPU sizes are visible to this account: GPU droplet access "
                "usually needs a one-time unlock — request it in the DigitalOcean "
                "console under Create > GPU Droplets."
            )
        return self._selection_catalog(
            reason=reason,
            options=options,
        )

    def _resolve_placement(
        self, *, size: str, region: str, requested_gpu: str | None
    ) -> tuple[dict[str, Any], str]:
        """Validate the size + pick a region with the size on offer."""
        options = to_agent_options(self.client.list_sizes(), only_available=False)
        option = find_option(options, instance_type=size)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or (
                "(none visible — the account may need the GPU droplet unlock)"
            )
            raise BackendValidationError(
                f"DigitalOcean size is not available to this account: {size}. "
                f"GPU sizes visible now: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() != str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match DigitalOcean size "
                f"{size} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        available_regions = sorted(str(r) for r in option.get("regions", []))
        if region:
            if region not in available_regions:
                where = ", ".join(available_regions) or "(no regions)"
                raise CapacityUnavailableError(
                    f"DigitalOcean size {size} is not offered in {region}. "
                    f"Regions offering it now: {where}."
                )
            chosen = region
        else:
            if not available_regions or not option.get("available"):
                raise CapacityUnavailableError(
                    f"DigitalOcean size {size} has no availability right now. "
                    "Call sandbox.options to pick an available size."
                )
            chosen = available_regions[0]
        return option, chosen

    def _ensure_ssh_key(self, *, name: str, public_key: str) -> int | str:
        """Register the caller key; reuse the account's copy when it exists.

        DigitalOcean dedupes keys by fingerprint (422 on re-upload), so a
        re-registered caller key resolves to the already-stored id.
        """
        try:
            return self.client.create_ssh_key(name=name, public_key=public_key)["id"]
        except BackendUnavailableError as exc:
            if exc.status != 422:
                raise
        wanted = " ".join(public_key.split()[:2])
        for key in self.client.list_ssh_keys():
            stored = " ".join(str(key.get("public_key") or "").split()[:2])
            if stored == wanted and key.get("id"):
                return key["id"]
        raise BackendUnavailableError(
            "DigitalOcean rejected the SSH key as a duplicate but no matching "
            "stored key was found"
        )

    def _ssh_key_ids_for_droplet(self, *, sandbox_id: str) -> list[int | str]:
        """The rp-named key registered for this droplet, resolved by name."""
        try:
            droplet = self.client.get_droplet(sandbox_id)
        except Exception:  # noqa: BLE001
            return []
        name = f"{droplet.get('name')}-key"
        if not str(droplet.get("name") or "").startswith("rp-"):
            return []
        try:
            keys = self.client.list_ssh_keys()
        except Exception:  # noqa: BLE001
            return []
        return [key["id"] for key in keys if key.get("name") == name and key.get("id")]


def _public_ipv4(droplet: dict[str, Any]) -> str:
    networks = droplet.get("networks")
    v4 = networks.get("v4") if isinstance(networks, dict) else None
    for entry in v4 or []:
        if isinstance(entry, dict) and entry.get("type") == "public":
            return str(entry.get("ip_address") or "")
    return ""


def build_digitalocean_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> DigitalOceanSandboxBackend:
    # Lazy: the token resolves at call time, not construction.
    return DigitalOceanSandboxBackend()
