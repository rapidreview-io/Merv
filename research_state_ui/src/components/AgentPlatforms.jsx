import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AutorunSetupWizard from './AutorunSetupWizard';
import RunnerSettingsForm from './RunnerSettingsForm';
import Switch from './Switch';
import TracePeek from './TracePeek';
import { runnerPresentation } from './runnerPresentation';
import {
  assignmentFor,
  formatDuration,
  formatTokens,
  friendlyPacket,
  isLiveSession,
  sessionAgent,
  sessionDestination,
  sessionDurationMs,
  sessionOutcome,
} from './agentSessionPresentation';
import {
  draftFromRunner,
  draftSignature,
  settingsFromDraft,
  validateDraft,
  workspaceWithRepository,
} from './agentPlatformConfig';

/**
 * AgentPlatforms — the Auto-run panel (Settings → Auto running).
 *
 * Everything here comes from the brain: runner presence and inventory arrive
 * on the runner's heartbeat, settings are saved to the brain and pulled by
 * the runner on its next poll, and jobs are the brain's session rows. The
 * browser never dials the runner machine, so this works the same for a
 * laptop, a remote box, or a phone.
 */

const INSTALL_COMMAND = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
const RUNNER_COMMAND = '$HOME/.merv/bin/merv-agent-runner';
const SESSIONS_POLL_MS = 10_000;

function JobCard({ session, projectId, now, open, onToggle, onStop, stopping }) {
  const assignment = assignmentFor(session);
  const packet = friendlyPacket(session);
  const destination = sessionDestination(projectId, session);
  const outcome = sessionOutcome(session);
  const tokens = formatTokens(session?.telemetry?.total_tokens);
  const tools = Number(session?.telemetry?.tool_calls || 0);
  const attempt = Number(packet.attempt || session?.attempt_index || 0);
  const live = isLiveSession(session);

  return (
    <article className={[
      'aru-job',
      open ? 'aru-job--open' : '',
      outcome.tone === 'live' || outcome.tone === 'starting' ? 'aru-job--working' : '',
    ].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="aru-job-summary"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`aru-job-dot aru-job-dot--${outcome.tone}`} aria-hidden="true" />
        <span className="aru-job-name">
          <strong>{assignment.title || 'Agent task'}</strong>
          <small>
            {assignment.subtitle || 'Experiment'}
            {attempt > 0 && ` · attempt ${attempt}`}
          </small>
        </span>
        <span className="aru-job-agent">{sessionAgent(session)}</span>
        <span className="aru-job-metrics">
          <span>{formatDuration(sessionDurationMs(session, now))}</span>
          {tokens && <span>{tokens} tokens</span>}
          <span className={`aru-job-state aru-job-state--${outcome.tone}`}>
            {outcome.label}
          </span>
        </span>
        <span className="aru-job-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="aru-job-body">
          <div className="aru-job-detail-bar">
            <span>
              {sessionAgent(session)}
              {tools > 0 && ` · ${tools} ${tools === 1 ? 'tool call' : 'tool calls'}`}
              {session?.agent_setup?.machine && ` · on ${session.agent_setup.machine}`}
            </span>
            <span className="page-actions">
              {live && onStop && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={stopping}
                  onClick={onStop}
                >
                  {stopping ? 'Stopping…' : 'Stop this job'}
                </button>
              )}
              {destination && (
                <Link className="btn btn--primary btn--sm" to={destination.to}>
                  {destination.label}
                </Link>
              )}
            </span>
          </div>
          <div className="aru-packet">
            <span className="aru-label">Trace</span>
            <TracePeek
              projectId={projectId}
              sessionId={session.id}
              live={live}
              machine={session?.agent_setup?.machine || ''}
            />
          </div>
          <details className="aru-packet aru-packet--collapsed">
            <summary className="aru-label">Assignment</summary>
            <pre><code>{JSON.stringify(packet, null, 2)}</code></pre>
          </details>
        </div>
      )}
    </article>
  );
}

