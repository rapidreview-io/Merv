"""Surface-owned derived experiment-figure projection.

Builds a graph document — typed nodes + edges — for one experiment from state
the backend already owns: the attempt chain, sealed submissions, artifacts,
review verdicts, sandbox liveness, conclusion, and tested claims. Nothing here
is agent-authored; every node is derived and therefore true by construction.

Pure projection logic — no DB or backend calls. The Application query gathers
the inputs (experiment state, review snapshots, open review requests, sandbox
view) and hands them in.

The document is a timeline. Its spine is the temporal sequence of *beats*:

    Attempt k  →  Design review  →  Submission k.1  →  Experiment review  →
    Submission k.2  →  Experiment review  →  …  →  Conclusion  →  Claims

Every attempt marker and result-submission marker is followed by the review
that judged it, and a rejecting review is what leads to the next round — so
round j+1 always sits strictly after round j *and* its verdict. Everything else
is a satellite that names the beat it belongs to (`anchor`) and which side of
the spine it lives on (`lane`):

  * ``lane: "evidence"``  — what a beat put up for review: the proposal (plan &
    friends) feeding an attempt marker, the results feeding a submission
    marker. Files are prepared before they are submitted, so evidence leads
    INTO its marker (drawn just before it, arrows converging on it).
  * ``lane: "execution"`` — the sandbox and files produced but not (yet) sealed
    into a result submission, hanging below the beat they trail.

Edge vocabulary:

  reviewed_by  marker → the review that graded it
  then         plain succession on the spine (approval → next round, re-review,
               marker → next marker when no verdict links them, → open gate)
  revised_to   a rejecting verdict → the round it caused
  feeds        evidence artifact → the marker it was submitted with
  produced     attempt → execution-lane artifact     (attachment; placement)
  ran_on       attempt → sandbox                     (attachment; placement)
  concludes    final beat → conclusion
  tests        conclusion (or final beat) → tested claim

`produced` and `ran_on` are attachments the canvas shows as placement (the
satellite sits below its anchor's column) rather than as lines.

Node `status` values are normalized for UI coloring:
  pending | active | done | failed | superseded | abandoned
except `review` nodes, whose status is the verdict (pass | needs_changes |
fail | open), `submission` nodes, which add `returned` for a round whose
verdict sent it back, and `claim` nodes, whose status is the claim status.

Every node that belongs to a round carries `qualifier` — "attempt 2" or
"round 3.1" — so a label like `report.md` or `Experiment review` never has to
be traced back through edges to know which round it is about.
"""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from ..research_core import EXPERIMENT_WORKFLOW

FIGURE_SCHEMA_VERSION = 3

# Artifact roles that read as a proposal when nothing has sealed them yet
# (legacy untyped roles remain readable on rows backfilled from the resource
# era).
UPSTREAM_ROLES = {"plan", "input", "code", "config", "model"}

# Per-beat, per-lane cap on individual artifact nodes. Old sandbox syncs could
# attach hundreds of files to one round; past the cap the remainder rolls up
# into a single `artifact_group` node so the canvas stays readable.
ARTIFACT_FANOUT_CAP = 6

# Which artifacts survive the cap, most-load-bearing first (nearest the spine).
_ROLE_PRIORITY = {
    "plan": 0,
    "report": 1,
    "result": 2,
    "model": 3,
    "input": 4,
    "code": 5,
    "config": 6,
    "note": 7,
}

_REJECTIONS = {"needs_changes", "fail"}

_ACTIVE_ATTEMPT_STATUSES = EXPERIMENT_WORKFLOW.effect_sources(
    "result_submission"
) | EXPERIMENT_WORKFLOW.effect_destinations("result_submission")
_ATTEMPT_STATUS = {
    state.name: "active" if state.name in _ACTIVE_ATTEMPT_STATUSES else "pending"
    for state in EXPERIMENT_WORKFLOW.states
}
_ATTEMPT_STATUS.update(
    {
        EXPERIMENT_WORKFLOW.success_status: "done",
        **{
            status: "failed"
            for status in EXPERIMENT_WORKFLOW.effect_destinations("fail_tracking")
        },
        **{
            status: "abandoned"
            for status in EXPERIMENT_WORKFLOW.effect_destinations("stop_tracking")
        },
    }
)

