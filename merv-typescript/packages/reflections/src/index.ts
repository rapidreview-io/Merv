import { excludedFromReview, releasedLease, visible, everyAsync } from '@merv/contracts';
import { mapAsync, someAsync, checkReceipt, grant, reference, target } from '@merv/contracts';
import { childRequest, createService, markdownSection, recorded, replayed } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import { z } from 'zod';
import {
  check,
  inTransaction,
  MervError,
  now,
  reviewHistory,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextInput,
  type ContextRegistration,
  type ReviewApplication,
  type ReviewRequest,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
import type { Paper } from '@merv/paper/types';
import { parseChangeSpec } from './change-spec.js';
import {
  CHANGE_SPEC_CRITERION,
  LENSES,
  LENS_RECIPE,
  LENS_WORKFLOW,
  LENS_WORKFLOW_ENDABLE,
  WORKSPACE_RECIPES,
  REFLECTION_CRITERIA,
  REFLECTION_WORKFLOW,
  REFLECTION_WORKFLOW_ENDABLE,
} from './definitions.js';
import type {
  ApprovedReflection,
  ChangeSpec,
  Reflection,
  ReflectionCreate,
  ReflectionLens,
  ReflectionLensSubmit,
  ReflectionEnd,
  Reflections,
  ReflectionSubmit,
} from './types.js';
export type * from './types.js';

/** What the earlier rounds may take of a 24000-character recipe, so they never crowd out the assignment. */
const REVIEW_HISTORY_CHARS = 6000;

interface WaveRow {
  id: string;
  project_id: string;
  title: string;
  owner_id: string;
  created_at: string;
  attempt: number;
  review_id: string | null;
  submission: string | null;
  approved: string | null;
  feedback: string;
}
interface LensRow {
  id: string;
  project_id: string;
  reflection_id: string;
  attempt: number;
  perspective: string;
  instructions: string;
  producer_id: string | null;
  artifact: string | null;
}
interface Submission {
  report: Artifact;
  changeSpec: Artifact;
  /** Set only for an application/json change specification; approval copies it unchanged. */
  plan?: ChangeSpec;
  producerId: string;
}
interface LeaseRow {
  id: string;
  project_id: string;
  instance_id: string;
  revision: number;
  actor_id: string;
  receipt: string;
  inputs: string;
  artifacts: string;
  review_id: string | null;
  claim_id: string | null;
  released_at: string | null;
}
/** Every step is named as its record is: a wave by its title, a lens by its wave and perspective. */
const named = ({ wave, lens }: { wave: WaveRow; lens: LensRow | null }) =>
  lens ? `${wave.title}: ${lens.perspective}` : wave.title;

/**
 * How often a review may send a reflection back, to its synthesis or to its lenses. Restarting
 * the lenses opens five more sessions, so this is the cap on that fan-out. After the last
 * return the next synthesis waits for a human, who reviews it by hand or allows another round.
 */
export const REFLECTION_LIMITS = { reviewReturns: 2 };
const configuration = z
  .object({
    limits: z
      .object({
        reviewReturns: z.number().int().min(1).max(1000).default(REFLECTION_LIMITS.reviewReturns),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

/** Domain composition only: every runnable stage is an ordinary registered workflow node. */
export class ReflectionService implements Reflections {
  /** One per published version: an instance moves only through the version it began on. */
  private handles = new Map<string, Awaited<ReturnType<Workflows['register']>>>();
  private contexts = new Map<string, ContextRegistration>();
  private releaseOwner?: () => void;
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private artifacts: Artifacts,
    private paper: Paper,
    private workflows: Workflows,
    private reviews: Reviews,
    contextBuilder: ContextBuilder,
    private limits = REFLECTION_LIMITS,
  ) {
    this.initialize = async () => {
      await state.migrate(
        'reflections',
        Object.entries(postgresMigrations).map(([version, sql]) => ({ version: +version, sql })),
      );
      try {
        for (const recipe of [LENS_RECIPE, ...WORKSPACE_RECIPES])
          this.contexts.set(recipe.name, await contextBuilder.register(recipe));
        for (const definition of [
          LENS_WORKFLOW,
          LENS_WORKFLOW_ENDABLE,
          REFLECTION_WORKFLOW,
          REFLECTION_WORKFLOW_ENDABLE,
        ])
          this.handles.set(
            `${definition.name}@${definition.version}`,
            await workflows.register(
              definition,
              this.policy(definition.name === LENS_WORKFLOW.name, definition.version),
            ),
          );
        this.releaseOwner = reviews.registerSubmitOwner({
          id: 'reflections',
          owns: async (review, tx) =>
            !!(await tx.get(
              'SELECT id FROM reflections WHERE id=? AND project_id=?',
              review.subjectId,
              review.projectId,
            )),
          submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        });
      } catch (error) {
        this.close();
        throw error;
      }
    };
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
  private async read(caller: Caller, tx: Transaction): Promise<void> {
    check(!this.closed, 'reflection_unavailable', 'Reflection program is unavailable', 503);
    await this.scope.require(caller, 'read', tx);
  }
  private async row(caller: Caller, id: string, tx: Transaction): Promise<WaveRow> {
    await this.read(caller, tx);
    const row = await tx.get<WaveRow>(
      'SELECT * FROM reflections WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'reflection_not_found', 'Reflection not found', 404);
    return row;
  }
  private async lensRow(caller: Caller, id: string, tx: Transaction): Promise<LensRow> {
    await this.read(caller, tx);
    const row = await tx.get<LensRow>(
      'SELECT * FROM reflection_lenses WHERE id=? AND project_id=?',
      id,
      caller.projectId,
    );
    check(row, 'reflection_lens_not_found', 'Reflection lens not found', 404);
    return row;
  }
  private async lensRows(row: WaveRow, tx: Transaction): Promise<LensRow[]> {
    return await tx.all<LensRow>(
      'SELECT * FROM reflection_lenses WHERE reflection_id=? AND attempt=? ORDER BY _merv_rowid',
      row.id,
      row.attempt,
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
    return await inTransaction(this.state, transaction, async (tx) => {
      const row = await this.row(caller, id, tx);
      const submission = row.submission ? (JSON.parse(row.submission) as Submission) : null;
      return {
        id,
        projectId: row.project_id,
        title: row.title,
        ownerId: row.owner_id,
        createdAt: row.created_at,
        attempt: row.attempt,
        lenses: await mapAsync(
          await this.lensRows(row, tx),
          async (lens) => await this.hydrateLens(caller, lens, tx),
        ),
        workflow: await this.workflows.get(caller, id, tx),
        review: row.review_id ? await this.reviews.get(caller, row.review_id, tx) : null,
        report: submission?.report ?? null,
        changeSpec: submission?.changeSpec ?? null,
        plan: submission?.plan ?? null,
      };
    });
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
    return await inTransaction(
      this.state,
      transaction,
      async (tx) => await this.hydrateLens(caller, await this.lensRow(caller, id, tx), tx),
    );
  }
  private async command<T>(
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
        const workflow = await this.handle(REFLECTION_WORKFLOW_ENDABLE).start(
          caller,
          {
            workflow: 'reflection',
            version: REFLECTION_WORKFLOW_ENDABLE.version,
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
          'INSERT INTO reflections(id,project_id,title,owner_id,created_at,attempt,corpus,paper,review_id,submission,approved,feedback) VALUES(?,?,?,?,?,1,?,?,NULL,NULL,NULL,?)',
          workflow.id,
          caller.projectId,
          title,
          caller.actorId,
          now(),
          'null',
          'null',
          '[]',
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
  /** A transition through the handle of the version the instance began on. */
  private async moved(
    caller: Caller,
    input: Parameters<ReturnType<ReflectionService['handle']>['transition']>[1],
    tx: Transaction,
  ) {
    const { workflow: name, version } = await this.workflows.get(caller, input.instanceId, tx);
    return await this.handle({ name, version }).transition(caller, input, tx);
  }
  private async createLenses(caller: Caller, row: WaveRow, tx: Transaction): Promise<void> {
    // Lenses pair with their wave: only an endable wave's lenses can be ended with it.
    const endable =
      (await this.workflows.get(caller, row.id, tx)).version ===
      REFLECTION_WORKFLOW_ENDABLE.version;
    const definition = endable ? LENS_WORKFLOW_ENDABLE : LENS_WORKFLOW;
    for (const lens of LENSES) {
      const workflow = await this.handle(definition).start(
        caller,
        {
          workflow: 'reflection.lens',
          version: definition.version,
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
  private async current(
    context: WorkflowCheckContext,
  ): Promise<{ wave: WaveRow; lens: LensRow | null }> {
    const lens =
      context.snapshot.workflow === 'reflection.lens'
        ? await this.lensRow(context.caller, context.snapshot.id, context.tx)
        : null;
    const wave = await this.row(
      context.caller,
      lens?.reflection_id ?? context.snapshot.id,
      context.tx,
    );
    if (lens) {
      const parent = await this.workflows.get(context.caller, wave.id, context.tx);
      check(
        lens.attempt === wave.attempt && parent.state === 'reflecting',
        'stale_reflection_lens',
        'This lens is not part of the active reflection attempt',
        409,
      );
    }
    return { wave, lens };
  }
  private async activeLease(context: WorkflowCheckContext): Promise<LeaseRow | undefined> {
    return await context.tx.get<LeaseRow>(
      'SELECT * FROM reflection_leases WHERE project_id=? AND instance_id=? AND revision=? AND released_at IS NULL',
      context.caller.projectId,
      context.snapshot.id,
      context.snapshot.revision,
    );
  }
  private async lease(context: WorkflowCheckContext): Promise<LeaseRow> {
    const row = await this.activeLease(context);
    check(
      context.caller.session &&
        row?.id === context.caller.session.id &&
        row.actor_id === context.caller.actorId,
      'stale_lease',
      'Worker no longer owns this reflection assignment',
      409,
    );
    return row;
  }
  /**
   * Every lens author and the synthesis author produced the wave, and a reviewer one of them
   * directs is that author's hand.
   */
  private async independent(caller: Caller, wave: WaveRow, tx: Transaction): Promise<void> {
    const submission = wave.submission ? (JSON.parse(wave.submission) as Submission) : null;
    const authors = [
      submission?.producerId,
      ...(await this.lensRows(wave, tx)).map((lens) => lens.producer_id),
    ];
    const authority = (await this.scope.authorityActor(caller, tx)).id;
    check(
      !authors.includes(caller.actorId) && !authors.includes(authority),
      'review_independence',
      'Reflection review must be independent of every lens author and the synthesis author',
      403,
    );
  }
  private async admit(context: WorkflowCheckContext, delegated = false): Promise<void> {
    const { caller, snapshot, tx } = context;
    const { wave, lens } = await this.current(context);
    const reviewing = snapshot.state === 'in_review';
    await this.scope.require(caller, reviewing ? 'review' : 'write', tx);
    const lease = await this.activeLease(context);
    if (caller.session) await this.lease(context);
    else check(!lease, 'reflection_leased', 'A worker owns this reflection assignment', 409);
    if (lens) {
      check(
        !lens.artifact && snapshot.state === 'reflecting',
        'reflection_lens_complete',
        'Lens has already submitted',
        409,
      );
      if (!delegated) {
        check(
          !(await this.lensRows(wave, tx)).some(
            (other) => other.id !== lens.id && other.producer_id === caller.actorId,
          ),
          'lens_independence',
          'Each lens requires a different agent identity',
          403,
        );
        const parallel = await tx.all<{ actor_id: string; instance_id: string }>(
          'SELECT actor_id,instance_id FROM reflection_leases WHERE project_id=? AND released_at IS NULL',
          caller.projectId,
        );
        check(
          !(await someAsync(
            parallel,
            async (entry) =>
              entry.actor_id === caller.actorId &&
              entry.instance_id !== snapshot.id &&
              (await this.lensRows(wave, tx)).some((other) => other.id === entry.instance_id),
          )),
          'lens_independence',
          'An agent cannot work on two perspectives in one attempt',
          403,
        );
      }
    } else if (reviewing) {
      check(wave.review_id, 'stale_review', 'Reflection review is missing', 409);
      const review = await this.reviews.get(caller, wave.review_id, tx);
      // An owner's override lifts this too; Reviews holds the claim to the owner who took it.
      if (!review.override) await this.independent(caller, wave, tx);
      check(
        review.subjectRevision === snapshot.revision,
        'stale_review',
        'Reflection review changed',
        409,
      );
      if (!delegated) {
        if (review.status === 'requested') await this.reviews.checkStart(caller, review.id, tx);
        else await this.reviews.checkSubmit(caller, review.id, undefined, tx);
      } else
        check(
          review.status === 'requested',
          'review_unavailable',
          'Review already has an owner',
          409,
        );
    } else {
      check(snapshot.state !== 'approved', 'reflection_complete', 'Reflection has ended', 409);
      check(
        snapshot.state === 'synthesizing',
        'reflection_not_ready',
        'Reflection waits for all five independent lenses',
        409,
      );
      const authority = await this.scope.authorityActor(caller, tx);
      check(
        authority.id === wave.owner_id || authority.role === 'operator',
        'forbidden',
        'Only the reflection owner or an operator may perform or delegate synthesis',
        403,
      );
    }
  }
  private async inputs(context: WorkflowCheckContext): Promise<Record<string, ContextInput>> {
    const { wave, lens } = await this.current(context);
    const submission = wave.submission ? (JSON.parse(wave.submission) as Submission) : null;
    const review =
      context.snapshot.state === 'in_review' && wave.review_id
        ? await this.reviews.get(context.caller, wave.review_id, context.tx)
        : null;
    const lenses = (await this.lensRows(wave, context.tx))
      .filter((entry) => entry.artifact)
      .map((entry) => (JSON.parse(entry.artifact!) as Artifact).id);
    const history = reviewHistory(
      (JSON.parse(wave.feedback) as ReviewRequest[]).map((entry) => ({ review: entry })),
      REVIEW_HISTORY_CHARS,
    );
    const previousCycle = (
      lens ? await this.workflows.get(context.caller, wave.id, context.tx) : context.snapshot
    ).data.previousCycleDigestId;
    return {
      assignment: {
        text: JSON.stringify({
          reflectionId: wave.id,
          title: wave.title,
          attempt: wave.attempt,
          workflow: context.snapshot,
          ...(context.snapshot.data.requirePlan
            ? {
                nextWave:
                  'Automatic research: submit an application/json change specification with an explicit continue or stop decision. A prose-only specification cannot finish this wave.',
              }
            : {}),
          ...(lens ? { perspective: lens.perspective, instructions: lens.instructions } : {}),
        }),
      },
      research: {
        text: `Read current research with project.records, task.get, experiment.get_state and paper.read. Inspect source evidence with artifact.read and its reviews with review.get. Existing work can progress during this wave; revisit relevant records before concluding. Identify the evidence you actually examined and distinguish completed results from work in progress. No corpus is embedded in this assignment.${
          // Only a wave Research started carries a digest, so only there is the tool named.
          typeof previousCycle === 'string'
            ? ' This research cycle follows an earlier one: research.lineage lists the cycles before it with their digests.'
            : ''
        }`,
      },
      ...(!lens ? { lenses: { artifactIds: lenses, mode: 'references' as const } } : {}),
      ...(review && submission
        ? {
            submission: {
              artifactIds: [submission.report.id, submission.changeSpec.id],
              mode: 'references' as const,
            },
            assessment: { text: JSON.stringify(review) },
          }
        : {}),
      feedback: {
        text: JSON.stringify({
          previousReviews: (
            JSON.parse(wave.feedback) as { id: string; synopsis: string; notes: string }[]
          )
            .slice(-1)
            .map(({ id, synopsis }) => ({ id, synopsis })),
          recovery: review?.recovery ?? null,
        }),
      },
      // Authors only: a reviewer judges the submission in front of them, not earlier verdicts.
      ...(!review && history.rounds.length ? { history: { text: JSON.stringify(history) } } : {}),
      ...(typeof previousCycle === 'string'
        ? { previousCycle: { artifactIds: [previousCycle], mode: 'auto' as const } }
        : {}),
    };
  }
  private inputIds(inputs: Record<string, ContextInput>): string[] {
    return [
      ...new Set(
        Object.values(inputs).flatMap((input) => ('artifactIds' in input ? input.artifactIds : [])),
      ),
    ];
  }
  private async references(context: WorkflowCheckContext) {
    const { wave, lens } = await this.current(context);
    const inputs = context.caller.session
      ? (JSON.parse((await this.lease(context)).inputs) as Record<string, ContextInput>)
      : await this.inputs(context);
    const review =
      !lens && context.snapshot.state === 'in_review' && wave.review_id
        ? await this.reviews.get(context.caller, wave.review_id, context.tx)
        : null;
    return {
      researchReviews: (JSON.parse(wave.feedback) as { id: string }[]).map((review) => review.id),
      reflectionId: wave.id,
      artifacts: [
        ...new Set([
          ...this.inputIds(inputs),
          ...(context.caller.session
            ? (await this.artifacts.authored(context.caller, context.tx)).map((a) => a.id)
            : []),
        ]),
      ],
      ...(review
        ? { reviewId: review.id, ...(review.claimId ? { claimId: review.claimId } : {}) }
        : {}),
    };
  }
  private async build(context: WorkflowCheckContext) {
    await this.admit(context);
    const { wave, lens } = await this.current(context);
    const stage = lens ? 'lens' : context.snapshot.state === 'in_review' ? 'review' : 'synthesis';
    const inputs = context.caller.session
      ? (JSON.parse((await this.lease(context)).inputs) as Record<string, ContextInput>)
      : await this.inputs(context);
    const recipe = [LENS_RECIPE, ...WORKSPACE_RECIPES].find(
      (entry) => entry.name === `reflection.${stage}`,
    )!;
    const preview = await this.contexts
      .get(recipe.name)!
      .preview(
        context.caller,
        { subject: { id: context.snapshot.id, revision: context.snapshot.revision }, inputs },
        context.tx,
      );
    return {
      role: stage === 'review' ? ('reviewer' as const) : ('producer' as const),
      label: named({ wave, lens }),
      brief: recipe.recipe.instructions,
      references: [
        { kind: 'reflection', id: wave.id, label: wave.title },
        ...preview.sources.map((a) => ({ kind: 'artifact', id: a.id, label: a.title })),
      ],
      handoff: {
        instruction:
          context.snapshot.data.requirePlan && stage === 'synthesis'
            ? `${recipe.recipe.outputInstructions} This automatic research wave requires the application/json format and an explicit continue or stop decision.`
            : recipe.recipe.outputInstructions,
        tools: [
          stage === 'lens'
            ? 'reflection.submit_lens'
            : stage === 'review'
              ? 'review.submit'
              : 'reflection.submit',
        ],
      },
      execution: { readOnly: stage === 'review', tools: [] },
      context: preview,
    };
  }
  private execution(lens: boolean, reviewing: boolean): WorkflowExecutionPolicy {
    return {
      readOnly: reviewing,
      tools: [
        grant('project.records', {}),
        grant('task.get', {}),
        grant('experiment.get_state', {}),
        grant('paper.read', {}),
        ...(!reviewing
          ? [grant('review.get', { reviewId: { kind: 'oneOf' as const, name: 'researchReviews' } })]
          : []),
        grant('workflow.status_and_next', { instanceId: target('instanceId') }),
        grant('workflow.assignment', { instanceId: target('instanceId') }),
        grant(
          lens ? 'reflection.lens' : 'reflection.get',
          lens ? { lensId: target('instanceId') } : { reflectionId: target('instanceId') },
        ),
        grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
        grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
        ...(reviewing
          ? [
              grant(
                'review.get',
                { reviewId: reference('reviewId') },
                { reviewId: { kind: 'oneOf' as const, name: 'researchReviews' } },
              ),
              grant('review.start', { reviewId: reference('reviewId') }),
              grant('review.submit', {
                reviewId: reference('reviewId'),
                claimId: reference('claimId'),
                expectedRevision: target('revision'),
              }),
            ]
          : [
              grant('artifact.create', {}),
              grant(
                lens ? 'reflection.submit_lens' : 'reflection.submit',
                lens
                  ? { lensId: target('instanceId'), expectedRevision: target('revision') }
                  : { reflectionId: target('instanceId'), expectedRevision: target('revision') },
              ),
            ]),
      ],
    };
  }
  private hooks(): NonNullable<NonNullable<WorkflowPolicy['assignments']>[number]['lease']> {
    return {
      label: async (context) => named(await this.current(context)),
      excludes: async (context, actorId) => {
        const { wave, lens } = await this.current(context);
        return (
          !lens &&
          context.snapshot.state === 'in_review' &&
          !!wave.review_id &&
          excludedFromReview(
            await this.reviews.get(context.caller, wave.review_id, context.tx),
            actorId,
          )
        );
      },
      role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
        check(!context.caller.session, 'forbidden', 'A worker cannot delegate assignments', 403);
        await this.admit(context, true);
        return context.snapshot.state === 'in_review' ? 'reviewer' : 'producer';
      },
      acquire: async (context) => {
        await this.admit({ ...context, caller: context.source }, true);
        const { wave, lens } = await this.current(context);
        if (lens)
          check(
            !(await this.lensRows(wave, context.tx)).some(
              (other) => other.id !== lens.id && other.producer_id === context.caller.actorId,
            ),
            'lens_independence',
            'Each lens requires a different agent identity',
            403,
          );
        // Reviews refuses a worker who wrote a lens or the synthesis (review_independence), and
        // Workflows admits the worker through admit() right after this hook.
        const review =
          context.snapshot.state === 'in_review' && wave.review_id
            ? await this.reviews.start(context.caller, wave.review_id, context.tx)
            : null;
        const inputs = await this.inputs({ ...context, caller: context.source });
        if (review) inputs.assessment = { text: JSON.stringify(review) };
        const ids = this.inputIds(inputs);
        for (const id of ids) await this.artifacts.get(context.source, id, context.tx);
        const receipt = {
          leaseId: context.leaseId,
          instanceId: context.snapshot.id,
          revision: context.snapshot.revision,
          actorId: context.caller.actorId,
          // Who directed this worker: no more independent of its lens than the worker is.
          sourceId: context.source.actorId,
          reviewId: review?.id ?? null,
          claimId: review?.claimId ?? null,
        };
        await context.tx.run(
          'INSERT INTO reflection_leases VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',
          context.leaseId,
          context.caller.projectId,
          context.snapshot.id,
          context.snapshot.revision,
          context.caller.actorId,
          JSON.stringify(receipt),
          JSON.stringify(inputs),
          JSON.stringify(ids),
          review?.id ?? null,
          review?.claimId ?? null,
        );
        return receipt;
      },
      check: async (context, receipt) => {
        const lease = await this.lease(context);
        checkReceipt(lease, receipt, 'Reflection lease receipt changed');
        if (lease.review_id) {
          // checkSubmit refuses a reviewer who is not independent of the reviewed work.
          const review = await this.reviews.checkSubmit(
            context.caller,
            lease.review_id,
            undefined,
            context.tx,
          );
          check(review.claimId === lease.claim_id, 'stale_claim', 'Review claim changed', 409);
        }
      },
      outputs: async (context) => {
        await this.lease(context);
        return {
          artifacts: (await this.artifacts.authored(context.caller, context.tx)).map((a) => a.id),
        };
      },
      release: async ({ lease, reason, tx }) =>
        await releasedLease(tx, this.reviews, 'reflection_leases', lease, reason, {
          instance_id: lease.instanceId,
        }),
    };
  }
  private policy(lens: boolean, version: number): WorkflowPolicy {
    const endable =
      (lens ? LENS_WORKFLOW_ENDABLE : REFLECTION_WORKFLOW_ENDABLE).version === version;
    const assignments = (lens ? ['reflecting'] : ['synthesizing', 'in_review']).map((state) => ({
      state,
      check: async (c: WorkflowCheckContext) => {
        await this.admit(c);
      },
      build: async (c: WorkflowCheckContext) => await this.build(c),
      references: async (c: WorkflowCheckContext) => await this.references(c),
      execution: this.execution(lens, state === 'in_review'),
      lease: this.hooks(),
    }));
    return {
      successStates: [lens ? 'complete' : 'approved'],
      // A lens has one way forward and nothing to return to; only the wave loops.
      ...(lens
        ? {}
        : {
            limits: [
              {
                name: 'review_returns',
                from: 'in_review',
                actions: ['revise_synthesis', 'restart_lenses'],
                max: this.limits.reviewReturns,
              },
            ],
            // Lenses hang off the wave by this table, not by a dependency edge, and every
            // restart makes five more: a rollup that missed them would miss most of the cost.
            children: async ({ caller, instanceId, tx }) =>
              (
                await tx.all<{ id: string }>(
                  'SELECT id FROM reflection_lenses WHERE reflection_id=? AND project_id=?',
                  instanceId,
                  caller.projectId,
                )
              ).map((row) => row.id),
          }),
      assignments,
      describe: async (context) => {
        const row = lens
          ? await this.lensRow(context.caller, context.snapshot.id, context.tx)
          : null;
        const wave = await this.row(
          context.caller,
          row?.reflection_id ?? context.snapshot.id,
          context.tx,
        );
        return {
          label: named({ wave, lens: row }),
          gate: context.snapshot.state,
          waiting:
            context.snapshot.state === 'reflecting' && !lens
              ? 'Wait for all five independent lens workflows to submit.'
              : 'Follow the current assignment and its exact pinned evidence.',
          references: (await this.lensRows(wave, context.tx)).map((child) => ({
            kind: 'workflow',
            id: child.id,
            label: child.perspective,
          })),
        };
      },
      actions: [
        ...(endable
          ? [
              {
                name: 'end',
                states: lens ? ['reflecting'] : ['reflecting', 'synthesizing', 'in_review'],
                transitions: ['abandon'],
                suggested: false,
                tool: 'reflection.end',
                instruction: lens
                  ? 'A lens ends only with its wave.'
                  : 'Abandon this wave when it cannot finish, as when five independent lens authors cannot be found. Its unfinished lenses end with it and new tasks and experiments may start again. Requires a specific reason. This is terminal.',
                ...(lens
                  ? {}
                  : {
                      requiredInput: ['reason'],
                      arguments: ({ snapshot }: WorkflowCheckContext) => ({
                        reflectionId: snapshot.id,
                        expectedRevision: snapshot.revision,
                      }),
                    }),
                check: async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
                  if (lens) {
                    const wave = (await this.lensRow(caller, snapshot.id, tx)).reflection_id;
                    const { state } = await this.workflows.get(caller, wave, tx);
                    check(
                      state === 'abandoned',
                      'reflection_open',
                      'A lens ends only with its wave',
                      409,
                    );
                  } else await this.ender(caller, await this.row(caller, snapshot.id, tx), tx);
                },
              },
            ]
          : []),
        ...(!lens
          ? [
              {
                name: 'join',
                states: ['reflecting'],
                transitions: ['join'],
                tool: 'reflection.submit_lens',
                suggested: false,
                instruction: 'The final lens joins the five completed child workflows.',
                check: async (c: WorkflowCheckContext) => {
                  const wave = await this.row(c.caller, c.snapshot.id, c.tx);
                  const children = await this.lensRows(wave, c.tx);
                  check(
                    children.length === 5 &&
                      (await everyAsync(
                        children,
                        async (child) =>
                          child.artifact &&
                          (await this.workflows.get(c.caller, child.id, c.tx)).state === 'complete',
                      )),
                    'reflection_lenses_incomplete',
                    'All five lens workflows must complete before synthesis',
                    409,
                  );
                },
              },
            ]
          : []),
        ...(lens
          ? [
              {
                name: 'submit',
                states: ['reflecting'],
                transitions: ['submit'],
                tool: 'reflection.submit_lens',
                instruction: 'Submit your own immutable lens report.',
                requiredInput: ['artifactId'],
                arguments: ({ snapshot }: WorkflowCheckContext) => ({
                  lensId: snapshot.id,
                  expectedRevision: snapshot.revision,
                }),
                check: async (c: WorkflowCheckContext) => {
                  await this.admit(c);
                  // The report is what the submission is about, so a question about the
                  // submission looks at it: an answer of ready for a report that is missing,
                  // written by somebody else, or has no Summary is an answer about nothing.
                  const artifactId = c.input?.artifactId;
                  if (typeof artifactId === 'string' && artifactId) {
                    const artifact = await this.author(c.caller, artifactId, c.tx);
                    check(
                      markdownSection(
                        (await this.artifacts.read(c.caller, artifact.id)).content,
                        'Summary',
                      ),
                      'reflection_summary_required',
                      'Lens report requires a nonempty Summary section',
                    );
                  }
                },
              },
            ]
          : [
              {
                name: 'submit',
                states: ['synthesizing'],
                transitions: ['submit'],
                tool: 'reflection.submit',
                instruction:
                  'Submit your report and change specification for independent review. An application/json change specification is validated as a structured plan and reviewed item by item; a text one is accepted but creates no work.',
                requiredInput: ['reportArtifactId', 'changeSpecArtifactId'],
                arguments: ({ snapshot }: WorkflowCheckContext) => ({
                  reflectionId: snapshot.id,
                  expectedRevision: snapshot.revision,
                }),
                check: async (c: WorkflowCheckContext) => {
                  await this.admit(c);
                  if (typeof c.input?.changeSpecArtifactId === 'string') {
                    const artifact = await this.author(
                      c.caller,
                      c.input.changeSpecArtifactId,
                      c.tx,
                    );
                    await this.plan(c.caller, artifact, c.tx, c.snapshot.data.requirePlan === true);
                  }
                },
              },
              {
                name: 'review',
                states: ['in_review'],
                transitions: ['approve', 'revise_synthesis', 'restart_lenses'],
                tool: 'review.submit',
                instruction:
                  'Verify the pinned synthesis and maintain Methods/Results with your own paperChanges in the verdict. If no paper edit is warranted, explain why in notes; pass or return to synthesizing/reflection.',
                requiredInput: ['verdict', 'notes', 'synopsis', 'findings'],
                arguments: async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
                  const wave = await this.row(caller, snapshot.id, tx);
                  const review = await this.reviews.get(caller, wave.review_id!, tx);
                  return {
                    reviewId: review.id,
                    ...(review.claimId ? { claimId: review.claimId } : {}),
                    expectedRevision: snapshot.revision,
                  };
                },
                check: async (c: WorkflowCheckContext) => {
                  await this.admit(c);
                  // A verdict needs the claim; before it, start_review is the step. A proposed
                  // verdict is checked as the verdict, so ready means the call will take it.
                  const wave = await this.row(c.caller, c.snapshot.id, c.tx);
                  const review = await this.reviews.checkSubmit(
                    c.caller,
                    wave.review_id!,
                    c.input as Parameters<Reviews['checkSubmit']>[2],
                    c.tx,
                  );
                  const input = c.input as unknown as ReviewApplication | undefined;
                  if (input && input.paperChanges !== undefined)
                    await this.paper.checkReview(
                      c.caller,
                      {
                        ...input.paperChanges,
                        source: {
                          kind: 'reflection',
                          id: wave.id,
                          revision: review.subjectRevision,
                        },
                        reviewId: review.id,
                        verdict: input.verdict,
                        evidenceIds: review.artifactIds,
                      },
                      c.tx,
                    );
                },
              },
              {
                name: 'start_review',
                states: ['in_review'],
                tool: 'review.start',
                instruction: 'Claim this exact independent reflection review.',
                arguments: async ({ caller, snapshot, tx }: WorkflowCheckContext) => ({
                  reviewId: (await this.row(caller, snapshot.id, tx)).review_id!,
                }),
                check: async ({ caller, snapshot, tx }: WorkflowCheckContext) => {
                  const wave = await this.row(caller, snapshot.id, tx);
                  check(wave.review_id, 'stale_review', 'Reflection review is missing', 409);
                  await this.reviews.checkStart(caller, wave.review_id, tx);
                },
              },
            ]),
      ],
    };
  }
  private async author(caller: Caller, id: string, tx: Transaction): Promise<Artifact> {
    const artifact = await this.artifacts.get(caller, id, tx);
    check(
      artifact.createdBy === caller.actorId,
      'artifact_author_required',
      'Submit your own immutable evidence',
      403,
    );
    if (caller.session)
      check(
        (await this.artifacts.authored(caller, tx)).some((a) => a.id === id),
        'artifact_execution_required',
        'Evidence must be authored in this execution',
        403,
      );
    const read = await this.artifacts.read(caller, id);
    check(
      read.encoding === 'utf8' && visible(read.content),
      'reflection_text_required',
      'Reflection evidence must be nonempty UTF-8 text',
    );
    return artifact;
  }
  /**
   * The plan a JSON change specification states. The media type is the author's declaration:
   * text is never parsed, so prose can never become work by resembling a plan.
   */
  private async plan(
    caller: Caller,
    changeSpec: Artifact,
    tx: Transaction,
    required = false,
  ): Promise<ChangeSpec | undefined> {
    check(
      !required || changeSpec.mediaType === 'application/json',
      'reflection_plan_required',
      'Automatic research requires an application/json change specification with a continue or stop decision',
      409,
    );
    if (changeSpec.mediaType !== 'application/json') return undefined;
    const plan = parseChangeSpec((await this.artifacts.read(caller, changeSpec.id)).content);
    // Work carried into the next cycle becomes its prerequisite, so it has to be real work here.
    for (const { workflowId } of plan.carriedOver) {
      const carried = await this.workflows.get(caller, workflowId, tx).catch((error: unknown) => {
        if (error instanceof MervError && error.code === 'not_found') return undefined;
        throw error;
      });
      check(
        carried && ['task', 'experiment'].includes(carried.workflow),
        'invalid_change_spec',
        `carriedOver ${workflowId} is not a task or experiment in this project`,
      );
    }
    return plan;
  }
  async submitLens(
    caller: Caller,
    input: ReflectionLensSubmit,
    transaction?: Transaction,
  ): Promise<ReflectionLens> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'submit_lens', input, tx, async () => {
        const lens = await this.lensRow(caller, input.lensId, tx);
        const snapshot = await this.workflows.get(caller, lens.id, tx);
        const context = { caller, snapshot, tx };
        await this.admit(context);
        check(
          snapshot.revision === input.expectedRevision,
          'revision_conflict',
          'Lens changed; refresh its assignment',
          409,
        );
        const artifact = await this.author(caller, input.artifactId, tx);
        const text = (await this.artifacts.read(caller, artifact.id)).content;
        check(
          markdownSection(text, 'Summary'),
          'reflection_summary_required',
          'Lens report requires a nonempty Summary section',
        );
        await this.moved(
          caller,
          {
            instanceId: lens.id,
            expectedRevision: input.expectedRevision,
            action: 'submit',
            input: { ...input },
            requestId: childRequest(caller, 'reflection', 'lens-submit', input.requestId),
          },
          tx,
        );
        await tx.run(
          'UPDATE reflection_lenses SET producer_id=?,artifact=? WHERE id=?',
          caller.actorId,
          JSON.stringify(artifact),
          lens.id,
        );
        const wave = await this.row(caller, lens.reflection_id, tx);
        const children = await this.lensRows(wave, tx);
        if (children.length === 5 && children.every((child) => child.artifact)) {
          const parent = await this.workflows.get(caller, wave.id, tx);
          await this.moved(
            caller,
            {
              instanceId: wave.id,
              expectedRevision: parent.revision,
              action: 'join',
              requestId: `reflection:${wave.id}:join:${wave.attempt}`,
              data: { lensIds: children.map((child) => child.id) },
            },
            tx,
          );
        }
        await recorded(this.state, tx, caller, 'reflection.lens_submitted', lens.id, {
          reflectionId: wave.id,
          attempt: wave.attempt,
          artifactId: artifact.id,
        });
        return await this.lens(caller, lens.id, tx);
      });
    });
  }
  async submit(
    caller: Caller,
    input: ReflectionSubmit,
    transaction?: Transaction,
  ): Promise<Reflection> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'submit', input, tx, async () => {
        const wave = await this.row(caller, input.reflectionId, tx);
        const snapshot = await this.workflows.get(caller, wave.id, tx);
        // A wave that moved on answers with the conflict, not with the next state's rules.
        check(
          snapshot.revision === input.expectedRevision,
          'revision_conflict',
          'Reflection changed; refresh its assignment',
          409,
        );
        check(
          snapshot.state !== 'in_review',
          'reflection_in_review',
          'Reflection is under review; synthesis returns only with the verdict',
          409,
        );
        await this.admit({ caller, snapshot, tx });
        check(
          input.reportArtifactId !== input.changeSpecArtifactId,
          'distinct_evidence_required',
          'Report and change specification must be distinct artifacts',
        );
        const submission: Submission = {
          report: await this.author(caller, input.reportArtifactId, tx),
          changeSpec: await this.author(caller, input.changeSpecArtifactId, tx),
          producerId: caller.actorId,
        };
        const plan = await this.plan(
          caller,
          submission.changeSpec,
          tx,
          snapshot.data.requirePlan === true,
        );
        if (plan) submission.plan = plan;
        const lenses = await this.lensRows(wave, tx);
        check(
          lenses.length === 5 && lenses.every((lens) => lens.artifact),
          'reflection_lenses_incomplete',
          'All five lens submissions are required',
          409,
        );
        const next = await this.moved(
          caller,
          {
            instanceId: wave.id,
            expectedRevision: input.expectedRevision,
            action: 'submit',
            input: { ...input },
            requestId: childRequest(caller, 'reflection', 'submit', input.requestId),
          },
          tx,
        );
        const pinnedInputIds = lenses.map((lens) => (JSON.parse(lens.artifact!) as Artifact).id);
        const review = await this.reviews.request(
          caller,
          {
            subjectId: wave.id,
            subjectRevision: next.revision,
            producerId: caller.actorId,
            administrativeActorId: wave.owner_id,
            artifactIds: [
              ...new Set([submission.report.id, submission.changeSpec.id, ...pinnedInputIds]),
            ],
            pinnedInputIds,
            // Lens authors, whoever directed a lens worker, the owner and the authority that
            // directed a worker's synthesis are none of them independent of it.
            excludedActorIds: [
              ...new Set([
                ...lenses.map((lens) => lens.producer_id!),
                ...(
                  await tx.all<{ receipt: string }>(
                    `SELECT receipt FROM reflection_leases WHERE project_id=? AND instance_id IN (${lenses.map(() => '?').join(',')})`,
                    caller.projectId,
                    ...lenses.map((lens) => lens.id),
                  )
                )
                  .map((row) => (JSON.parse(row.receipt) as { sourceId?: string }).sourceId)
                  .filter((id): id is string => typeof id === 'string'),
                ...(caller.session
                  ? [wave.owner_id, (await this.scope.authorityActor(caller, tx)).id]
                  : []),
              ]),
            ],
            criteria: [...REFLECTION_CRITERIA, ...(submission.plan ? [CHANGE_SPEC_CRITERION] : [])],
            formatVersion: 2,
            requestId: childRequest(caller, 'reflection', 'review-request', input.requestId),
          },
          tx,
        );
        await tx.run(
          'UPDATE reflections SET submission=?,review_id=? WHERE id=?',
          JSON.stringify(submission),
          review.id,
          wave.id,
        );
        await recorded(this.state, tx, caller, 'reflection.submitted', wave.id, {
          reviewId: review.id,
          attempt: wave.attempt,
        });
        return await this.get(caller, wave.id, tx);
      });
    });
  }
  /** Only the owner or an operator ends a wave, and never a worker assigned to it. */
  private async ender(caller: Caller, wave: WaveRow, tx: Transaction): Promise<void> {
    const actor = await this.scope.require(caller, 'write', tx);
    check(
      !caller.session && (actor.id === wave.owner_id || actor.role === 'operator'),
      'forbidden',
      'Only the reflection owner or an operator may end it',
      403,
    );
  }
  async end(caller: Caller, input: ReflectionEnd, transaction?: Transaction): Promise<Reflection> {
    ({ caller, input } = structuredClone({ caller, input }));
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      return await this.command(caller, 'end', input, tx, async () => {
        check(
          typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 16000,
          'invalid_reason',
          'A specific reason of 1–16000 characters is required to end a wave',
        );
        const wave = await this.row(caller, input.reflectionId, tx);
        await this.moved(
          caller,
          {
            instanceId: wave.id,
            expectedRevision: input.expectedRevision,
            action: 'abandon',
            input: { reason: input.reason },
            data: { reason: input.reason },
            requestId: childRequest(caller, 'reflection', 'end', input.requestId),
          },
          tx,
        );
        for (const lens of await this.lensRows(wave, tx)) {
          const snapshot = await this.workflows.get(caller, lens.id, tx);
          if (snapshot.state === 'reflecting')
            await this.moved(
              caller,
              {
                instanceId: lens.id,
                expectedRevision: snapshot.revision,
                action: 'abandon',
                requestId: childRequest(caller, 'reflection', `end-${lens.id}`, input.requestId),
              },
              tx,
            );
        }
        await tx.run('UPDATE reflections SET abandoned=? WHERE id=?', now(), wave.id);
        const review = wave.review_id && (await this.reviews.get(caller, wave.review_id, tx));
        if (review && ['requested', 'started'].includes(review.status))
          await this.reviews.supersede(caller, review.id, tx);
        await recorded(this.state, tx, caller, 'reflection.abandoned', wave.id, {
          reason: input.reason,
        });
        return await this.get(caller, wave.id, tx);
      });
    });
  }
  private async submitReview(
    caller: Caller,
    input: ReviewApplication,
    tx: Transaction,
  ): Promise<Reflection> {
    await this.scope.require(caller, 'review', tx);
    return await this.command(caller, 'review', input, tx, async () => {
      const review = await this.reviews.get(caller, input.reviewId, tx);
      const wave = await this.row(caller, review.subjectId, tx);
      const snapshot = await this.workflows.get(caller, wave.id, tx);
      check(
        wave.review_id === review.id &&
          snapshot.state === 'in_review' &&
          review.subjectRevision === snapshot.revision,
        'stale_review',
        'Only the exact current reflection review can be submitted',
        409,
      );
      check(
        snapshot.revision === input.expectedRevision,
        'revision_conflict',
        `Expected revision ${input.expectedRevision}, found ${snapshot.revision}`,
        409,
      );
      // admit() also checks the reviewer's independence.
      await this.admit({ caller, snapshot, tx });
      const route = input.verdict === 'pass' ? 'approved' : (input.returnTo ?? 'synthesizing');
      check(
        input.verdict === 'pass'
          ? input.returnTo === undefined
          : ['reflecting', 'synthesizing'].includes(route),
        'invalid_review_return',
        'Pass accepts no returnTo; rejections return to synthesizing or reflecting',
      );
      await this.reviews.checkSubmit(caller, input.reviewId, input, tx);
      const action =
        route === 'approved'
          ? 'approve'
          : route === 'reflecting'
            ? 'restart_lenses'
            : 'revise_synthesis';
      // Domain checks were completed above; generic transition still performs revision CAS.
      const next = await this.moved(
        caller,
        {
          instanceId: wave.id,
          expectedRevision: input.expectedRevision,
          action,
          input: { ...input },
          requestId: childRequest(caller, 'reflection', 'review', input.requestId),
        },
        tx,
      );
      await this.reviews.submit(caller, input, tx);
      if (input.paperChanges !== undefined)
        await this.paper.applyReview(
          caller,
          {
            ...input.paperChanges,
            source: { kind: 'reflection', id: wave.id, revision: review.subjectRevision },
            reviewId: review.id,
            verdict: input.verdict,
            evidenceIds: review.artifactIds,
          },
          tx,
        );
      if (route === 'approved') {
        const submission = JSON.parse(wave.submission!) as Submission;
        const approved: ApprovedReflection = {
          id: wave.id,
          projectId: wave.project_id,
          revision: next.revision,
          ...submission,
          lenses: (await this.lensRows(wave, tx)).map((lens) => ({
            id: lens.id,
            perspective: lens.perspective,
            artifact: JSON.parse(lens.artifact!) as Artifact,
            producerId: lens.producer_id!,
          })),
          reviewId: review.id,
          reviewerId: caller.actorId,
          approvedAt: now(),
        };
        await tx.run(
          'UPDATE reflections SET approved=? WHERE id=?',
          JSON.stringify(approved),
          wave.id,
        );
      } else {
        const feedback = [
          ...(JSON.parse(wave.feedback) as unknown[]),
          await this.reviews.get(caller, review.id, tx),
        ];
        await tx.run(
          'UPDATE reflections SET feedback=?,attempt=attempt+? WHERE id=?',
          JSON.stringify(feedback),
          route === 'reflecting' ? 1 : 0,
          wave.id,
        );
        if (route === 'reflecting')
          await this.createLenses(caller, await this.row(caller, wave.id, tx), tx);
      }
      await recorded(
        this.state,
        tx,
        caller,
        `reflection.${route === 'approved' ? 'approved' : 'returned'}`,
        wave.id,
        { reviewId: review.id, returnTo: route },
      );
      return await this.get(caller, wave.id, tx);
    });
  }
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
  ): Promise<ApprovedReflection> {
    caller = structuredClone(caller);
    return await inTransaction(this.state, transaction, async (tx) => {
      const wave = await this.row(caller, id, tx);
      check(
        wave.approved,
        'reflection_not_approved',
        'Reflection needs independent approval before consolidation',
        409,
      );
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
  inject: ['state', 'scope', 'artifacts', 'paper', 'workflows', 'reviews', 'contextBuilder'],
  Config: configuration,
  async apply(ctx: Context, config: z.infer<typeof configuration>) {
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
          config.limits,
        ),
      );
      yield () => service.close();
      yield ctx.provide('reflections', service);
    });
  },
};
export default reflectionsPlugin;
