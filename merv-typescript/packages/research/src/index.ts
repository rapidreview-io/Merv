import { AsyncResource } from 'node:async_hooks';
import type { ServiceTaskCreator, Tasks } from '@merv/tasks/types';
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
  type Caller,
  type Data,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import { CheckedTransitions } from '@merv/workflows/rules';
import type { Experiments } from '@merv/experiments/types';
import { problemDefined } from '@merv/paper/rules';
import type { Paper, PaperRevision } from '@merv/paper/types';
import type { Reflections } from '@merv/reflections/types';
import type { Context } from 'cordis';
import {
  AUTOMATIC_PROVIDER,
  bindAutomatic,
  closeBlockedWork,
  publishBlocker,
  reconcileAutomatic,
  retryUnavailable,
  soon,
  wakeAutomatic,
  type AutomaticRow,
} from './automatic.js';
import { compose, digested } from './compose.js';
import { postgresMigrations } from './index.postgres.js';
import { advanceSchema, createSchema, endSchema, getSchema, parse, replanSchema } from './input.js';
import {
  asked,
  begin,
  checkAutomaticContinuation,
  continuing,
  creatable,
  follow,
  inject,
  materialise,
  move,
  ready,
  retainedCode,
  selectedCode,
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
/** What Research asks of Code; a test may bind exactly this much. */
type ResearchCode = Pick<Code, 'acceptedSince' | 'hosted' | 'publishOnAcceptance' | 'unit'>;
export interface Capabilities {
  paper: Paper;
  reflections: Reflections;
  tasks: Tasks;
  integrations: ServiceTaskCreator;
  experiments: Experiments;
  artifacts: Artifacts;
  code: ResearchCode;
}
type Binding<T> = { value: T };
export type BindingChecks = (() => void)[];
const unavailable = {
  paper: 'This stage needs Paper; enable it to continue',
  reflections: 'This stage needs Reflections; enable it to continue',
  tasks:
    'Creating the approved plan\'s work needs Tasks; enable it, or complete this cycle with nextWave: "skip"',
  integrations: 'Injecting the consolidation task needs Tasks; enable it to continue',
  experiments:
    'Creating the approved plan\'s experiments needs Experiments; enable it, or complete this cycle with nextWave: "skip"',
  artifacts: "Artifacts are unavailable, so the predecessor cycle's digest cannot be retained",
  code: 'This stage needs Code; enable it to continue',
};
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
  code_required: number | null;
}
/** The immutable inputs as stored; which cycle it follows lives in predecessor_id alone. */
export type StoredRecord = Pick<
  ResearchRecord,
  'id' | 'projectId' | 'ownerId' | 'name' | 'createdAt' | 'researchDependencies'
> & { origin?: Omit<ResearchOrigin, 'researchId'> };

