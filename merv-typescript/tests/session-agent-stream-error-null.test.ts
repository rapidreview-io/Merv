/**
 * Cycle 11 review: a call whose JSON answer carries `"error": null` did not fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { toolFailure, lineKind } = await import('@merv/sessions/agent-stream');

test('a JSON answer whose error field is null is not a failure', () => {
  const output = '{"id":"run_8f3a9c2e1d0b","status":"succeeded","error":null}';
  assert.equal(toolFailure({ output }), undefined);
  assert.equal(lineKind({ kind: 'tool', result: { output } }), 'tool');
});
