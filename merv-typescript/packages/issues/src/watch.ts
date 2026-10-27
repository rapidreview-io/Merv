import type { State } from '@merv/contracts';
import type { Issues, SessionTrace } from '@merv/contracts/issues';

const MINUTE = 60_000;
/** The most event ids one flood scan reads. */
const WINDOW = 100_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Sessions' trace of each visit named (`sessions.running.platformTrace`); undefined while
 *  Sessions is absent. */
export type Traces = (
  sessionIds: readonly string[],
) => Promise<Map<string, SessionTrace>> | undefined;

/** Resolves what is no longer reported: a standing condition ten minutes after its last report,
 *  any other issue short of severe after a day. A severe one closes by its owner or an admin. */
export async function quiet(state: State, clock = Date.now): Promise<void> {
  const now = clock();
  const due = `state='open' AND (standing OR level<>'severe') AND ((standing AND last_at<?) OR (NOT standing AND level<>'severe' AND last_at<?))`;
  const since = [iso(now - 10 * MINUTE), iso(now - 1440 * MINUTE)];
  if (!(await state.read((sql) => sql.get(`SELECT 1 FROM issues WHERE ${due} LIMIT 1`, ...since))))
    return;
  await state.transaction((tx) =>
    tx.run(
      `UPDATE issues SET state='resolved', resolved_at=?, resolved_by='quiet' WHERE ${due}`,
      iso(now),
      ...since,
    ),
  );
}

/** The flood scan, from the event head when it is made (no backfill): each call reports every
 *  (type, subject) with 150 or more events since the last call, in windows that never overlap. */
export async function floods(state: State, issues: Issues): Promise<() => Promise<void>> {
  let cursor = await state.eventHead();
  return async () => {
    const head = await state.eventHead();
    const through = Math.min(head, cursor + WINDOW);
    if (through <= cursor) return;
    for (const row of await state.eventCounts(cursor, through, 150))
      issues.report({
        class: 'platform',
        where: 'events',
        code: 'event_flood',
        key: `${row.type} ${row.subjectId}`,
        subject: row.subjectId,
        loop: true,
        level: 'severe',
        n: row.count,
        refs: {
          projectId: row.projectId,
          eventType: row.type,
          subjectId: row.subjectId,
          eventIds: [row.first, row.last],
        },
      });
    // Too far behind to catch up, the scan starts over at the head.
    cursor = head - cursor > WINDOW ? head : through;
  };
}

/** Pins each kept case's visit once: when it has ended, or as it stands a day on. A case whose
 *  session Sessions does not know keeps `{}`. Retirement and the next visit take the rest. Each
 *  pass pages past the cases whose visit is still open. */
export async function pin(state: State, traces: Traces, clock = Date.now): Promise<void> {
  const now = clock();
  for (let after = 0; ;) {
    const rows = await state.read((sql) =>
      sql.all<{ id: string; session_id: string; at: string; rowid: number }>(
        'SELECT id, session_id, at, _merv_rowid AS rowid FROM issue_occurrences WHERE trace_json IS NULL AND session_id IS NOT NULL AND at<? AND _merv_rowid>? ORDER BY _merv_rowid LIMIT 200',
        iso(now - MINUTE),
        after,
      ),
    );
    if (!rows.length) return;
    const found = await traces([...new Set(rows.map((row) => row.session_id))]);
    if (!found) return;
    const pins = rows.flatMap((row): [string, string][] => {
      const trace = found.get(row.session_id);
      if (!trace) return [[row.id, '{}']];
      return trace.closedAt || row.at < iso(now - 1440 * MINUTE)
        ? [[row.id, JSON.stringify(trace)]]
        : [];
    });
    if (pins.length)
      await state.transaction(async (tx) => {
        for (const [id, trace] of pins)
          await tx.run(
            'UPDATE issue_occurrences SET trace_json=? WHERE id=? AND trace_json IS NULL',
            trace,
            id,
          );
      });
    if (rows.length < 200) return;
    after = rows.at(-1)!.rowid;
  }
}
