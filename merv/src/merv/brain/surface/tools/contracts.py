"""Typed tool contracts shared by MCP and HTTP adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from merv.shared.artifact_roles import ARTIFACT_TARGET_TYPES, SUBMITTABLE_ROLES
from merv.shared.storage_guidance import STORAGE_RULE_OF_THUMB
from merv.shared.tool_validation import validate_openssh_public_key

from ...research_core import (
    EXPERIMENT_TRANSITION_VALUES,
    EXPERIMENT_WORKFLOW,
    REFLECTION_TRANSITION_VALUES,
    REFLECTION_WORKFLOW,
    REVIEW_ROLE_VALUES,
    REVIEW_VERDICT_VALUES,
    TASK_TRANSITION_VALUES,
    TASK_WORKFLOW,
)

REVIEW_RETURN_VALUES = (
    "",
    *EXPERIMENT_WORKFLOW.review_return_statuses,
    *REFLECTION_WORKFLOW.review_return_statuses,
    *TASK_WORKFLOW.review_return_statuses,
    *TASK_WORKFLOW.review_fail_statuses,
)
EXPERIMENT_INITIAL_VALUES = (EXPERIMENT_WORKFLOW.initial,)
REVIEW_TARGET_VALUES = (
    EXPERIMENT_WORKFLOW.target_type,
    REFLECTION_WORKFLOW.target_type,
    TASK_WORKFLOW.target_type,
)
_TASK_REVIEW_RETURN = next(iter(TASK_WORKFLOW.review_returns))
_TASK_FAIL_STATUS = next(iter(TASK_WORKFLOW.review_fail_statuses))
_EXPERIMENT_RESULT_TRANSITION = next(
    transition.name
    for transition in EXPERIMENT_WORKFLOW.transitions
    if "result_submission" in transition.effects
)
_EXPERIMENT_RETRY_TRANSITION = next(
    transition.name
    for transition in EXPERIMENT_WORKFLOW.transitions
    if "record_retry_context" in transition.effects
)
_EXPERIMENT_EXECUTION_STATUS = next(
    iter(EXPERIMENT_WORKFLOW.effect_sources("result_submission"))
)
_EXPERIMENT_PLAN_RETURN = next(
    route for route in EXPERIMENT_WORKFLOW.review_returns if route.attempt == "new"
)
_EXPERIMENT_EXECUTION_RETURN = next(
    route for route in EXPERIMENT_WORKFLOW.review_returns if route.attempt == "same"
)
_REFLECTION_RERUN_RETURN = next(
    route for route in REFLECTION_WORKFLOW.review_returns if route.attempt == "new"
)
_REFLECTION_REVISION_RETURN = next(
    route for route in REFLECTION_WORKFLOW.review_returns if route.attempt == "same"
)
_REFLECTION_INITIAL_STATE = REFLECTION_WORKFLOW.state(REFLECTION_WORKFLOW.initial)
if _REFLECTION_INITIAL_STATE is None:
    raise RuntimeError("reflection workflow is missing its first transition")
_REFLECTION_FIRST_TRANSITION = _REFLECTION_INITIAL_STATE.forward.name
_REFLECTION_PUBLISH_TRANSITION = next(
    transition.name
    for transition in REFLECTION_WORKFLOW.transitions
    if "materialize_change_spec" in transition.effects
)


class ContractModel(BaseModel):
    """Strict boundary model for external tool inputs."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


ToolVisibility = Literal["public", "internal"]
ToolScopeStrategy = Literal["linked-project", "caller-selected", "capability", "none"]
ToolFeature = Literal["storage"]


@dataclass(frozen=True)
class ToolManifest:
    """One tool's complete public contract and routing metadata."""

    input_model: type[ContractModel]
    description: str
    handler_identity: str
    visibility: ToolVisibility = "public"
    scope_strategy: ToolScopeStrategy | None = None
    feature_requirements: tuple[ToolFeature, ...] = ()
    hosted_control_sandbox_lookup: bool = False

    def __post_init__(self) -> None:
        if self.scope_strategy is None:
            inferred: ToolScopeStrategy = (
                "linked-project"
                if issubclass(self.input_model, ProjectScopedInput)
                else "none"
            )
            object.__setattr__(self, "scope_strategy", inferred)


# Compatibility name for code that describes only the schema/description half.
ToolContract = ToolManifest


class EmptyInput(ContractModel):
    pass


class ProjectScopedInput(ContractModel):
    project_id: str = Field(
        description=(
            "Explicit project scope. Discover the id with "
            'project(action="list"), which returns the projects you can work '
            "in with names and dates. A credential bound to a single "
            "project may only pass that one; otherwise pass whichever project "
            "the user is asking about."
        )
    )


class WorkflowStatusAndNextInput(ProjectScopedInput):
    experiment_id: str | None = None
    task_id: str | None = Field(
        default=None,
        description=(
            "Scope the status to one task (task_… id) instead of an experiment; "
            "returns the task's workflow guidance, brief, delivery, and checks."
        ),
    )

    @model_validator(mode="after")
    def _one_scope(self) -> "WorkflowStatusAndNextInput":
        if self.experiment_id and self.task_id:
            raise ValueError("pass experiment_id or task_id, not both")
        return self


class AgentHelloInput(ContractModel):
    """Mint (or confirm) the agent_id this context window carries on every call.

    Kept tiny on purpose: the whole point of the id is that carrying it costs
    the model a handful of tokens per call.
    """

    agent_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Only if this context window already has an agent_id: pass it to "
            "confirm it instead of minting a second one."
        ),
    )
    role: str = Field(
        default="",
        max_length=64,
        description=(
            "Optional self-description: main, subagent, reviewer, lens, worker."
        ),
    )
    parent_agent_id: str = Field(
        default="",
        max_length=64,
        description=(
            "Optional: the agent_id of the context that spawned this one, if "
            "it told you."
        ),
    )
    note: str = Field(
        default="",
        max_length=200,
        description="Optional one-line note about what this context is doing.",
    )


class ProjectInput(ContractModel):
    """The one agent-facing project tool: list / current / create / overview."""

    action: Literal["list", "current", "create", "overview"] = Field(
        description=(
            "list = every project you can work in, with names, summaries, "
            "and creation dates — start here to pick a project_id; "
            "current = the project this credential is bound to, if it is "
            "bound to exactly one; "
            "overview = the canonical bounded project context — latest "
            "published reflection, literature General Summary, every claim "
            "(incl. settled/abandoned), and every experiment (incl. terminal) "
            "with one summary — for orienting or re-grounding; "
            "create = create a project."
        )
    )
    project_id: str = Field(
        default="",
        description="Optional explicit project id for action=overview.",
    )
    name: str = Field(
        default="",
        description=(
            "User-confirmed project name, at least 3 characters. Required for "
            "action=create. Do not infer a placeholder unless the user "
            "explicitly asked for it."
        ),
    )
    summary: str = Field(
        default="",
        description="Short user-confirmed project purpose or scope.",
    )

    @model_validator(mode="after")
    def _check_action(self) -> "ProjectInput":
        if self.action == "list":
            extras = [
                field
                for field in ("project_id", "name", "summary")
                if getattr(self, field)
            ]
            if extras:
                raise ValueError(
                    f"action=list takes no other fields; got {', '.join(extras)}"
                )
        elif self.action in ("current", "overview"):
            # Both default to the project bound to the caller's MCP key;
            # overview also tolerates an explicit project_id.
            forbidden = ["name", "summary"]
            if self.action == "current":
                forbidden = ["project_id", *forbidden]
            extras = [field for field in forbidden if getattr(self, field)]
            if extras:
                raise ValueError(
                    f"action={self.action} takes no other fields; "
                    f"got {', '.join(extras)}"
                )
        elif self.action == "create":
            if len(self.name) < 3:
                raise ValueError("action=create requires name (at least 3 characters)")
        return self


