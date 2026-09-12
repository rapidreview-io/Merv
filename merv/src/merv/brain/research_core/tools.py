# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""MCP tool contracts for research work.

Research owns the schema and prose of every experiment, task, reflection,
consolidation, review, claim, candidate, and literature call. Their enums and
transition names are read off the workflows this component defines, so a
workflow change cannot leave the agent-facing contract stale.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from ..kernel.tools import ContractModel, ProjectScopedInput, ToolContract
from ..workflows import documents
from .policy import (CLAIM_CONFIDENCES, CLAIM_STATUSES, EXPERIMENT, REFLECTION,
                     REVIEW_VERDICT_VALUES, TASK)

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
_REFLECTION_PUBLISH_TRANSITION = next(edge.name for edge in REFLECTION.workflow.edges
                                      if edge.target == REFLECTION.success_status)


class ProjectContextUpdateInput(ProjectScopedInput):
    summary: str = Field(description="The project background, goal and scope, in the user's meaning.")
    expected_summary: Annotated[str, StringConstraints(strip_whitespace=False)] = Field(
        description="Exact summary last read; a stale value rejects the entire write.")


class SynthesisReadInput(ProjectScopedInput):
    instance_id: str


class CandidateSubmitInput(ProjectScopedInput):
    name: str = Field(min_length=1, max_length=200)
    source_kind: Literal["artifact", "storage_object", "experiment_workspace"]
    source_ref: str = Field(min_length=1, max_length=500, description="Artifact, storage object or experiment id per source_kind; never a path or URI.")
    expected_sha256: str = Field(default="", pattern=r"^[0-9a-f]{64}$|^$", description="experiment_workspace only: expected digest of the task-defined path.")
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
    expected_champion_id: str = Field(description="The champion id candidate.list showed, or '' when none; prevents stale overwrites.")
    reason: str = Field(min_length=20, max_length=2000)


class ClaimCreateInput(ProjectScopedInput):
    statement: str
    scope: str = ""
    confidence: Literal[*sorted(CLAIM_CONFIDENCES)] = "medium"


class ClaimUpdateInput(ProjectScopedInput):
    claim_id: str
    status: Literal[*sorted(CLAIM_STATUSES)] | None = None
    confidence: Literal[*sorted(CLAIM_CONFIDENCES)] | None = None


class ExperimentCreateInput(ProjectScopedInput):
    name: str = Field(
        default="",
        description="Required. Folder-safe (letters, digits, . _ -), unique in the project, naming the contrast with sibling experiments; becomes experiments/<name>/.",
    )
    intent: str = Field(
        default="",
        description="Required. The ask in one standalone line: what this tests and why the project needs it, naming datasets, tasks and siblings. Method belongs in plan.md.",
    )
    details: str = Field(
        default="",
        description="Advice for whoever writes the plan (givens, boundaries, budgets); immutable, superseded by the approved plan.",
    )
    tested_claim_ids: documents.WrittenList = Field(default_factory=list, description="claim_ ids this experiment tests.")
    depends_on: documents.WrittenList = Field(
        default_factory=list,
        description="exp_/task_ ids this experiment must not start before; they become wave DAG edges.",
    )


class ExperimentGetStateInput(ProjectScopedInput):
    experiment_id: str
    review_id: str = Field(default="", description="A review id from the 'reviews' list, to receive its full body.")


class ExperimentExhibitInput(ProjectScopedInput):
    experiment_id: str


class ExperimentTransitionInput(ProjectScopedInput):
    experiment_id: str
    transition: Literal[*EXPERIMENT_TRANSITION_VALUES]
    evidence: dict[str, Any] | None = Field(
        default=None,
        description=(f"{_EXPERIMENT_RETRY_TRANSITION}: {{'reason', 'detail'}}; abandon and mark_failed: "
                     "{'reason': why the owner ended it}."),
    )


class TaskCreateInput(ProjectScopedInput):
    name: str = Field(
        default="",
        description="Required. Folder-safe (letters, digits, . _ -), unique among the project's tasks, naming the deliverable; becomes tasks/<name>/.",
    )
    goal: str = Field(
        default="",
        description="Required. What needs doing and why, standalone (name datasets, tools and experiments); no method. Immutable.",
    )
    deliverables: documents.WrittenList = Field(
        default=None,
        description="Required. One item per thing that must exist when done, each verifiable as written; 1-7 items. Immutable.",
    )
    depends_on: documents.WrittenList = Field(
        default_factory=list,
        description="exp_/task_ ids this task must not deliver before; they become wave DAG edges.",
    )


