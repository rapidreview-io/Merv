/**
 * Layered left-to-right layout for the experiment figure graph.
 *
 * Two modes, picked from the data:
 *
 * TIMELINE — when nodes carry `anchor` (the derived experiment figure). The
 * spine (attempt markers, submission markers, reviews, conclusion, claims) is
 * ranked by longest path over spine-only edges and pinned to ONE horizontal
 * row, so the reader follows a single line: marker → verdict → next round →
 * verdict → … Satellites (artifacts, artifact groups, sandbox) never take part
 * in ranking; each sits in its anchor's column, stacked tightly above the
 * spine (`lane: 'evidence'`) or below it (`lane: 'execution'`). Column = beat,
 * and a beat's evidence is directly above it — association by adjacency, with
 * no diagonal edges to trace.
 *
 * LEGACY — every other small DAG (agent-authored logic graphs, reflection
 * waves, mobile outlines): longest-path layering gives the reading order and a
 * right-pack pass pulls pure sources next to their consumer; each column is
 * centered independently.
 *
 * Deterministic by construction: same figure JSON → same positions, so
 * polling never reshuffles the canvas.
 */

export const FIG_NODE_W = 196;
// Nominal node heights. A plain figure card measures 76px; cards that
// accumulate items (a submission listing its files) pass their own estimate as
// `h`, and the timeline layout honors it. Legacy layouts keep the older 66px
// pitch so their spacing is unchanged.
const FIG_NODE_H = 66;
export const FIG_CARD_H = 76;
const heightOf = (n) => (Number.isFinite(n.h) ? n.h : FIG_CARD_H);
const GAP_X = 72;
// Timeline beats can sit closer: no diagonal edges cross the gap.
const BEAT_GAP_X = 56;
// Generous vertical separation between stacked/branching spine nodes: tight
// rows make the diagonal edges hard to follow, so give them room.
const GAP_Y = 80;
// Satellites hug their beat: a small gap between them, a slightly larger one
// off the spine so the spine row still reads as a line.
const SAT_GAP = 10;
const LANE_GAP = 26;

// Vertical order within a legacy column: inputs above the spine, verdicts/outputs below.
const TYPE_ORDER = { artifact: 0, artifact_group: 1, attempt: 2, submission: 3, sandbox: 4, review: 5, conclusion: 6, claim: 7 };

/** Longest-path ranks (Kahn's order; cycle-safe: leftovers keep rank 0),
 * followed by a right-pack of pure sources next to their earliest consumer. */
