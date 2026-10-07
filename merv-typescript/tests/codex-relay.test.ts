import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createService, MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { ManagedModelGrant } from '@merv/fleet/types';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import {
  codexModelRelay,
  codexPayload,
  hostedGrant,
  markRelayStart,
  modelBudgetStatus,
  relayFaulted,
  setDailyTokens,
} from '../packages/fleet/src/codex-relay.js';
import { modelMigrations } from '../packages/fleet/src/schema.js';
import { hostedCodexPlatform } from '@merv/fleet/hosted-codex';
import { openState } from './fixtures/state.js';

const key = 'private-provider-key';
const bearer = `ms_${'b'.repeat(43)}`;
const grant: ManagedModelGrant = {
  id: 'session_hosted',
  projectId: 'project_hosted',
  allocationId: 'flt_hosted',
  person: 'person_hosted',
  model: 'gpt-6-luna',
  effort: 'medium',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
/** The body Codex sends through the hosted provider for a model it runs on plain Responses,
 *  trimmed: its MCP server's tools arrive as one namespace. */
const codex = {
  model: 'gpt-6-luna',
  instructions: 'You are Codex.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'id -u' }] }],
  tools: [
    { type: 'function', name: 'exec_command', strict: false, parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'mcp__merv',
      description: 'Merv',
      tools: [{ type: 'function', name: 'task_get', parameters: { type: 'object' } }],
    },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { summary: 'auto', effort: 'xhigh' },
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'thread_1',
  client_metadata: { thread_id: 'thread_1' },
};
/** The body Codex 0.160.1 sends for a model its catalog runs on Responses Lite (gpt-6.1-sol),
 *  trimmed: the tools travel as the first input item, code mode's `exec` among them. */
const lite = {
  model: 'gpt-6-luna',
  input: [
    {
      type: 'additional_tools',
      id: 'at_1',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          description: '',
          tools: [
            {
              type: 'custom',
              name: 'exec',
              description: 'Run JavaScript code to orchestrate/compose tool calls',
              format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' },
            },
            { type: 'function', name: 'wait', parameters: { type: 'object' } },
          ],
        },
      ],
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'developer',
      content: [{ type: 'input_text', text: 'You are Codex.' }],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'id -u' }] },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'low', context: 'all_turns' },
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'thread_1',
  text: { verbosity: 'low' },
  client_metadata: { thread_id: 'thread_1' },
};
const completed = (input: number, output: number) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: input, output_tokens: output } },
  })}\n\n`;

async function fixture(t: TestContext, dailyTokensPerPerson = 1_000_000) {
  const state = await openState();
  // Fleet's model migrations reference Scope's projects table.
  await createService(new ProjectScope(state));
  await state.migrate('fleet_workflow', modelMigrations);
  let live = true;
  let down = false;
  let upstreamStatus = 200;
  const upstream: { body: Record<string, any>; authorization: string; lite: string | null }[] = [];
  let hold: Promise<void> | undefined;
  let afterCompleted: Promise<void> | undefined;
  let terminalFrame = completed(80, 30);
  const logs: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => logs.push(String(chunk)) > 0) as never;
  t.after(() => void (process.stderr.write = write));
  const authorize = async (presented: string) => {
    if (down) throw new MervError('database_unavailable', 'The database is unavailable', 503);
    if (!live || ![bearer, grant.id].includes(presented))
      throw new MervError('unauthorized', 'No live managed session', 401);
    return grant;
  };
  const start = async () => {
    const relay = new ModelRelay(
      codexModelRelay(state, { providerKey: () => key, dailyTokensPerPerson, authorize }),
      {
        fetchImpl: async (_url, init) => {
          upstream.push({
            body: JSON.parse(String(init!.body)),
            authorization: new Headers(init!.headers).get('authorization')!,
            lite: new Headers(init!.headers).get('x-openai-internal-codex-responses-lite'),
          });
          if (upstreamStatus !== 200) return new Response('{}', { status: upstreamStatus });
          const held = hold;
          const finish = afterCompleted;
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: response.created\ndata: {}\n\n'),
                );
                await held;
                controller.enqueue(new TextEncoder().encode(terminalFrame));
                await finish;
                try {
                  controller.close();
                } catch {
                  /* The client may have closed after completion. */
                }
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
    );
    const server = createServer((req, res) => void relay.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      relay.close();
      server.close();
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/codex-model/responses`;
  };
  const url = await start();
  const call = (body: unknown = codex, to = url, signal?: AbortSignal) =>
    fetch(to, {
      signal,
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const spent = async () =>
    Number(
      (
        await state.read((sql) =>
          sql.get<{ tokens: string }>(
            'SELECT tokens FROM fleet_model_usage WHERE person=?',
            grant.person,
          ),
        )
      )?.tokens ?? 0,
    );
  return {
    state,
    call,
    start,
    upstream,
    logs,
    spent,
    revoke: () => void (live = false),
    down: (value: boolean) => void (down = value),
    upstreamStatus: (status: number) => void (upstreamStatus = status),
    hold: (until: Promise<void>) => void (hold = until),
    afterCompleted: (until: Promise<void>) => void (afterCompleted = until),
    respond: (frame: string) => void (terminalFrame = frame),
  };
}

test('what Codex sends passes with the binding’s model and effort and the relay’s output cap', async (t) => {
  const f = await fixture(t);
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(f.upstream[0].authorization, `Bearer ${key}`);
  assert.deepEqual(f.upstream[0].body, {
    ...codex,
    reasoning: { summary: 'auto', effort: 'medium' },
    max_output_tokens: 65_536,
  });
  assert.doesNotMatch(f.logs.join(''), /"event":"codex_relay_failure"/);
  assert.match(
    f.logs.join(''),
    /"event":"codex_relay_terminal","model":"gpt-6-luna","status":"completed","incompleteReason":null/,
  );
});

test('a Responses Lite call passes with Codex’s lite header, its tools held to the same rule', async (t) => {
  const f = await fixture(t);
  const response = await f.call(lite);
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(f.upstream[0].body, {
    ...lite,
    reasoning: { effort: 'medium', context: 'all_turns' },
    max_output_tokens: 65_536,
  });
  assert.equal(f.upstream[0].lite, 'true');
  // A plain Responses call carries no lite header.
  await (await f.call()).text();
  assert.equal(f.upstream[1].lite, null);
  const [carrier, ...rest] = lite.input;
  for (const body of [
    { ...lite, input: [{ ...carrier, tools: [{ type: 'web_search' }] }, ...rest] },
    {
      ...lite,
      input: [
        {
          ...carrier,
          tools: [{ type: 'namespace', name: 'x', tools: [{ type: 'image_generation' }] }],
        },
        ...rest,
      ],
    },
    { ...lite, input: [{ ...carrier, role: 'user' }, ...rest] },
    { ...lite, input: [{ type: 'additional_tools', tools: 'web_search' }, ...rest] },
    // Only a valid additional_tools item, by its exact type, may carry tools.
    { ...lite, input: [{ ...carrier, type: 'Additional_tools' }, ...rest] },
    {
      ...lite,
      input: [
        carrier,
        { type: 'tool_search_output', call_id: 'c1', tools: [{ type: 'web_search' }] },
        ...rest,
      ],
    },
    {
      ...lite,
      input: [carrier, { ...rest[1], tools: [{ type: 'function', name: 'x' }] }, ...rest],
    },
    { ...lite, reasoning: { effort: 'low', context: 'current_turn_and_more' } },
  ]) {
    const refused = await f.call(body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 200));
    assert.deepEqual(await refused.json(), { error: 'invalid_payload' });
  }
  assert.equal(f.upstream.length, 2);
});

