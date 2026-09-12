"""MCP tool contracts for the merv-sandboxes service.

Infrastructure owns the schema of every ``sandbox.*`` and ``storage.*`` call;
ids of research targets ride through them as opaque strings.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from merv.shared.storage_guidance import STORAGE_RULE_OF_THUMB
from merv.shared.tool_validation import validate_openssh_public_key

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract
from .sandboxes import MAX_WAIT_SECONDS


class StoragePutObjectInput(ProjectScopedInput):
    name: str
    kind: Literal["dataset", "model", "other"]
    sha256: str
    size_bytes: int = Field(ge=0)
    content_type: str = "application/octet-stream"
    producing_experiment_id: str = ""
    producing_run: str = ""
    source_uri: str = ""
    notes: str = ""


class StorageSubmitInput(ProjectScopedInput):
    path: str = Field(description="Local file to upload; embedded in the returned `curl -T` command and the default name.")
    kind: Literal["dataset", "model", "other"]
    sha256: str = Field(description="Client-computed hex SHA-256 of the file; re-verified on completion.")
    size_bytes: int = Field(ge=0)
    name: str = Field(default="", description="Object name; defaults to the path.")
    content_type: str = ""
    producing_experiment_id: str = ""
    producing_run: str = ""
    source_uri: str = ""
    notes: str = ""

    @field_validator("content_type")
    @classmethod
    def _content_type_has_no_control_chars(cls, value: str) -> str:
        # content_type rides into a shell one-liner (shell-quoted there) and an
        # HTTP header; reject control chars so it can never inject a header line
        # or a raw newline into the returned curl command.
        if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
            raise ValueError("content_type must not contain control characters")
        return value


class StorageCompleteUploadInput(ProjectScopedInput):
    upload_id: str
    parts: list[dict[str, Any]] | None = None

    @field_validator("parts")
    @classmethod
    def _canonicalize_completed_parts(
        cls, value: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]] | None:
        if value is None:
            return None
        canonical: list[dict[str, Any]] = []
        for part in value:
            part_number = part.get("part_number", part.get("PartNumber"))
            etag = part.get("etag", part.get("ETag"))
            if part_number is None or etag is None:
                raise ValueError("each completed part needs part_number and etag")
            canonical.append({"part_number": int(part_number), "etag": str(etag)})
        return canonical


class StorageFindInput(ProjectScopedInput):
    """Resolve one object (object_id or name) or, with neither, list the project's objects."""

    object_id: str | None = None
    name: str | None = None
    version: int | None = Field(default=None, ge=1)
    include_download: bool = True
    status: (
        Literal["uploading", "completing", "available", "delete_pending", "deleted"]
        | None
    ) = None
    limit: int | None = Field(default=None, ge=1)
    offset: int = Field(default=0, ge=0)
    compact: bool = False

    @model_validator(mode="after")
    def _check_mode(self) -> "StorageFindInput":
        if self.object_id and self.name:
            raise ValueError("provide at most one of object_id or name")
        if self.version is not None and not (self.object_id or self.name):
            raise ValueError("version selects a resolve target; pass object_id or name")
        return self


class StorageFetchInput(ProjectScopedInput):
    path: str = Field(description="Local destination; embedded in the returned `curl -o` command.")
    object_id: str | None = None
    name: str | None = None
    version: int | None = Field(default=None, ge=1)


class StorageObjectInput(ProjectScopedInput):
    object_id: str
    action: Literal["pin", "renew", "delete"]


class SandboxRequestInput(ProjectScopedInput):
    experiment_id: str | None = Field(default=None, description="Experiment to associate the machine with.")
    instance_type: str | None = Field(default=None, description="An offer's instance_type from sandbox.options.")
    region: str | None = Field(default=None, description="Region filter, e.g. 'east'.")
    provider: str | None = Field(default=None, description="The offer's provider from sandbox.options.")
    gpu: str | None = Field(default=None, description="GPU filter over offers.")
    cpu: float | None = Field(default=None, gt=0, description="Minimum CPUs.")
    memory: int | None = Field(default=None, ge=512, description="Minimum memory in MiB.")
    time_limit: int | None = Field(default=None, ge=60, le=86400, description="Lease seconds, default 3600.")
    public_key: str = Field(description="Your OpenSSH public key; the private key stays local.")
    additional: bool = Field(default=False, description="Rent another machine instead of reusing the experiment's live one.")

    @field_validator("public_key")
    @classmethod
    def _public_key_shape(cls, value: str | None) -> str | None:
        return validate_openssh_public_key(value)


