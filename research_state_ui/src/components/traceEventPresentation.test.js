import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeTraceEvent, traceUpdatedLabel } from './traceEventPresentation.js';

test('claude stream-json assistant text and tool blocks summarize on one line', () => {
  const text = summarizeTraceEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Reading the plan\nnow' }] },
  });
  assert.deepEqual(text, { kind: 'assistant', text: 'Reading the plan now', tone: 'text' });
  const tool = summarizeTraceEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'workflow.status_and_next', input: { project_id: 'p' } }] },
  });
  assert.equal(tool.tone, 'tool');
  assert.match(tool.text, /⚙ workflow\.status_and_next/);
  const result = summarizeTraceEvent({ type: 'result', result: 'Done. Requested review.' });
  assert.deepEqual(result, { kind: 'result', text: 'Done. Requested review.', tone: 'final' });
});

test('codex --json items summarize by item type', () => {
  const command = summarizeTraceEvent({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'pytest -q', exit_code: 0 },
  });
  assert.equal(command.tone, 'tool');
  assert.equal(command.text, '$ pytest -q → exit 0');
  assert.equal(command.kind, 'item.completed · command_execution');
  const mcp = summarizeTraceEvent({
    type: 'item.completed',
    item: { type: 'mcp_tool_call', server: 'merv_agent_session', tool: 'artifact.submit', status: 'completed' },
  });
  assert.equal(mcp.text, '⚙ merv_agent_session.artifact.submit · completed');
  const done = summarizeTraceEvent({ type: 'turn.completed', usage: { input_tokens: 10 } });
  assert.equal(done.tone, 'final');
});

test('runner-side placeholders, errors, and unknown shapes never throw', () => {
  assert.equal(summarizeTraceEvent({ truncated: true, preview: 'x'.repeat(500) }).kind, 'large event');
  assert.equal(summarizeTraceEvent({ raw: 'plain stdout' }).text, 'plain stdout');
  assert.equal(summarizeTraceEvent({ type: 'error', error: { message: 'boom' } }).tone, 'error');
  assert.equal(summarizeTraceEvent(null).kind, 'event');
  const unknown = summarizeTraceEvent({ type: 'weird', foo: 'bar' });
  assert.equal(unknown.kind, 'weird');
  assert.equal(unknown.text, '{"foo":"bar"}');
  assert.ok(summarizeTraceEvent({ type: 'x', text: 'y'.repeat(1000) }).text.length <= 220);
});

test('updated labels are coarse and relative', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  assert.equal(traceUpdatedLabel(new Date(now - 12_000).toISOString(), now), '12s ago');
  assert.equal(traceUpdatedLabel(new Date(now - 5 * 60_000).toISOString(), now), '5m ago');
  assert.equal(traceUpdatedLabel('garbage', now), '');
});
