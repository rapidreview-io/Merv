/**
 * A record's trajectory, as the page lays it out (packages/ui/web/trajectory.ts): the blocks
 * Sessions kept, folded into moments of a few kinds; the sessions on an axis that folds the
 * waits between them; a stage's run of sessions as one span; and what a part of it comes to,
 * said as the chips say it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_TIMELINE, mergeEvents } from '../packages/ui/web/agent-stream.js';
import {
  BREAK_PX,
  axisOf,
  chipText,
  keywords,
  kindOf,
  momentsOf,
  programOf,
  selected,
  stageSpans,
  tally,
  type Lane,
} from '../packages/ui/web/trajectory.js';

const T0 = Date.UTC(2026, 9, 1, 9, 0);
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
const call = (
  seq: number,
  id: string,
  name: string,
  input: object,
  output: string,
  error = false,
) => [
  {
    seq,
    at: at(seq),
    event: { kind: 'tool_call' as const, id, name, input: JSON.stringify(input) },
  },
  {
    seq: seq + 1,
    at: at(seq + 1),
    event: { kind: 'tool_result' as const, id, output, ...(error && { error }) },
  },
];

test('blocks fold into moments of the right kinds, with a topic, a duration and a failure', () => {
  const events = [
    {
      seq: 1,
      at: at(1),
      event: { kind: 'thinking' as const, id: 't', delta: 'First **look**', done: true },
    },
    ...call(
      2,
      'a',
      'WebSearch',
      { query: 'grokking weight decay modular arithmetic' },
      'ten results',
    ),
    ...call(4, 'b', 'Read', { file_path: '/work/src/train.py' }, 'def train():'),
    ...call(
      6,
      'c',
      'Edit',
      { file_path: '/work/src/train.py', old_string: 'a', new_string: 'b' },
      'ok',
    ),
    ...call(8, 'd', 'Bash', { command: 'cd /work && python train.py --decay 0.3' }, 'exit 1', true),
    ...call(10, 'e', 'sandboxes.run_command', { command: 'python sweep.py' }, '{"jobId":"j1"}'),
    ...call(12, 'f', 'experiment.attach', { experimentId: 'exp_1', role: 'plan' }, '{"ok":true}'),
    {
      seq: 14,
      at: at(14),
      event: { kind: 'text' as const, id: 's', delta: 'Done: the step falls.', done: true },
    },
    {
      seq: 15,
      at: at(15),
      event: { kind: 'status' as const, id: 'u', text: 'Turn · 1200 tokens' },
    },
    {
      seq: 16,
      at: at(16),
      event: { kind: 'status' as const, id: 'v', text: 'Error · Model metadata not found' },
    },
    {
      seq: 17,
      at: at(17),
      event: { kind: 'status' as const, id: 'w', text: 'Turn failed · rate limited' },
    },
  ];
  const { blocks } = mergeEvents(NO_TIMELINE, events);
  const moments = momentsOf('session_1', blocks, T0 + 100_000);
  assert.deepEqual(
    moments.map((moment) => [moment.kind, moment.topic ?? null, moment.failed ?? null]),
    [
      ['think', null, null],
      ['search', 'grokking weight decay modular arithmetic', null],
      ['read', 'train.py', null],
      ['edit', 'train.py', null],
      ['run', 'python', 'exit 1'],
      ['job', 'sandboxes.run_command', null],
      ['merv', 'experiment.attach', null],
      ['say', null, null],
      ['say', null, 'rate limited'],
    ],
  );
  // A call's duration is its result's time less its call's; a quiet status is no moment.
  assert.equal(moments[1]!.until - moments[1]!.at, 1000);
  assert.equal(moments[0]!.summary, 'First look');
  assert.equal(moments[7]!.label, 'Said');
});

test('a transcript with one stamp for everything is placed by order along its visit', () => {
  const { blocks } = mergeEvents(NO_TIMELINE, [
    { seq: 1, at: at(0), event: { kind: 'text', id: 'a', delta: 'One', done: true } },
    {
      seq: 2,
      at: at(0),
      event: { kind: 'tool_call', id: 'b', name: 'Read', input: '{"file_path":"x"}' },
    },
    { seq: 3, at: at(0), event: { kind: 'tool_result', id: 'b', output: 'y' } },
    { seq: 4, at: at(0), event: { kind: 'text', id: 'c', delta: 'Three', done: true } },
  ]);
  const placed = momentsOf('s', blocks, T0, { start: T0, end: T0 + 40_000 });
  assert.deepEqual(
    placed.map((moment) => [moment.at - T0, moment.ordered]),
    [
      [10_000, true],
      [20_000, true],
      [30_000, true],
    ],
  );
  // With times of their own, nothing moves.
  const timed = momentsOf(
    's',
    mergeEvents(NO_TIMELINE, [
      { seq: 1, at: at(1), event: { kind: 'text', id: 'a', delta: 'One', done: true } },
      { seq: 2, at: at(5), event: { kind: 'text', id: 'c', delta: 'Two', done: true } },
    ]).blocks,
    T0,
    { start: T0, end: T0 + 40_000 },
  );
  assert.deepEqual(
    timed.map((moment) => [moment.at - T0, moment.ordered ?? false]),
    [
      [1000, false],
      [5000, false],
    ],
  );
});

test('a call still open on a live visit runs to now; a kind follows the tool, not its harness', () => {
  const { blocks } = mergeEvents(NO_TIMELINE, [
    {
      seq: 1,
      at: at(0),
      event: { kind: 'tool_call', id: 'x', name: 'exec_command', input: '{"cmd":"pytest -q"}' },
    },
  ]);
  const [open] = momentsOf('s', blocks, T0 + 30_000);
  assert.equal(open!.until, T0 + 30_000);
  assert.equal(open!.kind, 'run');
  assert.equal(open!.topic, 'pytest');
  assert.equal(kindOf('mcp__other__thing', 'other · thing'), 'merv');
  assert.equal(kindOf('sandboxes.workflow_get', 'sandboxes · workflow_get'), 'merv');
  assert.equal(kindOf('sandbox.jobs_submit', 'sandbox · jobs_submit'), 'job');
  assert.equal(kindOf('sandboxes.job_run', 'sandboxes · job_run'), 'job');
  assert.equal(kindOf('sandboxes.job_status', 'sandboxes · job_status'), 'merv');
  assert.equal(kindOf('sandbox.terminal', 'sandbox · terminal'), 'run');
  assert.equal(kindOf('web.search', 'web · search'), 'search');
  assert.equal(programOf('FOO=1 sudo /usr/bin/python3 -m pytest'), 'python3');
});

test('the axis shares the width by active time and folds a long wait to one break', () => {
  const minute = 60_000;
  const axis = axisOf(
    [
      { start: T0, end: T0 + 10 * minute },
      { start: T0 + 5 * minute, end: T0 + 20 * minute },
      { start: T0 + 120 * minute, end: T0 + 140 * minute },
    ],
    400 + BREAK_PX,
  );
  assert.equal(axis.segments.length, 2);
  assert.equal(axis.breaks.length, 1);
  assert.equal(axis.breaks[0]!.ms, 100 * minute);
  // 40 active minutes over 400 px: 10 px a minute, the fold between.
  assert.equal(Math.round(axis.x(T0 + 20 * minute)), 200);
  assert.equal(Math.round(axis.x(T0 + 120 * minute)), 200 + BREAK_PX);
  assert.equal(Math.round(axis.x(T0 + 140 * minute)), 400 + BREAK_PX);
  // A moment in the fold stands in it; the inverse lands back on active time.
  assert.equal(Math.round(axis.x(T0 + 60 * minute)), 200 + BREAK_PX / 2);
  assert.equal(Math.round(axis.t(100) - T0), 10 * minute);
  assert.ok(axis.ticks.length >= 2 && axis.ticks.every((tick) => /\d/.test(tick.label)));
  // No width, no crash.
  assert.equal(axisOf([], 0).segments.length, 0);
});

const lane = (
  sessionId: string,
  stage: string,
  start: number,
  end: number,
  role = 'producer',
): Lane => ({
  sessionId,
  threadId: `thread_${sessionId}`,
  role,
  stage,
  start,
  end,
  live: false,
  failed: false,
  moments: [],
});

test('a run of one stage is one span, and a return to it another', () => {
  const spans = stageSpans([
    lane('c', 'planned', T0 + 3000, T0 + 4000),
    lane('a', 'planned', T0, T0 + 1000),
    lane('b', 'design_review', T0 + 2000, T0 + 2500),
    lane('d', 'design_review', T0 + 5000, T0 + 6000, 'reviewer'),
    lane('e', 'running', T0 + 7000, T0 + 9000),
  ]);
  assert.deepEqual(
    spans.map((span) => [span.state, span.lanes.map((item) => item.sessionId)]),
    [
      ['planned', ['a']],
      ['design_review', ['b']],
      ['planned', ['c']],
      ['design_review', ['d']],
      ['running', ['e']],
    ],
  );
  const moment = {
    ...momentsOf('d', [], T0)[0]!,
    sessionId: 'd',
    at: T0 + 5500,
    until: T0 + 5500,
  } as never;
  assert.equal(
    selected({ sessionId: 'd', at: T0 + 5500, until: T0 + 5500 } as never, { stage: 3 }, spans),
    true,
  );
  assert.equal(
    selected({ sessionId: 'd', at: T0 + 5500, until: T0 + 5500 } as never, { stage: 1 }, spans),
    false,
  );
  assert.equal(
    selected(
      { sessionId: 'd', at: T0 + 5500, until: T0 + 5600 } as never,
      { range: [T0 + 5550, T0 + 9000] },
      spans,
    ),
    true,
  );
  assert.equal(
    selected({ sessionId: 'd', at: T0 + 5500, until: T0 + 5500 } as never, { session: 'e' }, spans),
    false,
  );
  void moment;
});

test('the chips count what was done and name what it kept coming back to', () => {
  const m = (kind: string, topic?: string, failed?: string) =>
    ({
      key: topic ?? kind,
      sessionId: 's',
      kind,
      at: T0,
      until: T0,
      label: '',
      summary: '',
      topic,
      failed,
    }) as never;
  const tallies = tally([
    m('search', 'grokking under weight decay'),
    m('search', 'weight decay grokking step'),
    m('search', 'modular arithmetic transformer'),
    m('edit', 'train.py'),
    m('edit', 'train.py'),
    m('edit', 'model.py'),
    m('read', 'train.py'),
    m('run', 'python', 'exit 1'),
    m('run', 'python'),
    m('run', 'pytest'),
    m('merv', 'experiment.attach'),
    m('merv', 'artifact.create'),
    m('merv', 'experiment.transition'),
    m('job', 'sandboxes.run_command'),
    m('say'),
    m('think'),
    m('think'),
  ]);
  assert.deepEqual(tallies.map(chipText), [
    '1 message',
    '2 thoughts',
    '3 web searches · decay, grokking, weight',
    '1 read · train.py',
    '3 edits · 2 files',
    '3 commands · python, pytest · 1 failed',
    '1 job · sandboxes.run_command',
    '3 Merv calls · experiment, artifact',
  ]);
  assert.deepEqual(keywords(['The effect of weight decay', 'weight decay vs. dropout']), [
    ['decay', 2],
    ['weight', 2],
    ['dropout', 1],
  ]);
});
