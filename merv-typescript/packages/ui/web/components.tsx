import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool, type ApiError } from './api';
import { useCommand } from './mutations';
import { clockOf, duration, elapsed, term, words, type Liveness, type Now } from './liveness';
import { ArtifactBody, bytes, type Artifact } from './views/artifacts';

export { term, words };

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');

/**
 * One colour and one name per record kind, keyed by the view kind a row
 * declares. Icons live only in the rail (icons.tsx); the kind label and every
 * uppercase kind label read from this table and nowhere else. Kinds that share
 * a subject share a colour; a kind this build does not know — a row a service
 * outside this process published — falls back to the slate the agents wear, and
 * is named by its own noun rather than by an entry of its own.
 */
export const KIND: Record<string, { color: string; label: string }> = {
  research: { color: '#6d28d9', label: 'Research' },
  claims: { color: '#6d28d9', label: 'Claim' },
  paper: { color: '#2563eb', label: 'Paper' },
  tasks: { color: '#0d9488', label: 'Task' },
  experiments: { color: '#0d9488', label: 'Experiment' },
  reviews: { color: '#dc2626', label: 'Review' },
  reflections: { color: '#dc2626', label: 'Reflection' },
  consolidation: { color: '#d97706', label: 'Consolidation' },
  sessions: { color: '#475569', label: 'Agent' },
  code: { color: '#475569', label: 'Code' },
  connections: { color: '#475569', label: 'Connection' },
  feed: { color: '#6b7280', label: 'Post' },
  artifacts: { color: '#6b7280', label: 'File' },
  settings: { color: '#6b7280', label: 'Settings' },
  'legacy-history': { color: '#6b7280', label: 'Archive' },
};
const UNKNOWN = { color: '#475569', label: '' };
export const kindOf = (kind: string | undefined) =>
  (kind && KIND[kind]) || { ...UNKNOWN, label: words(kind ?? '') };
/** The kind's colour reaches the CSS as --kind, so a card and its label agree. */
export const kindStyle = (kind: string | undefined) =>
  ({ '--kind': kindOf(kind).color }) as CSSProperties;

/** The card's first line: the kind's name in small caps; icons live only in the rail. */
export function KindLabel({ kind }: { kind: string | undefined }) {
  const { label } = kindOf(kind);
  if (!label) return null;
  return (
    <span className="kind" style={kindStyle(kind)}>
      {label}
    </span>
  );
}

/** The absolute time, where a record states one exactly. */
export const stamp = (at: string) => new Date(at).toLocaleString();

/**
 * An identifier printed as text. No page of this UI does that any more; the two
 * Codex-owned views (views/code.tsx, views/settings.tsx) still do, and this
 * exists for them alone until their own pass removes it.
 */
export function ObjId({ id }: { id: string }) {
  const [prefix, rest] = id.split('_', 2);
  return (
    <span className="obj-id mono" title={id}>
      {rest ? `${prefix}_${rest.slice(0, 6)}` : id.slice(0, 10)}
    </span>
  );
}

/** A relative time in a row, with the exact stamp kept in its title and nowhere else. */
export const Ago = ({ at, className }: { at: string; className?: string }) => (
  <span className={className} title={at}>
    {relativeTime(at)}
  </span>
);

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
const TONES: [Tone, string][] = [
  [
    'ok',
    'ready done complete completed approved passed pass success succeeded active live online ' +
      'running healthy verified published accepted merged enabled connected open supported',
  ],
  [
    'warn',
    'degraded pending waiting requested started in_progress in-progress review reviewing ' +
      'claimed assigned queued stale retrying partial needs_changes needs_review deprecated ' +
      'attempting planning provisioning starting deleting cancelling',
  ],
  [
    'bad',
    'unavailable unreachable failed fail error rejected blocked denied dead offline disconnected ' +
      'timed_out timeout invalid broken abandoned refuted contradicted',
  ],
  [
    'dim',
    'archived inactive disabled skipped ignored observer reader retired unassigned paused idle ' +
      'stopped ' +
      'draft none unpublished unverified cancelled closed expired not-published not-applicable ' +
      'metadata-only',
  ],
];
const TONE_OF = new Map(
  TONES.flatMap(([tone, words]) => words.split(' ').map((word) => [word, tone] as const)),
);
export const toneOf = (value: string) => TONE_OF.get(value) ?? 'neutral';

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

