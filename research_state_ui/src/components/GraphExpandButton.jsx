import { useCallback, useEffect, useState } from 'react';

/**
 * Expanded (near-fullscreen) mode for a graph slot: it survives switching
 * between the two graphs, Escape leaves it, and page scroll locks while it is
 * open. Lives next to the button that toggles it.
 */
export function useGraphExpand() {
  const [expanded, setExpanded] = useState(false);
  const toggleExpand = useCallback(() => setExpanded(v => !v), []);
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = e => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);
  return { expanded, toggleExpand, collapse: () => setExpanded(false) };
}

/** Which of a slot's graphs have anything to show; each child reports itself. */
export function useGraphAvailability(initial) {
  const [avail, setAvail] = useState(initial);
  const report = useCallback((key, value) => {
    setAvail(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  return [avail, report];
}

/**
 * The one expand/collapse control every graph header carries.
 *
 * Two rules it exists to enforce. First, it is always in the header, never
 * floating on the canvas — the canvas stays free of controls, and the reader
 * finds the same button in the same place on all five graphs. Second, it never
 * borrows '✕': that glyph means "close the sidebar" and nothing else. Three
 * graphs used to label their collapse action '✕ Close' while the sidebar close
 * was '×', so the same mark meant two opposite things on one screen.
 */
export default function GraphExpandButton({ expanded, onToggle, label = 'graph' }) {
  if (!onToggle) return null;
  return (
    <button
      type="button"
      className="fig-expand-btn"
      onClick={onToggle}
      aria-pressed={expanded}
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
    >
      <span className="fig-expand-ic" aria-hidden="true">{expanded ? '⤡' : '⤢'}</span>
      {expanded ? 'Collapse' : 'Expand'}
    </button>
  );
}
