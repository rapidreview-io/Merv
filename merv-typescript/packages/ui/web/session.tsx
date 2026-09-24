import {
  createContext,
  useContext,
  useEffect,
  useId,
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
  onAccessLost,
  resolveAccountSession,
  setProject,
  setToken,
  useScopeVersion,
  type Actor,
  type Project,
  type Account,
  type AccountSession,
} from './api';
import { Failure, Field, SearchField, Summary } from './components';
import { browserAuth, setAuthMode, type AuthConfiguration } from './auth';

export type { Actor, Project, Account } from './api';
interface Session {
  actor: Actor;
  project: Project;
  account: Account;
  chooseProject(): void;
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
  onAttempt,
  initialError,
}: {
  client?: SupabaseClient;
  configuration?: AuthConfiguration;
  /** The person has handed something over: only from here on can a refusal be theirs. */
  onAttempt(): void;
  initialError?: string;
}) {
  const [value, setValue] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const refusal = useId();
  const credential = useRef<HTMLFormElement>(null);
  // A refused credential brings the page back with its field emptied: the cursor goes
  // back into it, and the field names the refusal as what is wrong with it.
  useEffect(() => {
    setError(initialError);
    if (initialError) credential.current?.querySelector('input')?.focus();
  }, [initialError]);
  const passwordSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    onAttempt();
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
    onAttempt();
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
    onAttempt();
    setBusy(true);
    setError(undefined);
    setAuthMode('local');
    // Storing the credential is the sign-in: the app checks it and reports the outcome.
    setToken(token);
    setValue('');
  };
  // A secret on one line: nothing corrects it, completes it or shows it, and a pasted
  // credential file still lands whole, because a paste into one line only loses its newlines.
  const local = (
    <form onSubmit={localSignIn} className="identity-form" ref={credential}>
      <Field
        label="Bearer credential"
        className="mono"
        type="password"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? refusal : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={setValue}
      />
      <p className="signin-help">
        A local actor credential or a machine key
        {configuration?.enabled ? ', or a shared-account access token' : ''}. It stays in this tab.
      </p>
      <button type="submit" className="btn btn--primary" disabled={busy}>
        Continue
      </button>
    </form>
  );
  return (
    <main className="signin">
      <section className="signin-card">
        <div className="signin-wordmark">merv</div>
        <h1 className="signin-title">Sign in</h1>
        {client && (
          <form onSubmit={passwordSignIn} className="identity-form">
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={setEmail}
            />
            <Field
              label="Password"
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
        )}
        {/* Where a credential is the only way in it is the form; beside an account it folds away. */}
        {client ? (
          <details className="identity-local">
            <Summary>Use a bearer credential</Summary>
            {local}
          </details>
        ) : (
          local
        )}
        <Failure message={error} id={refusal} />
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
}: {
  account: Account;
  error?: string;
  choose(id: string): void;
  reload(): void;
  signOut(): void;
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
      <section className="signin-card">
        <div className="signin-wordmark">merv</div>
        <h1 className="signin-title">Choose a project</h1>
        {account.projects.length === 0 && (
          <p>
            {account.kind === 'user'
              ? 'You do not belong to a project yet. Create one or ask a project administrator to add you.'
              : 'This credential cannot currently access a project. Ask its owner to check membership or provide another credential.'}
          </p>
        )}
        {account.projects.length > 0 && (
          <SearchField label="Find a project by name or ID" value={search} onChange={setSearch} />
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
            <Summary>Create a project</Summary>
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
          <button className="btn" onClick={reload}>
            Refresh projects
          </button>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
        {account.kind === 'user' && (
          <details className="identity-local">
            <Summary>Account details</Summary>
            <p className="signin-help">
              Share this account ID with a project administrator to be added to their project.
            </p>
            <code>{account.user.subject}</code>
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
  const phase = useRef(state.phase);
  phase.current = state.phase;
  const epoch = useScopeVersion();
  // A credential this tab was still holding from an earlier visit is not something the
  // person just offered: when it is refused the sign-in page opens and accuses nobody.
  const attempted = useRef(false);
  // Consecutive checks the server could not answer, which space the next one out.
  const failures = useRef(0);
  const checking = useRef(false);
  const reload = () => setAttempt((n) => n + 1);
  useEffect(() => {
    let disposed = false;
    let active: Awaited<ReturnType<typeof browserAuth>> | undefined;
    // The address stays what it was: a restored or renewed sign-in keeps the page it is on.
    browserAuth(() => {
      if (!disposed) reload();
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
          // A credential being checked reports its own refusal; a session that had one ended.
          if (phase.current === 'anonymous' || phase.current === 'checking') return;
          setAuthMode('local');
          setState({ phase: 'anonymous', error: 'Your session ended. Sign in again.' });
          return;
        }
        // The account is read again and says whether the project is still one of its own;
        // a check already in flight answers for itself, so this can never loop.
        if (phase.current === 'ready' && !checking.current) reload();
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
    let retry: ReturnType<typeof setTimeout> | undefined;
    // A page that is open stays open while the same scope is checked again.
    setState((old) => (old.phase === 'ready' && old.epoch === epoch ? old : { phase: 'checking' }));
    checking.current = true;
    resolveAccountSession()
      .then((result) => {
        failures.current = 0;
        if (!cancelled) setState(result);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof ApiError && error.code === 'scope_changed')) return;
        // A server that is down or restarting, or a membership still settling, is asked again
        // later each time, and the credential is kept: a 30-second outage once made thousands
        // of requests and signed the person out.
        if (
          error instanceof ApiError &&
          (error.status === 0 ||
            error.status >= 500 ||
            ['invalid_response', 'membership_required'].includes(error.code))
        ) {
          retry = setTimeout(reload, Math.min(30_000, 1000 * 2 ** failures.current++));
          return;
        }
        // The message first: dropping the credential changes the scope, and the run that
        // change starts keeps an anonymous state as it finds it.
        const refused = error instanceof ApiError && error.status === 401;
        setState({
          phase: 'anonymous',
          error: !refused
            ? message(error)
            : attempted.current
              ? 'That credential was not accepted.'
              : undefined,
        });
        setToken(null);
      })
      .finally(() => {
        // A check waiting to be asked again is still in flight.
        if (!cancelled && !retry) checking.current = false;
      });
    return () => {
      cancelled = true;
      clearTimeout(retry);
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
        onAttempt={() => {
          attempted.current = true;
        }}
      />
    );
  // The page that was asked for opens in the chosen project.
  const choose = (id: string) => {
    setProject(id);
    reload();
  };
  if (state.phase === 'projects')
    return (
      <Projects
        account={state.account}
        error={state.error}
        choose={choose}
        reload={reload}
        signOut={signOut}
      />
    );
  const session: Session = {
    actor: state.actor,
    project: state.project,
    account: state.account,
    signOut,
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
