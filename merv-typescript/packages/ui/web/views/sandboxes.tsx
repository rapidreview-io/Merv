import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, accountRequest, scopeVersion, useScopeVersion } from '../api';

export interface SandboxesConnectionStatus {
  available: boolean;
  connected: boolean;
  connectionId?: string | null;
  accountId?: string | null;
  memberId?: string | null;
  connectedAt?: string | null;
  url: string | null;
}

const request = <T,>(action = '', method = 'GET', body?: object) =>
  accountRequest<T>(`/sandboxes/connection${action}`, {
    scoped: true,
    credentials: 'same-origin',
    method,
    ...(body === undefined ? {} : { body }),
  });

/** Same human account, with explicit permission for this project's compute. */
export function SandboxesConnection({
  onAvailable,
}: {
  onAvailable?: (available: boolean) => void;
}) {
  const epoch = useScopeVersion();
  const [status, setStatus] = useState<SandboxesConnectionStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const finishing = useRef<{ epoch: number; result: Promise<SandboxesConnectionStatus> }>();
  const current = useCallback(() => mounted.current && scopeVersion() === epoch, [epoch]);
  const callback = new URLSearchParams(window.location.search).get('sandboxes') === 'complete';
  const finish = useCallback(() => {
    if (finishing.current?.epoch !== epoch)
      finishing.current = {
        epoch,
        result: request<SandboxesConnectionStatus>('/finish', 'POST', {}),
      };
    return finishing.current.result;
  }, [epoch]);
  useEffect(() => {
    mounted.current = true;
    setStatus(undefined);
    setError(undefined);
    setBusy(true);
    void (callback ? finish() : request<SandboxesConnectionStatus>())
      .then(
        (value) => {
          if (!current()) return;
          setStatus(value);
          onAvailable?.(value.available);
          if (callback) {
            const url = new URL(window.location.href);
            url.searchParams.delete('sandboxes');
            window.history.replaceState(window.history.state, '', url);
          }
        },
        (failure: unknown) => {
          if (!current()) return;
          onAvailable?.(false);
          if (!(failure instanceof ApiError && failure.status === 404))
            setError(
              failure instanceof Error
                ? failure.message
                : 'Compute connection could not be loaded.',
            );
        },
      )
      .finally(() => {
        if (current()) setBusy(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [epoch, current, finish, onAvailable]);

  async function change(action: 'start' | 'disconnect') {
    if (busy || !current()) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'start') {
        const value = await request<{ url: string }>('/start', 'POST', {});
        if (current()) window.location.assign(value.url);
      } else {
        const value = await request<SandboxesConnectionStatus>('', 'DELETE');
        if (current()) setStatus(value);
      }
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error ? failure.message : 'Compute permission could not be updated.',
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  if (!status?.available && !error) return null;
  return (
    <section className="stack" aria-label="Sandboxes compute">
      <h2 className="section-title">Compute</h2>
      {status?.available && (
        <>
          <p className="muted">
            Use your Supabase account in Merv or Sandboxes to see the same compute and spending.
          </p>
          <p role="status">
            {status.connected
              ? 'This project bills the account you approved.'
              : 'Allow this project to use compute.'}
          </p>
          {status.connected && (
            <p className="muted">
              Disconnect blocks new access. Existing rentals and admitted jobs continue until they
              expire or you stop them in Sandboxes.
            </p>
          )}
          <div className="cluster">
            {!status.connected && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void change('start')}
              >
                Enable compute
              </button>
            )}
            {status.connected && status.url && (
              <a className="btn btn--primary" href={status.url} target="_blank" rel="noreferrer">
                View compute
              </a>
            )}
            {status.connected && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void change('disconnect')}
              >
                Disconnect
              </button>
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
