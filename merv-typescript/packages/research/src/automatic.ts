import {
  check,
  clip,
  digest,
  MervError,
  type Caller,
  type DelegationSource,
  type DomainEvents,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import type { ResearchContext } from './index.js';
import { definition } from './policy.js';
import type { ResearchAdvance, ResearchRecord } from './types.js';

/**
 * A row of research_automation. Its unavailable_since column holds when the outage the cycle's
 * blocker reports was first seen, whatever codes it has reported since.
 */
export interface AutomaticRow {
  research_id: string;
  project_id: string;
  source_json: string;
  root_id: string;
  cycle_index: number;
  max_cycles: number;
}
/**
 * Why automatic progress waits, as Research publishes it to Workflows; null when it does not.
 * One that only a person ends is the cycle owner's move, with its own way on: Workflows gives an
 * owner's move to a project admin too, so it still reaches somebody once the owner has left.
 */
export type AutomaticBlocker = {
  code: string;
  message: string;
  status: number;
  next?: string;
  whose?: 'owner';
} | null;
/** The provider Research's automation blockers are published as. */
export const AUTOMATIC_PROVIDER = 'research';
const NEXT =
  'Automatic research tries again when this project next changes; research.advance moves the cycle by hand, and research.end stops it.';

/** Research's whole opinion of a cycle, written over whatever it said before. */
export async function publishBlocker(
  workflows: Pick<Workflows, 'replaceBlockers'>,
  row: Pick<AutomaticRow, 'project_id' | 'research_id'>,
  blocker: AutomaticBlocker,
  tx: Transaction,
): Promise<void> {
  // An outage keeps when it was first seen; anything else forgets it.
  if (blocker?.status === 503)
    await tx.run(
      'UPDATE research_automation SET unavailable_since=COALESCE(unavailable_since,?) WHERE research_id=?',
      new Date().toISOString(),
      row.research_id,
    );
  else
    await tx.run(
      'UPDATE research_automation SET unavailable_since=NULL WHERE research_id=?',
      row.research_id,
    );
  await workflows.replaceBlockers(
    {
      projectId: row.project_id,
      instanceId: row.research_id,
      provider: AUTOMATIC_PROVIDER,
      blockers: blocker ? [{ key: 'automatic', next: NEXT, related: [], ...blocker }] : [],
    },
    tx,
  );
}

/** A refusal that only the cycle's owner, or a project admin, can move past, and how. */
const OWNERS: Record<string, string> = {
  research_definition_changed:
    'Accept the changed definition with research.advance, or stop the run with research.end',
};
/** Said of a run whose delegation no longer holds: nothing automatic moves it again. */
const LAPSED =
  'The delegation this automatic run acts under no longer holds: research.advance moves the cycle by hand, and research.end stops it';

// A member who leaves, or whose role changes, may take the delegation a run acts under with
// them: hearing it reports the lapse at once, not on the project's next change.
const CONSUMER = 'research.automatic.v4';
/** Retries of one event while the database answers 503: about 25 seconds of backoff in all. */
const UNAVAILABLE_RETRIES = 8;
const TRANSIENT = ['state_timeout', 'state_busy', 'state_unavailable'];

/** Existing durable events drive Research. This neither schedules nor launches workers. */
export async function automaticResearch(
  state: State,
  scope: Scope,
  workflows: Pick<Workflows, 'open' | 'replaceBlockers'>,
  events: DomainEvents,
  reconcile: (caller: Caller, row: AutomaticRow, tx: Transaction) => Promise<AutomaticBlocker>,
  /** Asked to try a cycle that an outage refused again later; it reads what was committed. */
  unavailable: (row: AutomaticRow) => void,
): Promise<() => void | Promise<void>> {
  return await events.subscribe({
    id: CONSUMER,
    // New subscriptions start here; bindAutomatic's startup wake revisits every open cycle.
    from: 'now',
    types: [
      'workflow.transition',
      'workflow.limit_extended',
      'code.publication_verified',
      'code.publication_stale',
      'research.created',
      'research.resume',
      'paper.patched',
      'actor.permissions_changed',
      'actor.revoked',
    ],
    handle: async (event, tx) => {
      // Startup asks for a resume, as does a retry; a later one still to come answers this.
      const later = { projectId: event.projectId, type: 'research.resume', after: event.id };
      if (event.type === 'research.resume' && (await state.findEvents(later, 1, tx)).length) return;
      // Only a defining cycle reads the paper, so only it can be unblocked by a patch.
      const cycles = (await workflows.open('research', event.projectId, tx)).filter(
        (cycle) => event.type !== 'paper.patched' || cycle.state === 'defining',
      );
      const rows = await tx.all<AutomaticRow>(
        'SELECT * FROM research_automation WHERE project_id=? AND research_id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY cycle_index,research_id',
        event.projectId,
        JSON.stringify(cycles.map((cycle) => cycle.id)),
      );
      for (const row of rows) {
        let blocker: AutomaticBlocker;
        // Isolate an expected refusal to this cycle, including any child mutations already made.
        // The effects and the event cursor still share the outer transaction. Unexpected errors
        // retry the event; a permanent domain blocker must not strand every other cycle.
        await tx.run('SAVEPOINT research_automatic_cycle');
        let delegated = false;
        try {
          const source = JSON.parse(row.source_json) as DelegationSource;
          await scope.requireDelegation(source, 'write', tx);
          delegated = true;
          blocker = await reconcile(sourceCaller(source), row, tx);
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
        } catch (error) {
          await tx.run('ROLLBACK TO SAVEPOINT research_automatic_cycle');
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
          if (!(error instanceof MervError) || (error.status >= 500 && error.status !== 503))
            throw error;
          // A database that is briefly unavailable is retried with the event, a bounded number
          // of times the consumer's own durable attempt count keeps, before it shows as a blocker.
          // Any other refusal shows at once: the consumer is shared by every project and must
          // not wait on it. An outage is tried again later, as nothing else may happen in this
          // project.
          if (TRANSIENT.includes(error.code)) {
            const consumer = (await events.status()).find((item) => item.id === CONSUMER);
            if ((consumer?.attempts ?? UNAVAILABLE_RETRIES) < UNAVAILABLE_RETRIES) throw error;
          }
          blocker = automaticBlocker(error);
          // A lapsed delegation, or a refusal only a person moves past, is somebody's move.
          const next = delegated ? OWNERS[error.code] : error.status !== 503 && LAPSED;
          if (next) blocker = { ...blocker, next, whose: 'owner' };
          if (error.status === 503) unavailable(row);
        }
        await publishBlocker(workflows, row, blocker, tx);
      }
    },
  });
}

export const automaticBlocker = (error: MervError): NonNullable<AutomaticBlocker> => ({
  code: error.code,
  message: clip(error.message, 2000),
  status: error.status,
});

export const automaticRequest = (cycle: string, revision: number, action: string) =>
  `research-auto:${digest({ cycle, revision, action })}`;

// Automatic progress, run on ResearchService (index.ts) as its ResearchContext: binding the
// consumer, waking cycles, the advance it makes, and closing work a failed input stranded.
/** Subscribe through the existing engine's durable events; workers keep their fixed grants. */
export async function bindAutomatic(
  ctx: ResearchContext,
  events: DomainEvents,
): Promise<() => void | Promise<void>> {
  ctx.open();
  const release = await automaticResearch(
    ctx.state,
    ctx.scope,
    ctx.workflows,
    events,
    async (caller, row, tx) => await reconcileAutomatic(ctx, caller, row, tx),
    (row) => retryUnavailable(ctx, row),
  );
  try {
    await wakeAutomatic(ctx);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/**
 * Wakes a project whose cycle an outage refused once `retryAfterMs` has passed, while one of
 * its cycles reports an outage first seen less than `unavailableForMs` ago: an idle project
 * has no other event to wake it. The bound is the outage's first sighting, kept beside the
 * cycle, so outages that alternate their codes cannot extend it. One retry waits per project.
 * A retry that cannot even be read or written is tried again, within the bound from `since`,
 * when this retry was first asked for.
 */
export function retryUnavailable(
  ctx: ResearchContext,
  row: AutomaticRow,
  since = Date.now(),
): void {
  if (ctx.retrying.has(row.project_id)) return;
  ctx.retrying.add(row.project_id);
  const wake = async () => {
    ctx.retrying.delete(row.project_id);
    if (ctx.closed) return;
    const source = JSON.parse(row.source_json) as DelegationSource;
    await ctx.state.transaction(async (tx) => {
      const out = await tx.all<{ unavailable_since: string }>(
        'SELECT unavailable_since FROM research_automation WHERE project_id=? AND unavailable_since IS NOT NULL',
        row.project_id,
      );
      if (
        !out.some((item) => Date.now() - Date.parse(item.unavailable_since) <= ctx.unavailableForMs)
      )
        return;
      await ctx.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: source.actorId,
        type: 'research.resume',
        subjectId: row.research_id,
        data: { performedBy: 'system:research' },
      });
    });
  };
  // Outside the consumer's transaction context, which ends before this runs.
  const retry = () =>
    void wake().catch(() => {
      if (Date.now() - since < ctx.unavailableForMs) retryUnavailable(ctx, row, since);
    });
  ctx.detached(() => setTimeout(retry, ctx.retryAfterMs).unref());
}

/** Startup must also revisit events previously consumed while blocked. */
export async function wakeAutomatic(ctx: ResearchContext): Promise<void> {
  if (ctx.closed) return;
  await ctx.state.transaction(async (tx) => {
    // One resume per project: its consumer reconciles every open cycle there.
    const cycles = await ctx.workflows.open('research', null, tx);
    const rows = await tx.all<{ project_id: string; source_json: string; research_id: string }>(
      'SELECT DISTINCT ON (project_id) project_id,source_json,research_id FROM research_automation WHERE research_id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY project_id,cycle_index,research_id',
      JSON.stringify(cycles.map((cycle) => cycle.id)),
    );
    for (const row of rows)
      await ctx.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: JSON.parse(row.source_json).actorId,
        type: 'research.resume',
        subjectId: row.research_id,
        data: { performedBy: 'system:research' },
      });
  });
}

