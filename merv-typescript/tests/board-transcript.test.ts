import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  NotSession,
  overview,
  readTranscript,
  redact,
  stepsOf,
} from '../packages/board/src/transcript.js';

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
    seen.along.marks
      .filter((mark) => mark.kind === 'retry')
      .map(({ step, until }) => [step, until]),
    [[4, 5]],
  );
  assert.deepEqual(seen.gaps.callsWithoutResult.first, [5]);
  assert.deepEqual(seen.gaps.compactions, [7]);
  assert.deepEqual(seen.files.changed, [{ path: 'src/round.js', edits: 1 }]);
});

test('Claude Code: a resumed file repeats lines once, a sub-agent keeps its lane, reminders are no person', () => {
  const said = person('hello');
  const whole = readTranscript(
    lines(said, said, person('<system-reminder>be good</system-reminder>'), {
      ...person('the brief'),
      isSidechain: true,
      agentId: 'agent1',
    }),
  );
  assert.deepEqual(
    whole.steps.map(({ kind, lane }) => [kind, lane]),
    [
      ['person', 'main'],
      ['say', 'agent1'],
    ],
  );
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

test('Codex: a failed item before its output marks the open call', () => {
  const whole = readTranscript(
    lines(
      { timestamp: at(0), type: 'session_meta', payload: { cli_version: '0.164' } },
      {
        timestamp: at(1),
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'a', name: 'exec', input: 'x' },
      },
      {
        timestamp: at(1),
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'CommandExecution', exit_code: 1, status: 'failed' },
        },
      },
      {
        timestamp: at(1),
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'a', output: 'see' },
      },
    ),
  );
  assert.equal(whole.steps[0]!.failed, true);
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

test('a path is not a format: the same bytes read the same wherever they lay', () => {
  // readTranscript takes no name at all, which is the whole of this test.
  assert.equal(readTranscript.length, 1);
});

const SECRETS = {
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx': 'api-key',
  AKIAIOSFODNN7EXAMPLE: 'api-key',
  ghp_abcdefghijklmnopqrstuvwxyz0123456789: 'api-key',
  'xoxb-1234567890-abcdefghij': 'api-key',
  mk_abcdefghijklmnop1234: 'api-key',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh': 'jwt',
  'Bearer abcdefghijklmnop1234': 'authorization',
  'password=hunter2hunter2': 'named-secret',
  '"api_key": "abcdef123456"': 'named-secret',
  'postgres://admin:s3cretpw@db.example.com/x': 'url-password',
  A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0: 'long-token',
  'someone@example.com': 'email',
  '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----': 'private-key',
} as const;

