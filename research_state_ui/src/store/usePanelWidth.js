import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Shared, draggable width for EVERY graph detail sidebar — the experiment
 * figure, the logic graph, the wave process figure, the project braid, and the
 * experiment map. One module-level store (same pattern as useTheme) rather than
 * per-component state, so dragging one panel moves all of them and the choice
 * survives a reload.
 *
 * The width drives a CSS custom property (--fig-panel-w) that the panel, the
 * resize handle, and the map's canvas-inset math all read, so a media query can
 * still override the layout wholesale on small screens.
 */
const KEY = 'rsui:figPanelW';
const MIN = 300;
const DEFAULT = 380;

// Exported so camera math can reserve the same gutter the CSS paints, and so a
// canvas can never be squeezed below a usable width by the drag.
export const PANEL_MIN = MIN;
export const PANEL_DEFAULT = DEFAULT;
export const CANVAS_MIN = 300;
// The panel never takes more than this share of the graph that hosts it. The
// width is ONE persisted number shared by every graph: dragged wide on an
// expanded, viewport-sized graph, it would otherwise come back on an inline
// graph wider than the graph itself. The CSS caps the drawer with the same
// fraction (min(--fig-panel-w, 75%)); this is the JS side of that contract,
// for the drag clamp and for camera math that reserves the panel's gutter.
export const PANEL_MAX_FRACTION = 0.75;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** The width the drawer actually renders at inside a host of `hostWidth`. */
export function effectivePanelWidth(stored, hostWidth) {
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return stored;
  return Math.min(stored, hostWidth * PANEL_MAX_FRACTION);
}

function load() {
  try {
    const v = parseInt(localStorage.getItem(KEY), 10);
    return Number.isFinite(v) ? Math.max(MIN, v) : DEFAULT;
  } catch { return DEFAULT; }
}

let width = load();
const listeners = new Set();

function setWidth(w) {
  width = w;
  for (const fn of listeners) fn();
}

export function usePanelWidth() {
  const value = useSyncExternalStore(
    useCallback((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, []),
    () => width,
  );
  const drag = useRef(null);

  const onMove = useCallback((e) => {
    const s = drag.current;
    if (!s) return;
    // The panel is the RIGHT column, so it widens as the pointer moves left.
    setWidth(clamp(s.startW + (s.startX - e.clientX), MIN, s.maxW));
  }, []);

  const onUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem(KEY, String(Math.round(width))); } catch { /* best-effort */ }
  }, [onMove]);

  const startResize = useCallback((e) => {
    e.preventDefault();
    // Every graph shell that hosts a sidebar, in one selector — the section
    // graphs, the project braid, and the experiment map.
    const body = e.currentTarget.closest('.fig-body, .wflow, .xmap');
    const bodyW = body ? body.clientWidth : 960;
    // Never let the panel eat the whole canvas: leave the graph ~300px, and
    // never more than the fraction the CSS caps the drawer at.
    const maxW = Math.max(MIN, Math.min(bodyW - CANVAS_MIN, bodyW * PANEL_MAX_FRACTION));
    // A stored width past the cap renders capped; start the drag from what
    // is on screen, not from the number, so the handle doesn't jump.
    drag.current = { startX: e.clientX, startW: Math.min(width, maxW), maxW };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onMove, onUp]);

  // Keyboard path for the resize handle. The handle announces itself as an
  // adjustable separator, so arrow keys have to actually move it — it used to
  // carry the role with pointer events as the only way to operate it.
  const nudge = useCallback((delta) => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const next = clamp(width + delta, MIN, Math.max(MIN, vw - CANVAS_MIN));
    setWidth(next);
    try { localStorage.setItem(KEY, String(Math.round(next))); } catch { /* best-effort */ }
  }, [width]);

  return { width: value, startResize, nudge };
}
