/**
 * Shared camera math for every graph canvas.
 *
 * Three things every graph needs and each used to solve alone:
 *   - how wide the canvas actually is once the detail sidebar overlays it,
 *   - how far the reader may pan before the graph could leave the screen,
 *   - how to frame a wide flat ribbon so the node text stays legible.
 *
 * All pure data — no react-flow imports — so callers stay free to apply the
 * result as a `defaultViewport`, a `setViewport`, or nothing at all.
 */

/**
 * Canvas width for framing, with a sane fallback before the element measures.
 *
 * Deliberately ignores the detail sidebar. The sidebar docks as an overlay, so
 * the canvas keeps its full width and the sidebar simply covers part of it —
 * and framing must NOT compensate for that. Reserving the covered gutter would
 * re-frame the graph every time the sidebar opened or closed, moving the whole
 * canvas under the reader for no reason they asked for. Motion nobody
 * requested is a nausea risk; a graph partly behind a panel is not.
 */
export function visibleWidth(el) {
  return Math.max(280, el?.clientWidth || 1000);
}

/**
 * Pan/zoom clamp around an already-fitted frame: a quarter-viewport of play on
 * each side and no zooming out much past the fit, so the graph can never be
 * flung off screen with no way back. `fit` is any {x, y, zoom} viewport.
 */
export function panExtentFor(fit, vw, vh, { minZoomFactor = 0.8, play = 0.25 } = {}) {
  const w = vw / fit.zoom;
  const h = vh / fit.zoom;
  const x0 = -fit.x / fit.zoom;
  const y0 = -fit.y / fit.zoom;
  return {
    minZoom: Math.max(0.05, fit.zoom * minZoomFactor),
    extent: [
      [x0 - w * play, y0 - h * play],
      [x0 + w * (1 + play), y0 + h * (1 + play)],
    ],
  };
}

/**
 * Readable framing for a wide, flat ribbon of nodes (the agent-authored logic
 * graph, the wave process spine). Plain fitView fits such a graph to WIDTH,
 * crushing the zoom until the labels are unreadable while most of the canvas
 * height sits empty. Instead: fill the tighter dimension, never below a legible
 * floor or past 1x, anchor the story's start at the left, centre it vertically.
 *
 * Returns null when there is nothing to frame.
 */
export function readableViewport({
  xs, ys, nodeW, nodeH = 72, cw, ch,
  pad = 28, minZoom = 0.8, maxZoom = 1,
}) {
  if (!xs?.length || !ys?.length) return null;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const gW = Math.max(1, Math.max(...xs) + nodeW - minX);
  const gH = Math.max(1, Math.max(...ys) + nodeH - minY);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.max((cw - pad * 2) / gW, (ch - pad * 2) / gH)),
  );
  return {
    x: pad - minX * zoom,
    y: (ch - gH * zoom) / 2 - minY * zoom,
    zoom,
  };
}
