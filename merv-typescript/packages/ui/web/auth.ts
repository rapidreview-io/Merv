import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { currentToken, identityVersion, setToken, setTokenRefresher } from './api';

export interface AuthConfiguration {
  enabled: boolean;
  login?: { url: string; publishableKey: string };
}
const MODE_KEY = 'merv:auth-mode';
const USER_KEY = 'merv:shared-account';
const memory = new Map<string, string>();
const storage = {
  getItem(key: string) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string) {
    memory.set(key, value);
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* memory only */
    }
  },
  removeItem(key: string) {
    memory.delete(key);
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* memory only */
    }
  },
};
let mode: 'local' | 'shared' = storage.getItem(MODE_KEY) === 'shared' ? 'shared' : 'local';
let modeVersion = 0;
let modeChanged: (() => void) | undefined;
export const setAuthMode = (value: 'local' | 'shared') => {
  mode = value;
  modeVersion++;
  storage.setItem(MODE_KEY, value);
  setToken(null);
  modeChanged?.();
};

export interface BrowserAuth {
  client?: SupabaseClient;
  configuration: AuthConfiguration;
  dispose(): void;
}
interface Runtime extends BrowserAuth {
  listeners: Set<() => void>;
}
type AuthOptions = { createClient?: typeof createClient; fetch?: typeof globalThis.fetch };
let initialization: Promise<Runtime> | undefined;

async function initialize(options: AuthOptions): Promise<Runtime> {
  // The public handshake must not carry a cached bearer or browser cookies.
  const response = await (options.fetch ?? fetch)('/auth/config', {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Authentication configuration is unavailable.');
  const configuration = (await response.json()) as AuthConfiguration;
  if (typeof configuration?.enabled !== 'boolean')
    throw new Error('Invalid authentication configuration.');
  const listeners = new Set<() => void>();
  if (!configuration.enabled || !configuration.login)
    return { configuration, listeners, dispose() {} };
  const client = (options.createClient ?? createClient)(
    configuration.login.url,
    configuration.login.publishableKey,
    {
      auth: {
        storage,
        storageKey: `merv:shared:${configuration.login.url}`,
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );
  let disposed = false;
  let allowRefresh = mode === 'shared';
  let lastAccount = storage.getItem(USER_KEY);
  const initialMode = modeVersion;
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const accountKey = (session: Session) => `${configuration.login!.url}\n${session.user.id}`;
  const applySession = (session: Session): boolean => {
    const key = accountKey(session);
    const sameAccount = lastAccount === key;
    lastAccount = key;
    storage.setItem(USER_KEY, key);
    setToken(session.access_token, { refresh: sameAccount });
    return sameAccount;
  };
  const changedMode = () => {
    allowRefresh = false;
  };
  modeChanged = changedMode;
  let refreshing: { identity: number; mode: number; result: Promise<string | null> } | undefined;
  const removeRefresher = setTokenRefresher(() => {
    if (disposed || mode !== 'shared' || !allowRefresh || !currentToken())
      return Promise.resolve(null);
    const generation = identityVersion();
    const selectedMode = modeVersion;
    const account = lastAccount;
    if (refreshing?.identity === generation && refreshing.mode === selectedMode)
      return refreshing.result;
    const pending = {
      identity: generation,
      mode: selectedMode,
      result: client.auth
        .refreshSession()
        .then(({ data, error }) => {
          if (
            disposed ||
            mode !== 'shared' ||
            modeVersion !== selectedMode ||
            identityVersion() !== generation ||
            error ||
            !data.session ||
            accountKey(data.session) !== account
          )
            return null;
          applySession(data.session);
          return data.session.access_token;
        })
        .catch(() => null)
        .finally(() => {
          if (refreshing === pending) refreshing = undefined;
        }),
    };
    refreshing = pending;
    return pending.result;
  });
  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => {
    // No SDK calls are awaited inside its callback: that callback holds the auth lock.
    if (disposed || mode !== 'shared') return;
    if (event === 'INITIAL_SESSION' && modeVersion !== initialMode) return;
    if (
      event === 'TOKEN_REFRESHED' &&
      (!allowRefresh || !session || accountKey(session) !== lastAccount)
    )
      return;
    if (session) {
      const sameAccount = applySession(session);
      allowRefresh = true;
      if (!sameAccount || event !== 'TOKEN_REFRESHED') publish();
    } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      allowRefresh = false;
      lastAccount = null;
      storage.removeItem(USER_KEY);
      setToken(null);
      publish();
    }
  });
  return {
    client,
    configuration,
    listeners,
    dispose() {
      disposed = true;
      subscription.unsubscribe();
      void client.auth.stopAutoRefresh().catch(() => undefined);
      removeRefresher();
      if (modeChanged === changedMode) modeChanged = undefined;
    },
  };
}

/** Share one client across async StrictMode mounts; each caller owns only its subscription. */
export async function browserAuth(
  onChanged: () => void,
  options: AuthOptions = {},
): Promise<BrowserAuth> {
  if (!initialization) {
    const pending = initialize(options).catch((error) => {
      if (initialization === pending) initialization = undefined;
      throw error;
    });
    initialization = pending;
  }
  const pending = initialization;
  const runtime = await pending;
  const listener = () => onChanged();
  runtime.listeners.add(listener);
  let disposed = false;
  return {
    client: runtime.client,
    configuration: runtime.configuration,
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.listeners.delete(listener);
      if (runtime.listeners.size === 0) {
        runtime.dispose();
        if (initialization === pending) initialization = undefined;
      }
    },
  };
}
