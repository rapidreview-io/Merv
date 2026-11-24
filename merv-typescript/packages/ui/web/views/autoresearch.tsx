import type { AutoresearchStatus } from '@merv/autoresearch/models';
import { permits } from '@merv/scope/rules';
import { useState } from 'react';
import { useTool } from '../api';
import { KV, LoadState, PageHeader, Part, StatusPill } from '../components';
import { useCommand } from '../mutations';
import { useSession } from '../session';
import type { ViewProps } from './index';

const usd = (value: number | null) => (value === null ? 'unknown' : `$${value.toFixed(2)}`);
const PAUSED: Record<string, string> = {
  person: 'Paused by a person',
  cap: 'Paused at the spend cap: raise the cap, or end the round',
  wake_limit: 'Paused after its automatic wakes in a row: resume, or write to the manager',
};
const STATE: Record<string, string> = {
  managing: 'Manager at work',
  waiting: 'Waiting for its runs',
  paused: 'Paused',
  idle: 'Round ended',
  off: 'Off',
};

/**
 * One project's autoresearch: whether it is on, the manager's one line at each wake, the
 * round's spend against its cap, and the pause and resume control. A project admin also sets
 * it up here; it is off until they turn it on.
 */
export function AutoresearchView({ row }: ViewProps) {
  const { actor } = useSession();
  const status = useTool<AutoresearchStatus>('autoresearch.read:status', {}, { every: 5000 });
  // Each press names its own requestId inside the action, as the noun tool takes it.
  const control = useCommand<AutoresearchStatus>({
    tool: 'autoresearch.write',
    idempotent: true,
    validate: (value) => !!value && typeof value.enabled === 'boolean',
    onSuccess: () => status.reload(),
  });
  if (!status.data) return <LoadState {...status} />;
  const data = status.data;
  const admin = permits(actor.role, 'admin');
  const act = (action: string, input: Record<string, unknown> = {}) =>
    void control.submit({ action, [action]: { ...input, requestId: crypto.randomUUID() } });
  const { spend } = data;
  const share =
    spend.committedUsd === null || spend.capUsd === 0
      ? 0
      : Math.min(100, Math.round((spend.committedUsd / spend.capUsd) * 100));
  return (
    <div className="page-stage stack">
      <PageHeader
        title={row.label}
        summary={data.enabled ? (data.goal ?? '') : 'Off. A project admin can turn it on below.'}
        actions={
          data.writable &&
          data.enabled && (
            <div className="cluster">
              {(data.state === 'managing' || data.state === 'waiting') && (
                <button className="btn" disabled={control.busy} onClick={() => act('pause')}>
                  Pause
                </button>
              )}
              {data.state === 'paused' && (
                <button className="btn" disabled={control.busy} onClick={() => act('resume')}>
                  Resume
                </button>
              )}
              {(data.state === 'waiting' || data.state === 'paused') && (
                <button className="btn" disabled={control.busy} onClick={() => act('end_round')}>
                  End round
                </button>
              )}
              {data.state === 'idle' && (
                <button className="btn" disabled={control.busy} onClick={() => act('start_round')}>
                  New round
                </button>
              )}
              {control.error && <span role="alert">{control.error}</span>}
            </div>
          )
        }
      />
      <KV
        rows={[
          ['Autoresearch', data.enabled ? 'On' : 'Off'],
          ['Now', data.state && <StatusPill value={STATE[data.state] ?? data.state} />],
          ['Paused', data.paused && PAUSED[data.paused]],
          [
            'Spend',
            <span className="tabular" key="spend">
              {usd(spend.spentUsd)} spent, {usd(spend.committedUsd)} with running work, of{' '}
              {usd(spend.capUsd)}
              <progress max={100} value={share} aria-label="Spend against the cap" />
            </span>,
          ],
          [
            'Wakes',
            data.enabled &&
              `${data.wakes.used} of ${data.wakes.limit} in a row${data.wakes.pending ? `, ${data.wakes.pending} queued` : ''}`,
          ],
        ]}
      />
      {data.lines.length > 0 && (
        <Part title="Decisions">
          <ol className="stack">
            {data.lines.map((line) => (
              <li key={line.id}>
                <span className="muted tabular">{new Date(line.at).toLocaleString()}</span>{' '}
                {line.text}
              </li>
            ))}
          </ol>
        </Part>
      )}
      {data.runs.length > 0 && (
        <Part title="Runs">
          <ul className="stack">
            {data.runs.map((run) => (
              <li key={run.id}>
                {run.workflow} “{run.name}” <StatusPill value={run.finalState ?? 'running'} />
              </li>
            ))}
          </ul>
        </Part>
      )}
      {admin && <Settings status={data} onSaved={() => status.reload()} />}
    </div>
  );
}

function Settings({ status, onSaved }: { status: AutoresearchStatus; onSaved: () => void }) {
  const [goal, setGoal] = useState(status.goal ?? '');
  const [cap, setCap] = useState(String(status.spend.capUsd));
  const [estimate, setEstimate] = useState(String(status.spend.runEstimateUsd));
  const [limit, setLimit] = useState(String(status.wakes.limit));
  const save = useCommand<AutoresearchStatus>({
    tool: 'autoresearch.write',
    idempotent: true,
    validate: (value) => !!value && typeof value.enabled === 'boolean',
    onSuccess: onSaved,
  });
  const submit = (enabled?: boolean) =>
    void save.submit({
      action: 'configure',
      configure: {
        ...(enabled !== undefined && { enabled }),
        ...(goal.trim() && { goal: goal.trim() }),
        capUsd: Number(cap),
        runEstimateUsd: Number(estimate),
        wakeLimit: Number(limit),
        requestId: crypto.randomUUID(),
      },
    });
  return (
    <Part title="Settings">
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="stack">
          Goal
          <textarea className="input" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <div className="cluster">
          <label>
            Cap (USD){' '}
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </label>
          <label>
            Per run (USD){' '}
            <input
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </label>
          <label>
            Wake limit{' '}
            <input
              className="input"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        <div className="cluster">
          <button className="btn" disabled={save.busy}>
            Save
          </button>
          <button
            type="button"
            className="btn"
            disabled={save.busy || (!status.enabled && !goal.trim())}
            onClick={() => submit(!status.enabled)}
          >
            {status.enabled ? 'Turn off' : 'Turn on'}
          </button>
          {save.error && <span role="alert">{save.error}</span>}
        </div>
      </form>
    </Part>
  );
}
