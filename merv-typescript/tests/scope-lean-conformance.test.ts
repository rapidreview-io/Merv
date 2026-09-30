import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  openSync,
  readFileSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createService,
  type Caller,
  type DelegationSource,
  type Permission,
  type Role,
  type UserKey,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { openState } from './fixtures/state.js';

type Command =
  | { kind: 'grant'; project: number; subject: number; role: Role }
  | { kind: 'remove'; project: number; subject: number }
  | {
      kind: 'issueKey';
      id: number;
      project: number;
      subject: number;
      account: boolean;
      expires: number | null;
    }
  | { kind: 'revokeKey' | 'revokeActor'; id: number }
  | { kind: 'issueActor'; id: number; project: number; role: Role; byMember?: boolean }
  | { kind: 'advance'; time: number }
  | { kind: 'capture'; id: number; project: number; subject: number; key: number | null }
  | { kind: 'keyAuthority' | 'actorAuthority'; id: number; project: number; permission: Permission }
  | { kind: 'delegated'; source: number; project: number; permission: Permission }
  | { kind: 'human'; source: number; project: number; permission: Permission; expires: number }
  | { kind: 'worker'; source: number; project: number; role: Role }
  | {
      kind: 'service';
      source: number;
      project: number;
      permission: Permission;
      reviewService: boolean;
    };
type Member = { epoch: number; project: number; subject: number; role: Role; active: boolean };
type Observation = { allowed: boolean | null; members: Member[] };
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const binary =
  process.env.MERV_SCOPE_LEAN_BINARY ?? resolve(directory, '.lake/build/bin/scope_authority_model');
const available = existsSync(binary);
const options = {
  skip:
    !available && process.env.MERV_REQUIRE_LEAN !== '1' ? 'Build scope_authority_model' : undefined,
};
const origin = Date.parse('2026-09-26T00:00:00.000Z');
const iso = (time: number) => new Date(origin + time).toISOString();
const permissions: Permission[] = ['read', 'write', 'review', 'admin'];
const roles: Role[] = ['operator', 'producer', 'reviewer', 'reader'];

