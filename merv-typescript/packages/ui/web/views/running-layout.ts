import type {
  RunningBoard,
  RunningEdge,
  RunningKey,
  RunningLaneName,
  RunningNode,
} from '@merv/contracts/running';

/**
 * Where the Running board draws everything, from one measured width. Three bands stand
 * one under the other — the work, the sessions on it, the machines they use — and each is
 * its heading and then its cards. Work is laid out by what waits on what: a chain of
 * prerequisites reads left to right, and a piece of work nothing relates to takes the next
 * free place. A session stands under the work it is on and a machine under the session or
 * work it serves, as near as the row allows, so the eye goes straight down a relation
 * before any line is drawn. The lines between bands are drawn only for what is in hand
 * (the page decides that); the lines inside the Work band are always there, because a
 * prerequisite is a fact about the work and not about the reader's selection.
 *
 * It is pure, so the drawing is the same wherever it is asked, and it is tested without a
 * browser. Below MIN_WIDTH there is no room for three bands of cards and their lines, and
 * the page says the same relations in words instead.
 */

export const LANES: readonly RunningLaneName[] = ['work', 'sessions', 'hardware'];
/** Narrower than this the bands become lists. */
export const MIN_WIDTH = 560;
/** Between the band's edge and its first or last card. */
const INSET = 16;
/** Between two cards, and between two rows of them. */
const GAP = 16;
/** Between two columns of one chain of work: room for the elbow and its arrowhead. */
const STEP = 40;
/** Under the last row of a band. */
const FOOT = 16;
/** A band's heading line, where the page has not measured the one it drew. */
export const HEAD = 44;
const CARD_W: Record<RunningLaneName, number> = { work: 208, sessions: 196, hardware: 196 };
/**
 * The face each lane allows, in the pixels of the type it is set in: a card's padding and
 * hairline, its kind word, a title clamped to two lines, and two lines of one row each. A
 * machine that counts its accelerators draws their cells above the title. Nothing on a
 * face wraps past these, so a card's height is known before it is drawn.
 */
const FACE = { chrome: 20, kind: 20, title: 36, line: 20, units: 28 };

/** How tall a card of this lane is, given whether its kinds mix and whether it counts units. */
export function cardHeight(lane: RunningLaneName, face: { kinds?: boolean; units?: boolean } = {}) {
  const shared = FACE.chrome + FACE.title + 2 * FACE.line;
  if (lane === 'work') return shared + (face.kinds ? FACE.kind : 0);
  if (lane === 'hardware') return shared + (face.units ? FACE.units : 0);
  return shared;
}

export interface RunningBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RunningPath {
  edge: RunningEdge;
  d: string;
  /** The arrowhead into the dependent, for a line inside the Work band. */
  head?: string;
  /** Between two bands: drawn only while one of its ends is in hand. */
  cross: boolean;
}
export interface RunningLayout {
  width: number;
  height: number;
  bands: { lane: RunningLaneName; top: number; height: number; head: number }[];
  at: Map<RunningKey, RunningBox>;
  /** Reading order: lane by lane, rows top to bottom, left to right. The keyboard follows it. */
  order: RunningKey[];
  paths: RunningPath[];
  /** The end of every line between bands, so a card says it has one before it is lit. */
  ports: { key: RunningKey; x: number; y: number }[];
  /** Grey cells where a lane whose source has never been read will draw. */
  ghosts: (RunningBox & { lane: RunningLaneName })[];
}

/** Whether the work lane holds more than one kind, so its cards print theirs. */
export const kindsMix = (board: RunningBoard) =>
  new Set(board.lanes.work.nodes.map((node) => node.kind ?? '')).size > 1;

/** The node a key names on the board: itself, or the node that absorbed it. */
export function absorberOf(board: RunningBoard, key: RunningKey): RunningNode | undefined {
  for (const lane of LANES)
    for (const node of board.lanes[lane].nodes)
      if (node.key === key || node.aliases?.includes(key)) return node;
  return undefined;
}

/**
 * What is lit when a key is in hand: everything it reaches through the relations between
 * bands, however far (the task, the sessions on it, their machines), and of the work it
 * waits on or holds up only its direct neighbours. A walk through prerequisites would light
 * a whole chain, and a board where most things are lit tells the reader nothing.
 */
