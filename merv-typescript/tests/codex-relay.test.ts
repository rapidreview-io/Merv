import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MervError } from '@merv/contracts';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';
import { ModelRelay } from '../packages/api/src/model-relay.js';
import { codexModelRelay } from '../packages/fleet/src/codex-relay.js';
import { openState } from './fixtures/state.js';

const key = 'private-provider-key';
const bearer = `ms_${'b'.repeat(43)}`;
const grant: ManagedModelGrant = {
  id: 'session_hosted',
  projectId: 'project_hosted',
  person: 'person_hosted',
  model: 'gpt-6-luna',
  effort: 'medium',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
/** The body Codex 0.155.0-alpha.2 sent through the hosted provider, trimmed: its MCP server's
 *  tools arrive as one namespace. */
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
const completed = (input: number, output: number) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: input, output_tokens: output } },
  })}\n\n`;

async function fixture(t: TestContext, dailyTokensPerPerson = 1_000_000) {
  const state = await openState();
  let live = true;
  const upstream: { body: Record<string, any>; authorization: string }[] = [];
  let hold: Promise<void> | undefined;
  const logs: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => logs.push(String(chunk)) > 0) as never;
  t.after(() => void (process.stderr.write = write));
  const sessions = {
    async managedModelGrant(presented: string) {
      if (!live || ![bearer, grant.id].includes(presented))
        throw new MervError('unauthorized', 'No live managed session', 401);
      return grant;
    },
  } as unknown as Sessions;
  const start = async () => {
    const relay = new ModelRelay({
      ...(await codexModelRelay(sessions, state, { providerKey: () => key, dailyTokensPerPerson })),
      fetchImpl: async (_url, init) => {
        upstream.push({
          body: JSON.parse(String(init!.body)),
          authorization: new Headers(init!.headers).get('authorization')!,
        });
        const held = hold;
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n'));
              await held;
              controller.enqueue(new TextEncoder().encode(completed(80, 30)));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const server = createServer((req, res) => void relay.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      relay.close();
      server.close();
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/codex-model/responses`;
  };
  const url = await start();
  const call = (body: unknown = codex, to = url) =>
    fetch(to, {
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
    call,
    start,
    upstream,
    logs,
    spent,
    revoke: () => void (live = false),
    hold: (until: Promise<void>) => void (hold = until),
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
  ]) {
    const response = await f.call(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 200));
    assert.deepEqual(await response.json(), { error: 'invalid_payload' });
  }
  assert.equal((await f.call(withoutInclude)).status, 200);
  assert.equal(f.upstream.length, 1);
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
  // The relay reads the session again about once a second while it streams.
  assert.match(await first.text(), /relay_interrupted/);
  release();
  assert.equal((await f.call()).status, 401);
});

test('a person’s daily tokens, kept in the database, stop further calls at the ceiling', async (t) => {
  const f = await fixture(t, 100);
  assert.equal((await f.call()).status, 200);
  const deadline = Date.now() + 5000;
  while ((await f.spent()) < 110 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await f.spent(), 110);
  assert.equal((await f.call()).status, 403);
  // A restart keeps the day's total: a fresh relay on the same database refuses too.
  assert.equal((await f.call(codex, await f.start())).status, 403);
  assert.equal(f.upstream.length, 1);
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
