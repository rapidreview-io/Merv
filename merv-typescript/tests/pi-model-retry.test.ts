import assert from 'node:assert/strict';
import test from 'node:test';
import { retryTransient } from '../packages/pi/src/model-retry.js';

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const stream = (...frames: string[]) =>
  new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
const opened = frame({ type: 'response.created', response: { id: 'r' } });
const failed = (code: string) => frame({ type: 'error', code, message: 'x' });
const answer = frame({ type: 'response.output_text.delta', delta: 'Hi' });
const sleep = async () => {};

test('a provider turning a call away before it answers is asked again, up to three times', async () => {
  let calls = 0;
  const replies = [failed('server_is_overloaded'), failed('rate_limit_exceeded'), answer];
  const response = await retryTransient(async () => stream(opened, replies[calls++]!), null, {
    sleep,
  });
  assert.equal(calls, 3);
  assert.match(await response.text(), /output_text\.delta/);
});

test('after three retries the failure reaches the agent as it came', async () => {
  let calls = 0;
  const response = await retryTransient(
    async () => (calls++, stream(opened, failed('server_is_overloaded'))),
    null,
    { sleep },
  );
  assert.equal(calls, 4);
  assert.match(await response.text(), /server_is_overloaded/);
});

test('refusals, failures after the answer began and HTTP errors are never retried', async () => {
  for (const reply of [
    () => stream(opened, failed('context_length_exceeded')),
    () => stream(opened, answer, failed('server_is_overloaded')),
    () => new Response('{"error":{"code":"upstream_failed"}}', { status: 502 }),
  ]) {
    let calls = 0;
    const response = await retryTransient(async () => (calls++, reply()), null, { sleep });
    assert.equal(calls, 1);
    await response.text();
  }
});

test('the waits grow 2 s, 4 s, 8 s', async () => {
  const waits: number[] = [];
  await retryTransient(async () => stream(opened, failed('server_error')), null, {
    sleep: async (ms) => void waits.push(ms),
  });
  assert.deepEqual(waits, [2000, 4000, 8000]);
});
