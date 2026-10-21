import { MervError } from '@merv/contracts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ModelRelay, type RelayTuning } from '../packages/fleet/src/model-relay.js';
import type { ModelRelayFailure, ModelRelayUsage } from '../packages/fleet/src/types.js';
import { piModelRelay, type PiRelayConfig, type PiRelayGrant } from '../packages/pi/src/relay.js';

type PiRelayFailureRecord = ModelRelayFailure<'pi_relay_failure'>;
type PiRelayUsageRecord = ModelRelayUsage<'pi_relay_usage'>;
/** Pi's relay hooks over the shared core, as the API mounts them. */
const piRelay = (config: PiRelayConfig & RelayTuning) =>
  new ModelRelay(piModelRelay(config), config);

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

async function fixture(overrides: Partial<PiRelayConfig & RelayTuning> = {}) {
  let currentGrant = grant();
  let revoked = false;
  const upstreamCalls: { url: string; init: RequestInit }[] = [];
  const relay = piRelay({
    models: [
      { id: 'test-model', effort: 'none' },
      { id: 'reasoning-model', effort: 'low' },
    ],
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
  f: { relay: ReturnType<typeof piRelay> },
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
  // Reasoning is the catalog's to set: no summary, and no encrypted reasoning at effort none.
  const { include: _include, ...asked } = payload;
  assert.deepEqual(JSON.parse(String(call.init.body)), { ...asked, reasoning: { effort: 'none' } });
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
    {
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [{ type: 'input_image', image_url: 'https://evil.example' }],
        },
      ],
    },
    // Fleet's one rule: a file by id, wherever it sits, as hosted Codex's relay refuses it.
    {
      tools: [
        {
          type: 'function',
          name: 'read_notes',
          parameters: { type: 'object', default: { file_id: 'file-abc' } },
        },
      ],
    },
    {
      tools: [
        {
          type: 'function',
          name: 'read_notes',
          parameters: { type: 'object', default: { type: 'item_reference', id: 'msg_1' } },
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
  // A relay its mount closed is unavailable.
  const closed = await fixture();
  closed.close();
  assert.equal((await send(closed)).status, 503);
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

test('bounds concurrent calls globally and prevents reused grant IDs from changing identity', async (t) => {
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

test('a stream that ends without its terminal frame is a failure', async (t) => {
  const failures: PiRelayFailureRecord[] = [];
  const f = await fixture({
    onFailure: (record) => void failures.push(record),
    fetchImpl: async () =>
      eventStream('data: {"type":"response.output_text.delta","delta":"a"}\n\n'.repeat(2)),
  });
  t.after(() => f.close());
  const response = await send(f);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.match(/output_text\.delta/g)?.length, 2);
  assert.match(
    text,
    /event: error\ndata: \{"type":"error","code":"relay_interrupted",[^\n]*\}\n\n$/,
  );
  assert.deepEqual(
    failures.map(({ code, phase }) => [code, phase]),
    [['upstream_failed', 'stream']],
  );
});

test('an authority or ledger that cannot answer is unavailable, not a refusal', async (t) => {
  const down = () => new MervError('database_unavailable', 'private database failure', 503);
  const cases: [string, Partial<PiRelayConfig & RelayTuning>, number, string][] = [
    [
      'authorize down',
      { authority: { authorize: async () => Promise.reject(down()), validate: async () => {} } },
      503,
      'relay_unavailable',
    ],
    [
      'authorize refuses',
      {
        authority: {
          authorize: async () => Promise.reject(new Error('private')),
          validate: async () => {},
        },
      },
      401,
      'unauthorized',
    ],
    [
      'validate down',
      {
        authority: { authorize: async () => grant(), validate: async () => Promise.reject(down()) },
      },
      503,
      'relay_unavailable',
    ],
    [
      'validate refuses',
      {
        authority: {
          authorize: async () => grant(),
          validate: async () => Promise.reject(new MervError('pi_authority_stale', 'Stale', 403)),
        },
      },
      403,
      'grant_forbidden',
    ],
    ['reserve down', { reserve: async () => Promise.reject(down()) }, 503, 'relay_unavailable'],
    [
      'reserve refuses',
      { reserve: async () => Promise.reject(new MervError('pi_model_ceiling', 'Used up', 403)) },
      403,
      'pi_model_ceiling',
    ],
  ];
  for (const [name, overrides, status, code] of cases) {
    const f = await fixture(overrides);
    t.after(() => f.close());
    const response = await send(f);
    assert.equal(response.status, status, name);
    assert.deepEqual(await response.json(), { error: code }, name);
    assert.equal(f.upstreamCalls.length, 0, name);
  }
});

/** A ledger whose charges settle by delta, as Pi's and Codex's do. */
function ledger() {
  const book = { used: 0, charges: 0, records: [] as PiRelayUsageRecord[] };
  return {
    book,
    reserve: async () => {
      book.charges++;
      book.used += 100;
      return { day: '2026-09-29', tokens: 100 };
    },
    onUsage: (record: PiRelayUsageRecord, _grant: PiRelayGrant, reserved: { tokens: number }) => {
      book.records.push(record);
      book.used += record.inputTokens + record.outputTokens - reserved.tokens;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a call the provider never took returns its charge, once', async (t) => {
  const failing = ledger();
  const f = await fixture({
    ...failing,
    fetchImpl: async () => new Response('private', { status: 500 }),
  });
  t.after(() => f.close());
  for (let call = 0; call < 5; call++) assert.equal((await send(f)).status, 502);
  await settle();
  assert.deepEqual([failing.book.charges, failing.book.used], [5, 0]);
  assert.equal(failing.book.records.length, 5);
  for (const record of failing.book.records)
    assert.deepEqual(record, {
      event: 'pi_relay_usage',
      model: 'test-model',
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      refund: true,
    });
  // Refused by the authority read after its charge, before it was sent.
  const stale = ledger();
  let validations = 0;
  const g = await fixture({
    ...stale,
    authority: {
      authorize: async () => grant(),
      validate: async () => {
        if (++validations === 2) throw new Error('private');
      },
    },
  });
  t.after(() => g.close());
  assert.equal((await send(g)).status, 403);
  await settle();
  assert.deepEqual([stale.book.charges, stale.book.used, stale.book.records.length], [1, 0, 1]);
  assert.equal(g.upstreamCalls.length, 0);
  // A finished call settles once, to its usage.
  const finished = ledger();
  const h = await fixture({
    ...finished,
    fetchImpl: async () =>
      eventStream(
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } })}\n\n`,
      ),
  });
  t.after(() => h.close());
  assert.equal((await send(h)).status, 200);
  await settle();
  assert.deepEqual([finished.book.used, finished.book.records.length], [7, 1]);
  assert.equal(finished.book.records[0]!.refund, undefined);
});

test('a call the provider may have run keeps its charge', async (t) => {
  const cases: [string, typeof fetch][] = [
    ['a success that is no stream', async () => new Response('{}', { status: 200 })],
    [
      'no answer',
      async () => {
        throw new Error('private');
      },
    ],
    ['a stream cut off', async () => eventStream('data: {"type":"delta"}\n\n')],
  ];
  for (const [name, fetchImpl] of cases) {
    const kept = ledger();
    const f = await fixture({ ...kept, fetchImpl });
    t.after(() => f.close());
    const response = await send(f);
    await response.text();
    await settle();
    assert.deepEqual([kept.book.charges, kept.book.used, kept.book.records], [1, 100, []], name);
  }
});

test('a reservation that commits after the worker hung up is returned', async (t) => {
  const late = ledger();
  let commit!: () => void;
  const committing = new Promise<void>((resolve) => (commit = resolve));
  let reserving!: () => void;
  const reserveStarted = new Promise<void>((resolve) => (reserving = resolve));
  const failures: PiRelayFailureRecord[] = [];
  let reserved = false;
  const f = await fixture({
    ...late,
    // Only the first call's reservation is slow.
    reserve: async () => {
      if (!reserved) {
        reserved = true;
        reserving();
        await committing;
      }
      return await late.reserve();
    },
    onFailure: (record) => void failures.push(record),
  });
  t.after(() => f.close());
  const hangUp = new AbortController();
  void send(f, request, { signal: hangUp.signal }).catch(() => undefined);
  await reserveStarted;
  hangUp.abort();
  await settle();
  // The lane is held until the reservation is known.
  assert.equal((await send(f)).status, 429);
  commit();
  await settle();
  assert.deepEqual([late.book.charges, late.book.used, late.book.records.length], [1, 0, 1]);
  assert.deepEqual(
    failures.map(({ code, phase }) => [code, phase]),
    [['disconnected', 'request']],
  );
  assert.equal(f.upstreamCalls.length, 0);
});

/** An upstream that sends a frame every `everyMs` until it is cancelled or has sent `count`. */
function ticking(everyMs: number, count = Infinity) {
  let timer: NodeJS.Timeout | undefined;
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0;
          timer = setInterval(() => {
            try {
              if (sent++ < count)
                controller.enqueue(
                  new TextEncoder().encode(`data: {"type":"delta","n":${sent}}\n\n`),
                );
              else {
                clearInterval(timer);
                controller.enqueue(
                  new TextEncoder().encode('data: {"type":"response.completed"}\n\n'),
                );
                controller.close();
              }
            } catch {
              clearInterval(timer);
            }
          }, everyMs);
        },
        cancel: () => clearInterval(timer),
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
}

test('an authority that stops answering ends the stream within its staleness bound', async (t) => {
  let validations = 0;
  const failures: PiRelayFailureRecord[] = [];
  const f = await fixture({
    authority: {
      authorize: async () => grant(),
      validate: () => (++validations > 3 ? new Promise<void>(() => {}) : Promise.resolve()),
    },
    onFailure: (record) => void failures.push(record),
    fetchImpl: ticking(100),
  });
  t.after(() => f.close());
  const started = Date.now();
  const response = await send(f);
  const reader = response.body!.getReader();
  let last = 0;
  let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = new TextDecoder().decode(next.value);
    if (chunk.includes('"type":"delta"')) last = Date.now() - started;
    text += chunk;
  }
  assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms`);
  assert.ok(last <= 5_100, `a frame was written at ${last} ms`);
  assert.match(text, /relay_interrupted/);
  assert.deepEqual(
    failures.map(({ code }) => code),
    ['relay_timeout'],
  );
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
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  try {
    controller.enqueue(new TextEncoder().encode('data: should-not-pass\n\n'));
  } catch {} // the fence may already have cancelled the upstream
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
  assert.equal(
    rest,
    'event: error\ndata: {"type":"error","code":"upstream_failed","message":"The model provider failed this call"}\n\n',
  );
});
