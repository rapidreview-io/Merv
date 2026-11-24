import {
  check,
  childRequest,
  clip,
  MervError,
  now,
  type Caller,
  type Transaction,
} from '@merv/contracts';
import type { CodeAcceptedSince } from '@merv/code-work/models';
import type { ResearchContext, StoredRecord } from './index.js';
import { choiceSchema, createSchema, parse } from './input.js';
import { definition, type Stage } from './policy.js';
import type { ResearchRecord } from './types.js';
import { digested } from './compose.js';

// How a cycle moves: what naming a predecessor and opening a cycle require, what each stage
// must pass and which transition an advance makes, and the consolidation task it injects. Each
// runs on ResearchService (index.ts) as its ResearchContext.
/** The accepted units main does not hold, read outside the transaction that acts on them. */
export type Unpublished = Pick<CodeAcceptedSince, 'unitIds' | 'quarantined'>;
/** What an advance does from where the cycle stands; see `move`. */
export type Move = 'advance' | 'complete' | 'inject' | 'reinject';
export type Choice = ReturnType<typeof parse<typeof choiceSchema>>;
const integrationGoal =
  "Integrate this cycle's accepted work onto one branch. Account for every experiment in this cycle as kept, adapted or dropped, with reasons; a drop is a reverting commit visible in the diff. Main is part of your base; the branch you deliver is what reaches main.";
const integrationChecks = [
  'Every experiment in this cycle is accounted for as kept, adapted or dropped, with a reason each.',
  'The report names what was dropped and why.',
  'The delivered branch passes the checks the project defines.',
];

/**
 * What naming a predecessor requires: it is over, nothing follows it yet, and it has a digest.
 * A predecessor that ended before digests existed is digested here. Any writer may cause
 * that, not only the predecessor's owner or an admin: the digest is composed by the server
 * from records the caller can already read, it can be written once, and nothing the caller
 * supplies reaches it.
 */
export async function follow(
  ctx: ResearchContext,
  caller: Caller,
  previousCycleId: string,
  tx: Transaction,
): Promise<void> {
  const previous = await ctx.get(caller, previousCycleId, tx);
  check(
    definition.terminal.includes(previous.workflow.state),
    'previous_cycle_open',
    'The predecessor cycle is still open; complete or end it before starting its successor',
    409,
  );
  check(
    !previous.successorId,
    'previous_cycle_followed',
    `The predecessor cycle is already followed by ${previous.successorId}; follow that cycle instead, or read the chain with research.lineage`,
    409,
  );
  await digested(ctx, caller, previous, tx, true);
}

/** Every selected work exists; an automatic cycle's are tasks and experiments, one at least. */
export async function selectable(
  ctx: ResearchContext,
  caller: Caller,
  { dependsOn, automatic }: { dependsOn: string[]; automatic?: boolean },
  tx: Transaction,
) {
  for (const id of dependsOn) {
    const work = await ctx.workflows.get(caller, id, tx);
    check(
      !automatic || ['task', 'experiment'].includes(work.workflow),
      'invalid_research_input',
      'Automatic research selects tasks and experiments',
    );
  }
  check(
    !automatic || dependsOn.length > 0,
    'research_work_required',
    'Select at least one task or experiment for automatic research',
  );
}

/**
 * Opens a cycle inside a command its caller already recorded. research_commands has one row
 * per request, so the cycle an advance opens must not record a second one under the same ID.
 */
export async function begin(
  ctx: ResearchContext,
  caller: Caller,
  input: ReturnType<typeof parse<typeof createSchema>>,
  tx: Transaction,
): Promise<ResearchRecord> {
  check(
    !caller.session,
    'forbidden',
    'Assigned workers cannot create an outer research cycle',
    403,
  );
  await selectable(ctx, caller, input, tx);
  const workflow = await ctx.handle!.start(
    caller,
    {
      workflow: 'research',
      version: definition.version,
      requestId: childRequest(caller, 'research', 'create', input.requestId),
      dependsOn: input.dependsOn,
      data: { name: input.name },
    },
    tx,
  );
  const record: StoredRecord = {
    id: workflow.id,
    projectId: caller.projectId,
    ownerId: caller.actorId,
    name: input.name,
    createdAt: now(),
    researchDependencies: [...new Set(input.dependsOn)],
  };
  await tx.run(
    'INSERT INTO research_cycles(id,project_id,record,predecessor_id) VALUES(?,?,?,?)',
    workflow.id,
    caller.projectId,
    JSON.stringify(record),
    input.previousCycleId ?? null,
  );
  if (input.automatic)
    await tx.run(
      'INSERT INTO research_automation(research_id,project_id,source_json) VALUES(?,?,?)',
      workflow.id,
      caller.projectId,
      JSON.stringify(await ctx.scope.delegationSource(caller, tx)),
    );
  await ctx.event(
    caller,
    'created',
    workflow.id,
    {
      dependsOn: record.researchDependencies,
      ...(input.previousCycleId ? { previousCycleId: input.previousCycleId } : {}),
    },
    tx,
  );
  return await ctx.get(caller, workflow.id, tx);
}

