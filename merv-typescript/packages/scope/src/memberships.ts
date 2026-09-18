import { visible, mapAsync } from '@merv/contracts';
import { postgresMigrations } from './memberships.postgres.js';
import {
  check,
  digest,
  newId,
  type Actor,
  type Caller,
  type HumanPrincipal,
  type Migration,
  type Permission,
  type Principal,
  type Project,
  type ProjectMembership,
  type Role,
  type SharedUser,
  type Sql,
  type State,
  type Transaction,
  type VerifiedIdentity,
} from '@merv/contracts';
import { projectValue, type ProjectRow } from './project-context.js';

export const membershipMigration: Migration = {
  version: 3,
  postgres: postgresMigrations[3],
  sql: `
    CREATE TABLE shared_users (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(issuer,subject)
    );
    CREATE TABLE member_actors (
      project_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      actor_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(project_id,issuer,subject),
      FOREIGN KEY(actor_id,project_id) REFERENCES actors(id,project_id)
    );
    CREATE TABLE project_memberships (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      actor_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('operator','producer','reviewer','reader')),
      active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, revoked_at TEXT,
      FOREIGN KEY(project_id,issuer,subject) REFERENCES member_actors(project_id,issuer,subject),
      FOREIGN KEY(actor_id,project_id) REFERENCES actors(id,project_id),
      CHECK((active=1 AND revoked_at IS NULL) OR (active=0 AND revoked_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX project_membership_active ON project_memberships(project_id,issuer,subject) WHERE active=1;
    CREATE UNIQUE INDEX project_membership_actor_active ON project_memberships(actor_id) WHERE active=1;
    CREATE INDEX project_membership_user ON project_memberships(issuer,subject,project_id);
    CREATE TABLE user_project_requests (
      issuer TEXT NOT NULL, subject TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      PRIMARY KEY(issuer,subject,request_id),
      FOREIGN KEY(issuer,subject) REFERENCES shared_users(issuer,subject)
    );
    CREATE TRIGGER shared_users_no_update BEFORE UPDATE ON shared_users
      BEGIN SELECT RAISE(ABORT,'Verified user identity is immutable'); END;
    CREATE TRIGGER shared_users_no_delete BEFORE DELETE ON shared_users
      BEGIN SELECT RAISE(ABORT,'Verified user identity is retained'); END;
    CREATE TRIGGER member_actors_no_update BEFORE UPDATE ON member_actors
      BEGIN SELECT RAISE(ABORT,'Member attribution is immutable'); END;
    CREATE TRIGGER member_actors_no_delete BEFORE DELETE ON member_actors
      BEGIN SELECT RAISE(ABORT,'Member attribution is retained'); END;
    CREATE TRIGGER project_memberships_no_delete BEFORE DELETE ON project_memberships
      BEGIN SELECT RAISE(ABORT,'Membership history is retained'); END;
    CREATE TRIGGER project_memberships_immutable BEFORE UPDATE ON project_memberships
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR
        NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR
        NEW.actor_id IS NOT OLD.actor_id OR NEW.role IS NOT OLD.role OR
        NEW.created_at IS NOT OLD.created_at OR OLD.active<>1 OR NEW.active<>0 OR
        OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
      BEGIN SELECT RAISE(ABORT,'Membership epochs only allow removal'); END;
  `,
};

interface MembershipRow {
  id: string;
  project_id: string;
  issuer: string;
  subject: string;
  actor_id: string;
  role: Role;
  active: number;
  created_at: string;
  revoked_at: string | null;
}
const membership = (row: MembershipRow): ProjectMembership => ({
  id: row.id,
  projectId: row.project_id,
  issuer: row.issuer,
  subject: row.subject,
  actorId: row.actor_id,
  role: row.role,
  active: !!row.active,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});
const roles: Role[] = ['operator', 'producer', 'reviewer', 'reader'];
const identityPart = (value: unknown, limit: number): boolean =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  value.trim() === value &&
  !value.includes('\0');

