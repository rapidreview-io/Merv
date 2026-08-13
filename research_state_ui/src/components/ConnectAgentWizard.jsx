import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, mcpEndpoint } from '../api';
import {
  NATIVE_CLIENTS,
  OTHER_CLIENT_NAMES,
  CLIENT_DOCS_URL,
  ClientMark,
  clientById,
  verifyPrompt,
} from './connectClients';

/**
 * Guided "connect your agent" setup, replayable per client and per machine.
 *
 * The setup crosses two surfaces — this browser and the user's agent in a
 * terminal — so the last step verifies the hop instead of trusting a
 * checklist: it watches the MCP activity ring for a tool call that arrives
 * *after* the step opened, and flips to done when one lands. The suggested
 * prompt ends in workflow.status_and_next because the hosted ring only shows
 * a member project-scoped rows; a bare project(action="list") would connect
 * fine yet stay invisible here.
 */

const STEPS = ['client', 'setup', 'verify', 'done'];
const POLL_MS = 2500;

function tsMs(ts) {
  const v = Date.parse(ts);
  return Number.isFinite(v) ? v : 0;
}

function CommandRow({ id, text, copied, onCopy }) {
  return (
    <div className="aru-command">
      <code className="mono">{text}</code>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCopy(id, text)}>
        {copied === id ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function ConnectAgentWizard({ projectId, projectName, initialClient = null, onClose }) {
  const [clientId, setClientId] = useState(initialClient);
  const [stepIndex, setStepIndex] = useState(initialClient ? 1 : 0);
  const [copied, setCopied] = useState('');
  const [seenCall, setSeenCall] = useState(null);
  const [watchError, setWatchError] = useState('');
  const baseline = useRef(null);
  const previouslyFocused = useRef(null);

  const step = STEPS[stepIndex];
  const client = clientId === 'other' ? null : clientById(clientId);
  const clientName = client ? client.name : 'your agent';

  // Escape closes; focus returns to the opener (there is no busy state here —
  // abandoning the wizard never loses server-side work).
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previouslyFocused.current && previouslyFocused.current.focus) {
        previouslyFocused.current.focus();
      }
    };
  }, [onClose]);

  // Entering verify re-arms the watch, so replays on the same mount ("Set up
  // another client") do not inherit the previous baseline.
  useEffect(() => {
    if (step === 'verify') {
      baseline.current = null;
      setWatchError('');
    }
  }, [step]);

  // Live check: first fetch snapshots the ring (existing traffic is not
  // proof); any newer tool.call is — auto-advance to done, like the other
  // wizards' self-advancing verification steps.
  useEffect(() => {
    if (step !== 'verify') return undefined;
    let alive = true;
    let failures = 0;
    const tick = async () => {
      try {
        const data = await api.listActivity(100, 'mcp', projectId);
        if (!alive) return;
        failures = 0;
        const calls = (data?.events || []).filter((e) => e.event === 'tool.call');
        const latest = calls.reduce((m, e) => Math.max(m, tsMs(e.ts)), 0);
        if (baseline.current === null) {
          baseline.current = latest;
          return;
        }
        const fresh = calls.filter((e) => tsMs(e.ts) > baseline.current);
        if (fresh.length) {
          setSeenCall({ tool: String(fresh[fresh.length - 1].tool || 'tool') });
          setStepIndex(STEPS.indexOf('done'));
        }
      } catch {
        failures += 1;
        if (alive && failures >= 3) {
          setWatchError(
            'Can’t watch traffic from this browser. After your agent answers, its calls are on Traffic & Tool I/O.',
          );
        }
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [step, projectId]);

  async function copy(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  function pick(id) {
    setClientId(id);
    setStepIndex(STEPS.indexOf('setup'));
  }

  function replay() {
    setClientId(null);
    setSeenCall(null);
    setWatchError('');
    baseline.current = null;
    setStepIndex(0);
  }

  const stepNumber = stepIndex + 1;

  return createPortal(
    <div className="retention-modal-overlay" onMouseDown={onClose}>
      <div
        className="retention-modal sbxpw"
        role="dialog"
        aria-modal="true"
        aria-label="Connect your agent"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="retention-modal-head">
          <div className="retention-modal-head-main">
            <ClientMark client={clientId || 'other'} />
            <h2 className="retention-modal-title">
              {client ? `Connect ${client.name}` : 'Connect your agent'}
            </h2>
          </div>
          <button type="button" className="retention-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="sbxpw-progress">
          <span className="sbxpw-bar" aria-hidden="true">
            <span style={{ width: `${(stepNumber / STEPS.length) * 100}%` }} />
          </span>
          <span className="sbxpw-count">Step {stepNumber} of {STEPS.length}</span>
        </div>

        {step === 'client' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Which agent do you use?</p>
            <p className="sbxpw-help">
              Your agent talks straight to Merv over MCP. These clients ship a
              native plugin with browser sign-in — pick yours.
            </p>
            <div className="cnx-grid">
              {NATIVE_CLIENTS.map((c) => (
                <button key={c.id} type="button" className="cnx-choice" onClick={() => pick(c.id)}>
                  <ClientMark client={c.id} />
                  <span className="cnx-choice-title">{c.name}</span>
                </button>
              ))}
              <button
                type="button"
                className="cnx-choice cnx-choice--wide"
                onClick={() => pick('other')}
              >
                <ClientMark client="other" />
                <span className="cnx-choice-text">
                  <span className="cnx-choice-title">Another client</span>
                  <span className="cnx-choice-sub">
                    {OTHER_CLIENT_NAMES.join(', ')}, headless runners, CI…
                  </span>
                </span>
              </button>
            </div>
          </div>
        )}

        {step === 'setup' && client && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Set up {client.name}</p>
            <ol className="cnx-substeps">
              {client.steps.map((s) => (
                <li key={s.title} className="cnx-substep">
                  <div className="cnx-substep-title">{s.title}</div>
                  {(s.commands || []).map((cmd) => (
                    <CommandRow key={cmd} id={cmd} text={cmd} copied={copied} onCopy={copy} />
                  ))}
                  {s.note && <p className="cnx-substep-note">{s.note}</p>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {step === 'setup' && !client && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Another client</p>
            <p className="sbxpw-help">
              {OTHER_CLIENT_NAMES.join(', ')} connect to the same endpoint with
              OAuth or a static key; headless runners and CI export a{' '}
              <code className="mono">MERV_MCP_KEY</code> minted under
              Settings → MCP keys. The{' '}
              <a href={CLIENT_DOCS_URL} target="_blank" rel="noreferrer">
                client guide on GitHub
              </a>{' '}
              has exact steps for each.
            </p>
            <div className="cnx-substep-title" style={{ marginTop: 12, marginBottom: 8 }}>
              MCP endpoint
            </div>
            <CommandRow id="endpoint" text={mcpEndpoint()} copied={copied} onCopy={copy} />
            <p className="cnx-substep-note" style={{ marginTop: 8 }}>
              Static keys are sent as <code className="mono">Authorization: Bearer</code>.
              Treat them like passwords.
            </p>
          </div>
        )}

        {step === 'verify' && (
          <div className="sbxpw-body">
            <p className="sbxpw-lead">Watch it connect</p>
            <p className="sbxpw-help">
              Open {clientName} in a terminal and hand it this prompt. The
              first call lands here within a few seconds.
            </p>
            <CommandRow id="prompt" text={verifyPrompt(projectName)} copied={copied} onCopy={copy} />
            {watchError ? (
              <p className="cnx-watch-note">{watchError}</p>
            ) : (
              <div className="aruw-poll" role="status">
                <span className="sbxpw-spinner" aria-hidden="true" />
                Listening for the first call…
              </div>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="sbxpw-body sbxpw-body--center">
            <div className="sbxpw-check" aria-hidden="true">✓</div>
            <p className="sbxpw-lead">
              {seenCall ? 'Your agent is in.' : 'Setup recorded.'}
            </p>
            <p className="sbxpw-help">
              {seenCall
                ? `First call seen: ${seenCall.tool}.`
                : 'Once the agent dials in, its calls appear under Traffic & Tool I/O.'}
            </p>
            <p className="cnx-done-next">
              Ask it to start an experiment — plans and results pass
              adversarial review before they land. Follow along on Feed and
              Experiments; anything that needs you shows up in Reviews. Replay
              this guide from Settings → Connect an agent for another machine
              or another client.
            </p>
          </div>
        )}

        <div className="sbxpw-nav">
          {stepIndex > 0 && step !== 'done' && (
            <button
              type="button"
              className="sbxpw-btn"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              Back
            </button>
          )}
          <span className="sbxpw-nav-spacer" />
          {step === 'setup' && (
            <button
              type="button"
              className="sbxpw-btn sbxpw-btn--primary"
              onClick={() => setStepIndex(STEPS.indexOf('verify'))}
            >
              Continue
            </button>
          )}
          {step === 'verify' && (
            <button
              type="button"
              className="sbxpw-btn"
              onClick={() => setStepIndex(STEPS.indexOf('done'))}
            >
              Skip — I’ll verify later
            </button>
          )}
          {step === 'done' && (
            <>
              <button type="button" className="sbxpw-btn" onClick={replay}>
                Set up another client
              </button>
              <button type="button" className="sbxpw-btn sbxpw-btn--primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
