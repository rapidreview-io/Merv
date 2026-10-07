import { expiry } from './expiry.js';
import type { Ledger } from './ledger.js';
import {
  check,
  eventSource,
  forRead,
  newId,
  ROLES,
  visible,
  type Actor,
  type ActorCredential,
  type Caller,
  type DelegationSource,
  type IssuedActorCredential,
  type Permission,
  type Project,
  type Role,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';

/** An actor with the person it acts for, if any; append `WHERE …` on `a`. */
export const ACTOR_WITH_MEMBER = `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
  LEFT JOIN member_actors m ON m.actor_id=a.id`;

export interface ActorRow {
  id: string;
  project_id: string;
  name: string;
  role: Role;
  active: number;
  user_issuer?: string | null;
  user_subject?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  service_owner?: string | null;
}
export interface CredentialRow {
  id: string;
  actor_id: string;
  project_id: string;
  kind: 'actor';
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  previous_id: string | null;
}
/** An allowed decision. `lifetime` is the deadline of the actor credential or user key it rested
 * on, if any. */
export interface Decision {
  actor: Actor;
  source?: DelegationSource;
  lifetime?: string | null;
}
export const actor = (row: ActorRow): Actor => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  role: row.role,
  active: !!row.active,
  ...(row.user_issuer ? { user: { issuer: row.user_issuer, subject: row.user_subject! } } : {}),
  ...(row.service_owner ? { serviceOwner: row.service_owner } : {}),
  ...(row.agent_id ? { threadId: row.agent_id } : {}),
  ...(row.session_id ? { sessionId: row.session_id } : {}),
});
export const credential = (row: CredentialRow): ActorCredential => ({
  id: row.id,
  actorId: row.actor_id,
  projectId: row.project_id,
  kind: row.kind,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  previousId: row.previous_id,
});
/** Independent actors and their credentials: bootstrap, issue, rotate, revoke, and the operator
 * authority that administers them. */
