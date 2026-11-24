import { AsyncResource } from 'node:async_hooks';
import type { Tasks } from '@merv/tasks/types';
import type { Code } from '@merv/code-work/types';
import {
  check,
  clip,
  createService,
  digest,
  inTransaction,
  mapAsync,
  recorded,
  childRequest,
  replayed,
  RequestJournal,
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
import type { ProcessGraph } from '@merv/workflows/models';
import { permits } from '@merv/scope/rules';
import type { Experiments } from '@merv/experiments/types';
import { problemDefined } from '@merv/paper/rules';
import type { Paper, PaperRevision } from '@merv/paper/types';
import type { Context } from 'cordis';
import { AUTOMATIC_PROVIDER, bindAutomatic, publishBlocker } from './automatic.js';
import { digested } from './compose.js';
import { postgresMigrations } from './index.postgres.js';
import { advanceSchema, createSchema, endSchema, getSchema, parse, replanSchema } from './input.js';
import { begin, follow, inject, ready, selectable, type Choice } from './integration.js';
import { definition, policy } from './policy.js';
import type {
  Research,
  ResearchAdvance,
  ResearchAutomation,
  ResearchCreate,
  ResearchEnd,
  ResearchLineage,
  ResearchRecord,
  ResearchReplan,
} from './types.js';
export type * from './types.js';
/** What Research asks of Code; a test may hand it exactly this much. */
type ResearchCode = Pick<Code, 'acceptedSince' | 'hosted' | 'publishOnAcceptance' | 'unit'>;
/** The plugins whose work a cycle coordinates; every one is required. */
export interface Providers {
  paper: Paper;
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
  predecessor_id: string | null;
  digest: string | null;
  integrations: string | null;
}
/** The immutable inputs as stored; which cycle it follows lives in predecessor_id alone. */
export type StoredRecord = Pick<
  ResearchRecord,
  'id' | 'projectId' | 'ownerId' | 'name' | 'createdAt' | 'researchDependencies'
>;

/**
 * What the modules read of the service: the gate's policy (policy.ts), how a cycle moves
 * (integration.ts), its digest (compose.ts) and automatic progress (automatic.ts).
 */
export type ResearchContext = Pick<
  ResearchService,
  | 'advance'
  | 'authorize'
  | 'checked'
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
  async page(
    caller: Caller,
    id: string,
  ): Promise<{ record: ResearchRecord; process: ProcessGraph }> {
    caller = structuredClone(caller);
    return await this.state.snapshot(async () => ({
      record: await this.get(caller, id),
      process: await this.workflows.process(caller, id, { checks: false }),
    }));
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
  /** Where an automatic cycle stands: the blocker Research published for it, if any. */
  private async automation(
    caller: Caller,
    id: string,
    tx: Transaction,
  ): Promise<ResearchAutomation> {
    const published = (await this.workflows.blockers(caller, id, tx)).find(
      (item) => item.provider === AUTOMATIC_PROVIDER,
    );
    return { blocker: published ? { code: published.code, message: published.message } : null };
  }
  /** The cycle a row describes, for a caller already authorized to read it. */
  private async record(
    caller: Caller,
    row: Row,
    tx: Transaction,
    actor: Actor,
  ): Promise<ResearchRecord> {
    const integrations: string[] = row.integrations ? JSON.parse(row.integrations) : [];
    // The selection is what the cycle waits on now, not what it was created with. A research@6
    // cycle a reflection's plan opened also stored that plan's origin, which nothing reads now.
    const { origin: _origin, ...record } = JSON.parse(row.record) as StoredRecord & {
      origin?: unknown;
    };
    const successor = await tx.get<{ id: string }>(
      'SELECT id FROM research_cycles WHERE predecessor_id=? AND project_id=?',
      row.id,
      caller.projectId,
    );
    const automatic = await tx.get<{ research_id: string }>(
      'SELECT research_id FROM research_automation WHERE research_id=?',
      row.id,
    );
    const workflow = await this.workflows.get(caller, row.id, tx);
    const selected = (await this.workflows.prerequisites(caller, [row.id], tx))
      .get(row.id)!
      .filter((item) => !integrations.includes(item.id));
    return {
      ...record,
      automation: automatic ? await this.automation(caller, row.id, tx) : null,
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
   * cycle, the newest that ended, which the next cycle follows, and every ended cycle that still
   * asks somebody to move. Every cycle is `list`'s, read when a page asks for it.
   */
  async home(caller: Caller): Promise<ResearchRecord[]> {
    this.open();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      const open = (await this.workflows.open('research', caller.projectId, tx)).map(
        (item) => item.id,
      );
      // What a cycle asks of somebody is the blocker Research published to Workflows, and
      // nothing kept beside it: an ending clears it there.
      const asking = (await this.workflows.blockers(caller, undefined, tx))
        .filter((item) => item.provider === AUTOMATIC_PROVIDER && item.whose)
        .map((item) => item.instanceId);
      const rows = await tx.all<Row>(
        `SELECT * FROM research_cycles WHERE project_id=? AND (id IN (SELECT jsonb_array_elements_text(?::jsonb))
          OR _merv_rowid=(SELECT MAX(_merv_rowid) FROM research_cycles WHERE project_id=? AND id NOT IN (SELECT jsonb_array_elements_text(?::jsonb))))
          ORDER BY _merv_rowid`,
        caller.projectId,
        JSON.stringify([...open, ...asking]),
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
        if (input.previousCycleId) await follow(this, caller, input.previousCycleId, tx);
        return await begin(this, caller, input, tx);
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
   * consolidation tasks are never part of the selection.
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
          'A cycle is replanned while it is still defining or researching',
          409,
        );
        if (record.automation) await selectable(this, caller, { ...input, automatic: true }, tx);
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
        // Ending forgets whatever the run said of the cycle, an outage's first sighting too.
        if (record.automation)
          await publishBlocker(
            this.workflows,
            { project_id: caller.projectId, research_id: record.id },
            null,
            tx,
          );
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
    // An already committed advance needs its receipt, not a new Git answer for its new stage.
    const prepared = await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      const previous = await new RequestJournal(
        tx,
        { table: 'research_commands' },
        caller.projectId,
        caller.actorId,
        input.requestId,
        digest({ operation: 'advance', input }),
      ).previous();
      return previous
        ? { previous: JSON.parse(previous.result) as ResearchRecord }
        : {
            hosted:
              ['researching', 'consolidating'].includes(record.workflow.state) &&
              (await this.providers.code.hosted(caller, tx)),
          };
    });
    if (prepared.previous) return prepared.previous;
    // Git answers outside every transaction; an advance already inside one cannot ask it.
    const since = prepared.hosted
      ? transaction
        ? null
        : await this.providers.code.acceptedSince(caller)
      : { unitIds: [], quarantined: [] };
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
        const { move, abandoned } = await ready(this, caller, record, tx, input, since);
        const injecting = move === 'inject' || move === 'reinject';
        const childIds: string[] = [];
        if (injecting)
          childIds.push(await inject(this, caller, record, since!, input.requestId, tx));
        if (record.workflow.state === 'defining')
          await tx.run(
            'UPDATE research_cycles SET problem=? WHERE id=?',
            JSON.stringify(await this.definition(caller, tx)),
            record.id,
          );
        // The guard inside the transition judges the same choices the preflight did, and the
        // move Git's answer decided, which it cannot ask for itself.
        const choice: Choice = {
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
        // A cycle that moved is no longer held by what its automation said before.
        if (record.automation)
          await publishBlocker(
            this.workflows,
            { project_id: caller.projectId, research_id: record.id },
            null,
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
            ...(abandoned ? { integration: 'abandoned' } : {}),
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
