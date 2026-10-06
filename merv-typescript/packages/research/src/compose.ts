import {
  clip,
  mapAsync,
  now,
  type Artifact,
  type Caller,
  type Transaction,
  type WorkflowDependency,
} from '@merv/contracts';
import type { BindingChecks, Capabilities, ResearchService } from './index.js';
import type { ResearchDigest, ResearchRecord } from './types.js';

// A cycle's digest: what it decided, composed from records once it is over and kept as an
// artifact. ResearchService (index.ts) runs these as its own methods.
/**
 * A digest rides inside a 24000-character reflection context, behind the assignment and any
 * rework feedback. At this bound it still fits beside them instead of being omitted whole.
 */
const DIGEST_MAX_CHARS = 12000;
const DIGEST_TEXT_CHARS = 300;
const DIGEST_LIST_LIMIT = 100;

/**
 * The cycle's digest, composed and stored if it has none. Completing and ending a cycle must
 * never wait on it, so there a missing capability leaves the column empty and whoever names
 * the cycle as a predecessor composes it late; `required` refuses instead.
 *
 * Two creators naming one undigested predecessor may both compose. The guarded update keeps
 * one: writers are serialised, so the second waits for the first and then matches no row or
 * fails its transaction. Either way the stored digest is re-read and returned, and the
 * loser's artifact stays unreferenced.
 */
export async function digested(
  this: ResearchService,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
  checks: BindingChecks,
  options: { late: boolean; required: boolean },
): Promise<Artifact | null> {
  if (record.digest) return record.digest;
  const children = this.children(record);
  const selected = (await this.workflows.prerequisites(caller, [record.id], tx))
    .get(record.id)!
    .filter((item) => !children.includes(item.id));
  const needed: (keyof Capabilities)[] = [
    'artifacts',
    ...(selected.some((item) => item.workflow === 'task') ? (['tasks'] as const) : []),
    ...(selected.some((item) => item.workflow === 'experiment') ? (['experiments'] as const) : []),
    ...(record.reflectionId ? (['reflections'] as const) : []),
    ...(record.integrations.length ? (['code'] as const) : []),
  ];
  if (!options.required && needed.some((name) => !this.bindings[name])) return null;
  const content = JSON.stringify(
    await this.compose(caller, record, selected, tx, checks, options.late),
  );
  const artifact = await this.use('artifacts', checks, (service) =>
    service.create(
      caller,
      {
        title: `Cycle digest: ${clip(record.name, 180)}`,
        content,
        mediaType: 'application/json',
      },
      tx,
    ),
  );
  await tx.run(
    'UPDATE research_cycles SET digest=? WHERE id=? AND digest IS NULL',
    JSON.stringify(artifact),
    record.id,
  );
  const stored = JSON.parse((await this.row(caller, record.id, tx)).digest!) as Artifact;
  if (stored.id === artifact.id)
    await this.event(
      caller,
      'digested',
      record.id,
      { artifactId: artifact.id, late: options.late },
      tx,
    );
  return stored;
}

/** Derived from records only, and naming no actor: see ResearchDigest. */
export async function compose(
  this: ResearchService,
  caller: Caller,
  record: ResearchRecord,
  selected: WorkflowDependency[],
  tx: Transaction,
  checks: BindingChecks,
  late: boolean,
): Promise<ResearchDigest> {
  const text = (value: string) => clip(value, DIGEST_TEXT_CHARS);
  const ref = ({ id, title, hash }: Artifact) => ({ id, title: text(title), hash });
  // A cycle ended while reflecting has a child with nothing approved in it.
  const reflection = record.reflectionId
    ? await this.use('reflections', checks, async (service) =>
        (await service.get(caller, record.reflectionId!, tx)).workflow.state === 'approved'
          ? await service.approved(caller, record.reflectionId!, tx)
          : null,
      )
    : null;
  const taskId = record.integrations.at(-1);
  const integration = taskId
    ? {
        taskId,
        publication:
          (await this.use('code', checks, (code) => code.unit(caller, taskId, tx))).publication
            ?.state ?? null,
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
    await mapAsync(ids('experiment'), (id) =>
      this.use('experiments', checks, (service) => service.get(caller, id, tx)),
    )
  ).sort(byCreated);
  const tasks = (
    await mapAsync(ids('task'), (id) =>
      this.use('tasks', checks, (service) => service.record(caller, id, tx)),
    )
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
    carriedOver: selected.filter((item) => !item.settled).map((item) => item.id),
    rejected: (reflection?.plan?.rejected ?? []).map((entry) => ({
      title: text(entry.title),
      reason: text(entry.reason),
    })),
  };
  const composedAt = now();
  let omitted = 0;
  for (const list of Object.values(lists)) omitted += list.splice(DIGEST_LIST_LIMIT).length;
  const reason = record.workflow.data.reason;
  const composed = (): ResearchDigest => ({
    formatVersion: 1,
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
    reflection: reflection && {
      id: reflection.id,
      reviewId: reflection.reviewId,
      approvedAt: reflection.approvedAt,
      report: ref(reflection.report),
      changeSpec: ref(reflection.changeSpec),
      // The decision is the one line of the plan every later wave needs; the items that
      // became work are records, which the successor's origin names.
      next: reflection.plan
        ? {
            decision: reflection.plan.next.decision,
            reason: reflection.plan.next.decision === 'stop' ? reflection.plan.next.reason : null,
            rationale: text(reflection.plan.next.rationale),
          }
        : null,
    },
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
