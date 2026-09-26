import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import {
  check,
  type Caller,
  type Json,
  type RunningAction,
  type RunningBoard,
  type RunningNode,
  type RunningPanel,
  type RunningPanelPart,
} from '@merv/contracts';
import { UiRegistry, type RunningContribution } from '@merv/ui';
import { runningBoard, runningPanel, type RunningSources } from '@merv/ui/running';
import { SandboxService, sandboxesPlugin, sandboxTools } from '../packages/sandboxes/src/index.js';
import { sandboxesToolsPlugin } from '../packages/sandboxes/src/tools.js';
import { sandboxesUiPlugin } from '../packages/sandboxes/src/ui.js';
import { createApp } from './fixtures/app.js';

/**
 * The Sandboxes part of the Running page: the machines cache the service fills on its own
 * timer, the Hardware lane's faces and reds, and a machine's sidebar with its controls. The
 * service is the in-process stand-in below, serving rows in the shapes scripts/fake-sandboxes.ts
 * serves, and counting every request that reaches it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const urlEnv = 'MERV_RUNNING_SANDBOXES_URL';
const tokenEnv = 'MERV_RUNNING_SANDBOXES_TOKEN';
const projectId = 'project_running';
const operator: Caller = { actorId: 'actor_operator', projectId };
const producer: Caller = { actorId: 'actor_producer', projectId };
const reader: Caller = { actorId: 'actor_reader', projectId };
const configuration = {
  urlEnv,
  connections: [{ projectId, namespace: 'demo', tokenEnv }],
  refreshMs: 3_600_000,
};
const WHO = 'A producer or operator extends or releases it.';
const train = 'python train.py --decay 1.0';

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
/**
 * One machine per line, in the positions scripts/fake-sandboxes.ts gives its seeds: name, state,
 * gpu, gpu count, vCPU, lease and clock in minutes from now, and the command a job runs.
 */
interface Extra {
  verdict?: string;
  /** A job that ended with this exit code, on an idle machine. */
  exit?: number;
  /** One of its connections is open. */
  open?: boolean;
  /** A hosted agent's machine, Fleet's and never the project's. */
  hosted?: boolean;
}
type Seed = readonly [
  name: string,
  state: string,
  gpu: string | null,
  gpus: number,
  cpu: number,
  lease: number | null,
  clock: number,
  command: string | null,
  extra?: Extra,
];
const evaluate = 'python eval.py --split held-out';
const seeds: Seed[] = [
  ['aurora-sweep', 'ready', 'H100', 8, 96, 160, -22, train, { open: true }],
  ['basalt-notebook', 'ready', 'A100', 1, 30, 181, -41, null, { exit: 1 }],
  ['cinder-provision', 'provisioning', 'H100', 4, 48, null, -4, null],
  ['dunes-eval', 'ready', 'L40S', 2, 32, 6, -9, evaluate],
  ['ember-retry', 'failed', 'H100', 8, 96, null, -21, null],
  ['flint-batch', 'stopped', null, 0, 16, -35, -35, null],
  ['gale-old', 'failed', 'A100', 1, 30, null, -90, null],
  ['harbor-lost', 'unknown', 'A100', 1, 30, 100, -3, null, { verdict: 'unreachable' }],
  ['iris-cpu', 'ready', null, 0, 16, 3, -12, null],
  ['merv-check-0123456789ab', 'ready', 'L4', 1, 8, 5, -2, 'sh check.sh'],
  ['agent', 'ready', null, 0, 2, 10, -1, null, { hosted: true }],
];
const idOf = (name: string) => `sbx_${name.split('-')[0]}`;
const keyOf = (name: string) => `sandbox:${idOf(name)}`;
const checkKey = keyOf('merv-check-0123456789ab');

