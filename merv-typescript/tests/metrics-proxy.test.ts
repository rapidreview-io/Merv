import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { ApiRequest } from '@merv/api/types';
import { metricsProxy } from '@merv/metrics/proxy';
import { Tokens } from '@merv/metrics/tokens';

const tokens = new Tokens('s'.repeat(32));
const expires = () => Math.floor(Date.now() / 1000) + 1000;
const write = (project = 'project') =>
  tokens.sign({ k: 'w', p: project, e: 'experiment', g: 'decay-sweep', a: 3, x: expires() });
const view = (project = 'project') =>
  `merv_trackio_${project}=${tokens.sign({ k: 'v', p: project, u: 'actor', x: expires() })}`;
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(t: TestContext) {
  const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let uploads = 0;
  // Runs Trackio already holds: id → name and config (with the attempt tags, when tagged).
  const held = new Map<string, { name: string; config: Record<string, unknown> | null }>();
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('set-cookie', 'trackio_write_token=upstream-secret');
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/api/upload'))
      return res.end(JSON.stringify({ paths: [`/tmp/staged-${++uploads}`] }));
    if (req.url?.endsWith('/get_runs_for_project'))
      return res.end(
        JSON.stringify({
          data: [...held].map(([id, { name }]) => ({ id, name, created_at: 't' })),
        }),
      );
    if (req.url?.endsWith('/get_run_configs'))
      return res.end(
        JSON.stringify({
          data: Object.fromEntries([...held].map(([id, { config }]) => [id, config])),
        }),
      );
    res.end(
      JSON.stringify({
        data: req.url?.includes('get_settings')
          ? { media_dir: '/private', color_palette: ['blue'] }
          : 'ok',
      }),
    );
  });
  const revoked = new Set<string>();
  const checked: string[] = [];
  const handler = metricsProxy(
    {
      upstream: await listen(upstream),
      writeToken: 'server-secret',
      mediaDir: '/data/trackio/media',
    },
    tokens,
    async (token) => {
      checked.push(token.p);
      return !revoked.has(token.p);
    },
  );
  const server = createServer(async (req, res) => {
    try {
      const result = await handler(req, res, {} as ApiRequest);
      if (result !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
      }
    } catch (error: any) {
      res.statusCode = error.status ?? 500;
      res.end(JSON.stringify({ error: error.code }));
    }
  });
  const origin = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });
  const send = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = { cookie: view() },
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const api = (
    name: string,
    body: unknown = { project: 'project' },
    headers?: Record<string, string>,
  ) => send(`/trackio/api/${name}`, body, headers);
  /** Stages one upload as a project's training job does, returning Trackio's handle. */
  const stage = async (project = 'project') =>
    (
      await send('/trackio/api/upload', '--fixture--', {
        'x-trackio-write-token': write(project),
        'content-type': 'multipart/form-data; boundary=fixture',
      })
    ).body.paths[0] as string;
  return { seen, revoked, checked, send, api, stage, origin, held };
}
test('tokens authenticate kind, project, tampering and expiry', () => {
  const token = write();
  assert.equal(tokens.verify(token)?.k, 'w');
  assert.equal(tokens.verify(token, expires() + 1), undefined);
  assert.equal(tokens.verify(token.slice(0, -2) + 'aa'), undefined);
  assert.equal(tokens.verify('broken'), undefined);
  assert.equal(new Tokens('other').verify(token), undefined);
  assert.equal(
    tokens.verify(tokens.sign({ k: 'v', p: 'project', u: 'actor', x: 100 }), 100),
    undefined,
  );
});
test('data requests require exact project names and live view authority', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('get_logs', {}, {})).status, 401);
  for (const project of ['other', 'proj.ect', 'project ', 'prоject', 'project/', undefined])
    assert.equal((await f.api('get_logs', { project })).status, 403);
  assert.equal((await f.api('get_logs', { project: 'project' })).status, 200);
  assert.equal(f.seen.length, 1);
  f.revoked.add('project');
  assert.equal((await f.api('get_logs')).status, 403);
  const checked = f.checked.length;
  assert.equal((await f.send('/trackio/assets/main.js')).status, 200);
  assert.equal(f.checked.length, checked);
  assert.equal(
    (await f.api('get_logs', { project: 'project' }, { 'x-trackio-write-token': write() })).status,
    200,
  );
});
test('named arguments are canonical; positional and malformed bodies fail closed', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { data: ['project'] },
    [],
    { args: ['project'], kwargs: {} },
    { args: [] },
    { kwargs: [] },
    { kwargs: {}, project: 'project' },
    'bad json',
  ])
    assert.equal((await f.api('get_logs', body)).status, 400);
  for (const body of [
    { project: 'project' },
    { kwargs: { project: 'project' }, args: [] },
    { kwargs: { project: 'project' } },
  ])
    assert.equal((await f.api('get_logs', body)).status, 200);
  for (const request of f.seen)
    assert.deepEqual(JSON.parse(request.body), { kwargs: { project: 'project' } });
  for (const name of ['get_logs_batch', 'get_system_logs_batch']) {
    assert.equal(
      (await f.api(name, { project: 'project', runs: [{ run: 'a', project: 'other' }] })).status,
      403,
    );
    assert.equal(
      (
        await f.api(name, {
          project: 'project',
          runs: [{ run: 'a', project: 'project' }, { run_id: 'id' }],
        })
      ).status,
      200,
    );
  }
});
test('only write tokens may write; every entry is checked and configs are tagged', async (t) => {
  const f = await fixture(t);
  const headers = { 'x-trackio-write-token': write() };
  const bodies = {
    log: { project: 'project', run: 'a' },
    bulk_log: {
      logs: [{ project: 'project', config: { _merv_experiment: 'forged', _merv_attempt: 9 } }],
    },
    bulk_log_system: { logs: [{ project: 'project' }] },
    bulk_alert: { alerts: [{ project: 'project' }] },
    bulk_upload_media: {
      uploads: [{ project: 'project', uploaded_file: { path: await f.stage() } }],
    },
  };
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal((await f.api(name, body)).status, 403);
    assert.equal((await f.api(name, body, headers)).status, 200);
    const args = JSON.parse(f.seen.at(-1)!.body).kwargs;
    if (name === 'bulk_log')
      assert.deepEqual(args.logs[0].config, {
        _merv_experiment: 'experiment',
        _merv_attempt: 3,
        _Group: 'decay-sweep',
      });
    assert.equal(f.seen.at(-1)!.headers['x-trackio-write-token'], 'server-secret');
    assert.equal(
      (await f.api(name, JSON.parse(JSON.stringify(body).replace('project"', 'other"')), headers))
        .status,
      403,
    );
  }
  assert.equal(
    (await f.api('bulk_log', { logs: [{ project: 'project' }, { project: 'other' }] }, headers))
      .status,
    403,
  );
  assert.equal(
    (await f.api('bulk_log', { logs: [{ project: 'project', config: [] }] }, headers)).status,
    400,
  );
  assert.equal((await f.api('bulk_log', { logs: {} }, headers)).status, 400);
  // Trackio joins run, step and relative_path into a file path without checking them.
  for (const upload of [
    { run: '../..', step: 0 },
    { run: 'a/../../other', step: 0 },
    { run: 'a', step: '../../other' },
    { run: null, relative_path: '../other.db' },
    { run: null, relative_path: '/etc/x' },
    { run: null, relative_path: 'a/%2e%2e/b' },
  ])
    assert.equal(
      (
        await f.api(
          'bulk_upload_media',
          {
            uploads: [{ project: 'project', uploaded_file: { path: await f.stage() }, ...upload }],
          },
          headers,
        )
      ).status,
      403,
    );
  for (const upload of [
    { run: 'train', step: 4 },
    { run: null, relative_path: 'configs/a.yaml' },
  ])
    assert.equal(
      (
        await f.api(
          'bulk_upload_media',
          {
            uploads: [{ project: 'project', uploaded_file: { path: await f.stage() }, ...upload }],
          },
          headers,
        )
      ).status,
      200,
    );
  // Trackio's staged uploads are global: a handle stays with the project that staged it, once.
  const foreign = await f.stage('other');
  const own = await f.stage();
  const media = (path: string) => ({
    uploads: [{ project: 'project', run: 'a', step: 0, uploaded_file: { path } }],
  });
  assert.equal((await f.api('bulk_upload_media', media(foreign), headers)).status, 403);
  assert.equal((await f.api('bulk_upload_media', media('/tmp/guessed'), headers)).status, 403);
  assert.equal((await f.api('bulk_upload_media', media(own), headers)).status, 200);
  assert.equal((await f.api('bulk_upload_media', media(own), headers)).status, 403);
});
test('mutations, unlisted routes, encoded paths and unsupported methods are never forwarded', async (t) => {
  const f = await fixture(t);
  for (const name of [
    'delete_run',
    'rename_run',
    'force_sync',
    'upload_db_to_space',
    'create_artifact',
    'get_registry',
    'anything',
  ])
    assert.equal((await f.api(name)).status, 404);
  for (const path of [
    '/trackio/oauth/callback',
    '/trackio/gradio_api/info',
    '/trackio/mcp',
    '/trackio/mcp-stream',
    '/trackio/api/get_logs',
    '/trackio/secret.db',
    '/trackio/assets/%2fsecret',
    '/trackio/static/secret.js',
  ])
    assert.equal((await f.send(path)).status, 404);
  assert.equal((await f.send('/trackio/', undefined, { cookie: view() }, 'PUT')).status, 404);
  assert.equal(f.seen.length, 0);
  for (const path of [
    '/trackio/',
    '/trackio/runs',
    '/trackio/media',
    '/trackio/version',
    '/trackio/a-spa-path',
    '/trackio/static/trackio/logo.svg',
  ])
    assert.equal((await f.send(path)).status, 200);
});
test('media paths cannot traverse or cross projects; file needs a view token, blobs match either kind', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/data/trackio/media/other/a.png',
    '/data/trackio/media/project/../other/a',
    '/data/trackio/media/project/a/../../other/a',
    '/data/trackio/media/project2/a',
    '/data/trackio/media/project',
    '/etc/passwd',
    '/data/trackio/media/project/\\..\\a',
    // Trackio unquotes again: a second encoding must not become ".." upstream.
    '/data/trackio/media/project/%2e%2e/other/a.png',
  ])
    assert.equal((await f.send(`/trackio/file?path=${encodeURIComponent(path)}`)).status, 403);
  const path = '/trackio/file?path=' + encodeURIComponent('/data/trackio/media/project/a.png');
  assert.equal((await f.send(path)).status, 200);
  await fetch(f.origin + path, { headers: { cookie: view(), range: 'bytes=0-9' } });
  assert.equal(f.seen.at(-1)!.headers.range, 'bytes=0-9');
  // Uploaded HTML or SVG must not run script on Merv's origin.
  for (const served of [path, '/trackio/artifact_blob/project/abc']) {
    const response = await fetch(f.origin + served, { headers: { cookie: view() } });
    assert.equal(
      response.headers.get('content-security-policy'),
      'sandbox allow-scripts allow-downloads',
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await f.send(path, undefined, { 'x-trackio-write-token': write() })).status, 403);
  assert.equal((await f.send('/trackio/artifact_blob/other/abc')).status, 403);
  assert.equal((await f.send('/trackio/artifact_blob/project/abc')).status, 200);
  assert.equal(
    (
      await f.send('/trackio/artifact_blob/project/abc', undefined, {
        'x-trackio-write-token': write(),
      })
    ).status,
    200,
  );
  f.revoked.add('project');
  assert.equal((await f.send(path)).status, 403);
  assert.equal((await f.send('/trackio/artifact_blob/project/abc')).status, 403);
});
test('local answers use Trackio envelopes and only valid token projects; settings pass through', async (t) => {
  const f = await fixture(t);
  const headers = { cookie: `${view()}; ${view('second')}; merv_trackio_fake=bad` };
  assert.deepEqual((await f.api('get_all_projects', {}, headers)).body, {
    data: ['project', 'second'],
  });
  f.revoked.add('second');
  assert.deepEqual((await f.api('get_all_projects', {}, headers)).body, { data: ['project'] });
  assert.deepEqual((await f.api('get_run_mutation_status', {})).body, {
    data: { spaces: false, allowed: false, auth: 'none' },
  });
  assert.equal(f.seen.length, 0);
  assert.deepEqual((await f.api('get_settings', {})).body, {
    data: { media_dir: '/private', color_palette: ['blue'] },
  });
});
test('client credentials and upstream cookies never cross the proxy', async (t) => {
  const f = await fixture(t);
  const response = await f.send(
    '/trackio/api/get_logs?write_token=secret&write_token=again',
    { project: 'project' },
    {
      'x-trackio-write-token': write(),
      cookie: 'trackio_write_token=bad; session=secret',
      authorization: 'Bearer private',
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const upstream = f.seen[0]!;
  assert.equal(upstream.path, '/trackio/api/get_logs');
  for (const name of ['cookie', 'authorization', 'x-trackio-write-token'])
    assert.equal(upstream.headers[name], undefined);
  assert.equal(
    (
      await f.api(
        'get_logs',
        { project: 'project' },
        { 'x-trackio-write-token': 'bad', cookie: view() },
      )
    ).status,
    401,
  );
});
test('JSON and multipart bodies are capped before contacting upstream', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('get_logs', 'x'.repeat(8 * 1024 * 1024 + 1))).status, 413);
  const headers = {
    'x-trackio-write-token': write(),
    'content-type': 'multipart/form-data; boundary=fixture',
  };
  assert.equal(
    (
      await f.send('/trackio/api/upload', '--fixture--', {
        cookie: view(),
        'content-type': headers['content-type'],
      })
    ).status,
    403,
  );
  assert.equal((await f.send('/trackio/api/upload', '--fixture--', headers)).status, 200);
  assert.equal(f.seen.at(-1)!.headers['x-trackio-write-token'], 'server-secret');
  // Stream the oversized upload so the cap is exercised without a second 64 MB allocation.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(f.origin + '/trackio/api/upload', { method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024);
    void (async () => {
      for (let i = 0; i < 65; i++) if (!req.write(chunk)) await once(req, 'drain');
      req.end();
    })().catch(reject);
  });
  assert.equal(status, 413);
  assert.equal(f.seen.length, 1);
});

