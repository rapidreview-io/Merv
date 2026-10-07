import { excludedFromReview, reviewActions, reviewHistory } from '@merv/reviews/rules';
import {
  heldLease,
  insertLease,
  leaseRows,
  liveLease,
  reviewedLeaseHooks,
  type LeaseRow as WorkflowLeaseRow,
} from '@merv/workflows/lease-rows';
import {
  everyAsync,
  sha256Hex,
  markdownSection,
  check,
  type Artifact,
  type Caller,
  type ContextInput,
  type ContextItem,
  type ReviewRequest,
  type Reviews,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
} from '@merv/contracts';
import { artifactItem, itemArtifactIds, textItem } from '@merv/context-builder/artifact-item';
import { grant, reference, target } from '@merv/workflows/rules';
import { lensName } from './names.js';
import { ITEM_RECIPES } from './definitions.js';
import type { ChangeSpec, ReflectionReview } from './types.js';
import type { ReflectionsContext } from './index.js';
import { author, ender, plan } from './commands.js';

// What both reflection workflows run on the server: who is admitted to a step, what its
// assignment holds, and the policy and lease hooks Workflows applies. Each runs on
// ReflectionService (index.ts) as its ReflectionsContext.
export interface WaveRow {
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
export interface LensRow {
  id: string;
  project_id: string;
  reflection_id: string;
  attempt: number;
  perspective: string;
  instructions: string;
  producer_id: string | null;
  artifact: string | null;
}
export interface Submission {
  report: Artifact;
  changeSpec: Artifact;
  /** Set only for an application/json change specification; approval copies it unchanged. */
  plan?: ChangeSpec;
  producerId: string;
}
export interface Current {
  wave: WaveRow;
  lens: LensRow | null;
}
/** A wave's or lens's lease: the inputs it froze and the artifacts they cite. */
export type LeaseRow = WorkflowLeaseRow<{
  inputs: Record<string, ContextInput>;
  artifacts: string[];
}>;
/** Every step is named as its record is: a wave by its title, a lens by its wave and perspective in words. */
const named = ({ wave, lens }: Current) =>
  lens ? `${wave.title}: ${lensName(lens.perspective)}` : wave.title;
export const submitted = (wave: WaveRow) =>
  wave.submission ? (JSON.parse(wave.submission) as Submission) : null;
export const summarized = (content: string) =>
  check(
    markdownSection(content, 'Summary'),
    'reflection_summary_required',
    'Lens report requires a nonempty Summary section',
  );
/** The paper changes a reflection verdict carries, as Paper checks and applies them. */
export const paperReview = (wave: WaveRow, review: ReviewRequest, input: ReflectionReview) => ({
  ...input.paperChanges!,
  source: { kind: 'reflection' as const, id: wave.id, revision: review.subjectRevision },
  reviewId: review.id,
  verdict: input.verdict,
  evidenceIds: review.artifactIds,
});
/**
 * Each section's items as a format-2 input. The assignment and the review criteria are embedded
 * whole, or the build fails; every other source is embedded while it fits.
 */
const embedded = (sections: Record<string, ContextItem[]>): Record<string, ContextInput> =>
  Object.fromEntries(
    Object.entries(sections).map(([key, items]) => [
      key,
      {
        items:
          key === 'assignment' || key === 'assessment'
            ? items.map((item) => ({ ...item, embed: 'always' as const }))
            : items,
      },
    ]),
  );
/** The instance's wave and, for a lens, the lens, whichever attempt it belongs to. */
export async function records(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
): Promise<Current> {
  const lens =
    context.snapshot.workflow === 'reflection.lens'
      ? await ctx.lensRow(context.caller, context.snapshot.id, context.tx)
      : null;
  const wave = await ctx.row(
    context.caller,
    lens?.reflection_id ?? context.snapshot.id,
    context.tx,
  );
  return { wave, lens };
}
/** The instance's records, refusing a lens of an attempt that is no longer reflecting. */
export async function current(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
): Promise<Current> {
  const { wave, lens } = await records(ctx, context);
  if (lens) {
    const parent = await ctx.workflows.get(context.caller, wave.id, context.tx);
    check(
      lens.attempt === wave.attempt && parent.state === 'reflecting',
      'stale_reflection_lens',
      'This lens is not part of the active reflection attempt',
      409,
    );
  }
  return { wave, lens };
}
/** The step this check is about: the wave or lens at its revision. */
const step = ({ caller, snapshot }: WorkflowCheckContext) => ({
  projectId: caller.projectId,
  instanceId: snapshot.id,
  revision: snapshot.revision,
});
/** The live lease on the step, whoever holds it. */
export async function activeLease(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
): Promise<LeaseRow | undefined> {
  return await liveLease<LeaseRow['details']>(ctx.state, context.tx, step(context));
}
/** The caller's own live lease on the step. */
export async function lease(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
): Promise<LeaseRow> {
  return await heldLease<LeaseRow['details']>(ctx.state, context.tx, step(context), context.caller);
}
/** A leased worker's inputs as frozen when it acquired the lease; anyone else's as they stand. */
export async function assignmentInputs(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
  current: Current,
  held?: LeaseRow,
): Promise<Record<string, ContextInput>> {
  return context.caller.session
    ? (held ?? (await lease(ctx, context))).details.inputs
    : await inputs(ctx, context, current);
}
/** Each lens of an attempt has its own author. */
export function distinctAuthor(
  ctx: ReflectionsContext,
  lens: LensRow,
  lenses: LensRow[],
  actorId: string,
): void {
  check(
    !lenses.some((other) => other.id !== lens.id && other.producer_id === actorId),
    'lens_independence',
    'Each lens requires a different agent identity',
    403,
  );
}
/**
 * Every lens author and the synthesis author produced the wave, and a reviewer one of them
 * directs is that author's hand.
 */
export async function independent(
  ctx: ReflectionsContext,
  caller: Caller,
  wave: WaveRow,
  tx: Transaction,
): Promise<void> {
  const authors = [
    submitted(wave)?.producerId,
    ...(await ctx.lensRows(wave, tx)).map((lens) => lens.producer_id),
  ];
  const authority = (await ctx.scope.authorityActor(caller, tx)).id;
  check(
    !authors.includes(caller.actorId) && !authors.includes(authority),
    'review_independence',
    'Reflection review must be independent of every lens author and the synthesis author',
    403,
  );
}
/** Admits the caller to the instance's current step; a leased worker's lease is returned. */
export async function admit(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
  delegated = false,
): Promise<Current & { lease: LeaseRow | undefined }> {
  const { caller, snapshot, tx } = context;
  const { wave, lens } = await current(ctx, context);
  const reviewing = snapshot.state === 'in_review';
  await ctx.scope.require(caller, reviewing ? 'review' : 'write', tx);
  const held = caller.session ? await lease(ctx, context) : await activeLease(ctx, context);
  if (!caller.session)
    check(!held, 'reflection_leased', 'A worker owns this reflection assignment', 409);
  if (lens) {
    check(
      !lens.artifact && snapshot.state === 'reflecting',
      'reflection_lens_complete',
      'Lens has already submitted',
      409,
    );
    if (!delegated) {
      const lenses = await ctx.lensRows(wave, tx);
      distinctAuthor(ctx, lens, lenses, caller.actorId);
      const parallel = await ctx.once(`leases:${caller.projectId}:${caller.actorId}`, () =>
        leaseRows(tx, { projectId: caller.projectId, actorId: caller.actorId, active: true }),
      );
      check(
        !parallel.some(
          (entry) =>
            entry.instance_id !== snapshot.id &&
            lenses.some((other) => other.id === entry.instance_id),
        ),
        'lens_independence',
        'An agent cannot work on two perspectives in one attempt',
        403,
      );
    }
  } else if (reviewing) {
    check(wave.review_id, 'stale_review', 'Reflection review is missing', 409);
    const review = await ctx.reviews.get(caller, wave.review_id, tx);
    // An owner's override lifts this too; Reviews holds the claim to the owner who took it.
    if (!review.override) await independent(ctx, caller, wave, tx);
    check(
      review.subjectRevision === snapshot.revision,
      'stale_review',
      'Reflection review changed',
      409,
    );
    if (!delegated) {
      if (review.status === 'requested') await ctx.reviews.checkStart(caller, review.id, tx);
      else await ctx.reviews.checkSubmit(caller, review.id, undefined, tx);
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
    const authority = await ctx.scope.authorityActor(caller, tx);
    check(
      authority.id === wave.owner_id || authority.role === 'operator',
      'forbidden',
      'Only the reflection owner or an operator may perform or delegate synthesis',
      403,
    );
  }
  return { wave, lens, lease: held };
}
export async function inputs(
  ctx: ReflectionsContext,
  context: WorkflowCheckContext,
  { wave, lens }: Current,
): Promise<Record<string, ContextInput>> {
  const submission = submitted(wave);
  const review =
    context.snapshot.state === 'in_review' && wave.review_id
      ? await ctx.reviews.get(context.caller, wave.review_id, context.tx)
      : null;
  const lensRows = (await ctx.lensRows(wave, context.tx)).filter((entry) => entry.artifact);
  const reviews = JSON.parse(wave.feedback) as ReviewRequest[];
  const previousCycle = (
    lens ? await ctx.workflows.get(context.caller, wave.id, context.tx) : context.snapshot
  ).data.previousCycleDigestId;
  const noted = (artifact: Artifact, priority: number, note: string): ContextItem =>
    artifactItem(artifact, {
      id: `artifact:${artifact.id}:${sha256Hex(Buffer.from(note)).slice(0, 12)}`,
      priority,
      note,
    });
  const assignment = JSON.stringify({
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
  });
  // A published section that repeats a current one says so itself: the builder names the copy.
  const stage = lens ? 'lens' : context.snapshot.state === 'in_review' ? 'review' : 'synthesis';
  const { maxChars } = ITEM_RECIPES.find((entry) => entry.name === `reflection.${stage}`)!.recipe;
  const paper = await ctx.paper.contextInput(context.caller, maxChars, context.tx);
  const lensItems = lensRows.map((entry) =>
    noted(
      JSON.parse(entry.artifact!) as Artifact,
      800,
      `reflection ${wave.id}; ${entry.perspective} lens ${entry.id}; attempt ${entry.attempt}`,
    ),
  );
  const historicalRounds = reviewHistory(
    reviews.map((entry) => ({ review: entry })),
    Number.MAX_SAFE_INTEGER,
  ).rounds;
  const reviewItems = historicalRounds.map((entry, index) =>
    textItem(`review:${entry.reviewId}`, `Reflection review ${index + 1}`, JSON.stringify(entry), {
      priority: index === historicalRounds.length - 1 ? 700 : 350,
      note: `reflection ${wave.id}; earlier review round ${index + 1}`,
      refs: [{ tool: 'review.get', input: { reviewId: entry.reviewId } }],
    }),
  );
  const reviewerFeedback =
    review && (reviews.length || review.recovery)
      ? [
          textItem(
            `review:${review.id}:limited-feedback`,
            'Prior review synopsis and current recovery',
            JSON.stringify({
              previousReviews: reviews.slice(-1).map(({ id, synopsis }) => ({ id, synopsis })),
              recovery: review.recovery ?? null,
            }),
            {
              priority: 700,
              note: `reflection ${wave.id}; limited reviewer feedback`,
              refs: [
                ...(reviews.length
                  ? [{ tool: 'review.get', input: { reviewId: reviews.at(-1)!.id } }]
                  : []),
                { tool: 'review.get', input: { reviewId: review.id } },
              ],
            },
          ),
        ]
      : [];
  const previousArtifact =
    typeof previousCycle === 'string'
      ? await ctx.artifacts.get(context.caller, previousCycle, context.tx)
      : null;
  return embedded({
    assignment: [
      textItem(
        `reflection:${wave.id}:${lens ? `lens:${lens.id}` : 'wave'}:${context.snapshot.revision}`,
        lens ? `${lens.perspective} lens assignment` : 'Reflection assignment',
        assignment,
        {
          priority: 1000,
          note: `reflection ${wave.id}; attempt ${wave.attempt}`,
          refs: [
            lens
              ? { tool: 'reflection.lens', input: { lensId: lens.id } }
              : { tool: 'reflection.get', input: { reflectionId: wave.id } },
          ],
        },
      ),
    ],
    projectPaper: paper.items,
    research: [],
    lenses: lens ? [] : lensItems,
    submission:
      review && submission
        ? [
            noted(submission.report, 780, `reflection ${wave.id}; synthesis report`),
            noted(submission.changeSpec, 780, `reflection ${wave.id}; change specification`),
          ]
        : [],
    assessment: review
      ? [
          textItem(
            `review:${review.id}:assessment`,
            'Exact independent review criteria',
            JSON.stringify(review),
            {
              priority: 950,
              note: `reflection ${wave.id}; current review`,
              refs: [{ tool: 'review.get', input: { reviewId: review.id } }],
            },
          ),
        ]
      : [],
    feedback: review ? reviewerFeedback : reviewItems.slice(-1),
    ...(!review ? { history: reviewItems.slice(0, -1) } : {}),
    previousCycle: previousArtifact
      ? [noted(previousArtifact, 300, `predecessor cycle of reflection ${wave.id}`)]
      : [],
  });
}
/** Every artifact the inputs name: the worker's artifact grants and the ones its source
 *  approved at acquisition. */
export async function references(ctx: ReflectionsContext, context: WorkflowCheckContext) {
  const found = await current(ctx, context);
  const { wave, lens } = found;
  const inputs = await assignmentInputs(ctx, context, found);
  const review =
    !lens && context.snapshot.state === 'in_review' && wave.review_id
      ? await ctx.reviews.get(context.caller, wave.review_id, context.tx)
      : null;
  return {
    // Native Sandboxes knows only task and experiment work; a reflection's checks run as a task.
    computeKind: 'task',
    researchReviews: (JSON.parse(wave.feedback) as { id: string }[]).map((review) => review.id),
    reflectionId: wave.id,
    artifacts: [
      ...new Set([
        ...itemArtifactIds(inputs),
        ...(context.caller.session
          ? (await ctx.artifacts.executionOutputs(context.caller, context.tx)).map((a) => a.id)
          : []),
      ]),
    ],
    ...(review
      ? { reviewId: review.id, ...(review.claimId ? { claimId: review.claimId } : {}) }
      : {}),
  };
}
export async function build(ctx: ReflectionsContext, context: WorkflowCheckContext) {
  const { lease, ...current } = await admit(ctx, context);
  const { wave, lens } = current;
  const stage = lens ? 'lens' : context.snapshot.state === 'in_review' ? 'review' : 'synthesis';
  const recipe = ITEM_RECIPES.find((entry) => entry.name === `reflection.${stage}`)!;
  const inputs = await assignmentInputs(ctx, context, current, lease);
  const preview = await ctx.contexts
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
export function execution(
  ctx: ReflectionsContext,
  lens: boolean,
  reviewing: boolean,
): WorkflowExecutionPolicy {
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
export function hooks(
  ctx: ReflectionsContext,
): NonNullable<NonNullable<WorkflowPolicy['assignments']>[number]['lease']> {
  return reviewedLeaseHooks({
    reviews: ctx.reviews,
    artifacts: ctx.artifacts,
    excluded: excludedFromReview,
    label: async (context) => named(await current(ctx, context)),
    review: async (context) => {
      const { wave, lens } = await current(ctx, context);
      return !lens && context.snapshot.state === 'in_review' ? wave.review_id : null;
    },
    lease: async (context) => await lease(ctx, context),
    role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
      check(!context.caller.session, 'forbidden', 'A worker cannot delegate assignments', 403);
      await admit(ctx, context, true);
      return context.snapshot.state === 'in_review' ? 'reviewer' : 'producer';
    },
    acquire: async (context) => {
      const source = { ...context, caller: context.source };
      const { wave, lens } = await admit(ctx, source, true);
      if (lens)
        distinctAuthor(ctx, lens, await ctx.lensRows(wave, context.tx), context.caller.actorId);
      // Reviews refuses a worker who wrote a lens or the synthesis (review_independence), and
      // Workflows admits the worker through admit() right after this hook.
      const review =
        context.snapshot.state === 'in_review' && wave.review_id
          ? await ctx.reviews.start(context.caller, wave.review_id, context.tx)
          : null;
      const frozen = await inputs(ctx, source, { wave, lens });
      if (review) {
        const assessment = frozen.assessment;
        check(
          assessment && 'items' in assessment && assessment.items.length === 1,
          'invalid_context',
          'Reflection review assessment is missing',
        );
        frozen.assessment = {
          items: [{ ...assessment.items[0]!, body: { text: JSON.stringify(review) } }],
        };
      }
      const ids = itemArtifactIds(frozen);
      await ctx.artifacts.getAll(context.source, ids, context.tx);
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
      await insertLease(context.tx, {
        id: context.leaseId,
        projectId: context.caller.projectId,
        snapshot: context.snapshot,
        actorId: context.caller.actorId,
        sourceActorId: context.source.actorId,
        reviewId: review?.id ?? null,
        claimId: review?.claimId ?? null,
        receipt,
        details: { inputs: frozen, artifacts: ids },
      });
      return receipt;
    },
  });
}
export function policy(ctx: ReflectionsContext, lens: boolean): WorkflowPolicy {
  const assignments = (lens ? ['reflecting'] : ['synthesizing', 'in_review']).map((state) => ({
    state,
    check: async (c: WorkflowCheckContext) => {
      await admit(ctx, c);
    },
    build: async (c: WorkflowCheckContext) => await build(ctx, c),
    references: async (c: WorkflowCheckContext) => await references(ctx, c),
    execution: execution(ctx, lens, state === 'in_review'),
    lease: hooks(ctx),
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
              max: ctx.limits.reviewReturns,
            },
          ],
          // Lenses hang off the wave by this table, not by a dependency edge, and every
          // restart makes five more: a rollup that missed them would miss most of the cost.
          children: async ({ projectId, instanceIds, tx }) => {
            const lenses: Record<string, string[]> = {};
            for (const row of await tx.all<{ id: string; reflection_id: string }>(
              `SELECT id,reflection_id FROM reflection_lenses WHERE project_id=? AND reflection_id IN (${instanceIds.map(() => '?').join(',')})`,
              projectId,
              ...instanceIds,
            ))
              (lenses[row.reflection_id] ??= []).push(row.id);
            return lenses;
          },
        }),
    assignments,
    // Every instance is described, a lens of an earlier attempt too, so staleness is no refusal.
    describe: async (context) => {
      const record = await records(ctx, context);
      const { wave } = record;
      return {
        label: named(record),
        // A lens is its wave's: what its agent asks, the wave's owner answers.
        owner: { actorId: wave.owner_id },
        gate: context.snapshot.state,
        waiting:
          context.snapshot.state === 'reflecting' && !lens
            ? 'Wait for all five independent lens workflows to submit.'
            : 'Follow the current assignment and its exact pinned evidence.',
        references: (await ctx.lensRows(wave, context.tx)).map((child) => ({
          kind: 'workflow',
          id: child.id,
          label: lensName(child.perspective),
        })),
      };
    },
    actions: [
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
            const wave = (await ctx.lensRow(caller, snapshot.id, tx)).reflection_id;
            const { state } = await ctx.workflows.get(caller, wave, tx);
            check(state === 'abandoned', 'reflection_open', 'A lens ends only with its wave', 409);
          } else await ender(ctx, caller, await ctx.row(caller, snapshot.id, tx), tx);
        },
      },
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
                const wave = await ctx.row(c.caller, c.snapshot.id, c.tx);
                const children = await ctx.lensRows(wave, c.tx);
                check(
                  children.length === 5 &&
                    (await everyAsync(
                      children,
                      async (child) =>
                        child.artifact &&
                        (await ctx.workflows.get(c.caller, child.id, c.tx)).state === 'complete',
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
                if (ctx.checked.found(c)) return;
                await admit(ctx, c);
                // The report is what the submission is about, so a question about the
                // submission looks at it: an answer of ready for a report that is missing,
                // written by somebody else, or has no Summary is an answer about nothing.
                const artifactId = c.input?.artifactId;
                if (typeof artifactId === 'string' && artifactId)
                  summarized((await author(ctx, c.caller, artifactId, c.tx)).content);
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
                if (ctx.checked.found(c)) return;
                await admit(ctx, c);
                if (typeof c.input?.changeSpecArtifactId === 'string') {
                  const changeSpec = await author(
                    ctx,
                    c.caller,
                    c.input.changeSpecArtifactId,
                    c.tx,
                  );
                  await plan(ctx, c.caller, changeSpec, c.tx, c.snapshot.data.requirePlan === true);
                }
              },
            },
            ...reviewActions<WorkflowCheckContext>({
              names: { submit: 'review', start: 'start_review' },
              states: ['in_review'],
              transitions: ['approve', 'revise_synthesis', 'restart_lenses'],
              instructions: {
                submit:
                  'Verify the pinned synthesis and maintain Methods/Results with your own paperChanges in the verdict. If no paper edit is warranted, explain why in notes; pass, or return it with returnTo synthesizing or reflecting.',
                start: 'Claim this exact independent reflection review.',
              },
              reviews: ctx.reviews,
              current: async ({ caller, snapshot, tx }) => {
                const wave = await ctx.row(caller, snapshot.id, tx);
                check(wave.review_id, 'stale_review', 'Reflection review is missing', 409);
                return await ctx.reviews.get(caller, wave.review_id, tx);
              },
              submit: async (c) => {
                const { wave } = await admit(ctx, c);
                // A verdict needs the claim; before it, start_review is the step. A proposed
                // verdict is checked as the verdict, so ready means the call will take it.
                const review = await ctx.reviews.checkSubmit(
                  c.caller,
                  wave.review_id!,
                  c.input as Parameters<Reviews['checkSubmit']>[2],
                  c.tx,
                );
                const input = c.input as unknown as ReflectionReview | undefined;
                // At the verdict's own transition, submitReview's applyReview checks the
                // edits as it makes them, in this transaction.
                if (input && input.paperChanges !== undefined && !c.transition)
                  await ctx.paper.checkReview(c.caller, paperReview(wave, review, input), c.tx);
              },
            }),
          ]),
    ],
  };
}