function RunnerCard({ runner, selected, onSelect, now }) {
  const view = runnerPresentation(runner, now);
  const enabled = (runner.platforms || []).filter((item) => item.enabled !== false).map((item) => item.name);
  return (
    <button
      type="button"
      className={`aru-runner${selected ? ' aru-runner--selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className={`aru-live-dot aru-live-dot--${view.tone}`} aria-hidden="true" />
      <span className="aru-runner-name">
        <strong>{view.machineName}</strong>
        <small>{[view.machineDetails, enabled.join(', ') || 'no agents'].filter(Boolean).join(' · ')}</small>
      </span>
      <span className={`aru-status aru-status--${view.tone}`}>{view.state}</span>
    </button>
  );
}

export default function AgentPlatforms({ projectId }) {
  const [sessions, setSessions] = useState(null);
  const [runners, setRunners] = useState([]);
  const [sessionError, setSessionError] = useState('');
  const [selectedRef, setSelectedRef] = useState('');
  const [draft, setDraft] = useState(() => draftFromRunner(null));
  const [draftBase, setDraftBase] = useState('');
  const [draftFor, setDraftFor] = useState('');
  const [saveState, setSaveState] = useState({ busy: false, error: '', savedVersion: 0, applied: false });
  const [dispatch, setDispatch] = useState(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [halting, setHalting] = useState(false);
  const [stoppingId, setStoppingId] = useState('');
  const [showHaltPrompt, setShowHaltPrompt] = useState(false);
  const [expandedSession, setExpandedSession] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [wizardOpen, setWizardOpen] = useState(false); // false | 'guide' | 'pair'
  const [configOpen, setConfigOpen] = useState(false);
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [recentFilter, setRecentFilter] = useState('all');
  const settingsRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await api.listAgentSessions(projectId);
      setSessions(response?.sessions || []);
      const rows = Array.isArray(response?.runners)
        ? response.runners
        : (response?.runner ? [response.runner] : []);
      setRunners(rows);
      setSessionError('');
    } catch {
      setSessionError('Session status is unavailable.');
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    refresh();
    const timer = setInterval(refresh, SESSIONS_POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, refresh]);

  useEffect(() => {
    if (!projectId) return undefined;
    let disposed = false;
    api.getProject(projectId)
      .then((project) => {
        if (!disposed) setDispatch(Boolean(project?.settings?.agent_dispatch));
      })
      .catch(() => {
        if (!disposed) setDispatchError('Dispatch setting is unavailable.');
      });
    return () => { disposed = true; };
  }, [projectId]);

  // Default the selected runner to the most recently seen one.
  useEffect(() => {
    if (!runners.length) return;
    if (!selectedRef || !runners.some((runner) => runner.runner_ref === selectedRef)) {
      setSelectedRef(runners[0].runner_ref);
    }
  }, [runners, selectedRef]);

  const selected = useMemo(
    () => runners.find((runner) => runner.runner_ref === selectedRef) || null,
    [runners, selectedRef],
  );

  // Seed the form from the selected runner's row; re-seed when the runner
  // changes or when the machine reports a newer view and the form is clean.
  useEffect(() => {
    if (!selected) return;
    const seeded = draftFromRunner(selected);
    const seededSignature = draftSignature(seeded.platforms, seeded.workspace);
    const currentSignature = draftSignature(draft.platforms, draft.workspace);
    const clean = draftFor === selected.runner_ref && currentSignature === draftBase;
    if (draftFor !== selected.runner_ref || clean) {
      setDraft(seeded);
      setDraftBase(seededSignature);
      setDraftFor(selected.runner_ref);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.runner_ref, selected?.desired_version, selected?.last_seen_at]);

  useEffect(() => {
    if (!selected || !saveState.savedVersion) return;
    if (Number(selected.applied_version || 0) >= saveState.savedVersion && !saveState.applied) {
      setSaveState((current) => ({ ...current, applied: true }));
    }
  }, [selected, saveState.savedVersion, saveState.applied]);

  const validation = useMemo(
    () => validateDraft(draft.platforms, draft.workspace),
    [draft],
  );
  const dirty = draftSignature(draft.platforms, draft.workspace) !== draftBase;
  const liveSessions = useMemo(() => (sessions || []).filter(isLiveSession), [sessions]);
  const closedSessions = useMemo(
    () => (sessions || []).filter((session) => !isLiveSession(session)),
    [sessions],
  );
  const filteredClosed = useMemo(() => closedSessions.filter((session) => {
    if (recentFilter === 'all') return true;
    const tone = sessionOutcome(session).tone;
    if (recentFilter === 'completed') return tone === 'complete';
    if (recentFilter === 'stopped') return tone === 'quiet';
    if (recentFilter === 'failed') return tone === 'error';
    return true;
  }), [closedSessions, recentFilter]);
  const recentSessions = showAllRecent ? filteredClosed : filteredClosed.slice(0, 6);
  const filterCounts = useMemo(() => {
    const counts = { all: closedSessions.length, completed: 0, stopped: 0, failed: 0 };
    for (const session of closedSessions) {
      const tone = sessionOutcome(session).tone;
      if (tone === 'complete') counts.completed += 1;
      else if (tone === 'quiet') counts.stopped += 1;
      else if (tone === 'error') counts.failed += 1;
    }
    return counts;
  }, [closedSessions]);
  const liveSessionCount = liveSessions.length;

  // The clock feeds both job elapsed times (1 s while anything runs) and
  // runner presence ages (must keep moving while idle, or a machine that
  // stops heartbeating would read as Live against a frozen "now").
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(
      () => setClock(Date.now()),
      liveSessionCount > 0 ? 1_000 : 5_000,
    );
    return () => clearInterval(timer);
  }, [liveSessionCount]);

  useEffect(() => { setExpandedSession(''); }, [projectId]);

  const liveRunners = runners.filter((runner) => runnerPresentation(runner, clock).live);
  const capacity = liveRunners.reduce((total, runner) => total + (Number(runner.capacity) || 0), 0);
  const enabledNames = [...new Set(
    liveRunners.flatMap((runner) => (runner.platforms || [])
      .filter((item) => item.enabled !== false)
      .map((item) => item.name)),
  )];
  const view = runnerPresentation(selected, clock);
  const anyRunner = runners.length > 0;

  function updatePlatform(id, patch) {
    setDraft((current) => ({
      ...current,
      platforms: current.platforms.map((platform) => (
        platform.id === id ? { ...platform, ...patch } : platform
      )),
    }));
  }

  function updateRepository(repository) {
    setDraft((current) => ({ ...current, workspace: workspaceWithRepository(current.workspace, repository) }));
  }

  function updateWorkspace(patch) {
    setDraft((current) => ({ ...current, workspace: { ...current.workspace, ...patch } }));
  }

  async function saveSettings() {
    if (!selected) return false;
    if (!validation.valid) {
      setSaveState((current) => ({ ...current, error: 'Fix the highlighted fields first.' }));
      return false;
    }
    setSaveState({ busy: true, error: '', savedVersion: 0, applied: false });
    try {
      const response = await api.putRunnerSettings(
        projectId,
        selected.runner_ref,
        settingsFromDraft(draft.platforms, draft.workspace),
      );
      const row = response?.runner || null;
      const version = Number(row?.desired_version || 0);
      setDraftBase(draftSignature(draft.platforms, draft.workspace));
      setSaveState({ busy: false, error: '', savedVersion: version, applied: false });
      if (row) {
        setRunners((current) => current.map((runner) => (
          runner.runner_ref === row.runner_ref ? { ...runner, ...row } : runner
        )));
      }
      return true;
    } catch (error) {
      setSaveState({
        busy: false,
        error: error?.message || 'Could not save runner settings.',
        savedVersion: 0,
        applied: false,
      });
      return false;
    }
  }

  async function toggleDispatch(next) {
    setDispatchBusy(true);
    setDispatchError('');
    try {
      const project = await api.patchProject(projectId, { agent_dispatch: next });
      setDispatch(Boolean(project?.settings?.agent_dispatch ?? next));
      // Turning dispatch off only stops new claims, so offer the separate stop
      // for whatever is already running.
      setShowHaltPrompt(!next);
    } catch (err) {
      setDispatchError(err?.message || 'Could not change the dispatch setting.');
    } finally {
      setDispatchBusy(false);
    }
  }

  async function haltSessions() {
    setHalting(true);
    setDispatchError('');
    try {
      const response = await api.haltAgentSessions(projectId);
      setSessions(response?.sessions || []);
      setShowHaltPrompt(false);
    } catch (err) {
      setDispatchError(err?.message || 'Could not stop the running sessions.');
    } finally {
      setHalting(false);
    }
  }

  async function haltOne(sessionId) {
    setStoppingId(sessionId);
    setDispatchError('');
    try {
      const response = await api.haltAgentSession(projectId, sessionId);
      const updated = response?.session;
      if (updated) {
        setSessions((current) => (current || []).map((session) => (
          session.id === updated.id ? updated : session
        )));
      }
    } catch (err) {
      setDispatchError(err?.message || 'Could not stop that session.');
    } finally {
      setStoppingId('');
    }
  }

  async function copy(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setCopyFailed('');
      setTimeout(() => setCopied(''), 1800);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); say so
      // instead of pretending, and leave the text selectable.
      setCopied('');
      setCopyFailed(label);
      setTimeout(() => setCopyFailed(''), 2400);
    }
  }
  const copyLabel = (label) => (copied === label ? 'Copied' : copyFailed === label ? 'Copy failed' : 'Copy');

  function showAgentSettings() {
    setConfigOpen(true);
    window.requestAnimationFrame(() => {
      settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const settingsNote = (() => {
    if (!selected) return 'Pair a runner to edit its settings.';
    if (saveState.busy) return 'Saving…';
    if (dirty) return `Unsaved changes for ${view.machineName}.`;
    if (view.settings) return view.settings;
    if (saveState.savedVersion && saveState.applied) return `Applied on ${view.machineName}.`;
    if (saveState.savedVersion) return `Saved. ${view.machineName} applies it on its next poll.`;
    return `Settings on ${view.machineName} are current.`;
  })();

  return (
    <>
      <section className="aru-scope" aria-label="Auto-run status">
        <header className="aru-scope-head">
          <h2 className="aru-scope-title">Auto-run</h2>
        </header>
        <div className="aru-card aru-overview">
          <div className="aru-machine">
            <span className={`aru-live-dot aru-live-dot--${view.tone}`} aria-hidden="true" />
            <div className="aru-machine-name">
              <strong>{anyRunner ? view.machineName : 'Connect a runner'}</strong>
              {anyRunner && view.machineDetails && <span>{view.machineDetails}</span>}
            </div>
            {anyRunner && (
              <span className={`aru-status aru-status--${view.tone}`}>
                {view.state}
              </span>
            )}
          </div>
          <div className="aru-overview-actions">
            <button
              type="button"
              className={`btn ${anyRunner ? 'btn--ghost' : 'btn--primary'} btn--sm`}
              onClick={() => setWizardOpen('pair')}
            >
              {anyRunner ? 'Pair another runner' : 'Set up runner'}
            </button>
            {anyRunner && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={showAgentSettings}
              >
                Agent settings
              </button>
            )}
          </div>
          <div className="aru-facts">
            <div className="aru-dispatch-control">
              <Switch
                checked={dispatch === true}
                disabled={dispatch === null || dispatchBusy || !projectId}
                onChange={toggleDispatch}
                label="Automatic dispatch"
              />
              <span>
                <strong>Dispatch</strong>
                <small>{dispatch === null ? 'Loading' : dispatch ? 'On' : 'Off'}</small>
              </span>
            </div>
            <span className="aru-fact">
              <strong>{liveSessions.length}</strong>
              <small>running</small>
            </span>
            <span className="aru-fact">
              <strong>{capacity}</strong>
              <small>{capacity === 1 ? 'slot' : 'slots'}</small>
            </span>
            <span className="aru-fact aru-fact--wide">
              <strong>{enabledNames.join(', ') || 'No agents'}</strong>
              <small>enabled</small>
            </span>
          </div>
          {runners.length > 1 && (
            <div className="aru-runner-list" role="list" aria-label="Runner machines">
              {runners.map((runner) => (
                <RunnerCard
                  key={runner.runner_ref}
                  runner={runner}
                  now={clock}
                  selected={runner.runner_ref === selectedRef}
                  onSelect={() => setSelectedRef(runner.runner_ref)}
                />
              ))}
            </div>
          )}
          {view.settings && anyRunner && (
            <p className={`aru-pairing-status aru-pairing-status--${view.settingsTone}`} role="status">
              {view.settings}
            </p>
          )}
        </div>

        {anyRunner && !view.live && (
          <div className="aru-start-panel" role="status">
            <span>
              <strong>{view.state === 'Stale' ? 'Runner not responding' : 'Runner offline'}</strong>
              <small>Start it on {view.machineName}</small>
            </span>
            <div className="aru-command">
              <code className="mono">{RUNNER_COMMAND}</code>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => copy('start-runner', RUNNER_COMMAND)}
              >
                {copyLabel('start-runner')}
              </button>
            </div>
          </div>
        )}

        {showHaltPrompt && liveSessions.length > 0 && (
          <div className="aru-card aru-halt" role="status">
            <p>{liveSessions.length} {liveSessions.length === 1 ? 'job is' : 'jobs are'} still running.</p>
            <div className="page-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={haltSessions}
                disabled={halting}
              >
                {halting ? 'Stopping…' : 'Stop now'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setShowHaltPrompt(false)}
                disabled={halting}
              >
                Keep running
              </button>
            </div>
          </div>
        )}

        {dispatchError && (
          <p className="aru-error" role="alert">{dispatchError}</p>
        )}

        {(sessionError || liveSessions.length > 0) && (
          <section className="aru-jobs" aria-label="Running jobs">
            <div className="aru-section-head">
              <span className="aru-section-title">Running</span>
              {liveSessions.length > 0 && !showHaltPrompt && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={haltSessions}
                  disabled={halting}
                >
                  {halting ? 'Stopping…' : liveSessions.length === 1 ? 'Stop' : 'Stop all'}
                </button>
              )}
            </div>
            {sessionError ? (
              <span className="aru-note">{sessionError}</span>
            ) : (
              <div className="aru-job-list">
                {liveSessions.map((session) => (
                  <JobCard
                    key={session.id}
                    session={session}
                    projectId={projectId}
                    now={clock}
                    open={expandedSession === session.id}
                    onToggle={() => setExpandedSession((current) => (
                      current === session.id ? '' : session.id
                    ))}
                    onStop={() => haltOne(session.id)}
                    stopping={stoppingId === session.id}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {!sessionError && closedSessions.length > 0 && (
          <section className="aru-jobs aru-jobs--recent" aria-label="Recent jobs">
            <div className="aru-section-head">
              <span className="aru-section-title">
                {showAllRecent ? 'History' : 'Recent'}
                <span className="aru-section-count">{filteredClosed.length}</span>
              </span>
              <span className="aru-filter-chips" role="group" aria-label="Filter jobs">
                {[
                  ['all', 'All'],
                  ['completed', 'Completed'],
                  ['stopped', 'Stopped'],
                  ['failed', 'Failed'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`aru-chip${recentFilter === key ? ' aru-chip--active' : ''}`}
                    aria-pressed={recentFilter === key}
                    disabled={key !== 'all' && filterCounts[key] === 0}
                    onClick={() => setRecentFilter(key)}
                  >
                    {label}{filterCounts[key] > 0 && key !== 'all' ? ` ${filterCounts[key]}` : ''}
                  </button>
                ))}
              </span>
            </div>
            {filteredClosed.length === 0 && (
              <span className="aru-note">No {recentFilter} jobs.</span>
            )}
            <div className="aru-job-list">
              {recentSessions.map((session) => (
                <JobCard
                  key={session.id}
                  session={session}
                  projectId={projectId}
                  now={clock}
                  open={expandedSession === session.id}
                  onToggle={() => setExpandedSession((current) => (
                    current === session.id ? '' : session.id
                  ))}
                />
              ))}
            </div>
            {filteredClosed.length > 6 && (
              <div className="aru-history-more">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setShowAllRecent((current) => !current)}
                >
                  {showAllRecent ? 'Show fewer' : `Show all ${filteredClosed.length}`}
                </button>
                {showAllRecent && closedSessions.length >= 250 && (
                  <span className="aru-note">Showing the latest 250 jobs.</span>
                )}
              </div>
            )}
          </section>
        )}

        <details
          ref={settingsRef}
          className="aru-settings"
          open={configOpen}
          onToggle={(event) => setConfigOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>Runner settings</strong>
              <small>
                {selected
                  ? `${view.machineName} · ${draft.platforms.filter((item) => item.enabled).length} ${draft.platforms.filter((item) => item.enabled).length === 1 ? 'agent' : 'agents'} · ${draft.workspace.repository || 'No repository'}`
                  : 'No runner paired yet'}
              </small>
            </span>
            <span className="aru-settings-action">{configOpen ? 'Close' : 'Open'}</span>
          </summary>
          <div className="aru-settings-body">
            {selected ? (
              <>
                <div className="aru-settings-head">
                  <span>
                    Settings for <strong>{view.machineName}</strong>
                    {runners.length > 1 && ' — pick another machine above'}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setWizardOpen('guide')}
                  >
                    Setup guide
                  </button>
                </div>
                <RunnerSettingsForm
                  platforms={draft.platforms}
                  custom={draft.custom}
                  workspace={draft.workspace}
                  validation={validation}
                  availableCommands={selected.inventory?.available_commands || null}
                  harness={selected.inventory?.harness || null}
                  onUpdatePlatform={updatePlatform}
                  onRepository={updateRepository}
                  onWorkspace={updateWorkspace}
                />
                {!validation.valid && (
                  <div className="aru-validation" role="alert">
                    <strong>Fix these before saving.</strong>
                    <ul>
                      {[...new Set(validation.messages)].map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {saveState.error && <p className="aru-error" role="alert">{saveState.error}</p>}
                <div className="aru-apply">
                  <span className="aru-note">{settingsNote}</span>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={saveState.busy || !dirty || !validation.valid}
                    onClick={saveSettings}
                  >
                    {saveState.busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            ) : (
              <p className="aru-note aru-pairing-hint">
                Run <code>{INSTALL_COMMAND}</code> on the machine that will run
                your agents, then approve the code it prints with{' '}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setWizardOpen('pair')}>Set up runner</button>.
              </p>
            )}

            <details className="aru-manual">
              <summary>Manual &amp; headless setup</summary>
              <div className="aru-manual-head">
                <p>
                  Install without pairing, export a project key as{' '}
                  <code>MERV_MCP_KEY</code>, then start the runner for this project.
                  Executable commands and custom agents are edited on the machine
                  with <code>merv-client agent</code>.
                </p>
              </div>
              <div className="aru-command">
                <code className="mono">{INSTALL_COMMAND} -s -- --install-only</code>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('install-only', `${INSTALL_COMMAND} -s -- --install-only`)}>
                  {copyLabel('install-only')}
                </button>
              </div>
              <div className="aru-command">
                <code className="mono">{RUNNER_COMMAND} --project {projectId || 'PROJECT_ID'}</code>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('run', `${RUNNER_COMMAND} --project ${projectId || 'PROJECT_ID'}`)}>
                  {copyLabel('run')}
                </button>
              </div>
            </details>
          </div>
        </details>
      </section>

      {wizardOpen && (
        <AutorunSetupWizard
          projectId={projectId}
          forcePair={wizardOpen === 'pair'}
          runners={runners}
          selectedRef={selectedRef}
          onSelectRunner={setSelectedRef}
          onRefreshRunners={refresh}
          draft={draft}
          validation={validation}
          onUpdatePlatform={updatePlatform}
          onRepository={updateRepository}
          onWorkspace={updateWorkspace}
          onSave={saveSettings}
          saveState={saveState}
          dispatch={dispatch}
          dispatchBusy={dispatchBusy}
          onDispatch={toggleDispatch}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