class ProjectUpdateInput(ProjectScopedInput):
    name: str | None = Field(
        default=None,
        description="New project name, at least 3 characters when provided.",
    )
    summary: str | None = None
    require_verified_reviews: bool | None = Field(
        default=None,
        description=(
            "Policy knob: when true, only reviews with verified reviewer "
            "independence (verified_agent_review) satisfy review gates; "
            "attested reviews stop counting. Omit to leave unchanged."
        ),
    )
    agent_dispatch: bool | None = Field(
        default=None,
        description=(
            "Policy knob (off by default): when true, local coding-agent "
            "runners may claim this project's experiments, reviews, and "
            "consolidations automatically. Turning it off stops new claims; "
            "sessions already running keep going until halted. Omit to leave "
            "unchanged."
        ),
    )
    hidden: bool | None = Field(
        default=None,
        description=(
            "Stash a project out of the UI project list without deleting it: "
            "when true, project.list omits it while the project's data and "
            "direct-by-id access are retained; false restores it. Omit to "
            "leave unchanged."
        ),
    )
    storage_max_upload_bytes: int | None = Field(
        default=None,
        gt=0,
        description=(
            "Project Object Storage policy: maximum bytes accepted by "
            "storage.submit. The server-wide maximum remains an upper bound. "
            "Omit to leave unchanged."
        ),
    )


class ProjectGetInput(ProjectScopedInput):
    pass


class CandidateSubmitInput(ProjectScopedInput):
    name: str = Field(min_length=1, max_length=200)
    source_kind: Literal["artifact", "storage_object", "experiment_workspace"]
    source_ref: str = Field(
        min_length=1,
        max_length=500,
        description=(
            "Artifact id, Object Storage id, or experiment id according to "
            "source_kind. Never a filesystem path or URI."
        ),
    )
    expected_sha256: str = Field(
        default="",
        pattern=r"^[0-9a-f]{64}$|^$",
        description=(
            "Optional expected digest for experiment_workspace only. The "
            "evaluator resolves the task-defined path; callers never pass it."
        ),
    )
    metrics: dict[str, float] = Field(min_length=1)
    primary_metric: str
    higher_is_better: bool = True
    validation_summary: str = Field(min_length=1, max_length=4000)
    idempotency_key: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _validate_candidate(self) -> "CandidateSubmitInput":
        if self.source_kind != "experiment_workspace" and self.expected_sha256:
            raise ValueError("expected_sha256 applies only to experiment_workspace")
        if self.primary_metric not in self.metrics:
            raise ValueError("primary_metric must name a value in metrics")
        return self


class CandidateStageInput(ProjectScopedInput):
    candidate_id: str
    stage_kind: Literal["artifact", "storage_object", "evaluator_receipt"]
    stage_ref: str = Field(
        min_length=1,
        max_length=500,
        description="Artifact id, Object Storage id, or evaluator receipt id.",
    )
    content_sha256: str = Field(default="", pattern=r"^[0-9a-f]{64}$|^$")
    manifest_sha256: str = Field(default="", pattern=r"^[0-9a-f]{64}$|^$")

    @model_validator(mode="after")
    def _one_pointer(self) -> "CandidateStageInput":
        if self.stage_kind == "evaluator_receipt":
            if not self.content_sha256 or not self.manifest_sha256:
                raise ValueError(
                    "evaluator_receipt requires content_sha256 and manifest_sha256"
                )
        elif self.content_sha256 or self.manifest_sha256:
            raise ValueError(
                "content/manifest hashes are resolved by artifact/storage staging"
            )
        return self


class CandidatePromoteInput(ProjectScopedInput):
    candidate_id: str
    expected_champion_id: str = Field(
        description=(
            "Champion id observed from candidate.list, or the empty string "
            "when no champion exists. Prevents stale overwrites."
        )
    )
    reason: str = Field(min_length=20, max_length=2000)


class ClaimCreateInput(ProjectScopedInput):
    statement: str
    scope: str = ""
    confidence: Literal["low", "medium", "high"] = "medium"


class ClaimListInput(ProjectScopedInput):
    pass


class ClaimUpdateInput(ProjectScopedInput):
    claim_id: str
    status: (
        Literal["draft", "active", "supported", "weakened", "contradicted", "abandoned"]
        | None
    ) = None
    confidence: Literal["low", "medium", "high"] | None = None


class ExperimentCreateInput(ProjectScopedInput):
    name: str = Field(
        default="",
        description="REQUIRED. Short folder-safe name, unique within the project — it becomes the experiment folder experiments/<name>/. Letters, digits, '.', '_', '-' only; 3-48 characters. The project supplies the shared context, so name the contrast: lead with what distinguishes this experiment from its siblings and do not repeat the project topic (next to 'released_adapters', prefer 'scratch_training' over 'lora_glue_scratch'). See the siblings — including terminal ones you should not recreate — via the project tool with action=\"overview\".",
    )
    intent: str = Field(
        default="",
        description="REQUIRED. The ask, in one standalone line: what this experiment tests and why the project needs it — written so a stranger plans the experiment you meant. Name the datasets, harness tasks, and sibling experiments involved by their own names; never 'the wave' or 'this reflection'. Doubles as the UI title. How to test it — method, metrics, thresholds — belongs in the plan.md artifact.",
    )
    details: str = Field(
        default="",
        description="Optional free prose addressed to whoever writes the plan: givens, boundaries with sibling experiments, preferences, budgets, warnings — up to a full design sketch. Immutable once created, and advice rather than contract: the approved plan supersedes it on anything about how. Empty is fine — the intent alone is a complete create.",
    )
    tested_claim_ids: list[str] | str | None = Field(default_factory=list)
    claim_id: str | None = Field(
        default=None, description="Alias for a single tested claim id."
    )
    claim_ids: list[str] | str | None = Field(
        default=None, description="Alias for tested_claim_ids."
    )
    depends_on: list[str] | str | None = Field(
        default_factory=list,
        description=(
            "Optional exp_/task_ ids of the same project this experiment must "
            "not start running before (e.g. the data-preparation task it "
            "trains on); they become wave DAG edges."
        ),
    )
    title: str = Field(
        default="",
        description="Deprecated; back-compat fallback for intent. Put design detail in plan.md.",
    )
    hypothesis: str = Field(
        default="",
        description="Deprecated; put the hypothesis in plan.md's 'Objective & hypothesis' section.",
    )
    design: str = Field(
        default="",
        description="Deprecated; put the method in plan.md's 'Method' section.",
    )
    success_criteria: str = Field(
        default="",
        description="Deprecated; put success criteria in plan.md's 'Evaluation' section.",
    )
    risks: str = Field(
        default="",
        description="Deprecated; put risks in plan.md's 'Risks & confounders' section.",
    )
    status: Literal[*EXPERIMENT_INITIAL_VALUES] = Field(
        default=EXPERIMENT_WORKFLOW.initial,
        description=f"Create always starts {EXPERIMENT_WORKFLOW.initial}.",
    )


class ExperimentListInput(ProjectScopedInput):
    pass


class ExperimentGetStateInput(ProjectScopedInput):
    experiment_id: str
    review_id: str = Field(
        default="",
        description=(
            "Optional review id taken from this experiment's 'reviews' list. "
            "Older rounds are listed by synopsis only; pass one here to also "
            "receive that review's full body under 'review'."
        ),
    )


class ExperimentExhibitInput(ProjectScopedInput):
    experiment_id: str


class ExperimentTransitionInput(ProjectScopedInput):
    experiment_id: str
    transition: Literal[*EXPERIMENT_TRANSITION_VALUES]
    evidence: dict[str, Any] | None = None