function record(seed: Seed): Record<string, Json> {
  const [name, state, gpu, gpus, cpu, lease, clock, command, extra = {}] = seed;
  const short = name.split('-')[0];
  // As the fake says it: a failed machine reads unreachable, a ready one running or idle.
  const unready = state === 'failed' ? 'unreachable' : state;
  const verdict = extra.verdict ?? (state !== 'ready' ? unready : command ? 'running' : 'idle');
  const settled = state === 'ready' || state === 'stopped';
  const created = clock - (settled ? 58 : 5);
  const rate = gpu ? gpus * 4.05 : cpu * 0.0325;
  const spent = settled ? (rate * -(created + 4)) / 60 : 0;
  const priced = (amount: number) =>
    state === 'failed' ? null : { currency: 'USD', amount: amount.toFixed(3) };
  const clause =
    state === 'provisioning'
      ? `allocating ${gpus} ${gpu} in us-east-1`
      : state === 'failed'
        ? 'the provider returned capacity_unavailable twice'
        : (command ?? 'no job since the warmup finished');
  const job = (state: string, exit: number | null, finished: string | null, command: string) => ({
    name: `${short}-job`,
    state,
    exit_code: exit,
    finished_at: finished,
    command,
  });
  const jobs = command
    ? [job('running', null, null, command)]
    : extra.exit === undefined
      ? []
      : [job('failed', extra.exit, at(clock), 'python warmup.py')];
  const connection = (kind: string, from: string, minutes: number, outcome: string | null) => ({
    kind,
    remote_addr: from,
    started_at: at(clock - minutes),
    outcome,
  });
  return {
    id: idOf(name),
    revision: 0,
    name,
    plugin: 'runpod',
    state,
    offer: { instance_type: `gpu-${gpus}x`, region: 'us-east-1' },
    resources: {
      gpu,
      gpu_count: gpus,
      gpu_memory_mb: gpu && gpus * 81920,
      cpu,
      memory_mb: cpu * (gpu ? 15360 : 4096),
    },
    lease_expires_at: lease === null ? null : at(lease),
    lease_seconds: lease === null ? null : gpu ? 14400 : 3600,
    cost_so_far: priced(spent),
    hourly_price: priced(rate),
    activity: { verdict, clause, at: at(clock) },
    // The service's own reason, which is not what the page calls red.
    attention: lease !== null && lease < 15 ? `lease ends in ${lease}m` : null,
    ...(extra.hosted ? { request: { protected_runtime: true } } : {}),
    created_at: at(created),
    endpoint: { host: `${short}.invalid`, port: 2222, token: 'sbxt_fake_endpoint_grant' },
    jobs,
    sessions: [
      connection('ssh', '203.0.113.24', 5, 'closed'),
      connection('exec', '198.51.100.7', 2, extra.open ? 'open' : null),
    ],
  };
}
const recordOnly = ['created_at', 'endpoint', 'jobs', 'sessions'];
const listRow = (value: Record<string, Json>) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !recordOnly.includes(key)));
const manifest = {
  version: 1,
  rows: [
    {
      id: 'sandboxes',
      label: 'Sandboxes',
      group: 'operations',
      order: 45,
      icon: 'code',
      collection: {
        noun: { singular: 'sandbox', plural: 'sandboxes' },
        read: '/v1/sandboxes',
        key: 'id',
        title: 'name',
        columns: [{ label: 'Sandbox', type: 'name', field: 'name' }],
        empty: { title: 'No sandboxes', hint: 'A sandbox appears while a machine is leased.' },
      },
      record: { read: '/v1/sandboxes/{id}', title: 'name' },
    },
  ],
};

/**
 * The service's stand-in: its list, its records, its renewal and its deletion, as
 * scripts/fake-sandboxes.ts settles the two acts, and every path asked of it. A list read is
 * answered as it stood when it arrived, and `held` keeps that answer back.
 */
