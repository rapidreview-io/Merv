/**
 * Where the map of work draws everything, from one measured width. Work joined by
 * prerequisites is one chain, and a chain reads down the page as the landing page draws it:
 * each unit stands one row below the last thing it waits on, as near under it as its row
 * allows. What waits on nothing stands just above the first thing that waits on it, or,
 * where that row is full, in the nearest row above with room. Chains and single units are
 * then set side by side on one grid of columns, each in the first free place it fits. A
 * chain keeps, in every row, the columns its cards and its lines reach, so the map is as
 * short as its work allows and no chain's lines cross another's.
 *
 * A line leaves the foot of the prerequisite, turns in the gap under its row, and arrives
 * from above with an arrowhead at the head of what waits on it. Lines are straight runs
 * joined at right angles. Prerequisites of the same things turn at one height, so their
 * lines meet and run on as one; the others in the row each turn at a height of their own,
 * so two lines that are not the same never lie on top of each other. Lines that have to
 * pass a row run down a gutter between two columns, which the grid keeps free: those that
 * left one turn for one row share a lane of it, and every other bundle has its own.
 *
 * It is pure, so the drawing is the same wherever it is asked, and it is tested without a
 * browser. Below MAP_MIN there is no room for two columns of cards and their lines, and the
 * page draws no map: the list under it says the same relations in words.
 */

/** Narrower than this no map is drawn. */
export const MAP_MIN = 560;
export const CARD_H = 116;
const CARD_MIN = 208;
const CARD_MAX = 288;
/** Between two columns: room for the lanes of lines running down past a row. */
const GAP_X = 24;
/** Between two rows: the turns of the row above, then where a gutter's lines come in. */
const GAP_Y = 48;
const ARRIVE = 12;

export interface MapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A prerequisite and what waits on it. `waiting` while the prerequisite is unsettled. */
export interface MapEdge {
  from: string;
  to: string;
  waiting?: boolean;
}
export interface MapWire extends MapEdge {
  d: string;
  /** The arrowhead at the head of what waits. */
  head: string;
}
export interface WorkMapLayout {
  width: number;
  height: number;
  at: Map<string, MapBox>;
  /** Reading order: rows top to bottom, left to right. The keyboard follows it. */
  order: string[];
  wires: MapWire[];
}
interface Cell {
  col: number;
  row: number;
}