class SandboxOptionsInput(ProjectScopedInput):
    gpu: str | None = Field(default=None, description="GPU filter, e.g. 'H100'.")
    region: str | None = Field(default=None, description="Region filter, e.g. 'east'.")


class SandboxTargetInput(ProjectScopedInput):
    """One sandbox, named by its experiment (primary sandbox) or its uid."""

    experiment_id: str | None = Field(default=None, description="Experiment whose sandbox to address; omit with sandbox_uid.")
    sandbox_uid: str | None = Field(default=None, description="One sandbox; omit for the experiment's primary one.")


SandboxGetInput = SandboxTargetInput


class SandboxAttachInput(ProjectScopedInput):
    experiment_id: str = Field(description="Experiment to attach the sandbox to.")
    sandbox_uid: str = Field(description="A running sandbox rented by another experiment.")


class SandboxPullOutputsInput(SandboxTargetInput):
    paths: list[str] = Field(
        default_factory=list,
        description="Paths under the sandbox experiment dir to rsync; default results/, figures/, report.md, graph.json, metrics.json, results.json.",
    )


class SandboxReleaseInput(SandboxTargetInput):
    confirm_retained: bool = Field(
        default=False,
        description="False returns a retention checklist; true destroys the sandbox and everything on it.",
    )


class SandboxExtendInput(SandboxTargetInput):
    seconds: int = Field(default=1800, ge=1, le=1800, description="Extra lifetime, at most 1800 per call.")


class SandboxRunsInput(SandboxTargetInput):
    wait_seconds: int = Field(
        default=0, ge=0, le=MAX_WAIT_SECONDS,
        description=f"Long-poll up to this many seconds (max {MAX_WAIT_SECONDS}) until any run finishes; 0 answers now.",
    )


class SandboxRunInput(SandboxTargetInput):
    command: str = Field(min_length=1, max_length=65536, description="Shell command to run as a detached job.")
    name: str = Field(default="", max_length=128, description="Job label; derived from the command when empty.")
    cwd: str = Field(default="/workspace", pattern=r"^/", description="Absolute working directory inside the sandbox.")
    timeout_seconds: int = Field(default=0, ge=0, description="0 uses the service default.")
    outputs: str = Field(default="", description="Directory to retain as a job output artifact.")
    idempotency_key: str | None = Field(default=None, max_length=128, description="Retry key; reuse only for the same command and inputs.")
    env: dict[str, str] = Field(default_factory=dict, description="Environment for this job; no secrets.")


class SandboxJobInput(ProjectScopedInput):
    job_id: str = Field(description="From sandbox.run or sandbox.runs.")
    after: str | None = Field(default=None, description="Cursor from the previous status, to long-poll for a change.")
    wait_seconds: int = Field(default=0, ge=0, le=MAX_WAIT_SECONDS)
    cancel: bool = Field(default=False, description="Request cancellation of this job.")
    stream: Literal["stdout", "stderr"] | None = Field(default=None, description="Read a bounded slice of this retained stream.")
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=4096, ge=1, le=1048576, description="Bytes to read from offset.")
    tail: int | None = Field(default=None, ge=1, le=1048576, description="Read only the last N bytes instead of offset/limit.")


class SandboxTerminalInput(SandboxTargetInput):
    tail: int | None = Field(default=None, description="Last N bytes of each stream (default 64 KB in total).")


