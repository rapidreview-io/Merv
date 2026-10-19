import test from 'node:test';
import assert from 'node:assert/strict';
import { piTitle } from '../packages/pi/src/relay.js';
import { describeScreen, screenRequest } from '../packages/pi/src/screen.js';
import { piConfig } from '../packages/pi/src/schema.js';

test('titles and screen descriptions use the Pi provider and preserve usage', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const sent: { url: string; model: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    sent.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'A useful title' }] }],
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  }) as typeof fetch;
  const provider = {
    modelResponsesUrl: 'https://api.gmi-serving.com/v1/responses',
    modelIdPrefix: 'openai/',
  };
  const title = await piTitle(
    'test-key',
    {
      model: 'gpt-6-luna',
      store: false,
      max_output_tokens: 24,
      reasoning: { effort: 'none' },
      instructions: 'Title',
      input: 'Hello',
    },
    provider,
  );
  assert.equal(title.title, 'A useful title');
  assert.deepEqual(title.usage, { inputTokens: 3, outputTokens: 4 });
  await describeScreen(
    'test-key',
    screenRequest('gpt-6.1-sol', 'What?', Buffer.from('test'), '/ui'),
    provider,
  );
  assert.deepEqual(sent, [
    { url: provider.modelResponsesUrl, model: 'openai/gpt-6-luna' },
    { url: provider.modelResponsesUrl, model: 'openai/gpt-6.1-sol' },
  ]);
});

test('Pi rejects unsafe provider endpoints', () => {
  for (const modelResponsesUrl of [
    'http://example.com/responses',
    'https://user:password@example.com/responses',
    'https://example.com/responses?key=secret',
  ]) {
    const result = piConfig.safeParse({ modelResponsesUrl });
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(result.error.issues.some((issue) => issue.path[0] === 'modelResponsesUrl'));
  }
});
