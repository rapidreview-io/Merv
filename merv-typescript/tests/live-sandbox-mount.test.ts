import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  parseOptions,
  checkPreparation,
  installBoundary,
  verifyAgentToolResult,
  type Boundary,
} from '../scripts/live-sandbox-mount.js';

const endpoint = 'https://sandboxes.rapidreview.io/mcp';
const identity = {
  namespace: 'test-namespace',
  account_id: 'test-account',
  member_id: 'test-member',
};
const token = 'sbxt_SYNTHETIC_TEST_ONLY';
const request = (
  params: Record<string, unknown> = { name: 'usage_report', arguments: {} },
): RequestInit => ({
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'x-sandbox-namespace': identity.namespace,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }),
});
const envelope = (data: Record<string, unknown> = identity) => ({
  jsonrpc: '2.0',
  id: 7,
  result: {
    content: [{ type: 'text', text: JSON.stringify(data), _meta: { retained: true } }],
    structuredContent: data,
    _meta: { fixture: true },
  },
});
function setup(t: TestContext, respond: () => Response) {
  const requests: Request[] = [];
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return respond();
    },
  );
  const boundary: Boundary = {
    token,
    identity,
    identityRequests: 0,
    toolDispatches: 0,
    blockedRequests: 0,
    resultScopeVerified: false,
  };
  const restore = installBoundary(boundary, new AbortController().signal);
  t.after(() => {
    restore();
    mock.mock.restore();
  });
  return { boundary, requests };
}

test('live sandbox CLI requires one explicit mode and rejects malformed options', () => {
  for (const args of [
    [],
    ['--unknown'],
    ['--check', '--use-saved-sandbox-token'],
    ['--check', '--check'],
    ['--check', '--output-dir'],
    ['--check', '--output-dir', '--check'],
  ])
    assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(['--check']).mode, 'check');
  assert.equal(parseOptions(['--use-saved-sandbox-token']).mode, 'live');
});

test('check mode reads no saved session, uses no network, and creates no output directory', (t) => {
  let credentialReads = 0;
  let networkRequests = 0;
  const original = fs.readFileSync;
  const fileMock = t.mock.method(
    fs,
    'readFileSync',
    (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).includes('.sandboxes')) {
        credentialReads++;
        throw new Error('Private session access forbidden in this test');
      }
      return Reflect.apply(original, fs, args);
    },
  );
  syncBuiltinESMExports();
  t.mock.method(globalThis, 'fetch', async () => {
    networkRequests++;
    throw new Error('Network forbidden in this test');
  });
  t.after(() => {
    fileMock.mock.restore();
    syncBuiltinESMExports();
  });
  const path = `/private/tmp/merv-sandbox-check-${randomUUID()}`;
  const result = checkPreparation(path);
  assert.equal(result.status, 'prepared');
  assert.ok(result.pluginCount >= 18);
  assert.equal(result.tool, '_sandbox.usage_report');
  assert.equal(credentialReads, 0);
  assert.equal(networkRequests, 0);
  assert.equal(fs.existsSync(path), false);
});

test('outbound boundary rejects other origins, paths, credentials, tools, and nonempty arguments before dispatch', async (t) => {
  const { boundary, requests } = setup(t, () => new Response(JSON.stringify(envelope())));
  for (const [url, init] of [
    ['https://example.invalid/mcp', request()],
    ['https://sandboxes.rapidreview.io/v1/sandboxes', request()],
    [endpoint + '?redirect=elsewhere', request()],
    [endpoint, { ...request(), headers: { authorization: 'Bearer synthetic-local-token' } }],
    [endpoint, request({ name: 'sandbox_create', arguments: {} })],
    [endpoint, request({ name: 'usage_report', arguments: { namespace: 'another' } })],
    [
      endpoint,
      {
        ...request(),
        body: JSON.stringify([
          {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'usage_report', arguments: {} },
          },
        ]),
      },
    ],
  ] as [string, RequestInit][])
    await assert.rejects(fetch(url, init), { code: 'outbound_request_blocked' });
  assert.equal(boundary.toolDispatches, 0);
  assert.equal(requests.length, 0);
});

for (const format of ['json', 'sse'] as const) {
  test(`one authorized call preserves the complete ${format} response and refuses a second dispatch`, async (t) => {
    const json = JSON.stringify(envelope());
    const body = format === 'json' ? json : `event: message\ndata: ${json}\n\n`;
    const { boundary, requests } = setup(
      t,
      () =>
        new Response(body, {
          headers: {
            'content-type': format === 'json' ? 'application/json' : 'text/event-stream',
            'x-fixture': 'retained',
          },
        }),
    );
    const response = await fetch(endpoint, request());
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get('x-fixture'), 'retained');
    assert.equal(boundary.resultScopeVerified, true);
    assert.equal(boundary.toolDispatches, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].redirect, 'error');
    await assert.rejects(fetch(endpoint, request()), { code: 'outbound_request_blocked' });
    assert.equal(requests.length, 1);
  });
}

test('a mismatched upstream member never reaches the downstream transport', async (t) => {
  const { boundary } = setup(
    t,
    () =>
      new Response(JSON.stringify(envelope({ ...identity, member_id: 'other-member' })), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  await assert.rejects(fetch(endpoint, request()), { code: 'upstream_scope_mismatch' });
  assert.equal(boundary.resultScopeVerified, false);
  assert.equal(boundary.toolDispatches, 1);
});

test(
  'oversized cloned responses cancel both tee branches without waiting indefinitely',
  { timeout: 2000 },
  async (t) => {
    let canceled = false;
    const { boundary } = setup(
      t,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await assert.rejects(fetch(endpoint, request()), { code: 'upstream_response_too_large' });
    assert.equal(canceled, true);
    assert.equal(boundary.resultScopeVerified, false);
  },
);

test('agent evidence requires delivered scoped data and rejects MCP errors encoded in text', () => {
  assert.equal(verifyAgentToolResult(envelope().result, identity), true);
  assert.equal(verifyAgentToolResult({ isError: true, ...envelope().result }, identity), false);
  assert.equal(
    verifyAgentToolResult(
      { content: [{ type: 'text', text: '{"error":{"code":"invalid_result"}}' }] },
      identity,
    ),
    false,
  );
  assert.equal(
    verifyAgentToolResult(
      {
        ...envelope().result,
        content: [{ type: 'text', text: '{"error":{"code":"invalid_result"}}' }],
      },
      identity,
    ),
    false,
  );
  assert.equal(
    verifyAgentToolResult(envelope({ ...identity, namespace: 'other' }).result, identity),
    false,
  );
  assert.equal(
    verifyAgentToolResult({ content: [{ type: 'text', text: 'SUCCESS' }] }, identity),
    false,
  );
});
