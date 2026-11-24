import { bodyOf, withBody, blocksOf, type Step } from './chat-events';
import { type EventRow } from './desk-calls';

const TOOL_WINDOW = 240;
export interface ToolWindow {
  rows: EventRow[];
  before?: number;
  after?: number;
  pending?: number;
}
export interface ToolPage extends ToolWindow {
  latest: number;
}

/** A nested tool is the root of its own disclosure, while its children keep their parent. */
export function expandedTool(rows: EventRow[], item: string): Step | undefined {
  const rooted = rows.map((row) => {
    if (row.type !== 'item') return row;
    const body = bodyOf(row);
    if (body.item !== item || !body.parent_tool_use_id) return row;
    const { parent_tool_use_id: _parent, ...root } = body;
    return withBody(row, root);
  });
  return blocksOf(rooted)
    .flatMap((block) => (block.type === 'trail' ? block.steps : []))
    .find((step) => step.item === item);
}

/** Open disclosures advance even while the outer transcript is reading an older window. */
function mergeToolRows(
  kept: EventRow[],
  incoming: EventRow[],
  item: string,
  direction: 'before' | 'after' = 'after',
): EventRow[] {
  const rows = new Map<string, EventRow>();
  for (const row of [...kept, ...incoming]) {
    const body = bodyOf(row);
    if (!(row.type === 'item' && body.item === item) && body.parent_tool_use_id !== item) continue;
    const stream = `stream:${body.parent_tool_use_id}:${body.item}`;
    if (row.type === 'text') {
      const previous = rows.get(stream);
      rows.set(
        stream,
        withBody(
          { ...row, type: 'message' },
          {
            ...body,
            role: 'assistant',
            text: (previous ? bodyOf(previous).text : '') + body.delta,
          },
        ),
      );
    } else if (row.seq) {
      if (row.type === 'message')
        for (const [key, previous] of rows) {
          if (!key.startsWith('stream:')) continue;
          const partial = bodyOf(previous);
          if (
            partial.parent_tool_use_id === body.parent_tool_use_id &&
            (!body.item || partial.item === body.item)
          )
            rows.delete(key);
        }
      rows.set(String(row.seq), row);
    } else if (row.type === 'message') rows.set(stream, row);
  }
  const ordered = [...rows.values()].sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity));
  const own = ordered.filter((row) => row.type === 'item' && bodyOf(row).item === item);
  const allChildren = ordered.filter((row) => bodyOf(row).parent_tool_use_id === item);
  const children =
    direction === 'before' ? allChildren.slice(0, TOOL_WINDOW) : allChildren.slice(-TOOL_WINDOW);
  return [
    ...new Map(
      [...own.slice(0, 1), ...own.slice(-1), ...children].map((row) => [
        row.seq || `stream:${bodyOf(row).item}`,
        row,
      ]),
    ).values(),
  ].sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity));
}

/** Every evicted child remains reachable through an exclusive history cursor. */
export function mergeToolWindow(
  current: ToolWindow,
  page: ToolPage,
  item: string,
  direction: 'before' | 'after' | 'replace',
): ToolWindow {
  const kept =
    direction === 'replace'
      ? current.rows.filter((row) => !row.seq || row.seq > page.latest)
      : current.rows;
  // A late expansion snapshot precedes live deltas already received while it
  // loaded; its old unattributed messages cannot complete those newer streams.
  const rows =
    direction === 'replace'
      ? mergeToolRows(page.rows, kept, item)
      : mergeToolRows(kept, page.rows, item, direction);
  const children = rows.filter((row) => row.seq && bodyOf(row).parent_tool_use_id === item);
  const first = children[0]?.seq,
    last = children.at(-1)?.seq;
  const candidates = [...kept, ...page.rows].filter(
    (row) => row.seq && bodyOf(row).parent_tool_use_id === item,
  );
  // Persisted children observed while an older page was frozen may be newer
  // than an in-flight snapshot. Keep their navigation cursor until fetched.
  const pending = (current.pending ?? 0) > page.latest ? current.pending : undefined;
  return {
    rows,
    pending,
    before:
      first !== undefined && candidates.some((row) => row.seq < first)
        ? first
        : direction !== 'after'
          ? page.before
          : current.before,
    after:
      last !== undefined && candidates.some((row) => row.seq > last)
        ? last
        : direction === 'before'
          ? current.after
          : (page.after ?? (pending ? last : undefined)),
  };
}

/** Reading older child history freezes that page until Newer history is chosen. */
export function liveToolWindow(current: ToolWindow, row: EventRow, item: string): ToolWindow {
  const body = bodyOf(row);
  if (current.after !== undefined && body.parent_tool_use_id === item)
    return { ...current, pending: Math.max(current.pending ?? 0, row.seq) };
  // Only a fetched child snapshot can acknowledge pending children. A later
  // parent completion says nothing about whether those children were loaded.
  return mergeToolWindow(current, { rows: [row], latest: 0, after: current.after }, item, 'after');
}
