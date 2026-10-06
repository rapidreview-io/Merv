import { CredentialStore } from '@merv/identity/credentials';
import { Ledger } from './ledger.js';
import { needs, permits, workerRoles } from './rules.js';
import { visible, createService, receipted, sha256Hex, within } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import { postgresMigrations as memberships } from './memberships.postgres.js';
import { postgresMigrations as userKeys } from './user-keys.postgres.js';
import { postgresMigrations as projectContext } from './project-context.postgres.js';
import { z } from 'zod';
import { ExactToolPolicy, grantsSchema } from './tool-policy.js';
import type { ToolGrant, ToolPolicy } from '@merv/contracts';
import type { Context } from 'cordis';
import {
  check,
  digest,
  eventSource,
  inTransaction,
  newId,
  ROLES,
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
  type StoredEvent,
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
import { identityValid, LIVE_OPERATOR, Memberships } from './memberships.js';
import { UserKeys } from './user-keys.js';
import {
  parseProjectContextUpdate,
  projectValue as project,
  type ProjectRow,
} from './project-context.js';
import {
  ACTOR_WITH_MEMBER,
  ActorCredentials,
  actor,
  credential,
  type ActorRow,
  type CredentialRow,
  type Decision,
} from './actor-credentials.js';

/** The one installed provider of a kind of caller authority, and the registration it came with. */
class AuthoritySlot<T> {
  #value?: T;
  #token?: symbol;
  constructor(
    private readonly code: { registered: string; unavailable: string },
    private readonly text: { installed: string; unavailable: string; changed: string },
  ) {}
  /** Throws at once when a provider is installed; the disposer withdraws only this registration. */
  install(value: T): () => void {
    check(!this.#value, this.code.registered, this.text.installed, 409);
    const token = Symbol(this.code.registered);
    this.#value = value;
    this.#token = token;
    return () => {
      if (this.#token !== token) return;
      this.#value = this.#token = undefined;
    };
  }
  /** The current registration, captured before a decision awaits anything. */
  get token(): symbol | undefined {
    return this.#token;
  }
  /** The installed provider, which a decision asks for only once it needs it. */
  provider(): T {
    const value = this.#value;
    check(value, this.code.unavailable, this.text.unavailable, 503);
    return value;
  }
  /** Refuses a decision whose provider was withdrawn, or installed again, while it was pending. */
  fence(token: symbol | undefined): void {
    check(
      token !== undefined && this.#token === token,
      this.code.unavailable,
      this.text.changed,
      503,
    );
  }
}
export class ProjectScope implements Scope {
  toolPolicy!: ToolPolicy;
  introductionWriter?: string;
  private members!: Memberships;
  private userKeys!: UserKeys;
  private ledger: Ledger;
  private credentials: ActorCredentials;
  private sessions = new AuthoritySlot<SessionAuthority>(
    { registered: 'session_authority_registered', unavailable: 'session_unavailable' },
    {
      installed: 'Session authority is already installed',
      unavailable: 'Session authority is unavailable',
      changed: 'Session authority changed during authorization; retry with the current provider',
    },
  );
  private conversations = new AuthoritySlot<ConversationAuthority>(
    { registered: 'conversation_authority_registered', unavailable: 'conversation_unavailable' },
    {
      installed: 'Conversation authority is already installed',
      unavailable: 'Conversation authority is unavailable',
      changed: 'Conversation authority changed during authorization',
    },
  );
  private managed = new AuthoritySlot<ManagedRunnerAuthority>(
    { registered: 'managed_authority_registered', unavailable: 'managed_runner_unavailable' },
    {
      installed: 'Managed runner authority is already installed',
      unavailable: 'Managed runner authority is unavailable',
      changed: 'Managed runner authority changed during authorization',
    },
  );
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private readonly clock: () => number = Date.now,
    grants: ToolGrant[] = [],
  ) {
    this.ledger = new Ledger(new CredentialStore(state, clock));
    this.credentials = new ActorCredentials(
      state,
      this.ledger,
      () => this.time(),
      async (caller, permission, tx) => await this.authorize(caller, permission, tx),
      async (caller, permission, tx) => await this.require(caller, permission, tx),
    );
    this.initialize = async () => {
      await this.ledger.initialize();
      this.toolPolicy = new ExactToolPolicy(this, grants);
      // In version order: integer keys enumerate ascending. Production pins each text by its digest.
      const texts = { ...postgresMigrations, ...memberships, ...userKeys, ...projectContext };
      await state.migrate(
        'scope',
        Object.entries(texts).map(([version, sql]) => ({ version: +version, sql })),
      );
      this.members = new Memberships(
        state,
        () => this.time(),
        async (caller, permission, tx) => await this.require(caller, permission, tx),
      );
      this.userKeys = new UserKeys(
        state,
        this.ledger,
        () => this.time(),
        this.members,
        async (caller, permission, tx) => await this.require(caller, permission, tx),
      );
    };
  }
  async projectOwners(
    tx?: Transaction,
  ): Promise<{ projectId: string; source: DelegationSource }[]> {
    const read = (sql: Sql) =>
      sql.all<{
        id: string;
        project_id: string;
        actor_id: string;
        issuer: string;
        subject: string;
      }>(
        `SELECT * FROM (SELECT DISTINCT ON (m.project_id) m.id,m.project_id,m.actor_id,m.issuer,m.subject,m.created_at
         FROM ${LIVE_OPERATOR} ORDER BY m.project_id,m.created_at,m.id) o ORDER BY o.created_at,o.id`,
      );
    return (await within(this.state, tx, read)).map((row) => ({
      projectId: row.project_id,
      source: {
        actorId: row.actor_id,
        projectId: row.project_id,
        kind: 'human',
        issuer: row.issuer,
        subject: row.subject,
        membershipId: row.id,
      },
    }));
  }
  async projectCreator(projectId: string, tx?: Transaction) {
    return await within(this.state, tx, async (sql) => {
      const row =
        (await sql.get<{ issuer: string; subject: string }>(
          'SELECT issuer,subject FROM user_project_requests WHERE project_id=?',
          projectId,
        )) ??
        (await sql.get<{ issuer: string; subject: string }>(
          `SELECT m.issuer,m.subject FROM ${LIVE_OPERATOR} AND m.project_id=? ORDER BY m.created_at,m.id LIMIT 1`,
          projectId,
        ));
      return row ? { issuer: row.issuer, subject: row.subject } : null;
    });
  }
  async serviceActor(
    provider: string,
    projectId: string,
    tx?: Transaction,
    role: 'producer' | 'reviewer' = 'producer',
  ): Promise<Caller> {
    check(
      typeof provider === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(provider),
      'invalid_provider',
      'A service provider is a short lowercase slug',
    );
    const find = async (sql: Sql) =>
      await sql.get<{ id: string; role: Role }>(
        'SELECT id,role FROM actors WHERE project_id=? AND service_owner=?',
        projectId,
        provider,
      );
    // Every task, workflow and session admission asks again: once it exists, one read, no lock.
    const found = await within(this.state, tx, find);
    if (found?.role === role) return { projectId, actorId: found.id };
    // A role that does not fit the provider still reaches the INSERT, whose trigger refuses it.
    return await inTransaction(this.state, tx, async (tx) => {
      check(
        await tx.get('SELECT 1 FROM projects WHERE id=?', projectId),
        'not_found',
        'Project not found',
        404,
      );
      await tx.run(
        'INSERT INTO actors(id,project_id,name,role,active,service_owner) VALUES (?,?,?,?,1,?) ON CONFLICT DO NOTHING',
        newId('actor'),
        projectId,
        `${provider} service`,
        role,
        provider,
      );
      const row = await find(tx);
      check(row, 'service_unavailable', 'The service actor is unavailable', 503);
      return { projectId, actorId: row.id };
    });
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
    return this.sessions.install(authority);
  }
  registerConversationAuthority(authority: ConversationAuthority): () => void {
    return this.conversations.install(authority);
  }
  registerManagedRunnerAuthority(authority: ManagedRunnerAuthority): () => void {
    return this.managed.install(authority);
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
    const { source, lifetime } = await this.authorize(caller, 'read', tx);
    // A conversation acts with exactly its person's authority: the source it was given.
    if (caller.conversation) return source!;
    const base = { actorId: caller.actorId, projectId: caller.projectId };
    if (caller.service) return { ...base, kind: 'service', vouchedBy: caller.service.vouchedBy };
    if (caller.human) {
      const { issuer, subject, membershipId } = caller.human;
      return { ...base, kind: 'human', issuer, subject, membershipId };
    }
    check(
      caller.key || caller.credentialId,
      'delegation_required',
      'Delegation requires an authenticated source credential',
      403,
    );
    // The authorization above just read the key or credential row, and with it the deadline.
    check(lifetime !== undefined, 'scope_internal', 'Credential lifetime unavailable', 500);
    return caller.key
      ? {
          ...base,
          kind: 'key',
          keyId: caller.key.id,
          membershipId: caller.key.membershipId,
          expiresAt: lifetime,
        }
      : { ...base, kind: 'actor', credentialId: caller.credentialId!, expiresAt: lifetime };
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
      return await within(this.state, tx, lookup);
    } else if (source.kind === 'key') {
      caller = { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
    } else if (source.kind === 'service') {
      caller = { ...base, service: { vouchedBy: source.vouchedBy } };
    } else {
      check(
        source.kind === 'actor' && typeof source.credentialId === 'string',
        'invalid_delegation',
        'Invalid delegation source',
        403,
      );
      caller = { ...base, credentialId: source.credentialId };
    }
    const { actor: value, lifetime } = await this.authorize(caller, permission, tx);
    check(!value.sessionId, 'nested_session', 'A session cannot be a delegation source', 403);
    // A key or credential source holds only while its row keeps the deadline it was given. A
    // service lapses with its voucher, whose lifetime its authorization already checked.
    check(
      source.kind === 'service' || lifetime === source.expiresAt,
      'invalid_delegation',
      'Delegation credential lifetime changed',
      403,
    );
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
      workerRoles.includes(input.role) &&
        typeof input.sessionId === 'string' &&
        input.sessionId.length > 0 &&
        input.sessionId.length <= 200 &&
        (input.agentId === undefined ||
          (typeof input.agentId === 'string' &&
            input.agentId.length > 0 &&
            input.agentId.length <= 200)) &&
        typeof input.name === 'string' &&
        visible(input.name) &&
        input.name.length <= 200,
      'invalid_session_actor',
      'Session actors need a name, lease and non-operator role',
    );
    await this.requireDelegation(source, needs(input.role), tx);
    const value: Actor = {
      id: newId('actor'),
      projectId: source.projectId,
      name: input.name.trim(),
      role: input.role,
      active: true,
      sessionId: input.sessionId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
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
    check(workerRoles.includes(role), 'invalid_session_role', 'Agents cannot become operators');
    await this.requireDelegation(source, needs(role), tx);
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
  async permissionLost(
    projectId: string,
    actorId: string,
    permission: Permission,
    after: number,
    tx: Transaction,
  ): Promise<boolean> {
    this.state.assertTransaction(tx);
    const held = (role: unknown) =>
      ROLES.includes(role as Role) && permits(role as Role, permission);
    const lost = (event: StoredEvent) =>
      event.type === 'actor.revoked' || (held(event.data.beforeRole) && !held(event.data.role));
    for (const type of ['actor.revoked', 'actor.permissions_changed'])
      for (let cursor = after; ;) {
        const page = await this.state.findEvents(
          { projectId, subjectId: actorId, type, after: cursor },
          1000,
          tx,
        );
        if (page.some(lost)) return true;
        if (page.length < 1000) break;
        cursor = page.at(-1)!.id;
      }
    return false;
  }
  async authorityActor(caller: Caller, tx?: Transaction): Promise<Actor> {
    caller = structuredClone(caller);
    if (!caller.session) return await this.require(caller, 'read', tx);
    const registration = this.sessions.token;
    const result = await within(
      this.state,
      tx,
      async (sql) => {
        // The session guard and the source it vouched for are read in one transaction.
        const { source } = await this.authorize(caller, 'read', sql as Transaction);
        return await this.requireDelegation(source!, 'read', sql as Transaction);
      },
      'read',
    );
    this.sessions.fence(registration);
    return result;
  }
  private time(): string {
    return new Date(this.clock()).toISOString();
  }
  async bootstrap(input: { projectName: string; actorName: string }) {
    return await this.credentials.bootstrap(input);
  }
  async authenticate(token: string): Promise<AuthenticatedActor> {
    const verified = await this.ledger.authenticate(token, 'actor');
    const row = await this.state.read(
      async (sql) =>
        await sql.get<CredentialRow & { name: string; role: Role; active: number }>(
          `SELECT c.*,a.name,a.role,a.active FROM actor_credentials c
         JOIN actors a ON a.id=c.actor_id AND a.project_id=c.project_id
         WHERE c.id=? AND c.token_hash=? AND a.active=1 AND c.revoked_at IS NULL
           AND a.session_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM member_actors m WHERE m.actor_id=a.id)
           AND (c.expires_at IS NULL OR c.expires_at>?)`,
          verified.subject,
          verified.tokenHash,
          this.time(),
        ),
    );
    check(row, 'unauthorized', 'Invalid, expired or revoked bearer credential', 401);
    return { ...actor({ ...row, id: row.actor_id }), credential: credential(row) };
  }
  async recognizesCredential(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 200) return false;
    // Sessions' bearers (session, managed runner, enrollment), which Scope does not store.
    if (/^m[ers]_/.test(token)) return true;
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
  /** require(), also returning the delegation source that a worker's session authority vouched for
   * and the deadline of the actor credential or user key the decision rested on, if any. */
  private async authorize(
    caller: Caller,
    permission: Permission,
    tx?: Transaction,
  ): Promise<Decision> {
    caller = structuredClone(caller);
    const registration = this.sessions.token;
    const managedRegistration = this.managed.token;
    const conversationRegistration = this.conversations.token;
    const provided = caller.session || caller.managed || caller.conversation || caller.service;
    // A provider's own refusals come first. Then the source it vouched for must belong to this
    // project and, unless it is a worker's delegator, be this very caller.
    const vouched = (
      source: DelegationSource | undefined,
      sameActor: boolean,
      code: string,
      message: string,
    ) =>
      check(
        !!source &&
          source.projectId === caller.projectId &&
          (!sameActor || source.actorId === caller.actorId),
        code,
        message,
        403,
      );
    const lookup = async (sql: Sql): Promise<Decision> => {
      // Unreachable: `within` hands every provider-backed decision a transaction, below.
      check(
        !provided || 'transactionId' in sql,
        'scope_internal',
        'Provider-backed authority needs a transaction',
        500,
      );
      const row = await sql.get<ActorRow>(
        `${ACTOR_WITH_MEMBER} WHERE a.id=? AND a.project_id=?`,
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
          caller.service,
        ].filter((value) => value !== undefined).length <= 1,
        'forbidden',
        'A caller cannot combine human, actor-credential and user-key authority',
        403,
      );
      let source: DelegationSource | undefined;
      let lifetime: string | null | undefined;
      if (caller.conversation) {
        check(
          !row.session_id,
          'conversation_forbidden',
          'Conversations act only as their original source actor',
          403,
        );
        source = await this.conversations.provider().require(caller, sql as Transaction);
        vouched(
          source,
          true,
          'conversation_forbidden',
          'Conversation source does not match this caller',
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
        source = await this.managed.provider().require(caller, sql as Transaction);
        vouched(
          source,
          true,
          'managed_runner_forbidden',
          'Managed runner source does not match this caller',
        );
        // Defence in depth: the real provider's requireDelegation already refuses a revoked actor.
        check(
          row.active,
          'managed_runner_forbidden',
          'Managed runner source actor is revoked',
          403,
        );
      } else if (caller.service) {
        const { vouchedBy } = caller.service;
        check(
          row.service_owner &&
            row.active &&
            vouchedBy?.projectId === caller.projectId &&
            vouchedBy.kind !== 'service',
          'forbidden',
          'Only a service of this project acts for one of its people',
          403,
        );
        // It acts only while the person who vouched for it may still write here.
        await this.requireDelegation(vouchedBy, 'write', sql as Transaction);
      } else if (row.session_id) {
        const own = (caller.session?.agentSessionId ?? caller.session?.id) === row.session_id;
        check(own, 'forbidden', 'Worker actors require their live session authority', 403);
        source = await this.sessions.provider().require(caller, sql as Transaction, permission);
        // A session that ended has retired its actor, and Sessions above said how it ended (its
        // handoff completed, say), the way the worker's next call will, whichever closed it first.
        check(row.active, 'session_closed', 'Session is closed', 401);
        // The source is the worker's delegator, another actor of the same project.
        vouched(source, false, 'forbidden', 'Session source does not match this project');
      } else if (caller.session) {
        check(false, 'forbidden', 'Session authority cannot select another actor', 403);
      } else if (row.user_issuer && caller.key !== undefined) {
        lifetime = await this.userKeys.authorize(caller, sql);
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
        // A reviewing service acts only as vouched for, above.
        check(
          row.active && !(row.service_owner && row.role === 'reviewer'),
          'forbidden',
          'Actor cannot access this project',
          403,
        );
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
        await this.ledger.live(bound.token_hash, 'actor', bound.id, sql);
        lifetime = bound.expires_at;
      }
      return { actor: actor(row), source, lifetime };
    };
    // A provider decides in a transaction. A worker's authority is checked several times per tool
    // call, so a read decision runs on a snapshot, which outside any scope takes no writer lock. A
    // managed runner only ever succeeds with 'read', so its refusal never waits for the lock either.
    const place = !provided ? undefined : caller.managed ? 'read' : permission;
    const decide = () => within(this.state, tx, lookup, place);
    // A direct caller's decision rests only on rows, so one snapshot makes it once. A provider's
    // also rests on that provider's own memory (a worker's invocation, say), so it never is.
    const value = provided
      ? await decide()
      : structuredClone(await this.state.remember(`scope:${JSON.stringify(caller)}`, decide));
    // An in-flight decision cannot survive provider removal, even if the same object
    // is installed again before it returns. The caller must make a fresh request.
    if (value.actor.sessionId) this.sessions.fence(registration);
    if (caller.managed) this.managed.fence(managedRegistration);
    if (caller.conversation) this.conversations.fence(conversationRegistration);
    const allowed = permits(value.actor.role, permission);
    check(allowed, 'forbidden', `Actor lacks ${permission} permission`, 403);
    return value;
  }
  /** Internal eligibility lookup; inspecting an actor does not assume that actor's authority.
   *  With `{ except }`, whether any actor but those, and no worker session's, is eligible. */
  async eligible(
    projectId: string,
    actor: string | { except: readonly string[] },
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean> {
    const ids = typeof actor === 'string' ? [actor] : ['', ...actor.except];
    const roles = (['operator', ...workerRoles] as const).filter((role) =>
      permits(role, permission),
    );
    const lookup = async (sql: Sql) =>
      await sql.get(
        `SELECT 1 FROM actors a LEFT JOIN member_actors m ON m.actor_id=a.id
         WHERE ${typeof actor === 'string' ? 'a.id IN' : 'a.session_id IS NULL AND a.id NOT IN'} (${ids.map(() => '?').join(',')})
         AND a.project_id=? AND a.active=1 AND a.role IN (${roles.map(() => '?').join(',')}) AND (m.actor_id IS NULL OR EXISTS(
           SELECT 1 FROM project_memberships p WHERE p.actor_id=a.id AND p.project_id=a.project_id
           AND p.issuer=m.issuer AND p.subject=m.subject AND p.role=a.role AND p.active=1)) LIMIT 1`,
        ...ids,
        projectId,
        ...roles,
      );
    return !!(await within(this.state, tx, lookup));
  }
  async project(caller: Caller, tx?: Transaction): Promise<Project> {
    caller = structuredClone(caller);
    await this.require(caller, 'read', tx);
    return await within(this.state, tx, async (sql) =>
      project((await sql.get<ProjectRow>('SELECT * FROM projects WHERE id=?', caller.projectId))!),
    );
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
      // Decided before the receipt lookup, so a replay needs no second decision, and again after
      // a fresh write (the receipt's `after`), on the same transaction.
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
          const changed =
            input.expectedContextRevision === undefined
              ? await tx.run(
                  'UPDATE projects SET summary=?,context_revision=context_revision+1 WHERE id=? AND summary=? AND context_revision<9007199254740991',
                  input.summary,
                  caller.projectId,
                  input.expectedSummary!,
                )
              : await tx.run(
                  'UPDATE projects SET summary=?,context_revision=context_revision+1 WHERE id=? AND context_revision=? AND context_revision<9007199254740991',
                  input.summary,
                  caller.projectId,
                  input.expectedContextRevision,
                );
          check(
            changed.changes === 1,
            'project_context_conflict',
            'Project Introduction changed; reread project.get before retrying with its current contextRevision or exact summary',
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
        },
      );
    });
  }
  async issueActor(caller: Caller, input: { name: string; role: Role; expiresAt?: string | null }) {
    return await this.credentials.issueActor(caller, input);
  }
  async actorCredentials(caller: Caller, actorId?: string): Promise<ActorCredential[]> {
    return await this.credentials.actorCredentials(caller, actorId);
  }
  async issueActorCredential(
    caller: Caller,
    input: { actorId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential> {
    return await this.credentials.issueActorCredential(caller, input);
  }
  async rotateCredential(
    caller: Caller,
    input: { credentialId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential> {
    return await this.credentials.rotateCredential(caller, input);
  }
  async revokeCredential(caller: Caller, credentialId: string): Promise<void> {
    await this.credentials.revokeCredential(caller, credentialId);
  }
  async actors(caller: Caller) {
    caller = structuredClone(caller);
    await this.require(caller, 'admin');
    return await this.state.read(async (sql) =>
      (
        await sql.all<ActorRow>(
          `${ACTOR_WITH_MEMBER} WHERE a.project_id=? ORDER BY a.active DESC,a.role,a.name,a.id`,
          caller.projectId,
        )
      ).map(actor),
    );
  }
  async revokeActor(caller: Caller, actorId: string): Promise<void> {
    await this.credentials.revokeActor(caller, actorId);
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
