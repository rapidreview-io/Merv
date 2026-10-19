/**
 * Where the map of work draws everything, from one measured width. A unit is a mark and a
 * name; a prerequisite stands in the column left of what waits on it, so every line runs left
 * to right and position says the order before any line does. Work joined by prerequisites is
 * one chain; each chain has its own rows, and chains stack down the page in the order their
 * work was given. Within a chain a unit stands level with what it waits on where that row is
 * free, else in the nearest free row under it, so lines are short and never cross a mark.
 *
 * A chain longer than the width holds folds its finished head: the leading columns whose
 * every unit has ended are drawn as small marks alone, in one short run, so names begin at
 * the first unit still open and the live edge always has the room. A unit that is live or
 * needs a person is never folded. Pressing the run unfolds it (`unfold`).
 *
 * A line is one quiet curve from the right of a mark to the left of the mark that waits on
 * it, with no head: the direction is the page's. It is pure, so the drawing is the same
 * wherever it is asked, and it is tested without a browser. Below MAP_MIN there is no room
 * for two columns with names, and the page draws no map: the list under it says the same
 * relations in words.
 */

/** Narrower than this no map is drawn: two columns with their names, or one and a fold. */
export const MAP_MIN = 520;
/** A row: one mark and its name. */
export const ROW_H = 30;
/** Half a mark: where a line leaves and arrives. */
export const MARK = 7;
/** A column with a name beside its mark, at the least and at the most. */
const COL_MIN = 170;
const COL_MAX = 440;
/** A folded mark and the step to the next. */
const FOLD_STEP = 16;
/** Room after the last column for its names. */
const NAME_W = 150;

export interface MapEdge {
  from: string;
  to: string;
  /** The prerequisite is unsettled: the line is dashed. */
  waiting?: boolean;
}
export interface MapWire extends MapEdge {
  d: string;
}
/** Where a unit's mark is centred, and whether it stands folded without its name. */
export interface MapPlace {
  x: number;
  y: number;
  folded: boolean;
  /** The room its name has: its column's width. */
  w: number;
}
export interface WorkMapLayout {
  width: number;
  height: number;
  at: Map<string, MapPlace>;
  /** Reading order: row by row, left to right. */
  order: string[];
  wires: MapWire[];
  /** How many units each chain folded, where it folded any, with the row the run stands in. */
  folds: { x: number; y: number; count: number }[];
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
  width: number,
  {
    ended = new Set(),
    held = new Set(),
    unfold = false,
  }: {
    /** Units that have ended, which a long chain may fold. */
    ended?: Set<string>;
    /** Units never folded: live, or needing a person. */
    held?: Set<string>;
    /** The reader pressed a fold open. */
    unfold?: boolean;
  } = {},
): WorkMapLayout | null {
  if (width < MAP_MIN || !keys.length) return null;
  const kept = edges.filter((edge) => edge.from !== edge.to);
  const depth = depths(keys, kept);
  const { up } = neighbours(keys, kept);
  const at = new Map<string, MapPlace>();
  const folds: WorkMapLayout['folds'] = [];
  let row = 0;
  for (const chain of chains(keys, kept)) {
    const columns = Math.max(...chain.map((key) => depth.get(key)!)) + 1;
    // A chain the width cannot hold with names folds its finished head, then its tail, until
    // it fits or only what must be shown is left.
    let fold = 0;
    let tail = 0;
    const runW = (count: number) => (count ? count * FOLD_STEP + FOLD_STEP : 0);
    const wide = () => (columns - fold - tail) * COL_MIN + NAME_W + runW(fold) + runW(tail) > width;
    if (!unfold) {
      const byColumn = (column: number) => chain.filter((key) => depth.get(key) === column);
      const more = () => wide() && columns - fold - tail > 1;
      while (more() && byColumn(fold).every((key) => ended.has(key) && !held.has(key))) fold++;
      while (more() && byColumn(columns - 1 - tail).every((key) => !held.has(key))) tail++;
    }
    const shown = columns - fold - tail;
    const foldW = runW(fold);
    const tailW = runW(tail);
    const colW = Math.min(
      COL_MAX,
      Math.max(COL_MIN, (width - foldW - tailW - NAME_W) / Math.max(1, shown)),
    );
    const tailX = foldW + shown * colW + NAME_W;
    // Rows within the chain: column by column, each unit level with the first thing it waits
    // on where that row is still free in its column, else the nearest free row below.
    const taken = new Map<number, Set<number>>();
    const rowOf = new Map<string, number>();
    const ordered = [...chain].sort((a, b) => depth.get(a)! - depth.get(b)!);
    let deepest = 0;
    for (const key of ordered) {
      const column = depth.get(key)!;
      const used = taken.get(column) ?? new Set<number>();
      taken.set(column, used);
      const parents = up.get(key)!.map((parent) => rowOf.get(parent) ?? 0);
      let r = parents.length ? Math.min(...parents) : 0;
      while (used.has(r)) r++;
      used.add(r);
      rowOf.set(key, r);
      deepest = Math.max(deepest, r);
      const folded = column < fold || column >= columns - tail;
      const x =
        column < fold
          ? FOLD_STEP + column * FOLD_STEP + MARK
          : column >= columns - tail
            ? tailX + (column - (columns - tail)) * FOLD_STEP + MARK
            : foldW + (column - fold) * colW + MARK;
      at.set(key, { x, y: (row + r) * ROW_H + ROW_H / 2, folded, w: folded ? FOLD_STEP : colW });
    }
    const y = row * ROW_H + ROW_H / 2;
    const counted = (test: (column: number) => boolean) =>
      chain.filter((key) => test(depth.get(key)!)).length;
    if (fold) folds.push({ x: FOLD_STEP, y, count: counted((column) => column < fold) });
    if (tail) folds.push({ x: tailX, y, count: counted((column) => column >= columns - tail) });
    row += deepest + 1;
  }
  const height = row * ROW_H;
  const wires = kept
    .filter((edge) => at.has(edge.from) && at.has(edge.to))
    .map((edge) => {
      const a = at.get(edge.from)!;
      const b = at.get(edge.to)!;
      const x1 = a.x + MARK + 2;
      const x2 = b.x - MARK - 2;
      const mid = (x1 + x2) / 2;
      return { ...edge, d: `M${x1} ${a.y}C${mid} ${a.y} ${mid} ${b.y} ${x2} ${b.y}` };
    });
  const order = [...at].sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([key]) => key);
  return { width, height, at, order, wires, folds };
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
