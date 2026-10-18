import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition, WorkflowPolicy } from '@merv/contracts';
import { adminOf } from '../packages/admin/src/index.js';
import { adminWork } from '../packages/admin/src/work.js';
import { RequestStore } from '../packages/customer-experiments/src/store.js';
import { createApp } from './fixtures/app.js';
import { currentTask } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { fixture as piFixture } from './fixtures/pi.js';

const issuer = 'https://identity.example';
const human = (subject: string) => ({
  issuer,
  subject,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
/** Ends neither in complete, failed nor abandoned: its own version says what is terminal. */
const chore: WorkflowDefinition = {
  name: 'chore',
  version: 1,
  managed: true,
  initial: 'drafting',
  states: ['drafting', 'paused', 'shipped'],
  terminal: ['shipped'],
  edges: [
    { from: 'drafting', action: 'pause', to: 'paused' },
    { from: 'drafting', action: 'ship', to: 'shipped' },
    { from: 'paused', action: 'resume', to: 'drafting' },
  ],
};
const rule = (name: string, from: string, tool = `chore.${name}`) => ({
  name,
  states: [from],
  transitions: [name],
  tool,
  instruction: name,
  check: () => {},
});
const chores: WorkflowPolicy = {
  actions: [
    rule('pause', 'drafting'),
    rule('ship', 'drafting'),
    rule('resume', 'paused', 'workflow.extend_limit'),
  ],
};
/** A standalone experiment's graph, as far as the table reads it. */
const standalone: WorkflowDefinition = {
  name: 'service_experiment',
  version: 99,
  managed: true,
  initial: 'ready',
  states: ['ready', 'complete'],
  terminal: ['complete'],
  edges: [{ from: 'ready', action: 'accept', to: 'complete' }],
};

test('the work table reads every project’s open and recent work through its owners', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-admin-work-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui', 'admin'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { scope, workflows, sessions, reflections } = app.ctx;
  const ada = await scope.members.acceptVerifiedIdentity(human('ada'));
  await scope.members.acceptVerifiedIdentity(human('abcd1234-0000-4000-8000-000000000000'));
  const lab = await scope.members.createProject(ada, { name: 'Lab A', requestId: 'lab' });
  const owner = await scope.caller(ada, lab.id);
  await waitForManagedCode(app.ctx.codeWork, owner);

  const task = await currentTask(app.ctx, owner, {
    title: 'Train the model',
    goal: 'Train it.',
    checks: ['It trains.'],
    requestId: 'task',
  });
  await sessions.dispatch.heartbeatRunner(owner, {
    runnerId: 'machine',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 1,
    capabilities: ['code.v2'],
  });
  const visit = await sessions.offer(owner, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    runnerId: 'machine',
    requestId: 'visit',
    secret: `ms_${randomBytes(32).toString('base64url')}`,
  });
  const wave = await reflections.create(owner, { requestId: 'wave', title: 'Spring' });

  const handle = await workflows.register(chore, chores);
  const start = (title: string) =>
    handle.start(owner, { workflow: 'chore', requestId: title, data: { title } });
  const move = (id: string, action: string) =>
    handle.transition(owner, { instanceId: id, expectedRevision: 0, action, requestId: id });
  const open = await start('Open chore');
  const paused = await move((await start('Paused chore')).id, 'pause');
  const shipped = await move((await start('Shipped chore')).id, 'ship');
  const old = await move((await start('Old chore')).id, 'ship');
  await app.ctx.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE wf_instances SET updated_at=? WHERE id=?',
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
      old.id,
    );
    await workflows.replaceBlockers(
      {
        projectId: lab.id,
        instanceId: open.id,
        provider: 'code',
        blockers: [
          {
            key: 'merge',
            code: 'code_base_blocked',
            status: 409,
            message: 'The base of this unit could not be made (blocked_infra)',
            next: 'An operator looks at the base with code.status.',
          },
        ],
      },
      tx,
    );
  });

  // Standalone experiments: one whose customer gave an email, one nobody identified.
  const store = new RequestStore(app.ctx.state, 'admin-work-fixture-key-never-valid-elsewhere');
  await store.initialize();
  const service = await workflows.register(standalone);
  const customerRequest = async (clientRequest: string, email?: string) => {
    const request = await store.create(clientRequest, 'Standalone', 10);
    const experiment = await service.start(owner, {
      workflow: 'service_experiment',
      requestId: clientRequest,
      data: { name: `Standalone ${email ?? 'guest'}` },
    });
    await store.mutate(request.id, (record) => {
      record.experimentId = experiment.id;
      record.checkout = { contractHash: 'h', generation: 1, url: 'private-checkout-url' };
      if (email) record.email = email;
    });
    return { request, experiment };
  };
  const paying = await customerRequest('private-idempotency-one', 'Customer@Example.com');
  const guest = await customerRequest('private-idempotency-two');
  const get = (name: string) =>
    name === 'customerExperiments'
      ? { customers: store.customers.bind(store) }
      : app.ctx.get(name as 'state');

  const view = await adminWork({ get } as never, [{ issuer, subject: 'ada', label: 'Ada L.' }]);
  const row = (id: string) => view.rows.find((item) => item.id === id)!;
  assert.deepEqual(view.unavailable, ['fleet', 'pi']);
  assert.equal(row(old.id), undefined, 'ended more than a day ago');
  assert.equal(row(shipped.id).terminal, true);
  assert.equal(row(open.id).terminal, false);
  assert.ok(
    view.rows.findIndex((item) => item.terminal) > view.rows.findIndex((item) => !item.terminal),
  );
  assert.deepEqual(row(open.id).attention, [
    {
      reason: 'blocker',
      provider: 'code',
      code: 'code_base_blocked',
      message: 'The base of this unit could not be made (blocked_infra)',
    },
  ]);
  assert.deepEqual(
    row(paused.id).attention.map(({ reason, code }) => [reason, code]),
    [['allowance', 'paused']],
  );
  assert.equal(row(open.id).kind, 'chore');
  assert.equal(row(open.id).title, 'Open chore');
  assert.deepEqual(row(open.id).project, { id: lab.id, name: 'Lab A' });
  assert.deepEqual(row(open.id).person, { key: `${issuer}|ada`, label: 'Ada L.' });

  // A task with its live visit at its revision, its type and what its visits have used.
  const leased = row(task.id);
  assert.equal(leased.kind, 'task');
  assert.equal(leased.type, 'task.work');
  assert.equal(leased.title, 'Train the model');
  assert.deepEqual(leased.agent, { role: 'producer', status: 'offered' });
  assert.equal(leased.machine, null);
  assert.equal(leased.cost, null);
  await sessions.release(owner, { sessionId: visit.id, runnerId: 'machine' });
  const after = (await adminWork({ get } as never, [])).rows.find((item) => item.id === task.id)!;
  assert.equal(after.agent, null);
  assert.deepEqual(after.cost, {
    sessions: 1,
    reportedSessions: 0,
    wallMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(row(wave.id).kind, 'reflection');
  for (const lens of wave.lenses) {
    assert.equal(row(lens.id).kind, 'reflection lens');
    assert.equal(row(lens.id).title, `Spring: ${lens.perspective.replaceAll('_', ' ')}`);
  }

  assert.equal(row(paying.experiment.id).kind, 'standalone experiment');
  assert.deepEqual(row(paying.experiment.id).person, {
    key: 'email:customer@example.com',
    label: 'Customer@Example.com',
  });
  assert.deepEqual(
    row(paying.experiment.id).attention.map(({ reason, code }) => [reason, code]),
    [['customer', 'approval']],
  );
  assert.match(row(guest.experiment.id).person.label, /^Guest · /);
  assert.equal(row(guest.experiment.id).person.key, `guest:${guest.request.id}`);

  // Every identity is a person, the one with no work too; counts are of the table's rows.
  const person = view.people.find((p) => p.key === `${issuer}|ada`)!;
  assert.equal(person.total, view.rows.filter((r) => r.person.key === person.key).length);
  assert.equal(person.active, person.total - 1);
  assert.ok(view.people.some((p) => p.label === 'abcd' && p.total === 0));

  // No capability, checkout or idempotency key of a request reaches the table.
  const json = JSON.stringify(view);
  for (const request of [paying.request, guest.request])
    for (const secret of [store.token(request, 'agent'), store.token(request, 'customer')])
      assert.ok(!json.includes(secret));
  assert.ok(!json.includes('private-'));
});