/** The free column nearest the one wanted, looking right before left. */
function nearest(want: number, cols: number, taken: Set<number>): number {
  for (let off = 0; off < cols; off++)
    for (const col of [want + off, want - off])
      if (col >= 0 && col < cols && !taken.has(col)) return col;
  return 0;
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const listed = <K, V>(map: Map<K, V[]>, key: K, ...values: V[]) =>
  map.set(key, [...(map.get(key) ?? []), ...values]);

/** Null where there is no room to draw, or nothing to. */
export function workMapLayout(
  keys: readonly string[],
  edges: readonly MapEdge[],
  width: number,
): WorkMapLayout | null {
  if (!(width >= MAP_MIN) || !keys.length) return null;
  const index = new Map(keys.map((key, n) => [key, n]));
  const drawn = [
    ...new Map(
      edges
        .filter((edge) => edge.from !== edge.to && index.has(edge.from) && index.has(edge.to))
        .map((edge) => [`${edge.from}>${edge.to}`, edge]),
    ).values(),
  ];
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const edge of drawn) {
    listed(before, edge.to, edge.from);
    listed(after, edge.from, edge.to);
  }
  // The longest way back to something that waits on nothing; a cycle stops where it closes.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    const d = Math.max(-1, ...(before.get(key) ?? []).map(depthOf)) + 1;
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  keys.forEach(depthOf);

  const cols = Math.floor((width + GAP_X) / (CARD_MIN + GAP_X));
  const w = Math.min(CARD_MAX, Math.floor((width - (cols - 1) * GAP_X) / cols));

  /** One chain on a grid of its own: its rows, and each unit as near its relations as it fits. */
  const block = (members: string[]) => {
    const least = Math.min(...members.map((key) => depth.get(key)!));
    const first = (key: string) => !before.has(key) && after.has(key);
    const levels: string[][] = [];
    for (const key of members) if (!first(key)) (levels[depth.get(key)! - least] ??= []).push(key);
    // The topmost first, so one that finds its row full can stand beside them.
    const above = (key: string) =>
      Math.min(...after.get(key)!.map((next) => depth.get(next)!)) - 1 - least;
    for (const key of members.filter(first).sort((a, b) => above(a) - above(b))) {
      let level = above(key);
      while (level >= 0 && !((levels[level]?.length ?? 0) % cols)) level--;
      (levels[level < 0 ? above(key) : level] ??= []).push(key);
    }
    const cell = new Map<string, Cell>();
    const rows: Set<number>[] = [];
    const over = (key: string, related: Map<string, string[]>) => {
      const placed = (related.get(key) ?? []).flatMap((other) => cell.get(other)?.col ?? []);
      return placed.length ? mean(placed) : undefined;
    };
    for (const level of levels.filter(Boolean)) {
      const sorted = [...level].sort(
        (a, b) =>
          (over(a, before) ?? Infinity) - (over(b, before) ?? Infinity) ||
          index.get(a)! - index.get(b)!,
      );
      let taken = new Set<number>();
      rows.push(taken);
      for (const key of sorted) {
        // A level wider than the page carries on in a row of its own.
        if (taken.size === cols) rows.push((taken = new Set()));
        const col = nearest(Math.round(over(key, before) ?? 0), cols, taken);
        taken.add(col);
        cell.set(key, { col, row: rows.length - 1 });
      }
    }
    // From the foot up, each unit moves over the middle of what waits on it where that
    // place is free, so one prerequisite of several stands over them and not at their edge.
    for (const key of [...cell.keys()].reverse()) {
      const { col, row } = cell.get(key)!;
      const want = over(key, after);
      if (want === undefined || Math.round(want) === col || rows[row]!.has(Math.round(want)))
        continue;
      rows[row]!.delete(col);
      rows[row]!.add(Math.round(want));
      cell.set(key, { col: Math.round(want), row });
    }
    const left = Math.min(...[...cell.values()].map(({ col }) => col));
    for (const [key, { col, row }] of cell) cell.set(key, { col: col - left, row });
    // The columns each row keeps: its cards, and every line from a card down to what waits.
    const spans = rows.map((): [number, number] => [Infinity, -Infinity]);
    const reach = (row: number, col: number) =>
      (spans[row] = [Math.min(spans[row]![0], col), Math.max(spans[row]![1], col)]);
    for (const [key, { col, row }] of cell) {
      reach(row, col);
      for (const next of after.get(key) ?? [])
        for (let r = row; r <= cell.get(next)!.row; r++) {
          reach(r, col);
          reach(r, cell.get(next)!.col);
        }
    }
    return { cell, spans };
  };

  // Chains in the order of their first unit, each in the first free place it fits.
  const place = new Map<string, Cell>();
  const used: boolean[][] = [];
  const seen = new Set<string>();
  for (const head of keys) {
    if (seen.has(head)) continue;
    const members = [head];
    seen.add(head);
    for (const key of members)
      for (const other of [...(before.get(key) ?? []), ...(after.get(key) ?? [])])
        if (!seen.has(other)) {
          seen.add(other);
          members.push(other);
        }
    members.sort((a, b) => index.get(a)! - index.get(b)!);
    const { cell, spans } = block(members);
    const wide = Math.max(...spans.map(([, hi]) => hi)) + 1;
    const kept = (row: number, col: number) =>
      spans.flatMap(([lo, hi], r) =>
        Array.from({ length: hi - lo + 1 }, (_, c): Cell => ({ row: row + r, col: col + lo + c })),
      );
    let [row, col] = [0, 0];
    while (kept(row, col).some((at) => used[at.row]?.[at.col]))
      if (++col > cols - wide) [row, col] = [row + 1, 0];
    for (const at of kept(row, col)) (used[at.row] ??= [])[at.col] = true;
    for (const [key, local] of cell) place.set(key, { col: col + local.col, row: row + local.row });
  }
  // The drawing stands in the middle of its frame: a lone chain is not pushed to the left
  // edge of a wide page, and a full page of cards starts where it always did.
  const across = Math.max(...[...place.values()].map(({ col }) => col)) + 1;
  const inset = Math.round((width - (across * (w + GAP_X) - GAP_X)) / 2);
  const at = new Map<string, MapBox>();
  for (const [key, { col, row }] of place)
    at.set(key, { x: inset + col * (w + GAP_X), y: row * (CARD_H + GAP_Y), w, h: CARD_H });

  const rowOf = (key: string) => place.get(key)!.row;
  const colOf = (key: string) => place.get(key)!.col;
  // Prerequisites of the same things share a turn; the others of a row each have their own.
  const waited = (key: string) => [...after.get(key)!].sort().join('\n');
  const turns = new Map<number, string[]>();
  for (const key of [...after.keys()].sort((a, b) => colOf(a) - colOf(b)))
    if (!turns.get(rowOf(key))?.includes(waited(key))) listed(turns, rowOf(key), waited(key));
  // Lines past a row: those of one turn bound for one row are a bundle, which runs down the
  // gutter nearest the middle of what it joins, in a lane beside the gutter's other bundles.
  const bundle = (edge: MapEdge) => `${rowOf(edge.from)} ${rowOf(edge.to)} ${waited(edge.from)}`;
  const joins = new Map<string, number[]>();
  for (const edge of drawn)
    if (rowOf(edge.to) !== rowOf(edge.from) + 1)
      listed(joins, bundle(edge), colOf(edge.from), colOf(edge.to));
  const gutterOf = (id: string) => Math.min(cols - 1, Math.floor(mean(joins.get(id)!)) + 1);
  const lanes = new Map<number, string[]>();
  for (const id of [...joins.keys()].sort((a, b) => mean(joins.get(a)!) - mean(joins.get(b)!)))
    listed(lanes, gutterOf(id), id);
  const laneOf = (id: string) => {
    const beside = lanes.get(gutterOf(id))!;
    return Math.round(
      inset +
        gutterOf(id) * (w + GAP_X) -
        GAP_X / 2 +
        (beside.indexOf(id) - (beside.length - 1) / 2) * Math.min(6, 16 / beside.length),
    );
  };
  // Where a prerequisite's lines leave its foot: the middle, or beside it where the card
  // straight under it waits on others and not on it, whose lines come in at that middle.
  const standing = new Map([...place].map(([key, { col, row }]) => [`${row} ${col}`, key]));
  const leave = (key: string) => {
    const box = at.get(key)!;
    const under = standing.get(`${rowOf(key) + 1} ${colOf(key)}`);
    if (!under || !before.has(under) || before.get(under)!.includes(key)) return box.x + box.w / 2;
    const left = mean(after.get(key)!.map((next) => at.get(next)!.x)) < box.x;
    return box.x + box.w / 2 + (left ? -16 : 16);
  };
  const wires = drawn.map((edge): MapWire => {
    const [a, b] = [at.get(edge.from)!, at.get(edge.to)!];
    const [x1, x2] = [leave(edge.from), b.x + b.w / 2];
    const beside = turns.get(rowOf(edge.from))!;
    const turn = Math.round(
      a.y +
        a.h +
        ((GAP_Y - ARRIVE - 4) * (beside.indexOf(waited(edge.from)) + 1)) / (beside.length + 1),
    );
    const id = bundle(edge);
    return {
      ...edge,
      d: joins.has(id)
        ? `M${x1} ${a.y + a.h}V${turn}H${laneOf(id)}V${b.y - ARRIVE}H${x2}V${b.y}`
        : `M${x1} ${a.y + a.h}V${turn}H${x2}V${b.y}`,
      head: `M${x2 - 4} ${b.y - 6}L${x2} ${b.y}L${x2 + 4} ${b.y - 6}`,
    };
  });
  const order = [...place.keys()].sort((a, b) => rowOf(a) - rowOf(b) || colOf(a) - colOf(b));
  return { width, height: used.length * (CARD_H + GAP_Y) - GAP_Y, at, order, wires };
}

/** The card straight below (or above) this one: the nearest row that way, nearest across. */
export function beneath(layout: WorkMapLayout, key: string, down: boolean): string | undefined {
  const from = layout.at.get(key);
  if (!from) return undefined;
  const rows = layout.order
    .map((other) => ({ key: other, box: layout.at.get(other)! }))
    .filter(({ box }) => (down ? box.y > from.y : box.y < from.y));
  if (!rows.length) return undefined;
  const y = (down ? Math.min : Math.max)(...rows.map(({ box }) => box.y));
  return rows
    .filter(({ box }) => box.y === y)
    .sort((a, b) => Math.abs(a.box.x - from.x) - Math.abs(b.box.x - from.x))[0]?.key;
}
