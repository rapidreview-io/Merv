import { useEffect, useState } from 'react';
import { api, request } from '../api';

const ACCOUNT = 'account';
const PROJECT = 'project';
const LOCAL = 'local';
const REMOTE = 'remote';
const PICKUP_POLL_MS = 3000;

export default function OAuthConsent() {
  const [state, setState] = useState({ loading: true, client: null, projects: [], error: '' });
  // Reaching every project is the common case; one project is the opt-in.
  const [grantScope, setGrantScope] = useState(ACCOUNT);
  const [projectId, setProjectId] = useState('');
  // Same machine is the common case; the remote card is the opt-in that
  // swaps the final redirect for a hand-carried command.
  const [location, setLocation] = useState(LOCAL);
  const [busy, setBusy] = useState(false);
  // Set once a remote-machine decision completes: {url, digest} after
  // approve, {denied: true} after cancel. Local decisions navigate away
  // instead and never reach this state.
  const [handoff, setHandoff] = useState(null);
  const [pickup, setPickup] = useState('pending');

  useEffect(() => {
    let disposed = false;
    const query = window.location.search;
    (async () => {
      try {
        const [client, projectResult] = await Promise.all([
          request(`/oauth/authorize/details${query}`),
          api.listProjects(),
        ]);
        if (!disposed) {
          setState({
            loading: false,
            client,
            projects: projectResult?.projects || [],
            error: '',
          });
        }
      } catch (error) {
        if (!disposed) {
          setState({
            loading: false,
            client: null,
            projects: [],
            error: error.message || 'Could not load this authorization request.',
          });
        }
      }
    })();
    return () => { disposed = true; };
  }, []);

  // The pickup poll: the code is single-use, so redeemed means the agent has
  // it and this tab is done. Transient poll failures stay "pending" — the
  // next tick answers.
  useEffect(() => {
    if (!handoff?.digest || pickup !== 'pending') return undefined;
    let disposed = false;
    const tick = async () => {
      try {
        const result = await request(
          `/oauth/authorize/status?digest=${encodeURIComponent(handoff.digest)}`,
        );
        if (disposed) return;
        if (result.status === 'redeemed') setPickup('redeemed');
        else if (result.status === 'expired' || result.status === 'unknown') setPickup('expired');
      } catch {
        // Keep waiting; the next poll answers.
      }
    };
    const timer = setInterval(tick, PICKUP_POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [handoff, pickup]);

  // An account grant still names a home project: the one it is listed and
  // revoked under. The first project is a fine default, so the common case
  // asks the user for no decision at all.
  const homeProject = state.projects[0];
  const chosenProjectId = grantScope === ACCOUNT ? homeProject?.id || '' : projectId;
  const canApprove = Boolean(chosenProjectId);

  const decide = async (decision) => {
    if (decision === 'approve' && !canApprove) return;
    const remote = location === REMOTE;
    if (remote && decision === 'deny') {
      // Nothing reachable to redirect to: the agent's listener is on another
      // machine and it simply times out. Just say what happened.
      setHandoff({ denied: true });
      return;
    }
    setBusy(true);
    setState(current => ({ ...current, error: '' }));
    try {
      const params = Object.fromEntries(new URLSearchParams(window.location.search));
      const result = await request('/oauth/authorize', {
        method: 'POST',
        body: {
          ...params,
          decision,
          project_id: decision === 'approve' ? chosenProjectId : '',
          grant_scope: grantScope,
          handoff: remote && decision === 'approve',
        },
      });
      if (remote) {
        setHandoff({ url: result.redirect_to, digest: result.code_status || '' });
        setBusy(false);
        return;
      }
      window.location.assign(result.redirect_to);
    } catch (error) {
      setState(current => ({
        ...current,
        error: error.message || 'Could not complete authorization.',
      }));
      setBusy(false);
    }
  };

  if (state.loading) {
    return <ConsentFrame><p className="auth-modal-sub">Loading authorization request…</p></ConsentFrame>;
  }
  if (!state.client) {
    return <ConsentFrame><p className="oauth-consent-error">{state.error}</p></ConsentFrame>;
  }
  if (handoff?.denied) {
    return (
      <ConsentFrame>
        <h2 className="auth-modal-title">Cancelled</h2>
        <p className="auth-modal-sub">
          Nothing was connected. {state.client.client_name} will stop waiting on
          its own — you can close this tab.
        </p>
      </ConsentFrame>
    );
  }
  if (handoff) {
    return (
      <HandoffScreen
        clientName={state.client.client_name}
        url={handoff.url}
        pickup={handoff.digest ? pickup : ''}
      />
    );
  }

  return (
    <ConsentFrame>
      <h2 className="auth-modal-title">Connect {state.client.client_name}</h2>
      <p className="auth-modal-sub">
        Choose how much of Merv this client may reach. You can revoke it at any
        time.
      </p>
      <div className="oauth-scope-choices">
        <ScopeChoice
          checked={grantScope === ACCOUNT}
          disabled={busy}
          onSelect={() => setGrantScope(ACCOUNT)}
          title="All my projects"
          detail="The client picks a project per request and follows your membership as it changes. Connect once and never again."
        />
        <ScopeChoice
          checked={grantScope === PROJECT}
          disabled={busy}
          onSelect={() => setGrantScope(PROJECT)}
          title="One project only"
          detail="The client is locked to a single project and cannot see the others."
        />
      </div>
      {grantScope === PROJECT && (
        <label className="auth-field">
          <span>Project</span>
          <select
            className="auth-input oauth-project-select"
            value={projectId}
            onChange={event => setProjectId(event.target.value)}
            disabled={busy}
          >
            <option value="">Select one project…</option>
            {state.projects.map(project => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
      )}
      {grantScope === ACCOUNT && homeProject && (
        <p className="oauth-consent-resource">
          Listed under {homeProject.name} in your MCP keys.
        </p>
      )}
      {!homeProject && (
        <p className="oauth-consent-error">
          Create a project before connecting a client.
        </p>
      )}
      <p className="auth-modal-sub oauth-location-question">
        Where is {state.client.client_name} running?
      </p>
      <div className="oauth-scope-choices">
        <LocationChoice
          checked={location === LOCAL}
          disabled={busy}
          onSelect={() => setLocation(LOCAL)}
          title="On this computer"
          detail="The usual sign-in — your browser finishes the connection by itself."
        />
        <LocationChoice
          checked={location === REMOTE}
          disabled={busy}
          onSelect={() => setLocation(REMOTE)}
          title="On another machine"
          detail="An SSH session, VM, or cloud box. You'll copy one command over to finish."
        />
      </div>
      <p className="oauth-consent-resource">Resource: {state.client.resource}</p>
      {state.error && <p className="oauth-consent-error">{state.error}</p>}
      <div className="oauth-consent-actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => decide('deny')}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !canApprove}
          onClick={() => decide('approve')}
        >
          {busy ? 'Connecting…' : 'Approve'}
        </button>
      </div>
    </ConsentFrame>
  );
}

export function HandoffScreen({ clientName, url, pickup }) {
  const [copied, setCopied] = useState('');
  const command = `curl '${url}'`;
  const copy = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('');
    }
  };
  return (
    <ConsentFrame>
      <h2 className="auth-modal-title">One step left</h2>
      <p className="auth-modal-sub">
        Open a <strong>second terminal</strong> on the machine where
        {' '}{clientName} is running — the sign-in is still waiting in the
        first one — and run:
      </p>
      <div className="arun-command">
        <code className="mono">{command}</code>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('curl', command)}>
          {copied === 'curl' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="oauth-consent-resource oauth-handoff-alt">
        <span>Terminal asking you to paste a URL instead?</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('url', url)}>
          {copied === 'url' ? 'Copied' : 'Copy URL'}
        </button>
      </p>
      {pickup === 'pending' && (
        <p className="auth-modal-sub oauth-pickup-pending">Waiting for {clientName} to pick this up…</p>
      )}
      {pickup === 'redeemed' && (
        <p className="auth-modal-sub oauth-pickup-done">✓ Connected. You can close this tab.</p>
      )}
      {pickup === 'expired' && (
        <p className="oauth-consent-error">
          This approval expired before it was used. Restart the sign-in from
          {' '}{clientName} and try again — it stays valid for ten minutes.
        </p>
      )}
    </ConsentFrame>
  );
}

export function ScopeChoice({ checked, disabled, onSelect, title, detail }) {
  return (
    <Choice name="grant_scope" checked={checked} disabled={disabled} onSelect={onSelect} title={title} detail={detail} />
  );
}

function LocationChoice({ checked, disabled, onSelect, title, detail }) {
  return (
    <Choice name="agent_location" checked={checked} disabled={disabled} onSelect={onSelect} title={title} detail={detail} />
  );
}

function Choice({ name, checked, disabled, onSelect, title, detail }) {
  return (
    <label className={`oauth-scope-choice${checked ? ' is-selected' : ''}`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span>
        <strong>{title}</strong>
        <span className="oauth-scope-detail">{detail}</span>
      </span>
    </label>
  );
}

export function ConsentFrame({ children }) {
  return (
    <div className="auth-gate">
      <div className="auth-modal oauth-consent">{children}</div>
    </div>
  );
}
