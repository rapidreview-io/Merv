# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Experiment state machine and tracking ledger."""

from __future__ import annotations

from contextlib import closing
import json
from typing import Any

from merv.shared.artifact_roles import EXHIBIT_ROLE
from merv.shared.markdown_images import markdown_image_links

from .evidence import (
    ArtifactDocument,
    artifact_state_record,
    current_slot_artifacts,
    graph_problems,
    plan_sections_missing,
    preferred_artifact,
    report_problems,
    require_artifact_document,
    submission_state_record,
)
from .dependencies import dependency_rows, dependent_rows, record_dependencies
from .experiment_workflow import EXPERIMENT_WORKFLOW
from .reflection_workflow import REFLECTION_WORKFLOW
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    GateEvaluation,
    RequirementEvaluation,
    active_experiment_cap_reached_message,
    covered_terminal_ids,
    evaluate_artifact_requirement,
    evaluate_dependency_requirement,
    evaluate_review_gate,
    reflection_create_block_message,
    validate_experiment_name,
)
from ..artifacts import Artifact, ArtifactTarget, Artifacts, Submission
from ..kernel.events import StoredEvent, freeze_json_object
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from ..kernel.utils import new_id
from ..kernel.utils import now_iso
from .models import CommittedExperimentUpdate
from .workflow_schema import ArtifactNeed, RecordNeed, ReviewReturn


def _query(conn, sql: str, parameters: tuple[Any, ...]) -> list[dict[str, Any]]:
    return rows_to_dicts(rows=conn.execute(sql, parameters).fetchall())


# Events that a tracking update may append.
TRACKING_EVENT_TYPES = (
    "experiment.mlflow_run_created",
    "experiment.mlflow_run_unavailable",
    "experiment.mlflow_run_refreshed",
)
# A keyed delivery derives one of these types; callers cannot override it and
# make an ordinary refresh look like the delivery's committed outcome.
TRACKING_DELIVERY_EVENT_TYPES = (
    "experiment.mlflow_run_created",
    "experiment.mlflow_run_unavailable",
)
ATTEMPT_CLOCK_TRANSITION = next(
    transition.name
    for state in EXPERIMENT_WORKFLOW.states
    for transition in state.transitions
    if "start_attempt_clock" in transition.effects
)


def reject_keyed_event_type_override(
    *, event_type: str | None, delivery_id: int | None
) -> None:
    """A keyed tracking write names its own event type; an override is invalid.

    A delivery's durable record is one of the two types above and nothing else:
    letting a caller name the type would let a keyed write masquerade as an
    unkeyed refresh, so the ledger would describe a delivery that never
    happened. Enforced at the writer, where it is binding.
    """
    if event_type is not None and delivery_id is not None:
        raise ValueError(
            "A keyed tracking write derives its own event type: "
            f"event_type={event_type!r} is invalid alongside "
            f"delivery_id={delivery_id!r}. Keyed writes may only append "
            + " or ".join(TRACKING_DELIVERY_EVENT_TYPES)
            + "."
        )


