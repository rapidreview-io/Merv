import { reviewHistory } from '@merv/reviews/rules';
import { mapAsync } from '@merv/contracts';
import {
  check,
  clip,
  type Caller,
  type ContextInput,
  type ContextItem,
  type Data,
  type ReviewRequest,
  type Transaction,
  type WorkflowCheckContext,
  type WorkflowExecutionReferences,
} from '@merv/contracts';
import { artifactItem, textItem } from '@merv/context-builder/artifact-item';
import type { Experiment, ExperimentEvidence } from './types.js';
import type { ExperimentsContext } from './index.js';
import {
  type ActiveState,
  reviewing,
  rolesFor,
  currentEvidence,
  approvedSubmission,
  designCheckout,
} from './program.js';
import { readsOnly } from './execution-policy.js';
import {
  recipeNames,
  instructions,
  handoff,
  sourceVerification,
  feasibilityFormat,
  CONTEXT_CHARS,
} from './definitions.js';
import { leaseOf, resumedOutputs } from './lease.js';
import { reviewOf, reviewCapture, admit } from './policy.js';

// What an assignment reads: its frozen inputs, its references and its rendered context.

export interface FrozenInputs {
  experiment: Data;
  /** The paper's items. */
  paper: ContextInput;
  approvedArtifacts: string[];
  evidenceArtifacts: string[];
  /** Earlier feedback and selected recovery: readable by reference, never auto-inlined. */
  historicalArtifacts: string[];
  review: ReviewRequest | null;
  feedback: Data;
}

const own = (value: unknown): Data => JSON.parse(JSON.stringify(value)) as Data;

/**
 * What the rounds of every attempt may add to the optional feedback section. The section is
 * dropped whole when it does not fit, so the history stays small beside the latest reviews.
 */
const REVIEW_HISTORY_CHARS = 8000;

/** The newest interruption and revision notes a context embeds, each clipped; get_state has all. */
const FEEDBACK_KEPT = 5;

const FEEDBACK_CHARS = 2000;

export function approvedPlan(ctx: ExperimentsContext, experiment: Experiment): string[] {
  const submission = approvedSubmission(
    experiment,
    'Execution requires this attempt’s exact approved design submission',
  );
  const plans = submission.evidence
    .filter((evidence) => evidence.role === 'plan')
    .map((evidence) => evidence.artifactId);
  check(plans.length > 0, 'approved_plan_required', 'The approved design has no pinned plan', 409);
  // The admitted feasibility statement travels with the plan, so the running worker and the
  // results reviewer see the budget the design was approved under. It is not required here:
  // submission and the design review are the gates, and this runs only after both.
  const feasibility = submission.evidence
    .filter((evidence) => evidence.role === 'feasibility')
    .map((evidence) => evidence.artifactId);
  return [...new Set([...plans, ...feasibility, ...submission.figureIds])];
}

export function eligibleRecovery(
  ctx: ExperimentsContext,
  experiment: Experiment,
): ExperimentEvidence[] {
  return currentEvidence(experiment, rolesFor(experiment.workflow.state));
}

