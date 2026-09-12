"""One project-wide author, using workflow revisions for publication and recovery."""

import json
import re
from typing import Literal

from pydantic import Field, ValidationError as InputError

from ...kernel.tools import ContractModel
from ...kernel.utils import WorkflowError
from ..graph import Change, Edge, Execution, Guidance, Issue, Node, Reference, Workflow
from .checks import project_brief
from .execution import KNOWLEDGE_TOOLS, RESEARCH_HANDOFF, owner_scopes


class Citation(ContractModel):
    kind: Literal["experiment", "reflection", "artifact"]
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)


class Publication(ContractModel):
    methods: str = Field(min_length=1)
    results: str = Field(min_length=1)
    references: list[Citation]
    editorial_note: str = Field(min_length=1, description="What was consolidated, corrected or omitted, and why.")


AUTHORING = (
    "Rewrite the project's Methods and Results as a SHORT, accurate account of current knowledge. "
    "Read project.synthesis.read for this assignment's immutable input snapshot and fetch the cited evidence. "
    "Methods must connect approaches tried, lessons, the rationale for changes, and current or awaited work. "
    "Results selectively retain important supporting AND contrary findings with their uncertainty. "
    "Write comparison tables directly in Results using Markdown pipe tables, with metric names, units, "
    "uncertainty and evidence references; compare only compatible measurements. "
    "If a figure helps explain a result, reference its retained image artifact as ![Descriptive caption](art_ID) "
    "and include that artifact ID in references. The UI renders the figure and caption; do not embed bytes "
    "or use local paths or temporary URLs. Figures are optional. "
    "When an experiment enters running, revise Methods to connect its purpose and approach to the research story. "
    "Place its bare exp_ID on its own paragraph where the story leads into it, and include it in references; "
    "the UI renders that reference as a card with live status. Use ordinary inline citations for historical evidence. "
    "Do not add a separate live-experiments heading, inventory or empty-state prose. "
    "When an experiment reaches a final state, revise Methods to incorporate what happened, replacing the card "
    "with concise prose and an inline citation when appropriate. Update Results where the evidence warrants it; "
    "otherwise retain Results. A terminal status alone is not a scientific finding. "
    "Distinguish established findings from ongoing/provisional work; completion alone is not evidence of success. "
    "After a reflection wave, reconcile conclusions across experiments with the reviewed synthesis. "
    "Revise and compress the existing account: replace superseded explanations, merge repeated findings, "
    "and remove detail recoverable from the cited records. Never append one paragraph per experiment or wave. "
    "A larger history should yield a better synthesis, not a proportionally longer document. "
    "Cite selected experiment/reflection IDs and immutable artifact IDs; refer to live status through these "
    "references rather than asserting that a job is still running. Inspect the evidence, not just event titles. "
    "Before publishing, read the whole revision for causal coherence, lost contrary evidence, unsupported claims "
    "and unnecessary length. Explain what changed or was omitted in editorial_note. Supply methods, results, references [{kind,id,label}], and editorial_note in "
    "workflow.transition(action='publish'). The server uses the pinned input coverage, never a caller-supplied cursor. "
    "If the source context changed, use action='refresh' and hand off; coverage and published text remain unchanged. "
    "Do not edit user intent or literature. If no established result exists, say so. "
    "Evidence details stay in records; project(action='records') and artifact.read retrieve them."
)


def pending(snapshot, knowledge):
    if not knowledge.read(Reference("synthesis_pending", snapshot.project_id))["events"]:
        return Issue("synthesis_current", "No unincorporated research changes.")


def prepare(snapshot, payload, knowledge):
    if payload:
        raise WorkflowError("prepare takes no payload")
    return Change(data={"source": knowledge.read(Reference("synthesis_source", snapshot.project_id))})


def context(snapshot, knowledge):
    source = snapshot.data["source"]
    refs = tuple(Reference(**ref) for ref in source["references"])
    return project_brief(snapshot, knowledge,
        AUTHORING + "\n\nPinned changes:\n" + json.dumps([dict(event) for event in source["events"]], ensure_ascii=False), refs)


def publish(snapshot, payload, knowledge):
    try:
        publication = Publication.model_validate(dict(payload))
    except InputError as exc:
        raise WorkflowError(str(exc)) from exc
    source = snapshot.data["source"]
    basis = knowledge.read(Reference("synthesis_basis", snapshot.project_id))
    if basis != source["basis"]:
        raise WorkflowError("User intent or literature changed; refresh before synthesizing again.")
    figures = set(re.findall(r"!\[[^\]]*\]\(\s*(art_\w+)(?=[\s)])", publication.methods + "\n" + publication.results))
    cited_artifacts = {ref.id for ref in publication.references if ref.kind == "artifact"}
    if figures - cited_artifacts:
        raise WorkflowError("Include every figure artifact in references.")
    allowed = {(ref["kind"], ref["id"]) for ref in source["references"]}
    for ref in publication.references:
        if (ref.kind, ref.id) not in allowed:
            raise WorkflowError("A citation is outside this assignment's pinned evidence; refresh before using new evidence.")
        if ref.kind == "artifact":
            knowledge.read(Reference("artifact", ref.id))
    return Change(data={**publication.model_dump(), "covered_event": source["through_event"], "source": {}})


def refresh(snapshot, payload, knowledge):
    if payload:
        raise WorkflowError("refresh takes no payload")
    return Change(data={"source": {}})


PROJECT_SYNTHESIS = Workflow(
    name="project_synthesis", version=1, initial="waiting", id_prefix="psyn",
    outcomes={},
    nodes=(
        Node("waiting", "Project synthesis is current or awaiting preparation"),
        Node("writing", "Revise the living project document", role="project_author", build_context=context,
             guidance=Guidance(handoff=RESEARCH_HANDOFF),
             execution=Execution(tools=KNOWLEDGE_TOOLS | {"project.synthesis.read"},
                                 scope=owner_scopes("instance_id"))),
    ),
    edges=(
        Edge("waiting", "prepare", "writing", check=pending, change=prepare,
             label="Pin accumulated changes for synthesis"),
        Edge("writing", "publish", "waiting", change=publish, label="Publish the revised Methods and Results"),
        Edge("writing", "refresh", "waiting", change=refresh, label="Discard input snapshot and prepare again"),
    ),
)