class ExperimentService:
    def __init__(
        self,
        *,
        store: BaseStateStore,
        artifacts: Artifacts,
    ) -> None:
        self.store = store
        self.artifacts = artifacts

    def create(
        self,
        *,
        name: str,
        intent: str,
        tested_claim_ids: list[str] | str | None = None,
        depends_on: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._create_in_transaction(
                conn=conn,
                project_id=project_id,
                name=name,
                intent=intent,
                tested_claim_ids=tested_claim_ids,
                depends_on=depends_on,
            )

    def create_from_reflection(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        name: str,
        intent: str,
        tested_claim_ids: list[str] | str | None = None,
        proposal_key: str = "",
        parallelism: str = "",
        depends_on: list[str] | str | None = None,
    ) -> dict[str, Any]:
        """Create one reviewed reflection proposal through normal invariants."""
        reflection_id = str(reflection_id or "").strip()
        source = conn.execute(
            "SELECT id FROM reflections WHERE id = ? AND project_id = ?",
            (reflection_id, project_id),
        ).fetchone()
        if source is None:
            raise NotFoundError(f"reflection not found: {reflection_id}")
        return self._create_in_transaction(
            conn=conn,
            project_id=project_id,
            name=name,
            intent=intent,
            tested_claim_ids=tested_claim_ids,
            source_reflection_id=reflection_id,
            proposal_key=proposal_key,
            parallelism=parallelism,
            depends_on=depends_on,
        )

    def _create_in_transaction(
        self,
        *,
        conn,
        project_id: str,
        name: str,
        intent: str,
        tested_claim_ids: list[str] | str | None,
        source_reflection_id: str = "",
        proposal_key: str = "",
        parallelism: str = "",
        depends_on: list[str] | str | None = None,
    ) -> dict[str, Any]:
        # Order-preserving dedupe: distinct refs (a create key and a literal
        # claim id) can resolve to one claim, and experiment_claims has a
        # composite primary key — a duplicate insert would abort the caller's
        # whole transaction (reflection publish included).
        tested_claim_ids = (
            [tested_claim_ids]
            if isinstance(tested_claim_ids, str)
            else list(dict.fromkeys(tested_claim_ids or []))
        )
        name = validate_experiment_name(name)
        if not intent.strip():
            raise ValidationError("intent is required")
        if not source_reflection_id:
            # Reflection-sourced creates were counted against the cap when the
            # change spec passed reflection review; re-checking here could only
            # wedge an already-bound publish over a mid-wave tool create.
            self._reject_active_experiment_cap(conn=conn, project_id=project_id)
            self._reject_reflection_blocked_experiment_create(
                conn=conn, project_id=project_id
            )
            self._reject_reserved_wave_name(
                conn=conn, project_id=project_id, name=name
            )
        duplicate = conn.execute(
            "SELECT id FROM experiments WHERE project_id = ? AND lower(name) = lower(?)",
            (project_id, name),
        ).fetchone()
        if duplicate is not None:
            raise ValidationError(
                f"an experiment named {name!r} already exists in this project "
                "— choose a new name"
            )
        for claim_id in tested_claim_ids or []:
            if (
                conn.execute(
                    "SELECT id FROM claims WHERE id = ? AND project_id = ?",
                    (claim_id, project_id),
                ).fetchone()
                is None
            ):
                raise NotFoundError(f"claim not found: {claim_id}")
        experiment_id = new_id(prefix="exp")
        now = now_iso()
        conn.execute(
            """
            INSERT INTO experiments
              (id, project_id, name, intent, status, attempt_index, revision_context, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, '', ?, ?)
            """,
            (
                experiment_id,
                project_id,
                name,
                intent.strip(),
                EXPERIMENT_WORKFLOW.initial,
                now,
                now,
            ),
        )
        for claim_id in tested_claim_ids or []:
            conn.execute(
                "INSERT INTO experiment_claims (experiment_id, claim_id) VALUES (?, ?)",
                (experiment_id, claim_id),
            )
        depends_on_ids = (
            [depends_on] if isinstance(depends_on, str) else list(depends_on or [])
        )
        recorded = record_dependencies(
            conn=conn,
            project_id=project_id,
            node_id=experiment_id,
            depends_on_ids=depends_on_ids,
        )
        event_payload: dict[str, Any] = {"name": name, "intent": intent}
        if recorded:
            event_payload["depends_on"] = recorded
        if source_reflection_id:
            event_payload.update(
                source_reflection_id=source_reflection_id,
                proposal_key=proposal_key.strip(),
                parallelism=parallelism.strip(),
            )
        self.store.record_event(
            conn=conn,
            project_id=project_id,
            event_type="experiment.created",
            target_type="experiment",
            target_id=experiment_id,
            payload=event_payload,
        )
        return self.get_state(experiment_id=experiment_id, conn=conn)

    def _active_experiment_count(self, *, conn, project_id: str) -> int:
        terminal = ", ".join(
            f"'{status}'"
            for status in sorted(EXPERIMENT_WORKFLOW.terminal_statuses)
        )
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS count FROM experiments
            WHERE project_id = ? AND status NOT IN ({terminal})
            """,
            (project_id,),
        ).fetchone()
        return int(row["count"] if row is not None else 0)

    def _reject_active_experiment_cap(self, *, conn, project_id: str) -> None:
        # Reserved wave names hold their cap slots: the wave passed the cap
        # check when its spec was validated, so tool creates must not consume
        # the slots its publish will materialize into.
        active_count = self._active_experiment_count(conn=conn, project_id=project_id)
        reserved_count = int(
            conn.execute(
                "SELECT COUNT(*) AS count FROM reflection_reserved_names "
                "WHERE project_id = ?",
                (project_id,),
            ).fetchone()["count"]
        )
        if active_count + reserved_count >= ACTIVE_EXPERIMENT_CAP:
            raise WorkflowError(
                active_experiment_cap_reached_message(
                    active_count=active_count, reserved_count=reserved_count
                )
            )

    def _reject_reserved_wave_name(
        self, *, conn, project_id: str, name: str
    ) -> None:
        """Refuse names an in-flight wave's validated spec will materialize.

        Taking one mid-wave would block the wave's already-bound publish at
        materialization; the reservation makes the race an actionable error
        for the creator instead.
        """
        row = conn.execute(
            "SELECT reflection_id FROM reflection_reserved_names "
            "WHERE project_id = ? AND name_lower = lower(?) LIMIT 1",
            (project_id, name),
        ).fetchone()
        if row is not None:
            raise WorkflowError(
                f"experiment name {name!r} is reserved by reflection wave "
                f"{row['reflection_id']} — it will be created when the wave "
                "publishes; choose a different name"
            )

    def _reject_reflection_blocked_experiment_create(
        self, *, conn, project_id: str
    ) -> None:
        debt, published_id = self._terminal_experiments_since_last_reflection(
            conn=conn, project_id=project_id
        )
        terminal = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
        placeholders = ", ".join("?" for _ in terminal)
        open_wave = conn.execute(
            f"""
            SELECT id, status FROM reflections
            WHERE project_id = ? AND status NOT IN ({placeholders})
            ORDER BY created_seq DESC LIMIT 1
            """,
            (project_id, *terminal),
        ).fetchone()
        message = reflection_create_block_message(
            debt=debt,
            published_id=published_id,
            open_wave=row_to_dict(row=open_wave),
        )
        if message:
            raise WorkflowError(message)

    def _terminal_experiments_since_last_reflection(
        self, *, conn, project_id: str
    ) -> tuple[int, str | None]:
        terminal = ", ".join(
            f"'{status}'"
            for status in sorted(EXPERIMENT_WORKFLOW.terminal_statuses)
        )
        current_terminal = {
            str(row["id"])
            for row in conn.execute(
                f"""
                SELECT id FROM experiments
                WHERE project_id = ? AND status IN ({terminal})
                """,
                (project_id,),
            ).fetchall()
        }
        published = conn.execute(
            """
            SELECT id, corpus_json FROM reflections
            WHERE project_id = ? AND status = ?
            ORDER BY published_at DESC, created_seq DESC LIMIT 1
            """,
            (project_id, REFLECTION_WORKFLOW.success_status),
        ).fetchone()
        if published is None:
            return len(current_terminal), None
        try:
            corpus = json.loads(str(published["corpus_json"] or "{}"))
        except json.JSONDecodeError:
            corpus = {}
        covered = covered_terminal_ids(corpus)
        return len(current_terminal - covered), str(published["id"])

    def get_state(
        self, *, experiment_id: str, project_id: str | None = None, conn=None
    ) -> dict[str, Any]:
        return self.get_state_with_gate(
            experiment_id=experiment_id, project_id=project_id, conn=conn
        )[0]

    def get_state_with_gate(
        self, *, experiment_id: str, project_id: str | None = None, conn=None
    ) -> tuple[dict[str, Any], GateEvaluation]:
        owns_conn = conn is None
        if conn is None:
            conn = self.store.connect()
        try:
            if owns_conn:
                project_id = self.store.require_project_id(
                    conn=conn, project_id=project_id
                )
            row = conn.execute(
                "SELECT * FROM experiments WHERE id = ?", (experiment_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"experiment not found: {experiment_id}")
            data = row_to_dict(row=row) or {}
            if project_id is not None and data["project_id"] != project_id:
                raise NotFoundError(
                    f"experiment not found in project {project_id}: {experiment_id}"
                )
            history = self.artifacts.history(
                tx=conn,
                target_type="experiment",
                target_ids=(experiment_id,),
                summarize=True,
            )[experiment_id]
            delivery = conn.execute(
                """
                SELECT delivery_id FROM tracking_deliveries
                WHERE project_id = ? AND target_type = 'experiment'
                  AND target_id = ?
                ORDER BY event_id DESC
                LIMIT 1
                """,
                (data["project_id"], data["id"]),
            ).fetchone()
            return self._assemble_state_with_gate(
                conn=conn,
                experiment=data,
                dependencies=dependency_rows(
                    conn=conn,
                    project_id=str(data["project_id"]),
                    node_ids=(experiment_id,),
                )[experiment_id],
                dependents=dependent_rows(
                    conn=conn,
                    project_id=str(data["project_id"]),
                    node_ids=(experiment_id,),
                )[experiment_id],
                tested_claims=_query(
                    conn,
                    """
                    SELECT c.* FROM claims c
                    JOIN experiment_claims ec ON ec.claim_id = c.id
                    WHERE ec.experiment_id = ?
                    ORDER BY c.created_at, c.id
                    """,
                    (experiment_id,),
                ),
                evidence=history.artifacts,
                reviews=_query(
                    conn,
                    """SELECT * FROM reviews
                    WHERE target_type = 'experiment' AND target_id = ?
                    ORDER BY created_seq DESC""",
                    (experiment_id,),
                ),
                submissions=history.submissions,
                tracking_delivery_id=(
                    None
                    if delivery is None
                    else int(delivery["delivery_id"])
                ),
            )
        finally:
            if owns_conn:
                conn.close()

    def list_states_with_gates(
        self, *, conn, project_id: str
    ) -> list[tuple[dict[str, Any], GateEvaluation]]:
        """Hydrate a project's experiment states with one read per child table."""
        experiment_rows = _query(
            conn,
            "SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at, id",
            (project_id,),
        )
        experiment_ids = tuple(str(row["id"]) for row in experiment_rows)
        if not experiment_ids:
            return []

        claims: dict[str, list[dict[str, Any]]] = {}
        for claim in _query(
            conn,
            """SELECT ec.experiment_id AS _experiment_id, c.*
            FROM experiment_claims ec
            JOIN experiments e ON e.id = ec.experiment_id
            JOIN claims c ON c.id = ec.claim_id
            WHERE e.project_id = ?
            ORDER BY e.created_at, e.id, c.created_at, c.id""",
            (project_id,),
        ):
            experiment_id = str(claim.pop("_experiment_id"))
            claims.setdefault(experiment_id, []).append(claim)

        reviews: dict[str, list[dict[str, Any]]] = {}
        for review in _query(
            conn,
            """SELECT r.* FROM reviews r
            JOIN experiments e ON e.id = r.target_id
            WHERE r.target_type = 'experiment' AND e.project_id = ?
            ORDER BY e.created_at, e.id, r.created_seq DESC""",
            (project_id,),
        ):
            reviews.setdefault(str(review["target_id"]), []).append(review)

        history = self.artifacts.history(
            tx=conn,
            target_type="experiment",
            target_ids=experiment_ids,
            summarize=True,
        )
        delivery_ids: dict[str, int] = {}
        if any(
            row.get("mlflow_run_id") or row.get("mlflow_run_error")
            for row in experiment_rows
        ):
            for row in conn.execute(
                """
                SELECT td.target_id, td.delivery_id
                FROM tracking_deliveries td
                JOIN (
                    SELECT target_id, MAX(event_id) AS event_id
                    FROM tracking_deliveries
                    WHERE project_id = ? AND target_type = 'experiment'
                    GROUP BY target_id
                ) latest
                  ON latest.target_id = td.target_id
                 AND latest.event_id = td.event_id
                WHERE td.project_id = ?
                  AND td.target_type = 'experiment'
                """,
                (project_id, project_id),
            ).fetchall():
                delivery_ids[str(row["target_id"])] = int(row["delivery_id"])
        dependencies = dependency_rows(
            conn=conn, project_id=project_id, node_ids=experiment_ids
        )
        dependents = dependent_rows(
            conn=conn, project_id=project_id, node_ids=experiment_ids
        )
        return [
            self._assemble_state_with_gate(
                conn=conn,
                experiment=experiment,
                dependencies=dependencies.get(str(experiment["id"]), []),
                dependents=dependents.get(str(experiment["id"]), []),
                tested_claims=claims.get(str(experiment["id"]), []),
                evidence=history[str(experiment["id"])].artifacts,
                reviews=reviews.get(str(experiment["id"]), []),
                submissions=history[str(experiment["id"])].submissions,
                tracking_delivery_id=delivery_ids.get(
                    str(experiment["id"])
                ),
            )
            for experiment in experiment_rows
        ]

    def _assemble_state_with_gate(
        self,
        *,
        conn,
        experiment: dict[str, Any],
        tested_claims: list[dict[str, Any]],
        evidence: tuple[Artifact, ...],
        reviews: list[dict[str, Any]],
        submissions: tuple[Submission, ...],
        tracking_delivery_id: int | None,
        dependencies: list[dict[str, Any]] | None = None,
        dependents: list[dict[str, Any]] | None = None,
    ) -> tuple[dict[str, Any], GateEvaluation]:
        data = dict(experiment)
        data["tested_claims"] = tested_claims
        data["dependencies"] = list(dependencies or [])
        data["dependents"] = list(dependents or [])
        data["artifacts"] = [artifact_state_record(item) for item in evidence]
        # Newest row per slot, not every row: sealed rounds leave the
        # superseded report alive as history, and only the current one is
        # "current". A no-op on rows written before submissions existed.
        data["current_attempt_artifacts"] = current_slot_artifacts(
            data["artifacts"], attempt=data["attempt_index"]
        )
        data["submissions"] = [
            submission_state_record(submission) for submission in submissions
        ]
        data["mlflow_run"] = self._mlflow_run_from_row(
            experiment=data,
            delivery_id=tracking_delivery_id,
        )
        for review in reviews:
            review["findings"] = json.loads(review.pop("findings_json", "[]"))
            review["evidence"] = json.loads(review.pop("evidence_json", "{}"))
        data["reviews"] = reviews
        evaluation = self._evaluate_gate(conn=conn, experiment=data)
        data["allowed_transitions"] = [dict(x) for x in evaluation.legal_transitions]
        data["gate_checklist"] = evaluation.checklist()
        return data, evaluation

    def assert_in_project(self, *, experiment_id: str, project_id: str) -> None:
        """Verify experiment identity/scope without hydrating its child records."""
        with closing(self.store.connect()) as conn:
            row = conn.execute("SELECT 1 FROM experiments WHERE id = ? AND project_id = ?", (experiment_id, project_id)).fetchone()
        if row is None:
            raise NotFoundError(f"experiment not found in project {project_id}: {experiment_id}")

    def _mlflow_run_from_row(
        self, *, experiment: dict[str, Any], delivery_id: int | None
    ) -> dict[str, Any] | None:
        run_id = str(experiment.get("mlflow_run_id") or "")
        error = str(experiment.get("mlflow_run_error") or "")
        if not run_id and not error:
            return None
        result: dict[str, Any] = {
            "run_id": run_id or None,
            "run_name": str(experiment.get("mlflow_run_name") or ""),
            "status": str(experiment.get("mlflow_run_status") or ""),
            "artifact_uri": str(experiment.get("mlflow_run_artifact_uri") or ""),
            "created_at": experiment.get("mlflow_run_created_at"),
            "created_by_plugin": bool(run_id),
        }
        if error:
            result["error"] = error
        if delivery_id is not None:
            result["delivery_id"] = delivery_id
        return result

    def record_mlflow_run(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str,
        run: dict[str, Any],
        event_type: str | None = None,
        return_event: bool = False,
        delivery_id: int | None = None,
    ) -> dict[str, Any] | CommittedExperimentUpdate:
        """``delivery_id`` names the committed event this tracking outcome
        belongs to. A keyed write records it in ``tracking_deliveries`` in the
        SAME transaction as the append, so the row's existence is exact proof
        this delivery's write committed — the mutable experiments row cannot
        distinguish it from an identical earlier one.

        A keyed write derives its own event type; pairing ``delivery_id`` with
        an ``event_type`` override is rejected here, at the only boundary that
        can bind it."""
        reject_keyed_event_type_override(
            event_type=event_type, delivery_id=delivery_id
        )

        def result(
            state: dict[str, Any], event: StoredEvent
        ) -> dict[str, Any] | CommittedExperimentUpdate:
            return CommittedExperimentUpdate(state, event) if return_event else state

        delivery = (
            {} if delivery_id is None else {"delivery_id": int(delivery_id)}
        )

        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if delivery_id is not None and (
                landed := self._delivery_event(
                    conn=conn,
                    project_id=project_id,
                    experiment_id=experiment_id,
                    delivery_id=int(delivery_id),
                )
            ) is not None:
                # The barrier lives here because only here is it atomic with
                # the append: a caller that reads the ledger in one transaction
                # and writes in another can be overtaken between the two, and
                # would then overwrite a newer outcome or append this delivery
                # twice. Callers may still pre-read as a fast path. The landed
                # event is returned as this call's own, because it is.
                return result(
                    self.get_state(
                        experiment_id=experiment_id, project_id=project_id, conn=conn
                    ),
                    landed,
                )
            existing = self.get_state(
                experiment_id=experiment_id,
                project_id=project_id,
                conn=conn,
            )
            now = now_iso()
            run_id = str(run.get("run_id") or "")
            run_name = str(run.get("run_name") or "")
            status = str(run.get("status") or "")
            artifact_uri = str(run.get("artifact_uri") or "")
            created_at = str(run.get("created_at") or "") or now
            error = str(run.get("error") or run.get("note") or "")
            if not run_id and not error:
                return existing
            if not run_id and str(existing.get("mlflow_run_id") or ""):
                # An error-only update (e.g. a failed re-create on retry) must
                # not blank an existing run identity — keep the run, attach
                # the error beside it.
                conn.execute(
                    "UPDATE experiments SET mlflow_run_error = ?, updated_at = ? WHERE id = ?",
                    (error, now, experiment_id),
                )
                event = self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type=event_type or "experiment.mlflow_run_unavailable",
                    target_type="experiment",
                    target_id=experiment_id,
                    payload={
                        "run_id": str(existing.get("mlflow_run_id") or ""),
                        "error": error,
                        "previous_run_id": str(existing.get("mlflow_run_id") or ""),
                        **delivery,
                    },
                )
                self._record_delivery(
                    conn=conn,
                    project_id=project_id,
                    experiment_id=experiment_id,
                    delivery_id=delivery_id,
                    event=event,
                )
                state = self.get_state(experiment_id=experiment_id, conn=conn)
                return result(state, event)
            conn.execute(
                """
                UPDATE experiments
                SET mlflow_run_id = ?,
                    mlflow_run_name = ?,
                    mlflow_run_status = ?,
                    mlflow_run_artifact_uri = ?,
                    mlflow_run_created_at = ?,
                    mlflow_run_error = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    run_id,
                    run_name,
                    status,
                    artifact_uri,
                    created_at if (run_id or error) else None,
                    "" if run_id else error,
                    now,
                    experiment_id,
                ),
            )
            event = self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type=(
                    event_type
                    or (
                        "experiment.mlflow_run_created"
                        if run_id
                        else "experiment.mlflow_run_unavailable"
                    )
                ),
                target_type="experiment",
                target_id=experiment_id,
                payload={
                    "run_id": run_id,
                    "run_name": run_name,
                    "status": status,
                    "error": "" if run_id else error,
                    "previous_run_id": existing.get("mlflow_run_id") or "",
                    **delivery,
                },
            )
            self._record_delivery(
                conn=conn,
                project_id=project_id,
                experiment_id=experiment_id,
                delivery_id=delivery_id,
                event=event,
            )
            state = self.get_state(experiment_id=experiment_id, conn=conn)
            return result(state, event)

    def _record_delivery(
        self,
        *,
        conn,
        project_id: str,
        experiment_id: str,
        delivery_id: int | None,
        event: StoredEvent,
    ) -> None:
        """Key this delivery to the event it just appended, same transaction.

        The row is the barrier's only lookup key, so it must be exactly as
        durable as the append it describes: written here, beside it, under the
        one commit. An unkeyed write has no delivery to name and writes none.
        The UNIQUE index makes "at most one append per delivery" the database's
        statement rather than the check above's — a second insert raises
        instead of quietly duplicating.
        """
        if delivery_id is None:
            return
        conn.execute(
            """
            INSERT INTO tracking_deliveries
              (project_id, target_type, target_id, delivery_id, event_id, created_at)
            VALUES (?, 'experiment', ?, ?, ?, ?)
            """,
            (
                project_id,
                experiment_id,
                int(delivery_id),
                int(event.id),
                event.created_at,
            ),
        )

    def _delivery_event(
        self, *, conn, project_id: str, experiment_id: str, delivery_id: int
    ) -> StoredEvent | None:
        """Return the event committed for this exact tracking delivery.

        The unique delivery key points directly to one event. Both rows commit
        together, so this constant-cost lookup is the idempotency proof; mutable
        experiment fields cannot safely prove which delivery wrote them.
        """
        keyed = conn.execute(
            """
            SELECT event_id
            FROM tracking_deliveries
            WHERE project_id = ? AND target_type = 'experiment'
              AND target_id = ? AND delivery_id = ?
            """,
            (project_id, experiment_id, int(delivery_id)),
        ).fetchone()
        if keyed is None:
            return None
        row = conn.execute(
            """
            SELECT id, type, target_type, target_id, payload_json, created_at
            FROM events WHERE id = ?
            """,
            (int(keyed["event_id"]),),
        ).fetchone()
        if row is None:  # pragma: no cover - the two rows commit together
            return None
        return StoredEvent(
            id=int(row["id"]),
            project_id=project_id,
            type=str(row["type"]),
            target_type=str(row["target_type"]),
            target_id=str(row["target_id"]),
            payload=freeze_json_object(json.loads(str(row["payload_json"] or "{}"))),
            created_at=str(row["created_at"]),
        )

    def tracking_delivery_state(
        self, *, project_id: str | None = None, experiment_id: str, delivery_id: int
    ) -> dict[str, Any] | None:
        """The durable state when this delivery's tracking event is committed.

        Answers "did THIS delivery's write land?" from the append-only ledger,
        so a stale identical run id or adapter error from an earlier delivery
        can never be mistaken for it. This is the callers' fast path; the
        binding barrier is the same check inside ``record_mlflow_run``.
        """
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if self._delivery_event(
                conn=conn,
                project_id=project_id,
                experiment_id=experiment_id,
                delivery_id=int(delivery_id),
            ) is None:
                return None
            return self.get_state(
                experiment_id=experiment_id, project_id=project_id, conn=conn
            )

    def _evaluate_gate(self, *, conn, experiment: dict[str, Any]) -> GateEvaluation:
        """Collect current facts once for enforcement, state, and guidance."""
        status = str(experiment.get("status") or "")
        workflow_state = EXPERIMENT_WORKFLOW.state(status)
        artifacts = experiment.get("current_attempt_artifacts") or []
        present_roles = {
            str(art.get("role"))
            for art in artifacts
            if art.get("role")
        }
        requirements: list[RequirementEvaluation] = []
        for requirement in (
            () if workflow_state is None else workflow_state.requirements
        ):
            if isinstance(requirement, RecordNeed):
                requirements.append(
                    evaluate_dependency_requirement(
                        requirement,
                        dependencies=experiment.get("dependencies") or [],
                    )
                )
                continue
            assert isinstance(requirement, ArtifactNeed)
            present = requirement.role in present_roles
            problems: tuple[str, ...] = ()
            if present and requirement.validator:
                try:
                    self._run_validator(
                        experiment=experiment, name=requirement.validator
                    )
                except WorkflowError as exc:
                    problems = (str(exc),)
            requirements.append(
                evaluate_artifact_requirement(
                    requirement,
                    present=present,
                    problems=problems,
                )
            )

        review = (
            None
            if workflow_state is None or workflow_state.review is None
            else evaluate_review_gate(
                conn=conn,
                target_type="experiment",
                target=experiment,
                review=workflow_state.review,
            )
        )
        return GateEvaluation(
            workflow=EXPERIMENT_WORKFLOW,
            status=status,
            requirements=tuple(requirements),
            review=review,
        )

    def list_experiment_summaries(
        self, *, project_id: str | None = None
    ) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, name, intent, status, attempt_index,
                       created_at, updated_at
                FROM experiments
                WHERE project_id = ?
                ORDER BY created_at, id
                """,
                (project_id,),
            ).fetchall()
            return rows_to_dicts(rows=rows)

    def transition_with_event(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, Any] | None = None,
        project_id: str | None = None,
    ) -> CommittedExperimentUpdate:
        """Transition atomically and expose its exact event after commit."""

        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            experiment, gate = self.get_state_with_gate(
                experiment_id=experiment_id, project_id=project_id, conn=conn
            )
            status = experiment["status"]
            next_status = gate.require_transition(transition)
            step = EXPERIMENT_WORKFLOW.transition(transition)
            if step is None:
                raise WorkflowError(f"unknown experiment transition: {transition}")
            now = now_iso()
            # Seal the live composition as a submission attempt. After the gate
            # (a refused transition seals nothing) and on this same connection
            # — the artifacts component owns the SQL, we only say when.
            # Every forward transition seals, not just submit_results: that is
            # one rule instead of a maintained allowlist, and it preserves plan
            # history at submit_design on the same terms as report history.
            self.artifacts.seal(
                tx=conn,
                target=ArtifactTarget(
                    "experiment", experiment_id, experiment["project_id"]
                ),
                transition=transition,
            )
            if "record_conclusion" in step.effects:
                conn.execute(
                    "UPDATE experiments SET status = ?, conclusion = ?, updated_at = ? WHERE id = ?",
                    (
                        next_status,
                        self._conclusion_from_evidence(evidence),
                        now,
                        experiment_id,
                    ),
                )
            elif "record_retry_context" in step.effects:
                revision_context = self._retry_running_context(
                    evidence=evidence,
                    previous=str(experiment.get("revision_context") or ""),
                )
                conn.execute(
                    "UPDATE experiments SET status = ?, revision_context = ?, updated_at = ? WHERE id = ?",
                    (next_status, revision_context, now, experiment_id),
                )
            else:
                conn.execute(
                    "UPDATE experiments SET status = ?, updated_at = ? WHERE id = ?",
                    (next_status, now, experiment_id),
                )
            event = self.store.record_event(
                conn=conn,
                project_id=experiment["project_id"],
                event_type=EXPERIMENT_WORKFLOW.event_type,
                target_type="experiment",
                target_id=experiment_id,
                payload={
                    "from": status,
                    "to": next_status,
                    "transition": transition,
                    "evidence": evidence or {},
                },
            )
            state = self.get_state(experiment_id=experiment_id, conn=conn)
            return CommittedExperimentUpdate(state=state, event=event)

    def _conclusion_from_evidence(self, evidence: dict[str, Any] | None) -> str:
        """Derive the durable conclusion text persisted when an experiment
        completes. Prefer an explicit `conclusion` string; otherwise serialize
        the whole evidence object so the accepted reasoning is not lost."""
        if not evidence:
            return ""
        conclusion = evidence.get("conclusion")
        if isinstance(conclusion, str) and conclusion.strip():
            return conclusion.strip()
        return json.dumps(evidence, sort_keys=True)

    def _retry_running_context(
        self, *, evidence: dict[str, Any] | None, previous: str = ""
    ) -> str:
        evidence = evidence or {}
        reason = str(evidence.get("reason") or "infrastructure failure").strip()
        detail = str(
            evidence.get("detail")
            or evidence.get("notes")
            or evidence.get("note")
            or ""
        ).strip()
        parts = [
            "Infrastructure retry requested while experiment was running.",
            "Approved plan and current attempt stay in force; rerun execution and retain fresh results before submit_results.",
            f"Reason: {reason}.",
        ]
        if detail:
            parts.append(f"Detail: {detail}")
        context = " ".join(parts)
        return f"{previous}\n\n{context}".strip() if previous else context

    def return_from_review(
        self,
        *,
        conn,
        experiment_id: str,
        route: ReviewReturn,
        revision_context: str,
    ) -> None:
        """Apply the workflow-declared destination and attempt policy."""

        row = conn.execute(
            "SELECT * FROM experiments WHERE id = ?", (experiment_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"experiment not found: {experiment_id}")
        sources = EXPERIMENT_WORKFLOW.review_sources(route)
        if row["status"] not in sources:
            raise WorkflowError(
                f"experiment is {row['status']!r}; only an experiment under "
                f"review can be sent back to {route.to_status}"
            )
        now = now_iso()
        previous_run_id = str(row["mlflow_run_id"] or "")
        if route.attempt == "new":
            # Run identity is per-attempt. A revised plan must not inherit the
            # previous attempt's usually-finalized tracking run.
            conn.execute(
                """
                UPDATE experiments
                SET status = ?, attempt_index = attempt_index + 1,
                    revision_context = ?, updated_at = ?,
                    mlflow_run_id = '', mlflow_run_name = '',
                    mlflow_run_status = '', mlflow_run_artifact_uri = '',
                    mlflow_run_created_at = NULL, mlflow_run_error = ''
                WHERE id = ?
                """,
                (route.to_status, revision_context, now, experiment_id),
            )
        else:
            conn.execute(
                """
                UPDATE experiments
                SET status = ?, revision_context = ?, updated_at = ?
                WHERE id = ?
                """,
                (route.to_status, revision_context, now, experiment_id),
            )
        payload = {"revision_context": revision_context}
        if route.attempt == "new":
            payload["previous_mlflow_run_id"] = previous_run_id
        self.store.record_event(
            conn=conn,
            project_id=row["project_id"],
            event_type=route.event_type,
            target_type="experiment",
            target_id=experiment_id,
            payload=payload,
        )

    def _run_validator(self, *, experiment: dict[str, Any], name: str) -> None:
        """Dispatch a workflow validator name to its deep-lint implementation."""
        if name == "plan":
            self._validate_plan_sections(experiment=experiment)
        elif name == "report":
            self._validate_results_report(experiment=experiment)
        elif name == "graph":
            self._validate_logic_graph(experiment=experiment)

    def _submitted_document(
        self, *, experiment: dict[str, Any], role: str, what: str
    ) -> ArtifactDocument:
        artifact = preferred_artifact(
            artifacts=experiment.get("current_attempt_artifacts") or [],
            roles=(role,),
        )
        if artifact is None:
            raise WorkflowError(
                f"no {role!r} artifact is submitted for the current attempt"
            )
        artifact_id = str(artifact.get("id") or "")
        found = self.artifacts.get(
            artifact_ids=(artifact_id,),
            include="document",
        )
        return require_artifact_document(
            found[0] if found else None,
            artifact_id=artifact_id,
            what=what,
        )

    def _validate_plan_sections(self, *, experiment: dict[str, Any]) -> None:
        """Block submit_design unless the current attempt's SUBMITTED plan fills
        in the required spine and every relative figure link has submitted
        figure content. Lints the bytes pinned at associate; editing the
        live file changes nothing until it is resubmitted."""
        document = self._submitted_document(
            experiment=experiment,
            role="plan",
            what="experiment plan",
        )
        plan_text, path = document.text, document.path
        missing = plan_sections_missing(plan_text)
        if missing:
            raise WorkflowError(
                "experiment plan is missing required sections before design review: "
                + ", ".join(missing)
                + ". Fill in the plan template's required spine — Summary; "
                "Objective & hypothesis; Evaluation — then resubmit the plan "
                "to submit the fix; see skills/research-workflow/plan-template.md."
            )
        figures = set(document.figure_links)
        problems = [
            f"figure {link!r} has no submitted content: make sure the file "
            f"exists next to {path} (copy it out first if it was produced "
            "on the sandbox), then resubmit the plan to submit it"
            for link in markdown_image_links(plan_text)
            if link not in figures
        ]
        if problems:
            raise WorkflowError(
                "experiment plan is not ready for design review: " + "; ".join(problems)
            )

    def _validate_results_report(self, *, experiment: dict[str, Any]) -> None:
        """Block submit_results unless the current attempt's SUBMITTED report
        passes the report lint — including every relative figure link having
        submitted figure content (captured when the report was associated),
        and a reference to the system metrics exhibit when one is pinned for
        this attempt (Application pins it before the transition gate runs)."""
        document = self._submitted_document(
            experiment=experiment,
            role="report",
            what="results report",
        )
        report_text, path = document.text, document.path
        figures = set(document.figure_links)

        def figure_problem(link: str) -> str | None:
            if link in figures:
                return None
            return (
                f"figure {link!r} has no submitted content: make sure the file "
                f"exists next to {path} (copy it out first if it was produced "
                "on the sandbox), then resubmit the report to submit it"
            )

        exhibit = preferred_artifact(
            artifacts=experiment.get("current_attempt_artifacts") or [],
            roles=(EXHIBIT_ROLE,),
        )
        problems = report_problems(
            report_text,
            figure_problem=figure_problem,
            exhibit_path=exhibit["path"] if exhibit else None,
        )
        if problems:
            raise WorkflowError(
                "results report is not ready for experiment review: "
                + "; ".join(problems)
                + ". Fix the file and resubmit it (artifact.submit) — "
                "see skills/research-workflow/report-template.md."
            )

    def _validate_logic_graph(self, *, experiment: dict[str, Any]) -> None:
        """Block submit_results unless the current attempt's SUBMITTED logic
        graph passes the envelope lint. The lint checks shape only (parses,
        node budget, DAG) — the story itself is the agent's to tell and the
        experiment reviewer's to judge."""
        document = self._submitted_document(
            experiment=experiment,
            role="graph",
            what="logic graph",
        )
        problems = graph_problems(document.text)
        if problems:
            raise WorkflowError(
                "logic graph is not ready for experiment review: "
                + "; ".join(problems)
                + ". Fix the file and resubmit it (artifact.submit) — "
                "see skills/research-workflow/graph-template.md."
            )

    def attempt_started_running_at(self, *, experiment_id: str) -> str | None:
        """When the current attempt entered running — the metrics-exhibit
        window start. Derived from the transition event stream: each attempt
        passes through its clock-start transition exactly once; retries and
        review returns to running keep the same attempt, so the latest matching
        event belongs to the current attempt."""
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                """
                SELECT payload_json, created_at FROM events
                WHERE target_type = 'experiment' AND target_id = ?
                  AND type = ?
                ORDER BY id DESC
                """,
                (experiment_id, EXPERIMENT_WORKFLOW.event_type),
            ).fetchall()
        for row in rows:
            try:
                payload = json.loads(str(row["payload_json"] or "{}"))
            except json.JSONDecodeError:
                continue
            if payload.get("transition") == ATTEMPT_CLOCK_TRANSITION:
                return str(row["created_at"])
        return None

    def record_exhibit_verdict(
        self,
        *,
        experiment_id: str,
        verdict: dict[str, Any],
        project_id: str | None = None,
    ) -> None:
        """Record the exhibit outcome (runs, result files, and pin status)."""
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="experiment.exhibit_generated",
                target_type="experiment",
                target_id=experiment_id,
                payload=verdict,
            )
