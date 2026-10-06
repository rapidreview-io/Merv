import { useEffect, useState } from 'react';
import { accountRequest } from '../api';
import { useCurrent } from '../mutations';
interface HuggingFaceStatus {
  available: boolean;
  configured: boolean;
  updatedAt: string | null;
}

/** Account-only credential input. The token exists only in this form and its PUT request. */
export function HuggingFaceSettings() {
  const current = useCurrent();
  const [status, setStatus] = useState<HuggingFaceStatus>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setStatus(undefined);
    setToken('');
    setError(undefined);
    setBusy(false);
    void accountRequest<HuggingFaceStatus>('/secrets/huggingface').then(
      (value) => {
        if (current()) setStatus(value);
      },
      () => {
        if (current()) setError('Hugging Face access could not be loaded.');
      },
    );
  }, [current]);
  const update = async (method: 'PUT' | 'DELETE') => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const body = method === 'PUT' ? { token } : undefined;
    // Clear even if the network fails; no retry queue or browser persistence retains the value.
    setToken('');
    try {
      const value = await accountRequest<HuggingFaceStatus>('/secrets/huggingface', {
        method,
        body,
      });
      if (current()) setStatus(value);
    } catch {
      if (current())
        setError(
          method === 'PUT'
            ? 'The token could not be saved. Enter it again to retry.'
            : 'The token could not be removed.',
        );
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <section className="stack" aria-label="Hugging Face">
      <h2 className="section-title">Hugging Face</h2>
      <p className="muted">
        Use a fine-grained read-only token. New hosted workers get temporary download access to your
        models and datasets; your account token stays on the server.
      </p>
      {status && (
        <p role="status">
          {!status.available
            ? 'Token storage is unavailable.'
            : status.configured
              ? 'Token saved.'
              : 'No token saved.'}
        </p>
      )}
      {status?.updatedAt && (
        <p className="muted">
          Updated{' '}
          <time dateTime={status.updatedAt}>{new Date(status.updatedAt).toLocaleString()}</time>
        </p>
      )}
      <form
        className="cluster"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void update('PUT');
        }}
      >
        <input
          className="input"
          type="password"
          aria-label="Hugging Face token"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          value={token}
          disabled={!status?.available || busy}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="btn" type="submit" disabled={!status?.available || busy || !token}>
          Save token
        </button>
        {status?.configured && (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void update('DELETE')}
          >
            Remove token
          </button>
        )}
      </form>
      {status?.configured && (
        <p className="muted">
          Changes apply to new worker launches. Running workers keep their token until they stop.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
