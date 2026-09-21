import { MervError } from '@merv/contracts';
import { MERGE_SETTINGS } from './merge-settings.js';
import type { ServerGit } from './git.js';

/**
 * The automatic merge of two accepted histories, made inside Code's own repository. It
 * runs no code of the repository: `merge-tree` needs no checkout, and the child sees no
 * hooks, drivers, filters, replacement objects or configuration but what Code wrote. A
 * clean result is only ever a base for somebody's work, never an accepted result.
 */

/** The one identity and moment every server-made merge carries, so a repeat is the same commit. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Merv',
  GIT_AUTHOR_EMAIL: 'merv@localhost',
  GIT_COMMITTER_NAME: 'Merv',
  GIT_COMMITTER_EMAIL: 'merv@localhost',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
  GIT_NO_REPLACE_OBJECTS: '1',
};
export const MERGE_ENGINE = 'merge-tree@1';
const DEADLINE_MS = 120_000;

export type BaseMergeResult =
  /** One side already holds the other: there is nothing to merge, and the descendant is the base. */
  | { outcome: 'contained'; commit: string }
  | { outcome: 'merged'; commit: string; tree: string }
  | { outcome: 'conflict'; paths: string[]; messages: string };

/**
 * Merges `right` into `left`. A conflict is an answer, not a failure: its paths and Git's
 * own words are kept for whoever resolves it. Anything else Git cannot do is thrown, and
 * is infrastructure's trouble rather than the repository's.
 */
export async function mergeBases(
  git: ServerGit,
  env: Record<string, string>,
  left: string,
  right: string,
  label: string,
  signal?: AbortSignal,
): Promise<BaseMergeResult> {
  const run = { env: { ...env, ...IDENTITY }, timeoutMs: DEADLINE_MS, signal };
  const holds = async (ancestor: string, descendant: string) =>
    (await git.run(['merge-base', '--is-ancestor', ancestor, descendant], run)).code === 0;
  if (left === right || (await holds(right, left))) return { outcome: 'contained', commit: left };
  if (await holds(left, right)) return { outcome: 'contained', commit: right };
  const merged = await git.run(
    [...MERGE_SETTINGS, 'merge-tree', '--write-tree', '--name-only', '--no-messages', left, right],
    run,
  );
  const [tree = '', ...paths] = merged.stdout.toString('utf8').split('\n').filter(Boolean);
  if (merged.code === 1) {
    const said = await git.run([...MERGE_SETTINGS, 'merge-tree', '--write-tree', left, right], run);
    return {
      outcome: 'conflict',
      paths: [...new Set(paths)].sort(),
      // What Git said stays whole up to a bound: it is evidence for the task that resolves it.
      messages: said.stdout.toString('utf8').split('\n\n').slice(1).join('\n\n').slice(0, 16_000),
    };
  }
  if (merged.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new MervError('code_merge_failed', 'Git could not merge the two histories', 503);
  const commit = (
    await git.ok(['commit-tree', tree, '-p', left, '-p', right, '-m', `Merge base ${label}`], run)
  )
    .toString('utf8')
    .trim();
  return { outcome: 'merged', commit, tree };
}