class TaskCreateInput(ProjectScopedInput):
    name: str = Field(
        default="",
        description=(
            "REQUIRED. Short folder-safe name, unique among the project's tasks "
            "— it becomes the task folder tasks/<name>/. Letters, digits, '.', "
            "'_', '-' only; 3-48 characters. Name the deliverable, not the "
            "project ('prep-cifar-splits', 'lit-sweep-distillation')."
        ),
    )
    goal: str = Field(
        default="",
        description=(
            "REQUIRED. Short prose — what needs to be done and why the "
            "project needs it. Write it STANDALONE: a person just opening the "
            "task must understand it, so name concrete datasets, tools, and "
            "experiments ('the wd-sweep experiment'), never context the "
            "reader cannot see ('the wave', 'this reflection'). No method — "
            "how is the executor's. The goal and deliverables are IMMUTABLE "
            "after creation."
        ),
    )
    deliverables: list[str] | str | None = Field(
        default=None,
        description=(
            "REQUIRED. The things that must exist when the task is done — "
            "one item per thing, each verifiable AS WRITTEN (carry the "
            "criterion in the sentence: counts, tolerances, required "
            "sections). No bundles, no vague nouns. Rule of thumb 1-7 items; "
            "more usually means two tasks. Immutable after creation: a wrong "
            "deliverable is an honest miss ('not delivered — why') in the "
            "delivery, or the owner ends the task and creates a better one."
        ),
    )
    depends_on: list[str] | str | None = Field(
        default_factory=list,
        description=(
            "Optional exp_/task_ ids of the same project this task must not "
            "deliver before; they become wave DAG edges. Empty for ad-hoc work."
        ),
    )


class TaskListInput(ProjectScopedInput):
    pass


class TaskGetStateInput(ProjectScopedInput):
    task_id: str
    review_id: str = Field(
        default="",
        description=(
            "Optional review id taken from this task's 'reviews' list; pass it "
            "to also receive that review's full body under 'review'."
        ),
    )


class TaskTransitionInput(ProjectScopedInput):
    task_id: str
    transition: Literal[*TASK_TRANSITION_VALUES]
    evidence: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Optional. On accept, {'outcome': ...} is the accepted outcome note; "
            "on mark_failed, {'reason': ...} says why the owner ended it."
        ),
    )


class MlflowContextInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Optional plugin experiment id. Omit for project-level MLflow "
            "navigation context; provide it for the exact MLflow experiment "
            "name/env used by a quantitative run."
        ),
    )


class MlflowFinalizeRunInput(ProjectScopedInput):
    experiment_id: str
    run_id: str | None = Field(
        default=None,
        description=(
            "MLflow run id to finalize/read back. Omit to use the "
            "plugin-created run persisted on the experiment."
        ),
    )
    status: Literal["FINISHED", "FAILED", "KILLED"] | None = Field(
        default="FINISHED",
        description=(
            "Terminal status to set before readback. Pass null for readback only."
        ),
    )
    wait_seconds: float = Field(
        default=2.0,
        ge=0.0,
        le=10.0,
        description="Maximum seconds to poll until MLflow readback is terminal.",
    )


class ReflectionLensInput(ContractModel):
    id: str = Field(
        description=(
            "Lens id slug (lowercase letters/digits/'_'/'-'). It doubles as the "
            "reflection filename: the lens's subagent submits <id>.md."
        )
    )
    title: str = ""
    charter: str = Field(
        default="",
        description=(
            "What angle this lens reads the project from. The core lenses "
            "(amplify, avoid, entropy) default their charter; the two "
            "wave-authored lenses must supply one."
        ),
    )
    why_distinct: str = Field(
        default="",
        description=(
            "Required for the two wave-authored lenses: how this lens differs "
            "from the core three and from the other authored lens. Engineered "
            "diversity is the point of the roster."
        ),
    )


class ReflectionCreateInput(ProjectScopedInput):
    title: str = Field(
        default="", description="Optional short headline for this reflection wave."
    )
    lenses: list[ReflectionLensInput] = Field(
        default_factory=list,
        description=(
            "The declared reflection roster: exactly 5 lenses — the 3 core ids "
            "(amplify, avoid, entropy) plus 2 you design for this "
            "project, each with a charter and why_distinct. The roster is "
            "fixed at create; every lens must submit its own reflection before "
            f"{_REFLECTION_FIRST_TRANSITION}."
        ),
    )


class ReflectionGetInput(ProjectScopedInput):
    reflection_id: str
    include_content: bool = Field(
        default=False,
        description=(
            "Default false: return TLDRs for submitted documents. Set true "
            "only for a focused deep dive that needs the exact bounded text."
        ),
    )


class ReflectionListInput(ProjectScopedInput):
    pass


class ReflectionTransitionInput(ProjectScopedInput):
    reflection_id: str
    transition: Literal[*REFLECTION_TRANSITION_VALUES]


class ConsolidationGetInput(ProjectScopedInput):
    reflection_id: str


class ConsolidationDecisionInput(ContractModel):
    experiment_id: str
    disposition: Literal[
        "used_as_is",
        "adapted",
        "reviewed_not_used",
        "superseded",
    ]
    rationale: str
    integration_kind: Literal[
        "merge",
        "fast_forward",
        "cherry_pick",
        "rewrite",
        "none",
    ]
    superseded_by: str = ""


class ConsolidationSubmitInput(ProjectScopedInput):
    reflection_id: str
    base_sha: str
    proposal_sha: str
    summary: str
    validation: dict[str, Any] = Field(default_factory=dict)
    decisions: list[ConsolidationDecisionInput]


class ArtifactSubmitInput(ProjectScopedInput):
    target_type: str = Field(
        description="Workflow target kind the artifact attaches to.",
        json_schema_extra={"enum": sorted(ARTIFACT_TARGET_TYPES)},
    )
    target_id: str = Field(
        description="Id of the experiment, task, reflection, claim, or review."
    )
    role: str = Field(
        description=(
            "Artifact role. Gated docs (plan, report, graph, project_graph, "
            "reflection_lens_doc, reflection_doc, change_spec; for tasks: "
            "brief, delivery) and metrics 'result' JSON only — all size-capped "
            "at 16 KB."
        ),
        json_schema_extra={"enum": sorted(SUBMITTABLE_ROLES)},
    )
    path: str = Field(
        description=(
            "Relative path of the local file you wrote — the provenance label "
            "and the file the returned upload command sends."
        )
    )
    lens_id: str = Field(
        default="",
        description=(
            "REQUIRED when role=reflection_lens_doc: the roster lens this "
            "reflection covers. Its submitted Markdown must contain a non-empty "
            f"Summary section to pass {_REFLECTION_FIRST_TRANSITION}. Invalid "
            "for any other role."
        ),
    )
    title: str = Field(default="", description="Optional display title.")

    @model_validator(mode="after")
    def _check_lens(self) -> "ArtifactSubmitInput":
        if self.role == "reflection_lens_doc" and not self.lens_id:
            raise ValueError("lens_id is required when role is reflection_lens_doc")
        if self.lens_id and self.role != "reflection_lens_doc":
            raise ValueError("lens_id only applies to reflection_lens_doc artifacts")
        return self


class ArtifactFindInput(ProjectScopedInput):
    artifact_id: str = Field(
        default="",
        description=(
            "Resolve one artifact by id. Use artifact_ids for an ordered batch, "
            "or omit both to list with the filters below."
        ),
    )
    artifact_ids: list[str] = Field(
        default_factory=list,
        max_length=50,
        description=(
            "Resolve 1-50 artifacts in one call. Duplicate ids are de-duplicated "
            "in first-seen order. Any missing or cross-project id fails the "
            "whole request."
        ),
    )
    include_content: bool = Field(
        default=False,
        description=(
            "Opt in to bounded submitted text for id-based reads. Metadata is "
            "the slim default. Singular reads add a sibling content envelope; "
            "plural reads add that envelope to each artifact row. It contains "
            "content, available, is_binary, size_bytes, and content_type; "
            "binary or unavailable bytes are never injected as text. Invalid "
            "when listing by filters."
        ),
    )
    target_type: str = Field(
        default="", description="List filter: target kind (e.g. 'experiment')."
    )
    target_id: str = Field(default="", description="List filter: target id.")
    role: str = Field(default="", description="List filter: artifact role.")

    @model_validator(mode="after")
    def _check_selector(self) -> "ArtifactFindInput":
        if any(not item for item in self.artifact_ids):
            raise ValueError("artifact_ids cannot contain blank ids")
        self.artifact_ids = list(dict.fromkeys(self.artifact_ids))
        if self.artifact_id and self.artifact_ids:
            raise ValueError("provide at most one of artifact_id or artifact_ids")
        filters = [
            field
            for field in ("target_type", "target_id", "role")
            if getattr(self, field)
        ]
        if (self.artifact_id or self.artifact_ids) and filters:
            raise ValueError(
                "id-based artifact reads cannot be combined with list filters"
            )
        if self.include_content and not (self.artifact_id or self.artifact_ids):
            raise ValueError("include_content requires artifact_id or artifact_ids")
        return self


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
    """List the storage ledger, or resolve a single object.

    A union of the former ``storage.list`` and ``storage.resolve`` inputs.
    Passing ``object_id`` or ``name`` (with optional ``version`` /
    ``include_download``) selects resolve mode; omitting both lists the ledger
    with the ``kind`` / ``status`` filters and ``limit`` / ``offset`` / ``compact``
    pagination.
    """

    # Resolve-mode selectors (former storage.resolve).
    object_id: str | None = None
    name: str | None = None
    version: int | None = Field(default=None, ge=1)
    include_download: bool = True
    # List-mode filters (former storage.list).
    kind: Literal["dataset", "model", "other"] | None = None
    status: (
        Literal["uploading", "completing", "available", "expired", "deleted"] | None
    ) = None
    include_expired: bool = False
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


