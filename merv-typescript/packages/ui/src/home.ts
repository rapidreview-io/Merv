import { mapAsync, type Caller, type Json } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import type { UiRow } from './types.js';

/** What the home pages draw, and the read-only tool that owns each part. */
const PARTS: [string, string][] = [
  ['project', 'project.get'],
  ['actors', 'actor.list'],
  ['claims', 'claim.list'],
  ['experiments', 'experiment.list'],
  ['tasks', 'task.list'],
  ['reviews', 'review.list'],
  ['cycles', 'research.list'],
  ['files', 'artifact.list'],
  ['posts', 'feed.list'],
  // Without an instance, this one answers for every workflow in the project at once.
  ['workflows', 'workflow.status_and_next'],
];
/** The rows whose own read the page draws, and what each of them is asked for. */
const READS: [string, string, Record<string, unknown>?][] = [
  ['reflections', 'reflections'],
  ['paper', 'paper'],
  ['sessions', 'sessions'],
  ['connections', 'connections'],
  ['archive', 'legacy-history', { action: 'summary' }],
];

/**
 * Who is asking, and where: the shell answers both with its rows, so opening the
 * app is one read rather than three.
 */
export async function identityOf(tools: Tools, caller: Caller): Promise<Record<string, Json>> {
  return {
    actor: (await tools.call('actor.whoami', caller, {})) as Json,
    project: (await tools.call('project.get', caller, {})) as Json,
  };
}

/**
 * Everything the home pages draw, in one answer. Read-only tools run in one snapshot
 * scope, so this is a single consistent read of the project rather than twenty round
 * trips at a browser's latency. A part whose plugin is not loaded, or whose answer this
 * caller may not read, is null: the page draws what it has and never fails whole.
 */
export async function homeRead(
  tools: Tools,
  rows: UiRow[],
  read: (caller: Caller, rowId: string, params?: Record<string, unknown>) => Promise<Json>,
  caller: Caller,
): Promise<Json> {
  const answer = async (fn: () => Promise<unknown>): Promise<Json> => {
    try {
      return ((await fn()) ?? null) as Json;
    } catch {
      return null;
    }
  };
  const parts = await mapAsync(PARTS, async ([key, tool]) => [
    key,
    await answer(async () => await tools.call(tool, caller, {})),
  ]);
  const reads = await mapAsync(READS, async ([key, kind, params]) => {
    const row = rows.find((item) => item.view.kind === kind && item.read);
    return [key, row ? await answer(async () => await read(caller, row.id, params)) : null];
  });
  return Object.fromEntries([...parts, ...reads]) as Json;
}
