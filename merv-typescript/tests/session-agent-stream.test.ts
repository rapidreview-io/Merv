import assert from 'node:assert/strict';
import test from 'node:test';
import { plainLine, toolLine } from '@merv/sessions/agent-stream';

test('truncated tool arguments keep a useful summary at every JSON escape boundary', () => {
  const input = JSON.stringify({
    command: 'echo "quoted" C:\\path\n\u0001end',
    description: 'Run command',
  });
  for (let end = 1; end <= input.length; end++)
    assert.doesNotThrow(() => toolLine('shell', input.slice(0, end)), `cut at ${end}`);

  assert.equal(toolLine('shell', '{"command":"echo C:\\\\').summary, 'echo C:\\');
  assert.equal(toolLine('shell', '{"command":"echo \\u00').summary, 'echo \\u00');

  // The live feed cuts input at 400 characters, which can fall inside a JSON escape.
  for (const suffix of ['\\', '\u0001']) {
    const prefix = JSON.stringify({ ignored: '', command: 'echo ' }).length - 2;
    for (let end = 1; end <= JSON.stringify(suffix).length - 2; end++) {
      const input = JSON.stringify({
        ignored: 'x'.repeat(400 - prefix - end),
        command: `echo ${suffix}end`,
      });
      assert.ok(input.length > 400);
      assert.doesNotThrow(() => toolLine('shell', input.slice(0, 400)));
    }
  }
});

test('a summary cut short keeps whole characters', () => {
  assert.equal(plainLine(`${'x'.repeat(78)}😀 more`), `${'x'.repeat(78)}…`);
});
