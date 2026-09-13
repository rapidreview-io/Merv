import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveNisaFetch,
  freshSavedToken,
  runLiveNisa,
  type LiveNisaBoundary,
} from '../scripts/live-nisa.js';

test('Nisa live preparation does not resolve a credential or open network connections', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('Network is forbidden');
  };
  try {
    const report = await runLiveNisa('--check');
    assert.equal(report.status, 'prepared');
    assert.equal(requests, 0);
    assert.equal('credentialRead' in report && report.credentialRead, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('Nisa live selection refuses expired OAuth without refresh or ambient fallback', () => {
  for (const saved of [
    null,
    {},
    { access_token: 'synthetic', expires_at: 1299 },
    { access_token: 'synthetic', expires_at: 1300 },
    { access_token: 'Bearer bad', expires_at: 1400 },
  ])
    assert.throws(() => freshSavedToken(saved, 1000), /^Error: nisa_/);
  assert.equal(
    freshSavedToken({ access_token: 'synthetic-fresh', expires_at: 1301 }, 1000),
    'synthetic-fresh',
  );
  assert.throws(
    () =>
      freshSavedToken({ api_key: 'rr_sk_synthetic', access_token: 'expired', expires_at: 0 }, 1000),
    /nisa_saved_token_expired/,
  );
});

const sandboxOrigin = 'https://sandboxes.rapidreview.io';
const nisaOrigin = 'https://api.rapidreview.io';
const search = { query: 'flash attention', max_results: 3, offset: 0, enrich: false };
function boundaryFixture() {
  const boundary: LiveNisaBoundary = {
    searchCalls: 0,
    paperCalls: 0,
    attemptedSandboxToolCalls: 0,
    blockedRequests: 0,
  };
  const forwarded: Request[] = [];
  const underlying: typeof fetch = async (input, init) => {
    forwarded.push(new Request(input, init));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  return { boundary, forwarded, guarded: createLiveNisaFetch(underlying, boundary) };
}
const toolCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'usage_report', arguments: {} },
});

test('live Nisa guard inspects Request-wrapped and byte-buffer sandbox calls before dispatch', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  await assert.rejects(
    guarded(new Request(sandboxOrigin + '/mcp', { method: 'POST', body: toolCall })),
    /sandbox_tool_not_authorized/,
  );
  await assert.rejects(
    guarded(sandboxOrigin + '/mcp', { method: 'POST', body: new TextEncoder().encode(toolCall) }),
    /sandbox_tool_not_authorized/,
  );
  assert.equal(boundary.attemptedSandboxToolCalls, 2);
  assert.equal(boundary.blockedRequests, 2);
  assert.equal(forwarded.length, 0);
});

test('live Nisa guard rejects sandbox batches, nonobjects, paths, methods and credentials', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  for (const body of [
    'null',
    '[]',
    '42',
    '"initialize"',
    'not json',
    '[' + toolCall + ']',
    '{"method":["initialize"]}',
  ])
    await assert.rejects(guarded(sandboxOrigin + '/mcp', { method: 'POST', body }));
  for (const [path, method] of [
    ['/v1/other', 'GET'],
    ['/mcp?query=bad', 'GET'],
    ['/mcp', 'PATCH'],
    ['/mcp', 'PUT'],
  ])
    await assert.rejects(guarded(sandboxOrigin + path, { method }));
  await assert.rejects(
    guarded(sandboxOrigin + '/mcp', {
      headers: { authorization: 'Bearer synthetic-not-authorized' },
    }),
    /sandbox_credential_not_authorized/,
  );
  assert.equal(boundary.attemptedSandboxToolCalls, 1);
  assert.equal(boundary.blockedRequests, 12);
  assert.equal(forwarded.length, 0);
});

test('live Nisa guard permits only public MCP lifecycle requests and disables redirect following', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'ping']) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method });
    await guarded(new Request(sandboxOrigin + '/mcp', { method: 'POST', body }));
    assert.equal(await forwarded.at(-1)!.clone().text(), body);
  }
  await guarded(sandboxOrigin + '/mcp', { method: 'GET' });
  await guarded(sandboxOrigin + '/mcp', { method: 'DELETE' });
  await guarded(new Request('http://127.0.0.1:43210/mcp', { method: 'POST', body: '{}' }));
  assert.equal(forwarded.length, 7);
  assert.ok(forwarded.every((request) => request.redirect === 'error'));
  assert.equal(boundary.blockedRequests, 0);
  assert.equal(boundary.attemptedSandboxToolCalls, 0);
});

