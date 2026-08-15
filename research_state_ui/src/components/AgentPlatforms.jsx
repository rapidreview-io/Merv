import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AutorunSetupWizard from './AutorunSetupWizard';
import Switch from './Switch';
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
  connectFailureMessage,
  ensureRunnerTransport,
  runnerRequest,
} from './runnerClient';
import {
  ADAPTERS,
  DEFAULT_WORKSPACE,
  capabilitiesFor,
  configFromDraft,
  configSignature,
  defaultPlatforms,
  workspaceWithRepository,
  draftFromSettings,
  nextCustomId,
  normalizeLocalPlatforms,
  validateDraft,
} from './agentPlatformConfig';

const DRAFT_KEY = 'rsui:agentPlatforms';
const WORKSPACE_KEY = 'rsui:agentWorkspace';
const LOCAL_RUNNER_URL = 'http://127.0.0.1:8791';

function readDraft() {
  if (typeof localStorage === 'undefined') return defaultPlatforms();
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
    return normalizeLocalPlatforms(saved);
  } catch {
    return defaultPlatforms();
  }
}

function readWorkspace() {
  if (typeof localStorage === 'undefined') return DEFAULT_WORKSPACE;
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY));
    return saved && typeof saved === 'object'
      ? {
        ...DEFAULT_WORKSPACE,
        repository: typeof saved.repository === 'string' ? saved.repository : '',
        root: saved.strategy === 'existing'
          ? ''
          : (typeof saved.root === 'string' ? saved.root : ''),
        base_ref: typeof saved.base_ref === 'string' && saved.base_ref.trim()
          ? saved.base_ref
          : DEFAULT_WORKSPACE.base_ref,
        strategy: 'git_worktree',
      }
      : { ...DEFAULT_WORKSPACE };
  } catch {
    return { ...DEFAULT_WORKSPACE };
  }
}

function platformSummary(platform) {
  return [
    platform.command[0] || 'no command',
    platform.model,
    platform.effort,
    `×${platform.parallelism}`,
  ].filter(Boolean).join(' · ');
}

function JobCard({ session, projectId, now, open, onToggle }) {
  const assignment = assignmentFor(session);
  const packet = friendlyPacket(session);
  const destination = sessionDestination(projectId, session);
  const outcome = sessionOutcome(session);
  const tokens = formatTokens(session?.telemetry?.total_tokens);
  const tools = Number(session?.telemetry?.tool_calls || 0);
  const attempt = Number(packet.attempt || session?.attempt_index || 0);

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
            </span>
            {destination && (
              <Link className="btn btn--primary btn--sm" to={destination.to}>
                {destination.label}
              </Link>
            )}
          </div>
          <div className="aru-packet">
            <span className="aru-label">Assignment</span>
            <pre><code>{JSON.stringify(packet, null, 2)}</code></pre>
          </div>
        </div>
      )}
    </article>
  );
}

