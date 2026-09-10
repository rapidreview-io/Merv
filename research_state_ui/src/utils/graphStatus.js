/**
 * The node vocabulary every graph surface shares: the experiment figure and the
 * wave figure on desktop, the outline and canvas overlay on mobile, and the
 * logic graph's accent ramp. One table each, so a status that reads "returned"
 * on one surface can never read "done" on another.
 */

/**
 * Per-type status → the small set of visual families the CSS knows:
 * done | open | revise | failed | faded | neutral.
 * (`open` = blue/in-motion, `revise` = amber, `faded` = superseded history.)
 */
export function figureStatusClass(node) {
  const s = String(node.status || '');
  if (node.type === 'review') {
    return { pass: 'done', needs_changes: 'revise', fail: 'failed', open: 'open' }[s] || 'neutral';
  }
  if (node.type === 'claim') {
    return {
      supported: 'done', weakened: 'revise', contradicted: 'failed',
      active: 'open', draft: 'neutral', abandoned: 'faded',
    }[s] || 'open';
  }
  if (node.type === 'submission') {
    return { open: 'open', done: 'done', returned: 'revise', failed: 'failed' }[s] || 'done';
  }
  return {
    pending: 'neutral', active: 'open', done: 'done', failed: 'failed',
    superseded: 'faded', abandoned: 'faded', none: 'neutral',
  }[s] || 'neutral';
}

// The family as a colour, for surfaces that paint rather than class up.
export const FIGURE_STATUS_COLOR = {
  done: 'var(--supports)', open: 'var(--active)', revise: 'var(--qualifies)',
  failed: 'var(--refutes)', faded: 'var(--faint)', neutral: 'var(--line-strong)',
};

// One geometric glyph per figure node type (monochrome, no emoji).
export const FIGURE_GLYPH = {
  attempt: '◇',
  submission: '▣',
  artifact: '▤',
  artifact_group: '▣',
  review: '☑',
  sandbox: '▶',
  conclusion: '∴',
  claim: '◎',
  consolidation: '▦',
};

// Node `kind` in a logic graph is the agent's own vocabulary — there is no
// fixed taxonomy, so each kind gets an accent by order of first appearance.
const KIND_COLORS = [
  'var(--active)',
  'var(--supports)',
  'var(--qualifies)',
  'var(--refutes)',
  'var(--mcp)',
  'var(--ice)',
];
export const KIND_NEUTRAL = 'var(--line-strong)';

export function kindColorMap(graph) {
  const colors = new Map();
  for (const node of graph?.nodes || []) {
    const kind = String(node.kind || '').trim();
    if (kind && !colors.has(kind)) {
      colors.set(kind, KIND_COLORS[colors.size % KIND_COLORS.length]);
    }
  }
  return colors;
}
