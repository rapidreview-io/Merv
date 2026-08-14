import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Switch from './Switch';
import { connectRunnerBridge, runnerRequest } from './runnerClient';

/**
 * AutorunSetupWizard — the guided first-run flow for auto running.
 *
 * The setup crosses two surfaces (this browser and a terminal on the runner
 * machine), so the wizard verifies each hop instead of trusting a checklist:
 * it polls /health until the settings service exists, pairs against it,
 * edits the same draft the panel owns, applies it, asks the settings process
 * to become the runner, then verifies that project is live. Dispatch is the
 * final step so the flow ends where claiming actually begins.
 */

const POLL_MS = 2000;

function CommandRow({ command, copied, onCopy }) {
  return (
    <div className="aru-command">
      <code className="mono">{command}</code>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function AutorunSetupWizard({
  projectId,
  runnerUrl,
  pairingToken,
  onPairingToken,
  startConnected,
  runnerStatus,
  platforms,
  workspace,
  validation,
  onUpdatePlatform,
  onWorkspace,
  onConnect,
  onApply,
  onStart,
  onRunnerLive,
  dispatch,
  dispatchBusy,
  onDispatch,
  onClose,
}) {
  // Capture the entry state once: pairing succeeds mid-flow, and the step
  // list must not rebuild under the current index when it does.
  const [enteredConnected] = useState(startConnected);
  const steps = useMemo(
    () => (enteredConnected
      ? ['agents', 'workspace', 'apply', 'run', 'done']
      : ['service', 'pair', 'agents', 'workspace', 'apply', 'run', 'done']),
    [enteredConnected],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState('');
  const [serviceBlocked, setServiceBlocked] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [serviceError, setServiceError] = useState('');
  const [applyState, setApplyState] = useState({ phase: 'idle' });
  const [startState, setStartState] = useState({ phase: 'idle' });
  const [startAttempt, setStartAttempt] = useState(0);
  const [copied, setCopied] = useState('');
  const applyRun = useRef(0);
  const startRequested = useRef(false);
  const serviceAdvanced = useRef(false);
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  const settingsCommand = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
  const runnerBin = '$HOME/.merv/bin/merv-agent-runner';
  const runCommand = `${runnerBin} --project ${projectId || 'PROJECT_ID'}`;
  const available = runnerStatus?.available_commands;
  const enabledPlatforms = platforms.filter(
    (platform) => platform.present !== false && platform.enabled,
  );
  const missingEnabled = available
    ? enabledPlatforms.filter(
      (platform) => available[platform.command[0]] === false,
    )
    : [];

  const next = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setStepIndex((i) => Math.max(i - 1, 0));
  const advanceService = () => {
    if (serviceAdvanced.current) return;
    serviceAdvanced.current = true;
    next();
  };

  async function copy(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  // ---- service step: advance the moment the loopback service answers ----
  useEffect(() => {
    if (step !== 'service') return undefined;
    let disposed = false;
    async function probe() {
      try {
        const health = await runnerRequest({ url: runnerUrl, token: '', path: '/health' });
        if (!disposed && health?.ok) advanceService();
      } catch {
        if (!disposed) setServiceBlocked(true);
      }
    }
    probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, runnerUrl]);

  async function connectService() {
    setServiceBusy(true);
    setServiceError('');
    try {
      await connectRunnerBridge(runnerUrl);
      const health = await runnerRequest({ url: runnerUrl, token: '', path: '/health' });
      if (!health?.ok) throw new Error('The local runner did not report healthy.');
      advanceService();
    } catch (error) {
      setServiceError(error?.message || 'Could not open the local runner connection.');
    } finally {
      setServiceBusy(false);
    }
  }

  // ---- apply step: save to the machine as soon as the step opens ----
  useEffect(() => {
    if (step !== 'apply') return undefined;
    const run = ++applyRun.current;
    let disposed = false;
    (async () => {
      setApplyState({ phase: 'running' });
      const result = await onApply();
      if (disposed || run !== applyRun.current) return;
      if (result.ok) {
        setApplyState({ phase: 'ok', restartRequired: result.restartRequired === true });
        next();
      } else {
        setApplyState({ phase: 'failed', detail: result.error });
      }
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- run step: hand settings-only mode to the runner, then verify it ----
  useEffect(() => {
    if (step !== 'run' || startRequested.current) return undefined;
    startRequested.current = true;
    if (applyState.restartRequired) {
      setStartState({ phase: 'restart' });
      return undefined;
    }
    (async () => {
      setStartState({ phase: 'starting' });
      const result = await onStart();
      setStartState(result.ok
        ? { phase: 'waiting' }
        : { phase: 'failed', detail: result.error });
    })();
    return undefined;
    // startAttempt deliberately re-arms this one-shot request after Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, startAttempt]);

  useEffect(() => {
    if (step !== 'run') return undefined;
    let disposed = false;
    async function probe() {
      try {
        const status = await runnerRequest({
          url: runnerUrl, token: pairingToken, path: '/status',
        });
        if (
          !disposed
          && status?.runner_active
          && String(status.project_id || '') === String(projectId || '')
        ) {
          onRunnerLive(status);
          next();
        }
      } catch {
        // The same process briefly closes the settings socket while it
        // switches into runner mode. Keep polling through that handoff.
      }
    }
    probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, runnerUrl, pairingToken, projectId]);

  async function pair() {
    setPairBusy(true);
    setPairError('');
    const result = await onConnect();
    setPairBusy(false);
    if (result.ok) next();
    else setPairError(result.error || 'Could not connect to the local runner.');
  }

  function retryStart() {
    startRequested.current = false;
    setStartAttempt((attempt) => attempt + 1);
  }

  const stepNumber = Math.min(stepIndex, steps.length - 1) + 1;

  return createPortal(
    <div className="retention-modal-overlay" onMouseDown={onClose}>
      <div
        className="retention-modal sbxpw"
        role="dialog"
        aria-modal="true"
        aria-label="Set up auto running"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="retention-modal-head">
          <div className="retention-modal-head-main">
            <h2 className="retention-modal-title">Set up auto running</h2>
          </div>
          <button type="button" className="retention-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sbxpw-progress">
          <span className="sbxpw-bar" aria-hidden="true">
            <span style={{ width: `${(stepNumber / steps.length) * 100}%` }} />
          </span>
          <span className="sbxpw-count">Step {stepNumber} of {steps.length}</span>
        </div>

        {step === 'service' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Install the runner</p>
            <p className="sbxpw-help">
              Run this on the machine that will run your agents. Setup continues
              when Merv connects.
            </p>
            <CommandRow
              command={settingsCommand}
              copied={copied === 'service'}
              onCopy={() => copy('service', settingsCommand)}
            />
            <p className="aruw-command-note">
              Requires Python 3.11+ and Git. Remote machine? Use{' '}
              <code>ssh -L 8791:127.0.0.1:8791 HOST</code>.
            </p>
            {serviceBlocked ? (
              <div className="aruw-poll" role="status">
                <button
                  type="button"
                  className="sbxp-save"
                  disabled={serviceBusy}
                  onClick={connectService}
                >
                  {serviceBusy ? 'Connecting…' : 'Connect to the runner'}
                </button>
                <span>
                  Your browser needs permission to connect to this machine.
                </span>
              </div>
            ) : (
              <div className="aruw-poll" role="status">
                <span className="sbxpw-spinner" aria-hidden="true" />
                Waiting for the runner…
              </div>
            )}
            {serviceError && <p className="sbxpw-fail-detail">{serviceError}</p>}
          </div>
        )}

        {step === 'pair' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Pair the runner</p>
            <p className="sbxpw-help">
              Paste the pairing token shown in the terminal. It stays in this tab.
            </p>
            <input
              className="sbxpw-input"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={pairingToken}
              placeholder="Paste from the runner terminal"
              onChange={(e) => onPairingToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && pairingToken.trim()) pair(); }}
            />
            {pairError && <p className="sbxpw-fail-detail">{pairError}</p>}
            <p className="aruw-command-note">
              Need the token again?
            </p>
            <CommandRow
              command={`${runnerBin} --show-pairing-token`}
              copied={copied === 'token'}
              onCopy={() => copy('token', `${runnerBin} --show-pairing-token`)}
            />
          </div>
        )}

        {step === 'agents' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Choose agents</p>
            <p className="sbxpw-help">
              {available
                ? 'Availability is checked on the runner machine.'
                : 'Select at least one agent.'}
            </p>
            <div className="aruw-agents">
              {platforms.filter((platform) => !platform.custom).map((platform) => {
                const found = available ? available[platform.command[0]] : undefined;
                return (
                  <div className="aruw-agent" key={platform.id}>
                    <Switch
                      checked={platform.enabled}
                      onChange={(value) => onUpdatePlatform(platform.id, { enabled: value })}
                      label={`Enable ${platform.name}`}
                    />
                    <span className="aruw-agent-name">
                      <strong>{platform.name}</strong>
                      <small className="mono">{platform.command[0] || 'no command'}</small>
                    </span>
                    {found === true && <span className="aruw-tag aruw-tag--ok">installed</span>}
                    {found === false && <span className="aruw-tag aruw-tag--missing">not found</span>}
                    <label className="aruw-par">
                      <span aria-hidden="true">×</span>
                      <input
                        type="number"
                        min="1"
                        max="32"
                        aria-label={`${platform.name} parallel experiments`}
                        value={platform.parallelism}
                        onChange={(e) => onUpdatePlatform(platform.id, { parallelism: e.target.value })}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
            {missingEnabled.length > 0 && (
              <p className="aruw-warn">
                {missingEnabled.map((platform) => platform.name).join(', ')}
                {missingEnabled.length === 1 ? ' is' : ' are'} not installed on
                this machine.
              </p>
            )}
          </div>
        )}

        {step === 'workspace' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Choose the repository</p>
            <p className="sbxpw-help">
              Use paths on the runner machine. Each job gets its own Git worktree.
            </p>
            <div className="aruw-fields">
              <label>
                <span>Repository</span>
                <input
                  className="sbxpw-input mono"
                  value={workspace.repository}
                  placeholder="/absolute/path/to/repository"
                  onChange={(e) => onWorkspace({ repository: e.target.value })}
                />
                {validation.workspace.repository && (
                  <small className="field-error">{validation.workspace.repository}</small>
                )}
              </label>
              <label>
                <span>Worktree root</span>
                <input
                  className="sbxpw-input mono"
                  value={workspace.root}
                  placeholder="/absolute/path/to/worktrees"
                  onChange={(e) => onWorkspace({ root: e.target.value })}
                />
                {validation.workspace.root && (
                  <small className="field-error">{validation.workspace.root}</small>
                )}
              </label>
              <label>
                <span>Base ref</span>
                <input
                  className="sbxpw-input mono"
                  value={workspace.base_ref}
                  onChange={(e) => onWorkspace({ base_ref: e.target.value })}
                />
                {validation.workspace.base_ref && (
                  <small className="field-error">{validation.workspace.base_ref}</small>
                )}
              </label>
            </div>
          </div>
        )}

        {step === 'apply' && (
          <div className="sbxpw-body sbxpw-body--center">
            {applyState.phase !== 'failed' ? (
              <>
                <span className="sbxpw-spinner" aria-hidden="true" />
                <p className="sbxpw-lead">Saving settings</p>
                <p className="sbxpw-help">
                  Writing agents and repository to <code>~/.merv/client.json</code>.
                </p>
              </>
            ) : (
              <>
                <p className="sbxpw-fail">Could not save</p>
                <p className="sbxpw-fail-detail">{applyState.detail}</p>
              </>
            )}
          </div>
        )}

        {step === 'run' && (
          <div className="sbxpw-body sbxpw-body--center">
            {startState.phase === 'failed' ? (
              <>
                <p className="sbxpw-fail">Could not start the runner</p>
                <p className="sbxpw-fail-detail">{startState.detail}</p>
              </>
            ) : startState.phase === 'restart' ? (
              <>
                <p className="sbxpw-lead">Restart the runner</p>
                <p className="sbxpw-help">Settings are saved. Restart the active runner to use them.</p>
                <CommandRow
                  command={runCommand}
                  copied={copied === 'run'}
                  onCopy={() => copy('run', runCommand)}
                />
              </>
            ) : (
              <>
                <span className="sbxpw-spinner" aria-hidden="true" />
                <p className="sbxpw-lead">Starting the runner</p>
                <p className="sbxpw-help">
                  {startState.phase === 'waiting'
                    ? 'The runner is starting for this project.'
                    : 'Switching the terminal from setup to auto-run.'}
                </p>
              </>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="sbxpw-body sbxpw-body--center">
            <span className="sbxpw-check" aria-hidden="true">✓</span>
            <p className="sbxpw-lead">Runner is live</p>
            <div className="sbxpw-finish-row">
              {dispatch === true ? (
                <span className="sbxpw-enabled-note">
                  Dispatch is on. New work will start automatically.
                </span>
              ) : (
                <button
                  type="button"
                  className="sbxp-save"
                  disabled={dispatchBusy || dispatch === null}
                  onClick={() => onDispatch(true)}
                >
                  {dispatchBusy ? 'Turning on…' : 'Turn on automatic dispatch'}
                </button>
              )}
            </div>
            {dispatch === false && (
              <p className="sbxpw-help">
                Turn on dispatch to start new work automatically.
              </p>
            )}
          </div>
        )}

        <div className="sbxpw-nav">
          {(step === 'agents' || step === 'workspace') && stepIndex > 0 && (
            <button type="button" className="sbxpw-btn" onClick={back}>Back</button>
          )}
          {step === 'apply' && applyState.phase === 'failed' && (
            <button type="button" className="sbxpw-btn" onClick={back}>Back — fix a value</button>
          )}
          <span className="sbxpw-nav-spacer" />
          {step === 'pair' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={pairBusy || !pairingToken.trim()}
              onClick={pair}
            >
              {pairBusy ? 'Connecting…' : 'Connect'}
            </button>
          )}
          {step === 'agents' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={enabledPlatforms.length === 0}
              onClick={next}
            >
              Next
            </button>
          )}
          {step === 'workspace' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={!validation.valid}
              onClick={next}
            >
              Save & apply
            </button>
          )}
          {step === 'run' && startState.phase === 'failed' && (
            <button type="button" className="sbxpw-btn sbxpw-btn--primary" onClick={retryStart}>
              Retry
            </button>
          )}
          {step === 'done' && (
            <button type="button" className="sbxpw-btn sbxpw-btn--primary" onClick={onClose}>
              Finish
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
