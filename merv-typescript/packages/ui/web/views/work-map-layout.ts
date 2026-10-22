/**
 * Where the map of work draws everything, on a canvas that scrolls inside the page. A unit is
 * a mark and a name; a prerequisite stands in the column left of what waits on it, so every
 * line runs left to right and position says the order before any line does. Work joined by
 * prerequisites is one chain; each chain has its own rows, and chains stack down the canvas in
 * the order their work was given. Within a chain a unit stands level with what it waits on
 * where that row is free, else in the nearest free row under it, so lines are short and never
 * cross a mark; a column holding one unit stands at the chain's middle, so a run of steps
 * reads as one line through the chain rather than hanging from its top.
 *
 * Columns keep one width whatever the room, so names keep theirs: the canvas grows past the
 * view and scrolls. Every chain ends at the right, where the newest work is, and the drawing
 * stands at the canvas's right edge and its vertical middle when the view holds it whole.
 *
 * A line runs from the end of a unit's name into the gutter after its column, down or up
 * the gutter to the row of what waits on it, and in to that mark: three straight runs, with
 * no head, the direction being the page's. Lines that leave one unit share the gutter run, so
 * a unit many things wait on reads as one trunk with a stub to each, never a fan of curves;
 * lines that arrive at one unit meet the same way. No line crosses a name. Within a column,
 * what needs a person stands first, then what is live, then the rest, the ended last. Work
 * joined to nothing is set in a grid of its own after the chains, filled from the right.
 * Groups (the cycles) stack down the canvas, each laid out alone, a gap between them. It is
 * pure, so the drawing is the same wherever it is asked, and it is tested without a browser.
 * Below MAP_MIN the page draws no map: the list under it says the same relations in words.
 */

/** Narrower than this no map is drawn. */
export const MAP_MIN = 520;
/** A row: one mark and its name. */
export const ROW_H = 36;
/** Half a mark: where a line leaves and arrives. */
export const MARK = 7;
/** A column: a mark, its name, and the gutter after it. */
const COL = 260;
/** Room around the drawing, and the wider room after its newest column. */
const PAD = 40;
const END = 96;
/** Between a name's end and the next column: where a line runs. */
export const GUTTER = 28;
/** Between two groups. */
const GROUP_GAP = 36;

export interface MapEdge {
  from: string;
  to: string;
  /** The prerequisite is unsettled: the line is dashed. */
  waiting?: boolean;
}
export interface MapWire extends MapEdge {
  d: string;
}
/** Where a unit's mark is centred. */
export interface MapPlace {
  x: number;
  y: number;
  /** The room its name has: its column's width. */
  w: number;
}
export interface WorkMapLayout {
  /** The canvas: at least the view, more where the drawing needs it. */
  width: number;
  height: number;
  at: Map<string, MapPlace>;
  /** Reading order: row by row, left to right. */
  order: string[];
  wires: MapWire[];
  /** Where each group after the first begins: a rule is drawn over it. */
  rules: number[];
}

/** Everything each unit waits on, and everything that waits on it. */
function neighbours(keys: string[], edges: MapEdge[]) {
  const up = new Map<string, string[]>(keys.map((key) => [key, []]));
  const down = new Map<string, string[]>(keys.map((key) => [key, []]));
  for (const edge of edges) {
    if (!up.has(edge.to) || !down.has(edge.from)) continue;
    up.get(edge.to)!.push(edge.from);
    down.get(edge.from)!.push(edge.to);
  }
  return { up, down };
}

/**
 * Each unit's column: one past the deepest thing it waits on, from zero. A ring, which no
 * owner should send, is cut where it closes, so every unit still has a column.
 */
export function depths(keys: string[], edges: MapEdge[]): Map<string, number> {
  const { up } = neighbours(keys, edges);
  const depth = new Map<string, number>();
  const walking = new Set<string>();
  const of = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (walking.has(key)) return 0;
    walking.add(key);
    const d = Math.max(-1, ...up.get(key)!.map(of)) + 1;
    walking.delete(key);
    depth.set(key, d);
    return d;
  };
  for (const key of keys) of(key);
  return depth;
}

/** The chains: every unit joined to another by any line, in the order their work was given. */
function chains(keys: string[], edges: MapEdge[]): string[][] {
  const { up, down } = neighbours(keys, edges);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    const chain: string[] = [];
    const queue = [key];
    seen.add(key);
    while (queue.length) {
      const here = queue.shift()!;
      chain.push(here);
      for (const next of [...up.get(here)!, ...down.get(here)!])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    out.push(chain);
  }
  return out;
}

