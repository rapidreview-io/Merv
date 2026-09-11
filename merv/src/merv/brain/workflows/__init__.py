"""Versioned workflow definitions, runtime and composition."""

from .definitions import artifact_roles, documents, research_contracts
# The record kinds Research speaks about by name. Which of them a brain
# installs is its program's business; this only publishes the declarations.
from .definitions.experiment import KIND as EXPERIMENT_KIND
from .definitions.reflection import KIND as REFLECTION_KIND, present_reflection_signal, published_followups
from .definitions.task import KIND as TASK_KIND
from .definitions.artifact_roles import (
    ARTIFACT_TARGET_TYPES, ARTIFACT_TOOL_VOCABULARY, EXHIBIT_ROLE, GATED_ROLES,
    METRIC_RESULT_MAX_BYTES, PROJECT_GRAPH_ROLE, REFLECTION_LENS_DOC_ROLE,
    SUBMITTABLE_ROLES, TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE,
)
from .definitions.artifacts import artifact_references, retain_artifacts
from .definitions.documents import (
    MAX_GRAPH_NODES, ArtifactDocument, artifact_state_record,
    artifact_submission_recency_key, brief_checks, claim_refs, delivery_results,
    delivery_section, depends_on_refs, graph_diff, graph_diff_summary, graph_problems,
    latest_per_slot, parse_change_spec, preferred_artifact, reflection_coverage_for,
    render_task_brief, require_artifact_document, task_deliverables,
    validate_reflection_roster,
)
from .composition import Child, ChildResult, join_guard, wait_for_all
from .delivery import Deliveries, Delivery
from .graph import (
    Action, ArtifactNeed, Brief, Change, CreationRequirement, DependenciesDone, Edge, Evaluation, Execution, Guidance, Issue,
    Knowledge, Metadata, Node, Program, Public, RecordKind, RecordNeed, Reference, Registry, Requirement,
    ReviewGate, ReviewReturn, Scope, Snapshot, Workflow, WorkspacePolicy, all_of,
)
from .runtime import InstanceFact, Runtime, snapshot_view
from .tools import TOOLS
from .workflows import Binding, Connection, Workflows

__all__ = [
    "Connection",
    "artifact_roles", "documents", "research_contracts",
    "EXPERIMENT_KIND", "REFLECTION_KIND", "TASK_KIND", "present_reflection_signal", "published_followups",
    "ARTIFACT_TARGET_TYPES", "ARTIFACT_TOOL_VOCABULARY", "EXHIBIT_ROLE", "GATED_ROLES",
    "METRIC_RESULT_MAX_BYTES", "PROJECT_GRAPH_ROLE", "REFLECTION_LENS_DOC_ROLE",
    "SUBMITTABLE_ROLES", "TASK_BRIEF_ROLE", "TASK_DELIVERY_ROLE",
    "artifact_references", "retain_artifacts", "join_guard",
    "MAX_GRAPH_NODES", "ArtifactDocument", "artifact_state_record",
    "artifact_submission_recency_key", "brief_checks", "claim_refs", "delivery_results",
    "delivery_section", "depends_on_refs", "graph_diff", "graph_diff_summary",
    "graph_problems", "latest_per_slot", "parse_change_spec", "preferred_artifact",
    "reflection_coverage_for", "render_task_brief", "require_artifact_document",
    "task_deliverables", "validate_reflection_roster",
    "Action", "ArtifactNeed", "Brief", "Change", "CreationRequirement", "Child", "ChildResult", "DependenciesDone",
    "Edge", "Evaluation", "Execution", "Guidance", "InstanceFact", "Issue", "Knowledge", "Metadata", "Node", "Program", "Public", "RecordKind",
    "RecordNeed", "Reference", "Registry", "Requirement", "ReviewGate", "ReviewReturn", "Scope",
    "Snapshot", "Workflow", "WorkspacePolicy",
    "Binding", "Deliveries", "Delivery", "Runtime", "TOOLS", "Workflows", "snapshot_view", "all_of", "wait_for_all",
]
