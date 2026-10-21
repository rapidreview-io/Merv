import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeCheckpoint, encodeCheckpoint } from '../packages/pi/src/checkpoint.js';
import { piResponsesSchema, validPiPayload } from '../packages/pi/src/relay-schema.js';
import type { PiBootstrap, PiCompletion, PiNextReply, PiWork } from '../packages/pi/src/types.js';
import { readBootstrap } from '../packages/pi/src/worker-main.js';
import { cause, runPiWorker } from '../packages/pi/src/worker.js';

const token = `piw_flt_test.${'a'.repeat(43)}`;
const relayToken = `pir_${'b'.repeat(43)}`;
const expires = () => new Date(Date.now() + 15_000).toISOString();
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const globalTool = {
  name: 'project.get',
  description: 'Read project',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const tool = globalTool;
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
const globalCall = {
  id: 'fc_1',
  type: 'function_call',
  call_id: 'call_1',
  name: 'project_get',
  arguments: '{}',
};
const call = globalCall;
function sse(items: object[], text?: string, cutOff = false): string {
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
    `data: ${JSON.stringify({ type: cutOff ? 'response.incomplete' : 'response.completed', response: { id: 'resp_1', status: cutOff ? 'incomplete' : 'completed', incomplete_details: cutOff ? { reason: 'max_output_tokens' } : null, output: items, usage: { input_tokens: 12, output_tokens: 8 } } })}\n\n`
  );
}
async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const write = process.stderr.write;
  let text = '';
  process.stderr.write = ((chunk: string) => ((text += chunk), true)) as typeof write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return text;
}

