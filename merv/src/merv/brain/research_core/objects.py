# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research facts about heavy objects that merv-sandboxes stores.

The service owns the object itself. Research links an opaque object id to the
target that produced it, keeps the research classification and provenance the
submitter declared, and snapshots the verified metadata at completion so
experiment views never need a service round trip.
"""

from __future__ import annotations

from contextlib import closing
from typing import Any, Mapping, TypedDict, cast

from ..kernel.state.store import BaseStateStore, Connection, next_created_seq, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, now_iso

STORAGE_KINDS = frozenset({"dataset", "model", "other"})
_TARGET_TABLES = {"experiment": "experiments"}
_TARGET_ID_BATCH_SIZE = 400
_PRODUCED_COLUMNS = (
    "object_id AS id",
    "name",
    "version",
    "kind",
    "content_sha256",
    "size_bytes",
    "content_type",
    "producing_run",
    "source_uri",
    "notes",
    "object_created_at AS created_at",
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
        self,
        *,
        project_id: str,
        record: Mapping[str, Any],
        attributes: Mapping[str, Any],
    ) -> None:
        """Record the submitter's research facts for a freshly created object."""
        kind = str(attributes.get("kind") or "").strip()
        if kind not in STORAGE_KINDS:
            raise ValidationError(
                f"invalid storage kind: {kind or '(missing)'}; allowed: "
                f"{', '.join(sorted(STORAGE_KINDS))}"
            )
        target_id = str(attributes.get("producing_experiment_id") or "").strip()
        target_type = "experiment" if target_id else ""
        now = now_iso()
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            if target_id:
                self._assert_target(
                    conn=conn, project_id=project_id, target_type=target_type, target_id=target_id
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
                    str(record["id"]),
                    project_id,
                    target_type,
                    target_id,
                    kind,
                    str(attributes.get("producing_run") or ""),
                    str(attributes.get("source_uri") or ""),
                    str(attributes.get("notes") or ""),
                    *self._snapshot(record),
                    now,
                    now,
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
                (*self._snapshot(record), now_iso(), project_id, str(record["id"])),
            )

    def deleted(self, *, project_id: str, object_id: str) -> None:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            conn.execute(
                """
                UPDATE research_objects
                SET status = 'deleted', updated_at = ?
                WHERE project_id = ? AND object_id = ?
                """,
                (now_iso(), project_id, object_id),
            )

    # Research reads --------------------------------------------------------

    def by_target(
        self,
        *,
        project_id: str,
        target_ids: tuple[str, ...],
        target_type: str = "experiment",
    ) -> dict[str, list[ProducedObject]]:
        """Batch active objects per target from the local snapshot."""
        ids = tuple(dict.fromkeys(str(item) for item in target_ids if item))
        result: dict[str, list[ProducedObject]] = {item: [] for item in ids}
        if not ids:
            return result
        columns = ", ".join(_PRODUCED_COLUMNS)
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            for start in range(0, len(ids), _TARGET_ID_BATCH_SIZE):
                batch = ids[start : start + _TARGET_ID_BATCH_SIZE]
                placeholders = ", ".join("?" for _ in batch)
                rows = conn.execute(
                    f"""
                    SELECT {columns}, target_id
                    FROM research_objects
                    WHERE project_id = ? AND target_type = ? AND status = 'active'
                      AND target_id IN ({placeholders})
                    ORDER BY target_id, kind, name, version DESC, created_seq DESC
                    """,
                    (project_id, target_type, *batch),
                ).fetchall()
                for row in rows:
                    data = row_to_dict(row=row) or {}
                    target_id = str(data.pop("target_id"))
                    result[target_id].append(cast(ProducedObject, data))
        return result

    def by_experiment(
        self, *, project_id: str, experiment_ids: tuple[str, ...]
    ) -> dict[str, list[ProducedObject]]:
        """The experiment-typed read Application's catalog port names."""
        return self.by_target(
            project_id=project_id, target_ids=experiment_ids, target_type="experiment"
        )

    def association(
        self, *, project_id: str, object_id: str
    ) -> dict[str, Any] | None:
        """The research facts recorded for one object, or None if Merv never tracked it."""
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

    def adopt(
        self,
        *,
        project_id: str,
        object_id: str,
        kind: str,
        target_type: str,
        target_id: str,
        producing_run: str,
        source_uri: str,
        notes: str,
        snapshot: Mapping[str, Any],
        created_at: str,
    ) -> bool:
        """Record an already-available service object as active; idempotent.

        Used when historical ledger rows are carried over to service objects.
        Returns False when the association already exists.
        """
        if kind not in STORAGE_KINDS:
            raise ValidationError(f"invalid storage kind: {kind}")
        if bool(target_type) != bool(target_id) or (
            target_type and target_type not in _TARGET_TABLES
        ):
            raise ValidationError("target_type and target_id must be given together")
        now = now_iso()
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            existing = conn.execute(
                "SELECT 1 FROM research_objects WHERE project_id = ? AND object_id = ?",
                (project_id, object_id),
            ).fetchone()
            if existing is not None:
                return False
            conn.execute(
                """
                INSERT INTO research_objects (
                  object_id, project_id, target_type, target_id, kind, producing_run,
                  source_uri, notes, status, name, version, content_sha256, size_bytes,
                  content_type, object_created_at, created_at, updated_at, created_seq
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    object_id,
                    project_id,
                    target_type,
                    target_id,
                    kind,
                    producing_run,
                    source_uri,
                    notes,
                    *self._snapshot({**snapshot, "created_at": created_at}),
                    now,
                    now,
                    next_created_seq(conn=conn, table="research_objects"),
                ),
            )
        return True

    # Helpers ---------------------------------------------------------------

    @staticmethod
    def _snapshot(record: Mapping[str, Any]) -> tuple[Any, ...]:
        return (
            str(record["name"]),
            int(record["version"]),
            str(record["content_sha256"]),
            int(record["size_bytes"]),
            str(record.get("content_type") or "application/octet-stream"),
            str(record.get("created_at") or now_iso()),
        )

    @staticmethod
    def _assert_target(
        *, conn: Connection, project_id: str, target_type: str, target_id: str
    ) -> None:
        table = _TARGET_TABLES.get(target_type)
        if table is None:
            raise ValidationError(f"unsupported storage target type: {target_type}")
        row = conn.execute(
            f"SELECT project_id FROM {table} WHERE id = ?", (target_id,)
        ).fetchone()
        if row is None or str(row["project_id"]) != project_id:
            raise NotFoundError(
                f"{target_type} not found in project {project_id}: {target_id}"
            )


__all__ = ["STORAGE_KINDS", "ProducedObject", "ResearchObjects"]
