import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, MervError, type Caller, type RunningNode } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
import { UiRegistry, type RunningRead } from '@merv/ui';
import { runningBoard, runningPanel, type RunningSources } from '@merv/ui/running';
import { FleetService, type FleetOwner } from '../packages/fleet/src/index.js';
import { fleetUiPlugin } from '../packages/fleet/src/ui.js';
import { openState } from './fixtures/state.js';

/**
 * Fleet's part of the Running page, composed as fleet-composition composes it: a bare
 * Context with the real Fleet service, its ui adapter and a UiRegistry, over a fake
 * sandboxes runtime. The board and the sidebars are read as the tools read them, inside one
 * read-only snapshot with a savepoint per part, so a write in Fleet's part would fail it.
 */

/** Machines come up ready or stay provisioning; `error` fails every provider call. */
class Runtimes implements SandboxRuntimes {
  readonly profiles = [{ key: 'standard', id: 'standard-profile', leaseSeconds: 600 }];
  ready = false;
  error?: Error;
  /** When the provider ends a new machine, unless Fleet renews it. */
  leaseExpiresAt = '2099-01-01T00:00:00Z';
  private readonly machines = new Map<string, SandboxRuntimeHandle>();
  /** One machine per create key, as the service keeps it. */
  private readonly created = new Map<string, string>();
  connected = () => true;
  describe = async () => null;
  private answer(sandboxId: string, change?: (machine: SandboxRuntimeHandle) => void) {
    if (this.error) throw this.error;
    const machine = this.machines.get(sandboxId)!;
    change?.(machine);
    return structuredClone(machine);
  }
  async provision(_projectId: string, operationKey: string) {
    if (this.error) throw this.error;
    const known = this.created.get(operationKey);
    if (known) return this.answer(known);
    const sandboxId = `sbx_${this.machines.size + 1}`;
    this.created.set(operationKey, sandboxId);
    this.machines.set(sandboxId, {
      sandboxId,
      state: this.ready ? 'ready' : 'provisioning',
      ready: this.ready,
      deleted: false,
      leaseExpiresAt: this.leaseExpiresAt,
      revision: 1,
      launch: null,
    });
    return this.answer(sandboxId);
  }
  inspect = async (_projectId: string, handle: SandboxRuntimeHandle) =>
    this.answer(handle.sandboxId);
  launch = async (_projectId: string, handle: SandboxRuntimeHandle, operationKey: string) =>
    this.answer(handle.sandboxId, (machine) => {
      machine.launch ??= {
        sandboxId: machine.sandboxId,
        launchId: `rln_${machine.sandboxId}`,
        operationKey,
        releaseId: 'release',
        jobId: `rtj_${machine.sandboxId}`,
        state: 'pending',
        deliveryState: 'launched',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    });
  acknowledge = async (_projectId: string, handle: SandboxRuntimeHandle) =>
    this.answer(handle.sandboxId, (machine) => {
      machine.launch!.state = 'consumed';
    });
  stop = async (_projectId: string, handle: SandboxRuntimeHandle) =>
    this.answer(handle.sandboxId, (machine) => {
      machine.state = 'deleting';
      machine.ready = false;
    });
  renew = async (_projectId: string, handle: SandboxRuntimeHandle) => this.answer(handle.sandboxId);
}

async function fixture(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Running Fleet', actorName: 'Operator' });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const runtimes = new Runtimes();
  let now = Date.parse('2026-09-22T00:00:00Z');
  const fleet = await createService(
    new FleetService(
      state,
      scope,
      runtimes,
      { enabled: true, globalLimit: 3, projectLimit: 3, allocationTimeoutSeconds: 3600 },
      () => now,
    ),
  );
  const owner: FleetOwner = {
    valid: async () => true,
    bootstrap: async () => 'bootstrap',
    observe: async () => 'running',
  };
  fleet.registerOwner('workflow', owner);
  fleet.registerOwner('pi-host', owner);
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('fleet', fleet);
  ctx.provide('ui', ui);
  const adapter = ctx.plugin(fleetUiPlugin);
  await adapter;
  t.after(async () => {
    await ctx.fiber.dispose();
    await fleet.close();
    await state.close();
  });
  const sources: RunningSources = {
    contributions: () => ui.contributions(),
    tools: async () => ['session.halt'],
    isolated: async (read) => await state.isolated(read),
  };
  let requests = 0;
  return {
    state,
    scope,
    caller,
    runtimes,
    fleet,
    ui,
    adapter,
    /** A request a second after the last, so the lane's order is the order they were made. */
    request: async (kind: string, id: string) => {
      now += 1000;
      return await fleet.request(caller, {
        requestId: `request-${++requests}`,
        owner: { kind, id },
      });
    },
    advance: (ms: number) => {
      now += ms;
    },
    board: async (as = caller) => await state.snapshot(() => runningBoard(sources, as)),
    panel: async (key: string, as = caller) =>
      await state.snapshot(() => runningPanel(sources, as, key)),
    /** Fleet's own panel member, as the sidebar calls it for a node another one absorbed. */
    absorbed: async (key: string, absorbedBy: string) => {
      const read: RunningRead = { caller, include: new Set(), once: async (_name, fn) => fn() };
      const contribution = ui.contributions().find(({ owner }) => owner === 'fleet')!;
      return await state.snapshot(() => contribution.panel!(read, key, absorbedBy));
    },
  };
}

const WHO = "An operator checks the project's sandbox connection";
const sessionsLane = (nodes: RunningNode[]) => nodes.filter(({ owner }) => owner === 'fleet');

test('each open allocation is a machine in the sessions lane, rented for its step, and a released one is gone', async (t) => {
  const f = await fixture(t);
  // One running, one starting, one stopping (a Pi host's), one waiting for a slot, one released.
  f.runtimes.ready = true;
  const running = await f.request('workflow', 'task_run:2');
  for (let tick = 0; tick < 3; tick++) await f.fleet.tick();
  f.runtimes.ready = false;
  const starting = await f.request('workflow', 'task_1:3');
  await f.fleet.tick();
  const stopping = await f.request('pi-host', 'pih_1:1');
  await f.fleet.tick();
  await f.fleet.cancel(f.caller, stopping.id);
  const waiting = await f.request('workflow', 'task_2:1');
  const released = await f.request('workflow', 'task_3:1');
  await f.fleet.cancel(f.caller, released.id);
  const now = async (id: string) => await f.fleet.inspect(f.caller, id);
  assert.deepEqual(
    await Promise.all(
      [running, starting, stopping, waiting, released].map(async ({ id }) => {
        const a = await now(id);
        return [a.phase, a.intent];
      }),
    ),
    [
      ['running', 'run'],
      ['provisioning', 'run'],
      ['provisioning', 'stop'],
      ['queued', 'run'],
      ['released', 'stop'],
    ],
  );
  const dispose = f.ui.contribute({
    owner: 'tasks',
    kinds: ['work'],
    lanes: ['work'],
    nodes: async () => ({
      nodes: ['task_run', 'task_1', 'task_2'].map((id) => ({
        key: `work:${id}`,
        lane: 'work' as const,
        title: id,
        lines: [],
        look: 'solid' as const,
      })),
    }),
  });
  t.after(dispose);

  const board = await f.board();
  assert.deepEqual(board.lanes.sessions.failed, []);
  assert.equal(board.lanes.sessions.needsYou, 0);
  const since = async (id: string) => ({ since: (await now(id)).updatedAt });
  // A Pi host is an agent machine; everything else here is a workflow's, in the order asked.
  assert.deepEqual(sessionsLane(board.lanes.sessions.nodes), [
    {
      key: `fleet:${stopping.id}`,
      lane: 'sessions',
      title: 'Agent machine',
      lines: [['Stopping · ', await since(stopping.id)], ['on a Fleet VM']],
      look: 'quiet',
      aliases: ['sandbox:sbx_3'],
      owner: 'fleet',
    },
    {
      key: `fleet:${running.id}`,
      lane: 'sessions',
      title: 'Workflow agent',
      lines: [['Running · ', await since(running.id)], ['on a Fleet VM']],
      look: 'solid',
      links: [{ to: 'work:task_run', verb: 'rented for', waiting: true }],
      aliases: ['sandbox:sbx_1'],
      owner: 'fleet',
    },
    {
      key: `fleet:${starting.id}`,
      lane: 'sessions',
      title: 'Workflow agent',
      lines: [['Starting · ', await since(starting.id)], ['on a Fleet VM']],
      look: 'dashed',
      dot: 'starting',
      links: [{ to: 'work:task_1', verb: 'rented for', waiting: true }],
      aliases: ['sandbox:sbx_2'],
      owner: 'fleet',
    },
    {
      key: `fleet:${waiting.id}`,
      lane: 'sessions',
      title: 'Workflow agent',
      // No machine is made while it waits for a slot, so none is named.
      lines: [['Waiting · ', await since(waiting.id)]],
      look: 'dashed',
      dot: 'starting',
      links: [{ to: 'work:task_2', verb: 'rented for', waiting: true }],
      owner: 'fleet',
    },
  ]);
  // Why each was rented, drawn dashed; a Pi host is rented for nobody's work.
  assert.deepEqual(board.edges, [
    { from: `fleet:${running.id}`, to: 'work:task_run', verb: 'rented for', waiting: true },
    { from: `fleet:${starting.id}`, to: 'work:task_1', verb: 'rented for', waiting: true },
    { from: `fleet:${waiting.id}`, to: 'work:task_2', verb: 'rented for', waiting: true },
  ]);
  assert.equal(board.lanes.work.nodes.length, 3);
  assert.equal(board.lanes.hardware.nodes.length, 0);
  // Another project sees none of them.
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const stranger: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  assert.deepEqual(sessionsLane((await f.board(stranger)).lanes.sessions.nodes), []);
  await assert.rejects(f.panel(`fleet:${running.id}`, stranger), {
    code: 'running_not_found',
    status: 404,
  });
  await assert.rejects(f.panel('fleet:flt_missing'), { code: 'running_not_found', status: 404 });
});

test('a request the sandbox service keeps failing counts its failures, then needs a person on the board, in its sidebar and on the Fleet page', async (t) => {
  const f = await fixture(t);
  f.runtimes.error = new MervError('sandbox_unavailable', 'Unreachable', 503);
  const failing = await f.request('workflow', 'task_1:1');
  const key = `fleet:${failing.id}`;
  await f.fleet.tick();
  const node = async () =>
    sessionsLane((await f.board()).lanes.sessions.nodes).find((n) => n.key === key)!;
  assert.deepEqual((await node()).lines[0], ['Retrying · ', { count: 1 }, ' failure']);
  for (let tick = 0; tick < 2; tick++) {
    f.advance(60_000);
    await f.fleet.tick();
  }
  const retrying = await node();
  assert.deepEqual(retrying.lines[0], ['Retrying · ', { count: 3 }, ' failures']);
  assert.equal(retrying.attention, undefined);
  assert.equal(retrying.look, 'dashed');
  for (let tick = 0; tick < 2; tick++) {
    f.advance(60_000);
    await f.fleet.tick();
  }
  const board = await f.board();
  const red = { says: ['No machine yet: the sandbox service keeps failing'], who: WHO };
  const [card] = sessionsLane(board.lanes.sessions.nodes);
  assert.deepEqual(card.attention, red);
  // The service never made a machine, so the card names none under its red sentence.
  assert.deepEqual(card.lines, [['Retrying · ', { count: 5 }, ' failures']]);
  assert.equal(board.lanes.sessions.needsYou, 1);

  const a = await f.fleet.inspect(f.caller, failing.id);
  const panel = await f.panel(key);
  assert.deepEqual(panel.header, {
    kind: 'Fleet machine',
    title: 'Workflow agent',
    says: ['Retrying · ', { count: 5 }, ' failures'],
    attention: red,
  });
  // The section that says why comes first.
  assert.deepEqual(panel.sections[0], {
    title: 'Fleet machine',
    place: 'machine',
    kind: 'facts',
    attention: true,
    owner: 'fleet',
    rows: [
      { label: 'Status', value: [{ state: 'retrying' }] },
      { label: 'Time remaining', value: [{ until: a.deadlineAt }] },
      { label: 'Needs you', value: red.says, attention: true },
      { label: 'Retries', value: [{ count: 5 }, ' failures'] },
      { label: 'Requested', value: [{ ago: a.createdAt }] },
    ],
  });
  // The Fleet page says the same thing in its own words, as it did before.
  const rows = (await f.ui.read(f.caller, 'fleet')) as Record<string, string | null>[];
  assert.deepEqual(
    rows.map((row) => [row.status, row.attention]),
    [
      [
        'retrying',
        "No machine yet: the sandbox service keeps failing. Check the project's sandbox connection.",
      ],
    ],
  );
});

test('a sidebar holds the Fleet machine and what it was rented for, gives up while it waits, and says in ink that the service refused it', async (t) => {
  const f = await fixture(t);
  const waiting = await f.request('workflow', 'task_1:3');
  // Not yet given a slot, it waits in the queue and gives up at its deadline.
  const panel = await f.panel(`fleet:${waiting.id}`);
  const a = await f.fleet.inspect(f.caller, waiting.id);
  assert.deepEqual(panel, {
    key: `fleet:${waiting.id}`,
    observedAt: panel.observedAt,
    header: {
      kind: 'Fleet machine',
      title: 'Workflow agent',
      says: ['Waiting · ', { since: a.updatedAt }],
    },
    sections: [
      {
        title: 'Rented for',
        place: 'relations',
        kind: 'links',
        rows: [{ to: { key: 'work:task_1' }, name: 'Open the work' }],
        owner: 'fleet',
      },
      {
        title: 'Fleet machine',
        place: 'machine',
        kind: 'facts',
        rows: [
          { label: 'Status', value: [{ state: 'waiting' }] },
          { label: 'Gives up', value: [{ until: a.deadlineAt }] },
          { label: 'Requested', value: [{ ago: a.createdAt }] },
        ],
        owner: 'fleet',
      },
    ],
    actions: [],
    route: `/fleet/${encodeURIComponent(waiting.id)}`,
    live: true,
    aliases: [],
  });

  // Refused before any machine existed: released at once, off the board, said where it is open.
  f.runtimes.error = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  await f.fleet.tick();
  const refused = await f.fleet.inspect(f.caller, waiting.id);
  assert.deepEqual([refused.phase, refused.error], ['released', 'runtime_refused']);
  assert.deepEqual(sessionsLane((await f.board()).lanes.sessions.nodes), []);
  const closed = await f.panel(`fleet:${waiting.id}`);
  assert.deepEqual(closed.header, {
    kind: 'Fleet machine',
    title: 'Workflow agent',
    says: ['Refused by the sandbox service · ', { ago: refused.updatedAt }],
  });
  assert.deepEqual(
    closed.sections.map(({ title, attention }) => [title, !!attention]),
    [
      ['Rented for', false],
      ['Fleet machine', false],
    ],
  );
  assert.deepEqual(closed.sections[1].kind === 'facts' && closed.sections[1].rows, [
    { label: 'Status', value: [{ state: 'refused' }] },
    { label: 'Requested', value: [{ ago: refused.createdAt }] },
  ]);
  assert.equal(closed.live, false);
  assert.deepEqual(closed.actions, []);
});

test('a refusal says what refused it, one word for it on the Fleet page too, and never turns red', async (t) => {
  const f = await fixture(t);
  // Over the sandbox service's spending limit: the service refused the first create.
  f.runtimes.error = new MervError('sandbox_budget_exceeded', 'The budget is spent', 403);
  const spent = await f.request('workflow', 'task_1:1');
  await f.fleet.tick();
  // The project's connection went away after the request: Fleet refuses it without asking.
  f.runtimes.error = undefined;
  const unconnected = await f.request('workflow', 'task_2:1');
  f.runtimes.connected = () => false;
  await f.fleet.tick();
  const [a, b] = [
    await f.fleet.inspect(f.caller, spent.id),
    await f.fleet.inspect(f.caller, unconnected.id),
  ];
  assert.deepEqual(
    [a, b].map(({ phase, error, createAttempted }) => [phase, error, createAttempted]),
    [
      ['released', 'wallet_refused', true],
      ['released', 'runtime_refused', false],
    ],
  );
  // A day later, when the work may long have run elsewhere, still nobody is called for.
  f.advance(86_400_000);
  const heads = await Promise.all([a, b].map(async ({ id }) => await f.panel(`fleet:${id}`)));
  assert.deepEqual(
    heads.map(({ header }) => header),
    [
      {
        kind: 'Fleet machine',
        title: 'Workflow agent',
        says: ['Refused · spending limit · ', { ago: a.updatedAt }],
      },
      {
        kind: 'Fleet machine',
        title: 'Workflow agent',
        says: ['Refused · no sandbox connection · ', { ago: b.updatedAt }],
      },
    ],
  );
  for (const panel of heads) {
    assert.deepEqual(
      panel.sections.map(({ attention }) => !!attention),
      [false, false],
    );
    const facts = panel.sections.find(({ title }) => title === 'Fleet machine')!;
    assert.deepEqual(facts.kind === 'facts' && facts.rows[0], {
      label: 'Status',
      value: [{ state: 'refused' }],
    });
  }
  const rows = (await f.ui.read(f.caller, 'fleet')) as Record<string, string | null>[];
  assert.deepEqual(
    rows.map((row) => [row.status, row.attention]),
    [
      ['refused', null],
      ['refused', null],
    ],
  );
});

test('a running machine the service stops answering about is said in ink while Fleet keeps it, and red once its lease has passed', async (t) => {
  const f = await fixture(t);
  f.runtimes.ready = true;
  f.runtimes.leaseExpiresAt = '2026-09-22T00:30:00.000Z';
  const machine = await f.request('workflow', 'task_run:2');
  for (let tick = 0; tick < 3; tick++) await f.fleet.tick();
  const key = `fleet:${machine.id}`;
  f.runtimes.error = new MervError('sandbox_unavailable', 'Unreachable', 503);
  for (let tick = 0; tick < 5; tick++) {
    f.advance(60_000);
    await f.fleet.tick();
  }
  const a = await f.fleet.inspect(f.caller, machine.id);
  assert.deepEqual([a.phase, a.failures, a.error], ['running', 5, 'runtime_unavailable']);
  const quiet = { says: ['The sandbox service is not answering about this machine'], quiet: true };
  const node = async () =>
    sessionsLane((await f.board()).lanes.sessions.nodes).find((n) => n.key === key)!;
  assert.deepEqual((await node()).attention, quiet);
  assert.deepEqual((await node()).lines, [
    ['Running · ', { count: 5 }, ' failures'],
    ['on a Fleet VM'],
  ]);
  assert.equal((await f.board()).lanes.sessions.needsYou, 0);
  const panel = await f.panel(key);
  assert.deepEqual(panel.header, {
    kind: 'Fleet machine',
    title: 'Workflow agent',
    says: ['Running · ', { count: 5 }, ' failures'],
  });
  const facts = panel.sections.find(({ title }) => title === 'Fleet machine')!;
  assert.equal(facts.attention, undefined);
  assert.deepEqual(facts.kind === 'facts' && facts.rows, [
    { label: 'Status', value: [{ state: 'running' }] },
    { label: 'Time remaining', value: [{ until: a.deadlineAt }] },
    { label: 'Sandbox service', value: ['not answering'] },
    { label: 'Retries', value: [{ count: 5 }, ' failures'] },
    { label: 'Requested', value: [{ ago: a.createdAt }] },
  ]);
  const page = async () =>
    ((await f.ui.read(f.caller, 'fleet')) as Record<string, string | null>[])[0].attention;
  assert.equal(
    await page(),
    "The sandbox service is not answering about this machine. Check the project's sandbox connection.",
  );

  // The session bound to it takes that line in ink, and nobody is counted as needed.
  const dispose = f.ui.contribute({
    owner: 'sessions',
    kinds: ['session'],
    lanes: ['sessions'],
    nodes: async () => ({
      nodes: [
        {
          key: 'session:1',
          lane: 'sessions',
          title: 'Producer',
          lines: [['Last call'], ['on a Fleet VM']],
          look: 'solid',
          dot: 'moving',
          aliases: [key],
        },
      ],
    }),
  });
  t.after(dispose);
  const bound = async () => {
    const board = await f.board();
    return [board.lanes.sessions.nodes.map(({ key }) => key), board.lanes.sessions.needsYou];
  };
  const session = async () =>
    (await f.board()).lanes.sessions.nodes.find((n) => n.key === 'session:1')!;
  assert.deepEqual(await bound(), [['session:1'], 0]);
  assert.deepEqual((await session()).attention, quiet);

  // Past its lease the machine is gone as far as Fleet knows: now a person is needed.
  f.advance(30 * 60_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, machine.id)).phase, 'uncertain');
  const red = {
    says: ['This machine is not answering: the sandbox service keeps failing'],
    who: WHO,
  };
  assert.deepEqual((await session()).attention, red);
  assert.deepEqual(await bound(), [['session:1'], 1]);
  assert.match((await page())!, /^This machine is not answering:/);
});

