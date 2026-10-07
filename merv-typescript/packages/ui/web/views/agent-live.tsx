import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentStreamEvent } from '@merv/sessions/agent-stream';
import { emptyOutput } from '@merv/sessions/agent-stream';
import { NO_TIMELINE, mergeEvents, useAgentStream, type AgentBlock } from '../agent-stream';
import type { EventStreamState } from '../event-stream';
import { CodeBlock } from '../code-block';
import { Summary, cx } from '../components';
import {
  timeline,
  type Entry,
  type PersonLine,
  type Step,
  type TailLine,
  type VisitBlocks,
} from '../conversation';
import { Icon, type IconName } from '../icons';
import { JsonView, readJson } from '../json-view';
import { MarkdownPieces } from '../markdown';

/**
 * A thread's conversation, in its dialog and in a unit's Agents tab: a timeline, newest at the
 * foot. What the agent says is the prose the eye lands on; the steps it took between two things
 * it said are one quiet group line, each step one short line a press opens to its raw input and
 * output; a step that failed is a red line that stays in sight; a person's line stands on an
 * accent bar; a visit or a milestone is a thin divider. The visit that holds its lease is read
 * live; the others are what Sessions kept of them. Sessions says what each event is
 * (`../conversation`); this only draws.
 */

/** How many entries are drawn at a time; the rest are a press away. */
const WINDOW = 300;
/** Output longer than this opens folded. */
const LONG_LINES = 12;
const LONG_CHARS = 1500;

const Cut = ({ count }: { count: number }) =>
  count > 0 ? (
    <p className="agent-cut">… {count.toLocaleString('en-US')} characters not shown</p>
  ) : null;

/** A tool's arguments: a tree where they are JSON, the text as it came where they are not. */
function Input({ input }: { input: string }) {
  const json = readJson(input);
  if (json && json.value && typeof json.value === 'object' && !Object.keys(json.value).length)
    return null;
  return json ? <JsonView value={json.value} /> : <CodeBlock code={input} label="Input" />;
}

/**
 * What the tool answered: a terminal's text, or JSON laid out two spaces deep, folded where it
 * is long. An answer with nothing in it is not drawn at all.
 */
function Output({
  result,
}: {
  result: NonNullable<Extract<AgentBlock, { kind: 'tool' }>['result']>;
}) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    const read = readJson(result.output);
    return read?.value && typeof read.value === 'object'
      ? JSON.stringify(read.value, null, 2)
      : undefined;
  }, [result.output]);
  if (emptyOutput(result.output)) return null;
  const output = json ?? result.output;
  const lines = output.split('\n').length;
  const label = result.error ? 'Error' : 'Output';
  const block = <CodeBlock code={output} label={label} />;
  if (lines <= LONG_LINES && output.length <= LONG_CHARS)
    return (
      <div className={cx('agent-output', result.error && 'agent-output--error')}>
        {block}
        <Cut count={result.cut} />
      </div>
    );
  return (
    <details
      className={cx('agent-output', result.error && 'agent-output--error')}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <Summary>
        {label} · {lines.toLocaleString('en-US')} lines
      </Summary>
      {open && block}
      <Cut count={result.cut} />
    </details>
  );
}

/** What a step opens to: a thought read whole, or a call's raw input and its answer. */
function StepBody({ block }: { block: AgentBlock }) {
  if (block.kind === 'thinking' || block.kind === 'text')
    return (
      <div className="agent-step-body agent-step-thought">
        <MarkdownPieces source={block.text} />
        <Cut count={block.cut} />
      </div>
    );
  if (block.kind === 'status') return <p className="agent-step-body mono">{block.text}</p>;
  return (
    <div className="agent-step-body">
      {block.input && <Input input={block.input} />}
      <Cut count={block.cut} />
      {block.result && <Output result={block.result} />}
    </div>
  );
}