test('secret-shaped values go, by kind; ordinary text and git hashes stay', () => {
  for (const [secret, kind] of Object.entries(SECRETS)) {
    const tally = {};
    const out = redact(`before ${secret} after`, tally);
    assert.ok(out.includes(`[redacted:${kind}]`), `${kind}: ${out}`);
    assert.ok(!out.includes(secret), kind);
    assert.ok(out.startsWith('before') && out.endsWith('after'));
    assert.ok((tally as Record<string, number>)[kind]! >= 1);
  }
  const plain =
    'commit 4afdb7a45e8d1f0c2b3a49586d7e6f1a2b3c4d5e fixed src/views/board-canvas.tsx: the token budget ran out, password reset flow';
  assert.equal(redact(plain), plain);
  assert.equal(
    redact('const password = process.env.PASSWORD'),
    'const password = process.env.PASSWORD',
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

test('review findings stay fixed', () => {
  // A quoted password with spaces, whole.
  assert.equal(
    redact('{"password":"my secret password"}'),
    '{"password":"[redacted:named-secret]"}',
  );
  // A token as a line type never reaches the overview.
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const typed = readTranscript(lines(person('x'), { type: token }));
  assert.ok(!JSON.stringify(overview(typed)).includes(token));
  // A stored transcript's extra fields are dropped.
  const held = JSON.parse(JSON.stringify(typed));
  held.steps[0].extra = token;
  assert.ok(!JSON.stringify(readTranscript(JSON.stringify(held))).includes(token));
  // A recognised session with odd content is read, not refused.
  assert.equal(
    readTranscript(lines(person('a'), { ...person('b'), message: { role: 'user', content: null } }))
      .steps.length,
    1,
  );
  // A business log with a payload is no Codex session.
  assert.throws(
    () => readTranscript(lines({ type: 'event_msg', payload: { message: 'log' } }, { a: 1 })),
    NotSession,
  );
  // Which of two open calls failed is not guessed.
  const call = (id: string) => ({
    timestamp: at(1),
    type: 'response_item',
    payload: { type: 'function_call', call_id: id, name: id, arguments: '{}' },
  });
  const done = (id: string) => ({
    timestamp: at(1),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: 'ok' },
  });
  const fail = (id: string) => ({
    timestamp: at(1),
    type: 'event_msg',
    payload: { type: 'item_completed', item: { id, status: 'failed' } },
  });
  const two = readTranscript(lines(call('a'), call('b'), fail('a'), done('a'), done('b')));
  assert.deepEqual(
    two.steps.map((step) => step.failed),
    [true, undefined],
  );
  assert.equal(
    readTranscript(lines(call('a'), call('b'), fail('x'), done('a'), done('b'))).steps.some(
      (step) => step.failed,
    ),
    false,
  );
  // An output that quotes someone else's exit is no failure.
  const quoted = {
    timestamp: at(1),
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'a',
      output: 'Process exited with code 0\nexample: Exit code: 1',
    },
  };
  assert.equal(readTranscript(lines(call('a'), quoted)).steps[0]!.failed, undefined);
  // A failed edit changed nothing.
  const edit = readTranscript(
    lines(use('e', 'Edit', { file_path: 'a.ts' }), result('e', 'denied', true)),
  );
  assert.deepEqual(overview(edit).files.changed, []);
  // Bytes, not characters, bound what is kept.
  const wide = lines(...Array.from({ length: 1400 }, () => person('漢'.repeat(4000))));
  assert.ok(
    new TextEncoder().encode(JSON.stringify(readTranscript(wide))).length <= 15 * 1024 * 1024,
  );
});

test('a long run stays bounded: overview, phases and pages of steps', () => {
  const rows: object[] = [];
  for (let at_ = 0; at_ < 5000; at_++) {
    if (at_ % 50 === 0) rows.push(person(`ask ${at_}`, at_ % 60));
    rows.push(use(`t${at_}`, 'Bash', { command: `cmd ${at_}` }, at_ % 60));
    rows.push(result(`t${at_}`, 'o'.repeat(20_000), at_ % 97 === 0, at_ % 60));
  }
  const whole = readTranscript(lines(...rows));
  const seen = overview(whole);
  assert.ok(seen.phases.length <= 24);
  assert.ok(JSON.stringify(seen).length < 20_000, `${JSON.stringify(seen).length}`);
  assert.equal(seen.along.marks.filter((mark) => mark.kind === 'failure').length, 30);
  assert.ok(seen.totals.failures > 30);
  assert.ok(JSON.stringify(whole).length < 16 * 1024 * 1024);
  const page = stepsOf(whole, 1, 5000);
  assert.ok(JSON.stringify(page).length < 40_000);
  assert.equal(page.next, page.steps.length + 1);
  assert.deepEqual(stepsOf(whole, 9_000, 9_010).steps, []);
  // A step past its page's room still comes alone and whole, so no read returns nothing.
  const alone = stepsOf(whole, 3, 3).steps[0] as { id: number; line?: number };
  assert.equal(alone.id, 3);
  assert.ok(alone.line);
  assert.ok(JSON.stringify(stepsOf(whole, 1, 5000)).length < 15_000);
});

test('the overview draws the run along time, every mark at its place on the line', () => {
  const at = (hour: string) => ({
    ...person(`said at ${hour}`),
    timestamp: `2026-10-31T${hour}:00:00.000Z`,
  });
  const { along } = overview(readTranscript(lines(at('10'), at('11'), at('20'))));
  assert.match(along.pace!, /^M\d+ \d+( L\d+ \d+){47}$/);
  assert.deepEqual(
    along.marks.filter((mark) => mark.kind === 'person').map((mark) => mark.x),
    [0, 120, 1200],
  );
  const hole = along.marks.find((mark) => mark.kind === 'pause')!;
  assert.deepEqual([hole.x, hole.until, hole.minutes], [0, 120, 60]);
});

test('a line stamped out of order makes one pause, not two', () => {
  const stamped = (minute: string) => ({
    ...person('x'),
    timestamp: `2026-10-31T${minute}:00.000Z`,
  });
  const pauses = overview(
    readTranscript(lines(stamped('11:00'), stamped('16:00'), stamped('11:50'), stamped('16:01'))),
  ).along.marks.filter((mark) => mark.kind === 'pause');
  assert.deepEqual(
    pauses.map(({ step, minutes, x, until }) => [step, minutes, x, until]),
    [[1, 300, 0, 1196]],
  );
});

test('missing times stay missing and are counted, never invented', () => {
  const { timestamp: _gone, ...bare } = person('no time');
  const whole = readTranscript(lines(bare, person('then', 5)));
  assert.equal(whole.steps[0]!.at, undefined);
  assert.equal(overview(whole).time.stepsWithoutTime, 1);
});

test('Board stays spin-out ready: the transcript code imports nothing, and only State and Scope are injected', () => {
  const source = readFileSync('packages/board/src/transcript.ts', 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  const service = readFileSync('packages/board/src/index.ts', 'utf8');
  assert.match(service, /inject: \['state', 'scope'\]/);
  for (const file of ['index', 'tools', 'transcript'])
    assert.doesNotMatch(
      readFileSync(`packages/board/src/${file}.ts`, 'utf8'),
      /@merv\/(sessions|runner|workflows)/,
    );
});
