import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createService, MervError, type Caller, type State } from '@merv/contracts';
import type { IssueReport, Issues } from '@merv/contracts/issues';
import { CodeBaseService } from '@merv/code-work/bases';
import { DurableEvents } from '@merv/domain-events';
import type { Fleet, FleetAllocation, FleetOwner } from '@merv/fleet/types';
import { FleetWorkflowAdapter } from '@merv/fleet/workflow';
import { modelMigrations } from '@merv/fleet/schema';
import { SandboxRuns } from '@merv/sandboxes/sandbox-runs';
import { ProjectScope } from '@merv/scope';
import type { Sessions } from '@merv/sessions/types';
import { FleetService } from '../packages/fleet/src/index.js';
import { fixture as piFixture } from './fixtures/pi.js';
import { profiles } from './fixtures/runtime-records.js';
import { FakeRuntimes } from './fixtures/runtimes.js';
import { openState } from './fixtures/state.js';

/** An owner's issues as a list: what it reported, in order. */
function capture() {
  const reports: IssueReport[] = [];
  const issues: Issues = { report: (issue) => void reports.push(issue), resolve() {} };
  const at = (where: string) => reports.filter((issue) => issue.where === where);
  return { reports, issues, at };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function fleetFixture(t: TestContext, owner: Partial<FleetOwner> = {}) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.credentials.bootstrap({ projectName: 'Fleet', actorName: 'Operator' });
  const caller: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  const runtimes = new FakeRuntimes();
  let now = Date.parse('2026-09-22T00:00:00Z');
  const fleet = await createService(
    new FleetService(state, scope, runtimes, { profiles }, () => now),
  );
  const seen = capture();
  fleet.issues = seen.issues;
  fleet.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'bootstrap',
    observe: async () => 'running',
    ...owner,
  });
  t.after(async () => {
    await fleet.close();
    await state.close();
  });
  const allocation = await fleet.request(caller, {
    requestId: 'r1',
    owner: { kind: 'workflow', id: 'work:wf_1' },
  });
  const machine = () => [...runtimes.handles.values()][0]!;
  return {
    ...seen,
    caller,
    runtimes,
    fleet,
    allocation,
    machine,
    advance: (ms: number) => void (now += ms),
  };
}

test('a machine the provider stopped while its work ran is reported gone, once', async (t) => {
  const f = await fleetFixture(t);
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, f.allocation.id)).phase, 'running');
  f.runtimes.release(f.machine().sandboxId);
  await f.fleet.tick();
  await f.fleet.tick();
  assert.deepEqual(
    f.at('fleet.machine_gone').map((issue) => [issue.code, issue.level, issue.subject]),
    [['stopped', 'severe', f.allocation.id]],
  );
  const [gone] = f.at('fleet.machine_gone');
  assert.equal(gone!.refs?.sandboxId, f.machine().sandboxId);
  assert.equal(gone!.refs?.instanceId, 'wf_1');
  assert.equal(gone!.refs?.runtimeRelease, profiles[0]!.releaseId);
});

test('a machine whose host never acknowledges its shutdown stands as stuck releasing', async (t) => {
  const f = await fleetFixture(t, { prepareStop: async () => false });
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  await f.fleet.cancel(f.caller, f.allocation.id);
  // Within a minute of its lease the host is renewed while capture retries: it is releasing.
  f.machine().leaseExpiresAt = '2026-09-22T00:00:30Z';
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, f.allocation.id)).phase, 'releasing');
  await f.fleet.tick();
  assert.deepEqual(f.at('fleet.stuck_releasing'), []);
  f.advance(600_001);
  await f.fleet.tick();
  await f.fleet.tick();
  const stuck = f.at('fleet.stuck_releasing');
  assert.deepEqual(
    stuck.map((issue) => [issue.code, issue.key, issue.standing, issue.level]),
    Array(2).fill(['releasing', f.allocation.id, true, 'severe']),
  );
});

