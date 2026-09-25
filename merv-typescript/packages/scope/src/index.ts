import { expiry } from './expiry.js';
import { visible, createService, receipted, sha256Hex } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { z } from 'zod';
import { ExactToolPolicy, grantsSchema } from './tool-policy.js';
import type { ToolGrant, ToolPolicy } from '@merv/contracts';
import { randomBytes } from 'node:crypto';
import type { Context } from 'cordis';
import {
  check,
  digest,
  eventSource,
  inTransaction,
  newId,
  type State,
  type Scope,
  type Caller,
  type Role,
  type Permission,
  type Actor,
  type Project,
  type ProjectContextUpdate,
  type Transaction,
  type Sql,
  type ActorCredential,
  type AuthenticatedActor,
  type IssuedActorCredential,
  type VerifiedIdentity,
  type HumanPrincipal,
  type Principal,
  type UserKey,
  type DelegationSource,
  type SessionAuthority,
  type ConversationAuthority,
  type ManagedRunnerAuthority,
} from '@merv/contracts';
import { identityValid, Memberships, membershipMigration } from './memberships.js';
import { UserKeys, userKeyMigration } from './user-keys.js';
import {
  parseProjectContextUpdate,
  projectContextMigration,
  projectValue as project,
  type ProjectRow,
} from './project-context.js';

interface ActorRow {
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
interface CredentialRow {
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
const actor = (row: ActorRow): Actor => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  role: row.role,
  active: !!row.active,
  ...(row.user_issuer ? { user: { issuer: row.user_issuer, subject: row.user_subject! } } : {}),
  ...(row.service_owner ? { serviceOwner: row.service_owner } : {}),
  ...(row.agent_id ? { agentId: row.agent_id } : {}),
  ...(row.session_id ? { sessionId: row.session_id } : {}),
});
const credential = (row: CredentialRow): ActorCredential => ({
  id: row.id,
  actorId: row.actor_id,
  projectId: row.project_id,
  kind: row.kind,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  previousId: row.previous_id,
});
const roles = ['operator', 'producer', 'reviewer', 'reader'];
const permits = (role: Role, permission: Permission): boolean =>
  permission === 'read' ||
  role === 'operator' ||
  (permission === 'write' && role === 'producer') ||
  (permission === 'review' && role === 'reviewer');
