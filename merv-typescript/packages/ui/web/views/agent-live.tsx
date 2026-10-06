import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { AgentStreamSession } from '@merv/contracts/agent-stream';
import { useAgentStream, type AgentBlock, type AgentStreamState } from '../agent-stream';
import { CodeBlock } from '../code-block';
import { Ago, Summary, cx, words } from '../components';
import { JsonView, readJson } from '../json-view';
import { MarkdownPieces } from '../markdown';

/**
 * What a unit's agent is doing, live, in its sidebar on the Work page (operators only; the
 * panel's `agent` section says which sessions there are). One session is read at a time: the
 * live one, or the newest, until another is chosen. Its stream is drawn as a person reads a
 * conversation: what it says, its thinking folded to one line, each tool it calls with what
 * the tool answered, and the session's own milestones as quiet dividers.
 */

/** How many blocks are drawn at a time; the rest are a press away. */
const WINDOW = 300;
/** Output longer than this opens folded. */
const LONG_LINES = 12;
const LONG_CHARS = 1500;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A session as its chip names it: the responsibility it holds, in the workflow's words. */
export const sessionLabel = (session: Pick<AgentStreamSession, 'role' | 'state'>) =>
  `${capital(words(session.role))} · ${words(session.state)}`;

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

/** What the tool answered: a terminal's text, folded where it is long. */
function Output({
  result,
}: {
  result: NonNullable<Extract<AgentBlock, { kind: 'tool' }>['result']>;
}) {
  const [open, setOpen] = useState(false);
  const lines = result.output.split('\n').length;
  const label = result.error ? 'Error' : 'Output';
  const block = <CodeBlock code={result.output} label={label} />;
  if (!result.output) return null;
  if (lines <= LONG_LINES && result.output.length <= LONG_CHARS)
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

/**
 * One session's stream. It follows the newest block while the reader is at the foot of it;
 * scrolled up, it holds still and offers the way back down. The newest blocks are drawn, a
 * window of them, and earlier ones a press away.
 */
function Timeline({ session }: { session: AgentStreamSession }) {
  const { timeline, state } = useAgentStream(session.events);
  const [shown, setShown] = useState(WINDOW);
  const [bottom, setBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const { blocks } = timeline;
  const from = Math.max(0, blocks.length - shown);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (bottom && element) element.scrollTop = element.scrollHeight;
  }, [timeline, bottom]);
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
        aria-label={`${sessionLabel(session)}, live`}
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
        {blocks.length ? (
          <ol className="agent-blocks">
            {blocks.slice(from).map((block) => (
              <li key={block.key}>
                <Block block={block} live={session.live} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted agent-quiet">{SAID[state]}</p>
        )}
      </div>
      {!bottom && (
        <button type="button" className="agent-jump" onClick={toFoot}>
          Jump to latest
        </button>
      )}
      {blocks.length > 0 && (state === 'retrying' || state === 'refused') && (
        <p className="muted agent-quiet" role="status">
          {SAID[state]}
        </p>
      )}
    </div>
  );
}

/** The sessions of a unit, newest first, and the live stream of the one chosen. */
export function AgentLive({ sessions }: { sessions: AgentStreamSession[] }) {
  const [chosen, setChosen] = useState<string>();
  const session =
    sessions.find((item) => item.sessionId === chosen) ??
    sessions.find((item) => item.live) ??
    sessions[0]!;
  const earlier = (id: string) => sessions.find((item) => item.sessionId === id);
  const chip = (item: AgentStreamSession) => (
    <>
      {item.live && <span className="live-dot live-dot--live" aria-label="Live" role="img" />}
      <span>{sessionLabel(item)}</span>
      {item.continues && (
        <span className="faint">
          continues{' '}
          {earlier(item.continues) ? sessionLabel(earlier(item.continues)!) : 'an earlier session'}
        </span>
      )}
      <span className="faint">
        {item.live || !item.endedAt ? 'started ' : 'ended '}
        <Ago at={item.live ? item.startedAt : (item.endedAt ?? item.startedAt)} />
      </span>
    </>
  );
  return (
    <div className="agent-live">
      {sessions.length > 1 ? (
        <div className="agent-chips" role="group" aria-label="Sessions">
          {sessions.map((item) => (
            <button
              type="button"
              key={item.sessionId}
              className="agent-chip"
              aria-pressed={item.sessionId === session.sessionId}
              onClick={() => setChosen(item.sessionId)}
            >
              {chip(item)}
            </button>
          ))}
        </div>
      ) : (
        <p className="agent-chips agent-chip">{chip(session)}</p>
      )}
      <Timeline key={session.sessionId} session={session} />
    </div>
  );
}
