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
import type { ResearchService } from './index.js';
import { definition } from './policy.js';
import type { ResearchAdvance, ResearchRecord } from './types.js';

/**
 * A row of research_automation. Its blocker_json column holds `{unavailableSince}`, when the
 * outage the cycle's blocker reports was first seen, whatever codes it has reported since.
 */
export interface AutomaticRow {
  research_id: string;
  project_id: string;
  source_json: string;
  root_id: string;
  cycle_index: number;
  max_cycles: number;
}
/** Why automatic progress waits, as Research publishes it to Workflows; null when it does not. */
export type AutomaticBlocker = { code: string; message: string; status: number } | null;
/** The provider Research's automation blockers are published as. */
export const AUTOMATIC_PROVIDER = 'research';
const NEXT =
  'Automatic research tries again when this project next changes; research.advance moves the cycle by hand, and research.end stops it.';

/** When the outage a cycle's blocker reports was first seen, or NaN when it reports none. */
export const unavailableSince = (blockerJson: string | null): number => {
  try {
    return Date.parse(
      (JSON.parse(blockerJson ?? 'null') as { unavailableSince?: string })?.unavailableSince ?? '',
    );
  } catch {
    return NaN;
  }
};

/** Research's whole opinion of a cycle, written over whatever it said before. */
export async function publishBlocker(
  workflows: Pick<Workflows, 'replaceBlockers'>,
  row: Pick<AutomaticRow, 'project_id' | 'research_id'>,
  blocker: AutomaticBlocker,
  tx: Transaction,
): Promise<void> {
  const held = await tx.get<{ blocker_json: string | null }>(
    'SELECT blocker_json FROM research_automation WHERE research_id=?',
    row.research_id,
  );
  const since = unavailableSince(held?.blocker_json ?? null);
  await tx.run(
    'UPDATE research_automation SET blocker_json=? WHERE research_id=?',
    blocker?.status === 503
      ? JSON.stringify({ unavailableSince: new Date(since || Date.now()).toISOString() })
      : null,
    row.research_id,
  );
  await workflows.replaceBlockers(
    {
      projectId: row.project_id,
      instanceId: row.research_id,
      provider: AUTOMATIC_PROVIDER,
      blockers: blocker ? [{ key: 'automatic', ...blocker, next: NEXT, related: [] }] : [],
    },
    tx,
  );
}

const CONSUMER = 'research.automatic.v3';
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
        try {
          const source = JSON.parse(row.source_json) as DelegationSource;
          await scope.requireDelegation(source, 'write', tx);
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
          if (error.status === 503) unavailable(row);
        }
        await publishBlocker(workflows, row, blocker, tx);
      }
    },
  });
}

export const automaticBlocker = (error: MervError): AutomaticBlocker => ({
  code: error.code,
  message: clip(error.message, 2000),
  status: error.status,
});

export const automaticRequest = (cycle: string, revision: number, action: string) =>
  `research-auto:${digest({ cycle, revision, action })}`;