test('fleet.retry counts failures to severe, never a booting launch, and a failed pass is reported', async (t) => {
  const f = await fleetFixture(t);
  await f.fleet.tick();
  // Sandboxes answers a just-made machine's first launch 503 before delivering anything.
  const launch = f.runtimes.launch.bind(f.runtimes);
  f.runtimes.launch = async () => {
    f.runtimes.launch = launch;
    throw new MervError('sandbox_provider_unavailable', 'Starting', 503);
  };
  await f.fleet.tick();
  assert.deepEqual(f.at('fleet.retry'), []);
  f.advance(1000);
  for (const _ of [1, 2]) await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, f.allocation.id)).phase, 'running');
  f.runtimes.inspect = async () => {
    throw new Error('provider unreachable');
  };
  for (const _ of [1, 2, 3, 4, 5]) {
    await f.fleet.tick();
    f.advance(61_000);
  }
  assert.deepEqual(
    f.at('fleet.retry').map((issue) => [issue.code, issue.level, issue.subject]),
    [
      ...Array(4).fill(['unexpected', 'notice', f.allocation.id]),
      ['unexpected', 'severe', f.allocation.id],
    ],
  );
  const internals = f.fleet as unknown as { run(): Promise<boolean>; pass(): Promise<void> };
  internals.run = () => Promise.reject(new MervError('state_unavailable', 'Down', 503));
  await internals.pass();
  assert.deepEqual(
    f.at('fleet.pass').map((issue) => [issue.code, issue.level, issue.subject]),
    [['state_unavailable', 'warn', 'fleet.pass']],
  );
});

test('work whose hosted machines never claimed it stands as unclaimed', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  await createService(new ProjectScope(state));
  await state.migrate('fleet_workflow', modelMigrations);
  process.env.MERV_TEST_ISSUES_MODEL = 'key';
  t.after(() => void delete process.env.MERV_TEST_ISSUES_MODEL);
  const source = { kind: 'actor', actorId: 'a1', projectId: 'p1', credentialId: 'c1' } as const;
  const rented = (id: string): FleetAllocation =>
    ({
      id,
      projectId: 'p1',
      source: { ...source, expiresAt: null },
      owner: { kind: 'workflow', id: 'work:wf_1' },
      requestId: id,
      profileId: 'standard',
      epoch: 1,
      phase: 'released',
      intent: 'stop',
      runtime: { sandboxId: id, state: 'stopped', ready: false, launch: null },
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
    }) as unknown as FleetAllocation;
  const fleet = {
    allocationSeconds: 86_400,
    held: async () => false,
    listOwned: async () => [rented('fa_1'), rented('fa_2')],
  } as unknown as Fleet;
  const sessions = {
    dispatch: {
      servedSources: async () => [{ projectId: 'p1', source }],
      dispatchDemand: async () => ({ candidates: [{ instanceId: 'wf_1', expectedRevision: 3 }] }),
    },
    managed: { inspect: async () => null },
  } as unknown as Sessions;
  const adapter = new FleetWorkflowAdapter(
    fleet,
    sessions,
    {} as never,
    { people: ['*'], modelApiKeyEnv: 'MERV_TEST_ISSUES_MODEL', baseUrl: 'https://example.invalid' },
    () => Date.parse('2026-09-23T00:00:00Z'),
    state,
  );
  const seen = capture();
  adapter.issues = seen.issues;
  // Its people, review director and retry grants are Scope's and Workflows': read as given.
  Object.assign(adapter, {
    director: async () => ({ user: { issuer: 'i', subject: 's' } }),
    reviewer: async () => source,
    retryGrants: async () => new Map(),
  });
  await adapter.reconcile();
  assert.deepEqual(seen.reports, [
    {
      class: 'platform',
      where: 'fleet.unclaimed',
      code: 'unclaimed',
      key: 'p1 wf_1:3',
      standing: true,
      level: 'severe',
      refs: { projectId: 'p1', instanceId: 'wf_1' },
    },
  ]);
});

