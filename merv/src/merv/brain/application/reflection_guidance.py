# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Agent-facing wording derived from semantic reflection facts."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def reflection_create_block_reason(*, signal: Mapping[str, Any]) -> str:
    count = signal.get("new_terminal_since_publish", 0)
    threshold = signal["block_new_terminal_threshold"]
    open_id = signal.get("open_reflection_id")
    if open_id:
        return (
            f"{count} experiments have finished since the last published "
            f"reflection (threshold {threshold}); finish and publish open "
            f"reflection wave {open_id} before creating another experiment."
        )
    since = (
        "since the last published reflection"
        if signal.get("last_published_reflection_id")
        else "and no project reflection has been published yet"
    )
    return (
        f"{count} experiments have finished {since} (threshold {threshold}); "
        "publish a project reflection wave before creating another experiment."
    )


def literature_hint(*, signal: Mapping[str, Any]) -> str | None:
    """Soft lit-review nudge (never blocks): fires iff >=3 cited papers have
    no section in the literature review yet."""
    unreviewed = int(signal.get("papers_unreviewed") or 0)
    if unreviewed < 3:
        return None
    return (
        f"{unreviewed} cited papers are not yet worked into the literature "
        "review — consider a targeted litreview.edit (add or amend the one "
        "relevant section)."
    )


def idle_reflection_hint(*, signal: Mapping[str, Any]) -> str:
    new = signal["new_terminal_since_publish"]
    finished = f"{new} experiment{'s have' if new != 1 else ' has'} finished"
    if signal["last_published_reflection_id"]:
        drift = f"{finished} since the last published reflection"
        if signal["claims_changed_since_publish"]:
            drift += (
                f" and {signal['claims_changed_since_publish']} claims have changed"
            )
    else:
        drift = f"{finished} and no project reflection exists yet"
    return (
        f"No experiments are active and {drift} — a good moment for a "
        "project reflection (reflection.create, project-reflection skill), or "
        "start the next experiment if the logic state is current."
    )


def reflection_staleness_hint(*, signal: Mapping[str, Any]) -> str:
    if not signal["stale"]:
        return ""
    blocked = bool(signal.get("experiment_create_blocked"))
    published = bool(signal.get("last_published_reflection_id"))
    if not published:
        if blocked:
            return (
                "Project reflection required before creating another experiment — "
                f"{signal['terminal_experiments']} experiments have finished and no "
                "project reflection exists yet. Use the project-reflection skill "
                "(reflection.create) and publish the wave before creating another "
                "experiment."
            )
        return (
            "Consider running the project's first reflection — "
            f"{signal['terminal_experiments']} experiments have finished and no "
            "project reflection exists yet. Use the project-reflection skill "
            "(reflection.create) when you judge the time is right."
        )
    prefix = (
        "Project reflection required before creating another experiment"
        if blocked
        else "Consider running a project reflection"
    )
    pieces = [
        f"{prefix} — {signal['new_terminal_since_publish']} experiments have "
        "finished since the last published reflection"
    ]
    if signal["claims_changed_since_publish"]:
        changed = f"{signal['claims_changed_since_publish']} claims have changed"
        if signal["contradicted_flip"]:
            changed += " (including a claim now contradicted)"
        pieces.append(changed)
    pieces.append(
        "the current reflection covers "
        f"{signal['covered_terminal_experiments']} of "
        f"{signal['terminal_experiments']} finished experiments"
    )
    suffix = (
        ". Publish a project reflection wave before creating another experiment."
        if blocked
        else ". Whether these developments change the project's logic state is "
        "your call (project-reflection skill, reflection.create)."
    )
    return "; ".join(pieces) + suffix


def present_reflection_signal(signal: Any) -> Any:
    if not isinstance(signal, Mapping):
        return signal
    result = dict(signal)
    if "stale" in result:
        result["hint"] = result.get("hint") or reflection_staleness_hint(signal=result)
    return result




__all__ = [
    "idle_reflection_hint",
    "present_reflection_signal",
    "reflection_create_block_reason",
    "reflection_staleness_hint",
]
