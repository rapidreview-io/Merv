import { excludedFromReview, reviewHistory, REVIEW_SUBMIT_INPUT } from '@merv/reviews/rules';
import {
  releasedLease,
  everyAsync,
  sha256Hex,
  checkReceipt,
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
import type { ReflectionService } from './index.js';

// What both reflection workflows run on the server: who is admitted to a step, what its
// assignment holds, and the policy and lease hooks Workflows applies. ReflectionService
// (index.ts) runs these as its own methods.
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
export interface LeaseRow {
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
  this: ReflectionService,
  context: WorkflowCheckContext,
): Promise<Current> {
  const lens =
    context.snapshot.workflow === 'reflection.lens'
      ? await this.lensRow(context.caller, context.snapshot.id, context.tx)
      : null;
  const wave = await this.row(
    context.caller,
    lens?.reflection_id ?? context.snapshot.id,
    context.tx,
  );
  return { wave, lens };
}
/** The instance's records, refusing a lens of an attempt that is no longer reflecting. */
export async function current(
  this: ReflectionService,
  context: WorkflowCheckContext,
): Promise<Current> {
  const { wave, lens } = await this.records(context);
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
export async function activeLease(
  this: ReflectionService,
  context: WorkflowCheckContext,
): Promise<LeaseRow | undefined> {
  const { caller, snapshot, tx } = context;
  return await this.once(`lease:${caller.projectId}:${snapshot.id}:${snapshot.revision}`, () =>
    tx.get<LeaseRow>(
      'SELECT * FROM reflection_leases WHERE project_id=? AND instance_id=? AND revision=? AND released_at IS NULL',
      caller.projectId,
      snapshot.id,
      snapshot.revision,
    ),
  );
}
export async function lease(
  this: ReflectionService,
  context: WorkflowCheckContext,
): Promise<LeaseRow> {
  return this.owned(context, await this.activeLease(context));
}
export function owned(
  this: ReflectionService,
  { caller }: WorkflowCheckContext,
  row: LeaseRow | undefined,
): LeaseRow {
  check(
    caller.session && row?.id === caller.session.id && row.actor_id === caller.actorId,
    'stale_lease',
    'Worker no longer owns this reflection assignment',
    409,
  );
  return row;
}
/** A leased worker's inputs as frozen when it acquired the lease; anyone else's as they stand. */
export async function assignmentInputs(
  this: ReflectionService,
  context: WorkflowCheckContext,
  current: Current,
  lease?: LeaseRow,
): Promise<Record<string, ContextInput>> {
  return context.caller.session
    ? (JSON.parse((lease ?? (await this.lease(context))).inputs) as Record<string, ContextInput>)
    : await this.inputs(context, current);
}
/** Each lens of an attempt has its own author. */
export function distinctAuthor(
  this: ReflectionService,
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
  this: ReflectionService,
  caller: Caller,
  wave: WaveRow,
  tx: Transaction,
): Promise<void> {
  const authors = [
    submitted(wave)?.producerId,
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
/** Admits the caller to the instance's current step; a leased worker's lease is returned. */
export async function admit(
  this: ReflectionService,
  context: WorkflowCheckContext,
  delegated = false,
): Promise<Current & { lease: LeaseRow | undefined }> {
  const { caller, snapshot, tx } = context;
  const { wave, lens } = await this.current(context);
  const reviewing = snapshot.state === 'in_review';
  await this.scope.require(caller, reviewing ? 'review' : 'write', tx);
  const lease = await this.activeLease(context);
  if (caller.session) this.owned(context, lease);
  else check(!lease, 'reflection_leased', 'A worker owns this reflection assignment', 409);
  if (lens) {
    check(
      !lens.artifact && snapshot.state === 'reflecting',
      'reflection_lens_complete',
      'Lens has already submitted',
      409,
    );
    if (!delegated) {
      const lenses = await this.lensRows(wave, tx);
      this.distinctAuthor(lens, lenses, caller.actorId);
      const parallel = await this.once(`leases:${caller.projectId}:${caller.actorId}`, () =>
        tx.all<{ instance_id: string }>(
          'SELECT instance_id FROM reflection_leases WHERE project_id=? AND actor_id=? AND released_at IS NULL',
          caller.projectId,
          caller.actorId,
        ),
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
  return { wave, lens, lease };
}
export async function inputs(
  this: ReflectionService,
  context: WorkflowCheckContext,
  { wave, lens }: Current,
): Promise<Record<string, ContextInput>> {
  const submission = submitted(wave);
  const review =
    context.snapshot.state === 'in_review' && wave.review_id
      ? await this.reviews.get(context.caller, wave.review_id, context.tx)
      : null;
  const lensRows = (await this.lensRows(wave, context.tx)).filter((entry) => entry.artifact);
  const reviews = JSON.parse(wave.feedback) as ReviewRequest[];
  const previousCycle = (
    lens ? await this.workflows.get(context.caller, wave.id, context.tx) : context.snapshot
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
  const paper = await this.paper.contextInput(context.caller, maxChars, context.tx);
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
      ? await this.artifacts.get(context.caller, previousCycle, context.tx)
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
export async function references(this: ReflectionService, context: WorkflowCheckContext) {
  const current = await this.current(context);
  const { wave, lens } = current;
  const inputs = await this.assignmentInputs(context, current);
  const review =
    !lens && context.snapshot.state === 'in_review' && wave.review_id
      ? await this.reviews.get(context.caller, wave.review_id, context.tx)
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
          ? (await this.artifacts.executionOutputs(context.caller, context.tx)).map((a) => a.id)
          : []),
      ]),
    ],
    ...(review
      ? { reviewId: review.id, ...(review.claimId ? { claimId: review.claimId } : {}) }
      : {}),
  };
}
export async function build(this: ReflectionService, context: WorkflowCheckContext) {
  const { lease, ...current } = await this.admit(context);
  const { wave, lens } = current;
  const stage = lens ? 'lens' : context.snapshot.state === 'in_review' ? 'review' : 'synthesis';
  const recipe = ITEM_RECIPES.find((entry) => entry.name === `reflection.${stage}`)!;
  const inputs = await this.assignmentInputs(context, current, lease);
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
export function execution(
  this: ReflectionService,
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
  this: ReflectionService,
): NonNullable<NonNullable<WorkflowPolicy['assignments']>[number]['lease']> {
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
      const source = { ...context, caller: context.source };
      const { wave, lens } = await this.admit(source, true);
      if (lens)
        this.distinctAuthor(lens, await this.lensRows(wave, context.tx), context.caller.actorId);
      // Reviews refuses a worker who wrote a lens or the synthesis (review_independence), and
      // Workflows admits the worker through admit() right after this hook.
      const review =
        context.snapshot.state === 'in_review' && wave.review_id
          ? await this.reviews.start(context.caller, wave.review_id, context.tx)
          : null;
      const inputs = await this.inputs(source, { wave, lens });
      if (review) {
        const assessment = inputs.assessment;
        check(
          assessment && 'items' in assessment && assessment.items.length === 1,
          'invalid_context',
          'Reflection review assessment is missing',
        );
        inputs.assessment = {
          items: [{ ...assessment.items[0]!, body: { text: JSON.stringify(review) } }],
        };
      }
      const ids = itemArtifactIds(inputs);
      await this.artifacts.getAll(context.source, ids, context.tx);
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
        artifacts: (await this.artifacts.executionOutputs(context.caller, context.tx)).map(
          (a) => a.id,
        ),
      };
    },
    release: async ({ lease, reason, tx }) =>
      await releasedLease(tx, this.reviews, 'reflection_leases', lease, reason, {
        instance_id: lease.instanceId,
      }),
  };
}
export function policy(this: ReflectionService, lens: boolean): WorkflowPolicy {
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
      const records = await this.records(context);
      const { wave } = records;
      return {
        label: named(records),
        gate: context.snapshot.state,
        waiting:
          context.snapshot.state === 'reflecting' && !lens
            ? 'Wait for all five independent lens workflows to submit.'
            : 'Follow the current assignment and its exact pinned evidence.',
        references: (await this.lensRows(wave, context.tx)).map((child) => ({
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
            const wave = (await this.lensRow(caller, snapshot.id, tx)).reflection_id;
            const { state } = await this.workflows.get(caller, wave, tx);
            check(state === 'abandoned', 'reflection_open', 'A lens ends only with its wave', 409);
          } else await this.ender(caller, await this.row(caller, snapshot.id, tx), tx);
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
                if (this.checked.found(c)) return;
                await this.admit(c);
                // The report is what the submission is about, so a question about the
                // submission looks at it: an answer of ready for a report that is missing,
                // written by somebody else, or has no Summary is an answer about nothing.
                const artifactId = c.input?.artifactId;
                if (typeof artifactId === 'string' && artifactId)
                  summarized((await this.author(c.caller, artifactId, c.tx)).content);
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
                if (this.checked.found(c)) return;
                await this.admit(c);
                if (typeof c.input?.changeSpecArtifactId === 'string') {
                  const changeSpec = await this.author(
                    c.caller,
                    c.input.changeSpecArtifactId,
                    c.tx,
                  );
                  await this.plan(c.caller, changeSpec, c.tx, c.snapshot.data.requirePlan === true);
                }
              },
            },
            {
              name: 'review',
              states: ['in_review'],
              transitions: ['approve', 'revise_synthesis', 'restart_lenses'],
              tool: 'review.submit',
              instruction:
                'Verify the pinned synthesis and maintain Methods/Results with your own paperChanges in the verdict. If no paper edit is warranted, explain why in notes; pass, or return it with returnTo synthesizing or reflecting.',
              requiredInput: [...REVIEW_SUBMIT_INPUT],
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
                const { wave } = await this.admit(c);
                // A verdict needs the claim; before it, start_review is the step. A proposed
                // verdict is checked as the verdict, so ready means the call will take it.
                const review = await this.reviews.checkSubmit(
                  c.caller,
                  wave.review_id!,
                  c.input as Parameters<Reviews['checkSubmit']>[2],
                  c.tx,
                );
                const input = c.input as unknown as ReflectionReview | undefined;
                // At the verdict's own transition, submitReview's applyReview checks the
                // edits as it makes them, in this transaction.
                if (input && input.paperChanges !== undefined && !c.transition)
                  await this.paper.checkReview(c.caller, paperReview(wave, review, input), c.tx);
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
