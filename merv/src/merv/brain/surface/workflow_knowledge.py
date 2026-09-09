"""Project-scoped support facts shared by every workflow plugin."""

from __future__ import annotations

from typing import Protocol

from ..artifacts import Artifacts
from ..kernel.state.store import Connection
from ..kernel.utils import NotFoundError, WorkflowError
from ..workflows import Reference, Snapshot


class ProjectReader(Protocol):
    def __call__(self, *, project_id: str, conn: Connection) -> dict: ...


class ReviewReader(Protocol):
    def __call__(self, *, snapshot: Snapshot, reference: Reference, conn: Connection) -> dict: ...


class WorkflowKnowledge:
    def __init__(self, *, snapshot: Snapshot, conn: Connection, artifacts: Artifacts, project: ProjectReader, review: ReviewReader) -> None:
        self.snapshot, self.conn, self.artifacts = snapshot, conn, artifacts
        self.project = project
        self.review = review

    def read(self, reference: Reference):
        project_id = self.snapshot.project_id
        if reference.kind == "project" and reference.id == project_id:
            return self.project(project_id=project_id, conn=self.conn)
        if reference.kind in {"review", "review_snapshot"}:
            return self.review(snapshot=self.snapshot, reference=reference, conn=self.conn)
        if reference.kind == "artifact":
            self.artifacts.assert_complete(artifact_ids=(reference.id,), project_id=project_id, tx=self.conn)
            artifact = self.artifacts.get(artifact_ids=(reference.id,), project_id=project_id,
                                          include="document", tx=self.conn)[0]
            if artifact.data is None:
                raise WorkflowError(f"artifact {reference.id} has no retained content")
            try:
                text = artifact.data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
            return {"id": artifact.id, "sha256": artifact.sha256, "data": artifact.data,
                    "text": text, "figures": artifact.figures, "complete": True}
        raise NotFoundError(f"knowledge is unavailable in this project: {reference.kind}/{reference.id}")
