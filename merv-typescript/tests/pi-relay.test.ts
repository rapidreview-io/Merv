import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PiModelRelay,
  type PiRelayConfig,
  type PiRelayFailureRecord,
  type PiRelayGrant,
  type PiRelayUsageRecord,
} from '../packages/pi/src/relay.js';
import { moveTool, type PiMoveContext } from '../packages/pi/src/moves.js';

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
  // Reasoning is the catalog's to set: no summary, and no encrypted reasoning at effort none.
  const { include: _include, ...asked } = payload;
  assert.deepEqual(JSON.parse(String(call.init.body)), { ...asked, reasoning: { effort: 'none' } });
});

test('a grant names a catalog model, and the relay alone sets each call’s reasoning', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  // A model outside the catalog reaches no provider, and a request must name its grant's model.
  f.updateGrant({ ...grant(), model: 'gpt-4' });
  assert.equal((await send(f, { ...request, model: 'gpt-4' })).status, 403);
  f.updateGrant(grant());
  assert.equal((await send(f, { ...request, model: 'reasoning-model' })).status, 400);
  assert.equal(f.upstreamCalls.length, 0);
  const asked = {
    reasoning: { effort: 'xhigh', summary: 'detailed' },
    include: ['reasoning.encrypted_content'],
  };
  await (await send(f, { ...request, ...asked })).text();
  f.updateGrant({ ...grant(), id: 'grant-2', model: 'reasoning-model' });
  await (await send(f, { ...request, ...asked, model: 'reasoning-model' })).text();
  assert.deepEqual(
    f.upstreamCalls.map((call) => JSON.parse(String(call.init.body))),
    [
      { ...request, reasoning: { effort: 'none' } },
      {
        ...request,
        model: 'reasoning-model',
        reasoning: { effort: 'low' },
        include: ['reasoning.encrypted_content'],
      },
    ],
  );
});

test('a model that reasons may stay silent longer before its call is ended', async (t) => {
  const silent = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const done = new TextEncoder().encode('data: {"type":"response.completed"}\n\n');
          // A call ended at its idle limit has cancelled this stream by then.
          setTimeout(() => {
            try {
              controller.enqueue(done);
              controller.close();
            } catch {}
          }, 200);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const f = await fixture({ idleTimeoutMs: 50, reasoningIdleTimeoutMs: 500, fetchImpl: silent });
  t.after(() => f.close());
  const quiet = await send(f);
  assert.equal(quiet.status, 504);
  await quiet.text();
  f.updateGrant({ ...grant(), id: 'grant-2', model: 'reasoning-model' });
  const reasoned = await send(f, { ...request, model: 'reasoning-model' });
  assert.equal(reasoned.status, 200);
  assert.match(await reasoned.text(), /response\.completed/);
});

test('each finished call reports its tokens by model, naming no one', async (t) => {
  const usage: PiRelayUsageRecord[] = [];
  const completed = `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 12 },
      },
    },
  })}\n\n`;
  let body = completed;
  const f = await fixture({
    fetchImpl: async () => eventStream(body),
    onUsage: (record) => void usage.push(record),
  });
  t.after(() => f.close());
  await (await send(f)).text();
  assert.deepEqual(usage, [
    {
      event: 'pi_relay_usage',
      model: 'test-model',
      inputTokens: 120,
      cachedTokens: 100,
      outputTokens: 30,
      reasoningTokens: 12,
    },
  ]);
  // A stream that never finishes reports nothing.
  body = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
  await (await send(f)).text();
  assert.equal(usage.length, 1);
  // A callback that throws changes nothing.
  const g = await fixture({
    fetchImpl: async () => eventStream(completed),
    onUsage: () => {
      throw new Error('private callback failure');
    },
  });
  t.after(() => g.close());
  const answered = await send(g);
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /resp_1/);
});

