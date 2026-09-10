# If you update this file, you must consult application.md to see whether application.md needs to be updated. application.md must not exceed 100 lines.
"""Agent-facing claim follow-ups derived from completed experiment facts."""

from __future__ import annotations

import re
from typing import Any

from ...research_core import EXPERIMENT, ExperimentState


_STATUS_MARKERS: tuple[tuple[re.Pattern[str], str | None, str | None], ...] = (
    (
        re.compile(r"\bcontradict\w*|\brefut\w*|\bfalsif\w*|\bdisprov\w*"),
        "contradicted",
        None,
    ),
    (
        re.compile(
            r"\bsupport(?:s|ed|ing)?\b|\bconfirm\w*|\bbeats?\b|\bimprov\w*|\bpositive result\w*|\b(?:target|criterion|criteria|threshold) met\b"
        ),
        "supported",
        "weakened",
    ),
    (
        re.compile(
            r"\bunsupported\b|\bnegative result\w*|\bweaken\w*|\binconclusive\b|\bmixed (?:results?|evidence|findings|signals?)\b|\bpartial(?:ly)? support\w*|\bno (?:significant )?effect\b|\bnot significant\b|\binsignificant\b|\bbelow (?:the )?baseline\b|\bbeaten\b|\bworse than\b|\bunderperform\w*"
        ),
        "weakened",
        None,
    ),
)
_NEGATION = re.compile(
    r"\b(?:not|no|never|neither|nor|without|cannot|can't|couldn't|didn't|"
    r"doesn't|wasn't|weren't|fail(?:ed|s)?(?:\s+to)?|unable\s+to|far\s+from)\b"
)
_CLAUSE_BOUNDARIES = (". ", "; ", ", ", " but ", " however ", " although ", " yet ")


def infer_claim_status(conclusion: str) -> str | None:
    """Conservative presentation hint from a free-text conclusion."""
    text = " ".join(conclusion.lower().split())
    votes: set[str] = set()
    for pattern, plain_vote, negated_vote in _STATUS_MARKERS:
        for match in pattern.finditer(text):
            window = text[max(0, match.start() - 40) : match.start()]
            for boundary in _CLAUSE_BOUNDARIES:
                if (index := window.rfind(boundary)) >= 0:
                    window = window[index + len(boundary) :]
            vote = negated_vote if _NEGATION.search(window) else plain_vote
            if vote is None:
                return None
            votes.add(vote)
    return votes.pop() if len(votes) == 1 else None


def claim_update_suggestions(experiment: ExperimentState) -> list[dict[str, Any]]:
    if experiment.get("status") != EXPERIMENT.success_status:
        return []
    conclusion = str(experiment.get("conclusion") or "").strip()
    suggested_status = infer_claim_status(conclusion)
    if not conclusion or suggested_status is None:
        return []
    suggestions = []
    for claim in experiment.get("tested_claims") or []:
        claim_id = str(claim.get("id") or "")
        if not claim_id or str(claim.get("status") or "") == suggested_status:
            continue
        suggestions.append(
            {
                "tool": "claim.update",
                "arguments": {
                    "project_id": experiment.get("project_id"),
                    "claim_id": claim_id,
                    "status": suggested_status,
                },
                "claim": {
                    field: claim.get(field)
                    for field in ("id", "statement", "status", "confidence", "scope")
                },
                "suggested_status": suggested_status,
                "reason": (
                    "Experiment completed with a passing review; apply a scoped "
                    "claim.update if this conclusion changes the claim's standing."
                ),
                "conclusion": conclusion,
                "requires_confirmation": True,
            }
        )
    return suggestions


__all__ = ["claim_update_suggestions"]
