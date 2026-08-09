# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Verda Sandbox adapter."""

from __future__ import annotations

import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any
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
    _float_or_zero,
    _http_base_url,
    _int_or_zero,
    _norm,
    _vm_name as _sandbox_name,
    find_option,
    price_sort_key,
    request_json,
)


# Configuration

# Pinned to the datacrunch.io host: the verda.com rename is mid-migration and
# the API answers on both; datacrunch.io is the documented stable base today.
DEFAULT_BASE_URL = "https://api.datacrunch.io"
DEFAULT_IMAGE = "ubuntu-24.04"
DEFAULT_SSH_USER = "root"
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class VerdaCloudConfig:
    client_id: str
    client_secret: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "VerdaCloudConfig":
        client_id = _first_env("MERV_VERDA_CLIENT_ID", "DATACRUNCH_CLIENT_ID")
        client_secret = _first_env(
            "MERV_VERDA_CLIENT_SECRET", "DATACRUNCH_CLIENT_SECRET"
        )
        if not client_id or not client_secret:
            raise BackendValidationError(
                "Verda OAuth2 credentials are required; set "
                "MERV_VERDA_CLIENT_ID and MERV_VERDA_CLIENT_SECRET "
                "(DATACRUNCH_* variants also accepted)"
            )
        return cls(
            client_id=client_id,
            client_secret=client_secret,
            base_url=_http_base_url("MERV_VERDA_API_BASE", DEFAULT_BASE_URL),
        )


@dataclass(frozen=True)
class VerdaSandboxConfig:
    cloud: VerdaCloudConfig
    image: str = DEFAULT_IMAGE
    location_code: str = ""
    instance_type: str = ""
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "VerdaSandboxConfig":
        return cls(
            cloud=VerdaCloudConfig.from_env(),
            image=(env_value("MERV_VERDA_IMAGE") or DEFAULT_IMAGE).strip(),
            location_code=(env_value("MERV_VERDA_LOCATION") or "").strip(),
            instance_type=(env_value("MERV_VERDA_INSTANCE_TYPE") or "").strip(),
            ssh_user=(env_value("MERV_VERDA_SSH_USER") or DEFAULT_SSH_USER).strip()
            or DEFAULT_SSH_USER,
        )


# Hardware catalog

def to_agent_options(
    instance_types: list[dict[str, Any]],
    availability: list[dict[str, Any]],
    *,
    gpu: str | None = None,
    region: str | None = None,
    only_available: bool = True,
) -> list[dict[str, Any]]:
    locations_by_type: dict[str, list[str]] = {}
    for entry in availability:
        location = str(entry.get("location_code") or "")
        for name in entry.get("availabilities", []) or []:
            locations_by_type.setdefault(str(name), []).append(location)

    gpu_filter = _norm(gpu)
    region_filter = _norm(region)
    options: list[dict[str, Any]] = []
    for item in instance_types:
        name = str(item.get("instance_type") or "")
        if not name:
            continue
        regions = sorted(locations_by_type.get(name, []))
        available = bool(regions)
        model = str(item.get("model") or "")
        gpu_obj = item.get("gpu") if isinstance(item.get("gpu"), dict) else {}
        cpu_obj = item.get("cpu") if isinstance(item.get("cpu"), dict) else {}
        memory_obj = item.get("memory") if isinstance(item.get("memory"), dict) else {}
        if only_available and not available:
            continue
        if region_filter and region_filter not in {r.lower() for r in regions}:
            continue
        if gpu_filter and gpu_filter not in _norm(model) and gpu_filter not in _norm(name):
            continue
        options.append(
            {
                "instance_type": name,
                "gpu": model,
                "gpu_description": str(gpu_obj.get("description") or model),
                "gpu_count": _int_or_zero(gpu_obj.get("number_of_gpus")),
                "vcpus": _int_or_zero(cpu_obj.get("number_of_cores")),
                "memory_gib": _int_or_zero(memory_obj.get("size_in_gigabytes")),
                "storage_gib": 0,  # Verda OS volumes are sized at deploy, not by SKU
                # Absent/garbled $/hr stays unknown rather than becoming free.
                "price_usd_per_hour": _float_or_none(item.get("price_per_hour")),
                "regions": regions,
                "available": available,
            }
        )
    options.sort(key=price_sort_key)
    return options


# Provider API client

