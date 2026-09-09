# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Experiment records, verified workflow facts and tracking ledger."""

from __future__ import annotations

from contextlib import closing, nullcontext
import json
from typing import Any

from merv.shared.artifact_roles import EXHIBIT_ROLE


from .evidence import (
    artifact_state_record,
    current_slot_artifacts,
    submission_state_record,
)
from .dependencies import dependency_rows, dependent_rows, record_dependencies
from .experiment_workflow import EXPERIMENT_WORKFLOW
from .workflow_schema import Workflow
from .reflection_workflow import REFLECTION_WORKFLOW
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    GateEvaluation,
    active_experiment_cap_reached_message,
    covered_terminal_ids,
    evaluate_artifact_requirement,
    evaluate_review_gate,
    reflection_create_block_message,
    review_snapshot_id,
    snapshot_from_id,
    read_review_fact,
    validate_experiment_name,
)
from .artifacts import ResearchArtifacts as Artifacts
from .artifact_models import Artifact, ArtifactTarget, Submission
from ..workflows import Reference, Runtime, Snapshot, WORKFLOWS
from ..kernel.events import StoredEvent, freeze_json_object
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from ..kernel.utils import new_id
from ..kernel.utils import now_iso
from .models import CommittedExperimentUpdate


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
EXPERIMENT = WORKFLOWS["experiment"]


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
        runtime: Runtime,
    ) -> None:
        self.store = store
        self.artifacts = artifacts
        self.runtime = runtime

    def create(
        self,
        *,
        name: str,
        intent: str,
        details: str = "",
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
                details=details,
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
        details: str = "",
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
            details=details,
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
        details: str = "",
        tested_claim_ids: list[str] | str | None = None,
        source_reflection_id: str = "",
        proposal_key: str = "",
        parallelism: str = "",
        depends_on: list[str] | str | None = None,
        workflow_instance: Snapshot | None = None,
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
        experiment_id = new_id(prefix="exp") if workflow_instance is None else workflow_instance.id
        now = now_iso()
        conn.execute(
            """
            INSERT INTO experiments
              (id, project_id, name, intent, details, status, attempt_index, revision_context, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?)
            """,
            (
                experiment_id,
                project_id,
                name,
                intent.strip(),
                details.strip(),
                EXPERIMENT.initial if workflow_instance is None else workflow_instance.state,
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
        if workflow_instance is None:
            self.runtime.adopt(conn=conn, project_id=project_id, instance_id=experiment_id,
                               workflow="experiment", state=EXPERIMENT.initial, data={"attempt_index": 1})
        return self.get_state(experiment_id=experiment_id, conn=conn)

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        self._create_in_transaction(
            conn=conn, project_id=snapshot.project_id, workflow_instance=snapshot,
            name=str(snapshot.data.get("name") or ""), intent=str(snapshot.data.get("intent") or ""),
            details=str(snapshot.data.get("details") or ""),
            tested_claim_ids=snapshot.data.get("tested_claim_ids"),
            depends_on=snapshot.data.get("depends_on"),
        )

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
        snapshots = self.runtime.snapshots(project_id=project_id, conn=conn)
        return [
            self._assemble_state_with_gate(
                conn=conn, snapshots=snapshots,
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
        snapshots: dict[str, Snapshot] | None = None,
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
        evaluation = self._evaluate_gate(conn=conn, experiment=data, snapshots=snapshots)
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
        expected_run_id: str | None = None,
    ) -> dict[str, Any] | CommittedExperimentUpdate | None:
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
            # Lock and compare together so a waiting refresh cannot overwrite
            # an attachment that committed while it was waiting on PostgreSQL.
            if expected_run_id is not None and conn.execute(
                """UPDATE experiments SET mlflow_run_id = mlflow_run_id
                   WHERE id = ? AND project_id = ? AND COALESCE(mlflow_run_id, '') = ?
                   RETURNING id""",
                (experiment_id, project_id, expected_run_id),
            ).fetchone() is None:
                return None
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

    def _evaluate_gate(self, *, conn, experiment: dict[str, Any], snapshots=None) -> GateEvaluation:
        """Evaluate the registered graph once; legacy checklist metadata is presentation only."""
        status = str(experiment.get("status") or "")
        if snapshots is None:
            try:
                snapshot = self.runtime.get(project_id=experiment["project_id"], instance_id=experiment["id"], conn=conn)
            except NotFoundError:
                snapshot = None
        else:
            snapshot = snapshots.get(experiment["id"])
        if snapshot is None:
            snapshot = Snapshot(id=experiment["id"], project_id=experiment["project_id"], workflow="experiment",
                                version=1, state=status, revision=0,
                                data={"attempt_index": experiment["attempt_index"]}, outcome=EXPERIMENT.outcomes.get(status, ""))
        definition = self.runtime.registry.get("experiment", snapshot.version)
        decision = definition.evaluate(
            snapshot, _ExperimentKnowledge(self, conn, experiment, snapshot))
        workflow = Workflow(self.runtime.registry.get("experiment", snapshot.version), EXPERIMENT_WORKFLOW.metadata)
        workflow_state = workflow.state(snapshot.state)
        requirements = []
        artifacts = experiment.get("current_attempt_artifacts") or []
        for need in () if workflow_state is None else workflow_state.requirements:
            role = need.role
            present = any(item.get("role") == role for item in artifacts)
            problem = next((issue.message for action in decision.blocked for issue in action.issues
                            if issue.code == f"{role}_invalid"), "")
            requirements.append(evaluate_artifact_requirement(need, present=present, problems=(problem,) if problem else ()))
        review = None if workflow_state is None or workflow_state.review is None else evaluate_review_gate(
            conn=conn, target_type="experiment", target=experiment, review=workflow_state.review, snapshot=snapshot)
        return GateEvaluation(workflow=workflow, status=status, requirements=tuple(requirements),
                              review=review, decision=decision)

    def _workflow_knowledge(self, snapshot: Snapshot, conn):
        experiment = self.get_state(experiment_id=snapshot.id, project_id=snapshot.project_id, conn=conn)
        if experiment["status"] != snapshot.state:
            raise WorkflowError("experiment state differs from its workflow instance; an explicit migration is required")
        return _ExperimentKnowledge(self, conn, experiment, snapshot)

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
        self, *, experiment_id: str, transition: str, evidence: dict[str, Any] | None = None,
        project_id: str | None = None, expected_revision: int | None = None,
    ) -> CommittedExperimentUpdate:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            experiment = self.get_state(experiment_id=experiment_id, project_id=project_id, conn=conn)
            current = self.runtime.adopt(conn=conn, project_id=project_id, instance_id=experiment_id,
                                         workflow="experiment", state=experiment["status"],
                                         data={"attempt_index": experiment["attempt_index"]})
            after = self.runtime.apply_in_transaction(
                conn=conn, project_id=project_id, instance_id=experiment_id, action=transition,
                expected_revision=current.revision if expected_revision is None else expected_revision,
                request_id=new_id(prefix="experiment_action"), payload=evidence or {},
            )
            return CommittedExperimentUpdate(
                state=self.get_state(experiment_id=experiment_id, project_id=project_id, conn=conn),
                event=self.runtime.event(conn=conn, snapshot=after),
            )

    def _commit_workflow_change(self, conn, before, after, action, payload) -> None:
        # Lifecycle decisions live in the graph. This binding only preserves
        # the native record and seals its submitted evidence on the same tx.
        if action == "start_work":
            return  # Runtime's idempotent workflow.work_started event owns the clock.
        if action not in {"revise_plan", "revise_execution", "migrate"}:
            self.artifacts.seal(tx=conn, target=ArtifactTarget("experiment", before.id, before.project_id), transition=action)
        now = now_iso()
        if action == "revise_plan":
            conn.execute(
                """UPDATE experiments SET status = ?, attempt_index = ?, revision_context = ?, updated_at = ?,
                   mlflow_run_id = '', mlflow_run_name = '', mlflow_run_status = '', mlflow_run_artifact_uri = '',
                   mlflow_run_created_at = NULL, mlflow_run_error = '' WHERE id = ? AND project_id = ?""",
                (after.state, after.data["attempt_index"], after.data["revision_context"], now, before.id, before.project_id),
            )
        elif action in {"revise_execution", "retry_running"}:
            conn.execute("UPDATE experiments SET status = ?, revision_context = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                         (after.state, after.data["revision_context"], now, before.id, before.project_id))
        elif action == "complete":
            conn.execute("UPDATE experiments SET status = ?, conclusion = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                         (after.state, after.data["conclusion"], now, before.id, before.project_id))
        else:
            conn.execute("UPDATE experiments SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
                         (after.state, now, before.id, before.project_id))

    def attempt_started_running_at(self, *, experiment_id: str) -> str | None:
        """First actual execution start in this attempt; approval never starts a clock."""
        with closing(self.store.connect()) as conn:
            rows = conn.execute(
                "SELECT type, payload_json, created_at FROM events WHERE target_id = ? "
                "AND type IN ('workflow.work_started', 'experiment.transitioned', 'experiment.returned_to_planned') ORDER BY id DESC",
                (experiment_id,),
            ).fetchall()
        started = None
        for row in rows:
            if row["type"] == "experiment.returned_to_planned":
                break
            try:
                payload = json.loads(str(row["payload_json"] or "{}"))
            except json.JSONDecodeError:
                continue
            if ((row["type"] == "workflow.work_started" and payload.get("state") == "running")
                    or (row["type"] == "experiment.transitioned" and payload.get("transition") == "start_running")):
                started = str(row["created_at"])
        return started

    def record_exhibit_verdict(
        self, *, experiment_id: str, verdict: dict[str, Any], project_id: str | None = None,
        expected_revision: int | None = None, expected_attempt_index: int | None = None,
        expected_artifact_ids: tuple[str, ...] | None = None, artifact_path: str = "",
        artifact_data: bytes | None = None, conn=None,
    ) -> None:
        """Atomically retain an exhibit and verdict for the unchanged source snapshot."""
        if artifact_data is not None and expected_revision is None:
            raise ValueError("pinning an exhibit requires its source workflow revision")
        with (self.store.transaction() if conn is None else nullcontext(conn)) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if expected_revision is not None:
                snapshot = self.runtime.lock(conn=conn, project_id=project_id, instance_id=experiment_id,
                                             revision=expected_revision)
                state = self.get_state(experiment_id=experiment_id, project_id=project_id, conn=conn)
                if snapshot.state != "running" or state["status"] != "running" or state["attempt_index"] != expected_attempt_index:
                    raise WorkflowError("experiment changed while its metrics exhibit was prepared; refresh before submitting results")
                current_ids = {str(item["id"]) for item in state.get("current_attempt_artifacts") or () if item.get("role") != EXHIBIT_ROLE}
                if expected_artifact_ids is not None and current_ids != set(expected_artifact_ids):
                    raise WorkflowError("experiment evidence changed while its metrics exhibit was prepared; refresh before submitting results")
            if artifact_data is not None:
                self.artifacts.pin(tx=conn, target=ArtifactTarget("experiment", experiment_id, project_id),
                                   path=artifact_path, role=EXHIBIT_ROLE, data=artifact_data,
                                   title="Metrics exhibit (system-generated)")
            self.store.record_event(conn=conn, project_id=project_id, event_type="experiment.exhibit_generated",
                                    target_type="experiment", target_id=experiment_id, payload=verdict)


class _ExperimentKnowledge:
    """Transaction- and project-bound facts; graph functions own every decision."""

    def __init__(self, service, conn, experiment, snapshot):
        self.service, self.conn, self.experiment, self.snapshot = service, conn, experiment, snapshot
        self._documents = {}

    def read(self, reference: Reference):
        experiment, conn = self.experiment, self.conn
        if reference.kind == "experiment" and reference.id == experiment["id"]:
            return experiment
        if reference.kind == "project" and reference.id == experiment["project_id"]:
            row = conn.execute("SELECT id, name, summary FROM projects WHERE id = ?", (reference.id,)).fetchone()
            return {} if row is None else dict(row)
        if reference.kind == "artifact":
            return self._artifact(reference.id)
        if reference.kind == "review":
            return self._review(reference.id)
        if reference.kind == "review_snapshot" and reference.id == experiment["id"]:
            node = self.service.runtime.registry.get(self.snapshot.workflow, self.snapshot.version).node(self.snapshot.state)
            role = node.role if node is not None else ""
            return read_review_fact(conn=conn, project_id=experiment["project_id"], target_type="experiment",
                                    target_id=experiment["id"], role=role, request=True,
                                    snapshot_id=review_snapshot_id(target_type="experiment", target=experiment, snapshot=self.snapshot))
        if reference.kind == "review_history":
            rows = conn.execute(
                "SELECT r.target_snapshot_id, r.verdict, r.return_to, r.notes, s.independence FROM reviews r "
                "JOIN review_sessions s ON s.id = r.session_id WHERE r.project_id = ? AND r.target_id = ? "
                "AND r.target_type = 'experiment' AND r.role = ? AND s.status = 'submitted' ORDER BY r.created_seq DESC",
                (experiment["project_id"], experiment["id"], reference.id),
            ).fetchall()
            return {"reviews": [{**dict(row), **snapshot_from_id(snapshot_id=row["target_snapshot_id"])} for row in rows]}
        raise NotFoundError(f"experiment fact not available: {reference.kind}/{reference.id}")

    def _artifact(self, artifact_id):
        if artifact_id in self._documents:
            return self._documents[artifact_id]
        experiment = self.experiment
        history = self.service.artifacts.history(tx=self.conn, target_type="experiment", target_ids=(experiment["id"],))[experiment["id"]]
        artifact = next((item for item in history.artifacts if item.id == artifact_id), None)
        if artifact is None or artifact.project_id != experiment["project_id"]:
            raise NotFoundError(f"artifact not found for this experiment: {artifact_id}")
        fact = {"id": artifact.id, "artifact_id": artifact.artifact_id, "path": artifact.path, "role": artifact.role, "error": ""}
        try:
            self.service.artifacts.contents.assert_complete(artifact_ids=(artifact.artifact_id,), project_id=experiment["project_id"], tx=self.conn)
            content = self.service.artifacts.contents.get(artifact_ids=(artifact.artifact_id,), project_id=experiment["project_id"], include="document", tx=self.conn)[0]
            if content.data is None:
                raise WorkflowError(f"{artifact.path} has no submitted content — resubmit it with artifact.upload")
            fact["figure_links"] = content.figures
            if artifact.role in {"plan", "report", "graph"}:
                try:
                    fact["text"] = content.data.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise WorkflowError(f"{artifact.path} is not valid UTF-8 text") from exc
        except (NotFoundError, ValidationError, WorkflowError) as exc:
            fact["error"] = str(exc)
        self._documents[artifact_id] = fact
        return fact

    def _review(self, role):
        return read_review_fact(conn=self.conn, project_id=self.experiment["project_id"], target_type="experiment",
                                target_id=self.experiment["id"], role=role,
                                snapshot_id=review_snapshot_id(target_type="experiment", target=self.experiment, snapshot=self.snapshot))
