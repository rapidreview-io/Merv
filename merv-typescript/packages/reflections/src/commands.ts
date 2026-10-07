import { leaseRows } from '@merv/workflows/lease-rows';
import {
  visible,
  childRequest,
  recorded,
  check,
  inTransaction,
  MervError,
  now,
  type Artifact,
  type ArtifactContent,
  type Caller,
  type Transaction,
} from '@merv/contracts';
import { parseChangeSpec } from './change-spec.js';
import { CHANGE_SPEC_CRITERION, REFLECTION_CRITERIA, REVIEW_RETURNS } from './definitions.js';
import type {
  ApprovedReflection,
  ChangeSpec,
  Reflection,
  ReflectionLens,
  ReflectionLensSubmit,
  ReflectionEnd,
  ReflectionReview,
  ReflectionSubmit,
} from './types.js';
import type { ReflectionsContext } from './index.js';
import {
  admit,
  paperReview,
  submitted,
  summarized,
  type Submission,
  type WaveRow,
} from './program.js';

// The commands that move a wave: a lens report, the synthesis, ending a wave and the review
// verdict. Each runs on ReflectionService (index.ts) as its ReflectionsContext.
/** The caller's own text evidence, with the text it holds. */
export async function author(
  ctx: ReflectionsContext,
  caller: Caller,
  id: string,
  tx: Transaction,
): Promise<ArtifactContent> {
  const artifact = await ctx.artifacts.get(caller, id, tx);
  check(
    artifact.createdBy === caller.actorId,
    'artifact_author_required',
    'Submit your own immutable evidence',
    403,
  );
  if (caller.session)
    check(
      (await ctx.artifacts.executionOutputs(caller, tx)).some((a) => a.id === id),
      'artifact_execution_required',
      'Evidence must be authored in this execution',
      403,
    );
  const read = await ctx.artifacts.read(caller, id, undefined, tx);
  check(
    read.encoding === 'utf8' && visible(read.content),
    'reflection_text_required',
    'Reflection evidence must be nonempty UTF-8 text',
  );
  return read;
}
/**
 * The plan a JSON change specification states. The media type is the author's declaration:
 * text is never parsed, so prose can never become work by resembling a plan.
 */
