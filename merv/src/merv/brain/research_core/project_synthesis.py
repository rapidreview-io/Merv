# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research-owned source snapshots and the single current project narrative.

Workflow state/history supply persistence, revision CAS and retained publications.
Research events supply pending work; neither polling nor worker failure consumes it.
"""

from contextlib import closing
import hashlib
import json

from ..kernel.utils import NotFoundError, WorkflowError
from ..literature import Literature
from ..workflows import Binding, Public
from .models import public_record
from .records import query


def instance_id(project_id):
    return f"psyn_{project_id}"


class ProjectSynthesis:
    def __init__(self, *, store, records, workflows):
        self.store, self.records, self.workflows = store, records, workflows
        workflows.bind("project_synthesis", Binding(
            self.knowledge, lambda *args: None, self.reject_extra_instance))

    @staticmethod
    def reject_extra_instance(conn, snapshot):
        raise WorkflowError("Each project already has one synthesis workflow; use its document's maintenance instance_id.")

    def ensure(self, *, conn, project_id):
        return self.workflows.runtime.adopt(conn=conn, project_id=project_id, instance_id=instance_id(project_id),
            workflow="project_synthesis", state="waiting", data={"covered_event": 0})

    def state(self, *, conn, project_id):
        return self.workflows.runtime.get(conn=conn, project_id=project_id, instance_id=instance_id(project_id))

    def pending(self, *, conn, snapshot):
        rows = query(conn, "SELECT id, type, target_type, target_id, payload_json FROM events "
            "WHERE project_id = ? AND id > ? AND target_type IN ('experiment', 'reflection', 'project', 'litreview_section') ORDER BY id",
            (snapshot.project_id, int(snapshot.data.get("covered_event", 0))))
        events = []
        for row in rows:
            payload = json.loads(row.pop("payload_json"))
            if (row["type"] in {"experiment.created", "experiment.transitioned", "reflection.published",
                                "project.context.updated", "litreview.section_edited"}
                or payload.get("workflow") == "experiment"
                or (payload.get("workflow") == "reflection" and payload.get("to") in {"consolidating", "published"})):
                events.append({**row, "from": payload.get("from", ""), "to": payload.get("to", "")})
        return {"events": events}

    @staticmethod
    def basis(*, conn, project_id):
        project = conn.execute("SELECT summary FROM projects WHERE id = ?", (project_id,)).fetchone()
        literature = Literature.summary(conn=conn, project_id=project_id)
        return {"sha256": hashlib.sha256(json.dumps([project["summary"], literature], sort_keys=True).encode()).hexdigest()}

    def capture(self, *, conn, snapshot):
        events = self.pending(conn=conn, snapshot=snapshot)["events"]
        if not events:
            raise WorkflowError("No research changes need synthesis")
        records, refs = [], {(r["kind"], r["id"]): dict(r) for r in snapshot.data.get("references", ())}
        for kind_name, record_id in dict.fromkeys((e["target_type"], e["target_id"]) for e in events):
            if kind_name not in {"experiment", "reflection"}:
                continue
            kind = self.records.kinds[kind_name]
            record = self.records.evidence_snapshot(
                kind, record_id=record_id, project_id=snapshot.project_id, conn=conn)
            selected = {key: record[key] for key in (
                "id", "name", "title", "intent", "status", "attempt_index", "conclusion", "revision_context", "corpus", "reviews"
            ) if key in record}
            refs[(kind_name, record_id)] = {"kind": kind_name, "id": record_id, "label": str(record.get("name") or record.get("title") or record_id)}
            selected["artifacts"] = []
            for artifact in record.get("artifacts", ()):
                artifact_id = artifact.get("artifact_id") or artifact["id"]
                ref = {"kind": "artifact", "id": artifact_id, "label": artifact["role"]}
                refs[("artifact", artifact_id)] = ref
                selected["artifacts"].append({**ref, "path": artifact.get("path"), "attempt_index": artifact.get("attempt_index", record["attempt_index"])})
            records.append({"kind": kind_name, **selected})
        return {"events": events, "through_event": events[-1]["id"], "records": records,
                "references": list(refs.values()), "basis": self.basis(conn=conn, project_id=snapshot.project_id)}

    def prepare(self, *, project_id):
        """Existing dispatch calls this; interactive callers use the same prepare edge."""
        with self.store.transaction() as conn:
            snapshot = self.ensure(conn=conn, project_id=project_id)
            if snapshot.state == "waiting" and self.pending(conn=conn, snapshot=snapshot)["events"]:
                self.workflows.runtime.apply_in_transaction(conn=conn, project_id=project_id, instance_id=snapshot.id,
                    action="prepare", expected_revision=snapshot.revision, request_id=f"prepare:{snapshot.revision}")

    def inputs(self, *, project_id, instance_id):
        with closing(self.store.connect()) as conn:
            snapshot = self.state(conn=conn, project_id=project_id)
            if snapshot.id != instance_id:
                raise NotFoundError(f"synthesis instance not found: {instance_id}; this project's is {snapshot.id}")
            if snapshot.state != "writing":
                raise WorkflowError(f"synthesis {snapshot.id} is {snapshot.state!r}, not writing: there is no writing assignment to read")
            return {"instance_id": snapshot.id, "revision": snapshot.revision,
                    "source": public_record(Public(), snapshot.data["source"]), "document": self.document(project_id=project_id, conn=conn)}

    def document(self, *, project_id, conn=None):
        if conn is None:
            with self.store.transaction() as tx:
                return self.document(project_id=project_id, conn=tx)
        project_id = self.store.require_project_id(conn=conn, project_id=project_id)
        project = dict(conn.execute("SELECT id, name, summary FROM projects WHERE id = ?", (project_id,)).fetchone())
        snapshot = self.state(conn=conn, project_id=project_id)
        refs = []
        for ref in snapshot.data.get("references", ()):
            item = dict(ref)
            if ref["kind"] in {"experiment", "reflection"}:
                kind = self.records.kinds[ref["kind"]]
                row = conn.execute(f"SELECT status, attempt_index FROM {kind.table} WHERE id = ? AND project_id = ?",
                                   (ref["id"], project_id)).fetchone()
                item.update(dict(row) if row is not None else {"status": "unavailable"})
            refs.append(item)
        return {**project,
                "literature": Literature.summary(conn=conn, project_id=project_id),
                "methods": snapshot.data.get("methods", ""), "results": snapshot.data.get("results", ""),
                "references": refs,
                "maintenance": {"instance_id": snapshot.id, "revision": snapshot.revision, "state": snapshot.state,
                    "covered_event": snapshot.data.get("covered_event", 0),
                    "pending": bool(self.pending(conn=conn, snapshot=snapshot)["events"])}}

    def knowledge(self, snapshot, conn):
        return SynthesisKnowledge(self, snapshot, conn)


class SynthesisKnowledge:
    def __init__(self, owner, snapshot, conn):
        self.owner, self.snapshot, self.conn = owner, snapshot, conn

    def read(self, reference):
        if reference.id != self.snapshot.project_id:
            raise NotFoundError("Synthesis context is project-scoped")
        if reference.kind == "synthesis_pending":
            return self.owner.pending(conn=self.conn, snapshot=self.snapshot)
        if reference.kind == "synthesis_source":
            return self.owner.capture(conn=self.conn, snapshot=self.snapshot)
        if reference.kind == "synthesis_basis":
            return self.owner.basis(conn=self.conn, project_id=self.snapshot.project_id)
        raise NotFoundError("Unknown synthesis fact")