test('a session that binds the machine absorbs its node, and the Fleet machine section follows the session sidebar without controls', async (t) => {
  const f = await fixture(t);
  f.runtimes.ready = true;
  const bound = await f.request('workflow', 'task_run:2');
  for (let tick = 0; tick < 3; tick++) await f.fleet.tick();
  f.runtimes.ready = false;
  const unbound = await f.request('workflow', 'task_1:1');
  await f.fleet.tick();
  const key = `fleet:${bound.id}`;
  const a = await f.fleet.inspect(f.caller, bound.id);
  assert.equal(a.phase, 'running');

  // Absorbed, only the machine's own facts are left: no status while it runs, no request time.
  const part = await f.absorbed(key, 'session:1');
  assert.deepEqual(part!.sections, [
    {
      title: 'Fleet machine',
      place: 'machine',
      kind: 'facts',
      rows: [{ label: 'Time remaining', value: [{ until: a.deadlineAt }] }],
    },
  ]);
  assert.deepEqual(part!.actions, []);

  const dispose = f.ui.contribute({
    owner: 'sessions',
    kinds: ['session'],
    lanes: ['sessions'],
    nodes: async () => ({
      nodes: [
        {
          key: 'session:1',
          lane: 'sessions',
          title: 'Producer',
          lines: [['on a Fleet VM']],
          look: 'solid',
          dot: 'live',
          aliases: [key],
          links: [{ to: 'work:task_run', verb: 'works on' }],
        },
      ],
    }),
    panel: async (_read, wanted) =>
      wanted === 'session:1'
        ? {
            header: { kind: 'Agent', title: 'Draft section 3.2', says: ['Active'] },
            sections: [
              {
                title: 'Lease',
                place: 'activity',
                kind: 'facts',
                rows: [{ label: 'Ends', value: [{ until: '2026-09-22T04:00:00Z' }] }],
              },
            ],
            actions: [
              {
                label: 'Halt lease',
                verb: 'halt',
                tool: 'session.halt',
                input: { sessionId: '1', reason: 'halted_by_operator' },
                allowed: true,
              },
            ],
            live: true,
            aliases: [key],
          }
        : null,
  });
  t.after(dispose);

  const board = await f.board();
  const lane = board.lanes.sessions.nodes;
  // The bound machine is drawn once, as its session, with the sandbox it holds.
  assert.deepEqual(
    lane.map(({ key }) => key),
    [`fleet:${unbound.id}`, 'session:1'],
  );
  assert.deepEqual(lane[1].aliases, ['sandbox:sbx_1', key]);
  assert.deepEqual(board.edges, []);

  const panel = await f.panel('session:1');
  assert.deepEqual(
    panel.sections.map(({ title, owner }) => [title, owner]),
    [
      ['Lease', 'sessions'],
      ['Fleet machine', 'fleet'],
    ],
  );
  assert.deepEqual(
    panel.actions.map(({ label }) => label),
    ['Halt lease'],
  );
  assert.deepEqual(panel.aliases, [key]);
  // Its own sidebar still answers, with what it was rented for.
  assert.deepEqual(
    (await f.panel(key)).sections.map(({ title }) => title),
    ['Rented for', 'Fleet machine'],
  );
});

test('the adapter takes its part of the Running page with it when it unloads', async (t) => {
  const f = await fixture(t);
  await f.request('workflow', 'task_1:1');
  assert.equal((await f.board()).lanes.sessions.nodes.length, 1);
  assert.deepEqual(
    f.ui.contributions().map(({ owner }) => owner),
    ['fleet'],
  );
  await f.adapter.dispose();
  assert.deepEqual(f.ui.contributions(), []);
  assert.equal(
    f.ui.rows().some((row) => row.id === 'fleet'),
    false,
  );
  assert.deepEqual((await f.board()).lanes.sessions.nodes, []);
});