async function service(t: TestContext) {
  const seen: string[] = [];
  const control: { down: boolean; held?: Promise<void> } = { down: false };
  const changed = new Map<string, Record<string, Json>>();
  const current = (seed: Seed) => ({ ...record(seed), ...changed.get(idOf(seed[0])) });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    let text = '';
    for await (const chunk of request) text += String(chunk);
    seen.push(`${request.method} ${path}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (path === '/v1/auth/me') return send(200, { role: 'consumer', namespace: 'demo' });
    if (path === '/v1/ui/manifest') return send(200, manifest);
    if (path === '/v1/sandboxes') {
      if (control.down) return send(503, { error: { code: 'unavailable', message: 'down' } });
      const body = { sandboxes: seeds.map((seed) => listRow(current(seed))) };
      await control.held;
      return send(200, body);
    }
    const seed = seeds.find(([name]) => path.startsWith(`/v1/sandboxes/${idOf(name)}`));
    if (!seed) return send(404, { error: { code: 'not_found', message: 'No such sandbox' } });
    const id = idOf(seed[0]);
    const revision = Number(current(seed).revision) + 1;
    if (request.method === 'POST') {
      // The service renews to now + lease_seconds; it never adds to what is left.
      const seconds = Number(JSON.parse(text).lease_seconds);
      changed.set(id, {
        ...changed.get(id),
        revision,
        lease_expires_at: at(seconds / 60),
        lease_seconds: seconds,
      });
    }
    if (request.method === 'DELETE')
      changed.set(id, { ...changed.get(id), revision, state: 'deleting' });
    return send(200, current(seed));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env[urlEnv] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env[tokenEnv] = 'sbxt_running_consumer_grant';
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
    delete process.env[urlEnv];
    delete process.env[tokenEnv];
  });
  const lists = () => seen.filter((entry) => entry === 'GET /v1/sandboxes').length;
  const records = (id: string) =>
    seen.filter((entry) => entry === `GET /v1/sandboxes/${id}`).length;
  return { seen, control, lists, records };
}

/** Waits on real time for what the service's timer started, however its clock is set. */
async function until(done: () => boolean, what: string): Promise<void> {
  const start = performance.now();
  while (!done()) {
    assert.ok(performance.now() - start < 8000, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const roles: Record<string, string[]> = {
  actor_operator: ['read', 'write', 'admin'],
  actor_producer: ['read', 'write'],
  actor_reader: ['read'],
};
/**
 * The service and its ui adapter composed as the application composes them, over a scope that
 * knows three roles, and the two Running reads over them.
 */
async function composed(t: TestContext) {
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('ui', ui);
  ctx.provide('scope', {
    require: async (caller: Caller, permission: string) =>
      check(roles[caller.actorId]?.includes(permission), 'forbidden', 'Not permitted', 403),
  } as never);
  const fiber = ctx.plugin(sandboxesPlugin, configuration);
  ctx.plugin(sandboxesUiPlugin);
  t.after(() => ctx.fiber.dispose());
  await fiber.await();
  await ctx.sandboxes.refresh();
  const sources = (...more: RunningContribution[]): RunningSources => ({
    contributions: () =>
      [...ui.contributions(), ...more].sort((a, b) => (a.owner < b.owner ? -1 : 1)),
    tools: async () => sandboxTools,
  });
  const board = async (caller = operator, ...more: RunningContribution[]) =>
    await runningBoard(sources(...more), caller);
  const panel = async (key: string, caller = operator, ...more: RunningContribution[]) =>
    await runningPanel(sources(...more), caller, key);
  const own = ui.contributions().find(({ owner }) => owner === 'sandboxes')!;
  const filled = async () =>
    await until(() => ctx.sandboxes.machines(projectId) !== null, 'the machines');
  return { ctx, ui, board, panel, own, filled };
}
/** Each instant read as whole minutes from now, the way the seeds wrote it. */
const minutes = (value: unknown): any =>
  JSON.parse(JSON.stringify(value), (key, entry) =>
    ['since', 'until', 'ago'].includes(key) && typeof entry === 'string'
      ? Math.round((Date.parse(entry) - Date.now()) / 60_000)
      : entry,
  );
/** The service's timer and clock move only when a test moves them. */
const frozen = (t: TestContext) =>
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
const hardware = (answer: RunningBoard) => answer.lanes.hardware.nodes;
const nodeOf = (answer: RunningBoard, key: string) =>
  hardware(answer).find((node) => node.key === key);
const labels = (actions: readonly RunningAction[]) => actions.map(({ label }) => label);
const titles = (answer: RunningPanel | RunningPanelPart) =>
  answer.sections.map(({ title }) => title);
const rows = (answer: RunningPanel | RunningPanelPart, title: string) => {
  const section = answer.sections.find((candidate) => candidate.title === title);
  assert.ok(section?.kind === 'facts', `${title} is a facts section`);
  return section.rows;
};

test('the first board read asks the service nothing and draws the lane as not yet known; the timer then fills it', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, filled } = await composed(t);
  const before = remote.seen.length;
  const cold = await board();
  assert.equal(remote.seen.length, before, 'no request reaches the service inside a board read');
  assert.deepEqual(cold.lanes.hardware.nodes, []);
  assert.equal(cold.lanes.hardware.pending, true, 'nothing known yet is not nothing running');
  assert.equal(cold.lanes.hardware.asOf, undefined);
  assert.deepEqual(cold.lanes.hardware.failed, []);
  assert.equal(remote.lists(), 0);

  t.mock.timers.tick(1000);
  await filled();
  assert.equal(remote.lists(), 1);
  const since = remote.seen.length;
  const warm = await board();
  assert.equal(remote.seen.length, since, 'a filled cache is read from memory too');
  assert.equal(warm.lanes.hardware.pending, undefined);
  assert.ok(Date.parse(warm.lanes.hardware.asOf!) <= Date.now());
  // Machines are provisioning and running jobs, so the list is read every 5 s and current for 10.
  assert.equal(warm.lanes.hardware.freshForMs, 10_000);
  assert.equal(hardware(warm).length, 8);
});

test('the lane draws each machine in flight by what it is, what it does and what it costs', async (t) => {
  frozen(t);
  await service(t);
  const { board, filled } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const answer = await board();
  const rate = (amount: string) => [{ money: null, rate: { amount, currency: 'USD' } }];
  assert.deepEqual(minutes(nodeOf(answer, keyOf('aurora-sweep'))), {
    key: keyOf('aurora-sweep'),
    lane: 'hardware',
    title: '8× H100',
    name: 'aurora-sweep',
    lines: [['Running ', { since: -22 }], rate('32.400')],
    look: 'solid',
    units: { count: 8, busy: true },
    rank: 0,
    owner: 'sandboxes',
  });
  assert.deepEqual(minutes(nodeOf(answer, keyOf('basalt-notebook'))), {
    key: keyOf('basalt-notebook'),
    lane: 'hardware',
    title: 'A100',
    name: 'basalt-notebook',
    lines: [['Idle ', { since: -41 }], rate('4.050')],
    look: 'solid',
    units: { count: 1, busy: false },
    rank: 2,
    owner: 'sandboxes',
  });
  assert.deepEqual(minutes(nodeOf(answer, keyOf('cinder-provision'))), {
    key: keyOf('cinder-provision'),
    lane: 'hardware',
    title: '4× H100',
    name: 'cinder-provision',
    lines: [['Provisioning ', { since: -4 }], rate('16.200')],
    look: 'dashed',
    units: { count: 4, busy: false },
    rank: 1,
    owner: 'sandboxes',
  });
  assert.equal(nodeOf(answer, keyOf('iris-cpu'))!.title, 'CPU · 16 vCPU');
  assert.deepEqual(nodeOf(answer, keyOf('iris-cpu'))!.lines[1], rate('0.520'));
  // A failed machine has no price; its face has no rate line rather than a made-up one.
  assert.deepEqual(nodeOf(answer, keyOf('ember-retry'))!.lines, [['Failed']]);
  for (const name of ['flint-batch', 'gale-old', 'agent'])
    assert.equal(
      nodeOf(answer, keyOf(name)),
      undefined,
      `${name} is not in flight, or not the project's`,
    );
  assert.ok(hardware(answer).every((node) => node.dot === undefined && !node.links));
  assert.doesNotMatch(JSON.stringify(answer), /sbxt_|203\.0\.113/);
});

