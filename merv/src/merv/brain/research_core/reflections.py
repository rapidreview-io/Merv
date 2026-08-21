# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Project reflection wave state service.

A reflection wave is the project-level counterpart of an experiment: a gated
record whose artifacts are the living project logic graph (role
'project_graph'), a concise reflection document (role 'reflection_doc'), and
the reviewed change spec (role 'change_spec'), produced by reconciling a
roster of differentiated per-lens reflections (role 'reflection_lens_doc').
Gates check envelopes only; the story's honesty and the belief-state update
are the reflection reviewer's call, and what the graph says is the agent's
design.
"""

from __future__ import annotations

from contextlib import closing, suppress
from datetime import UTC, datetime, timedelta
import json
from typing import Any

from merv.shared.artifact_roles import (
    PROJECT_GRAPH_ROLE,
    REFLECTION_LENS_DOC_ROLE,
    TASK_BRIEF_ROLE,
    TASK_DELIVERY_ROLE,
)

from .evidence import (
    ArtifactDocument,
    artifact_state_record,
    artifact_submission_recency_key,
    claim_refs,
    depends_on_refs,
    current_slot_artifacts,
    current_reflection_requirement_artifact,
    graph_diff,
    graph_diff_summary,
    graph_problems,
    parse_change_spec,
    preferred_artifact,
    reflection_coverage_for,
    reflection_doc_review_problems,
    reflection_lens_doc_problems,
    require_artifact_document,
    validate_reflection_roster,
)
from .dependencies import record_dependencies
from .experiments import ExperimentService
from .experiment_workflow import EXPERIMENT_TERMINAL_STATUSES
from .reflection_workflow import REFLECTION_WORKFLOW
from .tasks import TaskService
from .task_workflow import TASK_TERMINAL_STATUSES
from ..artifacts import MAX_SUBMITTED_TEXT_BYTES, ArtifactTarget, Artifacts
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    GateEvaluation,
    GateItem,
    RequirementEvaluation,
    active_experiment_cap_would_exceed_message,
    covered_terminal_ids,
    evaluate_artifact_requirement,
    evaluate_review_gate,
    reflection_signal_state,
    snapshot_from_id,
)
from .workflow_schema import ArtifactNeed, RecordNeed, ReviewReturn
from ..kernel.state.store import (
    BaseStateStore,
    next_created_seq,
    row_to_dict,
    rows_to_dicts,
)
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    WorkflowError,
    new_id,
    now_iso,
    parse_iso,
)

ADVANCE_OWNER_LEASE_SECONDS = 10 * 60


class ReflectionService:
    def __init__(
        self,
        *,
        store: BaseStateStore,
        artifacts: Artifacts,
        experiments: ExperimentService,
        tasks: TaskService | None = None,
    ) -> None:
        self.store = store
        self.artifacts = artifacts
        self.experiments = experiments
        self.tasks = (
            tasks if tasks is not None else TaskService(store=store, artifacts=artifacts)
        )

    # ---- create ----

    def create(
        self,
        *,
        title: str = "",
        lenses: list[dict[str, Any]] | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        roster = validate_reflection_roster(lenses=lenses or [])
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            terminal = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
            placeholders = ", ".join("?" for _ in terminal)
            open_row = conn.execute(
                f"""
                SELECT id, status FROM reflections
                WHERE project_id = ? AND status NOT IN ({placeholders})
                ORDER BY created_seq DESC LIMIT 1
                """,
                (project_id, *terminal),
            ).fetchone()
            if open_row is not None:
                raise WorkflowError(
                    f"a reflection wave is already open: {open_row['id']} is "
                    f"{open_row['status']!r}. Finish or abandon it before "
                    "starting a new one — the project graph is one living "
                    "artifact and only one wave may edit it at a time"
                )
            reflection_id = new_id(prefix="syn")
            now = now_iso()
            corpus = self._corpus_snapshot(conn=conn, project_id=project_id)
            conn.execute(
                """
                INSERT INTO reflections
                  (id, project_id, title, status, attempt_index, revision_context,
                   roster_json, corpus_json, created_at, updated_at, created_seq)
                VALUES (?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)
                """,
                (
                    reflection_id,
                    project_id,
                    title.strip(),
                    REFLECTION_WORKFLOW.initial,
                    json.dumps(roster, sort_keys=True),
                    json.dumps(corpus, sort_keys=True),
                    now,
                    now,
                    next_created_seq(conn=conn, table="reflections"),
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="reflection.created",
                target_type="reflection",
                target_id=reflection_id,
                payload={
                    "title": title.strip(),
                    "lenses": [lens["id"] for lens in roster],
                    "corpus_terminal_experiments": len(corpus["terminal_experiments"]),
                },
            )
            return self.get_state(
                reflection_id=reflection_id,
                conn=conn,
                include_content=True,
            )

    def _corpus_snapshot(self, *, conn, project_id: str) -> dict[str, Any]:
        terminal = ", ".join(f"'{s}'" for s in sorted(EXPERIMENT_TERMINAL_STATUSES))
        exp_rows = conn.execute(
            f"""
            SELECT id, name, attempt_index, status FROM experiments
            WHERE project_id = ? AND status IN ({terminal})
            ORDER BY created_at, id
            """,
            (project_id,),
        ).fetchall()
        claim_rows = conn.execute(
            "SELECT id, statement, status, confidence, scope FROM claims"
            " WHERE project_id = ? ORDER BY created_at, id",
            (project_id,),
        ).fetchall()
        experiments = rows_to_dicts(rows=exp_rows)
        experiment_history = self.artifacts.history(
            tx=conn,
            target_type="experiment",
            target_ids=tuple(str(experiment["id"]) for experiment in experiments),
        )
        for experiment in experiments:
            authoritative: dict[str, dict[str, Any]] = {}
            for evidence in experiment_history[str(experiment["id"])].artifacts:
                if evidence.attempt_index != int(
                    experiment["attempt_index"]
                ) or evidence.role not in {"report", "graph"}:
                    continue
                artifact = artifact_state_record(evidence)
                current = authoritative.get(evidence.role)
                if current is None or artifact_submission_recency_key(
                    artifact
                ) > artifact_submission_recency_key(current):
                    authoritative[evidence.role] = artifact
            experiment["artifacts"] = [
                self._artifact_content_ref(artifact=authoritative[role])
                for role in ("report", "graph")
                if role in authoritative
            ]
        task_terminal = ", ".join(f"'{s}'" for s in sorted(TASK_TERMINAL_STATUSES))
        task_rows = conn.execute(
            f"""
            SELECT id, name, goal, attempt_index, status, outcome, failed_by
            FROM tasks
            WHERE project_id = ? AND status IN ({task_terminal})
            ORDER BY created_at, id
            """,
            (project_id,),
        ).fetchall()
        tasks = rows_to_dicts(rows=task_rows)
        task_history = self.artifacts.history(
            tx=conn,
            target_type="task",
            target_ids=tuple(str(task["id"]) for task in tasks),
        )
        for task in tasks:
            authoritative_task: dict[str, dict[str, Any]] = {}
            for evidence in task_history[str(task["id"])].artifacts:
                if evidence.attempt_index != int(task["attempt_index"]) or (
                    evidence.role not in {TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE}
                ):
                    continue
                artifact = artifact_state_record(evidence)
                current = authoritative_task.get(evidence.role)
                if current is None or artifact_submission_recency_key(
                    artifact
                ) > artifact_submission_recency_key(current):
                    authoritative_task[evidence.role] = artifact
            task["artifacts"] = [
                self._artifact_content_ref(artifact=authoritative_task[role])
                for role in (TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE)
                if role in authoritative_task
            ]
        previous = self.latest_published(conn=conn, project_id=project_id)
        covered = covered_terminal_ids(
            None if previous is None else (previous.get("corpus") or {})
        )
        covered_tasks = covered_terminal_ids(
            None if previous is None else (previous.get("corpus") or {}),
            key="terminal_tasks",
        )
        previous_artifacts: dict[str, dict[str, Any]] = {}
        if previous is not None:
            graph = self._project_graph_artifact(reflection=previous)
            reflection_doc = preferred_artifact(
                artifacts=previous.get("current_attempt_artifacts") or [],
                roles=("reflection_doc",),
            )
            for role, artifact in (
                (PROJECT_GRAPH_ROLE, graph),
                ("reflection_doc", reflection_doc),
            ):
                if artifact is not None:
                    previous_artifacts[role] = self._artifact_content_ref(
                        artifact=artifact
                    )
        # The wave's new signal: terminal experiments the last published wave
        # never saw. The reflection still reads the whole project; these name
        # why it is happening now. Prior artifacts are pinned by id in the
        # snapshot and their immutable bytes are hydrated only on focused reads.
        return {
            "captured_at": now_iso(),
            "terminal_experiments": experiments,
            "terminal_tasks": tasks,
            "claims": rows_to_dicts(rows=claim_rows),
            "new_terminal_experiments": [
                {"id": exp["id"], "name": exp["name"], "status": exp["status"]}
                for exp in experiments
                if str(exp["id"]) not in covered
            ],
            "new_terminal_tasks": [
                {"id": task["id"], "name": task["name"], "status": task["status"]}
                for task in tasks
                if str(task["id"]) not in covered_tasks
            ],
            "previous_published_reflection_id": (
                None if previous is None else previous["id"]
            ),
            "previous_lens_reflections": (
                {}
                if previous is None
                else {
                    str(lens["lens_id"]): {
                        "artifact_id": lens["artifact_id"],
                        "path": lens["path"],
                        "role": lens["role"],
                        "submitted_order": lens["submitted_order"],
                    }
                    for lens in previous["reflection_coverage"]["lenses"]
                    if lens.get("covered")
                }
            ),
            "previous_published_artifacts": previous_artifacts,
        }

    # ---- read ----

    def get_state(
        self,
        *,
        reflection_id: str,
        project_id: str | None = None,
        conn=None,
        include_content: bool = False,
    ) -> dict[str, Any]:
        return self.get_state_with_gate(
            reflection_id=reflection_id,
            project_id=project_id,
            conn=conn,
            include_content=include_content,
        )[0]

    def get_state_with_gate(
        self,
        *,
        reflection_id: str,
        project_id: str | None = None,
        conn=None,
        include_content: bool = False,
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
                "SELECT * FROM reflections WHERE id = ?", (reflection_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"reflection not found: {reflection_id}")
            data = row_to_dict(row=row) or {}
            if project_id is not None and data["project_id"] != project_id:
                raise NotFoundError(
                    f"reflection not found in project {project_id}: {reflection_id}"
                )
            data["roster"] = json.loads(str(data.pop("roster_json", "[]")))
            data["corpus"] = json.loads(str(data.pop("corpus_json", "{}")))
            history = self.artifacts.history(
                tx=conn,
                target_type="reflection",
                target_ids=(reflection_id,),
                summarize=True,
            )[reflection_id]
            data["artifacts"] = [
                artifact_state_record(evidence) for evidence in history.artifacts
            ]
            # Newest row per slot — the reflection wave seals on its forward
            # transitions too, so superseded lens docs stay alive as history.
            data["current_attempt_artifacts"] = current_slot_artifacts(
                data["artifacts"], attempt=data["attempt_index"]
            )
            if include_content:
                content = self._artifact_content(
                    corpus=data["corpus"],
                    current=data["current_attempt_artifacts"],
                )
                data["corpus"] = self._hydrate_corpus_content(
                    conn=conn,
                    corpus=data["corpus"],
                    content=content,
                )
                data["current_attempt_artifacts"] = (
                    self._hydrate_current_attempt_artifacts(
                        artifacts=data["current_attempt_artifacts"],
                        content=content,
                    )
                )
            claim_rows = conn.execute(
                """
                SELECT sc.reflection_id, sc.claim_id, sc.op, sc.claim_key,
                       sc.created_at, c.statement, c.status, c.confidence
                FROM reflection_claim_changes sc
                JOIN claims c ON c.id = sc.claim_id
                WHERE sc.reflection_id = ?
                ORDER BY sc.created_at, sc.claim_id
                """,
                (reflection_id,),
            ).fetchall()
            data["materialized_claims"] = rows_to_dicts(rows=claim_rows)
            experiment_rows = conn.execute(
                """
                SELECT se.reflection_id, se.experiment_id, se.proposal_key,
                       se.created_at, e.name, e.intent, e.status
                FROM reflection_experiments se
                JOIN experiments e ON e.id = se.experiment_id
                WHERE se.reflection_id = ?
                ORDER BY se.created_at, se.experiment_id
                """,
                (reflection_id,),
            ).fetchall()
            data["materialized_experiments"] = rows_to_dicts(rows=experiment_rows)
            task_rows = conn.execute(
                """
                SELECT st.reflection_id, st.task_id, st.proposal_key,
                       st.created_at, t.name, t.goal, t.status
                FROM reflection_tasks st
                JOIN tasks t ON t.id = st.task_id
                WHERE st.reflection_id = ?
                ORDER BY st.created_at, st.task_id
                """,
                (reflection_id,),
            ).fetchall()
            data["materialized_tasks"] = rows_to_dicts(rows=task_rows)
            review_rows = conn.execute(
                """
                SELECT * FROM reviews
                WHERE target_type = 'reflection' AND target_id = ?
                ORDER BY created_seq DESC
                """,
                (reflection_id,),
            ).fetchall()
            reviews = rows_to_dicts(rows=review_rows)
            for review in reviews:
                review["findings"] = json.loads(review.pop("findings_json", "[]"))
                review["evidence"] = json.loads(review.pop("evidence_json", "{}"))
            data["reviews"] = reviews
            data["consolidation"] = self._consolidation_state(
                conn=conn,
                reflection=data,
            )
            proposal = data["consolidation"].get("proposal") or {}
            if proposal:
                data["snapshot_token"] = str(proposal.get("id") or "")
                data["code_sha"] = str(proposal.get("proposal_sha") or "")
            data["reflection_coverage"] = reflection_coverage_for(reflection=data)
            data["project_graph_diff"] = self._project_graph_diff(
                conn=conn, reflection=data
            )
            evaluation = self._evaluate_gate(conn=conn, reflection=data)
            data["gate_checklist"] = evaluation.checklist()
            data["allowed_transitions"] = [
                dict(item) for item in evaluation.legal_transitions
            ]
            return data, evaluation
        finally:
            if owns_conn:
                conn.close()

    def _consolidation_state(
        self, *, conn, reflection: dict[str, Any]
    ) -> dict[str, Any]:
        proposal_row = conn.execute(
            """
            SELECT * FROM consolidation_proposals
            WHERE reflection_id = ?
            ORDER BY revision DESC
            LIMIT 1
            """,
            (reflection["id"],),
        ).fetchone()
        proposal = row_to_dict(row=proposal_row)
        corpus = reflection.get("corpus") or {}
        experiments = [
            item
            for item in corpus.get("terminal_experiments") or []
            if isinstance(item, dict) and item.get("id")
        ]
        decisions_by_id: dict[str, dict[str, Any]] = {}
        if proposal is not None:
            proposal["validation"] = json.loads(
                str(proposal.pop("validation_json", "{}"))
            )
            decision_rows = conn.execute(
                """
                SELECT * FROM consolidation_decisions
                WHERE proposal_id = ?
                ORDER BY experiment_id
                """,
                (proposal["id"],),
            ).fetchall()
            for decision in rows_to_dicts(rows=decision_rows):
                decisions_by_id[str(decision["experiment_id"])] = decision
        decisions = []
        for experiment in experiments:
            experiment_id = str(experiment["id"])
            decision = decisions_by_id.get(experiment_id)
            decisions.append(
                {
                    "experiment_id": experiment_id,
                    "experiment_name": str(experiment.get("name") or ""),
                    **(
                        {
                            "disposition": "pending",
                            "rationale": "",
                            "source_sha": "",
                            "integration_kind": "none",
                            "superseded_by": "",
                        }
                        if decision is None
                        else decision
                    ),
                }
            )
        current_review = None
        if proposal is not None:
            for review in reflection.get("reviews", []):
                if review.get("role") != "consolidation_reviewer":
                    continue
                snapshot = snapshot_from_id(
                    snapshot_id=str(review.get("target_snapshot_id") or "")
                )
                if (
                    snapshot.get("snapshot_token") == proposal["id"]
                    and snapshot.get("code_sha") == proposal["proposal_sha"]
                ):
                    current_review = {
                        key: review.get(key)
                        for key in ("id", "role", "verdict", "created_at", "synopsis")
                    }
                    break
        advance = None
        if proposal is not None:
            advance = row_to_dict(
                row=conn.execute(
                    """
                    SELECT * FROM reflection_advances
                    WHERE proposal_id = ?
                    ORDER BY intended_at DESC
                    LIMIT 1
                    """,
                    (proposal["id"],),
                ).fetchone()
            )
            if advance is not None:
                advance["proposal_parents"] = json.loads(
                    str(advance.pop("proposal_parents_json", "[]"))
                )
                advance["diffstat"] = json.loads(
                    str(advance.pop("diffstat_json", "{}"))
                )
                advance["ancestry"] = json.loads(
                    str(advance.pop("ancestry_json", "{}"))
                )
        ancestry = (advance or {}).get("ancestry") or {}
        for decision in decisions:
            disposition = str(decision.get("disposition") or "")
            verified = bool(ancestry.get(str(decision["experiment_id"]), False))
            decision["ancestry_verified"] = verified
            merged = verified and decision.get("integration_kind") in {
                "merge",
                "fast_forward",
            }
            decision["integration_outcome"] = (
                "not_applied"
                if disposition in {"pending", "reviewed_not_used", "superseded"}
                else "merged" if merged else "applied"
            )
        considered = sum(
            decision.get("disposition") != "pending" for decision in decisions
        )
        return {
            "proposal": proposal,
            "decisions": decisions,
            "coverage": {
                "total": len(decisions),
                "considered": considered,
                "pending": len(decisions) - considered,
                "complete": considered == len(decisions),
            },
            "review": current_review,
            "advance": advance,
        }

    @staticmethod
    def _artifact_content_ref(*, artifact: dict[str, Any]) -> dict[str, Any]:
        return {
            "artifact_id": artifact.get("id"),
            "path": artifact.get("path"),
            "role": artifact.get("role"),
            "submitted_order": artifact.get("submitted_order"),
        }

    def _hydrate_artifact_content(
        self,
        *,
        artifact: dict[str, Any],
        content: dict[str, bytes | None],
    ) -> dict[str, Any]:
        artifact_id = str(artifact.get("artifact_id") or artifact.get("id") or "")
        data = content.get(artifact_id)
        text = None
        truncated = False
        if data is not None:
            truncated = len(data) > MAX_SUBMITTED_TEXT_BYTES
            text = data[:MAX_SUBMITTED_TEXT_BYTES].decode("utf-8", errors="replace")
            encoded = text.encode("utf-8")
            if len(encoded) > MAX_SUBMITTED_TEXT_BYTES:
                text = encoded[:MAX_SUBMITTED_TEXT_BYTES].decode(
                    "utf-8", errors="ignore"
                )
        return {
            **{key: value for key, value in artifact.items() if key != "tldr"},
            "content": text,
            "content_available": text is not None,
            "content_truncated": truncated,
        }

    def _hydrate_current_attempt_artifacts(
        self,
        *,
        artifacts: list[dict[str, Any]],
        content: dict[str, bytes | None],
    ) -> list[dict[str, Any]]:
        latest_lens_docs: dict[str, dict[str, Any]] = {}
        for artifact in artifacts:
            if artifact.get("role") != REFLECTION_LENS_DOC_ROLE:
                continue
            lens_id = str(artifact.get("lens_id") or "")
            current = latest_lens_docs.get(lens_id)
            if current is None or artifact_submission_recency_key(
                artifact
            ) > artifact_submission_recency_key(current):
                latest_lens_docs[lens_id] = artifact

        authoritative_lens_ids = {
            str(artifact.get("id") or "") for artifact in latest_lens_docs.values()
        }
        hydrated: list[dict[str, Any]] = []
        for artifact in artifacts:
            role = artifact.get("role")
            if (
                role == REFLECTION_LENS_DOC_ROLE
                and str(artifact.get("id") or "") not in authoritative_lens_ids
            ):
                continue
            hydrated.append(
                self._hydrate_artifact_content(artifact=artifact, content=content)
                if role
                in {
                    REFLECTION_LENS_DOC_ROLE,
                    PROJECT_GRAPH_ROLE,
                    "reflection_doc",
                    "change_spec",
                }
                else artifact
            )
        return hydrated

    def _hydrate_corpus_content(
        self,
        *,
        conn,
        corpus: dict[str, Any],
        content: dict[str, bytes | None],
    ) -> dict[str, Any]:
        hydrated = dict(corpus)
        hydrated["claims"] = self._backfill_claim_fields(
            conn=conn, claims=corpus.get("claims") or []
        )
        previous_lenses: dict[str, dict[str, Any]] = {}
        for lens_id, raw in (corpus.get("previous_lens_reflections") or {}).items():
            reference = (
                dict(raw)
                if isinstance(raw, dict)
                else {
                    "artifact_id": None,
                    "path": str(raw),
                    "role": REFLECTION_LENS_DOC_ROLE,
                }
            )
            previous_lenses[str(lens_id)] = self._hydrate_artifact_content(
                artifact=reference, content=content
            )
        hydrated["previous_lens_reflections"] = previous_lenses
        hydrated["previous_published_artifacts"] = {
            str(role): self._hydrate_artifact_content(
                artifact=dict(reference), content=content
            )
            for role, reference in (
                corpus.get("previous_published_artifacts") or {}
            ).items()
            if isinstance(reference, dict)
        }
        hydrated["terminal_experiments"] = [
            {
                **experiment,
                "artifacts": [
                    self._hydrate_artifact_content(
                        artifact=dict(reference), content=content
                    )
                    for reference in experiment.get("artifacts") or []
                    if isinstance(reference, dict)
                ],
            }
            for experiment in corpus.get("terminal_experiments") or []
            if isinstance(experiment, dict)
        ]
        hydrated["terminal_tasks"] = [
            {
                **task,
                "artifacts": [
                    self._hydrate_artifact_content(
                        artifact=dict(reference), content=content
                    )
                    for reference in task.get("artifacts") or []
                    if isinstance(reference, dict)
                ],
            }
            for task in corpus.get("terminal_tasks") or []
            if isinstance(task, dict)
        ]
        return hydrated

    def _artifact_content(
        self,
        *,
        corpus: dict[str, Any],
        current: list[dict[str, Any]],
    ) -> dict[str, bytes | None]:
        references: list[dict[str, Any]] = list(current)
        references.extend(
            reference
            for reference in (corpus.get("previous_lens_reflections") or {}).values()
            if isinstance(reference, dict)
        )
        references.extend(
            reference
            for reference in (corpus.get("previous_published_artifacts") or {}).values()
            if isinstance(reference, dict)
        )
        for node in (
            *(corpus.get("terminal_experiments") or []),
            *(corpus.get("terminal_tasks") or []),
        ):
            if isinstance(node, dict):
                references.extend(
                    reference
                    for reference in node.get("artifacts") or []
                    if isinstance(reference, dict)
                )
        artifact_ids = tuple(
            dict.fromkeys(
                str(reference.get("artifact_id") or reference.get("id") or "")
                for reference in references
                if reference.get("artifact_id") or reference.get("id")
            )
        )
        return {
            artifact.id: artifact.data
            for artifact in self.artifacts.get(
                artifact_ids=artifact_ids,
                include="content",
            )
        }

    def _backfill_claim_fields(
        self, *, conn, claims: list[Any]
    ) -> list[dict[str, Any]]:
        """Snapshots taken before claims carried text get it joined in live.

        The claim SET stays pinned by the snapshot; a claim deleted since
        keeps its snapshotted id and status.
        """
        rows = [dict(claim) for claim in claims if isinstance(claim, dict)]
        missing = tuple(
            str(row.get("id") or "") for row in rows if "statement" not in row
        )
        if not missing:
            return rows
        placeholders = ", ".join("?" for _ in missing)
        live = {
            str(record["id"]): record
            for record in rows_to_dicts(
                rows=conn.execute(
                    "SELECT id, statement, confidence, scope FROM claims"
                    f" WHERE id IN ({placeholders})",
                    missing,
                ).fetchall()
            )
        }
        return [{**live.get(str(row.get("id") or ""), {}), **row} for row in rows]

    def list_reflections(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                "SELECT id FROM reflections WHERE project_id = ? ORDER BY created_at, id",
                (project_id,),
            ).fetchall()
            return {
                "reflections": [
                    self.get_state(reflection_id=row["id"], conn=conn) for row in rows
                ]
            }

    def experiment_consolidations(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[dict[str, Any]]]:
        ids = tuple(dict.fromkeys(value for value in experiment_ids if value))
        result = {experiment_id: [] for experiment_id in ids}
        if not ids:
            return result
        placeholders = ", ".join("?" for _ in ids)
        with closing(self.store.connect()) as conn:
            self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                f"""
                SELECT d.*, p.reflection_id, p.revision, p.base_sha,
                       p.proposal_sha, p.summary, p.created_at,
                       a.status AS advance_status,
                       a.observed_sha AS central_sha,
                       a.ancestry_json,
                       a.bound_at
                FROM consolidation_decisions d
                JOIN consolidation_proposals p ON p.id = d.proposal_id
                LEFT JOIN reflection_advances a ON a.proposal_id = p.id
                WHERE p.project_id = ?
                  AND d.experiment_id IN ({placeholders})
                ORDER BY p.created_at, p.revision
                """,
                (project_id, *ids),
            ).fetchall()
            for row in rows:
                item = row_to_dict(row=row) or {}
                ancestry = json.loads(str(item.pop("ancestry_json", "{}") or "{}"))
                verified = bool(ancestry.get(str(item["experiment_id"]), False))
                item["ancestry_verified"] = verified
                merged = verified and item.get("integration_kind") in {
                    "merge",
                    "fast_forward",
                }
                item["integration_outcome"] = (
                    "not_applied"
                    if item["disposition"] in {"reviewed_not_used", "superseded"}
                    else "merged" if merged else "applied"
                )
                result[str(item["experiment_id"])].append(item)
        return result

    def overview(self, *, project_id: str | None = None) -> dict[str, Any]:
        """All waves plus the current reflection signal for project UI views."""
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                "SELECT id FROM reflections WHERE project_id = ? ORDER BY created_at, id",
                (project_id,),
            ).fetchall()
            reflections = [
                self.get_state(reflection_id=row["id"], conn=conn) for row in rows
            ]
            signal = self.reflection_signal(project_id=project_id, conn=conn)
            open_wave = self.open_reflection(conn=conn, project_id=project_id)
            published = self.latest_published(conn=conn, project_id=project_id)
            return {
                "reflections": reflections,
                "current": open_wave or published,
                "open_reflection": open_wave,
                "latest_published": published,
                "signal": signal,
            }

    def project_logic_graph_selection(self, *, project_id: str) -> dict[str, Any]:
        """Select the current project graph wave and reflection signal.

        The UI prefers the open wave's graph while the wave is open,
        falling back to the latest published graph when the open wave has not
        submitted one yet. Research owns this selection; Surface owns its wire
        presentation.
        """
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            signal = self.reflection_signal(project_id=project_id, conn=conn)
            reflection = self.open_reflection(conn=conn, project_id=project_id)
            graph_artifact = self._project_graph_artifact(reflection=reflection)
            if reflection is None or graph_artifact is None:
                published = self.latest_published(conn=conn, project_id=project_id)
                published_graph = self._project_graph_artifact(reflection=published)
                if published is not None and published_graph is not None:
                    reflection = published
                    graph_artifact = published_graph
            return {
                "signal": signal,
                "reflection": reflection,
                "graph_artifact": graph_artifact,
            }

    def open_reflection(self, *, conn, project_id: str) -> dict[str, Any] | None:
        """The one non-terminal wave for the project, fully hydrated, or None."""
        terminal = tuple(sorted(REFLECTION_WORKFLOW.terminal_statuses))
        placeholders = ", ".join("?" for _ in terminal)
        row = conn.execute(
            f"""
            SELECT id FROM reflections
            WHERE project_id = ? AND status NOT IN ({placeholders})
            ORDER BY created_seq DESC LIMIT 1
            """,
            (project_id, *terminal),
        ).fetchone()
        if row is None:
            return None
        return self.get_state(reflection_id=row["id"], conn=conn)

    def latest_published(self, *, conn, project_id: str) -> dict[str, Any] | None:
        row = conn.execute(
            """
            SELECT id FROM reflections
            WHERE project_id = ? AND status = ?
            ORDER BY published_at DESC, created_seq DESC LIMIT 1
            """,
            (project_id, REFLECTION_WORKFLOW.success_status),
        ).fetchone()
        if row is None:
            return None
        return self.get_state(reflection_id=row["id"], conn=conn)

    @staticmethod
    def _project_graph_artifact(
        *, reflection: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """This wave's graph, or None — the current attempt only.

        A rejection back to reflecting bumps the attempt, so the graph the
        reviewer rejected belongs to the previous one and cannot appear as
        current."""
        if reflection is None:
            return None
        return preferred_artifact(
            artifacts=reflection.get("current_attempt_artifacts") or [],
            roles=(PROJECT_GRAPH_ROLE,),
        )

    def _project_graph_diff(
        self, *, conn, reflection: dict[str, Any]
    ) -> dict[str, Any]:
        current_artifact = self._project_graph_artifact(reflection=reflection)
        # published_graph_version_id holds the artifact id pinned at publish.
        current_artifact_id = str(
            (
                reflection.get("published_graph_version_id")
                if reflection.get("status") == REFLECTION_WORKFLOW.success_status
                else None
            )
            or (current_artifact or {}).get("id")
            or ""
        )
        base = self._previous_published_graph_ref(conn=conn, reflection=reflection)
        result: dict[str, Any] = {
            "available": False,
            "reason": "",
            "summary": "",
            "base_reflection_id": base.get("reflection_id") if base else None,
            "base_graph_version_id": base.get("graph_version_id") if base else None,
            "current_reflection_id": reflection.get("id"),
            "current_graph_version_id": current_artifact_id or None,
            "problems": [],
        }
        if not current_artifact_id:
            result.update(
                {
                    "reason": "no_current_project_graph",
                    "summary": "No current project graph is associated for this reflection wave.",
                }
            )
            return result
        if base is None or not base.get("graph_version_id"):
            result.update(
                {
                    "reason": "no_previous_project_graph",
                    "summary": "No previous published project graph is available to compare.",
                }
            )
            return result

        base_graph, base_problems = self._load_graph_for_diff(
            artifact_id=str(base["graph_version_id"]),
            what="previous project logic graph",
        )
        current_graph, current_problems = self._load_graph_for_diff(
            artifact_id=current_artifact_id,
            what="current project logic graph",
        )
        problems = [*base_problems, *current_problems]
        if problems or base_graph is None or current_graph is None:
            result.update(
                {
                    "reason": "graph_unavailable",
                    "summary": "Project graph diff is unavailable because one graph cannot be read.",
                    "problems": problems,
                }
            )
            return result

        diff = graph_diff(base_graph=base_graph, current_graph=current_graph)
        result.update(diff)
        result["available"] = True
        result["reason"] = ""
        result["summary"] = graph_diff_summary(diff=diff)
        return result

    def _previous_published_graph_ref(
        self, *, conn, reflection: dict[str, Any]
    ) -> dict[str, Any] | None:
        project_id = str(reflection.get("project_id") or "")
        status = str(reflection.get("status") or "")
        current_id = str(reflection.get("id") or "")
        params: tuple[Any, ...]
        if status == REFLECTION_WORKFLOW.success_status:
            query = """
                SELECT id, published_graph_version_id
                FROM reflections
                WHERE project_id = ? AND status = ?
                  AND id != ? AND created_seq < ?
                ORDER BY published_at DESC, created_seq DESC
                LIMIT 1
                """
            params = (
                project_id,
                REFLECTION_WORKFLOW.success_status,
                current_id,
                int(reflection.get("created_seq") or 0),
            )
        else:
            query = """
                SELECT id, published_graph_version_id
                FROM reflections
                WHERE project_id = ? AND status = ?
                ORDER BY published_at DESC, created_seq DESC
                LIMIT 1
                """
            params = (project_id, REFLECTION_WORKFLOW.success_status)
        row = conn.execute(query, params).fetchone()
        if row is None:
            return None
        return {
            "reflection_id": row["id"],
            "graph_version_id": row["published_graph_version_id"],
        }

    def _load_graph_for_diff(
        self, *, artifact_id: str, what: str
    ) -> tuple[dict[str, Any] | None, list[str]]:
        try:
            text = self._read_document(artifact_id=artifact_id, what=what).text
        except WorkflowError as exc:
            return None, [str(exc)]
        problems = graph_problems(text)
        if problems:
            return None, [f"{what}: {problem}" for problem in problems]
        data = json.loads(text)
        return data, []

    def _read_document(self, *, artifact_id: str, what: str) -> ArtifactDocument:
        """Read one complete artifact as strict UTF-8 for a workflow gate."""
        if not artifact_id:
            raise WorkflowError(
                f"{what} has no submitted artifact — submit it with artifact.submit"
            )
        found = self.artifacts.get(
            artifact_ids=(artifact_id,),
            include="document",
        )
        return require_artifact_document(
            found[0] if found else None,
            artifact_id=artifact_id,
            what=what,
        )

    def _evaluate_gate(self, *, conn, reflection: dict[str, Any]) -> GateEvaluation:
        """Collect reflection facts once for enforcement, state, and guidance."""
        status = str(reflection.get("status") or "")
        workflow_state = REFLECTION_WORKFLOW.state(status)
        requirements: list[RequirementEvaluation] = []
        if workflow_state is not None and status == REFLECTION_WORKFLOW.initial:
            requirements.append(
                self._evaluate_roster_gate(
                    conn=conn,
                    reflection=reflection,
                    requirement=workflow_state.requirements[0],
                )
            )
        elif workflow_state is not None:
            for requirement in workflow_state.requirements:
                if isinstance(requirement, RecordNeed):
                    requirements.append(
                        self._evaluate_record_requirement(
                            reflection=reflection,
                            requirement=requirement,
                        )
                    )
                    continue
                artifact = current_reflection_requirement_artifact(
                    reflection=reflection, role=requirement.role
                )
                present = artifact is not None
                problems: tuple[str, ...] = ()
                if present and requirement.validator:
                    try:
                        self._run_validator(
                            conn=conn, reflection=reflection, name=requirement.validator
                        )
                    except WorkflowError as exc:
                        problems = (str(exc),)
                requirements.append(
                    evaluate_artifact_requirement(
                        requirement,
                        present=present,
                        problems=problems,
                        artifact_fields=(
                            None
                            if artifact is None
                            else {
                                "path": artifact.get("path"),
                                "artifact_id": artifact.get("id"),
                                "submitted_role": artifact.get("role"),
                            }
                        ),
                    )
                )

        review = (
            None
            if workflow_state is None or workflow_state.review is None
            else evaluate_review_gate(
                conn=conn,
                target_type="reflection",
                target=reflection,
                review=workflow_state.review,
            )
        )
        return GateEvaluation(
            workflow=REFLECTION_WORKFLOW,
            status=status,
            requirements=tuple(requirements),
            review=review,
        )

    @staticmethod
    def _evaluate_record_requirement(
        *, reflection: dict[str, Any], requirement: RecordNeed
    ) -> RequirementEvaluation:
        consolidation = reflection.get("consolidation") or {}
        proposal = consolidation.get("proposal") or {}
        coverage = consolidation.get("coverage") or {}
        advance = consolidation.get("advance") or {}
        if requirement.name == "consolidation_proposal":
            satisfied = bool(proposal) and bool(coverage.get("complete"))
            fields = {
                "proposal_id": proposal.get("id"),
                "proposal_sha": proposal.get("proposal_sha"),
                "coverage": coverage,
            }
        elif requirement.name == "central_advance":
            satisfied = bool(proposal) and (
                advance.get("status") == "bound"
                and advance.get("proposal_id") == proposal.get("id")
                and advance.get("observed_sha") == proposal.get("proposal_sha")
            )
            fields = {
                "advance_id": advance.get("id"),
                "status": advance.get("status") or "pending",
                "observed_sha": advance.get("observed_sha") or "",
            }
        else:  # pragma: no cover - workflow declaration is import-validated
            raise RuntimeError(
                f"unknown reflection record requirement: {requirement.name}"
            )
        return RequirementEvaluation(
            role=requirement.name,
            status="valid" if satisfied else "missing",
            blocker_code="" if satisfied else requirement.gate,
            enforcement_error="" if satisfied else requirement.error,
            problems=(),
            items=(
                {
                    "id": f"record:{requirement.name}",
                    "kind": "record",
                    "role": requirement.name,
                    "label": requirement.label,
                    "satisfied": satisfied,
                    "status": "valid" if satisfied else "missing",
                    "gate": requirement.gate,
                    "action": requirement.action,
                    "missing": requirement.missing if not satisfied else "",
                    **fields,
                },
            ),
        )

    def _evaluate_roster_gate(
        self,
        *,
        conn,
        reflection: dict[str, Any],
        requirement: ArtifactNeed,
    ) -> RequirementEvaluation:
        coverage = reflection.get("reflection_coverage") or {}
        by_lens = {
            str(item.get("lens_id") or ""): item
            for item in coverage.get("lenses") or []
        }
        missing_lenses = list(coverage.get("missing") or [])
        has_association = any(
            item.get("role") == requirement.role
            for item in reflection.get("current_attempt_artifacts") or []
        )
        missing_error = ""
        if missing_lenses:
            missing_error = (
                requirement.error
                if not has_association
                else (
                    "reflections are missing for lens(es): "
                    + ", ".join(missing_lenses)
                    + " — each roster lens must have its own reflection submitted "
                    "(artifact.submit with role 'reflection_lens_doc' and its "
                    "lens_id) for the current attempt, by its own subagent"
                )
            )
        invalid: dict[str, str] = {}
        if not missing_lenses:
            for lens in coverage.get("lenses") or []:
                lens_id, path = str(lens["lens_id"]), str(lens["path"])
                try:
                    text = self._read_document(
                        artifact_id=str(lens.get("artifact_id") or ""),
                        what=f"reflection {lens_id!r}",
                    ).text
                    problems = reflection_lens_doc_problems(text)
                    if problems:
                        invalid[lens_id] = (
                            f"reflection for lens {lens_id!r} ({path}) is not ready: "
                            + "; ".join(problems)
                            + " — add a ## Summary with the lens's macro-level "
                            "finding, then resubmit it (artifact.submit)"
                        )
                except WorkflowError as exc:
                    invalid[lens_id] = str(exc)

        items: list[GateItem] = []
        for lens in reflection.get("roster") or []:
            lens_id = str(lens.get("id") or "")
            found = by_lens.get(lens_id) or {}
            covered = bool(found.get("covered"))
            problem = invalid.get(lens_id, "")
            item: GateItem = {
                "id": f"reflection_lens:{lens_id}",
                "kind": "reflection_lens",
                "role": requirement.role,
                "lens_id": lens_id,
                "label": f"{str(lens.get('title') or lens_id)} reflection submitted",
                "satisfied": covered and not problem,
                "status": "invalid" if problem else "present" if covered else "missing",
                "gate": requirement.gate,
                "action": requirement.action,
            }
            if covered:
                item.update(
                    path=found.get("path"),
                    artifact_id=found.get("artifact_id"),
                    submitted_role=found.get("role"),
                )
            else:
                item["missing"] = (
                    f"reflection doc for lens {lens_id!r} "
                    "(artifact.submit with role 'reflection_lens_doc', "
                    f"lens_id {lens_id!r})"
                )
            if problem:
                item["problems"] = [problem]
            items.append(item)
        problems = tuple(invalid.values())
        error = missing_error or (problems[0] if problems else "")
        status = "missing" if missing_lenses else "invalid" if problems else "valid"
        return RequirementEvaluation(
            role=requirement.role,
            status=status,
            blocker_code=(
                ""
                if not error
                else (
                    requirement.gate
                    if missing_lenses
                    else f"{requirement.role}_invalid"
                )
            ),
            enforcement_error=error,
            problems=problems,
            items=tuple(items),
        )

    # ---- transitions ----

    def submit_consolidation(
        self,
        *,
        reflection_id: str,
        base_sha: str,
        proposal_sha: str,
        summary: str,
        validation: dict[str, Any] | None,
        decisions: list[dict[str, Any]],
        producer_session_id: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        """Record one immutable code proposal covering the whole reflection corpus."""
        base_sha = _git_sha(base_sha)
        proposal_sha = _git_sha(proposal_sha)
        producer_session_id = str(producer_session_id or "").strip()
        summary = str(summary or "").strip()
        if not producer_session_id:
            raise ValidationError("producer_session_id is required")
        if not summary:
            raise ValidationError("consolidation summary is required")
        if not isinstance(validation, dict):
            raise ValidationError("validation must be an object")
        try:
            validation_json = json.dumps(validation, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise ValidationError("validation must contain JSON values") from exc

        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            reflection = self.get_state(
                reflection_id=reflection_id,
                project_id=project_id,
                conn=conn,
            )
            if reflection["status"] != "consolidating":
                raise WorkflowError(
                    "consolidation proposals are accepted only after the "
                    "authoritative reflection review has passed"
                )
            unsettled_advance = conn.execute(
                """
                SELECT a.id
                FROM reflection_advances a
                JOIN consolidation_proposals p ON p.id = a.proposal_id
                WHERE p.reflection_id = ? AND a.status IN ('intended', 'bound')
                LIMIT 1
                """,
                (reflection_id,),
            ).fetchone()
            if unsettled_advance is not None:
                raise WorkflowError(
                    "cannot replace a consolidation proposal while its central "
                    "advance is in progress or already bound"
                )
            expected = {
                str(item["id"])
                for item in (reflection.get("corpus") or {}).get(
                    "terminal_experiments", []
                )
                if isinstance(item, dict) and item.get("id")
            }
            normalized = self._validate_consolidation_decisions(
                decisions=decisions,
                expected_experiments=expected,
            )
            revision_row = conn.execute(
                """
                SELECT COALESCE(MAX(revision), 0) AS revision
                FROM consolidation_proposals
                WHERE reflection_id = ?
                """,
                (reflection_id,),
            ).fetchone()
            revision = int(revision_row["revision"] or 0) + 1
            proposal_id = new_id(prefix="cpr")
            created_at = now_iso()
            conn.execute(
                """
                INSERT INTO consolidation_proposals (
                  id, reflection_id, project_id, revision, base_sha,
                  proposal_sha, summary, validation_json,
                  created_by_session_id, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    proposal_id,
                    reflection_id,
                    project_id,
                    revision,
                    base_sha,
                    proposal_sha,
                    summary,
                    validation_json,
                    producer_session_id,
                    created_at,
                ),
            )
            for decision in normalized:
                conn.execute(
                    """
                    INSERT INTO consolidation_decisions (
                      proposal_id, experiment_id, disposition, rationale,
                      source_sha, integration_kind, superseded_by, decided_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        proposal_id,
                        decision["experiment_id"],
                        decision["disposition"],
                        decision["rationale"],
                        decision["source_sha"],
                        decision["integration_kind"],
                        decision["superseded_by"],
                        created_at,
                    ),
                )
            conn.execute(
                """
                UPDATE reflections
                SET revision_context = '', updated_at = ?
                WHERE id = ?
                """,
                (created_at, reflection_id),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="reflection.consolidation_proposed",
                target_type="reflection",
                target_id=reflection_id,
                payload={
                    "proposal_id": proposal_id,
                    "proposal_sha": proposal_sha,
                    "base_sha": base_sha,
                    "revision": revision,
                    "experiments_considered": len(normalized),
                },
            )
            return self.get_state(
                reflection_id=reflection_id,
                conn=conn,
                include_content=True,
            )

    @staticmethod
    def _validate_consolidation_decisions(
        *,
        decisions: list[dict[str, Any]],
        expected_experiments: set[str],
    ) -> list[dict[str, Any]]:
        if not isinstance(decisions, list):
            raise ValidationError("decisions must be a list")
        allowed = {
            "used_as_is",
            "adapted",
            "reviewed_not_used",
            "superseded",
        }
        integration_kinds = {
            "merge",
            "fast_forward",
            "cherry_pick",
            "rewrite",
            "none",
        }
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in decisions:
            if not isinstance(raw, dict):
                raise ValidationError("each consolidation decision must be an object")
            experiment_id = str(raw.get("experiment_id") or "").strip()
            disposition = str(raw.get("disposition") or "").strip()
            rationale = str(raw.get("rationale") or "").strip()
            if experiment_id not in expected_experiments:
                raise ValidationError(
                    f"consolidation decision names an experiment outside the "
                    f"reflection corpus: {experiment_id or '<missing>'}"
                )
            if experiment_id in seen:
                raise ValidationError(
                    f"duplicate consolidation decision for {experiment_id}"
                )
            if disposition not in allowed:
                raise ValidationError(
                    f"unknown consolidation disposition: {disposition}"
                )
            if not rationale:
                raise ValidationError(
                    f"consolidation rationale is required for {experiment_id}"
                )
            source_sha = (
                _git_sha(str(raw.get("source_sha") or ""))
                if raw.get("source_sha")
                else ""
            )
            integration_kind = str(raw.get("integration_kind") or "none").strip()
            if integration_kind not in integration_kinds:
                raise ValidationError(
                    f"unknown integration kind for {experiment_id}: "
                    f"{integration_kind}"
                )
            carries_code = disposition in {"used_as_is", "adapted"}
            if carries_code and not source_sha:
                raise ValidationError(
                    f"{experiment_id} cannot carry code without a recorded "
                    "experiment workspace head"
                )
            if carries_code and integration_kind == "none":
                raise ValidationError(
                    f"{experiment_id} disposition {disposition!r} requires "
                    "a Git integration kind"
                )
            if not carries_code and integration_kind != "none":
                raise ValidationError(
                    f"{experiment_id} disposition {disposition!r} requires "
                    "integration_kind='none'"
                )
            superseded_by = str(raw.get("superseded_by") or "").strip()
            if (
                disposition == "superseded"
                and superseded_by not in expected_experiments
            ):
                raise ValidationError(
                    f"superseded decision for {experiment_id} must name the "
                    "superseding experiment"
                )
            if disposition != "superseded" and superseded_by:
                raise ValidationError(
                    "superseded_by is valid only for a superseded decision"
                )
            if superseded_by == experiment_id:
                raise ValidationError(f"{experiment_id} cannot supersede itself")
            normalized.append(
                {
                    "experiment_id": experiment_id,
                    "disposition": disposition,
                    "rationale": rationale,
                    "source_sha": source_sha,
                    "integration_kind": integration_kind,
                    "superseded_by": superseded_by,
                }
            )
            seen.add(experiment_id)
        missing = sorted(expected_experiments - seen)
        if missing:
            raise ValidationError(
                "every experiment must be reviewed for consolidation; missing: "
                + ", ".join(missing)
            )
        return normalized

    def require_consolidation_proposal(
        self, *, conn, reflection: dict[str, Any]
    ) -> None:
        state = REFLECTION_WORKFLOW.state(str(reflection.get("status") or ""))
        if (
            state is None
            or state.review is None
            or state.review.role != "consolidation_reviewer"
        ):
            return
        requirement = next(
            (
                item
                for item in state.requirements
                if isinstance(item, RecordNeed)
                and item.name == "consolidation_proposal"
            ),
            None,
        )
        if requirement is None:
            raise RuntimeError("consolidation state has no proposal requirement")
        evaluation = self._evaluate_record_requirement(
            reflection=reflection,
            requirement=requirement,
        )
        if not evaluation.satisfied:
            raise WorkflowError(evaluation.enforcement_error)

    def prepare_advance(
        self,
        *,
        reflection_id: str,
        runner_id: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        """Durably record the exact Git CAS the runner is allowed to perform."""
        runner_id = str(runner_id or "").strip()
        if not runner_id:
            raise ValidationError("runner_id is required")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            reflection, gate = self.get_state_with_gate(
                reflection_id=reflection_id,
                project_id=project_id,
                conn=conn,
            )
            if reflection["status"] != "consolidating":
                raise WorkflowError("reflection is not awaiting consolidation")
            self.require_consolidation_proposal(
                conn=conn,
                reflection=reflection,
            )
            if gate.review is None or not gate.review.satisfied:
                raise WorkflowError(
                    "the exact consolidation proposal must pass independent "
                    "review before central can advance"
                )
            proposal = (reflection.get("consolidation") or {}).get("proposal") or {}
            existing = conn.execute(
                """
                SELECT * FROM reflection_advances
                WHERE proposal_id = ?
                """,
                (proposal["id"],),
            ).fetchone()
            if existing is not None:
                status = str(existing["status"])
                current_runner = str(existing["runner_id"])
                if status in {"bound", "stale"}:
                    raise WorkflowError(
                        f"central advance is already {status}; submit a proposal "
                        "against the current central head"
                    )
                intended = parse_iso(existing["intended_at"])
                owned = (
                    status == "intended"
                    and current_runner != runner_id
                    and intended is not None
                    and intended + timedelta(seconds=ADVANCE_OWNER_LEASE_SECONDS)
                    > datetime.now(UTC)
                )
                if owned:
                    raise WorkflowError(
                        "central advance is owned by another runner; retry after "
                        "its intent lease expires"
                    )
                intended_at = now_iso()
                conn.execute(
                    """
                    UPDATE reflection_advances
                    SET status = 'intended', runner_id = ?, intended_at = ?,
                        observed_sha = '', error = ''
                    WHERE id = ?
                    """,
                    (runner_id, intended_at, existing["id"]),
                )
                if current_runner != runner_id:
                    self.store.record_event(
                        conn=conn,
                        project_id=project_id,
                        event_type="reflection.central_advance_intended",
                        target_type="reflection",
                        target_id=reflection_id,
                        payload={
                            "advance_id": str(existing["id"]),
                            "proposal_id": proposal["id"],
                            "expected_sha": proposal["base_sha"],
                            "target_sha": proposal["proposal_sha"],
                            "runner_id": runner_id,
                            "previous_runner_id": current_runner,
                            "takeover": True,
                        },
                    )
                return self._advance_payload(
                    conn=conn,
                    row=conn.execute(
                        "SELECT * FROM reflection_advances WHERE id = ?",
                        (existing["id"],),
                    ).fetchone(),
                )
            advance_id = new_id(prefix="adv")
            intended_at = now_iso()
            conn.execute(
                """
                INSERT INTO reflection_advances (
                  id, reflection_id, proposal_id, expected_sha, target_sha,
                  status, runner_id, intended_at
                )
                VALUES (?, ?, ?, ?, ?, 'intended', ?, ?)
                """,
                (
                    advance_id,
                    reflection_id,
                    proposal["id"],
                    proposal["base_sha"],
                    proposal["proposal_sha"],
                    runner_id,
                    intended_at,
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="reflection.central_advance_intended",
                target_type="reflection",
                target_id=reflection_id,
                payload={
                    "advance_id": advance_id,
                    "proposal_id": proposal["id"],
                    "expected_sha": proposal["base_sha"],
                    "target_sha": proposal["proposal_sha"],
                    "runner_id": runner_id,
                },
            )
            return self._advance_payload(
                conn=conn,
                row=conn.execute(
                    "SELECT * FROM reflection_advances WHERE id = ?",
                    (advance_id,),
                ).fetchone(),
            )

    @staticmethod
    def _advance_payload(*, conn, row) -> dict[str, Any]:
        result = row_to_dict(row=row) or {}
        result["proposal_parents"] = json.loads(
            str(result.pop("proposal_parents_json", "[]") or "[]")
        )
        result["diffstat"] = json.loads(str(result.pop("diffstat_json", "{}") or "{}"))
        result["ancestry"] = json.loads(str(result.pop("ancestry_json", "{}") or "{}"))
        result["sources"] = rows_to_dicts(
            rows=conn.execute(
                """
                SELECT experiment_id, source_sha, integration_kind
                FROM consolidation_decisions
                WHERE proposal_id = ? AND integration_kind != 'none'
                ORDER BY experiment_id
                """,
                (result.get("proposal_id"),),
            ).fetchall()
        )
        return result

    def settle_advance(
        self,
        *,
        advance_id: str,
        runner_id: str,
        observed_sha: str,
        proposal_parents: list[str] | None = None,
        diffstat: dict[str, Any] | None = None,
        ancestry: dict[str, bool] | None = None,
        error: str = "",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        """Settle one CAS receipt and atomically publish when it reached target."""
        observed_sha = _git_sha(observed_sha)
        parents = [_git_sha(value) for value in (proposal_parents or [])]
        try:
            diffstat_json = json.dumps(diffstat or {}, sort_keys=True)
        except (TypeError, ValueError) as exc:
            raise ValidationError("diffstat must contain JSON values") from exc
        ancestry = ancestry or {}
        if not isinstance(ancestry, dict) or any(
            not isinstance(key, str) or not key or not isinstance(value, bool)
            for key, value in ancestry.items()
        ):
            raise ValidationError("ancestry must map experiment ids to booleans")
        ancestry_json = json.dumps(ancestry, sort_keys=True)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            advance = conn.execute(
                """
                SELECT a.*, p.project_id
                FROM reflection_advances a
                JOIN consolidation_proposals p ON p.id = a.proposal_id
                WHERE a.id = ? AND p.project_id = ?
                """,
                (advance_id, project_id),
            ).fetchone()
            if advance is None:
                raise NotFoundError(f"central advance not found: {advance_id}")
            caller_runner = str(runner_id or "").strip()
            if str(advance["runner_id"]) != caller_runner:
                # The CAS itself is never transferable, but the publish retry
                # of an already-durable bound receipt is: after the owner's
                # lease any project runner may complete it (no Git work
                # remains, mirroring prepare_advance's intent-lease recovery).
                bound_at = parse_iso(advance["bound_at"])
                takeover = (
                    str(advance["status"]) == "bound"
                    and bound_at is not None
                    and bound_at
                    + timedelta(seconds=ADVANCE_OWNER_LEASE_SECONDS)
                    <= datetime.now(UTC)
                )
                if not takeover:
                    raise ValidationError(
                        "central advance belongs to another runner"
                    )
            reflection_id = str(advance["reflection_id"])
            wave_status = str(
                conn.execute(
                    "SELECT status FROM reflections WHERE id = ?",
                    (reflection_id,),
                ).fetchone()["status"]
            )
            if (
                wave_status in REFLECTION_WORKFLOW.terminal_statuses
                and wave_status != REFLECTION_WORKFLOW.success_status
            ):
                # The wave closed while the receipt was in flight (abandon is
                # legal until a receipt is bound): never bind or publish into
                # a terminal wave — record the orphaned CAS for the operator.
                conn.execute(
                    """
                    UPDATE reflection_advances
                    SET status = 'stale', observed_sha = ?, error = ?,
                        ancestry_json = ?
                    WHERE id = ?
                    """,
                    (
                        observed_sha,
                        f"wave {wave_status} before settle — central advance orphaned",
                        ancestry_json,
                        advance_id,
                    ),
                )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="reflection.central_advance_stale",
                    target_type="reflection",
                    target_id=reflection_id,
                    payload={
                        "advance_id": advance_id,
                        "expected_sha": str(advance["expected_sha"]),
                        "observed_sha": observed_sha,
                        "reason": f"wave {wave_status} before settle",
                    },
                )
                return self.get_state(
                    reflection_id=reflection_id,
                    conn=conn,
                    include_content=True,
                )
            if str(advance["status"]) == "bound":
                # Already bound: fall through to the publish attempt below so
                # a settle retried after a blocked publish can complete it.
                pass
            elif observed_sha == str(advance["target_sha"]):
                source_kinds = {
                    str(row["experiment_id"]): str(row["integration_kind"])
                    for row in conn.execute(
                        """
                        SELECT experiment_id, integration_kind
                        FROM consolidation_decisions
                        WHERE proposal_id = ? AND integration_kind != 'none'
                        """,
                        (advance["proposal_id"],),
                    ).fetchall()
                }
                if set(ancestry) != set(source_kinds):
                    raise ValidationError(
                        "ancestry receipt must cover every experiment whose "
                        "code was carried"
                    )
                mismatches = sorted(
                    experiment_id
                    for experiment_id, kind in source_kinds.items()
                    if kind in {"merge", "fast_forward"}
                    and ancestry[experiment_id] is not True
                )
                if mismatches:
                    raise ValidationError(
                        "ancestry must be true for merge or fast-forward "
                        "sources: " + ", ".join(mismatches)
                    )
                conn.execute(
                    """
                    UPDATE reflection_advances
                    SET status = 'bound', observed_sha = ?, bound_at = ?,
                        proposal_parents_json = ?, diffstat_json = ?,
                        ancestry_json = ?, error = ''
                    WHERE id = ?
                    """,
                    (
                        observed_sha,
                        now_iso(),
                        json.dumps(parents, sort_keys=True),
                        diffstat_json,
                        ancestry_json,
                        advance_id,
                    ),
                )
            elif observed_sha == str(advance["expected_sha"]):
                conn.execute(
                    """
                    UPDATE reflection_advances
                    SET status = ?, observed_sha = ?, error = ?,
                        ancestry_json = ?
                    WHERE id = ?
                    """,
                    (
                        "failed" if error else "intended",
                        observed_sha,
                        str(error or "")[:1000],
                        ancestry_json,
                        advance_id,
                    ),
                )
                return self.get_state(
                    reflection_id=str(advance["reflection_id"]),
                    conn=conn,
                    include_content=True,
                )
            else:
                conn.execute(
                    """
                    UPDATE reflection_advances
                    SET status = 'stale', observed_sha = ?, error = ?,
                        ancestry_json = ?
                    WHERE id = ?
                    """,
                    (
                        observed_sha,
                        str(error or "central moved")[:1000],
                        ancestry_json,
                        advance_id,
                    ),
                )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="reflection.central_advance_stale",
                    target_type="reflection",
                    target_id=str(advance["reflection_id"]),
                    payload={
                        "advance_id": advance_id,
                        "expected_sha": str(advance["expected_sha"]),
                        "observed_sha": observed_sha,
                    },
                )
                return self.get_state(
                    reflection_id=str(advance["reflection_id"]),
                    conn=conn,
                    include_content=True,
                )
        # The bound receipt is durable before publish is attempted: the Git
        # ref already moved, so a publish failure must mark the advance, not
        # unwind the record of an irreversible external fact.
        return self._publish_bound_advance(
            advance_id=advance_id,
            reflection_id=reflection_id,
            project_id=project_id,
        )

    def _publish_bound_advance(
        self, *, advance_id: str, reflection_id: str, project_id: str
    ) -> dict[str, Any]:
        """Publish a bound central advance in its own transaction.

        A blocked publish records its error on the advance and leaves the
        wave in consolidating with the receipt intact; retrying the settle
        re-enters here, so the wave completes once the blocker clears
        instead of wedging.
        """
        try:
            with self.store.transaction() as conn:
                # Cleared first so success leaves no stale diagnostic; a
                # failed publish rolls this back along with the transition.
                conn.execute(
                    "UPDATE reflection_advances SET error = '' WHERE id = ?",
                    (advance_id,),
                )
                reflection, gate = self.get_state_with_gate(
                    reflection_id=reflection_id,
                    project_id=project_id,
                    conn=conn,
                )
                if str(reflection.get("status")) == REFLECTION_WORKFLOW.success_status:
                    # A retried settle after a completed publish is idempotent.
                    return self.get_state(
                        reflection_id=reflection_id,
                        conn=conn,
                        include_content=True,
                    )
                return self._transition_in_tx(
                    conn=conn,
                    reflection=reflection,
                    gate=gate,
                    transition="publish",
                )
        except Exception as exc:
            with suppress(Exception):
                with self.store.transaction() as conn:
                    row = conn.execute(
                        "SELECT status FROM reflections WHERE id = ?",
                        (reflection_id,),
                    ).fetchone()
                    if (
                        row is None
                        or str(row["status"]) != REFLECTION_WORKFLOW.success_status
                    ):
                        # An ambiguous COMMIT ack can raise after publication
                        # landed; never let the diagnostic outlive a success.
                        conn.execute(
                            "UPDATE reflection_advances SET error = ? WHERE id = ?",
                            (
                                f"publish blocked after bind: {str(exc)[:900]}",
                                advance_id,
                            ),
                        )
            raise

    def transition(
        self,
        *,
        reflection_id: str,
        transition: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            reflection, gate = self.get_state_with_gate(
                reflection_id=reflection_id, project_id=project_id, conn=conn
            )
            return self._transition_in_tx(
                conn=conn,
                reflection=reflection,
                gate=gate,
                transition=transition,
            )

    def _transition_in_tx(
        self,
        *,
        conn,
        reflection: dict[str, Any],
        gate: GateEvaluation,
        transition: str,
    ) -> dict[str, Any]:
        status = reflection["status"]
        reflection_id = str(reflection["id"])
        next_status = gate.require_transition(transition)
        step = REFLECTION_WORKFLOW.transition(transition)
        if step is None:
            raise WorkflowError(f"unknown reflection transition: {transition}")
        if (
            next_status in REFLECTION_WORKFLOW.terminal_statuses
            and next_status != REFLECTION_WORKFLOW.success_status
        ):
            # A bound receipt means central already advanced: the only legal
            # exit is publish (the runner retries settle), so a terminal exit
            # here would strand the reviewed belief-state update forever.
            bound = conn.execute(
                "SELECT id FROM reflection_advances "
                "WHERE reflection_id = ? AND status = 'bound' LIMIT 1",
                (reflection_id,),
            ).fetchone()
            if bound is not None:
                raise WorkflowError(
                    "central has already advanced for this wave (bound receipt "
                    f"{bound['id']}); publication completes via the runner's "
                    "settle retry — the wave cannot be abandoned once bound"
                )
            # Cancel open intents so a settle that raced this exit records an
            # orphaned CAS instead of binding into a terminal wave.
            conn.execute(
                "UPDATE reflection_advances SET status = 'stale', error = ? "
                "WHERE reflection_id = ? AND status = 'intended'",
                ("wave abandoned before settle", reflection_id),
            )
        now = now_iso()
        # Same seal as the experiment FSM: freeze this round's lens docs
        # so a re-run of the fan-out cannot delete what was reviewed.
        self.artifacts.seal(
            tx=conn,
            target=ArtifactTarget(
                "reflection", reflection_id, reflection["project_id"]
            ),
            transition=transition,
        )
        if "materialize_change_spec" in step.effects:
            self._materialize_change_spec(conn=conn, reflection=reflection)
            conn.execute(
                """
                UPDATE reflections
                SET status = ?, published_at = ?, published_graph_version_id = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    next_status,
                    now,
                    (
                        self._current_graph_version_id(reflection=reflection)
                        if "pin_project_graph" in step.effects
                        else None
                    ),
                    now,
                    reflection_id,
                ),
            )
        else:
            conn.execute(
                "UPDATE reflections SET status = ?, updated_at = ? WHERE id = ?",
                (next_status, now, reflection_id),
            )
        if transition in ("submit_reflection_artifacts", "begin_consolidation"):
            # submit_reflection_artifacts shares the transaction that
            # world-validated the spec; begin_consolidation re-pins so a spec
            # revised and re-reviewed during reflection_review (review
            # freshness guarantees the newest spec IS the reviewed one) is
            # the one publication materializes.
            self._reserve_wave_names(conn=conn, reflection=reflection)
        elif next_status not in ("reflection_review", "consolidating"):
            # Publish materialized the names; abandon and early exits release.
            conn.execute(
                "DELETE FROM reflection_reserved_names WHERE reflection_id = ?",
                (reflection_id,),
            )
        self.store.record_event(
            conn=conn,
            project_id=reflection["project_id"],
            event_type=REFLECTION_WORKFLOW.event_type,
            target_type="reflection",
            target_id=reflection_id,
            payload={"from": status, "to": next_status, "transition": transition},
        )
        return self.get_state(
            reflection_id=reflection_id,
            conn=conn,
            include_content=True,
        )

    def _reserve_wave_names(self, *, conn, reflection: dict[str, Any]) -> None:
        """Pin the validated spec and reserve its experiment names.

        The reservation rows carry the validated artifact's id, so publish
        materializes exactly the spec whose names were reserved — a change
        spec submitted later never drifts into publication. A tool create
        taking a reserved name mid-wave gets an actionable error at create
        time instead of blocking an already-bound publish (see
        ExperimentService._reject_reserved_wave_name).
        """
        document = self._submitted_role_document(
            reflection=reflection, roles=("change_spec",), what="change spec"
        )
        if document is None:
            raise WorkflowError(
                "a change spec artifact must be submitted before reflection review"
            )
        spec = self._parse_change_spec(
            conn=conn,
            project_id=str(reflection["project_id"]),
            text=document.text,
            path=document.path,
            enforce_world=False,
        )
        decision = spec.get("decision") or {}
        names = {
            str(proposal.get("name") or "").strip().lower()
            for proposal in decision.get("experiments") or []
        }
        task_names = {
            str(proposal.get("name") or "").strip().lower()
            for proposal in decision.get("tasks") or []
        }
        reflection_id = str(reflection["id"])
        project_id = str(reflection["project_id"])
        conn.execute(
            "DELETE FROM reflection_reserved_names WHERE reflection_id = ?",
            (reflection_id,),
        )
        active_count = len(
            self._non_terminal_experiments(conn=conn, project_id=project_id)
        )
        if active_count + len(names) > ACTIVE_EXPERIMENT_CAP:
            raise WorkflowError(
                active_experiment_cap_would_exceed_message(
                    active_count=active_count, proposed_count=len(names)
                )
            )
        for name in sorted(name for name in names | task_names if name):
            # Availability recheck keeps this safe from any caller, not just
            # the gate that world-validated the spec this same transaction.
            if name in names and self._experiment_name_exists(
                conn=conn, project_id=project_id, name=name
            ):
                raise WorkflowError(
                    f"experiment name already exists in project: {name}"
                )
            if name in task_names and self._task_name_exists(
                conn=conn, project_id=project_id, name=name
            ):
                raise WorkflowError(f"task name already exists in project: {name}")
            conn.execute(
                "INSERT INTO reflection_reserved_names "
                "(reflection_id, project_id, name_lower, artifact_id) "
                "VALUES (?, ?, ?, ?)",
                (reflection_id, project_id, name, document.artifact_id),
            )

    def _run_validator(self, *, conn, reflection: dict[str, Any], name: str) -> None:
        if name == "graph":
            self._validate_project_graph(conn=conn, reflection=reflection)
        elif name == "reflection_doc":
            self._validate_reflection_doc(conn=conn, reflection=reflection)
        elif name == "change_spec":
            self._validate_change_spec(conn=conn, reflection=reflection)

    def _validate_project_graph(self, *, conn, reflection: dict[str, Any]) -> None:
        document = self._submitted_role_document(
            reflection=reflection,
            roles=(PROJECT_GRAPH_ROLE,),
            what="project logic graph",
        )
        if document is None:
            raise WorkflowError(
                "a project logic graph artifact must be submitted before reflection review"
            )
        problems = graph_problems(document.text)
        if problems:
            raise WorkflowError(
                "project logic graph is not ready for reflection review: "
                + "; ".join(problems)
                + ". Fix the file and resubmit it (artifact.submit) — "
                "see skills/research-workflow/graph-template.md."
            )

    def _validate_reflection_doc(self, *, conn, reflection: dict[str, Any]) -> None:
        document = self._submitted_role_document(
            reflection=reflection,
            roles=("reflection_doc",),
            what="reflection document",
        )
        if document is None:
            raise WorkflowError(
                "a reflection document artifact must be submitted before reflection review"
            )
        problems = reflection_doc_review_problems(
            text=document.text,
            submitted_images=set(document.figure_links),
            path=document.path,
        )
        if problems:
            raise WorkflowError(
                "reflection document is not ready for review: "
                + "; ".join(problems)
                + ". Keep it concise, fix the file, and resubmit it (artifact.submit) to "
                "submit the revision — see "
                "skills/project-reflection/reflection-artifacts-template.md."
            )

    def _validate_change_spec(self, *, conn, reflection: dict[str, Any]) -> None:
        document = self._submitted_role_document(
            reflection=reflection,
            roles=("change_spec",),
            what="change spec",
        )
        if document is None:
            raise WorkflowError(
                "a change spec artifact must be submitted before reflection review"
            )
        self._parse_change_spec(
            conn=conn,
            project_id=str(reflection["project_id"]),
            text=document.text,
            path=document.path,
        )

    def _pinned_change_spec(
        self, *, conn, reflection: dict[str, Any]
    ) -> dict[str, Any]:
        """The spec pinned when its names were validated and reserved.

        Publish reads the artifact id stored on the wave's reservation rows,
        never the latest submission — a spec submitted after validation
        cannot drift into publication. enforce_world=False: availability was
        checked and reserved in the pinning transaction, and by publish the
        Git advance is already bound, so a mutable-world recheck could only
        wedge the wave.
        """
        row = conn.execute(
            "SELECT artifact_id FROM reflection_reserved_names "
            "WHERE reflection_id = ? AND artifact_id != '' LIMIT 1",
            (str(reflection["id"]),),
        ).fetchone()
        if row is not None:
            document = self._read_document(
                artifact_id=str(row["artifact_id"]), what="change spec"
            )
        else:
            # Upgrade path: a wave already consolidating when the pin shipped
            # has no reservation rows; fall back to the current sealed spec
            # (the pre-pin behavior) so its bound publish cannot wedge. New
            # waves always pin at submit_reflection_artifacts.
            document = self._submitted_role_document(
                reflection=reflection, roles=("change_spec",), what="change spec"
            )
            if document is None:
                raise WorkflowError(
                    "a change spec artifact must be submitted before publish"
                )
        return self._parse_change_spec(
            conn=conn,
            project_id=str(reflection["project_id"]),
            text=document.text,
            path=document.path,
            enforce_world=False,
        )

    def _parse_change_spec(
        self,
        *,
        conn,
        project_id: str,
        text: str,
        path: str,
        enforce_world: bool = True,
    ) -> dict[str, Any]:
        return parse_change_spec(
            text=text,
            path=path,
            claim_exists=lambda claim_id: self._claim_exists(
                conn=conn, project_id=project_id, claim_id=claim_id
            ),
            experiment_name_taken=(
                (
                    lambda name: self._experiment_name_exists(
                        conn=conn, project_id=project_id, name=name
                    )
                )
                if enforce_world
                else None
            ),
            task_name_taken=(
                (
                    lambda name: self._task_name_exists(
                        conn=conn, project_id=project_id, name=name
                    )
                )
                if enforce_world
                else None
            ),
            node_exists=lambda node_id: self._node_exists(
                conn=conn, project_id=project_id, node_id=node_id
            ),
            non_terminal_experiments=(
                (
                    lambda: self._non_terminal_experiments(
                        conn=conn, project_id=project_id
                    )
                )
                if enforce_world
                else None
            ),
        )

    def _claim_exists(self, *, conn, project_id: str, claim_id: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM claims WHERE id = ? AND project_id = ? LIMIT 1",
            (claim_id, project_id),
        ).fetchone()
        return row is not None

    def _task_name_exists(self, *, conn, project_id: str, name: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM tasks WHERE project_id = ? AND lower(name) = lower(?) LIMIT 1",
            (project_id, name),
        ).fetchone()
        return row is not None

    def _node_exists(self, *, conn, project_id: str, node_id: str) -> bool:
        table = "experiments" if node_id.startswith("exp_") else "tasks"
        row = conn.execute(
            f"SELECT 1 FROM {table} WHERE id = ? AND project_id = ? LIMIT 1",
            (node_id, project_id),
        ).fetchone()
        return row is not None

    def _experiment_name_exists(self, *, conn, project_id: str, name: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM experiments WHERE project_id = ? AND lower(name) = lower(?) LIMIT 1",
            (project_id, name),
        ).fetchone()
        return row is not None

    def _non_terminal_experiments(self, *, conn, project_id: str) -> list[str]:
        terminal = ", ".join(
            f"'{status}'" for status in sorted(EXPERIMENT_TERMINAL_STATUSES)
        )
        rows = conn.execute(
            f"""
            SELECT name, id FROM experiments
            WHERE project_id = ? AND status NOT IN ({terminal})
            ORDER BY created_at, id
            """,
            (project_id,),
        ).fetchall()
        return [str(row["name"] or row["id"]) for row in rows]

    def _materialize_change_spec(self, *, conn, reflection: dict[str, Any]) -> None:
        """Apply the reviewer-approved belief-state update.

        This is called only from the publish transition after the review gate
        passes. Rejected reflections never reach this function, so speculative
        claim edits or experiment specs do not leak into project state.
        """
        project_id = str(reflection["project_id"])
        reflection_id = str(reflection["id"])
        spec = self._pinned_change_spec(conn=conn, reflection=reflection)
        key_to_claim_id = self._materialize_claim_changes(
            conn=conn,
            project_id=project_id,
            reflection_id=reflection_id,
            changes=spec.get("claim_changes") or [],
        )
        self._materialize_wave(
            conn=conn,
            project_id=project_id,
            reflection_id=reflection_id,
            key_to_claim_id=key_to_claim_id,
            experiments=spec["decision"].get("experiments") or [],
            tasks=spec["decision"].get("tasks") or [],
        )

    def _materialize_claim_changes(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        changes: list[dict[str, Any]],
    ) -> dict[str, str]:
        key_to_claim_id: dict[str, str] = {}
        for change in changes:
            op = str(change["op"])
            key = str(change.get("key") or "").strip()
            if op == "create":
                claim_id = self._create_claim(
                    conn=conn,
                    project_id=project_id,
                    reflection_id=reflection_id,
                    statement=str(change.get("statement") or ""),
                    scope=str(change.get("scope") or ""),
                    status=str(change.get("status") or "active"),
                    confidence=str(change.get("confidence") or "medium"),
                    rationale=str(change.get("rationale") or ""),
                )
                if key:
                    key_to_claim_id[key] = claim_id
            else:
                claim_id = str(change["claim_id"]).strip()
                self._update_claim(
                    conn=conn,
                    project_id=project_id,
                    reflection_id=reflection_id,
                    claim_id=claim_id,
                    statement=(
                        str(change["statement"]) if "statement" in change else None
                    ),
                    scope=str(change["scope"]) if "scope" in change else None,
                    status=(
                        str(change["status"])
                        if change.get("status") is not None
                        else None
                    ),
                    confidence=(
                        str(change["confidence"])
                        if change.get("confidence") is not None
                        else None
                    ),
                    rationale=str(change.get("rationale") or ""),
                )
            conn.execute(
                """
                INSERT INTO reflection_claim_changes
                  (reflection_id, claim_id, op, claim_key, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (reflection_id, claim_id, op, key, now_iso()),
            )
        return key_to_claim_id

    def _materialize_wave(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        key_to_claim_id: dict[str, str],
        experiments: list[dict[str, Any]],
        tasks: list[dict[str, Any]],
    ) -> None:
        """Create the wave's nodes, then its DAG edges.

        Two passes: every node exists before any edge is recorded, so a task
        may depend on an experiment proposed later in the spec and vice versa.
        A task's brief is pinned from the proposal — the reflection authored
        the finish line, the executor should not have to retype it.
        """
        key_to_node_id: dict[str, str] = {}
        pending_edges: list[tuple[str, list[str]]] = []
        for proposal in tasks:
            proposal_key = str(proposal.get("key") or "").strip()
            task = self.tasks.create_from_reflection(
                conn=conn,
                project_id=project_id,
                reflection_id=reflection_id,
                name=str(proposal.get("name") or ""),
                goal=str(proposal.get("goal") or ""),
                deliverables=[
                    str(item)
                    for item in (
                        proposal.get("deliverables")
                        if proposal.get("deliverables") is not None
                        else proposal.get("done_when") or []
                    )
                ],
                proposal_key=proposal_key,
            )
            task_id = str(task["id"])
            if proposal_key:
                key_to_node_id[proposal_key] = task_id
            conn.execute(
                """
                INSERT INTO reflection_tasks
                  (reflection_id, task_id, proposal_key, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (reflection_id, task_id, proposal_key, now_iso()),
            )
            # create_from_reflection pinned the rendered brief already.
            pending_edges.append((task_id, depends_on_refs(proposal)))
        for proposal in experiments:
            claim_ids = [key_to_claim_id.get(ref, ref) for ref in claim_refs(proposal)]
            proposal_key = str(proposal.get("key") or "").strip()
            experiment = self.experiments.create_from_reflection(
                conn=conn,
                project_id=project_id,
                reflection_id=reflection_id,
                name=str(proposal.get("name") or ""),
                intent=str(proposal.get("intent") or ""),
                details=str(proposal.get("details") or ""),
                tested_claim_ids=claim_ids,
                proposal_key=proposal_key,
                parallelism=str(proposal.get("parallelism") or ""),
            )
            experiment_id = str(experiment["id"])
            if proposal_key:
                key_to_node_id[proposal_key] = experiment_id
            conn.execute(
                """
                INSERT INTO reflection_experiments
                  (reflection_id, experiment_id, proposal_key, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (reflection_id, experiment_id, proposal_key, now_iso()),
            )
            pending_edges.append((experiment_id, depends_on_refs(proposal)))
        for node_id, refs in pending_edges:
            if not refs:
                continue
            record_dependencies(
                conn=conn,
                project_id=project_id,
                node_id=node_id,
                depends_on_ids=[key_to_node_id.get(ref, ref) for ref in refs],
            )

    def _create_claim(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        statement: str,
        scope: str,
        status: str,
        confidence: str,
        rationale: str,
    ) -> str:
        claim_id = new_id(prefix="claim")
        statement = statement.strip()
        conn.execute(
            """
            INSERT INTO claims
              (id, project_id, statement, scope, status, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                claim_id,
                project_id,
                statement,
                scope.strip(),
                status,
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
                "statement": statement,
                "scope": scope.strip(),
                "status": status,
                "confidence": confidence,
                "source_reflection_id": reflection_id,
                "rationale": rationale.strip(),
            },
        )
        return claim_id

    def _update_claim(
        self,
        *,
        conn,
        project_id: str,
        reflection_id: str,
        claim_id: str,
        statement: str | None,
        scope: str | None,
        status: str | None,
        confidence: str | None,
        rationale: str,
    ) -> None:
        row = conn.execute(
            """
            SELECT * FROM claims
            WHERE id = ? AND project_id = ?
            """,
            (claim_id, project_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"claim not found: {claim_id}")
        next_statement = (
            str(row["statement"]) if statement is None else statement.strip()
        )
        next_scope = str(row["scope"]) if scope is None else scope.strip()
        next_status = str(row["status"]) if status is None else status
        next_confidence = str(row["confidence"]) if confidence is None else confidence
        conn.execute(
            """
            UPDATE claims
            SET statement = ?, scope = ?, status = ?, confidence = ?
            WHERE id = ?
            """,
            (
                next_statement,
                next_scope,
                next_status,
                next_confidence,
                claim_id,
            ),
        )
        self.store.record_event(
            conn=conn,
            project_id=project_id,
            event_type="claim.updated",
            target_type="claim",
            target_id=claim_id,
            payload={
                "statement": next_statement,
                "scope": next_scope,
                "status": next_status,
                "confidence": next_confidence,
                "source_reflection_id": reflection_id,
                "rationale": rationale.strip(),
            },
        )

    def _current_graph_version_id(self, *, reflection: dict[str, Any]) -> str | None:
        """The current project-graph ARTIFACT id, pinned at publish."""
        artifact = preferred_artifact(
            artifacts=reflection.get("current_attempt_artifacts") or [],
            roles=(PROJECT_GRAPH_ROLE,),
        )
        artifact_id = (artifact or {}).get("id")
        return str(artifact_id) if artifact_id else None

    def _submitted_role_document(
        self,
        *,
        reflection: dict[str, Any],
        roles: tuple[str, ...],
        what: str,
    ) -> ArtifactDocument | None:
        artifact = preferred_artifact(
            artifacts=reflection.get("current_attempt_artifacts") or [],
            roles=roles,
        )
        if artifact is None:
            return None
        return self._read_document(
            artifact_id=str(artifact.get("id") or ""),
            what=what,
        )

    # ---- review return routing ----

    def return_from_review(
        self,
        *,
        conn,
        reflection_id: str,
        route: ReviewReturn,
        revision_context: str,
    ) -> None:
        """Apply the workflow-declared destination and attempt policy."""

        row = self._require_review_source(
            conn=conn,
            reflection_id=reflection_id,
            route=route,
        )
        attempt_index = int(row["attempt_index"]) + int(route.attempt == "new")
        if route.to_status not in ("reflection_review", "consolidating"):
            # The wave leaves the reserved window; the next
            # submit_reflection_artifacts re-validates and re-pins the spec.
            conn.execute(
                "DELETE FROM reflection_reserved_names WHERE reflection_id = ?",
                (reflection_id,),
            )
        conn.execute(
            """
            UPDATE reflections
            SET status = ?, attempt_index = ?,
                revision_context = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                route.to_status,
                attempt_index,
                revision_context,
                now_iso(),
                reflection_id,
            ),
        )
        self.store.record_event(
            conn=conn,
            project_id=row["project_id"],
            event_type=route.event_type,
            target_type="reflection",
            target_id=reflection_id,
            payload={"revision_context": revision_context},
        )

    def _require_review_source(
        self,
        *,
        conn,
        reflection_id: str,
        route: ReviewReturn,
    ):
        row = conn.execute(
            "SELECT * FROM reflections WHERE id = ?", (reflection_id,)
        ).fetchone()
        if row is None:
            raise NotFoundError(f"reflection not found: {reflection_id}")
        if row["status"] not in REFLECTION_WORKFLOW.review_sources(route):
            raise WorkflowError(
                f"reflection wave is {row['status']!r}; only a wave under "
                f"review can be sent back to {route.to_status}"
            )
        return row

    # ---- reflection drift ----

    def reflection_signal(self, *, project_id: str, conn=None) -> dict[str, Any]:
        """How far project state has drifted from the last published reflection.

        Computed on read, never stored. The output backs the soft 'Consider
        running a project reflection' nudge, the Home coverage badge, and the
        hard experiment.create block once project reflection debt reaches the
        blocking threshold.
        """
        owns_conn = conn is None
        if conn is None:
            conn = self.store.connect()
        try:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            terminal = ", ".join(f"'{s}'" for s in sorted(EXPERIMENT_TERMINAL_STATUSES))
            current_terminal = {
                str(row["id"]): str(row["status"])
                for row in conn.execute(
                    f"SELECT id, status FROM experiments WHERE project_id = ? AND status IN ({terminal})",
                    (project_id,),
                ).fetchall()
            }
            current_claims = {
                str(row["id"]): str(row["status"])
                for row in conn.execute(
                    "SELECT id, status FROM claims WHERE project_id = ?",
                    (project_id,),
                ).fetchall()
            }
            published = self.latest_published(conn=conn, project_id=project_id)
            open_wave = self.open_reflection(conn=conn, project_id=project_id)
            task_terminal = ", ".join(
                f"'{status}'" for status in sorted(TASK_TERMINAL_STATUSES)
            )
            current_terminal_tasks = {
                str(row["id"]): str(row["status"])
                for row in conn.execute(
                    f"SELECT id, status FROM tasks WHERE project_id = ? "
                    f"AND status IN ({task_terminal})",
                    (project_id,),
                ).fetchall()
            }
            return reflection_signal_state(
                current_terminal=current_terminal,
                current_claims=current_claims,
                published=published,
                open_wave=open_wave,
                current_terminal_tasks=current_terminal_tasks,
            )
        finally:
            if owns_conn:
                conn.close()


def _git_sha(value: Any) -> str:
    sha = str(value or "").strip().lower()
    if not (40 <= len(sha) <= 64) or any(
        character not in "0123456789abcdef" for character in sha
    ):
        raise ValidationError("Git SHA must be a full hexadecimal object id")
    return sha
