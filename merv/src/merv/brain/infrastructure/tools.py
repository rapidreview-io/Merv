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
    path: str = Field(
        description=(
            "Local file path to upload. Embedded verbatim into the returned "
            "`curl -T` command (which you run) and the default object name."
        )
    )
    kind: Literal["dataset", "model", "other"]
    sha256: str = Field(
        description=(
            "Client-computed SHA-256 (hex) of the file. Feeds name+sha dedup and "
            "is bound into the presigned checksum; identity is re-verified on "
            "completion."
        )
    )
    size_bytes: int = Field(
        ge=0,
        description="File size in bytes; presigns the upload and enforces the size cap.",
    )
    name: str = Field(
        default="",
        description="Optional storage object name. Defaults to the path.",
    )
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
    """List the project's storage objects, or resolve a single object.

    A union of the former ``storage.list`` and ``storage.resolve`` inputs.
    Passing ``object_id`` or ``name`` (with optional ``version`` /
    ``include_download``) selects resolve mode; omitting both lists the
    objects merv-sandboxes holds, filtered by ``status`` (available by
    default) with ``limit`` / ``offset`` / ``compact`` pagination.
    """

    # Resolve-mode selectors (former storage.resolve).
    object_id: str | None = None
    name: str | None = None
    version: int | None = Field(default=None, ge=1)
    include_download: bool = True
    # List-mode filters (former storage.list).
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
    path: str = Field(
        description=(
            "Local destination path. Embedded verbatim into the returned "
            "`curl -o` command, which you run."
        )
    )
    object_id: str | None = None
    name: str | None = None
    version: int | None = Field(default=None, ge=1)


class StorageObjectInput(ProjectScopedInput):
    object_id: str
    action: Literal["pin", "unpin", "renew", "delete"]


class SandboxRequestInput(ProjectScopedInput):
    experiment_id: str | None = Field(default=None, description="Optional experiment association.")
    instance_type: str | None = Field(default=None, description="Exact options[].instance_type offer ID from sandbox.options.")
    region: str | None = Field(default=None, description="Optional region filter.")
    provider: str | None = Field(default=None, description="Provider name returned by sandbox.options.")
    gpu: str | None = Field(default=None, description="GPU filter for available offers.")
    cpu: float | None = Field(default=None, gt=0, description="Minimum CPU resources.")
    memory: int | None = Field(default=None, ge=512, description="Minimum memory in MiB.")
    time_limit: int | None = Field(default=None, ge=60, le=86400, description="Lease seconds, default 3600.")
    public_key: str = Field(description="Caller OpenSSH public key for short-lived certificate SSH. Keep the private key local.")
    additional: bool = Field(default=False, description="Create an additional machine for this experiment instead of reusing one.")

    @field_validator("public_key")
    @classmethod
    def _public_key_shape(cls, value: str | None) -> str | None:
        return validate_openssh_public_key(value)


class SandboxOptionsInput(ProjectScopedInput):
    gpu: str | None = Field(
        default=None,
        description="Optional GPU filter (e.g. 'H100') over the available machines.",
    )
    region: str | None = Field(
        default=None,
        description="Optional region filter for available capacity.",
    )


class SandboxGetInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Experiment whose live sandbox association should be read. Omit "
            "when sandbox_uid is supplied."
        ),
    )
    sandbox_uid: str | None = Field(
        default=None,
        description="Optional sandbox_uid to read; omitted targets the primary sandbox.",
    )


class SandboxAttachInput(ProjectScopedInput):
    experiment_id: str = Field(
        description="Target experiment to attach the live sandbox to."
    )
    sandbox_uid: str = Field(
        description="Existing running sandbox_uid to associate with the target experiment."
    )


class SandboxPullOutputsInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Experiment whose running sandbox should be copied from. Omit when "
            "sandbox_uid is supplied."
        ),
    )
    sandbox_uid: str | None = Field(
        default=None,
        description="Optional sandbox_uid to copy from; omitted targets the primary sandbox.",
    )
    paths: list[str] = Field(
        default_factory=list,
        description=(
            "Paths under the sandbox experiment_dir to include in the returned "
            "rsync command. Omit to use common retained outputs: results/, "
            "figures/, report.md, graph.json, metrics.json, and results.json."
        ),
    )


class SandboxReleaseInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Experiment whose sandbox(es) should be released. Omit when "
            "terminating a specific sandbox_uid."
        ),
    )
    sandbox_uid: str | None = Field(
        default=None,
        description=(
            "Optional sandbox_uid to terminate just one sandbox. Omit to "
            "terminate all live sandboxes for the experiment."
        ),
    )
    confirm_retained: bool = Field(
        default=False,
        description=(
            "Release permanently destroys the sandbox and everything on it. "
            "The first call without this flag does NOT delete — it returns a "
            "retention checklist. Set true only after you have retained "
            "everything you need (rsync files off the box yourself over SSH, "
            "and use durable heavy-file storage only when that feature is "
            "enabled) to actually terminate."
        ),
    )


class SandboxExtendInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Experiment whose running sandbox should be extended. Omit when "
            "sandbox_uid is supplied."
        ),
    )
    sandbox_uid: str | None = Field(
        default=None,
        description="Optional sandbox_uid to extend; omitted targets the primary sandbox.",
    )
    seconds: int = Field(
        default=1800,
        ge=1,
        le=1800,
        description="Additional lifetime in seconds. Maximum one 30-minute increment per call.",
    )


class SandboxRunsInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Experiment whose sandbox runs to list (spans every sandbox the "
            "experiment used, including released ones). Omit with sandbox_uid."
        ),
    )
    sandbox_uid: str | None = Field(
        default=None,
        description="Optional sandbox_uid to read; omitted targets the experiment's sandboxes.",
    )
    wait_seconds: int = Field(
        default=0,
        ge=0,
        le=300,
        description=(
            "Long-poll: block up to this many seconds, returning early when "
            "any run finishes (or nothing is running). 0 answers immediately. "
            "Keep <=45 unless your MCP client's tool timeout is known to allow "
            "more (many clients cut tool calls at ~60s). This spans only the "
            "current turn: a run that finishes after you end the turn is not "
            "noticed until you next call this."
        ),
    )


class SandboxRunInput(SandboxGetInput):
    command: str = Field(min_length=1, max_length=65536, description="Shell command to run as a durable detached job.")
    name: str = Field(default="", max_length=128, description="Readable job label.")
    cwd: str = Field(default="/workspace", description="Absolute working directory inside the sandbox.")
    timeout_seconds: int = Field(default=0, ge=0, description="Job timeout; zero uses the service default.")
    outputs: str = Field(default="", description="Optional directory to retain as a job output artifact.")
    idempotency_key: str | None = Field(default=None, max_length=128, description="Stable retry key; reuse only for the same command and inputs.")
    env: dict[str, str] = Field(default_factory=dict, description="Environment for this job. Avoid secrets in tool-visible inputs.")


class SandboxJobInput(ProjectScopedInput):
    job_id: str = Field(description="Job ID returned by sandbox.run or sandbox.runs.")
    after: str | None = Field(default=None, description="Cursor from the previous status for long-polling.")
    wait_seconds: int = Field(default=0, ge=0, le=45)
    cancel: bool = Field(default=False, description="Request cancellation of this job.")
    stream: Literal["stdout", "stderr"] | None = Field(default=None, description="Optionally read a bounded slice of retained job output.")
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=65536, ge=1, le=1048576)


class SandboxTerminalInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description="Experiment whose sandbox transcript to read. Omit with sandbox_uid.",
    )
    sandbox_uid: str | None = Field(
        default=None,
        description="Optional sandbox_uid to read; omitted targets the primary sandbox.",
    )
    tail: int | None = Field(
        default=None, description="Return only the last N characters of the transcript."
    )
    since: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Incremental poll: return only transcript characters AFTER this "
            "cursor offset. Pass the 'cursor' from the previous response to get "
            "only new output instead of re-pulling the whole tail."
        ),
    )


