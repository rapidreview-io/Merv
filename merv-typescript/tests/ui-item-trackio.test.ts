/**
 * An experiment that logs to Trackio shows its curve live on its card, and keeps a static figure
 * in its results once it ends; an item that logged nothing shows nothing of Trackio.
 *
 * The server half is real: training code's writes go through Merv's /trackio proxy (which tags
 * each run with its experiment and attempt) to a Trackio stand-in that answers as Trackio does
 * (its SQL over an in-memory SQLite `metrics` table), and the Metrics service reads the item's
 * key curve and keeps its figure. The page half draws the real card with what the service read.
 * The render harness replaces `fetch`, so it is loaded only once the server half is done.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { ApiRequest } from '@merv/api/types';
import type { Caller, Scope, Artifacts } from '@merv/contracts';
import type { Experiments } from '@merv/experiments/types';
import type { Sessions } from '@merv/sessions/types';
import { MetricsService, type ItemMetrics } from '@merv/metrics/service';
import { metricsProxy } from '@merv/metrics/proxy';

const caller: Caller = { actorId: 'producer', projectId: 'project' };
const EXPERIMENT = 'wf_grok';
const QUIET = 'wf_quiet';
const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

/** Trackio as Merv's proxy and service reach it: logged rows, configs, and SQL over them. */
function trackio() {
  const runs = new Map<string, { name: string; config: Record<string, unknown>; at: string }>();
  const rows: {
    run_id: string;
    run_name: string;
    step: number;
    timestamp: string;
    metrics: string;
  }[] = [];
  const query = (sql: string) => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE metrics (run_id TEXT, run_name TEXT, step INTEGER, timestamp TEXT, metrics TEXT)',
    );
    const insert = db.prepare('INSERT INTO metrics VALUES (?, ?, ?, ?, ?)');
    for (const row of rows)
      insert.run(row.run_id, row.run_name, row.step, row.timestamp, row.metrics);
    const found = db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
    return { columns: Object.keys(found[0] ?? {}), rows: found };
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks).toString() || '{}').kwargs ?? {};
    const name = req.url!.split('/').at(-1)!;
    const of = (id: string) => rows.filter((row) => row.run_id === id);
    const data = (() => {
      switch (name) {
        case 'bulk_log':
          for (const entry of args.logs) {
            const id = entry.run_id ?? `id-${entry.run}`;
            if (!runs.has(id))
              runs.set(id, {
                name: entry.run,
                config: entry.config ?? {},
                at: new Date().toISOString(),
              });
            rows.push({
              run_id: id,
              run_name: entry.run,
              step: entry.step,
              timestamp: new Date(Date.UTC(2026, 10, 24, 0, 0, entry.step)).toISOString(),
              metrics: JSON.stringify(entry.metrics),
            });
          }
          return 'ok';
        case 'get_runs_for_project':
          return [...runs].map(([id, run]) => ({ id, name: run.name, created_at: run.at }));
        case 'get_run_configs':
          return Object.fromEntries([...runs].map(([id, run]) => [id, run.config]));
        case 'get_run_summary':
          return {
            config: runs.get(args.run_id)?.config ?? {},
            metrics: [
              ...new Set(of(args.run_id).flatMap((row) => Object.keys(JSON.parse(row.metrics)))),
            ],
            last_step: of(args.run_id).at(-1)?.step ?? null,
          };
        case 'get_metric_values':
          return of(args.run_id).map((row) => ({
            step: row.step,
            value: JSON.parse(row.metrics)[args.metric_name],
          }));
        case 'query_project':
          return query(args.query);
      }
    })();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
  return { server, runs };
}

