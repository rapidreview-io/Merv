import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decodeCheckpoint, encodeCheckpoint } from '../packages/pi/src/checkpoint.js';
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
/** One host slot's server: `next` scripts each /next reply and `model` each model request, named
 * by the turn's prompt; every other route accepts. */
const accepted: Record<string, object> = {
  begin: { apply: true },
  progress: { accepted: true },
  complete: { saved: true },
  fail: { interrupted: true },
};
type Sent = { headers: Headers; signal: AbortSignal };
function slotServer(
  slots: number,
  handlers: {
    next(count: number, body: Record<string, unknown>): PiNextReply | Response;
    model(name: string, body: Record<string, unknown>, request: Sent): Response;
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
        // The caller's signal: a Request's own stops following it once the Request is collected.
        { headers: incoming.headers, signal: init!.signal! },
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

test('the worker stops tool execution at its budget and completes through the relay', async () => {
  const server = slotServer(1, {
    next(count) {
      if (server.bodies('complete').length) server.controller.abort();
      return { work: count === 1 ? assignment('budget') : null };
    },
    model() {
      const first = server.bodies('responses').length === 1;
      return new Response(
        sse(
          first
            ? Array.from({ length: 65 }, (_, i) => ({
                ...call,
                id: `fc_${i}`,
                call_id: `call_${i}`,
              }))
            : [message('Finished')],
        ),
      );
    },
  });
  await server.run();
  assert.equal(server.bodies('tool').length, 64);
  assert.equal(server.bodies('responses')[1]!.tool_choice, 'none');
  assert.deepEqual(server.bodies('complete')[0]!.messages, [
    { role: 'assistant', text: 'Finished' },
  ]);
  assert.equal(server.bodies('fail').length, 0);
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
  model: (
    body: Record<string, unknown>,
    requests: Record<string, unknown>[],
    request: Sent,
  ) => Response,
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
    model(_name, body, request) {
      requests.push(body);
      return model(body, requests, request);
    },
  });
  return {
    server,
    requests,
    completions: () => server.bodies('complete') as unknown as PiCompletion[],
  };
}
const summary = 'Summary: the budget is 5k.';

/** A model reply sent only once `until` settles. */
const after = (until: Promise<unknown>, body: string) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        await until.catch(() => undefined);
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  );
/** A model reply never sent: only an abort ends it, as it ends a real fetch. */
const unanswered = (request: Sent) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const end = () => controller.error(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) end();
        else request.signal.addEventListener('abort', end);
      },
    }),
  );
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const answers = (requests: Record<string, unknown>[]) =>
  requests.filter((body) => !summarizing(body));
const compacted = (saved: ReturnType<typeof decodeCheckpoint>) =>
  saved.entries.filter((entry) => entry.type === 'compaction');
const savedBy = (done: PiCompletion) =>
  decodeCheckpoint({ content: done.checkpoint, hash: done.checkpointHash });

test('past 75% a summary starts beside the turn, which never waits for it and aborts it as it ends', async () => {
  let summaryRequest: Sent | undefined;
  const { server, requests, completions } = conversation(
    1,
    earlier(6, 40_000),
    (body, sent, request) => {
      if (summarizing(body)) {
        summaryRequest = request;
        return unanswered(request);
      }
      if (answers(sent).length === 1) return new Response(filled(sse([call]), 210_000));
      return after(pause(100), filled(sse([message('Answer')], 'Answer'), 215_000));
    },
  );
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(requests.filter(summarizing).length, 1);
  // Down its own lane; the turn's calls stay on theirs.
  assert.equal(summaryRequest!.headers.get('x-merv-pi-lane'), '1');
  assert.equal(summaryRequest!.signal.aborted, true);
  assert.equal(compacted(savedBy(completions()[0])).length, 0);
  assert.ok(completions()[0].checkpoint.includes('Question old1 '));
});

