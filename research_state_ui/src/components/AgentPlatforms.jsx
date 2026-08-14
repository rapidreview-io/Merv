import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import AutorunSetupWizard from './AutorunSetupWizard';
import Switch from './Switch';
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
        base_ref: typeof saved.base_ref === 'string' ? saved.base_ref : 'HEAD',
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

function ScopeHead({ title, tag, children }) {
  return (
    <header className="aru-scope-head">
      <h2 className="aru-scope-title">{title}</h2>
      <span className="aru-scope-tag">{tag}</span>
      {children}
    </header>
  );
}

export default function AgentPlatforms({ projectId }) {
  const [platforms, setPlatforms] = useState(readDraft);
  const [workspace, setWorkspace] = useState(readWorkspace);
  const [copied, setCopied] = useState('');
  const [expanded, setExpanded] = useState('');
  const [sessions, setSessions] = useState(null);
  const [sessionError, setSessionError] = useState('');
  const [runnerUrl, setRunnerUrl] = useState(LOCAL_RUNNER_URL);
  const [pairingToken, setPairingToken] = useState('');
  const [runnerConnection, setRunnerConnection] = useState('idle');
  const [runnerMessage, setRunnerMessage] = useState('');
  const [runnerStatus, setRunnerStatus] = useState(null);
  const [machineBaseline, setMachineBaseline] = useState(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [dispatch, setDispatch] = useState(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState('');
  const [halting, setHalting] = useState(false);
  const [showHaltPrompt, setShowHaltPrompt] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
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
          setSessionError('');
        }
      } catch {
        if (!disposed) setSessionError('Session status is unavailable.');
      }
    }
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [projectId]);

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
  const runnerBin = '$HOME/.merv/bin/merv-agent-runner';
  const installCommand = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
  const runCommand = `${runnerBin} --project ${projectId || 'PROJECT_ID'}`;
  const liveSessions = useMemo(
    () => (sessions || []).filter(
      (session) => session.status === 'offered' || session.status === 'active',
    ),
    [sessions],
  );
  const enabledPlatforms = platforms.filter(
    (platform) => platform.present !== false && platform.enabled,
  );
  const capacity = enabledPlatforms.reduce(
    (total, platform) => total + (Number(platform.parallelism) || 0),
    0,
  );

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
      setRestartNeeded(false);
      setRunnerConnection('connected');
      setRunnerMessage('');
      return { ok: true, status };
    } catch (error) {
      const message = connectFailureMessage(error);
      setRunnerConnection('idle');
      setRunnerStatus(null);
      setMachineBaseline(null);
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
      setPlatforms(hydrated.platforms);
      setWorkspace(hydrated.workspace);
      setMachineBaseline(configSignature(hydratedConfig));
      setRestartNeeded(Boolean(response?.restart_required && runnerStatus?.runner_active));
      setRunnerConnection('connected');
      setRunnerMessage('Saved to the runner machine.');
      return { ok: true };
    } catch (error) {
      const message = error?.message || 'Could not save runner settings.';
      setRunnerConnection('connected');
      setRunnerMessage(message);
      return { ok: false, error: message };
    }
  }

  const machineState = connected
    ? (runnerStatus?.runner_active
      ? `Runner active · ${runnerStatus.project_id || 'project unknown'}`
      : 'Paired · runner stopped')
    : (runnerConnection === 'connecting' ? 'Connecting…' : 'Not paired');

  return (
    <>
      <section className="aru-scope" aria-label="Project dispatch">
        <ScopeHead title="Automatic dispatch" tag="This project" />
        <div className="aru-card aru-dispatch">
          <Switch
            checked={dispatch === true}
            disabled={dispatch === null || dispatchBusy || !projectId}
            onChange={toggleDispatch}
            label="Automatic dispatch"
          />
          <div>
            <strong>
              {dispatch === null
                ? 'Loading…'
                : dispatch
                  ? 'Runners may claim this project’s work'
                  : 'Nothing is dispatched'}
            </strong>
            <p>
              While this is on, any runner started for this project claims its
              experiments, reviews, and consolidations as soon as they appear.
              Turning it off stops new claims only; running sessions finish
              unless you stop them.
            </p>
          </div>
        </div>

        {showHaltPrompt && liveSessions.length > 0 && (
          <div className="aru-card aru-halt" role="status">
            <p>
              {liveSessions.length === 1
                ? '1 session is still running.'
                : `${liveSessions.length} sessions are still running.`}
              {' '}
              Stop them now to end their agent processes; committed work is kept.
            </p>
            <div className="page-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={haltSessions}
                disabled={halting}
              >
                {halting ? 'Stopping…' : 'Stop them now'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setShowHaltPrompt(false)}
                disabled={halting}
              >
                Let them finish
              </button>
            </div>
          </div>
        )}

        {dispatchError && (
          <p className="aru-error" role="alert">{dispatchError}</p>
        )}

        <div className="aru-workers">
          <div className="aru-workers-head">
            <span className="aru-label">Workers</span>
            {liveSessions.length > 0 && !showHaltPrompt && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={haltSessions}
                disabled={halting}
              >
                {halting ? 'Stopping…' : `Stop ${liveSessions.length} running`}
              </button>
            )}
          </div>
          {sessionError ? (
            <span className="aru-note">{sessionError}</span>
          ) : sessions === null ? (
            <span className="aru-note">Loading…</span>
          ) : sessions.length === 0 ? (
            <span className="aru-note">
              No agent sessions yet. Sessions appear here once a runner claims work.
            </span>
          ) : (
            <div className="aru-worker-list">
              {sessions.slice(0, 8).map((session) => (
                <div className="aru-worker-row" key={session.id}>
                  <span>
                    <strong>{session.platform}</strong>
                    <small className="mono">{session.experiment_id}</small>
                    {session.workspace_ref && (
                      <small className="mono">{session.workspace_ref}</small>
                    )}
                  </span>
                  <span className={`mcpk-state mcpk-state--${session.status}`}>
                    {session.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="aru-scope" aria-label="Runner machine">
        <ScopeHead title="Runner machine" tag="Applies to one paired machine">
          {connected ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setWizardOpen(true)}
            >
              Setup guide
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setManualOpen((open) => !open)}
            >
              {manualOpen ? 'Hide manual setup' : 'Manual setup'}
            </button>
          )}
          <span className={`aru-conn aru-conn--${connected ? 'ok' : 'off'}`}>
            {machineState}
          </span>
        </ScopeHead>
        <p className="settings-summary">
          Agents, models, and the workspace live in <code>~/.merv/client.json</code>
          {' '}on the machine that runs them. Enabled agents run unattended with
          your machine account’s filesystem and network permissions; worktrees
          isolate Git changes, not operating-system access.
        </p>

        {!connected && (
          <div className="aru-setup-cta">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setWizardOpen(true)}
            >
              Set up auto running
            </button>
            <span className="aru-note">
              The guided setup starts the settings service on that machine,
              pairs it, picks agents, and brings the runner up — each step
              verified before the next.
            </span>
          </div>
        )}

        {(connected || manualOpen) && (<>
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
                  : `${enabledPlatforms.length} enabled · up to ${capacity} parallel ${capacity === 1 ? 'session' : 'sessions'}`}
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
            {platforms.map((platform) => {
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
              <span className="aru-note">
                Every experiment gets a persistent Git worktree, so parallel
                agents never share a checkout.
              </span>
            </div>
          </div>
          <div className="aru-workspace-fields">
            <label>
              <span>Repository</span>
              <input
                className="auth-input mono"
                value={workspace.repository}
                placeholder="/absolute/path/to/repository"
                onChange={(event) => setWorkspace((current) => ({
                  ...current,
                  repository: event.target.value,
                }))}
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
              : 'Not paired — this draft lives only in your browser until you apply it or merge it manually.'}
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
          <summary>Manual fallback · copy the draft as JSON</summary>
          <div className="aru-manual-head">
            <p>
              If the loopback service is unavailable, merge this draft into
              <code> ~/.merv/client.json</code> on the runner machine. Only
              <code> agent_workspace</code> and <code>agent_platforms</code> are
              written; other configuration is preserved. Each command line is one
              exact argument; shell expansion is never used.
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
              <span className="aru-note">
                Run this on the configured machine and keep it running.
                {dispatch === false && ' Automatic dispatch is off, so it will idle until you turn dispatch on above.'}
              </span>
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
          onWorkspace={(patch) => setWorkspace((current) => ({ ...current, ...patch }))}
          onConnect={connectRunner}
          onApply={applyRunnerSettings}
          onRunnerLive={setRunnerStatus}
          dispatch={dispatch}
          dispatchBusy={dispatchBusy}
          onDispatch={toggleDispatch}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
