# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research resolution of artifact-association targets.

Artifacts receives this capability at composition, so it can verify Research
targets without knowing Research tables or lifecycle rules.
"""

from __future__ import annotations

from ..artifacts import ArtifactTarget
from ..kernel.utils import NotFoundError, ValidationError
from .experiment_workflow import EXPERIMENT_TERMINAL_STATUSES
from .reflection_workflow import REFLECTION_TERMINAL_STATUSES
from .task_workflow import TASK_TERMINAL_STATUSES

_TABLE_BY_TYPE = {
    "experiment": "experiments",
    "reflection": "reflections",
    "task": "tasks",
    "claim": "claims",
    "review": "reviews",
}
# Experiments, reflections, and tasks scope associations to their current
# attempt, so a review rejection that bumps the attempt naturally invalidates
# stale associations for any of them (a task's attempt never bumps — its one
# review return keeps the same attempt — but the scoping is uniform).
_ATTEMPT_TABLE_BY_TYPE = {
    "experiment": "experiments",
    "reflection": "reflections",
    "task": "tasks",
}
# A published wave is frozen — its pinned graph is the project's comparison
# base — and an abandoned one is closed; neither accepts new artifacts.
_TERMINAL_REFLECTION_STATUSES = REFLECTION_TERMINAL_STATUSES

# A terminal experiment will never take another forward transition, so an
# artifact submitted now would stay unsealed forever while still winning
# latest-per-slot. Submitting DURING a review stays legal on purpose: it moves
# the snapshot and invalidates the pinned verdict, which is the designed way to
# correct work under review, and the next transition seals it.
_CLOSED_EXPERIMENT_STATUSES = EXPERIMENT_TERMINAL_STATUSES
# Same rule for tasks: done or failed, the record is closed.
_CLOSED_TASK_STATUSES = TASK_TERMINAL_STATUSES


class AssociationTargets:
    """Resolve Research targets and their current artifact attempt."""

    def resolve(
        self, *, tx, target: ArtifactTarget, for_submission: bool = False
    ) -> ArtifactTarget:
        kind, target_id = target.target_type, target.target_id
        if kind == "attempt":
            # Standalone attempt targets have no Research-owned row to resolve.
            return ArtifactTarget(kind, target_id, target.project_id)
        table = _TABLE_BY_TYPE.get(kind)
        if table is None:
            raise ValidationError(f"unsupported target type: {kind}")
        attempt = ", attempt_index" if kind in _ATTEMPT_TABLE_BY_TYPE else ""
        status = ", status" if kind in ("reflection", "experiment", "task") else ""
        row = tx.execute(
            f"SELECT project_id{attempt}{status} FROM {table} WHERE id = ?",
            (target_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"{kind} not found: {target_id}")
        project_id = str(row["project_id"])
        if target.project_id is not None and target.project_id != project_id:
            raise NotFoundError(
                f"{kind} not found in project {target.project_id}: {target_id}"
            )
        if (
            kind == "reflection"
            and str(row["status"]) in _TERMINAL_REFLECTION_STATUSES
        ):
            raise ValidationError(
                f"reflection {target_id} is {row['status']} — the wave is "
                "frozen and no longer accepts artifact submissions"
            )
        if (
            for_submission
            and kind == "reflection"
            and str(row["status"]) == "consolidating"
        ):
            # A new artifact would reset review freshness and block an
            # already-bound publish at its gate — the wedge, not a guard.
            raise ValidationError(
                f"reflection {target_id} is consolidating — its reviewed "
                "artifacts are frozen while the wave publishes; a "
                "consolidation-review rejection is the only path to revise"
            )
        if (
            kind == "experiment"
            and str(row["status"]) in _CLOSED_EXPERIMENT_STATUSES
        ):
            # Evidence added after the experiment ends would remain unsealed
            # while still winning latest-per-slot for an already closed round.
            raise ValidationError(
                f"experiment {target_id} is {row['status']} — it is not "
                "accepting artifact submissions right now; wait for the "
                "review verdict, then submit against the next round"
            )
        if kind == "task" and str(row["status"]) in _CLOSED_TASK_STATUSES:
            raise ValidationError(
                f"task {target_id} is {row['status']} — it is closed and no "
                "longer accepts artifact submissions"
            )
        return ArtifactTarget(
            target_type=kind,
            target_id=target_id,
            project_id=project_id,
            attempt_index=int(row["attempt_index"]) if attempt else 0,
        )

    def is_protected(self, *, tx, artifact_id: str) -> bool:
        """Whether a published reflection froze this artifact as its graph."""
        row = tx.execute(
            """
            SELECT 1 FROM reflections
            WHERE published_graph_version_id = ?
            LIMIT 1
            """,
            (artifact_id,),
        ).fetchone()
        return row is not None
