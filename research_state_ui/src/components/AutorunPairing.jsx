import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { runnerPresentation } from './runnerPresentation';

export const INSTALL_COMMAND = 'curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh';
export const RUNNER_COMMAND = '$HOME/.merv/bin/merv-agent-runner';

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

/** Clipboard with honest feedback: Copy → Copied, or Copy failed. */
export function useCopy() {
  const [state, setState] = useState(''); // '' | 'ok' | 'fail'
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState(''), 1800);
  }
  const label = state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : 'Copy';
  return [label, copy];
}

export function CommandLine({ command, label = 'Copy' }) {
  const [copyLabel, copy] = useCopy();
  return (
    <span className="arun-command">
      <code className="mono">{command}</code>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(command)} aria-label={label}>
        {copyLabel}
      </button>
    </span>
  );
}

/**
 * AutorunPairing — the whole of machine setup, in two lines.
 *
 * Line one is the command to run on the machine; line two takes the code it
 * prints. Approval registers the runner's own key with the brain, the machine
 * finishes pairing on its next poll and shows up in the machines console
 * live. Same component in the empty state and in the console's foot row.
 */
export default function AutorunPairing({ projectId, runners, onRefresh, onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(null); // { runner_ref, machine }
  const [localBrain, setLocalBrain] = useState(false);

  const arrived = useMemo(
    () => (approved ? (runners || []).find((runner) => runner.runner_ref === approved.runner_ref) : null),
    [approved, runners],
  );
  const arrivedLive = arrived ? runnerPresentation(arrived).live : false;

  // After approval, poll a little faster until the machine checks in.
  useEffect(() => {
    if (!approved || arrivedLive) return undefined;
    const timer = setInterval(() => onRefresh?.(), 3000);
    return () => clearInterval(timer);
  }, [approved, arrivedLive, onRefresh]);

  useEffect(() => {
    if (approved && arrivedLive) {
      onPaired?.(arrived);
      const timer = setTimeout(() => { setApproved(null); setCode(''); }, 2500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [approved, arrivedLive, arrived, onPaired]);

  async function approve(event) {
    event?.preventDefault?.();
    const normalized = normalizeCode(code);
    if (normalized.length !== 8) {
      setError('Enter the 8-character code the runner printed.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.approveRunnerPairing(projectId, normalized);
      setApproved({ runner_ref: result?.runner_ref || '', machine: result?.machine || {} });
      onRefresh?.();
    } catch (err) {
      const status = Number(err?.status || 0);
      const errorCode = String(err?.data?.error_code || '');
      if (status === 404 && errorCode === 'not_found') {
        setError('No runner is waiting with that code. Check the terminal and try again.');
      } else if (status === 404) {
        // Pairing routes exist only where owner key management exists; a
        // loopback brain has no auth and needs no runner credential.
        setLocalBrain(true);
      } else if (status === 429) {
        setError('Too many wrong codes. Wait ten minutes, then try again.');
      } else if (status === 403) {
        setError('Only a signed-in project owner can approve a runner.');
      } else {
        setError(err?.message || 'Could not approve the pairing.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (localBrain) {
    return (
      <div className="arun-pair">
        <p className="arun-pair-note">
          This brain runs locally, so no pairing is needed — start the runner against it directly:
        </p>
        <CommandLine command={`${RUNNER_COMMAND} --project ${projectId}`} />
      </div>
    );
  }

  const host = approved?.machine?.hostname || arrived?.machine?.hostname || 'the machine';
  return (
    <form className="arun-pair" onSubmit={approve}>
      <div className="arun-pair-line">
        <span className="arun-pair-step">1</span>
        <span className="arun-pair-text">On the machine</span>
        <CommandLine command={INSTALL_COMMAND} />
      </div>
      <div className="arun-pair-line">
        <span className="arun-pair-step">2</span>
        <span className="arun-pair-text">Code it prints</span>
        {approved ? (
          <ol className="arun-pair-stages" role="status" aria-label="Pairing progress">
            <li className="arun-pair-stage arun-pair-stage--ok"><span aria-hidden="true">●</span> Code approved</li>
            <li className={`arun-pair-stage arun-pair-stage--${arrived ? 'ok' : 'running'}`}>
              <span aria-hidden="true">●</span> {arrived ? `${host} checked in` : `Waiting for ${host} to check in…`}
            </li>
            <li className={`arun-pair-stage arun-pair-stage--${arrivedLive ? 'ok' : arrived ? 'running' : 'pending'}`}>
              <span aria-hidden="true">{arrivedLive || arrived ? '●' : '○'}</span> {arrivedLive ? 'Live — its agents are checked next' : 'Live'}
            </li>
          </ol>
        ) : (
          <span className="arun-pair-code">
            <input
              className="input mono arun-pair-input"
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(''); }}
              placeholder="XXXX XXXX"
              maxLength={9}
              autoComplete="off"
              spellCheck={false}
              aria-label="Pairing code"
            />
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
              {busy ? 'Approving…' : 'Approve'}
            </button>
          </span>
        )}
      </div>
      {error && <p className="arun-pair-error" role="alert">{error}</p>}
    </form>
  );
}