test("red is a person's move: failed within the hour, connection lost, a running job whose lease runs out; idle and Code's check machines stay ink", async (t) => {
  frozen(t);
  await service(t);
  const { board, filled } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const answer = await board();
  assert.deepEqual(minutes(nodeOf(answer, keyOf('dunes-eval'))!.attention), {
    says: ['Lease ', { until: 6 }],
    who: WHO,
  });
  assert.deepEqual(minutes(nodeOf(answer, keyOf('ember-retry'))!.attention), {
    says: ['Failed ', { ago: -21 }],
    who: WHO,
  });
  assert.deepEqual(nodeOf(answer, keyOf('harbor-lost'))!.attention, {
    says: ['Connection lost'],
    who: WHO,
  });
  // Idle bills but may hold an open shell the list cannot see; a lapsing lease with no job is
  // the machine going away as it should; Code gives its own check machines back.
  for (const name of ['basalt-notebook', 'iris-cpu', 'aurora-sweep', 'merv-check-0123456789ab'])
    assert.equal(nodeOf(answer, keyOf(name))!.attention, undefined, name);
  assert.deepEqual(
    hardware(answer).map(({ key }) => key),
    [
      'dunes-eval',
      'ember-retry',
      'harbor-lost',
      'aurora-sweep',
      'merv-check-0123456789ab',
      'cinder-provision',
      'basalt-notebook',
      'iris-cpu',
    ].map(keyOf),
  );
  assert.equal(answer.lanes.hardware.needsYou, 3);
});

test("the lane's own line is what the sandboxes drawn cost per hour together", async (t) => {
  frozen(t);
  await service(t);
  const { board, filled } = await composed(t);
  const cold = await board();
  assert.deepEqual(cold.lanes.hardware.summaries, [], 'no total before any machine is known');
  t.mock.timers.tick(1000);
  await filled();
  const answer = await board();
  // 8× H100, A100, 4× H100, 2× L40S, the unreachable A100, 16 vCPU and the check's L4.
  assert.deepEqual(answer.lanes.hardware.summaries, [
    {
      lane: 'hardware',
      says: ['Sandboxes ', { money: null, rate: { amount: '69.3700', currency: 'USD' } }],
      actions: [],
      owner: 'sandboxes',
    },
  ]);
});