/** A small coordinator over existing workflows; child programs own their actual assignments. */
export class ResearchService implements Research {
  // The gate's policy (policy.ts), how a cycle moves (integration.ts), its digest (compose.ts)
  // and automatic progress (automatic.ts) are this service's own methods, kept by concept.
  readonly policy = policy;
  readonly follow = follow;
  readonly begin = begin;
  readonly ready = ready;
  readonly move = move;
  readonly asked: typeof asked = asked;
  readonly continuing = continuing;
  readonly creatable = creatable;
  readonly checkAutomaticContinuation = checkAutomaticContinuation;
  readonly materialise = materialise;
  readonly inject = inject;
  readonly selectedCode = selectedCode;
  readonly retainedCode = retainedCode;
  readonly unpublished = unpublished;
  readonly digested = digested;
  readonly compose = compose;
  readonly bindAutomatic = bindAutomatic;
  readonly retryUnavailable = retryUnavailable;
  readonly wakeAutomatic = wakeAutomatic;
  readonly reconcileAutomatic = reconcileAutomatic;
  readonly soon = soon;
  readonly closeBlockedWork = closeBlockedWork;
  closed = false;
  automaticBound = false;
  /** How long a cycle an outage refused waits before it is tried again. */
  retryAfterMs = 30_000;
  /** How long an outage keeps a cycle being tried again before only an event or a bind wakes it. */
  unavailableForMs = 10 * 60_000;
  /** Projects with a retry already waiting: one resume reconciles every cycle there. */
  readonly retrying = new Set<string>();
  /** Runs a callback in the context this service was made in, outside every transaction. */
  readonly detached = AsyncResource.bind((fn: () => void) => fn());
  bindings: { [K in keyof Capabilities]?: Binding<Capabilities[K]> } = {};
  handle?: Awaited<ReturnType<Workflows['register']>>;
  readonly checked = new CheckedTransitions();
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly workflows: Workflows,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate(
      'research',
      Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
    );
    // Providers bind later, each as it arrives; see researchPlugin.
    this.handle = await this.workflows.register(definition, this.policy());
  }

  open() {
    check(!this.closed, 'research_unavailable', 'Research is unavailable', 503);
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<ResearchRecord> {
    this.open();
    caller = structuredClone(caller);
    parse(getSchema, { researchId: id });
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await this.record(caller, await this.row(caller, id, tx), tx);
    });
  }
  /**
   * Where an automatic run stands: the blocker Research published for the cycle, unless its
   * event consumer is not bound, or the run finished its authorized cycles here while its plan
   * wanted another (a reflection that chose to stop ended the run itself).
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
    if (definition.terminal.includes(workflow.state))
      return {
        ...status,
        blocker:
          workflow.state === 'complete' &&
          !successorId &&
          row.cycle_index >= row.max_cycles &&
          // Without Reflections to ask, the limit is what it may have been.
          !!(await this.continuing(caller, record as ResearchRecord, tx, [], 'complete').catch(
            () => true,
          ))
            ? {
                code: 'research_cycle_limit',
                message: `Finished the authorized ${row.max_cycles} research cycles; no further wave was created`,
              }
            : null,
      };
    if (!this.automaticBound)
      return {
        ...status,
        blocker: {
          code: 'research_automatic_unavailable',
          message: 'Automatic research is waiting for its durable event consumer to be available',
        },
      };
    const published = (await this.workflows.blockers(caller, row.research_id, tx)).find(
      (item) => item.provider === AUTOMATIC_PROVIDER,
    );
    return {
      ...status,
      blocker: published ? { code: published.code, message: published.message } : null,
    };
  }
  /** The cycle a row describes, for a caller already authorized to read it. */
  private async record(caller: Caller, row: Row, tx: Transaction): Promise<ResearchRecord> {
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
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<Row>(
          'SELECT * FROM research_cycles WHERE project_id=? ORDER BY _merv_rowid',
          caller.projectId,
        ),
        async (row) => await this.record(caller, row, tx),
      );
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
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'create', input, tx, async () => {
        if (input.previousCycleId) await this.follow(caller, input.previousCycleId, tx, checks);
        return await this.begin(caller, input, 'create', null, tx);
      });
      checks.forEach((check) => check());
      return result;
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
  async definition(caller: Caller, tx: Transaction, checks: BindingChecks): Promise<PaperRevision> {
    const problem = (await this.use('paper', checks, (service) => service.documents(caller, tx)))
      .problem.current;
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
        if (await this.selectedCode(caller, input.dependsOn, tx))
          await tx.run('UPDATE research_cycles SET code_required=1 WHERE id=?', record.id);
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
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'end', input, tx, async () => {
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
        ended.digest = await this.digested(caller, ended, tx, checks, {
          late: false,
          required: false,
        });
        return ended;
      });
      checks.forEach((check) => check());
      return result;
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
    const since = await this.unpublished(caller, input.researchId, transaction);
    return await inTransaction(this.state, transaction, async (tx) => {
      const record = await this.get(caller, input.researchId, tx);
      await this.authorize(caller, record, tx);
      const checks: BindingChecks = [];
      const result = await this.command(caller, 'advance', input, tx, async () => {
        check(
          record.workflow.revision === input.expectedRevision,
          'revision_conflict',
          'The research cycle changed; read its current revision',
          409,
        );
        const handle = this.handle!;
        const { move, continuing, abandoned } = await this.ready(
          caller,
          record,
          tx,
          checks,
          input,
          since,
        );
        const injecting = move === 'inject' || move === 'reinject';
        check(
          !continuing || input.nextWave,
          'next_wave_choice_required',
          'The approved reflection carries a plan that continues. Call research.advance with nextWave: "create" to open its tasks, experiments and the next research cycle, or nextWave: "skip" to complete this cycle without them',
          400,
        );
        const childIds: string[] = [];
        if (injecting)
          childIds.push(await this.inject(caller, record, since!, input.requestId, tx, checks));
        switch (record.workflow.state as Stage) {
          case 'defining': {
            const problem = await this.definition(caller, tx, checks);
            await tx.run(
              'UPDATE research_cycles SET problem=? WHERE id=?',
              JSON.stringify(problem),
              record.id,
            );
            break;
          }
          case 'researching': {
            // A predecessor a plan opened this cycle from may have no digest yet; without the
            // capabilities to compose one the wave simply starts without it.
            const carried = record.previousCycleId
              ? await this.digested(
                  caller,
                  await this.get(caller, record.previousCycleId, tx),
                  tx,
                  checks,
                  { late: true, required: false },
                )
              : null;
            const wave = await this.use('reflections', checks, (service) =>
              service.create(
                caller,
                {
                  title: `${clip(record.name, 288)}: reflection`,
                  ...(record.automation ? { requirePlan: true } : {}),
                  // Absent rather than null, so a cycle that follows nothing replays as before.
                  ...(carried ? { previousCycleDigestId: carried.id } : {}),
                  requestId: childRequest(caller, 'research', 'reflection', input.requestId),
                },
                tx,
              ),
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
          ? await this.materialise(caller, record, continuing, input.requestId, tx, checks)
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
          advanced.digest = await this.digested(caller, advanced, tx, checks, {
            late: false,
            required: false,
          });
        return advanced;
      });
      checks.forEach((check) => check());
      return result;
    });
  }
  private bind<K extends keyof Capabilities>(name: K, value: Capabilities[K]): () => void {
    this.open();
    const binding = { value };
    this.bindings = { ...this.bindings, [name]: binding };
    return () => {
      if (this.bindings[name] === binding) delete this.bindings[name];
    };
  }
  bindPaper(paper: Paper): () => void {
    return this.bind('paper', paper);
  }
  bindReflections(reflections: Reflections): () => void {
    return this.bind('reflections', reflections);
  }
  bindTasks(tasks: Tasks): () => void {
    const releases = [
      this.bind('tasks', tasks),
      this.bind('integrations', tasks.serviceTasks('research')),
    ];
    return () => releases.forEach((release) => release());
  }
  bindCode(code: ResearchCode): () => void {
    return this.bind('code', code);
  }
  bindExperiments(experiments: Experiments): () => void {
    return this.bind('experiments', experiments);
  }
  bindArtifacts(artifacts: Artifacts): () => void {
    return this.bind('artifacts', artifacts);
  }
  requireCapability<K extends keyof Capabilities>(name: K, checks: BindingChecks) {
    this.open();
    checks.forEach((check) => check());
    const binding = this.bindings[name];
    check(binding, `${name}_unavailable`, unavailable[name], 409);
    checks.push(() => {
      this.open();
      check(this.bindings[name] === binding, `${name}_unavailable`, unavailable[name], 409);
    });
    return binding.value;
  }
  async use<K extends keyof Capabilities, T>(
    name: K,
    checks: BindingChecks,
    action: (service: Capabilities[K]) => Promise<T>,
  ): Promise<T> {
    const service = this.requireCapability(name, checks);
    const result = await action(service);
    checks.forEach((check) => check());
    return result;
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
    this.bindings = {};
    this.handle?.dispose();
  }
}
export const researchPlugin = {
  name: 'merv-research',
  inject: ['state', 'scope', 'workflows'],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(new ResearchService(ctx.state, ctx.scope, ctx.workflows));
      yield () => service.close();
      ctx.inject(['domainEvents'], (ctx) => {
        ctx.effect(async () => await service.bindAutomatic(ctx.domainEvents));
      });
      // Each provider is optional: bound while it is loaded, and a bound one may unblock a cycle.
      ctx.inject(['paper'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindPaper(ctx.paper);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['reflections'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindReflections(ctx.reflections);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['tasks'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindTasks(ctx.tasks);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['experiments'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindExperiments(ctx.experiments);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['artifacts'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindArtifacts(ctx.artifacts);
          await service.wakeAutomatic();
        });
      });
      ctx.inject(['codeWork'], (ctx) => {
        ctx.effect(async function* () {
          yield service.bindCode(ctx.codeWork);
          await service.wakeAutomatic();
        });
      });
      yield ctx.provide('research', service);
    });
  },
};
export default researchPlugin;
