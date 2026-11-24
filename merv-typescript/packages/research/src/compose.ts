import { clip, mapAsync, now, type Artifact, type Caller, type Transaction } from '@merv/contracts';
import type { WorkflowDependency } from '@merv/workflows/models';
import type { ResearchContext } from './index.js';
import type { ResearchDigest, ResearchRecord } from './types.js';

// A cycle's digest: what it did, composed from records once it is over and kept as an
// artifact. Each runs on ResearchService (index.ts) as its ResearchContext.
/** A digest stays small enough to read whole beside an assignment's other context. */
const DIGEST_MAX_CHARS = 12000;
const DIGEST_TEXT_CHARS = 300;
const DIGEST_LIST_LIMIT = 100;

/**
 * The cycle's digest, composed and stored if it has none; `late` when a successor composes it
 * after the cycle was over, as it does for a cycle that ended before digests existed.
 *
 * Two creators naming one undigested predecessor may both compose. The guarded update keeps
 * one: writers are serialised, so the second waits for the first and then matches no row or
 * fails its transaction. Either way the stored digest is re-read and returned, and the
 * loser's artifact stays unreferenced.
 */
export async function digested(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
  late: boolean,
): Promise<Artifact> {
  if (record.digest) return record.digest;
  const selected = (await ctx.workflows.prerequisites(caller, [record.id], tx))
    .get(record.id)!
    .filter((item) => !record.integrations.includes(item.id));
  const artifact = await ctx.providers.artifacts.create(
    caller,
    {
      title: `Cycle digest: ${clip(record.name, 180)}`,
      content: JSON.stringify(await compose(ctx, caller, record, selected, tx, late)),
      mediaType: 'application/json',
    },
    tx,
  );
  await tx.run(
    'UPDATE research_cycles SET digest=? WHERE id=? AND digest IS NULL',
    JSON.stringify(artifact),
    record.id,
  );
  const stored = JSON.parse((await ctx.row(caller, record.id, tx)).digest!) as Artifact;
  if (stored.id === artifact.id)
    await ctx.event(caller, 'digested', record.id, { artifactId: artifact.id, late }, tx);
  return stored;
}

/** Derived from records only, and naming no actor: see ResearchDigest. */
export async function compose(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  selected: WorkflowDependency[],
  tx: Transaction,
  late: boolean,
): Promise<ResearchDigest> {
  const { code } = ctx.providers;
  const text = (value: string) => clip(value, DIGEST_TEXT_CHARS);
  const taskId = record.integrations.at(-1);
  const integration = taskId
    ? {
        taskId,
        publication: (await code.unit(caller, taskId, tx)).publication?.state ?? null,
      }
    : null;
  // A cycle reads only its selected work, directly from the providers that own it.
  // Keep the existing record order so digest truncation remains stable.
  const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const ids = (workflow: string) => [
    ...new Set(selected.filter((item) => item.workflow === workflow).map((item) => item.id)),
  ];
  const experiments = (
    await mapAsync(ids('experiment'), (id) => ctx.providers.experiments.get(caller, id, tx))
  ).sort(byCreated);
  const tasks = (
    await mapAsync(ids('task'), (id) => ctx.providers.tasks.record(caller, id, tx))
  ).sort(byCreated);
  const lists = {
    experiments: experiments.map((entry) => ({
      id: entry.id,
      name: text(entry.name),
      state: entry.workflow.state,
      attempts: entry.attempts.length,
      submissions: entry.submissions.length,
      conclusion: entry.conclusion === null ? null : text(entry.conclusion),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: text(task.title),
      state: task.workflow.state,
    })),
    dropped: selected.filter((item) => item.failed).map((item) => item.id),
    carriedOver: selected.filter((item) => !item.terminal).map((item) => item.id),
  };
  const composedAt = now();
  let omitted = 0;
  for (const list of Object.values(lists)) omitted += list.splice(DIGEST_LIST_LIMIT).length;
  const reason = record.workflow.data.reason;
  const composed = (): ResearchDigest => ({
    formatVersion: 2,
    cycle: {
      id: record.id,
      name: text(record.name),
      outcome: record.workflow.state as ResearchDigest['cycle']['outcome'],
      reason: typeof reason === 'string' ? text(reason) : null,
      createdAt: record.createdAt,
      composedAt,
      late,
    },
    previousCycleId: record.previousCycleId,
    integration,
    ...lists,
    omitted,
  });
  // The bound is a promise to every later context, so entries go, longest list first, until
  // it holds; what is left out is counted, and the records themselves remain readable.
  let digest = composed();
  while (JSON.stringify(digest).length > DIGEST_MAX_CHARS) {
    const longest = Object.values(lists).reduce((a, b) => (b.length > a.length ? b : a));
    if (!longest.length) break;
    longest.pop();
    omitted++;
    digest = composed();
  }
  return digest;
}
