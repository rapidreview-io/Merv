import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool, type ApiError } from './api';
import { ArtifactBody, bytes, type Artifact } from './views/artifacts';

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');

/**
 * One colour and one icon per record kind, keyed by the view kind a row
 * declares. The rail dot, a card's left edge, the title line's icon and every
 * uppercase kind label read from this table and nowhere else. Kinds that share
 * a subject share a colour; a kind this build does not know stays gray and
 * wears no icon.
 */
export const KIND: Record<string, { color: string; icon: string; label: string }> = {
  research: { color: '#6d28d9', icon: '🔍', label: 'Research' },
  claims: { color: '#6d28d9', icon: '💡', label: 'Claim' },
  paper: { color: '#2563eb', icon: '📄', label: 'Paper' },
  knowledge: { color: '#2563eb', icon: '📚', label: 'Knowledge' },
  tasks: { color: '#0d9488', icon: '✅', label: 'Task' },
  experiments: { color: '#0d9488', icon: '🧪', label: 'Experiment' },
  reviews: { color: '#dc2626', icon: '✏️', label: 'Review' },
  reflections: { color: '#dc2626', icon: '🪞', label: 'Reflection' },
  consolidation: { color: '#d97706', icon: '🧩', label: 'Consolidation' },
  people: { color: '#475569', icon: '👤', label: 'Person' },
  sessions: { color: '#475569', icon: '🤖', label: 'Agent' },
  code: { color: '#475569', icon: '💻', label: 'Code' },
  connections: { color: '#475569', icon: '🔌', label: 'Connection' },
  feed: { color: '#6b7280', icon: '💬', label: 'Post' },
  artifacts: { color: '#6b7280', icon: '📎', label: 'File' },
  settings: { color: '#6b7280', icon: '⚙️', label: 'Settings' },
  'legacy-history': { color: '#6b7280', icon: '🗄️', label: 'Archive' },
};
const UNKNOWN = { color: '#6b7280', icon: '', label: '' };
export const kindOf = (kind: string | undefined) =>
  (kind && KIND[kind]) || { ...UNKNOWN, label: words(kind ?? '') };
/** The kind's colour reaches the CSS as --kind, so a card and its label agree. */
export const kindStyle = (kind: string | undefined) =>
  ({ '--kind': kindOf(kind).color }) as CSSProperties;

/** The card's first line: the kind's icon and its name in small caps. */
export function KindLabel({ kind }: { kind: string | undefined }) {
  const { icon, label } = kindOf(kind);
  if (!label) return null;
  return (
    <span className="kind" style={kindStyle(kind)}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {label}
    </span>
  );
}

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
 * classes in the stylesheet; any status this table does not know stays neutral.
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

/** A state reads as its dot and one small-caps word: ● COMPLETED. */
export function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className={cx('status', `status--${toneOf(value.toLowerCase())}`)}>
      <span className="status-dot" aria-hidden="true" />
      {words(value)}
    </span>
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
  kind,
  title,
  summary,
  actions,
}: {
  eyebrow?: ReactNode;
  kind?: string;
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      {kind && (
        <div className="page-kind">
          <KindLabel kind={kind} />
        </div>
      )}
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

/** One list serves every pinned title, so a record does not fetch each file to name it. */
export const useArtifacts = () => {
  const list = useTool<Artifact[]>('artifact.list');
  return new Map((list.data ?? []).map((item) => [item.id, item]));
};

/**
 * A pinned file read where it is cited: the summary opens the body in place and
 * costs nothing until it is opened, and /artifacts/:id stays a destination —
 * reachable from the opened head — rather than the only way to read a file.
 */
export function Evidence({
  artifactId,
  artifact,
  label,
  meta,
}: {
  artifactId: string;
  artifact?: Artifact;
  label?: ReactNode;
  meta?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="crit-file" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {label ?? artifact?.title ?? <ObjId id={artifactId} />}
        {meta && artifact && (
          <span className="faint">
            {' '}
            · {artifact.mediaType} · {bytes(artifact.size)}
          </span>
        )}
      </summary>
      {open && <ArtifactBody artifactId={artifactId} metadata={artifact} />}
    </details>
  );
}

/**
 * One server answer rendered once: the instruction the workflow wrote, the
 * conditions it named that the instruction does not already say, and the
 * prerequisites it is still waiting on. Every string is the server's own —
 * instruction, blocker.message, action.instruction, dependency.name — so the
 * browser adds no rule, re-words no enum and re-derives no readiness.
 */
export function GateBox({ decision }: { decision: WorkflowDecision }) {
  const lines = [
    ...new Set([
      ...decision.blockers.map((blocker) => blocker.message),
      ...(decision.nextAction ? [decision.nextAction.instruction] : []),
    ]),
  ].filter((line) => line !== decision.instruction);
  return (
    <div className="stack">
      <p>{decision.instruction}</p>
      {lines.map((line) => (
        <p className="muted" key={line}>
          {line}
        </p>
      ))}
      {decision.dependencies
        .filter((item) => !item.settled || item.failed)
        .map((item) => (
          <p className="muted" key={item.id}>
            {['task', 'experiment'].includes(item.workflow) ? (
              <Link to={`/${item.workflow === 'task' ? 'tasks' : 'experiments'}/${item.id}`}>
                {item.name || shortId(item.id)}
              </Link>
            ) : (
              item.name || <ObjId id={item.id} />
            )}{' '}
            <StatusPill value={item.state} />
          </p>
        ))}
    </div>
  );
}