/**
 * The liveness line: one phrase from the one module that composes them, with
 * colour reaching the verdict word alone. A record the server cannot speak for
 * renders no line at all.
 */
export function Live({ of }: { of: Liveness | null }) {
  if (!of) return null;
  return (
    <span className="cluster agent-help">
      <span className={cx('status', `status--${of.tone}`)}>
        <span className="status-dot" aria-hidden="true" />
        {words(of.verdict)}
      </span>
      {of.rest && <span className="muted">{of.rest}</span>}
    </span>
  );
}

/** One clock for a page, ticking only while something on the page is actually live. */
export function useNow(every: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!every) return;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/**
 * Time a person acts on, at the row's own size in the text colour: amber under
 * ten minutes, red under two, counting down to 0s rather than to a euphemism. A
 * row that cannot have the fact keeps the em dash; the absolute stamp lives in
 * the panel.
 */
export function Countdown({ to, now }: { to: string | null | undefined; now: number }) {
  const at = to ? Date.parse(to) : Number.NaN;
  if (!Number.isFinite(at)) return <span className="faint">—</span>;
  const left = at - now;
  const near = left < 120_000 ? ' countdown--now' : left < 600_000 ? ' countdown--soon' : '';
  return <span className={`countdown tabular${near}`}>{duration(left)}</span>;
}

/**
 * A destructive control guarded in proportion to its consequence. The guard is
 * the one box on these pages, because there the box is the object: it names the
 * records under the click, and what will not change, before it acts. Ordinary
 * forward actions stay one click, and there is one path per mutation.
 */
export function ConfirmAction({
  label,
  title,
  confirm,
  busy,
  onConfirm,
  children,
}: {
  label: string;
  title: string;
  confirm: string;
  /** The label while the request is in flight; absent means not in flight. */
  busy?: string;
  onConfirm(): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.querySelector('button')?.focus();
  }, [open]);
  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div
      className="guard"
      role="alertdialog"
      aria-label={title}
      ref={box}
      onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
    >
      <strong>{title}</strong>
      {children}
      <div className="cluster">
        <button className="btn btn--danger" disabled={!!busy} onClick={onConfirm}>
          {busy ?? confirm}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Every waiting state names whose move it is. An empty row is not a statement,
 * so a side with nothing on it says so in words; the browser adds the two labels
 * and nothing else.
 */
export function ActorSplit({ agent, you }: { agent?: ReactNode; you?: ReactNode }) {
  return (
    <div className="moves">
      <div className="move">
        <span className="label">Agent’s move</span>
        {agent || <p className="muted">Nothing until an agent moves.</p>}
      </div>
      <div className="move">
        <span className="label">Your move</span>
        {you || <p className="muted">Nothing is waiting on you.</p>}
      </div>
    </div>
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
      {summary && <div className="page-summary">{summary}</div>}
    </header>
  );
}

/**
 * One section of a record, titled from the one vocabulary every kind uses. A
 * section a kind cannot have is left out where it is written, never drawn empty;
 * a block that needs naming inside one takes the quiet small-caps label, so the
 * six titles keep their meaning down the page.
 */
export const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="stack" aria-label={title}>
    <h2 className="section-title">{title}</h2>
    {children}
  </section>
);

/**
 * One anatomy for every record, in one order: the way back and what this is, then
 * What happens next — the only place on the page with controls, so the next move
 * is always in the same spot — then the kind's own content, how it got here, what
 * it relates to, and the details last. A slot this kind has nothing for is dropped
 * rather than drawn empty, and `title` is the kind's word for its own content.
 */
export function RecordPage({
  back,
  kind,
  name,
  standing,
  state,
  title = '',
  ...slots
}: {
  back: ReactNode;
  kind?: string;
  name: ReactNode;
  /** Execution · review · outcome, in whatever words this kind already has for them. */
  standing?: ReactNode;
  state?: ReactNode;
  title?: string;
} & Partial<Record<'act' | 'content' | 'history' | 'related' | 'details', ReactNode>>) {
  const order: [string, ReactNode][] = [
    ['What happens next', slots.act],
    [title, slots.content],
    ['History', slots.history],
    ['Related', slots.related],
    ['Details', slots.details],
  ];
  return (
    <div className="page-stage record-page stack stack--lg">
      <PageHeader eyebrow={back} kind={kind} title={name} summary={standing} actions={state} />
      {order.map(([label, body]) =>
        label && body ? (
          <Part title={label} key={label}>
            {body}
          </Part>
        ) : null,
      )}
    </div>
  );
}