class ReviewRequestInput(ProjectScopedInput):
    target_type: Literal[*REVIEW_TARGET_VALUES]
    target_id: str
    role: Literal[*REVIEW_ROLE_VALUES]
    reason: str = ""
    producer_session_id: str = "main"


class ReviewStartInput(ContractModel):
    review_request_id: str
    reviewer_capability: str
    declared_agent: str = ""
    caller_session_id: str = Field(
        description=(
            "The reviewer's OWN session identity (any stable identifier for "
            "the reviewing agent's session). Required: it must be non-empty "
            "and differ from the producer session that requested the review, "
            "so reviewer independence can be verified."
        )
    )


class ReviewSubmitInput(ContractModel):
    review_session_id: str
    verdict: Literal[*REVIEW_VERDICT_VALUES]
    synopsis: str = Field(
        description=(
            "The researcher's TLDR, 1-3 plain sentences, 40-420 chars: what "
            "was tried, what happened, and whether it holds. This is the "
            "first thing the human reads on the experiment page, so write "
            "plain prose in reader context — name things by their human "
            "names, and use at most one decisive number with its baseline. "
            "No entity ids (exp_/claim_/res_/rev_/rver_/syn_/lit_/paper_), "
            "no backticks or markdown, no newlines."
        )
    )
    return_to: Literal[*REVIEW_RETURN_VALUES] = Field(
        default_factory=str,
        description=(
            "Where a rejected target goes next. Omit on pass. REQUIRED on "
            "experiment-attempt-review rejections (needs_changes/fail): "
            f"{_EXPERIMENT_PLAN_RETURN.to_status!r} if the results show the "
            f"plan itself is flawed; {_EXPERIMENT_EXECUTION_RETURN.to_status!r} "
            "if the plan stands but execution or the conclusion is flawed "
            "(fix and re-run without redoing design review). Design-review "
            f"rejections always return to {_EXPERIMENT_PLAN_RETURN.to_status!r}. "
            "REQUIRED on project-reflection-review rejections: "
            f"{_REFLECTION_RERUN_RETURN.to_status!r} to re-launch the reflection "
            "fan-out (every lens re-submits for the new attempt), or "
            f"{_REFLECTION_REVISION_RETURN.to_status!r} if the reflections "
            "stand but the reflection artifacts (project graph, reflection "
            "doc, and/or change spec) must be revised. Task-review rejections: "
            f"needs_changes returns to {_TASK_REVIEW_RETURN.to_status!r} (the "
            "default; omit return_to) — the executor fixes the delivery; a "
            f"fail verdict ENDS the task ({_TASK_FAIL_STATUS!r}) — reserve it "
            "for a goal that cannot be met within the task's scope."
        ),
        json_schema_extra={
            "enum": [value for value in REVIEW_RETURN_VALUES if value]
        },
    )
    notes: str = Field(default="", description="Free-text summary of the review.")
    findings: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "List of issue objects. Each item should have an 'issue' (str); "
            "conventionally also 'severity' (e.g. 'high'/'medium'/'low'). "
            'Example: [{"issue": "no held-out test set", "severity": "high"}].'
        ),
    )
    evidence: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Free-form dict of supporting data for the verdict (e.g. metrics, "
            "checks run). Put structured rationale HERE — unknown TOP-LEVEL fields "
            "are rejected (this input forbids extras)."
        ),
    )


class ReviewStatusInput(ProjectScopedInput):
    target_type: Literal[*REVIEW_TARGET_VALUES]
    target_id: str


class SandboxRequestInput(ProjectScopedInput):
    experiment_id: str | None = Field(
        default=None,
        description=(
            "Optional experiment to attach the sandbox to. Omit to create a "
            "standalone sandbox addressed by sandbox_uid."
        ),
    )
    instance_type: str | None = Field(
        default=None,
        description=(
            "Provider-bundled machine SKU (GPU + CPU + RAM together). Required by "
            "the Lambda Labs and Thunder Compute backends: call this with no instance_type (or "
            "use sandbox.options) to get a live menu, then pick one of "
            "options[].instance_type. Ignored by Modal (which composes the machine "
            "from gpu/cpu/memory)."
        ),
    )
    region: str | None = Field(
        default=None,
        description=(
            "Optional datacenter/region for the chosen instance_type (Lambda "
            "Labs). Omit to auto-pick a region that currently has capacity."
        ),
    )
    provider: str | None = Field(
        default=None,
        description=(
            "Compute provider to serve this request when the deployment has "
            "several configured (e.g. lambda_labs, hyperstack, digitalocean). "
            "sandbox.options tags every hardware option with the provider that "
            "serves it — pass that value back together with its instance_type. "
            "Omit to use the default provider."
        ),
    )
    gpu: str | None = Field(
        default=None,
        description=(
            "GPU type. On Modal a concrete attachable GPU (e.g. 'A100', 'H100'); "
            "omit for a CPU-only sandbox. On Lambda Labs a free-form filter over "
            "live instance types — prefer instance_type there."
        ),
    )
    cpu: float | None = Field(
        default=None,
        description=(
            "Requested Modal CPU cores (1 core = 2 vCPUs). Default 2 cores. "
            "Ignored by Lambda Labs, where the instance_type fixes the vCPUs."
        ),
    )
    memory: int | None = Field(
        default=None,
        description=(
            "Requested sandbox memory in MiB. Default 8192. Ignored by Lambda "
            "Labs, where the instance_type fixes the RAM."
        ),
    )
    time_limit: int | None = Field(
        default=None,
        description="Max sandbox lifetime in seconds (60..86400). Default 3600.",
    )
    public_key: str = Field(
        description=(
            "Required OpenSSH public key to authorize on the VM. Pass only the "
            "single-line public key, never private-key material."
        ),
    )
    additional: bool = Field(
        default=False,
        description=(
            "When true with experiment_id, provision a new sandbox and add it "
            "to that experiment's active sandbox list instead of reusing an "
            "already attached live sandbox."
        ),
    )

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


class SandboxListInput(ProjectScopedInput):
    pass


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


class LitreviewViewInput(ProjectScopedInput):
    section: str = Field(
        default="",
        max_length=200,
        description=(
            "Read one full section by id (lit_...) or exact title "
            "(case-insensitive); 'summary' addresses the General Summary. "
            "Empty = the overview: General Summary + every section's TLDR "
            "outline + paper count — the cheap glance."
        ),
    )
    papers: bool = Field(
        default=False,
        description="Return the papers ledger page (with links) instead of the document.",
    )
    cursor: int = Field(
        default=0,
        ge=0,
        description="papers=true: created_seq cursor from the previous page's next_cursor.",
    )
    limit: int = Field(default=20, ge=1, le=50, description="papers=true: page size.")


class LitreviewOrderPair(ContractModel):
    id: str = Field(max_length=64, description="Section id (lit_...).")
    revision: int = Field(
        ge=1, description="The revision you last read for this section."
    )


