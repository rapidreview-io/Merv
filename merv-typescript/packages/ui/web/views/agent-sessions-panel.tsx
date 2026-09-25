import type { AgentSummary, AgentObservation as Observation } from '@merv/contracts/types';
import { useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion } from '../api';
import {
  Ago,
  KV,
  KindLabel,
  Live,
  LoadState,
  Stamp,
  StatusPill,
  Summary,
  useNow,
  words,
} from '../components';
import { CloseIcon } from '../icons';
import { Segments } from '../list-filters';
import { clock, holding, leaseLiveness, type Clock } from '../liveness';

/** The same lease, as the agent's own observation sends it. */
type Assignment = Observation['assignments'][number];
const count = (value: number) => value.toLocaleString();
const duration = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const activity = (agent: AgentSummary) =>
  agent.status === 'retired' ? 'retired' : agent.currentExecutionId ? 'assigned' : 'unassigned';
/**
 * A lease is labelled for the agent that takes it up — `Work: …`, `Review: …`, or
 * the recipe it runs — and the role beside it already says which. What is left is
 * the record's own name, which is the only part a person reads it for.
 */
const PURPOSE = /^(?:Work|Review|experiment\.\w+):\s+/;
/**
 * A reflection's lens is named by the server as the wave and then the lens's own enum
 * word — `After the first sweep: next_steps` — which the reflection page writes as
 * words. Only that closing word is rewritten: an underscore inside a name is its author's.
 */
const LENS = /: ([a-z]+(?:_[a-z]+)+)$/;
export const workName = (label: string) =>
  label.replace(PURPOSE, '').replace(LENS, (_, lens: string) => `: ${lens.replaceAll('_', ' ')}`);
/** The view kind a workflow's records are drawn as, where this build draws them. */
const KIND_OF: Record<string, string> = {
  task: 'tasks',
  experiment: 'experiments',
  research: 'research',
  reflection: 'reflections',
};