test("a failed Pi turn keeps the worker's words as its note; a cancelled one is not reported", async (t) => {
  const f = await piFixture(t);
  const seen = capture();
  f.pi.issues = seen.issues;
  const bound = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(bound.token, bound.input);
  await f.pi.fail(bound.token, { ...bound.input, reason: 'Out of memory (exit 137)' });
  const [turn] = seen.at('pi.turn');
  assert.deepEqual(
    { ...turn, refs: undefined },
    {
      class: 'platform',
      where: 'pi.turn',
      code: 'worker_interrupted',
      subject: bound.input.conversationId,
      level: 'warn',
      note: 'Out of memory (exit 137)',
      refs: undefined,
    },
  );
  assert.equal(turn!.refs?.commandId, bound.input.commandId);
  assert.equal(turn!.refs?.allocationId, bound.work.command.runtimeId);
  assert.equal(turn!.refs?.projectId, f.operator.projectId);
  const conversation = await f.create();
  await f.send(conversation);
  const stopped = await f.pi.stop(f.operator, conversation.id);
  assert.equal(stopped.commands[0]!.error, 'cancelled');
  assert.equal(seen.at('pi.turn').length, 1);
});

test('a consumer that keeps failing stands, severe from its fifth attempt', async (t) => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  t.after(async () => {
    await events.close();
    await state.close();
  });
  const seen = capture();
  events.issues = seen.issues;
  let calls = 0;
  await events.subscribe({
    id: 'flaky',
    types: ['probe.created'],
    from: 'beginning',
    async handle() {
      if (++calls <= 5) throw Object.assign(new Error('secret detail'), { code: 'probe_down' });
    },
  });
  const event = await state.transaction((tx) =>
    state.appendEvent(tx, {
      projectId: 'p',
      actorId: 'a',
      type: 'probe.created',
      subjectId: 's',
      data: {},
    }),
  );
  const deadline = Date.now() + 5000;
  while (calls < 6) {
    assert.ok(Date.now() < deadline, 'the consumer did not retry');
    await events.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const consumer = seen.at('consumer');
  assert.deepEqual(
    consumer.map((issue) => issue.level),
    ['warn', 'warn', 'warn', 'warn', 'severe'],
  );
  assert.deepEqual(
    { ...consumer[0], error: undefined },
    {
      class: 'platform',
      where: 'consumer',
      code: 'probe_down',
      key: 'flaky',
      standing: true,
      level: 'warn',
      refs: { eventIds: [event.id, event.id] },
      error: undefined,
    },
  );
});

test('code-work and sandboxes passes report what they swallow', async () => {
  const bases = new CodeBaseService({} as State, {} as never, {} as never);
  const code = capture();
  bases.issues = code.issues;
  Object.assign(bases, {
    due: async () => {
      throw new MervError('code_unavailable', 'Down', 503);
    },
  });
  bases.start(60_000);
  await settle();
  await bases.close();
  assert.deepEqual(
    code.reports.map((issue) => [issue.where, issue.code, issue.subject, issue.level]),
    [['code_work.bases', 'code_unavailable', 'code_work.bases', 'warn']],
  );

  const run = { run_ref: 'run_1', project_id: 'p1', target: 1, retired: 0 };
  const state = { read: async (fn: (sql: unknown) => unknown) => fn({ all: async () => [run] }) };
  const scope = {
    serviceActor: async () => {
      throw new MervError('scope_unavailable', 'Down', 503);
    },
  };
  const runs = new SandboxRuns(state as never, scope as never, {} as never, {} as never);
  const sandboxes = capture();
  runs.issues = sandboxes.issues;
  await runs.reconcile();
  assert.deepEqual(
    sandboxes.reports.map((issue) => [issue.where, issue.code, issue.subject, issue.refs]),
    [['sandboxes.retire', 'scope_unavailable', 'run_1', { projectId: 'p1' }]],
  );
});