test('a sidebar reads cost, lease and size at once, and what runs and what holds it open once its record is read', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, panel, filled, ctx } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const key = keyOf('aurora-sweep');
  const first = await panel(key);
  assert.deepEqual(minutes(first.header), {
    kind: 'Sandbox',
    title: 'aurora-sweep',
    says: ['Running', ' · ', { since: -22 }],
  });
  assert.deepEqual(
    titles(first),
    ['Now', 'Machine'],
    'until the record is read, only what the list says',
  );
  const aurora = record(seeds[0]);
  assert.deepEqual(minutes(rows(first, 'Now')), [
    { label: 'Cost so far', value: [{ money: aurora.cost_so_far, rate: aurora.hourly_price }] },
    { label: 'Lease', value: [{ until: 160, of: 14400 }] },
  ]);
  assert.deepEqual(rows(first, 'Machine'), [
    { label: 'Size', value: ['8× H100 · 96 vCPU · 1,440 GB'] },
    { label: 'Provider', value: ['runpod · us-east-1'] },
  ]);
  assert.equal(first.route, '/sandboxes/sbx_aurora');
  assert.equal(first.live, true);
  assert.equal(remote.records('sbx_aurora'), 0, 'the sidebar read itself asks the service nothing');

  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_aurora') !== null, 'the record');
  const second = await panel(key);
  assert.deepEqual(titles(second), ['Now', 'Running', 'Used by', 'Machine']);
  assert.deepEqual(rows(second, 'Running'), [{ label: 'Command', value: [{ mono: train }] }]);
  assert.deepEqual(rows(second, 'Used by'), [
    { label: 'Connections', value: [{ count: 1 }, ' open'] },
  ]);
  assert.doesNotMatch(JSON.stringify(second), /sbxt_|203\.0\.113|198\.51\.100/);

  // An idle machine says how its last job ended; its record holds no open connection.
  await panel(keyOf('basalt-notebook'));
  t.mock.timers.tick(8000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_basalt') !== null, 'the idle record');
  const idle = await panel(keyOf('basalt-notebook'));
  assert.deepEqual(titles(idle), ['Now', 'Running', 'Machine']);
  assert.deepEqual(minutes(rows(idle, 'Running')), [
    { label: 'Last exit', value: ['exit 1', ' · ', { ago: -41 }] },
  ]);
  assert.equal(idle.live, false);

  // A running job under a short lease: the lease is why the sidebar is red, and it reads first.
  const dunes = await panel(keyOf('dunes-eval'));
  assert.equal(dunes.header.attention?.says[0], 'Lease ');
  assert.equal(dunes.sections[0].title, 'Now');
  assert.equal(dunes.sections[0].attention, true);
  assert.equal(rows(dunes, 'Now')[1].attention, true);
  // A failed machine's sidebar says why it failed, which its card leaves out.
  assert.deepEqual(minutes((await panel(keyOf('ember-retry'))).header.attention), {
    says: [
      'Failed',
      ' · ',
      'the provider returned capacity_unavailable twice',
      ' · ',
      { ago: -21 },
    ],
    who: WHO,
  });
  await assert.rejects(panel(keyOf('agent')), { code: 'running_not_found' });
  await assert.rejects(panel('sandbox:sbx_nowhere'), { code: 'running_not_found' });
});

test("Extend lease and Release machine follow the tools' write permission, and Release says what stops", async (t) => {
  frozen(t);
  await service(t);
  const { board, panel, filled, ctx } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const key = keyOf('aurora-sweep');
  const before = await panel(key, producer);
  assert.deepEqual(labels(before.actions), ['Extend lease', 'Release machine']);
  assert.deepEqual(before.actions[0], {
    label: 'Extend lease',
    verb: 'extend',
    tool: 'sandbox.extend',
    input: { id: 'sbx_aurora', seconds: 3600 },
    allowed: true,
  });
  assert.deepEqual(before.actions[1].input, { id: 'sbx_aurora' });
  assert.deepEqual(before.actions[1].guard, {
    title: 'Release this machine?',
    consequence:
      'Deletes this 8× H100 at runpod now, and the job running on it stops with it. Retained job logs stay readable.',
  });
  assert.equal(before.actions[1].primary, undefined, 'a release never wears the accent');
  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_aurora') !== null, 'the record');
  const named = await panel(key, operator);
  assert.equal(
    named.actions[1].guard?.consequence,
    `Deletes this 8× H100 at runpod now, and ${train} stops with it. Retained job logs stay readable.`,
  );
  assert.deepEqual((await panel(key, reader)).actions, [], 'a reader is offered nothing');

  // Extend only while ready; Release while the service still leases the machine.
  assert.deepEqual(labels((await panel(keyOf('cinder-provision'))).actions), ['Release machine']);
  assert.deepEqual(labels((await panel(keyOf('harbor-lost'))).actions), ['Release machine']);
  // A failed provision may never have been allocated, and the service releases only what it
  // leases: no guard says it deletes an 8× H100 that never was. Its red still names who acts.
  const failed = await panel(keyOf('ember-retry'));
  assert.deepEqual(failed.actions, []);
  assert.equal(failed.header.attention?.who, WHO);
  // Releasing a check machine fails the check; Code gives it back itself.
  assert.deepEqual((await panel(checkKey)).actions, []);
});

