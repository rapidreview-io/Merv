import { useState } from 'react';
import { request } from '../api';
import { ConsentFrame } from './OAuthConsent';

/**
 * /go — pick up a pending consent by short code, typically on a phone.
 *
 * The laptop consent page mints the code; entering it here resolves the
 * original authorize query and continues the normal consent flow on this
 * device (sign-in wall included, if this device has no session yet).
 */
export default function GoEntry() {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await request(
        `/oauth/handoff/visit/${encodeURIComponent(code.trim())}`,
      );
      window.location.assign(`${window.location.origin}/merv/oauth/authorize?${result.query}`);
    } catch {
      setError('That code was not recognized — it may have expired. Codes last ten minutes and work once.');
      setBusy(false);
    }
  };

  return (
    <ConsentFrame>
      <h2 className="auth-modal-title">Continue a connection</h2>
      <p className="auth-modal-sub">
        Enter the code shown on the other screen to approve the connection
        from this device.
      </p>
      <form onSubmit={submit} className="oauth-go-form">
        <input
          className="auth-input oauth-go-input"
          value={code}
          onChange={event => setCode(event.target.value)}
          placeholder="AB12-CD34"
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !code.trim()}>
          {busy ? 'Looking up…' : 'Continue'}
        </button>
      </form>
      {error && <p className="oauth-consent-error">{error}</p>}
    </ConsentFrame>
  );
}