export function identityValid(identity: VerifiedIdentity, time: string): boolean {
  return (
    !!identity &&
    identityPart(identity.issuer, 2048) &&
    identityPart(identity.subject, 512) &&
    typeof identity.expiresAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(identity.expiresAt) &&
    Number.isFinite(Date.parse(identity.expiresAt)) &&
    new Date(identity.expiresAt).toISOString() === identity.expiresAt &&
    identity.expiresAt > time
  );
}

/** Synchronous membership storage, owned by Scope. Identity verification stays outside this layer. */
export class Memberships {
  constructor(
    private readonly state: State,
    private readonly time: () => string,
    private readonly require: (
      caller: Caller,
      permission: Permission,
      tx: Transaction,
    ) => Promise<Actor>,
  ) {}

  async acceptVerifiedIdentity(identity: VerifiedIdentity): Promise<HumanPrincipal> {
    const time = this.time();
    check(
      identityValid(identity, time),
      'unauthorized',
      'Verified identity is invalid or expired',
      401,
    );
    const existing = await this.state.read(
      async (sql) =>
        await sql.get<{ created_at: string }>(
          'SELECT created_at FROM shared_users WHERE issuer=? AND subject=?',
          identity.issuer,
          identity.subject,
        ),
    );
    if (existing)
      return {
        kind: 'user',
        user: {
          issuer: identity.issuer,
          subject: identity.subject,
          createdAt: existing.created_at,
        },
        expiresAt: identity.expiresAt,
      };
    return await this.state.transaction(async (tx) => {
      const insertedAt = this.time();
      check(
        identityValid(identity, insertedAt),
        'unauthorized',
        'Verified identity is invalid or expired',
        401,
      );
      await tx.run(
        'INSERT INTO shared_users(issuer,subject,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        identity.issuer,
        identity.subject,
        insertedAt,
      );
      return {
        kind: 'user',
        user: await this.user(tx, identity.issuer, identity.subject),
        expiresAt: identity.expiresAt,
      };
    });
  }

  private async user(sql: Sql, issuer: string, subject: string): Promise<SharedUser> {
    const row = await sql.get<{ issuer: string; subject: string; created_at: string }>(
      'SELECT * FROM shared_users WHERE issuer=? AND subject=?',
      issuer,
      subject,
    );
    check(row, 'unauthorized', 'Identity has not been verified', 401);
    return { issuer: row.issuer, subject: row.subject, createdAt: row.created_at };
  }

  async human(principal: Principal, tx: Transaction): Promise<HumanPrincipal> {
    check(
      principal?.kind === 'user',
      'forbidden',
      'This operation requires a verified human user',
      403,
    );
    check(
      principal.user &&
        identityValid({ ...principal.user, expiresAt: principal.expiresAt }, this.time()),
      'unauthorized',
      'Verified identity is invalid or expired',
      401,
    );
    return {
      kind: 'user',
      user: await this.user(tx, principal.user.issuer, principal.user.subject),
      expiresAt: principal.expiresAt,
    };
  }

  async resolve(
    principal: Principal,
    projectId: string | undefined,
    tx: Transaction,
  ): Promise<Caller> {
    if (principal?.kind === 'actor') {
      check(
        projectId === undefined || projectId === principal.actor.projectId,
        'forbidden',
        'Actor credentials are bound to their original project',
        403,
      );
      const caller: Caller = {
        actorId: principal.actor.id,
        projectId: principal.actor.projectId,
        credentialId: principal.actor.credential.id,
      };
      await this.require(caller, 'read', tx);
      return caller;
    }
    const human = await this.human(principal, tx);
    check(
      typeof projectId === 'string' && projectId.length > 0,
      'project_required',
      'Select a project for this human user',
    );
    const row = await tx.get<MembershipRow>(
      'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
      projectId,
      human.user.issuer,
      human.user.subject,
    );
    check(
      row,
      'membership_required',
      'An active membership in the selected project is required',
      403,
    );
    const caller: Caller = {
      actorId: row.actor_id,
      projectId,
      human: {
        issuer: human.user.issuer,
        subject: human.user.subject,
        expiresAt: human.expiresAt,
        membershipId: row.id,
      },
    };
    await this.require(caller, 'read', tx);
    return caller;
  }

