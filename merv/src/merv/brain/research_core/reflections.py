# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Reflection records, immutable evidence, and reviewed publication transactions.

Workflow definitions own decisions, validation, assignments, and composition.
This adapter supplies project-scoped facts and keeps the native record, sealed
evidence, reserved names, central receipts, and materialized wave consistent.
"""

from __future__ import annotations

from contextlib import closing, suppress
import json
from typing import Any

from ..agent_sessions import WorkspaceAdvances
from ..workflows import Binding, PROJECT_GRAPH_ROLE, REFLECTION_LENS_DOC_ROLE, TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE
from ..workflows.definitions import reflection_corpus as corpus
from ..workflows import (
    ArtifactDocument,
    artifact_state_record,
    claim_refs,
    depends_on_refs,
    parse_change_spec,
    preferred_artifact,
    reflection_coverage_for,
    require_artifact_document,
    validate_reflection_roster,
)
from .dependencies import record_dependencies
from .experiments import ExperimentService
from .tasks import TaskService
from .artifacts import ResearchArtifacts as Artifacts
from .artifact_models import ArtifactTarget
from .policy import (
    ACTIVE_EXPERIMENT_CAP,
    EXPERIMENT_TERMINAL_STATUSES,
    TASK_TERMINAL_STATUSES,
    GateEvaluation,
    REFLECTION,
    active_experiment_cap_would_exceed_message,
    covered_terminal_ids,
    reflection_signal_state,
    snapshot_from_id,
)
from .records import RecordHooks, RecordKnowledge, Records
from ..workflows import Reference, Snapshot, documents
from ..kernel.utils import ContentUnavailableError
from ..kernel.state.store import (
    BaseStateStore,
    row_to_dict,
    rows_to_dicts,
)
from ..kernel.utils import (
    NotFoundError,
    ValidationError,
    WorkflowError,
    new_id,
    now_iso,
)

# Which child action a parent action closes, and the states that hold this
# wave's reserved names: entering one from a pinning edge reserves the
# validated spec's names, and leaving them releases the rows.
CLOSES_CHILDREN = {"submit_reflections": "submit"}
PINS_WAVE_NAMES = ("submit_reflection_artifacts", "begin_consolidation")
HOLDS_WAVE_NAMES = ("reflection_review", "consolidating")


def _query(conn, sql: str, parameters: tuple[Any, ...]) -> list[dict[str, Any]]:
    return rows_to_dicts(rows=conn.execute(sql, parameters).fetchall())


def _literals(values) -> str:
    """A fixed set of declared statuses, spelled into one IN clause."""
    return ", ".join(f"'{value}'" for value in sorted(values))


def _pins(snapshot: dict[str, Any], proposal: dict[str, Any]) -> bool:
    """A review is current only for the exact proposal and code sha it graded."""
    return (snapshot.get("snapshot_token") == proposal["id"]
            and snapshot.get("code_sha") == proposal["proposal_sha"])


class ReflectionService(RecordHooks):
    """The reflection wave's own rules; its record runs on ``Records``."""

    def __init__(
        self,
        *,
        store: BaseStateStore,
        artifacts: Artifacts,
        experiments: ExperimentService,
        tasks: TaskService,
        records: Records,
        advances: WorkspaceAdvances,
    ) -> None:
        self.store = store
        self.artifacts = artifacts
        self.experiments = experiments
        self.tasks = tasks
        self.records = records
        self.runtime = records.runtime
        self.advances = advances
        records.register(REFLECTION, self)
        self.classify_reservations()

    def classify_reservations(self) -> None:
        """Complete migration 71 using pinned artifact bytes, unavailable to SQL.

        Unknown names and unreadable specs retain one slot; only proven task-only
        names release capacity. This is safe to repeat when storage recovers.
        """
        with self.store.transaction() as conn:
            for row in conn.execute("SELECT DISTINCT reflection_id, project_id, artifact_id FROM reflection_reserved_names").fetchall():
                experiments, tasks = set(), set()
                try:
                    found = self.artifacts.get(artifact_ids=(row["artifact_id"],), project_id=row["project_id"], include="document")
                    document = require_artifact_document(found[0] if found else None, artifact_id=row["artifact_id"], what="change spec")
                    decision = parse_change_spec(text=document.text, path=document.path,
                                                claim_exists=lambda _: True, node_exists=lambda _: True)["decision"]
                    experiments, tasks = ({str(item["name"]).strip().lower() for item in decision.get(kind) or ()}
                                          for kind in ("experiments", "tasks"))
                except (NotFoundError, ValidationError, WorkflowError, ContentUnavailableError):
                    pass
                names = conn.execute("SELECT name_lower FROM reflection_reserved_names WHERE reflection_id = ? AND artifact_id = ?",
                                     (row["reflection_id"], row["artifact_id"])).fetchall()
                for name in names:
                    conn.execute("UPDATE reflection_reserved_names SET experiment_slots = ? WHERE reflection_id = ? AND name_lower = ?",
                                 (int(name["name_lower"] in experiments or name["name_lower"] not in tasks), row["reflection_id"], name["name_lower"]))

    # ---- create ----

    def create(
        self,
        *,
        title: str = "",
        lenses: list[dict[str, Any]] | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return self._create(conn=conn, project_id=project_id, title=title, lenses=lenses)

    def initialize_workflow(self, conn, snapshot: Snapshot) -> None:
        self._create(conn=conn, project_id=snapshot.project_id, instance=snapshot,
                     title=str(snapshot.data.get("title") or ""),
                     lenses=[dict(lens) for lens in snapshot.data.get("lenses") or ()])

    def _create(self, *, conn, project_id, title, lenses, instance=None):
        roster = validate_reflection_roster(lenses=lenses or [])
        fixed = self._corpus_snapshot(conn=conn, project_id=project_id)
        return self.records.create_in_transaction(
            REFLECTION, conn=conn, project_id=project_id, instance=instance,
            values={"title": title.strip(), "roster_json": json.dumps(roster, sort_keys=True),
                    "corpus_json": json.dumps(fixed, sort_keys=True)},
            event={"title": title.strip(), "lenses": [lens["id"] for lens in roster],
                   "corpus_terminal_experiments": len(fixed["terminal_experiments"])},
            read={"include_content": True},
        )

    def before_create(self, *, conn, project_id: str, values: dict[str, Any]) -> None:
        """The project graph is one living artifact: one wave may edit it."""
        terminal = tuple(sorted(REFLECTION.terminal_statuses))
        open_row = conn.execute(
            f"""SELECT id, status FROM reflections WHERE project_id = ?
                AND status NOT IN ({", ".join("?" for _ in terminal)})
                ORDER BY created_seq DESC LIMIT 1""",
            (project_id, *terminal),
        ).fetchone()
        if open_row is not None:
            raise WorkflowError(
                f"a reflection wave is already open: {open_row['id']} is "
                f"{open_row['status']!r}. Finish or abandon it before "
                "starting a new one — the project graph is one living "
                "artifact and only one wave may edit it at a time"
            )

    def _corpus_snapshot(self, *, conn, project_id: str) -> dict[str, Any]:
        """Read the rows this wave freezes; the corpus shape is declared."""
        previous = self.latest_published(conn=conn, project_id=project_id)
        return corpus.corpus_snapshot(
            captured_at=now_iso(), previous=previous,
            experiments=self._terminal_nodes(conn=conn, project_id=project_id, kind="experiment",
                                             statuses=EXPERIMENT_TERMINAL_STATUSES, roles=("report", "graph"),
                                             columns="id, name, attempt_index, status"),
            tasks=self._terminal_nodes(conn=conn, project_id=project_id, kind="task",
                                       statuses=TASK_TERMINAL_STATUSES, roles=(TASK_BRIEF_ROLE, TASK_DELIVERY_ROLE),
                                       columns="id, name, goal, attempt_index, status, outcome, failed_by"),
            claims=_query(conn, "SELECT id, statement, status, confidence, scope FROM claims"
                                " WHERE project_id = ? ORDER BY created_at, id", (project_id,)),
            covered=covered_terminal_ids(None if previous is None else (previous.get("corpus") or {})),
            covered_tasks=covered_terminal_ids(None if previous is None else (previous.get("corpus") or {}),
                                               key="terminal_tasks"))

    def _terminal_nodes(self, *, conn, project_id: str, kind: str, statuses, roles, columns: str):
        """Every finished node of one kind, each naming its authoritative evidence."""
        nodes = _query(conn, f"SELECT {columns} FROM {kind}s WHERE project_id = ? AND status IN "
                             f"({_literals(statuses)}) ORDER BY created_at, id", (project_id,))
        history = self.artifacts.history(tx=conn, target_type=kind,
                                         target_ids=tuple(str(node["id"]) for node in nodes))
        for node in nodes:
            node["artifacts"] = corpus.authoritative_references(
                artifacts=[artifact_state_record(item) for item in history[str(node["id"])].artifacts],
                attempt_index=int(node["attempt_index"]), roles=roles)
        return nodes

    # ---- read ----

    def get_state(self, *, reflection_id: str, project_id: str | None = None, conn=None,
                  include_content: bool = False) -> dict[str, Any]:
        return self.records.get_state(REFLECTION, record_id=reflection_id, project_id=project_id,
                                      conn=conn, include_content=include_content)

    def get_state_with_gate(self, *, reflection_id: str, project_id: str | None = None, conn=None,
                            include_content: bool = False) -> tuple[dict[str, Any], GateEvaluation]:
        return self.records.get_state_with_gate(REFLECTION, record_id=reflection_id, project_id=project_id,
                                                conn=conn, include_content=include_content)

    def hydrate(self, *, conn, project_id: str, records: list[dict[str, Any]], detail_ids=(),
                include_content: bool = False) -> None:
        """Everything a wave is beyond its row: pinned lenses, the corpus it
        reads, what its change spec has materialized, and its code proposal."""
        for data in records:
            reflection_id = str(data["id"])
            self._pin_lens_artifacts(conn=conn, reflection=data)
            if include_content:
                content = self._submitted_bytes(artifact_ids=corpus.referenced_content_ids(
                    corpus=data["corpus"], current=data["current_attempt_artifacts"]))
                data["corpus"] = corpus.hydrated_corpus(
                    corpus=data["corpus"], content=content,
                    claims=self._backfill_claim_fields(conn=conn, claims=data["corpus"].get("claims") or []))
                data["current_attempt_artifacts"] = corpus.hydrated_artifacts(
                    artifacts=data["current_attempt_artifacts"], content=content)
            data["materialized_claims"] = _query(conn, """
                SELECT sc.reflection_id, sc.claim_id, sc.op, sc.claim_key, sc.created_at,
                       c.statement, c.status, c.confidence
                FROM reflection_claim_changes sc JOIN claims c ON c.id = sc.claim_id
                WHERE sc.reflection_id = ? ORDER BY sc.created_at, sc.claim_id""", (reflection_id,))
            data["materialized_experiments"] = _query(conn, """
                SELECT se.reflection_id, se.experiment_id, se.proposal_key, se.created_at,
                       e.name, e.intent, e.status
                FROM reflection_experiments se JOIN experiments e ON e.id = se.experiment_id
                WHERE se.reflection_id = ? ORDER BY se.created_at, se.experiment_id""", (reflection_id,))
            data["materialized_tasks"] = _query(conn, """
                SELECT st.reflection_id, st.task_id, st.proposal_key, st.created_at, t.name, t.goal, t.status
                FROM reflection_tasks st JOIN tasks t ON t.id = st.task_id
                WHERE st.reflection_id = ? ORDER BY st.created_at, st.task_id""", (reflection_id,))
            data["consolidation"] = self._consolidation_state(conn=conn, reflection=data)
            proposal = data["consolidation"].get("proposal") or {}
            if proposal:
                data["snapshot_token"] = str(proposal.get("id") or "")
                data["code_sha"] = str(proposal.get("proposal_sha") or "")
            data["reflection_coverage"] = reflection_coverage_for(reflection=data)
            data["project_graph_diff"] = self._project_graph_diff(conn=conn, reflection=data)

    def _pin_lens_artifacts(self, *, conn, reflection: dict[str, Any]) -> None:
        """A submitted lens child freezes its contribution: the pinned artifact
        stays current even after a newer upload for the same lens."""
        workflow_row = conn.execute(
            "SELECT data_json, revision FROM workflow_instances WHERE id = ? AND project_id = ?",
            (reflection["id"], reflection["project_id"]),
        ).fetchone()
        if workflow_row is None:
            return
        pinned = dict(json.loads(workflow_row["data_json"]).get("lens_artifacts") or {})
        children = conn.execute(
            "SELECT child_key, data_json FROM workflow_instances WHERE parent_id = ? AND parent_revision = ? "
            "AND project_id = ? AND outcome = 'submitted'",
            (reflection["id"], workflow_row["revision"], reflection["project_id"]),
        ).fetchall()
        pinned.update((child["child_key"], json.loads(child["data_json"])["artifact_id"]) for child in children)
        if not pinned:
            return
        by_id = {(item.get("lens_id"), item["id"]): item for item in reflection["artifacts"]}
        for item in reflection["artifacts"]:
            if item.get("artifact_id") and item.get("attempt_index") == reflection["attempt_index"]:
                by_id.setdefault((item.get("lens_id"), item["artifact_id"]), item)
        reflection["current_attempt_artifacts"] = [
            item for item in reflection["current_attempt_artifacts"]
            if item.get("role") != REFLECTION_LENS_DOC_ROLE or item.get("lens_id") not in pinned
        ] + [by_id[key] for key in ((lens, artifact) for lens, artifact in pinned.items()) if key in by_id]

    def read_fact(self, *, conn, record: dict[str, Any], reference: Reference):
        """The world a change spec is parsed against."""
        if reference.kind != "reflection_world" or reference.id != record["project_id"]:
            return None
        claims = conn.execute("SELECT id FROM claims WHERE project_id = ?", (reference.id,)).fetchall()
        experiments = conn.execute("SELECT id, name, status FROM experiments WHERE project_id = ? ORDER BY created_at, id", (reference.id,)).fetchall()
        tasks = conn.execute("SELECT id, name FROM tasks WHERE project_id = ?", (reference.id,)).fetchall()
        return {"claim_ids": tuple(row["id"] for row in claims),
                "experiment_names": tuple(str(row["name"]).lower() for row in experiments),
                "task_names": tuple(str(row["name"]).lower() for row in tasks),
                "node_ids": tuple(row["id"] for row in (*experiments, *tasks)),
                "non_terminal_experiments": tuple(str(row["name"] or row["id"]) for row in experiments
                                                  if row["status"] not in EXPERIMENT_TERMINAL_STATUSES)}

    def _consolidation_state(self, *, conn, reflection: dict[str, Any]) -> dict[str, Any]:
        """Where code consolidation stands: its latest proposal and its receipt."""
        proposal = row_to_dict(row=conn.execute(
            "SELECT * FROM consolidation_proposals WHERE reflection_id = ? ORDER BY revision DESC LIMIT 1",
            (reflection["id"],)).fetchone())
        decisions: list[dict[str, Any]] = []
        review = advance = None
        if proposal is not None:
            proposal["validation"] = json.loads(str(proposal.pop("validation_json", "{}")))
            decisions = _query(conn, "SELECT * FROM consolidation_decisions WHERE proposal_id = ? "
                                     "ORDER BY experiment_id", (proposal["id"],))
            advance = self._advance_view(
                self.advances.latest(conn=conn, proposal_ids=(str(proposal["id"]),)).get(str(proposal["id"])))
            review = next((
                {key: item.get(key) for key in ("id", "role", "verdict", "created_at", "synopsis")}
                for item in reflection.get("reviews", []) if item.get("role") == "consolidation_reviewer"
                and _pins(snapshot_from_id(snapshot_id=str(item.get("target_snapshot_id") or "")), proposal)), None)
        return corpus.consolidation_state(proposal=proposal, decisions=decisions, review=review, advance=advance,
                                          corpus=reflection.get("corpus") or {})

    def _submitted_bytes(self, *, artifact_ids: tuple[str, ...]) -> dict[str, bytes | None]:
        """The immutable bytes behind every content id this wave shows."""
        return {artifact.id: artifact.data for artifact
                in self.artifacts.get(artifact_ids=artifact_ids, include="content")}

    def _backfill_claim_fields(self, *, conn, claims: list[Any]) -> list[dict[str, Any]]:
        """Snapshots taken before claims carried text get it joined in live.

        The claim SET stays pinned by the snapshot; a claim deleted since keeps
        its snapshotted id and status.
        """
        rows = [dict(claim) for claim in claims if isinstance(claim, dict)]
        missing = tuple(str(row.get("id") or "") for row in rows if "statement" not in row)
        if not missing:
            return rows
        live = {str(record["id"]): record for record in _query(
            conn, "SELECT id, statement, confidence, scope FROM claims"
                  f" WHERE id IN ({', '.join('?' * len(missing))})", missing)}
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

    def experiment_consolidations(self, *, project_id: str,
                                  experiment_ids: tuple[str, ...]) -> dict[str, list[dict[str, Any]]]:
        """Every consolidation decision each experiment has received, with its receipt."""
        ids = tuple(dict.fromkeys(value for value in experiment_ids if value))
        result: dict[str, list[dict[str, Any]]] = {experiment_id: [] for experiment_id in ids}
        if not ids:
            return result
        with closing(self.store.connect()) as conn:
            self.store.require_project_id(conn=conn, project_id=project_id)
            rows = _query(conn, "SELECT d.*, p.reflection_id, p.revision, p.base_sha, p.proposal_sha, p.summary, "
                                "p.created_at FROM consolidation_decisions d "
                                "JOIN consolidation_proposals p ON p.id = d.proposal_id WHERE p.project_id = ? "
                                f"AND d.experiment_id IN ({', '.join('?' * len(ids))}) ORDER BY p.created_at, p.revision",
                          (project_id, *ids))
            receipts = self.advances.latest(conn=conn, proposal_ids=tuple(
                dict.fromkeys(str(row["proposal_id"]) for row in rows)))
            for item in rows:
                receipt = receipts.get(str(item["proposal_id"])) or {}
                item.update(advance_status=receipt.get("status"), central_sha=receipt.get("observed_sha"),
                            bound_at=receipt.get("bound_at"))
                # A decision the wave never reached is pending in the wave's own
                # view; a recorded one has already been considered.
                item.update(corpus.integration_outcome(decision=item, ancestry=receipt.get("ancestry") or {},
                                                       unapplied=("reviewed_not_used", "superseded")))
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
        terminal = tuple(sorted(REFLECTION.terminal_statuses))
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
            (project_id, REFLECTION.success_status),
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

    def _project_graph_diff(self, *, conn, reflection: dict[str, Any]) -> dict[str, Any]:
        """Compare this wave's graph with the last published one, or say why not."""
        published = reflection.get("status") == REFLECTION.success_status
        # published_graph_version_id holds the artifact id pinned at publish.
        current = str((reflection.get("published_graph_version_id") if published else None)
                      or (self._project_graph_artifact(reflection=reflection) or {}).get("id") or "")
        base = self._previous_published_graph_ref(conn=conn, reflection=reflection)
        comparable = current and base and base.get("graph_version_id")
        return corpus.graph_comparison(
            base=base, current_graph_version_id=current, current_reflection_id=reflection.get("id"),
            read={} if not comparable else {
                artifact_id: self._graph_text(artifact_id=artifact_id, what=f"{side} project logic graph")
                for artifact_id, side in ((str(base["graph_version_id"]), "previous"), (current, "current"))})

    def _graph_text(self, *, artifact_id: str, what: str) -> dict[str, str]:
        """One submitted graph as strict UTF-8, or why it could not be read."""
        try:
            return {"text": self._read_document(artifact_id=artifact_id, what=what).text}
        except WorkflowError as exc:
            return {"error": str(exc)}

    def _previous_published_graph_ref(
        self, *, conn, reflection: dict[str, Any]
    ) -> dict[str, Any] | None:
        project_id = str(reflection.get("project_id") or "")
        status = str(reflection.get("status") or "")
        current_id = str(reflection.get("id") or "")
        params: tuple[Any, ...]
        if status == REFLECTION.success_status:
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
                REFLECTION.success_status,
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
            params = (project_id, REFLECTION.success_status)
        row = conn.execute(query, params).fetchone()
        if row is None:
            return None
        return {
            "reflection_id": row["id"],
            "graph_version_id": row["published_graph_version_id"],
        }

    def _read_document(self, *, artifact_id: str, what: str) -> ArtifactDocument:
        """Read one complete artifact as strict UTF-8 for a workflow gate."""
        if not artifact_id:
            raise WorkflowError(
                f"{what} has no submitted artifact — submit it with artifact.upload"
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

    def bindings(self) -> dict[str, Binding]:
        """The lens and the published wave: graphs this service owns without a row."""
        return {"reflection_lens": Binding(self._lens_knowledge, self._commit_lens_change, self.initialize_lens),
                "research_wave": Binding(self._wave_knowledge, self._commit_wave_change, self.initialize_wave)}

    def _lens_knowledge(self, snapshot: Snapshot, conn):
        reflection = self.get_state(reflection_id=str(snapshot.data["reflection_id"]), project_id=snapshot.project_id, conn=conn)
        if str(snapshot.data["lens_id"]) not in {str(item["id"]) for item in reflection["roster"]}:
            raise WorkflowError("lens does not belong to this reflection's fixed roster")
        return RecordKnowledge(self.records, REFLECTION, conn, reflection, snapshot)

    def initialize_lens(self, conn, snapshot: Snapshot) -> None:
        parent = conn.execute(
            "SELECT p.id, p.project_id, p.revision, p.state, c.parent_revision, c.child_key "
            "FROM workflow_instances c JOIN workflow_instances p ON p.id = c.parent_id WHERE c.id = ?",
            (snapshot.id,),
        ).fetchone()
        if (parent is None or parent["id"] != snapshot.data.get("reflection_id") or parent["project_id"] != snapshot.project_id
                or parent["child_key"] != snapshot.data.get("lens_id") or parent["state"] != "reflecting"
                or parent["revision"] != parent["parent_revision"]):
            raise WorkflowError("Reflection lenses must be created by their parent's fixed composition.")
        knowledge = self._lens_knowledge(snapshot, conn)
        reflection = knowledge.read(Reference("reflection", parent["id"]))
        if int(snapshot.data.get("attempt_index") or 0) != int(reflection["attempt_index"]):
            raise WorkflowError("Reflection lens attempt does not match its parent.")
        if snapshot.outcome == "submitted":
            self._commit_lens_change(conn, snapshot, snapshot, "adopt_lens", {})

    def _wave_knowledge(self, snapshot: Snapshot, conn):
        reflection = self.get_state(reflection_id=str(snapshot.data.get("reflection_id") or ""),
                                    project_id=snapshot.project_id, conn=conn)
        if reflection["status"] != "published":
            raise WorkflowError("A research wave can start only from a published reflection.")
        return RecordKnowledge(self.records, REFLECTION, conn, reflection, snapshot)

    def initialize_wave(self, conn, snapshot: Snapshot) -> None:
        self._wave_knowledge(snapshot, conn)
        row = conn.execute("SELECT start_key FROM workflow_instances WHERE id = ? AND project_id = ?",
                           (snapshot.id, snapshot.project_id)).fetchone()
        key = f"reflection-wave:{snapshot.data['reflection_id']}"
        if row["start_key"] != f"client:{key}":
            raise WorkflowError(f"A published reflection has one research wave; start it with request_id={key!r}.")

    @staticmethod
    def _commit_wave_change(conn, before, after, action, payload) -> None:
        # The composition owns only workflow state; member records are bound
        # independently and retain their own state, revisions, and effects.
        return None

    def migrate_workflow_instances(self, conn) -> None:
        """Explicit v1 adoption of fixed lens sets after the kernel backfill.

        Completed, validated submissions enter at the named submitted outcome;
        unfinished lenses alone receive new work. Each adoption is recorded by
        the runtime and idempotent across startup retries.
        """
        rows = conn.execute(
            "SELECT id, project_id, revision FROM workflow_instances w WHERE workflow = 'reflection' "
            "AND version = 1 AND state = 'reflecting' AND NOT EXISTS "
            "(SELECT 1 FROM workflow_instances c WHERE c.parent_id = w.id AND c.parent_revision = w.revision)",
        ).fetchall()
        for row in rows:
            reflection = self.get_state(reflection_id=row["id"], project_id=row["project_id"], conn=conn)
            validate_reflection_roster(lenses=reflection["roster"])
            self.runtime.adopt_children(conn=conn, project_id=row["project_id"], instance_id=row["id"],
                                        expected_revision=row["revision"], request_id="reflection_lenses:v1")

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
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            reflection = self.get_state(reflection_id=reflection_id, project_id=project_id, conn=conn)
            if reflection["status"] != "consolidating":
                raise WorkflowError("consolidation proposals are accepted only after the "
                                    "authoritative reflection review has passed")
            if self.advances.unsettled(conn=conn, instance_id=reflection_id):
                raise WorkflowError("cannot replace a consolidation proposal while its central "
                                    "advance is in progress or already bound")
            self._record_proposal(conn=conn, reflection=reflection, proposal=documents.sealed_consolidation_proposal(
                summary=summary, validation=validation, producer_session_id=producer_session_id,
                base_sha=base_sha, proposal_sha=proposal_sha, decisions=decisions,
                expected_experiments={str(item["id"]) for item
                                      in (reflection.get("corpus") or {}).get("terminal_experiments") or ()
                                      if isinstance(item, dict) and item.get("id")}))
            # The graph pins exactly this proposal and requests its review; the
            # kind's declared commit columns clear the revision request.
            return self._transition_in_tx(conn=conn, reflection=reflection, transition="submit_consolidation")

    def _record_proposal(self, *, conn, reflection: dict[str, Any], proposal: dict[str, Any]) -> None:
        """Write the sealed proposal, its per-experiment decisions and its event."""
        reflection_id, project_id, now = str(reflection["id"]), str(reflection["project_id"]), now_iso()
        proposal_id = new_id(prefix="cpr")
        revision = int(((reflection.get("consolidation") or {}).get("proposal") or {}).get("revision") or 0) + 1
        conn.execute(
            "INSERT INTO consolidation_proposals (id, reflection_id, project_id, revision, base_sha, proposal_sha, "
            "summary, validation_json, created_by_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (proposal_id, reflection_id, project_id, revision, proposal["base_sha"], proposal["proposal_sha"],
             proposal["summary"], proposal["validation_json"], proposal["created_by_session_id"], now))
        for decision in proposal["decisions"]:
            conn.execute(
                "INSERT INTO consolidation_decisions (proposal_id, experiment_id, disposition, rationale, "
                "source_sha, integration_kind, superseded_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (proposal_id, decision["experiment_id"], decision["disposition"], decision["rationale"],
                 decision["source_sha"], decision["integration_kind"], decision["superseded_by"], now))
        self.store.record_event(
            conn=conn, project_id=project_id, event_type="reflection.consolidation_proposed",
            target_type="reflection", target_id=reflection_id,
            payload={"proposal_id": proposal_id, "proposal_sha": proposal["proposal_sha"],
                     "base_sha": proposal["base_sha"], "revision": revision,
                     "experiments_considered": len(proposal["decisions"])})

    def require_consolidation_proposal(self, *, conn, reflection: dict[str, Any]) -> None:
        if reflection["status"] != "consolidating":
            return
        decision = self.records.evaluate_gate(REFLECTION, conn=conn, record=reflection).decision
        for action in decision.actions:
            for issue in action.issues:
                if issue.code == "consolidation_proposal_required":
                    raise WorkflowError(issue.message)

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
            self.require_consolidation_proposal(conn=conn, reflection=reflection)
            if gate.review is None or not gate.review.satisfied:
                raise WorkflowError(
                    "the exact consolidation proposal must pass independent "
                    "review before central can advance"
                )
            proposal = (reflection.get("consolidation") or {}).get("proposal") or {}
            advance, previous = self.advances.intend(
                conn=conn,
                instance_id=reflection_id,
                proposal_id=proposal["id"],
                expected_sha=proposal["base_sha"],
                target_sha=proposal["proposal_sha"],
                runner_id=runner_id,
            )
            if previous != runner_id:
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="reflection.central_advance_intended",
                    target_type="reflection",
                    target_id=reflection_id,
                    payload={
                        "advance_id": advance["id"],
                        "proposal_id": proposal["id"],
                        "expected_sha": proposal["base_sha"],
                        "target_sha": proposal["proposal_sha"],
                        "runner_id": runner_id,
                        **({"previous_runner_id": previous, "takeover": True} if previous else {}),
                    },
                )
            return self._advance_payload(conn=conn, advance=advance)

    @staticmethod
    def _advance_view(receipt: dict[str, Any] | None) -> dict[str, Any] | None:
        """One receipt in this wave's own words: the instance it names is the wave."""
        if receipt is None:
            return None
        return {"reflection_id" if key == "instance_id" else key: value for key, value in receipt.items()}

    def _advance_payload(self, *, conn, advance: dict[str, Any]) -> dict[str, Any]:
        """The receipt plus the experiment branches its proposal carried."""
        return {
            **(self._advance_view(advance) or {}),
            "sources": rows_to_dicts(rows=conn.execute(
                "SELECT experiment_id, source_sha, integration_kind FROM consolidation_decisions "
                "WHERE proposal_id = ? AND integration_kind != 'none' ORDER BY experiment_id",
                (advance["proposal_id"],),
            ).fetchall()),
        }

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
        observed_sha = documents.git_sha(observed_sha)
        parents = tuple(documents.git_sha(value) for value in (proposal_parents or []))
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
            receipt = self.advances.receipt(conn=conn, advance_id=advance_id)
            reflection_id = self._proposal_owner(conn=conn, proposal_id=str(receipt["proposal_id"]),
                                                 project_id=project_id)
            wave_status = str(conn.execute(
                "SELECT status FROM reflections WHERE id = ?", (reflection_id,)).fetchone()["status"])
            orphaned = (
                wave_status in REFLECTION.terminal_statuses
                and wave_status != REFLECTION.success_status
            )
            if not orphaned and receipt["status"] != "bound" and observed_sha == str(receipt["target_sha"]):
                self._require_carried_ancestry(conn=conn, proposal_id=str(receipt["proposal_id"]),
                                               ancestry=ancestry)
            # The wave closed while the receipt was in flight (abandon is legal
            # until a receipt is bound): never bind or publish into a terminal
            # wave — record the orphaned CAS for the operator.
            advance = self.advances.settle(
                conn=conn, advance_id=advance_id, runner_id=runner_id, observed_sha=observed_sha,
                proposal_parents=parents, diffstat=diffstat_json, ancestry=ancestry_json, error=error,
                stale_reason=(f"wave {wave_status} before settle — central advance orphaned"
                              if orphaned else ""),
            )
            if advance["status"] == "stale":
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
                        **({"reason": f"wave {wave_status} before settle"} if orphaned else {}),
                    },
                )
            if advance["status"] != "bound":
                return self.get_state(reflection_id=reflection_id, conn=conn, include_content=True)
        # The bound receipt is durable before publish is attempted: the Git
        # ref already moved, so a publish failure must mark the advance, not
        # unwind the record of an irreversible external fact.
        return self._publish_bound_advance(
            advance_id=advance_id,
            reflection_id=reflection_id,
            project_id=project_id,
        )

    def _proposal_owner(self, *, conn, proposal_id: str, project_id: str) -> str:
        """The wave one proposal belongs to, refused across a project boundary."""
        row = conn.execute(
            "SELECT reflection_id FROM consolidation_proposals WHERE id = ? AND project_id = ?",
            (proposal_id, project_id)).fetchone()
        if row is None:
            raise NotFoundError(f"central advance not found: {proposal_id}")
        return str(row["reflection_id"])

    def _require_carried_ancestry(self, *, conn, proposal_id: str, ancestry: dict[str, bool]) -> None:
        """The runner's independent ancestry result must cover the code it carried."""
        carried = {
            str(row["experiment_id"]): str(row["integration_kind"])
            for row in conn.execute(
                "SELECT experiment_id, integration_kind FROM consolidation_decisions "
                "WHERE proposal_id = ? AND integration_kind != 'none'", (proposal_id,)).fetchall()
        }
        if set(ancestry) != set(carried):
            raise ValidationError("ancestry receipt must cover every experiment whose code was carried")
        mismatches = sorted(experiment_id for experiment_id, kind in carried.items()
                            if kind in {"merge", "fast_forward"} and ancestry[experiment_id] is not True)
        if mismatches:
            raise ValidationError("ancestry must be true for merge or fast-forward sources: "
                                  + ", ".join(mismatches))

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
                self.advances.note(conn=conn, advance_id=advance_id, error="")
                reflection = self.get_state(reflection_id=reflection_id, project_id=project_id,
                                            conn=conn, include_content=True)
                if str(reflection.get("status")) == REFLECTION.success_status:
                    return reflection  # A retried settle after a publish is idempotent.
                return self._transition_in_tx(conn=conn, reflection=reflection, transition="publish")
        except Exception as exc:
            with suppress(Exception):
                with self.store.transaction() as conn:
                    row = conn.execute(
                        "SELECT status FROM reflections WHERE id = ?",
                        (reflection_id,),
                    ).fetchone()
                    if (
                        row is None
                        or str(row["status"]) != REFLECTION.success_status
                    ):
                        # An ambiguous COMMIT ack can raise after publication
                        # landed; never let the diagnostic outlive a success.
                        self.advances.note(conn=conn, advance_id=advance_id,
                                           error=f"publish blocked after bind: {str(exc)[:900]}")
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
            return self._transition_in_tx(
                conn=conn, transition=transition,
                reflection=self.get_state(reflection_id=reflection_id, project_id=project_id, conn=conn),
            )

    def _transition_in_tx(self, *, conn, reflection: dict[str, Any], transition: str,
                          payload: dict[str, Any] | None = None) -> dict[str, Any]:
        reflection_id = str(reflection["id"])
        current = self.runtime.adopt(conn=conn, project_id=reflection["project_id"], instance_id=reflection_id,
                                     workflow="reflection", state=reflection["status"],
                                     data={"attempt_index": reflection["attempt_index"]})
        # Compatibility for the released bulk-submit tool: the child action the
        # parent's edge declares still runs on each open child, so the last one
        # fires the same guarded join an independent lens agent would.
        for child in self._open_children(conn=conn, parent=current, transition=transition):
            self.runtime.apply_in_transaction(conn=conn, project_id=current.project_id, instance_id=child.id,
                                              action=CLOSES_CHILDREN[transition], expected_revision=child.revision,
                                              request_id=new_id(prefix="lens_submission"))
        if transition in CLOSES_CHILDREN:
            # The final child's guarded join already applied the parent action.
            current = self.runtime.get(project_id=current.project_id, instance_id=reflection_id, conn=conn)
            if current.state != reflection["status"]:
                return self.get_state(reflection_id=reflection_id, conn=conn, include_content=True)
        self.runtime.apply_in_transaction(conn=conn, project_id=current.project_id, instance_id=reflection_id,
                                          action=transition, expected_revision=current.revision,
                                          request_id=new_id(prefix="reflection_action"), payload=payload or {})
        return self.get_state(reflection_id=reflection_id, conn=conn, include_content=True)

    def _open_children(self, *, conn, parent: Snapshot, transition: str):
        """Every child of this wait node that has not committed its own exit."""
        if transition not in CLOSES_CHILDREN or parent.workflow != "reflection":
            return ()
        return [state for child in parent.children if not child.outcome
                and not (state := self.runtime.get(project_id=parent.project_id, instance_id=child.id,
                                                   conn=conn)).outcome]

    def after_commit(self, *, conn, before, after, action: str, payload) -> None:
        """What a wave transition means beyond its declared column writes.

        Reserved names follow the states that hold them: a pinning edge
        reserves the validated spec's names, and leaving those states releases
        the rows. ``submit_reflection_artifacts`` shares the transaction that
        world-validated the spec; ``begin_consolidation`` re-pins, so a spec
        revised and re-reviewed during reflection_review (review freshness
        guarantees the newest spec IS the reviewed one) is the one publication
        materializes.
        """
        if action in PINS_WAVE_NAMES:
            self._reserve_wave_names(conn=conn, reflection=self.get_state(
                reflection_id=before.id, project_id=before.project_id, conn=conn))
        if action == "publish":
            self._materialize_change_spec(conn=conn, reflection=self.get_state(
                reflection_id=before.id, project_id=before.project_id, conn=conn))
        if action != "migrate" and REFLECTION.status_of(after.state) not in HOLDS_WAVE_NAMES:
            conn.execute("DELETE FROM reflection_reserved_names WHERE reflection_id = ?", (before.id,))

    def before_commit(self, *, conn, before, after, action: str) -> None:
        """A bound receipt means central already advanced: the only legal exit
        is publish (the runner retries settle), so a terminal exit here would
        strand the reviewed belief-state update forever."""
        status = REFLECTION.status_of(after.state)
        if status not in REFLECTION.terminal_statuses or status == REFLECTION.success_status:
            return
        unsettled = self.advances.unsettled(conn=conn, instance_id=before.id)
        if unsettled.get("status") == "bound":
            raise WorkflowError(
                "central has already advanced for this wave (bound receipt "
                f"{unsettled['id']}); publication completes via the runner's "
                "settle retry — the wave cannot be abandoned once bound")
        # Cancel open intents so a settle that raced this exit records an
        # orphaned CAS instead of binding into a terminal wave.
        self.advances.cancel(conn=conn, instance_id=before.id, reason="wave abandoned before settle")

    def _commit_lens_change(self, conn, before, after, action, payload) -> None:
        if action in {"submit", "adopt_lens"}:
            target = ArtifactTarget("reflection", str(before.data["reflection_id"]), before.project_id)
            existing = conn.execute(
                "SELECT id FROM research_artifacts WHERE project_id = ? AND target_type = 'reflection' "
                "AND target_id = ? AND attempt_index = ? AND role = 'reflection_lens_doc' AND lens_id = ? "
                "AND artifact_id = ? AND status = 'complete' ORDER BY created_seq LIMIT 1",
                (before.project_id, target.target_id, int(before.data["attempt_index"]), before.data["lens_id"], after.data["artifact_id"]),
            ).fetchone()
            if existing is None:
                attached = self.artifacts.attach(tx=conn, artifact_id=str(after.data["artifact_id"]), target=target,
                                                 role=REFLECTION_LENS_DOC_ROLE, lens_id=str(before.data["lens_id"]))
                association_id = attached.id
            else:
                association_id = existing["id"]
            self.artifacts.seal(tx=conn, target=target, transition="submit_lens" if action == "submit" else "adopt_lens",
                                association_ids=(association_id,))

    def _reserve_wave_names(self, *, conn, reflection: dict[str, Any]) -> None:
        """Pin the validated spec and reserve the names its wave will take.

        The reservation rows carry the validated artifact's id, so publish
        materializes exactly the spec whose names were reserved — a change
        spec submitted later never drifts into publication. A tool create
        taking a reserved name mid-wave gets an actionable error at create
        time instead of blocking an already-bound publish (see
        ExperimentService._reject_reserved_wave_name).
        """
        reflection_id, project_id = str(reflection["id"]), str(reflection["project_id"])
        document = self._submitted_role_document(reflection=reflection, roles=("change_spec",), what="change spec")
        if document is None:
            raise WorkflowError("a change spec artifact must be submitted before reflection review")
        world = self._world(conn=conn, project_id=project_id)
        decision = self._parse_change_spec(world=world, document=document).get("decision") or {}
        proposed = {kind: {name for proposal in decision.get(kind) or ()
                           if (name := str(proposal.get("name") or "").strip().lower())}
                    for kind in ("experiments", "tasks")}
        conn.execute("DELETE FROM reflection_reserved_names WHERE reflection_id = ?", (reflection_id,))
        active = len(world["non_terminal_experiments"])
        if active + len(proposed["experiments"]) > ACTIVE_EXPERIMENT_CAP:
            raise WorkflowError(active_experiment_cap_would_exceed_message(
                active_count=active, proposed_count=len(proposed["experiments"])))
        for name in sorted(proposed["experiments"] | proposed["tasks"]):
            # Availability recheck keeps this safe from any caller, not just
            # the gate that world-validated the spec this same transaction.
            for kind, taken in (("experiments", world["experiment_names"]), ("tasks", world["task_names"])):
                if name in proposed[kind] and name in taken:
                    raise WorkflowError(f"{kind[:-1]} name already exists in project: {name}")
            conn.execute("INSERT INTO reflection_reserved_names (reflection_id, project_id, name_lower, artifact_id, experiment_slots) "
                         "VALUES (?, ?, ?, ?, ?)", (reflection_id, project_id, name, document.artifact_id, int(name in proposed["experiments"])))

    def _pinned_change_spec(self, *, conn, reflection: dict[str, Any]) -> dict[str, Any]:
        """The spec pinned when its names were validated and reserved.

        Publish reads the artifact id stored on the wave's reservation rows,
        never the latest submission — a spec submitted after validation cannot
        drift into publication. Availability was checked and reserved in the
        pinning transaction, and by publish the Git advance is already bound,
        so a mutable-world recheck could only wedge the wave.
        """
        row = conn.execute("SELECT artifact_id FROM reflection_reserved_names "
                           "WHERE reflection_id = ? AND artifact_id != '' LIMIT 1",
                           (str(reflection["id"]),)).fetchone()
        # Upgrade path: a wave already consolidating when the pin shipped has
        # no reservation rows; fall back to the current sealed spec (the
        # pre-pin behavior) so its bound publish cannot wedge.
        document = (self._read_document(artifact_id=str(row["artifact_id"]), what="change spec") if row is not None
                    else self._submitted_role_document(reflection=reflection, roles=("change_spec",),
                                                       what="change spec"))
        if document is None:
            raise WorkflowError("a change spec artifact must be submitted before publish")
        return self._parse_change_spec(world=self._world(conn=conn, project_id=str(reflection["project_id"])),
                                       document=document)

    def _world(self, *, conn, project_id: str) -> dict[str, Any]:
        """The project a change spec is read against, as the graph reads it."""
        return self.read_fact(conn=conn, record={"project_id": project_id},
                              reference=Reference("reflection_world", project_id))

    @staticmethod
    def _parse_change_spec(*, world: dict[str, Any], document: ArtifactDocument) -> dict[str, Any]:
        """Parse one spec for reservation and publication, never for creation.

        Name availability and the active cap are the gate's question, asked
        once when the spec is validated; here the names are already this wave's.
        """
        return parse_change_spec(text=document.text, path=document.path,
                                 claim_exists=lambda value: value in world["claim_ids"],
                                 node_exists=lambda value: value in world["node_ids"])

    def _materialize_change_spec(self, *, conn, reflection: dict[str, Any]) -> None:
        """Apply the reviewer-approved belief-state update.

        This is called only from the publish transition after the review gate
        passes. Rejected reflections never reach this function, so speculative
        claim edits or experiment specs do not leak into project state.
        """
        project_id, reflection_id = str(reflection["project_id"]), str(reflection["id"])
        spec = self._pinned_change_spec(conn=conn, reflection=reflection)
        self._materialize_wave(
            conn=conn, project_id=project_id, reflection_id=reflection_id,
            key_to_claim_id=self._materialize_claim_changes(
                conn=conn, project_id=project_id, reflection_id=reflection_id,
                changes=spec.get("claim_changes") or []),
            experiments=spec["decision"].get("experiments") or [],
            tasks=spec["decision"].get("tasks") or [])

    def _materialize_claim_changes(self, *, conn, project_id: str, reflection_id: str,
                                   changes: list[dict[str, Any]]) -> dict[str, str]:
        """Apply each claim edit and remember the keys its wave refers to."""
        by_key: dict[str, str] = {}
        for change in changes:
            op, key = str(change["op"]), str(change.get("key") or "").strip()
            claim_id = (self._create_claim(conn=conn, project_id=project_id, change=change) if op == "create"
                        else self._update_claim(conn=conn, project_id=project_id, change=change))
            if op == "create" and key:
                by_key[key] = claim_id
            self._claim_event(conn=conn, project_id=project_id, reflection_id=reflection_id, op=op,
                              claim_id=claim_id, key=key, change=change)
        return by_key

    def _create_claim(self, *, conn, project_id: str, change: dict[str, Any]) -> str:
        claim_id = new_id(prefix="claim")
        conn.execute(
            "INSERT INTO claims (id, project_id, statement, scope, status, confidence, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (claim_id, project_id, str(change.get("statement") or "").strip(), str(change.get("scope") or "").strip(),
             str(change.get("status") or "active"), str(change.get("confidence") or "medium"), now_iso()))
        return claim_id

    def _update_claim(self, *, conn, project_id: str, change: dict[str, Any]) -> str:
        """Overwrite only the fields the spec named; the rest stand as they are."""
        claim_id = str(change["claim_id"]).strip()
        row = conn.execute("SELECT statement, scope, status, confidence FROM claims WHERE id = ? AND project_id = ?",
                           (claim_id, project_id)).fetchone()
        if row is None:
            raise NotFoundError(f"claim not found: {claim_id}")
        fields = {name: str(row[name]) if change.get(name) is None else str(change[name]).strip()
                  for name in ("statement", "scope", "status", "confidence")}
        conn.execute("UPDATE claims SET statement = ?, scope = ?, status = ?, confidence = ? WHERE id = ?",
                     (*fields.values(), claim_id))
        return claim_id

    def _claim_event(self, *, conn, project_id: str, reflection_id: str, op: str, claim_id: str,
                     key: str, change: dict[str, Any]) -> None:
        row = conn.execute("SELECT statement, scope, status, confidence FROM claims WHERE id = ?",
                           (claim_id,)).fetchone()
        self.store.record_event(
            conn=conn, project_id=project_id, event_type=f"claim.{'created' if op == 'create' else 'updated'}",
            target_type="claim", target_id=claim_id,
            payload={**{name: str(row[name]) for name in ("statement", "scope", "status", "confidence")},
                     "source_reflection_id": reflection_id,
                     "rationale": str(change.get("rationale") or "").strip()})
        conn.execute("INSERT INTO reflection_claim_changes (reflection_id, claim_id, op, claim_key, created_at) "
                     "VALUES (?, ?, ?, ?, ?)", (reflection_id, claim_id, op, key, now_iso()))

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

    # ---- reflection drift ----

    def reflection_signal(self, *, project_id: str, conn=None) -> dict[str, Any]:
        """How far project state has drifted from the last published reflection.

        Computed on read, never stored. The output backs the soft 'Consider
        running a project reflection' nudge, the Home coverage badge, and the
        hard experiment.create block once project reflection debt reaches the
        blocking threshold.
        """
        owns_conn = conn is None
        conn = self.store.connect() if owns_conn else conn
        try:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            return reflection_signal_state(
                current_terminal=self._statuses(conn=conn, project_id=project_id, table="experiments",
                                                statuses=EXPERIMENT_TERMINAL_STATUSES),
                current_terminal_tasks=self._statuses(conn=conn, project_id=project_id, table="tasks",
                                                      statuses=TASK_TERMINAL_STATUSES),
                current_claims=self._statuses(conn=conn, project_id=project_id, table="claims"),
                published=self.latest_published(conn=conn, project_id=project_id),
                open_wave=self.open_reflection(conn=conn, project_id=project_id))
        finally:
            if owns_conn:
                conn.close()

    @staticmethod
    def _statuses(*, conn, project_id: str, table: str, statuses: frozenset[str] | None = None) -> dict[str, str]:
        """The status of every row of one kind the drift signal compares."""
        where = "" if statuses is None else f" AND status IN ({_literals(statuses)})"
        return {str(row["id"]): str(row["status"]) for row
                in conn.execute(f"SELECT id, status FROM {table} WHERE project_id = ?{where}",
                                (project_id,)).fetchall()}
