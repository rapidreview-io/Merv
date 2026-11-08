import { MervError, type Caller, type Principal, type Scope } from '@merv/contracts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApiServer } from '../packages/api/src/http.js';
import type { Tools } from '../packages/api/src/types.js';
import { PiHttp } from '../packages/pi/src/api.js';
import type { PiService } from '../packages/pi/src/service.js';
import { PiStreams } from '../packages/pi/src/stream.js';

const workerToken = 'piw_http-fixture';
const conversationId = 'conversation-http';

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

function fixture(t: TestContext, rotateMs?: number) {
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
      // A second person in the project, for what one person's streams leave to others.
      const id = { 'actor-http-token': caller.actorId, 'other-http-token': 'actor-other' }[token];
      if (!id) throw new MervError('unauthorized', 'Invalid actor', 401);
      return {
        id,
        projectId: caller.projectId,
        name: 'HTTP operator',
        role: 'producer',
        active: true,
        credential: {
          id: caller.credentialId,
          actorId: id,
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
      return { ...caller, actorId: principal.actor.id };
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
      return { projectId: 'pi-host', actorId: 'pi-worker:flt_1' };
    },
    async authorizeStream(selected: Caller, id: string) {
      if (!permitted || selected.projectId !== caller.projectId || id !== conversationId)
        throw new MervError('pi_forbidden', 'Conversation denied', 403);
    },
    async snapshot(selected: Caller, id: string) {
      await pi.authorizeStream(selected, id);
      return { conversation: { id }, commands: [], ...streams.snapshot(id) };
    },
    heardSince: async () => ({}),
    ...Object.fromEntries(
      ['next', 'begin', 'tool', 'progress', 'complete', 'fail'].map((action) => [
        action,
        async (token: string, input: unknown, holdMs?: number) => {
          assert.equal(token, workerToken);
          calls.push(action);
          return { action, input, ...(holdMs && { holdMs }) };
        },
      ]),
    ),
  } as unknown as PiService;
  const http = new PiHttp(pi, rotateMs);
  const api = new ApiServer(scope, {} as Tools);
  const withdrawWorker = api.credential('piw_', http.credential);
  const unmountWorker = api.mount('/pi-worker', http.worker);
  const unregister = api.mount('/pi', http.events);
  t.after(async () => {
    for (const dispose of cleanup) dispose();
    http.close();
    unregister();
    unmountWorker();
    withdrawWorker();
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
  // A worker's bearer reaches the worker routes alone, and never Scope.
  const elsewhere = await fetch(events, { headers: { authorization: `Bearer ${workerToken}` } });
  assert.equal(elsewhere.status, 403);
  assert.deepEqual((await json(elsewhere)).error, {
    code: 'pi_forbidden',
    message: 'Worker credentials only reach the worker routes',
  });
  // A namespaced bearer no registered credential claims never reaches Scope.
  const unclaimed = await fetch(events, { headers: { authorization: 'Bearer zzz_unclaimed' } });
  assert.equal(unclaimed.status, 503);
  assert.deepEqual((await json(unclaimed)).error, {
    code: 'credential_unavailable',
    message: 'This credential is unavailable',
  });
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
    code: 'unavailable',
    message: 'This route is unavailable',
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
    // Only /next is held, well inside the running workers' 10 s request timeout.
    assert.deepEqual(action === 'tool' ? value.result : value, {
      action,
      input: { action },
      ...(action === 'next' && { holdMs: 5_000 }),
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
    [path, { headers: { ...headers, authorization: 'Bearer actor-http-token' } }, 401],
    [path, { headers: { ...headers, 'content-type': 'text/plain' } }, 415],
  ] as const) {
    const response = await post(url, options);
    assert.equal(response.status, status, url);
    await response.arrayBuffer();
  }
  assert.equal((await post(path, { body: '{' })).status, 400);
  const oversized = await post(path, { body: JSON.stringify({ padding: 'x'.repeat(16_000_000) }) });
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