class TaskGetStateInput(ProjectScopedInput):
    task_id: str
    review_id: str = Field(default="", description="A review id from the 'reviews' list, to receive its full body.")


class TaskTransitionInput(ProjectScopedInput):
    task_id: str
    transition: Literal[*TASK_TRANSITION_VALUES]
    evidence: dict[str, Any] | None = Field(
        default=None,
        description="accept: {'outcome': note} optionally; mark_failed requires {'reason': why the owner ended it}.",
    )


class ReflectionCreateInput(ProjectScopedInput):
    title: str = Field(default="", description="Optional headline for this wave.")
    lenses: list[documents.ReflectionLens] = Field(
        default_factory=list,
        description=(
            "Exactly 5 lenses: the core amplify, avoid and entropy plus 2 you design, each with a charter "
            f"and why_distinct; fixed at create, and every lens submits before {_REFLECTION_FIRST_TRANSITION}."
        ),
    )


class ReflectionGetInput(ProjectScopedInput):
    reflection_id: str
    include_content: bool = Field(
        default=False,
        description="true returns the exact bounded document text instead of TLDRs.",
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
    target_type: str = Field(min_length=1)
    target_id: str
    role: str = Field(min_length=1, max_length=128)
    reason: str = ""
    producer_session_id: str = "main"


class ReviewStartInput(ContractModel):
    review_request_id: str
    reviewer_capability: str = Field(description="The handoff capability, or 'assigned' in an assigned auto-run reviewer session.")
    caller_session_id: str = Field(
        default="",
        description="Your own stable session id, which must differ from the producer's; 'assigned' in an assigned auto-run session.",
    )


class ReviewSubmitInput(ContractModel):
    review_session_id: str
    verdict: Literal[*REVIEW_VERDICT_VALUES]
    synopsis: str = Field(
        description=(
            "The researcher's TLDR, 1-3 plain sentences (40-420 chars): what was tried, what happened, whether it "
            "holds; human names, one decisive number with its baseline, no ids, markdown or newlines."
        )
    )
    return_to: str = Field(
        default_factory=str,
        description=(
            "Where a rejected target goes; omit on pass. Experiment attempt rejections: "
            f"{_EXPERIMENT_PLAN_RETURN.to_status!r} if the plan is flawed, {_EXPERIMENT_EXECUTION_RETURN.to_status!r} "
            f"if only execution or conclusions are (design rejections always {_EXPERIMENT_PLAN_RETURN.to_status!r}). "
            f"Reflection rejections: {_REFLECTION_RERUN_RETURN.to_status!r} to re-run the fan-out, "
            f"{_REFLECTION_REVISION_RETURN.to_status!r} to revise the artifacts. Tasks: needs_changes returns to "
            f"{_TASK_REVIEW_RETURN.to_status!r} (omit); fail ends the task ({_TASK_FAIL_STATUS!r})."
        ),
    )
    notes: str = Field(default="", description="Free-text summary of the review.")
    findings: list[dict[str, Any]] = Field(
        default_factory=list,
        description='Issue objects, e.g. [{"issue": "no held-out test set", "severity": "high"}].',
    )
    evidence: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured rationale (metrics, checks run); unknown top-level fields are rejected.",
    )


class ReviewStatusInput(ProjectScopedInput):
    target_type: str = Field(min_length=1)
    target_id: str


class LitreviewViewInput(ProjectScopedInput):
    section: str = Field(default="", max_length=200, description="A section id or exact title ('summary' = General Summary); empty = the outline.")
    papers: bool = Field(default=False, description="Return the papers ledger instead of the document.")
    cursor: int = Field(default=0, ge=0, description="papers=true: next_cursor from the previous page.")
    limit: int = Field(default=20, ge=1, le=50, description="papers=true: page size.")


class LitreviewOrderPair(ContractModel):
    id: str = Field(max_length=64)
    revision: int = Field(ge=1, description="The revision you last read.")


class LitreviewEditInput(ProjectScopedInput):
    op: Literal["add", "edit", "delete", "reorder"] = Field(
        description=(
            "add = new section (title + tldr); edit = change only the fields you pass; delete = remove a section "
            "and its citation links; reorder = set the whole order. edit/delete need expected_revision; never rewrite the document."
        )
    )
    section: str = Field(default="", max_length=200, description="edit/delete: section id or exact title; 'summary' is the General Summary (expected_revision=0 to write it first).")
    title: str = Field(default="", max_length=200, description="add: required; edit: rename.")
    tldr: str = Field(default="", max_length=500, description="One-glance summary; required on add and whenever body changes.")
    body: str = Field(default="", description="Markdown, max 16,000 bytes; cite papers inline by paper_ id.")
    expected_revision: int | None = Field(default=None, ge=0, description="edit/delete: the revision you last read; on mismatch re-read and retry.")
    order: list[LitreviewOrderPair] | None = Field(default=None, max_length=64, description="reorder: every dynamic section as {id, revision} in the new order.")

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
    id: str = Field(max_length=200, description="Target id; section ids may be exact titles.")


