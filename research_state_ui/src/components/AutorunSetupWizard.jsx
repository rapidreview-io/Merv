import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import RunnerSettingsForm from './RunnerSettingsForm';
import { runnerPresentation } from './runnerPresentation';

/**
 * AutorunSetupWizard — the guided first-run flow for auto running.
 *
 * Three steps, all through the brain: (1) install the runner and approve the
 * code it prints, then wait for that machine's first heartbeat; (2) choose
 * agents and the repository, saved as brain-held tuning the runner pulls on
 * its next poll; (3) turn on dispatch. The browser never addresses the
 * runner machine, so this works for a remote box, over SSH, and on a phone.
 */

const POLL_MS = 3000;
const INSTALL_COMMAND = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
const RUNNER_COMMAND = '$HOME/.merv/bin/merv-agent-runner';

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

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

function formatCode(value) {
  const code = normalizeCode(value);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export default function AutorunSetupWizard({
  projectId,
  forcePair = false,
  runners,
  selectedRef,
  onSelectRunner,
  onRefreshRunners,
  draft,
  validation,
  onUpdatePlatform,
  onRepository,
  onWorkspace,
  onSave,
  saveState,
  dispatch,
  dispatchBusy,
  onDispatch,
  onClose,
}) {
  // Capture the entry state once: a runner going live mid-flow must not
  // rebuild the step list under the current index. "Pair another runner"
  // always starts at the pairing step even when one machine is already live.
  const [enteredWithRunner] = useState(() => (
    !forcePair && (runners || []).some((runner) => runner.live)
  ));
  const steps = useMemo(
    () => (enteredWithRunner ? ['agents', 'done'] : ['pair', 'agents', 'done']),
    [enteredWithRunner],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [copied, setCopied] = useState('');
  const [code, setCode] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveError, setApproveError] = useState('');
  const [approved, setApproved] = useState(null); // { runner_ref, machine }
  const [localBrain, setLocalBrain] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);

  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const stepNumber = Math.min(stepIndex, steps.length - 1) + 1;

  // Escape closes; focus returns to where the wizard was opened from.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    function onKey(event) {
      if (event.key === 'Escape') closeRef.current?.();
    }
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused.current?.focus?.();
    };
  }, []);

  const approvedRunner = useMemo(
    () => (approved ? (runners || []).find((runner) => runner.runner_ref === approved.runner_ref) : null),
    [approved, runners],
  );

  // After approval, watch for that machine's first heartbeat.
  useEffect(() => {
    if (step !== 'pair' || !approved || approvedRunner?.live) return undefined;
    const timer = setInterval(() => onRefreshRunners?.(), POLL_MS);
    return () => clearInterval(timer);
  }, [step, approved, approvedRunner?.live, onRefreshRunners]);

  useEffect(() => {
    if (step === 'pair' && approvedRunner?.live) {
      onSelectRunner?.(approvedRunner.runner_ref);
      setStepIndex((current) => current + 1);
    }
  }, [step, approvedRunner?.live, approvedRunner?.runner_ref, onSelectRunner]);

  async function copy(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  async function approve() {
    const normalized = normalizeCode(code);
    if (normalized.length !== 8) {
      setApproveError('Enter the 8-character code shown by the runner.');
      return;
    }
    setApproveBusy(true);
    setApproveError('');
    try {
      const result = await api.approveRunnerPairing(projectId, normalized);
      setApproved({ runner_ref: result?.runner_ref || '', machine: result?.machine || {} });
      onRefreshRunners?.();
    } catch (error) {
      const status = Number(error?.status || 0);
      const errorCode = String(error?.data?.error_code || '');
      if (status === 404 && errorCode === 'not_found') {
        setApproveError('No runner is waiting with that code. Check the terminal and try again.');
      } else if (status === 404) {
        // The pairing routes exist only where owner key management exists;
        // a loopback brain has no auth and needs no runner credential.
        setLocalBrain(true);
      } else if (status === 429) {
        setApproveError('Too many wrong codes. Wait ten minutes, then try again.');
      } else if (status === 403) {
        setApproveError('Only a signed-in project owner can approve a runner.');
      } else {
        setApproveError(error?.message || 'Could not approve the pairing.');
      }
    } finally {
      setApproveBusy(false);
    }
  }

  const selected = (runners || []).find((runner) => runner.runner_ref === selectedRef) || null;
  const selectedView = runnerPresentation(selected);
  const enabledCount = draft.platforms.filter((platform) => platform.enabled).length;

  return createPortal(
    <div className="retention-modal-overlay">
      <div
        className="retention-modal sbxpw"
        role="dialog"
        aria-modal="true"
        aria-label="Set up auto running"
        tabIndex={-1}
        ref={dialogRef}
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

        {step === 'pair' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Install &amp; pair the runner</p>
            <p className="sbxpw-help">
              Run this on the machine that will run your agents — local, remote,
              or over SSH. It prints a short code.
            </p>
            <CommandRow
              command={INSTALL_COMMAND}
              copied={copied === 'install'}
              onCopy={() => copy('install', INSTALL_COMMAND)}
            />
            <p className="aruw-command-note">
              Requires Python 3.11+ and Git. Already installed? Run{' '}
              <code>{RUNNER_COMMAND} pair</code>.
            </p>
            {localBrain ? (
              <div className="aruw-poll" role="status">
                <span>
                  This brain runs locally and needs no pairing. Start the runner
                  with <code>{RUNNER_COMMAND} --project {projectId}</code>.
                </span>
              </div>
            ) : approved ? (
              <div className="aruw-poll" role="status">
                <span className="sbxpw-spinner" aria-hidden="true" />
                Approved — waiting for {approved.machine?.hostname || 'the runner'}…
              </div>
            ) : (
              <>
                <label className="aruw-code">
                  <span>Pairing code</span>
                  <input
                    className="sbxpw-input mono"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="XXXX-XXXX"
                    value={formatCode(code)}
                    onChange={(e) => { setCode(e.target.value); setApproveError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') approve(); }}
                    aria-label="Pairing code"
                  />
                </label>
                {approveError && <p className="sbxpw-fail-detail" role="alert">{approveError}</p>}
              </>
            )}
          </div>
        )}

        {step === 'agents' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Agents &amp; repository</p>
            <p className="sbxpw-help">
              {selected
                ? `Settings for ${selectedView.machineName}. Availability is checked on that machine.`
                : 'Pair a runner first.'}
            </p>
            <RunnerSettingsForm
              platforms={draft.platforms}
              custom={draft.custom}
              workspace={draft.workspace}
              validation={validation}
              availableCommands={selected?.inventory?.available_commands || null}
              onUpdatePlatform={onUpdatePlatform}
              onRepository={onRepository}
              onWorkspace={onWorkspace}
              compact
            />
            {saveState.error && <p className="sbxpw-fail-detail" role="alert">{saveState.error}</p>}
          </div>
        )}

        {step === 'done' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">
              {saveState.applied ? '✓ Settings applied' : '✓ Settings saved'}
            </p>
            <p className="sbxpw-help">
              {saveState.applied
                ? `${selectedView.machineName} is running your settings.`
                : `${selectedView.machineName} will apply them on its next poll.`}
            </p>
            {dispatch === true ? (
              <p className="aruw-done-note">Dispatch is on. New work will start automatically.</p>
            ) : (
              <>
                <button
                  type="button"
                  className="sbxp-save"
                  disabled={dispatch === null || dispatchBusy}
                  onClick={() => onDispatch(true)}
                >
                  {dispatchBusy ? 'Turning on…' : 'Turn on automatic dispatch'}
                </button>
                {dispatch === false && (
                  <p className="aruw-done-note">Turn on dispatch to start new work automatically.</p>
                )}
              </>
            )}
          </div>
        )}

        <div className="sbxpw-nav">
          {step === 'agents' && stepIndex > 0 && (
            <button type="button" className="sbxpw-btn" onClick={() => setStepIndex((i) => i - 1)}>Back</button>
          )}
          <span className="sbxpw-nav-spacer" />
          {step === 'pair' && !approved && !localBrain && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={approveBusy || normalizeCode(code).length !== 8}
              onClick={approve}
            >
              {approveBusy ? 'Approving…' : 'Approve'}
            </button>
          )}
          {step === 'pair' && localBrain && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              onClick={() => { onRefreshRunners?.(); setStepIndex((i) => i + 1); }}
            >
              Continue
            </button>
          )}
          {step === 'agents' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={!selected || !validation.valid || enabledCount === 0 || saveState.busy}
              onClick={async () => {
                const ok = await onSave();
                if (ok) setStepIndex((i) => i + 1);
              }}
            >
              {saveState.busy ? 'Saving…' : 'Save'}
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