test('Pi turns are rows of the table, with the Fleet machine their host slot runs on', async (t) => {
  const f = await piFixture(t);
  const command = await f.send(await f.create());
  const get = (name: string) => ({ pi: f.pi, fleet: f.fleet, scope: f.scope })[name as 'pi'];
  const view = await adminWork({ get } as never, []);
  assert.deepEqual(view.unavailable, [
    'workflows',
    'sessions',
    'tasks',
    'reflections',
    'customerExperiments',
  ]);
  const [turn] = view.rows;
  assert.equal(view.rows.length, 1);
  assert.equal(turn!.id, command.id);
  assert.equal(turn!.kind, 'pi turn');
  assert.equal(turn!.title, 'Chat');
  assert.equal(turn!.project.name, 'Pi integration');
  assert.equal(turn!.state, 'waiting');
  assert.equal(turn!.terminal, false);
  const allocation = await f.allocation(command.runtimeId);
  assert.deepEqual(turn!.machine, {
    phase: allocation.phase,
    profile: 'standard',
    provider: 'fake',
    sandboxId: null,
    usdPerHour: null,
  });
});

test('only a configured human identity is an admin', () => {
  const identity = { issuer, subject: 'admin' };
  const signedIn = {
    kind: 'user' as const,
    user: { ...identity, createdAt: new Date().toISOString() },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  assert.ok(adminOf(signedIn, [identity]));
  for (const principal of [
    undefined,
    { ...signedIn, user: { ...signedIn.user, subject: 'other' } },
    { kind: 'actor', actor: { role: 'operator' } },
    { kind: 'key', key: { owner: identity } },
  ])
    assert.equal(adminOf(principal as never, [identity]), undefined);
  assert.equal(adminOf(signedIn, []), undefined);
});
