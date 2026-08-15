/**
 * Layered left-to-right layout for the experiment figure graph.
 *
 * Two modes, picked from the data:
 *
 * TIMELINE — the derived experiment figure. One uniform row grid, read left
 * to right in time:
 *
 *   marker columns   an attempt / submission (or the conclusion) is always the
 *                    ONLY card in its column and always sits on the middle row,
 *                    so the markers form one straight backbone;
 *   regular columns  everything else — the verdict on the round before, the
 *                    files prepared for the round after, sandbox, claims —
 *                    pooled into the single column between two markers and
 *                    stacked on the same row pitch, centered on the backbone
 *                    row (straddling it, never on it, so the backbone stays a
 *                    clear channel). No lanes: a file and a review are laid
 *                    out the same way, in type order, top to bottom.
 *
 * Spine nodes (markers, reviews, gates, claims) are ranked by longest path over
 * spine-only edges, which orders the columns. Satellites never take part in
 * ranking: evidence joins the regular column just before the marker it fed,
 * execution output joins the column just after the beat it trails.
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
// Nominal node heights. A plain figure card measures 76px; a card may pass its
// own estimate as `h` (bounds honor it). Legacy layouts keep the older 66px
// pitch so their spacing is unchanged.
const FIG_NODE_H = 66;
export const FIG_CARD_H = 76;
const heightOf = (n) => (Number.isFinite(n.h) ? n.h : FIG_CARD_H);
const GAP_X = 72;
// Generous vertical separation between stacked/branching nodes: tight rows
// make the diagonal edges hard to follow, so give them room.
const GAP_Y = 80;
// The timeline shares the legacy grid: same column pitch, same row pitch, so
// the figure keeps the spacing it always had.
const ROW_PITCH = FIG_NODE_H + GAP_Y;

// Vertical order within a column: inputs above, verdicts/outputs below.
const TYPE_ORDER = { artifact: 0, artifact_group: 1, attempt: 2, submission: 3, sandbox: 4, review: 5, conclusion: 6, claim: 7 };
// Backbone markers: the beats that own a column and sit on the middle row.
const MARKER_TYPES = new Set(['attempt', 'submission', 'conclusion']);

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
  const isMarker = (n) => MARKER_TYPES.has(n.type);

  // Column keys: a marker owns its rank outright; other spine nodes at that
  // rank share one regular column, placed just after the marker if they
  // (unusually) tie with one. Keys only need to sort, so halves are fine.
  const keyOf = new Map();
  const markerRanks = new Set(spineNodes.filter(isMarker).map(n => rank.get(n.id)));
  const regularKeys = new Set();
  for (const n of spineNodes) {
    const r = rank.get(n.id);
    if (isMarker(n)) {
      keyOf.set(n.id, r);
    } else {
      const k = markerRanks.has(r) ? r + 0.5 : r;
      keyOf.set(n.id, k);
      regularKeys.add(k);
    }
  }
  const sortedMarkers = [...markerRanks].sort((a, b) => a - b);
  const prevMarker = (k) => { let p = -Infinity; for (const m of sortedMarkers) { if (m < k) p = m; else break; } return p; };
  const nextMarker = (k) => { for (const m of sortedMarkers) if (m > k) return m; return Infinity; };
  const mid = (a, b) => {
    if (a === -Infinity && b === Infinity) return 0;
    if (a === -Infinity) return b - 1;
    if (b === Infinity) return a + 1;
    return (a + b) / 2;
  };

  // Satellites join the regular column in the gap next to their anchor:
  // evidence goes just BEFORE the marker it fed (prepared, then submitted),
  // execution output just AFTER the beat it trails. Anchored on a non-marker
  // (a verdict), it simply shares that column. Tolerate a satellite anchored
  // on another satellite by walking up (bounded) to the spine.
  const byId = new Map(rawNodes.map(n => [n.id, n]));
  const spineAnchor = (n) => {
    let cur = n;
    for (let hops = 0; hops < 4 && cur && satIds.has(cur.id); hops += 1) cur = byId.get(cur.anchor);
    return cur && keyOf.has(cur.id) ? cur : null;
  };
  const gapColumn = (lo, hi, pick) => {
    const inGap = [...regularKeys].filter(k => k > lo && k < hi).sort((a, b) => a - b);
    if (inGap.length) return pick === 'last' ? inGap[inGap.length - 1] : inGap[0];
    const k = mid(lo, hi);
    regularKeys.add(k);
    return k;
  };
  for (const n of satellites) {
    const anchor = spineAnchor(n);
    if (!anchor) { keyOf.set(n.id, gapColumn(-Infinity, sortedMarkers[0] ?? Infinity, 'last')); continue; }
    const ka = keyOf.get(anchor.id);
    if (!isMarker(anchor)) { keyOf.set(n.id, ka); continue; }
    keyOf.set(n.id, n.lane === 'execution'
      ? gapColumn(ka, nextMarker(ka), 'first')
      : gapColumn(prevMarker(ka), ka, 'last'));
  }

  const columns = new Map();
  for (const n of rawNodes) {
    const k = keyOf.get(n.id);
    if (!columns.has(k)) columns.set(k, []);
    columns.get(k).push(n);
  }

  // Every regular column straddles the backbone row: its cards take an even
  // number of half-row slots (odd counts leave the top slot empty), so the
  // nearest cards sit half a pitch above and below the row and the row itself
  // stays a clear channel for the marker → marker line. Cards keep input
  // order within a type (the server puts load-bearing files first).
  const slotsOf = (col) => (col.length % 2 ? col.length + 1 : col.length);
  let backboneY = 0;
  for (const [k, col] of columns) {
    if (sortedMarkers.includes(k)) continue;
    backboneY = Math.max(backboneY, ((slotsOf(col) - 1) / 2) * ROW_PITCH);
  }

  const nodes = [];
  let x = 0;
  for (const [k, col] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    if (sortedMarkers.includes(k)) {
      // Markers: exactly one per column, on the row. (Two markers can only
      // tie on rank in malformed data; stack them rather than lose one.)
      let y = backboneY;
      for (const n of col) { nodes.push({ ...n, x, y }); y += ROW_PITCH; }
    } else {
      col.sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
      const slots = slotsOf(col);
      let slot = slots - col.length; // odd count → leave the top slot empty
      for (const n of col) {
        nodes.push({ ...n, x, y: backboneY + (slot - (slots - 1) / 2) * ROW_PITCH });
        slot += 1;
      }
    }
    x += FIG_NODE_W + GAP_X;
  }
  // `backboneY` lets the viewport center on the marker row rather than on
  // whichever card happens to be current (often a verdict off the row).
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