test('replayed history keeps undeclared tool calls and forwards known reasoning fields only', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const reasoning = {
    type: 'reasoning',
    id: 'rs_1',
    encrypted_content: null,
    status: 'incomplete',
  };
  const summary = [{ type: 'summary_text', text: 'thought' }];
  const input = [
    ...request.input,
    { ...reasoning, summary: summary.map((item) => ({ ...item, extra: 1 })), extra: true },
    { type: 'function_call', call_id: 'call_1', name: 'task.get', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Tool task.get not found' },
  ];
  const replayed = await send(f, { ...request, input });
  assert.equal(replayed.status, 200);
  await replayed.text();
  const forwarded = JSON.parse(String(f.upstreamCalls[0]!.init.body));
  assert.deepEqual(forwarded.input, [
    ...request.input,
    { ...reasoning, summary },
    ...input.slice(2),
  ]);
  // No output cap is added, and a worker's own is passed on, whatever its size.
  assert.equal(forwarded.max_output_tokens, undefined);
  assert.equal((await send(f, { ...request, max_output_tokens: 128_000 })).status, 200);
  assert.equal(JSON.parse(String(f.upstreamCalls[1]!.init.body)).max_output_tokens, 128_000);
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

test("admits one call per conversation, so a person's conversations on one machine run at once", async (t) => {
  let release!: (value: string) => void;
  const key = new Promise<string>((resolve) => {
    release = resolve;
  });
  const f = await fixture({ providerKey: () => key });
  t.after(() => f.close());
  const first = send(f);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await send(f)).status, 429, 'the same conversation waits its turn');
  f.updateGrant({ ...grant(), id: 'grant-2', conversationId: 'conversation-2' });
  const second = send(f);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release('private-provider-key');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('holds 200 calls at once by default and refuses the 201st', async (t) => {
  let release!: (value: string) => void;
  const key = new Promise<string>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const f = await fixture({
    providerKey: () => key,
    authority: {
      async authorize() {
        calls += 1;
        return { ...grant(), id: `grant-${calls}`, conversationId: `conversation-${calls}` };
      },
      async validate() {},
    },
  });
  t.after(() => f.close());
  const held = Array.from({ length: 200 }, () => send(f));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // An admitted 201st would wait on the held key, so it gets a deadline instead of hanging.
  const overflow = await Promise.race([
    send(f).then((response) => response.status),
    new Promise((resolve) => setTimeout(resolve, 1_000, 'admitted')),
  ]);
  release('private-provider-key');
  assert.equal(overflow, 429);
  assert.deepEqual(
    new Set((await Promise.all(held)).map((response) => response.status)),
    new Set([200]),
  );
});

test('passes the switch_machine moveTool offers only under a grant that lists it', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const offered = moveTool({
    now: Date.now(),
    enabled: true,
    host: { next: null, draining: null } as PiMoveContext['host'],
    person: {
      key: 'user-1:project-1',
      preferred: 'standard',
      sticky: null,
      choseAt: null,
      moves: [],
    },
    conversationId: 'conversation-1',
    current: {
      key: 'standard',
      label: 'Standard',
      vcpu: 0.5,
      memoryGiB: 4,
      diskGB: 8,
      maxHourlyUsd: 0.074,
    },
    targets: [
      { key: 'large', label: 'Large', vcpu: 2, memoryGiB: 8, diskGB: 16, maxHourlyUsd: 0.22 },
    ],
  })!;
  const payload = {
    ...request,
    tools: [
      {
        type: 'function',
        name: 'switch_machine',
        description: offered.description,
        parameters: offered.inputSchema,
      },
    ],
  };
  assert.equal((await send(f, payload)).status, 400);
  f.updateGrant({ ...grant(), toolNames: ['read_notes', 'switch_machine'] });
  assert.equal((await send(f, payload)).status, 200);
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
  await new Promise((resolve) => setTimeout(resolve, 1100));
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

test('streamed frames reuse a recent authority read, and a turn fits dozens of model calls', async (t) => {
  let validations = 0;
  const bound = grant();
  const f = await fixture({
    authority: {
      authorize: async () => bound,
      validate: async () => {
        validations++;
      },
    },
    fetchImpl: async () => eventStream('data: {"type":"delta"}\n\n'.repeat(200)),
  });
  t.after(() => f.close());
  for (let turn = 0; turn < 20; turn++) {
    const response = await send(f);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).split('\n\n').length, 201);
  }
  assert.equal(validations, 60, 'three admission checks per call, none per frame');
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

test('failure diagnostics are bounded metadata only, after admission', async (t) => {
  const records: PiRelayFailureRecord[] = [];
  const secret = 'private-provider-prompt-token-header';
  const cases: {
    name: string;
    fetchImpl: typeof fetch;
    expectedStatus: number;
    expectedPhase: PiRelayFailureRecord['phase'];
    upstreamHttpStatus?: number;
  }[] = [
    {
      name: 'non-OK upstream',
      fetchImpl: async () =>
        new Response(secret, {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-private': secret },
        }),
      expectedStatus: 502,
      expectedPhase: 'upstream',
      upstreamHttpStatus: 401,
    },
    {
      name: 'SSE error frame',
      fetchImpl: async () => eventStream(`event: error\ndata: {"message":"${secret}"}\n\n`),
      expectedStatus: 502,
      expectedPhase: 'stream',
      upstreamHttpStatus: 200,
    },
    {
      name: 'network exception',
      fetchImpl: async () => {
        throw new Error(secret);
      },
      expectedStatus: 502,
      expectedPhase: 'upstream',
    },
    {
      name: 'idle timeout',
      fetchImpl: async () =>
        new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
      expectedStatus: 504,
      expectedPhase: 'stream',
      upstreamHttpStatus: 200,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (context) => {
      const f = await fixture({
        fetchImpl: scenario.fetchImpl,
        idleTimeoutMs: 25,
        onFailure: (record) => {
          records.push(record);
        },
      });
      context.after(() => f.close());
      const unauthorized = await send(f, request, {
        headers: { authorization: 'Bearer rejected', 'content-type': 'application/json' },
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(records.length, 0);
      const response = await send(f);
      assert.equal(response.status, scenario.expectedStatus);
      assert.doesNotMatch(await response.text(), /private/);
      assert.equal(records.length, 1);
      const record = records.pop()!;
      assert.deepEqual(
        Object.keys(record).sort(),
        [
          'code',
          'elapsedMs',
          'event',
          'model',
          'phase',
          ...(scenario.upstreamHttpStatus === undefined ? [] : ['upstreamHttpStatus']),
        ].sort(),
      );
      assert.equal(record.event, 'pi_relay_failure');
      assert.equal(record.phase, scenario.expectedPhase);
      assert.equal(
        record.code,
        scenario.expectedStatus === 504 ? 'relay_timeout' : 'upstream_failed',
      );
      assert.equal(record.upstreamHttpStatus, scenario.upstreamHttpStatus);
      assert.equal(record.model, 'test-model');
      assert.ok(
        Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 900_000,
      );
      assert.doesNotMatch(
        JSON.stringify(record),
        /private|grant-1|command-1|conversation-1|runtime-1|pir_/,
      );
    });
  }
});

test('throwing diagnostics callback does not change the public error or hold relay admission', async (t) => {
  const f = await fixture({
    fetchImpl: async () => new Response('private failure', { status: 400 }),
    onFailure: () => {
      throw new Error('private callback failure');
    },
  });
  t.after(() => f.close());
  const first = await send(f);
  assert.equal(first.status, 502);
  assert.deepEqual(JSON.parse(await first.text()), { error: 'upstream_failed' });
  const second = await send(f);
  assert.equal(second.status, 502);
  assert.deepEqual(JSON.parse(await second.text()), { error: 'upstream_failed' });
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