test('a sidebar opened before the machines are read says they are not read yet, not Not found, and its record is read once they are', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, panel, ctx } = await composed(t);
  const key = keyOf('aurora-sweep');
  const before = remote.seen.length;
  // A link to a sidebar reads the board and the sidebar together, before anything is known.
  assert.equal((await board()).lanes.hardware.pending, true);
  await assert.rejects(panel(key), { code: 'sandbox_machines_pending', status: 503 });
  await assert.rejects(panel('sandbox:sbx_nowhere'), { code: 'sandbox_machines_pending' });
  assert.equal(remote.seen.length, before, 'neither read asks the service anything');

  // The list is read first, and the ids the sidebars asked for wait for it.
  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machines(projectId) !== null, 'the machines');
  assert.equal(remote.records('sbx_aurora'), 0);
  // The next pass reads the record the list holds, with no sidebar read in between, and never
  // the id it does not hold.
  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_aurora') !== null, 'the record');
  assert.equal(remote.records('sbx_nowhere'), 0);
  assert.deepEqual(titles(await panel(key)), ['Now', 'Running', 'Used by', 'Machine']);
  await assert.rejects(panel('sandbox:sbx_nowhere'), { code: 'running_not_found' });

  // A tab hidden for more than a minute: the machines are forgotten, and the sidebar it comes
  // back to waits for them again.
  t.mock.timers.tick(60_000);
  assert.equal(ctx.sandboxes.machines(projectId), null);
  await assert.rejects(panel(key), { code: 'sandbox_machines_pending' });
});

test('after Extend lease the sidebar and the board read the answer at once, and the timer reads again on its next pass', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, panel, filled, ctx } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const key = keyOf('dunes-eval');
  await panel(key);
  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_dunes') !== null, 'the record');
  const short = await panel(key, producer);
  assert.deepEqual(minutes(rows(short, 'Now')[1]), {
    label: 'Lease',
    value: [{ until: 6, of: 14400 }],
    attention: true,
  });

  // A job runs with 6 minutes of lease left; Extend lease adds an hour to what is left.
  const lists = remote.lists();
  const records = remote.records('sbx_dunes');
  await ctx.sandboxes.extend(producer, { id: 'sbx_dunes', seconds: 3600 });
  const extended = await panel(key, producer);
  assert.equal(extended.header.attention, undefined, 'the lease is no longer red');
  assert.deepEqual(minutes(rows(extended, 'Now')[1]), {
    label: 'Lease',
    value: [{ until: 66, of: 3960 }],
  });
  assert.equal(extended.sections[0].attention, undefined);
  assert.deepEqual(labels(extended.actions), ['Extend lease', 'Release machine']);
  assert.equal(nodeOf(await board(), key)!.attention, undefined, 'nor is the machine on the board');
  // The extend read the record once itself; the timer reads both again a second later.
  assert.equal(remote.records('sbx_dunes'), records + 1);
  t.mock.timers.tick(1000);
  await until(
    () => remote.lists() === lists + 1 && remote.records('sbx_dunes') === records + 2,
    'the reads after the act',
  );
});

test('after Release machine the machine reads Releasing at once, and a list read already out when it landed is dropped', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, panel, filled, ctx } = await composed(t);
  await board();
  t.mock.timers.tick(1000);
  await filled();
  const key = keyOf('basalt-notebook');
  await panel(key);
  t.mock.timers.tick(1000);
  await until(() => ctx.sandboxes.machine(projectId, 'sbx_basalt') !== null, 'the record');
  assert.deepEqual(labels((await panel(key, producer)).actions), [
    'Extend lease',
    'Release machine',
  ]);

  // A list read goes out and its answer, the machine still idle, is held back.
  let free = () => {};
  const hold = () => (remote.control.held = new Promise<void>((resolve) => (free = resolve)));
  hold();
  const lists = remote.lists();
  t.mock.timers.tick(4000);
  await until(() => remote.lists() === lists + 1, 'a list read out');
  const answer = await ctx.sandboxes.release(producer, { id: 'sbx_basalt' });
  assert.equal((answer as { state?: string }).state, 'deleting');
  // The idle answer lands after the release; the next read waits for it, and is held too.
  const stale = free;
  hold();
  stale();
  for (let pass = 0; remote.lists() < lists + 2; pass++) {
    assert.ok(pass < 100, 'the next list read starts');
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const sidebar = await panel(key, producer);
  assert.deepEqual(sidebar.header.says, ['Releasing']);
  assert.deepEqual(sidebar.actions, [], 'nothing is offered twice');
  assert.equal(sidebar.live, true);
  const node = nodeOf(await board(), key)!;
  assert.deepEqual(node.lines[0], ['Releasing']);
  assert.equal(node.look, 'quiet');
  free();
});