  async caller(principal: Principal, projectId?: string): Promise<Caller> {
    return await this.state.transaction(async (tx) => await this.resolve(principal, projectId, tx));
  }

  private async project(tx: Sql, projectId: string): Promise<Project> {
    const row = await tx.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId);
    check(row, 'not_found', 'Project not found', 404);
    return projectValue(row);
  }

  async projects(principal: Principal): Promise<Project[]> {
    return await this.state.transaction(async (tx) => {
      if (principal?.kind === 'actor') {
        const caller = await this.resolve(principal, undefined, tx);
        return [await this.project(tx, caller.projectId)];
      }
      const human = await this.human(principal, tx);
      return await mapAsync(
        await tx.all<{ project_id: string }>(
          `SELECT m.project_id FROM project_memberships m JOIN actors a ON a.id=m.actor_id
         AND a.project_id=m.project_id AND a.role=m.role
         WHERE m.issuer=? AND m.subject=? AND m.active=1 AND a.active=1 ORDER BY m.created_at,m.project_id`,
          human.user.issuer,
          human.user.subject,
        ),
        async (row) => await this.project(tx, row.project_id),
      );
    });
  }

  async createProject(
    principal: Principal,
    input: { name: string; requestId: string },
  ): Promise<Project> {
    check(
      typeof input.name === 'string' && visible(input.name) && input.name.length <= 200,
      'invalid_project',
      'Project needs a nonblank name of at most 200 characters',
    );
    check(
      typeof input.requestId === 'string' &&
        visible(input.requestId) &&
        input.requestId.length <= 256,
      'invalid_request',
      'A request id of 1–256 characters is required',
    );
    const name = input.name.trim();
    const fingerprint = digest({ name });
    return await this.state.transaction(async (tx) => {
      const human = await this.human(principal, tx);
      const old = await tx.get<{ fingerprint: string; project_id: string }>(
        'SELECT * FROM user_project_requests WHERE issuer=? AND subject=? AND request_id=?',
        human.user.issuer,
        human.user.subject,
        input.requestId,
      );
      if (old) {
        check(
          old.fingerprint === fingerprint,
          'request_conflict',
          'Request id already created a different project',
          409,
        );
        await this.resolve(human, old.project_id, tx);
        return await this.project(tx, old.project_id);
      }
      const value: Project = {
        id: newId('project'),
        name,
        createdAt: this.time(),
        summary: '',
        contextRevision: 0,
      };
      await tx.run(
        'INSERT INTO projects(id,name,created_at) VALUES(?,?,?)',
        value.id,
        name,
        value.createdAt,
      );
      const initial = await this.activate(
        tx,
        value.id,
        human.user.issuer,
        human.user.subject,
        'operator',
      );
      await tx.run(
        'INSERT INTO user_project_requests(issuer,subject,request_id,fingerprint,project_id) VALUES(?,?,?,?,?)',
        human.user.issuer,
        human.user.subject,
        input.requestId,
        fingerprint,
        value.id,
      );
      await this.state.appendEvent(tx, {
        projectId: value.id,
        actorId: initial.actorId,
        type: 'project.created',
        subjectId: value.id,
        data: { name },
      });
      return value;
    });
  }

  async memberships(principal: Principal, projectId: string): Promise<ProjectMembership[]> {
    return await this.state.transaction(async (tx) => {
      await this.human(principal, tx);
      await this.resolve(principal, projectId, tx);
      return (
        await tx.all<MembershipRow>(
          tx.dialect === 'postgres'
            ? 'SELECT * FROM project_memberships WHERE project_id=? ORDER BY _merv_rowid'
            : 'SELECT * FROM project_memberships WHERE project_id=? ORDER BY rowid',
          projectId,
        )
      ).map(membership);
    });
  }

  private async operator(
    principal: Principal,
    projectId: string,
    tx: Transaction,
  ): Promise<Caller> {
    await this.human(principal, tx);
    const caller = await this.resolve(principal, projectId, tx);
    await this.require(caller, 'admin', tx);
    return caller;
  }

  private input(subject: string): void {
    check(identityPart(subject, 512), 'invalid_subject', 'Member subject is required');
  }

  private async activate(
    tx: Transaction,
    projectId: string,
    issuer: string,
    subject: string,
    role: Role,
  ): Promise<ProjectMembership> {
    let mapping = await tx.get<{ actor_id: string }>(
      'SELECT actor_id FROM member_actors WHERE project_id=? AND issuer=? AND subject=?',
      projectId,
      issuer,
      subject,
    );
    if (!mapping) {
      mapping = { actor_id: newId('actor') };
      await tx.run(
        'INSERT INTO actors(id,project_id,name,role,active) VALUES(?,?,?,?,1)',
        mapping.actor_id,
        projectId,
        subject.slice(0, 200),
        role,
      );
      await tx.run(
        'INSERT INTO member_actors(project_id,issuer,subject,actor_id) VALUES(?,?,?,?)',
        projectId,
        issuer,
        subject,
        mapping.actor_id,
      );
    } else
      await tx.run(
        'UPDATE actors SET active=1,role=? WHERE id=? AND project_id=?',
        role,
        mapping.actor_id,
        projectId,
      );
    const value: ProjectMembership = {
      id: newId('membership'),
      projectId,
      issuer,
      subject,
      actorId: mapping.actor_id,
      role,
      active: true,
      createdAt: this.time(),
      revokedAt: null,
    };
    await tx.run(
      'INSERT INTO project_memberships(id,project_id,issuer,subject,actor_id,role,active,created_at) VALUES(?,?,?,?,?,?,1,?)',
      value.id,
      projectId,
      issuer,
      subject,
      value.actorId,
      role,
      value.createdAt,
    );
    return value;
  }

  async addMember(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership> {
    this.input(input.subject);
    check(roles.includes(input.role), 'invalid_role', 'Unknown member role');
    return await this.state.transaction(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const issuer = caller.human!.issuer;
      const old = await tx.get<MembershipRow>(
        'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
        projectId,
        issuer,
        input.subject,
      );
      if (old) {
        check(
          old.role === input.role,
          'membership_exists',
          'Use changeMemberRole for an existing member',
          409,
        );
        return membership(old);
      }
      const value = await this.activate(tx, projectId, issuer, input.subject, input.role);
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'actor.membership_added',
        subjectId: value.actorId,
        data: { membershipId: value.id, issuer, subject: input.subject, role: input.role },
      });
      return value;
    });
  }

  private async active(
    tx: Sql,
    projectId: string,
    issuer: string,
    subject: string,
  ): Promise<MembershipRow> {
    const row = await tx.get<MembershipRow>(
      'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
      projectId,
      issuer,
      subject,
    );
    check(row, 'not_found', 'Active project member not found', 404);
    return row;
  }

  private async keepOperator(tx: Sql, previous: MembershipRow, nextRole?: Role): Promise<void> {
    if (previous.role !== 'operator' || nextRole === 'operator') return;
    const count = (await tx.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM project_memberships m JOIN actors a ON a.id=m.actor_id AND a.project_id=m.project_id
       JOIN shared_users u ON u.issuer=m.issuer AND u.subject=m.subject
       WHERE m.project_id=? AND m.actor_id<>? AND m.active=1 AND m.role='operator' AND a.active=1 AND a.role='operator'`,
      previous.project_id,
      previous.actor_id,
    ))!.count;
    check(
      count >= 1,
      'last_operator',
      'The final verified human operator cannot be removed or demoted',
      409,
    );
  }

  async changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership> {
    this.input(input.subject);
    check(roles.includes(input.role), 'invalid_role', 'Unknown member role');
    return await this.state.transaction(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const previous = await this.active(tx, projectId, caller.human!.issuer, input.subject);
      if (previous.role === input.role) return membership(previous);
      await this.keepOperator(tx, previous, input.role);
      await tx.run(
        'UPDATE project_memberships SET active=0,revoked_at=? WHERE id=?',
        this.time(),
        previous.id,
      );
      const next = await this.activate(
        tx,
        projectId,
        previous.issuer,
        previous.subject,
        input.role,
      );
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'actor.permissions_changed',
        subjectId: next.actorId,
        data: {
          beforeRole: previous.role,
          role: next.role,
          previousMembershipId: previous.id,
          membershipId: next.id,
        },
      });
      return next;
    });
  }

  async removeMember(principal: Principal, projectId: string, subject: string): Promise<void> {
    this.input(subject);
    await this.state.transaction(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const previous = await tx.get<MembershipRow>(
        tx.dialect === 'postgres'
          ? 'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? ORDER BY active DESC,_merv_rowid DESC LIMIT 1'
          : 'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? ORDER BY active DESC,rowid DESC LIMIT 1',
        projectId,
        caller.human!.issuer,
        subject,
      );
      if (!previous?.active) return;
      await this.keepOperator(tx, previous);
      await tx.run(
        'UPDATE project_memberships SET active=0,revoked_at=? WHERE id=?',
        this.time(),
        previous.id,
      );
      await tx.run(
        'UPDATE actors SET active=0 WHERE id=? AND project_id=?',
        previous.actor_id,
        projectId,
      );
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'actor.revoked',
        subjectId: previous.actor_id,
        data: { membershipId: previous.id, issuer: previous.issuer, subject: previous.subject },
      });
    });
  }

  async adoptProject(
    principal: HumanPrincipal,
    projectId: string,
    options?: { repairReason: string },
  ): Promise<ProjectMembership> {
    if (options !== undefined)
      check(
        options &&
          typeof options.repairReason === 'string' &&
          visible(options.repairReason) &&
          options.repairReason.length <= 2000,
        'invalid_repair_reason',
        'Local ownership repair requires a reason of 1–2000 characters',
      );
    return await this.state.transaction(async (tx) => {
      const human = await this.human(principal, tx);
      await this.project(tx, projectId);
      if (options !== undefined) {
        const previous = await tx.get<MembershipRow>(
          tx.dialect === 'postgres'
            ? 'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? ORDER BY active DESC,_merv_rowid DESC LIMIT 1'
            : 'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? ORDER BY active DESC,rowid DESC LIMIT 1',
          projectId,
          human.user.issuer,
          human.user.subject,
        );
        let value: ProjectMembership;
        if (previous?.active && previous.role === 'operator') value = membership(previous);
        else {
          if (previous?.active)
            await tx.run(
              'UPDATE project_memberships SET active=0,revoked_at=? WHERE id=?',
              this.time(),
              previous.id,
            );
          value = await this.activate(
            tx,
            projectId,
            human.user.issuer,
            human.user.subject,
            'operator',
          );
          if (previous?.active)
            await this.state.appendEvent(tx, {
              projectId,
              actorId: value.actorId,
              type: 'actor.permissions_changed',
              subjectId: value.actorId,
              data: {
                beforeRole: previous.role,
                role: value.role,
                previousMembershipId: previous.id,
                membershipId: value.id,
              },
            });
        }
        await this.state.appendEvent(tx, {
          projectId,
          actorId: value.actorId,
          type: 'membership.repaired',
          subjectId: value.actorId,
          data: {
            reason: options.repairReason.trim(),
            issuer: value.issuer,
            subject: value.subject,
            membershipId: value.id,
            previousMembershipId: previous?.id ?? null,
            previousRole: previous?.role ?? null,
            previousActive: previous ? !!previous.active : null,
          },
        });
        return value;
      }
      check(
        !(await tx.get('SELECT id FROM project_memberships WHERE project_id=? LIMIT 1', projectId)),
        'project_already_adopted',
        'Only projects without membership history may be adopted',
        409,
      );
      const value = await this.activate(
        tx,
        projectId,
        human.user.issuer,
        human.user.subject,
        'operator',
      );
      await this.state.appendEvent(tx, {
        projectId,
        actorId: value.actorId,
        type: 'actor.membership_added',
        subjectId: value.actorId,
        data: {
          membershipId: value.id,
          issuer: value.issuer,
          subject: value.subject,
          role: value.role,
          adopted: true,
        },
      });
      return value;
    });
  }
}
