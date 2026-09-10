# If you update this file, consult agent_sessions.md and keep it under 100 lines.
"""One durable compare-and-swap per accepted workspace, and its runner lease.

Git and the database cannot commit atomically. A node whose declared execution
advances the central ref produces work its owner may accept; when the owner
does, it records the exact swap here, one runner performs it against the
machine's central ref, and the receipt settles idempotently from the observed
sha after a crash. This module keeps the receipt and decides which runner owns
the attempt. What the advanced work means, and what accepting it implies, stay
with the owner, which reaches this capability by the opaque instance id the
assignment packet already carried.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from typing import Any

from ..kernel.state import BaseStateStore, row_to_dict
from ..kernel.state.store import Connection
from ..kernel.utils import NotFoundError, ValidationError, WorkflowError, new_id, now_iso, parse_iso
from .persistence import AGENT_SESSION_SCHEMA

# How long one runner's attempt is its own. An intent nobody settled, or a
# bound receipt whose owner never finished the follow-up, is recoverable by
# any project runner after this, so a machine that died cannot wedge a swap.
OWNER_LEASE_SECONDS = 10 * 60
_JSON_COLUMNS = (("proposal_parents_json", "proposal_parents", "[]"),
                 ("diffstat_json", "diffstat", "{}"), ("ancestry_json", "ancestry", "{}"))


def _decoded(row) -> dict[str, Any] | None:
    result = row_to_dict(row=row)
    if result is None:
        return None
    for column, field, empty in _JSON_COLUMNS:
        result[field] = json.loads(str(result.pop(column, empty) or empty))
    return result


class WorkspaceAdvances:
    """The receipts of every central compare-and-swap, past and in flight."""

    def __init__(self, *, store: BaseStateStore) -> None:
        self.store = store
        store.install(AGENT_SESSION_SCHEMA)

    def latest(self, *, conn: Connection, proposal_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
        """The newest receipt per proposal, decoded, for the ids that have one."""
        if not proposal_ids:
            return {}
        rows = conn.execute(
            f"SELECT * FROM workspace_advances WHERE proposal_id IN ({', '.join('?' * len(proposal_ids))}) "
            "ORDER BY intended_at", proposal_ids).fetchall()
        return {str(row["proposal_id"]): decoded for row in rows if (decoded := _decoded(row))}

    def receipt(self, *, conn: Connection, advance_id: str) -> dict[str, Any]:
        """What one swap says now: its shas, status, owner and last receipt."""
        return self._row(conn=conn, advance_id=advance_id)

    def unsettled(self, *, conn: Connection, instance_id: str) -> dict[str, str]:
        """The attempt still owing an outcome for this instance, id and status."""
        row = conn.execute(
            "SELECT id, status FROM workspace_advances WHERE instance_id = ? "
            "AND status IN ('intended', 'bound') ORDER BY status, intended_at LIMIT 1",
            (instance_id,)).fetchone()
        return {} if row is None else {"id": str(row["id"]), "status": str(row["status"])}

    def intend(self, *, conn: Connection, instance_id: str, proposal_id: str, expected_sha: str,
               target_sha: str, runner_id: str) -> tuple[dict[str, Any], str]:
        """Record the swap ``runner_id`` may perform; also who owned it before.

        A settled swap is never re-offered: its work either reached central or
        must be proposed again against the head that moved.
        """
        existing = conn.execute("SELECT * FROM workspace_advances WHERE proposal_id = ?", (proposal_id,)).fetchone()
        if existing is None:
            advance_id = new_id(prefix="adv")
            conn.execute(
                "INSERT INTO workspace_advances (id, instance_id, proposal_id, expected_sha, target_sha, "
                "status, runner_id, intended_at) VALUES (?, ?, ?, ?, ?, 'intended', ?, ?)",
                (advance_id, instance_id, proposal_id, expected_sha, target_sha, runner_id, now_iso()))
            return self._row(conn=conn, advance_id=advance_id), ""
        owner, status = str(existing["runner_id"]), str(existing["status"])
        if status in {"bound", "stale"}:
            raise WorkflowError(f"central advance is already {status}; submit a proposal "
                                "against the current central head")
        if owner != runner_id and self._leased(existing["intended_at"]):
            raise WorkflowError("central advance is owned by another runner; retry after "
                                "its intent lease expires")
        conn.execute("UPDATE workspace_advances SET status = 'intended', runner_id = ?, intended_at = ?, "
                     "observed_sha = '', error = '' WHERE id = ?", (runner_id, now_iso(), existing["id"]))
        return self._row(conn=conn, advance_id=str(existing["id"])), owner

    def settle(self, *, conn: Connection, advance_id: str, runner_id: str, observed_sha: str,
               proposal_parents: tuple[str, ...] = (), diffstat: str = "{}", ancestry: str = "{}",
               error: str = "", stale_reason: str = "") -> dict[str, Any]:
        """Apply one runner receipt to the swap and return what it now says.

        Reaching the target binds the receipt; observing the expected sha again
        means no swap happened and the attempt stands or failed; anything else
        means central moved under it. A bound receipt stays bound, so a settle
        retried after the owner's follow-up was blocked reaches it again.
        """
        row = self._row(conn=conn, advance_id=advance_id)
        owner, status = str(row["runner_id"]), str(row["status"])
        if owner != runner_id and not (status == "bound" and not self._leased(row["bound_at"])):
            # The swap itself is never transferable, but the follow-up of an
            # already-durable bound receipt is: after the owner's lease no Git
            # work remains, mirroring ``intend``'s intent-lease recovery.
            raise ValidationError("central advance belongs to another runner")
        if stale_reason:
            return self._write(conn=conn, advance_id=advance_id, status="stale", observed_sha=observed_sha,
                               error=stale_reason, ancestry=ancestry)
        if status == "bound":
            return row
        if observed_sha == str(row["target_sha"]):
            conn.execute("UPDATE workspace_advances SET status = 'bound', observed_sha = ?, bound_at = ?, "
                         "proposal_parents_json = ?, diffstat_json = ?, ancestry_json = ?, error = '' WHERE id = ?",
                         (observed_sha, now_iso(), json.dumps(list(proposal_parents), sort_keys=True),
                          diffstat, ancestry, advance_id))
            return self._row(conn=conn, advance_id=advance_id)
        held = observed_sha == str(row["expected_sha"])
        return self._write(conn=conn, advance_id=advance_id, ancestry=ancestry, observed_sha=observed_sha,
                           status="failed" if held and error else "intended" if held else "stale",
                           error=str(error or ("" if held else "central moved"))[:1000])

    def cancel(self, *, conn: Connection, instance_id: str, reason: str) -> None:
        """Retire this instance's unperformed intents; a bound receipt stands."""
        conn.execute("UPDATE workspace_advances SET status = 'stale', error = ? "
                     "WHERE instance_id = ? AND status = 'intended'", (reason, instance_id))

    def note(self, *, conn: Connection, advance_id: str, error: str) -> None:
        """Record why the owner's follow-up to a bound receipt has not finished."""
        conn.execute("UPDATE workspace_advances SET error = ? WHERE id = ?", (error, advance_id))

    def _write(self, *, conn: Connection, advance_id: str, status: str, observed_sha: str,
               error: str, ancestry: str) -> dict[str, Any]:
        conn.execute("UPDATE workspace_advances SET status = ?, observed_sha = ?, error = ?, ancestry_json = ? "
                     "WHERE id = ?", (status, observed_sha, error, ancestry, advance_id))
        return self._row(conn=conn, advance_id=advance_id)

    def _row(self, *, conn: Connection, advance_id: str) -> dict[str, Any]:
        row = _decoded(conn.execute("SELECT * FROM workspace_advances WHERE id = ?", (advance_id,)).fetchone())
        if row is None:
            raise NotFoundError(f"central advance not found: {advance_id}")
        return row

    @staticmethod
    def _leased(since: Any) -> bool:
        moment = parse_iso(since)
        return moment is not None and moment + timedelta(seconds=OWNER_LEASE_SECONDS) > datetime.now(UTC)


__all__ = ["OWNER_LEASE_SECONDS", "WorkspaceAdvances"]