test('live Nisa guard preserves exact normalized search/paper limits and never dispatches rejected calls', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  const post = (body: unknown, redirect: RequestRedirect = 'error') =>
    new Request(nisaOrigin + '/api/sdk/search', {
      method: 'POST',
      redirect,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  await assert.rejects(guarded(post({ ...search, enrich: true })));
  await assert.rejects(guarded(post(search, 'follow')), /nisa_redirects_not_disabled/);
  await assert.rejects(
    guarded(new Request(nisaOrigin + '/api/sdk/paper/1706.03762', { redirect: 'error' })),
    /nisa_paper_limit/,
  );
  assert.equal(forwarded.length, 0);
  await guarded(post(search));
  assert.deepEqual(JSON.parse(await forwarded[0].clone().text()), search);
  assert.equal(boundary.searchCalls, 1);
  await assert.rejects(guarded(post(search)), /nisa_search_limit/);
  boundary.paperId = '1706.03762';
  await assert.rejects(
    guarded(nisaOrigin + '/api/sdk/paper/1706.03763', { redirect: 'error' }),
    /nisa_paper_limit/,
  );
  await guarded(new Request(nisaOrigin + '/api/sdk/paper/1706.03762', { redirect: 'error' }));
  await assert.rejects(
    guarded(nisaOrigin + '/api/sdk/paper/1706.03762', { redirect: 'error' }),
    /nisa_paper_limit/,
  );
  await assert.rejects(guarded('https://unexpected.example/mcp'), /unexpected_live_origin/);
  assert.equal(boundary.searchCalls, 1);
  assert.equal(boundary.paperCalls, 1);
  assert.equal(boundary.blockedRequests, 7);
  assert.equal(forwarded.length, 2);
  assert.ok(forwarded.every((request) => request.redirect === 'error'));
});

test('live Nisa guard forwards effective Request init overrides rather than the original body or headers', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const request = new Request(sandboxOrigin + '/mcp', {
    method: 'POST',
    body: toolCall,
    headers: { authorization: 'Bearer synthetic-not-forwarded' },
  });
  await guarded(request, { body, headers: { 'content-type': 'application/json' } });
  assert.equal(forwarded.length, 1);
  assert.equal(await forwarded[0].clone().text(), body);
  assert.equal(forwarded[0].headers.has('authorization'), false);
  assert.equal(boundary.blockedRequests, 0);
  assert.equal(boundary.attemptedSandboxToolCalls, 0);
});

test('live Nisa guard admits only one concurrent search after asynchronous body inspection', async () => {
  const { boundary, forwarded, guarded } = boundaryFixture();
  const request = () =>
    new Request(nisaOrigin + '/api/sdk/search', {
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify(search),
    });
  const results = await Promise.allSettled([guarded(request()), guarded(request())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(boundary.searchCalls, 1);
  assert.equal(boundary.blockedRequests, 1);
  assert.equal(forwarded.length, 1);
});

test('a failed upstream dispatch consumes its Nisa allowance and never triggers a retry', async () => {
  for (const kind of ['search', 'paper'] as const) {
    const boundary: LiveNisaBoundary = {
      paperId: '1706.03762',
      searchCalls: 0,
      paperCalls: 0,
      attemptedSandboxToolCalls: 0,
      blockedRequests: 0,
    };
    let dispatched = 0;
    const guarded = createLiveNisaFetch(async () => {
      dispatched++;
      throw new Error('Simulated upstream failure');
    }, boundary);
    const request = () =>
      kind === 'search'
        ? new Request(nisaOrigin + '/api/sdk/search', {
            method: 'POST',
            redirect: 'error',
            body: JSON.stringify(search),
          })
        : new Request(nisaOrigin + '/api/sdk/paper/1706.03762', { redirect: 'error' });
    await assert.rejects(guarded(request()), /Simulated upstream failure/);
    assert.equal(boundary.blockedRequests, 0);
    await assert.rejects(guarded(request()), new RegExp(`nisa_${kind}_limit`));
    assert.equal(dispatched, 1);
    assert.equal(boundary[`${kind}Calls`], 1);
    assert.equal(boundary.blockedRequests, 1);
  }
});