// Automatic progress, as ResearchService (index.ts) runs it as its own methods: binding the
// consumer, waking cycles, the advance it makes, and closing work a failed input stranded.
/** Subscribe through the existing engine's durable events; workers keep their fixed grants. */
export async function bindAutomatic(
  this: ResearchService,
  events: DomainEvents,
): Promise<() => void | Promise<void>> {
  this.open();
  const release = await automaticResearch(
    this.state,
    this.scope,
    this.workflows,
    events,
    async (caller, row, tx) => await this.reconcileAutomatic(caller, row, tx),
    (row) => this.retryUnavailable(row),
  );
  try {
    await this.wakeAutomatic();
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
  this: ResearchService,
  row: AutomaticRow,
  since = Date.now(),
): void {
  if (this.retrying.has(row.project_id)) return;
  this.retrying.add(row.project_id);
  const wake = async () => {
    this.retrying.delete(row.project_id);
    if (this.closed) return;
    const source = JSON.parse(row.source_json) as DelegationSource;
    await this.state.transaction(async (tx) => {
      const out = await tx.all<{ blocker_json: string | null }>(
        'SELECT blocker_json FROM research_automation WHERE project_id=? AND blocker_json IS NOT NULL',
        row.project_id,
      );
      if (
        !out.some(
          (item) => Date.now() - unavailableSince(item.blocker_json) <= this.unavailableForMs,
        )
      )
        return;
      await this.state.appendEvent(tx, {
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
      if (Date.now() - since < this.unavailableForMs) this.retryUnavailable(row, since);
    });
  this.detached(() => setTimeout(retry, this.retryAfterMs).unref());
}

/** Startup must also revisit events previously consumed while blocked. */
export async function wakeAutomatic(this: ResearchService): Promise<void> {
  if (this.closed) return;
  await this.state.transaction(async (tx) => {
    // One resume per project: its consumer reconciles every open cycle there.
    const cycles = await this.workflows.open('research', null, tx);
    const rows = await tx.all<{ project_id: string; source_json: string; research_id: string }>(
      'SELECT DISTINCT ON (project_id) project_id,source_json,research_id FROM research_automation WHERE research_id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY project_id,cycle_index,research_id',
      JSON.stringify(cycles.map((cycle) => cycle.id)),
    );
    for (const row of rows)
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: JSON.parse(row.source_json).actorId,
        type: 'research.resume',
        subjectId: row.research_id,
        data: { performedBy: 'system:research' },
      });
  });
}

export async function reconcileAutomatic(
  this: ResearchService,
  caller: Caller,
  automatic: AutomaticRow,
  tx: Transaction,
): Promise<AutomaticBlocker> {
  this.open();
  const record = await this.get(caller, automatic.research_id, tx);
  await this.authorize(caller, record, tx);
  if (definition.terminal.includes(record.workflow.state)) return null;
  if (record.workflow.state === 'defining' && record.previousCycleId) {
    const previous = await this.get(caller, record.previousCycleId, tx);
    const current = await this.definition(caller, tx);
    check(
      !previous.problem || current.revision === previous.problem.revision,
      'research_definition_changed',
      'The project definition changed; explicitly accept it before continuing this automatic run',
      409,
    );
  }
  if (record.workflow.state === 'researching') await this.closeBlockedWork(caller, record, tx);
  const atLimit = automatic.cycle_index >= automatic.max_cycles;
  const nextWave = atLimit ? 'skip' : 'create';
  const guidance = await this.workflows.evaluate(
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
    advanced = await this.advance(caller, input, tx);
  } catch (error) {
    // Git is asked outside every transaction, so the same advance runs again on its own.
    if (error instanceof MervError && error.code === 'integration_candidates_unavailable')
      this.soon(caller, automatic, input, automaticBlocker(error));
    throw error;
  }
  await this.event(
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
  return null;
}

/**
 * The advance the consumer could not make, run on its own after its transaction, outside
 * every transaction's context. Success is a transition event the consumer answers; a
 * refusal is written only over the marker the consumer left, so a reconcile since is never
 * overwritten and nothing loops: the marker returns on the next event, today's retry cadence.
 */
export function soon(
  this: ResearchService,
  caller: Caller,
  row: AutomaticRow,
  input: ResearchAdvance,
  marker: AutomaticBlocker,
): void {
  if (this.closed) return;
  const run = async () => {
    try {
      await this.advance(caller, input);
    } catch (error) {
      if (
        this.closed ||
        !(error instanceof MervError) ||
        (error.status >= 500 && error.status !== 503)
      )
        return;
      await this.state.transaction(async (tx) => {
        const left = (await this.workflows.blockers(caller, row.research_id, tx)).find(
          (item) => item.provider === AUTOMATIC_PROVIDER,
        );
        if (left?.code === marker?.code && left?.message === marker?.message)
          await publishBlocker(this.workflows, row, automaticBlocker(error), tx);
      });
    }
  };
  // Outside the consumer's transaction, whose commit its own transaction waits for.
  this.detached(() => queueMicrotask(() => void run().catch(() => undefined)));
}

/**
 * A permanently failed input cannot strand never-started work in this selected wave, or the
 * work between it and that input.
 */
export async function closeBlockedWork(
  this: ResearchService,
  caller: Caller,
  record: ResearchRecord,
  tx: Transaction,
) {
  const remaining = new Set<string>();
  for (const id of record.researchDependencies)
    for (const item of await this.workflows.dependencyClosure(caller, id, tx)) remaining.add(item);
  for (let pass = 0, passes = remaining.size; remaining.size && pass < passes; pass++) {
    let changed = false;
    for (const id of [...remaining]) {
      const work = await this.workflows.get(caller, id, tx);
      if (
        !['task', 'experiment'].includes(work.workflow) ||
        !['in_progress', 'planned'].includes(work.state)
      ) {
        remaining.delete(id);
        continue;
      }
      // Never cancel a running producer or review to close a wave.
      if ((await this.workflows.workStarts(caller, id, tx)).length) {
        remaining.delete(id);
        continue;
      }
      const failed = (await this.workflows.prerequisites(caller, [id], tx))
        .get(id)!
        .filter((item) => item.failed);
      if (!failed.length) continue;
      // Work between the selection and the failed input is not the cycle's own to reflect on.
      const after = record.researchDependencies.includes(id)
        ? `Retained for reflection in ${record.name}.`
        : `Closed because work selected by ${record.name} waits on it.`;
      const reason = clip(
        `Not run: required input ended without success: ${failed.map((item) => `${item.name} (${item.id}, ${item.state})`).join(', ')}. ${after}`,
        16000,
      );
      const requestId = automaticRequest(record.id, work.revision, `close:${id}`);
      if (work.workflow === 'task') {
        await this.providers.tasks.markFailed(
          caller,
          { taskId: id, expectedRevision: work.revision, reason, requestId },
          tx,
        );
      } else {
        await this.providers.experiments.transition(
          caller,
          {
            experimentId: id,
            expectedRevision: work.revision,
            transition: 'abandon',
            evidence: { reason },
            requestId,
          },
          tx,
        );
      }
      await this.event(
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
      remaining.delete(id);
      changed = true;
    }
    if (!changed) break;
  }
}
