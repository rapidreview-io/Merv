import { AsyncResource } from 'node:async_hooks';
import type { Tasks } from '@merv/tasks/types';
import type { Code } from '@merv/code-work/types';
import {
  check,
  clip,
  createService,
  inTransaction,
  mapAsync,
  recorded,
  childRequest,
  replayed,
  type Artifact,
  type Artifacts,
  type Actor,
  type Caller,
  type Data,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { CheckedTransitions } from '@merv/workflows/rules';
import { permits } from '@merv/scope/rules';
import type { Experiments } from '@merv/experiments/types';
import { problemDefined } from '@merv/paper/rules';
import type { Paper, PaperRevision } from '@merv/paper/types';
import type { Reflections } from '@merv/reflections/types';
import type { Context } from 'cordis';
import {
  AUTOMATIC_PROVIDER,
  bindAutomatic,
  needsOwner,
  publishBlocker,
  type AutomaticRow,
} from './automatic.js';
import { digested } from './compose.js';
import { postgresMigrations } from './index.postgres.js';
import { advanceSchema, createSchema, endSchema, getSchema, parse, replanSchema } from './input.js';
import {
  begin,
  continuing,
  follow,
  inject,
  materialise,
  ready,
  unpublished,
  type Choice,
} from './integration.js';
import { definition, policy, type Stage } from './policy.js';
import type {
  Research,
  ResearchAdvance,
  ResearchAutomation,
  ResearchCreate,
  ResearchEnd,
  ResearchLineage,
  ResearchOrigin,
  ResearchRecord,
  ResearchReplan,
} from './types.js';
export { definition } from './policy.js';
export type * from './types.js';
/** What Research asks of Code; a test may hand it exactly this much. */
type ResearchCode = Pick<Code, 'acceptedSince' | 'hosted' | 'publishOnAcceptance' | 'unit'>;
/** The plugins whose work a cycle coordinates; every one is required. */
export interface Providers {
  paper: Paper;
  reflections: Reflections;
  tasks: Tasks;
  experiments: Experiments;
  artifacts: Artifacts;
  code: ResearchCode;
}
const ENDING_REASON_CHARS = 2000;
/** How far research.lineage walks back before it says the chain goes on. */
const LINEAGE_LIMIT = 20;
interface Row {
  id: string;
  record: string;
  problem: string | null;
  reflection_id: string | null;
  predecessor_id: string | null;
  digest: string | null;
  integrations: string | null;
}
/** The immutable inputs as stored; which cycle it follows lives in predecessor_id alone. */
export type StoredRecord = Pick<
  ResearchRecord,
  'id' | 'projectId' | 'ownerId' | 'name' | 'createdAt' | 'researchDependencies'
> & { origin?: Omit<ResearchOrigin, 'researchId'> };

/**
 * What the modules read of the service: the gate's policy (policy.ts), how a cycle moves
 * (integration.ts), its digest (compose.ts) and automatic progress (automatic.ts).
 */
export type ResearchContext = Pick<
  ResearchService,
  | 'advance'
  | 'authorize'
  | 'checked'
  | 'children'
  | 'closed'
  | 'definition'
  | 'detached'
  | 'event'
  | 'get'
  | 'handle'
  | 'open'
  | 'providers'
  | 'retryAfterMs'
  | 'retrying'
  | 'row'
  | 'scope'
  | 'state'
  | 'unavailableForMs'
  | 'workflows'
>;
/** A small coordinator over existing workflows; child programs own their actual assignments. */
export class ResearchService implements Research {
  closed = false;
  /** Projects with a retry already waiting: one resume reconciles every cycle there. */
  readonly retrying = new Set<string>();
  /** Runs a callback in the context this service was made in, outside every transaction. */
  readonly detached = AsyncResource.bind((fn: () => void) => fn());
  handle?: Awaited<ReturnType<Workflows['register']>>;
  readonly checked = new CheckedTransitions();
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly workflows: Workflows,
    readonly providers: Providers,
    /** How long a cycle an outage refused waits before it is tried again. */
    readonly retryAfterMs = 30_000,
    /** How long an outage keeps a cycle being tried again before only an event or a bind wakes it. */
    readonly unavailableForMs = 10 * 60_000,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('research', postgresMigrations);
    this.handle = await this.workflows.register(definition, policy(this));
  }

  open() {
    check(!this.closed, 'research_unavailable', 'Research is unavailable', 503);
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    parse(getSchema, { researchId: id });
    return await inTransaction(this.state, transaction, async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      return await this.record(caller, await this.row(caller, id, tx), tx, actor);
    });
  }
  /**
   * Where an automatic run stands: the blocker Research published for the cycle (on an ended
   * one, what its plan asks of the owner), or the run finished its authorized cycles here while
   * its plan wanted another (a reflection that chose to stop ended the run itself).
   */
  private async automation(
    caller: Caller,
    row: AutomaticRow,
    record: Pick<ResearchRecord, 'workflow' | 'reflectionId'>,
    successorId: string | null,
    tx: Transaction,
  ): Promise<ResearchAutomation> {
    const { workflow } = record;
    const status = { rootId: row.root_id, cycle: row.cycle_index, maxCycles: row.max_cycles };
    const published = (await this.workflows.blockers(caller, row.research_id, tx)).find(
      (item) => item.provider === AUTOMATIC_PROVIDER,
    );
    // An ended cycle keeps only what it asks of its owner.
    if (published)
      return { ...status, blocker: { code: published.code, message: published.message } };
    if (definition.terminal.includes(workflow.state))
      return {
        ...status,
        blocker:
          workflow.state === 'complete' &&
          !successorId &&
          row.cycle_index >= row.max_cycles &&
          // A reflection that cannot be read leaves the limit as what it may have been.
          !!(await continuing(this, caller, record as ResearchRecord, tx, 'complete').catch(
            () => true,
          ))
            ? {
                code: 'research_cycle_limit',
                message: `Finished the authorized ${row.max_cycles} research cycles; no further wave was created`,
              }
            : null,
      };
    return { ...status, blocker: null };
  }
  /** The cycle a row describes, for a caller already authorized to read it. */
  private async record(
    caller: Caller,
    row: Row,
    tx: Transaction,
    actor: Actor,
  ): Promise<ResearchRecord> {
    const integrations: string[] = row.integrations ? JSON.parse(row.integrations) : [];
    // The selection is what the cycle waits on now, not what it was created with.
    const children = [row.reflection_id, ...integrations];
    const { origin, ...record } = JSON.parse(row.record) as StoredRecord;
    const successor = await tx.get<{ id: string }>(
      'SELECT id FROM research_cycles WHERE predecessor_id=? AND project_id=?',
      row.id,
      caller.projectId,
    );
    const automatic = await tx.get<AutomaticRow>(
      'SELECT * FROM research_automation WHERE research_id=?',
      row.id,
    );
    const workflow = await this.workflows.get(caller, row.id, tx);
    const selected = (await this.workflows.prerequisites(caller, [row.id], tx))
      .get(row.id)!
      .filter((item) => !children.includes(item.id));
    return {
      ...record,
      automation: automatic
        ? await this.automation(
            caller,
            automatic,
            { workflow, reflectionId: row.reflection_id },
            successor?.id ?? null,
            tx,
          )
        : null,
      // The column is the one statement of which cycle this follows; the record pins the rest.
      origin: origin && row.predecessor_id ? { researchId: row.predecessor_id, ...origin } : null,
      successorId: successor?.id ?? null,
      previousCycleId: row.predecessor_id,
      digest: row.digest ? (JSON.parse(row.digest) as Artifact) : null,
      researchDependencies: selected.map((item) => item.id),
      progress: {
        settled: selected.filter((item) => item.settled).length,
        total: selected.length,
      },
      workflow,
      problem: row.problem ? JSON.parse(row.problem) : null,
      reflectionId: row.reflection_id,
      integrations,
      // What authorize asks, as the reader's role answers it: a page offers this reader the
      // cycle's moves only where Research would take them.
      writable:
        !caller.session &&
        permits(actor.role, 'write') &&
        (caller.actorId === record.ownerId || permits(actor.role, 'admin')),
    };
  }
  async row(caller: Caller, id: string, tx: Transaction): Promise<Row> {
    const row = await tx.get<Row>(
      'SELECT * FROM research_cycles WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'research_not_found', 'Research cycle was not found in this project', 404);
    return row;
  }
  async list(caller: Caller, transaction?: Transaction): Promise<ResearchRecord[]> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<Row>(
          'SELECT * FROM research_cycles WHERE project_id=? ORDER BY _merv_rowid',
          caller.projectId,
        ),
        async (row) => await this.record(caller, row, tx, actor),
      );
    });
  }
  /**
   * What Home and the rail poll, which must not grow with the project's history: every open
   * cycle, and the newest that ended, which the next cycle follows and which keeps what an
   * automatic run asks of its owner. Every cycle is `list`'s, read when a page asks for it.
   */
  async home(caller: Caller): Promise<ResearchRecord[]> {
    this.open();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      const open = (await this.workflows.open('research', caller.projectId, tx)).map(
        (item) => item.id,
      );
      const rows = await tx.all<Row>(
        `SELECT * FROM research_cycles WHERE project_id=? AND (id IN (SELECT jsonb_array_elements_text(?::jsonb))
          OR _merv_rowid=(SELECT MAX(_merv_rowid) FROM research_cycles WHERE project_id=? AND id NOT IN (SELECT jsonb_array_elements_text(?::jsonb))))
          ORDER BY _merv_rowid`,
        caller.projectId,
        JSON.stringify(open),
        caller.projectId,
        JSON.stringify(open),
      );
      return await mapAsync(rows, async (row) => await this.record(caller, row, tx, actor));
    });
  }
  /** How many cycles are still open, for the navigation badge, without reading each one. */
  async active(caller: Caller): Promise<number> {
    this.open();
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return (await this.workflows.open('research', caller.projectId, tx)).length;
    });
  }
  async create(
    caller: Caller,
    value: ResearchCreate,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(createSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'create', input, tx, async () => {
        if (input.previousCycleId) {
          await follow(this, caller, input.previousCycleId, tx);
          // What the ended cycle asked of its owner is answered by the cycle that follows it.
          await publishBlocker(
            this.workflows,
            { project_id: caller.projectId, research_id: input.previousCycleId },
            null,
            tx,
          );
        } else if (!caller.session) {
          // A cycle its owner starts by hand without naming one answers the latest run that
          // stopped for that owner all the same; anyone else's cycle leaves the decision theirs.
          const asked = (await this.workflows.blockers(caller, undefined, tx))
            .filter((item) => item.provider === AUTOMATIC_PROVIDER)
            .filter((item) => item.code === 'research_needs_owner')
            .at(-1);
          const ended = asked && (await this.get(caller, asked.instanceId, tx));
          if (
            ended &&
            (caller.actorId === ended.ownerId ||
              (await this.scope.eligible(caller.projectId, caller.actorId, 'admin', tx)))
          )
            await publishBlocker(
              this.workflows,
              { project_id: caller.projectId, research_id: ended.id },
              null,
              tx,
            );
        }
        return await begin(this, caller, input, 'create', null, tx);
      });
    });
  }
  async authorize(caller: Caller, record: ResearchRecord, tx: Transaction) {
    await this.scope.require(caller, 'write', tx);
    check(
      !caller.session,
      'forbidden',
      'Assigned workers cannot advance the outer research cycle',
      403,
    );
    if (caller.actorId !== record.ownerId) await this.scope.require(caller, 'admin', tx);
  }
  async definition(caller: Caller, tx: Transaction): Promise<PaperRevision> {
    const problem = (await this.providers.paper.documents(caller, tx)).problem.current;
    check(
      problemDefined(problem),
      'research_definition_required',
      'Fill the problem, scope, goals and constraints before starting research',
      409,
    );
    return problem;
  }
  async lineage(caller: Caller, id: string, transaction?: Transaction): Promise<ResearchLineage> {
    this.open();
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const asked = await this.get(caller, id, tx);
      const cycles = [asked];
      while (cycles[0].previousCycleId && cycles.length < LINEAGE_LIMIT)
        cycles.unshift(await this.get(caller, cycles[0].previousCycleId, tx));
      const successor = asked.successorId ? await this.get(caller, asked.successorId, tx) : null;
      return {
        researchId: id,
        cycles: cycles.map((cycle) => ({
          id: cycle.id,
          name: cycle.name,
          state: cycle.workflow.state,
          createdAt: cycle.createdAt,
          previousCycleId: cycle.previousCycleId,
          reflectionId: cycle.reflectionId,
          digest: cycle.digest,
        })),
        truncated: !!cycles[0].previousCycleId,
        successor: successor && {
          id: successor.id,
          name: successor.name,
          state: successor.workflow.state,
        },
      };
    });
  }

  /**
   * The owner reselects the work a cycle waits on while it is still defining or researching;
   * unsuccessful work stays selected as an outcome unless the owner drops it. The cycle's own
   * children (its reflection, its consolidation tasks) are never part of the selection.
   */
  async replan(
    caller: Caller,
    value: ResearchReplan,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    caller = structuredClone(caller);
    const input = parse(replanSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      return await this.command(caller, 'replan', input, tx, async () => {
        check(
          ['defining', 'researching'].includes(record.workflow.state),
          'invalid_transition',
          'A cycle is replanned before it reflects',
          409,
        );
        const current = record.researchDependencies;
        await this.handle!.addDependencies(
          caller,
          {
            instanceId: record.id,
            expectedRevision: input.expectedRevision,
            dependsOn: input.dependsOn.filter((id) => !current.includes(id)),
            drop: current.filter((id) => !input.dependsOn.includes(id)),
            requestId: childRequest(caller, 'research', 'replan', input.requestId),
          },
          tx,
        );
        return await this.get(caller, record.id, tx);
      });
    });
  }

  /**
   * End a cycle that cannot reach an answer. Its children keep their own records and their
   * own endings; what ends here is the coordination.
   */
  async end(
    caller: Caller,
    value: ResearchEnd,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(endSchema, value);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      return await this.command(caller, 'end', input, tx, async () => {
        // A completed run whose plan stopped for its owner ends with their decision to stop.
        if (record.automation?.blocker?.code === 'research_needs_owner') {
          await publishBlocker(
            this.workflows,
            { project_id: caller.projectId, research_id: record.id },
            null,
            tx,
          );
          await this.event(
            caller,
            'stopped',
            record.id,
            { decision: 'stop', reason: clip(input.reason, ENDING_REASON_CHARS) },
            tx,
          );
          return await this.get(caller, record.id, tx);
        }
        const action = input.outcome === 'failed' ? 'mark_failed' : 'abandon';
        const moved = await this.checked.take(
          tx,
          { instanceId: record.id, revision: record.workflow.revision, action },
          () =>
            this.handle!.transition(
              caller,
              {
                instanceId: record.id,
                expectedRevision: input.expectedRevision,
                action,
                input: { outcome: input.outcome, reason: input.reason },
                // Kept on the cycle, clipped, so a digest composed later can still say why it ended.
                data: { reason: clip(input.reason, ENDING_REASON_CHARS) },
                requestId: childRequest(caller, 'research', 'end', input.requestId),
              },
              tx,
            ),
        );
        await this.event(
          caller,
          'ended',
          record.id,
          { from: record.workflow.state, to: moved.state, reason: input.reason },
          tx,
        );
        const ended = await this.get(caller, record.id, tx);
        ended.digest = await digested(this, caller, ended, tx, false);
        return ended;
      });
    });
  }

  async advance(
    caller: Caller,
    value: ResearchAdvance,
    transaction?: Transaction,
  ): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    const input = parse(advanceSchema, value);
    // Git answers what main lacks outside every transaction, so it is asked before this opens.
    const since = await unpublished(this, caller, input.researchId, transaction);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      return await this.command(caller, 'advance', input, tx, async () => {
        check(
          record.workflow.revision === input.expectedRevision,
          'revision_conflict',
          'The research cycle changed; read its current revision',
          409,
        );
        const handle = this.handle!;
        const { move, continuing, abandoned } = await ready(this, caller, record, tx, input, since);
        const injecting = move === 'inject' || move === 'reinject';
        check(
          !continuing || input.nextWave,
          'next_wave_choice_required',
          'The approved reflection carries a plan that continues. Call research.advance with nextWave: "create" to open its tasks, experiments and the next research cycle, or nextWave: "skip" to complete this cycle without them',
          400,
        );
        const childIds: string[] = [];
        if (injecting)
          childIds.push(await inject(this, caller, record, since!, input.requestId, tx));
        switch (record.workflow.state as Stage) {
          case 'defining': {
            const problem = await this.definition(caller, tx);
            await tx.run(
              'UPDATE research_cycles SET problem=? WHERE id=?',
              JSON.stringify(problem),
              record.id,
            );
            break;
          }
          case 'researching': {
            // A predecessor a plan opened this cycle from may have no digest yet; it is
            // composed now, late.
            const carried = record.previousCycleId
              ? await digested(
                  this,
                  caller,
                  await this.get(caller, record.previousCycleId, tx),
                  tx,
                  true,
                )
              : null;
            const wave = await this.providers.reflections.create(
              caller,
              {
                title: `${clip(record.name, 288)}: reflection`,
                ...(record.automation ? { requirePlan: true } : {}),
                // Absent rather than null, so a cycle that follows nothing replays as before.
                ...(carried ? { previousCycleDigestId: carried.id } : {}),
                requestId: childRequest(caller, 'research', 'reflection', input.requestId),
              },
              tx,
            );
            await tx.run(
              'UPDATE research_cycles SET reflection_id=? WHERE id=?',
              wave.id,
              record.id,
            );
            childIds.push(wave.id);
            break;
          }
        }
        // The guard inside the transition judges the same choices the preflight did, and the
        // move Git's answer decided, which it cannot ask for itself.
        const choice: Choice = {
          ...(input.nextWave ? { nextWave: input.nextWave } : {}),
          ...(input.retryIntegration ? { retryIntegration: true } : {}),
          move,
        };
        const action = move === 'inject' ? 'advance' : move;
        const moved = await this.checked.take(
          tx,
          { instanceId: record.id, revision: record.workflow.revision, action },
          () =>
            handle.transition(
              caller,
              {
                instanceId: record.id,
                expectedRevision: input.expectedRevision,
                action,
                input: choice,
                requestId: childRequest(caller, 'research', 'advance', input.requestId),
              },
              tx,
            ),
        );
        // After the move, so every guard judged the project as it was before the plan's work
        // existed: seven planned experiments would otherwise refuse themselves.
        const successor = continuing
          ? await materialise(this, caller, record, continuing, input.requestId, tx)
          : undefined;
        if (injecting)
          await tx.run(
            'UPDATE research_cycles SET integrations=? WHERE id=?',
            JSON.stringify([...record.integrations, ...childIds]),
            record.id,
          );
        if (childIds.length)
          await handle.addDependencies(
            caller,
            {
              instanceId: record.id,
              expectedRevision: moved.revision,
              dependsOn: childIds,
              requestId: childRequest(caller, 'research', 'children', input.requestId),
            },
            tx,
          );
        // A cycle that moved is no longer held by what its automation said before, though
        // one that ended asks its owner what its plan stopped for.
        if (record.automation)
          await publishBlocker(
            this.workflows,
            { project_id: caller.projectId, research_id: record.id },
            await needsOwner(
              this,
              caller,
              {
                id: record.id,
                workflow: { state: moved.state },
                successorId: successor?.id ?? null,
                reflectionId: record.reflectionId,
              },
              tx,
            ),
            tx,
          );
        await this.event(
          caller,
          'advanced',
          record.id,
          {
            from: record.workflow.state,
            to: moved.state,
            children: childIds,
            // Quarantined acceptances are unpublished code the task may not build on.
            ...(injecting && since?.quarantined.length ? { quarantined: since.quarantined } : {}),
            ...(successor ? { successorId: successor.id } : {}),
            ...(abandoned ? { integration: 'abandoned' } : {}),
            ...(moved.state === 'complete' && input.nextWave === 'skip'
              ? { nextWave: 'skipped' }
              : {}),
          },
          tx,
        );
        const advanced = await this.get(caller, record.id, tx);
        if (moved.state === 'complete')
          advanced.digest = await digested(this, caller, advanced, tx, false);
        return advanced;
      });
    });
  }
  children(record: ResearchRecord): string[] {
    return [record.reflectionId, ...record.integrations].filter((id): id is string => !!id);
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'research_commands', caller, operation, input, execute);
  }
  async event(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await recorded(this.state, tx, caller, `research.${type}`, id, data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.handle?.dispose();
  }
}
export const researchPlugin = {
  name: 'merv-research',
  inject: [
    'state',
    'scope',
    'workflows',
    'domainEvents',
    'paper',
    'reflections',
    'tasks',
    'experiments',
    'artifacts',
    'codeWork',
  ],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new ResearchService(ctx.state, ctx.scope, ctx.workflows, {
          paper: ctx.paper,
          reflections: ctx.reflections,
          tasks: ctx.tasks,
          experiments: ctx.experiments,
          artifacts: ctx.artifacts,
          code: ctx.codeWork,
        }),
      );
      yield () => service.close();
      yield await bindAutomatic(service, ctx.domainEvents);
      yield ctx.provide('research', service);
    });
  },
};
export default researchPlugin;