export async function reconcileAutomatic(
  ctx: ResearchContext,
  caller: Caller,
  automatic: AutomaticRow,
  tx: Transaction,
): Promise<AutomaticBlocker> {
  ctx.open();
  const record = await ctx.get(caller, automatic.research_id, tx);
  await ctx.authorize(caller, record, tx);
  if (definition.terminal.includes(record.workflow.state)) return null;
  if (record.workflow.state === 'defining' && record.previousCycleId) {
    const previous = await ctx.get(caller, record.previousCycleId, tx);
    const current = await ctx.definition(caller, tx);
    check(
      !previous.problem || current.revision === previous.problem.revision,
      'research_definition_changed',
      'The project definition changed; explicitly accept it before continuing this automatic run',
      409,
    );
  }
  if (record.workflow.state === 'researching') await closeBlockedWork(ctx, caller, record, tx);
  const atLimit = automatic.cycle_index >= automatic.max_cycles;
  const nextWave = atLimit ? 'skip' : 'create';
  const guidance = await ctx.workflows.evaluate(
    caller,
    record.id,
    {
      action: `advance_${record.workflow.state}`,
      input: { nextWave },
    },
    tx,
  );
  const action = guidance.nextAction;
  if (!action || action.status !== 'ready') {
    const blocker = guidance.blockers[0] ?? guidance.actions.flatMap((item) => item.blockers)[0];
    return blocker
      ? { code: blocker.code, message: clip(blocker.message, 2000), status: blocker.status }
      : { code: 'research_waiting', message: guidance.instruction, status: 409 };
  }
  const input: ResearchAdvance = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    nextWave,
    requestId: automaticRequest(record.id, record.workflow.revision, 'advance'),
  };
  let advanced: ResearchRecord;
  try {
    advanced = await ctx.advance(caller, input, tx);
  } catch (error) {
    // Git is asked outside every transaction, so the same advance runs again on its own.
    if (error instanceof MervError && error.code === 'integration_candidates_unavailable')
      soon(ctx, caller, automatic, input, automaticBlocker(error));
    throw error;
  }
  await ctx.event(
    caller,
    'automatically_advanced',
    record.id,
    {
      performedBy: 'system:research',
      from: record.workflow.state,
      to: advanced.workflow.state,
      ...(advanced.successorId ? { successorId: advanced.successorId } : {}),
    },
    tx,
  );
  return await needsOwner(ctx, caller, advanced, tx);
}

