import { useEffect, useState } from 'react';
import { api, request, mcpEndpoint } from '../api';

export const ACCOUNT = 'account';
export const PROJECT = 'project';
const PICKUP_POLL_MS = 3000;

// A coarse pointer means a phone or tablet — never the machine the agent
// runs on, so those visitors skip the location question entirely.
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);

function brainOrigin() {
  return mcpEndpoint().replace(/\/mcp$/, '');
}

// The typeable command target: the pretty /merv/go path exists where the
// site's rewrites front the brain (production); everywhere else the brain's
// own endpoint is the accurate address.
function goUrl(token) {
  if (window.location.origin === 'https://rapidreview.io') {
    return `https://rapidreview.io/merv/go/${token}`;
  }
  return `${brainOrigin()}/oauth/handoff/${token}`;
}

export default function OAuthConsent() {
  const [state, setState] = useState({ loading: true, client: null, projects: [], error: '' });
  // Reaching every project is the common case; one project is the opt-in.
  const [grantScope, setGrantScope] = useState(ACCOUNT);
  const [projectId, setProjectId] = useState('');
  // Local is the common case, so remote is a quiet link, not a peer choice —
  // except on a phone, which is never the agent's machine.
  const [remote, setRemote] = useState(COARSE_POINTER);
  const [busy, setBusy] = useState(false);
  // {url, digest, goToken} after a remote approve; {denied: true} after a
  // remote cancel. Local decisions navigate away instead.
  const [handoff, setHandoff] = useState(null);
  const [pickup, setPickup] = useState('pending');
  // The short code a phone can type at /go to pick this consent up.
  const [phoneCode, setPhoneCode] = useState('');

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
        setHandoff({
          url: result.redirect_to,
          digest: result.code_status || '',
          goToken: result.go_token || '',
        });
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

  const mintPhoneCode = async () => {
    try {
      const result = await request('/oauth/handoff/visit', {
        method: 'POST',
        body: { query: window.location.search.replace(/^\?/, '') },
      });
      setPhoneCode(result.code);
    } catch (error) {
      setState(current => ({
        ...current,
        error: error.message || 'Could not create a phone code.',
      }));
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
        goToken={handoff.goToken}
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
      <ScopeFields
        grantScope={grantScope}
        setGrantScope={setGrantScope}
        projects={state.projects}
        projectId={projectId}
        setProjectId={setProjectId}
        homeProject={homeProject}
        busy={busy}
      />
      {COARSE_POINTER && (
        <p className="oauth-remote-note">
          Approving from this device — after you approve, you'll get one short
          command for the machine where {state.client.client_name} is running.
        </p>
      )}
      {!COARSE_POINTER && !remote && (
        <button
          type="button"
          className="oauth-remote-link"
          disabled={busy}
          onClick={() => setRemote(true)}
        >
          Is {state.client.client_name} on another machine (SSH, VM, cloud)?
        </button>
      )}
      {!COARSE_POINTER && remote && (
        <p className="oauth-remote-note">
          Remote machine: after you approve, you'll get one short command to
          run there.{' '}
          <button
            type="button"
            className="oauth-remote-link oauth-remote-link--inline"
            disabled={busy}
            onClick={() => { setRemote(false); setPhoneCode(''); }}
          >
            It's on this computer
          </button>
          {!phoneCode && (
            <>
              {' · '}
              <button
                type="button"
                className="oauth-remote-link oauth-remote-link--inline"
                disabled={busy}
                onClick={mintPhoneCode}
              >
                Approve on my phone instead
              </button>
            </>
          )}
        </p>
      )}
      {remote && phoneCode && (
        <p className="oauth-remote-note">
          On your phone, open <strong>{window.location.host}{'/merv/go'}</strong>{' '}
          and enter <strong className="oauth-go-code">{phoneCode}</strong> —
          then finish the approval there.
        </p>
      )}
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

export function HandoffScreen({ clientName, url, goToken, pickup }) {
  const [copied, setCopied] = useState('');
  const [showFull, setShowFull] = useState(false);
  const fullCommand = `curl '${url}'`;
  const shortCommand = goToken ? `curl -L '${goUrl(goToken)}'` : '';
  const pasteFirst = /claude/i.test(clientName || '');
  const copy = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('');
    }
  };
  const commandRow = (id, text) => (
    <div className="arun-command">
      <code className="mono">{text}</code>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(id, text)}>
        {copied === id ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
  return (
    <ConsentFrame>
      <h2 className="auth-modal-title">One step left</h2>
      {pasteFirst ? (
        <>
          <p className="auth-modal-sub">
            The waiting {clientName} terminal is asking for a URL — paste this
            one there:
          </p>
          <div className="arun-command">
            <code className="mono oauth-handoff-url">{url}</code>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('url', url)}>
              {copied === 'url' ? 'Copied' : 'Copy URL'}
            </button>
          </div>
          {shortCommand && (
            <p className="oauth-consent-resource oauth-handoff-alt">
              <span>No paste prompt? In a second terminal on that machine, run
              {' '}<code className="mono">{shortCommand}</code></span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('go', shortCommand)}>
                {copied === 'go' ? 'Copied' : 'Copy'}
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="auth-modal-sub">
            In a <strong>second terminal</strong> on the machine where
            {' '}{clientName} is waiting, type or paste:
          </p>
          {commandRow('go', shortCommand || fullCommand)}
          <p className="oauth-consent-resource oauth-handoff-alt">
            <span>Terminal asking you to paste a URL instead?</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy('url', url)}>
              {copied === 'url' ? 'Copied' : 'Copy URL'}
            </button>
          </p>
          {shortCommand && !showFull && (
            <button type="button" className="oauth-remote-link" onClick={() => setShowFull(true)}>
              Show the full command (no https needed on that machine)
            </button>
          )}
          {shortCommand && showFull && commandRow('curl', fullCommand)}
        </>
      )}
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

/**
 * The scope question every consent screen asks — the whole account or one
 * project — with the picker and the two notes that follow from the answer.
 */
export function ScopeFields({
  grantScope, setGrantScope, projects, projectId, setProjectId, homeProject, busy,
}) {
  return (
    <>
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
            {projects.map(project => (
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
    </>
  );
}

export function ScopeChoice({ checked, disabled, onSelect, title, detail }) {
  return (
    <label className={`oauth-scope-choice${checked ? ' is-selected' : ''}`}>
      <input
        type="radio"
        name="grant_scope"
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