class LitreviewCiteInput(ProjectScopedInput):
    url: str = Field(default="", max_length=2048, description="Paper URL; arXiv/DOI forms are normalized.")
    doi: str = Field(default="", max_length=256, description="Bare DOI.")
    arxiv_id: str = Field(default="", max_length=64, description="Bare arXiv id.")
    targets: list[LitreviewCiteTarget] = Field(default_factory=list, max_length=20, description="Where the paper is used; may be empty.")
    note: str = Field(default="", max_length=300, description="Why this paper matters here.")
    title: str = Field(default="", max_length=200, description="Fallback title when the host is off the fetch allowlist.")

    @model_validator(mode="after")
    def _one_identity(self) -> "LitreviewCiteInput":
        provided = [v for v in (self.url, self.doi, self.arxiv_id) if v]
        if len(provided) != 1:
            raise ValueError("provide exactly one of url, doi, or arxiv_id")
        return self


TOOLS: dict[str, ToolContract] = {
    "project.synthesis.read": ToolContract(
        handler_identity="synthesis.inputs", input_model=SynthesisReadInput,
        description="Read the writing assignment's pinned changes and evidence plus the current published project document.",
    ),
    "project.context.update": ToolContract(
        handler_identity="research.update_project_context",
        input_model=ProjectContextUpdateInput,
        description=("Write the project Introduction: one paper-style paragraph with an explicit goal and scope, grounded in "
            "what the user said (ask when ambiguity affects direction; never invent intent). Pass the last-read summary as "
            "expected_summary; reread on conflict."),
    ),
    "candidate.submit": ToolContract(
        handler_identity="application.submit_candidate",
        input_model=CandidateSubmitInput,
        description="Register a complete artifact/object, or nominate an experiment workspace for evaluator staging, as a champion candidate. Retries reuse idempotency_key.",
    ),
    "candidate.stage": ToolContract(
        handler_identity="application.stage_candidate",
        input_model=CandidateStageInput,
        description="Attach a verified durable receipt to a pending workspace candidate; no filesystem path or URI is accepted.",
    ),
    "candidate.list": ToolContract(
        handler_identity="research.list_candidates",
        input_model=ProjectScopedInput,
        description="List candidates, promotion history and the current champion.",
    ),
    "candidate.promote": ToolContract(
        handler_identity="research.promote_candidate",
        input_model=CandidatePromoteInput,
        description="Promote a staged candidate, passing the champion id you observed; pending workspace candidates cannot be promoted.",
    ),
    "claim.create": ToolContract(
        handler_identity="research.create_claim",
        input_model=ClaimCreateInput,
        description="Create a claim; check the project overview for settled or duplicate work first.",
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
        description="Update status or confidence; statement and scope are immutable (propose text changes through a reviewed reflection change spec).",
    ),
    "experiment.create": ToolContract(
        handler_identity="application.create_experiment",
        input_model=ExperimentCreateInput,
        description=(f"Create a {EXPERIMENT.workflow.initial} experiment. Returns {{id, name, status, folder, next}}: create "
            "experiments/<name>/ locally yourself (plan, scripts, results, report and graph live there; nothing reaches a "
            "sandbox unless you transfer it) and write the document `next` names. See research-workflow."),
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
        description="Internal experiment state. Agents use workflow.status_and_next for context and artifact.read for documents.",
    ),
    "experiment.transition": ToolContract(
        handler_identity="application.transition_experiment",
        input_model=ExperimentTransitionInput,
        description=("Apply a transition workflow.status_and_next allows; returns status, attempt and event receipts. "
            f"{_EXPERIMENT_RETRY_TRANSITION} keeps the approved plan and attempt. See research-workflow."),
    ),
    "experiment.exhibit": ToolContract(
        handler_identity="application.exhibit",
        input_model=ExperimentExhibitInput,
        description=f"Preview the metrics exhibit of a {_EXPERIMENT_EXECUTION_STATUS} experiment from its pinned result JSON.",
    ),
    "task.create": ToolContract(
        handler_identity="application.create_task",
        input_model=TaskCreateInput,
        description=(f"Create an {TASK.workflow.initial} task with an immutable goal and verifiable deliverables; pins brief.md. "
            "Returns {id, name, status, folder, next}: write the delivery document `next` names in tasks/<name>/. See research-workflow."),
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
        description="Internal task state. Agents use workflow.status_and_next(task_id=...) for context.",
    ),
    "task.transition": ToolContract(
        handler_identity="application.transition_task",
        input_model=TaskTransitionInput,
        description=("Apply a task transition (" + ", ".join(TASK.actions) + "); returns a compact receipt. See research-workflow."),
    ),
    "reflection.create": ToolContract(
        handler_identity="application.create_reflection",
        input_model=ReflectionCreateInput,
        description="Open one reflection wave with three core and two authored lenses and snapshot its corpus. See project-reflection.",
    ),
    "reflection.get": ToolContract(
        handler_identity="application.reflection",
        input_model=ReflectionGetInput,
        description=("Read a wave: coverage, artifact TLDRs, reviews, gate checklist and project graph diff; "
            "include_content=true adds the exact bounded documents."),
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
        description=("Apply a reflection transition (" + ", ".join(REFLECTION.actions) + "); "
            f"{_REFLECTION_PUBLISH_TRANSITION} belongs to the runner after reviewed central advance. See project-reflection."),
    ),
    "consolidation.get": ToolContract(
        handler_identity="application.consolidation",
        input_model=ConsolidationGetInput,
        description="Read the approved reflection, the immutable experiment SHA/summary packet, proposal coverage and review feedback.",
    ),
    "consolidation.submit": ToolContract(
        handler_identity="application.submit_consolidation",
        binds_producer_session="agent",
        input_model=ConsolidationSubmitInput,
        description="Submit the immutable base/proposal SHAs, validation and every experiment's integration decision; the approved reflection stays fixed. See project-reflection.",
    ),
    "review.start": ToolContract(
        handler_identity="application.start_review",
        scope_strategy="capability",
        telemetry_scope_field="review_request_id",
        binds_capability="review_request_id",
        input_model=ReviewStartInput,
        description=("Start the reviewer session for a request and return its pinned evidence: documents inline, other ids "
            "(logic graph, metrics exhibit) via artifact.read include_content=true. Assigned auto-run reviewers pass "
            "'assigned' twice. Follow the returned review skill, then review.submit."),
    ),
    "review.submit": ToolContract(
        handler_identity="application.submit_review",
        binds_caller_session=True,
        scope_strategy="capability",
        telemetry_scope_field="review_session_id",
        input_model=ReviewSubmitInput,
        description=("Submit the verdict, synopsis, notes, findings and evidence atomically with its graph route; "
            "a rejection names return_to where the graph offers a choice. Unknown top-level fields are rejected."),
    ),
    "review.status": ToolContract(
        handler_identity="application.review_status",
        visibility="internal",
        input_model=ReviewStatusInput,
        description="Inspect a target's review requests, submissions and expired-capability recovery guidance.",
    ),
    "litreview.view": ToolContract(
        handler_identity="litreview.view",
        input_model=LitreviewViewInput,
        description="Read the outline by default, one full section by id or title, or the papers ledger with papers=true.",
    ),
    "litreview.edit": ToolContract(
        handler_identity="litreview.edit",
        input_model=LitreviewEditInput,
        description="Add, edit, delete or reorder sections with revision checks; keep each TLDR current. See research-workflow.",
    ),
    "litreview.cite": ToolContract(
        handler_identity="litreview.cite",
        input_model=LitreviewCiteInput,
        description="Register one paper (url, doi or arxiv_id) and link it to sections, experiments or claims. See research-workflow.",
    ),
}


def review_request_tool(workflows) -> ToolContract:
    """review.request over every installed workflow's read-only reviewer node, so the roles an agent sees are the registered ones."""
    gates = [(workflow.name, node.name, node.role) for workflow in workflows
             for node in workflow.nodes if node.role and node.execution.read_only]

    class Input(ReviewRequestInput):
        target_type: str = Field(min_length=1, description="One of " + ", ".join(dict.fromkeys(name for name, _, _ in gates)) + ".")
        role: str = Field(min_length=1, max_length=128, description="The reviewer role of the gate the target waits at (review_gate.role in status): "
                          + ", ".join(f"{role} ({name} {state})" for name, state, role in gates) + ".")

    return ToolContract(
        handler_identity="application.request_review", binds_producer_session="session", input_model=Input,
        description=("Open a review at the target's active gate: returns a one-time capability and reviewer_handoff.spawn_prompt "
                     "for a separate reviewer. When the reviewer reports back, call workflow.status_and_next; a pass advances the target by itself."),
    )