class LitreviewEditInput(ProjectScopedInput):
    op: Literal["add", "edit", "delete", "reorder"] = Field(
        description=(
            "add = new dynamic section (title + tldr required); edit = targeted "
            "update of one section (expected_revision required; only the fields "
            "you pass change); delete = remove one section and its citation "
            "links (expected_revision required; the General Summary cannot be "
            "deleted); reorder = set the complete section order (order "
            "required). Always make targeted edits — never rewrite the whole "
            "document."
        )
    )
    section: str = Field(
        default="",
        max_length=200,
        description=(
            "edit/delete: section id (lit_...) or exact title; 'summary' "
            "addresses the General Summary (pass expected_revision=0 to write "
            "it for the first time)."
        ),
    )
    title: str = Field(
        default="",
        max_length=200,
        description="add: required. edit: optional rename (summary title is fixed).",
    )
    tldr: str = Field(
        default="",
        max_length=500,
        description=(
            "One-glance summary of the section. Required on add and on every "
            "edit that changes body — keep it current; it is what other agents "
            "read first."
        ),
    )
    body: str = Field(
        default="",
        description="Markdown body, max 16,000 bytes. Cite papers inline by paper_ id.",
    )
    expected_revision: int | None = Field(
        default=None,
        ge=0,
        description=(
            "edit/delete: the revision you last read. A mismatch means the "
            "section changed under you — re-read it and retry."
        ),
    )
    order: list[LitreviewOrderPair] | None = Field(
        default=None,
        max_length=64,
        description="reorder: ALL dynamic sections as {id, revision} pairs in the new order.",
    )

    @field_validator("body")
    @classmethod
    def _body_byte_cap(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 16_000:
            raise ValueError("body exceeds 16,000 bytes — split the section instead")
        return value

    @model_validator(mode="after")
    def _check_op(self) -> "LitreviewEditInput":
        if self.op == "add" and not self.title:
            raise ValueError("op=add requires title")
        if self.op in ("edit", "delete"):
            if not self.section:
                raise ValueError(f"op={self.op} requires section")
            if self.expected_revision is None:
                raise ValueError(f"op={self.op} requires expected_revision")
        if self.op == "reorder" and not self.order:
            raise ValueError("op=reorder requires order")
        return self


class LitreviewCiteTarget(ContractModel):
    type: Literal["litreview_section", "experiment", "claim"]
    id: str = Field(
        max_length=200,
        description="Target id (section ids may also be exact titles).",
    )


class LitreviewCiteInput(ProjectScopedInput):
    url: str = Field(
        default="",
        max_length=2048,
        description="Paper URL (arXiv/DOI forms are normalized).",
    )
    doi: str = Field(
        default="", max_length=256, description="Bare DOI, e.g. 10.1038/xyz."
    )
    arxiv_id: str = Field(
        default="", max_length=64, description="Bare arXiv id, e.g. 2107.03374."
    )
    targets: list[LitreviewCiteTarget] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Where this paper is used: lit-review sections, experiments, "
            "and/or claims. Registering with no targets is allowed."
        ),
    )
    note: str = Field(
        default="",
        max_length=300,
        description="Optional one-liner: why this paper matters here.",
    )
    title: str = Field(
        default="",
        max_length=200,
        description="Fallback title, used when the paper's host is off the fetch allowlist.",
    )

    @model_validator(mode="after")
    def _one_identity(self) -> "LitreviewCiteInput":
        provided = [v for v in (self.url, self.doi, self.arxiv_id) if v]
        if len(provided) != 1:
            raise ValueError("provide exactly one of url, doi, or arxiv_id")
        return self


