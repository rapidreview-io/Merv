/**
 * Fake merv-sandboxes control plane for the browser demo and the plugin tests. No
 * dependencies and almost no state: every instant is computed per request, so leases tick,
 * and the only thing remembered is what the two lifecycle calls changed.
 *
 *   PORT=3210 node --import tsx scripts/fake-sandboxes.ts
 *
 * Routes: GET /v1/auth/me, /v1/ui/manifest, /v1/sandboxes and /v1/sandboxes/{id}, plus
 * POST /v1/sandboxes/{id}/renew and DELETE /v1/sandboxes/{id}. Every request needs
 * `authorization: Bearer sbxt_...` and a matching `x-sandbox-namespace`
 * (`demo`, or FAKE_SANDBOXES_NAMESPACE); anything else gets the service's error envelope.
 * The list answers `{ sandboxes: [...] }`, keyed by the plural noun; the record answers one
 * object, to which the plugin adds `console_origin`. Money is a { currency, amount } pair
 * whose amount is a decimal string, an unavailable value is null rather than an absent key,
 * and `endpoint.token` is bait: the plugin strips it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const port = Number(process.env.PORT ?? 3210);
const namespace = process.env.FAKE_SANDBOXES_NAMESPACE ?? 'demo';
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

type Json = Record<string, unknown>;
type S = string;
type N = number;
const col = (label: string, rest: Json) => ({ label, ...rest });
const text = (label: string, field: string) => col(label, { type: 'text', field });
const ago = (label: string, field: string) => col(label, { type: 'ago', field });
const list = (title: S, field: S, columns: Json[]) => ({ title, kind: 'list', field, columns });
const act = (id: string, label: string, verb: string, tool: string, on: string[], rest: Json) => ({
  id,
  label,
  verb,
  tool,
  when: { field: 'state', in: on },
  ...rest,
});

const live = { verdict: 'activity.verdict', clause: 'activity.clause', clock: 'activity.at' };
const moving = ['provisioning', 'deleting'];
const both = ['provisioning', 'ready'];
const states = { field: 'state', open: both, live: moving, failed: ['failed'] };
const amounts = { total: 'cost_so_far.amount', rate: 'hourly_price.amount', currency: 'USD' };
const money = { type: 'money', ...amounts };
const consoleHref = '/ui/sandboxes/{id}';

/** The manifest the sandboxes team emits: what a row holds, never how it looks. */
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
        search: ['name', 'plugin', 'offer.instance_type', 'offer.region'],
        states,
        attention: { field: 'attention' },
        columns: [
          col('Sandbox', { type: 'name', field: 'name' }),
          col('State', { type: 'state', field: 'state' }),
          col('Hardware', {
            type: 'phrase',
            separator: ' ',
            fields: [
              { field: 'resources.gpu_count', suffix: '×' },
              { field: 'resources.gpu' },
              { field: 'resources.cpu', suffix: ' vCPU' },
              { field: 'resources.memory_mb', unit: 'mib' },
              '·',
              { field: 'offer.region' },
            ],
          }),
          col('Lease', { type: 'countdown', field: 'lease_expires_at', granted: 'lease_seconds' }),
          col('Cost', money),
        ],
        liveness: live,
        empty: { title: 'No sandboxes', hint: 'A sandbox appears while a machine is leased.' },
        cadence: { liveMs: 5000, idleMs: 30000, liveWhen: { field: 'state', in: moving } },
      },
      record: {
        read: '/v1/sandboxes/{id}',
        title: 'name',
        state: 'state',
        standing: live,
        act: [
          act('extend', 'Extend 1 hour', 'extend', 'sandbox.extend', ['ready'], {
            args: { seconds: 3600 },
          }),
          act('release', 'Release the machine', 'release', 'sandbox.release', both, {
            guard: {
              title: 'Release this machine?',
              consequence:
                'The machine is deleted at the provider. Retained job logs stay readable; nothing else in the record changes.',
            },
          }),
        ],
        content: list('Jobs', 'jobs', [
          text('Job', 'name'),
          text('Command', 'command'),
          col('State', { type: 'state', field: 'state' }),
          ago('Finished', 'finished_at'),
        ]),
        history: [
          { title: 'Provisioning', kind: 'ladder', field: 'ladder', step: 'step', state: 'state' },
          list('Events', 'events', [text('Event', 'summary'), ago('When', 'at')]),
          list('Sessions', 'sessions', [
            text('Kind', 'kind'),
            text('From', 'remote_addr'),
            ago('Started', 'started_at'),
            text('Outcome', 'outcome'),
          ]),
        ],
        details: [
          { label: 'SSH', field: 'ssh_command', mono: true },
          { label: 'Host key', field: 'host_key_fingerprint', mono: true },
          { label: 'Machine', field: 'offer.instance_type', mono: true },
          { label: 'Region', field: 'offer.region' },
          { label: 'Rate', field: 'hourly_price.amount' },
          { label: 'Provider', field: 'native_id', mono: true },
          { label: 'Created', field: 'created_at', unit: 'instant' },
          { label: 'Lease ends', field: 'lease_expires_at', unit: 'instant' },
        ],
        console: { label: 'Open in the sandbox console', href: consoleHref },
      },
    },
  ],
};

