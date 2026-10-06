import {
  check,
  childRequest,
  clip,
  inTransaction,
  MervError,
  now,
  ordered,
  type Artifact,
  type Caller,
  type Transaction,
} from '@merv/contracts';
import type { CodeAcceptedSince } from '@merv/code-work/models';
import type { ApprovedReflection, ChangeSpec } from '@merv/reflections/types';
import type { AutomaticRow } from './automatic.js';
import type { ResearchContext, StoredRecord } from './index.js';
import { createSchema, nextWaveChoiceSchema, parse } from './input.js';
import { definition, type Stage } from './policy.js';
import type { ResearchOrigin, ResearchRecord } from './types.js';
import { digested } from './compose.js';

// How a cycle moves: what naming a predecessor and opening a cycle require, what each stage
// must pass and which transition an advance makes, the consolidation task it injects and the
// approved plan's next wave it creates. Each runs on ResearchService (index.ts) as its
// ResearchContext.
/** An approved reflection whose plan says the project continues. */
export type Continuing = ApprovedReflection & {
  plan: ChangeSpec & { next: { decision: 'continue' } };
};
/** The accepted units main does not hold, read outside the transaction that acts on them. */
export type Unpublished = Pick<CodeAcceptedSince, 'unitIds' | 'quarantined'>;
/** What an advance does from where the cycle stands; see `move`. */
export type Move = 'advance' | 'complete' | 'inject' | 'reinject';
export type Choice = ReturnType<typeof parse<typeof nextWaveChoiceSchema>>;
const integrationGoal =
  "Integrate this cycle's accepted work onto one branch. Account for every experiment in this cycle as kept, adapted or dropped, with reasons; a drop is a reverting commit visible in the diff. Main is part of your base; the branch you deliver is what reaches main.";
const integrationChecks = [
  'Every experiment in this cycle is accounted for as kept, adapted or dropped, with a reason each.',
  'The report names what was dropped and why.',
  'The delivered branch passes the checks the project defines.',
];
/** Where text an agent wrote and an owner accepted came from, for the record that carries it. */
const origin = (approved: ApprovedReflection, ...named: string[]) =>
  `\n\nOrigin: reflection ${approved.id}, ${named.join(', ')}.`;
const pinned = (kind: string, { id, hash }: Artifact) => `${kind} ${id} (${hash})`;

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

/**
 * Opens a cycle inside a command its caller already recorded. research_commands has one row
 * per request, so the cycle an advance opens must not record a second one under the same ID.
 */
