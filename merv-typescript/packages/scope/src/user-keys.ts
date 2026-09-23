import { expiry } from './expiry.js';
import { postgresMigrations } from './user-keys.postgres.js';
import { randomBytes } from 'node:crypto';
import {
  visible,
  check,
  newId,
  sha256Hex,
  type Actor,
  type Caller,
  type IssuedUserKey,
  type Migration,
  type Permission,
  type Principal,
  type Project,
  type Sql,
  type State,
  type Transaction,
  type UserKey,
} from '@merv/contracts';
import type { Memberships } from './memberships.js';
import { projectValue, type ProjectRow } from './project-context.js';

export const userKeyMigration: Migration = {
  version: 4,
  sql: postgresMigrations[4],
};

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
const validToken = (token: unknown): token is string =>
  typeof token === 'string' && /^mk_[A-Za-z0-9_-]{43}$/.test(token);

/** User-owned machine credentials delegate live memberships, never an independent actor role. */
export class UserKeys {
  constructor(
    private readonly state: State,
    private readonly time: () => string,
    private readonly members: Memberships,
    private readonly require: (
      caller: Caller,
      permission: Permission,
      tx: Transaction,
    ) => Promise<Actor>,
  ) {}

  async authenticate(token: string): Promise<UserKey> {
    check(validToken(token), 'unauthorized', 'Invalid user key', 401);
    return await this.state.read(async (sql) => {
      const row = await sql.get<KeyRow>(
        'SELECT * FROM user_keys WHERE token_hash=?',
        sha256Hex(token),
      );
      this.live(row, 401);
      return hydrate(row);
    });
  }

  async recognizes(token: string): Promise<boolean> {
    if (!validToken(token)) return false;
    return await this.state.read(
      async (sql) =>
        !!(await sql.get('SELECT id FROM user_keys WHERE token_hash=?', sha256Hex(token))),
    );
  }

  private live(row: KeyRow | undefined, status: number): asserts row is KeyRow {
    check(
      row && row.revoked_at === null && (row.expires_at === null || row.expires_at > this.time()),
      status === 401 ? 'unauthorized' : 'forbidden',
      'User key is invalid, expired or revoked',
      status,
    );
  }

  private async current(sql: Sql, id: string): Promise<KeyRow> {
    check(
      typeof id === 'string' && id.length > 0,
      'forbidden',
      'User key identity is required',
      403,
    );
    const row = await sql.get<KeyRow>('SELECT * FROM user_keys WHERE id=?', id);
    this.live(row, 403);
    return row;
  }

  async authorize(caller: Caller, sql: Sql): Promise<void> {
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
  }

  async caller(
    principal: Extract<Principal, { kind: 'key' }>,
    projectId?: string,
  ): Promise<Caller> {
    return await this.state.transaction(async (tx) => {
      // Principal metadata is descriptive. Authority always comes from the current stored key.
      const key = await this.current(tx, principal.key?.id);
      const selected =
        projectId === undefined && key.grant_scope === 'project' ? key.project_id : projectId;
      check(
        typeof selected === 'string' && selected.length > 0,
        'project_required',
        'Account keys require an explicit project selection',
      );
      check(
        key.grant_scope === 'account' || key.project_id === selected,
        'forbidden',
        'User key does not grant this project',
        403,
      );
      const member = await tx.get<{ id: string; actor_id: string }>(
        'SELECT id,actor_id FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
        selected,
        key.issuer,
        key.subject,
      );
      check(member, 'membership_required', 'Key owner is not a member of this project', 403);
      const caller: Caller = {
        actorId: member.actor_id,
        projectId: selected,
        key: { id: key.id, membershipId: member.id },
      };
      await this.require(caller, 'read', tx);
      return caller;
    });
  }

  async projects(principal: Extract<Principal, { kind: 'key' }>): Promise<Project[]> {
    return await this.state.transaction(async (tx) => {
      const key = await this.current(tx, principal.key?.id);
      return (
        await tx.all<ProjectRow>(
          `SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id=p.id
         JOIN actors a ON a.id=m.actor_id AND a.project_id=m.project_id AND a.role=m.role
         WHERE m.issuer=? AND m.subject=? AND m.active=1 AND a.active=1
           AND (?='account' OR p.id=?) ORDER BY m.created_at,p.id`,
          key.issuer,
          key.subject,
          key.grant_scope,
          key.project_id,
        )
      ).map(projectValue);
    });
  }

  async keys(principal: Principal, projectId?: string): Promise<UserKey[]> {
    check(
      projectId === undefined || (typeof projectId === 'string' && projectId.length > 0),
      'invalid_project',
      'Project filter must be a nonempty identifier',
    );
    return await this.state.transaction(async (tx) => {
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
    const token = `mk_${randomBytes(32).toString('base64url')}`;
    const key: UserKey = { ...input, id: newId('key'), createdAt: time, revokedAt: null };
    await tx.run(
      'INSERT INTO user_keys(id,issuer,subject,project_id,grant_scope,label,token_hash,created_at,expires_at,previous_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      key.id,
      key.owner.issuer,
      key.owner.subject,
      key.projectId,
      key.grantScope,
      key.label,
      sha256Hex(token),
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

  private async ownerActor(tx: Sql, key: KeyRow): Promise<string> {
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
      let authorizationProject = previous.project_id;
      if (previous.grant_scope === 'account') {
        const membership = await tx.get<{ project_id: string }>(
          `SELECT m.project_id FROM project_memberships m JOIN actors a ON a.id=m.actor_id
           AND a.project_id=m.project_id AND a.role=m.role AND a.active=1
           WHERE m.issuer=? AND m.subject=? AND m.active=1 ORDER BY m.created_at,m.project_id LIMIT 1`,
          previous.issuer,
          previous.subject,
        );
        check(
          membership,
          'membership_required',
          'Account key rotation requires an active membership',
          403,
        );
        authorizationProject = membership.project_id;
      }
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
    await this.state.transaction(async (tx) => {
      const selected = await this.owned(tx, principal, keyId);
      const descendants = await tx.all<KeyRow>(
        `WITH RECURSIVE lineage(id) AS (
          SELECT id FROM user_keys WHERE id=? UNION ALL
          SELECT k.id FROM user_keys k JOIN lineage p ON k.previous_id=p.id
        ) SELECT k.* FROM user_keys k JOIN lineage l ON l.id=k.id WHERE k.revoked_at IS NULL`,
        selected.id,
      );
      if (!descendants.length) return;
      const ownerActorId = await this.ownerActor(tx, selected);
      const time = this.time();
      for (const key of descendants) {
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
    });
  }
}
