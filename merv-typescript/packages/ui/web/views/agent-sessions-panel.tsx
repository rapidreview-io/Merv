import { useEffect, useRef, useState } from 'react';
import type { AgentObservation as Observation, AgentSummary } from '@merv/contracts/types';
import { accountRequest, scopeVersion } from '../api';
import { Ago, KV, Live, StatusPill, relativeTime, stamp, useNow, words } from '../components';
import { clock, holding, leaseLiveness, type Clock } from '../liveness';

/** The same lease, as the agent's own observation sends it. */
type Assignment = Observation['assignments'][number];
const count = (value: number) => value.toLocaleString();
const duration = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const activity = (agent: AgentSummary) =>
  agent.status === 'retired' ? 'retired' : agent.currentExecutionId ? 'assigned' : 'unassigned';

function AssignmentDetails({ assignment, now }: { assignment: Assignment; now: Clock }) {
  return (
    <div className="stack agent-assignment">
      <div className="cluster cluster--between">
        <strong>{assignment.label}</strong>
        <Live of={leaseLiveness(assignment, now)} />
      </div>
      <p className="muted agent-help">
        {assignment.role} · {assignment.workflow.name} / {words(assignment.workflow.state)}
      </p>
      <details>
        <summary>Assignment details and permitted tools</summary>
        <div className="stack">
          <KV
            rows={[
              ['Revision', assignment.revision],
              ['Joined assignment', stamp(assignment.createdAt)],
              [
                holding(assignment, now) ? 'Lease expires' : 'Lease ran to',
                stamp(assignment.expiresAt),
              ],
              !!assignment.closedAt && ['Closed', stamp(assignment.closedAt)],
              !!(assignment.outcome || assignment.closeReason) && [
                'Outcome',
                words(assignment.outcome ?? assignment.closeReason ?? ''),
              ],
            ]}
          />
          <strong>Permitted tools · {assignment.tools.length}</strong>
          {assignment.tools.length ? (
            <ul className="agent-tool-list">
              {assignment.tools.map((tool) => (
                <li key={tool}>
                  <code>{tool}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No tools permitted.</p>
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
      <section className="stack">
        <h3>Current assignment</h3>
        {current ? (
          <AssignmentDetails assignment={current} now={now} />
        ) : (
          <p className="muted">No live assignment.</p>
        )}
      </section>
      <section className="stack">
        <h3>Tool activity</h3>
        <div className="cluster" role="group" aria-label="Tool activity scope">
          <button
            className={`btn btn--sm${callScope === 'current' ? ' btn--primary' : ''}`}
            aria-pressed={callScope === 'current'}
            disabled={!current}
            onClick={() => setRequestedScope('current')}
          >
            Current assignment · {currentCalls.length} shown
          </button>
          <button
            className={`btn btn--sm${callScope === 'all' ? ' btn--primary' : ''}`}
            aria-pressed={callScope === 'all'}
            onClick={() => setRequestedScope('all')}
          >
            All history · {count(observation.toolCallTotal)} total
          </button>
        </div>
        <div className="agent-token-stats">
          <div>
            <strong>{count(calls.length)}</strong>
            <span>Calls shown</span>
          </div>
          <div>
            <strong>≈ {count(displayed.input)}</strong>
            <span>Input tokens shown</span>
          </div>
          <div>
            <strong>≈ {count(displayed.output)}</strong>
            <span>Output tokens shown</span>
          </div>
        </div>
        {truncated && (
          <p className="muted agent-help">
            {calls.length} of {count(observation.toolCallTotal)} calls
          </p>
        )}
        {calls.length === 0 ? (
          <p className="muted">
            {callScope === 'current'
              ? 'No calls for this assignment in the returned activity.'
              : 'No tool calls recorded yet.'}
          </p>
        ) : (
          <ol
            className="agent-call-list"
            aria-label={
              callScope === 'current' ? 'Current assignment tool calls' : 'Tool-call history'
            }
          >
            {calls.map((call) => (
              <li key={call.id} className="agent-call stack">
                <div className="cluster cluster--between">
                  <code>{call.tool}</code>
                  <StatusPill value={call.status} />
                </div>
                {callScope === 'all' && (
                  <p className="muted agent-help">
                    {assignments.get(call.executionId)?.label ??
                      'Assignment outside the loaded history'}
                  </p>
                )}
                <div className="cluster muted agent-help">
                  <time dateTime={call.startedAt} title={call.startedAt}>
                    {new Date(call.startedAt).toLocaleTimeString()} · {relativeTime(call.startedAt)}
                  </time>
                  <span>
                    · {duration(call.durationMs)}
                    {call.status === 'running' ? ' · in progress' : ''}
                  </span>
                </div>
                <div className="cluster agent-help">
                  <span>Input ≈ {count(call.inputTokens)}</span>
                  <span>
                    Output {call.outputTokens === null ? '—' : `≈ ${count(call.outputTokens)}`}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        <details>
          <summary>Lifetime totals · {count(stats.totalCalls)} calls</summary>
          <div className="stack">
            <KV
              rows={[
                ['Lifetime calls', count(stats.totalCalls)],
                ['Completed calls', count(stats.completedCalls)],
                ['Lifetime input estimate', `≈ ${count(stats.inputTokens)} tokens`],
                ['Lifetime output estimate', `≈ ${count(stats.outputTokens)} tokens`],
              ]}
            />
          </div>
        </details>
      </section>
      <details>
        <summary>Agent identity</summary>
        <KV
          rows={[
            ['Runner', observation.agent.runnerId],
            ['Joined', stamp(observation.agent.createdAt)],
            ['Context epoch', observation.agent.contextEpoch],
          ]}
        />
      </details>
      <section className="stack">
        <h3>Past assignments · {history.length}</h3>
        {history.length ? (
          history.map((assignment) => (
            <details className="agent-history" key={assignment.id}>
              <summary>
                {assignment.label} · {words(assignment.status)}
              </summary>
              <AssignmentDetails assignment={assignment} now={now} />
            </details>
          ))
        ) : (
          <p className="muted">No previous assignments.</p>
        )}
      </section>
    </>
  );
}

/**
 * What one agent is doing, read beside the list that named it. The row that opened
 * it holds the way back: Escape and the close control both return the cursor there.
 */
export function AgentDetail({ agent, close }: { agent: AgentSummary; close(): void }) {
  const [observation, setObservation] = useState<Observation>();
  const [loadedAt, setLoadedAt] = useState<string>();
  const [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = agent.id;
  // The panel reads its own payload, so it keeps its own clock: durations are
  // measured from when this observation arrived, and a verdict stops short of
  // what that read did not see.
  const now = clock(undefined, loadedAt, useNow(1000), 12_000);
  useEffect(() => {
    setObservation(undefined);
    setError(undefined);
    heading.current?.focus();
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
  return (
    <section
      id="agent-detail"
      className="stack stack--lg agent-detail"
      aria-labelledby="agent-detail-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="cluster cluster--between agent-detail-heading">
        <div>
          <p className="label">Agent details</p>
          <h2 id="agent-detail-title" ref={heading} tabIndex={-1}>
            {agent.name}
          </h2>
        </div>
        <button className="btn btn--sm" aria-label="Close agent details" onClick={close}>
          Close ×
        </button>
      </div>
      {observation?.agent.id === selected ? (
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
        <p role="status" className="muted">
          Loading agent activity…
        </p>
      )}
    </section>
  );
}