test('an incomplete terminal is forwarded and logged with only a safe reason', async (t) => {
  const f = await fixture(t);
  const privateReason = 'secret URL https://private.example/token';
  const frame = `event: response.incomplete\ndata: ${JSON.stringify({
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: privateReason },
      usage: { input_tokens: 80, output_tokens: 30 },
    },
  })}\n\n`;
  f.respond(frame);
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `event: response.created\ndata: {}\n\n${frame}`);
  const terminal = f.logs
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'codex_relay_terminal');
  assert.deepEqual(
    (({ event, model, status, incompleteReason }) => ({ event, model, status, incompleteReason }))(
      terminal,
    ),
    {
      event: 'codex_relay_terminal',
      model: 'gpt-6-luna',
      status: 'incomplete',
      incompleteReason: 'other',
    },
  );
  assert.equal(typeof terminal.elapsedMs, 'number');
  assert.ok(!f.logs.join('').includes(privateReason));
  assert.match(f.logs.join(''), /"event":"codex_relay_usage"/);
  f.respond(frame.replace(privateReason, 'max_output_tokens'));
  assert.match(await (await f.call()).text(), /response\.incomplete/);
  assert.ok(f.logs.some((line) => line.includes('"incompleteReason":"max_output_tokens"')));
});

test('closing after response.completed settles usage without a relay failure', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.afterCompleted(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const cut = new AbortController();
  const response = await f.call(codex, undefined, cut.signal);
  const reader = response.body!.getReader();
  let body = '';
  while (!body.includes('response.completed')) {
    const next = await reader.read();
    assert.equal(next.done, false);
    body += new TextDecoder().decode(next.value);
  }
  cut.abort();
  release();
  const deadline = Date.now() + 5000;
  while ((await f.spent()) !== 110 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 110);
  assert.doesNotMatch(f.logs.join(''), /"event":"codex_relay_failure"/);
});

