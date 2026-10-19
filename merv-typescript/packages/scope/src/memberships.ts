import { clip, quoted, visible } from '@merv/contracts';
import {
  check,
  digest,
  forRead,
  newId,
  ROLES,
  type Actor,
  type Caller,
  type HumanPrincipal,
  type Permission,
  type Principal,
  type Project,
  type ProjectAdmin,
  type ProjectMembership,
  type ProjectMembers,
  type ProjectInvitation,
  type Role,
  type SharedUser,
  type Sql,
  type State,
  type Transaction,
  type VerifiedIdentity,
} from '@merv/contracts';
import { insertProject, projectValue, type ProjectRow } from './project-context.js';

interface InvitationRow {
  id: string;
  project_id: string;
  project_name: string;
  issuer: string;
  subject: string;
  email: string;
  role: Role;
  inviter_membership_id: string;
  status: ProjectInvitation['status'];
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  membership_id: string | null;
}
const invitation = (r: InvitationRow, now: string): ProjectInvitation => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  issuer: r.issuer,
  subject: r.subject,
  email: r.email,
  role: r.role,
  status: r.status === 'pending' && r.expires_at <= now ? 'expired' : r.status,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  sentAt: r.sent_at,
});

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
const identityPart = (value: unknown, limit: number): boolean =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  value.trim() === value &&
  !value.includes('\0');

/** Active operator memberships whose actor agrees and whose person has signed in. */
export const LIVE_OPERATOR = `project_memberships m
  JOIN actors a ON a.id=m.actor_id AND a.project_id=m.project_id
  JOIN shared_users u ON u.issuer=m.issuer AND u.subject=m.subject
  WHERE m.active=1 AND m.role='operator' AND a.active=1 AND a.role='operator'`;

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

/** The caller an actor token is, which only ever selects its own project. */
function actorCaller(principal: Extract<Principal, { kind: 'actor' }>, projectId?: string): Caller {
  check(
    projectId === undefined || projectId === principal.actor.projectId,
    'forbidden',
    `Actor credentials are bound to their original project ${principal.actor.projectId}, not ${quoted(String(projectId), 100)}: omit projectId, or pass exactly that id`,
    403,
  );
  return {
    actorId: principal.actor.id,
    projectId: principal.actor.projectId,
    credentialId: principal.actor.credential.id,
  };
}

function checkIdentity(identity: VerifiedIdentity, time: string): void {
  check(
    identityValid(identity, time) && !identity.anonymous,
    'unauthorized',
    'Verified identity is invalid or expired',
    401,
  );
}