TOOLS: dict[str, ToolContract] = {
    "storage.put_object": ToolContract(
        handler_identity="storage.put_object",
        visibility="internal",
        feature_requirements=("storage",),
        input_model=StoragePutObjectInput,
        description=f"Create a heavy storage object and return its upload target; the service assigns the version. {STORAGE_RULE_OF_THUMB}",
    ),
    "storage.submit": ToolContract(
        handler_identity="storage.submit",
        feature_requirements=("storage",),
        needs_base_url=True,
        input_model=StorageSubmitInput,
        description=(
            "Register a heavy file and get the one-line `run` command that uploads it; "
            "compute sha256 and size first, then run it verbatim. "
            f"{STORAGE_RULE_OF_THUMB}"
        ),
    ),
    "storage.complete_upload": ToolContract(
        handler_identity="storage.complete_upload",
        visibility="internal",
        feature_requirements=("storage",),
        input_model=StorageCompleteUploadInput,
        description="Complete a storage upload; merv-sandboxes verifies the bytes.",
    ),
    "storage.find": ToolContract(
        handler_identity="storage.find",
        feature_requirements=("storage",),
        input_model=StorageFindInput,
        description=(
            "Resolve one object by object_id or name (include_download adds a presigned URL that renews "
            "retention), or omit both to list objects by status with limit/offset; compact=true for a lean row. "
            "Keep plan, report, graph, scripts and metrics in the repo, not here."
        ),
    ),
    "storage.fetch": ToolContract(
        handler_identity="storage.fetch",
        feature_requirements=("storage",),
        input_model=StorageFetchInput,
        description="Get a one-line `run` command that downloads one object to path and verifies its sha256; execute it verbatim.",
    ),
    "storage.object": ToolContract(
        handler_identity="storage.manage",
        feature_requirements=("storage",),
        input_model=StorageObjectInput,
        description="pin keeps an object permanently, renew extends its retention, delete reclaims the bytes.",
    ),
    "sandbox.request": ToolContract(
        handler_identity="sandboxes.request", input_model=SandboxRequestInput,
        description="Rent a machine: call sandbox.options, pass its provider and instance_type, then poll sandbox.get. An experiment's live machine is reused unless additional=true; to share another experiment's box use sandbox.attach. SSH uses a short-lived certificate.",
    ),
    "sandbox.options": ToolContract(
        handler_identity="sandboxes.options", input_model=SandboxOptionsInput,
        description="List rentable offers; pass one's provider and instance_type to sandbox.request.",
    ),
    "sandbox.get": ToolContract(
        handler_identity="sandboxes.get", input_model=SandboxGetInput,
        description="Read one sandbox: a poll receipt while provisioning, then the facts; ssh{} rides only with a newly issued certificate (save it beside your key, pin the gateway host key). Jobs run in /workspace.",
    ),
    "sandbox.attach": ToolContract(
        handler_identity="sandboxes.attach", input_model=SandboxAttachInput,
        description="Associate a running project sandbox with another experiment; research metadata only.",
    ),
    "sandbox.pull_outputs": ToolContract(
        handler_identity="sandboxes.pull_outputs_command", input_model=SandboxPullOutputsInput,
        description="Return the certificate-SSH rsync command for retaining files from /workspace before release; run it on the caller machine with your key and destination paths.",
    ),
    "sandbox.list": ToolContract(
        handler_identity="sandboxes.list_sandboxes", input_model=ProjectScopedInput,
        description="List the project's sandboxes and their research associations.",
    ),
    "sandbox.release": ToolContract(
        handler_identity="sandboxes.release", input_model=SandboxReleaseInput,
        description="Delete a sandbox after retaining outputs: the first call returns a retention reminder, confirm_retained=true terminates. Poll sandbox.get until terminated; cleanup_pending may still bill.",
    ),
    "sandbox.extend": ToolContract(
        handler_identity="sandboxes.extend", input_model=SandboxExtendInput,
        description="Add up to 30 minutes to the lease, within the service's limits and budget.",
    ),
    "sandbox.run": ToolContract(
        handler_identity="sandboxes.run", input_model=SandboxRunInput,
        description="Start a durable detached job (survives SSH disconnects). Returns job_id, a cursor and the sandbox.job call to wait on it.",
    ),
    "sandbox.job": ToolContract(
        handler_identity="sandboxes.job", input_model=SandboxJobInput,
        description=f"One job: wait for a change (after + wait_seconds, up to {MAX_WAIT_SECONDS}s), read retained output (stream with offset/limit or tail; default 4 KB), or cancel. Readable after release.",
    ),
    "sandbox.runs": ToolContract(
        handler_identity="sandboxes.runs", input_model=SandboxRunsInput,
        description="List the jobs sandbox.run launched for a sandbox or experiment; wait_seconds long-polls until one changes. Use sandbox.job for one job's output.",
    ),
    "sandbox.terminal": ToolContract(
        handler_identity="sandboxes.terminal", input_model=SandboxTerminalInput,
        description="Fresh bounded tail of the latest job's stdout and stderr; sandbox.job reads exact byte ranges or older jobs.",
    ),
    "sandbox.health": ToolContract(
        handler_identity="sandboxes.health",
        visibility="internal",
        input_model=ContractModel,
        description="Check the execution backend is reachable.",
    ),
}