const ICONS: Record<string, IconName> = {
  Ran: 'code',
  Read: 'paper',
  Wrote: 'paper',
  Edited: 'edit',
  Updated: 'edit',
};
const iconOf = (step: Step): IconName =>
  step.kind === 'error'
    ? 'close'
    : step.kind === 'thinking'
      ? 'fallback'
      : (ICONS[step.label.split(' ', 1)[0]!] ?? 'connections');

/** One step as one line; a press opens what it did, raw, and only there. */
const StepLine = memo(function StepLine({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('agent-step', `agent-step--${step.kind}`, open && 'agent-step--open')}>
      <button
        type="button"
        className="agent-step-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {step.running ? (
          <span className="live-dot live-dot--moving" aria-hidden="true" />
        ) : (
          <Icon name={iconOf(step)} size={12} className="agent-step-icon" />
        )}
        <span className="agent-step-label">{step.label}</span>
        {step.summary && <span className="agent-step-summary">{step.summary}</span>}
      </button>
      {open && <StepBody block={step.block} />}
    </div>
  );
});

/**
 * The steps between two lines that are not steps: one alone is its line; more are one group
 * line, "12 steps", with the newest step's summary while the visit is live, opened to every
 * step. A step that failed stays in sight under the group while it is shut.
 */
function Steps({ entry, last }: { entry: Extract<Entry, { type: 'steps' }>; last: boolean }) {
  const [open, setOpen] = useState(false);
  const { steps } = entry;
  if (steps.length === 1) return <StepLine step={steps[0]!} />;
  const errors = steps.filter((step) => step.kind === 'error');
  const newest = steps.at(-1)!;
  const following = entry.live && last;
  return (
    <div className={cx('agent-steps', open && 'agent-steps--open')}>
      <button
        type="button"
        className="agent-step-line agent-steps-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {following && newest.running ? (
          <span className="live-dot live-dot--moving" aria-hidden="true" />
        ) : (
          <Icon name="chevrons" size={12} className="agent-step-icon" />
        )}
        <span className="agent-step-label">{steps.length} steps</span>
        {errors.length > 0 && <span className="agent-steps-failed">· {errors.length} failed</span>}
        {following && !open && (
          <span className="agent-step-summary">
            {[newest.label, newest.summary].filter(Boolean).join(' · ')}
          </span>
        )}
      </button>
      {open ? (
        <div className="agent-steps-list">
          {steps.map((step) => (
            <StepLine key={step.key} step={step} />
          ))}
        </div>
      ) : (
        errors.map((step) => <StepLine key={step.key} step={step} />)
      )}
    </div>
  );
}

/** A person's line: who, when it stands, what they said, and the reply under it. */
export function Person({ line }: { line: PersonLine }) {
  return (
    <div className={cx('agent-person', line.asked && 'agent-person--asked')}>
      <p className="agent-person-head">
        <span className="agent-person-who">{line.who}</span>
        {line.note && <span className="faint"> · {line.note}</span>}
      </p>
      <p className="wrap">{line.body}</p>
      {line.reply && <p className="wrap agent-person-reply">↳ {line.reply}</p>}
    </div>
  );
}

const Entryline = memo(function Entryline({ entry, last }: { entry: Entry; last: boolean }) {
  switch (entry.type) {
    case 'divider':
      return (
        <p className={cx('agent-divider', entry.tone === 'error' && 'agent-divider--error')}>
          {entry.text}
        </p>
      );
    case 'message':
      return (
        <div className="agent-text">
          <MarkdownPieces source={entry.block.text} />
          <Cut count={entry.block.cut} />
        </div>
      );
    case 'person':
      return <Person line={entry.line} />;
    case 'steps':
      return <Steps entry={entry} last={last} />;
  }
});

/** The live visit's stream as a word, where its agent has said nothing yet or it is slow. */
const SAID: Record<EventStreamState, string> = {
  connecting: 'Starting…',
  stalled: 'The live view is slow to connect.',
  open: 'Starting…',
  retrying: 'Reconnecting…',
  ended: '',
  refused: 'The live view isn’t available.',
};