export class ProjectScope implements Scope {
  toolPolicy!: ToolPolicy;
  private members!: Memberships;
  private userKeys!: UserKeys;
  private sessionAuthority?: SessionAuthority;
  private sessionAuthorityRegistration?: symbol;
  private conversationAuthority?: ConversationAuthority;
  private conversationAuthorityRegistration?: symbol;
  private managedAuthority?: ManagedRunnerAuthority;
  private managedAuthorityRegistration?: symbol;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private readonly clock: () => number = Date.now,
    grants: ToolGrant[] = [],
  ) {
    this.initialize = async () => {
      this.toolPolicy = new ExactToolPolicy(this, grants);
      await state.migrate('scope', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        membershipMigration,
        userKeyMigration,
        {
          version: 5,
          sql: postgresMigrations[5],
        },
        projectContextMigration,
        {
          version: 7,
          sql: postgresMigrations[7],
        },
        {
          version: 8,
          sql: postgresMigrations[8],
        },
      ]);
      this.members = new Memberships(
        state,
        () => this.time(),
        async (caller, permission, tx) => await this.require(caller, permission, tx),
      );
      this.userKeys = new UserKeys(
        state,
        () => this.time(),
        this.members,
        async (caller, permission, tx) => await this.require(caller, permission, tx),
      );
    };
  }
  async serviceActor(provider: string, projectId: string, tx: Transaction): Promise<Caller> {
    this.state.assertTransaction(tx);
    check(provider.trim().length > 0, 'invalid_provider', 'A service provider is required');
    await tx.run(
      "INSERT INTO actors(id,project_id,name,role,active,service_owner) VALUES (?,?,?,'producer',1,?) ON CONFLICT DO NOTHING",
      newId('actor'),
      projectId,
      `${provider} service`,
      provider,
    );
    const row = await tx.get<{ id: string }>(
      'SELECT id FROM actors WHERE project_id=? AND service_owner=?',
      projectId,
      provider,
    );
    check(row, 'service_unavailable', 'The service actor is unavailable', 503);
    return { projectId, actorId: row.id };
  }

  async acceptVerifiedIdentity(identity: VerifiedIdentity) {
    return await this.members.acceptVerifiedIdentity(identity);
  }
  async caller(principal: Principal, projectId?: string) {
    return principal?.kind === 'key'
      ? await this.userKeys.caller(principal, projectId)
      : await this.members.caller(principal, projectId);
  }
  async projects(principal: Principal) {
    return principal?.kind === 'key'
      ? await this.userKeys.projects(principal)
      : await this.members.projects(principal);
  }
  async authenticateKey(token: string): Promise<UserKey> {
    return await this.userKeys.authenticate(token);
  }
  async keys(principal: Principal, projectId?: string) {
    return await this.userKeys.keys(principal, projectId);
  }
  async createKey(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ) {
    return await this.userKeys.create(principal, input);
  }
  async rotateKey(principal: Principal, input: { keyId: string; expiresAt?: string | null }) {
    return await this.userKeys.rotate(principal, input);
  }
  async revokeKey(principal: Principal, keyId: string) {
    await this.userKeys.revoke(principal, keyId);
  }
  async createProject(principal: Principal, input: { name: string; requestId: string }) {
    return await this.members.createProject(principal, input);
  }
  async memberships(principal: Principal, projectId: string) {
    return await this.members.memberships(principal, projectId);
  }
  async addMember(principal: Principal, projectId: string, input: { subject: string; role: Role }) {
    return await this.members.addMember(principal, projectId, input);
  }
  async changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ) {
    return await this.members.changeMemberRole(principal, projectId, input);
  }
  async removeMember(principal: Principal, projectId: string, subject: string) {
    return await this.members.removeMember(principal, projectId, subject);
  }
  async adoptProject(
    principal: HumanPrincipal,
    projectId: string,
    options?: { repairReason: string },
  ) {
    return await this.members.adoptProject(principal, projectId, options);
  }
  registerSessionAuthority(authority: SessionAuthority): () => void {
    check(
      !this.sessionAuthority,
      'session_authority_registered',
      'Session authority is already installed',
      409,
    );
    this.sessionAuthority = authority;
    const registration = Symbol('session-authority');
    this.sessionAuthorityRegistration = registration;
    return () => {
      if (this.sessionAuthorityRegistration !== registration) return;
      this.sessionAuthorityRegistration = undefined;
      this.sessionAuthority = undefined;
    };
  }
  registerConversationAuthority(authority: ConversationAuthority): () => void {
    check(
      !this.conversationAuthority,
      'conversation_authority_registered',
      'Conversation authority is already installed',
      409,
    );
    const registration = Symbol('conversation-authority');
    this.conversationAuthority = authority;
    this.conversationAuthorityRegistration = registration;
    return () => {
      if (this.conversationAuthorityRegistration !== registration) return;
      this.conversationAuthority = undefined;
      this.conversationAuthorityRegistration = undefined;
    };
  }
  private requireAuthorityRegistration(registration: symbol | undefined): void {
    check(
      registration !== undefined && this.sessionAuthorityRegistration === registration,
      'session_unavailable',
      'Session authority changed during authorization; retry with the current provider',
      503,
    );
  }
  registerManagedRunnerAuthority(authority: ManagedRunnerAuthority): () => void {
    check(
      !this.managedAuthority,
      'managed_authority_registered',
      'Managed runner authority is already installed',
      409,
    );
    const registration = Symbol('managed-runner-authority');
    this.managedAuthority = authority;
    this.managedAuthorityRegistration = registration;
    return () => {
      if (this.managedAuthorityRegistration !== registration) return;
      this.managedAuthority = undefined;
      this.managedAuthorityRegistration = undefined;
    };
  }
  async delegationSource(caller: Caller, tx?: Transaction): Promise<DelegationSource> {
    caller = structuredClone(caller);
    check(
      !caller.managed,
      'managed_runner_forbidden',
      'A managed runner cannot delegate authority',
      403,
    );
    check(
      !caller.session,
      'nested_session',
      'A worker session cannot delegate another session',
      403,
    );
    // A conversation acts with exactly its person's authority: the source it was given.
    if (caller.conversation) return (await this.authorize(caller, 'read', tx)).source!;
    await this.require(caller, 'read', tx);
    const base = { actorId: caller.actorId, projectId: caller.projectId };
    if (caller.human) {
      const { issuer, subject, membershipId } = caller.human;
      return { ...base, kind: 'human', issuer, subject, membershipId };
    }
    const lookup = async (sql: Sql): Promise<DelegationSource> => {
      if (caller.key) {
        const key = (await sql.get<{ expires_at: string | null }>(
          'SELECT expires_at FROM user_keys WHERE id=?',
          caller.key.id,
        ))!;
        return {
          ...base,
          kind: 'key',
          keyId: caller.key.id,
          membershipId: caller.key.membershipId,
          expiresAt: key.expires_at,
        };
      }
      check(
        caller.credentialId,
        'delegation_required',
        'Delegation requires an authenticated source credential',
        403,
      );
      const row = await this.credentialRow(sql, caller.projectId, caller.credentialId);
      return { ...base, kind: 'actor', credentialId: row.id, expiresAt: row.expires_at };
    };
    return tx ? await lookup(tx) : await this.state.read(lookup);
  }
  async requireDelegation(
    source: DelegationSource,
    permission: Permission,
    tx?: Transaction,
  ): Promise<Actor> {
    source = structuredClone(source);
    check(
      source && typeof source.actorId === 'string' && typeof source.projectId === 'string',
      'invalid_delegation',
      'Invalid delegation source',
      403,
    );
    const base = { actorId: source.actorId, projectId: source.projectId };
    let caller: Caller;
    if (source.kind === 'human') {
      const lookup = async (sql: Sql): Promise<Actor> => {
        const row = await sql.get<ActorRow>(
          `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject
          FROM actors a JOIN member_actors m ON m.actor_id=a.id WHERE a.id=? AND a.project_id=?`,
          source.actorId,
          source.projectId,
        );
        check(row, 'membership_required', 'Delegated human membership is unavailable', 403);
        await this.requireHumanMembership(row, source, sql);
        check(
          permits(row.role, permission),
          'forbidden',
          `Actor lacks ${permission} permission`,
          403,
        );
        return actor(row);
      };
      if (tx) this.state.assertTransaction(tx);
      return tx ? await lookup(tx) : await this.state.read(lookup);
    } else if (source.kind === 'key') {
      caller = { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
    } else {
      check(
        source.kind === 'actor' && typeof source.credentialId === 'string',
        'invalid_delegation',
        'Invalid delegation source',
        403,
      );
      caller = { ...base, credentialId: source.credentialId };
    }
    const value = await this.require(caller, permission, tx);
    check(!value.sessionId, 'nested_session', 'A session cannot be a delegation source', 403);
    {
      const lookup = async (sql: Sql) =>
        await sql.get<{ expires_at: string | null }>(
          source.kind === 'key'
            ? 'SELECT expires_at FROM user_keys WHERE id=?'
            : 'SELECT expires_at FROM actor_credentials WHERE id=?',
          source.kind === 'key' ? source.keyId : source.credentialId,
        );
      const row = tx ? await lookup(tx) : await this.state.read(lookup);
      check(
        row && row.expires_at === source.expiresAt,
        'invalid_delegation',
        'Delegation credential lifetime changed',
        403,
      );
    }
    return value;
  }
  async createSessionActor(
    source: DelegationSource,
    input: { sessionId: string; agentId?: string; role: Exclude<Role, 'operator'>; name: string },
    tx: Transaction,
  ): Promise<Actor> {
    source = structuredClone(source);
    input = structuredClone(input);
    this.state.assertTransaction(tx);
    check(
      ['producer', 'reviewer', 'reader'].includes(input.role) &&
        typeof input.sessionId === 'string' &&
        input.sessionId.length > 0 &&
        typeof input.name === 'string' &&
        visible(input.name) &&
        input.name.length <= 200,
      'invalid_session_actor',
      'Session actors need a name, lease and non-operator role',
    );
    await this.requireDelegation(
      source,
      input.role === 'producer' ? 'write' : input.role === 'reviewer' ? 'review' : 'read',
      tx,
    );
    const value: Actor = {
      id: newId('actor'),
      projectId: source.projectId,
      name: input.name.trim(),
      role: input.role,
      active: true,
      sessionId: input.sessionId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    };
    await tx.run(
      'INSERT INTO actors(id,project_id,name,role,active,session_id,agent_id) VALUES(?,?,?,?,1,?,?)',
      value.id,
      value.projectId,
      value.name,
      value.role,
      input.sessionId,
      input.agentId ?? null,
    );
    return value;
  }
  async setAgentRole(
    source: DelegationSource,
    actorId: string,
    role: Exclude<Role, 'operator'>,
    tx: Transaction,
  ): Promise<void> {
    source = structuredClone(source);
    this.state.assertTransaction(tx);
    check(
      ['producer', 'reviewer', 'reader'].includes(role),
      'invalid_session_role',
      'Agents cannot become operators',
    );
    await this.requireDelegation(
      source,
      role === 'producer' ? 'write' : role === 'reviewer' ? 'review' : 'read',
      tx,
    );
    const result = await tx.run(
      'UPDATE actors SET role=? WHERE id=? AND project_id=? AND agent_id IS NOT NULL AND active=1',
      role,
      actorId,
      source.projectId,
    );
    check(result.changes === 1, 'agent_unavailable', 'Agent identity is unavailable', 403);
  }
  async retireSessionActor(actorId: string, reason: string, tx: Transaction): Promise<void> {
    this.state.assertTransaction(tx);
    const row = await tx.get<ActorRow>(
      'SELECT * FROM actors WHERE id=? AND session_id IS NOT NULL',
      actorId,
    );
    check(row, 'not_found', 'Session actor not found', 404);
    if (!row.active) return;
    await tx.run('UPDATE actors SET active=0 WHERE id=? AND active=1', actorId);
    await this.state.appendEvent(tx, {
      projectId: row.project_id,
      actorId: 'system:sessions',
      type: 'actor.revoked',
      subjectId: row.id,
      data: { sessionId: row.session_id!, reason, managedBy: 'sessions' },
    });
  }
  async authorityActor(caller: Caller, tx?: Transaction): Promise<Actor> {
    caller = structuredClone(caller);
    if (!caller.session) return await this.require(caller, 'read', tx);
    const registration = this.sessionAuthorityRegistration;
    const lookup = async (sql: Sql): Promise<Actor> => {
      if (!('transactionId' in sql)) return await this.state.transaction(lookup);
      // The session guard and the source it vouched for are read in one transaction.
      const { source } = await this.authorize(caller, 'read', sql as Transaction);
      return await this.requireDelegation(source!, 'read', sql as Transaction);
    };
    const result = tx ? await lookup(tx) : await this.state.read(lookup);
    this.requireAuthorityRegistration(registration);
    return result;
  }
  private time(): string {
    return new Date(this.clock()).toISOString();
  }
  private selfExpiry(expiresAt: string | null, limit: string | null): void {
    check(
      limit === null || (expiresAt !== null && expiresAt <= limit),
      'self_expiry_extension',
      'A self-issued credential cannot extend its existing expiry; another operator must authorize that extension',
      403,
    );
  }
  private async issue(
    tx: Transaction,
    projectId: string,
    name: string,
    role: Role,
    expiresAt?: string | null,
  ): Promise<IssuedActorCredential> {
    check(
      typeof name === 'string' && visible(name) && name.length <= 200,
      'invalid_actor',
      'Actor needs a nonblank name of at most 200 characters',
    );
    check(roles.includes(role), 'invalid_role', 'Unknown actor role');
    const value: Actor = { id: newId('actor'), projectId, name: name.trim(), role, active: true };
    await tx.run(
      'INSERT INTO actors(id,project_id,name,role,active) VALUES(?,?,?,?,1)',
      value.id,
      projectId,
      value.name,
      role,
    );
    const time = this.time();
    return await this.issueCredential(tx, value, expiry(expiresAt, time), null, time);
  }
  private async issueCredential(
    tx: Transaction,
    value: Actor,
    expiresAt: string | null,
    previousId: string | null,
    time: string,
  ): Promise<IssuedActorCredential> {
    const token = randomBytes(32).toString('base64url');
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
    await tx.run(
      'INSERT INTO actor_credentials(id,actor_id,project_id,kind,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,?)',
      issued.id,
      value.id,
      value.projectId,
      issued.kind,
      sha256Hex(token),
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
        summary: '',
        contextRevision: 0,
      };
      await tx.run(
        'INSERT INTO projects(id,name,created_at) VALUES(?,?,?)',
        value.id,
        value.name,
        value.createdAt,
      );
      const credential = await this.issue(tx, value.id, input.actorName, 'operator');
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
  async authenticate(token: string): Promise<AuthenticatedActor> {
    check(
      typeof token === 'string' && token.length >= 32 && token.length <= 200,
      'unauthorized',
      'Invalid bearer credential',
      401,
    );
    const row = await this.state.read(
      async (sql) =>
        await sql.get<CredentialRow & { name: string; role: Role; active: number }>(
          `SELECT c.*,a.name,a.role,a.active FROM actor_credentials c
         JOIN actors a ON a.id=c.actor_id AND a.project_id=c.project_id
         WHERE c.token_hash=? AND a.active=1 AND c.revoked_at IS NULL
           AND a.session_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM member_actors m WHERE m.actor_id=a.id)
           AND (c.expires_at IS NULL OR c.expires_at>?)`,
          sha256Hex(token),
          this.time(),
        ),
    );
    check(row, 'unauthorized', 'Invalid, expired or revoked bearer credential', 401);
    return { ...actor({ ...row, id: row.actor_id }), credential: credential(row) };
  }
  async recognizesCredential(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 200) return false;
    if (token.startsWith('ms_')) return true;
    if (await this.userKeys.recognizes(token)) return true;
    return await this.state.read(
      async (sql) =>
        !!(await sql.get('SELECT id FROM actor_credentials WHERE token_hash=?', sha256Hex(token))),
    );
  }
  /** Shared membership predicate for verified JWT callers and durable human delegations. */
  private async requireHumanMembership(
    row: ActorRow,
    human: {
      actorId: string;
      projectId: string;
      issuer: string;
      subject: string;
      membershipId: string;
    },
    sql: Sql,
  ): Promise<void> {
    check(
      typeof human.membershipId === 'string' && human.membershipId.length > 0,
      'membership_required',
      'Current membership authority is required',
      403,
    );
    const bound = await sql.get(
      `SELECT m.id FROM project_memberships m
      JOIN shared_users u ON u.issuer=m.issuer AND u.subject=m.subject
      WHERE m.id=? AND m.actor_id=? AND m.project_id=? AND m.issuer=? AND m.subject=? AND m.role=? AND m.active=1`,
      human.membershipId,
      human.actorId,
      human.projectId,
      human.issuer,
      human.subject,
      row.role,
    );
    check(
      row.active && bound && human.issuer === row.user_issuer && human.subject === row.user_subject,
      'membership_required',
      'An active current membership in this project is required',
      403,
    );
  }
  async require(caller: Caller, permission: Permission, tx?: Transaction): Promise<Actor> {
    return (await this.authorize(caller, permission, tx)).actor;
  }
  /** require(), also returning the delegation source that a worker's session authority vouched for. */
  private async authorize(
    caller: Caller,
    permission: Permission,
    tx?: Transaction,
  ): Promise<{ actor: Actor; source?: DelegationSource }> {
    caller = structuredClone(caller);
    const registration = this.sessionAuthorityRegistration;
    const managedRegistration = this.managedAuthorityRegistration;
    const conversationRegistration = this.conversationAuthorityRegistration;
    if (tx) this.state.assertTransaction(tx);
    const lookup = async (sql: Sql): Promise<{ actor: Actor; source?: DelegationSource }> => {
      const row = await sql.get<ActorRow>(
        `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
         LEFT JOIN member_actors m ON m.actor_id=a.id
         WHERE a.id=? AND a.project_id=?`,
        caller.actorId,
        caller.projectId,
      );
      check(
        row,
        caller.human || caller.key ? 'membership_required' : 'forbidden',
        'Actor cannot access this project',
        403,
      );
      check(
        [
          caller.human,
          caller.credentialId,
          caller.key,
          caller.session,
          caller.managed,
          caller.conversation,
        ].filter((value) => value !== undefined).length <= 1,
        'forbidden',
        'A caller cannot combine human, actor-credential and user-key authority',
        403,
      );
      let source: DelegationSource | undefined;
      if (caller.conversation) {
        check(
          !row.session_id,
          'conversation_forbidden',
          'Conversations act only as their original source actor',
          403,
        );
        if (!('transactionId' in sql))
          return await this.state.snapshot(() =>
            this.state.transaction((inner) => this.authorize(caller, permission, inner)),
          );
        const authority = this.conversationAuthority;
        check(authority, 'conversation_unavailable', 'Conversation authority is unavailable', 503);
        source = await authority.require(caller, sql as Transaction);
        check(
          source && source.actorId === caller.actorId && source.projectId === caller.projectId,
          'conversation_forbidden',
          'Conversation source does not match this caller',
          403,
        );
        // The person's live role, and a key's own limits, decide every permission.
        const original = await this.requireDelegation(source, permission, sql as Transaction);
        check(
          !original.sessionId && original.id === row.id && original.projectId === row.project_id,
          'conversation_forbidden',
          'Conversation source must be the original actor',
          403,
        );
        return { actor: original, source };
      } else if (caller.managed) {
        check(
          permission === 'read' && !row.session_id,
          'managed_runner_forbidden',
          'Managed runners may only use their bound execution controls',
          403,
        );
        if (!('transactionId' in sql))
          return await this.state.snapshot(() =>
            this.state.transaction((inner) => this.authorize(caller, permission, inner)),
          );
        const authority = this.managedAuthority;
        check(
          authority,
          'managed_runner_unavailable',
          'Managed runner authority is unavailable',
          503,
        );
        source = await authority.require(caller, sql as Transaction);
        check(
          source.actorId === caller.actorId && source.projectId === caller.projectId,
          'managed_runner_forbidden',
          'Managed runner source does not match this caller',
          403,
        );
      } else if (row.session_id) {
        const own = (caller.session?.agentSessionId ?? caller.session?.id) === row.session_id;
        // A session halted while this call was in flight has already retired its actor. Tell
        // the worker its session ended, the way its next call will, rather than that it lacks
        // a permission and might usefully try something else.
        check(row.active || !own, 'session_closed', 'Session is closed', 401);
        check(own, 'forbidden', 'Worker actors require their live session authority', 403);
        // A worker's authority is checked several times per tool call and only read, so
        // it is read on a snapshot: outside any scope that takes no writer lock.
        if (!('transactionId' in sql))
          return await this.state.snapshot(() =>
            this.state.transaction(
              async (inner) => await this.authorize(caller, permission, inner),
            ),
          );
        const authority = this.sessionAuthority;
        check(authority, 'session_unavailable', 'Session authority is unavailable', 503);
        source = await authority.require(caller, sql as Transaction);
      } else if (caller.session) {
        check(false, 'forbidden', 'Session authority cannot select another actor', 403);
      } else if (row.user_issuer && caller.key !== undefined) {
        await this.userKeys.authorize(caller, sql);
      } else if (row.user_issuer) {
        check(
          caller.human !== undefined,
          'membership_required',
          'Member actors require verified human authority',
          403,
        );
        const human = caller.human;
        check(
          identityValid(human, this.time()),
          'forbidden',
          'Human authority is invalid or expired',
          403,
        );
        await this.requireHumanMembership(
          row,
          { ...human, actorId: caller.actorId, projectId: caller.projectId },
          sql,
        );
      } else {
        check(
          caller.human === undefined && caller.key === undefined,
          'forbidden',
          'User authority cannot select an independent machine actor',
          403,
        );
        check(row.active, 'forbidden', 'Actor cannot access this project', 403);
      }
      if (caller.credentialId !== undefined) {
        check(
          typeof caller.credentialId === 'string' && caller.credentialId.length > 0,
          'forbidden',
          'Invalid credential identity',
          403,
        );
        const bound = await sql.get<CredentialRow>(
          `SELECT * FROM actor_credentials WHERE id=? AND actor_id=? AND project_id=?
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
          caller.credentialId,
          caller.actorId,
          caller.projectId,
          this.time(),
        );
        check(bound, 'forbidden', 'Credential cannot authorize this actor in this project', 403);
      }
      return { actor: actor(row), source };
    };
    const value = tx ? await lookup(tx) : await this.state.read(lookup);
    // An in-flight decision cannot survive provider removal, even if the same object
    // is installed again before it returns. The caller must make a fresh request.
    if (value.actor.sessionId) this.requireAuthorityRegistration(registration);
    if (caller.managed)
      check(
        managedRegistration !== undefined &&
          this.managedAuthorityRegistration === managedRegistration,
        'managed_runner_unavailable',
        'Managed runner authority changed during authorization',
        503,
      );
    if (caller.conversation)
      check(
        conversationRegistration !== undefined &&
          this.conversationAuthorityRegistration === conversationRegistration,
        'conversation_unavailable',
        'Conversation authority changed during authorization',
        503,
      );
    const allowed = permits(value.actor.role, permission);
    check(allowed, 'forbidden', `Actor lacks ${permission} permission`, 403);
    return value;
  }
  /** Internal eligibility lookup; inspecting an actor does not assume that actor's authority. */
  async eligible(
    projectId: string,
    actorId: string,
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean> {
    if (tx) this.state.assertTransaction(tx);
    const lookup = async (sql: Sql) =>
      await sql.get<{ role: Role }>(
        `SELECT a.role FROM actors a LEFT JOIN member_actors m ON m.actor_id=a.id
         WHERE a.id=? AND a.project_id=? AND a.active=1 AND (m.actor_id IS NULL OR EXISTS(
           SELECT 1 FROM project_memberships p WHERE p.actor_id=a.id AND p.project_id=a.project_id
           AND p.issuer=m.issuer AND p.subject=m.subject AND p.role=a.role AND p.active=1))`,
        actorId,
        projectId,
      );
    const row = tx ? await lookup(tx) : await this.state.read(lookup);
    return !!row && permits(row.role, permission);
  }
  async project(caller: Caller, tx?: Transaction): Promise<Project> {
    caller = structuredClone(caller);
    if (tx) this.state.assertTransaction(tx);
    await this.require(caller, 'read', tx);
    const read = async (sql: Sql) =>
      project((await sql.get<ProjectRow>('SELECT * FROM projects WHERE id=?', caller.projectId))!);
    return tx ? await read(tx) : await this.state.read(read);
  }
  async updateProjectContext(
    caller: Caller,
    raw: ProjectContextUpdate,
    transaction?: Transaction,
  ): Promise<Project> {
    caller = structuredClone(caller);
    const input = parseProjectContextUpdate(raw);
    return await inTransaction(this.state, transaction, async (tx) => {
      const authorize = async () => {
        check(
          !caller.session,
          'forbidden',
          'Worker sessions cannot edit the project Introduction',
          403,
        );
        const writer = await this.require(caller, 'write', tx);
        check(
          !writer.sessionId,
          'forbidden',
          'Worker actors cannot edit the project Introduction',
          403,
        );
      };
      await authorize();
      return await receipted(
        tx,
        caller,
        input.requestId,
        digest(input),
        async () => {
          const before = project(
            (await tx.get<ProjectRow>('SELECT * FROM projects WHERE id=?', caller.projectId))!,
          );
          await authorize();
          const changed = await tx.run(
            'UPDATE projects SET summary=?,context_revision=context_revision+1 WHERE id=? AND summary=? AND context_revision<9007199254740991',
            input.summary,
            caller.projectId,
            input.expectedSummary,
          );
          check(
            changed.changes === 1,
            'project_context_conflict',
            'Project Introduction changed; reread it before retrying with its exact text',
            409,
          );
          const result = project(
            (await tx.get<ProjectRow>('SELECT * FROM projects WHERE id=?', caller.projectId))!,
          );
          await this.state.appendEvent(tx, {
            projectId: caller.projectId,
            actorId: caller.actorId,
            type: 'project.context.updated',
            subjectId: caller.projectId,
            data: {
              previousSummary: before.summary!,
              summary: result.summary!,
              previousContextRevision: before.contextRevision!,
              contextRevision: result.contextRevision!,
              ...(caller.human
                ? {
                    source: {
                      kind: 'human',
                      issuer: caller.human.issuer,
                      subject: caller.human.subject,
                      membershipId: caller.human.membershipId,
                    },
                  }
                : caller.credentialId
                  ? { source: { kind: 'actor', credentialId: caller.credentialId } }
                  : eventSource(caller)),
            },
          });
          return result;
        },
        {
          table: 'project_context_commands',
          result: 'result_json',
          conflict: 'requestId already updated project context with different input',
          after: authorize,
          replay: async (result) => {
            await authorize();
            return result;
          },
        },
      );
    });
  }
  async issueActor(caller: Caller, input: { name: string; role: Role; expiresAt?: string | null }) {
    caller = structuredClone(caller);
    input = structuredClone(input);
    return await this.state.transaction(async (tx) => {
      await this.administer(caller, tx);
      const result = await this.issue(
        tx,
        caller.projectId,
        input.name,
        input.role,
        input.expiresAt,
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
    return await this.state.transaction(async (tx) => {
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
      const { credentialId } = await this.administer(caller, tx);
      const target = await this.actorRow(tx, caller.projectId, input.actorId);
      this.machineActor(target);
      check(target.active, 'actor_revoked', 'Cannot issue credentials for an inactive actor', 409);
      const current =
        target.id === caller.actorId && credentialId !== undefined
          ? await this.credentialRow(tx, caller.projectId, credentialId)
          : undefined;
      const time = this.time();
      const expiresAt = expiry(
        input.expiresAt === undefined ? current?.expires_at : input.expiresAt,
        time,
      );
      if (current) this.selfExpiry(expiresAt, current.expires_at);
      const issued = await this.issueCredential(tx, actor(target), expiresAt, null, time);
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
      const { credentialId } = await this.administer(caller, tx);
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
      // A self-rotation extends neither the credential it replaces nor the one making the call.
      if (target.id === caller.actorId) {
        this.selfExpiry(expiresAt, previous.expires_at);
        if (credentialId !== undefined)
          this.selfExpiry(
            expiresAt,
            (await this.credentialRow(tx, caller.projectId, credentialId)).expires_at,
          );
      }
      const result = await tx.run(
        'UPDATE actor_credentials SET revoked_at=? WHERE id=? AND project_id=? AND revoked_at IS NULL',
        time,
        previous.id,
        caller.projectId,
      );
      check(result.changes === 1, 'credential_revoked', 'Credential was already revoked', 409);
      const issued = await this.issueCredential(tx, actor(target), expiresAt, previous.id, time);
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
      if (target.revoked_at !== null) return;
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
      `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
       LEFT JOIN member_actors m ON m.actor_id=a.id WHERE a.id=? AND a.project_id=?`,
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
   * name. */
  private async administer(caller: Caller, tx: Transaction): Promise<{ credentialId?: string }> {
    const { source } = await this.authorize(caller, 'admin', tx);
    const via = caller.conversation ? source : undefined;
    check(
      caller.key === undefined && caller.session === undefined && via?.kind !== 'key',
      'forbidden',
      'User keys and worker sessions cannot administer independent actor credentials or actors',
      403,
    );
    return {
      credentialId: via
        ? via.kind === 'actor'
          ? via.credentialId
          : undefined
        : caller.credentialId,
    };
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
  async actors(caller: Caller) {
    caller = structuredClone(caller);
    await this.require(caller, 'admin');
    return await this.state.read(async (sql) =>
      (
        await sql.all<ActorRow>(
          `SELECT a.*,m.issuer AS user_issuer,m.subject AS user_subject FROM actors a
          LEFT JOIN member_actors m ON m.actor_id=a.id WHERE a.project_id=? ORDER BY a.active DESC,a.role,a.name,a.id`,
          caller.projectId,
        )
      ).map(actor),
    );
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
      // Revoking twice records nothing twice.
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
export const scopePlugin = {
  name: 'merv-scope',
  Config: z
    .object({ grants: grantsSchema.default([]) })
    .strict()
    .default({ grants: [] }),
  inject: ['state'],
  async apply(ctx: Context, config: { grants: ToolGrant[] } = { grants: [] }) {
    ctx.provide('scope', await createService(new ProjectScope(ctx.state, Date.now, config.grants)));
  },
};
export default scopePlugin;
