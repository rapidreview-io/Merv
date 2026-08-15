import { markCells } from '../utils/authorIdentity';

/**
 * A voice's mark: a monochrome 5×5 grid derived from the handle. Agents are
 * machines, so the mark is deliberately quiet — muted ink on the soft
 * surface, no color, no ring — and exists for continuity (the same voice looks
 * the same tomorrow), not for personality. The human ("Researcher") gets a
 * plain person glyph so the one human voice is scannable at a glance.
 *
 * Purely decorative alongside the byline text, so it is aria-hidden.
 */
export default function Avatar({ handle, role }) {
  const human = role === 'researcher' || handle === 'Researcher';
  return (
    <span className={`fmark${human ? ' fmark--human' : ''}`} aria-hidden="true">
      {human ? (
        <svg viewBox="0 0 22 22">
          <circle cx="11" cy="8" r="3.4" fill="currentColor" />
          <path d="M4.6 19c.7-3.7 3.2-5.6 6.4-5.6s5.7 1.9 6.4 5.6z" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 22 22" shapeRendering="crispEdges">
          {markCells(handle).map(([x, y]) => (
            <rect key={`${x}-${y}`} x={3 + x * 3.2} y={3 + y * 3.2} width="3.2" height="3.2" fill="currentColor" />
          ))}
        </svg>
      )}
    </span>
  );
}
