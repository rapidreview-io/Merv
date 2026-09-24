import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PiModelRelay, type PiRelayConfig, type PiRelayGrant } from '../packages/pi/src/relay.js';

const token = `pir_${'a'.repeat(43)}`;
const request = {
  model: 'test-model',
  stream: true,
  store: false,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
};
const grant = (): PiRelayGrant => ({
  id: 'grant-1',
  userId: 'user-1',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  commandId: 'command-1',
  runtimeId: 'runtime-1',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  model: 'test-model',
  toolNames: ['read_notes'],
});
const eventStream = (data = 'data: {"type":"response.completed"}\n\n') =>
  new Response(data, { headers: { 'content-type': 'text/event-stream', 'x-private': 'secret' } });

async function fixture(overrides: Partial<PiRelayConfig> = {}) {
  let currentGrant = grant();
  let revoked = false;
  const upstreamCalls: { url: string; init: RequestInit }[] = [];
  const relay = new PiModelRelay({
    enabled: true,
    model: 'test-model',
    providerKey: () => 'private-provider-key',
    authority: {
      async authorize(presented) {
        assert.equal(presented, token);
        return currentGrant;
      },
      async validate(candidate) {
        if (revoked || candidate.epoch !== currentGrant.epoch)
          throw Error('private authority details');
      },
    },
    fetchImpl: async (url, init) => {
      upstreamCalls.push({ url: String(url), init: init! });
      return eventStream();
    },
    ...overrides,
  });
  return {
    relay,
    upstreamCalls,
    revoke() {
      revoked = true;
    },
    updateGrant(next: PiRelayGrant) {
      currentGrant = next;
    },
    close() {
      relay.close();
    },
  };
}

function send(
  f: { relay: PiModelRelay },
  body: unknown = request,
  options: RequestInit & { path?: string; backpressure?: boolean } = {},
): Promise<Response> {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.url = options.path ?? '/pi-model/responses';
  req.method = options.method ?? 'POST';
  req.headers = Object.fromEntries(
    new Headers(
      options.headers ?? { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ).entries(),
  );
  req.aborted = false;
  const emitter = new EventEmitter();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
  });
  let status = 200;
  let headers: Record<string, string> = {};
  let headersSent = false;
  let done = false;
  let ready!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const res = Object.assign(emitter, {
    destroyed: false,
    writeHead(nextStatus: number, nextHeaders: Record<string, string>) {
      status = nextStatus;
      headers = nextHeaders;
      headersSent = true;
      ready();
      return this;
    },
    write(value: string | Uint8Array) {
      if (!headersSent) this.writeHead(200, {});
      output.enqueue(typeof value === 'string' ? new TextEncoder().encode(value) : value);
      return !options.backpressure;
    },
    end(value?: string | Uint8Array) {
      if (value) this.write(value);
      if (!headersSent) this.writeHead(200, {});
      if (!done) {
        done = true;
        output.close();
      }
      return this;
    },
  }) as unknown as ServerResponse;
  Object.defineProperty(res, 'headersSent', { get: () => headersSent });
  options.signal?.addEventListener(
    'abort',
    () => {
      (res as unknown as { destroyed: boolean }).destroyed = true;
      emitter.emit('close');
      if (!done) {
        done = true;
        output.error(new Error('client disconnected'));
      }
    },
    { once: true },
  );
  void f.relay.handle(req, res);
  if (req.method === 'POST') req.end(JSON.stringify(body));
  else req.end();
  return responseReady.then(() => new Response(bodyStream, { status, headers }));
}

test('relays only the fixed provider call and supports Pi function/reasoning transcript', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const payload = {
    ...request,
    max_output_tokens: 32,
    prompt_cache_key: 'pi-session-1',
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'low', summary: 'auto' },
    tools: [
      {
        type: 'function',
        name: 'read_notes',
        description: 'Read',
        parameters: {
          type: 'object',
          properties: { id: { $ref: '#/$defs/id' } },
          $defs: { id: { type: 'string' } },
        },
        strict: false,
      },
    ],
    input: [
      ...request.input,
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello', annotations: [] }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'read_notes', arguments: '{"id":"1"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ],
  };
  const response = await send(f, payload, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-private': 'incoming',
    },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.equal(response.headers.get('x-private'), null);
  assert.equal(f.upstreamCalls.length, 1);
  const call = f.upstreamCalls[0]!;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(Object.fromEntries(new Headers(call.init.headers).entries()), {
    authorization: 'Bearer private-provider-key',
    'content-type': 'application/json',
  });
  assert.deepEqual(JSON.parse(String(call.init.body)), payload);
});

