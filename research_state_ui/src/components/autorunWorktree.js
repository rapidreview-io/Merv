// Which jobs share a worktree. Pure: reads the session rows the brain lists.
// The branch (workspace_ref) is the identity — same branch, same worktree,
// so a later job there is continuing the earlier one's work.

function startedAt(session) {
  return Date.parse(session?.activated_at || session?.created_at || '') || 0;
}

/**
 * @returns {{ branch: string, before: object[], after: object[] }}
 *   before/after: other sessions on the same branch, oldest first, split
 *   around this session's start. Empty when the job reported no worktree.
 */
export function worktreeLineage(session, sessions = []) {
  const branch = String(session?.workspace_ref || '').trim();
  if (!branch) return { branch: '', before: [], after: [] };
  const mine = startedAt(session);
  const others = (sessions || [])
    .filter((other) => other && other.id !== session.id && String(other.workspace_ref || '').trim() === branch)
    .sort((a, b) => startedAt(a) - startedAt(b));
  return {
    branch,
    before: others.filter((other) => startedAt(other) <= mine),
    after: others.filter((other) => startedAt(other) > mine),
  };
}