async function fixture(
  options: {
    toolCall?: boolean;
    screenImage?: boolean;
    boardImage?: boolean;
    calls?: number;
    cancel?: boolean;
    checkpoint?: PiWork['checkpoint'];
    turns?: number;
    lostBegin?: boolean;
    duplicate?: boolean;
    modelError?: boolean;
    /** The provider is overloaded on the first call: it opens the response, then fails it. */
    overloadedOnce?: boolean;
    slowTool?: boolean;
    startupFailures?: Array<number | 'network'>;
    nextAfterGrant?: number[];
    slowProgress?: boolean;
    globalFetch?: typeof fetch;
    cutOff?: boolean;
    model?: string;
    context?: string;
    toolFailures?: number[];
    toolResult?: unknown;
    progressFailures?: number[];
    /** The answer's words, streamed 10 ms apart. */
    paced?: string[];
    /** The first reply's tool call arguments, streamed 10 ms apart, with no words. */
    pacedCall?: string[];
    /** One model call each, before the answer: a text and a tool call. */
    sections?: string[];
    /** The turn's role has a terminal. */
    shell?: boolean;
  } = {},
) {
  const tool = {
    ...globalTool,
    ...(options.boardImage
      ? { name: 'board.look' }
      : options.screenImage
        ? { name: 'screen.look' }
        : {}),
  };
  const call = {
    ...globalCall,
    ...(options.boardImage
      ? { name: 'board_look' }
      : options.screenImage
        ? { name: 'screen_look' }
        : {}),
  };
  const controller = new AbortController();
  const completions: PiCompletion[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const progress: unknown[] = [];
  // When each progress request and the first paced word arrived.
  const progressAt: number[] = [];
  let firstWordAt = 0;
  const failures: string[] = [];
  let begun = 0;
  let issued = 0;
  let saves = 0;
  let nextRequests = 0;
  let toolRequests = 0;
  const startupFailures = [...(options.startupFailures ?? [])];
  const [nextAfterGrant, toolFailures, progressFailures] = [
    options.nextAfterGrant,
    options.toolFailures,
    options.progressFailures,
  ].map((failures) => [...(failures ?? [])]);
  const unavailable = (status: number) =>
    json({ error: { code: 'not_found', message: 'Artifact not found in this project' } }, status);
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
        // A role without a terminal never sends one; with one, exactly the library's five.
        const offered = options.shell
          ? ['bash', 'grep', 'ls', 'project_get', 'read', 'write']
          : [
              options.boardImage
                ? 'board_look'
                : options.screenImage
                  ? 'screen_look'
                  : 'project_get',
            ];
        assert.ok(validPiPayload(parsed.data, offered));
        assert.deepEqual(
          (body.tools as { name: string }[]).map((tool) => tool.name).sort(),
          offered,
        );
        assert.equal(parsed.data.prompt_cache_key, undefined);
        if (!options.shell) assert.ok(!JSON.stringify(body).includes('bash'));
        assert.ok(!JSON.stringify(body).includes('private-auth'));
        modelRequests.push(body);
        if (options.modelError) return json({ error: { message: 'private-auth' } }, 503);
        if (options.overloadedOnce && modelRequests.length === 1)
          return new Response(
            `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_0' } })}\n\n` +
              `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'server_is_overloaded', message: 'The model provider failed this call' })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        if (options.pacedCall && modelRequests.length === 1) {
          const parts = options.pacedCall;
          const item = { ...call, arguments: parts.join('') };
          const frame = (event: object) =>
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(frame({ type: 'response.created', response: { id: 'resp_1' } }));
              controller.enqueue(
                frame({
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { ...item, arguments: '' },
                }),
              );
              for (const delta of parts) {
                controller.enqueue(
                  frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta }),
                );
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              controller.enqueue(
                frame({ type: 'response.output_item.done', output_index: 0, item }),
              );
              controller.enqueue(
                frame({
                  type: 'response.completed',
                  response: {
                    id: 'resp_1',
                    status: 'completed',
                    output: [item],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                }),
              );
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        if (options.paced) {
          const words = options.paced;
          const item = message(words.join(''));
          const frame = (event: object) =>
            new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(frame({ type: 'response.created', response: { id: 'resp_1' } }));
              controller.enqueue(
                frame({ type: 'response.output_item.added', output_index: 0, item }),
              );
              for (const delta of words) {
                firstWordAt ||= Date.now();
                controller.enqueue(
                  frame({
                    type: 'response.output_text.delta',
                    output_index: 0,
                    content_index: 0,
                    delta,
                  }),
                );
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              controller.enqueue(
                frame({ type: 'response.output_item.done', output_index: 0, item }),
              );
              controller.enqueue(
                frame({
                  type: 'response.completed',
                  response: {
                    id: 'resp_1',
                    status: 'completed',
                    output: [item],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                }),
              );
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        // A turn revoked while it calls a tool makes the call first.
        if (options.cancel && !(options.toolCall && modelRequests.length === 1)) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'response.created', response: { id: 'slow_1' } })}\n\n`,
                ),
              );
              init!.signal!.addEventListener('abort', () => controller.close(), { once: true });
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        const section = options.sections?.[modelRequests.length - 1];
        if (section !== undefined) {
          const index = modelRequests.length;
          const items = [
            { ...message(section), id: `msg_${index}` },
            { ...call, id: `fc_${index}`, call_id: `call_${index}` },
          ];
          return new Response(sse(items), { headers: { 'content-type': 'text/event-stream' } });
        }
        const first = options.toolCall && modelRequests.length === 1;
        const items = first
          ? Array.from({ length: options.calls ?? 1 }, (_, index) =>
              index ? { ...call, id: `fc_${index + 1}`, call_id: `call_${index + 1}` } : call,
            )
          : [message('Finished')];
        return new Response(sse(items, first ? undefined : 'Finished', options.cutOff), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      assert.equal(auth, `Bearer ${token}`);
      // One worker serves many conversations, so every turn route names the turn's.
      if (path !== '/pi-worker/next') assert.equal(body.conversationId, 'conv_1');
      if (path === '/pi-worker/next') {
        if (issued && completions.length >= issued && nextAfterGrant.length)
          return json({ error: 'Authority unavailable' }, nextAfterGrant.shift());
        if (issued >= (options.turns ?? 1) || (issued && completions.length < issued))
          return json({ work: null });
        issued++;
        const commandId = options.duplicate ? 'cmd_1' : `cmd_${issued}`;
        const work: PiWork = {
          command: {
            id: commandId,
            conversationId: 'conv_1',
            hostId: 'pih_1',
            machine: 'standard',
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
          model: options.model ?? 'gpt-6-luna',
          modelBaseUrl: `${baseUrl}/pi-model`,
          modelToken: relayToken,
          tools: [tool],
          notes: [],
          instructions: 'You are a test agent.',
          ...(options.context === undefined ? {} : { context: options.context }),
          ...(options.shell ? { shell: true as const } : {}),
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
        assert.equal(body.name, tool.name);
        assert.deepEqual(body.input, {});
        toolRequests++;
        if (toolFailures.length) return unavailable(toolFailures.shift()!);
        if (options.slowTool) {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          });
        }
        return json({ result: options.toolResult ?? { title: 'Project' } });
      }
      if (path === '/pi-worker/progress') {
        progress.push(body.events);
        progressAt.push(Date.now());
        if (progressFailures.length) return unavailable(progressFailures.shift()!);
        if (options.slowProgress)
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
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
  const bootstrap = slotBootstrap(1, baseUrl);
  return {
    bootstrap,
    controller,
    completions,
    modelRequests,
    progress,
    progressAt,
    get firstWordAt() {
      return firstWordAt;
    },
    failures,
    get begins() {
      return begun;
    },
    get nextRequests() {
      return nextRequests;
    },
    get toolRequests() {
      return toolRequests;
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
          modelRetry: { sleep: async () => {} },
        });
      } finally {
        clearTimeout(timeout);
        globalThis.fetch = originalFetch;
      }
    },
  };
}