export function related(board: RunningBoard, key: RunningKey): Set<RunningKey> {
  const start = absorberOf(board, key)?.key ?? key;
  const lit = new Set([start]);
  const queue = [start];
  const across = board.edges.filter((edge) => edge.verb !== 'waits on');
  while (queue.length) {
    const at = queue.shift()!;
    for (const edge of across) {
      const other = edge.from === at ? edge.to : edge.to === at ? edge.from : undefined;
      if (other && !lit.has(other)) {
        lit.add(other);
        queue.push(other);
      }
    }
  }
  for (const edge of board.edges)
    if (edge.verb === 'waits on') {
      if (edge.from === start) lit.add(edge.to);
      if (edge.to === start) lit.add(edge.from);
    }
  return lit;
}

interface Placed {
  at: Map<RunningKey, { x: number; y: number }>;
  /** The top of the block of rows each card stands in, for a line routed above them. */
  block: Map<RunningKey, number>;
  height: number;
}

/**
 * The Work band. Work joined by prerequisites is one chain, and a chain reads left to
 * right: each piece of work stands one column past the furthest thing it waits on, and a
 * column keeps the lane's own order top to bottom. Chains follow one another in the lane's
 * order, and the next starts a new block of rows when it does not fit beside the last; a
 * chain wider than the band carries its columns on into the next block.
 */
function workBand(nodes: RunningNode[], edges: RunningEdge[], width: number, h: number): Placed {
  const w = CARD_W.work;
  const index = new Map(nodes.map((node, n) => [node.key, n]));
  const waits = edges.filter(
    (edge) =>
      edge.verb === 'waits on' &&
      edge.from !== edge.to &&
      index.has(edge.from) &&
      index.has(edge.to),
  );
  const before = new Map<RunningKey, RunningKey[]>();
  const near = new Map<RunningKey, RunningKey[]>();
  for (const edge of waits) {
    before.set(edge.from, [...(before.get(edge.from) ?? []), edge.to]);
    near.set(edge.from, [...(near.get(edge.from) ?? []), edge.to]);
    near.set(edge.to, [...(near.get(edge.to) ?? []), edge.from]);
  }
  // The longest way back to a root; a cycle stops where it closes, so it keeps visit order.
  const depth = new Map<RunningKey, number>();
  const visiting = new Set<RunningKey>();
  const depthOf = (key: RunningKey): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    const d = Math.max(-1, ...(before.get(key) ?? []).map(depthOf)) + 1;
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  const chains: RunningKey[][][] = [];
  const seen = new Set<RunningKey>();
  for (const node of nodes) {
    if (seen.has(node.key)) continue;
    const members: RunningKey[] = [];
    const queue = [node.key];
    seen.add(node.key);
    while (queue.length) {
      const key = queue.shift()!;
      members.push(key);
      for (const other of near.get(key) ?? [])
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
    }
    members.sort((a, b) => index.get(a)! - index.get(b)!);
    const depths = members.map(depthOf);
    const least = Math.min(...depths);
    const columns: RunningKey[][] = [];
    members.forEach((key, n) => (columns[depths[n]! - least] ??= []).push(key));
    chains.push(columns.filter(Boolean));
  }
  const at = new Map<RunningKey, { x: number; y: number }>();
  const block = new Map<RunningKey, number>();
  let x = INSET;
  let top = 0;
  let bottom = 0;
  const wrap = () => {
    x = INSET;
    top = bottom + GAP;
  };
  for (const columns of chains) {
    const span = columns.length * w + (columns.length - 1) * STEP;
    if (x > INSET && x + span > width - INSET) wrap();
    columns.forEach((column, n) => {
      if (n > 0) x += STEP - GAP;
      if (x > INSET && x + w > width - INSET) wrap();
      let y = top;
      for (const key of column) {
        at.set(key, { x, y });
        block.set(key, top);
        y += h + GAP;
      }
      bottom = Math.max(bottom, y - GAP);
      x += w + GAP;
    });
  }
  return { at, block, height: nodes.length ? bottom : 0 };
}

/**
 * A band placed under what its cards relate to: each card as near the centre of its anchor
 * as the row allows, in the order of those anchors, and a card with none after all of them.
 * A row that is full carries on in the next.
 */
