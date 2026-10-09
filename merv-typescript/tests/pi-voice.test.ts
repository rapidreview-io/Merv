import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MervError } from '@merv/contracts';
import type { PiCommand } from '@merv/pi/models';
import { openVoice, voiceHistory, voiceInstructions } from '../packages/pi/src/voice.js';

const config = {
  url: 'https://voice.example/v1/live/sessions',
  model: 'gpt-live-1',
  voice: 'marin',
};
const turn = (user: string, answer: string) =>
  ({
    messages: [
      { role: 'user', text: user },
      { role: 'assistant', text: answer },
    ],
  }) as PiCommand;

test('the voice session is opened on Main with the key, in client delegation, and only the answer goes back', async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  let sent: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(
      JSON.stringify({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } }),
      { status: 201 },
    );
  }) as typeof fetch;
  const opened = await openVoice(
    config,
    'sk-test',
    'offer',
    voiceHistory([turn('Hi', 'Hello')]),
    'p1',
  );
  assert.deepEqual(opened, { sessionId: 'live_1', sdp: 'answer' });
  assert.equal(sent!.url, config.url);
  const headers = sent!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(headers['openai-safety-identifier'], 'p1');
  const body = JSON.parse(String(sent!.init.body));
  assert.equal(body.session.model, 'gpt-live-1');
  assert.deepEqual(body.session.delegation, { type: 'client' }, 'Pi does the work, not the voice');
  assert.equal(body.session.store, false);
  assert.equal(body.session.audio.output.voice, 'marin');
  assert.equal(body.session.instructions, voiceInstructions);
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'offer' });
  assert.deepEqual(
    body.session.input.map((item: { role: string; content: { type: string; text: string }[] }) => [
      item.role,
      item.content[0]!.type,
      item.content[0]!.text,
    ]),
    [
      ['user', 'input_text', 'Hi'],
      ['assistant', 'output_text', 'Hello'],
    ],
  );
  assert.ok(!JSON.stringify(opened).includes('sk-test'), 'the key never leaves Main');
});

test('a refused or unreachable voice session is one clear error', async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { message: 'Offer did not have an audio media section.' } }),
      {
        status: 400,
      },
    )) as typeof fetch;
  await assert.rejects(openVoice(config, 'k', 'bad', [], 'p'), (error: unknown) => {
    assert.ok(error instanceof MervError);
    assert.equal(error.code, 'pi_voice_unavailable');
    assert.match(error.message, /audio media section/);
    return true;
  });
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(openVoice(config, 'k', 'o', [], 'p'), /could not be reached/);
});

test('the seed history is the last turns, each cut short, and never more than the session takes', () => {
  const long = 'x'.repeat(5_000);
  const history = voiceHistory(Array.from({ length: 20 }, (_, n) => turn(`q${n}`, long)));
  assert.ok(history.length <= 12);
  assert.ok(history.every((item) => item.content[0]!.text.length <= 1_801));
  assert.ok(history.reduce((sum, item) => sum + item.content[0]!.text.length, 0) <= 24_000);
  assert.equal(history.at(-1)!.role, 'assistant', 'it ends where the conversation ends');
});