export default function AgentPlatforms({ projectId }) {
  const [platforms, setPlatforms] = useState(readDraft);
  const [workspace, setWorkspace] = useState(readWorkspace);
  const [copied, setCopied] = useState('');
  const [expanded, setExpanded] = useState('');
  const [sessions, setSessions] = useState(null);
  const [runnerPresence, setRunnerPresence] = useState(null);
  const [sessionError, setSessionError] = useState('');
  const [runnerUrl, setRunnerUrl] = useState(LOCAL_RUNNER_URL);
  const [pairingToken, setPairingToken] = useState('');
  const [runnerConnection, setRunnerConnection] = useState('idle');
  const [runnerMessage, setRunnerMessage] = useState('');
  const [runnerStatus, setRunnerStatus] = useState(null);
  const [, setRunnerLastSeen] = useState(null);
  const [machineBaseline, setMachineBaseline] = useState(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [dispatch, setDispatch] = useState(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [halting, setHalting] = useState(false);
  const [showHaltPrompt, setShowHaltPrompt] = useState(false);
  const [expandedSession, setExpandedSession] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [wizardOpen, setWizardOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  // Unpaired, the guided setup is the page; manual pairing is an explicit
  // opt-in so a fresh project is not greeted with raw fields and a draft.
  const [manualOpen, setManualOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(platforms));
    } catch {
      // A private browser may disable storage; the in-memory draft still works.
    }
  }, [platforms]);

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
    } catch {
      // The visible draft remains usable when browser storage is disabled.
    }
  }, [workspace]);

  useEffect(() => {
    if (!projectId) return undefined;
    let disposed = false;
    async function load() {
      try {
        const response = await api.listAgentSessions(projectId);
        if (!disposed) {
          setSessions(response?.sessions || []);
          setRunnerPresence(response?.runner || null);
          setSessionError('');
        }
      } catch {
        if (!disposed) setSessionError('Session status is unavailable.');
      }
    }
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (!pairingToken.trim() || machineBaseline === null) return undefined;
    let disposed = false;
    async function probe() {
      try {
        const status = await runnerRequest({
          url: runnerUrl, token: pairingToken, path: '/status',
        });
        if (disposed) return;
        setRunnerStatus(status);
        setRunnerLastSeen(Date.now());
        setRunnerConnection((current) => (
          current === 'applying' ? current : 'connected'
        ));
      } catch {
        if (!disposed) {
          setRunnerConnection((current) => (
            current === 'applying' ? current : 'unreachable'
          ));
        }
      }
    }
    const timer = setInterval(probe, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [runnerUrl, pairingToken, machineBaseline]);

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

  const draftConfig = useMemo(
    () => configFromDraft(platforms, workspace),
    [platforms, workspace],
  );
  const config = useMemo(() => JSON.stringify(draftConfig, null, 2), [draftConfig]);
  const signature = useMemo(() => configSignature(draftConfig), [draftConfig]);
  const validation = useMemo(
    () => validateDraft(platforms, workspace),
    [platforms, workspace],
  );
  const dirty = machineBaseline !== null && signature !== machineBaseline;
  const connected = runnerConnection === 'connected' || runnerConnection === 'applying';
  const paired = machineBaseline !== null;
  const runnerBin = '$HOME/.merv/bin/merv-agent-runner';
  const installCommand = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
  const runCommand = `${runnerBin} --project ${projectId || 'PROJECT_ID'}`;
  const liveSessions = useMemo(
    () => (sessions || []).filter(isLiveSession),
    [sessions],
  );
  const recentSessions = useMemo(
    () => (sessions || []).filter((session) => !isLiveSession(session)).slice(0, 6),
    [sessions],
  );

  useEffect(() => {
    if (liveSessions.length === 0) return undefined;
    setExpandedSession((current) => (
      liveSessions.some((session) => session.id === current)
        ? current
        : liveSessions[0].id
    ));
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [liveSessions]);
  const enabledPlatforms = platforms.filter(
    (platform) => platform.present !== false && platform.enabled,
  );
  const configuredPlatforms = platforms.filter((platform) => platform.present !== false);
  const capacity = enabledPlatforms.reduce(
    (total, platform) => total + (Number(platform.parallelism) || 0),
    0,
  );
  const sessionMachine = liveSessions.find((session) => (
    session?.agent_setup?.machine
    && Date.now() - Date.parse(session?.last_activity_at || session?.activated_at || '') < 45_000
  ));
  const effectivePresence = runnerPresence || (sessionMachine ? {
    live: true,
    machine: { hostname: sessionMachine.agent_setup.machine },
    platforms: liveSessions.map((session) => ({ name: session.agent_setup?.platform || session.platform })),
    capacity,
  } : null);
  const observedCapacity = Number(effectivePresence?.capacity);
  const shownCapacity = Number.isFinite(observedCapacity) && observedCapacity > 0
    ? observedCapacity
    : capacity;
  const observedPlatforms = Array.isArray(effectivePresence?.platforms)
    ? [...new Set(effectivePresence.platforms.map((item) => item?.name).filter(Boolean))]
    : [];

  function update(id, patch) {
    setPlatforms((current) => current.map((platform) => (
      platform.id === id ? { ...platform, ...patch, present: true } : platform
    )));
  }

  function addCommandAgent() {
    const id = nextCustomId(platforms);
    setPlatforms((current) => [...current, {
      id,
      name: id,
      adapter: 'command',
      command: [],
      model: '',
      effort: '',
      parallelism: 1,
      enabled: false,
      present: true,
      custom: true,
      commandWasString: false,
    }]);
    setExpanded(id);
  }

  function resetDraft() {
    setPlatforms(defaultPlatforms());
    setWorkspace({ ...DEFAULT_WORKSPACE });
    setExpanded('');
  }

  function updateRepository(repository) {
    setWorkspace((current) => workspaceWithRepository(current, repository));
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

  function invalidateConnection() {
    setRunnerConnection('idle');
    setRunnerStatus(null);
    setRunnerLastSeen(null);
    setMachineBaseline(null);
    setRestartNeeded(false);
    setRunnerMessage('');
  }

  async function copy(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  async function connectRunner() {
    if (!pairingToken.trim()) {
      const error = 'Enter the pairing token printed by the local runner.';
      setRunnerMessage(error);
      return { ok: false, error };
    }
    setRunnerConnection('connecting');
    setRunnerMessage('');
    try {
      await ensureRunnerTransport(runnerUrl);
      let status = await runnerRequest({
        url: runnerUrl, token: pairingToken, path: '/status',
      });
      const settings = await runnerRequest({
        url: runnerUrl, token: pairingToken, path: '/settings',
      });
      const hydrated = draftFromSettings(settings);
      const hydratedConfig = configFromDraft(hydrated.platforms, hydrated.workspace);
      if (
        status?.credential_required === true
        && status?.credential_configured === false
      ) {
        let minted = null;
        try {
          minted = await api.createProjectKey(projectId);
          await runnerRequest({
            url: runnerUrl,
            token: pairingToken,
            method: 'PUT',
            path: '/credential',
            body: { key: minted.secret },
          });
          status = { ...status, credential_configured: true };
        } catch (error) {
          if (minted?.key?.id) {
            api.revokeProjectKey(projectId, minted.key.id).catch(() => {});
          }
          throw new Error(
            error?.message || 'Could not provision the runner credential.',
          );
        }
      }
      setPlatforms(hydrated.platforms);
      setWorkspace(hydrated.workspace);
      setMachineBaseline(configSignature(hydratedConfig));
      setRunnerStatus(status);
      setRunnerLastSeen(Date.now());
      setRestartNeeded(false);
      setRunnerConnection('connected');
      setRunnerMessage('');
      return { ok: true, status };
    } catch (error) {
      const message = connectFailureMessage(error);
      if (machineBaseline === null) {
        setRunnerConnection('idle');
        setRunnerStatus(null);
        setRunnerLastSeen(null);
      } else {
        // Preserve the last known identity so the status card can say which
        // machine went offline instead of collapsing back to "not connected".
        setRunnerConnection('unreachable');
      }
      setRunnerMessage(message);
      return { ok: false, error: message };
    }
  }

  async function applyRunnerSettings() {
    if (!connected || machineBaseline === null) {
      return { ok: false, error: 'Pair the runner machine first.' };
    }
    if (!validation.valid) {
      return { ok: false, error: 'Fix the highlighted fields first.' };
    }
    if (!dirty) return { ok: true, skipped: true };
    setRunnerConnection('applying');
    setRunnerMessage('');
    try {
      const response = await runnerRequest({
        url: runnerUrl, token: pairingToken, method: 'PUT', body: draftConfig,
      });
      const hydrated = draftFromSettings(response);
      const hydratedConfig = configFromDraft(hydrated.platforms, hydrated.workspace);
      const needsRestart = Boolean(response?.restart_required && runnerStatus?.runner_active);
      setPlatforms(hydrated.platforms);
      setWorkspace(hydrated.workspace);
      setMachineBaseline(configSignature(hydratedConfig));
      setRestartNeeded(needsRestart);
      setRunnerConnection('connected');
      setRunnerMessage('Saved to the runner machine.');
      return { ok: true, restartRequired: needsRestart };
    } catch (error) {
      const message = error?.message || 'Could not save runner settings.';
      setRunnerConnection('connected');
      setRunnerMessage(message);
      return { ok: false, error: message };
    }
  }

  async function startConfiguredRunner() {
    try {
      const response = await runnerRequest({
        url: runnerUrl,
        token: pairingToken,
        method: 'POST',
        path: '/start',
        body: { project_id: projectId },
      });
      setRunnerConnection('connecting');
      setRunnerMessage('');
      return { ok: true, response };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'Could not start the runner.',
      };
    }
  }

  function markRunnerLive(status) {
    setRunnerStatus(status);
    setRunnerLastSeen(Date.now());
    setRunnerConnection('connected');
  }

  const runnerView = runnerPresentation({
    connection: runnerConnection,
    status: runnerStatus,
    projectId,
  });
  const observedMachine = effectivePresence?.machine || {};
  const runnerKnown = paired || Boolean(effectivePresence);
  const machineName = effectivePresence
    ? (observedMachine.hostname || 'Runner')
    : runnerView.machineName;
  const machineDetails = effectivePresence
    ? [
      observedMachine.system === 'Darwin' ? 'macOS' : observedMachine.system,
      observedMachine.architecture,
    ].filter(Boolean).join(' · ')
    : runnerView.machineDetails;
  const machineTone = effectivePresence
    ? (effectivePresence.live ? 'live' : 'error')
    : runnerView.tone;
  const machineState = effectivePresence
    ? (effectivePresence.live ? 'Live' : 'Offline')
    : runnerView.state;
  return (
    <>
      <section className="aru-scope" aria-label="Auto-run status">
        <header className="aru-scope-head">
          <h2 className="aru-scope-title">Auto-run</h2>
        </header>
        <div className="aru-card aru-overview">
          <div className="aru-machine">
            <span className={`aru-live-dot aru-live-dot--${machineTone}`} aria-hidden="true" />
            <div className="aru-machine-name">
              <strong>{runnerKnown ? machineName : 'Connect a runner'}</strong>
              {runnerKnown && machineDetails && <span>{machineDetails}</span>}
            </div>
            {runnerKnown && (
              <span className={`aru-status aru-status--${machineTone}`}>
                {machineState}
              </span>
            )}
          </div>
          <div className="aru-overview-actions">
            {paired ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={runnerConnection === 'connecting' || runnerConnection === 'applying'}
                  onClick={connectRunner}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setConfigOpen((open) => !open)}
                >
                  Settings
                </button>
              </>
            ) : effectivePresence ? (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setManualOpen(true);
                    setConfigOpen(true);
                  }}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setWizardOpen(true)}
                >
                  Setup guide
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => setWizardOpen(true)}
                >
                  Set up runner
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setManualOpen(true);
                    setConfigOpen(true);
                  }}
                >
                  Pair manually
                </button>
              </>
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
              <strong>{shownCapacity}</strong>
              <small>{shownCapacity === 1 ? 'slot' : 'slots'}</small>
            </span>
            <span className="aru-fact aru-fact--wide">
              <strong>
                {observedPlatforms.join(', ')
                  || enabledPlatforms.map((platform) => platform.name).join(', ')
                  || 'No agents'}
              </strong>
              <small>enabled</small>
            </span>
          </div>
        </div>

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
                  {halting ? 'Stopping…' : 'Stop'}
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
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {!sessionError && recentSessions.length > 0 && (
          <section className="aru-jobs aru-jobs--recent" aria-label="Recent jobs">
            <div className="aru-section-head">
              <span className="aru-section-title">Recent</span>
            </div>
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
          </section>
        )}

        <details
          className="aru-settings"
          open={configOpen}
          onToggle={(event) => setConfigOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>Runner settings</strong>
              <small>
                {enabledPlatforms.length} {enabledPlatforms.length === 1 ? 'agent' : 'agents'}
                {' · '}{workspace.repository || 'No repository'}
              </small>
            </span>
            <span className="aru-settings-action">{configOpen ? 'Close' : 'Open'}</span>
          </summary>
          <div className="aru-settings-body">
            <div className="aru-settings-head">
              <span>Machine connection</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setWizardOpen(true)}
              >
                Setup guide
              </button>
            </div>
        {(paired || manualOpen) && (<>
        <div className="aru-card aru-pairing">
          <label>
            <span>Local runner URL</span>
            <input
              className="auth-input mono"
              value={runnerUrl}
              onChange={(event) => {
                setRunnerUrl(event.target.value);
                invalidateConnection();
              }}
            />
          </label>
          <label>
            <span>Pairing token</span>
            <input
              className="auth-input mono"
              type="password"
              autoComplete="off"
              value={pairingToken}
              placeholder="Paste from the runner terminal"
              onChange={(event) => {
                setPairingToken(event.target.value);
                invalidateConnection();
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={runnerConnection === 'connecting' || runnerConnection === 'applying'}
            onClick={connectRunner}
          >
            {runnerConnection === 'connecting' ? 'Connecting…' : connected ? 'Reload' : 'Connect'}
          </button>
        </div>
        {runnerMessage && (
          <p className="aru-pairing-status" role="status">{runnerMessage}</p>
        )}
        {!connected && (
          <p className="aru-note aru-pairing-hint">
            Run <code>{installCommand}</code> on that machine. It installs the
            standalone runner, starts the service, and prints the pairing token.
          </p>
        )}

        <div className="aru-subsection">
          <div className="aru-subhead">
            <div>
              <span className="aru-label">Agents</span>
              <span className="aru-note">
                {enabledPlatforms.length === 0
                  ? 'None enabled'
                  : `${enabledPlatforms.length} enabled · ${capacity} ${capacity === 1 ? 'slot' : 'slots'}`}
              </span>
            </div>
            <div className="page-actions">
              {!connected && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={resetDraft}>
                  Reset draft
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--sm" onClick={addCommandAgent}>
                Add custom agent
              </button>
            </div>
          </div>

          <div className="aru-platform-list">
            {configuredPlatforms.map((platform) => {
              const capabilities = capabilitiesFor(platform.adapter);
              const errors = validation.platforms[platform.id] || {};
              const hasErrors = Object.keys(errors).length > 0;
              const open = expanded === platform.id;
              return (
                <article
                  className={`aru-platform${platform.enabled ? '' : ' aru-platform--off'}`}
                  key={platform.id}
                >
                  <div className="aru-platform-row">
                    <Switch
                      checked={platform.enabled}
                      onChange={(next) => update(platform.id, { enabled: next })}
                      label={`Enable ${platform.name}`}
                    />
                    <button
                      type="button"
                      className="aru-platform-name"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? '' : platform.id)}
                    >
                      <strong>{platform.name}</strong>
                      <small>
                        {platform.custom
                          ? `${platform.adapter} adapter · ${platform.id}`
                          : 'Native adapter'}
                      </small>
                    </button>
                    <span className="aru-platform-summary mono">
                      {platformSummary(platform)}
                    </span>
                    {hasErrors && (
                      <span className="aru-flag">needs attention</span>
                    )}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? '' : platform.id)}
                    >
                      {open ? 'Close' : 'Edit'}
                    </button>
                  </div>

                  {open && (
                    <div className="aru-platform-fields">
                      {(platform.custom || errors.adapter) && (
                        <label>
                          <span>Adapter</span>
                          <select
                            className="auth-input"
                            value={platform.adapter}
                            onChange={(event) => update(platform.id, { adapter: event.target.value })}
                          >
                            {ADAPTERS.map((adapter) => (
                              <option key={adapter} value={adapter}>{adapter}</option>
                            ))}
                          </select>
                          {errors.adapter && <small className="field-error">{errors.adapter}</small>}
                        </label>
                      )}
                      <label className="aru-command-field">
                        <span>Command arguments · one per line</span>
                        <textarea
                          className="auth-input mono"
                          rows="2"
                          value={platform.command.join('\n')}
                          placeholder={'agent-executable\n--optional-flag'}
                          onChange={(event) => update(platform.id, {
                            command: event.target.value ? event.target.value.split('\n') : [],
                            commandWasString: false,
                          })}
                        />
                        {errors.command && <small className="field-error">{errors.command}</small>}
                      </label>
                      {capabilities.model && (
                        <label>
                          <span>Model</span>
                          <input
                            className="auth-input"
                            value={platform.model}
                            placeholder="Platform default"
                            onChange={(event) => update(platform.id, { model: event.target.value })}
                          />
                        </label>
                      )}
                      {capabilities.effort && (
                        <label>
                          <span>Effort</span>
                          <input
                            className="auth-input"
                            value={platform.effort}
                            placeholder="Platform default"
                            onChange={(event) => update(platform.id, { effort: event.target.value })}
                          />
                        </label>
                      )}
                      <label>
                        <span>Parallel experiments</span>
                        <input
                          className="auth-input"
                          type="number"
                          min="1"
                          max="32"
                          value={platform.parallelism}
                          onChange={(event) => update(platform.id, { parallelism: event.target.value })}
                        />
                        {errors.parallelism && (
                          <small className="field-error">{errors.parallelism}</small>
                        )}
                      </label>
                      {platform.custom && (
                        <div className="aru-platform-remove">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setPlatforms((current) => current.filter((item) => item.id !== platform.id));
                              setExpanded('');
                            }}
                          >
                            Remove agent
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>

        <div className="aru-subsection">
          <div className="aru-subhead">
            <div>
              <span className="aru-label">Workspace</span>
            </div>
          </div>
          <div className="aru-workspace-fields">
            <label>
              <span>Repository</span>
              <input
                className="auth-input mono"
                value={workspace.repository}
                placeholder="/absolute/path/to/repository"
                onChange={(event) => updateRepository(event.target.value)}
              />
              {validation.workspace.repository && (
                <small className="field-error">{validation.workspace.repository}</small>
              )}
            </label>
            <label>
              <span>Worktree root</span>
              <input
                className="auth-input mono"
                value={workspace.root}
                placeholder="/absolute/path/to/worktrees"
                onChange={(event) => setWorkspace((current) => ({
                  ...current,
                  root: event.target.value,
                }))}
              />
              {validation.workspace.root && (
                <small className="field-error">{validation.workspace.root}</small>
              )}
            </label>
            <label>
              <span>Base ref</span>
              <input
                className="auth-input mono"
                value={workspace.base_ref}
                onChange={(event) => setWorkspace((current) => ({
                  ...current,
                  base_ref: event.target.value,
                }))}
              />
              {validation.workspace.base_ref && (
                <small className="field-error">{validation.workspace.base_ref}</small>
              )}
            </label>
          </div>
        </div>

        {!validation.valid && (
          <div className="aru-validation" role="alert">
            <strong>Fix the draft before applying or copying it.</strong>
            <ul>
              {[...new Set(validation.messages)].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="aru-apply">
          <span className="aru-note">
            {connected
              ? (dirty
                ? 'Unsaved changes for the paired machine.'
                : (restartNeeded
                  ? 'Saved. The active runner still uses its old settings — restart it.'
                  : 'Machine settings are current.'))
              : (runnerConnection === 'unreachable'
                ? 'Runner offline. Changes are kept in this browser.'
                : 'Pair the runner to apply changes.')}
          </span>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!connected || machineBaseline === null || !dirty || !validation.valid}
            onClick={applyRunnerSettings}
          >
            {runnerConnection === 'applying' ? 'Applying…' : 'Apply to machine'}
          </button>
        </div>

        <details className="aru-manual">
          <summary>JSON fallback</summary>
          <div className="aru-manual-head">
            <p>
              Merge into <code>~/.merv/client.json</code> on the runner machine.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!validation.valid}
              onClick={() => copy('config', config)}
            >
              {copied === 'config' ? 'Copied' : 'Copy config'}
            </button>
          </div>
          <pre className="aru-config mono"><code>{config}</code></pre>
        </details>

        <div className="aru-subsection">
          <div className="aru-subhead">
            <div>
              <span className="aru-label">Start claiming</span>
            </div>
          </div>
          <div className="aru-command">
            <code className="mono">{runCommand}</code>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('run', runCommand)}>
              {copied === 'run' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        </>)}
          </div>
        </details>
      </section>

      {wizardOpen && (
        <AutorunSetupWizard
          projectId={projectId}
          runnerUrl={runnerUrl}
          pairingToken={pairingToken}
          onPairingToken={setPairingToken}
          startConnected={connected}
          runnerStatus={runnerStatus}
          platforms={platforms}
          workspace={workspace}
          validation={validation}
          onUpdatePlatform={update}
          onWorkspace={(patch) => {
            if (Object.hasOwn(patch, 'repository')) updateRepository(patch.repository);
            else setWorkspace((current) => ({ ...current, ...patch }));
          }}
          onConnect={connectRunner}
          onApply={applyRunnerSettings}
          onStart={startConfiguredRunner}
          onRunnerLive={markRunnerLive}
          dispatch={dispatch}
          dispatchBusy={dispatchBusy}
          onDispatch={toggleDispatch}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