test('only Codex-shaped calls pass: no stored, background or chained response, and no hosted tool', async (t) => {
  const f = await fixture(t);
  const { include: _include, ...withoutInclude } = codex;
  for (const body of [
    { ...codex, store: true },
    { ...codex, stream: false },
    { ...codex, background: true },
    { ...codex, previous_response_id: 'resp_1' },
    { ...codex, conversation: 'conv_1' },
    { ...codex, service_tier: 'priority' },
    { ...codex, metadata: { a: 'b' } },
    { ...codex, max_output_tokens: 1_000_000 },
    { ...codex, model: 'gpt-6-astra' },
    { ...codex, tools: [{ type: 'web_search' }] },
    { ...codex, tools: [{ type: 'mcp', server_url: 'https://example.test' }] },
    {
      ...codex,
      tools: [{ type: 'namespace', name: 'x', tools: [{ type: 'code_interpreter' }] }],
    },
    { ...codex, tool_choice: { type: 'web_search' } },
    { ...codex, include: ['file_search_call.results'] },
    // Nothing the provider would fetch or look up for the worker.
    ...[
      { type: 'input_file', file_url: 'https://attacker.test/big.pdf' },
      { type: 'input_file', file_id: 'file-abc' },
      { type: 'input_image', image_url: 'https://attacker.test/a.png' },
    ].map((part) => ({
      ...codex,
      input: [{ type: 'message', role: 'user', content: [part] }],
    })),
    { ...codex, input: [{ type: 'item_reference', id: 'msg_abc' }] },
    {
      ...codex,
      tools: [
        {
          type: 'function',
          name: 'f',
          parameters: { type: 'object', $ref: 'https://attacker.test/schema.json' },
        },
      ],
    },
    // Fleet's one rule, as Pi's relay refuses it: no URL, URI or data string in a schema.
    ...[
      { type: 'object', properties: { a: { type: 'string', default: 'https://attacker.test' } } },
      { type: 'object', properties: { a: { type: 'string', description: 'see data:x' } } },
      { type: 'object', properties: { a: { type: 'string', contentMediaType: 'image/png' } } },
      { type: 'object', uri: 'x' },
    ].map((parameters) => ({
      ...codex,
      tools: [
        {
          type: 'namespace',
          name: 'mcp__merv',
          tools: [{ type: 'function', name: 'task_get', parameters }],
        },
      ],
    })),
  ]) {
    const response = await f.call(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 200));
    assert.deepEqual(await response.json(), { error: 'invalid_payload' });
  }
  assert.equal((await f.call(withoutInclude)).status, 200);
  // An MCP tool's schema names its dialect, and may have a field called url.
  const merv = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { url: { type: 'string' }, projectId: { type: 'string' } },
  };
  const named = { ...codex, tools: [{ type: 'function', name: 'paper_cite', parameters: merv }] };
  assert.equal((await f.call(named)).status, 200);
  assert.equal(f.upstream.length, 2);
});

test('one call in flight per session, and a session that ends stops its stream', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => (release = resolve)));
  const first = await f.call();
  assert.equal(first.status, 200);
  const second = await f.call();
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: 'relay_busy' });
  f.revoke();
  // The relay reads the session again about every 3 s while it streams.
  assert.match(await first.text(), /relay_interrupted/);
  release();
  assert.equal((await f.call()).status, 401);
});

