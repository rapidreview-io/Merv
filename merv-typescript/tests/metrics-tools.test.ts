import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Context } from 'cordis';
import { check, type Caller, type Scope, type Artifacts } from '@merv/contracts';
import type { Experiments } from '@merv/experiments/types';
import type { Sessions } from '@merv/sessions/types';
import type { NounDefinition } from '@merv/api/types';
import { MetricsService } from '@merv/metrics/service';
import metricsTools from '@merv/metrics/tools';
import metricsPlugin from '@merv/metrics';
import { MetricsRenderer } from '@merv/metrics/renderer';
import { MUTED, PALETTE, panel, sheet, type Chart } from '@merv/metrics/chart';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { MountHandler } from '@merv/api/types';

const caller: Caller = { actorId: 'producer', projectId: 'project' };
const loggedAt = (step: number) => new Date(Date.UTC(2026, 9, 26, 0, 0, step)).toISOString();
async function fixture(t: TestContext) {
  const state = {
    stage: 'running',
    attempt: 2,
    revision: 10,
    sessionInstance: 'experiment',
    sessionState: 'running',
    sessionStatus: 'active',
    allowed: true,
    live: true,
    readAllowed: true,
    count: 501,
    changeAttempt: false,
    oddMetric: 'nan',
    messages: [] as { createdAt: string; body: string }[],
    manyMetrics: 0,
    submissions: [] as { createdAt: string; stage: string }[],
  };
  const stored: { title: string; content: string; mediaType?: string }[] = [];
  const calls: { name: string; args: Record<string, any> }[] = [];
  const configs = {
    id1: { _merv_experiment: 'experiment', _merv_attempt: 1 },
    id2: { _merv_experiment: 'experiment', _merv_attempt: 2, _Group: 'decay-sweep' },
    id3: { _merv_experiment: 'other', _merv_attempt: 2 },
    id4: {},
  };
  const records = Object.keys(configs).map((id, i) => ({
    id,
    name: `run${i + 1}`,
    created_at: `2026-10-${20 + i}`,
  }));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/upload') {
      stored.push({ title: 'upload', content: Buffer.concat(chunks).toString() });
      res.end();
      return;
    }
    const args = JSON.parse(Buffer.concat(chunks).toString()).kwargs;
    // Trackio's metrics table, as its query endpoint sees it: every step logs loss (run2
    // falling), acc every fifth step, and a picture and an odd name once.
    const query = (sql: string) => {
      const db = new DatabaseSync(':memory:');
      db.exec(
        'CREATE TABLE metrics (run_id TEXT, run_name TEXT, step INTEGER, timestamp TEXT, metrics TEXT)',
      );
      const insert = db.prepare('INSERT INTO metrics VALUES (?, ?, ?, ?, ?)');
      for (const { id, name } of records)
        for (let step = 0; step < state.count; step++)
          insert.run(
            id,
            name,
            step,
            // Trackio's own form: microseconds and an offset. Every run logs a step a second.
            loggedAt(step).replace('Z', '000+00:00'),
            JSON.stringify({
              loss: name === 'run2' ? 500 - step : step,
              ...(step % 5 === 0 && { acc: step / 500 }),
              ...(step === 0 && { picture: { _type: 'trackio.image' }, [state.oddMetric]: 1 }),
              ...Object.fromEntries(
                Array.from({ length: state.manyMetrics }, (_, i) => [
                  `m${String(i).padStart(2, '0')}`,
                  step,
                ]),
              ),
            }),
          );
      const rows = db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
      return { columns: Object.keys(rows[0] ?? {}), rows, row_count: rows.length };
    };
    const name = req.url!.split('/').at(-1)!;
    calls.push({ name, args });
    if (name === 'get_metric_values' && state.changeAttempt) state.attempt++;
    assert.equal(args.project, caller.projectId);
    const values = Array.from({ length: state.count }, (_, step) => ({
      step,
      value: name === 'get_metric_values' && args.run === 'run2' ? 500 - step : step,
    }));
    const result = {
      get_runs_for_project: records,
      get_run_configs: configs,
      get_metrics_for_run: ['loss'],
      get_metric_values: values,
      get_run_summary: {
        config: configs[args.run_id as keyof typeof configs] ?? {},
        metrics: ['loss'],
        last_step: 500,
      },
      query_project: name === 'query_project' && query(args.query),
    }[name];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const upstream = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const scope = {
    require: async (_caller: Caller, permission: string) =>
      check(
        permission === 'write' ? state.allowed : state.readAllowed,
        'forbidden',
        'No write authority',
        403,
      ),
  } as unknown as Scope;
  const experiments = {
    get: async (_caller: Caller, id: string) => ({
      id,
      name: 'decay-sweep',
      projectId: 'project',
      workflow: { state: state.stage, revision: state.revision },
      attempt: { index: state.attempt },
      failed: false,
      submissions: state.submissions,
    }),
  } as unknown as Experiments;
  const sessions = {
    threads: {
      list: async () => [
        { id: 'producer', role: 'producer' },
        { id: 'reviewer', role: 'reviewer' },
      ],
    },
    messaging: {
      thread: async (_c: Caller, id: string) => ({
        messages: id === 'producer' ? state.messages : [{ createdAt: loggedAt(50), body: 'no' }],
      }),
    },
    session: async (c: Caller) => {
      check(state.live, 'forbidden', 'Lease ended', 403);
      return {
        kind: 'work',
        role: 'producer',
        instanceId: state.sessionInstance,
        actorId: c.actorId,
        projectId: c.projectId,
        status: state.sessionStatus,
        expiresAt: new Date(Date.now() + 100000).toISOString(),
        execution: { state: state.sessionState, workflow: 'experiment', revision: state.revision },
      };
    },
  } as unknown as Sessions;
  const artifacts = {
    uploadBegin: async (_caller: Caller, input: { size: number }) => ({
      uploadId: 'upload',
      partSize: input.size,
      parts: [{ partNumber: 1, size: input.size, url: upstream + '/upload', headers: {} }],
    }),
    uploadComplete: async () => ({ id: 'large-artifact' }),
    create: async (_caller: Caller, input: (typeof stored)[number]) => {
      stored.push(input);
      return { id: 'artifact' };
    },
  } as unknown as Artifacts;
  const metrics = new MetricsService(
    { upstream, writeToken: 'server', secret: 's'.repeat(32), mediaDir: '/data/trackio/media' },
    scope,
    experiments,
    sessions,
    artifacts,
    () => 'https://merv.example',
  );
  return { metrics, state, stored, calls, scope, experiments, sessions, artifacts, records };
}
test('connect requires a running experiment and write authority or its live producing session', async (t) => {
  const { metrics, state } = await fixture(t);
  const connected = await metrics.connect(caller, 'experiment');
  assert.equal(connected.env.TRACKIO_SERVER_URL, 'https://merv.example/trackio');
  const token = metrics.tokens.verify(connected.env.TRACKIO_WRITE_TOKEN)!;
  assert.equal(token.k, 'w');
  assert.deepEqual(token, {
    k: 'w',
    p: 'project',
    e: 'experiment',
    g: 'decay-sweep',
    a: 2,
    x: Math.floor(Date.parse(connected.expiresAt) / 1000),
  });
  assert.ok(token.x - Date.now() / 1000 <= 43200 && token.x - Date.now() / 1000 > 43195);
  state.stage = 'planned';
  await assert.rejects(metrics.connect(caller, 'experiment'), { status: 403 });
  state.stage = 'running';
  state.allowed = false;
  await assert.rejects(metrics.connect(caller, 'experiment'), { status: 403 });
  state.allowed = true;
  const worker = { ...caller, session: { id: 'session' } };
  assert.equal((await metrics.connect(worker, 'experiment')).project, 'project');
  state.sessionInstance = 'other';
  await assert.rejects(metrics.connect(worker, 'experiment'), { status: 403 });
  state.sessionInstance = 'experiment';
  state.sessionState = 'experiment_review';
  await assert.rejects(metrics.connect(worker, 'experiment'), { status: 403 });
  state.sessionState = 'running';
  state.sessionStatus = 'released';
  await assert.rejects(metrics.connect(worker, 'experiment'), { status: 403 });
  state.sessionStatus = 'active';
  state.live = false;
  await assert.rejects(metrics.connect(worker, 'experiment'), { status: 403 });
});
test("runs use run-id configs, filter by experiment and sort newest first; panels open Trackio's whole dashboard", async (t) => {
  const { metrics } = await fixture(t);
  assert.deepEqual(
    (await metrics.runs(caller)).map((r) => r.id),
    ['id4', 'id3', 'id2', 'id1'],
  );
  assert.deepEqual(
    (await metrics.runs(caller, 'experiment')).map((r) => [r.id, r.experiment, r.attempt]),
    [
      ['id2', 'decay-sweep', 2],
      ['id1', undefined, 1],
    ],
  );
  const panel = await metrics.panel(caller, 'experiment');
  const url = new URL(panel.url, 'https://merv.example');
  assert.equal(panel.runs, 2);
  assert.equal(url.searchParams.get('run_ids'), 'id2,id1');
  assert.equal(url.searchParams.has('navbar'), false);
  assert.equal(url.searchParams.get('hide_empty_tabs'), 'true');
  const project = new URL((await metrics.panel(caller)).url, 'https://merv.example').searchParams;
  assert.equal(project.has('run_ids'), false);
  assert.equal(project.has('navbar'), false);
  assert.equal(project.get('hide_empty_tabs'), 'true');
});
test('series reads many runs in one call, filters, thins evenly and keeps only finite scalars', async (t) => {
  const { metrics, calls } = await fixture(t);
  const [first, second] = await metrics.series(caller, {
    experimentId: 'experiment',
    metrics: ['loss'],
    from: 10,
    to: 20,
    points: 3,
  });
  assert.equal(calls.filter((c) => c.name === 'query_project').length, 1);
  assert.deepEqual(
    [first!.run, first!.attempt, { ...first!.metrics }],
    [
      'run2',
      2,
      {
        loss: [
          [10, 490],
          [15, 485],
          [20, 480],
        ],
      },
    ],
  );
  assert.deepEqual(
    { ...second!.metrics },
    {
      loss: [
        [10, 10],
        [15, 15],
        [20, 20],
      ],
    },
  );
  const [all] = await metrics.series(caller, { runs: ['run1'] });
  assert.deepEqual(Object.keys(all!.metrics).sort(), ['acc', 'loss', 'nan']);
  assert.equal(all!.metrics.loss!.length, 200);
  assert.deepEqual(all!.metrics.loss![0], [0, 0]);
  assert.deepEqual(all!.metrics.loss!.at(-1), [500, 500]);
  assert.equal(all!.metrics.acc!.length, 101);
  await assert.rejects(metrics.series(caller, { runs: ['missing'] }), { status: 404 });
  const [last] = await metrics.series(caller, { runs: ['id1'], metrics: ['loss'], points: 1 });
  assert.deepEqual({ ...last!.metrics }, { loss: [[500, 500]] });
  // Names are data in the SQL too.
  const [quoted] = await metrics.series(caller, { runs: ['run1'], metrics: ["it's"] });
  assert.deepEqual({ ...quoted!.metrics }, {});
});
test("run reports each metric's last logged point; query answers only rows", async (t) => {
  const { metrics, calls } = await fixture(t);
  assert.deepEqual(await metrics.run(caller, { run: 'run2', id: 'id2' }), {
    config: { _merv_experiment: 'experiment', _merv_attempt: 2, _Group: 'decay-sweep' },
    metrics: ['loss'],
    lastStep: 500,
    last: Object.assign(Object.create(null), { loss: [500, 0] }),
  });
  assert.match(calls.at(-1)!.args.query, /m\.run_id = 'id2'/);
  const query = await metrics.query(caller, 'SELECT step FROM metrics');
  assert.deepEqual(Object.keys(query), ['columns', 'rows', 'truncated']);
  assert.equal(query.rows.length, 200);
});
test('export retains every current-attempt series and enforces connect authority', async (t) => {
  const { metrics, stored, state } = await fixture(t);
  assert.deepEqual(await metrics.export(caller, 'experiment'), {
    artifactId: 'artifact',
    path: 'metrics/trackio-attempt-2.json',
  });
  const retained = JSON.parse(stored[0]!.content);
  assert.equal(stored[0]!.mediaType, 'application/json');
  assert.equal(retained.runs.length, 1);
  assert.equal(retained.runs[0].id, 'id2');
  assert.equal(retained.runs[0].metrics.loss.length, 501);
  state.sessionInstance = 'other';
  await assert.rejects(metrics.export({ ...caller, session: { id: 'wrong' } }, 'experiment'), {
    status: 403,
  });
  state.stage = 'experiment_review';
  await assert.rejects(metrics.export(caller, 'experiment'), { status: 403 });
  assert.equal(stored.length, 1);
});
test('noun tools have deferred actions, bounded schemas and flat worker aliases', async (t) => {
  const { metrics } = await fixture(t);
  const ctx = new Context();
  const nouns = new Map<string, NounDefinition>();
  const registered: { name: string; tier: string; readOnly: boolean }[] = [];
  ctx.provide('metrics', metrics);
  ctx.provide('api', { url: 'http://127.0.0.1:1' } as any);
  ctx.provide('tools', {
    noun: (name: string, definition: NounDefinition) => {
      nouns.set(name, definition);
      return () => {};
    },
    contributeInstructions: () => () => {},
    register: (definition: { name: string; tier: string; readOnly: boolean }) => {
      registered.push(definition);
      return () => {};
    },
  } as any);
  const plugin = ctx.plugin(metricsTools);
  await plugin;
  t.after(() => ctx.fiber.dispose());
  assert.equal(nouns.size, 2);
  // The pages' chart read is theirs alone: no agent lists it.
  assert.deepEqual(
    registered.map(({ name, tier, readOnly }) => [name, tier, readOnly]),
    [['metrics.chart', 'ui', true]],
  );
  for (const [name, noun] of nouns) {
    assert.equal(noun.tier, 'deferred');
    for (const [action, definition] of Object.entries(noun.actions))
      assert.deepEqual(definition.was, [`metrics.${action}`]);
    if (name === 'metrics.read') assert.equal(noun.readOnly, true);
  }
  const read = nouns.get('metrics.read')!.actions;
  assert.deepEqual(Object.keys(read).sort(), ['look', 'query', 'run', 'runs', 'series']);
  for (const input of [{ points: 1001 }, { runs: Array(21).fill('a') }, { metrics: [] }])
    assert.equal(read.series!.input.safeParse(input).success, false);
  assert.equal(read.look!.input.safeParse({ runs: Array(21).fill('a') }).success, false);
  assert.equal(read.look!.input.safeParse({ smoothing: 100 }).success, false);
});

