import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'merv:token';
export const readToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const writeToken = (token: string | null) => {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* session storage unavailable; the token lives in memory only */
  }
};

const PROJECT_KEY = 'merv:project';
const storedProject = (): string | null => {
  try {
    return sessionStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
};
let memoryToken: string | null = readToken();
let selectedProject = storedProject();
let scopeEpoch = 0;
let identityEpoch = 0;
const scopeListeners = new Set<() => void>();
const changed = () => {
  scopeEpoch++;
  for (const listener of scopeListeners) listener();
};
export const currentToken = () => memoryToken;
export const identityVersion = () => identityEpoch;
export const scopeVersion = () => scopeEpoch;
export function useScopeVersion() {
  return useSyncExternalStore(
    (listener) => {
      scopeListeners.add(listener);
      return () => {
        scopeListeners.delete(listener);
      };
    },
    scopeVersion,
    () => 0,
  );
}
export const projectSelection = () => selectedProject;
export const setProject = (projectId: string | null) => {
  if (selectedProject === projectId) return;
  selectedProject = projectId;
  try {
    if (projectId) sessionStorage.setItem(PROJECT_KEY, projectId);
    else sessionStorage.removeItem(PROJECT_KEY);
  } catch {
    /* memory-only selection */
  }
  changed();
};
export const setToken = (token: string | null, options: { refresh?: boolean } = {}) => {
  memoryToken = token;
  writeToken(token);
  if (!options.refresh) {
    identityEpoch++;
    selectedProject = null;
    try {
      sessionStorage.removeItem(PROJECT_KEY);
    } catch {
      /* memory-only selection */
    }
    changed();
  }
};
export const hasToken = () => memoryToken !== null;
let refreshToken: (() => Promise<string | null>) | undefined;
export const setTokenRefresher = (refresh: (() => Promise<string | null>) | undefined) => {
  refreshToken = refresh;
  return () => {
    if (refreshToken === refresh) refreshToken = undefined;
  };
};
let refreshing:
  | { identity: number; handler: () => Promise<string | null>; result: Promise<string | null> }
  | undefined;
function refreshedToken(handler: () => Promise<string | null>): Promise<string | null> {
  if (refreshing?.identity === identityEpoch && refreshing.handler === handler)
    return refreshing.result;
  const pending = {
    identity: identityEpoch,
    handler,
    result: Promise.resolve()
      .then(handler)
      .catch(() => null)
      .finally(() => {
        if (refreshing === pending) refreshing = undefined;
      }),
  };
  refreshing = pending;
  return pending.result;
}
function requireScope(epoch: number): void {
  if (epoch !== scopeEpoch)
    throw new ApiError('scope_changed', 'The selected account or project changed', 409);
}
const authListeners = new Set<(error: ApiError) => void>();
export const onAccessLost = (listener: (error: ApiError) => void) => {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
};

/** Account operations are deliberately independent of a selected project. */
export async function accountRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; scoped?: boolean; credentials?: 'same-origin' } = {},
): Promise<T> {
  const epoch = scopeEpoch;
  const project = selectedProject;
  let bearer = memoryToken;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: options.credentials ?? 'omit',
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(options.scoped && project ? { 'x-merv-project-id': project } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      requireScope(epoch);
      throw new ApiError('offline', 'The Merv server did not answer', 0);
    }
    requireScope(epoch);
    const body = (await response.json().catch(() => null)) as
      (T & { error?: { code: string; message: string } }) | null;
    requireScope(epoch);
    if (response.status === 401 && attempt === 0 && bearer && refreshToken) {
      // Another request may already have refreshed this account while this response arrived.
      const refreshed = memoryToken !== bearer ? memoryToken : await refreshedToken(refreshToken);
      requireScope(epoch);
      if (refreshed) {
        setToken(refreshed, { refresh: true });
        bearer = refreshed;
        continue;
      }
    }
    if (!response.ok || !body || body.error) {
      const failure = body?.error ?? {
        code: response.ok ? 'invalid_response' : `http_${response.status}`,
        message: response.statusText || 'The server returned an invalid response',
      };
      const error = new ApiError(failure.code, failure.message, response.status);
      if (response.status === 401 || error.code === 'membership_required') {
        for (const listener of authListeners) listener(error);
      }
      throw error;
    }
    return body;
  }
}

