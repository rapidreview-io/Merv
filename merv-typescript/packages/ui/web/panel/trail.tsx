import { useState, useEffect, useRef, useLayoutEffect, memo } from 'react';
import { type Step, type Block } from './chat-events';
import { type ToolWindow } from './lazy-tool';
import { said, groupLabel } from './tool-words';
import { ToolGlyph } from './marks';
import { stableBlocks, useHeldScroll } from './scroll-hold';
import { whileBusy } from './desk-calls';
import { Prose } from './prose';
import { CommandOutput } from './command-output';

/** Seconds since the step under way began, counted while it runs. */
function Elapsed() {
  const [since] = useState(Date.now);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - since) / 1000);
  return <span className="trail-time">{span(seconds)}</span>;
}
const span = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
/** A finished run in a glance: how many steps it was and how long they took. */
function summary(steps: Step[]) {
  const from = Math.min(...steps.map((step) => step.at ?? Infinity)),
    to = Math.max(...steps.map((step) => step.ended ?? -Infinity));
  const seconds = Math.round((to - from) / 1000);
  return `${steps.length} steps${seconds >= 1 && Number.isFinite(seconds) ? ` · ${span(seconds)}` : ''}`;
}

type ToolLoader = {
  load?(step: Step): Promise<Step>;
  release?(item: string): void;
  output?(item: string): string | undefined;
  current?(item: string): Step | undefined;
  history?(item: string): ToolWindow | undefined;
  page?(item: string, direction: 'before' | 'after'): Promise<void>;
};
/** `provider` colours the dots of a run under way; without `load` (far from the Mac) a step has no more to open than it says. */
export const Trail = memo(function Trail({
  steps: all_,
  live,
  waiting,
  blockId,
  provider,
  load,
  release,
  output,
  current: currentTool,
  history,
  page,
}: {
  steps: Step[];
  live: boolean;
  /** The run stands still until the person answers what it asked: nothing is under way, and nothing is timed. */
  waiting?: boolean;
  blockId?: string;
  provider?: 'claude' | 'codex';
} & ToolLoader) {
  const [picked, setPicked] = useState<string>();
  const [all, setAll] = useState(false);
  // Thinking is a moment, not a record: only while it is the last thing under way.
  const steps = all_.filter(
    (step, i) => step.kind !== 'think' || (live && i === all_.length - 1 && !step.done),
  );
  if (!steps.length) return null;
  const groups: Step[][] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (
      last &&
      !step.agent &&
      !last[0]!.agent &&
      last[0]!.kind === step.kind &&
      step.kind !== 'tool' &&
      (step.kind !== 'run' || said(step) === said(last[0]!))
    )
      last.push(step);
    else groups.push([step]);
  }
  const current = steps.at(-1)!;
  const active = live && !current.done;
  const line = (group: Step[], i: number) => {
    const expanded = group.some((step) => step.item === picked);
    const failed = group.some((s) => s.failed);
    // Each step opens to what it printed or answered: a command's output, an edit's diff, a tool's
    // answer. One loaded on demand (`deferred`) opens where it matters most: a failure or an edit.
    const details = group.filter(
      (s) =>
        !s.agent &&
        ((s.kind === 'run' && !!(load || s.detail)) ||
          !!s.detail ||
          (s.deferred && (failed || s.kind === 'edit'))),
    );
    const running = group.find((s) => live && !s.done && s.kind === 'run');
    const lastLine = running?.detail
      ?.trimEnd()
      .split(/[\r\n]/)
      .at(-1);
    return (
      <div key={expanded ? picked : group[0]!.item}>
        <button
          data-scroll-anchor={`tool:${group[0]!.item}`}
          className={`step ${failed ? 'is-failed' : ''} ${active && group.includes(current) ? 'is-active' : ''}`}
          onClick={() => setPicked(expanded ? undefined : group[0]!.item)}
          aria-expanded={expanded}
        >
          <ToolGlyph kind={group[0]!.kind} />
          <span className="step-title">{groupLabel(group, live)}</span>
          {lastLine && <span className="command-last-line">{lastLine}</span>}
        </button>
        {group.map(
          (s) =>
            s.agent && (
              <AgentTrail
                key={s.item}
                step={s}
                live={live}
                load={load}
                release={release}
                output={output}
                current={currentTool}
                history={history}
                page={page}
              />
            ),
        )}
        {expanded &&
          details.map((s) => (
            <ToolDetail
              key={s.item}
              step={s}
              live={live}
              load={load}
              release={release}
              output={output}
              current={currentTool}
              history={history}
              page={page}
            />
          ))}
      </div>
    );
  };
  // One line for the run, as the latest step says it; open, every step under it.
  return (
    <div className="trail" data-block-id={blockId}>
      <button
        className={`trail-more ${live ? 'is-active' : ''}`}
        aria-expanded={all}
        onClick={() => setAll(!all)}
      >
        {/* Between two steps the agent is still at it: the dots stay for as long as the turn does. */}
        {live && (
          <span
            className={`trail-live${provider ? ` is-${provider}` : ''}${waiting ? ' is-waiting' : ''}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="trail-label">
          {live && waiting ? 'Waiting for you' : groupLabel(groups.at(-1)!, live)}
        </span>
        {active && !waiting && <Elapsed />}
        {!live && steps.length > 1 && <span className="trail-sum">{summary(steps)}</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M3 2l3 3-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {all && <div className="trail-steps">{groups.map(line)}</div>}
    </div>
  );
});

/** Bodies and child transcripts enter the DOM only after the person opens them. */
function ToolDetail({
  step,
  live,
  load,
  release,
  output,
  current,
  history,
  page,
}: { step: Step; live: boolean } & ToolLoader) {
  const [loaded, setLoaded] = useState<Step>();
  const [error, setError] = useState('');
  const [paging, setPaging] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  // The reader's place is read as the new page renders: they may scroll while it is on its way.
  const held = useHeldScroll(() => host.current?.closest<HTMLElement>('.lines'));
  const window = history?.(step.item);
  useLayoutEffect(() => {
    held.restore();
  }, [window?.rows]);
  useEffect(() => {
    if (!load) return;
    let gone = false;
    void load(step).then(
      (value) => {
        if (!gone) setLoaded(value);
      },
      (caught) => {
        if (!gone) setError(caught.message);
      },
    );
    return () => {
      gone = true;
      release?.(step.item);
    };
  }, [step.item, load, release]);
  const latest = current?.(step.item) ?? loaded ?? step;
  const done = latest.done || loaded?.done;
  const detail = done
    ? (latest.detail ?? loaded?.detail ?? '')
    : (output?.(step.item) ?? latest.detail ?? loaded?.detail ?? '');
  // The scoped window is authoritative. Merging its first snapshot back in would
  // silently undo eviction and render every visited page again.
  const agent = latest.agent;
  const blocks = useRef<Block[]>([]);
  blocks.current = stableBlocks(blocks.current, agent?.blocks ?? []);
  const turnPage = async (direction: 'before' | 'after') => {
    if (!page || paging) return;
    held.hold();
    await whileBusy(setPaging, setError, async () => {
      await page(step.item, direction);
    });
  };
  if (error) return <p className="error-line">{error}</p>;
  if (agent)
    return (
      <div className="agent-history" ref={host}>
        {window?.before !== undefined && (
          <button className="history" disabled={paging} onClick={() => void turnPage('before')}>
            Older history
          </button>
        )}
        {blocks.current.map((block) =>
          block.type === 'trail' ? (
            <Trail
              key={block.key}
              blockId={block.key}
              steps={block.steps}
              live={live && !done}
              load={load}
              release={release}
              output={output}
              current={current}
              history={history}
              page={page}
            />
          ) : block.type === 'agent' || block.type === 'job' ? null : (
            <div
              key={block.key}
              data-scroll-anchor={`agent:${step.item}:${block.key}`}
              className="agent-words"
            >
              <Prose text={block.text} />
            </div>
          ),
        )}
        {window?.after !== undefined && (
          <button className="history" disabled={paging} onClick={() => void turnPage('after')}>
            Newer history
          </button>
        )}
      </div>
    );
  return step.kind === 'run' ? (
    <CommandOutput
      text={detail}
      running={live && !done}
      exitCode={latest.exitCode ?? loaded?.exitCode}
    />
  ) : (
    <pre className="step-detail">{detail}</pre>
  );
}

/** A child's words and steps stay under the task that started it. */
function AgentTrail({
  step,
  live,
  load,
  release,
  output,
  current,
  history,
  page,
}: { step: Step; live: boolean } & ToolLoader) {
  const [open, setOpen] = useState(false);
  const count = step.agent!.blocks.reduce(
    (n, block) => n + (block.type === 'trail' ? block.steps.length : 0),
    0,
  );
  return (
    <details className="agent-trail" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Agent: {step.title}
        {count ? ` · ${count} ${count === 1 ? 'step' : 'steps'}` : ''}
      </summary>
      {open && (
        <ToolDetail
          step={step}
          live={live}
          load={load}
          release={release}
          output={output}
          current={current}
          history={history}
          page={page}
        />
      )}
    </details>
  );
}