/**
 * A run whose approved plan stops for its owner ends with the owner's decision outstanding:
 * said on the completed cycle, with the plan's own reason, until a cycle follows it.
 */
export async function needsOwner(
  ctx: ResearchContext,
  caller: Caller,
  record: Pick<ResearchRecord, 'id' | 'reflectionId' | 'successorId'> & {
    workflow: { state: string };
  },
  tx: Transaction,
): Promise<AutomaticBlocker> {
  if (record.workflow.state !== 'complete' || record.successorId || !record.reflectionId)
    return null;
  const next = (await ctx.providers.reflections.approved(caller, record.reflectionId, tx))?.plan
    ?.next;
  return next?.decision === 'stop' && next.reason === 'needs_owner'
    ? {
        code: 'research_needs_owner',
        message: clip(`The approved plan stops for the owner: ${next.rationale}`, 2000),
        status: 409,
        next: 'Decide what comes next: start a research cycle that follows this one, or stop here with research.end',
        whose: 'owner',
      }
    : null;
}

/**
 * The advance the consumer could not make, run on its own after its transaction, outside
 * every transaction's context. Success is a transition event the consumer answers; a
 * refusal is written only over the marker the consumer left, so a reconcile since is never
 * overwritten and nothing loops: the marker returns on the next event, today's retry cadence.
 */
