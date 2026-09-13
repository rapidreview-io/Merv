import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { NisaServer } from './fixtures/nisa-server.js';

async function setup(t: any, extra: Record<string, unknown> = {}) {
  const upstream = new NisaServer({
    identities: {
      'Bearer synthetic-nisa-a': 'a',
      'Bearer synthetic-nisa-b': 'b',
    },
  });
  await upstream.start();
  const directory = mkdtempSync(join(tmpdir(), 'merv-nisa-'));
  const config: ApplicationConfig = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins.unshift({
    id: 'literature',
    name: '@merv/nisa',
    config: { apiOrigin: upstream.url, ...extra },
  });
  const app = await createApp({ directory, config, port: 0 });
  const a = app.ctx.scope.bootstrap({ projectName: 'Nisa A', actorName: 'A' });
  const b = app.ctx.scope.bootstrap({ projectName: 'Nisa B', actorName: 'B' });
  const caller = { actorId: a.actor.id, projectId: a.project.id };
  const other = { actorId: b.actor.id, projectId: b.project.id };
  const env = `MERV_NISA_TEST_${randomUUID().replaceAll('-', '_')}`;
  process.env[env] = 'synthetic-nisa-a';
  const binding = { id: 'nisa-a', ...caller, mountId: 'nisa', secretRef: `env:${env}` };
  const grant = { ...caller, mountId: 'nisa', tools: ['search', 'paper'] };
  app.ctx.credentials.replace([binding]);
  app.ctx.access.replace([grant]);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
    await upstream.close();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = async (token: string) => {
    const client = new Client({ name: 'nisa-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(app.ctx.api.url! + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const http = async (token: string, name: string, args: unknown) => {
    const response = await fetch(app.ctx.api.url! + '/tools/' + name, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  return { upstream, app, a, b, caller, other, env, binding, grant, connect, http };
}

test('Nisa preserves full search and paper references through HTTP and MCP without agent enrichment', async (t) => {
  const s = await setup(t);
  const paper = {
    arxiv_id: '1706.03762',
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    authors: ['Example Author'],
    abstract: 'Fixture abstract',
    source: 'bm25',
    why: 'Exact match',
    snippets: ['retained excerpt'],
    extra: { preserved: true },
  };
  const legacy = {
    arxiv_id: 'cs/0001001',
    title: 'Legacy paper',
    url: 'https://arxiv.org/abs/cs/0001001',
  };
  const underscored = {
    arxiv_id: 'cs_0001001',
    title: 'Legacy underscore paper',
    url: 'https://arxiv.org/abs/cs_0001001',
    source: 'bm25',
    extra: { rawIdRetained: true },
  };
  const data = {
    query: 'attention',
    count: 3,
    offset: 0,
    limit: 3,
    truncated: false,
    index_latest_pub_month: 202608,
    papers: [paper, legacy, underscored],
  };
  s.upstream.setSearch({ body: data });
  s.upstream.setPaper('1706.03762', { body: paper });
  const client = await s.connect(s.a.token);
  assert.equal((await client.listTools()).tools.length, 28);
  const result = await client.request(
    {
      method: 'tools/call',
      params: { name: 'mount__nisa__search', arguments: { query: 'attention', max_results: 3 } },
    },
    CallToolResultSchema,
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.data, data);
  assert.deepEqual(
    JSON.parse((result.content as { text: string }[])[0].text),
    result.structuredContent,
  );
  assert.deepEqual(
    (result.structuredContent?.sources as any[]).map((source) => source.url),
    [paper.url, legacy.url, 'https://arxiv.org/abs/cs/0001001'],
  );
  assert.equal((result.structuredContent?.sources as any[])[2].arxivId, underscored.arxiv_id);
  assert.deepEqual(s.upstream.requests[0].body, {
    query: 'attention',
    max_results: 3,
    offset: 0,
    enrich: false,
  });
  const retrieved = await s.http(s.a.token, 'mount__nisa__paper', { arxiv_id: '1706.03762' });
  assert.equal(retrieved.status, 200);
  assert.deepEqual(retrieved.data.result.structuredContent.data, paper);
  assert.equal(s.upstream.requests.length, 2);
  assert.equal(s.upstream.requests[1].path, '/api/sdk/paper/1706.03762');
});

test('Nisa checks exact grants, current bindings, project identity, and rotation on each dispatch', async (t) => {
  const s = await setup(t);
  const otherClient = await s.connect(s.b.token);
  assert.equal((await otherClient.listTools()).tools.length, 26);
  assert.equal((await s.http(s.b.token, 'mount__nisa__search', { query: 'test' })).status, 403);
  s.app.ctx.access.replace([s.grant, { ...s.grant, ...s.other }]);
  assert.equal((await s.http(s.b.token, 'mount__nisa__search', { query: 'test' })).status, 403);
  assert.equal(s.upstream.requests.length, 0);
  assert.equal((await s.http(s.a.token, 'mount__nisa__search', { query: 'test' })).status, 200);
  process.env[s.env] = 'synthetic-nisa-b';
  assert.equal((await s.http(s.a.token, 'mount__nisa__search', { query: 'test' })).status, 200);
  assert.deepEqual(
    s.upstream.requests.map((request) => request.identityLabel),
    ['a', 'b'],
  );
  s.app.ctx.credentials.replace([]);
  assert.equal(
    (await s.http(s.a.token, 'mount__nisa__paper', { arxiv_id: '1706.03762' })).status,
    403,
  );
  s.app.ctx.credentials.replace([s.binding]);
  s.app.ctx.access.replace([{ ...s.grant, tools: ['paper'] }]);
  assert.equal((await s.http(s.a.token, 'mount__nisa__search', { query: 'test' })).status, 403);
  assert.equal(s.upstream.requests.length, 2);
});

test('Nisa refuses unsupported inputs before dispatch', async (t) => {
  const s = await setup(t);
  for (const args of [
    { query: '' },
    { query: 'ok', enrich: true },
    { query: 'ok', max_results: 21 },
    { query: 'ok', offset: -1 },
    { query: ['ok'] },
    { query: 'ok', apiOrigin: 'https://example.com' },
  ])
    assert.equal((await s.http(s.a.token, 'mount__nisa__search', args)).status, 400);
  for (const arxiv_id of ['../usage', 'cs/0001001', '1706.03762?redirect=1', '1799.03762'])
    assert.equal((await s.http(s.a.token, 'mount__nisa__paper', { arxiv_id })).status, 400);
  assert.equal(s.upstream.requests.length, 0);
});

test('Nisa rejects redirects and bounded invalid upstream responses with sanitized errors and no retries', async (t) => {
  const s = await setup(t, { maxResponseBytes: 1024 });
  const secretText = 'Bearer synthetic-nisa-a sensitive-upstream-message';
  const cases = [
    { status: 401, body: secretText },
    { status: 500, body: secretText },
    { redirect: s.upstream.url + '/forbidden', body: secretText },
    { body: 'broken JSON ' + secretText },
    { body: { error: secretText } },
    { body: { papers: [{ arxiv_id: '1706.03762', title: 'x'.repeat(2048) }] } },
    { body: { papers: [{ arxiv_id: '../../bad', title: 'Bad' }] } },
  ];
  for (const reply of cases) {
    s.upstream.setSearch(reply);
    const count = s.upstream.requests.length;
    const result = await s.http(s.a.token, 'mount__nisa__search', { query: 'test' });
    assert.ok(result.status >= 400);
    assert.ok(!JSON.stringify(result.data).includes(secretText));
    assert.ok(!JSON.stringify(result.data).includes('synthetic-nisa-a'));
    assert.equal(s.upstream.requests.length, count + 1);
  }
  assert.ok(s.upstream.requests.every((request) => request.path === '/api/sdk/search'));
});

test('Nisa body deadline bounds unload even when an admitted response stalls', async (t) => {
  const s = await setup(t, { timeoutMs: 250 });
  s.upstream.setSearch({ body: '{', stallBody: true });
  const held = s.upstream.holdNextRequest();
  const pending = s.http(s.a.token, 'mount__nisa__search', { query: 'test' });
  await held.entered;
  const start = Date.now();
  const stopped = s.app.setEnabled('literature', false);
  held.release();
  const result = await pending;
  assert.ok(result.status >= 400);
  await stopped;
  assert.ok(Date.now() - start < 2000);
  assert.equal(s.app.ctx.tools.list().length, 26);
  assert.equal(s.upstream.requests.length, 1);
});
