import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, accountRequest, scopeVersion, useTool } from '../api';
import { useSession, type Actor } from '../session';
import { LoadState, ObjId, StatusPill, Table } from '../components';

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
  const [adding, setAdding] = useState(false);
  const [draftRoles, setDraftRoles] = useState<Record<string, Role>>({});
  const generation = useRef(0);
  const currentMember = members?.find(
    (member) => member.subject === subject && member.issuer === issuer,
  );
  const isOperator = (human ? currentMember?.role : actor.role) === 'operator';
  const canManage = human && isOperator;
  const actors = useTool<Actor[]>(isOperator ? 'actor.list' : null);
  const path = `/projects/${encodeURIComponent(project.id)}/members`;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const epoch = scopeVersion();
    const current = () => generation.current === currentGeneration && scopeVersion() === epoch;
    setMembers(undefined);
    setLoadError(undefined);
    setMutationError(undefined);
    setNewSubject('');
    setNewRole('reader');
    setAdding(false);
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

  const mutate = async (method: 'POST' | 'PATCH' | 'DELETE', target?: string, body?: unknown) => {
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
        setAdding(false);
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
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!newSubject || newSubject.trim() !== newSubject) {
      setMutationError('Enter the exact account ID without surrounding spaces.');
      return;
    }
    void mutate('POST', undefined, { subject: newSubject, role: newRole });
  };

  return (
    <div className="page-stage stack stack--lg">
      {canManage && (
        <div className="action-row">
          <button
            type="button"
            className="btn"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add member
          </button>
        </div>
      )}
      {human && (
        <section className="stack">
          <h2 className="section-title">Project members</h2>
          <LoadState
            loading={loading}
            error={loadError}
            empty={members?.length === 0}
            emptyTitle="No active memberships"
            emptyHint={`Everyone who can open ${project.name} is listed here; an operator adds them by account ID.`}
          />
          {members && members.length > 0 && (
            <Table
              rows={members}
              keyOf={(member) => member.id}
              columns={[
                {
                  key: 'subject',
                  label: 'Account ID',
                  render: (member) => (
                    <>
                      <code>{member.subject}</code>
                      {member.subject === subject && member.issuer === issuer ? ' (you)' : ''}
                    </>
                  ),
                },
                {
                  key: 'role',
                  label: 'Project role',
                  render: (member) =>
                    canManage && member.issuer === issuer ? (
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
                            {role}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <StatusPill value={member.role} />
                    ),
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        label: 'Actions',
                        render: (member: Membership) =>
                          member.issuer !== issuer ? (
                            <span className="faint">Different sign-in provider</span>
                          ) : (
                            <div className="signin-actions">
                              <button
                                className="btn btn--sm"
                                disabled={
                                  busy ||
                                  !draftRoles[member.id] ||
                                  draftRoles[member.id] === member.role
                                }
                                onClick={() =>
                                  void mutate('PATCH', member.subject, {
                                    role: draftRoles[member.id],
                                  })
                                }
                              >
                                Save role
                              </button>
                              <button
                                className="btn btn--sm"
                                disabled={busy}
                                onClick={() => void mutate('DELETE', member.subject)}
                              >
                                Remove
                              </button>
                            </div>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {canManage && adding && (
            <form className="identity-form card" onSubmit={add}>
              <h3 className="label">Add a member</h3>
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
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn--primary" disabled={busy} type="submit">
                Add member
              </button>
            </form>
          )}
          {mutationError && (
            <div className="error-message" role="alert">
              {mutationError}
            </div>
          )}
        </section>
      )}
      {isOperator && (
        <section className="stack">
          <h2 className="section-title">Project actors</h2>
          <LoadState
            loading={actors.loading}
            error={actors.error}
            empty={actors.data?.length === 0}
            emptyTitle="No actors"
            emptyHint="The identities that own work and reviews appear here as agents are issued credentials."
          />
          {actors.data && actors.data.length > 0 && (
            <Table
              rows={actors.data}
              keyOf={(actor) => actor.id}
              columns={[
                { key: 'name', label: 'Name', render: (actor) => <strong>{actor.name}</strong> },
                {
                  key: 'role',
                  label: 'Role',
                  render: (actor) => <StatusPill value={actor.role} />,
                },
                {
                  key: 'active',
                  label: 'Status',
                  render: (actor) => (actor.active ? 'active' : 'revoked'),
                },
                {
                  key: 'id',
                  label: 'Id',
                  render: (actor) => <ObjId id={actor.id} />,
                  width: '160px',
                },
              ]}
            />
          )}
        </section>
      )}
    </div>
  );
}
