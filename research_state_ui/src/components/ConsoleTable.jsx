import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cx, fmtDuration } from '../utils/format';

/**
 * The console-dialect ledger table: a sortable header, then one clickable row
 * per record. Experiments, Tasks and Reflections all read this way, so the
 * chrome, the sort affordance and the row navigation live here once; a page
 * supplies its columns, its comparators, and the cells of each row.
 */

/**
 * Sort state for a console table: clicking a new column sorts it, clicking the
 * current one reverses. Time-ish columns open newest/longest first, so only the
 * columns named in `ascKeys` (names, usually) open ascending.
 */
export function useTableSort(initialKey, { ascKeys = [] } = {}) {
  const [sortKey, setSortKey] = useState(initialKey);
  const [sortDir, setSortDir] = useState('desc');
  const toggleSort = (key) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(ascKeys.includes(key) ? 'asc' : 'desc');
  };
  const sorted = (list, comparators) => {
    const cmp = comparators[sortKey] || comparators[initialKey];
    return list.slice().sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
  };
  return { sortKey, sortDir, toggleSort, sorted };
}

/**
 * The created→settled facts a ledger row sorts and renders on. A record still
 * in flight measures to `nowMs`, so its duration ticks with the home poll.
 */
export function spanFacts({ createdAt, endAt, settled }, nowMs) {
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  const endMs = settled && endAt ? Date.parse(endAt) : nowMs;
  return {
    settled,
    createdMs,
    endMs,
    durationMs: Number.isFinite(createdMs) ? Math.max(0, endMs - createdMs) : NaN,
  };
}

/** Comparators over `spanFacts`, shared by every page that shows those columns. */
export const SPAN_SORTS = {
  created: (a, b) => (a.facts.createdMs || 0) - (b.facts.createdMs || 0),
  finished: (a, b) => (a.facts.settled ? a.facts.endMs : 0) - (b.facts.settled ? b.facts.endMs : 0),
  duration: (a, b) => (a.facts.durationMs || 0) - (b.facts.durationMs || 0),
};

/** Two-line timestamp cell; an absent stamp reads as a dash with a reason. */
export function WhenCell({ parts, title, noneTitle }) {
  if (!parts) return <div className="expt-when expt-when--none" title={noneTitle}>—</div>;
  return (
    <div className="expt-when" title={title}>
      <span className="expt-when-day">{parts.day}</span>
      <span className="expt-when-time">{parts.time}</span>
    </div>
  );
}

/** Duration cell, with the live dot while the record is still moving. */
export function DurationCell({ facts, doneTitle, liveTitle }) {
  return (
    <div
      className={cx('expt-dur', !facts.settled && 'expt-dur--live')}
      title={facts.settled ? doneTitle : liveTitle}
    >
      {fmtDuration(facts.durationMs)}
      {!facts.settled && <span className="expt-live-dot" aria-hidden="true" />}
    </div>
  );
}

/**
 * @param {object[]} columns  [{ key, label, right? }]
 * @param {object[]} rows     [{ key, href, cells }] — `cells` is the row's JSX
 * @param {object}   sort     a useTableSort() result
 */
export default function ConsoleTable({ label, columns, rows, sort, className }) {
  const navigate = useNavigate();
  return (
    <div className="expt-scroll">
      <div className={cx('expt', className)} role="table" aria-label={label}>
        <div className="expt-head con-head" role="row">
          {columns.map(col => (
            <button
              key={col.key}
              type="button"
              role="columnheader"
              aria-sort={sort.sortKey === col.key ? (sort.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              className={cx('th', 'th--con', col.right && 'th--r', sort.sortKey === col.key && 'on')}
              onClick={() => sort.toggleSort(col.key)}
            >
              {col.label}
              {sort.sortKey === col.key && (
                <span className="arr" aria-hidden="true">{sort.sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
          ))}
        </div>
        {rows.map(row => (
          <div
            key={row.key}
            className="expt-row"
            role="row"
            tabIndex={0}
            onClick={() => navigate(row.href)}
            onKeyDown={ev => { if (ev.key === 'Enter') navigate(row.href); }}
          >
            {row.cells}
          </div>
        ))}
      </div>
    </div>
  );
}