export class ActorCredentials {
  constructor(
    private readonly state: State,
    private readonly ledger: Ledger,
    private readonly time: () => string,
    private readonly authorize: (
      caller: Caller,
      permission: Permission,
      tx: Transaction,
    ) => Promise<Decision>,
    private readonly require: (
      caller: Caller,
      permission: Permission,
      tx: Transaction,
    ) => Promise<Actor>,
  ) {}
  private notBeyond(expiresAt: string | null, limit: string | null): void {
    check(
      limit === null || (expiresAt !== null && expiresAt <= limit),
      'self_expiry_extension',
      'A credential cannot outlive the credential that authorized or preceded it; another operator must authorize a longer one',
      403,
    );
  }
  private async issue(
    tx: Transaction,
    projectId: string,
    name: string,
    role: Role,
    expiresAt: string | null | undefined,
    limit: string | null,
  ): Promise<IssuedActorCredential> {
    check(
      typeof name === 'string' && visible(name) && name.length <= 200,
      'invalid_actor',
      'Actor needs a nonblank name of at most 200 characters',
    );
    check(ROLES.includes(role), 'invalid_role', 'Unknown actor role');
    const value: Actor = { id: newId('actor'), projectId, name: name.trim(), role, active: true };
    await tx.run(
      'INSERT INTO actors(id,project_id,name,role,active) VALUES(?,?,?,?,1)',
      value.id,
      projectId,
      value.name,
      role,
    );
    const time = this.time();
    return await this.issueCredential(tx, value, expiry(expiresAt, time), null, time, limit);
  }
  private async issueCredential(
    tx: Transaction,
    value: Actor,
    expiresAt: string | null,
    previousId: string | null,
    time: string,
    limit: string | null,
  ): Promise<IssuedActorCredential> {
    // Nothing minted through an expiring credential outlives it.
    this.notBeyond(expiresAt, limit);
    const issued: ActorCredential = {
      id: newId('credential'),
      actorId: value.id,
      projectId: value.projectId,
      kind: 'actor',
      createdAt: time,
      expiresAt,
      revokedAt: null,
      previousId,
    };
    const { token, tokenHash } = await this.ledger.issue('actor', issued.id, expiresAt, tx);
    await tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,?)',
      issued.id,
      value.id,
      value.projectId,
      issued.kind,
      tokenHash,
      time,
      expiresAt,
      previousId,
    );
    return { actor: value, credential: issued, token };
  }
  async bootstrap(input: { projectName: string; actorName: string }) {
    check(
      typeof input.projectName === 'string' &&
        visible(input.projectName) &&
        input.projectName.length <= 200,
      'invalid_project',
      'Project needs a name of at most 200 characters',
    );
    return await this.state.transaction(async (tx) => {
      const value: Project = {
        id: newId('project'),
        name: input.projectName.trim(),
        createdAt: this.time(),
      };
      await tx.run(
        'INSERT INTO projects(id,name,created_at) VALUES(?,?,?)',
        value.id,
        value.name,
        value.createdAt,
      );
      const credential = await this.issue(tx, value.id, input.actorName, 'operator', null, null);
      await this.state.appendEvent(tx, {
        projectId: value.id,
        actorId: credential.actor.id,
        type: 'project.created',
        subjectId: value.id,
        data: { name: value.name },
      });
      return { project: value, ...credential };
    });
  }
  async issueActor(caller: Caller, input: { name: string; role: Role; expiresAt?: string | null }) {
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.state.transaction(async (tx) => {
      const { limit } = await this.administer(caller, tx);
      const result = await this.issue(
        tx,
        caller.projectId,
        input.name,
        input.role,
        input.expiresAt === undefined ? limit : input.expiresAt,
        limit,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.created',
        subjectId: result.actor.id,
        data: { name: result.actor.name, role: result.actor.role, ...eventSource(caller) },
      });
      return result;
    });
  }
  async actorCredentials(caller: Caller, actorId = caller.actorId): Promise<ActorCredential[]> {
    caller = structuredClone(caller);
    return await forRead(this.state, async (tx) => {
      // A read of one's own metadata is not administration; a session or key holds none.
      if (actorId === caller.actorId) await this.require(caller, 'read', tx);
      else await this.administer(caller, tx);
      await this.actorRow(tx, caller.projectId, actorId);
      return (
        await tx.all<CredentialRow>(
          'SELECT * FROM actor_credentials WHERE project_id=? AND actor_id=? ORDER BY created_at,id',
          caller.projectId,
          actorId,
        )
      ).map(credential);
    });
  }
  async issueActorCredential(
    caller: Caller,
    input: { actorId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential> {
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.state.transaction(async (tx) => {
      const { limit } = await this.administer(caller, tx);
      const target = await this.actorRow(tx, caller.projectId, input.actorId);
      this.machineActor(target);
      check(target.active, 'actor_revoked', 'Cannot issue credentials for an inactive actor', 409);
      const time = this.time();
      const expiresAt = expiry(input.expiresAt === undefined ? limit : input.expiresAt, time);
      const issued = await this.issueCredential(tx, actor(target), expiresAt, null, time, limit);
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.credential_issued',
        subjectId: issued.credential.id,
        data: { actorId: target.id, expiresAt, ...eventSource(caller) },
      });
      return issued;
    });
  }
  async rotateCredential(
    caller: Caller,
    input: { credentialId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential> {
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.state.transaction(async (tx) => {
      const { credentialId, limit } = await this.administer(caller, tx);
      const previous = await this.credentialRow(tx, caller.projectId, input.credentialId);
      check(
        previous.id !== credentialId,
        'self_rotation',
        'Cannot atomically rotate the credential authenticating this call. Use actor.issue_token, verify the new token, then revoke the old credential.',
        409,
      );
      const target = await this.actorRow(tx, caller.projectId, previous.actor_id);
      this.machineActor(target);
      check(target.active, 'actor_revoked', 'Cannot rotate credentials for an inactive actor', 409);
      check(
        previous.revoked_at === null,
        'credential_revoked',
        'Credential is already revoked',
        409,
      );
      const time = this.time();
      const expiresAt = expiry(
        input.expiresAt === undefined ? previous.expires_at : input.expiresAt,
        time,
      );
      // A self-rotation never extends the credential it replaces. Nor does any rotation outlive
      // the credential making the call: issueCredential guarantees that, and checking it here
      // too refuses before the revocation writes.
      if (target.id === caller.actorId) this.notBeyond(expiresAt, previous.expires_at);
      this.notBeyond(expiresAt, limit);
      const result = await tx.run(
        'UPDATE actor_credentials SET revoked_at=? WHERE id=? AND project_id=? AND revoked_at IS NULL',
        time,
        previous.id,
        caller.projectId,
      );
      check(result.changes === 1, 'credential_revoked', 'Credential was already revoked', 409);
      // Only a revocation counts here, never expiry: renewing an expired credential is intended.
      check(
        (await this.ledger.retire('actor', previous, tx))?.revokedAt === null,
        'credential_revoked',
        'Credential was revoked in the credential ledger',
        409,
      );
      const issued = await this.issueCredential(
        tx,
        actor(target),
        expiresAt,
        previous.id,
        time,
        limit,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.credential_rotated',
        subjectId: issued.credential.id,
        data: { actorId: target.id, previousId: previous.id, expiresAt, ...eventSource(caller) },
      });
      return issued;
    });
  }
  async revokeCredential(caller: Caller, credentialId: string): Promise<void> {
    caller = structuredClone(caller);
    await this.state.transaction(async (tx) => {
      const { credentialId: own } = await this.administer(caller, tx);
      const target = await this.credentialRow(tx, caller.projectId, credentialId);
      this.machineActor(await this.actorRow(tx, caller.projectId, target.actor_id));
      check(
        target.actor_id !== caller.actorId || (own !== undefined && target.id !== own),
        'self_revoke',
        'Cannot revoke the credential authenticating this call; verify another credential first',
      );
      // The ledger decides liveness: a credential Scope's row calls revoked is retired there too,
      // and only one revoked in both is left as it is.
      const before = await this.ledger.retire('actor', target, tx);
      if (target.revoked_at !== null && before?.revokedAt !== null) return;
      const time = this.time();
      await tx.run(
        'UPDATE actor_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
        time,
        target.id,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.credential_revoked',
        subjectId: target.id,
        data: { actorId: target.actor_id, revokedAt: time, ...eventSource(caller) },
      });
    });
  }
  private async actorRow(sql: Sql, projectId: string, actorId: string): Promise<ActorRow> {
    check(
      typeof actorId === 'string' && actorId.length > 0,
      'invalid_actor',
      'Actor id is required',
    );
    const row = await sql.get<ActorRow>(
      `${ACTOR_WITH_MEMBER} WHERE a.id=? AND a.project_id=?`,
      actorId,
      projectId,
    );
    check(row, 'not_found', 'Actor not found', 404);
    return row;
  }
  private machineActor(row: ActorRow): void {
    check(
      !row.user_issuer && !row.session_id && !row.service_owner,
      'member_actor',
      'Member, session, and service actors carry no independent credentials',
      403,
    );
  }
  /** Admin authority over independent actors and their credentials, which a user key or a worker
   * session never holds, nor a conversation started with a key. Returns the credential the call
   * rests on (a conversation's source credential), which the self-revoke and self-rotate checks
   * name, and that credential's deadline, which bounds anything the call mints. */
  private async administer(
    caller: Caller,
    tx: Transaction,
  ): Promise<{ credentialId?: string; limit: string | null }> {
    const { source, lifetime } = await this.authorize(caller, 'admin', tx);
    const via = caller.conversation ? source : undefined;
    check(
      caller.key === undefined && caller.session === undefined && via?.kind !== 'key',
      'forbidden',
      'User keys and worker sessions cannot administer independent actor credentials or actors',
      403,
    );
    // A conversation rests on its actor source, whose expiresAt requireDelegation has just matched
    // to the row. Humans, bare in-process callers and non-expiring credentials impose no limit. (A
    // service-sourced conversation cannot reach here: a service actor is never an operator.)
    if (via)
      return via.kind === 'actor'
        ? { credentialId: via.credentialId, limit: via.expiresAt }
        : { limit: null };
    if (caller.credentialId === undefined) return { limit: null };
    check(lifetime !== undefined, 'scope_internal', 'Credential lifetime unavailable', 500);
    return { credentialId: caller.credentialId, limit: lifetime };
  }
  private async credentialRow(
    sql: Sql,
    projectId: string,
    credentialId: string,
  ): Promise<CredentialRow> {
    check(
      typeof credentialId === 'string' && credentialId.length > 0,
      'invalid_credential',
      'Credential id is required',
    );
    const row = await sql.get<CredentialRow>(
      'SELECT * FROM actor_credentials WHERE id=? AND project_id=?',
      credentialId,
      projectId,
    );
    check(row, 'not_found', 'Actor credential not found', 404);
    return row;
  }
  async revokeActor(caller: Caller, actorId: string): Promise<void> {
    caller = structuredClone(caller);
    await this.state.transaction(async (tx) => {
      await this.administer(caller, tx);
      this.machineActor(await this.actorRow(tx, caller.projectId, actorId));
      check(
        actorId !== caller.actorId,
        'self_revoke',
        'Cannot revoke your own operator credential',
      );
      // Deactivating the actor ends every credential of it, since authentication and every
      // decision require an active actor. Its credential rows, and their ledger rows, are left
      // as they are on purpose (actor-credentials.test.ts pins it); listings still show them
      // unrevoked. Revoking twice records nothing twice.
      const r = await tx.run(
        'UPDATE actors SET active=0 WHERE id=? AND project_id=? AND active=1',
        actorId,
        caller.projectId,
      );
      if (!r.changes) return;
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.revoked',
        subjectId: actorId,
        data: { ...eventSource(caller) },
      });
    });
  }
}