test('a call is charged at its most before it goes out and settled when it finishes; the day refuses what would pass the ceiling', async (t) => {
  // What one call may cost at most: its request's tokens and the output cap.
  const most = Math.ceil(JSON.stringify(codexPayload(codex, grant)).length / 4) + 65_536;
  const f = await fixture(t, most + 50);
  assert.equal((await f.call()).status, 200);
  const deadline = Date.now() + 5000;
  while ((await f.spent()) !== 110 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 110);
  // Another call could cost more than the 50 tokens left under the ceiling.
  const refused = await f.call();
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: 'fleet_model_ceiling' });
  assert.match(f.logs.join(''), /"event":"codex_relay_ceiling"/);
  assert.deepEqual(
    (({ blocked, blockReason, lastRefusedTokens, remaining }) => ({
      blocked,
      blockReason,
      lastRefusedTokens,
      remaining,
    }))(await modelBudgetStatus(f.state, grant.person, most + 50)),
    {
      blocked: true,
      blockReason: 'last_refused_reservation_unaffordable',
      lastRefusedTokens: most,
      remaining: most - 60,
    },
  );
  assert.equal((await modelBudgetStatus(f.state, 'another-person', most + 50)).blocked, false);
  // A restart keeps the day's total: a fresh relay on the same database refuses too.
  assert.equal((await f.call(codex, await f.start())).status, 403);
  assert.equal(f.upstream.length, 1);
});

test('a call settles to the day it was charged to, even past midnight', async (t) => {
  const f = await fixture(t);
  const relay = codexModelRelay(f.state, {
    providerKey: () => key,
    dailyTokensPerPerson: 1_000_000,
    authorize: async () => grant,
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T23:59:59.500Z') });
  const charge = await relay.reserve!(grant, codexPayload(codex, grant)!);
  assert.equal(charge.day, '2026-09-28');
  t.mock.timers.tick(1_000);
  await relay.onUsage!(
    {
      event: 'codex_relay_usage',
      model: grant.model,
      inputTokens: 80,
      cachedTokens: 0,
      outputTokens: 30,
      reasoningTokens: 0,
    },
    grant,
    charge,
  );
  t.mock.timers.reset();
  const days = await f.state.read((sql) =>
    sql.all<{ day: string; tokens: number | string }>(
      'SELECT day, tokens FROM fleet_model_usage WHERE person=?',
      grant.person,
    ),
  );
  assert.deepEqual(
    days.map(({ day, tokens }) => ({ day, tokens: Number(tokens) })),
    [{ day: '2026-09-28', tokens: 110 }],
  );
});

test('a call cut off before it finishes keeps its charge, and calls in flight count against the day', async (t) => {
  const most = Math.ceil(JSON.stringify(codexPayload(codex, grant)).length / 4) + 65_536;
  const f = await fixture(t, 2 * most - 1);
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => (release = resolve)));
  const cut = new AbortController();
  const response = await f.call(codex, undefined, cut.signal);
  assert.equal(response.status, 200);
  await response.body!.getReader().read();
  // While the first call is out, a second (from a fresh relay, so no lane is shared) cannot
  // also take the day: both at their most would pass the ceiling.
  assert.equal((await f.call(codex, await f.start())).status, 403);
  // Cut off before any usage arrives, the call keeps what it was charged.
  cut.abort();
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await f.spent(), most);
});

test('five calls the provider answers with 500 cost nothing, and an outage answers 503', async (t) => {
  const f = await fixture(t);
  f.upstreamStatus(500);
  for (let call = 0; call < 5; call++) assert.equal((await f.call()).status, 502);
  const deadline = Date.now() + 5000;
  while (
    f.logs.filter((line) => line.includes('"refund":true')).length < 5 &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 0);
  assert.equal(f.upstream.length, 5);
  f.down(true);
  const unavailable = await f.call();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'relay_unavailable' });
  f.down(false);
  f.revoke();
  assert.equal((await f.call()).status, 401);
});