TOOLS: dict[str, ToolContract] = {
    "storage.put_object": ToolContract(
        handler_identity="storage.put_object",
        visibility="internal",
        feature_requirements=("storage",),
        input_model=StoragePutObjectInput,
        description=(
            "Create a heavy storage object in merv-sandboxes and return its "
            "upload target. The service assigns the version. "
            f"{STORAGE_RULE_OF_THUMB}"
        ),
    ),
    "storage.submit": ToolContract(
        handler_identity="storage.submit",
        feature_requirements=("storage",),
        input_model=StorageSubmitInput,
        description=(
            "Register a heavy file and get a one-line `run` command to upload it. "
            "Compute the file's sha256 and size, call this, then execute the "
            "returned command verbatim — it PUTs the bytes straight to object "
            "storage and completes the object once merv-sandboxes verifies them "
            "(bytes never pass through the agent context or the brain). Omit "
            "name to use the path; the service assigns the version. "
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
            "Find project storage objects. Pass object_id or name (with optional "
            "version, include_download) to resolve ONE object and, with "
            "include_download=true, a presigned download URL that renews its "
            "retention. Omit both to list objects: filter by status (available "
            "by default), paginate with limit/offset, and pass compact=true for "
            "a lean projection."
        ),
    ),
    "storage.fetch": ToolContract(
        handler_identity="storage.fetch",
        feature_requirements=("storage",),
        input_model=StorageFetchInput,
        description=(
            "Resolve a storage object and get a one-line `run` command to "
            "download it. Pass object_id or name (with optional version), then "
            "execute the returned command verbatim — it curls the bytes to your "
            "path and verifies the stored sha256."
        ),
    ),
    "storage.object": ToolContract(
        handler_identity="storage.manage",
        feature_requirements=("storage",),
        input_model=StorageObjectInput,
        description=(
            "Apply a lifecycle action to one storage object by object_id: pin "
            "(retention removed; kept permanently), renew (extend retention by "
            "the default window), or delete (merv-sandboxes reclaims the bytes). "
            "unpin is refused: service retention only extends, so a pinned "
            "object stays pinned until deleted."
        ),
    ),
    "sandbox.request": ToolContract(
        handler_identity="sandboxes.request", input_model=SandboxRequestInput,
        description="Rent a machine through merv-sandboxes. First call sandbox.options, then pass the selected provider and instance_type. Poll sandbox.get while provisioning. Existing live experiment machines are reused unless additional=true. Caller SSH access uses a short-lived certificate.",
    ),
    "sandbox.options": ToolContract(
        handler_identity="sandboxes.options", input_model=SandboxOptionsInput,
        description="List current rentable offers from the project's configured infrastructure providers.",
    ),
    "sandbox.get": ToolContract(
        handler_identity="sandboxes.get", input_model=SandboxGetInput,
        description="Read sandbox state and refresh caller certificate SSH access. Save the returned certificate beside your local private key and pin the gateway host key. The independent service owns lease and lifecycle state.",
    ),
    "sandbox.attach": ToolContract(
        handler_identity="sandboxes.attach", input_model=SandboxAttachInput,
        description="Associate a running project sandbox with another experiment. This updates research metadata only.",
    ),
    "sandbox.pull_outputs": ToolContract(
        handler_identity="sandboxes.pull_outputs_command", input_model=SandboxPullOutputsInput,
        description="Return a certificate-SSH rsync command for retaining selected files under /workspace before sandbox release. Run the command on the caller machine after substituting local key and destination paths.",
    ),
    "sandbox.list": ToolContract(
        handler_identity="sandboxes.list_sandboxes", input_model=ProjectScopedInput,
        description="List project sandboxes and preserved historical research associations.",
    ),
    "sandbox.release": ToolContract(
        handler_identity="sandboxes.release", input_model=SandboxReleaseInput,
        description="Request deletion after retaining outputs. The first call returns a retention reminder; confirm_retained=true sends deletion to the service. Poll sandbox.get until terminated; cleanup_pending may still bill.",
    ),
    "sandbox.extend": ToolContract(
        handler_identity="sandboxes.extend", input_model=SandboxExtendInput,
        description="Add up to 30 minutes to the sandbox lease, subject to the service's limits and budget.",
    ),
    "sandbox.run": ToolContract(
        handler_identity="sandboxes.run", input_model=SandboxRunInput,
        description="Start a durable detached job through merv-sandboxes. Returns a job ID. Poll sandbox.job for status, bounded stdout/stderr, exit code, and retained results; jobs survive SSH disconnection.",
    ),
    "sandbox.job": ToolContract(
        handler_identity="sandboxes.job", input_model=SandboxJobInput,
        description="Read or cancel a project job. Use after plus wait_seconds to wait for a change, or stream with offset/limit to read bounded retained output. Job status and retained logs remain available after sandbox release.",
    ),
    "sandbox.runs": ToolContract(
        handler_identity="sandboxes.runs", input_model=SandboxRunsInput,
        description="List durable jobs launched with sandbox.run for a sandbox or experiment. SSH commands are not automatically jobs. Use sandbox.job to inspect output or wait for status changes.",
    ),
    "sandbox.terminal": ToolContract(
        handler_identity="sandboxes.terminal", input_model=SandboxTerminalInput,
        description="Read a bounded stdout/stderr snapshot of the latest durable job. replace=true means replace the previous snapshot. Use sandbox.job for exact byte ranges or older jobs; SSH sessions are not recorded.",
    ),
    "sandbox.health": ToolContract(
        handler_identity="sandboxes.health",
        visibility="internal",
        input_model=ContractModel,
        description="Check the execution backend is reachable.",
    ),
}