export async function plan(
  ctx: ReflectionsContext,
  caller: Caller,
  { artifact, content }: ArtifactContent,
  tx: Transaction,
  required = false,
): Promise<ChangeSpec | undefined> {
  check(
    !required || artifact.mediaType === 'application/json',
    'reflection_plan_required',
    'Automatic research requires an application/json change specification with a continue or stop decision',
    409,
  );
  if (artifact.mediaType !== 'application/json') return undefined;
  const plan = parseChangeSpec(content);
  // Work carried into the next cycle becomes its prerequisite, so it has to be real work here.
  for (const { workflowId } of plan.carriedOver) {
    const carried = await ctx.workflows.get(caller, workflowId, tx).catch((error: unknown) => {
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
export async function submitLens(
  ctx: ReflectionsContext,
  caller: Caller,
  input: ReflectionLensSubmit,
  transaction?: Transaction,
): Promise<ReflectionLens> {
  ({ caller, input } = structuredClone({ caller, input }));
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await ctx.command(caller, 'submit_lens', input, tx, async () => {
      const lens = await ctx.lensRow(caller, input.lensId, tx);
      const snapshot = await ctx.workflows.get(caller, lens.id, tx);
      const context = { caller, snapshot, tx };
      await admit(ctx, context);
      check(
        snapshot.revision === input.expectedRevision,
        'revision_conflict',
        'Lens changed; refresh its assignment',
        409,
      );
      const { artifact, content } = await author(ctx, caller, input.artifactId, tx);
      summarized(content);
      await ctx.moved(
        caller,
        {
          instanceId: lens.id,
          expectedRevision: input.expectedRevision,
          action: 'submit',
          input: { ...input },
          requestId: childRequest(caller, 'reflection', 'lens-submit', input.requestId),
        },
        tx,
        snapshot,
      );
      await tx.run(
        'UPDATE reflection_lenses SET producer_id=?,artifact=? WHERE id=?',
        caller.actorId,
        JSON.stringify(artifact),
        lens.id,
      );
      const wave = await ctx.row(caller, lens.reflection_id, tx);
      const children = await ctx.lensRows(wave, tx);
      if (children.length === 5 && children.every((child) => child.artifact)) {
        const parent = await ctx.workflows.get(caller, wave.id, tx);
        await ctx.moved(
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
      await recorded(ctx.state, tx, caller, 'reflection.lens_submitted', lens.id, {
        reflectionId: wave.id,
        attempt: wave.attempt,
        artifactId: artifact.id,
      });
      return await ctx.lens(caller, lens.id, tx);
    });
  });
}
export async function submit(
  ctx: ReflectionsContext,
  caller: Caller,
  input: ReflectionSubmit,
  transaction?: Transaction,
): Promise<Reflection> {
  ({ caller, input } = structuredClone({ caller, input }));
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await ctx.command(caller, 'submit', input, tx, async () => {
      const wave = await ctx.row(caller, input.reflectionId, tx);
      const snapshot = await ctx.workflows.get(caller, wave.id, tx);
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
      await admit(ctx, { caller, snapshot, tx });
      check(
        input.reportArtifactId !== input.changeSpecArtifactId,
        'distinct_evidence_required',
        'Report and change specification must be distinct artifacts',
      );
      const report = await author(ctx, caller, input.reportArtifactId, tx);
      const changeSpec = await author(ctx, caller, input.changeSpecArtifactId, tx);
      const submission: Submission = {
        report: report.artifact,
        changeSpec: changeSpec.artifact,
        producerId: caller.actorId,
      };
      const planned = await plan(ctx, caller, changeSpec, tx, snapshot.data.requirePlan === true);
      if (planned) submission.plan = planned;
      // Synthesis opens only by the join, which found all five of these complete.
      const lenses = await ctx.lensRows(wave, tx);
      const next = await ctx.moved(
        caller,
        {
          instanceId: wave.id,
          expectedRevision: input.expectedRevision,
          action: 'submit',
          input: { ...input },
          requestId: childRequest(caller, 'reflection', 'submit', input.requestId),
        },
        tx,
        snapshot,
      );
      const pinnedInputIds = lenses.map((lens) => (JSON.parse(lens.artifact!) as Artifact).id);
      const review = await ctx.reviews.request(
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
                await leaseRows(tx, {
                  projectId: caller.projectId,
                  instanceIds: lenses.map((lens) => lens.id),
                })
              )
                .map((row) => row.source_actor_id)
                .filter((id): id is string => typeof id === 'string'),
              ...(caller.session
                ? [wave.owner_id, (await ctx.scope.authorityActor(caller, tx)).id]
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
      await recorded(ctx.state, tx, caller, 'reflection.submitted', wave.id, {
        reviewId: review.id,
        attempt: wave.attempt,
      });
      return await ctx.get(caller, wave.id, tx);
    });
  });
}
/** Only the owner or an operator ends a wave, and never a worker assigned to it. */
export async function ender(
  ctx: ReflectionsContext,
  caller: Caller,
  wave: WaveRow,
  tx: Transaction,
): Promise<void> {
  const actor = await ctx.scope.require(caller, 'write', tx);
  check(
    !caller.session && (actor.id === wave.owner_id || actor.role === 'operator'),
    'forbidden',
    'Only the reflection owner or an operator may end it',
    403,
  );
}
export async function end(
  ctx: ReflectionsContext,
  caller: Caller,
  input: ReflectionEnd,
  transaction?: Transaction,
): Promise<Reflection> {
  ({ caller, input } = structuredClone({ caller, input }));
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await ctx.command(caller, 'end', input, tx, async () => {
      check(
        typeof input.reason === 'string' && visible(input.reason) && input.reason.length <= 16000,
        'invalid_reason',
        'A specific reason of 1–16000 characters is required to end a wave',
      );
      const wave = await ctx.row(caller, input.reflectionId, tx);
      await ctx.moved(
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
      for (const lens of await ctx.lensRows(wave, tx)) {
        const snapshot = await ctx.workflows.get(caller, lens.id, tx);
        if (snapshot.state === 'reflecting')
          await ctx.moved(
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
      const review = wave.review_id && (await ctx.reviews.get(caller, wave.review_id, tx));
      if (review && ['requested', 'started'].includes(review.status))
        await ctx.reviews.supersede(caller, review.id, tx);
      await recorded(ctx.state, tx, caller, 'reflection.abandoned', wave.id, {
        reason: input.reason,
      });
      return await ctx.get(caller, wave.id, tx);
    });
  });
}
export async function submitReview(
  ctx: ReflectionsContext,
  caller: Caller,
  input: ReflectionReview,
  tx: Transaction,
): Promise<Reflection> {
  await ctx.scope.require(caller, 'review', tx);
  if (input.paperChanges !== undefined)
    input = {
      ...input,
      paperChanges: ctx.paper.parseChanges(input.paperChanges),
    };
  return await ctx.command(caller, 'review', input, tx, async () => {
    const review = await ctx.reviews.get(caller, input.reviewId, tx);
    const wave = await ctx.row(caller, review.subjectId, tx);
    const { state } = await ctx.workflows.get(caller, wave.id, tx);
    check(
      wave.review_id === review.id && state === 'in_review',
      'stale_review',
      'Only the exact current reflection review can be submitted',
      409,
    );
    const route =
      input.verdict === 'pass' ? 'approved' : (input.returnTo ?? REVIEW_RETURNS[0].value);
    check(
      input.verdict === 'pass'
        ? input.returnTo === undefined
        : REVIEW_RETURNS.some((each) => each.value === route),
      'invalid_review_return',
      'Pass accepts no returnTo; rejections return to synthesizing or reflecting',
    );
    const action =
      route === 'approved'
        ? 'approve'
        : route === 'reflecting'
          ? 'restart_lenses'
          : 'revise_synthesis';
    // The transition checks the revision and runs the review action's check: admit(), with the
    // reviewer's independence, then the verdict and its paper changes.
    const next = await ctx.moved(
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
    await ctx.reviews.submit(caller, input, tx);
    if (input.paperChanges !== undefined)
      await ctx.paper.applyReview(caller, paperReview(wave, review, input), tx);
    if (route === 'approved') {
      const approved: ApprovedReflection = {
        id: wave.id,
        projectId: wave.project_id,
        revision: next.revision,
        ...submitted(wave)!,
        lenses: (await ctx.lensRows(wave, tx)).map((lens) => ({
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
        await ctx.reviews.get(caller, review.id, tx),
      ];
      await tx.run(
        'UPDATE reflections SET feedback=?,attempt=attempt+? WHERE id=?',
        JSON.stringify(feedback),
        route === 'reflecting' ? 1 : 0,
        wave.id,
      );
      if (route === 'reflecting')
        await ctx.createLenses(caller, await ctx.row(caller, wave.id, tx), tx);
    }
    await recorded(
      ctx.state,
      tx,
      caller,
      `reflection.${route === 'approved' ? 'approved' : 'returned'}`,
      wave.id,
      { reviewId: review.id, returnTo: route },
    );
    return await ctx.get(caller, wave.id, tx);
  });
}
