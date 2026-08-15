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
