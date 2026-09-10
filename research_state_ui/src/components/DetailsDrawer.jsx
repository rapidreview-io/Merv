import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import StatusPill from './StatusPill';
import { fmtSpan, formatBytes } from '../utils/format';
import { nodeRoute } from '../utils/entityResolve';
import { ago, msBetween } from '../utils/time';

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
/** The drawer's open state, with focus returning to the button that opened it. */
export function useDetailsDrawer() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsBtnRef = useRef(null);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    detailsBtnRef.current?.focus({ preventScroll: true });
  }, []);
  const toggleDetails = useCallback(() => setDetailsOpen(v => !v), []);
  return { detailsOpen, setDetailsOpen, toggleDetails, closeDetails, detailsBtnRef };
}

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
/* ── Row builders for the three sections. The experiment and the task drawer
   show the same operations grammar, so they read the record the same way. ── */

// Submission order: the stamp, then the server's tiebreak for a same-second
// batch (second-resolution timestamps tie more often than you would think).
const byArtifactOrder = (a, b) =>
  String(a.created_at || '').localeCompare(String(b.created_at || ''))
  || ((a.submitted_order ?? 0) - (b.submitted_order ?? 0));

export function sortedArtifacts(record) {
  return (record.artifacts || []).slice().sort(byArtifactOrder);
}

/** One role's submissions as version rows: "v2 · attempt 3", size, age. */
export function versionRows(artifacts, role) {
  return artifacts.filter(a => a.role === role).map((a, i) => ({
    id: a.id,
    name: `v${i + 1}${a.attempt_index != null ? ` · attempt ${a.attempt_index}` : ''}`,
    meta: [a.size_bytes != null ? formatBytes(a.size_bytes) : null, ago(a.created_at)].filter(Boolean).join(' · '),
    title: a.path,
  }));
}

/** Review rounds as version rows: the round, the verdict pill, the age. */
export function reviewRows(reviews) {
  return reviews.map((r, i) => ({
    id: r.id,
    name: `round ${i + 1}`,
    pill: String(r.verdict || 'pending').toLowerCase(),
    meta: ago(r.created_at) || '',
  }));
}

/** Timeline items in the order they happened; `rank` breaks a same-second tie. */
export function orderedTimeline(items) {
  return items
    .filter(i => i.t)
    .sort((a, b) => String(a.t).localeCompare(String(b.t)) || (a.rank - b.rank));
}

/** Dependency/dependent nodes, each carrying the href of its own page. */
export function linkedNodes(nodes, px) {
  return (nodes || []).map(d => ({ ...d, href: px(nodeRoute(d)) }));
}

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

