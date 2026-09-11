# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The concrete public root for authoritative research state."""

from __future__ import annotations

from ..kernel.state.store import Connection

from contextlib import closing
from functools import partial
import hashlib
import json
import math
from typing import Any


from .policy import (
    EXPERIMENT_TERMINAL_STATUSES,
    REFLECTION,
    TASK_TERMINAL_STATUSES,
    AGENT_DISPATCH_SETTING,
    CLAIM_CONFIDENCES,
    CLAIM_STATUSES,
    GateEvaluation,
    parse_project_settings,
    reflection_signal_state,
)
from .experiments import ExperimentService
from .models import (
    ReflectionState,
    ExperimentState,
    LiteratureSignal,
    ResearchSnapshot,
    TaskState,
    public_record,
)
from .reflections import ReflectionService, publication_effect, wave_row
from .records import RecordHooks, Records, query
from .reviews import ReviewService, verdict_effect
from .tasks import TaskService
from ..agent_sessions import WorkspaceAdvances
from ..workflows import REVIEW_KIND, Binding, Program, Public, RecordKind, Workflows
from .artifacts import ResearchArtifacts as Artifacts
from ..kernel.state.store import BaseStateStore, Connection, next_created_seq, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, new_id, now_iso
from .persistence import RESEARCH_SCHEMA


MIN_PROJECT_NAME_LEN = 3
_GRAPH_REF_BATCH_SIZE = 400
_GRAPH_REFS = (
    ("rev_", "review", "review_id", "reviews", ("role", "verdict", "created_at")),
    ("claim_", "claim", "claim_id", "claims", ("statement", "status")),
    ("exp_", "experiment", "experiment_id", "experiments", ("intent", "status")),
    ("task_", "task", "task_id", "tasks", ("goal", "status")),
    (
        "syn_",
        "reflection",
        "reflection_id",
        "reflections",
        ("title", "status", "published_at"),
    ),
    (
        "lit_",
        "litreview_section",
        "section_id",
        "litreview_sections",
        ("title", "tldr"),
    ),
    ("paper_", "paper", "paper_id", "papers", ("title", "url", "year")),
)
_CANDIDATE_SELECT = "SELECT * FROM project_candidates"
# Which stored columns a reader of a project or a candidate never sees; the
# rest of each row is its public shape.
PROJECT_PUBLIC = Public(hidden=("tenant_id",), renames={"settings_json": "settings"})
CANDIDATE_PUBLIC = Public(hidden=("project_id", "validation_json", "idempotency_key",
                                  "request_digest", "created_seq"))