export function workMapLayout(
  keys: string[],
  edges: MapEdge[],
  view: { width: number; height: number },
  {
    ended = new Set(),
    held = new Set(),
    groups = [keys],
  }: {
    /** Units that have ended, which stand last in their column. */
    ended?: Set<string>;
    /** Units live or needing a person, which stand first in theirs. */
    held?: Set<string>;
    /** The keys in groups, top to bottom; a key in none is drawn in the first. */
    groups?: string[][];
  } = {},
): WorkMapLayout | null {
  if (view.width < MAP_MIN || !keys.length) return null;
  const kept = edges.filter((edge) => edge.from !== edge.to);
  const depth = depths(keys, kept);
  const { up, down } = neighbours(keys, kept);
  const grouped = new Set(groups.flat());
  const sets = groups
    .map((group, index) =>
      index
        ? group.filter((key) => keys.includes(key))
        : [...group, ...keys.filter((key) => !grouped.has(key))],
    )
    .filter((group) => group.length)
    .map((group) => ({
      joined: chains(group, kept).filter((chain) => chain.length > 1),
      alone: group.filter((key) => !up.get(key)!.length && !down.get(key)!.length),
    }));
  const columnsOf = (chain: string[]) => Math.max(...chain.map((key) => depth.get(key)!)) + 1;
  // Every chain ends in the last column; work joined to nothing fills as many as the view holds.
  const viewCols = Math.max(1, Math.floor((view.width - PAD - END) / COL));
  const cols = Math.max(
    1,
    ...sets.flatMap(({ joined, alone }) => [
      ...joined.map(columnsOf),
      Math.min(alone.length, viewCols),
    ]),
  );
  // Places are worked out from the drawing's own corner, then moved onto the canvas.
  const at = new Map<string, MapPlace>();
  const rules: number[] = [];
  const place = (key: string, column: number, row: number) =>
    at.set(key, { x: column * COL + MARK, y: row * ROW_H + ROW_H / 2, w: COL });
  let row = 0;
  let top = 0;
  for (const [index, { joined, alone }] of sets.entries()) {
    if (index && row) {
      top += GROUP_GAP;
      rules.push(row * ROW_H + top - GROUP_GAP / 2);
    }
    for (const chain of joined) {
      const shift = cols - columnsOf(chain);
      // Rows within the chain: column by column, each unit level with the first thing it waits
      // on where that row is still free in its column, else the nearest free row below.
      const taken = new Map<number, Set<number>>();
      const rowOf = new Map<string, number>();
      const rank = (key: string) => (held.has(key) ? 0 : ended.has(key) ? 2 : 1);
      const ordered = [...chain].sort((a, b) => depth.get(a)! - depth.get(b)! || rank(a) - rank(b));
      for (const key of ordered) {
        const used = taken.get(depth.get(key)!) ?? new Set<number>();
        taken.set(depth.get(key)!, used);
        const parents = up.get(key)!.map((parent) => rowOf.get(parent) ?? 0);
        let r = parents.length ? Math.min(...parents) : 0;
        while (used.has(r)) r++;
        used.add(r);
        rowOf.set(key, r);
      }
      const deepest = Math.max(...rowOf.values());
      for (const key of chain) {
        const column = depth.get(key)!;
        const single = taken.get(column)!.size === 1;
        place(key, shift + column, row + (single ? deepest / 2 : rowOf.get(key)!) + top / ROW_H);
      }
      row += deepest + 1;
    }
    // What waits on nothing and holds nothing up: a grid, filled from the right.
    const across = Math.min(cols, Math.max(1, alone.length));
    alone.forEach((key, n) =>
      place(key, cols - 1 - (n % across), row + Math.floor(n / across) + top / ROW_H),
    );
    row += Math.ceil(alone.length / across);
  }
  const drawn = { width: cols * COL, height: top + row * ROW_H };
  const width = Math.max(view.width, PAD + drawn.width + END);
  const height = Math.max(view.height, drawn.height + 2 * PAD);
  const dx = width - END - drawn.width;
  const dy = Math.round((height - drawn.height) / 2);
  for (const spot of at.values()) {
    spot.x += dx;
    spot.y += dy;
  }
  const wires = kept
    .filter((edge) => at.has(edge.from) && at.has(edge.to))
    .map((edge) => {
      const a = at.get(edge.from)!;
      const b = at.get(edge.to)!;
      // From the end of the name's room, so the line runs through no name.
      const x1 = a.x - MARK + a.w - GUTTER + 6;
      const x2 = b.x - MARK - 2;
      // The gutter run: where every line leaving this unit turns, so they lie as one.
      const xt = a.x - MARK + a.w - GUTTER / 2;
      return { ...edge, d: `M${x1} ${a.y}H${xt}V${b.y}H${x2}` };
    });
  const order = [...at].sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([key]) => key);
  return { width, height, at, order, wires, rules: rules.map((y) => y + dy) };
}

/** The unit nearest straight under (or over) the one in hand, for the keyboard. */
export function beneath(layout: WorkMapLayout, key: string, down: boolean): string | undefined {
  const here = layout.at.get(key);
  if (!here) return undefined;
  const rows = [...layout.at]
    .filter(([, place]) => (down ? place.y > here.y : place.y < here.y))
    .sort(([, a], [, b]) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y));
  const nearest = rows[0]?.[1].y;
  return rows
    .filter(([, place]) => place.y === nearest)
    .sort(([, a], [, b]) => Math.abs(a.x - here.x) - Math.abs(b.x - here.x))[0]?.[0];
}