test('a call the provider fails reaches Codex as the provider’s own frame and is refunded', async (t) => {
  // Audit 11: a context overflow reached Codex as an untyped relay frame, so Codex retried five
  // more times and never compacted, and each attempt kept about 315K tokens of the day.
  const f = await fixture(t);
  const failed = `event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: {
      status: 'failed',
      error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window.' },
      usage: null,
    },
  })}\n\n`;
  f.respond(failed);
  // About 1 MB of history, as a session near Codex's compaction threshold sends.
  const long = {
    ...codex,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(1e6) }] },
    ],
  };
  const response = await f.call(long);
  assert.equal(response.status, 200);
  // Codex reads the failure's code (ContextWindowExceeded), so it compacts instead of retrying;
  // the provider's own words stay with the relay.
  assert.equal(
    await response.text(),
    `event: response.created\ndata: {}\n\nevent: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'context_length_exceeded', message: 'The model provider failed this call' },
      },
    })}\n\n`,
  );
  // The refund settles after its log line, beside the relay's own write of the failure.
  const deadline = Date.now() + 5000;
  while ((await f.spent()) !== 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 0);
  assert.equal(f.upstream.length, 1);
  assert.match(
    f.logs.join(''),
    /"event":"codex_relay_terminal","model":"gpt-6-luna","status":"failed"/,
  );
  // A failed call that reports its usage is settled to it instead.
  f.respond(failed.replace('"usage":null', '"usage":{"input_tokens":70,"output_tokens":5}'));
  await (await f.call()).text();
  const settled = Date.now() + 5000;
  while ((await f.spent()) !== 75 && Date.now() < settled)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 75);
});

test('a call the relay or its provider fails mid-visit, or a Main restart, is a relay fault of the visit', async (t) => {
  // Audit 15: a release or an outage cut a hosted Codex call, Codex exited 1, and the visit was
  // counted as the work's failure; five of them held the work for an operator.
  const f = await fixture(t);
  const since = new Date(Date.now() - 60_000).toISOString();
  const faulted = () => f.state.read((sql) => relayFaulted(sql, grant.id, since));
  const settle = async (want: boolean) => {
    const deadline = Date.now() + 5000;
    while ((await faulted()) !== want && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return await faulted();
  };
  // A refusal of the request itself is the visit's, not the relay's.
  f.upstreamStatus(400);
  assert.equal((await f.call()).status, 502);
  assert.equal(await settle(true), false);
  // A stream the provider cuts before its terminal frame.
  f.upstreamStatus(200);
  f.respond('');
  assert.equal((await f.call()).status, 200);
  assert.equal(await settle(true), true);
  // Main restarting cuts every visit that lived through it, whatever it was doing then.
  const other = (start: string) => f.state.read((sql) => relayFaulted(sql, 'session_other', start));
  assert.equal(await other(since), false);
  await markRelayStart(f.state);
  assert.equal(await other(since), true);
  assert.equal(await other(new Date(Date.now() + 1000).toISOString()), false);
  // Only lately: a fault past the window says nothing of a close now.
  assert.equal(
    await f.state.read((sql) => relayFaulted(sql, grant.id, since, Date.now() + 16 * 60_000)),
    false,
  );
});

test('a failure the provider streams of the request itself is the visit’s, not a relay fault', async (t) => {
  // Cycle 11 review: a context overflow (routine near compaction) or an invalid prompt that the
  // provider streamed was recorded as a relay fault, so the visit's own crash within the next
  // 15 minutes, and a request that fails the same way every visit, closed uncounted for ever.
  const f = await fixture(t);
  const since = new Date(Date.now() - 60_000).toISOString();
  const faulted = () => f.state.read((sql) => relayFaulted(sql, grant.id, since));
  const failed = (code: string) =>
    `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: { status: 'failed', error: { code, message: 'no' }, usage: null },
    })}\n\n`;
  for (const code of ['context_length_exceeded', 'invalid_prompt']) {
    f.respond(failed(code));
    await (await f.call()).text();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await faulted(), false);
  // The provider's own outage, streamed, is still the relay's side.
  f.respond(failed('server_error'));
  await (await f.call()).text();
  const deadline = Date.now() + 5000;
  while (!(await faulted()) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await faulted(), true);
});

test('the relay’s own interruption is a typed error frame', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => (release = resolve)));
  const response = await f.call();
  f.revoke();
  const text = await response.text();
  release();
  const frame = text.split('\n\n').filter(Boolean).at(-1)!;
  assert.match(frame, /^event: error\ndata: /);
  assert.deepEqual(JSON.parse(frame.slice(frame.indexOf('data: ') + 6)), {
    type: 'error',
    code: 'relay_interrupted',
    message: 'The model relay ended this call',
  });
});