class Research:
    """Own research records, lifecycle workflows, gates, and invariants.

    What crosses the kinds is a method here: the project, its claims, its
    candidates, the canonical snapshot, the bounded project context, and the
    event ledger. What belongs to one kind belongs to that kind's service —
    ``experiments``, ``tasks``, ``reflections``, ``reviews`` — which a caller
    reaches and calls itself, because a method that only forwards to one of
    them says nothing a reader did not already know.
    """

    __slots__ = (
        "program",
        "store",
        "artifacts",
        "records",
        "experiments",
        "tasks",
        "reflections",
        "reviews",
        "workflows",
    )

    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts, workflows: Workflows,
                 advances: WorkspaceAdvances, program: Program) -> None:
        self.store = store
        self.artifacts = artifacts
        self.workflows = workflows
        self.program = program
        store.install(RESEARCH_SCHEMA)
        self.records = Records(store=store, artifacts=artifacts, runtime=workflows.runtime)
        self.experiments = ExperimentService(store=store, records=self.records)
        self.tasks = TaskService(store=store, records=self.records)
        self.reflections = ReflectionService(
            advances=advances,
            store=store,
            artifacts=artifacts,
            records=self.records,
        )
        workflows.register_transactional_effect("reflection.materialize_change_spec", publication_effect(
            write_claim=self._write_claim, create_experiment=self.experiments.create_from_reflection,
            create_task=self.tasks.create_from_reflection))
        self.reviews = ReviewService(records=self.records)
        # A review request is a native record whose graph reads nothing, so it
        # needs no hook of its own beyond the engine's own writes.
        self.records.register(REVIEW_KIND, RecordHooks())
        workflows.register_transactional_effect("review.record_verdict", verdict_effect(records=self.records))
        # Every native record binds through the one engine; a graph with no row
        # of its own is bound by the service that owns it.
        for kind in program.kinds:
            hooks = self.records.hooks[kind.name]
            self.workflows.bind(kind.name, Binding(partial(self.records.knowledge, kind),
                                                  partial(self.records.commit_change, kind),
                                                  hooks.initialize_workflow))
        for hooks in self.records.hooks.values():
            for name, binding in hooks.bindings().items():
                self.workflows.bind(name, binding)

    @property
    def kinds(self) -> dict[str, RecordKind]:
        """The native record kinds this brain installed, by name."""
        return self.records.kinds

    def initialize_workflows(self) -> None:
        """Explicit bootstrap of version-pinned legacy compositions after binding."""
        with self.store.transaction() as conn:
            self.reflections.migrate_workflow_instances(conn=conn)
            # Schema 60 adopts released research records, including gates whose
            # review already passed. Resume only that pinned migration revision;
            # an arbitrary plugin's read-only node still needs its assigned work.
            rows = conn.execute(
                "SELECT w.id, w.project_id FROM workflow_instances w JOIN workflow_history h "
                "ON h.instance_id = w.id AND h.revision = w.revision "
                "WHERE h.command_key = 'migration:60' AND w.outcome = ''"
            ).fetchall()
            for row in rows:
                decision = self.workflows.runtime.evaluate(conn=conn, project_id=row["project_id"], instance_id=row["id"])
                selected = decision.suggested
                if decision.node is not None and decision.node.execution.read_only and selected is not None and selected.available:
                    self.workflows.runtime.apply_in_transaction(
                        conn=conn, project_id=row["project_id"], instance_id=row["id"],
                        action=selected.edge.name, expected_revision=decision.snapshot.revision,
                        request_id="migration:60:review", payload={},
                    )

    # Projects -------------------------------------------------------------

    def create_project(
        self,
        *,
        name: str,
        summary: str = "",
        tenant_id: str | None = None,
        user_id: str = "",
    ) -> dict[str, Any]:
        name = self._validate_project_name(name)
        tenant_id = (tenant_id or "local").strip() or "local"
        with self.store.transaction() as conn:
            project_id = new_id(prefix="proj")
            conn.execute("INSERT INTO projects (id, name, summary, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)",
                         (project_id, name, summary.strip(), tenant_id, now_iso()))
            if user_id:
                conn.execute("INSERT INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)",
                             (project_id, user_id, now_iso()))
            self.store.record_event(conn=conn, project_id=project_id, event_type="project.created",
                                    target_type="project", target_id=project_id, payload={"name": name})
            return self.get_project(project_id=project_id, conn=conn)

    def update_project(
        self,
        *,
        project_id: str | None = None,
        name: str | None = None,
        summary: str | None = None,
        require_verified_reviews: bool | None = None,
        hidden: bool | None = None,
        agent_dispatch: bool | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            current = self.get_project(project_id=project_id, conn=conn)
            project_id = str(current["id"])
            next_name = current["name"] if name is None else self._validate_project_name(name)
            next_summary = current["summary"] if summary is None else summary.strip()
            settings = {**current["settings"], **{key: bool(value) for key, value in (
                ("require_verified_reviews", require_verified_reviews), ("hidden", hidden),
                (AGENT_DISPATCH_SETTING, agent_dispatch)) if value is not None}}
            conn.execute("UPDATE projects SET name = ?, summary = ?, settings_json = ? WHERE id = ?",
                         (next_name, next_summary, json.dumps(settings, sort_keys=True), project_id))
            self.store.record_event(conn=conn, project_id=project_id, event_type="project.updated",
                                    target_type="project", target_id=project_id,
                                    payload={"name": next_name, "summary": next_summary, "settings": settings})
            return self.get_project(project_id=project_id, conn=conn)

    def get_project(self, *, project_id: str | None = None, conn: Connection | None = None) -> dict[str, Any]:
        if conn is not None:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"project not found: {project_id}")
            return self._project_view(row)
        with closing(self.store.connect()) as conn:
            return self.get_project(project_id=project_id, conn=conn)

    def list_projects(
        self,
        *,
        tenant_id: str | None = None,
        include_hidden: bool = False,
    ) -> dict[str, Any]:
        where, parameters = ("", ()) if tenant_id is None else (" WHERE tenant_id = ?", (tenant_id,))
        with closing(self.store.connect()) as conn:
            rows = conn.execute(f"SELECT * FROM projects{where} ORDER BY created_at, id", parameters).fetchall()
        projects = [self._project_view(row) for row in rows]
        return {"projects": [project for project in projects if include_hidden or not project["settings"].get("hidden")]}

    def current_project(self, *, tenant_id: str | None = None) -> dict[str, Any]:
        projects = self.list_projects(tenant_id=tenant_id)["projects"]
        if not projects:
            return {"exists": False, "project": None}
        if len(projects) > 1:
            raise ValidationError(
                "multiple projects exist in this state store; use an explicit project_id",
                details={"project_ids": [project["id"] for project in projects]},
            )
        return {"exists": True, "project": projects[0]}

    def reachable_projects(
        self,
        *,
        user_id: str = "",
        key_project_id: str = "",
        tenant_id: str | None = None,
        include_hidden: bool = False,
    ) -> dict[str, Any]:
        projects = self.list_projects(tenant_id=tenant_id, include_hidden=include_hidden)["projects"]
        if user_id:
            memberships = self.project_ids_for_user(user_id=user_id)
            projects = [project for project in projects if str(project["id"]) in memberships]
        if key_project_id:
            projects = [project for project in projects if project["id"] == key_project_id]
        return {"projects": projects}

    def is_project_member(self, *, project_id: str, user_id: str) -> bool:
        return self.store.is_project_member(project_id=project_id, user_id=user_id)

    def project_members(self, *, project_id: str) -> dict[str, Any]:
        return {"members": self.store.list_project_members(project_id=project_id)}

    def add_project_member(self, *, project_id: str, user_id: str) -> dict[str, Any]:
        user_id = str(user_id or "").strip()
        if not user_id:
            raise ValidationError("user_id is required", details={"field": "user_id"})
        self.store.add_project_member(project_id=project_id, user_id=user_id)
        return self.project_members(project_id=project_id)

    def remove_project_member(self, *, project_id: str, user_id: str) -> dict[str, Any]:
        self.store.remove_project_member(project_id=project_id, user_id=user_id)
        return self.project_members(project_id=project_id)

    def project_ids_for_user(self, *, user_id: str) -> set[str]:
        with closing(self.store.connect()) as conn:
            rows = conn.execute("SELECT project_id FROM project_members WHERE user_id = ?", (user_id,)).fetchall()
        return {str(row["project_id"]) for row in rows}

    # Candidates -----------------------------------------------------------

    def submit_candidate(
        self,
        *,
        project_id: str | None,
        name: str,
        primary_metric: str,
        metrics: dict[str, float],
        validation_summary: str,
        idempotency_key: str,
        source_ref: str,
        expected_sha256: str = "",
        source_experiment_id: str = "",
        source_kind: str,
        higher_is_better: bool = True,
    ) -> dict[str, Any]:
        """Register one immutable resolved source or pending worktree source."""
        name, primary_metric, validation_summary, idempotency_key, source_experiment_id, source_kind, source_ref, expected_sha256 = (
            str(value or "").strip() for value in (name, primary_metric, validation_summary, idempotency_key,
                                                   source_experiment_id, source_kind, source_ref, expected_sha256))
        if not all((name, validation_summary, idempotency_key, source_ref)):
            raise ValidationError("candidate source, name, validation, and idempotency key are required")
        if source_kind not in {"artifact", "storage_object", "experiment_workspace"}:
            raise ValidationError(f"unknown candidate source_kind: {source_kind}")
        if source_kind == "experiment_workspace" and source_ref != source_experiment_id:
            raise ValidationError("experiment_workspace source must be its source_experiment_id")
        normalized_metrics = {str(key).strip(): float(value) for key, value in metrics.items()}
        if not normalized_metrics or any(not key or not math.isfinite(value) for key, value in normalized_metrics.items()):
            raise ValidationError("candidate metrics need nonblank names and finite values")
        if primary_metric not in normalized_metrics:
            raise ValidationError("primary_metric must name a value in metrics")
        validation = {"metrics": normalized_metrics, "primary_metric": primary_metric,
                      "higher_is_better": bool(higher_is_better), "summary": validation_summary}
        request_digest = hashlib.sha256(json.dumps(
            [name, source_kind, source_ref, source_experiment_id, expected_sha256, validation],
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()

        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if source_experiment_id and conn.execute("SELECT 1 FROM experiments WHERE id = ? AND project_id = ?",
                                                     (source_experiment_id, project_id)).fetchone() is None:
                raise NotFoundError(f"experiment not found in project {project_id}: {source_experiment_id}")
            existing = conn.execute("SELECT id, request_digest FROM project_candidates WHERE project_id = ? AND idempotency_key = ?",
                                    (project_id, idempotency_key)).fetchone()
            if existing is not None and str(existing["request_digest"]) != request_digest:
                raise ValidationError("idempotency_key was already used for a different candidate")
            candidate_id = str(existing["id"]) if existing is not None else new_id(prefix="cand")
            if existing is None:
                conn.execute(
                    "INSERT INTO project_candidates (id, project_id, name, source_kind, source_ref, source_experiment_id, "
                    "expected_sha256, validation_json, idempotency_key, request_digest, created_at, created_seq) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (candidate_id, project_id, name, source_kind, source_ref, source_experiment_id or None, expected_sha256,
                     json.dumps(validation, sort_keys=True, separators=(",", ":")), idempotency_key, request_digest,
                     now_iso(), next_created_seq(conn=conn, table="project_candidates")))
                self.store.record_event(conn=conn, project_id=project_id, event_type="candidate.submitted",
                                        target_type="candidate", target_id=candidate_id, payload={})
            candidate, state = self._candidate(conn=conn, project_id=project_id, candidate_id=candidate_id)
            return {"candidate": candidate, "champion_id": state["champion_id"], "idempotent": existing is not None}

    def stage_candidate(
        self,
        *,
        project_id: str | None,
        candidate_id: str,
        content_sha256: str,
        stage_kind: str,
        stage_ref: str,
        manifest_sha256: str = "",
    ) -> dict[str, Any]:
        """Append the verified durable pointer for a worktree nomination."""
        stage_kind = str(stage_kind or "").strip()
        stage_ref = str(stage_ref or "").strip()
        if (
            stage_kind not in {"artifact", "storage_object", "evaluator_receipt"}
            or not stage_ref
        ):
            raise ValidationError("stage_kind and stage_ref are required")
        if stage_kind == "evaluator_receipt" and not manifest_sha256:
            raise ValidationError(
                "manifest_sha256 is required for evaluator_receipt staging"
            )
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            candidate, _ = self._candidate(
                conn=conn, project_id=project_id, candidate_id=candidate_id
            )
            if candidate["source_kind"] != "experiment_workspace":
                raise ValidationError(
                    "only experiment_workspace candidates require staging"
                )
            if candidate["receipt"]:
                expected = {
                    "kind": stage_kind,
                    "ref": stage_ref,
                    "manifest_sha256": manifest_sha256,
                    "content_sha256": content_sha256,
                }
                receipt = dict(candidate["receipt"])
                receipt.pop("staged_at", None)
                if receipt != expected:
                    raise ValidationError(
                        "candidate already has a different staging receipt"
                    )
                return {"candidate": candidate, "idempotent": True}
            expected_sha = str(candidate["expected_sha256"])
            if expected_sha and expected_sha != content_sha256:
                raise ValidationError(
                    "staged checksum does not match the nominated workspace candidate"
                )
            receipt = {
                "kind": stage_kind,
                "ref": stage_ref,
                "manifest_sha256": manifest_sha256,
                "content_sha256": content_sha256,
            }
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="candidate.staged",
                target_type="candidate",
                target_id=candidate_id,
                payload=receipt,
            )
            staged, _ = self._candidate(
                conn=conn, project_id=project_id, candidate_id=candidate_id
            )
            return {"candidate": staged, "idempotent": False}

    def list_candidates(self, *, project_id: str | None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._candidate_state(conn=conn, project_id=project_id)

    def promote_candidate(
        self,
        *,
        project_id: str | None,
        candidate_id: str,
        expected_champion_id: str,
        reason: str,
    ) -> dict[str, Any]:
        reason = str(reason or "").strip()
        if len(reason) < 20:
            raise ValidationError(
                "promotion reason must be at least 20 characters and explain the comparison"
            )
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            candidate_id = str(candidate_id or "").strip()
            expected_champion_id = str(expected_champion_id or "").strip()
            candidate, state = self._candidate(
                conn=conn, project_id=project_id, candidate_id=candidate_id
            )
            if not candidate["staged"]:
                raise ValidationError(
                    "candidate is pending evaluator staging and cannot be promoted"
                )
            previous_id = state["champion_id"]
            if previous_id != expected_champion_id:
                raise ValidationError(
                    "champion changed; refresh candidate.list before promoting",
                    details={
                        "expected_champion_id": expected_champion_id,
                        "actual_champion_id": previous_id,
                    },
                )
            promoted = previous_id != candidate_id
            if promoted:
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="candidate.promoted",
                    target_type="candidate",
                    target_id=candidate_id,
                    payload={"previous_candidate_id": previous_id, "reason": reason},
                )
            candidate.update(validated=True, is_champion=True, was_promoted=True)
            return {
                "champion": candidate,
                "champion_id": candidate_id,
                "promoted": promoted,
            }

    @classmethod
    def _candidate(
        cls, *, conn: Connection, project_id: str, candidate_id: str
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """One candidate, and the state replay `candidate.list` reads it from."""
        state = cls._candidate_state(conn=conn, project_id=project_id)
        for candidate in state["candidates"]:
            if str(candidate["id"]) == candidate_id:
                return candidate, state
        raise NotFoundError(
            f"candidate not found in project {project_id}: {candidate_id}"
        )

    @classmethod
    def _candidate_state(cls, *, conn: Connection, project_id: str) -> dict[str, Any]:
        """Every candidate row with the staging and promotion events replayed over it."""
        rows = conn.execute(
            _CANDIDATE_SELECT + " WHERE project_id = ? ORDER BY created_seq DESC",
            (project_id,),
        ).fetchall()
        receipts, promotions = cls._candidate_history(conn=conn, project_id=project_id)
        champion_id = str(promotions[0]["candidate_id"]) if promotions else ""
        promoted_ids = {str(item["candidate_id"]) for item in promotions}
        candidates = [
            cls._candidate_view(
                row,
                receipt=receipts.get(str(row["id"])),
                promoted=str(row["id"]) in promoted_ids,
                is_champion=str(row["id"]) == champion_id,
            )
            for row in rows
        ]
        return {
            "champion": next((c for c in candidates if c["is_champion"]), None),
            "champion_id": champion_id,
            "candidates": candidates,
            "promotions": promotions,
        }

    @staticmethod
    def _candidate_view(
        row: Any,
        *,
        receipt: dict[str, Any] | None,
        promoted: bool,
        is_champion: bool,
    ) -> dict[str, Any]:
        """The candidate row, plus what its validation and staging receipt say."""
        data = row_to_dict(row=row) or {}
        validation = json.loads(str(data.get("validation_json") or "{}"))
        workspace = data.get("source_kind") == "experiment_workspace"
        return public_record(
            CANDIDATE_PUBLIC, data,
            source_experiment_id=data.get("source_experiment_id") or "",
            expected_sha256=data.get("expected_sha256") or "",
            staged=not workspace or receipt is not None,
            receipt=receipt or (None if workspace else {
                "kind": data.get("source_kind"), "ref": data.get("source_ref"),
                "manifest_sha256": "", "content_sha256": data.get("expected_sha256"),
                "staged_at": data.get("created_at"),
            }),
            metrics=validation.get("metrics", {}),
            primary_metric=validation.get("primary_metric"),
            higher_is_better=bool(validation.get("higher_is_better", True)),
            validation_summary=validation.get("summary", ""),
            validated=promoted,
            was_promoted=promoted,
            is_champion=is_champion,
        )

    @classmethod
    def _candidate_context(
        cls, *, conn: Connection, project_id: str
    ) -> dict[str, Any]:
        state = cls._candidate_state(conn=conn, project_id=project_id)
        recent = state["candidates"][:3]
        return {
            "champion": state["champion"],
            "champion_id": state["champion_id"],
            "latest": recent[0] if recent else None,
            "recent": recent,
            "count": len(state["candidates"]),
            "pending_staging_count": sum(
                not candidate["staged"] for candidate in state["candidates"]
            ),
        }

    @staticmethod
    def _candidate_history(
        *, conn: Connection, project_id: str
    ) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        rows = conn.execute(
            """
            SELECT id, type, target_id, payload_json, created_at FROM events
            WHERE project_id = ? AND target_type = 'candidate'
              AND type IN ('candidate.staged', 'candidate.promoted')
            ORDER BY id DESC
            """,
            (project_id,),
        ).fetchall()
        receipts: dict[str, dict[str, Any]] = {}
        promotions: list[dict[str, Any]] = []
        for row in rows:
            payload = json.loads(str(row["payload_json"] or "{}"))
            candidate_id = str(row["target_id"])
            if row["type"] == "candidate.staged":
                payload["staged_at"] = str(row["created_at"])
                receipts.setdefault(candidate_id, payload)
            else:
                promotions.append(
                    {
                        "event_id": int(row["id"]),
                        "candidate_id": candidate_id,
                        "previous_candidate_id": payload.get(
                            "previous_candidate_id", ""
                        ),
                        "reason": payload.get("reason", ""),
                        "created_at": str(row["created_at"]),
                    }
                )
        return receipts, promotions

    # Claims ---------------------------------------------------------------

    def create_claim(
        self,
        *,
        statement: str,
        scope: str = "",
        confidence: str = "medium",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._write_claim(conn=conn, project_id=project_id,
                                     changes={"statement": statement, "scope": scope, "confidence": confidence})

    def update_claim(self, *, claim_id: str, status: str | None = None, confidence: str | None = None,
                     project_id: str | None = None) -> dict[str, Any]:
        if status is None and confidence is None:
            raise ValidationError("nothing to update: provide status and/or confidence")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._write_claim(conn=conn, project_id=project_id, claim_id=claim_id,
                                     changes={"status": status, "confidence": confidence})

    def _write_claim(self, *, conn: Connection, project_id: str, changes: dict[str, Any], claim_id: str = "",
                     provenance: dict[str, Any] | None = None) -> dict[str, Any]:
        """Write a claim and its event on the caller's transaction, preserving omitted fields."""
        creating = not claim_id
        fields = {"statement": "", "scope": "", "status": "active", "confidence": "medium"}
        if not creating:
            row = conn.execute("SELECT * FROM claims WHERE id = ? AND project_id = ?", (claim_id, project_id)).fetchone()
            if row is None:
                raise NotFoundError(f"claim not found in project {project_id}: {claim_id}")
            fields.update({name: row[name] for name in fields})
        fields.update({name: changes[name] for name in fields if changes.get(name) is not None})
        for name in ("statement", "scope"):
            fields[name] = fields[name].strip()
        if not fields["statement"]:
            raise ValidationError("statement is required")
        for name, allowed in (("status", CLAIM_STATUSES), ("confidence", CLAIM_CONFIDENCES)):
            if fields[name] not in allowed:
                raise ValidationError(f"unknown claim {name}: {fields[name]}")
        if creating:
            claim_id = new_id(prefix="claim")
            conn.execute("INSERT INTO claims (id, project_id, statement, scope, status, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (claim_id, project_id, *fields.values(), now_iso()))
        else:
            conn.execute("UPDATE claims SET statement = ?, scope = ?, status = ?, confidence = ? WHERE id = ? AND project_id = ?",
                         (*fields.values(), claim_id, project_id))
        self.store.record_event(conn=conn, project_id=project_id, event_type="claim.created" if creating else "claim.updated",
                                target_type="claim", target_id=claim_id, payload={**fields, **(provenance or {})})
        return dict(conn.execute("SELECT * FROM claims WHERE id = ? AND project_id = ?", (claim_id, project_id)).fetchone())

    def list_claims(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return {"claims": query(conn, "SELECT * FROM claims WHERE project_id = ? ORDER BY created_at, id", (project_id,))}

    # Node reads -----------------------------------------------------------

    def project_experiments(self, *, project_id: str | None) -> list[ExperimentState]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            evaluated = self.experiments.list_states_with_gates(
                conn=conn, project_id=project_id
            )
            return [state for state, _gate in evaluated]

    def project_tasks(self, *, project_id: str | None) -> list[TaskState]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            evaluated = self.tasks.list_states_with_gates(
                conn=conn, project_id=project_id
            )
            return [state for state, _gate in evaluated]

    # Reviews --------------------------------------------------------------

    def review_project_id(self, *, review_request_id: Any = None, review_session_id: Any = None) -> str | None:
        found = self.reviews.locate(request_id=review_request_id, session_id=review_session_id)
        return None if found is None else found[0]

    def assert_review_in_project(self, *, project_id: str | None, review_request_id: Any = None,
                                 review_session_id: Any = None) -> None:
        found = self.reviews.locate(request_id=review_request_id, session_id=review_session_id)
        if found is None or found[0] != project_id:
            what = "request" if review_request_id else "session"
            raise NotFoundError(f"review {what} not found in project {project_id}: {review_request_id or review_session_id}")

    # Canonical reads ------------------------------------------------------

    def snapshot(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
        task_id: str | None = None,
    ) -> ResearchSnapshot:
        """Read all project research once; no caller-selected hydration shape."""
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            claims = query(conn, "SELECT id, statement, scope, status, confidence, created_at FROM claims "
                                 "WHERE project_id = ? ORDER BY created_at, id", (project_id,))
            evaluated = self.experiments.list_states_with_gates(conn=conn, project_id=project_id)
            evaluated_tasks = self.tasks.list_states_with_gates(conn=conn, project_id=project_id,
                                                                detail_ids=(task_id,) if task_id else ())
            open_reflection, open_gate = self._reflection(conn=conn, project_id=project_id, terminal=False)
            published, published_gate = self._reflection(conn=conn, project_id=project_id, terminal=True)
            experiments, tasks = [state for state, _ in evaluated], [state for state, _ in evaluated_tasks]
            return ResearchSnapshot(
                project_id=project_id, requested_experiment_id=experiment_id, requested_task_id=task_id,
                project=row_to_dict(row=conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()) or {},
                claims=claims, experiments=experiments, tasks=tasks,
                open_reflection=open_reflection, latest_published_reflection=published,
                gate_evaluations={**{state.id: gate for state, gate in (*evaluated, *evaluated_tasks)},
                                  **{wave.id: gate for wave, gate in ((open_reflection, open_gate), (published, published_gate))
                                     if wave is not None}},
                reflection_signal=reflection_signal_state(
                    current_terminal={row.id: row.status for row in experiments if row.status in EXPERIMENT_TERMINAL_STATUSES},
                    current_terminal_tasks={row.id: row.status for row in tasks if row.status in TASK_TERMINAL_STATUSES},
                    current_claims={str(claim["id"]): str(claim["status"]) for claim in claims},
                    published=published, open_wave=open_reflection),
                literature_signal=self._literature_signal(conn=conn, project_id=project_id),
            )

    def project_context_facts(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            experiments = query(conn, "SELECT id, name, intent, status, attempt_index, conclusion, created_at, updated_at "
                                      "FROM experiments WHERE project_id = ? ORDER BY created_at, id", (project_id,))
            claims_by_experiment: dict[str, list[str]] = {}
            for link in conn.execute("SELECT ec.experiment_id, ec.claim_id FROM experiment_claims ec JOIN experiments e "
                                     "ON e.id = ec.experiment_id WHERE e.project_id = ? ORDER BY e.created_at, e.id, ec.claim_id",
                                     (project_id,)).fetchall():
                claims_by_experiment.setdefault(str(link["experiment_id"]), []).append(str(link["claim_id"]))
            for experiment in experiments:
                experiment["tested_claim_ids"] = claims_by_experiment.get(str(experiment["id"]), [])
            return {
                "project": row_to_dict(row=conn.execute("SELECT id, name, summary FROM projects WHERE id = ?",
                                                        (project_id,)).fetchone()) or {},
                "claims": query(conn, "SELECT id, statement, scope, status, confidence FROM claims "
                                      "WHERE project_id = ? ORDER BY created_at, id", (project_id,)),
                "experiments": experiments,
                "tasks": query(conn, "SELECT id, name, goal, status, attempt_index, outcome, failed_by, created_at, updated_at "
                                     "FROM tasks WHERE project_id = ? ORDER BY created_at, id", (project_id,)),
                "latest_published_reflection": row_to_dict(row=wave_row(
                    conn, project_id, published=True, columns="id, title, status, attempt_index, published_at, updated_at")),
                "open_reflection": row_to_dict(row=wave_row(
                    conn, project_id, published=False, columns="id, title, status, attempt_index, updated_at")),
                "literature_summary": row_to_dict(row=conn.execute(
                    "SELECT id, tldr, body, updated_at FROM litreview_sections WHERE project_id = ? AND kind = 'summary'",
                    (project_id,)).fetchone()),
                "paper_count": int(conn.execute("SELECT COUNT(*) AS n FROM papers WHERE project_id = ?",
                                                (project_id,)).fetchone()["n"]),
                "candidates": self._candidate_context(conn=conn, project_id=project_id),
            }

    def resolve_graph_refs(self, *, project_id: str, refs: tuple[str, ...]) -> dict[str, Any]:
        if not refs:
            return {}
        with closing(self.store.connect()) as conn:
            resolved: dict[str, Any] = {}
            for prefix, entity_type, id_key, table, selected_fields in _GRAPH_REFS:
                typed_refs = tuple(dict.fromkeys(ref for ref in refs if ref.startswith(prefix)))
                by_id: dict[str, Any] = {}
                for start in range(0, len(typed_refs), _GRAPH_REF_BATCH_SIZE):
                    batch = typed_refs[start:start + _GRAPH_REF_BATCH_SIZE]
                    by_id.update((str(row["id"]), row) for row in conn.execute(
                        f"SELECT {', '.join(('id', *selected_fields))} FROM {table} "
                        f"WHERE project_id = ? AND id IN ({', '.join('?' for _ in batch)})", (project_id, *batch)).fetchall())
                for ref in typed_refs:
                    row = by_id.get(ref)
                    resolved[ref] = ({"type": "unknown", "resolved": False} if row is None else
                                     {"type": entity_type, "resolved": True, id_key: row["id"],
                                      **{field: row[field] for field in selected_fields}})
            return {ref: resolved[ref] for ref in refs if ref in resolved}

    # Event ledger reads ---------------------------------------------------

    def tenant_event_count(self, *, tenant_id: str) -> int:
        return self.store.tenant_event_count(tenant_id=tenant_id)

    def project_event_signal(self, *, project_id: str) -> str:
        return self.store.project_event_signal(project_id=project_id)

    def recent_events(self, *, project_id: str, limit: int) -> dict[str, Any]:
        return self.store.recent_events(project_id=project_id, limit=limit)

    def events_since(self, *, project_id: str, after_id: int) -> dict[str, Any]:
        """Ascending tail of the events table — the SSE cursor read."""
        return self.store.recent_events(project_id=project_id, limit=500, after_id=after_id)

    # Read helpers ---------------------------------------------------------

    def _reflection(self, *, conn: Connection, project_id: str, terminal: bool
                    ) -> tuple[ReflectionState | None, GateEvaluation | None]:
        row = wave_row(conn, project_id, published=terminal)
        return (None, None) if row is None else self.reflections.get_state_with_gate(reflection_id=row["id"], conn=conn)

    def _literature_signal(self, *, conn: Connection, project_id: str) -> LiteratureSignal:
        total = conn.execute("SELECT COUNT(*) AS n FROM papers WHERE project_id = ?", (project_id,)).fetchone()
        unreviewed = conn.execute(
            "SELECT COUNT(*) AS n FROM papers p WHERE p.project_id = ? "
            "AND EXISTS (SELECT 1 FROM paper_links l WHERE l.paper_id = p.id AND l.target_type IN ('experiment', 'claim')) "
            "AND NOT EXISTS (SELECT 1 FROM paper_links l WHERE l.paper_id = p.id AND l.target_type = 'litreview_section')",
            (project_id,)).fetchone()
        return LiteratureSignal(papers_total=int(total["n"]), papers_unreviewed=int(unreviewed["n"]))

    @staticmethod
    def _validate_project_name(name: str) -> str:
        name = (name or "").strip()
        if not name:
            raise ValidationError("name is required")
        if len(name) < MIN_PROJECT_NAME_LEN:
            raise ValidationError(f"name must be at least {MIN_PROJECT_NAME_LEN} characters")
        return name

    @staticmethod
    def _project_view(row: Any) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        return public_record(PROJECT_PUBLIC, data,
                             settings=parse_project_settings(data.get("settings_json")))


__all__ = ["Research"]
