import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { personName } from '@merv/contracts/text';
import { ApiError, accountRequest, scopeVersion, useTool } from '../api';
import { useActor, useSession, type Actor } from '../session';
import { EmptyState, term } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';
import { Invitations } from '../invitations';

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
  // A file read outside a session (a test, a preview) names nobody rather than failing.
  const actor = useActor();
  return namesOf(useTool<Actor[]>(actor?.role === 'operator' ? 'actor.list' : null).data);
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
  const { subject, issuer } = human ? account.user : { subject: '', issuer: '' };
  const [members, setMembers] = useState<Membership[]>();
  const [loadError, setLoadError] = useState<ApiError>();
  const [mutationError, setMutationError] = useState<string>();
  const [loading, setLoading] = useState(human);
  const [busy, setBusy] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [invitationRevision, setInvitationRevision] = useState(0);
  const [newRole, setNewRole] = useState<Role>('reader');
  const [draftRoles, setDraftRoles] = useState<Record<string, Role>>({});
  const generation = useRef(0);
  // The newest read of the list asked: an answer to an older one, overtaken, is not drawn.
  const newest = useRef(0);
  const heading = useId();
  const nameOf = useActorNames();
  const mine = (member: Membership) => member.subject === subject && member.issuer === issuer;
  // A member is named from the directory, never by the account ID they signed in with.
  const label = (member: Membership) => nameOf(member.actorId) ?? (mine(member) ? 'You' : 'Member');
  const isOperator = (human ? members?.find(mine)?.role : actor.role) === 'operator';
  const options = roles.map((role) => (
    <option key={role} value={role}>
      {term(role)}
    </option>
  ));
  const canManage = human && isOperator;
  // The project always keeps an operator, so the only one can be neither demoted nor removed.
  const operators = members?.filter((member) => member.role === 'operator').length;
  const lastOperator = (member: Membership) => member.role === 'operator' && operators === 1;
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
    // The list keeps itself current, one poll at a time; a poll never disturbs a half-written form.
    let polling = false;
    const load = async () => {
      if (polling) return;
      polling = true;
      const asked = ++newest.current;
      const show = await accountRequest<{ memberships: Membership[] }>(path, { scoped: true }).then(
        (result) => () => setMembers(result.memberships.filter((member) => member.active)),
        (error) => () => setLoadError(failure(error)),
      );
      polling = false;
      if (!current() || asked !== newest.current) return;
      show();
      setLoading(false);
    };
    if (human) void load();
    const poll = () => document.visibilityState === 'hidden' || void load();
    const timer = human ? setInterval(poll, 10000) : undefined;
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
      await accountRequest(
        method === 'POST'
          ? `/projects/${encodeURIComponent(project.id)}/invitations`
          : `${path}/${encodeURIComponent(target!)}`,
        {
          method,
          body,
          scoped: true,
        },
      );
      if (!current()) return;
      if (method === 'POST') {
        setNewSubject('');
        done?.();
      }
      const asked = ++newest.current;
      const result = await accountRequest<{ memberships: Membership[] }>(path, { scoped: true });
      if (!current()) return;
      if (asked === newest.current)
        setMembers(result.memberships.filter((member) => member.active));
      setDraftRoles({});
      setLoadError(undefined);
    } catch (error) {
      if (current()) setMutationError(failure(error).message);
    } finally {
      if (current()) {
        setBusy(false);
        setInvitationRevision((value) => value + 1);
      }
    }
  };
  // Trimming a pasted address does not change the recipient's account identity.
  const add = (event: FormEvent, close: () => void) => {
    event.preventDefault();
    const pasted = newSubject.trim();
    if (pasted) void mutate('POST', undefined, { email: pasted, role: newRole }, close);
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
        label: 'Invite member',
        shown: canManage,
        form: (close) => (
          <form
            className="identity-form card"
            aria-labelledby={heading}
            onSubmit={(event) => add(event, close)}
          >
            <h2 id={heading}>Invite member</h2>
            <p>
              They will receive an email and join only after accepting. Invitations expire in seven
              days.
            </p>
            <label>
              Email address
              <input
                className="input mono"
                value={newSubject}
                type="email"
                maxLength={320}
                required
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                // Supabase resolves the email; joining still requires the recipient to accept.
                placeholder="colleague@example.com"
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
                {options}
              </select>
            </label>
            <div>
              {/* One lock serves every change on the page, so the word stays what it was. */}
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || !newSubject.trim()}
              >
                Send invitation
              </button>
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
                {options}
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
        <>
          {mutationError && (
            <div className="error-message" role="alert">
              {mutationError}
            </div>
          )}
          {canManage && <Invitations projectId={project.id} refresh={invitationRevision} />}
        </>
      }
    />
  );
}
