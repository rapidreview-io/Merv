import { useEffect, useRef, useState } from 'react';
import { accountRequest, scopeVersion } from '../api';
import { KV, StatusPill, relativeTime, stamp, words } from '../components';

export interface AgentSummary {
  id: string;
  sessionId: string;
  actorId: string;
  name: string;
  status: string;
  contextEpoch: number;
  persistent: boolean;
  currentExecutionId: string | null;
  currentAssignment: { label: string; role: string } | null;
  createdAt: string;
  runnerId: string;
}
interface Assignment {
  id: string;
  instanceId: string;
  label: string;
  role: string;
  status: string;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  outcome?: string | null;
  workflow: { name: string; state: string };
  revision: number;
  tools: string[];
}
interface ToolCall {
  id: string;
  executionId: string;
  tool: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number | null;
}
interface Observation {
  agent: AgentSummary;
  assignments: Assignment[];
  toolCalls: ToolCall[];
  toolCallTotal: number;
  tokenStats: {
    inputTokens: number;
    outputTokens: number;
    completedCalls: number;
    totalCalls: number;
  };
  tokenAccounting: { kind: 'estimate'; method: string };
}
const count = (value: number) => value.toLocaleString();
const duration = (ms: number | null) =>
  ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const activity = (agent: AgentSummary) =>
  agent.status === 'retired' ? 'retired' : agent.currentExecutionId ? 'assigned' : 'unassigned';

function AssignmentDetails({ assignment }: { assignment: Assignment }) {
  return (
    <div className="stack agent-assignment">
      <div className="cluster cluster--between">
        <strong>{assignment.label}</strong>
        <StatusPill value={assignment.status} />
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
              ['Lease expires', stamp(assignment.expiresAt)],
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

function AgentObservation({ observation }: { observation: Observation }) {
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
          <AssignmentDetails assignment={current} />
        ) : (
          <p className="muted">
            No live assignment. This does not indicate whether the agent process is connected.
          </p>
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
        <p className="muted agent-help">
          {callScope === 'current'
            ? `Showing ${calls.length} calls for the current assignment from the returned activity.`
            : `Showing ${calls.length} of ${count(observation.toolCallTotal)} lifetime calls.`}{' '}
          {truncated &&
            `The server returned ${observation.toolCalls.length} calls; earlier calls may not be shown. `}
          In-flight calls first, then newest. Refreshes every 4 seconds.
        </p>
        <p className="muted agent-help">
          Token counts estimate the displayed tool payloads, not model usage or billing. Outputs
          include recorded results only.
        </p>
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
            <p className="muted agent-help">
              {observation.tokenAccounting.method} Output totals include recorded results only.
            </p>
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
                {assignment.label} · {assignment.status}
              </summary>
              <AssignmentDetails assignment={assignment} />
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
  const [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = agent.id;
  useEffect(() => {
    setObservation(undefined);
    setError(undefined);
    heading.current?.focus();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const version = scopeVersion();
    const refresh = async () => {
      try {
        const result = await accountRequest<Observation>(
          `/sessions/agents/${encodeURIComponent(selected)}/observation`,
          { scoped: true },
        );
        if (!cancelled && version === scopeVersion()) {
          setObservation(result);
          setError(undefined);
        }
      } catch (failure) {
        if (!cancelled && version === scopeVersion()) {
          setError(failure instanceof Error ? failure.message : 'Could not load agent activity.');
          setObservation(undefined);
        }
      } finally {
        if (!cancelled && version === scopeVersion())
          timer = setTimeout(() => void refresh(), 4000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
      {error ? (
        <p role="alert">{error}</p>
      ) : observation?.agent.id === selected ? (
        <AgentObservation key={observation.agent.id} observation={observation} />
      ) : (
        <p role="status" className="muted">
          Loading agent activity…
        </p>
      )}
    </section>
  );
}