TOOL_MANIFEST: dict[str, ToolManifest] = {
    "agent.hello": ToolContract(
        handler_identity="agents.hello",
        scope_strategy="none",
        input_model=AgentHelloInput,
        description=(
            "Call ONCE at the start of a context window, before any other Merv "
            "call: returns the short agent_id that identifies this context "
            "window (this conversation, or this subagent) to Merv. Every other "
            "Merv tool requires that agent_id as an argument, so Merv can "
            "attribute what each agent did and was told. Never share an "
            "agent_id across contexts; a subagent must call agent.hello "
            "itself. If you already have one from earlier in this context, "
            "keep using it (or pass it here to confirm) instead of minting "
            "another."
        ),
    ),
    "workflow.status_and_next": ToolContract(
        handler_identity="application.status_for_agent",
        input_model=WorkflowStatusAndNextInput,
        description=(
            "The canonical entrypoint for starting or resuming work. Without "
            "experiment_id or task_id, returns workflow guidance plus the "
            "bounded project context: project metadata, latest published "
            "reflection, General Summary of the literature, every claim, and "
            "one status-dependent summary for every experiment and task. With "
            "experiment_id, returns the four-section experiment context: "
            "experiment, latest plan, latest report, and all other "
            "current-attempt artifact references. Live experiments receive the "
            "full latest plan; terminal experiments receive its Summary; the "
            "latest report is full when present. With task_id, returns the "
            "task's guidance, brief, delivery, checks, and dependencies. Use "
            "artifact.find with one id or an ordered id batch for deeper "
            "artifact reads."
        ),
    ),
    "project": ToolContract(
        handler_identity="application.project",
        scope_strategy="caller-selected",
        input_model=ProjectInput,
        description=(
            "Project navigation for this credential, dispatched on 'action'. "
            "action=list returns every project you can work in — id, name, "
            "summary, and creation date, minus any the user has stashed — and "
            "is how you pick the project_id "
            "that most other tools require; call it first when you do not "
            "already know which project the user means. "
            "action=current returns the single project this credential is "
            "bound to; a credential that reaches several returns exists=false "
            "and the same list, because there is no one current project. "
            "action=overview is the whole-project read for orienting or "
            "re-grounding: the same bounded project context used by project-"
            "scoped workflow and review starts, including the latest published "
            "reflection, the literature General Summary, every claim "
            "(including settled/abandoned), and every experiment (including "
            "terminal) with one status-dependent summary. "
            "action=create creates a project from a user-confirmed name and "
            "summary."
        ),
    ),
    "project.update": ToolContract(
        handler_identity="research.update_project",
        visibility="internal",
        input_model=ProjectUpdateInput,
        description=(
            "Update a project name, summary, review/agent/storage policy knobs, "
            "or hidden state."
        ),
    ),
    "project.get": ToolContract(
        handler_identity="research.get_project",
        visibility="internal",
        input_model=ProjectGetInput,
        description="Get project metadata.",
    ),
    "candidate.submit": ToolContract(
        handler_identity="application.submit_candidate",
        input_model=CandidateSubmitInput,
        description=(
            "Register an immutable project candidate that already exists as "
            "one complete Artifact/available Object Storage object, or nominate "
            "an experiment_workspace for evaluator staging without exposing a "
            "filesystem path. Use Object Storage for large checkpoints; never "
            "put model bytes in Git. Safe retries reuse the same idempotency_key."
        ),
    ),
    "candidate.stage": ToolContract(
        handler_identity="application.stage_candidate",
        input_model=CandidateStageInput,
        description=(
            "Attach one verified durable Artifact/Object Storage receipt to a "
            "pending experiment_workspace candidate, or an evaluator-owned "
            "receipt id plus immutable content/manifest hashes when heavy "
            "Object Storage is disabled. No filesystem path or URI is accepted."
        ),
    ),
    "candidate.list": ToolContract(
        handler_identity="research.list_candidates",
        input_model=ProjectScopedInput,
        description=(
            "List immutable project candidates, append-only promotion history, "
            "and the current champion."
        ),
    ),
    "candidate.promote": ToolContract(
        handler_identity="research.promote_candidate",
        input_model=CandidatePromoteInput,
        description=(
            "Promote an already-submitted candidate to current project "
            "champion after comparing it with the existing best-known result. "
            "Pending workspace candidates cannot be promoted; pass the "
            "champion id you observed so stale managers cannot overwrite it."
        ),
    ),
    "project.list": ToolContract(
        handler_identity="application.project_list",
        visibility="internal",
        input_model=EmptyInput,
        description="List projects in the current tool scope.",
    ),
    "claim.create": ToolContract(
        handler_identity="research.create_claim",
        input_model=ClaimCreateInput,
        description=(
            'Create a claim. Check the project tool with action="overview" '
            "first so you do not recreate a settled or abandoned claim."
        ),
    ),
    "claim.list": ToolContract(
        handler_identity="research.list_claims",
        visibility="internal",
        input_model=ClaimListInput,
        description="List claims.",
    ),
    "claim.update": ToolContract(
        handler_identity="research.update_claim",
        input_model=ClaimUpdateInput,
        description=(
            "Update a claim's status or confidence. The statement and scope "
            "are immutable — experiments and reviews reference the claim by "
            "id assuming stable meaning. To revise the text, propose a claim "
            "change in a reflection change spec (reviewed), or abandon this "
            "claim and create a corrected one."
        ),
    ),
    "experiment.create": ToolContract(
        handler_identity="application.create_experiment",
        input_model=ExperimentCreateInput,
        description=(
            f"Create a {EXPERIMENT_WORKFLOW.initial} experiment. Requires an intent (the "
            "ask, one standalone line: what this tests and why, standalone) and a "
            "short folder-safe 'name' unique within the project; the name becomes "
            "the experiment folder experiments/<name>/. Optional 'details' carries "
            "everything else the planner should have."
        ),
    ),
    "experiment.list": ToolContract(
        handler_identity="application.list_experiments",
        visibility="internal",
        input_model=ExperimentListInput,
        description="List experiments with state.",
    ),
    "experiment.get_state": ToolContract(
        handler_identity="application.experiment",
        visibility="internal",
        input_model=ExperimentGetStateInput,
        description=(
            "Compatibility-only singular internal experiment state projection. "
            "Agents use workflow.status_and_next for context and artifact.find "
            "for focused singular or batch document retrieval."
        ),
    ),
    "experiment.transition": ToolContract(
        handler_identity="application.transition_experiment",
        input_model=ExperimentTransitionInput,
        description=(
            "Apply a transition allowed by workflow.status_and_next. Returns "
            "only a compact acknowledgement (from/to status, attempt, event "
            "id, and timestamp), plus any operation-specific side-effect receipt; it "
            "does not return experiment context. Call "
            "workflow.status_and_next afterward to continue. "
            f" Use {_EXPERIMENT_RETRY_TRANSITION} only for "
            "infrastructure/interruption reruns where the experiment should "
            f"stay {_EXPERIMENT_EXECUTION_STATUS} on the same attempt. At "
            f"{_EXPERIMENT_RESULT_TRANSITION} the system evaluates the attempt's metrics "
            "exhibit from eligible pinned result JSON with provenance; when an "
            "exhibit is pinned, report.md must reference it."
        ),
    ),
    "experiment.exhibit": ToolContract(
        handler_identity="application.exhibit",
        input_model=ExperimentExhibitInput,
        description=(
            "Read-only preview of the system-generated metrics exhibit for a "
            f"{_EXPERIMENT_EXECUTION_STATUS} experiment from eligible pinned result-file sources "
            "(metrics.json, results.json, and "
            "results/*.json associated with role 'result'). Call it before "
            "writing report.md. When pinned, the report must "
            "reference and interpret it rather than hand-copy numbers."
        ),
    ),
    "task.create": ToolContract(
        handler_identity="application.create_task",
        input_model=TaskCreateInput,
        description=(
            f"Create a {TASK_WORKFLOW.initial} task: scoped non-experiment work "
            "with a verifiable finish line and no claim (lit review, data "
            "preparation, harness building, memos). Requires a goal (short "
            "standalone prose), deliverables (the things that must exist, each "
            "verifiable as written), and a short folder-safe 'name' unique "
            "among the project's tasks; the name becomes the task folder "
            "tasks/<name>/. Goal and deliverables are IMMUTABLE — Merv renders "
            "and pins brief.md from them. When the work is done, submit the "
            "delivery (role 'delivery': one confirmation per deliverable, "
            "then Notes prose). Has a claim to test? Create an experiment "
            "instead."
        ),
    ),
    "task.list": ToolContract(
        handler_identity="application.list_tasks",
        visibility="internal",
        input_model=TaskListInput,
        description="List tasks with state.",
    ),
    "task.get_state": ToolContract(
        handler_identity="application.task",
        visibility="internal",
        input_model=TaskGetStateInput,
        description=(
            "Compatibility-only singular internal task state projection. "
            "Agents use workflow.status_and_next(task_id=...) for context."
        ),
    ),
    "task.transition": ToolContract(
        handler_identity="application.transition_task",
        input_model=TaskTransitionInput,
        description=(
            "Apply a task transition allowed by workflow.status_and_next: "
            "submit_delivery (in_progress → in_review, needs a valid brief and "
            "delivery and every dependency done), accept (after a passing "
            "task_reviewer review → done), or mark_failed (the owner ends the "
            "task with evidence={'reason': ...}). Returns a compact "
            "acknowledgement; call workflow.status_and_next(task_id=...) "
            "afterward to continue."
        ),
    ),
    "mlflow.context": ToolContract(
        handler_identity="application.tracking_context",
        input_model=MlflowContextInput,
        description=(
            "Central MLflow bridge context. With no experiment_id, returns the "
            "project-level tracking URI, dashboard URL, namespace prefix, env, "
            "and plugin experiment-to-MLflow-name map for direct MlflowClient "
            "navigation. With experiment_id, also returns the exact "
            "merv/<project>/<experiment> experiment name and env vars to set "
            "(MLFLOW_TRACKING_URI, MLFLOW_EXPERIMENT_NAME, …) before a "
            "quantitative run, plus the plugin-created run id when available. "
            "Returns configured=false when no tracking server is set."
        ),
    ),
    "mlflow.finalize_run": ToolContract(
        handler_identity="application.finalize_tracking",
        input_model=MlflowFinalizeRunInput,
        description=(
            "Finalize a plugin experiment's MLflow run and read it back through "
            "the backend MLflow API. Omit run_id to use the plugin-created run "
            "from experiment state; pass status=null for readback only. The "
            "helper updates the persisted mlflow_run status so immediate stale "
            "RUNNING readbacks do not linger in experiment state."
        ),
    ),
    "reflection.create": ToolContract(
        handler_identity="application.create_reflection",
        input_model=ReflectionCreateInput,
        description=(
            "Open a project reflection wave. "
            "Declares the 5-lens reflection roster (3 core: amplify, "
            "avoid, entropy; plus 2 you design with charter + "
            "why_distinct) and snapshots the corpus of finished experiments "
            "the wave covers — including new_terminal_experiments (the new "
            "signal since the last published wave) and each lens's previous "
            "reflection artifact id and bounded submitted content. One wave "
            "may be open at a time. See the "
            "project-reflection skill."
        ),
    ),
    "reflection.get": ToolContract(
        handler_identity="application.reflection",
        input_model=ReflectionGetInput,
        description=(
            "Get one reflection wave state: roster, per-lens "
            "reflection coverage, TLDRs for current-attempt reflection "
            "artifacts, prior published graph/reflection documents, and "
            "snapshotted terminal-experiment reports/graphs; pass "
            "include_content=true only for a focused deep dive that needs "
            "their exact bounded text. Also returns reviews and "
            "allowed_transitions with preconditions. Includes gate_checklist "
            "for missing lenses/artifacts/review state, and project_graph_diff "
            "when a submitted project graph can be compared with the previous "
            "published graph."
        ),
    ),
    "reflection.list": ToolContract(
        handler_identity="application.reflections",
        visibility="internal",
        input_model=ReflectionListInput,
        description="List the project's reflection waves with state.",
    ),
    "reflection.transition": ToolContract(
        handler_identity="application.transition_reflection",
        input_model=ReflectionTransitionInput,
        description=(
            "Apply an allowed reflection transition ("
            + ", ".join(REFLECTION_WORKFLOW.transition_names)
            + "). See "
            "reflection.get.allowed_transitions for preconditions from the "
            f"current status. {_REFLECTION_PUBLISH_TRANSITION} is internal: "
            "after reflection review, begin_consolidation hands code to a "
            "separate consolidator and reviewer; only the runner's central "
            "advance may publish and materialize the approved change spec."
        ),
    ),
    "consolidation.get": ToolContract(
        handler_identity="application.consolidation",
        input_model=ConsolidationGetInput,
        description=(
            "Read the authoritative reflection and slim immutable experiment "
            "packet for code consolidation: exact experiment branches/base/head "
            "SHAs, concise result summaries, current proposal coverage, and "
            "prior consolidation-review feedback."
        ),
    ),
    "consolidation.submit": ToolContract(
        handler_identity="application.submit_consolidation",
        input_model=ConsolidationSubmitInput,
        description=(
            "Submit one immutable consolidation proposal. The proposal must "
            "name exact base/proposal SHAs and account for every experiment as "
            "used as-is, adapted, reviewed but not used, or superseded. This "
            "records the actual Git integration kind while Merv supplies each "
            "experiment branch head and the runner independently verifies "
            "ancestry. It cannot reopen or alter the authoritative reflection."
        ),
    ),
    "litreview.view": ToolContract(
        handler_identity="litreview.view",
        input_model=LitreviewViewInput,
        description=(
            "Read the project's living literature review. No args = the "
            "overview (General Summary + every section's TLDR + paper count) — "
            "read this before editing so you know the document's shape. "
            "section=<id or title> = one full section with its cited papers. "
            "papers=true = the papers ledger with links to the sections, "
            "experiments, and claims that cite each paper."
        ),
    ),
    "litreview.edit": ToolContract(
        handler_identity="litreview.edit",
        input_model=LitreviewEditInput,
        description=(
            "Make a TARGETED change to the literature review: add, edit, "
            "delete, or reorder one thing per call — never rewrite the whole "
            "document. Every section keeps a TLDR (required on writes) so the "
            "overview stays glanceable. edit/delete require expected_revision "
            "(the revision you last read); a conflict means someone changed it "
            "— re-read and retry. Update the review whenever a new paper "
            "informs the project."
        ),
    ),
    "litreview.cite": ToolContract(
        handler_identity="litreview.cite",
        input_model=LitreviewCiteInput,
        description=(
            "Register a paper in the project's papers ledger and link it to "
            "the sections, experiments, or claims that use it. Papers are "
            "deduplicated (arXiv/DOI/URL forms of the same paper converge); "
            "metadata is fetched from known paper hosts, otherwise pass title. "
            "After citing, make a targeted litreview.edit so the review stays "
            "current."
        ),
    ),
    "artifact.submit": ToolContract(
        handler_identity="artifact_submissions.submit",
        input_model=ArtifactSubmitInput,
        description=(
            "Submit a typed artifact against a workflow target. FIRST write "
            "the document to a local file, then call this with its relative "
            "path; the result contains a one-line `run` command — execute it "
            "verbatim to upload the bytes (one-time token, expires in ~15 "
            "min). Gated roles are validated and size-capped (16 KB); for "
            "markdown with relative image links the upload response returns "
            "follow-up commands to push each figure the same way. "
            "Resubmitting the same slot replaces the previous artifact."
        ),
    ),
    "artifact.find": ToolContract(
        handler_identity="artifact_submissions.find",
        input_model=ArtifactFindInput,
        description=(
            "Find submitted artifacts. Pass artifact_id to resolve one, "
            "artifact_ids to resolve an ordered batch of 1-50, or filter the "
            "project's complete artifacts by target_type/target_id/role. "
            "Duplicate batch ids are de-duplicated first-seen; missing ids fail "
            "the request atomically. Metadata is the slim default. For id-based "
            "plan/report deep dives, include_content=true returns bounded text "
            "content envelopes while safely marking binary/unavailable bytes. "
            "Compact rows: id, target, role, attempt, lens_id, path label, "
            "title, size, timestamps."
        ),
    ),
    "storage.put_object": ToolContract(
        handler_identity="storage.put_object",
        visibility="internal",
        feature_requirements=("storage",),
        input_model=StoragePutObjectInput,
        description=(
            "Register a heavy storage object intent. Returns a presigned upload "
            "target unless the content is already present in the project. "
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
            "storage and finalizes the ledger object (bytes never pass through "
            "the agent context or the brain). Omit name to use the path. "
            f"{STORAGE_RULE_OF_THUMB}"
        ),
    ),
    "storage.complete_upload": ToolContract(
        handler_identity="storage.complete_upload",
        visibility="internal",
        feature_requirements=("storage",),
        input_model=StorageCompleteUploadInput,
        description="Complete a storage upload and mark the ledger object available.",
    ),
    "storage.find": ToolContract(
        handler_identity="storage.find",
        feature_requirements=("storage",),
        input_model=StorageFindInput,
        description=(
            "Find project storage objects. Pass object_id or name (with optional "
            "version, include_download) to resolve ONE object to its ledger row "
            "and, with include_download=true, a presigned download URL that renews "
            "TTL. Omit both to list the ledger: filter by kind/status, include "
            "expired rows with include_expired, paginate with limit/offset, and "
            "pass compact=true for a lean projection."
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
            "(expiry cleanup keeps it), unpin (restore its default expiry), renew "
            "(renew its default expiry window), or delete (drop the ledger alias, "
            "keeping history, and reclaim bytes when unreferenced)."
        ),
    ),
    "review.request": ToolContract(
        handler_identity="application.request_review",
        input_model=ReviewRequestInput,
        description=(
            "Create a review request and request-scoped reviewer capability; "
            "the plaintext is returned only in this response. The "
            "response's reviewer_handoff.spawn_prompt is a ready-to-use prompt "
            "for the reviewer subagent. The reviewer presents the capability "
            "via review.start with its own caller_session_id. Starting does "
            "not consume it; the first accepted submission closes the request."
        ),
    ),
    "review.start": ToolContract(
        handler_identity="application.start_review",
        scope_strategy="capability",
        input_model=ReviewStartInput,
        description=(
            "Start a reviewer session for the pinned request snapshot. The "
            "response includes bounded project orientation and, for an "
            "experiment target, the same canonical four-section context used "
            "by workflow.status_and_next, built only from artifact versions "
            "pinned to the request. Plan/report bodies needed for that review "
            "are included; use artifact.find for deeper reads of the listed "
            "artifact ids. The reviewer skill supplies the procedural "
            "read-only boundary."
        ),
    ),
    "review.submit": ToolContract(
        handler_identity="research.submit_review",
        scope_strategy="capability",
        input_model=ReviewSubmitInput,
        description=(
            "Submit a review from a reviewer session. Accepts ONLY: "
            "review_session_id, verdict (pass|needs_changes|fail), synopsis "
            "(REQUIRED: 1-3 plain sentences, 40-420 chars, the researcher's "
            "TLDR — no entity ids, markdown, or backticks), return_to, "
            "notes, findings (list of {issue, severity?}), and evidence "
            "(free-form dict). On experiment-attempt-review rejections "
            f"return_to is REQUIRED: {_EXPERIMENT_PLAN_RETURN.to_status!r} if "
            "the results show the plan itself is flawed, "
            f"{_EXPERIMENT_EXECUTION_RETURN.to_status!r} if the plan stands "
            "but execution or the conclusion is flawed (the experiment "
            "resumes running with its approved plan intact). Put structured "
            "rationale inside "
            "'evidence' — unknown top-level fields are rejected."
        ),
    ),
    "review.status": ToolContract(
        handler_identity="application.review_status",
        visibility="internal",
        input_model=ReviewStatusInput,
        description=(
            "Inspect review requests and submissions for a target, including "
            "recovery guidance for lost or expired reviewer capabilities."
        ),
    ),
    "sandbox.request": ToolContract(
        handler_identity="sandboxes.request",
        input_model=SandboxRequestInput,
        description=(
            "Procure (reuse or create) a project sandbox, optionally attached to "
            "an experiment, and return SSH details plus a brain-composed hint "
            "with runtime guidance for the remote work folder, expiry, copy-out, "
            "and durable storage. "
            "On Thunder Compute or Lambda Labs, omit instance_type to "
            "receive a live menu of available machines to pick from. "
            "SSH key custody: the sandbox authorizes a caller-side public key. "
            "The primary path is bring-your-own-key — the requesting agent "
            "generates its own ephemeral ed25519 keypair (ssh-keygen), keeps the "
            "private key to itself in a location only it can read, and passes "
            "only the single-line OpenSSH PUBLIC key as public_key so it gets "
            "authorized on the VM. Never send private-key material. "
            "The response's persisted public_key_source is 'caller' for new "
            "requests; legacy 'managed' rows remain readable/releasable."
        ),
    ),
    "sandbox.options": ToolContract(
        handler_identity="sandboxes.options",
        input_model=SandboxOptionsInput,
        description=(
            "List the hardware the active backend can provision right now "
            "(Thunder Compute/Lambda Labs: live available instance types; Modal: gpu/cpu/memory menu)."
        ),
    ),
    "sandbox.get": ToolContract(
        handler_identity="sandboxes.get",
        input_model=SandboxGetInput,
        description=(
            "Get sandbox status, SSH details, expiry, and polling/runtime "
            "guidance in the brain-composed hint by sandbox_uid or by an "
            "experiment's active sandbox "
            "association. Use it to poll provisioning and inspect terminated "
            "or expired sandboxes. Includes public_key_source so callers know "
            "whether the VM authorized a caller-supplied public key or a "
            "legacy managed fallback key."
        ),
        hosted_control_sandbox_lookup=True,
    ),
    "sandbox.attach": ToolContract(
        handler_identity="sandboxes.attach",
        input_model=SandboxAttachInput,
        description=(
            "Associate an existing running sandbox with an experiment without "
            "changing the VM, workdir, SSH connection, or lifecycle. A live "
            "sandbox can be associated with multiple active experiments."
        ),
    ),
    "sandbox.pull_outputs": ToolContract(
        handler_identity="sandboxes.pull_outputs_command",
        input_model=SandboxPullOutputsInput,
        description=(
            "Return a filled rsync command for selected files or directories "
            "under a running sandbox's experiment_dir. The calling agent runs "
            "the command itself with its own SSH key and local destination; "
            "bytes move directly from the sandbox to the caller. Use object "
            "storage tools for heavy artifacts. Use this before artifact.submit "
            "or sandbox.release; omit paths to pull common retained outputs."
        ),
    ),
    "sandbox.list": ToolContract(
        handler_identity="sandboxes.list_sandboxes",
        input_model=SandboxListInput,
        description=(
            "List this project's sandboxes (project-shared: every sandbox in the "
            "key's project, not just ones this caller provisioned)."
        ),
    ),
    "sandbox.release": ToolContract(
        handler_identity="sandboxes.release",
        input_model=SandboxReleaseInput,
        description=(
            "Terminate a sandbox by experiment_id or sandbox_uid (permanently "
            "destroys the VM and everything on it) and capture a best-effort "
            "metrics snapshot. "
            "Two-step by design: the first call WITHOUT confirm_retained does "
            "not delete — it returns a retention checklist asking you to confirm "
            "you have everything you need. Retain first with sandbox.pull_outputs "
            "for light files and configured durable storage for heavy ones when "
            "available, then "
            "re-call with confirm_retained=true to actually terminate."
        ),
    ),
    "sandbox.extend": ToolContract(
        handler_identity="sandboxes.extend",
        input_model=SandboxExtendInput,
        description=(
            "Extend a running sandbox's expiry by at most one 30-minute "
            "increment, subject to provider support and tenant lifetime/spend "
            "quotas. Modal may reject this because its provider timeout is "
            "fixed when the sandbox is created."
        ),
    ),
    "sandbox.runs": ToolContract(
        handler_identity="sandboxes.runs",
        input_model=SandboxRunsInput,
        description=(
            "List merv_run launches for a sandbox or experiment: label, status, "
            "exit_code, started/finished timestamps, and log path — one compact "
            "call instead of transcript polling. Launch long work on the sandbox "
            "with `merv_run <label> -- <command>` (detaches, survives SSH "
            "disconnect, writes an exit_code sentinel), then long-poll here with "
            "wait_seconds. On HTTP surfaces holding a wait key, each row also "
            "carries a signed `wait_url`: arm `merv-runs-wait --url <wait_url>` "
            "as a background process right after launching and the finished run "
            "wakes you, instead of the box billing idle until you next poll; a "
            "row without one means keyed mode (`merv-runs-wait --project-id ... "
            "--sandbox-uid ... --label ...`). "
            "Status is running, finished, lost, or unknown. "
            "`unknown` means the box died before its receipts could be read, so "
            "the run's outcome is NOT known — it may well have succeeded, and it "
            "must never be recorded as a failure. Its logs and unpulled outputs "
            "died with the box; check what you retained (pulled outputs, "
            "submitted artifacts) and re-run if nothing survived. "
            "`lost` is a finding: the receipts WERE read and no sentinel was "
            "there. "
            "Receipts outlive the sandbox: finished runs stay queryable after "
            "release or expiry (logs/outputs do not — pull those before the box "
            "dies)."
        ),
    ),
    "sandbox.terminal": ToolContract(
        handler_identity="sandboxes.terminal",
        input_model=SandboxTerminalInput,
        description=(
            "Read a sandbox terminal transcript by experiment_id or sandbox_uid. "
            "For polling, pass "
            "since=<cursor from the last response> to get only NEW output "
            "instead of re-pulling the whole tail; 'running' indicates whether "
            "the sandbox is still alive so you can stop polling a finished one. "
            "Per-command status: 'command_running' is true while a command is "
            "in flight, and once it finishes 'last_exit_code' (0 = success) and "
            "'last_command_finished_at' report its result — so you can tell a "
            "command is done and whether it succeeded without re-reading output "
            "(null on sandboxes created before this was added). The structured "
            "'last_command' block persists the latest parsed command id, text, "
            "status, exit code, timestamps, and output tail; "
            "'command_status_stale' is true when that block is from the last "
            "successful transcript read because the current read failed."
        ),
    ),
    "sandbox.health": ToolContract(
        handler_identity="sandboxes.health",
        visibility="internal",
        input_model=EmptyInput,
        description="Check the execution backend is reachable.",
    ),
}