# Refresh this many seconds before the token's stated expiry.
TOKEN_EXPIRY_SLACK_SECONDS = 60.0


class VerdaClient:
    def __init__(
        self, *, config: VerdaCloudConfig | None = None, timeout: float = 60.0
    ) -> None:
        self.config = config or VerdaCloudConfig.from_env()
        self.timeout = timeout
        self._token = ""
        self._token_expires_at = 0.0

    def list_instance_types(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/v1/instance-types")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Verda returned malformed instance-types data")
        return [item for item in raw if isinstance(item, dict)]

    def list_availability(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/v1/instance-availability")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Verda returned malformed availability data")
        return [item for item in raw if isinstance(item, dict)]

    def add_ssh_key(self, *, name: str, key: str) -> str:
        raw = self._request("POST", "/v1/ssh-keys", body={"name": name, "key": key})
        if not isinstance(raw, str) or not raw:
            raise BackendUnavailableError("Verda returned no SSH key id")
        return raw

    def list_ssh_keys(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/v1/ssh-keys")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Verda returned malformed SSH keys data")
        return [item for item in raw if isinstance(item, dict)]

    def delete_ssh_key(self, key_id: str) -> None:
        self._request("DELETE", f"/v1/ssh-keys/{key_id}")

    def add_script(self, *, name: str, script: str) -> str:
        raw = self._request(
            "POST", "/v1/scripts", body={"name": name, "script": script}
        )
        if not isinstance(raw, str) or not raw:
            raise BackendUnavailableError("Verda returned no startup script id")
        return raw

    def list_scripts(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/v1/scripts")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Verda returned malformed scripts data")
        return [item for item in raw if isinstance(item, dict)]

    def delete_script(self, script_id: str) -> None:
        self._request("DELETE", f"/v1/scripts/{script_id}")

    def deploy_instance(
        self,
        *,
        instance_type: str,
        image: str,
        hostname: str,
        description: str,
        location_code: str,
        ssh_key_ids: list[str],
        startup_script_id: str,
    ) -> str:
        raw = self._request(
            "POST",
            "/v1/instances",
            body={
                "instance_type": instance_type,
                "image": image,
                "hostname": hostname,
                "description": description,
                "location_code": location_code,
                "ssh_key_ids": ssh_key_ids,
                "startup_script_id": startup_script_id,
            },
        )
        # 202 body is the bare instance id as a JSON string.
        if not isinstance(raw, str) or not raw:
            raise BackendUnavailableError("Verda deploy returned no instance id")
        return raw

    def get_instance(self, instance_id: str) -> dict[str, Any]:
        raw = self._request("GET", f"/v1/instances/{instance_id}")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Verda returned malformed instance data")
        return raw

    def list_instances(self) -> list[dict[str, Any]]:
        raw = self._request("GET", "/v1/instances")
        if not isinstance(raw, list):
            raise BackendUnavailableError("Verda returned malformed instances data")
        return [item for item in raw if isinstance(item, dict)]

    def perform_action(self, *, instance_id: str, action: str) -> None:
        self._request(
            "PUT", "/v1/instances", body={"id": instance_id, "action": action}
        )

    # ---------- auth ----------

    def _bearer_token(self, *, force: bool = False) -> str:
        if force or not self._token or time.monotonic() >= self._token_expires_at:
            payload = self._raw_request(
                "POST",
                "/v1/oauth2/token",
                body={
                    "grant_type": "client_credentials",
                    "client_id": self.config.client_id,
                    "client_secret": self.config.client_secret,
                },
                token="",
            )
            if not isinstance(payload, dict) or not payload.get("access_token"):
                raise BackendUnavailableError("Verda OAuth2 returned no access token")
            self._token = str(payload["access_token"])
            expires_in = float(payload.get("expires_in") or 0.0)
            self._token_expires_at = time.monotonic() + max(
                expires_in - TOKEN_EXPIRY_SLACK_SECONDS, 30.0
            )
        return self._token

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> Any:
        try:
            return self._raw_request(method, path, body=body, token=self._bearer_token())
        except BackendUnavailableError as exc:
            if exc.status != 401:
                raise
        # Expired/revoked token: mint a fresh one and replay once.
        return self._raw_request(
            method, path, body=body, token=self._bearer_token(force=True)
        )

    def _raw_request(
        self, method: str, path: str, *, body: dict[str, Any] | None, token: str
    ) -> Any:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "merv/0.0013",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return request_json(
            provider="Verda",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers=headers,
            timeout=self.timeout,
        )


