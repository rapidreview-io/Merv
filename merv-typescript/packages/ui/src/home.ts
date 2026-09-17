import { type Caller, type Json } from '@merv/contracts';
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

/** A part whose tool is absent, or whose answer this caller may not read, is null. */
const answer = async (fn: () => Promise<unknown>): Promise<Json> => {
  try {
    return ((await fn()) ?? null) as Json;
  } catch {
    return null;
  }
};

/**
 * Who is asking, where, and the shape of every deployed program — the states a
 * record can stand in, which a list draws beside its state word. The shell answers
 * all of it with its rows, so opening the app is one read rather than three.
 */
export async function identityOf(tools: Tools, caller: Caller): Promise<Record<string, Json>> {
  const [actor, project, workflows] = await Promise.all([
    tools.call('actor.whoami', caller, {}),
    tools.call('project.get', caller, {}),
    answer(async () => await tools.call('workflow.catalog', caller, {})),
  ]);
  return { actor: actor as Json, project: project as Json, workflows: workflows ?? [] };
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
  // The parts are independent read-only tools, each in its own snapshot scope, so they
  // read in parallel; this tool is not itself scoped, or they would share one connection.
  const parts = await Promise.all(
    PARTS.map(async ([key, tool]) => [
      key,
      await answer(async () => await tools.call(tool, caller, {})),
    ]),
  );
  const reads = await Promise.all(
    READS.map(async ([key, kind, params]) => {
      const row = rows.find((item) => item.view.kind === kind && item.read);
      return [key, row ? await answer(async () => await read(caller, row.id, params)) : null];
    }),
  );
  return Object.fromEntries([...parts, ...reads]) as Json;
}