test('only the reset or a raised limit lifts a refused wait: a smaller call that passes does not', async (t) => {
  // Audit 15 (robust-budget): any admitted call deleted the refusal, so the visit refused at the
  // ceiling was no longer judged to wait; its close counted as a failure and it was held after 5.
  const most = Math.ceil(JSON.stringify(codexPayload(codex, grant)).length / 4) + 65_536;
  const f = await fixture(t, most - 1);
  assert.equal((await f.call()).status, 403);
  assert.equal((await modelBudgetStatus(f.state, grant.person, most - 1)).lastRefusedTokens, most);
  const smaller = { model: grant.model, input: [], store: false, stream: true };
  assert.ok(Math.ceil(JSON.stringify(codexPayload(smaller, grant)).length / 4) + 65_536 < most);
  assert.equal((await f.call(smaller)).status, 200);
  const waiting = await modelBudgetStatus(f.state, grant.person, most - 1);
  assert.deepEqual([waiting.lastRefusedTokens, waiting.blocked], [most, true]);
  // A smaller refusal later the same day keeps the largest wait.
  const bigger = {
    ...smaller,
    input: [{ type: 'message', role: 'user', content: 'x'.repeat(4e5) }],
  };
  assert.equal((await f.call(bigger)).status, 403);
  const largest = (await modelBudgetStatus(f.state, grant.person, most - 1)).lastRefusedTokens!;
  assert.ok(largest > most);
  assert.equal((await f.call()).status, 403);
  assert.equal(
    (await modelBudgetStatus(f.state, grant.person, most - 1)).lastRefusedTokens,
    largest,
  );
  // A limit raised far enough lifts it.
  await setDailyTokens(f.state, grant.person, 10 * most);
  assert.equal((await modelBudgetStatus(f.state, grant.person, most - 1)).blocked, false);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO fleet_model_blockers(person,day,required_tokens) VALUES(?,?,?)',
      'yesterday-person',
      yesterday,
      most + 100_000,
    ),
  );
  assert.equal(
    (await modelBudgetStatus(f.state, 'yesterday-person', most)).lastRefusedTokens,
    null,
  );
  const fresh = await modelBudgetStatus(f.state, 'fresh-person', 65_536);
  assert.equal(fresh.blocked, true);
  assert.equal(fresh.blockReason, 'minimum_reservation_unaffordable');
  assert.equal(fresh.lastRefusedTokens, null);
});

test('the provider key never reaches a response or a log', async (t) => {
  const f = await fixture(t);
  const bodies = [
    await (await f.call()).text(),
    await (await f.call({ ...codex, store: true })).text(),
  ];
  f.revoke();
  bodies.push(await (await f.call()).text());
  const logs = f.logs.join('');
  assert.match(logs, /"event":"codex_relay_usage"/);
  for (const text of [...bodies, logs]) assert.equal(text.includes(key), false);
});

test('a person’s own daily limit governs their calls, above or below the deployment’s', async (t) => {
  const most = Math.ceil(JSON.stringify(codexPayload(codex, grant)).length / 4) + 65_536;
  const f = await fixture(t, most - 1);
  assert.equal((await f.call()).status, 403, 'the deployment’s limit is below one call');
  await setDailyTokens(f.state, grant.person, most + 50);
  assert.equal((await f.call()).status, 200);
  const deadline = Date.now() + 5000;
  while ((await f.spent()) !== 110 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    (({ tokens, usedToday }) => ({ tokens, usedToday }))(
      await modelBudgetStatus(f.state, grant.person, most - 1),
    ),
    { tokens: most + 50, usedToday: 110 },
  );
  await setDailyTokens(f.state, grant.person, 100);
  assert.equal((await f.call()).status, 403);
});

test('Fleet grants hosted Codex the model while its session is live or a minute past its handoff', () => {
  const bound = {
    sessionId: 'session_hosted',
    projectId: 'project_hosted',
    allocationId: 'flt_hosted',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const handedOffAt = '2026-10-06T00:00:00.000Z';
  const at = Date.parse(handedOffAt);
  assert.deepEqual(hostedGrant(bound, 'person_hosted', at), {
    id: 'session_hosted',
    projectId: 'project_hosted',
    allocationId: 'flt_hosted',
    person: 'person_hosted',
    model: hostedCodexPlatform.model,
    effort: hostedCodexPlatform.effort,
    expiresAt: bound.expiresAt,
  });
  // Codex writes its closing turn after the handoff: the runner's minute of grace.
  const closed = { ...bound, handedOffAt };
  assert.equal(hostedGrant(closed, 'person_hosted', at + 59_999).id, 'session_hosted');
  assert.throws(() => hostedGrant(closed, 'person_hosted', at + 60_000), {
    code: 'unauthorized',
  });
  // A machine Fleet rented for nobody grants nothing.
  assert.throws(() => hostedGrant(bound, undefined, at), { code: 'unauthorized' });
});
