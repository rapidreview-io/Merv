import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentStreamEvent } from '@merv/sessions/agent-stream';
import {
  NO_TIMELINE,
  mergeEvents,
  useAgentStream,
  type AgentBlock,
  type AgentStreamState,
} from '../agent-stream';
import { CodeBlock } from '../code-block';
import { Summary, cx } from '../components';
import { JsonView, readJson } from '../json-view';
import { MarkdownPieces } from '../markdown';

/**
 * What a thread's agent said, visit by visit, in its dialog on the Work page (operators only,
 * as the stream itself is). It is drawn as a person reads a conversation: what it says, its
 * thinking folded to one line, each tool it calls with what the tool answered, and each
 * visit's start and the session's own milestones as quiet dividers. The visit that holds its
 * lease is read live; the others are what Sessions kept of them.
 */

/** How many blocks are drawn at a time; the rest are a press away. */
const WINDOW = 300;
/** Output longer than this opens folded. */
const LONG_LINES = 12;
const LONG_CHARS = 1500;

const Cut = ({ count }: { count: number }) =>
  count > 0 ? (
    <p className="agent-cut">… {count.toLocaleString('en-US')} characters not shown</p>
  ) : null;

/** Thinking, folded to its first line; opened, it is read as Markdown. */
function Thinking({ block }: { block: Extract<AgentBlock, { done: boolean }> }) {
  const [open, setOpen] = useState(false);
  const first = block.text.trim().split('\n', 1)[0] ?? '';
  return (
    <details className="agent-thinking" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <Summary>
        <span className="agent-thinking-word">{block.done ? 'Thought' : 'Thinking'}</span>
        <span className="agent-thinking-line">{first}</span>
      </Summary>
      {open && (
        <div className="agent-thinking-body">
          <MarkdownPieces source={block.text} />
          <Cut count={block.cut} />
        </div>
      )}
    </details>
  );
}

/** A tool's arguments: a tree where they are JSON, the text as it came where they are not. */
function Input({ input }: { input: string }) {
  const json = readJson(input);
  if (json && json.value && typeof json.value === 'object' && !Object.keys(json.value).length)
    return null;
  return json ? <JsonView value={json.value} /> : <CodeBlock code={input} label="Input" />;
}

/**
 * What the tool answered: a terminal's text, or JSON laid out two spaces deep where the
 * answer is a JSON object or list, folded where it is long.
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
  const output = json ?? result.output;
  const lines = output.split('\n').length;
  const label = result.error ? 'Error' : 'Output';
  const block = <CodeBlock code={output} label={label} />;
  if (!output) return null;
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

/** A call and its answer as one block; until the answer comes, the call is in flight. */
function Tool({ block, live }: { block: Extract<AgentBlock, { kind: 'tool' }>; live: boolean }) {
  const pending = !block.result && live;
  return (
    <div className="agent-tool">
      <p className="agent-tool-head">
        <span
          className={cx('live-dot', pending ? 'live-dot--moving' : 'agent-tool-dot')}
          aria-hidden="true"
        />
        <span className="mono agent-tool-name">{block.name ?? 'Tool'}</span>
        {pending && <span className="agent-tool-state">running</span>}
        {block.result?.error && <span className="agent-tool-state agent-tool-failed">failed</span>}
      </p>
      {block.input && <Input input={block.input} />}
      <Cut count={block.cut} />
      {block.result && <Output result={block.result} />}
    </div>
  );
}

/** One block, drawn again only when it changed: the timeline replaces just that object. */
const Block = memo(function Block({ block, live }: { block: AgentBlock; live: boolean }) {
  switch (block.kind) {
    case 'thinking':
      return <Thinking block={block} />;
    case 'text':
      return (
        <div className="agent-text">
          <MarkdownPieces source={block.text} />
          <Cut count={block.cut} />
        </div>
      );
    case 'tool':
      return <Tool block={block} live={live} />;
    case 'status':
      return <p className="agent-status">{block.text}</p>;
  }
});

const SAID: Record<AgentStreamState, string> = {
  connecting: 'Connecting…',
  open: 'Nothing yet.',
  retrying: 'Reconnecting…',
  ended: 'This session said nothing.',
  refused: 'This stream isn’t available.',
};

/** One visit as the conversation reads it: its divider, then what it said. */
export interface ConversationVisit {
  sessionId: string;
  /** The visit's line, e.g. 'Visit 2 · resumed · 12:41'. */
  divider: string;
  /** What Sessions kept of a visit that has ended. */
  events?: AgentStreamEvent[];
  /** The live stream of the visit that holds its lease; at most one visit has one. */
  stream?: string;
}
type Row = { key: string; divider?: string; block?: AgentBlock; live?: boolean };

/**
 * A thread's conversation across its visits, oldest first. It follows the newest block while
 * the reader is at the foot of it; scrolled up, it holds still and offers the way back down.
 * The newest blocks are drawn, a window of them, and earlier ones a press away. The caller
 * remounts it when another visit goes live, so one stream's blocks never stand under another.
 */
export function AgentConversation({
  label,
  visits,
}: {
  label: string;
  visits: ConversationVisit[];
}) {
  const streamed = visits.find((visit) => visit.stream);
  const { timeline: live, state } = useAgentStream(streamed?.stream ?? null);
  const kept = useMemo(
    () => visits.map((visit) => mergeEvents(NO_TIMELINE, visit.events ?? []).blocks),
    [visits],
  );
  const rows: Row[] = visits.flatMap((visit, at) => {
    const blocks = visit === streamed ? live.blocks : kept[at]!;
    return [
      { key: visit.sessionId, divider: visit.divider },
      ...blocks.map((block) => ({
        key: `${visit.sessionId}:${block.key}`,
        block,
        live: visit === streamed,
      })),
    ];
  });
  const said = rows.some((row) => row.block);
  const [shown, setShown] = useState(WINDOW);
  const [bottom, setBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const from = Math.max(0, rows.length - shown);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (bottom && element) element.scrollTop = element.scrollHeight;
  }, [live, kept, bottom]);
  const toFoot = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    setBottom(true);
  };
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
        {said ? (
          <ol className="agent-blocks">
            {rows.slice(from).map((row) => (
              <li key={row.key}>
                {row.block ? (
                  <Block block={row.block} live={!!row.live} />
                ) : (
                  <p className="agent-status agent-visit">{row.divider}</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted agent-quiet">
            {streamed ? SAID[state] : 'This thread said nothing.'}
          </p>
        )}
      </div>
      {!bottom && (
        <button type="button" className="agent-jump" onClick={toFoot}>
          Jump to latest
        </button>
      )}
      {said && streamed && (state === 'retrying' || state === 'refused') && (
        <p className="muted agent-quiet" role="status">
          {SAID[state]}
        </p>
      )}
    </div>
  );
}
