import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MervError, type Caller, type Principal, type Scope } from '@merv/contracts';
import { ApiServer } from '../packages/api/src/http.js';
import type { Tools } from '../packages/api/src/types.js';
import { PiHttp } from '../packages/pi/src/api.js';
import { PiModelRelay, type PiRelayGrant } from '../packages/pi/src/relay.js';
import { PiStreams } from '../packages/pi/src/stream.js';
import type { PiService } from '../packages/pi/src/service.js';

const workerToken = 'piw_http-fixture';
const modelToken = `pir_${'h'.repeat(43)}`;
const conversationId = 'conversation-http';
const modelRequest = {
  model: 'test-model',
  store: false,
  stream: true,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
};

test('evicted transient tails get a new generation so reconnect can replace old sequence state', () => {
  const streams = new PiStreams(1000, 1);
  streams.publish('first', { commandId: 'command', type: 'text', text: 'old tail' });
  const before = streams.snapshot('first');
  streams.snapshot('second');
  const after = streams.snapshot('first');
  assert.notEqual(after.streamId, before.streamId);
  assert.equal(after.sequence, 0);
  assert.deepEqual(after.tail, []);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('HTTP fixture timed out')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(t: TestContext) {
  const streams = new PiStreams();
  const subscribe = streams.subscribe.bind(streams);
  let subscriptions = 0;
  streams.subscribe = (id, listener) => {
    const unsubscribe = subscribe(id, listener);
    subscriptions++;
    return () => {
      unsubscribe();
      subscriptions--;
    };
  };
  const calls: string[] = [];
  const cleanup: Array<() => void> = [];
  let permitted = true;
  const caller: Caller = {
    actorId: 'actor-http',
    projectId: 'project-http',
    credentialId: 'credential-http',
  };
  const scope = {
    authenticate(token: string) {
      if (token !== 'actor-http-token') throw new MervError('unauthorized', 'Invalid actor', 401);
      return {
        id: caller.actorId,
        projectId: caller.projectId,
        name: 'HTTP operator',
        role: 'producer',
        active: true,
        credential: {
          id: caller.credentialId,
          actorId: caller.actorId,
          projectId: caller.projectId,
          kind: 'actor',
          createdAt: '2026-09-23T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          previousId: null,
        },
      };
    },
    async caller(principal: Principal, projectId?: string) {
      if (principal.kind !== 'actor' || (projectId && projectId !== caller.projectId))
        throw new MervError('forbidden', 'Wrong project', 403);
      return caller;
    },
    async require(selected: Caller) {
      if (!permitted || selected.projectId !== caller.projectId)
        throw new MervError('forbidden', 'Read denied', 403);
    },
  } as unknown as Scope;
  const pi = {
    streams,
    async authenticateWorker(token: string) {
      if (token !== workerToken) throw new MervError('pi_unauthorized', 'Invalid worker', 401);
    },
    async authorizeStream(selected: Caller, id: string) {
      if (!permitted || selected.projectId !== caller.projectId || id !== conversationId)
        throw new MervError('pi_forbidden', 'Conversation denied', 403);
    },
    async snapshot(selected: Caller, id: string) {
      await pi.authorizeStream(selected, id);
      return { conversation: { id }, commands: [], ...streams.snapshot(id) };
    },
    ...Object.fromEntries(
      ['next', 'begin', 'tool', 'progress', 'complete', 'fail'].map((action) => [
        action,
        async (token: string, input: unknown) => {
          assert.equal(token, workerToken);
          calls.push(action);
          return { action, input };
        },
      ]),
    ),
  } as unknown as PiService;
  const http = new PiHttp(pi);
  const api = new ApiServer(scope, {} as Tools);
  const unmountWorker = api.mount('/pi-worker', http.worker);
  const unregister = api.registerPi(http);
  t.after(async () => {
    for (const dispose of cleanup) dispose();
    http.close();
    unregister();
    unmountWorker();
    streams.close();
    await api.stop();
  });
  return {
    api,
    streams,
    calls,
    cleanup,
    subscriptions: () => subscriptions,
    unregister,
    deny: () => {
      permitted = false;
    },
    allow: () => {
      permitted = true;
    },
  };
}

async function json(response: Response) {
  return (await response.json()) as {
    error?: { code: string } | string;
    work?: unknown;
    result?: unknown;
    action?: string;
    input?: unknown;
  };
}

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
) {
  while (true) {
    const boundary = buffer.text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.text.slice(0, boundary);
      buffer.text = buffer.text.slice(boundary + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      assert.ok(event && data, `Incomplete SSE frame: ${frame}`);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    }
    const chunk = await within(reader.read());
    assert.equal(chunk.done, false, 'SSE closed before the expected event');
    buffer.text += new TextDecoder().decode(chunk.value);
  }
}

test('optional Pi routes require a provider and human source authentication', async (t) => {
  const f = fixture(t);
  const base = await f.api.start();
  const events = `${base}/pi/${conversationId}/events`;
  const headers = { authorization: 'Bearer actor-http-token' };
  assert.equal((await fetch(events)).status, 401);
  assert.equal(
    (await fetch(events, { headers: { authorization: `Bearer ${workerToken}` } })).status,
    401,
  );
  assert.equal(
    (await fetch(events, { headers: { ...headers, 'x-merv-project-id': 'other-project' } })).status,
    403,
  );
  assert.equal((await fetch(`${events}?since=1`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/pi/${conversationId}/other`, { headers })).status, 404);
  assert.equal((await fetch(events, { method: 'POST', headers })).status, 404);
  f.deny();
  assert.equal((await fetch(events, { headers })).status, 403);
  f.allow();
  f.unregister();
  const missing = await fetch(events, { headers });
  assert.equal(missing.status, 503);
  assert.deepEqual((await json(missing)).error, {
    code: 'pi_unavailable',
    message: 'Agent conversations are unavailable',
  });
});

test('worker mount enforces exact method, path, origin, bearer and bounded JSON over HTTP', async (t) => {
  const f = fixture(t);
  const base = await f.api.start();
  const path = `${base}/pi-worker/next`;
  const headers = { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' };
  const post = (url: string, options: RequestInit = {}) =>
    fetch(url, { method: 'POST', headers, body: '{}', ...options });
  for (const action of ['next', 'begin', 'tool', 'progress', 'complete', 'fail']) {
    const result = await post(`${base}/pi-worker/${action}`, { body: JSON.stringify({ action }) });
    assert.equal(result.status, 200);
    const value = await json(result);
    assert.deepEqual(action === 'next' ? value.work : action === 'tool' ? value.result : value, {
      action,
      input: { action },
    });
  }
  assert.deepEqual(f.calls, ['next', 'begin', 'tool', 'progress', 'complete', 'fail']);
  for (const [url, options, status] of [
    [path, { method: 'GET', body: undefined }, 404],
    [`${path}/extra`, {}, 404],
    [`${path}?cursor=1`, {}, 404],
    [path, { headers: { ...headers, origin: base } }, 403],
    [path, { headers: { 'content-type': 'application/json' } }, 401],
    [path, { headers: { ...headers, authorization: 'Bearer piw_invalid' } }, 401],
    [path, { headers: { ...headers, 'content-type': 'text/plain' } }, 415],
  ] as const) {
    const response = await post(url, options);
    assert.equal(response.status, status, url);
    await response.arrayBuffer();
  }
  assert.equal((await post(path, { body: '{' })).status, 400);
  const oversized = await post(path, { body: JSON.stringify({ padding: 'x'.repeat(3_000_000) }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(f.calls, ['next', 'begin', 'tool', 'progress', 'complete', 'fail']);
});

test('SSE sends canonical snapshots and deltas, reconnects, and releases disconnected subscribers', async (t) => {
  const f = fixture(t);
  const base = await f.api.start();
  const url = `${base}/pi/${conversationId}/events`;
  const headers = { authorization: 'Bearer actor-http-token' };
  const spareSubscriptions = Array.from({ length: 7 }, () =>
    f.streams.subscribe(conversationId, () => {}),
  );
  t.after(() => {
    for (const unsubscribe of spareSubscriptions) unsubscribe();
  });
  const waitForRelease = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (f.subscriptions() === 7) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(f.subscriptions(), 7, 'a disconnected SSE reader must release its subscription');
  };
  const first = await fetch(url, { headers });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = first.body!.getReader();
  const buffer = { text: '' };
  const initial = await readEvent(reader, buffer);
  assert.equal(initial.event, 'snapshot');
  assert.equal(initial.data.sequence, 0);
  const streamId = initial.data.streamId;
  f.streams.publish(conversationId, { commandId: 'cmd-1', type: 'text', text: 'first' });
  const delta = await readEvent(reader, buffer);
  assert.equal(delta.event, 'delta');
  assert.deepEqual(delta.data, {
    streamId,
    sequence: 1,
    commandId: 'cmd-1',
    type: 'text',
    text: 'first',
  });
  await reader.cancel();
  await waitForRelease();
  const reconnect = await fetch(url, { headers: { ...headers, 'last-event-id': '1' } });
  assert.equal(reconnect.status, 200);
  const nextReader = reconnect.body!.getReader();
  const nextBuffer = { text: '' };
  const canonical = await readEvent(nextReader, nextBuffer);
  assert.equal(canonical.event, 'snapshot');
  assert.equal(canonical.data.streamId, streamId);
  assert.equal(canonical.data.sequence, 1);
  assert.deepEqual(canonical.data.tail, [
    { commandId: 'cmd-1', type: 'text', text: 'first', sequence: 1 },
  ]);
  f.streams.changed(conversationId, 'cmd-1');
  const changed = await readEvent(nextReader, nextBuffer);
  assert.equal(changed.event, 'snapshot');
  assert.equal(changed.data.sequence, 2);
  assert.deepEqual(changed.data.tail, [
    { commandId: 'cmd-1', type: 'changed', text: '', sequence: 2 },
  ]);
  await nextReader.cancel();
  await waitForRelease();
  const reconnected = await fetch(url, { headers });
  assert.equal(reconnected.status, 200);
  const finalReader = reconnected.body!.getReader();
  assert.equal((await readEvent(finalReader, { text: '' })).event, 'snapshot');
  await finalReader.cancel();
  await waitForRelease();
});

test('SSE subscriber capacity refuses new HTTP connections instead of returning empty success', async (t) => {
  const f = fixture(t);
  const base = await f.api.start();
  const url = `${base}/pi/${conversationId}/events`;
  const headers = { authorization: 'Bearer actor-http-token' };
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let count = 0; count < 8; count++) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      readers.push(reader);
      assert.equal((await readEvent(reader, { text: '' })).event, 'snapshot');
    }
    assert.equal(f.subscriptions(), 8);
    const overflow = await fetch(url, { headers });
    assert.ok(overflow.status >= 400, 'an unadmitted SSE reader must not get HTTP 200');
    await overflow.body?.cancel();
  } finally {
    await Promise.allSettled(readers.map((reader) => reader.cancel()));
  }
});

test('relay mount streams vetted upstream frames and cuts off revoked grants', async (t) => {
  const f = fixture(t);
  let revoked = false;
  const entered = deferred<void>();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const forwarded: { url: string; init: RequestInit }[] = [];
  const grant: PiRelayGrant = {
    id: 'grant-http',
    userId: 'user-http',
    projectId: 'project-http',
    conversationId,
    commandId: 'cmd-http',
    runtimeId: 'runtime-http',
    epoch: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    model: 'test-model',
    toolNames: [],
  };
  const relay = new PiModelRelay({
    enabled: true,
    model: 'test-model',
    providerKey: () => 'fake-secret',
    maxRequestBytes: 512,
    authority: {
      async authorize(token) {
        if (token !== modelToken) throw Error('bad token');
        return grant;
      },
      async validate() {
        if (revoked) throw Error('revoked');
      },
    },
    fetchImpl: async (url, init) => {
      forwarded.push({ url: String(url), init: init! });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            entered.resolve();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'x-provider-secret': 'private' } },
      );
    },
  });
  const unmount = f.api.mount('/pi-model', relay.handle);
  f.cleanup.push(() => {
    relay.close();
    unmount();
  });
  const base = await f.api.start();
  const url = `${base}/pi-model/responses`;
  const headers = { authorization: `Bearer ${modelToken}`, 'content-type': 'application/json' };
  const send = (path: string, options: RequestInit = {}) =>
    fetch(path, { method: 'POST', headers, body: JSON.stringify(modelRequest), ...options });
  assert.equal((await send(`${url}?extra=1`)).status, 404);
  assert.equal((await send(url, { headers: { ...headers, origin: base } })).status, 403);
  assert.equal((await send(url, { headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal(
    (await send(url, { body: JSON.stringify({ ...modelRequest, store: true }) })).status,
    400,
  );
  assert.equal(
    (
      await send(url, {
        body: JSON.stringify({
          ...modelRequest,
          input: [{ role: 'system', content: 'x'.repeat(512) }],
        }),
      })
    ).status,
    413,
  );
  assert.equal(forwarded.length, 0);
  const pending = send(url);
  await within(entered.promise);
  upstream.enqueue(
    new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"first"}\n\n'),
  );
  const response = await within(pending);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-provider-secret'), null);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(forwarded[0]?.url, 'https://api.openai.com/v1/responses');
  assert.equal(
    forwarded[0]?.init.headers &&
      (forwarded[0].init.headers as Record<string, string>).authorization,
    'Bearer fake-secret',
  );
  assert.deepEqual(JSON.parse(String(forwarded[0]?.init.body)), {
    ...modelRequest,
    max_output_tokens: 4096,
  });
  const reader = response.body!.getReader();
  const first = await readEvent(reader, { text: '' });
  assert.equal(first.event, 'response.output_text.delta');
  assert.deepEqual(first.data, { delta: 'first' });
  revoked = true;
  upstream.enqueue(
    new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"secret"}\n\n'),
  );
  let remainder = '';
  while (true) {
    const chunk = await within(reader.read());
    if (chunk.done) break;
    remainder += new TextDecoder().decode(chunk.value);
  }
  assert.doesNotMatch(remainder, /secret/);
  assert.match(remainder, /relay_interrupted/);
  for (let attempt = 0; attempt < 40 && !cancelled; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cancelled, true);
  await reader.cancel();
});

test('relay disconnect aborts the injected upstream and releases per-user admission', async (t) => {
  const f = fixture(t);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const entered = deferred<void>();
  let aborted = false;
  let cancelled = false;
  const relay = new PiModelRelay({
    enabled: true,
    model: 'test-model',
    providerKey: () => 'fake-secret',
    authority: {
      async authorize() {
        return {
          id: 'disconnect-grant',
          userId: 'disconnect-user',
          projectId: 'project-http',
          conversationId,
          commandId: 'cmd-http',
          runtimeId: 'runtime-http',
          epoch: 1,
          expiresAt,
          model: 'test-model',
          toolNames: [],
        };
      },
      async validate() {},
    },
    fetchImpl: async (_url, init) => {
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ready":true}\n\n'));
            entered.resolve();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const unmount = f.api.mount('/pi-model', relay.handle);
  f.cleanup.push(() => {
    relay.close();
    unmount();
  });
  const base = await f.api.start();
  const send = () =>
    fetch(`${base}/pi-model/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${modelToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(modelRequest),
    });
  const response = await within(send());
  await within(entered.promise);
  await response.body!.cancel();
  for (let attempt = 0; attempt < 40 && (!aborted || !cancelled); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(aborted, true, 'client socket close must abort provider fetch');
  assert.equal(cancelled, true, 'client socket close must cancel upstream reader');
  const second = await within(send());
  assert.equal(second.status, 200, 'user admission must be released after disconnect');
  await second.body!.cancel();
});
