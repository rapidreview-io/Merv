import { expiry } from './expiry.js';
import {
  visible,
  check,
  forRead,
  newId,
  type Actor,
  type Caller,
  type IssuedUserKey,
  type Permission,
  type Principal,
  type Project,
  type Sql,
  type State,
  type Transaction,
  type UserKey,
} from '@merv/contracts';
import type { Ledger } from './ledger.js';
import type { Memberships } from './memberships.js';

interface KeyRow {
  id: string;
  issuer: string;
  subject: string;
  project_id: string;
  grant_scope: UserKey['grantScope'];
  label: string | null;
  token_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  previous_id: string | null;
}
const hydrate = (row: KeyRow): UserKey => ({
  id: row.id,
  owner: { issuer: row.issuer, subject: row.subject },
  projectId: row.project_id,
  grantScope: row.grant_scope,
  label: row.label,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  previousId: row.previous_id,
});

/** User-owned machine credentials delegate live memberships, never an independent actor role. */
export class UserKeys {
  constructor(
    private readonly state: State,
    private readonly ledger: Ledger,
    private readonly time: () => string,
    private readonly members: Memberships,
    private readonly require: (
      caller: Caller,
      permission: Permission,
      tx: Transaction,
    ) => Promise<Actor>,
  ) {}

  async authenticate(token: string): Promise<UserKey> {
    return await this.state.read(async (sql) => {
      const verified = await this.ledger.authenticate(token, 'user-key', sql);
      const row = await sql.get<KeyRow>(
        'SELECT * FROM user_keys WHERE id=? AND token_hash=?',
        verified.subject,
        verified.tokenHash,
      );
      check(row, 'unauthorized', 'User key is invalid, expired or revoked', 401);
      return hydrate(row);
    });
  }

  private async current(sql: Sql, id: string): Promise<KeyRow> {
    check(
      typeof id === 'string' && id.length > 0,
      'forbidden',
      'User key identity is required',
      403,
    );
    // Caller resolution and its read decision both ask, in one snapshot: one read serves them.
    const row = await this.state.remember(`scope:key:${id}`, () =>
      sql.get<KeyRow>('SELECT * FROM user_keys WHERE id=?', id),
    );
    const refusal = { code: 'forbidden', message: 'User key is invalid, expired or revoked' };
    check(row, refusal.code, refusal.message, 403);
    await this.ledger.live(row.token_hash, 'user-key', row.id, sql, { ...refusal, status: 403 });
    return row;
  }

  /** Checks a user key caller against its stored key and membership; returns the key's deadline. */
  async authorize(caller: Caller, sql: Sql): Promise<string | null> {
    check(
      caller.key &&
        typeof caller.key.membershipId === 'string' &&
        caller.key.membershipId.length > 0,
      'membership_required',
      'Current membership authority is required',
      403,
    );
    const key = await this.current(sql, caller.key.id);
    check(
      key.grant_scope === 'account' || key.project_id === caller.projectId,
      'forbidden',
      'User key does not grant this project',
      403,
    );
    check(
      await sql.get(
        `SELECT m.id FROM project_memberships m JOIN actors a ON a.id=m.actor_id
         AND a.project_id=m.project_id AND a.role=m.role AND a.active=1
         JOIN member_actors u ON u.actor_id=m.actor_id AND u.project_id=m.project_id
         AND u.issuer=m.issuer AND u.subject=m.subject
         WHERE m.id=? AND m.actor_id=? AND m.project_id=? AND m.issuer=? AND m.subject=? AND m.active=1`,
        caller.key.membershipId,
        caller.actorId,
        caller.projectId,
        key.issuer,
        key.subject,
      ),
      'membership_required',
      'An active current membership belonging to the key owner is required',
      403,
    );
    return key.expires_at;
  }

  async caller(
    principal: Extract<Principal, { kind: 'key' }>,
    projectId?: string,
    decide = true,
  ): Promise<Caller> {
    return await forRead(this.state, async (tx) => {
      // Principal metadata is descriptive. Authority always comes from the current stored key.
      const key = await this.current(tx, principal.key?.id);
      const selected =
        projectId === undefined && key.grant_scope === 'project' ? key.project_id : projectId;
      check(
        typeof selected === 'string' && selected.length > 0,
        'project_required',
        'This key works across projects: pass projectId (call project.list to see them)',
      );
      check(
        key.grant_scope === 'account' || key.project_id === selected,
        'forbidden',
        'User key does not grant this project',
        403,
      );
      const member = await this.members.current(tx, selected, key.issuer, key.subject);
      check(member, 'membership_required', 'Key owner is not a member of this project', 403);
      const caller: Caller = {
        actorId: member.actor_id,
        projectId: selected,
        key: { id: key.id, membershipId: member.id },
      };
      if (decide) await this.require(caller, 'read', tx);
      return caller;
    });
  }

  async projects(principal: Extract<Principal, { kind: 'key' }>): Promise<Project[]> {
    return await forRead(this.state, async (tx) => {
      const key = await this.current(tx, principal.key?.id);
      const only = key.grant_scope === 'account' ? null : key.project_id;
      return await this.members.memberProjects(tx, key.issuer, key.subject, only);
    });
  }

