import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ApiError } from './api';

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');

export const shortId = (id: string) => {
  const [prefix, rest] = id.split('_', 2);
  return rest ? `${prefix}_${rest.slice(0, 6)}` : id.slice(0, 10);
};
export const words = (value: string) => value.replaceAll('_', ' ');

export function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60_000);
  if (!Number.isFinite(minutes)) return iso;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Semantic tone for status text. Tones map to the status--ok/warn/bad/dim
 * classes in the generated CSS; any status this table does not know stays
 * neutral. The raw lowercased status class is kept alongside the tone class
 * so existing per-status overrides continue to apply.
 */
type Tone = 'ok' | 'warn' | 'bad' | 'dim';
const TONES: [Tone, Set<string>][] = [
  [
    'ok',
    new Set([
      'ready',
      'done',
      'complete',
      'completed',
      'approved',
      'passed',
      'pass',
      'success',
      'succeeded',
      'active',
      'live',
      'online',
      'running',
      'healthy',
      'verified',
      'published',
      'accepted',
      'merged',
      'enabled',
      'connected',
      'open',
      'supported',
    ]),
  ],
  [
    'warn',
    new Set([
      'degraded',
      'pending',
      'waiting',
      'requested',
      'started',
      'in_progress',
      'in-progress',
      'review',
      'reviewing',
      'claimed',
      'assigned',
      'queued',
      'stale',
      'retrying',
      'partial',
      'needs_changes',
      'needs_review',
      'deprecated',
      'attempting',
      'planning',
    ]),
  ],
  [
    'bad',
    new Set([
      'unavailable',
      'failed',
      'fail',
      'error',
      'rejected',
      'blocked',
      'denied',
      'dead',
      'offline',
      'disconnected',
      'timed_out',
      'timeout',
      'invalid',
      'broken',
      'abandoned',
      'refuted',
      'contradicted',
    ]),
  ],
  [
    'dim',
    new Set([
      'archived',
      'inactive',
      'disabled',
      'skipped',
      'ignored',
      'observer',
      'reader',
      'retired',
      'unassigned',
      'paused',
      'draft',
      'none',
      'unpublished',
      'unverified',
      'cancelled',
      'closed',
      'expired',
      'not-published',
      'not-applicable',
      'metadata-only',
    ]),
  ],
];
const toneOf = (value: string) => TONES.find(([, set]) => set.has(value))?.[0] ?? 'neutral';

export function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  const v = value.toLowerCase();
  return (
    <span className={cx('status', 'status--pill', `status--${toneOf(v)}`, v)}>{words(value)}</span>
  );
}

export function ObjId({ id, strong }: { id: string; strong?: boolean }) {
  return (
    <span className={cx('obj-id', 'mono', strong && 'obj-id--strong')} title={id}>
      {shortId(id)}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  summary,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <div className="page-head-row">
        <h1 className="page-title">{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {summary && <p className="page-summary">{summary}</p>}
    </header>
  );
}

/** Loading, error, and empty states share one calm voice; errors name the code the server sent. */
export function LoadState({
  loading,
  error,
  empty,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  back,
}: {
  loading: boolean;
  error?: ApiError;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  back?: { to: string; label: string };
}) {
  if (error)
    return (
      <div className="empty-state empty-state--error" role="alert">
        <h2>
          {error.status === 403
            ? 'Not permitted'
            : error.status === 404
              ? 'Not found'
              : 'Could not load'}
        </h2>
        <p>
          {error.message} <span className="mono faint">({error.code})</span>
        </p>
        {back && (
          <Link className="btn" to={back.to}>
            ← {back.label}
          </Link>
        )}
      </div>
    );
  if (loading)
    return (
      <div className="empty" role="status">
        Loading…
      </div>
    );
  if (empty)
    return (
      <div className="empty-state">
        <h2>{emptyTitle}</h2>
        {emptyHint && <p>{emptyHint}</p>}
      </div>
    );
  return null;
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div className="kv-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table<T>({
  columns,
  rows,
  keyOf,
  onRow,
}: {
  columns: { key: string; label: string; render(row: T): ReactNode; width?: string }[];
  rows: T[];
  keyOf(row: T): string;
  onRow?(row: T): string;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={keyOf(row)}>
              {columns.map((column, index) => (
                <td key={column.key}>
                  {index === 0 && onRow ? (
                    <Link className="row-link" to={onRow(row)}>
                      {column.render(row)}
                    </Link>
                  ) : (
                    column.render(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
