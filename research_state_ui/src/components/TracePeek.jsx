import { useEffect, useState } from 'react';
import { api } from '../api';
import { summarizeTraceEvent, traceUpdatedLabel } from './traceEventPresentation';

/**
 * TracePeek — the bounded, redacted excerpt of one auto-run job's trace.
 *
 * The runner mirrors the last few provider events and the tail of stderr to
 * the brain (capped, secrets redacted); the raw trace stays on the machine.
 * Fetched lazily when a job card is expanded, refreshed while the job is
 * live, and read-only. Click an event to see its raw JSON.
 */

const LIVE_REFRESH_MS = 10_000;

export default function TracePeek({ projectId, sessionId, live, machine }) {
  const [trace, setTrace] = useState(undefined); // undefined = loading, null = none
  const [error, setError] = useState('');
  const [openIndex, setOpenIndex] = useState(-1);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!projectId || !sessionId) return undefined;
    let disposed = false;
    async function load() {
      try {
        const response = await api.getAgentSessionTrace(projectId, sessionId);
        if (disposed) return;
        setTrace(response?.trace || null);
        setError('');
        setNow(Date.now());
      } catch (err) {
        if (!disposed) setError(err?.message || 'Trace is unavailable.');
      }
    }
    load();
    if (!live) return () => { disposed = true; };
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [projectId, sessionId, live]);

  const path = <code>~/.merv/agent-traces/{sessionId}/</code>;

  if (error) return <p className="aru-note aru-trace-empty">{error}</p>;
  if (trace === undefined) return <p className="aru-note aru-trace-empty">Loading trace…</p>;
  if (trace === null) {
    return (
      <p className="aru-note aru-trace-empty">
        {live
          ? <>No trace yet — the runner mirrors a short excerpt once the agent starts writing.</>
          : <>No trace excerpt was mirrored for this job. The full trace, if any, is at {path}{machine ? <> on {machine}</> : null}.</>}
      </p>
    );
  }

  const events = Array.isArray(trace.events) ? trace.events : [];
  return (
    <div className="aru-trace" aria-label="Trace excerpt">
      {events.length === 0 ? (
        <p className="aru-note aru-trace-empty">No events yet.</p>
      ) : (
        <ol className="aru-trace-list">
          {events.map((event, index) => {
            const summary = summarizeTraceEvent(event);
            const open = openIndex === index;
            return (
              <li key={index} className={`aru-trace-row aru-trace-row--${summary.tone}${open ? ' aru-trace-row--open' : ''}`}>
                <button
                  type="button"
                  className="aru-trace-line"
                  aria-expanded={open}
                  onClick={() => setOpenIndex(open ? -1 : index)}
                >
                  <span className={`aru-trace-kind aru-trace-kind--${summary.tone}`}>{summary.kind}</span>
                  <span className="aru-trace-text">{summary.text || '—'}</span>
                </button>
                {open && (
                  <pre className="aru-trace-raw"><code>{JSON.stringify(event, null, 2)}</code></pre>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {trace.stderr_tail && (
        <details className="aru-trace-stderr">
          <summary>stderr tail</summary>
          <pre><code>{trace.stderr_tail}</code></pre>
        </details>
      )}
      <p className="aru-trace-foot">
        Last {events.length} {events.length === 1 ? 'event' : 'events'}
        {trace.complete ? ' · final' : live ? ' · live, refreshes every 10 s' : ''}
        {trace.updated_at ? ` · updated ${traceUpdatedLabel(trace.updated_at, now)}` : ''}
        {' · '}full trace at {path}{machine ? <> on {machine}</> : null}
      </p>
    </div>
  );
}
