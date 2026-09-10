# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""What is true of experiments alone: creation invariants, claims, exhibits."""

from __future__ import annotations

from contextlib import closing, nullcontext
import json
from typing import Any

from ..workflows import EXHIBIT_ROLE, KINDS, Snapshot
from .experiment_workflow import EXPERIMENT_WORKFLOW
from .reflection_workflow import REFLECTION_WORKFLOW
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    GateEvaluation,
    active_experiment_cap_reached_message,
    covered_terminal_ids,
    reflection_create_block_message,
    validate_experiment_name,
)
from .artifact_models import ArtifactTarget
from .records import RecordHooks, Records
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError
from .models import CommittedExperimentUpdate

EXPERIMENT = KINDS["experiment"]


class ExperimentService(RecordHooks):
    """The experiment's own rules; every lifecycle step runs on ``Records``."""

    def __init__(self, *, store: BaseStateStore, records: Records) -> None:
        self.store = store
        self.records = records
        self.runtime = records.runtime
        self.artifacts = records.artifacts
        records.register(EXPERIMENT, self)

    # ---- create ----

    def create(
        self, *, name: str, intent: str, details: str = "",
        tested_claim_ids: list[str] | str | None = None,
        depends_on: list[str] | str | None = None, project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._create(conn=conn, project_id=project_id, name=name, intent=intent, details=details,
                                tested_claim_ids=tested_claim_ids, depends_on=depends_on)

    def create_from_reflection(
        self, *, conn, project_id: str, reflection_id: str, name: str, intent: str, details: str = "",
        tested_claim_ids: list[str] | str | None = None, proposal_key: str = "",
        parallelism: str = "", depends_on: list[str] | str | None = None,
    ) -> dict[str, Any]:
        """Create one reviewed reflection proposal through normal invariants.

        The cap, reserved name and reflection-debt blocks were checked when the
        change spec passed reflection review; re-checking here could only wedge
        an already-bound publish over a mid-wave tool create.
        """
        reflection_id = str(reflection_id or "").strip()
        if conn.execute("SELECT id FROM reflections WHERE id = ? AND project_id = ?",
                        (reflection_id, project_id)).fetchone() is None:
            raise NotFoundError(f"reflection not found: {reflection_id}")
        return self._create(conn=conn, project_id=project_id, name=name, intent=intent, details=details,
                            tested_claim_ids=tested_claim_ids, depends_on=depends_on, guard=False,
                            source={"source_reflection_id": reflection_id, "proposal_key": proposal_key.strip(),
                                    "parallelism": parallelism.strip()})

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        self._create(conn=conn, project_id=snapshot.project_id, instance=snapshot,
                     name=str(snapshot.data.get("name") or ""), intent=str(snapshot.data.get("intent") or ""),
                     details=str(snapshot.data.get("details") or ""),
                     tested_claim_ids=snapshot.data.get("tested_claim_ids"),
                     depends_on=snapshot.data.get("depends_on"))

    def _create(self, *, conn, project_id, name, intent, details="", tested_claim_ids=None,
                depends_on=None, guard=True, source=None, instance=None) -> dict[str, Any]:
        # Order-preserving dedupe: distinct refs (a create key and a literal
        # claim id) can resolve to one claim, and experiment_claims has a
        # composite primary key — a duplicate insert would abort the caller's
        # whole transaction (reflection publish included).
        claim_ids = ([tested_claim_ids] if isinstance(tested_claim_ids, str)
                     else list(dict.fromkeys(tested_claim_ids or [])))
        name = validate_experiment_name(name)
        if not intent.strip():
            raise ValidationError("intent is required")
        return self.records.create_in_transaction(
            EXPERIMENT, conn=conn, project_id=project_id, guard=guard, instance=instance,
            values={"name": name, "intent": intent.strip(), "details": details.strip(),
                    "tested_claim_ids": claim_ids},
            event={"name": name, "intent": intent, **(source or {})}, depends_on=depends_on,
        )

    # ---- declared hooks ----

    def before_create(self, *, conn, project_id: str, values: dict[str, Any]) -> None:
        self._reject_active_experiment_cap(conn=conn, project_id=project_id)
        self._reject_reflection_blocked_experiment_create(conn=conn, project_id=project_id)
        self._reject_reserved_wave_name(conn=conn, project_id=project_id, name=str(values["name"]))

    def after_create(self, *, conn, project_id: str, record_id: str, values: dict[str, Any]) -> None:
        for claim_id in values.get("tested_claim_ids") or []:
            if conn.execute("SELECT id FROM claims WHERE id = ? AND project_id = ?",
                            (claim_id, project_id)).fetchone() is None:
                raise NotFoundError(f"claim not found: {claim_id}")
            conn.execute("INSERT INTO experiment_claims (experiment_id, claim_id) VALUES (?, ?)",
                         (record_id, claim_id))

    def hydrate(self, *, conn, project_id: str, records: list[dict[str, Any]], detail_ids=()) -> None:
        claims: dict[str, list[dict[str, Any]]] = {}
        for claim in rows_to_dicts(rows=conn.execute(
            """SELECT ec.experiment_id AS _experiment_id, c.* FROM experiment_claims ec
               JOIN experiments e ON e.id = ec.experiment_id JOIN claims c ON c.id = ec.claim_id
               WHERE e.project_id = ? ORDER BY e.created_at, e.id, c.created_at, c.id""",
            (project_id,)).fetchall()):
            claims.setdefault(str(claim.pop("_experiment_id")), []).append(claim)
        for record in records:
            record["tested_claims"] = claims.get(str(record["id"]), [])

    # ---- create blocks ----

    def _reject_active_experiment_cap(self, *, conn, project_id: str) -> None:
        # Reserved wave names hold their cap slots: the wave passed the cap
        # check when its spec was validated, so tool creates must not consume
        # the slots its publish will materialize into.
        terminal = ", ".join(f"'{status}'" for status in sorted(EXPERIMENT_WORKFLOW.terminal_statuses))
        active_count = int(conn.execute(
            f"SELECT COUNT(*) AS count FROM experiments WHERE project_id = ? AND status NOT IN ({terminal})",
            (project_id,)).fetchone()["count"])
        reserved_count = int(conn.execute(
            "SELECT COUNT(*) AS count FROM reflection_reserved_names WHERE project_id = ?",
            (project_id,)).fetchone()["count"])
        if active_count + reserved_count >= ACTIVE_EXPERIMENT_CAP:
            raise WorkflowError(active_experiment_cap_reached_message(
                active_count=active_count, reserved_count=reserved_count))

    def _reject_reserved_wave_name(self, *, conn, project_id: str, name: str) -> None:
        """Refuse names an in-flight wave's validated spec will materialize.

        Taking one mid-wave would block the wave's already-bound publish at
        materialization; the reservation makes the race an actionable error
        for the creator instead.
        """
        row = conn.execute(
            "SELECT reflection_id FROM reflection_reserved_names "
            "WHERE project_id = ? AND name_lower = lower(?) LIMIT 1", (project_id, name)).fetchone()
        if row is not None:
            raise WorkflowError(
                f"experiment name {name!r} is reserved by reflection wave "
                f"{row['reflection_id']} — it will be created when the wave "
                "publishes; choose a different name")

    def _reject_reflection_blocked_experiment_create(self, *, conn, project_id: str) -> None:
        debt, published_id = self._terminal_experiments_since_last_reflection(conn=conn, project_id=project_id)
        terminal = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
        open_wave = conn.execute(
            f"""SELECT id, status FROM reflections WHERE project_id = ?
                AND status NOT IN ({", ".join("?" for _ in terminal)})
                ORDER BY created_seq DESC LIMIT 1""", (project_id, *terminal)).fetchone()
        message = reflection_create_block_message(
            debt=debt, published_id=published_id, open_wave=row_to_dict(row=open_wave))
        if message:
            raise WorkflowError(message)

    def _terminal_experiments_since_last_reflection(self, *, conn, project_id: str) -> tuple[int, str | None]:
        terminal = ", ".join(f"'{status}'" for status in sorted(EXPERIMENT_WORKFLOW.terminal_statuses))
        current_terminal = {
            str(row["id"]) for row in conn.execute(
                f"SELECT id FROM experiments WHERE project_id = ? AND status IN ({terminal})",
                (project_id,)).fetchall()}
        published = conn.execute(
            """SELECT id, corpus_json FROM reflections WHERE project_id = ? AND status = ?
               ORDER BY published_at DESC, created_seq DESC LIMIT 1""",
            (project_id, REFLECTION_WORKFLOW.success_status)).fetchone()
        if published is None:
            return len(current_terminal), None
        try:
            corpus = json.loads(str(published["corpus_json"] or "{}"))
        except json.JSONDecodeError:
            corpus = {}
        return len(current_terminal - covered_terminal_ids(corpus)), str(published["id"])

    # ---- reads and transitions ----

    def get_state(self, *, experiment_id: str, project_id: str | None = None, conn=None) -> dict[str, Any]:
        return self.records.get_state(EXPERIMENT, record_id=experiment_id, project_id=project_id, conn=conn)

    def get_state_with_gate(self, *, experiment_id: str, project_id: str | None = None,
                            conn=None) -> tuple[dict[str, Any], GateEvaluation]:
        return self.records.get_state_with_gate(EXPERIMENT, record_id=experiment_id,
                                                project_id=project_id, conn=conn)

    def list_states_with_gates(self, *, conn, project_id: str) -> list[tuple[dict[str, Any], GateEvaluation]]:
        return self.records.list_states_with_gates(EXPERIMENT, conn=conn, project_id=project_id)

    def assert_in_project(self, *, experiment_id: str, project_id: str) -> None:
        self.records.assert_in_project(EXPERIMENT, record_id=experiment_id, project_id=project_id)

    def list_experiment_summaries(self, *, project_id: str | None = None) -> list[dict[str, Any]]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return rows_to_dicts(rows=conn.execute(
                """SELECT id, project_id, name, intent, status, attempt_index, created_at, updated_at
                   FROM experiments WHERE project_id = ? ORDER BY created_at, id""",
                (project_id,)).fetchall())

    def transition_with_event(
        self, *, experiment_id: str, transition: str, evidence: dict[str, Any] | None = None,
        project_id: str | None = None, expected_revision: int | None = None,
    ) -> CommittedExperimentUpdate:
        state, event = self.records.transition(
            EXPERIMENT, record_id=experiment_id, transition=transition, evidence=evidence,
            project_id=project_id, expected_revision=expected_revision)
        return CommittedExperimentUpdate(state=state, event=event)

    # ---- experiment-only facts ----

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


__all__ = ["ExperimentService"]