function rankNodes(nodes, edges) {
  const out = new Map(nodes.map(n => [n.id, []]));
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) {
    out.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const rank = new Map(nodes.map(n => [n.id, 0]));
  const remaining = new Map(indeg);
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  while (queue.length) {
    const id = queue.shift();
    for (const next of out.get(id)) {
      rank.set(next, Math.max(rank.get(next), rank.get(id) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  for (const n of nodes) {
    const targets = out.get(n.id);
    if (indeg.get(n.id) === 0 && targets.length) {
      const minSucc = Math.min(...targets.map(t => rank.get(t)));
      if (Number.isFinite(minSucc)) rank.set(n.id, Math.max(rank.get(n.id), minSucc - 1));
    }
  }
  return rank;
}

function layoutTimeline(rawNodes, edges, ids) {
  const satellites = rawNodes.filter(n => n.anchor && ids.has(n.anchor));
  const satIds = new Set(satellites.map(n => n.id));
  const spineNodes = rawNodes.filter(n => !satIds.has(n.id));
  const spineEdges = edges.filter(e => !satIds.has(e.from) && !satIds.has(e.to));
  const rank = rankNodes(spineNodes, spineEdges);

  // A satellite's anchor should be a spine node; tolerate a satellite anchored
  // on another satellite by walking up (bounded) to the spine.
  const byId = new Map(rawNodes.map(n => [n.id, n]));
  const rankOf = (n) => {
    let cur = n;
    for (let hops = 0; hops < 4 && cur && satIds.has(cur.id); hops += 1) cur = byId.get(cur.anchor);
    return cur && rank.has(cur.id) ? rank.get(cur.id) : 0;
  };

  const columns = new Map();
  const col = (r) => {
    if (!columns.has(r)) columns.set(r, { spine: [], above: [], below: [] });
    return columns.get(r);
  };
  for (const n of spineNodes) col(rank.get(n.id)).spine.push(n);
  for (const n of satellites) {
    (n.lane === 'execution' ? col(rankOf(n)).below : col(rankOf(n)).above).push(n);
  }

  // Cards are top-aligned on the spine row (their edge handles sit at a fixed
  // offset from the top, so a tall accumulating card still reads as one
  // straight line). The row must clear the tallest evidence stack.
  const sum = (arr, f) => arr.reduce((acc, n) => acc + f(n), 0);
  const stackH = (arr) => (arr.length ? sum(arr, heightOf) + (arr.length - 1) * SAT_GAP + LANE_GAP : 0);
  let spineY = 0;
  for (const c of columns.values()) spineY = Math.max(spineY, stackH(c.above));

  const nodes = [];
  for (const [r, c] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const x = r * (FIG_NODE_W + BEAT_GAP_X);
    // Spine nodes: one sits on the row; several stack down from it (in input order).
    let y = spineY;
    for (const n of c.spine) {
      nodes.push({ ...n, x, y });
      y += heightOf(n) + GAP_Y;
    }
    const blockBottom = c.spine.length ? y - GAP_Y : spineY;
    // Evidence stacks upward from the spine, first item nearest the row.
    y = spineY - LANE_GAP;
    for (const n of c.above) {
      y -= heightOf(n);
      nodes.push({ ...n, x, y });
      y -= SAT_GAP;
    }
    // Execution stacks downward from the spine block.
    y = blockBottom + LANE_GAP;
    for (const n of c.below) {
      nodes.push({ ...n, x, y });
      y += heightOf(n) + SAT_GAP;
    }
  }
  return { nodes, edges };
}

function layoutLegacy(rawNodes, edges) {
  const rank = rankNodes(rawNodes, edges);
  const columns = new Map();
  for (const n of rawNodes) {
    const r = rank.get(n.id) || 0;
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(n);
  }

  const tallest = Math.max(...[...columns.values()].map(col => col.length));
  const totalH = tallest * FIG_NODE_H + (tallest - 1) * GAP_Y;

  const nodes = [];
  for (const [r, col] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    col.sort((a, b) => {
      const ka = `${a.group || ''}~${TYPE_ORDER[a.type] ?? 9}~${a.id}`;
      const kb = `${b.group || ''}~${TYPE_ORDER[b.type] ?? 9}~${b.id}`;
      return ka.localeCompare(kb);
    });
    const colH = col.length * FIG_NODE_H + (col.length - 1) * GAP_Y;
    let y = (totalH - colH) / 2;
    for (const n of col) {
      nodes.push({ ...n, x: r * (FIG_NODE_W + GAP_X), y });
      y += FIG_NODE_H + GAP_Y;
    }
  }
  return { nodes, edges };
}

/** Bounding box of laid-out nodes in flow coordinates (uses per-node `h`). */
export function figureBounds(nodes) {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + FIG_NODE_W); maxY = Math.max(maxY, n.y + heightOf(n));
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * `opts.timeline` forces the timeline mode (the experiment figure asks for it
 * explicitly, since after folding evidence into cards a figure may carry no
 * anchored node at all); by default the mode is inferred from the data.
 */
export function layoutFigure(figure, opts = {}) {
  const rawNodes = figure?.nodes || [];
  const rawEdges = figure?.edges || [];
  if (!rawNodes.length) return { nodes: [], edges: [] };

  const ids = new Set(rawNodes.map(n => n.id));
  const edges = rawEdges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  const timeline = opts.timeline ?? rawNodes.some(n => n.anchor && ids.has(n.anchor));
  if (timeline) {
    return layoutTimeline(rawNodes, edges, ids);
  }
  return layoutLegacy(rawNodes, edges);
}
