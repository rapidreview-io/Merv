import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ModelRelay, type RelayTuning } from '../packages/fleet/src/model-relay.js';
import type { ModelRelayUsage } from '../packages/fleet/src/types.js';
import { piSummaryLane } from '../packages/pi/src/limits.js';
import { piModelRelay, type PiRelayConfig, type PiRelayGrant } from '../packages/pi/src/relay.js';
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

/** A ledger whose charges settle by delta, as Pi's and Codex's do. */
function ledger() {
  const book = { used: 0, charges: 0, records: [] as PiRelayUsageRecord[] };
  return {
    book,
    reserve: async () => {
      book.charges++;
      book.used += 100;
      return { day: '2026-09-29', micros: 100, model: 'test-model' };
    },
    onUsage: (record: PiRelayUsageRecord, _grant: PiRelayGrant, reserved: { micros: number }) => {
      book.records.push(record);
      book.used += record.inputTokens + record.outputTokens - reserved.micros;
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

test("a summary runs beside its conversation's call, one at a time", async (t) => {
  let release!: (value: string) => void;
  const key = new Promise<string>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ providerKey: () => key });
  t.after(() => f.close());
  const summaryHeaders = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    [piSummaryLane]: '1',
  };
  const first = send(f);
  const summary = send(f, request, { headers: summaryHeaders });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await send(f)).status, 429);
  assert.equal((await send(f, request, { headers: summaryHeaders })).status, 429);
  release('private-provider-key');
  assert.equal((await first).status, 200);
  assert.equal((await summary).status, 200);
  await Promise.all([(await first).text(), (await summary).text()]);
  assert.equal(f.upstreamCalls.length, 2);
});
