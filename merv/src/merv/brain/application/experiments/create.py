# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Experiment creation application command."""

from __future__ import annotations

from typing import TypedDict, Unpack

from ...kernel.utils import ValidationError, safe_experiment_dirname
from ...research_core import EXPERIMENT_WORKFLOW, ExperimentState, Research
from .presentation import rich_experiment_state


class ExperimentCreateArgs(TypedDict, total=False):
    """Public compatibility fields translated before Research sees them."""

    name: str
    intent: str
    tested_claim_ids: list[str] | str | None
    claim_id: str | None
    claim_ids: list[str] | str | None
    title: str
    hypothesis: str
    design: str
    success_criteria: str
    risks: str
    status: str
    depends_on: list[str] | str | None
    project_id: str | None


def experiment_folder(*, experiment_id: str, name: str = "") -> str:
    folder = safe_experiment_dirname(name.strip() or experiment_id)
    return f"experiments/{folder}/"


def create_experiment(
    research: Research, **kwargs: Unpack[ExperimentCreateArgs]
) -> ExperimentState:
    """Translate released aliases, create in Research, and add folder guidance."""
    initial = EXPERIMENT_WORKFLOW.initial
    status = str(kwargs.pop("status", initial) or initial)
    if status != initial:
        raise ValidationError(
            f"experiment.create only supports status={initial!r}; use "
            "experiment.transition for workflow changes"
        )
    legacy_intent = [
        str(kwargs.pop(field, "") or "").strip()
        for field in ("title", "hypothesis", "design", "success_criteria", "risks")
    ]
    intent = str(kwargs.pop("intent", "") or "").strip() or next(
        (value for value in legacy_intent if value),
        "",
    )
    claim_values: list[str] = []
    for value in (
        kwargs.pop("tested_claim_ids", None),
        kwargs.pop("claim_id", None),
        kwargs.pop("claim_ids", None),
    ):
        if isinstance(value, str):
            claim_values.append(value)
        elif value:
            claim_values.extend(value)
    claim_ids: list[str] = []
    for claim_id in claim_values:
        if not isinstance(claim_id, str) or not claim_id.strip():
            raise ValidationError("claim ids must be non-empty strings")
        if claim_id not in claim_ids:
            claim_ids.append(claim_id)
    state = research.create_experiment(
        name=str(kwargs.pop("name", "") or ""),
        intent=intent,
        tested_claim_ids=claim_ids,
        depends_on=kwargs.pop("depends_on", None),
        project_id=kwargs.pop("project_id", None),
    )
    if kwargs:
        raise ValidationError(
            "unexpected experiment.create fields: " + ", ".join(sorted(kwargs))
        )
    state["folder"] = experiment_folder(
        experiment_id=str(state.get("id") or ""),
        name=str(state.get("name") or ""),
    )
    state["folder_guidance"] = (
        f"Use {state['folder']} as the experiment's one local folder. "
        "Create it yourself before working in it: plan.md, scripts, configs, "
        "retained results, report, and graph all live there. This local folder "
        "is not uploaded to a sandbox automatically: create, fetch, or explicitly "
        "transfer sandbox inputs after provisioning. Pull selected light outputs "
        "back with sandbox.pull_outputs, or upload heavy outputs to configured "
        "object storage, before the sandbox is released."
    )
    return rich_experiment_state(state, storage_objects=())


__all__ = [
    "ExperimentCreateArgs",
    "create_experiment",
    "experiment_folder",
]
