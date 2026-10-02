import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import { useTool, type ApiError } from './api';
import { CheckIcon, ChevronRightIcon, CopyIcon, Icon } from './icons';
import { clockOf, duration, elapsed, term, words, type Liveness, type Now } from './liveness';
import { shortId } from './markdown';
import { useCommand } from './mutations';
import { ArtifactBody, bytes, fileType, type Artifact } from './views/artifacts';

export { term, words };

export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');

/**
 * One colour and one name per record kind, keyed by the view kind a row
 * declares. The kind label and every uppercase kind label read from this table
 * and nowhere else; the glyph of the same name is in icons.tsx. A colour is a
 * --kind-* token rather than a value, because each theme states its own: what is
 * legible as an 11px label on the light ground is not on the dark one. Kinds
 * that share a subject share a colour; a kind this build does not know — a row a
 * service outside this process published — falls back to the slate the agents
 * wear, and is named by its own noun rather than by an entry of its own.
 */
export const KIND: Record<string, { color: string; label: string }> = {
  research: { color: 'var(--kind-purple)', label: 'Research' },
  paper: { color: 'var(--kind-blue)', label: 'Paper' },
  tasks: { color: 'var(--kind-teal)', label: 'Task' },
  experiments: { color: 'var(--kind-teal)', label: 'Experiment' },
  work: { color: 'var(--kind-teal)', label: 'Work' },
  reviews: { color: 'var(--kind-red)', label: 'Review' },
  reflections: { color: 'var(--kind-red)', label: 'Reflection' },
  sessions: { color: 'var(--kind-slate)', label: 'Agent' },
  code: { color: 'var(--kind-slate)', label: 'Code' },
  connections: { color: 'var(--kind-slate)', label: 'Connection' },
  feed: { color: 'var(--kind-gray)', label: 'Post' },
  artifacts: { color: 'var(--kind-gray)', label: 'File' },
  settings: { color: 'var(--kind-gray)', label: 'Settings' },
  'legacy-history': { color: 'var(--kind-gray)', label: 'Archive' },
};
const UNKNOWN = { color: 'var(--kind-slate)', label: '' };
export const kindOf = (kind: string | undefined) =>
  (kind && KIND[kind]) || { ...UNKNOWN, label: words(kind ?? '') };
/** The kind's colour reaches the CSS as --kind, so a card and its label agree. */
export const kindStyle = (kind: string | undefined) =>
  ({ '--kind': kindOf(kind).color }) as CSSProperties;

/** The card's first line: the kind's name in small caps, in the kind's colour. */
export function KindLabel({ kind }: { kind: string | undefined }) {
  const { label } = kindOf(kind);
  if (!label) return null;
  return (
    <span className="kind" style={kindStyle(kind)}>
      {label}
    </span>
  );
}

const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/**
 * The absolute time in the reader's own locale, to the minute: `Sep 20, 2026,
 * 10:38 AM`. Seconds are the machine's business and stay in the ISO string. What
 * is not a time at all is returned as it was written.
 */
export const stamp = (at: string) => {
  const on = new Date(at);
  return Number.isNaN(on.getTime()) ? at : STAMP.format(on);
};

/** The same, as the element a time is: the ISO string is its value and its title. */
export const Stamp = ({ at, className }: { at: string; className?: string }) => (
  <time className={className} dateTime={at} title={at}>
    {stamp(at)}
  </time>
);

