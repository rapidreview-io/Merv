# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The concrete public root for authoritative research state."""

from __future__ import annotations

from contextlib import closing
import hashlib
import json
import math
from typing import Any, cast

from merv.shared.storage_guidance import STORAGE_MAX_UPLOAD_BYTES_SETTING

from .experiment_workflow import EXPERIMENT_TERMINAL_STATUSES
from .reflection_workflow import REFLECTION_WORKFLOW
from .policy import (
    AGENT_DISPATCH_SETTING,
    CLAIM_CONFIDENCES,
    CLAIM_STATUSES,
    GateEvaluation,
    parse_project_settings,
    reflection_signal_state,
    snapshot_from_id,
)
from .experiments import ExperimentService
from .models import (
    CommittedExperimentUpdate,
    ExhibitVerdict,
    ExperimentState,
    ExperimentSummary,
    LiteratureSignal,
    PersistedRunState,
    ResearchSnapshot,
)
from .reflections import ReflectionService
from .reviews import ReviewService
from ..artifacts import Artifacts
from ..kernel.events import StoredEvent
from ..kernel.state.store import (
    BaseStateStore,
    Connection,
    next_created_seq,
    row_to_dict,
    rows_to_dicts,
)
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    new_id,
    now_iso,
)


MIN_PROJECT_NAME_LEN = 3
_GRAPH_REF_BATCH_SIZE = 400
_GRAPH_REFS = (
    ("rev_", "review", "review_id", "reviews", ("role", "verdict", "created_at")),
    ("claim_", "claim", "claim_id", "claims", ("statement", "status")),
    ("exp_", "experiment", "experiment_id", "experiments", ("intent", "status")),
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


class Research:
    """Own research records, lifecycle workflows, gates, and invariants.

    Application and delivery code use this object only. Experiment, reflection,
    and review implementations remain separate because their transactions and
    state machines are independently meaningful; they are not public service
    objects.
    """

    __slots__ = (
        "store",
        "artifacts",
        "_experiments",
        "_reflections",
        "_reviews",
    )

    def __init__(self, *, store: BaseStateStore, artifacts: Artifacts) -> None:
        self.store = store
        self.artifacts = artifacts
        self._experiments = ExperimentService(store=store, artifacts=artifacts)
        self._reflections = ReflectionService(
            store=store,
            artifacts=artifacts,
            experiments=self._experiments,
        )
        self._reviews = ReviewService(
            store=store,
            experiments=self._experiments,
            reflections=self._reflections,
            artifacts=artifacts,
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
            conn.execute(
                """
                INSERT INTO projects (id, name, summary, tenant_id, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (project_id, name, summary.strip(), tenant_id, now_iso()),
            )
            if user_id:
                conn.execute(
                    """
                    INSERT INTO project_members (project_id, user_id, added_at)
                    VALUES (?, ?, ?)
                    """,
                    (project_id, user_id, now_iso()),
                )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="project.created",
                target_type="project",
                target_id=project_id,
                payload={"name": name},
            )
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            return self._project_view(row)

    def update_project(
        self,
        *,
        project_id: str | None = None,
        name: str | None = None,
        summary: str | None = None,
        require_verified_reviews: bool | None = None,
        hidden: bool | None = None,
        agent_dispatch: bool | None = None,
        storage_max_upload_bytes: int | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"project not found: {project_id}")
            next_name = (
                str(row["name"]) if name is None else self._validate_project_name(name)
            )
            next_summary = str(row["summary"]) if summary is None else summary.strip()
            settings = parse_project_settings(row["settings_json"])
            if require_verified_reviews is not None:
                settings["require_verified_reviews"] = bool(require_verified_reviews)
            if hidden is not None:
                settings["hidden"] = bool(hidden)
            if agent_dispatch is not None:
                settings[AGENT_DISPATCH_SETTING] = bool(agent_dispatch)
            if storage_max_upload_bytes is not None:
                if isinstance(storage_max_upload_bytes, bool) or int(
                    storage_max_upload_bytes
                ) <= 0:
                    raise ValidationError(
                        "storage_max_upload_bytes must be a positive integer"
                    )
                settings[STORAGE_MAX_UPLOAD_BYTES_SETTING] = int(
                    storage_max_upload_bytes
                )
            conn.execute(
                """
                UPDATE projects
                SET name = ?, summary = ?, settings_json = ?
                WHERE id = ?
                """,
                (
                    next_name,
                    next_summary,
                    json.dumps(settings, sort_keys=True),
                    project_id,
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="project.updated",
                target_type="project",
                target_id=project_id,
                payload={
                    "name": next_name,
                    "summary": next_summary,
                    "settings": settings,
                },
            )
            updated = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            return self._project_view(updated)

    def get_project(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"project not found: {project_id}")
            return self._project_view(row)

    def list_projects(
        self,
        *,
        tenant_id: str | None = None,
        include_hidden: bool = False,
    ) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            if tenant_id is None:
                rows = conn.execute(
                    "SELECT * FROM projects ORDER BY created_at, id"
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM projects
                    WHERE tenant_id = ?
                    ORDER BY created_at, id
                    """,
                    (tenant_id,),
                ).fetchall()
        projects = [self._project_view(row) for row in rows]
        if not include_hidden:
            projects = [
                project for project in projects if not project["settings"].get("hidden")
            ]
        return {"projects": projects}

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
        projects = self.list_projects(
            tenant_id=tenant_id, include_hidden=include_hidden
        )["projects"]
        if user_id:
            memberships = self.project_ids_for_user(user_id=user_id)
            projects = [
                project for project in projects if str(project["id"]) in memberships
            ]
        if key_project_id:
            projects = [
                project for project in projects if project["id"] == key_project_id
            ]
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
            rows = conn.execute(
                """
                SELECT project_id FROM project_members
                WHERE user_id = ?
                """,
                (user_id,),
            ).fetchall()
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
        name = str(name or "").strip()
        primary_metric = str(primary_metric or "").strip()
        validation_summary = str(validation_summary or "").strip()
        idempotency_key = str(idempotency_key or "").strip()
        source_experiment_id = str(source_experiment_id or "").strip()
        source_kind = str(source_kind or "").strip()
        source_ref = str(source_ref or "").strip()
        expected_sha256 = str(expected_sha256 or "").strip()
        if not all((name, validation_summary, idempotency_key, source_ref)):
            raise ValidationError(
                "candidate source, name, validation, and idempotency key are required"
            )
        if source_kind not in {"artifact", "storage_object", "experiment_workspace"}:
            raise ValidationError(f"unknown candidate source_kind: {source_kind}")
        if source_kind == "experiment_workspace" and source_ref != source_experiment_id:
            raise ValidationError(
                "experiment_workspace source must be its source_experiment_id"
            )
        normalized_metrics = {
            str(key).strip(): float(value) for key, value in metrics.items()
        }
        if not normalized_metrics or any(
            not key or not math.isfinite(value)
            for key, value in normalized_metrics.items()
        ):
            raise ValidationError(
                "candidate metrics need nonblank names and finite values"
            )
        if primary_metric not in normalized_metrics:
            raise ValidationError("primary_metric must name a value in metrics")
        validation = {
            "metrics": normalized_metrics,
            "primary_metric": primary_metric,
            "higher_is_better": bool(higher_is_better),
            "summary": validation_summary,
        }
        request_digest = hashlib.sha256(
            json.dumps(
                [
                    name,
                    source_kind,
                    source_ref,
                    source_experiment_id,
                    expected_sha256,
                    validation,
                ],
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if source_experiment_id:
                source = conn.execute(
                    "SELECT 1 FROM experiments WHERE id = ? AND project_id = ?",
                    (source_experiment_id, project_id),
                ).fetchone()
                if source is None:
                    raise NotFoundError(
                        f"experiment not found in project {project_id}: "
                        f"{source_experiment_id}"
                    )
            existing = conn.execute(
                """
                SELECT * FROM project_candidates
                WHERE project_id = ? AND idempotency_key = ?
                """,
                (project_id, idempotency_key),
            ).fetchone()
            if existing is not None:
                if str(existing["request_digest"]) != request_digest:
                    raise ValidationError(
                        "idempotency_key was already used for a different candidate"
                    )
                candidate_id = str(existing["id"])
                idempotent = True
            else:
                candidate_id = new_id(prefix="cand")
                now = now_iso()
                conn.execute(
                    """
                    INSERT INTO project_candidates (
                      id, project_id, name, source_kind, source_ref,
                      source_experiment_id, expected_sha256, validation_json,
                      idempotency_key, request_digest, created_at, created_seq
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        candidate_id,
                        project_id,
                        name,
                        source_kind,
                        source_ref,
                        source_experiment_id or None,
                        expected_sha256,
                        json.dumps(validation, sort_keys=True, separators=(",", ":")),
                        idempotency_key,
                        request_digest,
                        now,
                        next_created_seq(conn=conn, table="project_candidates"),
                    ),
                )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="candidate.submitted",
                    target_type="candidate",
                    target_id=candidate_id,
                    payload={},
                )
                idempotent = False
            return {
                "candidate": self._candidate(
                    conn=conn, project_id=project_id, candidate_id=candidate_id
                ),
                "champion_id": self._champion_id(conn=conn, project_id=project_id),
                "idempotent": idempotent,
            }

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
            candidate = self._candidate(
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
            event = self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="candidate.staged",
                target_type="candidate",
                target_id=candidate_id,
                payload=receipt,
            )
            receipt["staged_at"] = event.created_at
            return {
                "candidate": self._candidate(
                    conn=conn,
                    project_id=project_id,
                    candidate_id=candidate_id,
                    receipt=receipt,
                ),
                "idempotent": False,
            }

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
            candidate = self._candidate(
                conn=conn, project_id=project_id, candidate_id=candidate_id
            )
            if not candidate["staged"]:
                raise ValidationError(
                    "candidate is pending evaluator staging and cannot be promoted"
                )
            previous_id = self._champion_id(conn=conn, project_id=project_id)
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
        cls,
        *,
        conn: Connection,
        project_id: str,
        candidate_id: str,
        receipt: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        row = conn.execute(
            _CANDIDATE_SELECT + " WHERE id = ? AND project_id = ?",
            (candidate_id, project_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(
                f"candidate not found in project {project_id}: {candidate_id}"
            )
        if receipt is None and str(row["source_kind"]) == "experiment_workspace":
            staged = conn.execute(
                """
                SELECT payload_json, created_at FROM events
                WHERE project_id = ? AND type = 'candidate.staged'
                  AND target_type = 'candidate' AND target_id = ?
                ORDER BY id DESC LIMIT 1
                """,
                (project_id, candidate_id),
            ).fetchone()
            if staged is not None:
                receipt = json.loads(str(staged["payload_json"] or "{}"))
                receipt["staged_at"] = str(staged["created_at"])
        view = cls._candidate_view(row, receipt=receipt)
        promotion = conn.execute(
            """
            SELECT EXISTS(
                     SELECT 1 FROM events WHERE project_id = ?
                       AND type = 'candidate.promoted' AND target_id = ?
                   ) AS was_promoted,
                   COALESCE((SELECT target_id FROM events WHERE project_id = ?
                     AND type = 'candidate.promoted' ORDER BY id DESC LIMIT 1), '')
                     AS champion_id
            """,
            (project_id, candidate_id, project_id),
        ).fetchone()
        was_promoted = bool(promotion["was_promoted"])
        view.update(
            validated=was_promoted,
            was_promoted=was_promoted,
            is_champion=str(promotion["champion_id"]) == candidate_id,
        )
        return view

    @staticmethod
    def _champion_id(*, conn: Connection, project_id: str) -> str:
        row = conn.execute(
            """
            SELECT target_id AS candidate_id FROM events
            WHERE project_id = ? AND type = 'candidate.promoted'
              AND target_type = 'candidate' ORDER BY id DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        return str(row["candidate_id"]) if row is not None else ""

    @classmethod
    def _candidate_state(
        cls, *, conn: Connection, project_id: str
    ) -> dict[str, Any]:
        rows = conn.execute(
            _CANDIDATE_SELECT
            + " WHERE project_id = ? ORDER BY created_seq DESC",
            (project_id,),
        ).fetchall()
        receipts, promotions = cls._candidate_history(
            conn=conn, project_id=project_id
        )
        candidates = [
            cls._candidate_view(row, receipt=receipts.get(str(row["id"])))
            for row in rows
        ]
        by_id = {str(item["id"]): item for item in candidates}
        champion_id = (
            str(promotions[0]["candidate_id"]) if promotions else ""
        )
        promoted_ids = {str(item["candidate_id"]) for item in promotions}
        for candidate in candidates:
            candidate_id = str(candidate["id"])
            candidate["is_champion"] = candidate_id == champion_id
            candidate["was_promoted"] = candidate_id in promoted_ids
            candidate["validated"] = candidate["was_promoted"]
        return {
            "champion": by_id.get(champion_id),
            "champion_id": champion_id,
            "candidates": candidates,
            "promotions": promotions,
        }

    @staticmethod
    def _candidate_view(
        row: Any, *, receipt: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        validation = json.loads(str(data.get("validation_json") or "{}"))
        workspace = data.get("source_kind") == "experiment_workspace"
        staged = not workspace or receipt is not None
        durable = receipt or (
            {
                "kind": data.get("source_kind"),
                "ref": data.get("source_ref"),
                "manifest_sha256": "",
                "content_sha256": data.get("expected_sha256"),
                "staged_at": data.get("created_at"),
            }
            if not workspace
            else None
        )
        return {
            "id": data.get("id"),
            "name": data.get("name"),
            "source_kind": data.get("source_kind"),
            "source_ref": data.get("source_ref"),
            "source_experiment_id": data.get("source_experiment_id") or "",
            "expected_sha256": data.get("expected_sha256") or "",
            "staged": staged,
            "receipt": durable,
            "metrics": validation.get("metrics", {}),
            "primary_metric": validation.get("primary_metric"),
            "higher_is_better": bool(validation.get("higher_is_better", True)),
            "validation_summary": validation.get("summary", ""),
            "validated": False,
            "was_promoted": False,
            "is_champion": False,
            "created_at": data.get("created_at"),
        }

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
        if not statement.strip():
            raise ValidationError("statement is required")
        if confidence not in CLAIM_CONFIDENCES:
            raise ValidationError(f"unknown claim confidence: {confidence}")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            claim_id = new_id(prefix="claim")
            conn.execute(
                """
                INSERT INTO claims
                  (id, project_id, statement, scope, status, confidence, created_at)
                VALUES (?, ?, ?, ?, 'active', ?, ?)
                """,
                (
                    claim_id,
                    project_id,
                    statement.strip(),
                    scope.strip(),
                    confidence,
                    now_iso(),
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="claim.created",
                target_type="claim",
                target_id=claim_id,
                payload={
                    "statement": statement.strip(),
                    "scope": scope.strip(),
                    "status": "active",
                    "confidence": confidence,
                },
            )
            return dict(
                conn.execute(
                    "SELECT * FROM claims WHERE id = ?", (claim_id,)
                ).fetchone()
            )

    def update_claim(
        self,
        *,
        claim_id: str,
        status: str | None = None,
        confidence: str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        if status is None and confidence is None:
            raise ValidationError("nothing to update: provide status and/or confidence")
        if status is not None and status not in CLAIM_STATUSES:
            raise ValidationError(f"unknown claim status: {status}")
        if confidence is not None and confidence not in CLAIM_CONFIDENCES:
            raise ValidationError(f"unknown claim confidence: {confidence}")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                "SELECT * FROM claims WHERE id = ?", (claim_id,)
            ).fetchone()
            if row is None or row["project_id"] != project_id:
                raise NotFoundError(
                    f"claim not found in project {project_id}: {claim_id}"
                )
            next_status = str(row["status"]) if status is None else status
            next_confidence = (
                str(row["confidence"]) if confidence is None else confidence
            )
            conn.execute(
                """
                UPDATE claims SET status = ?, confidence = ? WHERE id = ?
                """,
                (next_status, next_confidence, claim_id),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="claim.updated",
                target_type="claim",
                target_id=claim_id,
                payload={
                    "statement": row["statement"],
                    "scope": row["scope"],
                    "status": next_status,
                    "confidence": next_confidence,
                },
            )
            updated = conn.execute(
                "SELECT * FROM claims WHERE id = ?", (claim_id,)
            ).fetchone()
            return row_to_dict(row=updated) or {}

    def list_claims(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT * FROM claims
                WHERE project_id = ?
                ORDER BY created_at, id
                """,
                (project_id,),
            ).fetchall()
            return {"claims": rows_to_dicts(rows=rows)}

    # Experiments ----------------------------------------------------------

    def create_experiment(
        self,
        *,
        name: str,
        intent: str,
        tested_claim_ids: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> ExperimentState:
        return cast(
            ExperimentState,
            self._experiments.create(
                name=name,
                intent=intent,
                tested_claim_ids=tested_claim_ids,
                project_id=project_id,
            ),
        )

    def experiment_state(
        self, *, experiment_id: str, project_id: str | None = None
    ) -> ExperimentState:
        return cast(
            ExperimentState,
            self._experiments.get_state(
                experiment_id=experiment_id, project_id=project_id
            ),
        )

    def project_experiments(self, *, project_id: str | None) -> list[ExperimentState]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            evaluated = self._experiments.list_states_with_gates(
                conn=conn, project_id=project_id
            )
            return cast(
                list[ExperimentState],
                [state for state, _gate in evaluated],
            )

    def project_experiment_summaries(
        self, *, project_id: str | None
    ) -> list[ExperimentSummary]:
        return cast(
            list[ExperimentSummary],
            self._experiments.list_experiment_summaries(project_id=project_id),
        )

    def transition_experiment(
        self,
        *,
        experiment_id: str,
        transition: str,
        evidence: dict[str, object] | None = None,
        project_id: str | None = None,
    ) -> CommittedExperimentUpdate:
        return cast(
            CommittedExperimentUpdate,
            self._experiments.transition_with_event(
                experiment_id=experiment_id,
                transition=transition,
                evidence=evidence,
                project_id=project_id,
            ),
        )

    def record_tracking_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run: PersistedRunState,
        delivery_id: int,
    ) -> ExperimentState:
        return cast(
            ExperimentState,
            self._experiments.record_mlflow_run(
                project_id=project_id,
                experiment_id=experiment_id,
                run=run,
                delivery_id=delivery_id,
            ),
        )

    def refresh_tracking_run(
        self,
        *,
        project_id: str,
        experiment_id: str,
        run: PersistedRunState,
    ) -> CommittedExperimentUpdate:
        return cast(
            CommittedExperimentUpdate,
            self._experiments.record_mlflow_run(
                project_id=project_id,
                experiment_id=experiment_id,
                run=run,
                event_type="experiment.mlflow_run_refreshed",
                return_event=True,
            ),
        )

    def record_exhibit_verdict(
        self,
        *,
        experiment_id: str,
        project_id: str,
        verdict: ExhibitVerdict,
    ) -> None:
        self._experiments.record_exhibit_verdict(
            experiment_id=experiment_id,
            project_id=project_id,
            verdict=verdict,
        )

    def attempt_started_running_at(self, *, experiment_id: str) -> str | None:
        return self._experiments.attempt_started_running_at(experiment_id=experiment_id)

    def assert_experiment_in_project(
        self, *, attachment_id: str, project_id: str
    ) -> None:
        self._experiments.assert_in_project(
            experiment_id=attachment_id, project_id=project_id
        )

    # Reflections ----------------------------------------------------------

    def create_reflection(
        self,
        *,
        project_id: str,
        title: str = "",
        lenses: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return self._reflections.create(
            project_id=project_id,
            title=title,
            lenses=lenses or [],
        )

    def reflection_state(
        self,
        *,
        project_id: str,
        reflection_id: str,
        include_content: bool = False,
    ) -> dict[str, Any]:
        return self._reflections.get_state(
            project_id=project_id,
            reflection_id=reflection_id,
            include_content=include_content,
        )

    def list_reflections(self, *, project_id: str) -> dict[str, Any]:
        return self._reflections.list_reflections(project_id=project_id)

    def experiment_consolidations(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[dict[str, Any]]]:
        return self._reflections.experiment_consolidations(
            project_id=project_id,
            experiment_ids=experiment_ids,
        )

    def transition_reflection(
        self,
        *,
        project_id: str,
        reflection_id: str,
        transition: str,
    ) -> dict[str, Any]:
        return self._reflections.transition(
            project_id=project_id,
            reflection_id=reflection_id,
            transition=transition,
        )

    def submit_consolidation(
        self,
        *,
        project_id: str,
        reflection_id: str,
        base_sha: str,
        proposal_sha: str,
        summary: str,
        validation: dict[str, Any] | None,
        decisions: list[dict[str, Any]],
        producer_session_id: str,
    ) -> dict[str, Any]:
        return self._reflections.submit_consolidation(
            project_id=project_id,
            reflection_id=reflection_id,
            base_sha=base_sha,
            proposal_sha=proposal_sha,
            summary=summary,
            validation=validation,
            decisions=decisions,
            producer_session_id=producer_session_id,
        )

    def prepare_reflection_advance(
        self, *, project_id: str, reflection_id: str, runner_id: str
    ) -> dict[str, Any]:
        return self._reflections.prepare_advance(
            project_id=project_id,
            reflection_id=reflection_id,
            runner_id=runner_id,
        )

    def settle_reflection_advance(
        self,
        *,
        project_id: str,
        advance_id: str,
        runner_id: str,
        observed_sha: str,
        proposal_parents: list[str] | None = None,
        diffstat: dict[str, Any] | None = None,
        ancestry: dict[str, bool] | None = None,
        error: str = "",
    ) -> dict[str, Any]:
        return self._reflections.settle_advance(
            project_id=project_id,
            advance_id=advance_id,
            runner_id=runner_id,
            observed_sha=observed_sha,
            proposal_parents=proposal_parents,
            diffstat=diffstat,
            ancestry=ancestry,
            error=error,
        )

    def reflection_overview(self, *, project_id: str) -> dict[str, Any]:
        return self._reflections.overview(project_id=project_id)

    def project_logic_graph_selection(self, *, project_id: str) -> dict[str, Any]:
        return self._reflections.project_logic_graph_selection(project_id=project_id)

    # Reviews --------------------------------------------------------------

    def request_review(
        self,
        *,
        target_type: str,
        target_id: str,
        role: str,
        reason: str = "",
        producer_session_id: str = "main",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        return self._reviews.request(
            target_type=target_type,
            target_id=target_id,
            role=role,
            reason=reason,
            producer_session_id=producer_session_id,
            project_id=project_id,
        )

    def start_review(
        self,
        *,
        review_request_id: str,
        reviewer_capability: str,
        declared_agent: str = "",
        caller_session_id: str = "",
        tenant_id: str | None = None,
        assigned_agent_session_id: str = "",
        assigned_review_request_id: str = "",
    ) -> dict[str, Any]:
        return self._reviews.start(
            review_request_id=review_request_id,
            reviewer_capability=reviewer_capability,
            declared_agent=declared_agent,
            caller_session_id=caller_session_id,
            tenant_id=tenant_id,
            assigned_agent_session_id=assigned_agent_session_id,
            assigned_review_request_id=assigned_review_request_id,
        )

    def submit_review(
        self,
        *,
        review_session_id: str,
        verdict: str,
        synopsis: str,
        notes: str = "",
        findings: list[dict[str, Any]] | None = None,
        evidence: dict[str, Any] | None = None,
        return_to: str = "",
    ) -> dict[str, Any]:
        return self._reviews.submit(
            review_session_id=review_session_id,
            verdict=verdict,
            synopsis=synopsis,
            notes=notes,
            findings=findings,
            evidence=evidence,
            return_to=return_to,
        )

    def review_status(
        self,
        *,
        target_type: str,
        target_id: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        return self._reviews.status(
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
        )

    def latest_submitted_review_event(
        self,
        *,
        target_type: str,
        target_id: str,
        project_id: str | None = None,
    ) -> StoredEvent | None:
        return self._reviews.latest_submitted_event(
            target_type=target_type,
            target_id=target_id,
            project_id=project_id,
        )

    def review_queue(self, *, project_id: str | None = None) -> dict[str, Any]:
        return self._reviews.queue(project_id=project_id)

    def open_experiment_reviews(
        self,
        *,
        project_id: str | None,
        experiment_id: str,
    ) -> list[dict[str, Any]]:
        return self._reviews.open_requests_for_target(
            project_id=project_id, experiment_id=experiment_id
        )

    def review_snapshot(self, *, snapshot_id: str) -> dict[str, Any]:
        return snapshot_from_id(snapshot_id=snapshot_id)

    def review_project_id(
        self,
        *,
        review_request_id: Any = None,
        review_session_id: Any = None,
    ) -> str | None:
        if bool(review_request_id) == bool(review_session_id):
            raise ValueError(
                "provide exactly one of review_request_id or review_session_id"
            )
        if review_request_id:
            return self._reviews.request_project_id(review_request_id=review_request_id)
        return self._reviews.session_project_id(review_session_id=review_session_id)

    def review_target(
        self,
        *,
        review_request_id: Any = None,
        review_session_id: Any = None,
    ) -> tuple[str, str, str] | None:
        return self._reviews.target_for(
            review_request_id=review_request_id,
            review_session_id=review_session_id,
        )

    def review_request_for_session(self, *, review_session_id: Any) -> str | None:
        return self._reviews.request_id_for_session(review_session_id=review_session_id)

    def assert_review_in_project(
        self,
        *,
        project_id: str | None,
        review_request_id: Any = None,
        review_session_id: Any = None,
    ) -> None:
        if bool(review_request_id) == bool(review_session_id):
            raise ValueError(
                "provide exactly one of review_request_id or review_session_id"
            )
        if review_request_id:
            self._reviews.assert_request_in_project(
                project_id=project_id,
                review_request_id=review_request_id,
            )
        else:
            self._reviews.assert_session_in_project(
                project_id=project_id,
                review_session_id=review_session_id,
            )

    # Canonical reads ------------------------------------------------------

    def snapshot(
        self,
        *,
        project_id: str | None = None,
        experiment_id: str | None = None,
    ) -> ResearchSnapshot:
        """Read all project research once; no caller-selected hydration shape."""
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            project = (
                row_to_dict(
                    row=conn.execute(
                        "SELECT * FROM projects WHERE id = ?", (project_id,)
                    ).fetchone()
                )
                or {}
            )
            claims = rows_to_dicts(
                rows=conn.execute(
                    """
                    SELECT id, statement, scope, status, confidence, created_at
                    FROM claims
                    WHERE project_id = ?
                    ORDER BY created_at, id
                    """,
                    (project_id,),
                ).fetchall()
            )
            evaluated = self._experiments.list_states_with_gates(
                conn=conn, project_id=project_id
            )
            experiments = cast(list[ExperimentState], [state for state, _ in evaluated])
            gates = {str(state["id"]): evaluation for state, evaluation in evaluated}
            open_reflection, open_gate = self._reflection(
                conn=conn, project_id=project_id, terminal=False
            )
            published, published_gate = self._reflection(
                conn=conn, project_id=project_id, terminal=True
            )
            for reflection, evaluation in (
                (open_reflection, open_gate),
                (published, published_gate),
            ):
                if reflection is not None and evaluation is not None:
                    gates[str(reflection["id"])] = evaluation
            signal = reflection_signal_state(
                current_terminal={
                    str(row["id"]): str(row["status"])
                    for row in experiments
                    if str(row["status"]) in EXPERIMENT_TERMINAL_STATUSES
                },
                current_claims={
                    str(claim["id"]): str(claim["status"]) for claim in claims
                },
                published=published,
                open_wave=open_reflection,
            )
            recent_claims, claim_events = self._dashboard_facts(
                conn=conn, project_id=project_id, published=published
            )
            return ResearchSnapshot(
                project_id=project_id,
                requested_experiment_id=experiment_id,
                project=project,
                claims=claims,
                experiments=experiments,
                open_reflection=open_reflection,
                latest_published_reflection=published,
                reflection_signal=signal,
                gate_evaluations=gates,
                recent_claims=recent_claims,
                claim_events_since_reflection=claim_events,
                literature_signal=self._literature_signal(
                    conn=conn, project_id=project_id
                ),
            )

    def project_context_facts(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            project = (
                row_to_dict(
                    row=conn.execute(
                        """
                    SELECT id, name, summary FROM projects WHERE id = ?
                    """,
                        (project_id,),
                    ).fetchone()
                )
                or {}
            )
            claims = rows_to_dicts(
                rows=conn.execute(
                    """
                    SELECT id, statement, scope, status, confidence
                    FROM claims
                    WHERE project_id = ?
                    ORDER BY created_at, id
                    """,
                    (project_id,),
                ).fetchall()
            )
            experiments = rows_to_dicts(
                rows=conn.execute(
                    """
                    SELECT id, name, intent, status, attempt_index, conclusion,
                           created_at, updated_at
                    FROM experiments
                    WHERE project_id = ?
                    ORDER BY created_at, id
                    """,
                    (project_id,),
                ).fetchall()
            )
            links = conn.execute(
                """
                SELECT ec.experiment_id, ec.claim_id
                FROM experiment_claims ec
                JOIN experiments e ON e.id = ec.experiment_id
                WHERE e.project_id = ?
                ORDER BY e.created_at, e.id, ec.claim_id
                """,
                (project_id,),
            ).fetchall()
            claims_by_experiment: dict[str, list[str]] = {}
            for link in links:
                claims_by_experiment.setdefault(str(link["experiment_id"]), []).append(
                    str(link["claim_id"])
                )
            for experiment in experiments:
                experiment["tested_claim_ids"] = claims_by_experiment.get(
                    str(experiment["id"]), []
                )
            reflection_terminal = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
            reflection_placeholders = ", ".join("?" for _ in reflection_terminal)
            latest = row_to_dict(
                row=conn.execute(
                    """
                    SELECT id, title, status, attempt_index, published_at,
                           updated_at
                    FROM reflections
                    WHERE project_id = ? AND status = ?
                    ORDER BY published_at DESC, created_seq DESC
                    LIMIT 1
                    """,
                    (project_id, REFLECTION_WORKFLOW.success_status),
                ).fetchone()
            )
            open_wave = row_to_dict(
                row=conn.execute(
                    f"""
                    SELECT id, title, status, attempt_index, updated_at
                    FROM reflections
                    WHERE project_id = ?
                      AND status NOT IN ({reflection_placeholders})
                    ORDER BY created_seq DESC
                    LIMIT 1
                    """,
                    (project_id, *reflection_terminal),
                ).fetchone()
            )
            literature_summary = row_to_dict(
                row=conn.execute(
                    """
                    SELECT id, tldr, body, updated_at
                    FROM litreview_sections
                    WHERE project_id = ? AND kind = 'summary'
                    """,
                    (project_id,),
                ).fetchone()
            )
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM papers WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            candidates = self._candidate_context(conn=conn, project_id=project_id)
        return {
            "project": project,
            "claims": claims,
            "experiments": experiments,
            "latest_published_reflection": latest,
            "open_reflection": open_wave,
            "literature_summary": literature_summary,
            "paper_count": int(count["n"]) if count else 0,
            "candidates": candidates,
        }

    def resolve_graph_refs(
        self, *, project_id: str, refs: tuple[str, ...]
    ) -> dict[str, Any]:
        if not refs:
            return {}
        with closing(self.store.connect()) as conn:
            resolved: dict[str, Any] = {}
            for (
                prefix,
                entity_type,
                id_key,
                table,
                selected_fields,
            ) in _GRAPH_REFS:
                typed_refs = tuple(
                    dict.fromkeys(ref for ref in refs if ref.startswith(prefix))
                )
                if not typed_refs:
                    continue
                fields = ", ".join(("id", *selected_fields))
                by_id: dict[str, Any] = {}
                for start in range(0, len(typed_refs), _GRAPH_REF_BATCH_SIZE):
                    batch = typed_refs[start : start + _GRAPH_REF_BATCH_SIZE]
                    placeholders = ", ".join("?" for _ in batch)
                    rows = conn.execute(
                        f"""
                        SELECT {fields} FROM {table}
                        WHERE project_id = ? AND id IN ({placeholders})
                        """,
                        (project_id, *batch),
                    ).fetchall()
                    by_id.update((str(row["id"]), row) for row in rows)
                for ref in typed_refs:
                    row = by_id.get(ref)
                    if row is None:
                        resolved[ref] = {
                            "type": "unknown",
                            "resolved": False,
                        }
                        continue
                    record = {
                        "type": entity_type,
                        "resolved": True,
                        id_key: row["id"],
                    }
                    record.update({field: row[field] for field in selected_fields})
                    resolved[ref] = record
            return {ref: resolved[ref] for ref in refs if ref in resolved}

    # Event ledger reads ---------------------------------------------------

    def tenant_event_count(self, *, tenant_id: str) -> int:
        return self.store.tenant_event_count(tenant_id=tenant_id)

    def project_event_signal(self, *, project_id: str) -> str:
        return self.store.project_event_signal(project_id=project_id)

    def recent_events(self, *, project_id: str, limit: int) -> dict[str, Any]:
        return self.store.recent_events(project_id=project_id, limit=limit)

    def events_since(self, *, project_id: str, after_id: int) -> dict[str, Any]:
        return self.store.events_since(project_id=project_id, after_id=after_id)

    # Read helpers ---------------------------------------------------------

    def _reflection(
        self, *, conn: Any, project_id: str, terminal: bool
    ) -> tuple[dict[str, Any] | None, GateEvaluation | None]:
        terminal_statuses = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
        placeholders = ", ".join("?" for _ in terminal_statuses)
        predicate = "status = ?" if terminal else f"status NOT IN ({placeholders})"
        parameters = (
            (project_id, REFLECTION_WORKFLOW.success_status)
            if terminal
            else (project_id, *terminal_statuses)
        )
        order = (
            "published_at DESC, created_seq DESC" if terminal else "created_seq DESC"
        )
        row = conn.execute(
            f"""
            SELECT id FROM reflections
            WHERE project_id = ? AND {predicate}
            ORDER BY {order}
            LIMIT 1
            """,
            parameters,
        ).fetchone()
        if row is None:
            return None, None
        return self._reflections.get_state_with_gate(reflection_id=row["id"], conn=conn)

    def _literature_signal(self, *, conn: Any, project_id: str) -> LiteratureSignal:
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM papers WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        unreviewed = conn.execute(
            """
            SELECT COUNT(*) AS n FROM papers p
            WHERE p.project_id = ?
              AND EXISTS (
                SELECT 1 FROM paper_links l
                WHERE l.paper_id = p.id
                  AND l.target_type IN ('experiment', 'claim')
              )
              AND NOT EXISTS (
                SELECT 1 FROM paper_links l
                WHERE l.paper_id = p.id
                  AND l.target_type = 'litreview_section'
              )
            """,
            (project_id,),
        ).fetchone()
        return LiteratureSignal(
            papers_total=int(total["n"]),
            papers_unreviewed=int(unreviewed["n"]),
        )

    def _dashboard_facts(
        self,
        *,
        conn: Any,
        project_id: str,
        published: dict[str, Any] | None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        recent = rows_to_dicts(
            rows=conn.execute(
                """
                SELECT c.id, c.statement, c.status, c.confidence
                FROM claims c
                LEFT JOIN events e
                  ON e.project_id = c.project_id
                 AND e.target_type = 'claim'
                 AND e.target_id = c.id
                 AND e.type IN ('claim.created', 'claim.updated')
                WHERE c.project_id = ?
                GROUP BY c.id
                ORDER BY COALESCE(MAX(e.created_at), c.created_at) DESC,
                         c.created_at DESC
                LIMIT 5
                """,
                (project_id,),
            ).fetchall()
        )
        if published is None:
            return recent, []
        event = conn.execute(
            """
            SELECT id FROM events
            WHERE project_id = ?
              AND type = ?
              AND target_type = 'reflection'
              AND target_id = ?
            ORDER BY id DESC LIMIT 1
            """,
            (
                project_id,
                REFLECTION_WORKFLOW.event_type,
                published.get("id"),
            ),
        ).fetchone()
        if event is not None:
            where, marker = "id > ?", event["id"]
        elif published.get("published_at"):
            where, marker = "created_at >= ?", published["published_at"]
        else:
            return recent, []
        events = rows_to_dicts(
            rows=conn.execute(
                """
                SELECT id, type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ?
                  AND target_type = 'claim'
                  AND type IN ('claim.created', 'claim.updated')
                """
                f" AND {where} ORDER BY id",
                (project_id, marker),
            ).fetchall()
        )
        return recent, events

    @staticmethod
    def _validate_project_name(name: str) -> str:
        name = (name or "").strip()
        if not name:
            raise ValidationError("name is required")
        if len(name) < MIN_PROJECT_NAME_LEN:
            raise ValidationError(
                f"name must be at least {MIN_PROJECT_NAME_LEN} characters"
            )
        return name

    @staticmethod
    def _project_view(row: Any) -> dict[str, Any]:
        data = row_to_dict(row=row) or {}
        view = {
            key: data[key]
            for key in ("id", "name", "summary", "status", "created_at")
            if key in data
        }
        view["settings"] = parse_project_settings(data.get("settings_json"))
        return view


__all__ = ["Research"]