function model(commands: Command[]): Observation[] {
  assert.ok(available, `Required Lean model missing: ${binary}`);
  const scratch = mkdtempSync(resolve(tmpdir(), 'merv-scope-oracle-'));
  writeFileSync(resolve(scratch, 'input'), JSON.stringify({ commands }));
  const input = openSync(resolve(scratch, 'input'), 'r');
  const output = openSync(resolve(scratch, 'output'), 'w');
  try {
    // File descriptors avoid synchronous pipe backpressure stalls on macOS.
    const result = spawnSync(binary, [], {
      cwd: directory,
      encoding: 'utf8',
      stdio: [input, output, 'pipe'],
      timeout: 15_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(resolve(scratch, 'output'), 'utf8'))
      .observations as Observation[];
  } finally {
    closeSync(input);
    closeSync(output);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function implementation(
  commands: Command[],
  mutation?: 'refresh-epoch' | 'project-key-as-account',
): Promise<Observation[]> {
  const state = await openState();
  let now = 0;
  const scope = await createService(new ProjectScope(state, () => origin + now));
  try {
    const admin = await scope.acceptVerifiedIdentity({
      issuer: 'https://lean.test',
      subject: 'admin',
      expiresAt: iso(1_000_000),
    });
    const user = await scope.acceptVerifiedIdentity({
      issuer: 'https://lean.test',
      subject: 'worker',
      expiresAt: iso(1_000_000),
    });
    const projects = new Map<number, string>();
    for (const id of [1, 2])
      projects.set(
        id,
        (await scope.createProject(admin, { name: `Lean scope ${id}`, requestId: `lean-${id}` }))
          .id,
      );
    const project = (id: number) => projects.get(id)!;
    const projectNumber = (id: string) => [...projects].find(([, value]) => id === value)![0];
    const keys = new Map<number, UserKey>();
    const actors = new Map<number, Caller>();
    const sources = new Map<number, DelegationSource>();
    const epochs = new Map<string, number>();
    const observations: Observation[] = [];
    let session = 0;
    const selected = (id: number, projectId: number) => ({
      ...sources.get(id)!,
      projectId: project(projectId),
    });
    const isAllowed = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return true;
      } catch (error) {
        const code = (error as { code?: string }).code;
        assert.ok(
          [
            'forbidden',
            'membership_required',
            'invalid_delegation',
            'invalid_session_actor',
          ].includes(code ?? ''),
          `Unexpected denial ${String(error)}`,
        );
        return false;
      }
    };
    for (const command of commands) {
      let allowed: boolean | null = null;
      switch (command.kind) {
        case 'advance':
          now = command.time;
          break;
        case 'grant': {
          const current = (await scope.memberships(admin, project(command.project))).find(
            (m) => m.subject === 'worker' && m.active,
          );
          if (current)
            await scope.changeMemberRole(admin, project(command.project), {
              subject: 'worker',
              role: command.role,
            });
          else
            await scope.addMember(admin, project(command.project), {
              subject: 'worker',
              role: command.role,
            });
          break;
        }
        case 'remove':
          await scope.removeMember(admin, project(command.project), 'worker');
          break;
        case 'issueKey': {
          const issued = await scope.createKey(user, {
            projectId: project(command.project),
            grantScope:
              command.account || mutation === 'project-key-as-account' ? 'account' : 'project',
            expiresAt: command.expires === null ? null : iso(command.expires),
          });
          keys.set(command.id, issued.key);
          break;
        }
        case 'revokeKey':
          await scope.revokeKey(user, keys.get(command.id)!.id);
          break;
        case 'issueActor': {
          const value = await scope.issueActor(
            await scope.caller(command.byMember ? user : admin, project(command.project)),
            { name: `Independent ${command.id}`, role: command.role },
          );
          actors.set(command.id, {
            actorId: value.actor.id,
            projectId: value.actor.projectId,
            credentialId: value.credential.id,
          });
          break;
        }
        case 'revokeActor': {
          const actor = actors.get(command.id)!;
          await scope.revokeActor(await scope.caller(admin, actor.projectId), actor.actorId);
          break;
        }
        case 'capture':
          allowed = await isAllowed(async () => {
            const caller =
              command.key === null
                ? await scope.caller(user, project(command.project))
                : await scope.caller(
                    { kind: 'key', key: keys.get(command.key)! },
                    project(command.project),
                  );
            const source = await scope.delegationSource(caller);
            if (command.key === null)
              assert.equal(
                'expiresAt' in source,
                false,
                'Human delegations deliberately omit JWT lifetime',
              );
            sources.set(command.id, source);
          });
          break;
        case 'keyAuthority':
          allowed = await isAllowed(async () =>
            scope.require(
              await scope.caller(
                { kind: 'key', key: keys.get(command.id)! },
                project(command.project),
              ),
              command.permission,
            ),
          );
          break;
        case 'actorAuthority':
          allowed = await isAllowed(() =>
            scope.require(
              { ...actors.get(command.id)!, projectId: project(command.project) },
              command.permission,
            ),
          );
          break;
        case 'delegated': {
          let source = selected(command.source, command.project);
          if (mutation === 'refresh-epoch')
            source = await scope.delegationSource(
              await scope.caller(user, project(command.project)),
            );
          allowed = await isAllowed(() => scope.requireDelegation(source, command.permission));
          break;
        }
        case 'human': {
          const source = selected(command.source, command.project);
          assert.equal(source.kind, 'human');
          if (source.kind !== 'human') throw new Error('human fixture requires a human source');
          const caller: Caller = {
            actorId: source.actorId,
            projectId: source.projectId,
            human: {
              issuer: source.issuer,
              subject: source.subject,
              membershipId: source.membershipId,
              expiresAt: iso(command.expires),
            },
          };
          allowed = await isAllowed(() => scope.require(caller, command.permission));
          break;
        }
        case 'worker':
          allowed = await isAllowed(() =>
            state.transaction((tx) =>
              scope.createSessionActor(
                selected(command.source, command.project),
                {
                  sessionId: `lean-session-${++session}`,
                  name: 'Lean worker',
                  role: command.role as Exclude<Role, 'operator'>,
                },
                tx,
              ),
            ),
          );
          break;
        case 'service': {
          const service = await scope.serviceActor(
            command.reviewService ? 'fleet-review' : 'lean-fixture',
            project(command.project),
          );
          allowed = await isAllowed(() =>
            scope.require(
              { ...service, service: { vouchedBy: sources.get(command.source)! } },
              command.permission,
            ),
          );
          break;
        }
      }
      const members = await state.read((sql) =>
        sql.all<{ id: string; project_id: string; role: Role; active: number }>(
          "SELECT id,project_id,role,active FROM project_memberships WHERE subject='worker' ORDER BY _merv_rowid",
        ),
      );
      observations.push({
        allowed,
        members: members.map((m) => {
          if (!epochs.has(m.id)) epochs.set(m.id, epochs.size + 1);
          return {
            epoch: epochs.get(m.id)!,
            project: projectNumber(m.project_id),
            subject: 1,
            role: m.role,
            active: !!m.active,
          };
        }),
      });
    }
    return observations;
  } finally {
    await state.close();
  }
}

const query = (source: number, project: number): Command[] =>
  permissions.map((permission) => ({ kind: 'delegated', source, project, permission }));
const grant = (project: number, role: Role): Command => ({
  kind: 'grant',
  project,
  subject: 1,
  role,
});
const capture = (id: number, project: number, key: number | null = null): Command => ({
  kind: 'capture',
  id,
  project,
  subject: 1,
  key,
});

function targeted(): Command[] {
  const commands: Command[] = [
    grant(1, 'producer'),
    grant(2, 'reviewer'),
    capture(1, 1),
    capture(2, 2),
    ...query(1, 1),
    ...query(1, 2),
    ...query(2, 2),
    ...roles.map((role) => ({ kind: 'worker' as const, source: 1, project: 1, role })),
    ...roles.map((role) => ({ kind: 'worker' as const, source: 2, project: 2, role })),
    { kind: 'service', source: 1, project: 1, permission: 'review', reviewService: true },
    { kind: 'service', source: 1, project: 2, permission: 'review', reviewService: true },
    { kind: 'service', source: 2, project: 2, permission: 'review', reviewService: true },
    { kind: 'issueKey', id: 1, subject: 1, project: 1, account: true, expires: null },
    { kind: 'issueKey', id: 2, subject: 1, project: 1, account: false, expires: 500 },
    capture(3, 1, 1),
    capture(4, 1, 2),
    { kind: 'issueActor', id: 1, project: 1, role: 'reviewer' },
    { kind: 'advance', time: 100 },
    { kind: 'human', source: 1, project: 1, permission: 'read', expires: 100 },
    ...query(1, 1), // Durable human source outlives initiating JWT.
  ];
  for (const id of [1, 2])
    for (const project of [1, 2])
      for (const permission of permissions)
        commands.push({ kind: 'keyAuthority', id, project, permission });
  commands.push(grant(1, 'reader'), ...query(1, 1), ...query(3, 1), ...query(4, 1));
  for (const permission of permissions)
    commands.push({ kind: 'keyAuthority', id: 1, project: 1, permission });
  commands.push(
    grant(1, 'producer'),
    ...query(1, 1),
    capture(5, 1),
    { kind: 'remove', project: 1, subject: 1 },
    ...query(5, 1),
    { kind: 'keyAuthority', id: 1, project: 1, permission: 'read' },
    grant(1, 'producer'),
    ...query(5, 1),
    capture(6, 1, 1),
  );
  for (const permission of permissions)
    commands.push({ kind: 'keyAuthority', id: 1, project: 1, permission });
  // Exercise the full worker lattice, including operator sources and same-role no-ops.
  for (const [index, role] of roles.entries()) {
    const id = 20 + index;
    commands.push(grant(2, role), capture(id, 2), grant(2, role), ...query(id, 2));
    for (const child of roles)
      commands.push({ kind: 'worker', source: id, project: 2, role: child });
  }
  // Administrative issuance is independent of the issuing member's subsequent removal.
  commands.push(
    grant(2, 'operator'),
    { kind: 'issueActor', id: 2, project: 2, role: 'reviewer', byMember: true },
    { kind: 'remove', project: 2, subject: 1 },
  );
  for (const permission of permissions)
    commands.push({ kind: 'actorAuthority', id: 2, project: 2, permission });
  // Independent actor credentials retain their own role despite membership changes.
  for (const project of [1, 2])
    for (const permission of permissions)
      commands.push({ kind: 'actorAuthority', id: 1, project, permission });
  commands.push(
    { kind: 'revokeKey', id: 1 },
    ...query(6, 1),
    { kind: 'keyAuthority', id: 1, project: 2, permission: 'read' },
    { kind: 'advance', time: 500 },
    { kind: 'keyAuthority', id: 2, project: 1, permission: 'read' },
    { kind: 'revokeActor', id: 1 },
    { kind: 'actorAuthority', id: 1, project: 1, permission: 'read' },
  );
  return commands;
}

function generated(): Command[] {
  const commands: Command[] = [
    grant(1, 'producer'),
    grant(2, 'reviewer'),
    { kind: 'issueKey', id: 1, subject: 1, project: 1, account: true, expires: null },
  ];
  let seed = 731,
    source = 0;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let i = 0; i < 24; i++) {
    const project = 1 + random(2);
    commands.push(capture(++source, project));
    const old = source;
    commands.push(grant(project, roles[random(4)]!), ...query(old, project));
    if (i % 3 === 0)
      commands.push(
        { kind: 'remove', project, subject: 1 },
        grant(project, roles[random(4)]!),
        ...query(old, project),
      );
    for (const permission of permissions)
      commands.push({ kind: 'keyAuthority', id: 1, project, permission });
  }
  return commands;
}

test(
  'compiled Scope authority model agrees with live memberships, keys, worker role checks and service exception',
  options,
  async () => {
    for (const commands of [targeted(), generated()])
      assert.deepEqual(await implementation(commands), model(commands), JSON.stringify(commands));
  },
);

test(
  'Scope differential harness detects stale-epoch resurrection and project-key widening',
  options,
  async () => {
    const epochs: Command[] = [
      grant(1, 'producer'),
      capture(1, 1),
      grant(1, 'reader'),
      grant(1, 'producer'),
      ...query(1, 1),
    ];
    const projects: Command[] = [
      grant(1, 'producer'),
      grant(2, 'reviewer'),
      { kind: 'issueKey', id: 1, subject: 1, project: 1, account: false, expires: null },
      { kind: 'keyAuthority', id: 1, project: 2, permission: 'review' },
    ];
    for (const [commands, mutation] of [
      [epochs, 'refresh-epoch'],
      [projects, 'project-key-as-account'],
    ] as const) {
      const expected = model(commands),
        actual = await implementation(commands, mutation);
      assert.throws(
        () => assert.deepEqual(actual, expected),
        assert.AssertionError,
        `negative control ${mutation} was not detected`,
      );
    }
  },
);
