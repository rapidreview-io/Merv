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
  // The shell answers who and where with the rows the page needs anyway; a
  // composition without it still answers those two questions on their own tools.
  const shell = await call<{ actor?: Actor; project?: Project }>('ui.shell').catch(() => null);
  if (shell) remember('ui.shell', shell);
  const [actor, project] =
    shell?.actor && shell.project
      ? [shell.actor, shell.project]
      : await Promise.all([call<Actor>('actor.whoami'), call<Project>('project.get')]);
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
  /** When the data on screen arrived, so a failed refresh can say how old it is. */
  loadedAt: string | undefined;
  loading: boolean;
  reload(): void;
}

/**
 * The last good answer to each call, for the life of the page. A record opened beside its
 * list remounts the list, and without this the list would blank and read itself again for
 * data it already had; served from here it keeps its rows and refreshes underneath them.
 * Nothing is served that a live read is not already replacing, so this is invisible except
 * for the missing flash.
 */
const LAST = new Map<string, { data: unknown; loadedAt: string }>();
/** An answer the boot already holds, kept so the page that needs it does not ask again. */
export const remember = (name: string, data: unknown) =>
  LAST.set(`${scopeEpoch}:${name}:{}`, { data, loadedAt: new Date().toISOString() });

/**
 * One request per answer in flight. Two places on a page ask the same question —
 * the rail and the page it frames read the same home, a record opens beside its
 * list — and the second one joins the first request instead of making another.
 * A reload always asks again, so a command's own refresh never joins a read that
 * started before it.
 */
const FLIGHT = new Map<string, Promise<unknown>>();
async function shared<T>(
  key: string,
  name: string,
  input: Record<string, unknown>,
  fresh: boolean,
): Promise<T> {
  const joined = fresh ? undefined : (FLIGHT.get(key) as Promise<T> | undefined);
  if (joined) return await joined;
  const pending = call<T>(name, input);
  FLIGHT.set(key, pending);
  void pending
    .catch(() => undefined)
    .finally(() => {
      if (FLIGHT.get(key) === pending) FLIGHT.delete(key);
    });
  return await pending;
}

/**
 * Load a tool result; `every` (ms) refreshes quietly while keeping the last good data on
 * screen. A failed refresh keeps that data and its arrival time beside the error, so a view
 * degrades to one stale line rather than blanking a list that is still correct. The cadence
 * stops entirely while the tab is hidden and catches up once on return, so a backgrounded
 * page costs nothing; both rules live here rather than in any view.
 */
export function useTool<T>(
  name: string | null,
  input: Record<string, unknown> = {},
  options: { every?: number } = {},
): Loaded<T> {
  const epoch = useScopeVersion();
  const key = name ? `${epoch}:${name}:${JSON.stringify(input)}` : null;
  const [state, setState] = useState<{
    key: string | null;
    data?: T;
    loadedAt?: string;
    error?: ApiError;
  }>({ key: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    if (!key || !name) return;
    let cancelled = false;
    let asked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;
    const hidden = () => document.visibilityState === 'hidden';
    const schedule = () => {
      if (hidden()) waiting = true;
      else timer = setTimeout(() => void refresh(), options.every);
    };
    const resume = () => {
      if (!waiting || hidden()) return;
      waiting = false;
      void refresh();
    };
    const refresh = async () => {
      // A reload asks again; every other read joins one already in flight.
      const fresh = tick > 0 && !asked;
      asked = true;
      try {
        const data = await shared<T>(key, name, input, fresh);
        const loadedAt = new Date().toISOString();
        if (LAST.size > 64) LAST.clear();
        LAST.set(key, { data, loadedAt });
        if (!cancelled && latest.current === key) setState({ key, data, loadedAt });
      } catch (error) {
        if (!cancelled && latest.current === key)
          setState((old) => ({
            key,
            ...((old.key === key ? old : LAST.get(key)) as { data?: T; loadedAt?: string }),
            error: error as ApiError,
          }));
      } finally {
        // Wait for a response before polling again, including on slow remote storage.
        if (!cancelled && options.every) schedule();
      }
    };
    void refresh();
    if (options.every) document.addEventListener('visibilitychange', resume);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
    // The serialized key captures the input object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, options.every]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.key === key;
  // Before this mount's own read lands, the page shows what the last one saw.
  const kept = current || !key ? undefined : LAST.get(key);
  return {
    data: current ? state.data : (kept?.data as T | undefined),
    error: current ? state.error : undefined,
    loadedAt: current ? state.loadedAt : kept?.loadedAt,
    loading: !!key && !current && !kept,
    reload,
  };
}
