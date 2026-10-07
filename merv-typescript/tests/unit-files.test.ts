/**
 * A unit's Artifacts tab reads its files in two statements, however many visits made them: the
 * files its record names, and the newest its sessions made, in one bounded list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { UNIT_MADE_LIMIT, unitFiles } from '@merv/reviews/unit-history';
import { experimentFileIds } from '../packages/experiments/src/running.js';

test('a unit made by forty visits lists what they made in one bounded read', async () => {
  const visits = 40;
  const evidence = Array.from({ length: visits }, (_, i) => ({
    artifactId: `seed_${i}`,
    role: 'result',
    path: `seed${i}.json`,
    figureIds: [],
    sessionId: `ses_${i}`,
  }));
  const named = experimentFileIds({ evidence, submissions: [] } as never, []);
  assert.equal(named.sessions.length, visits);
  const lists: { sessions?: readonly string[]; limit?: number }[] = [];
  const artifacts = {
    find: async () => new Map(),
    list: async (_: unknown, query: { sessions?: readonly string[]; limit?: number }) => {
      lists.push(query);
      return Array.from({ length: query.limit ?? 0 }, (_, i) => ({ id: `a_${i}` }));
    },
  };
  const { made } = await unitFiles(artifacts as never, {} as never, named, {} as never);
  assert.equal(lists.length, 1, 'one list for every session');
  assert.deepEqual(lists[0], { sessions: named.sessions, limit: UNIT_MADE_LIMIT });
  assert.equal(made.length, UNIT_MADE_LIMIT, 'bounded in all');
  // A unit no session made anything for lists nothing.
  lists.length = 0;
  await unitFiles(artifacts as never, {} as never, { ids: [], sessions: [] }, {} as never);
  assert.equal(lists.length, 0);
});