/**
 * Loading, error, and empty states share one calm voice; errors name the code
 * the server sent. While the read is in flight the list keeps its own shape:
 * grey rows in the same grid, in as many columns as the list will have. A failed
 * refresh with good data still on screen is a different case from a failed load:
 * it degrades to one line naming when the data last arrived, and never blanks a
 * list that is still correct. Pass the loaded result through and it is handled.
 */
export function LoadState({
  loading,
  error,
  data,
  loadedAt,
  empty,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  back,
  columns = 1,
}: {
  loading: boolean;
  error?: ApiError;
  data?: unknown;
  loadedAt?: string;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  back?: { to: string; label: string };
  columns?: number;
}) {
  if (error && data !== undefined)
    return (
      <p className="muted agent-help" role="status" title={`${error.message} (${error.code})`}>
        Could not refresh. Showing the state that loaded {loadedAt ? <Ago at={loadedAt} /> : 'last'}
        .
      </p>
    );
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
      <div className="skel" role="status" aria-label="Loading">
        {[0, 1, 2, 3].map((row) => (
          <div className="skel-row" key={row} style={{ '--cols': columns } as CSSProperties}>
            {Array.from({ length: columns }, (_, cell) => (
              <span className="skel-cell" key={cell} />
            ))}
          </div>
        ))}
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

/**
 * One labelled control, written the same way on every form: the label above it and
 * the limits the tool itself enforces passed straight through to the element.
 */
type Asked = { label: ReactNode; value: string; onChange(value: string): void };
export const Field = ({
  label,
  value,
  onChange,
  ...rest
}: Asked & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) => (
  <label>
    {label}
    <input {...rest} value={value} onChange={(event) => onChange(event.target.value)} />
  </label>
);
/** The same, where the answer runs longer than a line. */
export const Area = ({
  label,
  value,
  onChange,
  ...rest
}: Asked & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) => (
  <label>
    {label}
    <textarea {...rest} value={value} onChange={(event) => onChange(event.target.value)} />
  </label>
);

/** A refused command says so in one line, in the same place on every form. */
export const Failure = ({ message }: { message?: string }) =>
  message ? (
    <p className="error-message" role="alert">
      {message}
    </p>
  ) : null;

/** One control that advances a workflow, keeping its receipt through an uncertain answer. */
export function ResearchCommand({
  tool,
  input,
  label,
  onSaved,
  available = true,
  disabled = false,
}: {
  tool: string;
  input: Record<string, unknown>;
  label: string;
  onSaved: () => void;
  available?: boolean;
  disabled?: boolean;
}) {
  const command = useCommand<{ id: string; kind?: string }>({
    tool,
    validate: (value) =>
      !!value &&
      typeof value.id === 'string' &&
      (input.kind === undefined || value.kind === input.kind),
    onSuccess: onSaved,
  });
  if (!available && !command.locked) return null;
  return (
    <div className="stack">
      <Failure message={command.error} />
      <div>
        <button
          className="btn"
          disabled={command.busy || (disabled && !command.retry)}
          onClick={() => void command.submit(input)}
        >
          {command.busy ? 'Saving…' : command.retry ? 'Retry same request' : label}
        </button>
      </div>
    </div>
  );
}

/** A row a record cannot have is left out where it is written, not filtered upstream. */
export type KVRow = [string, ReactNode] | false | null | undefined;
export function KV({ rows }: { rows: KVRow[] }) {
  return (
    <dl className="kv">
      {rows
        .filter((row): row is [string, ReactNode] => !!row)
        .map(([label, value]) => (
          <div className="kv-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One column declared once: its key, its heading, and what a row says in it. */
export interface Column<T> {
  key: string;
  label: string;
  render(row: T): ReactNode;
  width?: string;
}
export const col = <T,>(
  key: string,
  label: string,
  render: (row: T) => ReactNode,
  width?: string,
): Column<T> => ({ key, label, render, width });

export function Table<T>({
  columns,
  rows,
  keyOf,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf(row: T): string;
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
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
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
 * A file this page cannot name is left out rather than named by its identifier.
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
  if (label === undefined && !artifact?.title) return null;
  return (
    <details className="crit-file" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {label ?? artifact?.title}
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
                {item.name}
              </Link>
            ) : (
              item.name
            )}{' '}
            <StatusPill value={item.state} />
          </p>
        ))}
    </div>
  );
}
