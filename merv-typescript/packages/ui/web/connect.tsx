import { useEffect, useState } from 'react';
import { accountRequest } from './api';
import { Icon } from './icons';
import { useAccount } from './session';

/** The consent an agent client opens: one card, the three facts as labelled fields, what the
 *  connection can and cannot do as a list, one primary control. */
export function ConnectConsent({ requestId }: { requestId: string }) {
  const { account, signOut } = useAccount()!;
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
        { method: 'POST', body: { allow } },
      );
      window.location.assign(result.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Authorization failed');
      setBusy(false);
    }
  }
  const human = account.kind === 'user';
  return (
    <main className="signin consent">
      <section className="consent-card" aria-busy={!details && !error}>
        <div className="signin-wordmark">merv</div>
        <h1 className="signin-title">Connect your agent</h1>
        {details && (
          <>
            <p className="consent-warn">
              Approve only a connection you just started. Client names are self-reported.
            </p>
            <dl className="consent-fields">
              <div>
                <dt>Client</dt>
                <dd>{details.clientName}</dd>
              </div>
              <div>
                <dt>Access to</dt>
                <dd className="mono wrap">{details.resource}</dd>
              </div>
              <div>
                <dt>Returns to</dt>
                <dd className="mono wrap">{details.redirectUri}</dd>
              </div>
            </dl>
            <ul className="consent-grants">
              <li>
                <Icon name="check" size={14} />
                Reads and acts with your permissions in every project you belong to, now and as your
                memberships change
              </li>
              <li>
                <Icon name="check" size={14} />
                Needs no repository and no project yet
              </li>
              <li className="consent-grant--not">
                <Icon name="close" size={14} />
                Cannot create accounts, manage memberships or grant itself permissions
              </li>
            </ul>
            {!human && (
              <p className="consent-warn" role="status">
                Sign in with a human account to authorize.{' '}
                <button type="button" className="signin-switch" onClick={signOut}>
                  Switch account
                </button>
              </p>
            )}
            <div className="consent-actions">
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy}
                onClick={() => consent(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !human}
                onClick={() => consent(true)}
              >
                {busy ? 'Authorizing…' : 'Authorize'}
              </button>
            </div>
            <p className="consent-foot">
              The client keeps and refreshes its credentials; sign in again after 30 days. Revoke it
              any time under <a href="/ui/account/keys">Account keys</a> as “OAuth:{' '}
              {details.clientName}”.
            </p>
          </>
        )}
        {!details && !error && <p className="signin-help">Loading connection…</p>}
        {error && (
          <p className="consent-warn" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
