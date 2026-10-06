import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

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
/** The project an account last opened in this browser, so a new tab or a reload opens it again. */
const LAST_KEY = 'merv:last-project';
const storedProject = (): string | null => {
  try {
    return sessionStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
};
const lastProject = (who: string): string | null => {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
    return last?.who === who && typeof last.project === 'string' ? last.project : null;
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
    else {
      // Choosing another project, or losing this one, forgets it for the browser too.
      sessionStorage.removeItem(PROJECT_KEY);
      localStorage.removeItem(LAST_KEY);
    }
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
      (T & { error?: { code: string; message: string; details?: unknown } }) | null;
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
      // A validation answer's own sentences say what to fix; only a generic check needs its field.
      const details = [failure.details as { path?: unknown[]; message?: string; code?: string }[]]
        .flat()
        .filter((d) => d?.message)
        .map((d) => [d.code !== 'custom' && d.path?.join('.'), d.message].filter(Boolean).join(' '))
        .join('; ');
      const error = new ApiError(failure.code, details || failure.message, response.status);
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
  const who = account.kind === 'user' ? `${account.user.issuer} ${account.user.subject}` : '';
  const selected =
    account.kind === 'actor'
      ? account.actor.projectId
      : account.kind === 'key' && account.key.grantScope === 'project'
        ? account.key.projectId
        : (projectSelection() ?? (who && lastProject(who)));
  if (!selected || !account.projects.some((project) => project.id === selected)) {
    setProject(null);
    return { phase: 'projects', account, epoch: scopeEpoch };
  }
  setProject(selected);
  try {
    if (who) localStorage.setItem(LAST_KEY, JSON.stringify({ who, project: selected }));
  } catch {
    /* this tab alone remembers it */
  }
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
 * One read per question, however many places on the page ask it: the rail and the page it
 * frames read the same home, a record opens beside its list, and every one of them shares
 * one answer and one timer. Each place says how often it wants the answer, and the read
 * polls at the shortest of those. Its last good answer outlives the places that asked, for
 * the life of the page, so a list remounted beside a record keeps its rows and refreshes
 * underneath them instead of blanking.
 */
interface Read {
  name: string;
  input: Record<string, unknown>;
  epoch: number;
  shown: { data?: unknown; error?: ApiError; loadedAt?: string };
  /** The shown answer as text, so an identical poll can be told apart from a changed one. */
  text?: string;
  listeners: Set<() => void>;
  /** Each mounted place's cadence in ms, or undefined for a place that does not poll. */
  readers: Map<object, number | undefined>;
  flight?: Promise<void>;
  /** The newest request started, and the newest one whose answer is shown. */
  asked: number;
  answered: number;
  timer?: ReturnType<typeof setTimeout>;
  last: number;
  /** A poll that fell due while the tab was hidden, asked once the tab is shown. */
  waiting: boolean;
}
const READS = new Map<string, Read>();
const keyOf = (epoch: number, name: string, input: Record<string, unknown>) =>
  `${epoch}:${name}:${JSON.stringify(input)}`;
function readOf(key: string, name: string, input: Record<string, unknown>, epoch: number): Read {
  const known = READS.get(key);
  if (known) return known;
  if (READS.size > 64)
    for (const [old, read] of READS)
      if (!read.readers.size && !read.listeners.size) READS.delete(old);
  const read: Read = {
    name,
    input,
    epoch,
    shown: {},
    listeners: new Set(),
    readers: new Map(),
    asked: 0,
    answered: 0,
    last: 0,
    waiting: false,
  };
  READS.set(key, read);
  return read;
}
/** An answer the boot already holds, kept so the page that needs it does not ask again. */
export const remember = (name: string, data: unknown) => {
  readOf(keyOf(scopeEpoch, name, {}), name, {}, scopeEpoch).shown = {
    data,
    loadedAt: new Date().toISOString(),
  };
};
const hidden = () => document.visibilityState === 'hidden';
let watchingVisibility = false;
/**
 * The next poll, counted from the last answer at the shortest cadence any place asks for. The
 * cadence stops entirely while the tab is hidden and catches up once on return, so a
 * backgrounded page costs nothing.
 */
function schedule(read: Read): void {
  clearTimeout(read.timer);
  read.waiting = false;
  const every = Math.min(...[...read.readers.values()].map((ms) => ms || Infinity));
  if (read.flight || every === Infinity) return;
  if (!watchingVisibility) {
    watchingVisibility = true;
    document.addEventListener('visibilitychange', () => {
      if (hidden()) return;
      for (const each of READS.values()) if (each.waiting) void ask(each);
    });
  }
  if (hidden()) read.waiting = true;
  else read.timer = setTimeout(() => void ask(read), Math.max(0, read.last + every - Date.now()));
}
/**
 * Ask the server, joining a request already in flight unless `fresh`: a reload always asks
 * again, so a command's own refresh never joins a read that started before it. A failed
 * refresh keeps the last good data and its arrival time beside the error, so a view degrades
 * to one stale line rather than blanking a list that is still correct.
 */
function ask(read: Read, fresh = false): Promise<void> {
  if (read.epoch !== scopeEpoch) return Promise.resolve();
  if (read.flight && !fresh) return read.flight;
  clearTimeout(read.timer);
  const asked = ++read.asked;
  const show = (shown: Read['shown'], text?: string) => {
    if (asked < read.answered) return;
    read.answered = asked;
    // An identical answer keeps the object every view holds, so nothing re-renders; only its
    // arrival time moves, read at each view's next render.
    if (text !== undefined && text === read.text && !read.shown.error)
      return void (read.shown.loadedAt = shown.loadedAt);
    if (text !== undefined) read.text = text;
    read.shown = shown;
    for (const listener of read.listeners) listener();
  };
  const flight = call(read.name, read.input)
    .then(
      (data) => show({ data, loadedAt: new Date().toISOString() }, JSON.stringify(data)),
      (error: unknown) => show({ ...read.shown, error: error as ApiError }),
    )
    .finally(() => {
      // Wait for a response before polling again, including on slow remote storage.
      if (read.flight !== flight) return;
      read.flight = undefined;
      read.last = Date.now();
      schedule(read);
    });
  read.flight = flight;
  return flight;
}

/**
 * Refresh every mounted read of these tools, whatever input each was given. A page that has
 * just changed a record says so, rather than leaving the lists beside it to notice on their
 * own poll: a verdict left the Work row reading IN REVIEW for seven seconds after the record
 * itself said the task had failed.
 */
export function refreshTools(...names: string[]): void {
  for (const [key, read] of READS)
    if (read.readers.size && names.some((name) => key.includes(`:${name}:`))) void ask(read, true);
}

const NOTHING: Read['shown'] = {};
/**
 * Load a tool result; `every` (ms) refreshes quietly while keeping the last good data on
 * screen. Every place asking the same question shares one read (see `Read`).
 */
export function useTool<T>(
  name: string | null,
  input: Record<string, unknown> = {},
  options: { every?: number } = {},
): Loaded<T> {
  const epoch = useScopeVersion();
  const key = name ? keyOf(epoch, name, input) : null;
  // The serialized key captures the input object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useMemo(() => (key ? readOf(key, name!, input, epoch) : undefined), [key]);
  const shown = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        read?.listeners.add(listener);
        return () => void read?.listeners.delete(listener);
      },
      [read],
    ),
    () => read?.shown ?? NOTHING,
    () => NOTHING,
  );
  const place = useRef({}).current;
  useEffect(() => {
    if (!read) return;
    // A place that opens asks at once, joining a read already in flight, unless another
    // place already keeps this answer fresh on its own cadence.
    const kept = read.shown.data !== undefined && [...read.readers.values()].some(Boolean);
    read.readers.set(place, options.every);
    if (kept) schedule(read);
    else void ask(read);
    return () => {
      read.readers.delete(place);
      // What the next place to open sees is the last good answer, never an old failure.
      if (!read.readers.size && read.shown.error)
        read.shown = { data: read.shown.data, loadedAt: read.shown.loadedAt };
      schedule(read);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);
  // The cadence is read as each wait is set, so a page that changes it is not read again at
  // once: the wait is set again, counted from the last answer.
  useEffect(() => {
    if (!read?.readers.has(place)) return;
    read.readers.set(place, options.every);
    schedule(read);
  }, [read, place, options.every]);
  const reload = useCallback(() => void (read && ask(read, true)), [read]);
  return {
    data: shown.data as T | undefined,
    error: shown.error,
    loadedAt: shown.loadedAt,
    loading: !!key && !shown.data && !shown.error,
    reload,
  };
}
