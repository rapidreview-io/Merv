import assert from 'node:assert/strict';
import test from 'node:test';
import './ui-render.js';

const { sayable } = await import('../packages/ui/web/views/pi-voice.js');

test('an answer written for the screen is said as words: no markup, tables or code', () => {
  assert.equal(
    sayable('## Status\n\n**Work.** Two tasks run. See [the map](/work).\n\n- one\n- two'),
    'Status Work. Two tasks run. See the map. one two',
  );
  assert.equal(
    sayable('Here it is.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\nDone.'),
    'Here it is. Done. (Details are on screen.)',
  );
  const long = sayable(`${'A sentence that goes on. '.repeat(120)}`);
  assert.ok(long.length <= 1_800, 'one append is at most 500 tokens');
  assert.ok(long.endsWith('.'), 'cut at the end of a sentence');
});