function anchoredBand(
  nodes: RunningNode[],
  anchorOf: (node: RunningNode) => number | undefined,
  width: number,
  w: number,
  h: number,
): Placed {
  const items = nodes.map((node, index) => ({ node, index, anchor: anchorOf(node) }));
  const sorted = [
    ...items
      .filter((item) => item.anchor !== undefined)
      .sort((a, b) => a.anchor! - b.anchor! || a.index - b.index),
    ...items.filter((item) => item.anchor === undefined),
  ];
  const at = new Map<RunningKey, { x: number; y: number }>();
  const block = new Map<RunningKey, number>();
  const right = width - INSET - w;
  let row = 0;
  let cursor = INSET;
  for (const { node, anchor } of sorted) {
    const wanted = anchor === undefined ? cursor : Math.round(anchor - w / 2);
    let x = Math.max(wanted, cursor);
    if (x > right) {
      if (cursor > INSET) {
        row++;
        cursor = INSET;
        // A card with no anchor starts the new row; one with an anchor stands under it.
        x = anchor === undefined ? INSET : Math.min(Math.max(wanted, INSET), right);
      } else x = right;
    }
    const y = row * (h + GAP);
    at.set(node.key, { x, y });
    block.set(node.key, y);
    cursor = x + w + GAP;
  }
  return { at, block, height: nodes.length ? (row + 1) * h + row * GAP : 0 };
}

/** A line of right angles, each corner turned on a small radius. */
function elbow(points: [number, number][], radius = 6): string {
  const kept = points.filter(
    ([x, y], at) => at === 0 || x !== points[at - 1]![0] || y !== points[at - 1]![1],
  );
  let d = `M ${kept[0]![0]} ${kept[0]![1]}`;
  for (let at = 1; at < kept.length - 1; at++) {
    const [px, py] = kept[at - 1]!;
    const [cx, cy] = kept[at]!;
    const [nx, ny] = kept[at + 1]!;
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    d +=
      ` L ${cx - Math.sign(cx - px) * r} ${cy - Math.sign(cy - py) * r}` +
      ` Q ${cx} ${cy} ${cx + Math.sign(nx - cx) * r} ${cy + Math.sign(ny - cy) * r}`;
  }
  const [lx, ly] = kept[kept.length - 1]!;
  return `${d} L ${lx} ${ly}`;
}
/** The head of an arrow arriving level at a card's left side. */
const arrow = (x: number, y: number) => `M ${x - 5} ${y - 3.5} L ${x} ${y} L ${x - 5} ${y + 3.5}`;

/**
 * Null where there is no room to draw: the page then lists each band and says every
 * relation in words. `heads` are the heights the page measured for each band's heading
 * and the lines under it; left out, a heading is one line.
 */