/** Project membership storage, owned by Scope: projects, their members and the actors members act
 * as. Verifying an identity stays outside this layer. */
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
  private readonly firstSignIns = new Set<(person: SharedUser) => void>();
  private readonly adminChanges = new Set<(projectId: string, admin: ProjectAdmin) => void>();
  /** Each open write's admin changes, heard once it commits. */
  private readonly admins = new WeakMap<Transaction, Map<string, ProjectAdmin>>();

  onFirstSignIn(listener: (person: SharedUser) => void): () => void {
    this.firstSignIns.add(listener);
    return () => void this.firstSignIns.delete(listener);
  }
  onAdminChanged(listener: (projectId: string, admin: ProjectAdmin) => void): () => void {
    this.adminChanges.add(listener);
    return () => void this.adminChanges.delete(listener);
  }

  /** A membership write; a listener hears its admin changes after it commits, and its own
   *  failure is its own. */
  private async write<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    let changed = new Map<string, ProjectAdmin>();
    const value = await this.state.transaction(async (tx) => {
      this.admins.set(tx, (changed = new Map()));
      return await work(tx);
    });
    for (const [projectId, admin] of changed)
      for (const hear of this.adminChanges)
        try {
          hear(projectId, admin);
        } catch {}
    return value;
  }

  private async assignAdmin(tx: Transaction, projectId: string, admin: ProjectAdmin) {
    await tx.run(
      'UPDATE projects SET admin_issuer=?,admin_subject=? WHERE id=?',
      admin.issuer,
      admin.subject,
      projectId,
    );
    this.admins.get(tx)!.set(projectId, { issuer: admin.issuer, subject: admin.subject });
  }

  /** The admin stays a live operator: one who is no longer one, or none yet, gives way to the
   *  longest-standing live operator. A project with none keeps what it had. */
  private async keepAdmin(tx: Transaction, projectId: string): Promise<void> {
    const next = await tx.get<ProjectAdmin & { kept: boolean }>(
      `SELECT m.issuer,m.subject,EXISTS(SELECT 1 FROM projects p WHERE p.id=m.project_id
         AND p.admin_issuer=m.issuer AND p.admin_subject=m.subject) AS kept
       FROM ${LIVE_OPERATOR} AND m.project_id=? ORDER BY kept DESC,m.created_at,m.id LIMIT 1`,
      projectId,
    );
    if (next && !next.kept) await this.assignAdmin(tx, projectId, next);
  }

  async setAdmin(principal: Principal, projectId: string, { ...admin }: ProjectAdmin) {
    this.input(admin.subject);
    return await this.write(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      check(
        await tx.get(
          `SELECT 1 FROM ${LIVE_OPERATOR} AND m.project_id=? AND m.issuer=? AND m.subject=?`,
          projectId,
          admin.issuer,
          admin.subject,
        ),
        'admin_not_operator',
        'The admin must be a signed-in operator of the project',
        409,
      );
      const before = await this.admin(tx, projectId);
      const same = (a: ProjectAdmin | null | undefined, b: ProjectAdmin | null | undefined) =>
        !!a && a.issuer === b?.issuer && a.subject === b.subject;
      if (same(before, admin)) return admin;
      // Billing is consented to: an operator takes it on, or the admin hands it to another.
      check(
        same(caller.human, admin) || same(caller.human, before),
        'admin_consent',
        'Only the admin can name another operator to bill; any operator can take billing on',
        403,
      );
      await this.assignAdmin(tx, projectId, admin);
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'project.admin_changed',
        subjectId: projectId,
        data: { ...admin, before },
      });
      return admin;
    });
  }

  private async admin(sql: Sql, projectId: string): Promise<ProjectAdmin | null> {
    return (
      (await sql.get<ProjectAdmin>(
        'SELECT admin_issuer AS issuer,admin_subject AS subject FROM projects WHERE id=? AND admin_issuer IS NOT NULL',
        projectId,
      )) ?? null
    );
  }

  async acceptVerifiedIdentity({ ...identity }: VerifiedIdentity): Promise<HumanPrincipal> {
    checkIdentity(identity, this.time());
    const existing = await this.state.read(
      async (sql) =>
        await sql.get<{ created_at: string }>(
          'SELECT created_at FROM shared_users WHERE issuer=? AND subject=?',
          identity.issuer,
          identity.subject,
        ),
    );
    checkIdentity(identity, this.time());
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
    let first = false;
    const principal = await this.state.transaction(async (tx): Promise<HumanPrincipal> => {
      const insertedAt = this.time();
      checkIdentity(identity, insertedAt);
      const inserted = await tx.run(
        'INSERT INTO shared_users(issuer,subject,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
        identity.issuer,
        identity.subject,
        insertedAt,
      );
      first = inserted.changes > 0;
      const user = await this.user(tx, identity.issuer, identity.subject);
      return { kind: 'user', user, expiresAt: identity.expiresAt };
    });
    // A listener's own failure is its own: the person has signed in.
    if (first)
      for (const hear of this.firstSignIns)
        try {
          hear(principal.user);
        } catch {}
    return principal;
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
    const identity = { ...principal.user, expiresAt: principal.expiresAt };
    checkIdentity(identity, this.time());
    const user = await this.user(tx, identity.issuer, identity.subject);
    checkIdentity(identity, this.time());
    return { kind: 'user', user, expiresAt: identity.expiresAt };
  }

  async resolve(
    principal: Principal,
    projectId: string | undefined,
    tx: Transaction,
    decide = true,
  ): Promise<Caller> {
    if (principal?.kind === 'actor') {
      const caller = actorCaller(principal, projectId);
      if (decide) await this.require(caller, 'read', tx);
      return caller;
    }
    const human = await this.human(principal, tx);
    check(
      typeof projectId === 'string' && projectId.length > 0,
      'project_required',
      'Select a project for this human user',
    );
    const row = await this.current(tx, projectId, human.user.issuer, human.user.subject);
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
    if (decide) await this.require(caller, 'read', tx);
    return caller;
  }

  async caller(principal: Principal, projectId?: string, decide = true): Promise<Caller> {
    // An actor token names its caller by itself: only a decision reads storage for it.
    if (principal?.kind === 'actor' && !decide) return actorCaller(principal, projectId);
    return await forRead(this.state, (tx) => this.resolve(principal, projectId, tx, decide));
  }

  private async project(tx: Sql, projectId: string): Promise<Project> {
    const row = await tx.get<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId);
    check(row, 'not_found', 'Project not found', 404);
    return projectValue(row);
  }

  async projects(principal: Principal): Promise<Project[]> {
    return await forRead(this.state, async (tx) => {
      if (principal?.kind === 'actor') {
        const caller = await this.resolve(principal, undefined, tx);
        return [await this.project(tx, caller.projectId)];
      }
      const { user } = await this.human(principal, tx);
      return await this.memberProjects(tx, user.issuer, user.subject, null);
    });
  }

  /** The projects where this person's membership and actor are active, `only` one if given. */
  async memberProjects(sql: Sql, issuer: string, subject: string, only: string | null) {
    return (
      await sql.all<ProjectRow>(
        `SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id=p.id
         JOIN actors a ON a.id=m.actor_id AND a.project_id=m.project_id AND a.role=m.role
         WHERE m.issuer=? AND m.subject=? AND m.active=1 AND a.active=1
           AND (CAST(? AS TEXT) IS NULL OR p.id=?) ORDER BY m.created_at,m.project_id`,
        issuer,
        subject,
        only,
        only,
      )
    ).map(projectValue);
  }

  async createProject(
    principal: Principal,
    { ...input }: { name: string; requestId: string },
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
    return await this.write(async (tx) => {
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
      const { id } = await insertProject(tx, name, this.time());
      const initial = await this.activate(tx, id, human.user, 'operator');
      await tx.run(
        'INSERT INTO user_project_requests(issuer,subject,request_id,fingerprint,project_id) VALUES(?,?,?,?,?)',
        human.user.issuer,
        human.user.subject,
        input.requestId,
        fingerprint,
        id,
      );
      await this.state.appendEvent(tx, {
        projectId: id,
        actorId: initial.actorId,
        type: 'project.created',
        subjectId: id,
        data: { name },
      });
      return await this.project(tx, id);
    });
  }

  async memberships(principal: Principal, projectId: string): Promise<ProjectMembers> {
    return await forRead(this.state, async (tx) => {
      await this.resolve(await this.human(principal, tx), projectId, tx);
      const rows = await tx.all<MembershipRow & { signed_in: boolean }>(
        `SELECT m.*,EXISTS(SELECT 1 FROM shared_users u WHERE u.issuer=m.issuer AND u.subject=m.subject)
           AS signed_in FROM project_memberships m WHERE m.project_id=? ORDER BY m._merv_rowid`,
        projectId,
      );
      return {
        memberships: rows.map((row) => ({ ...membership(row), signedIn: row.signed_in })),
        admin: await this.admin(tx, projectId),
      };
    });
  }

  private async operator(
    principal: Principal,
    projectId: string,
    tx: Transaction,
  ): Promise<Caller> {
    const caller = await this.resolve(await this.human(principal, tx), projectId, tx);
    await this.require(caller, 'admin', tx);
    return caller;
  }

  private input(subject: string): void {
    check(identityPart(subject, 512), 'invalid_subject', 'Member subject is required');
  }

  private async activate(
    tx: Transaction,
    projectId: string,
    { issuer, subject }: { issuer: string; subject: string },
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
        clip(subject, 200),
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
    await this.keepAdmin(tx, projectId);
    return value;
  }

  /** A pending invitation is never a membership or an actor. */
  async inviteMember(
    principal: Principal,
    projectId: string,
    input: {
      issuer: string;
      subject: string;
      email: string;
      role: Role;
    },
  ): Promise<ProjectInvitation> {
    const { issuer, subject, email, role } = { ...input };
    this.input(subject);
    check(ROLES.includes(role), 'invalid_role', 'Unknown member role');
    check(
      typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      'invalid_email',
      'A valid email is required',
    );
    return await this.state.transaction(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      check(
        issuer === caller.human!.issuer,
        'forbidden',
        'The recipient must use the same sign-in provider',
        403,
      );
      check(
        !(await tx.get(
          'SELECT id FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
          projectId,
          issuer,
          subject,
        )),
        'membership_exists',
        'This person is already a project member',
        409,
      );
      const now = this.time();
      await tx.run(
        "UPDATE project_invitations SET status='expired' WHERE project_id=? AND status='pending' AND expires_at<=?",
        projectId,
        now,
      );
      // An operator losing their membership/role also withdraws their outstanding offers.
      await tx.run(
        "UPDATE project_invitations SET status='revoked' WHERE project_id=? AND status='pending' AND inviter_membership_id NOT IN (SELECT id FROM project_memberships WHERE active=1 AND role='operator')",
        projectId,
      );
      const old = await tx.get<InvitationRow>(
        "SELECT * FROM project_invitations WHERE project_id=? AND issuer=? AND subject=? AND status='pending'",
        projectId,
        issuer,
        subject,
      );
      if (old) {
        check(
          old.role === role && old.email === email,
          'invitation_exists',
          'Revoke the pending invitation before changing its role or email',
          409,
        );
        return invitation(old, now);
      }
      const recent = await tx.get<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM project_invitations WHERE inviter_membership_id=? AND created_at>?',
        caller.human!.membershipId,
        new Date(Date.parse(now) - 3600_000).toISOString(),
      );
      check(
        (recent?.count ?? 0) < 30,
        'invitation_rate_limited',
        'Too many invitations; try again later',
        429,
      );
      const project = await this.project(tx, projectId);
      const row: InvitationRow = {
        id: newId('invite'),
        project_id: projectId,
        project_name: project.name,
        issuer,
        subject,
        email,
        role,
        inviter_membership_id: caller.human!.membershipId,
        status: 'pending',
        created_at: now,
        expires_at: new Date(Date.parse(now) + 7 * 86400_000).toISOString(),
        sent_at: null,
        membership_id: null,
      };
      await tx.run(
        'INSERT INTO project_invitations(id,project_id,project_name,issuer,subject,email,role,inviter_membership_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        row.id,
        projectId,
        project.name,
        issuer,
        subject,
        email,
        role,
        row.inviter_membership_id,
        row.status,
        now,
        row.expires_at,
      );
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'project.invitation_created',
        subjectId: row.id,
        data: { role },
      });
      return invitation(row, now);
    });
  }

  async invitations(principal: Principal, projectId?: string): Promise<ProjectInvitation[]> {
    return await forRead(this.state, async (tx) => {
      const human = await this.human(principal, tx);
      if (projectId !== undefined) await this.operator(human, projectId, tx);
      const rows =
        projectId === undefined
          ? await tx.all<InvitationRow>(
              "SELECT i.* FROM project_invitations i JOIN project_memberships m ON m.id=i.inviter_membership_id WHERE i.issuer=? AND i.subject=? AND i.status='pending' AND i.expires_at>? AND m.active=1 AND m.role='operator' ORDER BY i.created_at DESC",
              human.user.issuer,
              human.user.subject,
              this.time(),
            )
          : await tx.all<InvitationRow>(
              'SELECT * FROM project_invitations WHERE project_id=? ORDER BY created_at DESC LIMIT 200',
              projectId,
            );
      return rows.map((r) => invitation(r, this.time()));
    });
  }

  async respondToInvitation(
    principal: Principal,
    id: string,
    response: 'accept' | 'decline',
  ): Promise<ProjectMembership | null> {
    check(
      response === 'accept' || response === 'decline',
      'invalid_response',
      'Choose accept or decline',
    );
    return await this.write(async (tx) => {
      const human = await this.human(principal, tx);
      const row = await tx.get<InvitationRow>(
        'SELECT * FROM project_invitations WHERE id=? AND issuer=? AND subject=?',
        id,
        human.user.issuer,
        human.user.subject,
      );
      check(row, 'not_found', 'Invitation not found for this account', 404);
      if (row.status === 'declined' && response === 'decline') return null;
      if (row.status === 'accepted' && response === 'accept') {
        const previous = await tx.get<MembershipRow>(
          'SELECT * FROM project_memberships WHERE id=? AND active=1',
          row.membership_id,
        );
        check(previous, 'invitation_closed', 'This invitation has already been used', 409);
        return membership(previous);
      }
      check(
        row.status === 'pending' && row.expires_at > this.time(),
        'invitation_closed',
        'This invitation has expired or is no longer pending',
        409,
      );
      const author = await tx.get<MembershipRow>(
        "SELECT * FROM project_memberships WHERE id=? AND active=1 AND role='operator'",
        row.inviter_membership_id,
      );
      check(author, 'invitation_closed', 'The inviter no longer administers this project', 409);
      let value: ProjectMembership | null = null;
      if (response === 'accept') {
        const existing = await tx.get<MembershipRow>(
          'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
          row.project_id,
          row.issuer,
          row.subject,
        );
        value = existing
          ? membership(existing)
          : await this.activate(tx, row.project_id, row, row.role);
        if (!existing)
          await this.state.appendEvent(tx, {
            projectId: row.project_id,
            actorId: value.actorId,
            type: 'actor.membership_added',
            subjectId: value.actorId,
            data: {
              membershipId: value.id,
              issuer: row.issuer,
              subject: row.subject,
              role: row.role,
              invitationId: id,
            },
          });
      }
      await tx.run(
        'UPDATE project_invitations SET status=?,membership_id=? WHERE id=?',
        response === 'accept' ? 'accepted' : 'declined',
        value?.id ?? null,
        id,
      );
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: value?.actorId ?? author.actor_id,
        type: `project.invitation_${response === 'accept' ? 'accepted' : 'declined'}`,
        subjectId: id,
        data: { issuer: row.issuer, subject: row.subject },
      });
      return value;
    });
  }

  async revokeInvitation(principal: Principal, projectId: string, id: string): Promise<void> {
    await this.state.transaction(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const row = await tx.get<InvitationRow>(
        'SELECT * FROM project_invitations WHERE id=? AND project_id=?',
        id,
        projectId,
      );
      check(row, 'not_found', 'Invitation not found', 404);
      if (row.status !== 'pending') return;
      await tx.run("UPDATE project_invitations SET status='revoked' WHERE id=?", id);
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'project.invitation_revoked',
        subjectId: id,
        data: {},
      });
    });
  }

  async invitationSent(principal: Principal, projectId: string, id: string): Promise<void> {
    await this.state.transaction(async (tx) => {
      await this.operator(principal, projectId, tx);
      await tx.run(
        'UPDATE project_invitations SET sent_at=COALESCE(sent_at,?) WHERE id=? AND project_id=?',
        this.time(),
        id,
        projectId,
      );
    });
  }

  async addMember(
    principal: Principal,
    projectId: string,
    { subject, role }: { subject: string; role: Role },
  ): Promise<ProjectMembership> {
    this.input(subject);
    check(ROLES.includes(role), 'invalid_role', 'Unknown member role');
    return await this.write(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const issuer = caller.human!.issuer;
      const old = await this.current(tx, projectId, issuer, subject);
      if (old) {
        check(
          old.role === role,
          'membership_exists',
          'Use changeMemberRole for an existing member',
          409,
        );
        return membership(old);
      }
      const value = await this.activate(tx, projectId, { issuer, subject }, role);
      await this.state.appendEvent(tx, {
        projectId,
        actorId: caller.actorId,
        type: 'actor.membership_added',
        subjectId: value.actorId,
        data: { membershipId: value.id, issuer, subject, role },
      });
      return value;
    });
  }

  /** The person's active membership in this project, if any. */
  async current(sql: Sql, projectId: string, issuer: string, subject: string) {
    return await sql.get<MembershipRow>(
      'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? AND active=1',
      projectId,
      issuer,
      subject,
    );
  }

  private async keepOperator(tx: Sql, previous: MembershipRow, nextRole?: Role): Promise<void> {
    if (previous.role !== 'operator' || nextRole === 'operator') return;
    const count = (await tx.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${LIVE_OPERATOR} AND m.project_id=? AND m.actor_id<>?`,
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
    { subject, role }: { subject: string; role: Role },
  ): Promise<ProjectMembership> {
    this.input(subject);
    check(ROLES.includes(role), 'invalid_role', 'Unknown member role');
    return await this.write(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const previous = await this.current(tx, projectId, caller.human!.issuer, subject);
      check(previous, 'not_found', 'Active project member not found', 404);
      if (previous.role === role) return membership(previous);
      await this.keepOperator(tx, previous, role);
      return await this.replace(tx, previous, role, caller.actorId);
    });
  }

  /** Ends the active membership `previous` and starts its person's next one with `role`, which
   *  `actorId` (by default that person) records as a change of permissions. */
  private async replace(
    tx: Transaction,
    previous: MembershipRow,
    role: Role,
    actorId?: string,
  ): Promise<ProjectMembership> {
    await tx.run(
      'UPDATE project_memberships SET active=0,revoked_at=? WHERE id=?',
      this.time(),
      previous.id,
    );
    const next = await this.activate(tx, previous.project_id, previous, role);
    await this.state.appendEvent(tx, {
      projectId: previous.project_id,
      actorId: actorId ?? next.actorId,
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
  }

  async removeMember(principal: Principal, projectId: string, subject: string): Promise<void> {
    this.input(subject);
    await this.write(async (tx) => {
      const caller = await this.operator(principal, projectId, tx);
      const previous = await this.current(tx, projectId, caller.human!.issuer, subject);
      if (!previous) return;
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
      await this.keepAdmin(tx, projectId);
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
    const reason = options?.repairReason;
    if (options !== undefined)
      check(
        typeof reason === 'string' && visible(reason) && reason.length <= 2000,
        'invalid_repair_reason',
        'Local ownership repair requires a reason of 1–2000 characters',
      );
    return await this.write(async (tx) => {
      const human = await this.human(principal, tx);
      await this.project(tx, projectId);
      if (reason !== undefined) {
        const previous = await tx.get<MembershipRow>(
          'SELECT * FROM project_memberships WHERE project_id=? AND issuer=? AND subject=? ORDER BY active DESC,_merv_rowid DESC LIMIT 1',
          projectId,
          human.user.issuer,
          human.user.subject,
        );
        const value = !previous?.active
          ? await this.activate(tx, projectId, human.user, 'operator')
          : previous.role === 'operator'
            ? membership(previous)
            : await this.replace(tx, previous, 'operator');
        await this.state.appendEvent(tx, {
          projectId,
          actorId: value.actorId,
          type: 'membership.repaired',
          subjectId: value.actorId,
          data: {
            reason: reason.trim(),
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
      const value = await this.activate(tx, projectId, human.user, 'operator');
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
