import {
  createService,
  MervError,
  type Caller,
  type WorkflowExecutionReferences,
  type WorkflowPolicy,
} from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');
const presence = (runnerId: string, capabilities?: string[]) => ({
  runnerId,
  machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
  platforms: [{ name: 'codex', harness: 'codex' as const, enabled: true, parallelism: 4 }],
  capacity: 4,
  ...(capabilities ? { capabilities } : {}),
});
const auto = (runnerId: string) => ({
  runnerId,
  requestId: request(),
  secret: secret(),
  platform: { name: 'codex', harness: 'codex' as const },
});
const oid = 'a'.repeat(40);

async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  const register = async (name: string, driver?: string) => {
    const policy: WorkflowPolicy = {
      successStates: ['done'],
      actions: [
        {
          name: 'finish',
          states: ['working'],
          transitions: ['finish'],
          tool: 'finish',
          instruction: 'Finish.',
          check: () => {},
        },
      ],
      assignments: [
        {
          state: 'working',
          check: async ({ caller, tx }) => {
            await scope.require(caller, 'write', tx);
          },
          build: () => ({
            role: 'producer',
            label: name,
            brief: 'Work',
            references: [],
            handoff: { instruction: 'Finish', tools: ['finish'] },
            execution: { readOnly: false, tools: [] },
            context: null,
          }),
          execution: {
            readOnly: false,
            tools: [],
            ...(driver
              ? {
                  workspace: {
                    mode: 'persistent' as const,
                    namespace: 'work',
                    base: 'reference:base' as const,
                    perBase: false,
                    retain: true,
                    advancesCentral: false,
                    driver,
                  },
                }
              : {}),
          },
          references: (): WorkflowExecutionReferences => (driver ? { base: oid } : {}),
          lease: {
            role: () => 'producer' as const,
            acquire: ({ leaseId }) => ({ leaseId }),
            check: () => {},
            release: () => {},
          },
        },
      ],
    };
    return await workflows.register(
      {
        name,
        version: 1,
        initial: 'working',
        states: ['working', 'done'],
        terminal: ['done'],
        edges: [{ from: 'working', action: 'finish', to: 'done' }],
      },
      policy,
    );
  };
  const hosted = await register('hosted', 'code.v2');
  const scratch = await register('scratch');
  const boot = await scope.bootstrap({ projectName: 'Capabilities', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  await sessions.setDispatch(owner, { enabled: true });
  return { sessions, source, owner, hosted, scratch };
}

test('work that names a workspace driver is offered only to a runner that advertises it, and the rest of the queue still reaches the others', async (t) => {
  const f = await fixture(t);
  // A legacy runner sends the closed heartbeat it always sent, and it is still accepted.
  const legacy = await f.sessions.heartbeatRunner(f.source, presence('legacy'));
  assert.equal((legacy as { capabilities?: string[] }).capabilities, undefined);
  const stored = await f.sessions.heartbeatRunner(f.source, presence('modern', ['code.v2']));
  assert.deepEqual((stored as { capabilities?: string[] }).capabilities, ['code.v2']);
  await assert.rejects(
    f.sessions.heartbeatRunner(f.source, presence('bad', ['Not A Capability'])),
    (error: unknown) => error instanceof MervError && error.code === 'invalid_runner',
  );

  const first = await f.hosted.start(f.source, { workflow: 'hosted', requestId: request() });
  const plain = await f.scratch.start(f.source, { workflow: 'scratch', requestId: request() });
  const taken = await f.sessions.lease(f.source, auto('legacy'));
  assert.equal(taken.session?.instanceId, plain.id, 'the driver-free work behind it is offered');
  assert.deepEqual(await f.sessions.lease(f.source, auto('legacy')), {
    session: null,
    reason: 'runner_incompatible',
  });
  const status = await f.sessions.projectStatus(f.owner);
  assert.equal(
    status.runners.find((runner) => runner.runnerId === 'legacy')?.lastDecision,
    'runner_incompatible',
  );
  const offered = await f.sessions.lease(f.source, auto('modern'));
  assert.equal(offered.session?.instanceId, first.id);
  assert.equal(offered.session?.execution.policy.workspace?.mode, 'persistent');
});

test('a hand offer requires the driver before leasing and attachment rechecks the capability', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.source, presence('legacy'));
  await f.sessions.heartbeatRunner(f.source, presence('modern', ['code.v2']));
  const workspace = {
    repositoryId: 'repository',
    workspaceId: 'workspace',
    mode: 'persistent' as const,
    branch: 'merv/work/x',
    baseOid: oid,
    headOid: oid,
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  for (const [runnerId, code] of [
    ['legacy', 'runner_incompatible'],
    ['unknown', 'runner_incompatible'],
    ['modern', null],
  ] as const) {
    const instance = await f.hosted.start(f.source, { workflow: 'hosted', requestId: request() });
    const offered = f.sessions.offer(f.source, {
      instanceId: instance.id,
      expectedRevision: 0,
      runnerId,
      requestId: request(),
      secret: secret(),
    });
    if (code) {
      await assert.rejects(offered, { code });
      continue;
    }
    const session = await offered;
    await f.sessions.heartbeatRunner(f.source, presence(runnerId));
    await assert.rejects(
      f.sessions.attach(f.source, {
        sessionId: session.id,
        runnerId,
        hostRef: 'launch',
        workspace,
      }),
      { code: 'runner_incompatible' },
    );
    await f.sessions.heartbeatRunner(f.source, presence(runnerId, ['code.v2']));
    const attach = f.sessions.attach(f.source, {
      sessionId: session.id,
      runnerId,
      hostRef: 'launch',
      workspace,
    });
    assert.equal((await attach).hostRef, 'launch');
  }
});