test("folded into a Code check, a machine adds its cost and size to the check's sidebar, without its lease or controls", async (t) => {
  frozen(t);
  await service(t);
  const { board, panel, filled, own } = await composed(t);
  const code: RunningContribution = {
    owner: 'code-research',
    kinds: ['check'],
    lanes: ['hardware'],
    nodes: async () => ({
      nodes: [
        {
          key: 'check:base',
          lane: 'hardware',
          title: 'Code check',
          lines: [['Running']],
          look: 'solid',
          aliases: [checkKey],
        } satisfies RunningNode,
      ],
    }),
    panel: async (_read, key) =>
      key === 'check:base'
        ? {
            header: { kind: 'Code check', title: 'npm test', says: ['Running'] },
            sections: [
              {
                title: 'Check',
                place: 'activity',
                kind: 'facts',
                rows: [{ label: 'Phase', value: ['Running'] }],
              },
            ],
            actions: [],
            live: true,
            aliases: [checkKey],
          }
        : null,
  };
  await board(operator, code);
  t.mock.timers.tick(1000);
  await filled();
  const answer = await board(operator, code);
  assert.equal(nodeOf(answer, checkKey), undefined, 'the same machine is never drawn twice');
  assert.deepEqual(nodeOf(answer, 'check:base')?.aliases, [checkKey]);
  assert.equal(nodeOf(answer, 'check:base')?.attention, undefined);

  const sidebar = await panel('check:base', operator, code);
  assert.deepEqual(
    sidebar.sections.map(({ title, owner }) => `${owner} ${title}`),
    ['code-research Check', 'sandboxes Now', 'sandboxes Machine'],
  );
  assert.deepEqual(
    rows(sidebar, 'Now').map(({ label }) => label),
    ['Cost so far'],
    "the check's timeout is its clock, not the machine's lease",
  );
  assert.deepEqual(sidebar.actions, []);
  const folded = await own.panel!(
    { caller: operator, include: new Set(), once: async (_name, read) => await read() },
    keyOf('dunes-eval'),
    'check:base',
  );
  assert.deepEqual(folded?.actions, []);
  assert.deepEqual(titles(folded!), ['Now', 'Machine']);
});

test('a failed refresh keeps the rows it had, says the lane failed and keeps their age', async (t) => {
  frozen(t);
  const remote = await service(t);
  const { board, ctx } = await composed(t);
  const machines = () => ctx.sandboxes.machines(projectId);
  // A service that never answered: nothing is known, and the lane says its part failed.
  remote.control.down = true;
  await board();
  t.mock.timers.tick(1000);
  await until(() => machines()?.failed === true, 'the first refresh');
  const never = await board();
  assert.deepEqual(never.lanes.hardware.failed, ['sandboxes']);
  assert.deepEqual(hardware(never), []);
  assert.equal(never.lanes.hardware.asOf, undefined);
  assert.equal(never.lanes.hardware.pending, undefined, 'a failure is known, and not polled for');

  // A failed read is tried again at the fast cadence, and an answer clears the failure.
  remote.control.down = false;
  t.mock.timers.tick(5000);
  await until(() => machines()?.failed === false, 'the second refresh');
  const read = await board();
  assert.deepEqual(read.lanes.hardware.failed, []);
  assert.equal(hardware(read).length, 8);

  remote.control.down = true;
  t.mock.timers.tick(5000);
  await until(() => machines()?.failed === true, 'the third refresh');
  const answer = await board();
  assert.deepEqual(answer.lanes.hardware.failed, ['sandboxes']);
  assert.equal(answer.lanes.hardware.asOf, read.lanes.hardware.asOf);
  assert.deepEqual(
    hardware(answer).map(({ key }) => key),
    hardware(read).map(({ key }) => key),
  );
  assert.equal(remote.lists(), 3);
});

test('reads stop a minute after the last watch, a record is read only for a machine the list holds, and close() stops the timer', async (t) => {
  frozen(t);
  const remote = await service(t);
  const sandboxes = new SandboxService(configuration);
  t.after(() => sandboxes.close());
  assert.throws(() => sandboxes.machines('project_other'), { code: 'sandbox_not_connected' });
  sandboxes.watch('project_other');
  sandboxes.watch(projectId, 'sbx_aurora');
  assert.equal(sandboxes.machines(projectId), null);
  t.mock.timers.tick(1000);
  await until(() => sandboxes.machines(projectId) !== null, 'the machines');
  assert.equal(remote.records('sbx_aurora'), 0, 'an id the list has not shown is not read');
  // Machines are changing, so the list is read again 5 s later, and the watched record 8 s.
  sandboxes.watch(projectId, 'sbx_aurora');
  sandboxes.watch(projectId, 'sbx_invented');
  t.mock.timers.tick(5000);
  await until(() => remote.lists() === 2 && remote.records('sbx_aurora') === 1, 'the second pass');
  assert.equal(remote.records('sbx_invented'), 0);
  assert.equal(sandboxes.machines(projectId)?.freshForMs, 10_000);

  // Nothing watches for a minute: the project is forgotten and the timer goes with it.
  for (let second = 0; second < 60; second++) {
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sandboxes.machines(projectId), null);
  // A read started just before the minute ran out still lands.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const settled = remote.seen.length;
  t.mock.timers.tick(120_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remote.seen.length, settled, 'nothing is read once nobody watches');

  sandboxes.watch(projectId);
  await sandboxes.close();
  sandboxes.watch(projectId);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remote.seen.length, settled, 'a closed service reads nothing');
});