test('large exports use Artifacts uploads; changed attempts cannot retain mixed data', async (t) => {
  const { metrics, stored, state } = await fixture(t);
  state.count = 100000;
  assert.deepEqual(await metrics.export(caller, 'experiment'), {
    artifactId: 'large-artifact',
    path: 'metrics/trackio-attempt-2.json',
  });
  assert.equal(JSON.parse(stored[0]!.content).runs[0].metrics.loss.length, 100000);
  state.count = 501;
  state.changeAttempt = true;
  await assert.rejects(metrics.export(caller, 'experiment'), { status: 409 });
  assert.equal(stored.length, 1);
});
test('session mount requires project read and issues project cookies with secure defaults', async (t) => {
  const f = await fixture(t);
  const ctx = new Context();
  const mounts = new Map<string, { handler: MountHandler; options: unknown }>();
  ctx.provide('scope', f.scope);
  ctx.provide('experiments', f.experiments);
  ctx.provide('sessions', f.sessions);
  ctx.provide('artifacts', f.artifacts);
  ctx.provide('api', {
    publicOrigin: 'https://merv.example',
    mount: (path: string, handler: MountHandler, options: unknown) => {
      mounts.set(path, { handler, options });
      return () => mounts.delete(path);
    },
  } as any);
  await ctx.plugin(metricsPlugin, f.metrics.config);
  t.after(() => ctx.fiber.dispose());
  assert.deepEqual(mounts.get('/trackio')!.options, { public: true });
  assert.equal(mounts.get('/metrics')!.options, undefined);
  const headers = new Map<string, string>();
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3081' } as Record<string, string>,
    socket: {},
  };
  const res = { setHeader: (key: string, value: string) => headers.set(key, value) };
  const r = {
    url: new URL('http://localhost/metrics/session'),
    caller: async () => caller,
    json: async () => ({ experimentId: 'experiment' }),
  };
  const result = (await mounts.get('/metrics')!.handler(req as any, res as any, r as any)) as {
    runs: number;
  };
  assert.equal(result.runs, 2);
  let cookie = headers.get('set-cookie')!;
  assert.match(cookie, /^merv_trackio_project=/);
  assert.match(cookie, /Path=\/trackio; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/);
  const token = f.metrics.tokens.verify(cookie.split(';')[0]!.split('=')[1]!)!;
  assert.equal(token.k, 'v');
  assert.equal(token.p, 'project');
  assert.ok(token.x - Date.now() / 1000 <= 1800);
  req.headers.host = 'merv.example';
  await mounts.get('/metrics')!.handler(req as any, res as any, r as any);
  assert.match(headers.get('set-cookie')!, /Secure/);
  req.headers.host = 'localhost:3081';
  req.headers['x-forwarded-proto'] = 'https';
  await mounts.get('/metrics')!.handler(req as any, res as any, r as any);
  assert.match(headers.get('set-cookie')!, /Secure/);
  req.headers['x-forwarded-proto'] = 'http';
  await mounts.get('/metrics')!.handler(req as any, res as any, r as any);
  assert.doesNotMatch(headers.get('set-cookie')!, /Secure/);
  f.state.readAllowed = false;
  await assert.rejects(
    async () => mounts.get('/metrics')!.handler(req as any, res as any, r as any),
    { status: 403 },
  );
});
test(
  'look rasterises the chart offline, one picture at a time, and stops when closed',
  { skip: !existsSync(chromium.executablePath()) },
  async (t) => {
    try {
      const probe = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      await probe.close();
    } catch {
      t.skip('Chromium cannot launch in this environment');
      return;
    }
    let foreign = 0;
    const outside = createServer((_req, res) => {
      foreign++;
      res.end('foreign');
    });
    outside.listen(0, '127.0.0.1');
    await once(outside, 'listening');
    const renderer = new MetricsRenderer();
    t.after(async () => {
      await renderer.close();
      outside.closeAllConnections();
      await new Promise<void>((resolve) => outside.close(() => resolve()));
    });
    const destination = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image href="${destination}/x.png" width="10" height="10"/><rect width="200" height="100" fill="#2563eb"/></svg>`;
    const pictures = await Promise.all([
      renderer.render(svg, 200, 100),
      renderer.render(svg, 200, 100),
    ]);
    for (const picture of pictures) {
      assert.equal(picture.mimeType, 'image/jpeg');
      assert.equal(Buffer.from(picture.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    }
    assert.equal(foreign, 0);
    await renderer.close();
    await assert.rejects(renderer.render(svg, 200, 100), { status: 503 });
  },
);
test("chart names each run's experiment and attempt, greys redone attempts and marks what happened while runs logged", async (t) => {
  const f = await fixture(t);
  f.state.messages = [
    // Between two logged steps: the step the run had reached, not the next one.
    {
      createdAt: new Date(Date.parse(loggedAt(100)) + 500).toISOString(),
      body: 'Lower the learning rate',
    },
    { createdAt: '2026-10-25T00:00:00.000Z', body: 'Before any run' },
  ];
  f.state.submissions = [{ createdAt: loggedAt(1000), stage: 'results' }];
  const chart = await f.metrics.chart(caller, { experimentId: 'experiment', metrics: 'LOS | x_' });
  assert.deepEqual(chart.metrics, ['loss']);
  assert.deepEqual(
    chart.runs.map((run) => [run.id, run.attempt, run.state, run.muted, run.color]),
    [
      ['id2', 2, 'running', undefined, PALETTE[1]],
      ['id1', 1, 'running', true, PALETTE[0]],
    ],
  );
  assert.equal(chart.runs[0]!.metrics.loss!.length, 300);
  assert.deepEqual(Object.keys(chart.runs[0]!.metrics), ['loss']);
  assert.equal(chart.live, true);
  // Only the producers' message sent while the runs logged, at the step each had reached.
  assert.deepEqual(chart.marks.map((mark) => [mark.run, mark.step, mark.label]).sort(), [
    ['id1', 100, 'Message: Lower the learning rate'],
    ['id2', 100, 'Message: Lower the learning rate'],
  ]);
  const project = await f.metrics.chart(caller, {});
  assert.equal(project.runs.length, 4);
  assert.deepEqual(project.marks, []);
  // Colours belong to the runs, not to the choice of them.
  assert.equal(project.runs.find((run) => run.id === 'id2')!.color, PALETTE[1]);
  // An untagged run beside the experiment's own takes none of its marks.
  const mixed = await f.metrics.chart(caller, { runs: ['id1', 'id4'] });
  assert.deepEqual(
    mixed.marks.map((mark) => mark.run),
    ['id1'],
  );
  // Words are data: a pattern's characters match only themselves.
  assert.deepEqual((await f.metrics.chart(caller, { metrics: "(a+)+$|it's|%" })).metrics, []);
  assert.deepEqual((await f.metrics.chart(caller, { metrics: 'acc|nan' })).metrics, ['acc', 'nan']);
  // An id selects its run alone, even where another run carries that id as its name.
  f.records.push({ id: 'id9', name: 'id1', created_at: '2026-10-30' });
  assert.deepEqual(
    (await f.metrics.chart(caller, { runs: ['id1'] })).runs.map((run) => run.id),
    ['id1'],
  );
  assert.deepEqual(
    (await f.metrics.series(caller, { runs: ['run1', 'id1'], metrics: ['acc'] })).map((r) => r.id),
    ['id1'],
  );
});
test("a read stays inside Trackio's row limit: at most 60 metrics, and fewer points a line as lines grow", async (t) => {
  const f = await fixture(t);
  f.state.count = 50;
  f.state.manyMetrics = 70;
  const chart = await f.metrics.chart(caller, {});
  assert.equal(chart.metrics.length, 60);
  assert.equal(chart.omitted, 13);
  // 4 runs x 60 metrics share 9,000 rows: 37 points a line of 50.
  assert.equal(chart.runs[0]!.metrics.acc!.length, 10);
  assert.equal(chart.runs[0]!.metrics.m00!.length, 37);
  const rows = chart.runs.reduce(
    (sum, run) => sum + Object.values(run.metrics).reduce((n, points) => n + points.length, 0),
    0,
  );
  assert.ok(rows <= 9000);
});
test('panels escape every text, draw grey runs under the current ones and size the picture to its panels', () => {
  const metric = '<b>"m"</b>';
  const chart: Chart = {
    metrics: [metric],
    runs: [
      {
        id: 'a',
        run: '<i>run</i>',
        color: PALETTE[0]!,
        muted: true,
        metrics: {
          [metric]: [
            [0, 1],
            [1, 2],
          ],
        },
      },
      {
        id: 'b',
        run: 'b',
        color: PALETTE[1]!,
        metrics: {
          [metric]: [
            [0, 2],
            [1, 1],
          ],
        },
      },
    ],
    marks: [{ run: 'b', step: 1, at: '', label: '</title><script>x</script>' }],
    live: false,
  };
  const svg = panel(chart, metric);
  assert.doesNotMatch(svg, /<b>|<i>|<script/);
  assert.ok(svg.indexOf(MUTED) < svg.indexOf(PALETTE[1]!));
  const picture = sheet(chart);
  assert.doesNotMatch(picture.svg, /<i>/);
  assert.deepEqual(picture.shown, [metric]);
  assert.equal(picture.width, 432);
  // Values past float precision for their range still draw, and in bounded time.
  const huge: Chart = {
    metrics: ['m'],
    runs: [
      {
        id: 'h',
        run: 'h',
        color: PALETTE[0]!,
        metrics: {
          m: [
            [0, 1e16],
            [1, 1e16 + 2],
          ],
        },
      },
    ],
    marks: [],
    live: false,
  };
  assert.match(panel(huge, 'm'), /<path d="M/);
  // A metric named like an inherited property, logged by one run of two.
  const inherited = JSON.parse(
    JSON.stringify({
      ...huge,
      metrics: ['constructor'],
      runs: [
        {
          id: 'a',
          run: 'a',
          color: PALETTE[0],
          metrics: {
            constructor: [
              [0, 1],
              [1, 2],
            ],
          },
        },
        { id: 'b', run: 'b', color: PALETTE[1], metrics: {} },
      ],
    }),
  ) as Chart;
  assert.match(panel(inherited, 'constructor'), /<path d="M/);
});

test('run listings are capped at 200 after sorting', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 250; i++)
    f.records.push({ id: `extra${i}`, name: `extra${i}`, created_at: '2026-11-01' });
  const runs = await f.metrics.runs(caller);
  assert.equal(runs.length, 200);
  assert.ok(runs.every((r) => r.id.startsWith('extra')));
});

test('run and metric names are data, including JavaScript property names', async (t) => {
  const f = await fixture(t);
  f.state.oddMetric = '__proto__';
  f.records.push({ id: 'id5', name: 'constructor', created_at: '2026-10-30' });
  const [run] = await f.metrics.series(caller, { runs: ['constructor'], metrics: ['__proto__'] });
  assert.equal(run!.run, 'constructor');
  assert.deepEqual(Object.keys(run!.metrics), ['__proto__']);
  assert.deepEqual(run!.metrics.__proto__, [[0, 1]]);
  assert.equal(Object.hasOwn(Object.prototype, 'loss'), false);
});
