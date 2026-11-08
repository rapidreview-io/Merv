import assert from 'node:assert/strict';
import test from 'node:test';
import { overview, readTranscript } from '../packages/board/src/transcript.js';

const lines = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const base = { sessionId: 's', version: '2.1.300', isSidechain: false };
let n = 0;
const at = (minute: number) => `2026-10-31T10:${String(minute).padStart(2, '0')}:00.000Z`;
const person = (text: string, minute = 0) => ({
  ...base,
  type: 'user',
  uuid: `u${n++}`,
  timestamp: at(minute),
  message: { role: 'user', content: text },
});
const agent = (content: object[], minute = 0, more = {}) => ({
  ...base,
  type: 'assistant',
  uuid: `u${n++}`,
  timestamp: at(minute),
  message: { role: 'assistant', content },
  ...more,
});
const use = (id: string, name: string, input: object, minute = 0) =>
  agent([{ type: 'tool_use', id, name, input }], minute);
const result = (id: string, content: unknown, is_error = false, minute = 0) => ({
  ...base,
  type: 'user',
  uuid: `u${n++}`,
  timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
});

test('Claude Code: calls meet their results, a failure is what the file records, order holds', () => {
  const whole = readTranscript(
    lines(
      person('fix the test'),
      agent([{ type: 'thinking', thinking: '' }], 1),
      agent(
        [
          { type: 'thinking', thinking: 'maybe tax' },
          { type: 'text', text: 'Looking' },
        ],
        1,
      ),
      use('a', 'Bash', { command: 'npm test' }, 2),
      result('a', 'exit 1', true, 3),
      use('b', 'Bash', { command: 'npm test' }, 4),
      use('c', 'Edit', { file_path: 'src/round.js' }, 4),
      result('c', [{ type: 'text', text: 'ok' }, { type: 'image' }], false, 5),
      { type: 'attachment', uuid: 'x', timestamp: at(5) },
      { type: 'brand-new-thing', timestamp: at(5) },
      { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'y', timestamp: at(6) },
      { ...person('Summary so far', 6), isCompactSummary: true },
      result('gone', 'no call'),
    ),
  );
  assert.equal(whole.source, 'claude-code');
  assert.deepEqual(
    whole.steps.map((step) => step.kind),
    ['person', 'think', 'say', 'call', 'call', 'call', 'gap', 'gap'],
  );
  assert.deepEqual(
    whole.steps.map((step) => step.id),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const [, , , failed, open, edit] = whole.steps;
  assert.equal(failed!.failed, true);
  assert.equal(failed!.until, at(3));
  assert.equal(open!.output, undefined);
  assert.equal(open!.failed, undefined, 'no result is no failure');
  assert.equal(edit!.output, 'ok\n[image]');
  assert.deepEqual(edit!.files, ['src/round.js']);
  assert.equal(whole.gaps.hiddenReasoning, 1);
  assert.equal(whole.gaps.orphanResults, 1);
  assert.deepEqual(whole.gaps.notRead, { attachment: 1, 'brand-new-thing': 1 });
  const seen = overview(whole);
  assert.equal(seen.totals.failures, 1);
  assert.deepEqual(
    seen.along.marks.filter((mark) => mark.kind === 'retry').map(({ step, last }) => [step, last]),
    [[4, 5]],
  );
  assert.deepEqual(seen.gaps.callsWithoutResult.first, [5]);
  assert.deepEqual(seen.gaps.compactions, [7]);
  assert.deepEqual(seen.files.changed, [{ path: 'src/round.js', edits: 1 }]);
});

const rollout = (...rows: object[]) =>
  lines(
    { timestamp: at(0), type: 'session_meta', payload: { id: 'r', cli_version: '0.155.0' } },
    ...rows.map((payload) => ({ timestamp: at(1), type: 'response_item', payload })),
  );
const said = (role: string, text: string) => ({
  type: 'message',
  role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});

test('Codex: function and custom calls pair, exits count as failure, context is no person', () => {
  const whole = readTranscript(
    rollout(
      said('user', '<environment_context>x</environment_context>'),
      said('developer', 'rules'),
      said('user', 'fix it'),
      { type: 'reasoning', summary: [], encrypted_content: 'zzz' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'function_call', call_id: 'a', name: 'shell', arguments: '{"path":"src/a.js"}' },
      { type: 'function_call_output', call_id: 'a', output: 'Process exited with code 2\nno' },
      {
        type: 'custom_tool_call',
        call_id: 'b',
        name: 'apply_patch',
        input: '*** Update File: src/b.js\n',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'b',
        output: [{ type: 'input_text', text: 'ok' }],
      },
      said('assistant', 'done'),
    ) +
      '\n' +
      lines({ timestamp: at(2), type: 'compacted', payload: { message: '' } }),
  );
  assert.equal(whole.source, 'codex');
  assert.deepEqual(whole.versions, ['0.155.0']);
  assert.deepEqual(
    whole.steps.map((step) => step.kind),
    ['person', 'think', 'call', 'call', 'say', 'gap'],
  );
  assert.equal(whole.steps[2]!.failed, true);
  assert.deepEqual(whole.steps[2]!.files, ['src/a.js']);
  assert.equal(whole.steps[3]!.failed, undefined);
  assert.deepEqual(whole.steps[3]!.files, ['src/b.js']);
  assert.equal(whole.gaps.hiddenReasoning, 1);
});

test('what is no known session is refused by what it holds, never guessed', () => {
  assert.throws(() => readTranscript('hello\nworld'), /0 JSON lines and 2 others/);
  assert.throws(
    () => readTranscript(lines({ type: 'started' }, { type: 'started' }, { a: 1 })),
    /started ×2, \(no type\) ×1/,
  );
  assert.throws(() => readTranscript(''), /Not a session/);
  const secretType = lines({ type: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz '.repeat(3) });
  assert.doesNotMatch(
    (() => {
      try {
        readTranscript(secretType);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })(),
    /sk-ant/,
  );
  assert.throws(
    () =>
      readTranscript(lines(person('x'), { timestamp: at(0), type: 'session_meta', payload: {} })),
    /both Claude Code and Codex/,
  );
});

test('nothing unredacted leaves: steps, tools, files, and a stored transcript read again', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const whole = readTranscript(
    lines(
      person(`use ${secret}`),
      agent([{ type: 'thinking', thinking: secret }]),
      use('a', 'Bash', {
        command: `curl -H "Authorization: Bearer ${secret}"`,
        file_path: `/tmp/${secret}`,
      }),
      result('a', `echoed ${secret}`, true),
    ),
  );
  assert.ok(!JSON.stringify(whole).includes(secret));
  assert.ok(!JSON.stringify(overview(whole)).includes(secret));
  assert.ok(whole.redacted['api-key']! >= 4);
  // A value straddling the cut is gone before anything is cut.
  const long = readTranscript(lines(person(`${'x '.repeat(1400)}${secret}${' y'.repeat(1400)}`)));
  assert.ok(!JSON.stringify(long).includes('ghp_'));
  assert.ok(long.steps[0]!.elided! > 0);
  // A transcript stored by hand with a secret in it is redacted again on the way out.
  const dirty = JSON.parse(JSON.stringify(whole));
  dirty.steps[0].text = secret;
  assert.ok(!JSON.stringify(readTranscript(JSON.stringify(dirty))).includes(secret));
});