export function soon(
  ctx: ResearchContext,
  caller: Caller,
  row: AutomaticRow,
  input: ResearchAdvance,
  marker: AutomaticBlocker,
): void {
  if (ctx.closed) return;
  const run = async () => {
    try {
      await ctx.advance(caller, input);
    } catch (error) {
      if (
        ctx.closed ||
        !(error instanceof MervError) ||
        (error.status >= 500 && error.status !== 503)
      )
        return;
      await ctx.state.transaction(async (tx) => {
        const left = (await ctx.workflows.blockers(caller, row.research_id, tx)).find(
          (item) => item.provider === AUTOMATIC_PROVIDER,
        );
        if (left?.code === marker?.code && left?.message === marker?.message)
          await publishBlocker(ctx.workflows, row, automaticBlocker(error), tx);
      });
    }
  };
  // Outside the consumer's transaction, whose commit its own transaction waits for.
  ctx.detached(() => queueMicrotask(() => void run().catch(() => undefined)));
}

/**
 * A permanently failed input cannot strand never-started work in this selected wave, or the
 * work between it and that input. Each owner judges what of its own was never started.
 */
export async function closeBlockedWork(
  ctx: ResearchContext,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
) {
  const { tasks, experiments } = ctx.providers;
  if (!record.researchDependencies.length) return;
  // The whole closure in one walk, then each pass reads every prerequisite at once: a pass that
  // finds nothing failed ends the walk, as the first does on every event while nothing has.
  const remaining = new Set(
    await ctx.workflows.dependencyClosure(caller, record.researchDependencies, tx),
  );
  for (let pass = 0, passes = remaining.size; remaining.size && pass < passes; pass++) {
    const prerequisites = await ctx.workflows.prerequisites(caller, [...remaining], tx);
    let changed = false;
    for (const id of [...remaining]) {
      const failed = prerequisites.get(id)!.filter((item) => item.failed);
      if (!failed.length) continue;
      remaining.delete(id);
      // Work between the selection and the failed input is not the cycle's own to reflect on.
      const after = record.researchDependencies.includes(id)
        ? `Retained for reflection in ${record.name}.`
        : `Closed because work selected by ${record.name} waits on it.`;
      const reason = clip(
        `Not run: required input ended without success: ${failed.map((item) => `${item.name} (${item.id}, ${item.state})`).join(', ')}. ${after}`,
        16000,
      );
      // The work's own revision too: work closed, then moved on (a suspended service task
      // resumed), is closed again by a request of its own, never a replay of the first.
      const work = await ctx.workflows.get(caller, id, tx);
      const requestId = automaticRequest(
        record.id,
        record.workflow.revision,
        `close:${id}@${work.revision}`,
      );
      if (
        !(await tasks.closeUnstarted(caller, id, reason, requestId, tx)) &&
        !(await experiments.closeUnstarted(caller, id, reason, requestId, tx))
      )
        continue;
      await ctx.event(
        caller,
        'blocked_work_closed',
        record.id,
        {
          performedBy: 'system:research',
          workflowId: id,
          failedInputs: failed.map((item) => item.id),
          reason,
        },
        tx,
      );
      changed = true;
    }
    if (!changed) break;
  }
}
