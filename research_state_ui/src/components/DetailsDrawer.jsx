import { useEffect, useRef } from 'react';

/*
 * DetailsDrawer — the operational sidecar of a work node (experiment or
 * task): status, timeline, graph neighbours, files, record. It never takes
 * layout space: the page keeps its one reading column and the drawer slides
 * over the right edge on press, dismisses on ✕, Escape, or the scrim.
 *
 * Light by design: page background, one hairline, quiet type — the same
 * facts the old right rail carried, without the permanent second column.
 * Content is the page's business; this component owns only the frame,
 * the motion, and focus (in on open, back to the toggle on close).
 */

export function DetailsButton({ open, onToggle, controls, buttonRef }) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={'btn btn--sm dtl-toggle' + (open ? ' dtl-toggle--open' : '')}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <span className="dtl-toggle-glyph" aria-hidden="true">▤</span>
      Details
    </button>
  );
}

export default function DetailsDrawer({ id, open, onClose, title = 'Details', children }) {
  const panelRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <>
      {/* A near-invisible scrim: click-away without dimming the page. */}
      <div
        className={'dtl-scrim' + (open ? ' dtl-scrim--open' : '')}
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        id={id}
        ref={panelRef}
        tabIndex={-1}
        className={'dtl-drawer' + (open ? ' dtl-drawer--open' : '')}
        aria-label={title}
      >
        <div className="dtl-head">
          <span className="dtl-title">{title}</span>
          <button type="button" className="dtl-close" aria-label="Close details" onClick={onClose}>✕</button>
        </div>
        {children}
      </aside>
    </>
  );
}
