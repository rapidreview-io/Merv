"""Research workflow vocabulary and creation constraints shared by definitions."""

from __future__ import annotations

import re

from ...kernel.utils import ValidationError


PROJECT_INTENT_GUIDANCE = (
    "The Introduction (summary) is the project's single authoritative definition, editable by the user or an interactive agent. "
    "In an interactive conversation, ask the user focused questions about the problem/background, goal, constraints, "
    "scope and what success means; follow up where ambiguity affects direction. Then write one brief research-paper-style "
    "paragraph with an explicit goal and scope. Preserve uncertainty; never invent intent or maintain a separate brief. "
    "Create or revise this same paragraph with project.context.update, using the exact last-read summary as expected_summary. "
    "On a conflict, reread and reconcile before retrying. There is no completeness gate. "
    "Automatically deployed sessions read this paragraph but cannot edit it or interview the user. "
    "Keep research findings and evolving conclusions in Methods/Results, not the Introduction."
)


def project_context(project):
    return {"id": project.get("id"), "name": project.get("name"),
            "summary": project.get("summary", ""), "intent_guidance": PROJECT_INTENT_GUIDANCE}


def render_project_document(project):
    literature = project.get("literature") or {}
    refs = "\n".join(
        f"- {ref['label']}: {ref['kind']} {ref['id']}"
        + (f" — current status {ref['status']}, attempt {ref.get('attempt_index', '?')}" if "status" in ref else "")
        for ref in project.get("references", ())
    )
    papers = "\n".join(f"- [{paper['title']}]({paper['url']}) ({paper['id']})"
                       for paper in literature.get("cited_papers", ()))
    pending = ""
    if (project.get("maintenance") or {}).get("pending"):
        pending = "Newer research awaits incorporation into Methods/Results.\n\n"
    return (
        f"# {project.get('name', 'Project')}\n\n## Introduction\n{project.get('summary', '')}\n\n"
        f"{project.get('intent_guidance', PROJECT_INTENT_GUIDANCE)}\n\n"
        f"## Literature\n{literature.get('body') or 'No literature summary yet.'}\n{papers}\n\n"
        f"{pending}## Methods\n{project.get('methods') or 'Not yet synthesized.'}\n\n"
        f"## Results\n{project.get('results') or 'Not yet synthesized.'}\n\n"
        f"## Selected evidence and current work\n{refs}\n"
        "Read project(action='records') for the full record inventory and litreview.view for the detailed review."
    )


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

# Entity id prefixes agents may cite from prose, each with the kind it names.
# Support surfaces (the feed) receive this at composition and match prefixes
# only; the kinds label validation messages. `res_` and `rver_` predate the
# current reviews module and stay so older mentions keep parsing.
ENTITY_REF_VOCABULARY: tuple[tuple[str, str], ...] = (
    ("exp_", "experiment"),
    ("task_", "task"),
    ("claim_", "claim"),
    ("res_", "result"),
    ("rver_", "review verdict"),
    ("syn_", "reflection"),
    ("rev_", "review"),
    ("lit_", "literature"),
    ("paper_", "paper"),
)
ENTITY_ID_RE = re.compile(
    r"\b(?:%s)[A-Za-z0-9]" % "|".join(prefix for prefix, _ in ENTITY_REF_VOCABULARY)
)

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