export async function begin(
  ctx: ResearchContext,
  caller: Caller,
  input: ReturnType<typeof parse<typeof createSchema>>,
  step: 'create' | 'successor',
  origin: ResearchOrigin | null,
  tx: Transaction,
): Promise<ResearchRecord> {
  check(
    !caller.session,
    'forbidden',
    'Assigned workers cannot create an outer research cycle',
    403,
  );
  for (const id of input.dependsOn) await ctx.workflows.get(caller, id, tx);
  check(
    input.automatic || input.maxCycles === undefined,
    'invalid_research_input',
    'maxCycles requires automatic mode',
  );
  if (input.automatic) {
    check(
      input.dependsOn.length > 0,
      'research_work_required',
      'Select at least one task or experiment for automatic research',
    );
    for (const id of input.dependsOn) {
      const work = await ctx.workflows.get(caller, id, tx);
      check(
        ['task', 'experiment'].includes(work.workflow),
        'invalid_research_input',
        'Automatic research selects tasks and experiments',
      );
    }
  }
  const workflow = await ctx.handle!.start(
    caller,
    {
      workflow: 'research',
      version: 6,
      requestId: childRequest(caller, 'research', step, input.requestId),
      dependsOn: input.dependsOn,
      data: { name: input.name },
    },
    tx,
  );
  let predecessorId = input.previousCycleId ?? null;
  let from: StoredRecord['origin'];
  if (origin) ({ researchId: predecessorId, ...from } = origin);
  const record: StoredRecord = {
    id: workflow.id,
    projectId: caller.projectId,
    ownerId: caller.actorId,
    name: input.name,
    createdAt: now(),
    researchDependencies: [...new Set(input.dependsOn)],
    ...(from ? { origin: from } : {}),
  };
  await tx.run(
    'INSERT INTO research_cycles(id,project_id,record,predecessor_id) VALUES(?,?,?,?)',
    workflow.id,
    caller.projectId,
    JSON.stringify(record),
    predecessorId,
  );
  const inherited = origin
    ? await tx.get<AutomaticRow>(
        'SELECT * FROM research_automation WHERE research_id=?',
        origin.researchId,
      )
    : undefined;
  if (input.automatic || inherited) {
    const source =
      inherited?.source_json ?? JSON.stringify(await ctx.scope.delegationSource(caller, tx));
    await tx.run(
      'INSERT INTO research_automation(research_id,project_id,source_json,root_id,cycle_index,max_cycles) VALUES(?,?,?,?,?,?)',
      workflow.id,
      caller.projectId,
      source,
      inherited?.root_id ?? workflow.id,
      inherited ? inherited.cycle_index + 1 : 1,
      inherited?.max_cycles ?? input.maxCycles ?? 10,
    );
  }
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
): Promise<{ move: Move; continuing?: Continuing; abandoned?: true }> {
  const stage = record.workflow.state as Stage;
  check(stage !== 'complete', 'research_complete', 'This research cycle is complete', 409);
  if (stage === 'defining') {
    await ctx.definition(caller, tx);
    return { move: 'advance' };
  }
  // Only one wave reflects at a time; the cycle's own, just started, is not another.
  if (stage === 'researching') {
    const open = await ctx.providers.reflections.open(caller, tx);
    check(
      !open || open === record.reflectionId,
      'reflection_open',
      'Complete the current reflection before starting another',
      409,
    );
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
  if (stage === 'reflecting') {
    check(record.reflectionId, 'research_child_missing', 'The reflection workflow is missing', 409);
    // An abandoned wave is never approved; the engine then offers this cycle's end.
    check(
      (await ctx.workflows.get(caller, record.reflectionId, tx)).state !== 'abandoned',
      'dependency_failed',
      `The reflection ${record.reflectionId} was abandoned. End this cycle with research.end; a cycle that follows it can reflect on the same work.`,
      409,
    );
    await ctx.providers.reflections.approved(caller, record.reflectionId, tx);
  }
  const judged = await move(ctx, caller, record, tx, since, choice);
  const chosen = judged === 'abandon' ? 'advance' : judged;
  // A skip reads no plan, so it completes a cycle whose plan can no longer be created.
  // Anything else must know whether a plan waits for an answer.
  const continued =
    choice.nextWave === 'skip' ? undefined : await continuing(ctx, caller, record, tx, chosen);
  if (continued && choice.nextWave === 'create') {
    checkAutomaticContinuation(ctx, caller, record);
    await creatable(ctx, caller, continued.plan, tx);
  }
  return {
    move: chosen,
    continuing: continued,
    ...(judged === 'abandon' ? { abandoned: true as const } : {}),
  };
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
  if (stage !== 'reflecting' && stage !== 'consolidating') return 'advance';
  // A preflight that answers the completion question is read as completing, so a plan that
  // would refuse is reported before the advance, as it always was.
  const judged = (holds: Move, lacks: Move): Move => {
    if (since !== undefined) {
      asked(ctx, since);
      return since.unitIds.length ? lacks : holds;
    }
    return (choice.move ?? (choice.nextWave ? holds : lacks)) === holds ? holds : lacks;
  };
  if (stage === 'reflecting') return judged('complete', 'inject');
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
  // between a successor task and completing, as it did at reflection.
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

/** Git answers what main lacks outside every transaction; null says it could not be asked. */
export function asked(
  ctx: ResearchContext,
  since: Unpublished | null,
): asserts since is Unpublished {
  check(
    since !== null,
    'integration_candidates_unavailable',
    'What main lacks is asked of Git outside a transaction; this advance runs again on its own',
    409,
  );
}

/** The approved reflection, when this advance completes the cycle and its plan continues. */
export async function continuing(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
  move: Move,
): Promise<Continuing | undefined> {
  const completing =
    move === 'complete' || (record.workflow.state === 'consolidating' && move === 'advance');
  if (!completing || !record.reflectionId) return undefined;
  const approved = await ctx.providers.reflections.approved(caller, record.reflectionId, tx);
  return approved.plan?.next.decision === 'continue' ? (approved as Continuing) : undefined;
}

/**
 * Everything about the project that can refuse the plan, judged before the cycle moves. A
 * plan reported ready and refused on every attempt would leave skipping as the only way on,
 * and skipping discards the reviewed plan.
 *
 * A workspace declaration is also admitted by the item's owner at creation, not pre-checked
 * here: a refusal while Code is unloaded rolls the whole advance back and leaves the
 * approved plan to retry.
 */
export async function creatable(
  ctx: ResearchContext,
  caller: Caller,
  plan: ChangeSpec,
  tx: Transaction,
): Promise<void> {
  const planned = plan.items.flatMap((item) => (item.kind === 'experiment' ? [item.name] : []));
  if (planned.length)
    await ctx.providers.experiments.admits(caller, planned, tx).catch((error: unknown) => {
      // Experiments' refusal, with this cycle's way past it.
      throw error instanceof MervError && error.status === 409
        ? new MervError(
            error.code,
            `${error.message}. Complete this cycle with nextWave: "skip" to go on without the plan`,
            409,
          )
        : error;
    });
  // The engine refuses the starts anyway; said here, the owner reads it before trying.
  check(
    !(await ctx.providers.reflections.open(caller, tx)),
    'reflection_open',
    'Another reflection wave pauses task and experiment creation; finish it, or complete this cycle with nextWave: "skip"',
    409,
  );
  for (const { workflowId } of plan.carriedOver) {
    const carried = await ctx.workflows.get(caller, workflowId, tx);
    check(
      ['task', 'experiment'].includes(carried.workflow),
      'next_wave_inapplicable',
      `Carried-over work ${workflowId} is neither a task nor an experiment; complete this cycle with nextWave: "skip"`,
      409,
    );
  }
}

export function checkAutomaticContinuation(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
) {
  if (record.automation) {
    check(
      caller.actorId === record.ownerId,
      'automatic_owner_required',
      'Only the authorizing owner creates an automatic successor',
      403,
    );
    check(
      record.automation.cycle < record.automation.maxCycles,
      'research_cycle_limit',
      'The automatic research run has reached its cycle limit; complete with nextWave: skip',
      409,
    );
  }
}

/**
 * Creates the approved plan's work under the advancing owner and opens the cycle that waits
 * on it. Runs inside the advance's transaction, so a refusal anywhere leaves nothing behind.
 * Every request ID derives from the advance's, so a retry names the same records.
 */
export async function materialise(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  approved: Continuing,
  requestId: string,
  tx: Transaction,
): Promise<ResearchRecord> {
  const { plan } = approved;
  checkAutomaticContinuation(ctx, caller, record);
  const created = new Map<string, string>();
  for (const item of ordered<ChangeSpec['items'][number]>(plan.items)!) {
    // The text was written by a leased agent and is filed under the owner who accepted it;
    // this line is what lets a reader of the record trace it back to the reviewed plan.
    const provenance = `\n\nWhy: ${item.rationale}${origin(approved, pinned('change specification', approved.changeSpec), `item ${item.key}`)}`;
    const dependsOn = item.dependsOn.map((key) => created.get(key)!);
    const itemRequestId = childRequest(caller, 'research', `item:${item.key}`, requestId);
    // Storage is platform policy, including new work generated from retained older plans.
    const work =
      item.kind === 'task'
        ? await ctx.providers.tasks.create(
            caller,
            {
              title: item.title,
              goal: `${item.goal}${provenance}`,
              checks: item.checks,
              dependsOn,
              workspace: 'git',
              requestId: itemRequestId,
            },
            tx,
          )
        : await ctx.providers.experiments.create(
            caller,
            {
              name: item.name,
              intent: item.question,
              details: `${item.details}${provenance}`.trimStart(),
              dependsOn,
              workspace: 'git',
              requestId: itemRequestId,
            },
            tx,
          );
    created.set(item.key, work.id);
  }
  const carriedOver = plan.carriedOver.map((entry) => entry.workflowId);
  return await begin(
    ctx,
    caller,
    parse(createSchema, {
      name: plan.next.name,
      dependsOn: [...created.values(), ...carriedOver],
      requestId,
    }),
    'successor',
    {
      researchId: record.id,
      reflectionId: approved.id,
      reviewId: approved.reviewId,
      changeSpec: { id: approved.changeSpec.id, hash: approved.changeSpec.hash },
      items: plan.items.map((item) => ({
        key: item.key,
        kind: item.kind,
        id: created.get(item.key)!,
      })),
      carriedOver,
    },
    tx,
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
  const approved = await ctx.providers.reflections.approved(caller, record.reflectionId!, tx);
  const count = record.integrations.length + 1;
  const step = count === 1 ? 'integration' : `integration:${count}`;
  const task = await ctx.providers.tasks.serviceTasks('research').create(
    {
      projectId: caller.projectId,
      requestId: childRequest(caller, 'research', step, requestId),
      title: `${clip(record.name, 180)}: consolidation`,
      goal: `${integrationGoal}${origin(approved, pinned('report', approved.report), pinned('change specification', approved.changeSpec))}`,
      checks: integrationChecks,
      dependsOn: units.unitIds,
    },
    tx,
  );
  await ctx.providers.code.publishOnAcceptance(caller, { unitId: task.id }, tx);
  return task.id;
}

/**
 * What main lacks, for a cycle that may consolidate in a hosted project. Git is read outside
 * the transaction that advances the cycle; inside one this answers null.
 */
export async function unpublished(
  ctx: ResearchContext,
  caller: Caller,
  researchId: string,
  tx?: Transaction,
): Promise<Unpublished | null> {
  const { code } = ctx.providers;
  const asks = await inTransaction(ctx.state, tx, async (tx) => {
    const record = await ctx.get(caller, researchId, tx);
    if (!['reflecting', 'consolidating'].includes(record.workflow.state)) return false;
    await ctx.authorize(caller, record, tx);
    return await code.hosted(caller, tx);
  });
  if (!asks) return { unitIds: [], quarantined: [] };
  if (tx) return null;
  return await code.acceptedSince(caller);
}
