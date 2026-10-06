import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, accountRequest, scopeVersion, useScopeVersion } from '../api';

interface SandboxesConnectionStatus {
  available: boolean;
  connected: boolean;
  connectionId?: string | null;
  accountId?: string | null;
  memberId?: string | null;
  connectedAt?: string | null;
  url: string | null;
  funding?: 'managed' | 'personal';
  managedAvailable?: boolean;
  allowance?: {
    budgets: {
      scope: string;
      target: string;
      window: string;
      metric: string;
      currency: string;
      provider: string | null;
      source: string | null;
      cap: string | null;
      accrued: string;
      reserved: string;
      available: string | null;
      accounting_complete: boolean;
    }[];
  };
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
          onAvailable?.(!(failure instanceof ApiError && failure.status === 404));
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

  useEffect(() => {
    if (!status?.connected || status.funding !== 'managed') return;
    const timer = setInterval(() => {
      void request<SandboxesConnectionStatus>().then(
        (value) => {
          if (current()) {
            setStatus(value);
            setError(undefined);
          }
        },
        () => {
          if (current()) setError('Compute usage could not be refreshed.');
        },
      );
    }, 60_000);
    return () => clearInterval(timer);
  }, [current, status?.connected, status?.funding]);

  async function change(action: 'start' | 'managed' | 'disconnect') {
    if (busy || !current()) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'managed') {
        const value = await request<SandboxesConnectionStatus>('/managed', 'POST', {});
        if (current()) setStatus(value);
      } else if (action === 'start') {
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
  const managed = status?.funding === 'managed';
  const budget = status?.allowance?.budgets
    .filter(
      (b) =>
        b.scope === 'member' &&
        b.target === status.memberId &&
        b.window === 'month' &&
        b.metric === 'money' &&
        b.currency === 'USD' &&
        !b.provider &&
        !b.source &&
        b.cap !== null,
    )
    .sort((a, b) => Number(a.cap) - Number(b.cap))[0];
  return (
    <section className="stack" aria-label="Sandboxes compute">
      <h2 className="section-title">Compute</h2>
      {status?.available && (
        <>
          <p className="muted">
            {status.managedAvailable
              ? 'Merv-managed ML is funded by the project owner’s Merv account. Its monthly allowance is shared across that account’s projects.'
              : 'Use your Supabase account in Merv or Sandboxes to see the same compute and spending.'}
          </p>
          <p role="status">
            {managed
              ? 'This project uses Merv-managed ML.'
              : status.managedAvailable
                ? 'Enable Merv-managed ML to run compute.'
                : status.connected
                  ? 'This project bills the account you approved.'
                  : 'Allow this project to use compute.'}
          </p>
          {managed && budget && (
            <p role="status">
              ${Number(budget.accrued).toFixed(2)} used · ${Number(budget.reserved).toFixed(2)}{' '}
              reserved of ${Number(budget.cap).toFixed(0)} per account this month (UTC).
              {!budget.accounting_complete &&
                ' Accounting is incomplete; new compute may be blocked.'}
            </p>
          )}
          {status.connected && (
            <p className="muted">
              Disconnect blocks new access. Existing rentals and admitted jobs continue until they
              expire or you stop them in Sandboxes.
            </p>
          )}
          <div className="cluster">
            {(!status.connected || (status.managedAvailable && !managed)) && (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void change(status.managedAvailable ? 'managed' : 'start')}
              >
                {status.managedAvailable ? 'Enable Merv-managed ML' : 'Enable compute'}
              </button>
            )}
            {status.connected && !managed && status.url && (
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
