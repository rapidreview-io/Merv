/**
 * Layered left-to-right layout for the experiment figure graph.
 *
 * Two modes, picked from the data:
 *
 * TIMELINE — when nodes carry `anchor` (the derived experiment figure). Three
 * bands around one straight backbone:
 *
 *   evidence   files (spread out) in a sub-column just BEFORE the marker they
 *              were submitted with, stacked above the backbone, `feeds`
 *              arrows converging on the marker — prepared, then submitted;
 *   backbone   attempt / submission markers (and conclusion, claims) on ONE
 *              middle row, linked marker → marker: the line the reader follows;
 *   verdicts   reviews on the row below, each in its own temporal column
 *              between the round it graded and the round it led to — the
 *              loop that explains each backbone step (dashed amber = sent back);
 *   execution  sandbox and unsealed files hang below the beat they trail.
 *
 * Spine nodes (backbone + verdicts) are ranked by longest path over spine-only
 * edges, so a verdict still takes its own column between two markers.
 * Satellites never take part in ranking; each sits by its anchor.
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
// Timeline bands. ROW_GAP separates the backbone from the verdict row (and any
// stacked backbone nodes); satellites are spread with SAT_GAP and start
// LANE_GAP off the card they hang from, so a stack reads as distinct cards
// rather than a slab.
const ROW_GAP = 80;
const SAT_GAP = 36;
const LANE_GAP = 44;
// Evidence sits closer to its marker than beats sit to each other, so the
// pair (files ↘ marker) reads as one unit.
const EVIDENCE_GAP_X = 40;

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
    if (!columns.has(r)) columns.set(r, { backbone: [], verdicts: [], evidence: [], below: [] });
    return columns.get(r);
  };
  for (const n of spineNodes) {
    (n.type === 'review' ? col(rank.get(n.id)).verdicts : col(rank.get(n.id)).backbone).push(n);
  }
  for (const n of satellites) {
    (n.lane === 'execution' ? col(rankOf(n)).below : col(rankOf(n)).evidence).push(n);
  }

  // Cards are top-aligned on their row (edge handles sit at a fixed offset
  // from the top). The backbone row must clear the tallest evidence stack.
  const sum = (arr, f) => arr.reduce((acc, n) => acc + f(n), 0);
  const stackH = (arr) => (arr.length ? sum(arr, heightOf) + (arr.length - 1) * SAT_GAP + LANE_GAP : 0);
  let backboneY = 0;
  for (const c of columns.values()) backboneY = Math.max(backboneY, stackH(c.evidence));
  const verdictY = backboneY + FIG_CARD_H + ROW_GAP;

  // Columns are laid out left to right; a beat with evidence reserves a
  // sub-column just before it for the files that led into it.
  const nodes = [];
  const placed = new Map(); // id → { x, y, h } for anchoring the execution lane
  let x = 0;
  for (const [, c] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    if (c.evidence.length) {
      // Evidence stacks upward, most load-bearing file nearest the backbone.
      let y = backboneY - LANE_GAP;
      for (const n of c.evidence) {
        y -= heightOf(n);
        nodes.push({ ...n, x, y });
        y -= SAT_GAP;
      }
      x += FIG_NODE_W + EVIDENCE_GAP_X;
    }
    // Backbone: one card on the row; several (claims) stack down from it.
    let y = backboneY;
    for (const n of c.backbone) {
      nodes.push({ ...n, x, y });
      placed.set(n.id, { x, y, h: heightOf(n) });
      y += heightOf(n) + ROW_GAP;
    }
    // Verdicts: the row below the backbone (a re-review stacks further down).
    y = verdictY;
    for (const n of c.verdicts) {
      nodes.push({ ...n, x, y });
      placed.set(n.id, { x, y, h: heightOf(n) });
      y += heightOf(n) + ROW_GAP;
    }
    // Execution hangs below whichever card it trails: a marker (so it lands on
    // the verdict row of the marker's own column, which is otherwise empty) or
    // a verdict (so it lands one row further down).
    for (const n of c.below) {
      let cur = n;
      for (let hops = 0; hops < 4 && cur && satIds.has(cur.id); hops += 1) cur = byId.get(cur.anchor);
      const at = (cur && placed.get(cur.id)) || { x, y: backboneY, h: FIG_CARD_H };
      const start = at.y + at.h + ROW_GAP;
      const key = `${at.x}:${start}`;
      const stackY = placed.get(key)?.y ?? start;
      nodes.push({ ...n, x: at.x, y: stackY });
      placed.set(key, { x: at.x, y: stackY + heightOf(n) + SAT_GAP, h: 0 });
    }
    x += FIG_NODE_W + BEAT_GAP_X;
  }
  // `backboneY` lets the viewport center on the middle band rather than on
  // whichever card happens to be current (often a verdict on the row below).
  return { nodes, edges, backboneY };
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