test('the entire read allowlist enforces project scope, including write-token reads', async (t) => {
  const f = await fixture(t);
  const names =
    'get_runs_for_project get_run_configs get_metrics_for_run get_metric_values get_project_summary get_run_summary get_system_metrics_for_run get_system_logs get_system_logs_batch get_snapshot get_logs get_logs_batch get_alerts get_project_files get_tab_availability get_traces get_trace_steps query_project get_run_artifact_counts get_artifacts list_artifacts'.split(
      ' ',
    );
  for (const name of names) {
    const args = {
      project: 'project',
      ...(name.endsWith('_batch') ? { runs: [{ run: 'a' }] } : {}),
    };
    assert.equal((await f.api(name, args)).status, 200, name);
    assert.equal((await f.api(name, { ...args, project: 'other' })).status, 403, name);
    assert.equal(
      (await f.api(name, { ...args, project: 'other' }, { 'x-trackio-write-token': write() }))
        .status,
      403,
      name,
    );
  }
});
test('cookie names are project-bound, expiry is checked, and static HEAD authenticates', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send('/trackio/', undefined, {})).status, 401);
  const expired = tokens.sign({ k: 'v', p: 'project', u: 'actor', x: 1 });
  assert.equal(
    (await f.api('get_logs', { project: 'project' }, { cookie: `merv_trackio_project=${expired}` }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.api(
        'get_logs',
        { project: 'project' },
        { cookie: view().replace('merv_trackio_project=', 'merv_trackio_other=') },
      )
    ).status,
    401,
  );
  const response = await fetch(f.origin + '/trackio/assets/main.js', {
    method: 'HEAD',
    headers: { cookie: view() },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  const raw = await new Promise<number>((resolve, reject) => {
    const req = request(
      f.origin,
      { path: '/trackio/assets/%2e%2e/file', headers: { cookie: view() } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(raw, 404);
});

test('a run belongs to the experiment attempt that first logged it', async (t) => {
  const f = await fixture(t);
  const headers = { 'x-trackio-write-token': write() };
  const tags = (e: string, a: number) => ({ _merv_experiment: e, _merv_attempt: a, _Group: 'g' });
  f.held.set('theirs', { name: 'train', config: tags('other-experiment', 3) });
  f.held.set('earlier', { name: 'old', config: tags('experiment', 2) });
  f.held.set('mine', { name: 'mine', config: tags('experiment', 3) });
  f.held.set('bare', { name: 'bare', config: null });
  const log = (entry: Record<string, unknown>) =>
    f.api(
      'bulk_log',
      { logs: [{ project: 'project', metrics: { x: 1 }, step: 0, ...entry }] },
      headers,
    );
  // Another experiment's run, by id or by name, with or without a config, and another attempt's.
  for (const entry of [
    { run: 'train', run_id: 'theirs', config: null },
    { run: 'train', run_id: 'theirs', config: {} },
    { run: 'train' },
    { run: 'old', run_id: 'earlier' },
  ])
    assert.equal((await log(entry)).status, 403, JSON.stringify(entry));
  for (const name of ['bulk_log_system', 'bulk_alert'])
    assert.equal(
      (
        await f.api(
          name,
          {
            logs: [{ project: 'project', run: 'train' }],
            alerts: [{ project: 'project', run: 'train' }],
          },
          headers,
        )
      ).status,
      403,
    );
  // Its own run keeps logging; a new or untagged run is stamped on its first entry only.
  assert.equal((await log({ run: 'mine', run_id: 'mine', config: null })).status, 200);
  assert.equal(JSON.parse(f.seen.at(-1)!.body).kwargs.logs[0].config, null);
  const fresh = await f.api(
    'bulk_log',
    {
      logs: [
        { project: 'project', run: 'new', run_id: 'new', config: null },
        { project: 'project', run: 'new', run_id: 'new', config: null },
        { project: 'project', run: 'bare', run_id: 'bare', config: null },
      ],
    },
    headers,
  );
  assert.equal(fresh.status, 200);
  const [first, second, bare] = JSON.parse(f.seen.at(-1)!.body).kwargs.logs;
  assert.equal(first.config._merv_experiment, 'experiment');
  assert.equal(second.config, null);
  assert.equal(bare.config._merv_attempt, 3);
});