/** One visit as the conversation reads it: its divider, then what it said. */
export interface ConversationVisit {
  sessionId: string;
  /** When it began, which places the people's lines among the visits. */
  at: string;
  /** The visit's line, e.g. 'Visit 2 · resumed · 48m'. */
  divider: string;
  /** A launch that failed. */
  tone?: 'error';
  /** What Sessions kept of a visit that has ended. */
  events?: AgentStreamEvent[];
  /** The live stream of the visit that holds its lease; at most one visit has one. */
  stream?: string;
}

/**
 * A thread's conversation across its visits, oldest first, with the people's lines among them.
 * It follows the newest line while the reader is at the foot of it; scrolled up, it holds still
 * and offers the way back down. The newest entries are drawn, a window of them, and earlier
 * ones a press away. The caller remounts it when another visit goes live, so one stream's
 * blocks never stand under another.
 */
export function AgentConversation({
  label,
  visits,
  people = [],
  empty = 'Nothing said yet.',
}: {
  label: string;
  visits: ConversationVisit[];
  people?: readonly PersonLine[];
  /** What it says where there is nothing at all. */
  empty?: string;
}) {
  const streamed = visits.find((visit) => visit.stream);
  const { timeline: live, state, retry } = useAgentStream(streamed?.stream ?? null);
  const kept = useMemo(
    () => visits.map((visit) => mergeEvents(NO_TIMELINE, visit.events ?? []).blocks),
    [visits],
  );
  const entries = useMemo(
    () =>
      timeline(
        visits.map((visit, at): VisitBlocks => ({
          key: visit.sessionId,
          at: visit.at,
          divider: visit.divider,
          tone: visit.tone,
          blocks: visit === streamed ? live.blocks : kept[at]!,
          live: visit === streamed,
        })),
        people,
      ),
    [visits, streamed, live, kept, people],
  );
  const [shown, setShown] = useState(WINDOW);
  const [bottom, setBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const from = Math.max(0, entries.length - shown);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (bottom && element) element.scrollTop = element.scrollHeight;
  }, [entries, bottom, state]);
  const toFoot = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setBottom(true);
  };
  const quiet = !!streamed && !live.blocks.length && SAID[state];
  const trouble =
    !!streamed && live.blocks.length > 0 && ['stalled', 'retrying', 'refused'].includes(state);
  const shownEntries = entries.slice(from);
  return (
    <div className="agent-frame">
      <div
        className="agent-timeline"
        ref={scroller}
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
        }}
      >
        {from > 0 && (
          <button
            type="button"
            className="btn-text agent-earlier"
            onClick={() => setShown(shown + WINDOW)}
          >
            Show earlier · {from.toLocaleString('en-US')} more
          </button>
        )}
        <ol className="agent-blocks">
          {shownEntries.map((entry, at) => (
            <li key={entry.key}>
              <Entryline entry={entry} last={at === shownEntries.length - 1} />
            </li>
          ))}
        </ol>
        {!streamed && entries.every((entry) => entry.type === 'divider') && (
          <p className="muted agent-quiet">{empty}</p>
        )}
        {(quiet || trouble) && (
          <p className="agent-quiet agent-live-state" role="status">
            {(state === 'connecting' || state === 'open') && (
              <span className="live-dot live-dot--moving" aria-hidden="true" />
            )}
            <span>{SAID[state]}</span>
            {(state === 'stalled' || state === 'refused') && (
              <button type="button" className="btn-text" onClick={retry}>
                Retry
              </button>
            )}
          </p>
        )}
      </div>
      {!bottom && (
        <button type="button" className="agent-jump" onClick={toFoot}>
          Jump to latest
        </button>
      )}
    </div>
  );
}

/** A card's glance at its live agent: its last lines, drawn as the thread draws them. */
export function AgentTail({ lines }: { lines: readonly TailLine[] }) {
  return (
    <ol className="agent-tail" aria-label="Live" aria-live="off">
      {lines.length ? (
        lines.map((line) => (
          <li key={line.key} className={`agent-tail--${line.kind}`}>
            {line.text}
          </li>
        ))
      ) : (
        <li className="agent-tail--starting">Starting…</li>
      )}
    </ol>
  );
}