_REVIEW_LABELS = {
    state.review.role: state.review.action_name.replace("_", " ").capitalize()
    for state in EXPERIMENT_WORKFLOW.states
    if state.review is not None
}
_REVIEW_LABELS.update(
    {
        "human": "Human review",
        "automated_check": "Automated check",
    }
)
_RESULT_SUBMISSION_TRANSITIONS = {
    transition.name
    for transition in EXPERIMENT_WORKFLOW.transitions
    if "result_submission" in transition.effects
}
# Seals taken by the transition into a non-result review gate (submit_design):
# what they froze is the proposal the design reviewer read.
_PROPOSAL_TRANSITIONS = {
    transition.name
    for transition in EXPERIMENT_WORKFLOW.transitions
    if transition.to_status
    in {
        state.name
        for state in EXPERIMENT_WORKFLOW.states
        if state.review is not None
        and state.name
        not in EXPERIMENT_WORKFLOW.effect_destinations("result_submission")
    }
}


def _humanize(value: str) -> str:
    return value.replace("_", " ")


def _seq_order(row: dict[str, Any]) -> tuple[int, str, str]:
    """Chronological key shared by reviews and seals. `created_seq` is the
    authoritative insertion order, with created_at and the id as tie-breakers
    so rows that predate the column still sort deterministically."""
    try:
        seq = int(row.get("created_seq") or 0)
    except (TypeError, ValueError):
        seq = 0
    return (seq, str(row.get("created_at") or ""), str(row.get("id") or ""))


def _chain_edge(add_edge, source: str, source_verdict: str | None, target: str) -> None:
    """Link a spine beat to whatever preceded it.

    `source_verdict` is None when the source is a round marker (attempt or
    submission). A rejecting verdict earns the dashed revision arrow; a
    non-rejecting one is plain succession."""
    if source_verdict is None:
        add_edge(source, target, "reviewed_by")
    elif source_verdict in _REJECTIONS:
        add_edge(source, target, "revised_to")
    else:
        add_edge(source, target, "then")


def _artifact_label(artifact: dict[str, Any]) -> str:
    title = (artifact.get("title") or "").strip()
    if title:
        return title
    return PurePosixPath(
        str(artifact.get("path") or artifact.get("id") or "artifact")
    ).name