/**
 * One sandbox per line; everything else is derived so the table stays readable.
 * Positions: name, state, plugin, region, gpu, gpuCount, cpu, lease, activity,
 * attention, command. Minutes are relative to now and null is genuinely absent.
 */
type Seed = readonly [S, S, S, S, S | null, N, N, N | null, N, S | null, S | null];
const train = 'python train.py --decay 1.0';
const evaluate = 'python eval.py --split held-out';
const batch = 'python export.py --all';
const serve = 'python serve.py --checkpoint step-9810';
const ending = 'lease ends in 6m';
const broken = 'provisioning failed';
const seeds: Seed[] = [
  ['aurora-sweep', 'ready', 'runpod', 'us-east-1', 'H100', 8, 96, 160, -22, null, train],
  ['basalt-notebook', 'ready', 'lambda', 'us-west-2', 'A100', 1, 30, 181, -41, null, null],
  ['cinder-provision', 'provisioning', 'modal', 'eu-west-1', 'H100', 4, 48, null, -4, null, null],
  ['dunes-eval', 'ready', 'runpod', 'us-east-1', 'L40S', 2, 32, 6, -9, ending, evaluate],
  ['ember-retry', 'failed', 'lambda', 'us-east-1', 'H100', 8, 96, null, -21, broken, null],
  ['flint-batch', 'stopped', 'modal', 'us-central-1', null, 0, 16, -35, -35, null, batch],
  ['garnet-serve', 'ready', 'lambda', 'us-west-2', 'A10', 1, 30, 95, -3, null, serve],
];
/** What one accelerator costs an hour where it is not the big-GPU rate. */
const perGpu: Record<string, number> = { A10: 0.75 };
const steps = ['Requested', 'Offer chosen', 'Machine allocated', 'Image pulled', 'Ready'];
const reasons: Record<string, string> = {
  idle: 'no job since the warmup finished',
  unreachable: 'the provider returned capacity_unavailable twice',
  stopped: 'released after the batch finished',
};
const recordOnly = `created_at ready_at native_id ssh_command endpoint host_key_fingerprint
  jobs ladder events sessions`.split(/\s+/);
const idOf = (seed: Seed) => `sbx_${seed[0].split('-')[0]}`;

function record(seed: Seed): Json {
  const [name, state, plugin, region, gpu, gpus, cpu, lease, clock, attention, command] = seed;
  const short = name.split('-')[0];
  const settled = state === 'ready' || state === 'stopped';
  const verdict =
    state === 'ready' ? (command ? 'running' : 'idle') : state === 'failed' ? 'unreachable' : state;
  const clause = reasons[verdict] ?? command ?? `allocating ${gpus} ${gpu} in ${region}`;
  const created = clock - (settled ? 58 : 5);
  const ready = settled ? created + 4 : null;
  const rate = gpu ? gpus * (perGpu[gpu] ?? 4.05) : cpu * 0.0325;
  const spent = ready === null ? 0 : (rate * -ready) / 60;
  // A provision that never priced out has no accounting at all: both amounts are null.
  const priced = (amount: number) =>
    state === 'failed' ? null : { currency: 'USD', amount: amount.toFixed(3) };
  const host = `${short}.${region}.sandboxes.invalid`;
  const memory_mb = cpu * (gpu ? 15360 : 4096);
  const stopped = state === 'stopped';
  const job = {
    name: `${short}-job`,
    state: stopped ? 'succeeded' : 'running',
    exit_code: stopped ? 0 : null,
    finished_at: stopped ? at(clock) : null,
    command,
  };
  const done = settled ? 5 : 2;
  const mark = (index: number) => (index < done ? 'done' : index === done ? 'here' : 'next');
  return {
    id: idOf(seed),
    revision: 0,
    name,
    plugin,
    state,
    offer: { instance_type: gpu ? `gpu-${gpus}x${gpu.toLowerCase()}` : `cpu-${cpu}x`, region },
    resources: { gpu, gpu_count: gpus, gpu_memory_mb: gpu && gpus * 81920, cpu, memory_mb },
    lease_expires_at: lease === null ? null : at(lease),
    lease_seconds: lease === null ? null : gpu ? 14400 : 3600,
    cost_so_far: priced(spent),
    hourly_price: priced(rate),
    activity: { verdict, clause, at: at(clock) },
    attention,
    created_at: at(created),
    ready_at: ready === null ? null : at(ready),
    native_id: `${plugin}-${short}-01`,
    ssh_command: ready === null ? null : `ssh -p 2222 root@${host}`,
    // Nothing is pinned until the machine answers; until then there is no fingerprint.
    host_key_fingerprint: ready === null ? null : `SHA256:${short}7Qm9vdHN0cmFwIGtleSBm`,
    // Bait for the plugin's stripping; a real record carries a real grant here.
    endpoint: { host, port: 2222, user: 'root', token: 'sbxt_fake_endpoint_grant' },
    jobs: command ? [job] : [],
    ladder: steps.map((step, index) => ({ step, state: mark(index) })),
    events: [
      { summary: `Requested: ${plugin} in ${region}`, at: at(created) },
      { summary: `${verdict}: ${clause}`, at: at(clock) },
    ],
    sessions: [
      { kind: 'ssh', remote_addr: '203.0.113.24', started_at: at(clock - 5), outcome: 'closed' },
      { kind: 'exec', remote_addr: '198.51.100.7', started_at: at(clock - 2), outcome: null },
    ],
  };
}
/**
 * What the two lifecycle calls changed; everything else is still derived from the seed.
 * Deletion is asynchronous at a provider, so a released machine reads `deleting` once and
 * `stopped` from the next read on, exactly as the real service settles it.
 */