function AssignmentDetails({ assignment, now }: { assignment: Assignment; now: Clock }) {
  return (
    <div className="stack">
      <div className="cluster cluster--between">
        <strong>{workName(assignment.label)}</strong>
        <Live of={leaseLiveness(assignment, now)} />
      </div>
      {/* The role it holds, then the record's kind and how it stands, as a row says them. */}
      <p className="cluster agent-help">
        <span className="muted">{words(assignment.role)}</span>
        <KindLabel kind={KIND_OF[assignment.workflow.name]} />
        <StatusPill value={assignment.workflow.state} />
      </p>
      <details>
        <Summary>Details</Summary>
        <div className="stack">
          <KV
            rows={[
              ['Joined', <Stamp at={assignment.createdAt} />],
              [
                holding(assignment, now) ? 'Lease expires' : 'Lease ran to',
                <Stamp at={assignment.expiresAt} />,
              ],
              !!assignment.closedAt && ['Closed', <Stamp at={assignment.closedAt} />],
              !!(assignment.outcome || assignment.closeReason) && [
                'Outcome',
                words(assignment.outcome ?? assignment.closeReason ?? ''),
              ],
            ]}
          />
          <span className="label">
            Tools <span className="section-n">{assignment.tools.length}</span>
          </span>
          {assignment.tools.length > 0 && (
            <ul className="agent-tool-list">
              {assignment.tools.map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

function AgentObservation({ observation, now }: { observation: Observation; now: Clock }) {
  const current = observation.assignments.find(
    (assignment) => assignment.id === observation.agent.currentExecutionId,
  );
  const [requestedScope, setRequestedScope] = useState<'current' | 'all'>(
    current ? 'current' : 'all',
  );
  const callScope = current ? requestedScope : 'all';
  const currentCalls = observation.toolCalls.filter((call) => call.executionId === current?.id);
  const calls = callScope === 'current' ? currentCalls : observation.toolCalls;
  const displayed = calls.reduce(
    (totals, call) => ({
      input: totals.input + call.inputTokens,
      output: totals.output + (call.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const history = observation.assignments
    .filter((assignment) => assignment.id !== current?.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const assignments = new Map(
    observation.assignments.map((assignment) => [assignment.id, assignment]),
  );
  const stats = observation.tokenStats;
  const truncated = observation.toolCallTotal > observation.toolCalls.length;
  return (
    <>
      {/* An agent on nothing has no assignment to show: the section is not drawn. */}
      {current && (
        <section className="stack">
          <h3>Assignment</h3>
          <AssignmentDetails assignment={current} now={now} />
        </section>
      )}
      <section className="stack">
        <h3>
          Tool activity {/* What this read returned, against everything the agent ever called. */}
          <span className="section-n">
            {truncated && callScope === 'all'
              ? `${count(calls.length)} of ${count(observation.toolCallTotal)}`
              : count(calls.length)}
          </span>
        </h3>
        {/* With no live assignment there is one reading, and a switch of one says nothing. */}
        {current && (
          <div>
            <Segments<'current' | 'all'>
              label="Tool activity scope"
              options={[
                { value: 'current', label: 'This assignment', count: count(currentCalls.length) },
                { value: 'all', label: 'All', count: count(observation.toolCallTotal) },
              ]}
              value={callScope}
              onChange={setRequestedScope}
            />
          </div>
        )}
        <div className="agent-token-stats">
          <div>
            <strong>≈ {count(displayed.input)}</strong>
            <span>Input tokens</span>
          </div>
          <div>
            <strong>≈ {count(displayed.output)}</strong>
            <span>Output tokens</span>
          </div>
        </div>
        {calls.length > 0 && (
          <ol
            className="agent-call-list"
            aria-label={
              callScope === 'current' ? 'Current assignment tool calls' : 'Tool-call history'
            }
          >
            {calls.map((call) => {
              const under = callScope === 'all' && assignments.get(call.executionId)?.label;
              return (
                <li key={call.id} className="agent-call stack">
                  <div className="cluster cluster--between">
                    <code>{call.tool}</code>
                    <StatusPill value={call.status} />
                  </div>
                  {under && <p className="muted agent-help">{workName(under)}</p>}
                  <div className="cluster muted agent-help">
                    <Ago at={call.startedAt} />
                    <span>{duration(call.durationMs)}</span>
                  </div>
                  <div className="cluster agent-help">
                    <span>Input ≈ {count(call.inputTokens)}</span>
                    <span>
                      Output {call.outputTokens === null ? '—' : `≈ ${count(call.outputTokens)}`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <details>
          <Summary>Lifetime · {count(stats.totalCalls)} calls</Summary>
          <div className="stack">
            <KV
              rows={[
                ['Calls', count(stats.totalCalls)],
                ['Completed', count(stats.completedCalls)],
                ['Input tokens', `≈ ${count(stats.inputTokens)}`],
                ['Output tokens', `≈ ${count(stats.outputTokens)}`],
              ]}
            />
          </div>
        </details>
      </section>
      <section className="stack">
        <h3>
          Past assignments <span className="section-n">{history.length}</span>
        </h3>
        {history.map((assignment) => (
          <details className="agent-history" key={assignment.id}>
            <Summary>
              {workName(assignment.label)} · {words(assignment.status)}
            </Summary>
            <AssignmentDetails assignment={assignment} now={now} />
          </details>
        ))}
      </section>
      <section className="stack">
        <h3>Details</h3>
        <KV
          rows={[
            ['Joined', <Stamp at={observation.agent.createdAt} />],
            ['Context epoch', observation.agent.contextEpoch],
          ]}
        />
      </section>
    </>
  );
}

/**
 * What one agent is doing, read under the list that named it. The list may be most
 * of a window tall, so choosing an agent brings the panel's head to the top of the
 * view and puts the cursor on its name; nothing animates, so there is no motion to
 * reduce. The row that opened it holds the way back: Escape and the close control
 * both return the cursor there.
 */
export function AgentDetail({ agent, close }: { agent: AgentSummary; close(): void }) {
  const [observation, setObservation] = useState<Observation>();
  const [loadedAt, setLoadedAt] = useState<string>();
  const [error, setError] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = agent.id;
  // The panel reads its own payload, so it keeps its own clock: durations are
  // measured from when this observation arrived, and a verdict stops short of
  // what that read did not see.
  const now = clock(undefined, loadedAt, useNow(1000), 12_000);
  useEffect(() => {
    setObservation(undefined);
    setError(undefined);
    heading.current?.focus({ preventScroll: true });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let waiting = false;
    const version = scopeVersion();
    const live = () => !cancelled && version === scopeVersion();
    const hidden = () => document.visibilityState === 'hidden';
    const refresh = async () => {
      try {
        const result = await accountRequest<Observation>(
          `/sessions/agents/${encodeURIComponent(selected)}/observation`,
          { scoped: true },
        );
        if (live()) {
          setObservation(result);
          setLoadedAt(new Date().toISOString());
          setError(undefined);
        }
      } catch (failure) {
        // A failed poll degrades to one line beside the activity that is still
        // correct; it never wipes what the last good read returned.
        if (live())
          setError(failure instanceof Error ? failure.message : 'Could not load agent activity.');
      } finally {
        if (live()) {
          if (hidden()) waiting = true;
          else timer = setTimeout(() => void refresh(), 4000);
        }
      }
    };
    const resume = () => {
      if (!waiting || hidden()) return;
      waiting = false;
      void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [selected]);
  // A page cannot scroll past its own foot, and until its read lands the panel is one
  // line tall: its head is brought up as it opens, and again once it has its height.
  const loaded = observation?.agent.id === selected;
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'start' });
  }, [selected, loaded]);
  return (
    <section
      id="agent-detail"
      ref={panel}
      className="stack stack--lg agent-detail"
      aria-labelledby="agent-detail-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="cluster cluster--between">
        <div>
          <KindLabel kind="sessions" />
          <h2 id="agent-detail-title" ref={heading} tabIndex={-1}>
            {agent.name}
          </h2>
        </div>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close agent details"
          title="Close"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>
      {loaded && observation ? (
        <>
          {error && (
            <p className="muted agent-help" role="status" title={error}>
              Could not refresh. Showing the state that loaded{' '}
              {loadedAt ? <Ago at={loadedAt} /> : 'last'}.
            </p>
          )}
          <AgentObservation key={observation.agent.id} observation={observation} now={now} />
        </>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        <LoadState loading />
      )}
    </section>
  );
}