const slotBootstrap = (slots: number, baseUrl = 'https://pi-worker.test'): PiBootstrap => ({
  kind: 'pi',
  version: 2,
  baseUrl,
  hostId: 'pih_1',
  runtimeId: 'flt_test',
  epoch: 1,
  machine: 'standard',
  slots,
  workerToken: token,
  expiresAt: expires(),
});

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

test('project context travels as labeled user-level source, outside trusted system instructions', async () => {
  const source = JSON.stringify({
    documents: {
      problem: {
        current: { revision: 4, sections: [{ id: 'goals', content: 'Recover target effect' }] },
      },
    },
  });
  const app = await fixture({ context: source, turns: 2 });
  await app.run();
  // Each turn's requests carry the snapshot once; the history and checkpoint never hold it.
  const later = JSON.stringify(app.modelRequests[1]);
  assert.equal(later.split('Recover target effect').length, 2);
  assert.match(later, /Question 1/);
  assert.doesNotMatch(app.completions.at(-1)!.checkpoint, /Recover target effect/);
  const request = app.modelRequests[0];
  const input = request.input as { role: string; content: unknown }[];
  const system = input.filter(({ role }) => role === 'system');
  const user = input.filter(({ role }) => role === 'user');
  assert.ok(!JSON.stringify(system).includes('Recover target effect'));
  assert.match(JSON.stringify(user), /Project context for this turn/);
  assert.match(JSON.stringify(user), /Recover target effect/);
  assert.match(JSON.stringify(user), /Question 1/);
});

test('authority failure after an accepted grant exits; an outage is waited out', async () => {
  const revoked = await fixture({ turns: 2, nextAfterGrant: [401] });
  await assert.rejects(revoked.run(), /Worker request failed with HTTP 401/);
  assert.equal(revoked.nextRequests, 2);
  assert.equal(revoked.begins, 1);
  assert.equal(revoked.modelRequests.length, 1);
  const outage = await fixture({ turns: 2, nextAfterGrant: [503, 502] });
  await outage.run();
  assert.equal(outage.nextRequests, 4);
  assert.equal(outage.begins, 2);
  assert.equal(outage.completions.length, 3);
});

test('call 65 is refused before it runs, the next request carries tool_choice none, and the answer completes', async () => {
  const app = await fixture({ toolCall: true, calls: 65 });
  await app.run();
  assert.deepEqual(app.failures, []);
  assert.equal(app.toolRequests, 64);
  assert.deepEqual(
    app.modelRequests.map((request) => request.tool_choice),
    [undefined, 'none'],
  );
  assert.match(JSON.stringify(app.modelRequests[1].input), /used its 64 tool calls: answer now/);
  assert.equal(app.completions[0].outcomes.length, 64);
  assert.deepEqual(app.completions[0].messages, [{ role: 'assistant', text: 'Finished' }]);
});
const said = (content: object[], stopReason = 'stop') => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'openai',
  model: 'unknown-model',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

