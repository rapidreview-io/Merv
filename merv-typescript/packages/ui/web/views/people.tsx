import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, accountRequest, scopeVersion, useTool } from '../api';
import { useSession, type Actor } from '../session';
import { EmptyState, Submit, term } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';

/** A directory entry whose name is an identifier names nobody, so the page says nothing. */
const IDENTIFIER = /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|\|/;
/** A name nobody wrote is not one: an identifier names nobody. */
export const personName = (name: string | undefined) =>
  name && !IDENTIFIER.test(name) ? name : undefined;
/**
 * Up to two initials for the disc that stands for a person, in the rail's account
 * row and beside a post: the first letters of the first two words, and a dot for
 * somebody nobody can name.
 */
export const initials = (name: string | undefined) =>
  (name ?? '')
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || '·';
export const namesOf = (actors: Actor[] | null | undefined) => {
  const names = new Map((actors ?? []).map((actor) => [actor.id, actor.name]));
  return (id: string | null | undefined) => personName(id ? names.get(id) : undefined);
};
/** The same names, for a page that has no directory of its own. */
export function useActorNames() {
  const { actor } = useSession();
  return namesOf(useTool<Actor[]>(actor.role === 'operator' ? 'actor.list' : null).data);
}

type Role = Actor['role'];
interface Membership {
  id: string;
  projectId: string;
  issuer: string;
  subject: string;
  actorId: string;
  role: Role;
  active: boolean;
}
const roles: Role[] = ['reader', 'producer', 'reviewer', 'operator'];
const failure = (error: unknown): ApiError =>
  error instanceof ApiError
    ? error
    : new ApiError('request_failed', error instanceof Error ? error.message : 'Request failed.', 0);
const mutationMessage = (error: unknown): string =>
  error instanceof ApiError && error.code === 'last_operator'
    ? 'Keep at least one operator with a verified account. Another operator must sign in before the last verified operator can be removed or demoted.'
    : failure(error).message;

/**
 * Members and keys belong to a person's account. A session opened with a bearer
 * credential has none, so Settings does not offer it those rooms; whoever arrives
 * at one by its address is told what would open it, with the one step that leads
 * there.
 */
export function NeedsAccount({ icon, said }: { icon: string; said: string }) {
  const { signOut } = useSession();
  return (
    <div className="page-stage">
      <EmptyState
        kind="settings"
        icon={icon}
        title={said}
        action={
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        }
      />
    </div>
  );
}

