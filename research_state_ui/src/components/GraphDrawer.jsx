import { useEffect, useRef, useState } from 'react';
import { motionMs } from '../utils/motion';

// How long the drawer takes to slide. Matches --sidebar-out's register: fast
// enough to answer the click, long enough to read as a slide, not a pop.
export const DRAWER_MS = 200;

/**
 * Escape closes the sidebar first; the graph slot's own handler then gets the
 * next Escape to leave fullscreen. Capture phase, and registered only while
 * something is selected, so the two peel one layer at a time.
 */
export function useEscapeToDeselect(selectedId, deselect) {
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      deselect();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId, deselect]);
}

/**
 * The read-only canvas contract all three graphs render under: the node paints
 * its own ring from our selectedId, so react-flow's selection stays off (two
 * selection states drift apart — a ringed node with nothing open), and the
 * wheel only zooms in fullscreen so an inline graph never eats a page scroll.
 */
export function flowCanvasProps(expanded) {
  return {
    proOptions: { hideAttribution: true },
    nodesDraggable: false,
    nodesConnectable: false,
    nodesFocusable: false,
    elementsSelectable: false,
    edgesFocusable: false,
    zoomOnDoubleClick: false,
    zoomOnScroll: expanded,
    zoomOnPinch: true,
    preventScrolling: expanded,
    minZoom: 0.3,
    maxZoom: 1.6,
  };
}

/**
 * The sliding drawer every graph sidebar rides in — the experiment figure,
 * the logic graph, the wave process figure, the project graph, and the map.
 *
 * It owns the geometry (docked over the canvas's right edge at the shared
 * --fig-panel-w) and the motion: a translateX slide in from the edge, the
 * same slide back out. Its content is HELD through the slide-out — the panel
 * keeps rendering the last selection until the drawer has left the frame, so
 * nothing blanks mid-slide — and unmounted afterwards, so a closed drawer
 * leaves nothing focusable behind. While it is closed or leaving it is inert
 * and hidden from assistive tech.
 *
 * The duration is resolved through motionMs at render, so reduced-motion
 * users and hidden documents (background tabs, whose transitions never
 * advance) get the end state at once instead of a drawer stuck off-screen.
 */
export default function GraphDrawer({ open, children, className = '' }) {
  // The last content rendered while open — what shows during the slide-out.
  // Read synchronously in the closing render, so the panel never blanks for
  // a frame between "open" and "leaving".
  const lastRef = useRef(null);
  if (open) lastRef.current = children;
  const [, rerender] = useState(0);
  const ms = motionMs(DRAWER_MS);

  useEffect(() => {
    if (open || !lastRef.current) return undefined;
    // Drop the held content a little past the transition, so the last frame
    // has painted before it goes; a timer rather than transitionend so a
    // hidden document (where the transition never runs) still cleans up.
    const t = setTimeout(() => { lastRef.current = null; rerender(n => n + 1); }, ms + 40);
    return () => clearTimeout(t);
  }, [open, ms]);

  const content = open ? children : lastRef.current;
  return (
    <div
      className={`graph-drawer${open ? ' graph-drawer--open' : ''}${className ? ` ${className}` : ''}`}
      style={{ transitionDuration: `${ms}ms` }}
      aria-hidden={!open}
      // React 18 forwards `inert` only as a string attribute: '' sets it,
      // undefined removes it (a boolean false would still be truthy in HTML).
      inert={open ? undefined : ''}
    >
      {content}
    </div>
  );
}
