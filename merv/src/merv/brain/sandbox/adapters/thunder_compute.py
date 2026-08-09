# If you update this file, you must consult sandbox.md to see whether sandbox.md needs to be updated. sandbox.md must not exceed 100 lines.
"""Thunder Compute Sandbox adapter."""

from __future__ import annotations

import shlex
import subprocess
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit
from ...kernel.env import env_value
from ..remote.bootstrap_tools import BASELINE_APT_PACKAGES, ML_PYTHON_PACKAGES
from ..remote.vm_bootstrap import MGMT_SSH_USER, build_bootstrap_core
from ..remote.vm_ssh import _run_ssh_process, ssh_command, stderr_detail
from ..sandbox_paths import DEFAULT_DATA_DIR, DEFAULT_REMOTE_ROOT, remote_root_of, remote_sessions_dir
from .base import (
    BackendCapabilities,
    BackendUnavailableError,
    BackendValidationError,
    OnCreated,
    OnQuote,
    OnPhase,
    ProvisionedSandbox,
    SandboxRequest,
    SshInputRunner,
    SshRunner,
    VmSshSandboxBackend,
    _absolute_posix_path,
    _float_or_none,
    _int_or_zero,
    _load_env_text,
    _norm,
    _positive_float,
    _positive_int,
    _validate_data_dir,
    bearer_json_headers,
    request_json,
)


# Configuration

DEFAULT_BASE_URL = "https://api.thundercompute.com:8443/v1"
DEFAULT_TEMPLATE = "base"
DEFAULT_SSH_USER = "ubuntu"
DEFAULT_SANDBOX_DATA_DIR = DEFAULT_DATA_DIR
DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS = 900
DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS = 10.0


@dataclass(frozen=True)
class ThunderCloudConfig:
    api_key: str
    base_url: str = DEFAULT_BASE_URL

    @classmethod
    def from_env(cls) -> "ThunderCloudConfig":
        load_thunder_env_file()
        api_key = (
            env_value("MERV_THUNDER_API_KEY")
            or env_value("THUNDER_COMPUTE_API_KEY")
            or env_value("TNR_API_TOKEN")
            or ""
        )
        if not api_key:
            raise BackendValidationError(
                "Thunder Compute API key is required; set "
                "MERV_THUNDER_API_KEY, THUNDER_COMPUTE_API_KEY, or TNR_API_TOKEN"
            )
        base_url = env_value("MERV_THUNDER_API_BASE") or DEFAULT_BASE_URL
        parsed = urlsplit(base_url)
        if parsed.scheme != "https":
            localhost = parsed.scheme == "http" and parsed.hostname in {
                "localhost",
                "127.0.0.1",
                "::1",
            }
            if not localhost:
                raise BackendValidationError(
                    "MERV_THUNDER_API_BASE must be an HTTPS URL "
                    "(http is only allowed for localhost tests)"
                )
        if not parsed.netloc:
            raise BackendValidationError("MERV_THUNDER_API_BASE must include a host")
        return cls(api_key=api_key, base_url=base_url.rstrip("/"))


@dataclass(frozen=True)
class ThunderSandboxConfig:
    cloud: ThunderCloudConfig
    instance_type_name: str = ""
    template: str = DEFAULT_TEMPLATE
    ssh_user: str = DEFAULT_SSH_USER
    remote_root: str = DEFAULT_REMOTE_ROOT
    sandbox_data_dir: str = DEFAULT_SANDBOX_DATA_DIR
    poll_timeout_seconds: int = DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS
    poll_interval_seconds: float = DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS

    @classmethod
    def from_env(cls) -> "ThunderSandboxConfig":
        cloud = ThunderCloudConfig.from_env()
        remote_root = _absolute_posix_path(
            env_value("MERV_THUNDER_WORKDIR") or DEFAULT_REMOTE_ROOT,
            field="MERV_THUNDER_WORKDIR",
        )
        sandbox_data_dir = _absolute_posix_path(
            env_value("MERV_THUNDER_DATA_DIR") or DEFAULT_SANDBOX_DATA_DIR,
            field="MERV_THUNDER_DATA_DIR",
        )
        _validate_data_dir(
            sandbox_data_dir,
            remote_root=remote_root,
            field="MERV_THUNDER_DATA_DIR",
        )
        return cls(
            cloud=cloud,
            instance_type_name=env_value("MERV_THUNDER_INSTANCE_TYPE") or "",
            template=env_value("MERV_THUNDER_TEMPLATE") or DEFAULT_TEMPLATE,
            ssh_user=env_value("MERV_THUNDER_SSH_USER") or DEFAULT_SSH_USER,
            remote_root=remote_root,
            sandbox_data_dir=sandbox_data_dir,
            poll_timeout_seconds=_positive_int(
                env_value("MERV_THUNDER_POLL_TIMEOUT")
                or DEFAULT_INSTANCE_POLL_TIMEOUT_SECONDS,
                field="MERV_THUNDER_POLL_TIMEOUT",
            ),
            poll_interval_seconds=_positive_float(
                env_value("MERV_THUNDER_POLL_INTERVAL")
                or DEFAULT_INSTANCE_POLL_INTERVAL_SECONDS,
                field="MERV_THUNDER_POLL_INTERVAL",
            ),
        )