export function PeopleView() {
  const { account, project, actor } = useSession();
  const human = account.kind === 'user';
  const subject = human ? account.user.subject : '';
  const issuer = human ? account.user.issuer : '';
  const [members, setMembers] = useState<Membership[]>();
  const [loadError, setLoadError] = useState<ApiError>();
  const [mutationError, setMutationError] = useState<string>();
  const [loading, setLoading] = useState(human);
  const [busy, setBusy] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [newRole, setNewRole] = useState<Role>('reader');
  const [draftRoles, setDraftRoles] = useState<Record<string, Role>>({});
  const generation = useRef(0);
  const heading = useId();
  const nameOf = useActorNames();
  // A member is named from the directory, never by the account ID they signed in with.
  const label = (member: Membership) =>
    nameOf(member.actorId) ??
    (member.subject === subject && member.issuer === issuer ? 'You' : 'Member');
  const currentMember = members?.find(
    (member) => member.subject === subject && member.issuer === issuer,
  );
  const isOperator = (human ? currentMember?.role : actor.role) === 'operator';
  const canManage = human && isOperator;
  // The project always keeps an operator, so the only one can be neither demoted nor removed.
  const lastOperator = (member: Membership) =>
    member.role === 'operator' &&
    members?.filter((other) => other.role === 'operator').length === 1;
  const path = `/projects/${encodeURIComponent(project.id)}/members`;
  const filter = useListFilter(members, {
    stateOf: (member) => member.role,
    labels: (member) => [nameOf(member.actorId), member.subject],
    ids: (member) => [member.id, member.actorId],
  });

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const epoch = scopeVersion();
    const current = () => generation.current === currentGeneration && scopeVersion() === epoch;
    setMembers(undefined);
    setLoadError(undefined);
    setMutationError(undefined);
    setNewSubject('');
    setNewRole('reader');
    setDraftRoles({});
    setBusy(false);
    setLoading(human);
    // The list keeps itself current; a poll never disturbs a half-written form.
    const load = () =>
      accountRequest<{ memberships: Membership[] }>(path, { scoped: true }).then(
        (result) => {
          if (current()) {
            setMembers(result.memberships.filter((member) => member.active));
            setLoading(false);
          }
        },
        (error) => {
          if (current()) {
            setLoadError(failure(error));
            setLoading(false);
          }
        },
      );
    if (human) void load();
    const timer = human ? setInterval(() => void load(), 10000) : undefined;
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [path, human, issuer, subject]);

  const mutate = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    target?: string,
    body?: unknown,
    done?: () => void,
  ) => {
    if (!canManage || busy) return;
    const currentGeneration = generation.current;
    const epoch = scopeVersion();
    const current = () => generation.current === currentGeneration && scopeVersion() === epoch;
    setBusy(true);
    setMutationError(undefined);
    try {
      await accountRequest(target === undefined ? path : `${path}/${encodeURIComponent(target)}`, {
        method,
        body,
        scoped: true,
      });
      if (!current()) return;
      if (method === 'POST') {
        setNewSubject('');
        done?.();
      }
      const result = await accountRequest<{ memberships: Membership[] }>(path, { scoped: true });
      if (!current()) return;
      setMembers(result.memberships.filter((member) => member.active));
      setDraftRoles({});
      setLoadError(undefined);
    } catch (error) {
      if (current()) setMutationError(mutationMessage(error));
    } finally {
      if (current()) setBusy(false);
    }
  };
  // What is pasted is the ID the person being added was shown; the space a paste
  // drags along with it is nobody's mistake, so it is dropped and not complained of.
  const add = (event: FormEvent, close: () => void) => {
    event.preventDefault();
    const pasted = newSubject.trim();
    if (pasted) void mutate('POST', undefined, { subject: pasted, role: newRole }, close);
  };

  // An account with no sign-in of its own has no memberships to manage; the
  // identities that own work are the Sessions page's own directory.
  if (!human)
    return <NeedsAccount icon="people" said="Sign in with an account to manage members" />;

  return (
    <ListPage
      load={{ loading, error: loadError, data: members }}
      noun="members"
      kind="people"
      placeholder="Account ID"
      filter={filter}
      emptyTitle="No active memberships"
      create={{
        label: 'New member',
        shown: canManage,
        form: (close) => (
          <form
            className="identity-form card"
            aria-labelledby={heading}
            onSubmit={(event) => add(event, close)}
          >
            <h2 id={heading}>New member</h2>
            <label>
              Their account ID
              <input
                className="input mono"
                value={newSubject}
                maxLength={512}
                required
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                // Nobody knows one by heart: it is shown to its owner, to be handed over.
                placeholder="Paste the ID they see under Account details"
                onChange={(event) => setNewSubject(event.target.value)}
              />
            </label>
            <label>
              Project role
              <select
                className="input"
                value={newRole}
                disabled={busy}
                onChange={(event) => setNewRole(event.target.value as Role)}
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {term(role)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              {/* One lock serves every change on the page, so the word stays what it was. */}
              <Submit disabled={busy || !newSubject.trim()} />
            </div>
          </form>
        ),
      }}
      line={(member) => ({
        name: <strong>{label(member)}</strong>,
        standing:
          canManage && member.issuer === issuer ? (
            <div className="states">
              <select
                className="input"
                aria-label={`Role for ${label(member)}`}
                value={draftRoles[member.id] ?? member.role}
                disabled={busy || lastOperator(member)}
                onChange={(event) =>
                  setDraftRoles((previous) => ({
                    ...previous,
                    [member.id]: event.target.value as Role,
                  }))
                }
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {term(role)}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                disabled={busy || !draftRoles[member.id] || draftRoles[member.id] === member.role}
                onClick={() =>
                  void mutate('PATCH', member.subject, { role: draftRoles[member.id] })
                }
              >
                Edit role
              </button>
              <button
                className="btn"
                disabled={busy || lastOperator(member)}
                onClick={() => void mutate('DELETE', member.subject)}
              >
                Remove
              </button>
            </div>
          ) : (
            <ThreeStates
              execution={member.role}
              meta={member.issuer === issuer ? undefined : 'Different sign-in provider'}
            />
          ),
      })}
      after={
        mutationError && (
          <div className="error-message" role="alert">
            {mutationError}
          </div>
        )
      }
    />
  );
}