test('only a role with a terminal is offered bash, read, write, ls and grep, in its own folder', async (t) => {
  const plain = await fixture({});
  await plain.run();
  assert.deepEqual(plain.failures, []);
  const named = (app: { modelRequests: Record<string, unknown>[] }) =>
    (app.modelRequests[0].tools as { name: string }[]).map(({ name }) => name).sort();
  assert.deepEqual(named(plain), ['project_get']);

  const home = mkdtempSync(join(tmpdir(), 'pi-shell-home-'));
  const was = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = was;
    rmSync(home, { recursive: true, force: true });
  });
  const shell = await fixture({ shell: true });
  await shell.run();
  assert.deepEqual(shell.failures, []);
  assert.deepEqual(named(shell), ['bash', 'grep', 'ls', 'project_get', 'read', 'write']);
  assert.ok(statSync(join(home, 'conversations', 'conv_1')).isDirectory());
});

test('an assignment the worker refuses is failed at once instead of left to expire', async () => {
  const app = await fixture({ model: 'gpt-6/luna' });
  await app.run();
  assert.deepEqual(app.failures, ['cmd_1']);
  assert.equal(app.begins, 0);
  assert.equal(app.modelRequests.length, 0);
  const dotted = await fixture({ model: 'gpt-5.6-luna' });
  await dotted.run();
  assert.deepEqual(dotted.failures, []);
  assert.equal(dotted.modelRequests[0].model, 'gpt-5.6-luna');
});

