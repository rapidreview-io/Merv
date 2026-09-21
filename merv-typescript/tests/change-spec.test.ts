import test from 'node:test';
import assert from 'node:assert/strict';
import { MervError } from '@merv/contracts';
import { ordered } from '@merv/contracts';
import { parseChangeSpec } from '../packages/reflections/src/change-spec.js';
import type {
  ChangeSpec,
  ChangeSpecExperiment,
  ChangeSpecTask,
  WorkItem,
} from '../packages/reflections/src/types.js';

const task = (key: string, dependsOn: string[] = []): ChangeSpecTask => ({
  key,
  kind: 'task',
  title: `Task ${key}`,
  goal: 'Establish the measurement the experiment needs.',
  checks: ['The measurement is recorded'],
  dependsOn,
  rationale: 'The methods lens found the measurement missing.',
});
const experiment = (key: string, dependsOn: string[] = []): ChangeSpecExperiment => ({
  key,
  kind: 'experiment',
  name: `exp-${key}`,
  question: 'Does the effect survive the control?',
  details: '',

  dependsOn,
  rationale: 'The evidence lens found the control missing.',
});
const plan = (patch: Partial<ChangeSpec> = {}): ChangeSpec => ({
  version: 1,
  changes: 'Narrow the scope to the controlled setting.',
  next: { decision: 'continue', name: 'Second wave', rationale: 'The control is cheap.' },
  items: [task('measure'), experiment('control', ['measure']), task('report', ['control'])],
  carriedOver: [],
  rejected: [{ title: 'Scale up first', reason: 'No evidence yet that the effect is real.' }],
  ...patch,
});
const refused = (value: unknown, pattern: RegExp) =>
  assert.throws(
    () => parseChangeSpec(typeof value === 'string' ? value : JSON.stringify(value)),
    (error: unknown) =>
      error instanceof MervError &&
      error.code === 'invalid_change_spec' &&
      error.status === 400 &&
      pattern.test(error.message),
  );

test('a valid change specification parses to the plan it states', () => {
  assert.deepEqual(parseChangeSpec(JSON.stringify(plan())), plan());
  const stop = plan({
    next: { decision: 'stop', reason: 'goal_met', rationale: 'The claim is settled.' },
    items: [],
    rejected: [],
  });
  assert.deepEqual(parseChangeSpec(JSON.stringify(stop)), stop);
  const carried = plan({
    items: [],
    carriedOver: [{ workflowId: 'task_1', reason: 'Unfinished' }],
  });
  assert.deepEqual(parseChangeSpec(JSON.stringify(carried)), carried);
});

test('every field may reach its limit, and the whole stays small enough to review', () => {
  const widest: WorkItem[] = [
    {
      ...task('wide'),
      title: 't'.repeat(200),
      goal: 'g'.repeat(4000),
      checks: Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(500, 'c')),
      rationale: 'r'.repeat(1000),
    },
    {
      ...experiment('deep', ['wide']),
      name: 'n'.repeat(48),
      question: 'q'.repeat(4000),
      details: 'd'.repeat(4000),
      rationale: 'r'.repeat(1000),
    },
  ];
  assert.deepEqual(
    parseChangeSpec(JSON.stringify(plan({ changes: 'c'.repeat(8000), items: widest }))).items,
    widest,
  );
  refused(plan({ items: [{ ...task('wide'), goal: 'g'.repeat(4001) }] }), /items\.0\.goal/);
  refused(plan({ items: [{ ...task('wide'), rationale: 'r'.repeat(1001) }] }), /rationale/);
  refused(plan({ changes: 'c'.repeat(8001) }), /changes/);
  refused(JSON.stringify(plan()) + ' '.repeat(64_000), /64000 bytes/);
});

test('a malformed, extended or wrongly versioned change specification is refused by field', () => {
  refused('{not json', /valid JSON/);
  refused({ ...plan(), extra: true }, /extra|input/i);
  refused({ ...plan(), version: 2 }, /version/);
  refused(plan({ items: [{ ...task('a'), type: 'task.work' } as ChangeSpecTask] }), /items\.0/);
  refused(plan({ items: [{ ...task('A') }] }), /items\.0\.key/);
  refused(plan({ items: [{ ...task('a'), title: 'two\nlines' }] }), /items\.0\.title/);
  refused(plan({ items: [{ ...experiment('a'), name: 'no spaces' }] }), /items\.0\.name/);
  refused(plan({ items: Array.from({ length: 13 }, (_, i) => task(`t${i}`)) }), /items/);
});

test('the item graph must be local, acyclic and feasible-first', () => {
  refused(plan({ items: [task('a'), task('a')] }), /a occurs more than once/);
  refused(plan({ items: [task('a', ['missing'])] }), /unknown key missing/);
  refused(plan({ items: [task('a', ['a'])] }), /depends on itself/);
  refused(plan({ items: [task('a', ['b']), task('b', ['a'])] }), /cycle/);
  refused(plan({ items: [task('a', ['b', 'b']), task('b')] }), /repeats a dependency/);
  refused(plan({ items: [experiment('a'), experiment('b', ['a'])] }), /only on tasks/);
  refused(
    plan({ items: [experiment('a'), { ...experiment('b'), name: 'EXP-A' }] }),
    /more than once/,
  );
  refused(
    plan({ items: Array.from({ length: 8 }, (_, i) => experiment(`e${i}`)) }),
    /at most 7 experiments/,
  );
  refused(plan({ items: [{ ...task('a'), checks: ['Same', 'Same'] }] }), /repeats a check/);
  // Tasks folds case and runs of whitespace when it compares checks, so the plan must too.
  refused(
    plan({ items: [{ ...task('a'), checks: ['Tests pass', 'tests \t pass'] }] }),
    /repeats a check/,
  );
});

test('the decision agrees with the work it carries', () => {
  const stop = { decision: 'stop', reason: 'needs_owner', rationale: 'Budget.' } as const;
  refused(plan({ next: stop }), /stop decision/);
  refused(
    plan({ next: stop, items: [], carriedOver: [{ workflowId: 'task_1', reason: 'Open' }] }),
    /stop decision/,
  );
  refused(plan({ items: [] }), /continue decision/);
  refused(
    plan({
      carriedOver: [
        { workflowId: 'task_1', reason: 'Open' },
        { workflowId: 'task_1', reason: 'Again' },
      ],
    }),
    /more than once/,
  );
});

test('items are ordered prerequisites first, otherwise as listed', () => {
  const items = [task('last', ['mid']), task('first'), experiment('mid', ['first']), task('free')];
  assert.deepEqual(
    ordered(items)!.map((item) => item.key),
    ['first', 'mid', 'last', 'free'],
  );
  assert.equal(ordered([task('a', ['b']), task('b', ['a'])]), undefined);
});