  async keys(principal: Principal, projectId?: string): Promise<UserKey[]> {
    check(
      projectId === undefined || (typeof projectId === 'string' && projectId.length > 0),
      'invalid_project',
      'Project filter must be a nonempty identifier',
    );
    return await forRead(this.state, async (tx) => {
      const human = await this.members.human(principal, tx);
      return (
        await tx.all<KeyRow>(
          'SELECT * FROM user_keys WHERE issuer=? AND subject=? AND (CAST(? AS TEXT) IS NULL OR project_id=?) ORDER BY created_at,id',
          human.user.issuer,
          human.user.subject,
          projectId ?? null,
          projectId ?? null,
        )
      ).map(hydrate);
    });
  }

  private async issue(
    tx: Transaction,
    input: Omit<UserKey, 'id' | 'createdAt' | 'revokedAt'>,
    time: string,
  ): Promise<IssuedUserKey> {
    const key: UserKey = { ...input, id: newId('key'), createdAt: time, revokedAt: null };
    const { token, tokenHash } = await this.ledger.issue('user-key', key.id, key.expiresAt, tx);
    await tx.run(
      'INSERT INTO user_keys(id,issuer,subject,project_id,grant_scope,label,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      key.id,
      key.owner.issuer,
      key.owner.subject,
      key.projectId,
      key.grantScope,
      key.label,
      tokenHash,
      key.createdAt,
      key.expiresAt,
      key.previousId,
    );
    return { key, token };
  }

