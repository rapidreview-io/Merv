import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeCheckpoint, encodeCheckpoint } from '../packages/pi/src/checkpoint.js';
import { readBootstrap } from '../packages/pi/src/worker-main.js';
import { runPiWorker } from '../packages/pi/src/worker.js';
import { piResponsesSchema, validPiPayload } from '../packages/pi/src/relay-schema.js';
import type { PiBootstrap, PiCompletion, PiWork } from '../packages/pi/src/types.js';

const token = `piw_flt_test.${'a'.repeat(43)}`;
const relayToken = `pir_${'b'.repeat(43)}`;
const expires = () => new Date(Date.now() + 15_000).toISOString();
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const tool = {
  name: 'project.get',
  description: 'Read project',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

function sseItem(item: object, index = 0): string {
  return (
    `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: index, item })}\n\n` +
    `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item })}\n\n`
  );
}
const message = (text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'project_get',
  arguments: '{}',
};
function sse(items: object[], text?: string): string {
  const output = items
    .map((item, index) =>
      item === items.at(-1) && text !== undefined
        ? `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: index, item })}\n\n` +
          `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: text })}\n\n` +
          `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item })}\n\n`
        : sseItem(item, index),
    )
    .join('');
  return (
    `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n\n` +
    output +
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: items, usage: { input_tokens: 12, output_tokens: 8 } } })}\n\n`
  );
}

async function fixture(
  options: {
    toolCall?: boolean;
    cancel?: boolean;
    checkpoint?: PiWork['checkpoint'];
    turns?: number;
    lostBegin?: boolean;
    duplicate?: boolean;
    modelError?: boolean;
    slowTool?: boolean;
    startupFailures?: Array<number | 'network'>;
    nextAfterGrantStatus?: number;
    slowProgress?: boolean;
    globalFetch?: typeof fetch;
  } = {},
) {
  const controller = new AbortController();
  const completions: PiCompletion[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const progress: unknown[] = [];
  const failures: string[] = [];
  let begun = 0;
  let issued = 0;
  let saves = 0;
  let nextRequests = 0;
  const startupFailures = [...(options.startupFailures ?? [])];
  const baseUrl = 'https://pi-worker.test';
  const fakeFetch: typeof fetch = async (input, init) => {
    if (new URL(new Request(input, init).url).pathname === '/pi-worker/next') {
      nextRequests++;
      const failure = startupFailures.shift();
      if (failure === 'network') throw new TypeError('Network unavailable');
      if (failure) return json({ error: 'Not enrolled' }, failure);
    }
    try {
      const incoming = new Request(input, init);
      const body = JSON.parse(await incoming.text()) as Record<string, unknown>;
      const path = new URL(incoming.url).pathname;
      const auth = incoming.headers.get('authorization');
      assert.equal(incoming.redirect, 'error');
      if (path === '/pi-model/responses') {
        assert.equal(incoming.method, 'POST');
        assert.equal(incoming.url, `${baseUrl}/pi-model/responses`);
        assert.deepEqual([...incoming.headers.keys()].sort(), [
          'accept',
          'authorization',
          'content-type',
        ]);
        assert.equal(incoming.headers.get('accept'), 'text/event-stream');
        assert.equal(auth, `Bearer ${relayToken}`);
        const parsed = piResponsesSchema.safeParse(body);
        assert.ok(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
        assert.ok(validPiPayload(parsed.data, ['project_get']));
        assert.deepEqual(
          (body.tools as { name: string }[]).map((tool) => tool.name),
          ['project_get'],
        );
        assert.equal(parsed.data.prompt_cache_key, undefined);
        assert.ok(!JSON.stringify(body).includes('bash'));
        assert.ok(!JSON.stringify(body).includes('private-auth'));
        modelRequests.push(body);
        if (options.modelError) return json({ error: { message: 'private-auth' } }, 503);
        if (options.cancel) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'response.created', response: { id: 'slow_1' } })}\n\n`,
                ),
              );
              incoming.signal.addEventListener('abort', () => controller.close(), { once: true });
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        const first = options.toolCall && modelRequests.length === 1;
        const items = first ? [call] : [message('Finished')];
        return new Response(sse(items, first ? undefined : 'Finished'), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      assert.equal(auth, `Bearer ${token}`);
      if (path === '/pi-worker/next') {
        if (issued && completions.length >= issued && options.nextAfterGrantStatus)
          return json({ error: 'Authority unavailable' }, options.nextAfterGrantStatus);
        if (issued >= (options.turns ?? 1) || (issued && completions.length < issued))
          return json({ work: null });
        issued++;
        const commandId = options.duplicate ? 'cmd_1' : `cmd_${issued}`;
        const work: PiWork = {
          command: {
            id: commandId,
            conversationId: 'conv_1',
            runtimeId: 'flt_test',
            epoch: 1,
            status: 'starting',
            messages: [{ role: 'user', text: `Question ${issued}` }],
            outcomes: [],
            error: null,
            createdAt: expires(),
            expiresAt: expires(),
            completedAt: null,
          },
          checkpoint: completions.length
            ? { content: completions.at(-1)!.checkpoint, hash: completions.at(-1)!.checkpointHash }
            : (options.checkpoint ?? null),
          model: 'fake-model',
          modelBaseUrl: `${baseUrl}/pi-model`,
          modelToken: relayToken,
          tools: [tool],
        };
        return json({ work });
      }
      if (path === '/pi-worker/begin') {
        begun++;
        if (options.lostBegin)
          return json({ error: { code: 'unavailable', message: 'unavailable' } }, 503);
        return json({ apply: begun <= (options.turns ?? 1) });
      }
      if (path === '/pi-worker/tool') {
        assert.equal(body.name, 'project.get');
        assert.deepEqual(body.input, {});
        if (options.slowTool) {
          return new Promise<Response>((_resolve, reject) => {
            incoming.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          });
        }
        return json({ result: { title: 'Project' } });
      }
      if (path === '/pi-worker/progress') {
        progress.push(body.events);
        if (options.slowProgress)
          return new Promise<Response>((_resolve, reject) => {
            incoming.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          });
        if (options.cancel)
          return json({ error: { code: 'pi_command_stale', message: 'revoked' } }, 409);
        return json({ accepted: true });
      }
      if (path === '/pi-worker/complete') {
        completions.push(body as unknown as PiCompletion);
        if (++saves === 1) return json({ saved: false });
        if (completions.length >= (options.turns ?? 1) + 1) controller.abort();
        return json({ saved: true });
      }
      if (path === '/pi-worker/fail') {
        failures.push(String(body.commandId));
        controller.abort();
        return json({ interrupted: true });
      }
      return json({ error: { code: 'not_found', message: 'unavailable' } }, 404);
    } catch {
      return json({ error: { code: 'unavailable', message: 'unavailable' } }, 503);
    }
  };
  const bootstrap: PiBootstrap = {
    kind: 'pi',
    baseUrl,
    projectId: 'proj_1',
    conversationId: 'conv_1',
    runtimeId: 'flt_test',
    epoch: 1,
    workerToken: token,
    expiresAt: expires(),
  };
  return {
    bootstrap,
    controller,
    completions,
    modelRequests,
    progress,
    failures,
    get begins() {
      return begun;
    },
    get nextRequests() {
      return nextRequests;
    },
    async run() {
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = options.globalFetch ?? fakeFetch;
      try {
        await runPiWorker(bootstrap, {
          fetchImpl: fakeFetch,
          signal: controller.signal,
          pollIntervalMs: 250,
          workerId: 'worker_1',
        });
      } finally {
        clearTimeout(timeout);
        globalThis.fetch = originalFetch;
      }
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('real Pi session streams through relay, invokes only allowlisted tool, checkpoints and retries exact completion', async () => {
  const app = await fixture({ toolCall: true });
  const keys = [
    'OPENAI_API_KEY',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'OPENAI_BASE_URL',
    'PI_CACHE_RETENTION',
  ];
  const previous = keys.map((key) => process.env[key]);
  process.env.OPENAI_API_KEY = 'private-auth';
  process.env.OPENAI_ORG_ID = 'private-organization';
  process.env.OPENAI_PROJECT_ID = 'private-project';
  process.env.OPENAI_BASE_URL = 'https://ambient-openai.invalid';
  process.env.PI_CACHE_RETENTION = 'long';
  try {
    await app.run();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
  assert.equal(app.modelRequests.length, 2);
  assert.equal(app.begins, 1);
  assert.equal(app.completions.length, 2);
  assert.deepEqual(app.completions[0], app.completions[1]);
  assert.deepEqual(app.completions[0].messages, [{ role: 'assistant', text: 'Finished' }]);
  assert.deepEqual(app.completions[0].outcomes, [
    { callId: 'call_1', name: 'project.get', input: {}, output: { title: 'Project' } },
  ]);
  assert.equal(app.failures.length, 0);
  assert.ok(app.progress.length > 0);
  const checkpoint = decodeCheckpoint({
    content: app.completions[0].checkpoint,
    hash: app.completions[0].checkpointHash,
  });
  assert.ok(checkpoint.entries.some((entry) => entry.type === 'message'));
  assert.ok(checkpoint.leafId);
});

test('model stream uses only the supplied relay transport, never ambient fetch', async () => {
  let ambientCalls = 0;
  const app = await fixture({
    globalFetch: async () => {
      ambientCalls++;
      throw new Error('Ambient fetch forbidden');
    },
  });
  await app.run();
  assert.equal(ambientCalls, 0);
  assert.equal(app.modelRequests.length, 1);
});

test('startup waits for delayed enrollment without repeating a begun prompt', async () => {
  const app = await fixture({ startupFailures: [401, 403, 503, 'network'] });
  await app.run();
  assert.equal(app.begins, 1);
  assert.equal(app.modelRequests.length, 1);
  assert.equal(app.completions.length, 2);
  assert.equal(app.nextRequests, 5);
});

test('startup enrollment wait stops at bootstrap expiry', async () => {
  const app = await fixture({ startupFailures: Array(20).fill(503) });
  app.bootstrap.expiresAt = new Date(Date.now() + 450).toISOString();
  const started = Date.now();
  await app.run().catch((error: unknown) => {
    assert.match(String(error), /Worker authority unavailable/);
  });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(app.begins, 0);
  assert.equal(app.modelRequests.length, 0);
});

test('authority failure after an accepted grant exits instead of re-enrolling', async () => {
  const app = await fixture({ turns: 2, nextAfterGrantStatus: 503 });
  await assert.rejects(app.run(), /Worker authority unavailable/);
  assert.equal(app.nextRequests, 2);
  assert.equal(app.begins, 1);
  assert.equal(app.modelRequests.length, 1);
});

test('requested shutdown during an in-flight next poll exits normally before or after enrollment', async (t) => {
  for (const enrolled of [false, true])
    await t.test(enrolled ? 'idle enrolled worker' : 'initial enrollment', async () => {
      const app = await fixture();
      let calls = 0;
      let polling!: () => void;
      const ready = new Promise<void>((resolve) => {
        polling = resolve;
      });
      const worker = runPiWorker(app.bootstrap, {
        signal: app.controller.signal,
        pollIntervalMs: 1,
        fetchImpl: async (input, init) => {
          assert.equal(new URL(String(input)).pathname, '/pi-worker/next');
          calls++;
          if (enrolled && calls === 1) return json({ work: null });
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
            polling();
          });
        },
      });
      await ready;
      app.controller.abort();
      await assert.doesNotReject(worker);
      assert.equal(calls, enrolled ? 2 : 1);
    });
});

test('slow progress delivery permits only one outstanding batch or heartbeat', async () => {
  const app = await fixture({ cancel: true, slowProgress: true });
  const stop = setTimeout(() => app.controller.abort(), 1_100);
  try {
    await app.run();
  } finally {
    clearTimeout(stop);
  }
  assert.equal(app.progress.length, 1);
  assert.equal(app.modelRequests.length, 1);
});

test('oversized worker responses cancel their streams', async () => {
  for (const declared of [false, true]) {
    const app = await fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(declared ? 1 : 2_100_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return new Response(body, {
        headers: declared ? { 'content-length': '2100001' } : {},
      });
    };
    await assert.rejects(runPiWorker(app.bootstrap, { fetchImpl }), /exceeds limit/);
    assert.equal(cancelled, true);
  }
});

test('subsequent turn restores prior context but returns only new canonical assistant messages', async () => {
  const app = await fixture({ turns: 2 });
  await app.run();
  assert.equal(app.modelRequests.length, 2);
  assert.equal(app.completions.length, 3);
  assert.deepEqual(app.completions[2].messages, [{ role: 'assistant', text: 'Finished' }]);
  const checkpoint = decodeCheckpoint({
    content: app.completions[2].checkpoint,
    hash: app.completions[2].checkpointHash,
  });
  assert.ok(checkpoint.entries.filter((entry) => entry.type === 'message').length >= 4);
  assert.ok(
    checkpoint.entries.some((entry) => {
      if (entry.type !== 'message' || !('message' in entry)) return false;
      const content = (entry.message as { content?: unknown }).content;
      return (
        Array.isArray(content) &&
        content.some((part: { text?: string }) => part.text === 'Question 1')
      );
    }),
  );
});

test('lost begin reply never replays prompt; duplicate assignment never invokes model twice', async () => {
  const ambiguous = await fixture({ lostBegin: true });
  await ambiguous.run();
  assert.equal(ambiguous.begins, 1);
  assert.equal(ambiguous.modelRequests.length, 0);
  assert.deepEqual(ambiguous.failures, ['cmd_1']);
  const duplicate = await fixture({ duplicate: true, turns: 2 });
  await assert.rejects(duplicate.run(), /Duplicate worker assignment/);
  assert.equal(duplicate.begins, 1);
  assert.equal(duplicate.modelRequests.length, 1);
});

test('provider error fails closed without automatic retry', async () => {
  const app = await fixture({ modelError: true });
  await app.run();
  assert.equal(app.modelRequests.length, 1);
  assert.deepEqual(app.failures, ['cmd_1']);
  assert.equal(app.completions.length, 0);
});

test('checkpoint restores the full tree and active branch into the actual Pi session', async () => {
  const previous = {
    version: 1,
    header: {
      type: 'session',
      version: 3,
      id: 'session_test',
      cwd: '/pi-worker',
      timestamp: expires(),
    },
    entries: [
      {
        type: 'message',
        id: 'root',
        parentId: null,
        timestamp: expires(),
        message: { role: 'user', content: 'Earlier', timestamp: Date.now() },
      },
      {
        type: 'message',
        id: 'sibling',
        parentId: 'root',
        timestamp: expires(),
        message: { role: 'user', content: 'Other branch', timestamp: Date.now() },
      },
      {
        type: 'message',
        id: 'active',
        parentId: 'root',
        timestamp: expires(),
        message: { role: 'user', content: 'Active branch', timestamp: Date.now() },
      },
    ],
    leafId: 'sibling',
  };
  const content = JSON.stringify(previous);
  const app = await fixture({ checkpoint: { content, hash: digest(content) } });
  await app.run();
  assert.equal(app.completions.length, 2);
  const next = decodeCheckpoint({
    content: app.completions[0].checkpoint,
    hash: app.completions[0].checkpointHash,
  });
  assert.ok(next.entries.some((entry) => entry.id === 'active'));
  assert.ok(next.entries.some((entry) => entry.id === 'sibling'));
  assert.ok(next.entries.some((entry) => entry.parentId === 'sibling'));
  assert.equal(app.completions[0].messages.length, 1);
});

test('revocation aborts a silent model turn without completing or retrying the provider', async () => {
  const app = await fixture({ cancel: true });
  await app.run();
  assert.equal(app.modelRequests.length, 1);
  assert.deepEqual(app.failures, ['cmd_1']);
  assert.equal(app.completions.length, 0);
});

test('revocation aborts an outstanding read tool before another model request', async () => {
  const app = await fixture({ toolCall: true, slowTool: true, cancel: true });
  await app.run();
  assert.equal(app.modelRequests.length, 1);
  assert.deepEqual(app.failures, ['cmd_1']);
  assert.equal(app.completions.length, 0);
});

test('bootstrap is bounded and strict; checkpoints verify digest and tree integrity', async () => {
  const bootstrap = await readBootstrap(
    (async function* () {
      yield JSON.stringify({
        kind: 'pi',
        baseUrl: 'http://127.0.0.1',
        projectId: 'proj_1',
        conversationId: 'conv_1',
        runtimeId: 'flt_test',
        epoch: 1,
        workerToken: token,
        expiresAt: expires(),
      });
    })(),
  );
  assert.equal(bootstrap.workerToken, token);
  await assert.rejects(
    readBootstrap(
      (async function* () {
        yield 'a'.repeat(4100);
      })(),
    ),
    /Invalid Pi bootstrap/,
  );
  await assert.rejects(
    readBootstrap(
      (async function* () {
        yield JSON.stringify({ ...bootstrap, unexpected: 'secret' });
      })(),
    ),
    /Invalid Pi bootstrap/,
  );
  const content = JSON.stringify({
    version: 1,
    header: { type: 'session', id: 's', cwd: '/pi-worker', timestamp: expires() },
    entries: [{ id: 'bad', parentId: 'missing', type: 'message' }],
    leafId: 'bad',
  });
  assert.throws(
    () => decodeCheckpoint({ content, hash: digest(content) }),
    /Invalid checkpoint tree/,
  );
  assert.throws(() => decodeCheckpoint({ content, hash: '0'.repeat(64) }), /digest/);
  assert.throws(
    () => encodeCheckpoint({ getHeader: () => null, getEntries: () => [], getLeafId: () => null }),
    /Invalid session/,
  );
});