# Social feed (Feed_PRD.md) registers its tools from its own module so the feed
# stays a liftable feature: this is the single integration point with the tool
# manifest. The merge happens before the derived sets below so the brain tool
# surface includes the feed tools. (feed_contracts imports the base classes above; this
# bottom-of-section import is safe because they are already defined.)
from .feed_contracts import FEED_TOOL_CONTRACTS  # noqa: E402

TOOL_MANIFEST.update(FEED_TOOL_CONTRACTS)

# Compatibility name for callers that describe the manifest as contracts.
TOOL_CONTRACTS = TOOL_MANIFEST
STORAGE_TOOL_NAMES = {
    name
    for name, tool in TOOL_MANIFEST.items()
    if "storage" in tool.feature_requirements
}
SANDBOX_TOOL_NAMES = {
    name
    for name, tool in TOOL_MANIFEST.items()
    if tool.handler_identity.startswith("sandboxes.")
}
MCP_HIDDEN_TOOL_NAMES = frozenset(
    name for name, tool in TOOL_MANIFEST.items() if tool.visibility == "internal"
)
LEGACY_TRACKING_TOOL_NAMES = frozenset({"mlflow.context", "mlflow.finalize_run"})


def available_tool_names(
    *,
    storage_enabled: bool,
    tracking_enabled: bool = False,
    sandbox_enabled: bool = True,
) -> set[str]:
    """Tool names for the active feature set.

    Optional capabilities are omitted rather than advertised as operations
    that will fail when called.
    """
    names = set(TOOL_MANIFEST)
    if not storage_enabled:
        names -= STORAGE_TOOL_NAMES
    if not tracking_enabled:
        names -= LEGACY_TRACKING_TOOL_NAMES
    if not sandbox_enabled:
        names -= SANDBOX_TOOL_NAMES
    return names


PROJECT_SCOPED_TOOL_NAMES = {
    name
    for name, tool in TOOL_MANIFEST.items()
    if tool.scope_strategy == "linked-project"
}