test("the shipped fake's machines read the way the design draws them", async (t) => {
  const child = spawn('node', ['--import', 'tsx', 'scripts/fake-sandboxes.ts'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => void child.kill());
  const [ready] = (await once(child.stdout, 'data')) as [Buffer];
  process.env[urlEnv] = new URL(JSON.parse(ready.toString()).url).origin;
  process.env[tokenEnv] = 'sbxt_demo_consumer';
  t.after(() => {
    delete process.env[urlEnv];
    delete process.env[tokenEnv];
  });
  const { board, filled } = await composed(t);
  await board();
  await filled();
  const answer = await board();
  const face = (name: string) => {
    const node = nodeOf(answer, `sandbox:sbx_${name}`);
    assert.ok(node, name);
    return [node.title, node.lines[0][0], node.attention?.says[0] ?? null];
  };
  assert.deepEqual(face('aurora'), ['8× H100', 'Running ', null]);
  assert.deepEqual(face('basalt'), ['A100', 'Idle ', null]);
  assert.deepEqual(face('cinder'), ['4× H100', 'Provisioning ', null]);
  assert.deepEqual(face('dunes'), ['2× L40S', 'Running ', 'Lease ']);
  assert.deepEqual(face('ember'), ['8× H100', 'Failed', 'Failed ']);
  assert.equal(nodeOf(answer, 'sandbox:sbx_flint'), undefined);
  assert.equal(answer.lanes.hardware.needsYou, 2);
});

test('the assembled application draws the machines from memory inside the read-only tools, with controls only for writers', async (t) => {
  const remote = await service(t);
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-sandboxes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry,
      ) as never,
    },
  });
  t.after(() => app.stop());
  const credentials = await app.ctx.scope.bootstrap({ projectName: 'Machines', actorName: 'Op' });
  const owner = { actorId: credentials.actor.id, projectId: credentials.project.id };
  const token = async (role: 'producer' | 'reader') =>
    (await app.ctx.scope.issueActor(owner, { name: role, role })).token;
  const tokens = {
    operator: credentials.token,
    producer: await token('producer'),
    reader: await token('reader'),
  };
  // Composed after boot, as the demo composes it, for the project it just made.
  const fiber = app.ctx.plugin(sandboxesPlugin, {
    ...configuration,
    connections: [{ projectId: owner.projectId, namespace: 'demo', tokenEnv }],
  });
  app.ctx.plugin(sandboxesToolsPlugin);
  app.ctx.plugin(sandboxesUiPlugin);
  await fiber.await();
  await app.ctx.sandboxes.refresh();
  const tool = async (name: string, bearer: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  const before = remote.seen.length;
  const cold = await tool('ui.running', tokens.reader);
  assert.equal(cold.status, 200);
  assert.equal(remote.seen.length, before, 'the tool call itself asks the service nothing');
  assert.equal((cold.body.result as RunningBoard).lanes.hardware.pending, true);
  await until(() => app.ctx.sandboxes.machines(owner.projectId) !== null, 'the machines');
  const warm = (await tool('ui.running', tokens.reader)).body.result as RunningBoard;
  assert.equal(hardware(warm).length, 8);
  assert.deepEqual(warm.lanes.hardware.failed, []);
  assert.equal(warm.lanes.hardware.needsYou, 3);

  const key = keyOf('aurora-sweep');
  const offered = async (bearer: string) => {
    const answer = await tool('ui.running_panel', bearer, { key });
    assert.equal(answer.status, 200);
    return labels((answer.body.result as RunningPanel).actions);
  };
  assert.deepEqual(await offered(tokens.operator), ['Extend lease', 'Release machine']);
  assert.deepEqual(await offered(tokens.producer), ['Extend lease', 'Release machine']);
  assert.deepEqual(await offered(tokens.reader), []);
  // The input the sidebar carries is the tool's own input, sent as it is.
  const panel = (await tool('ui.running_panel', tokens.producer, { key })).body
    .result as RunningPanel;
  const extend = await tool('sandbox.extend', tokens.producer, panel.actions[0].input);
  assert.equal(extend.status, 200);
  assert.ok(remote.seen.includes('POST /v1/sandboxes/sbx_aurora/renew'));
});