def build_experiment_figure(
    *,
    experiment: dict[str, Any],
    review_attempts: dict[str, int],
    open_review_requests: list[dict[str, Any]],
    sandbox: dict[str, Any] | None,
    sandbox_active: bool = False,
) -> dict[str, Any]:
    """Project one experiment's state into a figure graph.

    `review_attempts` maps review id -> attempt_index (resolved from review
    snapshots by the caller; 0 means unknown). `sandbox` is a sandbox row view
    or None when the experiment never had one; `sandbox_active` is the
    caller's liveness verdict (the sandbox module owns status vocabulary).
    """
    current_attempt = max(1, int(experiment.get("attempt_index") or 1))
    status = str(experiment.get("status") or EXPERIMENT_WORKFLOW.initial)

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    def add_edge(source: str, target: str, edge_type: str) -> None:
        edges.append(
            {
                "id": f"{source}->{target}:{edge_type}",
                "from": source,
                "to": target,
                "type": edge_type,
            }
        )

    def clamp_attempt(value: Any) -> int:
        try:
            attempt = int(value)
        except (TypeError, ValueError):
            attempt = 0
        if attempt < 1 or attempt > current_attempt:
            return current_attempt
        return attempt

    # Round markers in temporal order, and what each one is called.
    spine: list[str] = []
    round_name: dict[str, str] = {}
    marker_attempt: dict[str, int] = {}

    # ---- seals: every forward transition froze the live composition ----
    seals = sorted(experiment.get("submissions", []), key=_seq_order)
    seal_by_id = {str(row.get("id")): row for row in seals}
    sealed_attempts = {clamp_attempt(row.get("attempt_index")) for row in seals}
    result_rounds: dict[int, list[dict[str, Any]]] = {}
    for row in seals:
        if str(row.get("transition") or "") in _RESULT_SUBMISSION_TRANSITIONS:
            result_rounds.setdefault(clamp_attempt(row.get("attempt_index")), []).append(row)
    submission_nodes: dict[str, str] = {}

    # ---- attempt markers + the result-submission rounds inside them ----
    for k in range(1, current_attempt + 1):
        is_current = k == current_attempt
        attempt_id = f"attempt:{k}"
        nodes.append(
            {
                "id": attempt_id,
                "type": "attempt",
                "label": f"Attempt {k}",
                "sublabel": _humanize(status) if is_current else "superseded",
                "status": (
                    _ATTEMPT_STATUS.get(status, "pending")
                    if is_current
                    else "superseded"
                ),
                "group": attempt_id,
                "ref": {"kind": "experiment", "id": experiment.get("id")},
            }
        )
        spine.append(attempt_id)
        round_name[attempt_id] = f"attempt {k}"
        marker_attempt[attempt_id] = k
        # Only result-submission seals become beats. A plan seal is already
        # drawn by the attempt marker; what has no home otherwise is the report
        # round, which is exactly what a return to running repeats without
        # bumping the attempt.
        for index, row in enumerate(result_rounds.get(k, []), start=1):
            node_id = f"submission:{k}.{index}"
            submission_nodes[str(row.get("id"))] = node_id
            nodes.append(
                {
                    "id": node_id,
                    "type": "submission",
                    "label": f"Submission {k}.{index}",
                    "sublabel": "results submitted",
                    "status": "done",
                    "group": attempt_id,
                    "ref": {"kind": "submission", "id": row.get("id")},
                    "meta": {"attempt_index": k, "submission_index": index},
                }
            )
            spine.append(node_id)
            round_name[node_id] = f"round {k}.{index}"
            marker_attempt[node_id] = k

    # ---- submitted reviews, chained after the marker they graded ----
    # A review of a result submission hangs off that submission; a design
    # review (or any review predating submissions) hangs off the attempt.
    # Rounds sharing a root chain in the order they happened, so a re-review
    # is another beat, not a sibling.
    reviews_by_root: dict[str, list[dict[str, Any]]] = {}
    for review in experiment.get("reviews", []):
        attempt = clamp_attempt(review_attempts.get(str(review.get("id"))))
        root = (
            submission_nodes.get(str(review.get("submission_id") or ""))
            or f"attempt:{attempt}"
        )
        reviews_by_root.setdefault(root, []).append(review)

    # tail[marker] = (last spine node of that round, its verdict or None)
    tails: dict[str, tuple[str, str | None]] = {}
    for root in spine:
        rounds = reviews_by_root.get(root)
        if not rounds:
            continue
        rounds.sort(key=_seq_order)
        source, source_verdict = root, None
        for review in rounds:
            review_id = str(review.get("id"))
            verdict = str(review.get("verdict") or "")
            node_id = f"review:{review_id}"
            nodes.append(
                {
                    "id": node_id,
                    "type": "review",
                    "label": _REVIEW_LABELS.get(str(review.get("role")), "Review"),
                    "sublabel": _humanize(verdict),
                    "status": verdict or "open",
                    "group": f"attempt:{marker_attempt[root]}",
                    "qualifier": round_name[root],
                    "ref": {"kind": "review", "id": review_id},
                    "meta": {
                        "role": review.get("role"),
                        "synopsis": review.get("synopsis") or "",
                        "notes": review.get("notes") or "",
                    },
                }
            )
            _chain_edge(add_edge, source, source_verdict, node_id)
            source, source_verdict = node_id, verdict
        tails[root] = (source, source_verdict)

    # ---- open review gates (requested/started, no verdict yet) ----
    # Land after the newest verdict on the round being reviewed, not back on
    # the marker.
    open_root = f"attempt:{current_attempt}"
    for row in reversed(result_rounds.get(current_attempt, [])):
        open_root = submission_nodes[str(row.get("id"))]
        break
    for request in open_review_requests:
        node_id = f"review_request:{request.get('id')}"
        nodes.append(
            {
                "id": node_id,
                "type": "review",
                "label": _REVIEW_LABELS.get(str(request.get("role")), "Review"),
                "sublabel": "awaiting verdict",
                "status": "open",
                "group": f"attempt:{current_attempt}",
                "qualifier": round_name[open_root],
                "ref": {"kind": "review_request", "id": request.get("id")},
            }
        )
        source, source_verdict = tails.get(open_root, (open_root, None))
        _chain_edge(add_edge, source, source_verdict, node_id)
        tails[open_root] = (node_id, "")

    def tail_of(marker: str) -> tuple[str, str | None]:
        return tails.get(marker, (marker, None))

    # A round wears its verdict: a submission that was sent back reads as
    # returned (amber), one that failed as failed, so the spine is honest at a
    # glance instead of every round looking like a success.
    for node in nodes:
        if node["type"] != "submission":
            continue
        verdict = tail_of(node["id"])[1]
        if verdict == "fail":
            node["status"], node["sublabel"] = "failed", "failed review"
        elif verdict in _REJECTIONS:
            node["status"], node["sublabel"] = "returned", "sent back"

    # ---- spine succession: each round follows the verdict of the last ----
    # A rejection is what caused the next round, so the arrow leaves the
    # review, not the marker; without a verdict (legacy rows, abandoned
    # gates) the markers link directly.
    for previous, following in zip(spine, spine[1:]):
        source, verdict = tail_of(previous)
        add_edge(
            source,
            following,
            "revised_to" if verdict in _REJECTIONS else "then",
        )

    # ---- artifacts, one node per (artifact, attempt) association ----
    # Where an artifact sits is decided by what sealed it: a result seal makes
    # it evidence above that submission, a proposal seal makes it the proposal
    # above the attempt, and anything else (a seal taken by mark_ready /
    # start_running / retry, or nothing yet) is execution output trailing the
    # latest beat that preceded it. Superseded rows survive their round (that
    # is the history), so mark anything the target no longer treats as current.
    current_ids = {
        str(res.get("id")) for res in experiment.get("current_attempt_artifacts", [])
    }
    result_seal_orders = {
        attempt: [_seq_order(row) for row in rows]
        for attempt, rows in result_rounds.items()
    }

    def execution_anchor(attempt: int, before: tuple[int, str, str] | None) -> str:
        """The spine beat an unsubmitted file trails: the verdict on the last
        result round sealed before it, else the attempt's design verdict."""
        rounds = result_rounds.get(attempt, [])
        orders = result_seal_orders.get(attempt, [])
        marker = f"attempt:{attempt}"
        for row, order in zip(rounds, orders):
            if before is not None and order >= before:
                break
            marker = submission_nodes[str(row.get("id"))]
        return tail_of(marker)[0]

    def place(res: dict[str, Any]) -> tuple[str, str, str, str]:
        """(anchor, lane, marker, edge_type) for one artifact row. Evidence
        feeds its marker (artifact → marker); execution output is produced by
        its attempt (attempt → artifact)."""
        attempt = clamp_attempt(res.get("attempt_index"))
        attempt_id = f"attempt:{attempt}"
        seal = seal_by_id.get(str(res.get("submission_id") or ""))
        if seal is not None:
            submission = submission_nodes.get(str(seal.get("id")))
            if submission:
                return submission, "evidence", submission, "feeds"
            if str(seal.get("transition") or "") in _PROPOSAL_TRANSITIONS:
                return attempt_id, "evidence", attempt_id, "feeds"
            anchor = execution_anchor(attempt, _seq_order(seal))
            return anchor, "execution", attempt_id, "produced"
        # Unsealed. Once this attempt has sealed anything, an unsealed row was
        # registered after that seal: work in progress trailing the latest
        # beat. Before any seal (still planning, or rows that predate seals)
        # the role decides: inputs are the proposal, outputs are execution.
        role = str(res.get("role") or "other")
        if attempt not in sealed_attempts and role in UPSTREAM_ROLES:
            return attempt_id, "evidence", attempt_id, "feeds"
        return execution_anchor(attempt, None), "execution", attempt_id, "produced"

    buckets: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    seen_assoc: set[tuple[str, int]] = set()
    for res in experiment.get("artifacts", []):
        attempt = clamp_attempt(res.get("attempt_index"))
        key = (str(res.get("id")), attempt)
        if key in seen_assoc:
            continue
        seen_assoc.add(key)
        buckets.setdefault(place(res), []).append(res)

    # Emit in spine order so a bucket's most load-bearing file sits nearest the
    # spine and columns fill left to right. A satellite is named after the beat
    # it hangs on: a marker's round, or the round a verdict graded.
    spine_index = {node_id: i for i, node_id in enumerate(n["id"] for n in nodes)}
    beat_name = {
        n["id"]: round_name.get(n["id"]) or str(n.get("qualifier") or "") for n in nodes
    }
    def attach(node_id: str, marker: str, edge_type: str) -> None:
        if edge_type == "feeds":
            add_edge(node_id, marker, edge_type)
        else:
            add_edge(marker, node_id, edge_type)

    for (anchor, lane, marker, edge_type), bucket in sorted(
        buckets.items(), key=lambda item: (spine_index.get(item[0][0], 0), item[0])
    ):
        bucket.sort(
            key=lambda r: (
                _ROLE_PRIORITY.get(str(r.get("role") or "other"), 9),
                str(r.get("path") or ""),
            )
        )
        qualifier = beat_name.get(anchor) or round_name.get(marker) or ""
        group = f"attempt:{marker_attempt.get(marker, current_attempt)}"
        shown, overflow = bucket[:ARTIFACT_FANOUT_CAP], bucket[ARTIFACT_FANOUT_CAP:]
        for res in shown:
            role = str(res.get("role") or "other")
            attempt = clamp_attempt(res.get("attempt_index"))
            node_id = f"artifact:{res.get('id')}:a{attempt}"
            superseded = bool(current_ids) and str(res.get("id")) not in current_ids
            nodes.append(
                {
                    "id": node_id,
                    "type": "artifact",
                    "label": _artifact_label(res),
                    "sublabel": f"{role} · superseded" if superseded else role,
                    "status": "superseded" if superseded else "none",
                    "group": group,
                    "anchor": anchor,
                    "lane": lane,
                    "qualifier": qualifier,
                    "ref": {"kind": "artifact", "id": res.get("id")},
                    "meta": {
                        "role": role,
                        "path": res.get("path"),
                        "superseded": superseded,
                    },
                }
            )
            attach(node_id, marker, edge_type)
        if overflow:
            roles = sorted({str(r.get("role") or "other") for r in overflow})
            node_id = f"artifact_group:{anchor}:{lane}"
            nodes.append(
                {
                    "id": node_id,
                    "type": "artifact_group",
                    "label": f"{len(overflow)} more files",
                    "sublabel": " · ".join(roles),
                    "status": "none",
                    "group": group,
                    "anchor": anchor,
                    "lane": lane,
                    "qualifier": qualifier,
                    "ref": {"kind": "artifact_group", "id": None},
                    "meta": {
                        "count": len(overflow),
                        "roles": roles,
                        "artifact_ids": [str(r.get("id")) for r in overflow],
                    },
                }
            )
            attach(node_id, marker, edge_type)

    # ---- sandbox / execution ----
    # Hangs below the beat where this attempt's execution began: its design
    # approval when there is one, else the attempt marker itself.
    if sandbox and str(sandbox.get("status") or "none") != "none":
        sandbox_status = str(sandbox.get("status"))
        attempt_id = f"attempt:{current_attempt}"
        design_tail, design_verdict = tail_of(attempt_id)
        anchor = design_tail if design_verdict == "pass" else attempt_id
        nodes.append(
            {
                "id": "sandbox",
                "type": "sandbox",
                "label": "Sandbox",
                "sublabel": str(
                    sandbox.get("gpu") or sandbox.get("instance_type") or sandbox_status
                ),
                "status": "active" if sandbox_active else "done",
                "group": attempt_id,
                "anchor": anchor,
                "lane": "execution",
                "qualifier": beat_name.get(anchor) or round_name[attempt_id],
                "ref": {"kind": "sandbox", "id": experiment.get("id")},
                "meta": {"sandbox_status": sandbox_status},
            }
        )
        add_edge(attempt_id, "sandbox", "ran_on")

    # ---- conclusion + tested claims, after the final beat ----
    end_source = tail_of(spine[-1])[0]
    conclusion = str(experiment.get("conclusion") or "").strip()
    claim_source = end_source
    if conclusion:
        nodes.append(
            {
                "id": "conclusion",
                "type": "conclusion",
                "label": "Conclusion",
                "sublabel": conclusion,
                "status": "done",
                "group": f"attempt:{current_attempt}",
                "ref": {"kind": "experiment", "id": experiment.get("id")},
            }
        )
        add_edge(end_source, "conclusion", "concludes")
        claim_source = "conclusion"
    # The beat that is "now" — the reader's reference point: the conclusion
    # once there is one, else the latest verdict or marker on the spine.
    for node in nodes:
        if node["id"] == claim_source:
            node["current"] = True
            break
    for claim in experiment.get("tested_claims", []):
        node_id = f"claim:{claim.get('id')}"
        nodes.append(
            {
                "id": node_id,
                "type": "claim",
                "label": str(claim.get("statement") or claim.get("id")),
                "sublabel": _humanize(str(claim.get("status") or "")),
                "status": str(claim.get("status") or "active"),
                "ref": {"kind": "claim", "id": claim.get("id")},
            }
        )
        add_edge(claim_source, node_id, "tests")

    return {
        "schema_version": FIGURE_SCHEMA_VERSION,
        "source": "derived",
        "experiment_id": experiment.get("id"),
        "intent": experiment.get("intent") or "",
        "status": status,
        "attempt_index": current_attempt,
        "groups": [
            {"id": f"attempt:{k}", "label": f"Attempt {k}"}
            for k in range(1, current_attempt + 1)
        ],
        "nodes": nodes,
        "edges": edges,
    }
