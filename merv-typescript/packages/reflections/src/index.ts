import {
  bound,
  mapAsync,
  childRequest,
  createService,
  recorded,
  replayed,
  check,
  inTransaction,
  MervError,
  now,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextRegistration,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import { CheckedTransitions } from '@merv/workflows/rules';
import { leaseRows } from '@merv/workflows/lease-rows';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import type { Paper } from '@merv/paper/types';
import { PAPER_REVIEW_GUIDANCE } from '@merv/paper/rules';
import type {} from '@merv/sessions/types';
import * as running from './running.js';
import * as program from './program.js';
import * as commands from './commands.js';
import { submitted, type LensRow, type WaveRow } from './program.js';
import { LENSES, LENS_WORKFLOW, ITEM_RECIPES, REFLECTION_WORKFLOW } from './definitions.js';
import type {
  ApprovedReflection,
  Reflection,
  ReflectionCreate,
  ReflectionLens,
  Reflections,
} from './types.js';
export type * from './types.js';

/** What review.start and review.get tell the reviewer of a reflection wave's synthesis. */
const REVIEW_GUIDANCE = `Pass rejects returnTo; a rejection returns to synthesizing (the default) or reflecting. Reflection reviewers ${PAPER_REVIEW_GUIDANCE} You may add comprehensive detail when it helps explain the project’s trajectory and informs what comes next. Edits save with any verdict; if none are needed, explain why in notes.`;

/**
 * How often a review may send a reflection back, to its synthesis or to its lenses. Restarting
 * the lenses opens five more sessions, so this is the cap on that fan-out. After the last
 * return the next synthesis waits for a human, who reviews it by hand or allows another round.
 */
export const REFLECTION_LIMITS = { reviewReturns: 2 };

/** What the modules (program.ts, commands.ts, running.ts) read of the service. */
export type ReflectionsContext = Pick<
  ReflectionService,
  | 'artifacts'
  | 'checked'
  | 'command'
  | 'contexts'
  | 'createLenses'
  | 'get'
  | 'lens'
  | 'lensRow'
  | 'lensRows'
  | 'limits'
  | 'moved'
  | 'once'
  | 'paper'
  | 'read'
  | 'reviews'
  | 'row'
  | 'scope'
  | 'state'
  | 'wave'
  | 'workflows'
>;
/** Domain composition only: every runnable stage is an ordinary registered workflow node. */
export class ReflectionService implements Reflections {
  /** One per published version: an instance moves only through the version it began on. */
  private handles = new Map<string, Awaited<ReturnType<Workflows['register']>>>();
  checked = new CheckedTransitions();
  contexts = new Map<string, ContextRegistration>();
  private releaseOwner?: () => void;
  private closed = false;
  constructor(
    readonly state: State,
    readonly scope: Scope,
    readonly artifacts: Artifacts,
    readonly paper: Paper,
    readonly workflows: Workflows,
    readonly reviews: Reviews,
    private contextBuilder: ContextBuilder,
    readonly limits = REFLECTION_LIMITS,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('reflections', postgresMigrations);
    try {
      // Every assignment renders with these, a leased one too, so earlier versions render
      // nothing and are not registered; their rows stay in context_recipes.
      for (const recipe of ITEM_RECIPES)
        this.contexts.set(recipe.name, await this.contextBuilder.register(recipe));
      for (const definition of [LENS_WORKFLOW, REFLECTION_WORKFLOW])
        this.handles.set(
          `${definition.name}@${definition.version}`,
          await this.workflows.register(
            definition,
            program.policy(this, definition === LENS_WORKFLOW),
          ),
        );
      this.releaseOwner = this.reviews.registerSubmitOwner({
        id: 'reflections',
        owns: async (review, tx) =>
          !!(await tx.get(
            'SELECT id FROM reflections WHERE id=? AND project_id=?',
            review.subjectId,
            review.projectId,
          )),
        submit: async (caller, input, tx) => await commands.submitReview(this, caller, input, tx),
        // A rejected report goes back to synthesis, or to the lenses for five new reports.
        returns: async () => [
          { value: 'synthesizing', label: 'Synthesis, for a revised report' },
          { value: 'reflecting', label: 'Lenses, for five new reports' },
        ],
        // Both rejecting verdicts return the wave.
        returning: ['needs_changes', 'fail'],
        guidance: REVIEW_GUIDANCE,
        fields: ['paperChanges'],
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseOwner?.();
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
    for (const context of this.contexts.values()) context.dispose();
    this.contexts.clear();
  }
  async read(caller: Caller, tx: Transaction): Promise<void> {
    check(!this.closed, 'reflection_unavailable', 'Reflection program is unavailable', 503);
    await this.scope.require(caller, 'read', tx);
  }
  /** Guidance's callbacks each read these rows; one snapshot reads each once. Callers get copies. */
  async once<T>(key: string, read: () => Promise<T>): Promise<T> {
    return structuredClone(await this.state.remember(`reflections:${key}`, read));
  }
  async row(caller: Caller, id: string, tx: Transaction): Promise<WaveRow> {
    await this.read(caller, tx);
    const row = await this.once(`row:${caller.projectId}:${id}`, () =>
      tx.get<WaveRow>(
        'SELECT * FROM reflections WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      ),
    );
    check(row, 'reflection_not_found', 'Reflection not found', 404);
    return row;
  }
  async lensRow(caller: Caller, id: string, tx: Transaction): Promise<LensRow> {
    await this.read(caller, tx);
    const row = await this.once(`lens:${caller.projectId}:${id}`, () =>
      tx.get<LensRow>(
        'SELECT * FROM reflection_lenses WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      ),
    );
    check(row, 'reflection_lens_not_found', 'Reflection lens not found', 404);
    return row;
  }
  async lensRows(row: WaveRow, tx: Transaction): Promise<LensRow[]> {
    return await this.once(`lenses:${row.project_id}:${row.id}:${row.attempt}`, () =>
      tx.all<LensRow>(
        'SELECT * FROM reflection_lenses WHERE reflection_id=? AND attempt=? ORDER BY _merv_rowid',
        row.id,
        row.attempt,
      ),
    );
  }
  private async hydrateLens(
    caller: Caller,
    row: LensRow,
    tx: Transaction,
  ): Promise<ReflectionLens> {
    return {
      id: row.id,
      reflectionId: row.reflection_id,
      attempt: row.attempt,
      perspective: row.perspective,
      instructions: row.instructions,
      producerId: row.producer_id,
      artifact: row.artifact ? JSON.parse(row.artifact) : null,
      workflow: await this.workflows.get(caller, row.id, tx),
    };
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<Reflection> {
    caller = structuredClone(caller);
    return await inTransaction(
      this.state,
      transaction,
      async (tx) => await this.wave(caller, id, tx),
    );
  }
  /**
   * One wave. `lenient` is the Running page's read, where a review the wave names and Reviews
   * does not hold is drawn as no review rather than refusing the whole wave.
   */
  async wave(caller: Caller, id: string, tx: Transaction, lenient = false): Promise<Reflection> {
    const row = await this.row(caller, id, tx);
    const submission = submitted(row);
    const own = (await this.authored(caller, tx, id))?.own;
    return {
      id,
      projectId: row.project_id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      attempt: row.attempt,
      lenses: await mapAsync(await this.lensRows(row, tx), async (lens) =>
        this.withheld(await this.hydrateLens(caller, lens, tx), own),
      ),
      workflow: await this.workflows.get(caller, id, tx),
      review: row.review_id
        ? await this.reviews.get(caller, row.review_id, tx).catch((error: unknown) => {
            if (lenient && error instanceof MervError && error.status === 404) return null;
            throw error;
          })
        : null,
      report: submission?.report ?? null,
      changeSpec: submission?.changeSpec ?? null,
      plan: submission?.plan ?? null,
    };
  }
  async list(caller: Caller, transaction?: Transaction): Promise<Reflection[]> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.read(caller, tx);
      return await mapAsync(
        await tx.all<{ id: string }>(
          'SELECT id FROM reflections WHERE project_id=? ORDER BY _merv_rowid DESC',
          caller.projectId,
        ),
        async (row) => await this.get(caller, row.id, tx),
      );
    });
  }
  async lens(caller: Caller, id: string, transaction?: Transaction): Promise<ReflectionLens> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const row = await this.lensRow(caller, id, tx);
      const own = (await this.authored(caller, tx, row.reflection_id))?.own;
      return this.withheld(await this.hydrateLens(caller, row, tx), own);
    });
  }
  /**
   * The lenses of a reflecting wave (`reflectionId`, else the open one) that the calling worker's
   * thread wrote: its actor held their leases, on this visit or an earlier one. Such a worker
   * reads no other lens's output, so the five stay independent; an inquiry visit to its thread,
   * which holds no lease, is held to the same. Undefined for any other caller, or once the wave
   * synthesizes: synthesis and review sessions, leased the wave itself, read them all.
   */
  async authored(caller: Caller, tx: Transaction, reflectionId?: string) {
    if (!caller.session) return undefined;
    const held = await leaseRows(tx, {
      projectId: caller.projectId,
      actorId: caller.actorId,
      workflows: [LENS_WORKFLOW.name],
    });
    if (!held.length) return undefined;
    const lenses = await tx.all<{ id: string; reflection_id: string; artifact: string | null }>(
      reflectionId
        ? 'SELECT id,reflection_id,artifact FROM reflection_lenses WHERE reflection_id=? AND project_id=?'
        : 'SELECT l.id,l.reflection_id,l.artifact FROM reflection_lenses l JOIN reflections r ON r.id=l.reflection_id WHERE r.project_id=? AND r.approved IS NULL AND r.abandoned IS NULL ORDER BY l._merv_rowid',
      ...(reflectionId ? [reflectionId] : []),
      caller.projectId,
    );
    const own = new Set(
      held.map((lease) => lease.instance_id).filter((id) => lenses.some((lens) => lens.id === id)),
    );
    if (!own.size) return undefined;
    const waveId = lenses[0]!.reflection_id;
    const wave = await this.workflows.get(caller, waveId, tx);
    return wave.state === 'reflecting'
      ? { own, others: lenses.filter((lens) => !own.has(lens.id)) }
      : undefined;
  }
  /** Artifacts' read rule: a lens's worker reads no report another lens of its wave made. */
  async withheldReports(caller: Caller, tx: Transaction) {
    const authored = await this.authored(caller, tx);
    if (!authored) return null;
    const others = authored.others;
    return {
      artifacts: others.flatMap((lens) =>
        lens.artifact ? [(JSON.parse(lens.artifact) as Artifact).id] : [],
      ),
      // What those lenses' sessions made on the way to their reports.
      sessions: (
        await leaseRows(tx, {
          projectId: caller.projectId,
          instanceIds: others.map((lens) => lens.id),
        })
      ).map((lease) => lease.id),
    };
  }
  private withheld(lens: ReflectionLens, own: ReadonlySet<string> | undefined): ReflectionLens {
    return !own || own.has(lens.id) ? lens : { ...lens, artifact: null };
  }
  async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'reflection_commands', caller, operation, input, execute, {
      hash: 'fingerprint',
    });
  }
  async create(
    caller: Caller,
    input: ReflectionCreate,
    transaction?: Transaction,
  ): Promise<Reflection> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      check(!caller.session, 'forbidden', 'Create waves outside an assigned worker', 403);
      return await this.command(caller, 'create', input, tx, async () => {
        check(
          !(await this.open(caller, tx)),
          'reflection_open',
          'Complete the current reflection before starting another',
          409,
        );
        const title = input.title?.trim() || 'Project reflection';
        check(
          title.length <= 300,
          'invalid_title',
          'Reflection title is limited to 300 characters',
        );
        if (input.previousCycleDigestId)
          await this.artifacts.get(caller, input.previousCycleDigestId, tx);
        const workflow = await this.handle(REFLECTION_WORKFLOW).start(
          caller,
          {
            workflow: 'reflection',
            version: REFLECTION_WORKFLOW.version,
            requestId: childRequest(caller, 'reflection', 'wave', input.requestId),
            // Later transitions pass no such key, so the wave keeps the digest it started with.
            data: {
              title,
              ...(input.requirePlan ? { requirePlan: true } : {}),
              ...(input.previousCycleDigestId
                ? { previousCycleDigestId: input.previousCycleDigestId }
                : {}),
            },
          },
          tx,
        );
        await tx.run(
          "INSERT INTO reflections(id,project_id,title,owner_id,created_at,attempt,review_id,submission,approved,feedback) VALUES(?,?,?,?,?,1,NULL,NULL,NULL,'[]')",
          workflow.id,
          caller.projectId,
          title,
          caller.actorId,
          now(),
        );
        await this.createLenses(caller, await this.row(caller, workflow.id, tx), tx);
        await recorded(this.state, tx, caller, 'reflection.created', workflow.id, {
          research: 'live',
        });
        return await this.get(caller, workflow.id, tx);
      });
    });
  }
  private handle({ name, version }: { name: string; version: number }) {
    const handle = this.handles.get(`${name}@${version}`);
    check(handle, 'reflection_unavailable', 'Reflection program is unavailable', 503);
    return handle;
  }
  /** A transition on the instance's own version; one guarded by its command passes `checked`. */
  async moved(
    caller: Caller,
    input: Parameters<ReturnType<ReflectionService['handle']>['transition']>[1],
    tx: Transaction,
    checked?: WorkflowSnapshot,
  ) {
    const { workflow: name, version } =
      checked ?? (await this.workflows.get(caller, input.instanceId, tx));
    const move = () => this.handle({ name, version }).transition(caller, input, tx);
    const edge = checked && { ...checked, instanceId: checked.id, action: input.action };
    return await (edge ? this.checked.take(tx, edge, move) : move());
  }
  async createLenses(caller: Caller, row: WaveRow, tx: Transaction): Promise<void> {
    for (const lens of LENSES) {
      const workflow = await this.handle(LENS_WORKFLOW).start(
        caller,
        {
          workflow: 'reflection.lens',
          version: LENS_WORKFLOW.version,
          requestId: `reflection:${row.id}:${row.attempt}:${lens.perspective}`,
          data: { reflectionId: row.id, attempt: row.attempt, perspective: lens.perspective },
        },
        tx,
      );
      await tx.run(
        'INSERT INTO reflection_lenses(id,project_id,reflection_id,attempt,perspective,instructions,producer_id,artifact) VALUES(?,?,?,?,?,?,NULL,NULL)',
        workflow.id,
        caller.projectId,
        row.id,
        row.attempt,
        lens.perspective,
        lens.instructions,
      );
    }
  }
  // The policy and lease hooks of both workflows (program.ts), the lens, synthesis, end and
  // review commands (commands.ts) and the Running page (running.ts) run on this service as their
  // ReflectionsContext; the Reflections contract's share of them is bound here.
  readonly submitLens = bound(this, commands.submitLens);
  readonly submit = bound(this, commands.submit);
  readonly end = bound(this, commands.end);
  readonly running = bound(this, running.running);
  readonly runningPanel = bound(this, running.runningPanel);
  async open(caller: Caller, transaction?: Transaction): Promise<string | undefined> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.read(caller, tx);
      return (
        await tx.get<{ id: string }>(
          'SELECT id FROM reflections WHERE project_id=? AND approved IS NULL AND abandoned IS NULL',
          caller.projectId,
        )
      )?.id;
    });
  }
  async approved(
    caller: Caller,
    id: string,
    transaction?: Transaction,
  ): Promise<ApprovedReflection | null> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const wave = await this.row(caller, id, tx);
      if (!wave.approved) return null;
      // Waves approved before this shape was narrowed also stored corpus, paper and
      // experimentIds, always empty for the version that remains; they are not part of it.
      const {
        corpus: _corpus,
        paper: _paper,
        experimentIds: _experimentIds,
        ...approved
      } = JSON.parse(wave.approved) as ApprovedReflection & Record<string, unknown>;
      return approved;
    });
  }
}
export const reflectionsPlugin = {
  name: 'merv-reflections',
  inject: [
    'state',
    'scope',
    'artifacts',
    'paper',
    'workflows',
    'reviews',
    'contextBuilder',
    'sessions',
  ],
  async apply(ctx: Context) {
    await ctx.effect(async function* () {
      const service = await createService(
        new ReflectionService(
          ctx.state,
          ctx.scope,
          ctx.artifacts,
          ctx.paper,
          ctx.workflows,
          ctx.reviews,
          ctx.contextBuilder,
        ),
      );
      yield () => service.close();
      yield ctx.artifacts.registerReadRule('reflections', (caller, tx) =>
        service.withheldReports(caller, tx),
      );
      // A restart makes new lens instances: each perspective's author still takes its own up again.
      yield ctx.sessions.threads.register(LENS_WORKFLOW.name, ({ data, role }) =>
        JSON.stringify([LENS_WORKFLOW.name, data.reflectionId, data.perspective, role]),
      );
      yield ctx.provide('reflections', service);
    });
  },
};
export default reflectionsPlugin;
