# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The problem ledger: the root charter row the user is interviewed into.

A problem is a unit of uncertainty. Today only the root exists — the
project's charter: a one-line falsifiable statement (immutable) plus a
living, versioned details document written FROM an interview with the
user, never invented by an agent. The decomposition tree grows from this
row later; parent_id and the tree bookkeeping columns are already in the
schema so that growth is additive.
"""

from __future__ import annotations

from contextlib import closing
import re
from typing import Any

from ..kernel.state.store import BaseStateStore, row_to_dict
from ..kernel.utils import NotFoundError, ValidationError, new_id, now_iso

MAX_STATEMENT_CHARS = 256
MIN_STATEMENT_CHARS = 20
MAX_DETAILS_CHARS = 20_000

# The interview agenda and the details contract are the same thing: the
# grilling is done when every one of these sections can be written precisely.
REQUIRED_DETAIL_SECTIONS = (
    "Solved means",
    "Failed means",
    "Constraints",
    "Non-goals",
)

_HEADING = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)


def validate_statement(value: Any) -> str:
    statement = str(value or "").strip()
    if not statement:
        raise ValidationError(
            "statement is required: the root problem in one line — a "
            "falsifiable question or proposition, not a topic label"
        )
    if "\n" in statement:
        raise ValidationError(
            "statement must be a single line; elaboration belongs in details"
        )
    if len(statement) > MAX_STATEMENT_CHARS:
        raise ValidationError(
            f"statement is {len(statement)} characters; keep it under "
            f"{MAX_STATEMENT_CHARS} — it is the line every plan and every "
            "future subproblem will carry as context"
        )
    if len(statement) < MIN_STATEMENT_CHARS:
        raise ValidationError(
            f"statement is too short to guide a research effort (min "
            f"{MIN_STATEMENT_CHARS} characters) — name the object, the "
            "question, and the condition, not just the topic"
        )
    return statement


def _sections(details: str) -> dict[str, str]:
    """Map '## Heading' titles (casefolded) to their body text."""
    found: dict[str, str] = {}
    matches = list(_HEADING.finditer(details))
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(details)
        found[match.group("title").casefold()] = details[start:end].strip()
    return found


def validate_details(value: Any) -> str:
    details = str(value or "").strip()
    if not details:
        raise ValidationError(
            "details is required: the living understanding of the problem, "
            "written from the interview with the user"
        )
    if len(details) > MAX_DETAILS_CHARS:
        raise ValidationError(
            f"details is {len(details)} characters; keep it under "
            f"{MAX_DETAILS_CHARS} — link out to artifacts for anything longer"
        )
    sections = _sections(details)
    missing = [
        title
        for title in REQUIRED_DETAIL_SECTIONS
        if not sections.get(title.casefold())
    ]
    if missing:
        raise ValidationError(
            "details is missing required sections (each a non-empty '## "
            "<title>' block): " + ", ".join(missing) + ". These are the "
            "interview agenda — if one cannot be written precisely yet, the "
            "interview is not finished."
        )
    return details


def problem_view(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "statement": row["statement"],
        "details": row["details"],
        "details_version": int(row["details_version"]),
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class ProblemService:
    def __init__(self, *, store: BaseStateStore) -> None:
        self.store = store

    def define_root(
        self,
        *,
        statement: str,
        details: str,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        statement = validate_statement(statement)
        details = validate_details(details)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            existing = self._root_row(conn=conn, project_id=project_id)
            if existing is not None:
                raise ValidationError(
                    "this project already has a root problem "
                    f"({existing['id']}); the statement is immutable — evolve "
                    "the understanding with problem.refine instead"
                )
            problem_id = new_id(prefix="prob")
            now = now_iso()
            conn.execute(
                """
                INSERT INTO problems
                  (id, project_id, parent_id, statement, details,
                   details_version, status, summary, depth, revisit_count,
                   created_at, updated_at)
                VALUES (?, ?, '', ?, ?, 1, 'open', '', 0, 0, ?, ?)
                """,
                (problem_id, project_id, statement, details, now, now),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.defined",
                target_type="problem",
                target_id=problem_id,
                payload={"statement": statement, "details_version": 1},
            )
            return problem_view(
                row_to_dict(
                    row=conn.execute(
                        "SELECT * FROM problems WHERE id = ?", (problem_id,)
                    ).fetchone()
                )
            )

    def refine_root(
        self,
        *,
        details: str,
        expected_version: int | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        details = validate_details(details)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            row = self._root_row(conn=conn, project_id=project_id)
            if row is None:
                raise NotFoundError(
                    "this project has no root problem yet — interview the "
                    "user, then problem.define"
                )
            current = int(row["details_version"])
            if expected_version is not None and int(expected_version) != current:
                raise ValidationError(
                    f"details_version is {current}, not {expected_version} — "
                    "someone refined the problem since you read it. Re-read "
                    "with problem.get and merge before refining."
                )
            next_version = current + 1
            conn.execute(
                """
                UPDATE problems SET details = ?, details_version = ?,
                  updated_at = ? WHERE id = ?
                """,
                (details, next_version, now_iso(), row["id"]),
            )
            # Full previous text rides in the event so every version of the
            # understanding stays reconstructable from the ledger.
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.details_refined",
                target_type="problem",
                target_id=str(row["id"]),
                payload={
                    "details_version": next_version,
                    "previous_version": current,
                    "previous_details": str(row["details"]),
                },
            )
            return problem_view(
                row_to_dict(
                    row=conn.execute(
                        "SELECT * FROM problems WHERE id = ?", (row["id"],)
                    ).fetchone()
                )
            )

    def root_state(
        self, *, project_id: str | None = None, conn=None
    ) -> dict[str, Any] | None:
        if conn is not None:
            row = self._root_row(conn=conn, project_id=str(project_id))
            return problem_view(row) if row is not None else None
        with closing(self.store.connect()) as owned:
            project_id = self.store.require_project_id(conn=owned, project_id=project_id)
            row = self._root_row(conn=owned, project_id=project_id)
            return problem_view(row) if row is not None else None

    def _root_row(self, *, conn, project_id: str) -> dict[str, Any] | None:
        return row_to_dict(
            row=conn.execute(
                "SELECT * FROM problems WHERE project_id = ? AND parent_id = ''",
                (project_id,),
            ).fetchone()
        )
