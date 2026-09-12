# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Experiment creation application command."""

from __future__ import annotations

from typing import Any, TypedDict, Unpack

from ...research_core import (
    Research,
    project_fields,
    safe_experiment_dirname,
)
from ...workflows import documents


class ExperimentCreateArgs(TypedDict, total=False):
    name: str
    intent: str
    details: str
    tested_claim_ids: list[str] | str | None
    depends_on: list[str] | str | None
    project_id: str | None


def experiment_folder(*, experiment_id: str, name: str = "") -> str:
    folder = safe_experiment_dirname(name.strip() or experiment_id)
    return f"experiments/{folder}/"


def create_experiment(
    research: Research, **kwargs: Unpack[ExperimentCreateArgs]
) -> dict[str, Any]:
    """Create in Research and add folder guidance."""
    state = research.experiments.create(**kwargs)
    return creation_receipt(state, folder=experiment_folder(experiment_id=state.id, name=state.name))


_SECTIONS = {"plan": documents.REQUIRED_PLAN_SECTIONS, "delivery": documents.REQUIRED_DELIVERY_SECTIONS}


def creation_receipt(state, *, folder: str) -> dict[str, Any]:
    """What a fresh record's creator needs next: its identity, its folder, and the first document to write."""
    item = next(item for item in state.gate_checklist.items if not item.satisfied)
    step = {"action": item.action, "role": item.role}
    if item.role in _SECTIONS:
        step.update(tool="artifact.upload", required_sections=[title for title, _ in _SECTIONS[item.role]])
    return {**project_fields(state, ("id", "name", "status")), "folder": folder, "next": step}


__all__ = [
    "ExperimentCreateArgs",
    "create_experiment",
    "creation_receipt",
    "experiment_folder",
]
