# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research facts about heavy objects that merv-sandboxes stores.

The service owns the object; Research links its opaque id to the experiment
that produced it, keeps the classification and provenance the submitter
declared, and snapshots the verified metadata at completion so experiment
views never need a service round trip.
"""

from __future__ import annotations

from contextlib import closing
from typing import Any, Mapping, TypedDict, cast

from ..kernel.state.store import BaseStateStore, next_created_seq, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, now_iso

STORAGE_KINDS = frozenset({"dataset", "model", "other"})
_TARGET_ID_BATCH_SIZE = 400
_PRODUCED_COLUMNS = (
    "object_id AS id, name, version, kind, content_sha256, size_bytes, "
    "content_type, producing_run, source_uri, notes, object_created_at AS created_at"
)


class ProducedObject(TypedDict):
    """Hosted-safe heavy-object facts exposed to research views."""

    id: str
    name: str
    version: int
    kind: str
    content_sha256: str
    size_bytes: int
    content_type: str
    producing_run: str
    source_uri: str
    notes: str
    created_at: str


class ResearchObjects:
    """Associations from service objects to the research work that produced them."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self.store = store

    # Lifecycle hook (bound to the infrastructure facade at composition) ---

    def submitted(
        self, *, project_id: str, record: Mapping[str, Any], attributes: Mapping[str, Any]
    ) -> None:
        """Record the submitter's research facts for a freshly created object."""
        kind = str(attributes.get("kind") or "").strip()
        if kind not in STORAGE_KINDS:
            raise ValidationError(
                f"invalid storage kind: {kind or '(missing)'}; allowed: "
                f"{', '.join(sorted(STORAGE_KINDS))}"
            )
        target_id = str(attributes.get("producing_experiment_id") or "").strip()
        now = now_iso()
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if target_id:
                row = conn.execute(
                    "SELECT project_id FROM experiments WHERE id = ?", (target_id,)
                ).fetchone()
                if row is None or str(row["project_id"]) != project_id:
                    raise NotFoundError(
                        f"experiment not found in project {project_id}: {target_id}"
                    )
            conn.execute(
                """
                INSERT INTO research_objects (
                  object_id, project_id, target_type, target_id, kind, producing_run,
                  source_uri, notes, status, name, version, content_sha256, size_bytes,
                  content_type, object_created_at, created_at, updated_at, created_seq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(record["id"]), project_id, "experiment" if target_id else "",
                    target_id, kind, str(attributes.get("producing_run") or ""),
                    str(attributes.get("source_uri") or ""),
                    str(attributes.get("notes") or ""),
                    *snapshot_values(record), now, now,
                    next_created_seq(conn=conn, table="research_objects"),
                ),
            )

    def completed(self, *, project_id: str, record: Mapping[str, Any]) -> None:
        """Activate the association with the service-verified metadata."""
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            conn.execute(
                """
                UPDATE research_objects
                SET status = 'active', name = ?, version = ?, content_sha256 = ?,
                    size_bytes = ?, content_type = ?, object_created_at = ?, updated_at = ?
                WHERE project_id = ? AND object_id = ? AND status != 'deleted'
                """,
                (*snapshot_values(record), now_iso(), project_id, str(record["id"])),
            )

    def deleted(self, *, project_id: str, object_id: str) -> None:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            conn.execute(
                """
                UPDATE research_objects SET status = 'deleted', updated_at = ?
                WHERE project_id = ? AND object_id = ?
                """,
                (now_iso(), project_id, object_id),
            )

    # Research reads --------------------------------------------------------

    def by_experiment(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[ProducedObject]]:
        """Batch active objects per experiment from the local snapshot."""
        ids = tuple(dict.fromkeys(str(item) for item in experiment_ids if item))
        result: dict[str, list[ProducedObject]] = {item: [] for item in ids}
        with closing(self.store.connect()) as conn:
            if not ids:
                return result
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            for start in range(0, len(ids), _TARGET_ID_BATCH_SIZE):
                batch = ids[start : start + _TARGET_ID_BATCH_SIZE]
                rows = conn.execute(
                    f"""
                    SELECT {_PRODUCED_COLUMNS}, target_id
                    FROM research_objects
                    WHERE project_id = ? AND target_type = 'experiment'
                      AND status = 'active' AND target_id IN ({", ".join("?" for _ in batch)})
                    ORDER BY target_id, kind, name, version DESC, created_seq DESC
                    """,
                    (project_id, *batch),
                ).fetchall()
                for row in rows:
                    data = row_to_dict(row=row) or {}
                    result[str(data.pop("target_id"))].append(cast(ProducedObject, data))
        return result

    def association(self, *, project_id: str, object_id: str) -> dict[str, Any] | None:
        """The research facts recorded for one object, or None if untracked."""
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                """
                SELECT object_id, target_type, target_id, kind, status, producing_run,
                       source_uri, notes, content_sha256
                FROM research_objects
                WHERE project_id = ? AND object_id = ?
                """,
                (project_id, object_id),
            ).fetchone()
        return row_to_dict(row=row) if row is not None else None


def snapshot_values(record: Mapping[str, Any]) -> tuple[Any, ...]:
    """The verified service metadata every association row stores, in column order."""
    return (
        str(record["name"]),
        int(record["version"]),
        str(record["content_sha256"]),
        int(record["size_bytes"]),
        str(record.get("content_type") or "application/octet-stream"),
        str(record.get("created_at") or now_iso()),
    )


__all__ = ["STORAGE_KINDS", "ProducedObject", "ResearchObjects", "snapshot_values"]
