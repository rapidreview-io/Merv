import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import ProviderIcon from './ProviderIcon';

/**
 * ProviderSetupModal — the guided connection wizard for one compute cloud.
 *
 * One data point per step: each screen collects a single credential field
 * with instructions for retrieving it (help text comes from the backend
 * catalog, so the flow is provider-specific without the UI knowing any
 * provider). Shared deployment connections have separate cards; personal
 * credentials use their own connection name. The wizard ends by saving and
 * then verifying access with a real
 * provider API call; only then does it offer the agent-facing enable switch
 * and the optional daily spend cap.
 */

function buildSteps(entry, mode) {
  const steps = [];
  if (entry.platform_available) steps.push({ kind: 'mode' });
  if (mode !== 'platform') {
    for (const field of entry.fields) steps.push({ kind: 'field', field });
  }
  steps.push({ kind: 'verify' });
  steps.push({ kind: 'done' });
  return steps;
}

export default function ProviderSetupModal({ projectId, entry: initial, onUpdated, onClose }) {
  const [entry, setEntry] = useState(initial);
  // 'own' | 'platform'; preselect a previous explicit choice.
  const [mode, setMode] = useState(
    initial.credential_mode || (initial.platform_available ? '' : 'own'),
  );
  const [drafts, setDrafts] = useState({});
  const [stepIndex, setStepIndex] = useState(0);
  const [verifyState, setVerifyState] = useState({ phase: 'idle' });
  const [enabling, setEnabling] = useState(false);
  const [limitDraft, setLimitDraft] = useState(
    initial.daily_usd_limit == null ? '' : String(initial.daily_usd_limit),
  );
  const verifyRun = useRef(0);

  const steps = useMemo(() => buildSteps(entry, mode), [entry, mode]);
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  const patch = (updated) => { setEntry(updated); onUpdated(updated); };

  // ---- verify step: save what was collected, then probe access ----
  useEffect(() => {
    if (step.kind !== 'verify') return undefined;
    const run = ++verifyRun.current;
    let cancelled = false;
    (async () => {
      setVerifyState({ phase: 'running' });
      try {
        const body = { mode: mode || 'own' };
        if (mode !== 'platform') {
          const values = {};
          for (const [k, v] of Object.entries(drafts)) {
            const field = entry.fields.find((f) => f.key === k);
            // Blank draft on an already-saved secret means "keep it".
            if (field?.secret && field.set && !String(v).trim()) continue;
            values[k] = v;
          }
          if (Object.keys(values).length) body.values = values;
        }
        const saved = await api.saveSandboxProvider(projectId, entry.provider, body);
        if (cancelled || run !== verifyRun.current) return;
        patch(saved);
        const result = await api.verifySandboxProvider(projectId, entry.provider);
        if (cancelled || run !== verifyRun.current) return;
        patch(result.provider);
        setVerifyState(
          result.ok
            ? { phase: 'ok', detail: result.detail }
            : { phase: 'failed', detail: result.detail },
        );
        if (result.ok) setStepIndex((i) => i + 1);
      } catch (err) {
        if (!cancelled && run === verifyRun.current) {
          setVerifyState({ phase: 'failed', detail: err.message });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind]);

  const setDraft = (key, value) => setDrafts((d) => ({ ...d, [key]: value }));

  const fieldReady = (field) => {
    const draft = String(drafts[field.key] ?? '').trim();
    if (!field.required) return true;
    return Boolean(draft) || field.set || Boolean(field.value);
  };

  const next = () => setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => {
    if (step.kind === 'verify') setVerifyState({ phase: 'idle' });
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  const chooseMode = (choice) => {
    setMode(choice);
    setStepIndex(1); // steps rebuild off the new mode; 1 = first step after choice
  };

  const finish = async () => {
    const trimmed = limitDraft.trim();
    const want = trimmed === '' ? null : Number(trimmed);
    const have = entry.daily_usd_limit == null ? null : Number(entry.daily_usd_limit);
    if (want !== have && !(want != null && Number.isNaN(want))) {
      try {
        patch(await api.setSandboxProviderDailyLimit(projectId, entry.provider, want));
      } catch { /* the card still shows the stored value */ }
    }
    onClose();
  };

  const enableNow = async () => {
    setEnabling(true);
    try {
      patch(await api.setSandboxProviderEnabled(projectId, entry.provider, true));
    } finally {
      setEnabling(false);
    }
  };

  const stepNumber = steps.indexOf(step) + 1;

  return createPortal(
    <div className="retention-modal-overlay" onMouseDown={onClose}>
      <div
        className="retention-modal sbxpw"
        role="dialog"
        aria-modal="true"
        aria-label={`Set up ${entry.label}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="retention-modal-head">
          <div className="retention-modal-head-main">
            <ProviderIcon provider={entry.provider} />
            <h2 className="retention-modal-title">Connect {entry.label}</h2>
          </div>
          <button type="button" className="retention-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sbxpw-progress">
          <span className="sbxpw-bar" aria-hidden="true">
            <span style={{ width: `${(stepNumber / steps.length) * 100}%` }} />
          </span>
          <span className="sbxpw-count">Step {stepNumber} of {steps.length}</span>
        </div>

        {step.kind === 'mode' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">How should agents pay for {entry.label} compute?</p>
            <button type="button" className={`sbxpw-choice${mode === 'platform' ? ' picked' : ''}`} onClick={() => chooseMode('platform')}>
              <span className="sbxpw-choice-title">Use {entry.platform_label}</span>
              <span className="sbxpw-choice-sub">
                Zero setup — sandboxes bill through the credentials this deployment already holds.
              </span>
            </button>
            <button type="button" className={`sbxpw-choice${mode === 'own' ? ' picked' : ''}`} onClick={() => chooseMode('own')}>
              <span className="sbxpw-choice-title">Supply my own credentials</span>
              <span className="sbxpw-choice-sub">
                Bring a {entry.label} account — compute bills to it directly.
              </span>
            </button>
          </div>
        )}

        {step.kind === 'field' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">
              {step.field.label}
              {!step.field.required && <span className="sbxp-field-opt"> · optional</span>}
            </p>
            {entry.credentials_replace && entry.connected && (
              <p className="sbxpw-help">Replacing this connection requires the complete credential set.</p>
            )}
            <p className="sbxpw-help">
              {step.field.help || `Paste the ${step.field.label.toLowerCase()}.`}{' '}
              <a href={entry.console_url} target="_blank" rel="noreferrer">Open the {entry.label} console ↗</a>
            </p>
            {step.field.multiline ? (
              <textarea
                className="sbxpw-input"
                rows={6}
                autoFocus
                spellCheck={false}
                value={drafts[step.field.key] ?? ''}
                placeholder={step.field.secret && step.field.set ? 'saved — leave blank to keep' : step.field.placeholder}
                onChange={(e) => setDraft(step.field.key, e.target.value)}
              />
            ) : (
              <input
                className="sbxpw-input"
                type={step.field.secret ? 'password' : 'text'}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={drafts[step.field.key] ?? (step.field.value || '')}
                placeholder={step.field.secret && step.field.set ? 'saved — leave blank to keep' : step.field.placeholder}
                onChange={(e) => setDraft(step.field.key, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && fieldReady(step.field)) next(); }}
              />
            )}
            {step.field.secret && step.field.set && (
              <p className="sbxpw-kept">A value is already saved; leaving this blank keeps it.</p>
            )}
          </div>
        )}

        {step.kind === 'verify' && (
          <div className="sbxpw-body sbxpw-body--center">
            {verifyState.phase !== 'failed' ? (
              <>
                <span className="sbxpw-spinner" aria-hidden="true" />
                <p className="sbxpw-lead">Confirming access with {entry.label}…</p>
                <p className="sbxpw-help">Saving the connection, then making one read-only API call with these credentials.</p>
              </>
            ) : (
              <>
                <p className="sbxpw-fail">Verification failed</p>
                <p className="sbxpw-fail-detail">{verifyState.detail}</p>
              </>
            )}
          </div>
        )}

        {step.kind === 'done' && (
          <div className="sbxpw-body sbxpw-body--center">
            <span className="sbxpw-check" aria-hidden="true">✓</span>
            <p className="sbxpw-lead">{entry.label} is connected</p>
            {verifyState.detail && <p className="sbxpw-help">{verifyState.detail}</p>}
            <p className="sbxpw-help">The service reserves the full authorized lease against your daily cap.</p>
            <div className="sbxpw-finish-row">
              {entry.enabled ? (
                <span className="sbxpw-enabled-note">Enabled for agents</span>
              ) : (
                <button type="button" className="sbxp-save" disabled={enabling} onClick={enableNow}>
                  {enabling ? 'Enabling…' : 'Enable for agents'}
                </button>
              )}
            </div>
            <label className="sbxpw-limit">
              <span>Project daily spend cap (USD, blank = none)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={limitDraft}
                placeholder="e.g. 50"
                onChange={(e) => setLimitDraft(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="sbxpw-nav">
          {step.kind !== 'done' && stepIndex > 0 && step.kind !== 'verify' && (
            <button type="button" className="sbxpw-btn" onClick={back}>Back</button>
          )}
          {step.kind === 'verify' && verifyState.phase === 'failed' && (
            <button type="button" className="sbxpw-btn" onClick={back}>Back — fix a value</button>
          )}
          <span className="sbxpw-nav-spacer" />
          {step.kind === 'field' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              disabled={!fieldReady(step.field)}
              onClick={next}
            >
              {steps[stepIndex + 1]?.kind === 'verify' ? 'Save & verify' : 'Next'}
            </button>
          )}
          {step.kind === 'done' && (
            <button type="button" className="sbxpw-btn sbxpw-btn--primary" onClick={finish}>Finish</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
