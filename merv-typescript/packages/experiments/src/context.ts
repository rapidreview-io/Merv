import type { CodeCapture } from '@merv/code-work/types';
import { reviewHistory, type ReviewHistory } from '@merv/reviews/rules';
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
  continuousProducer,
} from './program.js';
import { readsOnly } from './execution-policy.js';
import {
  recipeNames,
  instructions,
  presentationAt,
  handoffAt,
  recipeKey,
  feasibilityFormat,
  feasibilityRules,
  workflowGates,
} from './definitions.js';
import { leaseOf, resumedOutputs } from './lease.js';
import { reviewOf, reviewCapture, admit } from './policy.js';

// What an assignment reads: its frozen inputs, its references and its rendered context.

export interface FrozenInputs {
  experiment: Data;
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

/**
 * How the note retry_running adds to an attempt begins. Every other note an attempt holds is the
 * notes of a review that returned it, which the frozen inputs keep under `interruptions` too.
 */
export const RECOVERY_NOTE = 'Infrastructure recovery: ';

const FEEDBACK_CHARS = 2000;

export function approvedPlan(experiment: Experiment): string[] {
  const submission = approvedSubmission(
    experiment,
    'Execution requires this attempt’s exact approved design submission',
  );
  const pinned = (role: string) =>
    submission.evidence.filter((item) => item.role === role).map((item) => item.artifactId);
  const plans = pinned('plan');
  check(plans.length > 0, 'approved_plan_required', 'The approved design has no pinned plan', 409);
  // The admitted feasibility statement travels with the plan, so the running worker and the
  // results reviewer see the budget the design was approved under. It is not required here:
  // submission and the design review are the gates, and this runs only after both.
  return [...new Set([...plans, ...pinned('feasibility'), ...submission.figureIds])];
}

export function eligibleRecovery(experiment: Experiment): ExperimentEvidence[] {
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
      ...inputIds(await inputsOf(ctx, caller, experiment, tx)),
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
  const rejected = reviewing(state) ? [] : await rejectedRounds(ctx, caller, experiment, tx);
  const history = reviewHistory(rejected, REVIEW_HISTORY_CHARS);
  const selected = reviewing(state)
    ? review!.artifactIds
    : eligibleRecovery(experiment).flatMap((evidence) => [
        evidence.artifactId,
        ...evidence.figureIds,
      ]);
  const approvedArtifacts =
    state === 'running' || state === 'experiment_review' ? approvedPlan(experiment) : [];
  const approvedIds = new Set(approvedArtifacts);
  // Keep the exact artifact selections frozen; reviewers receive retrieval references only.
  // All stages open retained contents explicitly through their artifact references.
  const priorIds = new Set(feedbackReviews.flatMap((prior) => prior.artifactIds));
  const evidenceArtifacts = [
    ...new Set(
      selected.filter((id) => !approvedIds.has(id) && (reviewing(state) || !priorIds.has(id))),
    ),
  ];
  const historicalArtifacts = [
    ...new Set([...feedbackReviews.flatMap((prior) => prior.artifactIds), ...selected]),
  ].filter((id) => !evidenceArtifacts.includes(id) && !approvedArtifacts.includes(id));
  return {
    experiment: own({
      intent: experiment.intent,
      project: await ctx.scope.project(caller, tx),
      codeCapture: await reviewCapture(ctx, caller, experiment, tx),
      ...(state === 'planned'
        ? { feasibilityFormat, feasibilityRules, computeAccess: PLANNING_COMPUTE }
        : {}),
      selectedEvidence: experiment.evidence.filter((evidence) =>
        selected.includes(evidence.artifactId),
      ),
    }),
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
      ...(!reviewing(state)
        ? { priorReviewReferences: rejected.map(({ review, label }) => ({ id: review.id, label })) }
        : {}),
      ...(continuousProducer(experiment.workflow.version) && experiment.attempt.approvedReviewId
        ? {
            approvedDesignReview: await ctx.reviews.get(
              caller,
              experiment.attempt.approvedReviewId,
              tx,
            ),
          }
        : {}),
      ...(history.rounds.length ? { history } : {}),
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
  const reviews = await ctx.reviews.find(
    caller,
    experiment.submissions.map((submission) => submission.reviewId),
    tx,
  );
  return [...experiment.submissions]
    .sort((a, b) => a.subjectRevision - b.subjectRevision)
    .map((submission) => ({
      review: reviews.get(submission.reviewId)!,
      label: `${submission.stage} attempt ${submission.attemptIndex} round ${submission.round}`,
    }))
    .filter(({ review }) => review.status === 'submitted' && review.verdict !== 'pass');
}

export async function feedbackOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ReviewRequest[]> {
  const ids = [...new Set(experiment.attempt.feedbackReviewIds)];
  const reviews = await ctx.reviews.find(caller, ids, tx);
  return ids.map((id) => {
    const review = reviews.get(id);
    check(
      review?.subjectId === experiment.id &&
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

export function inputIds(inputs: FrozenInputs): string[] {
  return [
    ...new Set([
      ...inputs.approvedArtifacts,
      ...inputs.evidenceArtifacts,
      ...inputs.historicalArtifacts,
    ]),
  ].sort();
}

/**
 * What a design may do with compute, said in the assignment a planner reads first: its Sandboxes
 * tools come on their own connection, so the declared tools above never list them. A project
 * with no compute connected gets no connection, and its planner, told to measure, searched
 * Merv for compute before asking (2026-10-09). But a visit can lack the connection while the
 * project has compute connected (2026-10-13), so the planner learns which from Merv's own
 * sandboxes.spend_status before it asks, rather than asking the owner to connect compute that is
 * connected.
 */
const PLANNING_COMPUTE =
  'Your Sandboxes MCP connection (the server named sandboxes) is separate from the Merv tools this assignment declares, so its tools are not listed here; they are granted to this planning lease. Use them, GPUs and storage included, to measure what the design needs: a bounded feasibility probe such as loading the pinned base and timing a few training steps for memory and step time, within an hour and a few dollars, releasing the machine after. Do not run full training or evaluation or keep a probe checkpoint as the model. Retain the measurements as feasibility evidence instead of asking for them. If this visit has no server named sandboxes, Merv issued it no connection; call sandboxes.spend_status on the merv server to learn why before you ask. A sandbox_not_connected refusal means the project has no compute connected: ask the owner to connect it with session.ask_owner. An answer that names the project’s namespace means compute is connected and only this visit lacks its connection: say exactly that in session.ask_owner, and do not ask the owner to connect compute. Either way, ask instead of searching for compute, designing without measurements or ending the experiment.';

export async function references(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<WorkflowExecutionReferences> {
  const { experiment } = await admit(ctx, context);
  const { caller, snapshot, tx } = context;
  const review = experiment.reviewId
    ? await ctx.reviews.get(caller, experiment.reviewId, tx)
    : null;
  // Execution works on its pinned base, once a lease pinned one (an interactive producer has no
  // checkout). From experiment@41 the design and its review read the code execution will start
  // from: that base, with an earlier attempt's commits on it.
  const base =
    snapshot.state === 'running'
      ? (await ctx.code.basePin(caller, snapshot.id, tx))?.reference
      : ['planned', 'design_review'].includes(snapshot.state) && designCheckout(snapshot.version)
        ? await ctx.code.resumesFrom(caller, snapshot.id, tx)
        : null;
  return {
    // The native Sandboxes work kind an experiment binds compute under.
    computeKind: 'experiment',
    // A design measures its compute rather than guessing it: bounded probes, not the run.
    ...(snapshot.state === 'planned' ? { computeProfile: 'plan' } : {}),
    ...(base ? { base } : {}),
    ...(snapshot.state === 'experiment_review'
      ? {
          code: (await reviewCapture(ctx, caller, experiment, tx))!.workspace!.headOid,
        }
      : {}),
    artifacts: await allowedArtifacts(ctx, caller, experiment, tx),
    dependencies: (context.dependencies ?? []).map((dependency) => dependency.id).sort(),
    reviews: [
      ...new Set(
        [
          experiment.reviewId,
          experiment.attempt.approvedReviewId,
          ...(await feedbackOf(ctx, caller, experiment, tx)).map((prior) => prior.id),
          ...(await rejectedRounds(ctx, caller, experiment, tx)).map((round) => round.review.id),
        ].filter((id): id is string => !!id),
      ),
    ],
    ...(review ? { reviewId: review.id } : {}),
    ...(review?.claimId && review.reviewerId === caller.actorId ? { claimId: review.claimId } : {}),
  };
}

/** The commits a reviewer compares, from the validated capture kept in frozen server inputs. */
function reviewerCode(experiment: Data) {
  const capture = experiment.codeCapture as unknown as CodeCapture | null | undefined;
  return capture?.workspace
    ? {
        submittedCommit: capture.workspace.headOid,
        startingCommit: capture.attachedBaseOid ?? capture.workspace.baseOid,
      }
    : undefined;
}

export async function build(ctx: ExperimentsContext, context: WorkflowCheckContext) {
  const { experiment, review } = await admit(ctx, context);
  const state = context.snapshot.state as ActiveState;
  let inputs: FrozenInputs;
  if (context.caller.session) {
    // The lease's frozen inputs are read, never written: the worker's own recovery joins a copy.
    const leased = (await leaseOf(ctx, context.caller, experiment, context.tx)).details.inputs;
    const historical = new Set(leased.historicalArtifacts);
    const owned = eligibleRecovery(experiment)
      .filter((evidence) => evidence.createdBy === context.caller.actorId)
      .flatMap((evidence) => [evidence.artifactId, ...evidence.figureIds])
      .filter((id) => !historical.has(id));
    const allowed = new Set(await allowedArtifacts(ctx, context.caller, experiment, context.tx));
    inputs = {
      ...leased,
      evidenceArtifacts: [...new Set([...leased.evidenceArtifacts, ...owned])].filter(
        (id) => allowed.has(id) && !leased.approvedArtifacts.includes(id),
      ),
    };
  } else inputs = await inputsOf(ctx, context.caller, experiment, context.tx);
  const records = new Map(
    [
      ...experiment.submissions.flatMap((submission) => submission.evidence),
      ...experiment.evidence,
    ].map((evidence) => [evidence.artifactId, evidence]),
  );
  // Figures are images: listed for the reader to open, never read into the context.
  const figures = new Set([
    ...experiment.submissions.flatMap((submission) => [
      ...submission.figureIds,
      ...(submission.reportPdfId ? [submission.reportPdfId] : []),
    ]),
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
        embed: 'never',
        ...(record
          ? {
              // A large exhibit repeats every result's data; a reviewer paged one of 795 KB
              // in 98 reads (2026-10-13) to check what its sources already say.
              note:
                id === exhibit
                  ? `${record.role} ${record.path}: each JSON result's data exactly as attached, in path order, with its artifactId and sha256 under source; check that mapping against the result evidence rather than reading this file whole`
                  : `${record.role} ${record.path}`,
            }
          : figures.has(id)
            ? { note: 'figure' }
            : {}),
      });
    });
  const stateRef = { tool: 'experiment.get_state', input: { experimentId: experiment.id } };
  const evidence = inputs.evidenceArtifacts.filter((id) => id !== exhibit);
  const priorReviews = [
    ...(inputs.feedback.previousReviews as unknown as ReviewRequest[]),
    ...(inputs.feedback.approvedDesignReview
      ? [inputs.feedback.approvedDesignReview as unknown as ReviewRequest]
      : []),
    ...(!reviewing(state)
      ? ((inputs.feedback.priorReviewReferences as unknown as
          { id: string; label: string }[] | undefined) ??
        (inputs.feedback.history as unknown as ReviewHistory | undefined)?.rounds.map((round) => ({
          id: round.reviewId,
          label: round.label,
        })) ??
        [])
      : []),
  ];
  const sources: Record<string, ContextInput> = {
    experiment: {
      items: [
        textItem(
          `experiment:${experiment.id}`,
          experiment.name,
          JSON.stringify({
            id: experiment.id,
            name: experiment.name,
            project: inputs.experiment.project,
            attemptIndex: experiment.attempt.index,
            expectedRevision: experiment.workflow.revision,
            ...(state === 'planned'
              ? {
                  intent: inputs.experiment.intent,
                  feasibilityFormat: inputs.experiment.feasibilityFormat,
                  feasibilityRules: inputs.experiment.feasibilityRules,
                  computeAccess: inputs.experiment.computeAccess,
                }
              : {}),
            ...(state === 'running'
              ? {
                  intent: inputs.experiment.intent,
                  approvedSubmissionId: experiment.attempt.approvedSubmissionId,
                  approvedReviewId: experiment.attempt.approvedReviewId,
                }
              : {}),
            ...(state === 'experiment_review' ? { code: reviewerCode(inputs.experiment) } : {}),
          }),
          {
            embed: 'always',
            refs: [stateRef],
          },
        ),
      ],
    },
    projectPaper: {
      items: [
        textItem('project-paper', 'Project paper', '', {
          embed: 'never',
          refs: [{ tool: 'paper.read', input: {} }],
        }),
      ],
    },
    feedback: {
      items: priorReviews
        .filter((prior, index, all) => all.findIndex((item) => item.id === prior.id) === index)
        .map((prior) =>
          textItem(
            `review:${prior.id}`,
            'label' in prior ? (prior.label ?? 'Prior review') : 'Prior review',
            '',
            {
              embed: 'never',
              refs: [{ tool: 'review.get', input: { reviewId: prior.id } }],
            },
          ),
        ),
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
                'Pinned review (open review.get for criteria and requirements)',
                JSON.stringify({
                  reviewId: inputs.review.id,
                  subjectRevision: inputs.review.subjectRevision,
                  snapshotHash: inputs.review.snapshotHash,
                  claimId: inputs.review.claimId,
                  status: inputs.review.status,
                }),
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
  if (!reviewing(state)) {
    sources.feedback!.items.push(...(await artifactItems(inputs.historicalArtifacts, 700)));
    // Labeled as what each note is: reviewers' notes read as interruptions (2026-10-13) left an
    // executor unable to tell a verdict from the infrastructure failure retry_running is for.
    const notes = inputs.feedback.interruptions as string[] | undefined;
    if (Array.isArray(notes) && notes.length) {
      const interruptions = notes.filter((note) => note.startsWith(RECOVERY_NOTE));
      const reviewNotes = notes.filter((note) => !note.startsWith(RECOVERY_NOTE));
      sources.feedback!.items.push(
        textItem(
          `attemptNotes:${experiment.id}`,
          'Notes on this attempt: review notes that returned it, and infrastructure interruptions',
          JSON.stringify({
            ...(reviewNotes.length ? { reviewNotes } : {}),
            ...(interruptions.length ? { interruptions } : {}),
            ...(inputs.feedback.earlierInterruptions
              ? { earlierNotes: inputs.feedback.earlierInterruptions }
              : {}),
          }),
          { refs: [stateRef] },
        ),
      );
    }
  }
  const recipe = ctx.contexts.get(recipeKey(state, context.snapshot.version));
  check(recipe, 'experiment_unavailable', 'This experiment recipe is unavailable', 503);
  const gitInstruction =
    state === 'running'
      ? '\nExecute code in the configured private Git checkout. Retain experiment outputs through the declared artifact tools. After submit_results, stop: the Runner will capture the final code before independent review becomes eligible.'
      : state === 'experiment_review'
        ? '\nInspect the provided read-only checkout at code.submittedCommit against the approved plan and retained results. code.startingCommit identifies the starting point for comparison. Do not substitute another branch or a newer head.'
        : designCheckout(context.snapshot.version)
          ? '\nThe read-only checkout holds the code execution will start from: this experiment’s pinned base (project main with the accepted code of the tasks it depends on) and, after an earlier attempt, that attempt’s commits on it. Inspect it to write or judge the design against that code; nothing changed there is kept. Execution resumes in a configured private Git workspace from the same commit.'
          : '\nThis experiment will execute in a configured private Git workspace on its pinned base; planning and design review have no checkout. Read the accepted code’s delivery evidence (task.get, artifact.read) instead, design against what it reports, and leave verifying the code itself to execution, which starts from that base.';
  const needsClaim = review?.status === 'requested';
  const instruction = needsClaim
    ? 'Call review.start to claim this exact review, then refresh workflow.assignment for the new claim. Reading or beginning the assignment does not claim it.'
    : handoffAt(state, context.snapshot.version);
  const speedGuidance =
    state === 'planned'
      ? ' Prioritize fast experiment completion. Plan batching, multiple GPUs or concurrent independent jobs for execution after approval when they save time, within the authorized budget and scientific requirements. Avoid duplicating the same work.'
      : state === 'running'
        ? ' Prioritize fast experiment completion. Balance GPU utilization and cost, using batching, multiple GPUs or concurrent independent run jobs when they save time, within the authorized budget and scientific requirements. Parallel independent work is encouraged; avoid duplicating the same work.'
        : '';
  const approved =
    state === 'running' && continuousProducer(context.snapshot.version)
      ? approvedSubmission(experiment)
      : undefined;
  const continuation =
    continuousProducer(context.snapshot.version) && !reviewing(state)
      ? `\n\nCurrent stage: ${state === 'running' ? 'execution (running), after independent design approval' : 'design (planned)'}. This is a fresh visit with a new lease, credential, execution policy and workspace. The current assignment, authoritative experiment record and frozen inputs supersede all earlier conversation, plans and permissions. Use only this visit's granted tools, limits and configured workspace; old credentials and paths are not authority.${state === 'running' ? ` Execute only the exact approved design submission ${experiment.attempt.approvedSubmissionId} (revision ${approved!.subjectRevision}, round ${approved!.round}, manifest ${approved!.manifestHash}), approved by review ${experiment.attempt.approvedReviewId}, for attempt ${experiment.attempt.index}. Read the pinned approvedPlan artifacts and feasibility limits, and the reviewer findings in feedback before executing; if feedback is omitted for space, call review.get for the approved review above. Follow the approved scope. Retain the required results and final report and submit them for independent review.` : ' Read current reviewer findings and recovery references before revising the design; execution requires a new independent design approval.'}`
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
    brief: `${instructions[state]}${speedGuidance}${workflowGates[state] ?? ''}${continuation}\n\nExperiment: ${experiment.name}\nAttempt index: ${experiment.attempt.index}\nExpected revision: ${experiment.workflow.revision}\n\n${instruction}${gitInstruction}${state === 'running' ? `\n\n${presentationAt(context.snapshot.version)}` : ''}`,
    references: [
      { kind: 'experiment', id: experiment.id, label: experiment.name },
      ...preview.sources.map((artifact) => ({
        kind: 'artifact',
        id: artifact.id,
        label: artifact.title,
      })),
      ...(await ctx.artifacts.getAll(context.caller, inputs.historicalArtifacts, context.tx)).map(
        (artifact) => ({ kind: 'artifact', id: artifact.id, label: artifact.title }),
      ),
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