test('oversized worker responses cancel their streams', async () => {
  for (const declared of [false, true]) {
    const app = await fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(declared ? 1 : 4_500_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'error');
      return new Response(body, {
        headers: declared ? { 'content-length': '4500001' } : {},
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
  await duplicate.run();
  assert.equal(duplicate.begins, 1);
  assert.equal(duplicate.modelRequests.length, 1);
  assert.deepEqual(duplicate.failures, ['cmd_1']);
});

test('provider error fails closed without automatic retry and logs its cause', async () => {
  const app = await fixture({ modelError: true });
  const logged = await stderrOf(() => app.run());
  assert.match(logged, /^Pi worker turn failed: Model response failed \(error\)$/m);
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

test('bootstrap is v2, bounded and strict; checkpoints verify digest and tree integrity', async () => {
  const read = (value: unknown) =>
    readBootstrap(
      (async function* () {
        yield typeof value === 'string' ? value : JSON.stringify(value);
      })(),
    );
  const bootstrap = await read(slotBootstrap(3, 'http://127.0.0.1'));
  assert.equal(bootstrap.workerToken, token);
  assert.equal(bootstrap.slots, 3);
  const { version: _version, hostId: _hostId, machine: _machine, slots: _slots, ...v1 } = bootstrap;
  for (const refused of [
    'a'.repeat(4100),
    { ...bootstrap, unexpected: 'secret' },
    { ...v1, projectId: 'proj_1', conversationId: 'conv_1' },
    { ...bootstrap, version: 1 },
    { ...bootstrap, slots: 0 },
    { ...bootstrap, slots: 9 },
    { ...bootstrap, machine: 'Large' },
    { ...bootstrap, hostId: '../host' },
  ])
    await assert.rejects(read(refused), /Invalid Pi bootstrap/);
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
  // Nor does the worker save a checkpoint Main would refuse, as one whose leaf it left out.
  const header = { type: 'session' as const, id: 's', cwd: '/pi-worker', timestamp: expires() };
  assert.throws(
    () => encodeCheckpoint({ getHeader: () => header, getEntries: () => [], getLeafId: () => 'a' }),
    /Invalid checkpoint leaf/,
  );
  assert.equal(cause(new Error(`Rejected ${token}`)), 'Unexpected error');
  assert.equal(cause(new Error('fetch https://pi.test failed')), 'Unexpected error');
});

const assignment = (name: string, change: Partial<PiWork['command']> = {}): PiWork => ({
  command: {
    id: `cmd_${name}`,
    conversationId: `conv_${name}`,
    hostId: 'pih_1',
    machine: 'standard',
    runtimeId: 'flt_test',
    epoch: 1,
    status: 'starting',
    messages: [{ role: 'user', text: `Question ${name}` }],
    outcomes: [],
    error: null,
    createdAt: expires(),
    expiresAt: expires(),
    completedAt: null,
    ...change,
  },
  checkpoint: null,
  model: 'gpt-6-luna',
  modelBaseUrl: 'https://pi-worker.test/pi-model',
  modelToken: relayToken,
  tools: [tool],
  notes: [`Note ${name}`],
  instructions: 'You are a test agent.',
});
/** An answer whose stream shows its first text, then waits for `release` to finish. */
function held(text: string, release: Promise<unknown>, started = () => {}): Response {
  const frames = sse([message(text)], text).split(/(?<=\n\n)/);
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(frames.slice(0, 3).join('')));
        started();
        await release;
        controller.enqueue(encoder.encode(frames.slice(3).join('')));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
/** One host slot's server: `next` scripts each /next reply and `model` each model request, named
 * by the turn's prompt; every other route accepts. */
const accepted: Record<string, object> = {
  begin: { apply: true },
  progress: { accepted: true },
  complete: { saved: true },
  fail: { interrupted: true },
};
function slotServer(
  slots: number,
  handlers: {
    next(count: number, body: Record<string, unknown>): PiNextReply | Response;
    model(name: string, body: Record<string, unknown>): Response;
    tool?(body: Record<string, unknown>): unknown;
    /** What any other route answers in place of `accepted`. */
    replies?: Record<string, object>;
  },
) {
  const controller = new AbortController();
  const calls: { route: string; body: Record<string, unknown>; at: number }[] = [];
  const bodies = (route: string) =>
    calls.filter((call) => call.route === route).map((call) => call.body);
  const fetchImpl: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    const route = new URL(incoming.url).pathname.split('/').at(-1)!;
    const body = JSON.parse(await incoming.text()) as Record<string, unknown>;
    calls.push({ route, body, at: Date.now() });
    if (route === 'responses')
      // The last prompt named; a summary of a turn's start may name none.
      return handlers.model(
        [...JSON.stringify(body.input).matchAll(/Question (\w+)/g)].at(-1)?.[1] ?? '',
        body,
      );
    if (route === 'next') {
      const reply = handlers.next(bodies('next').length, body);
      return reply instanceof Response ? reply : json(reply);
    }
    if (route === 'tool') {
      const result = await handlers.tool?.(body);
      return result instanceof Response ? result : json({ result: result ?? { title: 'Project' } });
    }
    return json(handlers.replies?.[route] ?? accepted[route]);
  };
  return {
    controller,
    calls,
    bodies,
    async run() {
      const safety = setTimeout(() => controller.abort(), 6_000);
      try {
        await runPiWorker(slotBootstrap(slots), {
          fetchImpl,
          signal: controller.signal,
          pollIntervalMs: 250,
          workerId: 'worker_1',
        });
      } finally {
        clearTimeout(safety);
      }
    },
  };
}

test('retire takes no more work, lets the running turn finish, then exits', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const server = slotServer(3, {
    next(count) {
      if (count === 2) setTimeout(release, 100);
      return count === 1
        ? { work: assignment('a') }
        : { work: null, retire: count === 2 || undefined };
    },
    model: () => held('Answer a', released),
  });
  await server.run();
  assert.equal(server.controller.signal.aborted, false);
  assert.equal(server.bodies('next').length, 2);
  assert.deepEqual(
    server.bodies('complete').map((body) => body.commandId),
    ['cmd_a'],
  );
});

test('a write is posted once, even after a 503, and a read is retried; writes in one reply run in order', async () => {
  const tools = [
    { ...tool, name: 'task.create', readOnly: false },
    { ...tool, name: 'feed.post', readOnly: false },
    { ...tool, name: 'task.get', readOnly: true },
  ];
  const calling = (id: number, name: string) => ({
    ...call,
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
  });
  let failed = 0;
  const log: string[] = [];
  let models = 0;
  const server = slotServer(3, {
    next(count) {
      if (server.bodies('complete').length) server.controller.abort();
      return { work: count === 1 ? { ...assignment('a'), tools } : null };
    },
    model() {
      models++;
      return new Response(
        models === 1
          ? sse([calling(1, 'task_create'), calling(2, 'feed_post'), calling(3, 'task_get')])
          : sse([message('Done')], 'Done'),
      );
    },
    async tool(body) {
      const name = String(body.name);
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      log.push(`end ${name}`);
      return name !== 'feed.post' && failed++ < 2
        ? json({ error: { code: 'unavailable', message: 'Busy' } }, 503)
        : { ran: name };
    },
  });
  await server.run();
  const posted = server.bodies('tool').map(({ name }) => name);
  assert.equal(posted.filter((name) => name === 'task.create').length, 1);
  assert.equal(posted.filter((name) => name === 'task.get').length, 2);
  // The reply's calls run one at a time, in order, as it holds writes.
  assert.deepEqual(
    log,
    ['task.create', 'feed.post', 'task.get', 'task.get'].flatMap((name) => [
      `start ${name}`,
      `end ${name}`,
    ]),
  );
  assert.deepEqual(
    (server.bodies('complete')[0].outcomes as { name: string }[]).map(({ name }) => name),
    ['feed.post', 'task.get'],
  );
  assert.equal(server.bodies('fail').length, 0);
});

/** `turns` earlier exchanges of a conversation saved before compaction existed, each prompt
 * `filler` characters long; the last answer says it filled `tokens` of the model's window. */
function earlier(
  turns: number,
  filler: number,
  tokens = 30_100,
  first: Record<string, unknown>[] = [],
) {
  const at = new Date().toISOString();
  const entries: Record<string, unknown>[] = [...first];
  for (let turn = 1; turn <= turns; turn++) {
    entries.push(
      {
        type: 'message',
        id: `user_${turn}`,
        parentId: (entries.at(-1)?.id as string | undefined) ?? null,
        timestamp: at,
        message: {
          role: 'user',
          content: `Question old${turn} ${'y'.repeat(filler)}`,
          timestamp: 1,
        },
      },
      {
        type: 'message',
        id: `answer_${turn}`,
        parentId: `user_${turn}`,
        timestamp: at,
        message: {
          ...said([{ type: 'text', text: `Answer ${turn}` }]),
          model: 'gpt-6-luna',
          usage: {
            input: tokens - 100,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: turn === turns ? tokens : 30_100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      },
    );
  }
  const content = JSON.stringify({
    version: 1,
    header: { type: 'session', version: 3, id: 'session_long', cwd: '/pi-worker', timestamp: at },
    entries,
    leafId: entries.at(-1)!.id,
  });
  return { content, hash: digest(content) };
}
/** A model reply that says the request and answer filled `tokens` of the window. */
const filled = (body: string, tokens: number) =>
  body.replace(
    '"usage":{"input_tokens":12,"output_tokens":8}',
    `"usage":{"input_tokens":${tokens - 8},"output_tokens":8,"total_tokens":${tokens}}`,
  );
const summarizing = (body: Record<string, unknown>) =>
  JSON.stringify(body.input).includes('context summarization assistant');
/** A conversation of `turns` turns, the first restoring `checkpoint`; each later one restores
 * the checkpoint its turn before saved. */
function conversation(
  turns: number,
  checkpoint: PiWork['checkpoint'],
  model: (body: Record<string, unknown>, requests: Record<string, unknown>[]) => Response,
  change: Partial<PiWork> = {},
) {
  const requests: Record<string, unknown>[] = [];
  let issued = 0;
  const server = slotServer(3, {
    next() {
      const done = server.bodies('complete');
      if (done.length === turns) server.controller.abort();
      if (issued > done.length || issued === turns) return { work: null };
      issued++;
      const previous = done.at(-1) as { checkpoint: string; checkpointHash: string } | undefined;
      return {
        work: {
          ...assignment(`t${issued}`, { conversationId: 'conv_a' }),
          checkpoint: previous
            ? { content: previous.checkpoint, hash: previous.checkpointHash }
            : checkpoint,
          ...change,
        },
      };
    },
    model(_name, body) {
      requests.push(body);
      return model(body, requests);
    },
  });
  return {
    server,
    requests,
    completions: () => server.bodies('complete') as unknown as PiCompletion[],
  };
}
const summary = 'Summary: the budget is 5k.';

test('a long conversation compacts once past 90% of the window, and the next turn starts from its summary', async () => {
  // Six earlier exchanges of 10,000 tokens each; the first answer fills 250,000 of gpt-6-luna's
  // 272,000 tokens, past the 244,800 where Codex compacts too.
  const { server, requests, completions } = conversation(2, earlier(6, 40_000), (body, sent) =>
    summarizing(body)
      ? new Response(sse([message(summary)], summary))
      : new Response(
          filled(sse([message('Answer')], 'Answer'), sent.length === 1 ? 250_000 : 9_000),
        ),
  );
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  const summaries = requests.filter(summarizing);
  assert.equal(summaries.length, 1);
  // The summary is one more call through the relay, which accepts it as it does any other.
  const parsed = piResponsesSchema.safeParse(summaries[0]);
  assert.ok(parsed.success && validPiPayload(parsed.data, ['project_get']));
  assert.equal(summaries[0].tools, undefined);
  assert.ok(JSON.stringify(summaries[0].input).includes('Question old1 '));
  const [first, second] = completions();
  assert.deepEqual(first.messages, [{ role: 'assistant', text: 'Answer' }]);
  assert.deepEqual(second.messages, [{ role: 'assistant', text: 'Answer' }]);
  assert.ok(
    server
      .bodies('progress')
      .some((body) => JSON.stringify(body.events).includes('Compacted earlier conversation')),
  );
  // The checkpoint holds the summary, then what Pi kept: the oldest exchanges are gone.
  const saved = decodeCheckpoint({ content: first.checkpoint, hash: first.checkpointHash });
  assert.equal(saved.entries[0].type, 'compaction');
  assert.equal(saved.leafId, saved.entries.at(-1)!.id);
  assert.ok(
    !first.checkpoint.includes('Question old1 ') && first.checkpoint.includes('Question t1'),
  );
  // The next turn sends the current instructions, the summary and what came after it.
  const next = requests.at(-1)!;
  const sent = JSON.stringify(next.input);
  assert.equal((next.input as { role?: string }[])[0].role, 'developer');
  assert.ok(sent.includes(summary) && sent.includes('Question t1') && sent.includes('Question t2'));
  assert.ok(sent.includes('Question old6 ') && !sent.includes('Question old1 '));
});

test('a failed summary keeps the conversation: the turn and the checkpoint fall back to the window', async () => {
  // Eight exchanges of 60,000 characters: more than gpt-6-luna's window held before compaction
  // (304 KB beside 128 KB of tool results), restored whole now that compaction bounds it.
  const { server, requests, completions } = conversation(2, earlier(8, 60_000), (body, sent) => {
    if (summarizing(body)) return json({ error: { message: 'unavailable' } }, 500);
    // The first reply reads a project and fills 250,000 tokens: compaction is due before the next.
    if (sent.length === 1) return new Response(filled(sse([call]), 250_000));
    return new Response(sse([message('Answer')], 'Answer'));
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  // One summary is tried; once it fails the turn tries no other.
  assert.equal(requests.filter(summarizing).length, 1);
  assert.equal(requests.length, 4);
  assert.ok(JSON.stringify(requests[0].input).includes('Question old1 '));
  // The rest of the turn is sent within the window, as before compaction: newest exchanges first.
  const after = JSON.stringify(requests[2].input);
  assert.ok(!after.includes('Question old1 ') && after.includes('Question old8 '));
  assert.ok(after.includes('Question t1') && after.includes('function_call_output'));
  const [first, second] = completions();
  assert.deepEqual(first.messages, [{ role: 'assistant', text: 'Answer' }]);
  assert.deepEqual(second.messages, [{ role: 'assistant', text: 'Answer' }]);
  const saved = decodeCheckpoint({ content: first.checkpoint, hash: first.checkpointHash });
  assert.ok(saved.entries.every((entry) => entry.type !== 'compaction'));
  assert.ok(first.checkpoint.length < 330_000 && first.checkpoint.includes('Question t1'));
  assert.ok(JSON.stringify(requests[3].input).includes('Question t2'));
  assert.ok(
    server
      .bodies('progress')
      .every((body) => !JSON.stringify(body.events).includes('Compacted earlier conversation')),
  );
});
