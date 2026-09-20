import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SandboxClient } from '../packages/sandboxes/src/client.js';

const tokenEnv = 'MERV_SANDBOXES_TRANSPORT_TEST_TOKEN';
const connection = { projectId: 'project_streams', namespace: 'streams', tokenEnv };

function client(t: TestContext, response: () => Response) {
  const previous = process.env[tokenEnv];
  process.env[tokenEnv] = 'sbxt_transport_fixture';
  t.after(() => {
    if (previous === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previous;
  });
  t.mock.method(globalThis, 'fetch', async (url: URL) =>
    url.pathname === '/v1/auth/me'
      ? Response.json({ role: 'consumer', namespace: connection.namespace })
      : response(),
  );
  return new SandboxClient('https://sandbox.invalid');
}

function streamed(
  chunkBytes: number,
  count: number,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const observed = { chunks: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (observed.chunks === count) controller.close();
        else {
          observed.chunks++;
          controller.enqueue(Buffer.alloc(chunkBytes, 32));
        }
      },
      cancel() {
        observed.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    observed,
    response: new Response(body, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    }),
  };
}

test('sandbox success bodies enforce the byte limit, including multibyte JSON', async (t) => {
  // Less than 4M JavaScript characters, but more than 4M bytes after UTF-8 encoding.
  const body = JSON.stringify({ value: 'é'.repeat(2_000_000) });
  assert.ok(body.length < 4_000_000 && Buffer.byteLength(body) > 4_000_000);
  const transport = client(
    t,
    () =>
      new Response(body, {
        // This can describe a compressed response; the decoded stream still needs its own limit.
        headers: { 'content-type': 'application/json', 'content-length': '128' },
      }),
  );
  await assert.rejects(transport.read(connection, '/v1/sandboxes'), {
    code: 'sandbox_unavailable',
  });
});

test('sandbox success bodies stop reading as soon as their streaming budget is exceeded', async (t) => {
  const { response, observed } = streamed(1_000_001, 10);
  const transport = client(t, () => response);
  await assert.rejects(transport.read(connection, '/v1/sandboxes'), {
    code: 'sandbox_unavailable',
  });
  assert.equal(observed.chunks, 4, 'do not buffer the rest of an already oversized body');
  assert.equal(observed.cancelled, true);
});

test('sandbox write errors have a small streaming budget and cancel oversized bodies', async (t) => {
  const { response, observed } = streamed(1024, 20, { status: 409 });
  const transport = client(t, () => response);
  await assert.rejects(
    transport.write(connection, 'POST', '/v1/sandboxes/sbx_test/renew', {
      lease_seconds: 600,
      expected_revision: 1,
    }),
    { code: 'sandbox_forbidden' },
  );
  assert.equal(observed.chunks, 5, 'the 4096-byte error budget must apply during streaming');
  assert.equal(observed.cancelled, true);
});

const rejectedResponses: {
  label: string;
  status: number;
  headers: Record<string, string>;
  code: string;
}[] = [
  { label: 'read refusal', status: 403, headers: {}, code: 'sandbox_forbidden' },
  {
    label: 'redirect',
    status: 302,
    headers: { location: 'https://other.invalid' },
    code: 'sandbox_redirect_refused',
  },
  {
    label: 'wrong media type',
    status: 200,
    headers: { 'content-type': 'text/html' },
    code: 'sandbox_unavailable',
  },
  {
    label: 'oversized declared body',
    status: 200,
    headers: { 'content-length': '4000001' },
    code: 'sandbox_unavailable',
  },
];
for (const scenario of rejectedResponses) {
  test(`sandbox ${scenario.label} cancels the rejected body without reading it`, async (t) => {
    const { response, observed } = streamed(1024, 20, scenario);
    const transport = client(t, () => response);
    await assert.rejects(transport.read(connection, '/v1/sandboxes'), { code: scenario.code });
    assert.equal(observed.chunks, 0);
    assert.equal(observed.cancelled, true);
  });
}

test('sandbox transport preserves a valid small JSON response and a bounded write refusal', async (t) => {
  let next = () => Response.json({ value: '研究' });
  const transport = client(t, () => next());
  assert.deepEqual(await transport.read(connection, '/v1/sandboxes'), { value: '研究' });
  next = () =>
    Response.json(
      { error: { code: 'operation_state', message: 'sandbox is stopped' } },
      { status: 409 },
    );
  await assert.rejects(
    transport.write(connection, 'POST', '/v1/sandboxes/sbx_test/renew', {
      lease_seconds: 600,
    }),
    { code: 'sandbox_operation_state', status: 409, message: 'sandbox is stopped' },
  );
});

test('sandbox transport sanitizes interrupted bodies and recovers on the next call', async (t) => {
  let next = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('secret upstream diagnostic'));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const transport = client(t, () => next());
  await assert.rejects(transport.read(connection, '/v1/sandboxes'), {
    code: 'sandbox_unavailable',
    message: 'merv-sandboxes answered invalid JSON',
  });
  next = () => Response.json({ recovered: true });
  assert.deepEqual(await transport.read(connection, '/v1/sandboxes'), { recovered: true });
});

test(
  'sandbox transport deadline covers a real stalled response body',
  { timeout: 5000 },
  async (t) => {
    const previous = process.env[tokenEnv];
    process.env[tokenEnv] = 'sbxt_transport_fixture';
    t.after(() => {
      if (previous === undefined) delete process.env[tokenEnv];
      else process.env[tokenEnv] = previous;
    });
    let disconnected!: Promise<unknown>;
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/v1/auth/me') {
        response.end(JSON.stringify({ role: 'consumer', namespace: connection.namespace }));
      } else {
        disconnected = once(response, 'close');
        response.write('{"secret":"never finishes');
      }
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const transport = new SandboxClient(`http://127.0.0.1:${address.port}`, 200);
    await assert.rejects(transport.read(connection, '/v1/sandboxes'), {
      code: 'sandbox_unavailable',
      message: 'merv-sandboxes answered invalid JSON',
    });
    assert.ok(disconnected, 'the request must reach its response body');
    await disconnected;
  },
);
