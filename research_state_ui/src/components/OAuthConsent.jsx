import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, request } from '../api';

export const ACCOUNT = 'account';
export const PROJECT = 'project';

// A coarse pointer means a phone or tablet, which is never the machine the
// client runs on — and a loopback callback is reachable only from there.
const COARSE_POINTER =
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
const LOOPBACK_CALLBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(
  new URLSearchParams(window.location.search).get('redirect_uri') || '',
);

export default function OAuthConsent() {
  const [state, setState] = useState({ loading: true, client: null, projects: [], error: '' });
  // Reaching every project is the common case; one project is the opt-in.
  const [grantScope, setGrantScope] = useState(ACCOUNT);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);

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

  // An account grant still names a home project: the one it is listed and
  // revoked under. The first project is a fine default, so the common case
  // asks the user for no decision at all.
  const homeProject = state.projects[0];
  const chosenProjectId = grantScope === ACCOUNT ? homeProject?.id || '' : projectId;
  const canApprove = Boolean(chosenProjectId);

  const decide = async (decision) => {
    if (decision === 'approve' && !canApprove) return;
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
        },
      });
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
      {COARSE_POINTER && LOOPBACK_CALLBACK && (
        <p className="oauth-consent-note">
          {state.client.client_name} is listening on its own machine, so open
          this link in a browser there — this device cannot reach it.
        </p>
      )}
      <p className="oauth-consent-note">
        A machine with no browser — a VM, a container, CI — uses a project key
        instead of this flow.{' '}
        {homeProject ? (
          <Link to={`/p/${homeProject.id}/settings?tab=keys`}>
            Mint one under MCP keys
          </Link>
        ) : 'Mint one under MCP keys'}
        , or run <code className="mono">merv-agent-runner pair</code> for the
        auto-run runner.
      </p>
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
