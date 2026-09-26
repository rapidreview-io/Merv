import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  RunningAction,
  RunningAttention,
  RunningFact,
  RunningLinkRow,
  RunningPanel,
  RunningPhrase,
  RunningRow,
  RunningSection,
  RunningStreamItem,
} from '@merv/contracts/running';
import { refreshTools, useTool } from '../api';
import { ConfirmAction, LoadState, Ruled, Summary, col, cx, useNow, words } from '../components';
import { ArrowRightIcon, CloseIcon } from '../icons';
import { clock, elapsed } from '../liveness';
import { Markdown } from '../markdown';
import { useCommand } from '../mutations';
import { ProcessDiagram, diagramOfGraph } from '../process';
import { Phrase, Reading, Target, phraseText, silent, ticks, valueText } from './running-phrase';

/**
 * The sidebar of whatever is in hand on the Running page. Its owner wrote every word of it
 * in the six kinds of section the contract names, and the page only draws them: what the
 * thing is and how it stands, the controls its owner allows this reader, then its sections
 * in the order the board composed them, and the way to its own page last. It reads itself
 * again every 4 s while its owner says something is moving, every 10 s otherwise.
 */

/**
 * One control. The input is sent exactly as its owner wrote it — a halt with no lease named
 * halts every lease — and where the owner said what a confirmed act must hold (`expect`),
 * an answer short of it keeps the guard open with the owner's own sentence under it, and
 * nothing on the page is refreshed as though it had happened.
 */
export function Act({ action }: { action: RunningAction }) {
  const [unmet, setUnmet] = useState(false);
  const met = useRef<boolean>();
  const { expect } = action;
  const command = useCommand<Record<string, unknown>>({
    tool: action.tool,
    idempotent: true,
    validate: (result) =>
      !expect ||
      (!!result && typeof result === 'object' && typeof result[expect.field] === 'number'),
    onSuccess: (result) => {
      const done = !expect || (result[expect.field] as number) >= expect.min;
      met.current = done;
      setUnmet(!done);
      if (done) refreshTools('ui.running', 'ui.running_panel');
    },
  });
  const run = async () => {
    met.current = undefined;
    setUnmet(false);
    await command.submit(action.input);
    return met.current === true;
  };
  const label = command.retry ? 'Retry same request' : action.label;
  const busy = command.busy ? 'Working…' : undefined;
  const note =
    command.error || unmet ? (
      <p className="error-message" role="alert">
        {command.error ?? expect?.nothing}
      </p>
    ) : null;
  if (action.guard) {
    // What ends something wears the refusal's colour before it is pressed, as on Sessions.
    const ends = action.verb === 'halt' || action.verb === 'release';
    const guard = (
      <ConfirmAction
        label={action.label}
        title={action.guard.title}
        confirm={label}
        busy={busy}
        note={note}
        danger={ends}
        onConfirm={run}
      >
        <p>{action.guard.consequence}</p>
      </ConfirmAction>
    );
    return ends ? <div className="act-danger">{guard}</div> : guard;
  }
  return (
    <>
      <button
        type="button"
        className={cx('btn', action.primary && 'btn--primary')}
        disabled={command.busy}
        onClick={() => void run()}
      >
        {busy ?? label}
      </button>
      {note}
    </>
  );
}

