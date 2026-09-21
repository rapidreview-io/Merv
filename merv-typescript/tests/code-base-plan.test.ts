import test from 'node:test';
import assert from 'node:assert/strict';
import { baseKey, members, planBase, type PlannedBase } from '../packages/code/src/base-plan.js';

const c = (letter: string) => letter.repeat(40);
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(c);
const record = (...commits: string[]): PlannedBase => ({
  key: baseKey(commits),
  members: members(commits),
  quarantined: false,
});

test('a key names the set and nothing about the order or the repeats it was given in', () => {
  assert.equal(baseKey([A, B]), baseKey([B, A, B]));
  assert.notEqual(baseKey([A, B]), baseKey([A, B, C]));
  assert.throws(() => baseKey(['abc123']), /full commit id/);
});

test('one commit needs no merge, and two are one merge of their own records', () => {
  assert.deepEqual(planBase([A], []), []);
  const [only, ...rest] = planBase([B, A], []);
  assert.deepEqual(rest, []);
  assert.deepEqual(only!.members, [A, B]);
  assert.deepEqual([only!.left, only!.right], [baseKey([A]), baseKey([B])].sort());
});

test('{A,B} then {A,B,C}: the reconciled pair is reused and only C is merged into it', () => {
  const steps = planBase([A, B, C], [record(A, B)]);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.members, [A, B, C]);
  assert.deepEqual(
    [steps[0]!.left, steps[0]!.right].sort(),
    [baseKey([A, B]), baseKey([C])].sort(),
  );
});

test('{A,B} and {B,C} merge directly: the shared commit is common history, not a third merge', () => {
  const steps = planBase([A, B, C], [record(A, B), record(B, C)]);
  assert.equal(steps.length, 1);
  assert.deepEqual(
    [steps[0]!.left, steps[0]!.right].sort(),
    [baseKey([A, B]), baseKey([B, C])].sort(),
  );
});

test('every union on the way is a record of its own, and an existing one is not planned again', () => {
  const fresh = planBase([A, B, C, D], []);
  assert.deepEqual(
    fresh.map((step) => step.members.length),
    [2, 3, 4],
  );
  for (const step of fresh) assert.equal(step.key, baseKey(step.members));
  // With the triple already written, only the last join remains.
  const later = planBase(
    [A, B, C, D],
    [record(fresh[1]!.members[0]!, ...fresh[1]!.members.slice(1))],
  );
  assert.deepEqual(
    later.map((step) => step.members.length),
    [4],
  );
});

test('two askers choose alike whatever order the records are read in, and the lower key wins a tie', () => {
  const records = [record(A, B), record(C, D), record(A, C)];
  const one = planBase([A, B, C, D], records);
  const other = planBase([D, C, B, A], [...records].reverse());
  assert.deepEqual(one, other);
  const pairs = [baseKey([A, B]), baseKey([C, D]), baseKey([A, C])].sort();
  assert.ok([one[0]!.left, one[0]!.right].includes(pairs[0]!), 'the lowest key leads');
});

test('a quarantined record is never built on, and a record that is not inside the set is ignored', () => {
  const bad = { ...record(A, B), quarantined: true };
  const steps = planBase([A, B, C], [bad, record(A, D)]);
  assert.deepEqual(
    steps.map((step) => step.members.length),
    [2, 3],
  );
  assert.ok(steps.every((step) => step.left !== bad.key && step.right !== bad.key));
});
