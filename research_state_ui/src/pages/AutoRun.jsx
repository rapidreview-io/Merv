import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import { api } from '../api';
import Switch from '../components/Switch';
import AutorunJobs, { jobBucket } from '../components/AutorunJobs';
import AutorunMachines from '../components/AutorunMachines';
import AutorunPairing from '../components/AutorunPairing';
import { autorunHeadline } from '../components/autorunHeadline';
import { isLiveSession } from '../components/agentSessionPresentation';

const TABS = [
  ['active', 'Active'],
  ['done', 'Done'],
  ['failed', 'Failed'],
  ['all', 'All'],
];

/**
 * Auto-run — agents at work.
 *
 * The runtime view of the project's autopilot: one sentence says whether work
 * is moving on its own and, if not, why; the jobs console shows what agents
 * are doing or did (the trace is a twist away); the machines console shows the
 * paired runners and holds their tuning. Everything comes from the brain — the
 * browser never dials a machine — so it reads the same for a laptop, a remote
 * box, or a phone. Experiments stays the record; this page is what ran it.
 */
export default function AutoRun() {
  const projectId = useProjectStore((s) => s.projectId);
  const [sessions, setSessions] = useState(null); // null = loading
  const [runners, setRunners] = useState([]);
  const [queue, setQueue] = useState(null); // null = brain does not report one
  const [error, setError] = useState('');
  const [dispatch, setDispatch] = useState(null); // null = unknown
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [tab, setTab] = useState('active');
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await api.listAgentSessions(projectId);
      setSessions(response?.sessions || []);
      setRunners(Array.isArray(response?.runners)
        ? response.runners
        : (response?.runner ? [response.runner] : []));
      setQueue(Array.isArray(response?.queue) ? response.queue : null);
      setError('');
    } catch (err) {
      setError(err?.message || 'Auto-run status is unavailable.');
    }
  }, [projectId]);

  useEffect(() => {
    setSessions(null);
    setRunners([]);
    setQueue(null);
    setDispatch(null);
    setTab('active');
    refresh();
  }, [projectId, refresh]);

  useEffect(() => {
    if (!projectId) return undefined;
    let disposed = false;
    api.getProject(projectId)
      .then((project) => { if (!disposed) setDispatch(Boolean(project?.settings?.agent_dispatch)); })
      .catch(() => { if (!disposed) setDispatchError('Dispatch setting is unavailable.'); });
    return () => { disposed = true; };
  }, [projectId]);

  const running = useMemo(() => (sessions || []).filter(isLiveSession).length, [sessions]);

  // Fast while something runs, relaxed otherwise (Sandboxes cadence).
  useEffect(() => {
    if (!projectId) return undefined;
    const timer = setInterval(refresh, running > 0 ? 3000 : 10000);
    return () => clearInterval(timer);
  }, [projectId, refresh, running]);

  // Elapsed times tick at 1 Hz only while a job runs; presence ages must keep
  // moving regardless, or a machine that stops heartbeating would stay "Live"
  // against a frozen clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), running > 0 ? 1000 : 5000);
    return () => clearInterval(timer);
  }, [running]);

  async function toggleDispatch(next) {
    setDispatchBusy(true);
    setDispatchError('');
    try {
      const project = await api.patchProject(projectId, { agent_dispatch: next });
      setDispatch(Boolean(project?.settings?.agent_dispatch ?? next));
    } catch (err) {
      setDispatchError(err?.message || 'Could not change dispatch.');
    } finally {
      setDispatchBusy(false);
    }
  }

  async function stopSession(sessionId) {
    const response = await api.haltAgentSession(projectId, sessionId);
    const updated = response?.session;
    if (updated) {
      setSessions((current) => (current || []).map((session) => (
        session.id === updated.id ? updated : session
      )));
    }
  }

  function mergeRunner(row) {
    if (!row?.runner_ref) return;
    setRunners((current) => current.map((runner) => (
      runner.runner_ref === row.runner_ref ? { ...runner, ...row } : runner
    )));
  }

  const counts = useMemo(() => {
    const out = { active: 0, done: 0, failed: 0, all: (sessions || []).length };
    for (const session of sessions || []) out[jobBucket(session)] += 1;
    if (queue) {
      out.active += queue.length;
      out.all += queue.length;
    }
    return out;
  }, [sessions, queue]);

  const headline = autorunHeadline({
    dispatch,
    runners,
    sessions: sessions || [],
    waiting: queue ? queue.length : null,
    now,
  });
  const noMachines = sessions !== null && runners.length === 0;

  return (
    <div className="page-stage arun">
      <header className="page-header page-header--lg arun-header">
        <div className="page-head-row">
          <div className="arun-title">
            <h1 className="page-title">Agents at work</h1>
            <p className={`page-summary arun-headline arun-headline--${headline.tone || 'quiet'}`} role="status">
              {headline.text || ' '}
            </p>
          </div>
          <div className="page-actions arun-dispatch" title="Whether paired machines may pick up new work">
            <span className="arun-dispatch-word">
              Dispatch <strong>{dispatch === null ? '…' : dispatch ? 'on' : 'off'}</strong>
            </span>
            <Switch
              checked={dispatch === true}
              disabled={dispatch === null || dispatchBusy || !projectId}
              onChange={toggleDispatch}
              label="Automatic dispatch"
            />
          </div>
        </div>
        <div className="tab-row arun-tabs" role="tablist" aria-label="Jobs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`tab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {key === 'active' && running > 0 && <span className="arun-tab-dot" aria-hidden="true" />}
              {label}
              <span className="tab-count">{counts[key]}</span>
            </button>
          ))}
        </div>
      </header>

      {(error || dispatchError) && <div className="error-message">{error || dispatchError}</div>}

      {sessions === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {noMachines ? (
            <div className="empty-state arun-empty">
              <h2>No machines yet</h2>
              <p>Run this on the machine that will do the work. It prints a code to approve here.</p>
              <AutorunPairing projectId={projectId} runners={runners} onRefresh={refresh} />
            </div>
          ) : null}

          {(!noMachines || (sessions || []).length > 0) && (
            <AutorunJobs
              projectId={projectId}
              sessions={sessions}
              queue={queue}
              tab={tab}
              now={now}
              dispatch={dispatch}
              runners={runners}
              onStop={stopSession}
            />
          )}

          {!noMachines && (
            <section className="section arun-machines" aria-label="Machines">
              <div className="section-title">Machines</div>
              <AutorunMachines
                projectId={projectId}
                runners={runners}
                sessions={sessions}
                dispatch={dispatch}
                now={now}
                onRunner={mergeRunner}
                onRefresh={refresh}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