test('denies alternate routes, origins, tokens, unsafe payload fields and tools', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const [path, method, status] of [
    ['/pi-model/responses?x=1', 'POST', 404],
    ['/pi-model', 'POST', 404],
    ['/pi-model/responses', 'GET', 405],
  ] as const) {
    const result = await send(f, request, { path, method });
    assert.equal(result.status, status);
  }
  assert.equal(
    (
      await send(f, request, {
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await send(f, request, {
        headers: { authorization: 'Bearer user-key', 'content-type': 'application/json' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await send(f, request, {
        headers: {
          authorization: `Bearer PIR_${'a'.repeat(43)}`,
          'content-type': 'application/json',
        },
      })
    ).status,
    401,
  );
  const attacks = [
    { model: 'another-model' },
    { stream: false },
    { store: true },
    { previous_response_id: 'resp_1' },
    { background: true },
    { conversation: 'conv_1' },
    { max_output_tokens: 4097 },
    {
      input: [
        { role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.example' }] },
      ],
    },
    { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'function', name: 'write_notes', parameters: {} }] },
    {
      tools: [
        {
          type: 'function',
          name: 'read_notes',
          parameters: { type: 'object', $ref: 'https://evil.example/schema' },
        },
      ],
    },
    {
      tools: [
        {
          type: 'function',
          name: 'read_notes',
          parameters: {
            type: 'object',
            properties: { src: { format: 'uri', default: 'https://evil.example' } },
          },
        },
      ],
    },
    { input: [{ type: 'function_call', name: 'write_notes', call_id: 'call_1', arguments: '{}' }] },
    {
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'https://evil.example' }],
        },
      ],
    },
  ];
  for (const attack of attacks)
    assert.equal((await send(f, { ...request, ...attack })).status, 400, JSON.stringify(attack));
  assert.equal(f.upstreamCalls.length, 0);
});

test('rejects missing, expired or revoked grants and does not expose authority errors', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.updateGrant({ ...grant(), expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await send(f)).status, 403);
  f.updateGrant(grant());
  f.revoke();
  const response = await send(f);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /private/);
  assert.equal(f.upstreamCalls.length, 0);
  const unavailable = await fixture({ authority: undefined });
  t.after(() => unavailable.close());
  assert.equal((await send(unavailable)).status, 503);
  const disabled = await fixture({ enabled: false });
  t.after(() => disabled.close());
  assert.equal((await send(disabled)).status, 503);
});

test('revalidates after asynchronous admission before accessing provider', async (t) => {
  let release!: (value: string) => void;
  const key = new Promise<string>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ providerKey: () => key });
  t.after(() => f.close());
  const first = send(f);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await send(f)).status, 429);
  f.revoke();
  release('private-provider-key');
  assert.equal((await first).status, 403);
  assert.equal(f.upstreamCalls.length, 0);
});

test('bounds concurrent users globally and prevents reused grant IDs from changing identity', async (t) => {
  let release!: (value: string) => void;
  const key = new Promise<string>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ providerKey: () => key, maxConcurrent: 1 });
  t.after(() => f.close());
  const first = send(f);
  await new Promise((resolve) => setTimeout(resolve, 20));
  f.updateGrant({ ...grant(), id: 'grant-2', userId: 'user-2' });
  assert.equal((await send(f)).status, 429);
  release('private-provider-key');
  assert.equal((await first).status, 200);
  await (await first).text();
  f.updateGrant({ ...grant(), id: 'grant-1', userId: 'changed-user' });
  assert.equal((await send(f)).status, 403);
});

