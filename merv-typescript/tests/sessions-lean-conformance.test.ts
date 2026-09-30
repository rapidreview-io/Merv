import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import {
  checkReceipt,
  createService,
  releasedLease,
  type Caller,
  type LeaseRow,
  type WorkflowPolicy,
  type WorkflowDefinition,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { LeasedSessions, type Session, type SessionInvocation } from '@merv/sessions';
import { DurableEvents } from '@merv/domain-events';
import { openState } from './fixtures/state.js';

type Command =
  | {
      kind: 'offer';
      id: number;
      target: number;
      revision: number;
      actor: number;
      receipt: number;
      expires: number;
      hard: number;
    }
  | { kind: 'activate' | 'run' | 'cancel'; id: number }
  | { kind: 'close'; id: number; expired: boolean }
  | { kind: 'release'; id: number; receipt: number }
  | { kind: 'prepare'; id: number; session: number }
  | { kind: 'move'; target: number; revision: number }
  | { kind: 'advance'; time: number }
  | { kind: 'reload' | 'unload' | 'restart' };
type Observation = {
  outcome: string;
  effects: number;
  sessions: { id: number; status: string; released: boolean }[];
};
const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const binary = resolve(modelDir, '.lake/build/bin/sessions_ownership_model');
const skip =
  !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
    ? 'Build sessions_ownership_model to run session conformance'
    : undefined;
const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
function model(commands: Command[]): Observation[] {
  const run = spawnSync(binary, [], { input: JSON.stringify({ commands }), encoding: 'utf8' });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  return (JSON.parse(run.stdout) as { observations: Observation[] }).observations;
}
async function fixture(t: TestContext, releaseSuccessorMutant = false) {
  const start = Date.now();
  let time = 0;
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => start + time));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const boot = await scope.bootstrap({ projectName: 'Session proof', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  await state.transaction(async (tx) => {
    await tx.run(`CREATE TABLE lean_session_leases (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,instance_id TEXT NOT NULL,revision BIGINT NOT NULL,
      actor_id TEXT NOT NULL,receipt TEXT NOT NULL,released_at TEXT,review_id TEXT,claim_id TEXT)`);
    await tx.run(
      'CREATE TABLE lean_session_effects (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY)',
    );
  });
  let receipt = 0,
    mutantReleases = 0;
  const definition: WorkflowDefinition = {
    name: 'lean_session',
    version: 1,
    managed: true,
    initial: 'working',
    states: ['working'],
    terminal: [],
    edges: [{ from: 'working', action: 'move', to: 'working' }],
  };
  // No Reviews dependency is needed: fixture leases have no review/claim pair. The exact
  // production lease helper still performs all receipt/owner matching and row release.
  const reviews = {
    releaseClaim: async () => {
      throw new Error('Fixture has no review claims');
    },
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'move',
        states: ['working'],
        transitions: ['move'],
        tool: 'work.move',
        instruction: 'Move revision.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'producer',
          label: 'Work',
          brief: 'Bound local proof fixture',
          references: [],
          handoff: { instruction: 'Probe.', tools: ['work.probe'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [{ name: 'work.probe', alternatives: [{}] }] },
        references: async () => ({}),
        lease: {
          role: async ({ caller, tx }) => {
            await scope.require(caller, 'write', tx);
            return 'producer' as const;
          },
          acquire: async ({ caller, snapshot, tx, leaseId }) => {
            const body = { nonce: receipt };
            await tx.run(
              'INSERT INTO lean_session_leases(id,project_id,instance_id,revision,actor_id,receipt) VALUES(?,?,?,?,?,?)',
              leaseId,
              caller.projectId,
              snapshot.id,
              snapshot.revision,
              caller.actorId,
              JSON.stringify(body),
            );
            return body;
          },
          check: async ({ caller, snapshot, tx }, presented) => {
            const row = await tx.get<LeaseRow>(
              'SELECT * FROM lean_session_leases WHERE id=? AND project_id=? AND instance_id=? AND revision=? AND actor_id=? AND released_at IS NULL',
              caller.session!.id,
              caller.projectId,
              snapshot.id,
              snapshot.revision,
              caller.actorId,
            );
            checkReceipt(row, presented, 'Exact current lease is required');
          },
          release: async ({ lease, reason, tx }) => {
            await releasedLease(tx, reviews, 'lean_session_leases', lease, reason, {
              instance_id: lease.instanceId,
            });
            if (releaseSuccessorMutant) {
              mutantReleases++;
              await tx.run(
                'UPDATE lean_session_leases SET released_at=? WHERE instance_id=?',
                new Date().toISOString(),
                lease.instanceId,
              );
            }
          },
        },
      },
    ],
  };
  let handle = await workflows.register(definition, policy);
  const ids = await Promise.all(
    [0, 1].map(
      async (id) =>
        (
          await handle.start(source, {
            workflow: definition.name,
            requestId: `start-${id}`,
          })
        ).id,
    ),
  );
  const createSessions = () =>
    createService(
      new LeasedSessions(state, scope, workflows, events, {
        clock: () => start + time,
        sweepIntervalMs: 60_000,
      }),
    );
  let sessions = await createSessions();
  const agents = await Promise.all(
    [1, 2].map(async (id) =>
      sessions.registerAgent(source, {
        name: `Agent ${id}`,
        runnerId: `runner-${id}`,
        requestId: `agent-${id}`,
        secret: secret(),
      }),
    ),
  );
  const rows = new Map<number, { session: Session; token: string; caller?: Caller }>();
  const invocations = new Map<number, SessionInvocation>();
  const observations: Observation[] = [];
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  const apply = async (command: Command) => {
    let outcome = '';
    try {
      switch (command.kind) {
        case 'offer': {
          receipt = command.receipt;
          const token = secret();
          const session = await sessions.offer(source, {
            instanceId: ids[command.target]!,
            expectedRevision: command.revision,
            runnerId: `runner-${command.actor}`,
            agentId: agents[command.actor - 1]!.id,
            requestId: `offer-${command.id}`,
            secret: token,
            hardDeadlineSeconds: 300,
          });
          rows.set(command.id, { session, token });
          outcome = 'offered';
          break;
        }
        case 'activate': {
          const row = rows.get(command.id)!;
          row.caller = await sessions.authenticate(row.token);
          outcome = 'active';
          break;
        }
        case 'prepare': {
          const row = rows.get(command.session)!;
          invocations.set(command.id, await sessions.prepare(row.caller!, 'work.probe', {}));
          outcome = 'prepared';
          break;
        }
        case 'run':
          await sessions.run(invocations.get(command.id)!, async (caller) =>
            state.transaction(async (tx) => {
              await scope.require(caller, 'write', tx);
              await tx.run('INSERT INTO lean_session_effects DEFAULT VALUES');
            }),
          );
          outcome = 'executed';
          break;
        case 'cancel':
          await sessions.cancel(invocations.get(command.id)!);
          outcome = 'cancelled';
          break;
        case 'close':
          if (command.expired) await sessions.sweep();
          else
            await sessions.release(source, {
              sessionId: rows.get(command.id)!.session.id,
              runnerId: rows.get(command.id)!.session.runnerId,
            });
          outcome = observations
            .at(-1)
            ?.sessions.find((s) => s.id === command.id)
            ?.status.match(/released|expired/)
            ? 'unchanged'
            : 'closed';
          break;
        case 'release': {
          const lease = structuredClone(rows.get(command.id)!.session.lease);
          lease.receipt = { nonce: command.receipt };
          await workflows.releaseLease(lease, { reason: 'Delayed exact cleanup' });
          outcome = 'released';
          break;
        }
        case 'advance':
          time = Math.max(time, command.time);
          outcome = 'time';
          break;
        case 'move': {
          const before = await workflows.get(source, ids[command.target]!);
          await handle.transition(source, {
            instanceId: before.id,
            expectedRevision: before.revision,
            requestId: `move-${observations.length}`,
            action: 'move',
          });
          outcome = 'moved';
          break;
        }
        case 'unload':
          handle.dispose();
          outcome = 'unloaded';
          break;
        case 'reload':
          handle.dispose();
          handle = await workflows.register(definition, policy);
          outcome = 'reloaded';
          break;
        case 'restart':
          await sessions.close();
          sessions = await createSessions();
          outcome = 'restarted';
          break;
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      const aliases: Record<string, string> = {
        session_conflict: 'conflict',
        agent_busy: 'conflict',
        session_invocation: 'invocation',
        session_closed: 'refused',
        session_expired: 'refused',
        unauthorized: 'refused',
        workflow_unavailable: 'refused',
        revision_conflict: 'refused',
        session_completed: 'refused',
      };
      outcome =
        command.kind !== 'release' && code === 'stale_lease'
          ? 'refused'
          : (aliases[code!] ?? code!);
      assert.ok(
        ['conflict', 'invocation', 'refused', 'stale_lease', 'execution_replaced'].includes(
          outcome,
        ),
        String(error),
      );
    }
    const stored = await state.read((sql) =>
      sql.all<{ id: string; status: string; released: boolean }>(
        'SELECT s.id,s.status,(l.released_at IS NOT NULL) AS released FROM worker_sessions s JOIN lean_session_leases l ON l.id=s.id',
      ),
    );
    const count = await state.read((sql) =>
      sql.get<{ count: string }>('SELECT COUNT(*) AS count FROM lean_session_effects'),
    );
    observations.push({
      outcome,
      effects: Number(count!.count),
      sessions: [...rows].map(([id, { session }]) => {
        const row = stored.find((r) => r.id === session.id)!;
        return { id, status: row.status, released: row.released };
      }),
    });
  };
  return { apply, observations, mutantReleases: () => mutantReleases };
}
const offer = (id: number, target: number, actor: number, time = 0, revision = 0): Command => ({
  kind: 'offer',
  id,
  target,
  actor,
  revision,
  receipt: id,
  expires: time + 300_000,
  hard: time + 300_000,
});
const commands: Command[] = [
  offer(1, 0, 1),
  offer(2, 0, 2),
  offer(3, 1, 1), // distinct target and actor conflicts
  { kind: 'activate', id: 1 },
  { kind: 'prepare', id: 10, session: 1 },
  { kind: 'reload' },
  { kind: 'run', id: 10 },
  { kind: 'prepare', id: 11, session: 1 },
  { kind: 'run', id: 11 },
  { kind: 'run', id: 11 },
  { kind: 'prepare', id: 12, session: 1 },
  { kind: 'cancel', id: 12 },
  { kind: 'run', id: 12 },
  { kind: 'release', id: 1, receipt: 999 },
  { kind: 'close', id: 1, expired: false },
  offer(4, 0, 1),
  { kind: 'activate', id: 4 },
  { kind: 'release', id: 1, receipt: 1 },
  { kind: 'prepare', id: 13, session: 4 },
  { kind: 'run', id: 13 },
  { kind: 'prepare', id: 14, session: 4 },
  { kind: 'advance', time: 300_000 },
  { kind: 'run', id: 14 },
  { kind: 'close', id: 4, expired: true },
  offer(5, 0, 2, 300_000),
  { kind: 'activate', id: 5 },
  { kind: 'prepare', id: 15, session: 5 },
  { kind: 'restart' },
  { kind: 'run', id: 15 },
  { kind: 'prepare', id: 16, session: 5 },
  { kind: 'run', id: 16 },
  { kind: 'prepare', id: 17, session: 5 },
  { kind: 'move', target: 0, revision: 1 },
  { kind: 'run', id: 17 },
  { kind: 'close', id: 5, expired: true },
  offer(6, 0, 1, 300_000, 1),
  { kind: 'activate', id: 6 },
  { kind: 'prepare', id: 18, session: 6 },
  { kind: 'unload' },
  { kind: 'run', id: 18 },
  { kind: 'reload' },
  { kind: 'prepare', id: 19, session: 6 },
  { kind: 'run', id: 19 },
];
test(
  'Lean ownership, expiry, exact release and registration generations agree with real Sessions',
  { skip },
  async (t) => {
    const f = await fixture(t);
    for (const command of commands) await f.apply(command);
    assert.deepEqual(f.observations, model(commands), JSON.stringify(commands));
  },
);
test(
  'session comparator catches old cleanup releasing a successor',
  {
    skip:
      skip ?? (process.env.MERV_LEAN_MUTATIONS === '1' ? undefined : 'Set MERV_LEAN_MUTATIONS=1'),
  },
  async (t) => {
    const f = await fixture(t, true);
    const trace: Command[] = [
      offer(1, 0, 1),
      { kind: 'close', id: 1, expired: false },
      offer(2, 0, 2),
      { kind: 'release', id: 1, receipt: 1 },
    ];
    for (const command of trace) await f.apply(command);
    assert.ok(f.mutantReleases() >= 2, 'release mutation was exercised');
    assert.equal(f.observations.at(-1)!.sessions[1]!.released, true);
    assert.throws(() => assert.deepEqual(f.observations, model(trace)), { code: 'ERR_ASSERTION' });
  },
);
