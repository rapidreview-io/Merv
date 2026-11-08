import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import { piAnthropicRelay, type PiRelayGrant } from '../packages/pi/src/relay.js';

const grant: PiRelayGrant = {
  id: 'grant-1',
  userId: 'user-1',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  commandId: 'command-1',
  runtimeId: 'runtime-1',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  model: 'claude-haiku-5-5',
  toolNames: ['read_notes'],
};
const config = piAnthropicRelay({
  models: [
    { id: 'gpt-6.1-sol', effort: 'medium' },
    { id: 'claude-haiku-5-5', effort: 'none' },
  ],
  providerKey: () => 'private-anthropic-key',
  authority: { authorize: async () => grant, validate: async () => {} },
});
const picture = Buffer.from('a picture').toString('base64');

/** The body pi-ai's Anthropic adapter sends for a turn shaped as the worker shapes it. */
async function workerBody(): Promise<Record<string, unknown>> {
  const model: Model<'anthropic-messages'> = {
    id: 'claude-haiku-5-5',
    name: 'claude-haiku-5-5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://merv.test/pi-model/anthropic',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 64_000,
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  };
  let body: Record<string, unknown> | undefined;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const context = normalizeContext({
    systemPrompt: 'You are Pi.',
    tools: [
      {
        name: 'read_notes',
        description: 'Read',
        parameters: { type: 'object', properties: { id: { type: 'string' } } } as never,
      },
    ],
    messages: [
      { role: 'user', content: 'What is on screen?', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Look first.', thinkingSignature: 'signed' },
          { type: 'toolCall', id: 'toolu_1', name: 'read_notes', arguments: { id: '1' } },
        ],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'toolu_1',
        toolName: 'read_notes',
        content: [
          { type: 'text', text: '{"seen":"a board"}' },
          { type: 'image', data: picture, mimeType: 'image/jpeg' },
        ],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  const events = streamSimple(model, context, {
    reasoning: 'low',
    apiKey: 'pir_token',
    headers: { 'anthropic-beta': '' },
    cacheRetention: 'short',
    maxRetries: 0,
    env: {},
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('', { status: 500 });
    },
  });
  for await (const _event of events);
  assert.ok(body, 'pi-ai sent a request');
  return body;
}

test('the relay refuses what a Claude turn never sends', async () => {
  const body = await workerBody();
  const refused = (change: (copy: Record<string, any>) => void) => {
    const copy = structuredClone(body) as Record<string, any>;
    change(copy);
    return config.payload(copy, grant) === null;
  };
  assert.ok(refused((copy) => (copy.model = 'claude-opus-5-5')));
  assert.ok(refused((copy) => copy.tools.push({ type: 'web_fetch_20260209', name: 'web_fetch' })));
  assert.ok(refused((copy) => (copy.tools[0].name = 'other_tool')));
  assert.ok(refused((copy) => (copy.mcp_servers = [{ type: 'url', url: 'https://x.test' }])));
  assert.ok(refused((copy) => (copy.tool_choice = { type: 'any' })));
  assert.ok(
    refused(
      (copy) =>
        copy.messages[0].content.push?.({
          type: 'image',
          source: { type: 'url', url: 'https://x.test/a.png' },
        }) ?? (copy.messages[0].content = [{ type: 'image', source: { type: 'url', url: 'x' } }]),
    ),
  );
  // Only Claude's catalog models: an OpenAI grant never reaches Anthropic.
  await assert.rejects(config.authority.validate({ ...grant, model: 'gpt-6.1-sol' }));
});

test('the relay reads Anthropic usage and ends at message_stop', async () => {
  const usages: unknown[] = [];
  const terminals: unknown[] = [];
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const calls: { url: string; headers: Headers }[] = [];
  const relay = new ModelRelay(
    {
      ...config,
      onUsage: (record) => void usages.push(record),
      onTerminal: (record) => void terminals.push(record),
    },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
      },
    },
  );
  const body = await workerBody();
  const { status, text } = await relayCall(relay, body);
  assert.equal(status, 200);
  assert.match(text, /message_stop/);
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0]!.headers.get('x-api-key'), 'private-anthropic-key');
  assert.equal(calls[0]!.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(calls[0]!.headers.get('authorization'), null);
  assert.deepEqual(usages, [
    {
      event: 'pi_relay_usage',
      model: 'claude-haiku-5-5',
      inputTokens: 105,
      cachedTokens: 90,
      cacheWriteTokens: 5,
      outputTokens: 42,
      reasoningTokens: 0,
    },
  ]);
  assert.equal((terminals[0] as { status: string }).status, 'completed');
});

/** One call through the relay's handler, as Main mounts it. */
async function relayCall(relay: { handle: ModelRelay<PiRelayGrant>['handle'] }, body: unknown) {
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const req = Object.assign(new PassThrough(), {
    url: '/pi-model/anthropic/v1/messages',
    method: 'POST',
    headers: { authorization: `Bearer pir_${'a'.repeat(43)}`, 'content-type': 'application/json' },
  });
  let status = 0;
  let text = '';
  const finished = new Promise<void>((resolve) => {
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      writeHead(code: number) {
        status = code;
        res.headersSent = true;
        return res;
      },
      write(chunk: string | Uint8Array, callback?: () => void) {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        callback?.();
        return true;
      },
      end(chunk?: string | Uint8Array) {
        if (chunk) res.write(chunk);
        if (!status) status = 200;
        res.writableEnded = true;
        resolve();
        return res;
      },
    });
    void relay.handle(req as never, res as never);
  });
  req.end(JSON.stringify(body));
  await finished;
  return { status, text };
}