/**
 * Refuses what the stage cannot pass and answers with the move the advance makes. `since` is
 * what main lacks, which only an advance has asked; the guard reads the move it chose instead.
 */
export async function ready(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
  choice: Choice = {},
  since?: Unpublished | null,
): Promise<{ move: Move; abandoned?: true }> {
  const stage = record.workflow.state as Stage;
  check(stage !== 'complete', 'research_complete', 'This research cycle is complete', 409);
  if (stage === 'defining') {
    await ctx.definition(caller, tx);
    return { move: 'advance' };
  }
  if (stage === 'researching') {
    const selection = new Set(record.researchDependencies);
    const pending = (await ctx.workflows.prerequisites(caller, [record.id], tx))
      .get(record.id)!
      .filter((item) => selection.has(item.id) && !item.settled && !item.failed);
    check(
      !pending.length,
      'dependencies_pending',
      `Waiting for research outcomes: ${pending.map((item) => `${item.name} (${item.state})`).join(', ')}`,
      409,
    );
  }
  const judged = await move(ctx, caller, record, tx, since, choice);
  return judged === 'abandon' ? { move: 'advance', abandoned: true as const } : { move: judged };
}

/**
 * The transition an advance makes; `inject` and `reinject` first inject a consolidation task.
 * A cycle consolidates through that task: an unfinished one, one that ended without
 * acceptance and one not on main yet are refused here, so a preflight reports the same wait.
 * Whether main lacks accepted code is Git's answer: an advance reads it as `since` and hands
 * the guard the move it chose; a preflight has neither and reads the move main lacking makes.
 */
export async function move(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
  since: Unpublished | null | undefined,
  choice: Choice,
): Promise<Move | 'abandon'> {
  const stage = record.workflow.state as Stage;
  if (stage !== 'researching' && stage !== 'consolidating') return 'advance';
  const judged = (holds: Move, lacks: Move): Move => {
    if (since !== undefined) {
      // Git answers what main lacks outside every transaction; null says it could not be asked.
      check(
        since !== null,
        'integration_candidates_unavailable',
        'What main lacks is asked of Git outside a transaction; this advance runs again on its own',
        409,
      );
      return since.unitIds.length ? lacks : holds;
    }
    return (choice.move ?? lacks) === holds ? holds : lacks;
  };
  if (stage === 'researching') return judged('complete', 'inject');
  const taskId = record.integrations.at(-1)!;
  const task = (await ctx.workflows.prerequisites(caller, [record.id], tx))
    .get(record.id)!
    .find((item) => item.id === taskId)!;
  if (task.failed) {
    check(
      choice.retryIntegration,
      'integration_failed',
      `The consolidation task ${taskId} ended ${task.state}. Retry with research.advance { retryIntegration: true } to inject a fresh task, or end the cycle with research.end.`,
      409,
    );
    return judged('advance', 'reinject');
  }
  check(
    task.settled,
    'dependencies_pending',
    `Waiting for the consolidation task: ${task.name} (${task.state})`,
    409,
  );
  const { publication } = await ctx.providers.code.unit(caller, taskId, tx);
  if (publication?.state === 'published') return 'advance';
  // A pull request closed unmerged is a rejection: the cycle moves on without its code.
  if (publication?.state === 'closed') return 'abandon';
  // Main moved first, or the task ended without acceptance: what main lacks now decides
  // between a successor task and completing, as it did when research ended.
  if (publication?.state === 'stale') return judged('advance', 'reinject');
  // Code says what holds its publication and who ends the wait, in its own code and words.
  const said = publication?.blockers[0];
  throw said
    ? new MervError(
        said.code,
        `The consolidation task ${taskId} is accepted; ${said.message}. ${said.next}`,
        409,
      )
    : new MervError(
        'publication_pending',
        `The consolidation task ${taskId} is accepted, but Code holds no publication for it`,
        409,
      );
}

/**
 * One ordinary Git task that integrates the accepted units main lacks and publishes the
 * result: it stands on them, so its base holds them and main, and its acceptance seals the
 * publication. The advance records it after the move, so the guard judges the task before it.
 */
export async function inject(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  units: Unpublished,
  requestId: string,
  tx: Transaction,
): Promise<string> {
  const count = record.integrations.length + 1;
  const step = count === 1 ? 'integration' : `integration:${count}`;
  const task = await ctx.providers.tasks.serviceTasks('research').create(
    {
      projectId: caller.projectId,
      requestId: childRequest(caller, 'research', step, requestId),
      title: `${clip(record.name, 180)}: consolidation`,
      goal: integrationGoal,
      checks: integrationChecks,
      dependsOn: units.unitIds,
    },
    tx,
  );
  await ctx.providers.code.publishOnAcceptance(caller, { unitId: task.id }, tx);
  return task.id;
}