/** Rows of label and value; a row this reader has nothing for is not drawn. */
function Facts({ rows }: { rows: RunningFact[] }) {
  return (
    <dl className="kv running-facts">
      {rows.map((row, index) => {
        const [only] = row.value;
        // A link that is the whole value stands alone, so it is a control and as tall as one.
        const alone = row.value.length === 1 && typeof only === 'object' && 'link' in only;
        return (
          <div
            className={cx('kv-row', row.attention && 'running-attn')}
            key={`${row.label}${index}`}
          >
            <dt>{row.label}</dt>
            <dd>
              {alone ? (
                <Target to={only.link} className="hit">
                  {only.text}
                </Target>
              ) : (
                <Phrase value={row.value} in="facts" />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A table is the ruled list Sessions uses, so it stacks by the sidebar's own width rather
 * than carrying its last columns off the side of it. A row with somewhere to go is that
 * way from its first cell.
 */
function Rows({ section }: { section: Extract<RunningSection, { kind: 'table' }> }) {
  const reading = useContext(Reading);
  const rows = section.rows;
  const columns = section.columns.map((label, at) =>
    col<RunningRow>(String(at), label, (row) => {
      const cell = row.cells[at];
      if (!cell || silent(cell, reading)) return null;
      const said = (
        <span className={cx(row.attention && 'running-attn')}>
          <Phrase value={cell} in={at === 0 && row.to ? 'line' : 'cell'} />
        </span>
      );
      return at === 0 && row.to ? (
        <Target to={row.to} className="hit">
          {said}
        </Target>
      ) : (
        said
      );
    }),
  );
  return (
    <Ruled
      label={section.title}
      template={section.columns
        .map((_, at) => (at ? 'minmax(0, 1fr)' : 'minmax(0, 1.6fr)'))
        .join(' ')}
      columns={columns}
      rows={rows}
      keyOf={(row) => String(rows.indexOf(row))}
    />
  );
}

/** One line a thing: what kind it is, its name, and how it stands; the line is the way to it. */
function Jumps({ rows }: { rows: RunningLinkRow[] }) {
  return (
    <ul className="running-jumps">
      {rows.map((row, index) => (
        <li key={index}>
          <Target to={row.to} className={cx('running-jump', row.attention && 'running-attn')}>
            {row.kind && <span className="running-kind">{row.kind}</span>}
            <span className="running-jump-name">{row.name}</span>
            {row.says && (
              <span className="running-jump-says">
                <Phrase value={row.says} />
              </span>
            )}
          </Target>
        </li>
      ))}
    </ul>
  );
}

/** How long a silence between two rows must be before the stream says so. */
const QUIET = 5 * 60_000;
export type StreamRow =
  | {
      kind: 'call';
      call: string;
      state: 'running' | 'succeeded' | 'failed' | 'interrupted';
      at: string;
      ms: number | null;
      /** Adjacent calls of one tool that ended the same way, drawn as one row. */
      times: number;
    }
  | { kind: 'mark'; mark: RunningPhrase; at: string }
  | { kind: 'gap'; ms: number; at: string };

/**
 * The stream as it is drawn: calls still running first, in the order sent; then the rest,
 * newest first, with a run of one tool ending the same way said once, and every silence of
 * five minutes or more said where it fell.
 */
export function streamRows(items: readonly RunningStreamItem[]): StreamRow[] {
  const running: StreamRow[] = [];
  const rows: StreamRow[] = [];
  let last: number | undefined;
  for (const item of items) {
    if ('call' in item && item.state === 'running') {
      running.push({ kind: 'call', ...item, times: 1 });
      continue;
    }
    const at = Date.parse(item.at);
    const gap = last === undefined || !Number.isFinite(at) ? 0 : Math.abs(last - at);
    if (gap >= QUIET) rows.push({ kind: 'gap', ms: gap, at: item.at });
    const previous = rows.at(-1);
    if (
      'call' in item &&
      previous?.kind === 'call' &&
      previous.call === item.call &&
      previous.state === item.state
    ) {
      previous.times++;
      previous.ms = null;
    } else
      rows.push('call' in item ? { kind: 'call', ...item, times: 1 } : { kind: 'mark', ...item });
    if (Number.isFinite(at)) last = at;
  }
  return [...running, ...rows];
}

/** The Merv calls a session made, as the stream the owner sent: tool, how it ended, when. */
function Stream({ items }: { items: RunningStreamItem[] }) {
  const reading = useContext(Reading);
  const ago = (at: string) => valueText({ ago: at }, reading);
  return (
    <ol className="running-stream">
      {streamRows(items).map((row, index) =>
        row.kind === 'gap' ? (
          <li className="running-stream-quiet" key={index}>
            <span />
            <span>No call for {elapsed(row.ms)}</span>
          </li>
        ) : row.kind === 'mark' ? (
          <li className="running-stream-quiet" key={index}>
            <time dateTime={row.at}>{ago(row.at)}</time>
            <span>
              <Phrase value={row.mark} />
            </span>
          </li>
        ) : (
          <li key={index}>
            <time dateTime={row.at}>
              {row.state === 'running' ? valueText({ since: row.at }, reading) : ago(row.at)}
            </time>
            <span className="running-stream-call">
              <span className="mono">{row.call}</span>
              {row.times > 1 && <span className="faint"> ×{row.times}</span>}
            </span>
            <span className="running-state">{words(row.state)}</span>
            <span className="faint tabular">
              {row.ms !== null && row.ms >= 1000 ? elapsed(row.ms) : ''}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * The section as this reader reads it: a row whose phrase says nothing to them — an actor
 * they may not name, say — is dropped, and a section left with nothing is dropped whole,
 * rather than standing as a heading over nothing.
 */
function readable(
  section: RunningSection,
  reading: Parameters<typeof silent>[1],
): RunningSection | null {
  switch (section.kind) {
    case 'facts': {
      const rows = section.rows.filter((row) => !silent(row.value, reading));
      return rows.length ? { ...section, rows } : null;
    }
    case 'table': {
      const rows = section.rows.filter((row) => row.cells.some((cell) => !silent(cell, reading)));
      return rows.length ? { ...section, rows } : null;
    }
    case 'links':
      return section.rows.length ? section : null;
    case 'text':
      return section.text.trim() ? section : null;
    case 'ladder':
      return section;
    case 'stream':
      return section.items.length ? section : null;
  }
}

function Body({ section }: { section: RunningSection }) {
  switch (section.kind) {
    case 'facts':
      return <Facts rows={section.rows} />;
    case 'table':
      return <Rows section={section} />;
    case 'links':
      return <Jumps rows={section.rows} />;
    case 'text':
      return section.markdown ? (
        <Markdown source={section.truncated ? `${section.text}\n\n…` : section.text} under={3} />
      ) : (
        <p
          className={cx('running-text', !!section.clamp && 'running-text--clamp')}
          style={section.clamp ? { WebkitLineClamp: section.clamp } : undefined}
        >
          {section.text}
          {section.truncated && '…'}
        </p>
      );
    case 'ladder':
      // The whole machine needs about 410px; a narrower sidebar scrolls it in its own block.
      return (
        <div className="running-ladder">
          <ProcessDiagram {...diagramOfGraph(section.graph)} kind="running" />
        </div>
      );
    case 'stream':
      return <Stream items={section.items} />;
  }
}

function Section({ section: sent }: { section: RunningSection }) {
  const reading = useContext(Reading);
  const section = readable(sent, reading);
  if (!section) return null;
  const head = (
    <>
      <span className="running-section-title">{section.title}</span>
      {section.aside && !silent(section.aside, reading) && (
        <span className="running-aside">
          <Phrase value={section.aside} in="cell" />
        </span>
      )}
    </>
  );
  const heading = cx('running-section-head', section.attention && 'running-attn');
  if (section.folded)
    return (
      <details className="running-section">
        <Summary className={heading}>{head}</Summary>
        <Body section={section} />
      </details>
    );
  return (
    <section className="running-section" aria-label={section.title}>
      <h3 className={heading}>{head}</h3>
      <Body section={section} />
    </section>
  );
}

/**
 * The line under the title: how the thing stands, or — where it needs a person — what
 * needs one, in the refusal's colour, then who ends the wait and the way to the move. A
 * screen reader's live region holds every word of it and none of its clocks, wherever they
 * stand in the line, so a person is told once when the standing changes and never every
 * second.
 */
function Standing({ says, attention }: { says: RunningPhrase; attention?: RunningAttention }) {
  const reading = useContext(Reading);
  const said = attention?.says ?? says;
  return (
    <>
      <p className={cx('running-says', attention && !attention.quiet && 'running-attn')}>
        <Phrase value={said} in="cell" />
      </p>
      <span className="sr-only" role="status">
        {phraseText(
          said.filter((value) => !ticks(value)),
          reading,
        )}
      </span>
      {attention?.who && <p className="running-who">{attention.who}</p>}
      {attention?.to && (
        <Target to={attention.to} className="hit running-move">
          {attention.to.text}
        </Target>
      )}
    </>
  );
}

/**
 * The sidebar for one key. It is remounted for each key it shows, so a control's answer
 * never stands over another thing's sidebar. `attention` is the board's for this node — a
 * mark another owner raised on it — used where the owner's own head raises none.
 */
export function RunningSidebar({
  target,
  attention,
  moving,
  onClose,
  onMissing,
  nameOf,
  open,
}: {
  target: string;
  attention?: RunningAttention;
  /** The board draws this thing live, so its sidebar is read at the live pace from the start. */
  moving?: boolean;
  onClose(): void;
  /** Where no owner answers for the key, the page the link that opened it named instead. */
  onMissing?(): void;
  nameOf(id: string): string | undefined;
  open(key: string, route?: string): void;
}) {
  const [every, setEvery] = useState(moving ? 4000 : 10_000);
  const panel = useTool<RunningPanel>('ui.running_panel', { key: target }, { every });
  const data = panel.data;
  const live = data?.live;
  useEffect(() => {
    if (live !== undefined) setEvery(live ? 4000 : 10_000);
  }, [live]);
  // The sidebar keeps its own clock: it measures from its own read, which is not the board's.
  const now = clock(data?.observedAt, panel.loadedAt, useNow(1000), every * 2);
  const head = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const loaded = !!data;
  const missing = !data && panel.error?.code === 'running_not_found';
  useEffect(() => {
    if (missing) onMissing?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing]);
  // The cursor goes to the name of what opened, once it has one; where the sidebar stands
  // under the board rather than beside it, its head is brought into view as well.
  useEffect(() => {
    if (!loaded || !head.current) return;
    heading.current?.focus({ preventScroll: true });
    const top = head.current.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight - 96) head.current.scrollIntoView?.({ block: 'start' });
  }, [loaded]);
  const close = (
    <button
      type="button"
      className="btn-icon running-close"
      aria-label="Close"
      title="Close"
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );
  if (!data)
    return (
      <div className="running-sidebar">
        <div className="running-panel-top">{close}</div>
        {missing && onMissing ? <LoadState loading /> : <LoadState {...panel} />}
      </div>
    );
  const standing = data.header.attention ?? attention;
  return (
    <Reading.Provider value={{ now, nameOf, open }}>
      <div className="running-sidebar">
        <header className="running-panel-head" ref={head}>
          <div className="running-panel-top">
            <span className="running-kind">{data.header.kind}</span>
            {close}
          </div>
          <h2 id="running-panel-title" className="running-panel-title" tabIndex={-1} ref={heading}>
            {data.header.title}
          </h2>
          <Standing says={data.header.says} attention={standing} />
        </header>
        {data.actions.length > 0 && (
          <div className="cluster running-acts">
            {data.actions.map((action) => (
              <Act key={`${action.tool}:${action.label}`} action={action} />
            ))}
          </div>
        )}
        {panel.error && <LoadState {...panel} />}
        {data.sections.map((section, index) => (
          <Section key={`${section.owner ?? ''}:${section.title}:${index}`} section={section} />
        ))}
        {data.route && (
          <Link className="running-open hit" to={data.route}>
            Open record <ArrowRightIcon size={14} />
          </Link>
        )}
      </div>
    </Reading.Provider>
  );
}