/** One tool call over the same-origin JSON endpoint agents use. */
export async function call<T>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  const body = await accountRequest<{ result: T }>(`/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: input,
    scoped: true,
  });
  return body.result as T;
}

export interface Actor {
  id: string;
  projectId: string;
  name: string;
  role: 'operator' | 'producer' | 'reviewer' | 'reader';
  active: boolean;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  summary?: string;
  contextRevision?: number;
}
export interface UserKey {
  id: string;
  owner: { issuer: string; subject: string };
  projectId: string;
  grantScope: 'project' | 'account';
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface IssuedUserKey {
  key: UserKey;
  token: string;
}
export type Account =
  | { kind: 'actor'; actor: Actor; projects: Project[] }
  | { kind: 'key'; key: UserKey; projects: Project[] }
  | {
      kind: 'user';
      user: { issuer: string; subject: string; createdAt: string };
      projects: Project[];
    };
export type AccountSession =
  | { phase: 'projects'; account: Account; epoch: number }
  | { phase: 'ready'; account: Account; actor: Actor; project: Project; epoch: number };

/** Resolve account discovery before project-scoped reads, including a user's first empty account. */
export async function resolveAccountSession(): Promise<AccountSession> {
  const epoch = scopeEpoch;
  const account = await accountRequest<Account>('/account');
  requireScope(epoch);
  const selected =
    account.kind === 'actor'
      ? account.actor.projectId
      : account.kind === 'key' && account.key.grantScope === 'project'
        ? account.key.projectId
        : projectSelection();
  if (!selected || !account.projects.some((project) => project.id === selected)) {
    setProject(null);
    return { phase: 'projects', account, epoch: scopeEpoch };
  }
  setProject(selected);
  const selectedEpoch = scopeEpoch;
  const [actor, project] = await Promise.all([
    call<Actor>('actor.whoami'),
    call<Project>('project.get'),
  ]);
  requireScope(selectedEpoch);
  return { phase: 'ready', account, actor, project, epoch: selectedEpoch };
}

/** Owner key administration is independent of the selected project's membership. */
export const keyClient = {
  list: () => accountRequest<{ keys: UserKey[] }>('/account/keys'),
  create: (input: {
    projectId: string;
    grantScope?: 'project' | 'account';
    label?: string;
    expiresAt?: string | null;
  }) => accountRequest<IssuedUserKey>('/account/keys', { method: 'POST', body: input }),
  rotate: (id: string, input: { expiresAt?: string | null } = {}) =>
    accountRequest<IssuedUserKey>(`/account/keys/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: input,
    }),
  revoke: (id: string) =>
    accountRequest<{ revoked: true }>(`/account/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload(): void;
}

/** Load a tool result; `every` (ms) refreshes quietly while keeping the last good data on screen. */
export function useTool<T>(
  name: string | null,
  input: Record<string, unknown> = {},
  options: { every?: number } = {},
): Loaded<T> {
  const epoch = useScopeVersion();
  const key = name ? `${epoch}:${name}:${JSON.stringify(input)}` : null;
  const [state, setState] = useState<{ key: string | null; data?: T; error?: ApiError }>({
    key: null,
  });
  const [tick, setTick] = useState(0);
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    if (!key || !name) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const data = await call<T>(name, input);
        if (!cancelled && latest.current === key) setState({ key, data });
      } catch (error) {
        if (!cancelled && latest.current === key)
          setState((old) => ({
            key,
            data: old.key === key ? old.data : undefined,
            error: error as ApiError,
          }));
      } finally {
        // Wait for a response before polling again, including on slow remote storage.
        if (!cancelled && options.every) timer = setTimeout(() => void refresh(), options.every);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The serialized key captures the input object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, options.every]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: !!key && !current,
    reload,
  };
}