export async function allowedArtifacts(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<string[]> {
  await ctx.scope.require(caller, 'read', tx);
  if (caller.session) {
    const lease = await leaseOf(ctx, caller, experiment, tx);
    return [
      ...new Set([
        ...lease.details.artifacts.map((artifact) => artifact.id),
        ...(experiment.captureArtifactIds ?? []),
        ...(await ctx.artifacts.executionOutputs(caller, tx)).map((artifact) => artifact.id),
        ...(await resumedOutputs(ctx, caller, experiment.workflow, tx)),
      ]),
    ].sort();
  }
  return [
    ...new Set([
      ...inputIds(ctx, await inputsOf(ctx, caller, experiment, tx)),
      ...(experiment.captureArtifactIds ?? []),
    ]),
  ];
}

/** Every caller has already passed this review's capture gate in the same transaction. */
export async function inputsOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<FrozenInputs> {
  const state = experiment.workflow.state;
  const review = reviewing(state) ? await reviewOf(ctx, caller, experiment, tx) : null;
  const feedbackReviews = await feedbackOf(ctx, caller, experiment, tx);
  // Authors only: a reviewer already reads the current attempt's rejections in previousReviews
  // and judges this submission, not the verdicts earlier attempts received.
  const history = reviewHistory(
    reviewing(state) ? [] : await rejectedRounds(ctx, caller, experiment, tx),
    REVIEW_HISTORY_CHARS,
  );
  const selected = reviewing(state)
    ? review!.artifactIds
    : eligibleRecovery(ctx, experiment).flatMap((evidence) => [
        evidence.artifactId,
        ...evidence.figureIds,
      ]);
  const approvedArtifacts =
    state === 'running' || state === 'experiment_review' ? approvedPlan(ctx, experiment) : [];
  const approvedIds = new Set(approvedArtifacts);
  // Current review evidence remains inline. Feedback artifacts and producing recovery from a
  // previous round stay available through artifact.read, without quoting their old bodies.
  // A results review pins the approved design again; its body already appears in approvedPlan.
  const priorIds = new Set(feedbackReviews.flatMap((prior) => prior.artifactIds));
  const evidenceArtifacts = [
    ...new Set(
      selected.filter((id) => !approvedIds.has(id) && (reviewing(state) || !priorIds.has(id))),
    ),
  ];
  const historicalArtifacts = [
    ...new Set([...feedbackReviews.flatMap((prior) => prior.artifactIds), ...selected]),
  ].filter((id) => !evidenceArtifacts.includes(id) && !approvedArtifacts.includes(id));
  const historicalReferences = await mapAsync(historicalArtifacts, async (id) => {
    const artifact = await ctx.artifacts.get(caller, id, tx);
    return {
      id: artifact.id,
      title: artifact.title,
      hash: artifact.hash,
      mediaType: artifact.mediaType,
      size: artifact.size,
    };
  });
  // Paper serves the Introduction from the Problem, whose sections `paper` carries.
  const project = await ctx.scope.project(caller, tx);
  return {
    experiment: own({
      id: experiment.id,
      name: experiment.name,
      intent: experiment.intent,
      details: experiment.details,
      ownerId: experiment.ownerId,
      project,
      workspace: 'git',
      codeCapture: await reviewCapture(ctx, caller, experiment, tx),
      paperChangesFormat: {
        documents: [
          {
            kind: 'methods or results',
            expectedRevision: 0,
            changes: [
              { id: 'section-id', title: 'Section title', content: 'Changed section text' },
            ],
          },
        ],
      },
      ...(state === 'planned' ? { feasibilityFormat } : {}),
      // Its notes are the feedback section's, which embeds the newest few.
      attempt: { ...experiment.attempt, feedback: undefined },
      workflow: experiment.workflow,
      selectedEvidence: experiment.evidence.filter((evidence) =>
        selected.includes(evidence.artifactId),
      ),
    }),
    paper: await ctx.paper.contextInput(caller, CONTEXT_CHARS, tx),
    approvedArtifacts,
    evidenceArtifacts,
    historicalArtifacts,
    review,
    feedback: own({
      interruptions: experiment.attempt.feedback
        .slice(-FEEDBACK_KEPT)
        .map((note) => clip(note, FEEDBACK_CHARS)),
      ...(experiment.attempt.feedback.length > FEEDBACK_KEPT
        ? { earlierInterruptions: experiment.attempt.feedback.length - FEEDBACK_KEPT }
        : {}),
      previousReviews: feedbackReviews,
      ...(historicalReferences.length ? { artifactReferences: historicalReferences } : {}),
      ...(history.rounds.length ? { history } : {}),
      recovery: review?.recovery ?? null,
    }),
  };
}

/**
 * Every rejected submission of this experiment, oldest first. A design rejection opens a new
 * attempt that names only the review that caused it, so the rounds before it are read from the
 * submissions, which name every review the experiment ever had.
 */
export async function rejectedRounds(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<{ review: ReviewRequest; label: string }[]> {
  const rounds = await mapAsync(
    [...experiment.submissions].sort((a, b) => a.subjectRevision - b.subjectRevision),
    async (submission) => ({
      review: await ctx.reviews.get(caller, submission.reviewId, tx),
      label: `${submission.stage} attempt ${submission.attemptIndex} round ${submission.round}`,
    }),
  );
  return rounds.filter(({ review }) => review.status === 'submitted' && review.verdict !== 'pass');
}

export async function feedbackOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ReviewRequest[]> {
  const ids = experiment.attempt.feedbackReviewIds;
  return await mapAsync([...new Set(ids)], async (id) => {
    const review = await ctx.reviews.get(caller, id, tx);
    check(
      review.subjectId === experiment.id &&
        review.status === 'submitted' &&
        review.verdict !== 'pass' &&
        review.subjectRevision < experiment.workflow.revision &&
        experiment.submissions.some((submission) => submission.reviewId === id),
      'stale_feedback',
      'Recovery must reference an exact prior rejected submission',
      409,
    );
    return review;
  });
}

export function inputIds(ctx: ExperimentsContext, inputs: FrozenInputs): string[] {
  return [
    ...new Set([
      ...inputs.approvedArtifacts,
      ...inputs.evidenceArtifacts,
      ...inputs.historicalArtifacts,
    ]),
  ].sort();
}

/**
 * A derived base is only ever read here. Until a lease has pinned one there is none to name:
 * an interactive producer has no checkout, and a leased one always finds its pin.
 */
export async function pinnedBase(
  ctx: ExperimentsContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<{ base?: string }> {
  const pin = await ctx.code.basePin(caller, snapshot.id, tx);
  return pin ? { base: pin.reference } : {};
}

export async function references(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<WorkflowExecutionReferences> {
  const { experiment } = await admit(ctx, context);
  const review = experiment.reviewId
    ? await ctx.reviews.get(context.caller, experiment.reviewId, context.tx)
    : null;
  return {
    // The native Sandboxes work kind an experiment binds compute under.
    computeKind: 'experiment',
    // Execution works on its pinned base; from experiment@41 the design and its review read it.
    ...(context.snapshot.state === 'running' ||
    (['planned', 'design_review'].includes(context.snapshot.state) &&
      designCheckout(context.snapshot.version))
      ? await pinnedBase(ctx, context)
      : {}),
    ...(context.snapshot.state === 'experiment_review'
      ? {
          code: (await reviewCapture(ctx, context.caller, experiment, context.tx))!.workspace!
            .headOid,
        }
      : {}),
    artifacts: await allowedArtifacts(ctx, context.caller, experiment, context.tx),
    dependencies: (context.dependencies ?? []).map((dependency) => dependency.id).sort(),
    reviews: [
      ...new Set(
        [
          experiment.reviewId,
          experiment.attempt.approvedReviewId,
          ...(await feedbackOf(ctx, context.caller, experiment, context.tx)).map(
            (prior) => prior.id,
          ),
          ...(await rejectedRounds(ctx, context.caller, experiment, context.tx)).map(
            (round) => round.review.id,
          ),
        ].filter((id): id is string => !!id),
      ),
    ],
    ...(review ? { reviewId: review.id } : {}),
    ...(review?.claimId && review.reviewerId === context.caller.actorId
      ? { claimId: review.claimId }
      : {}),
  };
}

export async function build(ctx: ExperimentsContext, context: WorkflowCheckContext) {
  const { experiment, review } = await admit(ctx, context);
  const state = context.snapshot.state as ActiveState;
  let inputs: FrozenInputs;
  if (context.caller.session) {
    inputs = (await leaseOf(ctx, context.caller, experiment, context.tx)).details.inputs;
    const historical = new Set(inputs.historicalArtifacts);
    const owned = eligibleRecovery(ctx, experiment).filter(
      (evidence) => evidence.createdBy === context.caller.actorId,
    );
    const allowed = new Set(await allowedArtifacts(ctx, context.caller, experiment, context.tx));
    inputs.evidenceArtifacts = [
      ...new Set([
        ...inputs.evidenceArtifacts,
        ...owned
          .flatMap((evidence) => [evidence.artifactId, ...evidence.figureIds])
          .filter((id) => !historical.has(id)),
      ]),
    ].filter((id) => allowed.has(id) && !inputs.approvedArtifacts.includes(id));
  } else inputs = await inputsOf(ctx, context.caller, experiment, context.tx);
  const records = new Map(
    [
      ...experiment.submissions.flatMap((submission) => submission.evidence),
      ...experiment.evidence,
    ].map((evidence) => [evidence.artifactId, evidence]),
  );
  // Figures are images: listed for the reader to open, never read into the context.
  const figures = new Set([
    ...experiment.submissions.flatMap((submission) => submission.figureIds),
    ...[...records.values()].flatMap((evidence) => evidence.figureIds),
  ]);
  // The generated metrics exhibit has its own section, where it is listed and never embedded.
  const exhibit =
    state === 'experiment_review'
      ? (inputs.experiment as { selectedEvidence?: ExperimentEvidence[] }).selectedEvidence?.find(
          (item) =>
            item.role === 'exhibit' &&
            item.systemGenerated &&
            inputs.evidenceArtifacts.includes(item.artifactId),
        )?.artifactId
      : undefined;
  const artifactItems = async (ids: string[], priority: number) =>
    (await ctx.artifacts.getAll(context.caller, ids, context.tx)).map((artifact): ContextItem => {
      const id = artifact.id;
      const record = records.get(id);
      return artifactItem(artifact, {
        priority,
        ...(figures.has(id) || id === exhibit ? { embed: 'never' as const } : {}),
        ...(record
          ? { note: `${record.role} ${record.path}` }
          : figures.has(id)
            ? { note: 'figure' }
            : {}),
      });
    });
  const stateRef = { tool: 'experiment.get_state', input: { experimentId: experiment.id } };
  const evidence = inputs.evidenceArtifacts.filter((id) => id !== exhibit);
  const sources: Record<string, ContextInput> = {
    experiment: {
      items: [
        textItem(
          `experiment:${experiment.id}`,
          experiment.name,
          JSON.stringify(inputs.experiment),
          {
            embed: 'always',
            refs: [stateRef],
          },
        ),
      ],
    },
    projectPaper: inputs.paper,
    feedback: {
      items: [
        textItem(
          `feedback:${experiment.id}`,
          'Previous reviews, interruptions and recovery',
          JSON.stringify(inputs.feedback),
          { priority: 700, refs: [stateRef] },
        ),
      ],
    },
    ...(inputs.approvedArtifacts.length
      ? { approvedPlan: { items: await artifactItems(inputs.approvedArtifacts, 900) } }
      : {}),
    ...(evidence.length ? { evidence: { items: await artifactItems(evidence, 800) } } : {}),
    ...(state === 'experiment_review'
      ? {
          exhibitReference: {
            items: exhibit
              ? await artifactItems([exhibit], 0)
              : [
                  textItem(
                    `exhibit:${experiment.id}`,
                    'Metrics exhibit',
                    'Any metrics exhibit is included with the selected evidence above.',
                  ),
                ],
          },
        }
      : {}),
    ...(inputs.review
      ? {
          assessment: {
            items: [
              textItem(
                `review:${inputs.review.id}`,
                'Pinned review and numbered criteria',
                JSON.stringify(inputs.review),
                {
                  embed: 'always',
                  refs: [{ tool: 'review.get', input: { reviewId: inputs.review.id } }],
                },
              ),
            ],
          },
        }
      : {}),
  };
  const recipe = ctx.contexts.get(state);
  check(recipe, 'experiment_unavailable', 'This experiment recipe is unavailable', 503);
  const gitInstruction =
    state === 'running'
      ? '\nExecute code in the configured private Git checkout. Retain experiment outputs through the declared artifact tools. After submit_results, stop: the Runner will capture the final code before independent review becomes eligible.'
      : state === 'experiment_review'
        ? '\nThe read-only checkout is pinned to the exact final producing-session Git capture in your context. Inspect and verify that code against the approved plan and retained results; do not substitute another branch or a newer head.'
        : designCheckout(context.snapshot.version)
          ? '\nThe read-only checkout holds this experiment’s pinned base: project main with the accepted code of the tasks it depends on, the code execution will start from. Inspect it to write or judge the design against that code; nothing changed there is kept. Execution runs in a configured private Git workspace on the same base.'
          : '\nThis experiment will execute in a configured private Git workspace on its pinned base; planning and design review have no checkout. Read the accepted code’s delivery evidence (task.get, artifact.read) instead, design against what it reports, and leave verifying the code itself to execution, which starts from that base.';
  const needsClaim = review?.status === 'requested';
  const instruction = needsClaim
    ? 'Call review.start to claim this exact review, then refresh workflow.assignment for the new claim. Reading or beginning the assignment does not claim it.'
    : handoff(state);
  const speedGuidance =
    state === 'planned'
      ? ' Prioritize fast experiment completion. Plan batching, multiple GPUs or concurrent independent jobs for execution after approval when they save time, within the authorized budget and scientific requirements. Avoid duplicating the same work.'
      : state === 'running'
        ? ' Prioritize fast experiment completion. Balance GPU utilization and cost, using batching, multiple GPUs or concurrent independent run jobs when they save time, within the authorized budget and scientific requirements. Parallel independent work is encouraged; avoid duplicating the same work.'
        : '';
  const preview = await recipe.preview(
    context.caller,
    {
      subject: {
        id: experiment.id,
        revision: experiment.workflow.revision,
        ...(review?.claimId ? { claimId: review.claimId } : {}),
      },
      inputs: sources,
    },
    context.tx,
  );
  return {
    role: reviewing(state) ? 'reviewer' : 'producer',
    label: `${recipeNames[state]}: ${experiment.name}`,
    name: experiment.name,
    brief:
      `${instructions[state]}${speedGuidance}\n\nExperiment: ${experiment.name}\nAttempt index: ${experiment.attempt.index}\nExpected revision: ${experiment.workflow.revision}\n\n${instruction}${gitInstruction}\n\n${sourceVerification}` +
      ((await ctx.sandboxes?.guidance(
        experiment.projectId,
        state === 'running' ? 'execute' : 'check',
        context.tx,
      )) ?? ''),
    references: [
      { kind: 'experiment', id: experiment.id, label: experiment.name },
      ...preview.sources.map((artifact) => ({
        kind: 'artifact',
        id: artifact.id,
        label: artifact.title,
      })),
      ...(await mapAsync(inputs.historicalArtifacts, async (id) => {
        const artifact = await ctx.artifacts.get(context.caller, id, context.tx);
        return { kind: 'artifact' as const, id: artifact.id, label: artifact.title };
      })),
    ],
    handoff: {
      instruction,
      tools: reviewing(state)
        ? needsClaim
          ? ['review.start', 'workflow.assignment']
          : ['review.submit']
        : ['experiment.attach', 'experiment.transition'],
    },
    execution: { readOnly: readsOnly(state, context.snapshot.version), tools: [] },
    context: preview,
  };
}
