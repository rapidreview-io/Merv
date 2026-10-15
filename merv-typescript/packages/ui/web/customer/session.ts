import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../api';
import { customerRequest, onBoundElsewhere, said, setCredentials, takeCapability } from './api';

/** GET /session: the request's version, whether a browser is bound to it, and its Supabase. */
export interface SessionInfo {
  version: number;
  bound: boolean;
  login: { url: string; publishableKey: string };
}

export type CustomerSession =
  | { phase: 'loading' }
  | { phase: 'invalid'; message: string }
  /** The page could not be opened just now: a server, network or sign-in failure. */
  | { phase: 'failed'; message: string }
  /** Another browser holds the request; this one may take it over. */
  | { phase: 'elsewhere'; busy?: boolean; error?: string }
  | { phase: 'ready'; info: SessionInfo };

export interface SessionControls {
  /** Rebinds the request to this browser (POST /session {takeOver: true}). */
  takeOver(): Promise<void>;
  /** Opens the page again after a failure. */
  retry(): void;
}

const INVALID = 'This link is not valid.';
const FAILED = 'Couldn’t open the experiment. Try again.';
/** Only the server refusing the link means the link is wrong; anything else may pass. */
const refused = (cause: unknown) =>
  cause instanceof ApiError && [401, 403, 404].includes(cause.status);

/**
 * Who is acting on this request: the link's capability, plus this browser's anonymous Supabase
 * user, made silently the first time and kept in localStorage so the browser stays the same
 * person. The first POST /session binds the request to that user; afterwards only it, with the
 * capability, acts as the customer, until another browser holding the link takes it over.
 */
export function useCustomerSession(
  request: string | null,
  options: { createClient?: typeof createClient } = {},
): [CustomerSession, SessionControls] {
  const [state, setState] = useState<CustomerSession>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const client = useRef<SupabaseClient | null>(null);
  const token = useRef<string | null>(null);
  const info = useRef<SessionInfo | null>(null);

  const bind = async (takeOver = false) => {
    await customerRequest('/session', { method: 'POST', body: takeOver ? { takeOver } : {} });
    setState({ phase: 'ready', info: info.current! });
  };

  useEffect(() => {
    if (!request) return setState({ phase: 'invalid', message: INVALID });
    const capability = takeCapability(request);
    if (!capability) return setState({ phase: 'invalid', message: INVALID });
    let cancelled = false;
    setCredentials({
      request,
      capability,
      identity: () => token.current,
      renew: async () => {
        const next = await client.current?.auth.refreshSession().catch(() => null);
        token.current = next?.data.session?.access_token ?? null;
        return token.current;
      },
    });
    let unsubscribe = () => {};
    // Taken over by another browser while open here: this one may take it back.
    const away = onBoundElsewhere(() => !cancelled && setState({ phase: 'elsewhere' }));
    void (async () => {
      try {
        const read = await customerRequest<SessionInfo>('/session', { identity: false });
        if (cancelled) return;
        info.current = read;
        const supabase = (options.createClient ?? createClient)(
          read.login.url,
          read.login.publishableKey,
          {
            auth: {
              storageKey: `merv:customer:${read.login.url}`,
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: false,
            },
          },
        );
        client.current = supabase;
        const listening = supabase.auth.onAuthStateChange((_event, session) => {
          token.current = session?.access_token ?? null;
        });
        unsubscribe = () => listening.data.subscription.unsubscribe();
        let session = (await supabase.auth.getSession()).data.session;
        if (!session) {
          const made = await supabase.auth.signInAnonymously();
          if (made.error) throw made.error;
          session = made.data.session;
        }
        if (cancelled) return;
        token.current = session?.access_token ?? null;
        try {
          await bind();
        } catch (cause) {
          if (cancelled) return;
          if (cause instanceof ApiError && cause.code === 'bound_elsewhere')
            setState({ phase: 'elsewhere' });
          else throw cause;
        }
      } catch (cause) {
        if (cancelled) return;
        setState(
          refused(cause)
            ? { phase: 'invalid', message: said(cause, INVALID) }
            : { phase: 'failed', message: FAILED },
        );
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      away();
    };
    // The page serves one request for its life; a retry opens it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, attempt]);

  const controls = useMemo<SessionControls>(
    () => ({
      takeOver: async () => {
        setState({ phase: 'elsewhere', busy: true });
        try {
          await bind(true);
        } catch (cause) {
          setState({ phase: 'elsewhere', error: said(cause, 'Try again.') });
        }
      },
      retry: () => {
        setState({ phase: 'loading' });
        setAttempt((value) => value + 1);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return [state, controls];
}
