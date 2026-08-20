import { useEffect, useState } from 'react';
import { api, request } from '../api';
import { ConsentFrame, ScopeChoice } from './OAuthConsent';

const ACCOUNT = 'account';
const PROJECT = 'project';

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

function formatCode(code) {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function deviceError(err) {
  if (Number(err?.status) === 429) {
    return 'Too many wrong codes. Wait ten minutes, then try again.';
  }
  if (err?.data?.error === 'invalid_grant') {
    return 'No device is waiting with that code. Check the terminal — codes expire after ten minutes.';
  }
  return err?.data?.error_description || err?.message || 'Could not complete the request.';
}

/**
 * DeviceConsent — the RFC 8628 verification page at /oauth/device.
 *
 * The client on the remote machine polls the brain with a secret it alone
 * holds; this page only binds a short human-typed code to a consent decision.
 * Nothing here ever addresses the client's machine, which is the point: it is
 * the lane for a VM whose loopback no browser can reach.
 */
export default function DeviceConsent() {
  const initial = normalizeCode(new URLSearchParams(window.location.search).get('user_code'));
  const [code, setCode] = useState(initial);
  const [grant, setGrant] = useState(null);
  const [projects, setProjects] = useState([]);
  // Reaching every project is the common case; one project is the opt-in.
  const [grantScope, setGrantScope] = useState(ACCOUNT);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(''); // '' | 'approved' | 'denied'

  const lookup = async (value) => {
    const normalized = normalizeCode(value);
    if (normalized.length !== 8) {
      setError('Enter the 8-character code the client printed.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const [details, projectResult] = await Promise.all([
        request(`/oauth/device/details?user_code=${encodeURIComponent(normalized)}`),
        api.listProjects(),
      ]);
      setGrant(details);
      setProjects(projectResult?.projects || []);
    } catch (err) {
      setError(deviceError(err));
    } finally {
      setBusy(false);
    }
  };

  // A verification_uri_complete link carries the code; skip the typing step.
  useEffect(() => {
    if (initial.length === 8) lookup(initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const homeProject = projects[0];
  const chosenProjectId = grantScope === ACCOUNT ? homeProject?.id || '' : projectId;
  const canApprove = Boolean(chosenProjectId);

  const decide = async (decision) => {
    if (decision === 'approve' && !canApprove) return;
    setBusy(true);
    setError('');
    try {
      await request('/oauth/device', {
        method: 'POST',
        body: {
          user_code: grant.user_code,
          decision,
          project_id: decision === 'approve' ? chosenProjectId : '',
          grant_scope: grantScope,
        },
      });
      setDone(decision === 'approve' ? 'approved' : 'denied');
    } catch (err) {
      setError(deviceError(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <ConsentFrame>
        <h2 className="auth-modal-title">
          {done === 'approved' ? 'Connected' : 'Denied'}
        </h2>
        <p className="auth-modal-sub">
          {done === 'approved'
            ? `You can return to the terminal — ${grant?.client_name || 'the client'} finishes signing in on its own within a few seconds.`
            : 'The request was denied. The client will be told on its next poll.'}
        </p>
      </ConsentFrame>
    );
  }

  if (!grant) {
    return (
      <ConsentFrame>
        <h2 className="auth-modal-title">Connect a device</h2>
        <p className="auth-modal-sub">
          Enter the code the client printed in its terminal.
        </p>
        <form
          onSubmit={(event) => { event.preventDefault(); lookup(code); }}
        >
          <label className="auth-field">
            <span>Code</span>
            <input
              className="auth-input mono"
              value={formatCode(code)}
              onChange={(event) => { setCode(normalizeCode(event.target.value)); setError(''); }}
              placeholder="XXXX-XXXX"
              maxLength={9}
              autoComplete="off"
              spellCheck={false}
              aria-label="Device code"
            />
          </label>
          {error && <p className="oauth-consent-error">{error}</p>}
          <div className="oauth-consent-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      </ConsentFrame>
    );
  }

  return (
    <ConsentFrame>
      <h2 className="auth-modal-title">Connect {grant.client_name || 'this client'}</h2>
      <p className="auth-modal-sub">
        Code {grant.user_code}. Choose how much of Merv this client may reach.
        You can revoke it at any time.
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
      <p className="oauth-consent-resource">Resource: {grant.resource}</p>
      {error && <p className="oauth-consent-error">{error}</p>}
      <div className="oauth-consent-actions">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => decide('deny')}>
          Deny
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