test('reclaims expired grant counters without evicting live grants', async (t) => {
  const f = await fixture({ maxGrantEntries: 1 });
  t.after(() => f.close());
  f.updateGrant({ ...grant(), expiresAt: new Date(Date.now() + 80).toISOString() });
  assert.equal((await send(f)).status, 200);
  f.updateGrant({
    ...grant(),
    id: 'grant-2',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal((await send(f)).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal((await send(f)).status, 200);
});

test('enforces request bytes, response bytes, deadline, and per-grant request count', async (t) => {
  const f = await fixture({
    maxRequestBytes: 150,
    maxResponseBytes: 30,
    maxRequestsPerGrant: 1,
    fetchImpl: async () => eventStream('data: longer than thirty bytes of upstream text here\n\n'),
  });
  t.after(() => f.close());
  assert.equal(
    (
      await send(f, {
        ...request,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(200) }] }],
      })
    ).status,
    413,
  );
  assert.equal((await send(f)).status, 502);
  assert.equal((await send(f)).status, 429);
  const timeout = await fixture({
    totalTimeoutMs: 80,
    idleTimeoutMs: 25,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  t.after(() => timeout.close());
  const response = await send(timeout);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /relay_interrupted/);
});

test('revocation fences subsequent SSE chunks and disconnect/shutdown abort upstream', async (t) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const signals: AbortSignal[] = [];
  const f = await fixture({
    fetchImpl: async (_url, init) => {
      signals.push(init!.signal!);
      return new Response(
        new ReadableStream({
          start(stream) {
            controller = stream;
            stream.enqueue(new TextEncoder().encode('data: first\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  t.after(() => f.close());
  const response = await send(f);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  f.revoke();
  controller.enqueue(new TextEncoder().encode('data: should-not-pass\n\n'));
  const rest = await new Response(
    new ReadableStream({
      async start(stream) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          stream.enqueue(next.value);
        }
        stream.close();
      },
    }),
  ).text();
  assert.doesNotMatch(rest, /should-not-pass/);
  assert.match(rest, /relay_interrupted/);

  const g = await fixture({
    fetchImpl: async (_url, init) => {
      signals.push(init!.signal!);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('data: first\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  t.after(() => g.close());
  const aborted = new AbortController();
  const second = await send(g, request, { signal: aborted.signal });
  await second.body!.getReader().read();
  aborted.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signals[1]?.aborted, true);
  const third = await send(g);
  await third.body!.getReader().read();
  g.relay.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signals[2]?.aborted, true);
  assert.equal((await send(g)).status, 503);
});

test('stalled downstream writes abort upstream at the idle deadline', async (t) => {
  let upstreamSignal!: AbortSignal;
  const f = await fixture({
    idleTimeoutMs: 25,
    totalTimeoutMs: 250,
    fetchImpl: async (_url, init) => {
      upstreamSignal = init!.signal!;
      return eventStream('data: first\n\n');
    },
  });
  t.after(() => f.close());
  const response = await send(f, request, { backpressure: true });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /relay_interrupted/);
  assert.equal(upstreamSignal.aborted, true);
});

test('grant expiry fences the next SSE event', async (t) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const f = await fixture({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            controller = stream;
            stream.enqueue(new TextEncoder().encode('data: first\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  t.after(() => f.close());
  f.updateGrant({ ...grant(), expiresAt: new Date(Date.now() + 80).toISOString() });
  const response = await send(f);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  await new Promise((resolve) => setTimeout(resolve, 110));
  controller.enqueue(new TextEncoder().encode('data: expired\n\n'));
  let rest = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert.match(rest, /relay_interrupted/);
  assert.doesNotMatch(rest, /data: expired/);
});

test('does not expose provider errors or upstream headers', async (t) => {
  const f = await fixture({
    fetchImpl: async () =>
      new Response('private upstream error', {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-private': 'secret' },
      }),
  });
  t.after(() => f.close());
  const response = await send(f);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-private'), null);
  assert.doesNotMatch(await response.text(), /private|upstream error/);
});

test('streams complete SSE frames incrementally but sanitizes upstream SSE errors', async (t) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ready!: () => void;
  const streamReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const f = await fixture({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            controller = stream;
            stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta"'));
            ready();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  t.after(() => f.close());
  const pending = send(f);
  await streamReady;
  controller.enqueue(new TextEncoder().encode(',"delta":"first"}\n\n'));
  const response = await pending;
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  controller.enqueue(
    new TextEncoder().encode('event: error\ndata: {"message":"private provider details"}\n\n'),
  );
  let rest = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert.match(rest, /relay_interrupted/);
  assert.doesNotMatch(rest, /private provider details/);
});