  async create(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<IssuedUserKey> {
    const { projectId, grantScope = 'project', label, expiresAt } = input;
    check(
      grantScope === 'project' || grantScope === 'account',
      'invalid_grant',
      'Unknown key grant',
    );
    check(
      label === undefined ||
        label === null ||
        (typeof label === 'string' && visible(label) && label.length <= 120),
      'invalid_label',
      'Key label must be nonblank text of 1–120 characters or null',
    );
    return await this.state.transaction(async (tx) => {
      const human = await this.members.human(principal, tx);
      const caller = await this.members.resolve(human, projectId, tx);
      const time = this.time();
      const issued = await this.issue(
        tx,
        {
          owner: { issuer: human.user.issuer, subject: human.user.subject },
          projectId: caller.projectId,
          grantScope,
          label: label?.trim() ?? null,
          expiresAt: expiry(expiresAt, time),
          previousId: null,
        },
        time,
      );
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'actor.key_created',
        subjectId: issued.key.id,
        data: { grantScope, label: issued.key.label, expiresAt: issued.key.expiresAt },
      });
      return issued;
    });
  }

  private async owned(tx: Transaction, principal: Principal, keyId: string): Promise<KeyRow> {
    const human = await this.members.human(principal, tx);
    check(typeof keyId === 'string' && keyId.length > 0, 'invalid_key', 'Key id is required');
    const row = await tx.get<KeyRow>(
      'SELECT * FROM user_keys WHERE id=? AND issuer=? AND subject=?',
      keyId,
      human.user.issuer,
      human.user.subject,
    );
    check(row, 'not_found', 'User key not found', 404);
    return row;
  }

  private async ownerActor(
    tx: Sql,
    key: Pick<KeyRow, 'project_id' | 'issuer' | 'subject'>,
  ): Promise<string> {
    const owner = await tx.get<{ actor_id: string }>(
      'SELECT actor_id FROM member_actors WHERE project_id=? AND issuer=? AND subject=?',
      key.project_id,
      key.issuer,
      key.subject,
    );
    check(owner, 'invalid_key_owner', 'Key issuance membership history is missing', 500);
    return owner.actor_id;
  }

  async rotate(
    principal: Principal,
    { ...input }: { keyId: string; expiresAt?: string | null },
  ): Promise<IssuedUserKey> {
    return await this.state.transaction(async (tx) => {
      const previous = await this.owned(tx, principal, input.keyId);
      check(
        previous.revoked_at === null,
        'key_revoked',
        'User key is already revoked or rotated',
        409,
      );
      // An account key is authorized through its owner's first active membership.
      const authorizationProject =
        previous.grant_scope === 'account'
          ? (await this.members.memberProjects(tx, previous.issuer, previous.subject, null))[0]?.id
          : previous.project_id;
      check(
        authorizationProject,
        'membership_required',
        'Account key rotation requires an active membership',
        403,
      );
      await this.members.resolve(principal, authorizationProject, tx);
      const time = this.time();
      const expiresAt = expiry(
        input.expiresAt === undefined ? previous.expires_at : input.expiresAt,
        time,
      );
      const changed = await tx.run(
        'UPDATE user_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
        time,
        previous.id,
      );
      check(changed.changes === 1, 'key_revoked', 'User key is already revoked or rotated', 409);
      // Only a revocation counts here, never expiry: renewing an expired key is intended.
      check(
        (await this.ledger.retire('user-key', previous, tx))?.revokedAt === null,
        'key_revoked',
        'User key was revoked in the credential ledger',
        409,
      );
      const issued = await this.issue(
        tx,
        { ...hydrate(previous), expiresAt, previousId: previous.id },
        time,
      );
      await this.state.appendEvent(tx, {
        projectId: previous.project_id,
        actorId: await this.ownerActor(tx, previous),
        type: 'actor.key_rotated',
        subjectId: issued.key.id,
        data: { previousId: previous.id, grantScope: issued.key.grantScope, expiresAt },
      });
      return issued;
    });
  }

  async revoke(principal: Principal, keyId: string): Promise<void> {
    await this.state.transaction(async (tx) =>
      this.revokeLineage(tx, await this.owned(tx, principal, keyId)),
    );
  }

  /**
   * The account key a consumed email-code challenge yields, in the transaction that consumes it.
   * The owner is the challenge's; no principal or tool reaches this. It replaces the key of the
   * same connector install, expires after a fixed `keyDays` and is never renewed.
   */
  async issueForEmailLogin(
    tx: Transaction,
    login: { issuer: string; subject: string; install_id: string; client: string; host: string },
    limits: { keyDays: number; keysPerPerson: number },
  ): Promise<IssuedUserKey> {
    const { issuer, subject } = login;
    // Authorized, as account-key rotation is, through the owner's first active membership.
    const anchor = (await this.members.memberProjects(tx, issuer, subject, null))[0];
    check(
      anchor,
      'membership_required',
      'Sign in to Merv on the web and join or create a project first',
      409,
    );
    const time = this.time();
    const agentKeys = `FROM agent_logins l JOIN user_keys k ON k.id=l.key_id
      WHERE l.issuer=? AND l.subject=? AND k.revoked_at IS NULL`;
    const live = await tx.get<{ count: string | number }>(
      `SELECT COUNT(*) AS count ${agentKeys} AND k.expires_at>? AND l.install_id<>?`,
      issuer,
      subject,
      time,
      login.install_id,
    );
    check(
      Number(live?.count ?? 0) < limits.keysPerPerson,
      'agent_key_limit',
      'Revoke an agent key on the Keys page first',
      409,
    );
    const label = `${login.client} on ${login.host}`;
    const expiresAt = new Date(Date.parse(time) + limits.keyDays * 86_400_000).toISOString();
    const issued = await this.issue(
      tx,
      {
        owner: { issuer, subject },
        projectId: anchor.id,
        grantScope: 'account',
        label,
        expiresAt,
        previousId: null,
      },
      time,
    );
    for (const earlier of await tx.all<KeyRow>(
      `SELECT k.* ${agentKeys} AND l.install_id=?`,
      issuer,
      subject,
      login.install_id,
    ))
      await this.revokeLineage(tx, earlier);
    await this.state.appendEvent(tx, {
      projectId: anchor.id,
      actorId: await this.ownerActor(tx, { project_id: anchor.id, issuer, subject }),
      type: 'actor.key_created',
      subjectId: issued.key.id,
      data: { grantScope: 'account', label, expiresAt, via: 'email_code' },
    });
    return issued;
  }

  /** Withdraws a key just issued whose sign-in could not be completed. */
  async revokeIssued(keyId: string): Promise<void> {
    await this.state.transaction(async (tx) => {
      const row = await tx.get<KeyRow>('SELECT * FROM user_keys WHERE id=?', keyId);
      check(row, 'not_found', 'User key not found', 404);
      await this.revokeLineage(tx, row);
    });
  }

  /** The presenting key revokes itself, with its lineage: it can name no other key. */
  async revokePresented(principal: Principal): Promise<void> {
    check(principal?.kind === 'key', 'forbidden', 'Only a key revokes itself here', 403);
    await this.state.transaction(async (tx) =>
      this.revokeLineage(tx, await this.current(tx, principal.key?.id)),
    );
  }

  /** Revokes `selected` and every rotation descending from it, in `tx`. */
  private async revokeLineage(tx: Transaction, selected: KeyRow): Promise<void> {
    const lineage = await tx.all<KeyRow>(
      `WITH RECURSIVE lineage(id) AS (
        SELECT id FROM user_keys WHERE id=? UNION ALL
        SELECT k.id FROM user_keys k JOIN lineage p ON k.previous_id=p.id
      ) SELECT k.* FROM user_keys k JOIN lineage l ON l.id=k.id`,
      selected.id,
    );
    const time = this.time();
    let ownerActorId: string | undefined;
    for (const key of lineage) {
      // The ledger decides liveness: a key Scope's row calls revoked is retired there too, and
      // only one revoked in both is left as it is.
      const before = await this.ledger.retire('user-key', key, tx);
      if (key.revoked_at !== null && before?.revokedAt !== null) continue;
      ownerActorId ??= await this.ownerActor(tx, selected);
      await tx.run(
        'UPDATE user_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
        time,
        key.id,
      );
      await this.state.appendEvent(tx, {
        projectId: key.project_id,
        actorId: ownerActorId,
        type: 'actor.key_revoked',
        subjectId: key.id,
        data: { rootKeyId: selected.id, revokedAt: time },
      });
    }
  }
}