def load_thunder_env_file() -> None:
    """Load Thunder settings from an explicit env file or local checkout .env."""

    configured = env_value("MERV_THUNDER_ENV_FILE")
    if configured:
        path = Path(configured).expanduser()
        if not path.exists():
            raise BackendValidationError(f"MERV_THUNDER_ENV_FILE does not exist: {path}")
    elif (env_value("MERV_MODE") or "").lower() == "control":
        return
    else:
        path = Path(__file__).resolve().parents[7] / ".env"
        if not path.exists():
            return
    _load_env_text(path.read_text())


# Hardware catalog

def summarize_specs(
    specs: dict[str, Any],
    *,
    pricing: dict[str, Any] | None = None,
    template: str,
    gpu: str | None = None,
    mode: str | None = None,
) -> dict[str, Any]:
    gpu_filter = _norm(gpu)
    mode_filter = _norm(mode)
    prices = pricing or {}
    options: list[dict[str, Any]] = []

    for name, raw in sorted(specs.items()):
        if not isinstance(raw, dict):
            continue
        gpu_type = _gpu_type_from_name(name)
        display = str(raw.get("displayName") or gpu_type.upper())
        spec_mode = str(raw.get("mode") or "")
        if mode_filter and mode_filter != _norm(spec_mode):
            continue
        haystack = " ".join((name, gpu_type, display)).lower()
        if gpu_filter and gpu_filter not in haystack:
            continue
        vcpu_options = sorted(
            {
                parsed
                for item in raw.get("vcpuOptions", []) or []
                for parsed in [_int_or_zero(item)]
                if parsed > 0
            }
        )
        if not vcpu_options:
            continue
        storage = raw.get("storageGB") if isinstance(raw.get("storageGB"), dict) else {}
        storage_min = _int_or_zero(storage.get("min")) or 100
        gpu_count = _int_or_zero(raw.get("gpuCount"))
        ram_per_vcpu = _int_or_zero(raw.get("ramPerVCPUGiB"))
        vcpus = vcpu_options[0]
        options.append(
            {
                "instance_type": name,
                "gpu": display,
                "gpu_type": gpu_type,
                "gpu_count": gpu_count,
                "vram_gb": _int_or_zero(raw.get("vramGB")),
                "mode": spec_mode,
                "vcpus": vcpus,
                "vcpu_options": vcpu_options,
                "memory_gib": vcpus * ram_per_vcpu if ram_per_vcpu else 0,
                "storage_gib": storage_min,
                "storage_options_gib": {
                    "min": storage_min,
                    "max": _int_or_zero(storage.get("max")),
                },
                "template": template,
                "price_usd_per_hour": _price_for(name=name, gpu_type=gpu_type, prices=prices),
                "available": True,
            }
        )

    options.sort(
        key=lambda item: (
            # Unpriced is not cheap: those SKUs sort last, not first.
            item.get("price_usd_per_hour") is None,
            float(item.get("price_usd_per_hour") or 0.0),
            int(item.get("gpu_count") or 0),
            int(item.get("vcpus") or 0),
            str(item.get("instance_type") or ""),
        )
    )
    return {
        "provider": "thunder_compute",
        "count": len(options),
        "regions": [],
        "instance_types": options,
    }


def find_option(summary: dict[str, Any], *, instance_type: str) -> dict[str, Any] | None:
    wanted = _norm(instance_type)
    for option in summary.get("instance_types", []):
        if _norm(option.get("instance_type")) == wanted:
            return option
    return None


def _gpu_type_from_name(name: str) -> str:
    marker = "_x"
    if marker in name:
        return name.split(marker, 1)[0]
    return name.split("_", 1)[0]


def _price_for(*, name: str, gpu_type: str, prices: dict[str, Any]) -> float | None:
    """The published $/hr for this SKU, or None when nothing prices it.

    None, never 0.0 — an unpriced SKU that reads as free spends a budget blind.
    """
    for key in (name, gpu_type):
        if key in prices:
            return _float_or_none(prices.get(key))
    return None


