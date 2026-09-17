import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  accountRequest,
  hasToken,
  identityVersion,
  onAccessLost,
  resolveAccountSession,
  scopeVersion,
  setProject,
  setToken,
  useScopeVersion,
  type Actor,
  type Project,
  type Account,
  type AccountSession,
} from './api';
import { Failure, Field } from './components';
import { browserAuth, setAuthMode, type AuthConfiguration } from './auth';
import { KeysPanel } from './views/keys';

export type { Actor, Project, Account } from './api';
interface Session {
  actor: Actor;
  project: Project;
  account: Account;
  chooseProject(): void;
  manageKeys(): void;
  signOut(): void;
}
const SessionContext = createContext<Session | null>(null);
export const useSession = (): Session => {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
};
/** The identity a page's own state belongs to: when it changes, the page starts again. */
export const useScopeKey = () => {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return `${epoch}:${project.id}:${actor.id}:${actor.role}`;
};

function extractToken(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed.token === 'string' ? parsed.token : '';
  } catch {
    return '';
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed.');

function SignIn({
  client,
  configuration,
  onSignedIn,
  initialError,
}: {
  client?: SupabaseClient;
  configuration?: AuthConfiguration;
  onSignedIn(): void;
  initialError?: string;
}) {
  const [value, setValue] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(initialError), [initialError]);
  const passwordSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setError(undefined);
    setAuthMode('shared');
    try {
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      setPassword('');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  const googleSignIn = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    setAuthMode('shared');
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/ui/` },
      });
      if (error) throw error;
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  };
  const localSignIn = async (event: FormEvent) => {
    event.preventDefault();
    const token = extractToken(value);
    if (!token) {
      setError('Paste a bearer token or a credential file.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setAuthMode('local');
    setToken(token);
    const epoch = scopeVersion();
    try {
      await accountRequest<Account>('/account');
      setValue('');
      onSignedIn();
    } catch (error) {
      if (scopeVersion() === epoch) {
        setToken(null);
        setError(message(error));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="signin">
      <section className="signin-card card">
        <div className="signin-wordmark">merv</div>
        <h1 className="signin-title">Sign in</h1>
        <p className="signin-help">Your research, evidence and agents in one workspace.</p>
        {client && (
          <>
            <p className="signin-help">Use your shared research account.</p>
            <form onSubmit={passwordSignIn} className="identity-form">
              <Field
                label="Email"
                className="input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={setEmail}
              />
              <Field
                label="Password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={setPassword}
              />
              <button className="btn btn--primary" disabled={busy} type="submit">
                Sign in
              </button>
              <button
                className="btn"
                disabled={busy}
                type="button"
                onClick={() => void googleSignIn()}
              >
                Continue with Google
              </button>
            </form>
          </>
        )}
        <details open={!client} className="identity-local">
          <summary>Use a bearer credential</summary>
          <p className="signin-help">
            Paste a local actor credential or a machine key
            {configuration?.enabled ? ' or an existing shared-account access token' : ''}. It stays
            in this tab.
          </p>
          <form onSubmit={localSignIn} className="identity-form">
            <textarea
              className="textarea mono"
              rows={4}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Bearer credential"
              spellCheck={false}
            />
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Continue
            </button>
          </form>
        </details>
        <Failure message={error} />
      </section>
    </main>
  );
}

function Projects({
  account,
  error: initialError,
  choose,
  reload,
  signOut,
  manageKeys,
}: {
  account: Account;
  error?: string;
  choose(id: string): void;
  reload(): void;
  signOut(): void;
  manageKeys(): void;
}) {
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const receipt = useRef({ name: '', id: '' });
  const query = search.trim().toLocaleLowerCase();
  const projects = account.projects
    .filter((project) => `${project.name}\n${project.id}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    if (receipt.current.name !== name || !receipt.current.id)
      receipt.current = { name, id: crypto.randomUUID() };
    try {
      const { project } = await accountRequest<{ project: Project }>('/projects', {
        method: 'POST',
        body: { name, requestId: receipt.current.id },
      });
      choose(project.id);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="signin signin--projects">
      <section className="signin-card card">
        <div className="signin-wordmark">merv</div>
        <h1 className="signin-title">Choose a project</h1>
        {account.projects.length > 0 && (
          <p className="signin-help">Open a project to see its research and current work.</p>
        )}
        {account.projects.length === 0 && (
          <p>
            {account.kind === 'user'
              ? 'You do not belong to a project yet. Create one or ask a project administrator to add you.'
              : 'This credential cannot currently access a project. Ask its owner to check membership or provide another credential.'}
          </p>
        )}
        {account.projects.length > 0 && (
          <label className="project-search">
            Find a project
            <input
              className="input"
              type="search"
              placeholder="Search by name or ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
        <div className="identity-form project-choices" aria-label="Available projects">
          {projects.map((project) => (
            <button className="btn" key={project.id} onClick={() => choose(project.id)}>
              {project.name}
            </button>
          ))}
        </div>
        {account.projects.length > 0 && (
          <p className="signin-help" role="status">
            {projects.length === 0
              ? 'No projects match your search.'
              : `${projects.length} of ${account.projects.length} projects`}
          </p>
        )}
        {account.kind === 'user' && (
          <details className="identity-local" open={account.projects.length === 0}>
            <summary>Create a project</summary>
            <form onSubmit={create} className="identity-form">
              <label>
                New project
                <input
                  className="input"
                  value={name}
                  maxLength={200}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button className="btn btn--primary" disabled={busy}>
                Create project
              </button>
            </form>
          </details>
        )}
        <Failure message={error} />
        <div className="signin-actions">
          {account.kind === 'user' && (
            <button className="btn" onClick={manageKeys}>
              Manage machine keys
            </button>
          )}
          <button className="btn" onClick={reload}>
            Refresh projects
          </button>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
        {account.kind === 'user' && (
          <details className="identity-local">
            <summary>Account details</summary>
            <p className="signin-help">
              Share this account ID with a project administrator to be added to their project.
            </p>
            <code className="history-hash">{account.user.subject}</code>
          </details>
        )}
      </section>
    </main>
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof browserAuth>>>();
  const [authReady, setAuthReady] = useState(false);
  const [state, setState] = useState<
    | { phase: 'checking' }
    | { phase: 'anonymous'; error?: string }
    | (AccountSession & { error?: string })
  >(hasToken() ? { phase: 'checking' } : { phase: 'anonymous' });
  const [attempt, setAttempt] = useState(0);
  const [keysEpoch, setKeysEpoch] = useState<number>();
  const epoch = useScopeVersion();
  const accountVersion = useRef(identityVersion());
  const reload = () => setAttempt((n) => n + 1);
  useEffect(() => {
    let disposed = false;
    let active: Awaited<ReturnType<typeof browserAuth>> | undefined;
    browserAuth(() => {
      if (disposed) return;
      if (accountVersion.current !== identityVersion()) navigate('/', { replace: true });
      accountVersion.current = identityVersion();
      setAttempt((n) => n + 1);
    }).then(
      (result) => {
        if (disposed) result.dispose();
        else {
          active = result;
          setAuth(result);
          setAuthReady(true);
        }
      },
      (error) => {
        if (!disposed) {
          setState({ phase: 'anonymous', error: message(error) });
          // Local credentials remain usable when the public login handshake is unavailable.
          setAuthReady(true);
        }
      },
    );
    return () => {
      disposed = true;
      active?.dispose();
    };
  }, []);
  useEffect(
    () =>
      onAccessLost((error) => {
        if (error.status === 401) {
          setAuthMode('local');
          setState({ phase: 'anonymous', error: 'Your session ended. Sign in again.' });
        } else {
          setProject(null);
          setAttempt((n) => n + 1);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!authReady) return;
    if (!hasToken()) {
      setState((old) => (old.phase === 'anonymous' ? old : { phase: 'anonymous' }));
      return;
    }
    let cancelled = false;
    setState({ phase: 'checking' });
    resolveAccountSession()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((error: unknown) => {
        if (
          cancelled ||
          (error instanceof ApiError &&
            ['scope_changed', 'membership_required'].includes(error.code))
        )
          return;
        setState({ phase: 'anonymous', error: message(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, epoch, authReady]);
  const signOut = () => {
    setAuthMode('local');
    setState({ phase: 'anonymous' });
    navigate('/', { replace: true });
    void auth?.client?.auth.signOut({ scope: 'local' }).catch(() => undefined);
  };
  if (state.phase === 'checking' || ('epoch' in state && state.epoch !== epoch))
    return <main className="signin empty">Connecting…</main>;
  if (state.phase === 'anonymous')
    return (
      <SignIn
        client={auth?.client}
        configuration={auth?.configuration}
        initialError={state.error}
        onSignedIn={() => {
          navigate('/', { replace: true });
          reload();
        }}
      />
    );
  const choose = (id: string) => {
    setProject(id);
    navigate('/', { replace: true });
    reload();
  };
  const manageKeys = () => setKeysEpoch(scopeVersion());
  if (keysEpoch === epoch && state.account.kind === 'user')
    return (
      <main>
        <KeysPanel
          account={state.account}
          initialProjectId={state.phase === 'ready' ? state.project.id : undefined}
          onClose={() => setKeysEpoch(undefined)}
        />
      </main>
    );
  if (state.phase === 'projects')
    return (
      <Projects
        account={state.account}
        error={state.error}
        choose={choose}
        reload={reload}
        signOut={signOut}
        manageKeys={manageKeys}
      />
    );
  const session: Session = {
    actor: state.actor,
    project: state.project,
    account: state.account,
    signOut,
    manageKeys,
    chooseProject: () => {
      setProject(null);
      navigate('/', { replace: true });
      reload();
    },
  };
  return (
    <SessionContext.Provider value={session}>
      <div key={`${state.actor.id}:${state.project.id}`} className="session-workspace">
        {children}
      </div>
    </SessionContext.Provider>
  );
}
