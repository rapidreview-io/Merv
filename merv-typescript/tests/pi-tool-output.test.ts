import test from 'node:test';
import assert from 'node:assert/strict';
import { toolOutput } from '../packages/pi/src/fit.js';

const read = { cuts: true, free: false };

test('a look spends nothing and comes through after the budget is gone', () => {
  const spend = toolOutput(100);
  spend('x'.repeat(100), read);
  assert.deepEqual(spend('{"viewport":{}}', { cuts: true, free: true }), {
    shown: '{"viewport":{}}',
  });
  // And looks do not use up what a later read may spend.
  const fresh = toolOutput(10);
  fresh('y'.repeat(50), { cuts: true, free: true });
  assert.equal(fresh('z'.repeat(10), read).cut, undefined);
});

test('a read past the budget says plainly what is missing and what to do', () => {
  const spend = toolOutput(10);
  const { shown, cut } = spend('a'.repeat(30), read);
  assert.equal(cut!.text, 'a'.repeat(10));
  assert.match(shown, /limit for this answer reached: 20 of 30 bytes/);
  assert.match(shown, /tell the person what you could not read/);
  // The next read has nothing, and is told so rather than handed silence.
  assert.match(spend('b'.repeat(5), read).shown, /^\n\[Tool output limit/);
});

test('a write is never cut, and still spends', () => {
  const spend = toolOutput(10);
  const write = { cuts: false, free: false };
  assert.deepEqual(spend('r'.repeat(30), write), { shown: 'r'.repeat(30) });
  assert.ok(spend('s', read).cut);
});

test('a cut never leaves half a character', () => {
  const { cut } = toolOutput(4)('ééé', read);
  assert.equal(cut!.text, 'éé');
  assert.ok(!toolOutput(3)('ééé', read).cut!.text.includes('�'));
});
