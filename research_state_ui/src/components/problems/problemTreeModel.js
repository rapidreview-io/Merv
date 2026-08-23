/**
 * problemTreeModel — pure layout for the living problem tree: flattens the
 * nested /problem-tree payload into positioned nodes and edges. Tidy vertical
 * tree — root at top, each subtree gets its natural width, parents centered
 * over the span of their children. No JSX here — same discipline as
 * braidModel.js so a mobile surface can reuse it later.
 *
 * Coordinates: node {x, y} is the card's top-left in SVG space; attempt marks
 * carry x/y RELATIVE to their node's top-left (the renderer draws them inside
 * the node's translated <g>). Edges run from the parent's unit bottom (below
 * its attempt tray, when it has one) to the child's top center.
 */

import { strandTone } from '../reflection/braidModel.js';

// Node card: same width as the project graph's experiment cards (EXP_W), a
// hair taller so a two-line statement breathes.
export const NODE_W = 190;
export const NODE_H = 64;
// Attempt marks: small — the same silhouette vocabulary as the project graph
// (rect = experiment, flowchart-hexagon = task), shrunk to a badge.
export const ATT_W = 22;
export const ATT_H = 12;
const ATT_GAP = 6;
const TRAY_GAP = 7; // node bottom → marks
export const TRAY_H = TRAY_GAP + ATT_H + 3;
const H_GAP = 26; // between sibling subtrees
const V_GAP = 46; // tray bottom → next row's card top
const PAD = 18; // canvas padding (also room for the frontier pulse ring)
export const LEVEL_H = NODE_H + TRAY_H + V_GAP;

// Attempt tone rides the braid's lifecycle vocabulary so an attempt is
// colored identically here and on the project graph.
export const attemptTone = strandTone;

const PROBLEM_STATUSES = new Set([
  'open', 'attempting', 'decomposed', 'solved', 'failed', 'stuck', 'moot',
]);

// Unknown statuses render as the neutral card; keep the class vocabulary
// closed so a surprise status never invents a CSS hook.
export function problemStatus(status) {
  const s = String(status || '');
  return PROBLEM_STATUSES.has(s) ? s : 'decomposed';
}

/**
 * Nested problem node → { nodes, edges, width, height }.
 *   nodes[i] = { id, statement, status, depth, summary, revisitCount,
 *                detailsVersion, isRoot, x, y, cx, hasTray,
 *                attempts: [{ id, kind, name, status, verdict, tone, x, y }] }
 *   edges[j] = { id, x1, y1, x2, y2, live }   (live = child is attempting)
 */
export function buildProblemTree(root) {
  if (!root || typeof root !== 'object') {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // Measure pass: a subtree is as wide as its own card (or attempt tray)
  // or the sum of its children's subtrees, whichever is larger.
  const widths = new Map();
  const measure = (n) => {
    const attempts = Array.isArray(n.attempts) ? n.attempts : [];
    const trayW = attempts.length
      ? attempts.length * ATT_W + (attempts.length - 1) * ATT_GAP
      : 0;
    const own = Math.max(NODE_W, trayW);
    const kids = Array.isArray(n.children) ? n.children : [];
    const sum = kids.reduce((acc, k) => acc + measure(k), 0)
      + H_GAP * Math.max(0, kids.length - 1);
    const w = Math.max(own, sum);
    widths.set(n, w);
    return w;
  };
  measure(root);

  const nodes = [];
  const edges = [];
  let maxBottom = 0;

  // Place pass: children left-to-right inside the subtree span (centered when
  // the parent's own card is the wider thing), parent centered over the
  // midpoint of its first and last child's centers.
  const place = (n, x0, depth) => {
    const w = widths.get(n);
    const kids = Array.isArray(n.children) ? n.children : [];
    const placedKids = [];
    if (kids.length) {
      const kidsW = kids.reduce((acc, k) => acc + widths.get(k), 0)
        + H_GAP * Math.max(0, kids.length - 1);
      let cursor = x0 + (w - kidsW) / 2;
      for (const k of kids) {
        placedKids.push(place(k, cursor, depth + 1));
        cursor += widths.get(k) + H_GAP;
      }
    }
    const cx = placedKids.length
      ? (placedKids[0].cx + placedKids[placedKids.length - 1].cx) / 2
      : x0 + w / 2;
    const y = PAD + depth * LEVEL_H;

    const rawAttempts = Array.isArray(n.attempts) ? n.attempts : [];
    const trayW = rawAttempts.length
      ? rawAttempts.length * ATT_W + (rawAttempts.length - 1) * ATT_GAP
      : 0;
    const attempts = rawAttempts.map((a, i) => ({
      id: a.id,
      kind: a.kind === 'task' ? 'task' : 'experiment',
      name: a.name || a.id,
      status: String(a.status || ''),
      verdict: String(a.verdict || ''),
      tone: attemptTone(a.status),
      // Relative to the node's top-left; centered under the card.
      x: NODE_W / 2 - trayW / 2 + i * (ATT_W + ATT_GAP),
      y: NODE_H + TRAY_GAP,
    }));

    const node = {
      id: n.id,
      statement: String(n.statement || ''),
      status: problemStatus(n.status),
      depth,
      summary: String(n.summary || ''),
      revisitCount: n.revisit_count || 0,
      detailsVersion: n.details_version || 1,
      isRoot: depth === 0,
      x: cx - NODE_W / 2,
      y,
      cx,
      hasTray: attempts.length > 0,
      attempts,
    };
    nodes.push(node);
    maxBottom = Math.max(maxBottom, y + NODE_H + (node.hasTray ? TRAY_H : 0));

    // Edges: parent unit bottom (below its tray) → child top center.
    const unitBottom = y + NODE_H + (node.hasTray ? TRAY_H : 0);
    for (const k of placedKids) {
      edges.push({
        id: `${node.id}->${k.id}`,
        x1: cx,
        y1: unitBottom,
        x2: k.cx,
        y2: k.y,
        live: k.status === 'attempting',
      });
    }
    return node;
  };
  place(root, PAD, 0);

  return {
    nodes,
    edges,
    width: widths.get(root) + PAD * 2,
    height: maxBottom + PAD,
  };
}
