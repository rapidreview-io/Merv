import { useEffect, useState } from 'react';
import { accountRequest } from './api';
import { useSession } from './session';

export function ConnectConsent({ requestId }: { requestId: string }) {
  const { project, account, chooseProject, signOut } = useSession();
  const [details, setDetails] = useState<{
    clientName: string;
    redirectUri: string;
    resource: string;
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    accountRequest<typeof details>(`/oauth/requests/${encodeURIComponent(requestId)}`)
      .then((value) => {
        if (live) setDetails(value);
      })
      .catch((e) => {
        if (live) setError(String(e.message));
      });
    return () => {
      live = false;
    };
  }, [requestId]);
  async function consent(allow: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await accountRequest<{ redirect: string }>(
        `/oauth/requests/${encodeURIComponent(requestId)}`,
        { method: 'POST', body: { projectId: project.id, allow } },
      );
      window.location.assign(result.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authorization failed');
      setBusy(false);
    }
  }
  return (
    <main className="page-stage" style={{ maxWidth: 720, margin: '3rem auto' }}>
      <h1>Connect your agent to Merv</h1>
      {details && (
        <>
          <p>
            <strong>{details.clientName}</strong> requests access to <code>{details.resource}</code>
            .
          </p>
          <p>Only approve a connection you just started. Client names are self-reported.</p>
          <p>
            Return address: <code>{details.redirectUri}</code>
          </p>
          <p>
            Selected project: <strong>{project.name}</strong>{' '}
            <button onClick={chooseProject}>Change project</button>
          </p>
          <p>
            Your agent can read and act with your current permissions across your projects. It
            cannot create accounts, manage memberships or grant itself permissions. No repository is
            required.
          </p>
          <p>
            The client stores and refreshes its credentials. Revoke this connection in Settings →
            Keys under “OAuth: {details.clientName}”. Sign in again after 30 days.
          </p>
          {account.kind !== 'user' && (
            <p>
              Sign in with a human account to authorize a connection.{' '}
              <button onClick={signOut}>Switch account</button>
            </p>
          )}
          <button disabled={busy || account.kind !== 'user'} onClick={() => consent(true)}>
            Authorize
          </button>{' '}
          <button disabled={busy} onClick={() => consent(false)}>
            Cancel
          </button>
        </>
      )}
      {!details && !error && <p>Loading connection…</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
