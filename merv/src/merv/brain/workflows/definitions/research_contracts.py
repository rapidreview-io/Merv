"""Research workflow vocabulary and creation constraints shared by definitions."""

from __future__ import annotations

import re

from ...kernel.utils import ValidationError

CLAIM_STATUSES = frozenset(
    {
        "draft",
        "active",
        "supported",
        "weakened",
        "contradicted",
        "abandoned",
    }
)

CLAIM_CONFIDENCES = frozenset({"low", "medium", "high"})

MAX_EXPERIMENT_NAME_LEN = 48

MIN_EXPERIMENT_NAME_LEN = 3

_EXPERIMENT_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

MAX_TASK_NAME_LEN = MAX_EXPERIMENT_NAME_LEN

MIN_TASK_NAME_LEN = MIN_EXPERIMENT_NAME_LEN

ACTIVE_EXPERIMENT_CAP = 7

REFLECTION_IDLE_RECOMMEND_NEW_TERMINAL_THRESHOLD = 1
REFLECTION_NUDGE_NEW_TERMINAL_THRESHOLD = 3
REFLECTION_BLOCK_NEW_TERMINAL_THRESHOLD = 5

def active_experiment_cap_would_exceed_message(
    *, active_count: int, proposed_count: int
) -> str:
    experiment_word = "experiment" if proposed_count == 1 else "experiments"
    return (
        "active experiment cap would be exceeded: "
        f"project has {active_count} active experiments and this reflection "
        f"proposes {proposed_count} new {experiment_word}; "
        "finish one before creating another."
    )

def _validate_folder_name(name: str, *, subject: str, folder: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ValidationError(
            f"name is required: a short, folder-safe {subject} name — it "
            f"becomes the {subject} folder {folder}/<name>/"
        )
    if (
        len(name) < MIN_EXPERIMENT_NAME_LEN
        or len(name) > MAX_EXPERIMENT_NAME_LEN
        or not _EXPERIMENT_NAME_RE.fullmatch(name)
    ):
        raise ValidationError(
            f"{subject} name must work as a folder name: start with a letter "
            "or digit and use only letters, digits, '.', '_' and '-', between "
            f"{MIN_EXPERIMENT_NAME_LEN} and "
            f"{MAX_EXPERIMENT_NAME_LEN} characters"
        )
    return name

def validate_experiment_name(name: str) -> str:
    return _validate_folder_name(name, subject="experiment", folder="experiments")

def validate_task_name(name: str) -> str:
    return _validate_folder_name(name, subject="task", folder="tasks")

ROSTER_SIZE = 5

CORE_LENSES: tuple[dict[str, str], ...] = (
    {
        "id": "amplify",
        "title": "Amplify what works",
        "charter": (
            "What worked, and what should we do more of? Identify positive "
            "signal, repeated wins, promising mechanisms, and directions where "
            "additional investment is justified."
        ),
    },
    {
        "id": "avoid",
        "title": "Avoid what failed",
        "charter": (
            "What did not work, and what should we avoid? Build the "
            "negative-knowledge ledger from dead_end graph nodes, abandoned "
            "attempts and experiments, and needs_changes review histories: "
            "direction tested, setting, what happened, why it failed."
        ),
    },
    {
        "id": "entropy",
        "title": "Entropy & weird bets",
        "charter": (
            "What unlikely, high-variance things should we try to escape the "
            "project's current local optimum? Generate strange but testable "
            "ideas, surprising pivots, and experiments the other lenses would "
            "probably dismiss too quickly."
        ),
    },
)

CORE_LENS_IDS = tuple(lens["id"] for lens in CORE_LENSES)