async function serverHalf(t: TestContext) {
  const upstream = trackio();
  const record = {
    id: EXPERIMENT,
    name: 'decay-sweep',
    projectId: 'project',
    intent: 'Does the grokking step fall as weight decay grows?',
    details: '',
    conclusion: null as string | null,
    workflow: { state: 'running', revision: 7, updatedAt: '2026-11-24T00:00:00.000Z' },
    attempt: { index: 1 },
    settled: false,
    failed: false,
    submissions: [],
    evidence: [] as Record<string, unknown>[],
  };
  const stored = new Map<string, { title: string; mediaType?: string; content: string }>();
  const experiments = {
    get: async (_c: Caller, id: string) => {
      if (id !== EXPERIMENT) throw Object.assign(new Error('Not found'), { status: 404 });
      return structuredClone(record);
    },
    attach: async (_c: Caller, input: Record<string, unknown>) => {
      record.evidence.push({
        id: `ev${record.evidence.length}`,
        role: input.role,
        path: input.path,
        artifactId: input.artifactId,
        attemptIndex: input.attemptIndex,
        resultFormat: input.resultFormat,
        current: true,
      });
      return input;
    },
  } as unknown as Experiments;
  const artifacts = {
    create: async (_c: Caller, input: { title: string; mediaType?: string; content: string }) => {
      const id = `art_${stored.size + 1}`;
      stored.set(id, input);
      return { id };
    },
  } as unknown as Artifacts;
  const scope = { require: async () => undefined } as unknown as Scope;
  const sessions = { threads: { list: async () => [] } } as unknown as Sessions;
  const config = {
    upstream: await listen(upstream.server),
    writeToken: 'server-secret',
    secret: 's'.repeat(32),
    mediaDir: '/data/trackio/media',
  };
  const metrics = new MetricsService(
    config,
    scope,
    experiments,
    sessions,
    artifacts,
    () => 'https://merv.test',
  );
  const handler = metricsProxy(config, metrics.tokens, async () => true);
  const proxy = createServer(async (req, res) => {
    try {
      const result = await handler(req, res, {} as ApiRequest);
      if (result !== undefined) res.end(JSON.stringify(result));
    } catch (error: any) {
      res.statusCode = error.status ?? 500;
      res.end(JSON.stringify({ error: error.code }));
    }
  });
  const origin = await listen(proxy);
  t.after(async () => {
    for (const server of [proxy, upstream.server]) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  // Training code logs as the Trackio client does, with what connect returned.
  const { env, project } = await metrics.connect(
    caller,
    { experimentId: EXPERIMENT },
    'lab-gpu-01',
  );
  const log = async (from: number, to: number) => {
    const logs = [];
    for (const [arm, jump] of [
      ['decay-0.3', 140],
      ['decay-3.0', 60],
    ] as const)
      for (let step = from; step < to; step += 10)
        logs.push({
          project,
          run: arm,
          step,
          metrics: {
            'val/acc': 1 / (1 + Math.exp(-(step - jump) / 12)),
            'train/loss': 4 * Math.exp(-step / 40),
          },
          ...(step === 0 && { config: { weight_decay: Number(arm.split('-')[1]) } }),
        });
    const response = await fetch(`${origin}/trackio/api/bulk_log`, {
      method: 'POST',
      headers: {
        'x-trackio-write-token': env.TRACKIO_WRITE_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kwargs: { logs } }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const read = async () => await metrics.items(caller, { ids: [EXPERIMENT, QUIET], points: 200 });
  return { metrics, record, stored, upstream, log, read };
}

test('an experiment that logs to Trackio shows its curve live, then keeps a static figure in its results', async (t) => {
  // ── Server: the item's runs are found from the item, live, then kept. ──────────────────
  const server = await serverHalf(t);
  await server.log(0, 100);
  // The proxy tagged both runs with the experiment, its attempt and where they ran.
  for (const run of server.upstream.runs.values())
    assert.deepEqual(
      [run.config._merv_experiment, run.config._merv_attempt, run.config._merv_machine],
      [EXPERIMENT, 1, 'lab-gpu-01'],
    );
  const early = await server.read();
  // An item that logged nothing is not answered at all: nothing to draw.
  assert.deepEqual(Object.keys(early), [EXPERIMENT]);
  assert.equal(early[EXPERIMENT]!.metric, 'val/acc');
  assert.deepEqual(early[EXPERIMENT]!.runs.map((run) => run.run).sort(), [
    'decay-0.3',
    'decay-3.0',
  ]);
  assert.equal(early[EXPERIMENT]!.runs[0]!.points.length, 10);
  assert.equal(early[EXPERIMENT]!.machine, 'lab-gpu-01');
  // Training goes on: the next read has the new points on the same lines.
  await server.log(100, 200);
  const later = await server.read();
  assert.equal(later[EXPERIMENT]!.runs[0]!.points.length, 20);
  assert.deepEqual(
    later[EXPERIMENT]!.runs.map((run) => run.color),
    early[EXPERIMENT]!.runs.map((run) => run.color),
    'a run keeps its colour as it grows',
  );
  // Before submitting, export keeps the series and draws the key figure, every run overlaid,
  // and attaches both to the attempt's results.
  const drawn: string[] = [];
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const exported = await server.metrics.export(
    caller,
    { experimentId: EXPERIMENT },
    async (svg) => {
      drawn.push(svg);
      return { data: PNG, mimeType: 'image/png' };
    },
  );
  assert.deepEqual(exported.figure, {
    artifactId: 'art_2',
    path: 'metrics/trackio-attempt-1.png',
    metric: 'val/acc',
  });
  assert.equal(drawn.length, 1);
  // The static figure is a real chart: a line per run of the key metric, named in its legend.
  assert.match(drawn[0]!, /decay-sweep: val\/acc/);
  assert.match(drawn[0]!, /decay-0\.3/);
  assert.match(drawn[0]!, /decay-3\.0/);
  assert.ok((drawn[0]!.match(/<path d="M/g) ?? []).length >= 2);
  assert.equal(server.stored.get('art_2')!.mediaType, 'image/png');
  assert.deepEqual(
    server.record.evidence.map(({ role, path, resultFormat }) => [role, path, resultFormat]),
    [
      ['result', 'metrics/trackio-attempt-1.json', 'qualitative'],
      ['result', 'metrics/trackio-attempt-1.png', 'qualitative'],
    ],
  );
  const kept = JSON.parse(server.stored.get('art_1')!.content);
  assert.equal(kept.runs.length, 2);
  assert.equal(kept.runs[0].metrics['val/acc'].length, 20);
  // The experiment ends.
  server.record.workflow.state = 'complete';
  server.record.settled = true;
  server.record.conclusion = 'Yes: the grokking step falls with decay.';
  const ended = await server.read();

  // ── Page: the card draws what the service read. ─────────────────────────────────────────
  const render = await import('./ui-render.js');
  const { createElement } = await import('react');
  const { MemoryRouter } = await import('react-router-dom');
  const { ExperimentSummary } = await import('../packages/ui/web/views/item-views.js');
  const { setProject } = await import('../packages/ui/web/api.js');
  setProject('project');
  const shell = {
    plugins: [],
    rows: ['experiments', 'metrics'].map((id, order) => ({
      id,
      label: id,
      path: `/${id}`,
      group: 'hidden',
      order,
      view: { kind: id },
      status: {},
      readable: true,
    })),
    workflows: [],
  };
  let curves: Record<string, ItemMetrics> = early;
  const asked: Record<string, unknown>[] = [];
  const serveAll = () => {
    render.serve('/tools/ui.shell', { body: { result: shell } });
    render.serve('/tools/ui.running', {
      body: {
        result: {
          observedAt: new Date().toISOString(),
          edges: [],
          lanes: Object.fromEntries(
            ['work', 'sessions', 'hardware'].map((lane) => [
              lane,
              { nodes: [], summaries: [], needsYou: 0, failed: [] },
            ]),
          ),
        },
      },
    });
    render.serve('/tools/artifact.list', { body: { result: [] } });
    render.serve('/tools/metrics.items', (_call, sent) => {
      asked.push(sent);
      return { body: { result: curves } };
    });
  };
  const draw = async (record: typeof server.record) => {
    await render.mount(
      createElement(
        MemoryRouter,
        null,
        createElement(ExperimentSummary, {
          experiment: record as never,
          codeUnit: null,
          history: [],
        }),
      ),
    );
    await render.settle(50);
  };
  const lines = () => document.querySelectorAll('.item-curve-plot svg path').length;

  // Running: the curve is drawn live, every run on one frame.
  serveAll();
  const running = {
    ...structuredClone(server.record),
    workflow: { ...server.record.workflow, state: 'running' },
    settled: false,
    conclusion: null,
    evidence: [],
  };
  await draw(running);
  assert.ok(document.querySelector('.item-summary.is-working'));
  assert.match(render.text(), /Live/);
  assert.match(render.text(), /val\/acc/);
  assert.equal(lines(), 2);
  assert.deepEqual(asked[0]!.ids, [EXPERIMENT]);
  const before = document.querySelector('.item-curve-plot svg')!.innerHTML;
  // The next read is the 10-second poll: the same card is redrawn in place with the new points.
  curves = later;
  await render.settle(10_600);
  assert.equal(lines(), 2);
  assert.notEqual(document.querySelector('.item-curve-plot svg')!.innerHTML, before);
  await render.unmount();

  // Ended: no live curve; the result card shows the figure kept in its results.
  serveAll();
  curves = ended;
  await draw(server.record);
  assert.ok(document.querySelector('.item-summary.is-done'));
  assert.doesNotMatch(render.text(), /Live/);
  assert.match(render.text(), /Yes: the grokking step falls with decay\./);
  const figure = document.querySelector('.item-figure a');
  assert.equal(figure?.getAttribute('href'), '/artifacts/art_2');
  assert.match(render.text(), /Passed/);
  assert.match(render.text(), /lab-gpu-01/);
  await render.unmount();

  // An item that logged no metrics shows nothing of Trackio: no curve, no figure, no metric.
  serveAll();
  curves = {};
  await draw({
    ...structuredClone(server.record),
    id: QUIET,
    workflow: { ...server.record.workflow, state: 'running' },
    settled: false,
    evidence: [],
    conclusion: null,
  });
  assert.equal(document.querySelector('.item-curve, .item-figure, .item-spark'), null);
  assert.doesNotMatch(render.text(), /val\/acc|Live/);
  await render.unmount();
});