/** A relative time in a row, with the absolute one kept in its title and nowhere else. */
export const Ago = ({ at, className }: { at: string; className?: string }) => (
  <time className={className} dateTime={at} title={stamp(at)}>
    {relativeTime(at)}
  </time>
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
 * Every state a deployed program can stand in is here, a review gate included, so
 * work that is with a reviewer never reads as the grey of work that has stopped.
 */
type Tone = 'ok' | 'warn' | 'bad' | 'dim';
const TONES: [Tone, string][] = [
  [
    'ok',
    'ready done complete completed approved passed pass success succeeded active live online ' +
      'running healthy verified published accepted merged enabled connected open supported ' +
      'resolved working',
  ],
  [
    'warn',
    'degraded pending waiting requested started in_progress in-progress review reviewing ' +
      'claimed assigned queued stale retrying partial needs_changes needs_review deprecated ' +
      'attempting planning provisioning starting deleting cancelling needs_reconnect refreshing ' +
      'in_review design_review experiment_review planned defining ' +
      'researching reflecting synthesizing consolidating weakened ' +
      'held waiting_inputs retry_wait awaiting_resolution',
  ],
  [
    'bad',
    'unavailable unreachable failed failure fail error rejected blocked denied dead offline disconnected ' +
      'timed_out timeout invalid broken abandoned refuted contradicted missing unsupported ' +
      'quarantined conflicted blocked_infra',
  ],
  [
    'dim',
    'archived inactive disabled skipped ignored observer reader retired unassigned paused idle ' +
      'stopped ' +
      'draft none unpublished unverified cancelled closed expired not-published not-applicable ' +
      'metadata-only ended suspended',
  ],
];
const TONE_OF = new Map(
  TONES.flatMap(([tone, words]) => words.split(' ').map((word) => [word, tone] as const)),
);
export const toneOf = (value: string) => TONE_OF.get(value) ?? 'neutral';

/** A state reads as its dot and one small-caps word: ● COMPLETED. */
const Word = ({ tone, value }: { tone: string; value: string }) => (
  <span className={cx('status', `status--${tone}`)}>
    <span className="status-dot" aria-hidden="true" />
    {words(value)}
  </span>
);
export const StatusPill = ({ value }: { value: string | null | undefined }) =>
  value ? <Word tone={toneOf(value.toLowerCase())} value={value} /> : null;

/**
 * The liveness line: one phrase from the one module that composes them, with
 * colour reaching the verdict word alone. A record the server cannot speak for
 * renders no line at all.
 */
export function Live({ of }: { of: Liveness | null }) {
  if (!of) return null;
  return (
    <span className="cluster agent-help">
      <Word tone={of.tone} value={of.verdict} />
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
 * the panel. The clock cannot outrun its data: once the payload is older than the
 * cadence it was read at, the cell states the value that read saw and its age,
 * rather than counting a browser timer down against a fact nobody has refreshed.
 */
export function Countdown({ to, now }: { to: string | null | undefined; now: Now }) {
  const { at, since, stale } = clockOf(now);
  const on = to ? Date.parse(to) : Number.NaN;
  if (!Number.isFinite(on)) return <span className="ghost">—</span>;
  if (stale)
    return (
      <span className="countdown tabular">
        {duration(on - (at - since))} <span className="faint">as of {elapsed(since)} ago</span>
      </span>
    );
  const left = on - at;
  const near = left < 120_000 ? ' countdown--now' : left < 600_000 ? ' countdown--soon' : '';
  return <span className={`countdown tabular${near}`}>{duration(left)}</span>;
}

/**
 * A destructive control guarded in proportion to its consequence. The guard is
 * the one box on these pages, because there the box is the object: it names the
 * records under the click, and what will not change, before it acts. Ordinary
 * forward actions stay one click, and there is one path per mutation. What the
 * command answered is stated here, where the click was: the guard closes only on
 * a confirmed change, so a refusal, an unknown result and a request that changed
 * nothing all stay in front of the person who asked for them.
 */
export function ConfirmAction({
  label,
  title,
  confirm,
  busy,
  note,
  danger = true,
  onToggle,
  onConfirm,
  children,
}: {
  label: string;
  title: string;
  confirm: string;
  /** The label while the request is in flight; absent means not in flight. */
  busy?: string;
  /** What the command answered, rendered under the guard that asked it. */
  note?: ReactNode;
  /**
   * Whether this act is the kind that cannot be undone. The refusal's colour is the
   * page's one cue for that, so a reversible verb's confirm does not wear it.
   */
  danger?: boolean;
  /** Said as the guard opens and closes, so a caller can draw only the open one. */
  onToggle?(open: boolean): void;
  onConfirm(): void | Promise<boolean | void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) box.current?.querySelector('button')?.focus();
  }, [open]);
  const show = (next: boolean) => {
    setOpen(next);
    onToggle?.(next);
  };
  if (!open)
    return (
      <button className="btn" onClick={() => show(true)}>
        {label}
      </button>
    );
  return (
    <div
      className="guard"
      role="alertdialog"
      aria-label={title}
      ref={box}
      onKeyDown={(event) => event.key === 'Escape' && show(false)}
    >
      <strong>{title}</strong>
      {children}
      {note}
      <div className="cluster">
        <button
          className={danger ? 'btn btn--danger' : 'btn btn--primary'}
          disabled={!!busy}
          onClick={() => void Promise.resolve(onConfirm()).then((done) => done && show(false))}
        >
          {busy ?? confirm}
        </button>
        <button className="btn" disabled={!!busy} onClick={() => show(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The one line a fold shows while it is shut. Every disclosure on every page opens
 * from the same mark — the thin caret of icons.tsx, which turns as it opens — and
 * never from the browser's own triangle, which is a different weight in every
 * browser and no part of the glyph set.
 */
export const Summary = ({ children, ...rest }: HTMLAttributes<HTMLElement>) => (
  <summary {...rest}>
    <ChevronRightIcon size={12} className="caret" />
    {children}
  </summary>
);

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
 * the gate it stands at with the one control that moves it — no heading over it,
 * because the ladder is its own sentence — then what the record says of itself where
 * its author wrote more than a line, the kind's own content, how it got here, what
 * it relates to, and the details last. A slot this kind has nothing for is dropped
 * rather than drawn empty, and `title` is the kind's word for its content.
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
} & Partial<
  Record<'act' | 'description' | 'content' | 'history' | 'code' | 'related' | 'details', ReactNode>
>) {
  const order: [string, ReactNode][] = [
    ['Description', slots.description],
    [title, slots.content],
    ['History', slots.history],
    // What Git holds for this record is a section of it, never a second record page.
    ['Code', slots.code],
    ['Related', slots.related],
    ['Details', slots.details],
  ];
  return (
    <div className="page-stage record-page stack stack--lg">
      <PageHeader eyebrow={back} kind={kind} title={name} summary={standing} actions={state} />
      {slots.act}
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
 * A place with nothing in it, said once and the same way everywhere: the glyph of
 * the kind that would be here in that kind's colour, a few words, and — where
 * the reader may make the first one — the control that does. It carries the
 * create action itself, so nobody has to find a button at the far end of an empty
 * page. A failed load wears the same shape in the refusal's colour.
 */
export function EmptyState({
  kind,
  icon = kind,
  title,
  hint,
  action,
  error,
  page,
}: {
  /** The view kind: it names the glyph and supplies the colour. */
  kind?: string;
  /** A glyph other than the kind's own, by its name in icons.tsx. */
  icon?: string;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  error?: boolean;
  /** True where the state is the whole page, so its words are the page's one h1. */
  page?: boolean;
}) {
  const Title = page ? 'h1' : 'h2';
  return (
    <div
      className={cx('empty-state', error && 'empty-state--error')}
      role={error ? 'alert' : undefined}
      style={kind ? kindStyle(kind) : undefined}
    >
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} size={22} />
        </span>
      )}
      <Title className="empty-title">{title}</Title>
      {hint && <p>{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
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
  emptyKind,
  emptyIcon,
  emptyAction,
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
  /** What the empty state draws: see EmptyState's `kind`, `icon` and `action`. */
  emptyKind?: string;
  emptyIcon?: string;
  emptyAction?: ReactNode;
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
      <EmptyState
        error
        icon="alert"
        title={
          error.status === 403
            ? 'Not permitted'
            : error.status === 404
              ? 'Not found'
              : 'Could not load'
        }
        hint={
          <>
            {error.message} <span className="mono faint">({error.code})</span>
          </>
        }
        action={
          back && (
            <Link className="btn" to={back.to}>
              ← {back.label}
            </Link>
          )
        }
      />
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
      <EmptyState
        kind={emptyKind}
        icon={emptyIcon ?? emptyKind}
        title={emptyTitle}
        hint={emptyHint}
        action={emptyAction}
      />
    );
  return null;
}

/**
 * One labelled control, written the same way on every form: the label above it and
 * the limits the tool itself enforces passed straight through to the element. The
 * element wears the field's own class whatever form it stands in, so its frame, its
 * size under a finger and its 16px type on a phone never depend on the caller.
 */
type Asked = { label: ReactNode; value: string; onChange(value: string): void };
export const Field = ({
  label,
  value,
  onChange,
  className,
  ...rest
}: Asked & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) => (
  <label>
    {label}
    <input
      {...rest}
      className={cx('input', className)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
);
/** The same, where the answer runs longer than a line. */
export const Area = ({
  label,
  value,
  onChange,
  className,
  ...rest
}: Asked & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) => (
  <label>
    {label}
    <textarea
      {...rest}
      className={cx('textarea', className)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
);

/**
 * The search field of a list or a chooser: the glyph says what it is, so the
 * placeholder is one word and the sentence about what it reads is its name for a
 * screen reader instead.
 */
export const SearchField = ({
  label,
  value,
  onChange,
  placeholder = 'Search',
  title,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  title?: string;
}) => (
  <span className="search" title={title}>
    <Icon name="search" />
    <input
      className="input"
      type="search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </span>
);

/**
 * What every opened form does, whoever draws it: the cursor goes to its first
 * field as it opens, and Escape means what Cancel means wherever the focus
 * happens to be — except while its request is in flight, when there is nothing
 * left to cancel. The key is captured and marked as handled, so a pane that also
 * listens for Escape leaves the page alone; a field with its own use for the key
 * (the record picker's open list) takes it first, the same way.
 */
export function useOpenedForm(
  box: { current: HTMLElement | null },
  onClose: () => void,
  locked = false,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')
      ?.focus();
  }, [box]);
  useEffect(() => {
    if (locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [locked]);
}

/**
 * A form that stands on its own rather than under a list's control row — an
 * editor beside a heading, a panel's one form — held to the same width and given
 * the same manners as the forms a list opens.
 */
export function OpenedForm({
  onClose,
  locked,
  className,
  children,
  ...rest
}: Omit<FormHTMLAttributes<HTMLFormElement>, 'onKeyDown'> & {
  onClose(): void;
  locked?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  useOpenedForm(form, onClose, locked);
  return (
    <form {...rest} className={cx('creation', className)} ref={form}>
      {children}
    </form>
  );
}

/**
 * The one button a creation form submits with. The opener and the form's heading
 * already say what is being made, so the button says only `Create`; it keeps the
 * command's own words while the request is in flight or waiting to be retried.
 */
export const Submit = ({
  label = 'Create',
  busy,
  retry,
  disabled,
  saving = 'Saving…',
}: {
  label?: string;
  busy?: boolean;
  retry?: boolean;
  disabled?: boolean;
  saving?: string;
}) => (
  <button type="submit" className="btn btn--primary" disabled={busy || disabled}>
    {busy ? saving : retry ? 'Retry same request' : label}
  </button>
);

/**
 * Machine text is there to be copied, not read: one glyph takes all of it to the
 * clipboard and turns to a check for a moment. The clipboard exists only on a
 * secure origin; without it nothing is drawn, and the text is still there to
 * select or to read from its hover title.
 */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) return null;
  return (
    <button
      type="button"
      className="btn-icon btn-icon--inline"
      aria-label={label}
      title={copied ? 'Copied' : label}
      onClick={() =>
        void clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

/**
 * A hash or a commit is for comparing, not reading: its head in the mono, all of it
 * in the hover title and, where `copy` names the act, one click from the clipboard.
 */
export const Short = ({ value, copy }: { value: string; copy?: string }) => (
  <>
    <span className="mono faint" title={value}>
      {value.slice(0, 12)}…
    </span>
    {copy && <CopyButton text={value} label={copy} />}
  </>
);

/**
 * A refused command says so in one line, in the same place on every form. Where the
 * refusal is about one field, `id` lets that field name the line as its description.
 */
export const Failure = ({ message, id }: { message?: string; id?: string }) =>
  message ? (
    <p className="error-message" role="alert" id={id}>
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
    // The record moved under the control: what it shows is stale, not the click wrong.
    conflictCode: 'revision_conflict',
    onConflict: onSaved,
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

/**
 * When a record was made and when it last changed, as the two rows every Details
 * block ends with. A record nobody has touched since it was made says so by
 * having one row: Updated is left out when it reads the same, to the minute, as
 * Created. Spread it into a KV's rows.
 */
export const timeRows = (createdAt?: string | null, updatedAt?: string | null): KVRow[] => [
  !!createdAt && ['Created', <Stamp at={createdAt} />],
  !!updatedAt &&
    (!createdAt || stamp(updatedAt) !== stamp(createdAt)) && ['Updated', <Stamp at={updatedAt} />],
];

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

/**
 * Facts that are not records, ruled on one grid: the head and every row read the
 * same template, so a fact keeps its x-position down the list. It is the lease
 * list's anatomy, and it narrows the way that list does — each fact under the
 * last, behind its column's name — where a table carries its last columns off the
 * side of a phone without saying so.
 */
export function Ruled<T>({
  label,
  template,
  columns,
  rows,
  keyOf,
}: {
  label: string;
  template: string;
  columns: Column<T>[];
  rows: T[];
  keyOf(row: T): string;
}) {
  return (
    <div
      className="ruled"
      role="table"
      aria-label={label}
      style={{ '--cols': template } as CSSProperties}
    >
      <div className="ruled-head" role="row">
        {columns.map((column) => (
          <span className="label" role="columnheader" key={column.key}>
            {column.label}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="ruled-row" role="row" key={keyOf(row)}>
          {columns.map((column, at) => (
            // The first fact is the row's own name; the rest say which fact they are.
            <div role="cell" key={column.key} data-label={at ? column.label : undefined}>
              {column.render(row)}
            </div>
          ))}
        </div>
      ))}
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
 * reachable from the opened head — rather than the only way to read a file. The
 * summary has said the file's title, so the head under it does not say it again.
 * A file the one list did not name (it carries the newest thousand) is still shown
 * and still opens, under the short form every unnamed record takes until its own
 * head can name it.
 */
export function Evidence({
  artifactId,
  artifact,
  label,
  meta,
  opened = false,
}: {
  artifactId: string;
  artifact?: Artifact;
  label?: ReactNode;
  meta?: boolean;
  /** Open on arrival, where the file is what the page is about until something else is. */
  opened?: boolean;
}) {
  const [open, setOpen] = useState(opened);
  return (
    <details
      className="crit-file"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <Summary>
        {label ?? artifact?.title ?? <span className="mono">{shortId(artifactId)}</span>}
        {/* Shut, the summary says what would open; open, the head beneath it does. What it
            says is set a step apart and wraps as one piece, so a long title never leaves
            a separator hanging at the end of its line. */}
        {meta && artifact && !open && (
          <>
            {' '}
            <span className="faint crit-file-meta">
              {fileType(artifact).label} · {bytes(artifact.size)}
            </span>
          </>
        )}
      </Summary>
      {open && (
        <ArtifactBody
          artifactId={artifactId}
          metadata={artifact}
          named={!label && artifact ? 'cited' : undefined}
        />
      )}
    </details>
  );
}