export function runningLayout(
  board: RunningBoard,
  width: number,
  options: { heads?: Partial<Record<RunningLaneName, number>> } = {},
): RunningLayout | null {
  if (!(width >= MIN_WIDTH)) return null;
  const kinds = kindsMix(board);
  const units = board.lanes.hardware.nodes.some((node) => node.units);
  const lane = new Map<RunningKey, RunningLaneName>();
  for (const name of LANES) for (const node of board.lanes[name].nodes) lane.set(node.key, name);
  const at = new Map<RunningKey, RunningBox>();
  const blocks = new Map<RunningKey, number>();
  const bands: RunningLayout['bands'] = [];
  const ghosts: RunningLayout['ghosts'] = [];
  const centre = (key: RunningKey) => {
    const box = at.get(key);
    return box && box.x + box.w / 2;
  };
  /** The first on-board card of this lane that `key` is related to, by any of these verbs. */
  const firstOf = (key: RunningKey, to: RunningLaneName, verbs?: ReadonlySet<string>) => {
    for (const edge of board.edges) {
      if (verbs && !verbs.has(edge.verb)) continue;
      const other = edge.from === key ? edge.to : edge.to === key ? edge.from : undefined;
      if (other && lane.get(other) === to) return centre(other);
    }
    return undefined;
  };
  // A session stands under the work it is on. A rented machine is not placed by what it was
  // rented for: that is why it was rented, not what it runs, and position would say otherwise.
  const working = new Set(['works on', 'reviews', 'reads']);
  let top = 0;
  for (const name of LANES) {
    const { nodes, pending } = board.lanes[name];
    const h = cardHeight(name, { kinds, units });
    const w = CARD_W[name];
    const placed =
      name === 'work'
        ? workBand(nodes, board.edges, width, h)
        : anchoredBand(
            nodes,
            name === 'sessions'
              ? (node) => firstOf(node.key, 'work', working)
              : (node) => firstOf(node.key, 'sessions') ?? firstOf(node.key, 'work'),
            width,
            w,
            h,
          );
    const head = Math.max(HEAD, Math.round(options.heads?.[name] ?? 0));
    const content = top + head;
    for (const [key, point] of placed.at) {
      at.set(key, { x: point.x, y: content + point.y, w, h });
      blocks.set(key, content + placed.block.get(key)!);
    }
    let height = placed.height;
    if (pending && !nodes.length) {
      const room = Math.max(1, Math.min(3, Math.floor((width - 2 * INSET + GAP) / (w + GAP))));
      for (let index = 0; index < room; index++)
        ghosts.push({ lane: name, x: INSET + index * (w + GAP), y: content, w, h });
      height = h;
    }
    const total = head + (height ? height + FOOT : 0);
    bands.push({ lane: name, top, height: total, head });
    top += total;
  }

  const paths: RunningPath[] = [];
  const ports = new Map<string, { key: RunningKey; x: number; y: number }>();
  const rank = (key: RunningKey) => LANES.indexOf(lane.get(key)!);
  const work = [...at].filter(([key]) => lane.get(key) === 'work');
  /** Whether a level run at `y` from `x1` to `x2` would pass through a card other than its ends. */
  const blocked = (y: number, x1: number, x2: number, ends: RunningKey[]) =>
    work.some(
      ([key, box]) =>
        !ends.includes(key) &&
        box.x < Math.max(x1, x2) &&
        box.x + box.w > Math.min(x1, x2) &&
        box.y <= y &&
        box.y + box.h >= y,
    );
  for (const edge of board.edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to || edge.from === edge.to) continue;
    if (edge.verb === 'waits on') {
      if (lane.get(edge.from) !== 'work' || lane.get(edge.to) !== 'work') continue;
      // The prerequisite points into the work that waits on it.
      const [a, b] = [to, from];
      const [sx, sy] = [a.x + a.w, a.y + a.h / 2];
      const [ex, ey] = [b.x, b.y + b.h / 2];
      const same = blocks.get(edge.to) === blocks.get(edge.from);
      let points: [number, number][];
      if (same && ex > sx) {
        const gx = ex - Math.min(STEP, ex - sx) / 2;
        const ends = [edge.from, edge.to];
        if (!blocked(sy, sx, gx, ends) && !blocked(ey, gx, ex, ends))
          points = [
            [sx, sy],
            [gx, sy],
            [gx, ey],
            [ex, ey],
          ];
        else {
          // Past a column in between: over the top of the block, in the gap above its rows.
          const over = blocks.get(edge.to)! - GAP / 2;
          const out = sx + Math.min(STEP, ex - sx) / 2;
          points = [
            [sx, sy],
            [out, sy],
            [out, over],
            [gx, over],
            [gx, ey],
            [ex, ey],
          ];
        }
      } else {
        // Carried on into a later block: down the gap beside the prerequisite, along the gap
        // above the dependent's block, and in from its left.
        const out = Math.min(sx + GAP / 2, width - 2);
        const over = blocks.get(edge.from)! - GAP / 2;
        const gx = Math.max(2, ex - GAP / 2);
        points = [
          [sx, sy],
          [out, sy],
          [out, over],
          [gx, over],
          [gx, ey],
          [ex, ey],
        ];
      }
      paths.push({ edge, d: elbow(points), head: arrow(ex, ey), cross: false });
      continue;
    }
    if (lane.get(edge.from) === lane.get(edge.to)) continue;
    const [lower, upper, low, up] =
      rank(edge.from) > rank(edge.to)
        ? [from, to, edge.from, edge.to]
        : [to, from, edge.to, edge.from];
    const [lx, ly] = [lower.x + lower.w / 2, lower.y];
    const [ux, uy] = [upper.x + upper.w / 2, upper.y + upper.h];
    const my = (ly + uy) / 2;
    paths.push({ edge, d: `M ${lx} ${ly} C ${lx} ${my} ${ux} ${my} ${ux} ${uy}`, cross: true });
    ports.set(`${low}|${lx}|${ly}`, { key: low, x: lx, y: ly });
    ports.set(`${up}|${ux}|${uy}`, { key: up, x: ux, y: uy });
  }
  const order = LANES.flatMap((name) =>
    board.lanes[name].nodes
      .map((node) => node.key)
      .filter((key) => at.has(key))
      .sort((a, b) => at.get(a)!.y - at.get(b)!.y || at.get(a)!.x - at.get(b)!.x),
  );
  return { width, height: top, bands, at, order, paths, ports: [...ports.values()], ghosts };
}