# Provider API client

class ThunderComputeClient:
    def __init__(self, *, config: ThunderCloudConfig | None = None, timeout: float = 30.0) -> None:
        self.config = config or ThunderCloudConfig.from_env()
        self.timeout = timeout

    def list_specs(self) -> dict[str, Any]:
        data = self._request("GET", "/specs")
        raw = data.get("specs")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Thunder Compute returned malformed specs data")
        return raw

    def pricing(self) -> dict[str, Any]:
        data = self._request("GET", "/pricing")
        raw = data.get("pricing")
        if not isinstance(raw, dict):
            raise BackendUnavailableError("Thunder Compute returned malformed pricing data")
        return raw

    def list_instances(self) -> dict[str, dict[str, Any]]:
        data = self._request("GET", "/instances/list")
        instances: dict[str, dict[str, Any]] = {}
        for key, item in data.items():
            if isinstance(item, dict):
                row = dict(item)
                row.setdefault("id", str(key))
                instances[str(key)] = row
        return instances

    def create_instance(
        self,
        *,
        cpu_cores: int,
        disk_size_gb: int,
        gpu_type: str,
        mode: str,
        num_gpus: int,
        template: str,
        public_key: str,
    ) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/instances/create",
            body={
                "cpu_cores": int(cpu_cores),
                "disk_size_gb": int(disk_size_gb),
                "gpu_type": gpu_type,
                "mode": mode,
                "num_gpus": int(num_gpus),
                "template": template,
                "public_key": public_key,
            },
        )
        if not isinstance(data.get("identifier"), int) or not data.get("uuid"):
            raise BackendUnavailableError("Thunder Compute create returned no instance identifier")
        return data

    def delete_instance(self, instance_id: str) -> None:
        self._request("POST", f"/instances/{instance_id}/delete")

    def _request(
        self, method: str, path: str, *, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return request_json(
            provider="Thunder Compute",
            method=method,
            base_url=self.config.base_url,
            path=path,
            body=body,
            headers=bearer_json_headers(self.config.api_key, "merv/0.0005"),
            timeout=self.timeout,
            require_object=True,
            report_http_status=False,
        )


# Sandbox adapter

BOOTSTRAP_SSH_TIMEOUT_SECONDS = 900
ACTIVE_INSTANCE_STATUSES = frozenset({"running"})
LIVE_INSTANCE_STATUSES = frozenset({"starting", "running"})
TERMINAL_INSTANCE_STATUSES = frozenset({"terminated", "terminating", "stopped", "failed"})

THUNDER_APT_PACKAGES: tuple[str, ...] = (
    "openssh-server",
    "ca-certificates",
    *BASELINE_APT_PACKAGES,
)

BootstrapRunner = Callable[[list[str], str, int], "subprocess.CompletedProcess[str]"]


class ThunderComputeSandboxBackend(VmSshSandboxBackend):
    capabilities = BackendCapabilities(
        name="thunder_compute",
        lifetime_extension_supported=True,
        requires_hardware_selection=True,
        configurable_resources=False,
    )

    def __init__(
        self,
        *,
        config: ThunderSandboxConfig | None = None,
        client: ThunderComputeClient | None = None,
        ssh_runner: SshRunner | None = None,
        ssh_input_runner: SshInputRunner | None = None,
        bootstrap_runner: BootstrapRunner | None = None,
    ) -> None:
        super().__init__(
            ssh_runner=ssh_runner,
            ssh_input_runner=ssh_input_runner,
        )
        self._config = config
        self._client = client
        self._bootstrap_runner = bootstrap_runner or _run_bootstrap

    @property
    def config(self) -> ThunderSandboxConfig:
        return self._lazy_provider_config(ThunderSandboxConfig.from_env)

    @property
    def client(self) -> ThunderComputeClient:
        return self._lazy_provider_client(ThunderComputeClient)

    def acquire(
        self,
        *,
        request: SandboxRequest,
        on_phase: OnPhase | None = None,
        on_created: OnCreated | None = None,
        on_quote: OnQuote | None = None,
    ) -> ProvisionedSandbox:
        instance_type = (request.instance_type or self.config.instance_type_name or "").strip()
        if not instance_type:
            raise BackendValidationError(
                "Thunder Compute requires an instance_type. Call sandbox.options, "
                "or sandbox.request without an instance_type, to see available specs."
            )
        if not request.management_public_key or not request.management_key_path:
            raise BackendValidationError("Thunder Compute requires a management SSH key")
        self._notify(on_phase, "checking_capacity", instance_type)
        option = self._resolve_option(instance_type=instance_type, requested_gpu=request.gpu)

        instance_id = ""
        instance_uuid = ""
        try:
            self._notify(on_phase, "creating", instance_type)
            created = self.client.create_instance(
                cpu_cores=int(option["vcpus"]),
                disk_size_gb=int(option["storage_gib"]),
                gpu_type=str(option["gpu_type"]),
                mode=str(option["mode"]),
                num_gpus=int(option["gpu_count"]),
                template=str(option.get("template") or self.config.template),
                public_key=request.management_public_key,
            )
            instance_id = str(created["identifier"])
            instance_uuid = str(created.get("uuid") or instance_id)
            self._notify(on_created, instance_id, instance_uuid)

            self._notify(on_phase, "connecting", "waiting for running instance and ssh")
            instance = self._wait_for_running_instance(
                instance_id=instance_id, instance_uuid=instance_uuid, on_phase=on_phase
            )
            host = str(instance.get("ip") or "")
            port = int(instance.get("port") or 22)
            if not host:
                raise BackendUnavailableError("Thunder instance became running without a public IP")

            workdir = self._sandbox_workdir(request)
            self._notify(on_phase, "bootstrapping", "installing sandbox ssh wrapper")
            self._bootstrap_vm(
                host=host,
                port=port,
                request=request,
                workdir=workdir,
                on_phase=on_phase,
            )
            return ProvisionedSandbox(
                sandbox_id=instance_id,
                ssh_host=host,
                ssh_port=port,
                **self._provisioned_vm_fields(workdir=workdir),
                gpu=str(option.get("gpu") or request.gpu or ""),
                cpu=float(option["vcpus"]),
                memory=int(option.get("memory_gib") or 0) * 1024 or None,
                instance_type=instance_type,
                region="",
                # Tri-state: an unpriced catalog option must stay None so the
                # ledger records price_known=0 instead of a "known" $0.00/hr.
                price_usd_per_hour=_float_or_none(option.get("price_usd_per_hour")),
            )
        except Exception:
            if instance_id:
                with suppress(Exception):
                    self.client.delete_instance(instance_id)
            raise

    def is_alive(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        # List directly: an id absent from a successful listing is
        # authoritatively gone; a failed listing propagates so callers don't
        # mistake an API outage for a dead instance.
        instances = self.client.list_instances()
        instance = instances.get(str(sandbox_id))
        if instance is None:
            return False
        return _status(instance) in LIVE_INSTANCE_STATUSES

    def terminate(self, *, sandbox_id: str) -> bool:
        if not sandbox_id:
            return False
        try:
            self.client.delete_instance(sandbox_id)
        except Exception:  # noqa: BLE001
            return False
        return True

    def health(self) -> dict[str, Any]:
        return self._probe_health(lambda: self.client.list_specs())

    def hardware_catalog(
        self, *, gpu: str | None = None, region: str | None = None
    ) -> dict[str, Any]:
        summary = summarize_specs(
            self.client.list_specs(),
            pricing=self.client.pricing(),
            template=self.config.template,
            gpu=gpu,
        )
        options = summary["instance_types"]
        return self._selection_catalog(
            reason=(
                "Thunder Compute exposes fixed GPU specs by instance_type; pick "
                "one option rather than cpu/memory. Region selection is not exposed."
            ),
            regions=[],
            options=options,
        )

    def find_sandbox_id(
        self, *, experiment_id: str, sandbox_uid: str = "", provider: str = ""
    ) -> str | None:
        marker = f"merv-mgmt-{sandbox_uid or experiment_id}"
        # A failed listing propagates: only a successful one that names nothing
        # is authoritative, and the caller must be able to tell the difference.
        instances = self.client.list_instances()
        for fallback_id, row in instances.items():
            if _status(row) not in LIVE_INSTANCE_STATUSES:
                continue
            if _contains_key_comment(row, marker):
                return str(row.get("id") or row.get("identifier") or fallback_id)
        return None

    def _resolve_option(self, *, instance_type: str, requested_gpu: str | None) -> dict[str, Any]:
        summary = summarize_specs(
            self.client.list_specs(),
            pricing=self.client.pricing(),
            template=self.config.template,
        )
        option = find_option(summary, instance_type=instance_type)
        if option is None:
            offered = ", ".join(
                str(item.get("instance_type") or "")
                for item in summary.get("instance_types", [])
            ) or "(none)"
            raise BackendValidationError(
                f"Thunder Compute instance type is not currently offered: {instance_type}. "
                f"Currently offered: {offered}."
            )
        if requested_gpu:
            haystack = " ".join(
                str(option.get(key) or "")
                for key in ("instance_type", "gpu", "gpu_type")
            ).upper()
            if requested_gpu.upper() not in haystack:
                raise BackendValidationError(
                    f"requested gpu {requested_gpu} does not match Thunder instance "
                    f"type {instance_type} ({option.get('gpu') or 'unknown GPU'})"
                )
        return option

    def _wait_for_running_instance(
        self, *, instance_id: str, instance_uuid: str, on_phase: OnPhase | None = None
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        last_status = ""
        while time.monotonic() < deadline:
            instance = self._instance_by_id(instance_id, instance_uuid=instance_uuid)
            last_status = _status(instance)
            self._notify(on_phase, "connecting", f"Thunder instance status: {last_status or 'unknown'}")
            if last_status in ACTIVE_INSTANCE_STATUSES and instance.get("ip"):
                return instance
            if last_status in TERMINAL_INSTANCE_STATUSES:
                raise BackendUnavailableError(
                    f"Thunder instance {instance_id} reached terminal status {last_status}"
                )
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(
            f"Thunder instance {instance_id} did not become running before timeout "
            f"(last status: {last_status or 'unknown'})"
        )

    def _instance_by_id(
        self, instance_id: str, *, instance_uuid: str | None = None
    ) -> dict[str, Any]:
        instances = self.client.list_instances()
        row = instances.get(str(instance_id))
        if row is not None:
            return row
        if instance_uuid:
            for item in instances.values():
                if str(item.get("uuid") or item.get("name") or "") == instance_uuid:
                    return item
        raise BackendUnavailableError(f"Thunder instance not found: {instance_id}")

    def _bootstrap_vm(
        self,
        *,
        host: str,
        port: int,
        request: SandboxRequest,
        workdir: str,
        on_phase: OnPhase | None = None,
    ) -> None:
        script = build_thunder_bootstrap_script(
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
            port=port,
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
                    command,
                    script,
                    BOOTSTRAP_SSH_TIMEOUT_SECONDS,
                )
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
            else:
                if result.returncode == 0:
                    self._wait_for_management_ssh(
                        host=host,
                        port=port,
                        key_path=request.management_key_path,
                        on_phase=on_phase,
                    )
                    return
                last_error = stderr_detail(result)
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(f"Thunder VM bootstrap failed: {last_error}")

    def _wait_for_management_ssh(
        self, *, host: str, port: int, key_path: str, on_phase: OnPhase | None = None
    ) -> None:
        deadline = time.monotonic() + self.config.poll_timeout_seconds
        last_error = ""
        while time.monotonic() < deadline:
            self._notify(on_phase, "bootstrapping", "waiting for management ssh")
            # Rebuild each attempt so the injected runner sees the retry cadence.
            result = self._ssh_runner(
                ssh_command(
                    host=host,
                    port=port,
                    user=MGMT_SSH_USER,
                    key_path=key_path,
                    remote_command="test -x /opt/merv/rec.sh && true",
                )
            )
            if result.returncode == 0:
                return
            last_error = stderr_detail(result)
            time.sleep(self.config.poll_interval_seconds)
        raise BackendUnavailableError(f"Thunder management SSH never became ready: {last_error}")


def build_thunder_bootstrap_script(
    *,
    public_key: str,
    management_public_key: str,
    experiment_id: str,
    workdir: str,
    sessions_dir: str,
    sandbox_data_dir: str,
) -> str:
    apt_packages = " ".join(shlex.quote(pkg) for pkg in THUNDER_APT_PACKAGES)
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


def _status(instance: Mapping[str, Any]) -> str:
    return str(instance.get("status") or "").strip().lower()


def _contains_key_comment(instance: Mapping[str, Any], marker: str) -> bool:
    raw_keys = (
        instance.get("sshPublicKeys")
        or instance.get("ssh_public_keys")
        or instance.get("public_keys")
        or instance.get("publicKey")
        or instance.get("public_key")
    )
    if isinstance(raw_keys, str):
        return marker in raw_keys
    if isinstance(raw_keys, Mapping):
        return any(marker in str(value) for value in raw_keys.values())
    if isinstance(raw_keys, (list, tuple, set)):
        for item in raw_keys:
            if marker in str(item):
                return True
            if isinstance(item, Mapping) and any(marker in str(value) for value in item.values()):
                return True
    return False


def _run_bootstrap(
    command: list[str], script: str, timeout: int
) -> subprocess.CompletedProcess[str]:
    return _run_ssh_process(command, stdin=script, timeout=timeout)


def build_thunder_compute_sandbox_backend(
    *, repo_root: Path | None = None, **_kwargs: Any
) -> ThunderComputeSandboxBackend:
    return ThunderComputeSandboxBackend()
