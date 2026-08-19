# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The wave DAG: which nodes (experiments, tasks) wait on which.

Edges live in ``node_dependencies``. Experiments and tasks read them through
one gate (``evaluate_dependency_requirement``); the reflection and the create
tools write them. Pure SQL helpers — no lifecycle rules here.
"""

from __future__ import annotations

from typing import Any

from ..kernel.utils import NotFoundError, ValidationError, now_iso
from .experiment_workflow import EXPERIMENT_TERMINAL_STATUSES, EXPERIMENT_WORKFLOW
from .task_workflow import TASK_TERMINAL_STATUSES, TASK_WORKFLOW

NODE_PREFIXES = ("exp_", "task_")


def node_type_of(node_id: str) -> str:
    if node_id.startswith("exp_"):
        return "experiment"
    if node_id.startswith("task_"):
        return "task"
    raise ValidationError(
        f"unknown node id {node_id!r}: dependencies name experiments (exp_…) "
        "or tasks (task_…)"
    )


def _node_row(*, conn, project_id: str, node_id: str) -> dict[str, Any] | None:
    table = "experiments" if node_type_of(node_id) == "experiment" else "tasks"
    row = conn.execute(
        f"SELECT id, name, status FROM {table} WHERE id = ? AND project_id = ?",
        (node_id, project_id),
    ).fetchone()
    return None if row is None else dict(row)


def _settled(node_type: str, status: str) -> bool:
    if node_type == "experiment":
        return status == EXPERIMENT_WORKFLOW.success_status
    return status == TASK_WORKFLOW.success_status


def _failed(node_type: str, status: str) -> bool:
    if node_type == "experiment":
        return status in EXPERIMENT_TERMINAL_STATUSES - {
            EXPERIMENT_WORKFLOW.success_status
        }
    return status in TASK_TERMINAL_STATUSES - {TASK_WORKFLOW.success_status}


def dependency_rows(
    *, conn, project_id: str, node_ids: tuple[str, ...]
) -> dict[str, list[dict[str, Any]]]:
    """Per node: its dependencies with current status and settled/failed flags.

    A dependency whose row is gone reads as unsettled with status 'missing',
    so a dangling edge never silently opens a gate.
    """
    result: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in node_ids}
    if not node_ids:
        return result
    placeholders = ", ".join("?" for _ in node_ids)
    edges = conn.execute(
        f"""
        SELECT node_id, depends_on_id FROM node_dependencies
        WHERE project_id = ? AND node_id IN ({placeholders})
        ORDER BY created_at, depends_on_id
        """,
        (project_id, *node_ids),
    ).fetchall()
    for edge in edges:
        node_id = str(edge["node_id"])
        target_id = str(edge["depends_on_id"])
        try:
            node_type = node_type_of(target_id)
        except ValidationError:
            node_type = "unknown"
        target = (
            _node_row(conn=conn, project_id=project_id, node_id=target_id)
            if node_type != "unknown"
            else None
        )
        status = "missing" if target is None else str(target.get("status") or "")
        result.setdefault(node_id, []).append(
            {
                "id": target_id,
                "node_type": node_type,
                "name": "" if target is None else str(target.get("name") or ""),
                "status": status,
                "settled": target is not None and _settled(node_type, status),
                "failed": target is not None and _failed(node_type, status),
            }
        )
    return result


def dependents_of(*, conn, project_id: str, node_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT node_id FROM node_dependencies
        WHERE project_id = ? AND depends_on_id = ?
        ORDER BY created_at, node_id
        """,
        (project_id, node_id),
    ).fetchall()
    return [str(row["node_id"]) for row in rows]


def _reaches(*, conn, project_id: str, start: str, goal: str) -> bool:
    """Whether ``goal`` is reachable from ``start`` along depends_on edges."""
    frontier = [start]
    seen: set[str] = set()
    while frontier:
        current = frontier.pop()
        if current == goal:
            return True
        if current in seen:
            continue
        seen.add(current)
        rows = conn.execute(
            "SELECT depends_on_id FROM node_dependencies "
            "WHERE project_id = ? AND node_id = ?",
            (project_id, current),
        ).fetchall()
        frontier.extend(str(row["depends_on_id"]) for row in rows)
    return False


def record_dependencies(
    *,
    conn,
    project_id: str,
    node_id: str,
    depends_on_ids: list[str],
) -> list[str]:
    """Insert edges after checking every target exists, is not the node itself,
    and does not close a cycle. Returns the recorded target ids in order."""
    recorded: list[str] = []
    for raw in depends_on_ids:
        target_id = str(raw or "").strip()
        if not target_id or target_id in recorded:
            continue
        if target_id == node_id:
            raise ValidationError(f"{node_id} cannot depend on itself")
        if _node_row(conn=conn, project_id=project_id, node_id=target_id) is None:
            raise NotFoundError(
                f"dependency not found in project: {target_id} (dependencies "
                "name existing experiments or tasks of this project)"
            )
        if _reaches(conn=conn, project_id=project_id, start=target_id, goal=node_id):
            raise ValidationError(
                f"{node_id} → {target_id} would create a dependency cycle"
            )
        existing = conn.execute(
            "SELECT 1 FROM node_dependencies WHERE node_id = ? AND depends_on_id = ?",
            (node_id, target_id),
        ).fetchone()
        if existing is not None:
            recorded.append(target_id)
            continue
        conn.execute(
            """
            INSERT INTO node_dependencies
              (project_id, node_id, depends_on_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (project_id, node_id, target_id, now_iso()),
        )
        recorded.append(target_id)
    return recorded


__all__ = [
    "NODE_PREFIXES",
    "dependency_rows",
    "dependents_of",
    "node_type_of",
    "record_dependencies",
]
