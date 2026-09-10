# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""MCP tool contracts for research work.

Research owns the schema and prose of every experiment, task, reflection,
consolidation, review, claim, candidate, and literature call. Their enums and
transition names are read off the workflows this component defines, so a
workflow change cannot leave the agent-facing contract stale.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract
from ..workflows import documents
from .policy import EXPERIMENT, REFLECTION, REVIEW_VERDICT_VALUES, TASK

# Every enum and every sentence below is read off the graphs, never restated.
EXPERIMENT_TRANSITION_VALUES = EXPERIMENT.actions
REFLECTION_TRANSITION_VALUES = REFLECTION.actions
TASK_TRANSITION_VALUES = TASK.actions
EXPERIMENT_INITIAL_VALUES = (EXPERIMENT.workflow.initial,)
_TASK_REVIEW_RETURN = next(iter(TASK.review_returns))
_TASK_FAIL_STATUS = next(gate.fail_route.to_status for gate in TASK.review_gates
                         if gate.fail_route is not None)
_EXPERIMENT_RESULT_TRANSITION = EXPERIMENT.action_with_effect("result_submission")
_EXPERIMENT_RETRY_TRANSITION = EXPERIMENT.action_with_effect("record_retry_context")
_EXPERIMENT_EXECUTION_STATUS = next(iter(EXPERIMENT.effect_sources("result_submission")))
_EXPERIMENT_PLAN_RETURN = next(
    route for route in EXPERIMENT.review_returns if route.attempt == "new"
)
_EXPERIMENT_EXECUTION_RETURN = next(
    route for route in EXPERIMENT.review_returns if route.attempt == "same"
)
_REFLECTION_RERUN_RETURN = next(
    route for route in REFLECTION.review_returns if route.attempt == "new"
)
_REFLECTION_REVISION_RETURN = next(
    route for route in REFLECTION.review_returns if route.attempt == "same"
)
_REFLECTION_FIRST_TRANSITION = next(
    edge.name for edge in REFLECTION.workflow.edges
    if edge.source == REFLECTION.workflow.initial
)
_REFLECTION_PUBLISH_TRANSITION = REFLECTION.action_with_effect("materialize_change_spec")


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
    tested_claim_ids: documents.WrittenList = Field(default_factory=list)
    claim_id: str | None = Field(
        default=None, description="Alias for a single tested claim id."
    )
    claim_ids: documents.WrittenList = Field(
        default=None, description="Alias for tested_claim_ids."
    )
    depends_on: documents.WrittenList = Field(
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
        default=EXPERIMENT.workflow.initial,
        description=f"Create always starts {EXPERIMENT.workflow.initial}.",
    )


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
    deliverables: documents.WrittenList = Field(
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
    depends_on: documents.WrittenList = Field(
        default_factory=list,
        description=(
            "Optional exp_/task_ ids of the same project this task must not "
            "deliver before; they become wave DAG edges. Empty for ad-hoc work."
        ),
    )


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


class ReflectionCreateInput(ProjectScopedInput):
    title: str = Field(
        default="", description="Optional short headline for this reflection wave."
    )
    lenses: list[documents.ReflectionLens] = Field(
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


class ReflectionTransitionInput(ProjectScopedInput):
    reflection_id: str
    transition: Literal[*REFLECTION_TRANSITION_VALUES]


class ConsolidationGetInput(ProjectScopedInput):
    reflection_id: str


class ConsolidationSubmitInput(ProjectScopedInput):
    reflection_id: str
    base_sha: str
    proposal_sha: str
    summary: str
    validation: dict[str, Any] = Field(default_factory=dict)
    decisions: list[documents.ConsolidationDecision]


class ReviewRequestInput(ProjectScopedInput):
    target_type: str = Field(min_length=1, description="Registered workflow name, such as experiment or replication.")
    target_id: str
    role: str = Field(min_length=1, max_length=128, description="Role declared by the current read-only workflow node.")
    reason: str = ""
    producer_session_id: str = "main"


class ReviewStartInput(ContractModel):
    review_request_id: str
    reviewer_capability: str = Field(
        description="Use the handoff capability, or 'assigned' in the assigned auto-run reviewer session."
    )
    declared_agent: str = ""
    caller_session_id: str = Field(
        description=(
            "The reviewer's OWN session identity (any stable identifier for "
            "the reviewing agent's session). Required: it must be non-empty "
            "and differ from the producer session that requested the review, "
            "so reviewer independence can be verified. In an assigned auto-run "
            "reviewer session, use 'assigned'; the authenticated lease supplies the identity."
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
    return_to: str = Field(
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
    target_type: str = Field(min_length=1)
    target_id: str


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


TOOLS: dict[str, ToolContract] = {
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
        input_model=ProjectScopedInput,
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
            f"Create a {EXPERIMENT.workflow.initial} experiment. Requires an intent (the "
            "ask, one standalone line: what this tests and why, standalone) and a "
            "short folder-safe 'name' unique within the project; the name becomes "
            "the experiment folder experiments/<name>/. Optional 'details' carries "
            "everything else the planner should have."
        ),
    ),
    "experiment.list": ToolContract(
        handler_identity="application.experiments",
        visibility="internal",
        input_model=ProjectScopedInput,
        description="List experiments with state.",
    ),
    "experiment.get_state": ToolContract(
        handler_identity="application.experiment",
        visibility="internal",
        input_model=ExperimentGetStateInput,
        description=(
            "Compatibility-only singular internal experiment state projection. "
            "Agents use workflow.status_and_next for context and artifact.read "
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
            "Passing reviews apply their forward transition automatically; "
            "an assigned worker stops after handing off its node. "
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
            f"Create a {TASK.workflow.initial} task: scoped non-experiment work "
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
        handler_identity="application.tasks",
        visibility="internal",
        input_model=ProjectScopedInput,
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
            "delivery and every dependency done), or mark_failed (the owner ends the "
            "task with evidence={'reason': ...}). Returns a compact "
            "acknowledgement. A passing task_reviewer review completes the task "
            "automatically. An assigned worker stops after submission; interactive "
            "agents refresh workflow.status_and_next(task_id=...)."
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
        input_model=ProjectScopedInput,
        description="List the project's reflection waves with state.",
    ),
    "reflection.transition": ToolContract(
        handler_identity="application.transition_reflection",
        input_model=ReflectionTransitionInput,
        description=(
            "Apply an allowed reflection transition ("
            + ", ".join(REFLECTION.actions)
            + "). See "
            "reflection.get.allowed_transitions for preconditions from the "
            f"current status. {_REFLECTION_PUBLISH_TRANSITION} is internal: "
            "a passing reflection review automatically hands code to a "
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
        binds_producer_session="agent",
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
    "review.request": ToolContract(
        handler_identity="application.request_review",
        binds_producer_session="session",
        input_model=ReviewRequestInput,
        description=(
            "Create a review request and request-scoped reviewer capability; "
            "the plaintext is returned only in this response. The "
            "response's reviewer_handoff.spawn_prompt is a ready-to-use prompt "
            "for the reviewer subagent. The reviewer presents the capability "
            "via review.start with its own caller_session_id. Starting does "
            "not consume it; the first accepted submission closes the request. "
            "Auto-run opens and dispatches reviews when a workflow enters a "
            "review node; its producer stops after that handoff."
        ),
    ),
    "review.start": ToolContract(
        handler_identity="application.start_review",
        scope_strategy="capability",
        telemetry_scope_field="review_request_id",
        binds_capability="review_request_id",
        input_model=ReviewStartInput,
        description=(
            "Start a reviewer session for the pinned request snapshot. The "
            "response includes bounded project orientation and, for an "
            "experiment target, the same canonical four-section context used "
            "by workflow.status_and_next, built only from artifact versions "
            "pinned to the request. Plan/report bodies needed for that review "
            "are included; use artifact.read for deeper reads of the listed "
            "artifact ids. Assigned auto-run reviewers use 'assigned' for both "
            "reviewer_capability and caller_session_id; their scoped credential "
            "enforces the read-only boundary. Interactive reviewers follow the "
            "same skill using the handoff capability."
        ),
    ),
    "review.submit": ToolContract(
        handler_identity="reviews.submit",
        scope_strategy="capability",
        telemetry_scope_field="review_session_id",
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
            "'evidence' — unknown top-level fields are rejected. The verdict and "
            "its graph transition commit together: design pass enters execution, "
            "attempt/task pass completes work, and reflection pass enters "
            "consolidation. Consolidation pass waits for the runner to publish."
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
}
