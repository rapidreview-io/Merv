import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, accountRequest, scopeVersion, useTool } from '../api';
import { useSession, type Actor } from '../session';
import { LoadState, term } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';

/** Actor names for ids; operators get names, everyone else gets short ids. */
export function useActorNames() {
  const { actor } = useSession();
  const { data } = useTool<Actor[]>(actor.role === 'operator' ? 'actor.list' : null);
  const names = new Map((data ?? []).map((actor) => [actor.id, actor.name]));
  return (id: string | null | undefined) => (id ? names.get(id) : undefined);
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
  const currentMember = members?.find(
    (member) => member.subject === subject && member.issuer === issuer,
  );
  const isOperator = (human ? currentMember?.role : actor.role) === 'operator';
  const canManage = human && isOperator;
  const actors = useTool<Actor[]>(isOperator ? 'actor.list' : null);
  const path = `/projects/${encodeURIComponent(project.id)}/members`;
  const filter = useListFilter(members, {
    stateOf: (member) => member.role,
    labels: (member) => [member.subject],
    ids: (member) => [member.id, member.actorId],
  });
  const actorFilter = useListFilter(actors.data, {
    stateOf: (worker) => worker.role,
    labels: (worker) => [worker.name],
    ids: (worker) => [worker.id],
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
      actors.reload();
    } catch (error) {
      if (current()) setMutationError(mutationMessage(error));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const add = (event: FormEvent, close: () => void) => {
    event.preventDefault();
    if (!newSubject || newSubject.trim() !== newSubject) {
      setMutationError('Enter the exact account ID without surrounding spaces.');
      return;
    }
    void mutate('POST', undefined, { subject: newSubject, role: newRole }, close);
  };

  // One row for an actor, wherever this page lists them.
  const actorLine = (worker: Actor) => ({
    name: <strong>{worker.name}</strong>,
    standing: <ThreeStates execution={worker.role} meta={worker.active ? 'active' : 'revoked'} />,
  });
  const noActors =
    'The identities that own work and reviews appear here as agents are issued credentials.';
  // An account with no sign-in of its own has no memberships to manage: the
  // identities are then the page's one list, under the same control row.
  if (!human)
    return (
      <ListPage
        load={actors}
        noun="actors"
        placeholder="Name"
        filter={actorFilter}
        line={actorLine}
        emptyTitle="No actors"
        emptyHint={noActors}
      />
    );
  // The identities that own work: a second list of another kind, under the members.
  const workers = isOperator && (
    <section className="stack">
      <h2 className="section-title">Project actors</h2>
      <LoadState
        {...actors}
        empty={actors.data?.length === 0}
        columns={2}
        emptyTitle="No actors"
        emptyHint={noActors}
      />
      <ul className="rows">
        {(actors.data ?? []).map((worker) => {
          const { name, standing } = actorLine(worker);
          return (
            <li className="row" key={worker.id}>
              <span className="row-name">{name}</span>
              {standing}
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <ListPage
      load={{ loading, error: loadError, data: members }}
      noun="members"
      placeholder="Account ID"
      filter={filter}
      emptyTitle="No active memberships"
      emptyHint={`Everyone who can open ${project.name} is listed here; an operator adds them by account ID.`}
      create={{
        label: 'New member',
        shown: canManage,
        form: (close) => (
          <form className="identity-form card" onSubmit={(event) => add(event, close)}>
            <h3 className="label">New member</h3>
            <p className="faint">
              Use the exact account ID from shared sign-in. This grants project access when that
              account signs in; it does not create a login account.
            </p>
            <label>
              Account ID
              <input
                className="input mono"
                value={newSubject}
                maxLength={512}
                required
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
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
            <button className="btn btn--primary" disabled={busy} type="submit">
              New member
            </button>
          </form>
        ),
      }}
      line={(member) => ({
        name: (
          <strong>
            <code>{member.subject}</code>
            {member.subject === subject && member.issuer === issuer ? ' (you)' : ''}
          </strong>
        ),
        standing:
          canManage && member.issuer === issuer ? (
            <div className="states">
              <select
                className="input"
                aria-label={`Role for ${member.subject}`}
                value={draftRoles[member.id] ?? member.role}
                disabled={busy}
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
                className="btn btn--sm"
                disabled={busy || !draftRoles[member.id] || draftRoles[member.id] === member.role}
                onClick={() =>
                  void mutate('PATCH', member.subject, { role: draftRoles[member.id] })
                }
              >
                Edit role
              </button>
              <button
                className="btn btn--sm"
                disabled={busy}
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
          {workers}
        </>
      }
    />
  );
}