# Sandbox adapter

ACTIVE_INSTANCE_STATUSES = frozenset({"running"})
# "offline" instances still hold (and bill for) their OS volume; only these
# statuses are provably done. "no_capacity"/"installation_failed"/"error" are
# deploy outcomes handled in the wait loop.
TERMINAL_INSTANCE_STATUSES = frozenset({"discontinued", "deleting", "notfound"})
FAILED_DEPLOY_STATUSES = frozenset({"error", "installation_failed"})

VERDA_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)


class VerdaSandboxBackend(VmSshSandboxBackend):
    terminal_statuses = TERMINAL_INSTANCE_STATUSES
    capabilities = BackendCapabilities(
        name="verda",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: VerdaSandboxConfig | None = None,
        client: VerdaClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
    ) -> None:
        super().__init__(ssh_runner=ssh_runner, ssh_input_runner=ssh_input_runner)
        self._config = config
        self._client = client

    @property
    def config(self) -> VerdaSandboxConfig:
        return self._lazy_provider_config(VerdaSandboxConfig.from_env)

    @property
    def client(self) -> VerdaClient:
        return self._lazy_provider_client(VerdaClient)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        instance_name = _sandbox_name(request.sandbox_uid or request.experiment_id)
        instance_type = (request.instance_type or self.config.instance_type or "").strip()
        if not instance_type:
            raise BackendValidationError(
                "Verda requires an instance_type (a fixed GPU + CPU + RAM SKU, "
                "e.g. 1H100.80S.30V). Call sandbox.options, or sandbox.request "
                "without an instance_type, to see live availability, then pick one."
            )
        self._notify(on_phase, "checking_capacity", instance_type)
        option, location = self._resolve_placement(
            instance_type=instance_type,
            location=(request.region or self.config.location_code or "").strip(),
            requested_gpu=request.gpu,
        )

        key_id = ""
        script_id = ""
        instance_id = ""
        try:
            self._notify(on_phase, "registering_ssh_key", f"{instance_name}-key")
            key_id = self.client.add_ssh_key(
                name=f"{instance_name}-key", key=request.public_key
            )

            workdir = self._sandbox_workdir(request)
            script = self._standard_user_data(
                request=request,
                workdir=workdir,
                apt_packages=VERDA_APT_PACKAGES,
            )
            script_id = self.client.add_script(
                name=f"{instance_name}-boot", script=script
            )

            self._notify(on_phase, "creating", f"{instance_type} in {location}")
            instance_id = self.client.deploy_instance(
                instance_type=instance_type,
                image=self.config.image,
                hostname=instance_name,
                description=instance_name,
                location_code=location,
                ssh_key_ids=[key_id],
                startup_script_id=script_id,
            )
            self._notify(on_created, instance_id, instance_name)

            self._notify(on_phase, "connecting", "waiting for running instance and ssh")
            instance = self._wait_for_running_instance(instance_id=instance_id)
            ip = str(instance.get("ip") or "")
            if not ip:
                raise BackendUnavailableError("Verda instance is running without an IP")
            self._wait_for_ssh(host=ip)
            return ProvisionedSandbox(
                sandbox_id=instance_id,
                ssh_host=ip,
                ssh_port=22,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option.get("vcpus") or 0) or None,
                memory=(int(option.get("memory_gib") or 0) * 1024) or None,
                instance_type=instance_type,
                region=location,
                # Prefer the live per-instance quote (spot/dynamic pricing);
                # both unknown stays None so the ledger records price_known=0
                # instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_zero(instance.get("price_per_hour"))
                or _float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if instance_id:
                with suppress(Exception):
                    self.client.perform_action(instance_id=instance_id, action="delete")
            for cleanup, resource_id in (
                (self.client.delete_script, script_id),
                (self.client.delete_ssh_key, key_id),
            ):
                if resource_id:
                    with suppress(Exception):
                        cleanup(resource_id)
            raise

    def _get_resource(self, sandbox_id: str) -> dict[str, Any]:
        return self.client.get_instance(sandbox_id)

    def terminate(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        try:
            self.client.perform_action(instance_id=sandbox_id, action="delete")
        except BackendUnavailableError as exc:
            if exc.status != 404:  # 404 = already gone; that IS terminated
                return False
        except Exception:  # noqa: BLE001
            return False
        self._delete_rp_resources(sandbox_id=sandbox_id)
        return True

    def health(self) -> dict:
        return self._probe_health(lambda: self.client.list_instance_types())

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        return self._find_named_resource_id(
            name=_sandbox_name(sandbox_uid or experiment_id),
            resources=self.client.list_instances(),
            name_field="hostname",
        )

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        """Live menu of deployable Verda SKUs with current pricing."""
        options = to_agent_options(
            self.client.list_instance_types(),
            self.client.list_availability(),
            gpu=gpu,
            region=region,
            only_available=True,
        )
        return self._selection_catalog(
            reason=(
                "Verda (DataCrunch) bundles GPU, CPU, and RAM into fixed instance "
                "types; pick one instance_type. Billing rounds up to 10-minute "
                "increments."
            ),
            options=options,
        )

    def _resolve_placement(
        self, *, instance_type: str, location: str, requested_gpu: str | None
    ) -> tuple[dict[str, Any], str]:
        """Validate the SKU and pick a location with capacity for it now."""
        options = to_agent_options(
            self.client.list_instance_types(),
            self.client.list_availability(),
            only_available=False,
        )
        option = find_option(options, instance_type=instance_type)
        if option is None:
            offered = ", ".join(sorted(o["instance_type"] for o in options)) or "(none)"
            raise BackendValidationError(
                f"Verda instance type is not offered: {instance_type}. "
                f"Offered: {offered}."
            )
        if requested_gpu and requested_gpu.upper() not in str(
            option.get("gpu_description") or ""
        ).upper() and requested_gpu.upper() not in str(option.get("gpu") or "").upper():
            raise BackendValidationError(
                f"requested gpu {requested_gpu} does not match Verda instance type "
                f"{instance_type} ({option.get('gpu_description') or 'unknown GPU'})"
            )
        available = sorted(str(r) for r in option.get("regions", []))
        if location:
            if location not in available:
                where = ", ".join(available) or "(no locations)"
                raise CapacityUnavailableError(
                    f"Verda instance type {instance_type} has no capacity in "
                    f"{location}. Locations with capacity now: {where}."
                )
            chosen = location
        else:
            if not available:
                raise CapacityUnavailableError(
                    f"Verda instance type {instance_type} has no capacity in any "
                    "location. Call sandbox.options to pick an available SKU."
                )
            chosen = available[0]
        return option, chosen

    def _wait_for_running_instance(self, *, instance_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        last_status = ""
        while time.monotonic() < deadline:
            instance = self.client.get_instance(instance_id)
            last_status = str(instance.get("status") or "")
            if last_status in ACTIVE_INSTANCE_STATUSES and instance.get("ip"):
                return instance
            if last_status == "no_capacity":
                raise CapacityUnavailableError(
                    f"Verda ran out of capacity while deploying {instance_id}"
                )
            if last_status in FAILED_DEPLOY_STATUSES | TERMINAL_INSTANCE_STATUSES:
                raise BackendUnavailableError(
                    f"Verda instance {instance_id} reached terminal status {last_status}"
                )
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(
            f"Verda instance {instance_id} did not start before timeout "
            f"(last status: {last_status or 'unknown'})"
        )

    def _delete_rp_resources(self, *, sandbox_id: str) -> None:
        """Drop the rp-named key + script registered for this instance.

        Resolved by name (rp-<uid>-key / rp-<uid>-boot) because the ids are
        only known to the acquire that created them, and terminate may run
        after a daemon restart.
        """
        try:
            instance = self.client.get_instance(sandbox_id)
            hostname = str(instance.get("hostname") or "")
        except Exception:  # noqa: BLE001
            hostname = ""
        if not hostname.startswith("rp-"):
            return
        for lister, deleter, suffix in (
            (self.client.list_ssh_keys, self.client.delete_ssh_key, "-key"),
            (self.client.list_scripts, self.client.delete_script, "-boot"),
        ):
            try:
                resources = lister()
            except Exception:  # noqa: BLE001
                continue
            for resource in resources:
                if str(resource.get("name") or "") == f"{hostname}{suffix}" and resource.get("id"):
                    with suppress(Exception):
                        deleter(str(resource["id"]))


def build_verda_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> VerdaSandboxBackend:
    # Lazy: OAuth2 credentials resolve at call time, not construction.
    return VerdaSandboxBackend()