test('at 90% the finished summary swaps in at once, and all after its first kept entry stays', async () => {
  const { server, requests, completions } = conversation(1, earlier(6, 40_000), (body, sent) => {
    if (summarizing(body)) return new Response(sse([message(summary)], summary));
    const reply = answers(sent).length;
    if (reply === 1) return new Response(filled(sse([call]), 210_000));
    // Written after the summary was asked for, and past the 244,800 where Pi compacts.
    if (reply === 2) return after(pause(150), filled(sse([call]), 250_000));
    return new Response(sse([message('Answer')], 'Answer'));
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(requests.filter(summarizing).length, 1);
  const last = JSON.stringify(answers(requests).at(-1)!.input);
  assert.ok(last.includes(summary) && !last.includes('Question old1 '));
  // What came after the summary began is there word for word: both tool calls and their results.
  assert.ok(last.includes('Question t1'));
  assert.equal([...last.matchAll(/function_call_output/g)].length, 2);
  assert.ok(
    server
      .bodies('progress')
      .some((body) => JSON.stringify(body.events).includes('Compacted earlier conversation')),
  );
  assert.equal(compacted(savedBy(completions()[0])).length, 1);
});

test('at 90% an unfinished summary is waited for, never started twice', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let released = false;
  const { server, requests } = conversation(1, earlier(6, 40_000), (body, sent) => {
    if (summarizing(body)) return after(ready, sse([message(summary)], summary));
    const reply = answers(sent).length;
    if (reply === 1) return new Response(filled(sse([call]), 210_000));
    if (reply === 2) {
      setTimeout(() => {
        released = true;
        release();
      }, 300);
      return new Response(filled(sse([call]), 250_000));
    }
    // The call after the 90% waited for the summary.
    assert.equal(released, true);
    return new Response(sse([message('Answer')], 'Answer'));
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(requests.filter(summarizing).length, 1);
  assert.ok(JSON.stringify(answers(requests).at(-1)!.input).includes(summary));
});

test('a summary that failed leaves Pi to make its own at 90%, as it always did', async () => {
  let tried = 0;
  const { server, requests, completions } = conversation(1, earlier(6, 40_000), (body, sent) => {
    if (summarizing(body))
      return ++tried === 1
        ? json({ error: { message: 'unavailable' } }, 500)
        : new Response(sse([message(summary)], summary));
    const reply = answers(sent).length;
    if (reply === 1) return new Response(filled(sse([call]), 210_000));
    if (reply === 2) return after(pause(100), filled(sse([call]), 220_000));
    // Under the 90% no other was started in its place.
    if (reply === 3) {
      assert.equal(tried, 1);
      return after(pause(100), filled(sse([call]), 250_000));
    }
    return new Response(sse([message('Answer')], 'Answer'));
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(requests.filter(summarizing).length, 2);
  assert.ok(JSON.stringify(answers(requests).at(-1)!.input).includes(summary));
  assert.equal(compacted(savedBy(completions()[0])).length, 1);
});

test('a summary finished before the turn ends is used then, and the next turn pays for no other', async () => {
  const { server, requests, completions } = conversation(2, earlier(6, 40_000), (body, sent) => {
    if (summarizing(body)) return new Response(sse([message(summary)], summary));
    const reply = answers(sent).length;
    if (reply === 1) return new Response(filled(sse([call]), 210_000));
    if (reply === 2) return after(pause(150), filled(sse([message('Answer')], 'Answer'), 215_000));
    return new Response(filled(sse([message('Answer')], 'Answer'), 30_000));
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(requests.filter(summarizing).length, 1);
  assert.equal(compacted(savedBy(completions()[0])).length, 1);
  const next = JSON.stringify(requests.at(-1)!.input);
  assert.ok(next.includes(summary) && next.includes('Question t1') && next.includes('Question t2'));
});

test('a turn restored past 75% begins a summary at once, unless the turn before it was interrupted', async () => {
  // Eight exchanges of 105,000 characters: about 210,000 tokens.
  for (const interrupted of [false, true]) {
    const { server, requests } = conversation(
      1,
      earlier(8, 105_000),
      (body) =>
        summarizing(body)
          ? new Response(sse([message(summary)], summary))
          : after(pause(150), sse([message('Answer')], 'Answer')),
      interrupted ? { previousInterrupted: true } : {},
    );
    await server.run();
    assert.equal(server.bodies('fail').length, 0);
    assert.equal(requests.filter(summarizing).length, interrupted ? 0 : 1);
  }
});

test('after a summary the turn cut off, short turns start no other until the context has grown', async () => {
  // Each reply fills so much, one turn each: past 237,200 (210,000 and a tenth of the window) the
  // next begins; once Pi has compacted (the 250,000), the mark no longer holds.
  const fills = [210_000, 215_000, 230_000, 240_000, 250_000, 212_000];
  let replies = 0;
  const { server, completions } = conversation(
    fills.length,
    earlier(6, 40_000),
    (body, _sent, request) => {
      if (summarizing(body))
        return replies === 5 ? new Response(sse([message(summary)], summary)) : unanswered(request);
      return after(pause(100), filled(sse([message('Answer')], 'Answer'), fills[replies++]));
    },
  );
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  // Where each turn's checkpoint says the last unfinished summary began.
  const marks = completions().map(
    (done) =>
      (
        savedBy(done).entries.findLast((entry) => entry.type === 'custom') as unknown as {
          data: { tokens: number };
        }
      ).data.tokens,
  );
  assert.deepEqual(marks, [210_000, 210_000, 210_000, 240_000, 240_000, 212_000]);
});

test('a turn restored past 75% that cut its summary off starts no other at the next turn', async () => {
  let summaries = 0;
  const { server } = conversation(2, earlier(8, 105_000), (body, _sent, request) => {
    if (!summarizing(body)) return after(pause(100), sse([message('Answer')], 'Answer'));
    summaries++;
    return unanswered(request);
  });
  await server.run();
  assert.equal(server.bodies('fail').length, 0);
  assert.equal(summaries, 1);
});
