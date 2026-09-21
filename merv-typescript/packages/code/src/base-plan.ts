import { createHash } from 'node:crypto';

/**
 * The plan of a base: how the record for one set of accepted commits is built from two
 * records that already have names. It is pure, because the choice has to be the same
 * whichever waiter asks first, and because a plan is frozen the moment it is written: a
 * record made later never changes how an earlier one is built.
 */

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Full commit ids, once each, in the one order every caller agrees on. */
export const members = (commits: Iterable<string>): string[] => {
  const sorted = [...new Set(commits)].sort();
  for (const commit of sorted)
    if (!oid.test(commit)) throw new TypeError(`Not a full commit id: ${commit}`);
  return sorted;
};

/**
 * The name of a set of accepted commits. It names the set and nothing else: not the
 * repository, the runner, main, the check or the attempt, so every unit with the same
 * dependencies waits on, and then starts from, the same record.
 */
export const baseKey = (commits: Iterable<string>): string =>
  createHash('sha256')
    .update(JSON.stringify(members(commits)))
    .digest('hex');

/** A record the planner may build on: its set, and whether it may be used at all. */
export interface PlannedBase {
  key: string;
  members: string[];
  quarantined: boolean;
}
/** One pairwise merge: two records that exist, or are made by an earlier step, and their union. */
export interface PlanStep {
  key: string;
  members: string[];
  left: string;
  right: string;
}

/**
 * The steps that build `wanted` from what exists. The largest record inside the set leads,
 * then whichever record adds the most of what is still missing, a tie going to the lower
 * key so that two askers choose alike; a lone commit is its own record, which is what
 * guarantees an end. Every step joins exactly two records, and every union on the way is a
 * record of its own, so `{A,B}` is reconciled once and `{A,B,C}` is "C into the reconciled
 * A and B". An unresolved record is still built on — planning round a stuck one would send
 * the same conflict to people twice — and a quarantined one never is.
 */
export function planBase(wanted: Iterable<string>, existing: PlannedBase[]): PlanStep[] {
  const target = members(wanted);
  if (target.length < 2) return [];
  const inside = new Set(target);
  const usable = existing
    .filter(
      (record) =>
        !record.quarantined &&
        record.members.length < target.length &&
        record.members.every((commit) => inside.has(commit)),
    )
    .map((record) => ({ key: record.key, members: members(record.members) }));
  const named = new Map(usable.map((record) => [record.key, record]));
  // A lone commit always has a record, whether or not anybody wrote it down yet.
  for (const commit of target) {
    const key = baseKey([commit]);
    if (!named.has(key)) named.set(key, { key, members: [commit] });
  }
  const candidates = [...named.values()];
  const best = (covered: Set<string>) =>
    candidates
      .map((record) => ({
        record,
        gain: record.members.filter((commit) => !covered.has(commit)).length,
      }))
      .filter((item) => item.gain > 0)
      .sort(
        (left, right) =>
          right.gain - left.gain ||
          right.record.members.length - left.record.members.length ||
          left.record.key.localeCompare(right.record.key),
      )[0]?.record;

  const steps: PlanStep[] = [];
  let current = best(new Set())!;
  const covered = new Set(current.members);
  while (covered.size < target.length) {
    const next = best(covered)!;
    for (const commit of next.members) covered.add(commit);
    const union = members(covered);
    const key = baseKey(union);
    // The operands stand in key order, so the same two records always merge the same way round.
    const [left, right] = [current.key, next.key].sort();
    const made = existing.find((record) => record.key === key && !record.quarantined);
    if (!made) steps.push({ key, members: union, left: left!, right: right! });
    current = { key, members: union };
  }
  return steps;
}
