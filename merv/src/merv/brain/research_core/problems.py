# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""The problem ledger: the decomposition tree research work hangs from.

A problem is a unit of uncertainty. The root is the project's charter —
a one-line falsifiable statement (immutable) plus a living, versioned
details document written FROM an interview with the user, never invented
by an agent. Below it, frontier decomposition: an open leaf is either
attempted (experiments/tasks created through problem.attempt, many-to-many
with per-problem verdicts) or decomposed into independent children, and a
parent revisits its children's summaries — fully when all are terminal
(SOLVED/FAILED/STUCK/NEXT), or interim while some still run (CONTINUE/
MOOT/RESOLVE, never NEXT). Sequencing lives only in parent→child edges;
siblings are independent by construction.
"""

from __future__ import annotations

from contextlib import closing
import json
import re
from typing import Any

from .experiment_workflow import EXPERIMENT_TERMINAL_STATUSES, EXPERIMENT_WORKFLOW
from .task_workflow import TASK_TERMINAL_STATUSES, TASK_WORKFLOW
from ..kernel.state.store import BaseStateStore, row_to_dict, rows_to_dicts
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError, new_id, now_iso

MAX_STATEMENT_CHARS = 256
MIN_STATEMENT_CHARS = 20
MAX_DETAILS_CHARS = 20_000
MAX_SUMMARY_CHARS = 700

# Tree budgets: structural backstops, not the real economics (that is
# sandbox-hours). Depth counts from the root at 0.
MAX_DEPTH = 6
MAX_REVISITS = 4
MAX_ATTACHED_PROBLEMS = 4
MAX_CHILDREN_PER_STEP = 8

PROBLEM_TERMINAL_STATUSES = frozenset({"solved", "failed", "stuck", "moot"})
_FULL_VERDICTS = ("solved", "failed", "stuck", "next")
_INTERIM_VERDICTS = ("continue", "moot", "solved", "failed")
_ATTEMPT_VERDICTS = ("solved", "failed", "reopen")

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


def validate_summary(value: Any, *, what: str = "summary") -> str:
    summary = str(value or "").strip()
    if not summary:
        raise ValidationError(
            f"{what} is required: 2-3 sentences the PARENT problem reads — "
            "what was established and the key evidence, standalone"
        )
    if len(summary) > MAX_SUMMARY_CHARS:
        raise ValidationError(
            f"{what} is {len(summary)} characters; keep it under "
            f"{MAX_SUMMARY_CHARS} — it is the compressed result, not the "
            "report. Evidence stays on the attempt."
        )
    return summary


def _child_details(value: Any) -> str:
    details = str(value or "").strip()
    if len(details) > MAX_DETAILS_CHARS:
        raise ValidationError(
            f"child details is {len(details)} characters; keep it under "
            f"{MAX_DETAILS_CHARS}"
        )
    return details


def attempt_kind_of(attempt_id: str) -> str:
    if attempt_id.startswith("exp"):
        return "experiment"
    if attempt_id.startswith("task"):
        return "task"
    raise ValidationError(f"not an attempt id (exp_/task_): {attempt_id}")


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
    def __init__(self, *, store: BaseStateStore, experiments=None, tasks=None) -> None:
        self.store = store
        # Sibling services for in-transaction attempt creation; wired by
        # Research after all services exist (None only in narrow unit tests).
        self.experiments = experiments
        self.tasks = tasks

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

    # ---- the tree: attempts ----

    def attempt(
        self,
        *,
        problem_ids: list[str] | str,
        kind: str = "experiment",
        name: str = "",
        intent: str = "",
        details: str = "",
        goal: str = "",
        deliverables: list[str] | str | None = None,
        depends_on: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        ids = [problem_ids] if isinstance(problem_ids, str) else list(problem_ids or [])
        ids = list(dict.fromkeys(str(item or "").strip() for item in ids if item))
        if not ids:
            raise ValidationError(
                "problem_ids is required: the open leaf problem(s) this "
                "attempt answers"
            )
        if len(ids) > MAX_ATTACHED_PROBLEMS:
            raise ValidationError(
                f"{len(ids)} problems on one attempt is too many (max "
                f"{MAX_ATTACHED_PROBLEMS}) — an attempt spanning that much is "
                "usually a sign the decomposition, not the experiment, is wrong"
            )
        if kind not in ("experiment", "task"):
            raise ValidationError('kind must be "experiment" or "task"')
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            problems = self._load_problems(conn=conn, project_id=project_id, ids=ids)
            for problem in problems:
                if problem["status"] != "open":
                    raise WorkflowError(
                        f"problem {problem['id']} is {problem['status']}, not "
                        "open — only open frontier leaves take a new attempt"
                    )
            if kind == "experiment":
                if self.experiments is None:
                    raise WorkflowError("experiment service unavailable")
                state = self.experiments._create_in_transaction(
                    conn=conn,
                    project_id=project_id,
                    name=name,
                    intent=intent,
                    details=details,
                    depends_on=depends_on,
                )
            else:
                if self.tasks is None:
                    raise WorkflowError("task service unavailable")
                state = self.tasks._create_in_transaction(
                    conn=conn,
                    project_id=project_id,
                    name=name,
                    goal=goal,
                    deliverables=deliverables,
                    depends_on=depends_on,
                )
            attempt_id = str(state["id"])
            now = now_iso()
            for problem in problems:
                conn.execute(
                    """
                    INSERT INTO problem_attempts
                      (problem_id, attempt_id, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (problem["id"], attempt_id, now),
                )
                conn.execute(
                    "UPDATE problems SET status = 'attempting', updated_at = ? "
                    "WHERE id = ?",
                    (now, problem["id"]),
                )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="problem.attempted",
                    target_type="problem",
                    target_id=str(problem["id"]),
                    payload={"attempt_id": attempt_id, "kind": kind},
                )
            return {
                "attempt": {
                    "id": attempt_id,
                    "kind": kind,
                    "name": state.get("name", ""),
                    "status": state.get("status", ""),
                },
                "problems": [
                    {"id": problem["id"], "status": "attempting"}
                    for problem in problems
                ],
            }

    def resolve_attempt(
        self,
        *,
        attempt_id: str,
        verdicts: list[dict[str, Any]] | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        attempt_id = str(attempt_id or "").strip()
        kind = attempt_kind_of(attempt_id)
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            attempt = self._attempt_row(
                conn=conn, project_id=project_id, attempt_id=attempt_id
            )
            pending = rows_to_dicts(
                rows=conn.execute(
                    """
                    SELECT pa.problem_id FROM problem_attempts pa
                    JOIN problems p ON p.id = pa.problem_id
                    WHERE pa.attempt_id = ? AND pa.verdict = ''
                      AND p.project_id = ?
                    ORDER BY pa.created_at, pa.problem_id
                    """,
                    (attempt_id, project_id),
                ).fetchall()
            )
            if not pending:
                raise WorkflowError(
                    f"attempt {attempt_id} has no unresolved attached problems"
                )
            pending_ids = [str(row["problem_id"]) for row in pending]
            status = str(attempt["status"])
            terminal = (
                EXPERIMENT_TERMINAL_STATUSES
                if kind == "experiment"
                else TASK_TERMINAL_STATUSES
            )
            if status not in terminal:
                raise WorkflowError(
                    f"the {kind} is {status}; resolve its problems only once "
                    "it is terminal"
                )
            success_status = (
                EXPERIMENT_WORKFLOW.success_status
                if kind == "experiment"
                else TASK_WORKFLOW.success_status
            )
            if status != success_status:
                # Infra death or abandonment carries no findings: every
                # attached problem returns to the frontier for re-triage.
                by_problem = {pid: {"verdict": "reopen"} for pid in pending_ids}
            else:
                given = {
                    str(item.get("problem_id") or "").strip(): item
                    for item in (verdicts or [])
                }
                missing = [pid for pid in pending_ids if pid not in given]
                extra = [pid for pid in given if pid not in pending_ids]
                if missing or extra:
                    raise ValidationError(
                        "verdicts must cover exactly the attempt's unresolved "
                        f"problems. Missing: {missing or 'none'}. Not attached "
                        f"or already resolved: {extra or 'none'}."
                    )
                by_problem = {}
                for pid in pending_ids:
                    verdict = str(given[pid].get("verdict") or "").strip()
                    if verdict not in _ATTEMPT_VERDICTS:
                        raise ValidationError(
                            f"verdict for {pid} must be one of "
                            f"{', '.join(_ATTEMPT_VERDICTS)}: solved/failed "
                            "resolve the problem (a refuting result is "
                            "failed — that is an ending, not a retry); reopen "
                            "returns it to the frontier because this attempt "
                            "did not answer it"
                        )
                    entry: dict[str, Any] = {"verdict": verdict}
                    if verdict in ("solved", "failed"):
                        entry["summary"] = validate_summary(
                            given[pid].get("summary"),
                            what=f"summary for {pid}",
                        )
                    by_problem[pid] = entry
            now = now_iso()
            resolved = []
            for pid in pending_ids:
                entry = by_problem[pid]
                verdict = entry["verdict"]
                conn.execute(
                    """
                    UPDATE problem_attempts SET verdict = ?, summary = ?,
                      resolved_at = ? WHERE problem_id = ? AND attempt_id = ?
                    """,
                    (verdict, entry.get("summary", ""), now, pid, attempt_id),
                )
                if verdict == "reopen":
                    conn.execute(
                        "UPDATE problems SET status = 'open', updated_at = ? "
                        "WHERE id = ? AND status = 'attempting'",
                        (now, pid),
                    )
                else:
                    conn.execute(
                        "UPDATE problems SET status = ?, summary = ?, "
                        "updated_at = ? WHERE id = ? AND status = 'attempting'",
                        (verdict, entry.get("summary", ""), now, pid),
                    )
                self.store.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="problem.resolved",
                    target_type="problem",
                    target_id=pid,
                    payload={
                        "verdict": verdict,
                        "attempt_id": attempt_id,
                        "summary": entry.get("summary", ""),
                    },
                )
                resolved.append({"id": pid, "verdict": verdict})
            return {"attempt_id": attempt_id, "problems": resolved}

    # ---- the tree: growth ----

    def decompose(
        self,
        *,
        problem_id: str,
        children: list[dict[str, Any]] | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            (problem,) = self._load_problems(
                conn=conn, project_id=project_id, ids=[str(problem_id or "").strip()]
            )
            if problem["status"] != "open":
                raise WorkflowError(
                    f"problem {problem['id']} is {problem['status']}, not open "
                    "— decompose only an open frontier leaf (new children for "
                    "a decomposed parent come from problem.revisit_submit "
                    "with verdict next)"
                )
            spawned = self._spawn_children(
                conn=conn,
                project_id=project_id,
                parent=problem,
                children=children,
            )
            now = now_iso()
            conn.execute(
                "UPDATE problems SET status = 'decomposed', updated_at = ? "
                "WHERE id = ?",
                (now, problem["id"]),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.decomposed",
                target_type="problem",
                target_id=str(problem["id"]),
                payload={
                    "children": [
                        {"id": child["id"], "statement": child["statement"]}
                        for child in spawned
                    ]
                },
            )
            return {
                "problem": {"id": problem["id"], "status": "decomposed"},
                "children": spawned,
            }

    def mark_stuck(
        self,
        *,
        problem_id: str,
        why: str = "",
        project_id: str | None = None,
    ) -> dict[str, Any]:
        why = validate_summary(why, what="why")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            (problem,) = self._load_problems(
                conn=conn, project_id=project_id, ids=[str(problem_id or "").strip()]
            )
            if problem["status"] != "open":
                raise WorkflowError(
                    f"problem {problem['id']} is {problem['status']}, not open "
                    "— only an open leaf gives up directly (a decomposed "
                    "parent goes stuck through revisit_submit)"
                )
            now = now_iso()
            conn.execute(
                "UPDATE problems SET status = 'stuck', summary = ?, "
                "updated_at = ? WHERE id = ?",
                (why, now, problem["id"]),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.marked_stuck",
                target_type="problem",
                target_id=str(problem["id"]),
                payload={"why": why},
            )
            return {"problem": {"id": problem["id"], "status": "stuck"}}

    # ---- the tree: revisits ----

    def revisit_submit(
        self,
        *,
        problem_id: str,
        verdict: str = "",
        why: str = "",
        summary: str = "",
        children: list[dict[str, Any]] | None = None,
        moot_ids: list[str] | str | None = None,
        project_id: str | None = None,
    ) -> dict[str, Any]:
        verdict = str(verdict or "").strip().lower()
        why = validate_summary(why, what="why")
        with self.store.transaction() as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            (problem,) = self._load_problems(
                conn=conn, project_id=project_id, ids=[str(problem_id or "").strip()]
            )
            if problem["status"] != "decomposed":
                raise WorkflowError(
                    f"problem {problem['id']} is {problem['status']} — only a "
                    "decomposed parent takes a revisit"
                )
            child_rows = rows_to_dicts(
                rows=conn.execute(
                    "SELECT * FROM problems WHERE parent_id = ? "
                    "ORDER BY created_at, id",
                    (problem["id"],),
                ).fetchall()
            )
            live = [
                row
                for row in child_rows
                if str(row["status"]) not in PROBLEM_TERMINAL_STATUSES
            ]
            kind = "interim" if live else "full"
            allowed = _INTERIM_VERDICTS if live else _FULL_VERDICTS
            if verdict not in allowed:
                raise ValidationError(
                    f"a {kind} revisit ({len(live)} live children) allows "
                    f"verdicts {', '.join(allowed)}"
                    + (
                        " — NEXT waits until every child is terminal; moot "
                        "the stragglers first if the answer cannot depend on "
                        "them"
                        if live
                        else ""
                    )
                )
            now = now_iso()
            revisit_id = new_id(prefix="prev")
            payload: dict[str, Any] = {}
            spawned: list[dict[str, Any]] = []
            mooted: list[str] = []
            if verdict == "next":
                revisits = int(problem["revisit_count"]) + 1
                if revisits > MAX_REVISITS:
                    raise WorkflowError(
                        f"revisit limit reached ({MAX_REVISITS}): this problem "
                        "has spawned new children too many times — resolve it "
                        "as solved, failed, or stuck instead"
                    )
                spawned = self._spawn_children(
                    conn=conn,
                    project_id=project_id,
                    parent=problem,
                    children=children,
                )
                conn.execute(
                    "UPDATE problems SET revisit_count = ?, updated_at = ? "
                    "WHERE id = ?",
                    (revisits, now, problem["id"]),
                )
                payload["children"] = [child["id"] for child in spawned]
            elif verdict == "moot":
                ids = (
                    [moot_ids] if isinstance(moot_ids, str) else list(moot_ids or [])
                )
                ids = [str(item or "").strip() for item in ids if item]
                live_ids = {str(row["id"]) for row in live}
                bad = [item for item in ids if item not in live_ids]
                if not ids or bad:
                    raise ValidationError(
                        "moot_ids must name live DIRECT children of this "
                        f"problem. Live children: {sorted(live_ids)}. "
                        f"Invalid: {bad or 'none given'}."
                    )
                mooted = self._moot_subtree(
                    conn=conn, project_id=project_id, ids=ids, revisit_id=revisit_id
                )
                payload["mooted"] = mooted
            elif verdict in ("solved", "failed"):
                summary = validate_summary(summary)
                if live:
                    mooted = self._moot_subtree(
                        conn=conn,
                        project_id=project_id,
                        ids=[str(row["id"]) for row in live],
                        revisit_id=revisit_id,
                    )
                    payload["mooted"] = mooted
                conn.execute(
                    "UPDATE problems SET status = ?, summary = ?, updated_at = ? "
                    "WHERE id = ?",
                    (verdict, summary, now, problem["id"]),
                )
                payload["summary"] = summary
            elif verdict == "stuck":
                conn.execute(
                    "UPDATE problems SET status = 'stuck', summary = ?, "
                    "updated_at = ? WHERE id = ?",
                    (why, now, problem["id"]),
                )
            # verdict == "continue": the journal row is the whole effect.
            conn.execute(
                """
                INSERT INTO problem_revisits
                  (id, project_id, problem_id, kind, verdict, why,
                   payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    revisit_id,
                    project_id,
                    str(problem["id"]),
                    kind,
                    verdict,
                    why,
                    json.dumps(payload, sort_keys=True),
                    now,
                ),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.revisited",
                target_type="problem",
                target_id=str(problem["id"]),
                payload={"kind": kind, "verdict": verdict, "why": why, **payload},
            )
            return {
                "revisit_id": revisit_id,
                "kind": kind,
                "verdict": verdict,
                "problem": {
                    "id": problem["id"],
                    "status": self._status_of(conn=conn, problem_id=problem["id"]),
                },
                "spawned": spawned,
                "mooted": mooted,
                "moot_work": self._moot_work(
                    conn=conn, project_id=project_id, mooted=mooted
                ),
            }

    def _moot_subtree(
        self, *, conn, project_id: str, ids: list[str], revisit_id: str
    ) -> list[str]:
        """Flip every non-terminal problem in the given subtrees to moot."""
        mooted: list[str] = []
        queue = list(ids)
        now = now_iso()
        while queue:
            current = queue.pop(0)
            row = conn.execute(
                "SELECT id, status FROM problems WHERE id = ? AND project_id = ?",
                (current, project_id),
            ).fetchone()
            if row is None:
                continue
            queue.extend(
                str(child["id"])
                for child in conn.execute(
                    "SELECT id FROM problems WHERE parent_id = ?", (current,)
                ).fetchall()
            )
            # Terminal beats moot: a child that resolved concurrently keeps
            # its verdict; its summary simply arrives as extra context.
            if str(row["status"]) in PROBLEM_TERMINAL_STATUSES:
                continue
            conn.execute(
                "UPDATE problems SET status = 'moot', updated_at = ? WHERE id = ?",
                (now, current),
            )
            # The moot IS this problem's resolution: its pending attempt
            # pairs must never sit in the needs-a-verdict queue.
            conn.execute(
                "UPDATE problem_attempts SET verdict = 'moot', resolved_at = ? "
                "WHERE problem_id = ? AND verdict = ''",
                (now, current),
            )
            self.store.record_event(
                conn=conn,
                project_id=project_id,
                event_type="problem.mooted",
                target_type="problem",
                target_id=current,
                payload={"revisit_id": revisit_id},
            )
            mooted.append(current)
        return mooted

    def _moot_work(
        self, *, conn, project_id: str, mooted: list[str]
    ) -> list[dict[str, Any]]:
        """Attempts whose every attached problem is now terminal, still live.

        These are the work items the application layer abandons and whose
        sandboxes it releases — the whole point of mooting is to stop paying.
        """
        if not mooted:
            return []
        placeholders = ", ".join("?" for _ in mooted)
        attempt_ids = [
            str(row["attempt_id"])
            for row in conn.execute(
                f"SELECT DISTINCT attempt_id FROM problem_attempts "
                f"WHERE problem_id IN ({placeholders})",
                tuple(mooted),
            ).fetchall()
        ]
        work: list[dict[str, Any]] = []
        for attempt_id in attempt_ids:
            attached = [
                str(row["status"])
                for row in conn.execute(
                    """
                    SELECT p.status FROM problem_attempts pa
                    JOIN problems p ON p.id = pa.problem_id
                    WHERE pa.attempt_id = ?
                    """,
                    (attempt_id,),
                ).fetchall()
            ]
            if any(status not in PROBLEM_TERMINAL_STATUSES for status in attached):
                continue
            kind = attempt_kind_of(attempt_id)
            row = self._attempt_row(
                conn=conn, project_id=project_id, attempt_id=attempt_id
            )
            terminal = (
                EXPERIMENT_TERMINAL_STATUSES
                if kind == "experiment"
                else TASK_TERMINAL_STATUSES
            )
            if str(row["status"]) in terminal:
                continue
            work.append(
                {
                    "id": attempt_id,
                    "kind": kind,
                    "name": str(row["name"] or ""),
                    "status": str(row["status"]),
                }
            )
        return work

    # ---- reads ----

    def tree(self, *, project_id: str | None = None) -> dict[str, Any]:
        with closing(self.store.connect()) as conn:
            project_id = self.store.require_project_id(conn=conn, project_id=project_id)
            problems = self.project_problems(conn=conn, project_id=project_id)
            attempts = self.attempts_with_state(conn=conn, project_id=project_id)
            revisits = self._revisits_by_problem(conn=conn, project_id=project_id)
            history = self._root_details_history(
                conn=conn, project_id=project_id, problems=problems
            )
        by_parent: dict[str, list[dict[str, Any]]] = {}
        for problem in problems:
            by_parent.setdefault(str(problem["parent_id"]), []).append(problem)
        attempts_by_problem: dict[str, list[dict[str, Any]]] = {}
        for attempt in attempts:
            attempts_by_problem.setdefault(str(attempt["problem_id"]), []).append(
                {key: attempt[key] for key in ("id", "kind", "name", "status", "verdict")}
            )

        def node(problem: dict[str, Any]) -> dict[str, Any]:
            return {
                "id": problem["id"],
                "statement": problem["statement"],
                "status": problem["status"],
                "depth": int(problem["depth"]),
                "summary": problem["summary"],
                "details": problem["details"],
                "details_version": int(problem["details_version"]),
                "revisit_count": int(problem["revisit_count"]),
                "attempts": attempts_by_problem.get(str(problem["id"]), []),
                "revisits": revisits.get(str(problem["id"]), []),
                "children": [
                    node(child) for child in by_parent.get(str(problem["id"]), [])
                ],
            }

        roots = by_parent.get("", [])
        counts: dict[str, int] = {}
        for problem in problems:
            counts[str(problem["status"])] = counts.get(str(problem["status"]), 0) + 1
        return {
            "exists": bool(roots),
            "root": node(roots[0]) if roots else None,
            # Superseded charter versions, oldest first; the current text
            # lives on the root node itself.
            "details_history": history,
            "counts": counts,
        }

    def _revisits_by_problem(
        self, *, conn, project_id: str
    ) -> dict[str, list[dict[str, Any]]]:
        """The decision journal, grouped per problem, oldest first."""
        grouped: dict[str, list[dict[str, Any]]] = {}
        rows = conn.execute(
            """
            SELECT problem_id, kind, verdict, why, payload_json, created_at
            FROM problem_revisits WHERE project_id = ?
            ORDER BY created_at, id
            """,
            (project_id,),
        ).fetchall()
        for row in rows:
            try:
                payload = json.loads(str(row["payload_json"]) or "{}")
            except ValueError:
                payload = {}
            entry: dict[str, Any] = {
                "kind": str(row["kind"]),
                "verdict": str(row["verdict"]),
                "why": str(row["why"]),
                "at": str(row["created_at"]),
            }
            for key in ("summary", "mooted", "children"):
                if payload.get(key):
                    entry[key] = payload[key]
            grouped.setdefault(str(row["problem_id"]), []).append(entry)
        return grouped

    def _root_details_history(
        self, *, conn, project_id: str, problems: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Superseded root charter versions from the refine event journal."""
        root = next(
            (row for row in problems if not str(row["parent_id"])), None
        )
        if root is None:
            return []
        rows = conn.execute(
            """
            SELECT payload_json, created_at FROM events
            WHERE project_id = ? AND type = 'problem.details_refined'
              AND target_id = ?
            ORDER BY id
            """,
            (project_id, str(root["id"])),
        ).fetchall()
        history = []
        for row in rows:
            try:
                payload = json.loads(str(row["payload_json"]) or "{}")
            except ValueError:
                continue
            history.append(
                {
                    "version": int(payload.get("previous_version") or 0),
                    "details": str(payload.get("previous_details") or ""),
                    "superseded_at": str(row["created_at"]),
                }
            )
        return history

    def project_problems(self, *, conn, project_id: str) -> list[dict[str, Any]]:
        return rows_to_dicts(
            rows=conn.execute(
                "SELECT * FROM problems WHERE project_id = ? "
                "ORDER BY created_at, id",
                (project_id,),
            ).fetchall()
        )

    def attempts_with_state(self, *, conn, project_id: str) -> list[dict[str, Any]]:
        """Attempt pairs joined to their work item's live status."""
        rows = rows_to_dicts(
            rows=conn.execute(
                """
                SELECT pa.problem_id, pa.attempt_id, pa.verdict, pa.summary,
                       pa.created_at, pa.resolved_at
                FROM problem_attempts pa
                JOIN problems p ON p.id = pa.problem_id
                WHERE p.project_id = ?
                ORDER BY pa.created_at, pa.attempt_id, pa.problem_id
                """,
                (project_id,),
            ).fetchall()
        )
        state: dict[str, dict[str, Any]] = {}
        for row in rows:
            attempt_id = str(row["attempt_id"])
            if attempt_id not in state:
                kind = attempt_kind_of(attempt_id)
                work = self._attempt_row(
                    conn=conn, project_id=project_id, attempt_id=attempt_id
                )
                state[attempt_id] = {
                    "kind": kind,
                    "name": str(work["name"] or ""),
                    "status": str(work["status"]),
                }
        return [
            {
                "problem_id": str(row["problem_id"]),
                "id": str(row["attempt_id"]),
                "verdict": str(row["verdict"]),
                "summary": str(row["summary"]),
                **state[str(row["attempt_id"])],
            }
            for row in rows
        ]

    def latest_revisits(self, *, conn, project_id: str) -> dict[str, str]:
        """problem_id -> created_at of its most recent revisit row."""
        return {
            str(row["problem_id"]): str(row["created_at"])
            for row in conn.execute(
                """
                SELECT problem_id, MAX(created_at) AS created_at
                FROM problem_revisits WHERE project_id = ?
                GROUP BY problem_id
                """,
                (project_id,),
            ).fetchall()
        }

    # ---- internals ----

    def _spawn_children(
        self,
        *,
        conn,
        project_id: str,
        parent: dict[str, Any],
        children: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        items = list(children or [])
        if not items:
            raise ValidationError(
                "children is required: 1-"
                f"{MAX_CHILDREN_PER_STEP} subproblems that can be worked on "
                "in parallel TODAY, each strictly narrower than the parent, "
                "with no dependency on each other or on unstated results. If "
                "none exist, the problem is stuck, not decomposable."
            )
        if len(items) > MAX_CHILDREN_PER_STEP:
            raise ValidationError(
                f"{len(items)} children at once is too many (max "
                f"{MAX_CHILDREN_PER_STEP}) — a wider fan-out is usually a "
                "sign the split is not really independent"
            )
        depth = int(parent["depth"]) + 1
        if depth > MAX_DEPTH:
            raise WorkflowError(
                f"depth limit reached ({MAX_DEPTH}): this problem cannot be "
                "decomposed further — attempt it directly or mark it stuck"
            )
        statements = []
        for item in items:
            statement = validate_statement((item or {}).get("statement"))
            statements.append((statement, _child_details((item or {}).get("details"))))
        lowered = [statement.casefold() for statement, _ in statements]
        if len(set(lowered)) != len(lowered):
            raise ValidationError("children contain duplicate statements")
        placeholders = ", ".join("?" for _ in lowered)
        clash = conn.execute(
            f"SELECT statement FROM problems WHERE project_id = ? "
            f"AND lower(statement) IN ({placeholders})",
            (project_id, *lowered),
        ).fetchone()
        if clash is not None:
            raise ValidationError(
                f"a problem with the statement {str(clash['statement'])!r} "
                "already exists in this project — duplicate problems mean "
                "duplicate work; reference the existing node instead"
            )
        now = now_iso()
        spawned = []
        for statement, details in statements:
            child_id = new_id(prefix="prob")
            conn.execute(
                """
                INSERT INTO problems
                  (id, project_id, parent_id, statement, details,
                   details_version, status, summary, depth, revisit_count,
                   created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, 'open', '', ?, 0, ?, ?)
                """,
                (child_id, project_id, parent["id"], statement, details, depth, now, now),
            )
            spawned.append({"id": child_id, "statement": statement, "depth": depth})
        return spawned

    def _load_problems(
        self, *, conn, project_id: str, ids: list[str]
    ) -> list[dict[str, Any]]:
        problems = []
        for problem_id in ids:
            row = conn.execute(
                "SELECT * FROM problems WHERE id = ? AND project_id = ?",
                (problem_id, project_id),
            ).fetchone()
            if row is None:
                raise NotFoundError(
                    f"problem not found in project {project_id}: {problem_id}"
                )
            problems.append(row_to_dict(row=row) or {})
        return problems

    def _attempt_row(self, *, conn, project_id: str, attempt_id: str) -> dict[str, Any]:
        table = "experiments" if attempt_kind_of(attempt_id) == "experiment" else "tasks"
        row = conn.execute(
            f"SELECT id, name, status FROM {table} WHERE id = ? AND project_id = ?",
            (attempt_id, project_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(
                f"attempt not found in project {project_id}: {attempt_id}"
            )
        return row_to_dict(row=row) or {}

    def _status_of(self, *, conn, problem_id: str) -> str:
        row = conn.execute(
            "SELECT status FROM problems WHERE id = ?", (problem_id,)
        ).fetchone()
        return str(row["status"]) if row is not None else ""