const changed = new Map<string, Json>();
const current = (seed: Seed): Json => ({ ...record(seed), ...changed.get(idOf(seed)) });
const settle = (id: string) => {
  const change = changed.get(id);
  if (change?.state === 'deleting') changed.set(id, { ...change, state: 'stopped' });
};
const listRow = (seed: Seed) =>
  Object.fromEntries(Object.entries(current(seed)).filter(([key]) => !recordOnly.includes(key)));

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const fail = (response: ServerResponse, status: number, code: string, message: string) =>
  send(response, status, { error: { code, message } });

const read = async (request: IncomingMessage): Promise<Json> => {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text ? (JSON.parse(text) as Json) : {};
};
/** The states the real service will renew a lease in; anything else is a refusal. */
const renewable = ['provisioning', 'ready', 'unknown'];
const seedOf = (path: string, suffix = '') =>
  seeds.find((candidate) => `/v1/sandboxes/${idOf(candidate)}${suffix}` === path);
const missing = (response: ServerResponse, path: string) =>
  fail(
    response,
    404,
    'not_found',
    /^\/v1\/sandboxes\/./.test(path) ? 'No such sandbox' : 'No such route',
  );

/** The two lifecycle calls: a renewed lease and a requested deletion, and nothing else. */
async function change(
  request: IncomingMessage,
  response: ServerResponse,
  method: 'POST' | 'DELETE',
  path: string,
): Promise<void> {
  const renewing = method === 'POST';
  const seed = seedOf(path, renewing ? '/renew' : '');
  if (!seed) return missing(response, path);
  const id = idOf(seed);
  const state = (current(seed) as { state: string }).state;
  if (!renewing) {
    // Deleting a machine that is already gone deletes nothing twice, so the record is the answer.
    if (!['deleting', 'stopped'].includes(state))
      changed.set(id, {
        ...changed.get(id),
        state: 'deleting',
        revision: Number(current(seed).revision) + 1,
      });
    return send(response, 202, current(seed));
  }
  const body = (await read(request).catch(() => ({}))) as {
    lease_seconds?: unknown;
    expected_revision?: unknown;
  };
  const seconds = body.lease_seconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 60)
    return fail(response, 400, 'validation', 'lease_seconds out of range');
  const latest = current(seed);
  if (body.expected_revision !== undefined && body.expected_revision !== latest.revision)
    return fail(response, 409, 'operation_state', 'sandbox changed concurrently; read it again');
  if (!renewable.includes(String(latest.state)))
    return fail(
      response,
      409,
      'operation_state',
      'sandbox lease can only be renewed while it is live',
    );
  // The service renews to now + lease_seconds; it never adds to what is left.
  changed.set(id, {
    ...changed.get(id),
    revision: Number(latest.revision) + 1,
    lease_expires_at: at(seconds / 60),
    lease_seconds: seconds,
  });
  return send(response, 200, current(seed));
}

const server = createServer((request, response) => {
  const method = request.method ?? 'GET';
  const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  if (!(request.headers.authorization ?? '').startsWith('Bearer sbxt_'))
    return fail(response, 401, 'authentication', 'A consumer grant is required');
  if (request.headers['x-sandbox-namespace'] !== namespace)
    return fail(response, 403, 'authorization', 'The namespace selector does not match the grant');
  if (method === 'POST' || method === 'DELETE') return void change(request, response, method, path);
  if (method !== 'GET') return fail(response, 405, 'validation', 'No such method');
  if (path === '/v1/auth/me')
    return send(response, 200, { role: 'consumer', namespace, member_id: 'mem_demo' });
  if (path === '/v1/ui/manifest') return send(response, 200, manifest);
  if (path === '/v1/sandboxes') return send(response, 200, { sandboxes: seeds.map(listRow) });
  const seed = seedOf(path);
  if (seed) {
    settle(idOf(seed));
    return send(response, 200, current(seed));
  }
  return missing(response, path);
}).listen(port, '127.0.0.1', () =>
  console.log(
    JSON.stringify({
      status: 'ready',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      namespace,
    }),
  ),
);
