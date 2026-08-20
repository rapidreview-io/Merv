import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import StatusPill from './StatusPill';
import { fmtAgo, fmtSpan } from '../utils/format';

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

// The right-panel twin of the left sidebar's toggle (Sidebar.IconSidebar):
// same frame, divider on the other side.
function IconPanelRight(props) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M14.5 4.5v15" />
    </svg>
  );
}

// Icon-only, at the status strip's height on the far right — the mirror of
// the left sidebar's hide button.
export function DetailsButton({ open, onToggle, controls, buttonRef }) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={'dtl-toggle' + (open ? ' dtl-toggle--open' : '')}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? 'Hide details' : 'Show details'}
      title="Details"
      onClick={onToggle}
    >
      <IconPanelRight />
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

/* ── Shared drawer sections: the operations grammar. The pages hand in rows;
   nothing here repeats what a page already shows. ── */
const ago = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? fmtAgo(Date.now() - t) : null;
};
const msBetween = (a, b) => {
  const t0 = Date.parse(a || ''), t1 = Date.parse(b || '');
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null;
};

export function OpsTimeline({ items, done, createdAt, endedAt }) {
  if (!items.length) return null;
  const spans = items.map((item, i) => {
    if (i === 0) return null;
    const ms = msBetween(items[i - 1].t, item.t);
    return ms != null && ms >= 1000 ? fmtSpan(ms) : null;
  });
  const total = done ? msBetween(createdAt, endedAt) : null;
  return (
    <div className="dtl-sec">
      <div className="dtl-eyebrow">Timeline</div>
      <ul className="dtl-tl">
        {items.map((item, i) => (
          <li key={i}>
            <span className={`dtl-tl-dot${item.tone ? ` dtl-tl-dot--${item.tone}` : ''}`} aria-hidden="true" />
            <span className="dtl-tl-t" title={item.t}>{spans[i] ? `+${spans[i]}` : i === 0 ? ago(item.t) : '<1m'}</span>
            <span className="dtl-tl-w">{item.label}</span>
          </li>
        ))}
      </ul>
      {total != null && <div className="dtl-sub">{fmtSpan(total)} start to finish</div>}
    </div>
  );
}

export function OpsVersions({ groups }) {
  const shown = groups.filter(g => g.rows.length > 0);
  if (!shown.length) return null;
  return (
    <div className="dtl-sec">
      <div className="dtl-eyebrow">Versions</div>
      {shown.map(g => (
        <div key={g.label} className="dtl-vgroup">
          <div className="dtl-vlabel">{g.label} · {g.rows.length}</div>
          {g.rows.map((row, i) => (
            <div key={row.id || i} className="dtl-vrow" title={row.title || ''}>
              <span className="dtl-vname">{row.name}</span>
              {row.pill && <StatusPill value={row.pill} />}
              <span className="dtl-vmeta">{row.meta}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function OpsPosition({ upstream, downstream, waitNote }) {
  const row = (d) => (
    <div key={d.id} className="dtl-node-row">
      <span className="dtl-node-glyph" aria-hidden="true">{d.node_type === 'task' ? '◇' : '◈'}</span>
      <Link className="dtl-node-name" to={d.href}>{d.name || d.id}</Link>
      <StatusPill value={d.status} />
      {d.failed && <span className="dtl-bad">ended without succeeding</span>}
    </div>
  );
  return (
    <div className="dtl-sec">
      <div className="dtl-eyebrow">Position</div>
      <div className="dtl-vlabel">waits on{upstream.length ? ` · ${upstream.length}` : ''}</div>
      {upstream.length === 0 ? <div className="dtl-empty">nothing</div> : upstream.map(row)}
      <div className="dtl-vlabel" style={{ marginTop: 10 }}>unblocks{downstream.length ? ` · ${downstream.length}` : ''}</div>
      {downstream.length === 0 ? <div className="dtl-empty">nothing waits on this</div> : downstream.map(row)}
      {waitNote && <div className="dtl-sub">{waitNote}</div>}
    </div>
  );
}

