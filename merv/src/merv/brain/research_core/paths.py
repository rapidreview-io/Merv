# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Filesystem-safe names for research-owned local folders."""

from __future__ import annotations


def safe_experiment_dirname(experiment_id: str) -> str:
    """Return a filesystem-safe experiment directory name."""
    return (
        "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in experiment_id)
        or "experiment"
    )
