import { visible, mapAsync, record } from '@merv/contracts';
import { childRequest, plain, recorded, replayed, sha256Hex } from '@merv/contracts';
import { requireDependencies } from '@merv/workflows/rules';
import {
  check,
  digest,
  inTransaction,
  MervError,
  newId,
  now,
  type Artifact,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowCheckContext,
} from '@merv/contracts';
import type { CodeCaptureRef } from '@merv/code-work/types';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  ExperimentReview,
  ExperimentSubmission,
  ExperimentTransition,
} from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentTransitionSchema,
  parseExperimentInput,
} from './input.js';
import {
  buildMetricsExhibit,
  decodeEvidence,
  exhibitBytes,
  markdownImageTargets,
  feasibilityShortfalls,
  parseFeasibility,
  parseResult,
  shouldPinExhibit,
  reportConclusion,
  validatePlan,
  validateReport,
} from './evidence.js';
import type { ExperimentsContext } from './index.js';
import {
  reviewing,
  runningNode,
  programVersion,
  rolesFor,
  currentEvidence,
  approvedSubmission,
  experimentEpoch,
  epochAfter,
  TERMINAL,
  EXPERIMENT_WORKFLOW,
} from './program.js';
import { designCriteria, feasibilityCriterion, resultsCriteria } from './definitions.js';
import { allowedArtifacts } from './context.js';
import { pinnedRecovery, holds } from './lease.js';
import {
  handleFor,
  move,
  revision,
  route,
  current,
  assertProducer,
  assertAdministration,
} from './policy.js';

// The experiment commands: create, attach, transition, exhibit and submitReview.

const terminal = new Set<string>(TERMINAL);

/** The evidence, figures, exhibit and final capture a design or results submission pins. */
interface Submission {
  evidence: ExperimentEvidence[];
  figureIds: string[];
  exhibit: ExperimentExhibit | null;
  codeCaptureRef?: CodeCaptureRef;
}

/**
 * Ending or retrying names its reason under evidence. Guidance reaches here without the input
 * schema, so the check is made here once rather than only where the tool parses its input.
 */
function reasoned(input: Data | undefined, message: string): void {
  if (input)
    check(
      typeof (input.evidence as Data | undefined)?.reason === 'string' &&
        !!(input.evidence as Data).reason,
      'reason_required',
      message,
    );
}

export async function create(
  ctx: ExperimentsContext,
  caller: Caller,
  value: ExperimentCreate,
  transaction?: Transaction,
): Promise<Experiment> {
  ctx.open();
  caller = structuredClone(caller);
  const input = parseExperimentInput(experimentCreateSchema, value);
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await command(ctx, caller, 'create', input, tx, async () => {
      check(
        !caller.session,
        'forbidden',
        'An assigned experiment worker cannot create a separate experiment',
        403,
      );
      await ctx.admits(caller, [input.name], tx);
      for (const id of input.dependsOn) {
        const dependency = await ctx.workflows.get(caller, id, tx);
        // An ordering between two experiments is a task in between (founder, 2026-09-18).
        check(
          dependency.workflow === 'task',
          'invalid_dependency',
          'Experiment prerequisites must be tasks; order two experiments with a task between them',
        );
      }
      check(
        input.workspace === undefined || input.workspace === 'git',
        'invalid_workspace',
        'New experiments always use Git. Omit workspace or use git.',
      );
      const owner = await ctx.scope.authorityActor(caller, tx);
      await ctx.code.ensureRepository(caller, tx);
      const workflow = await handleFor(ctx, programVersion).start(
        caller,
        {
          workflow: 'experiment',
          requestId: childRequest(caller, 'experiment', 'create', input.requestId),
          dependsOn: input.dependsOn,
          // What waits on this experiment names it, so the instance carries the name.
          data: {
            workspace: 'git',
            name: input.name,
            computeEpoch: experimentEpoch(1, EXPERIMENT_WORKFLOW.initial),
          },
        },
        tx,
      );
      const createdAt = now();
      await tx.run(
        'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,attempt_index,workspace) VALUES(?,?,?,?,?,?,?,?,1,?)',
        workflow.id,
        caller.projectId,
        input.name,
        input.intent,
        input.details,
        owner.id,
        caller.actorId,
        createdAt,
        'git',
      );
      await addAttempt(ctx, workflow.id, 1, workflow.revision, null, [], createdAt, tx);
      await ctx.code.declareUnit(caller, workflow.id, tx);
      await recordEvent(
        ctx,
        caller,
        'created',
        workflow.id,
        { name: input.name, dependsOn: input.dependsOn },
        tx,
      );
      return await ctx.get(caller, workflow.id, tx);
    });
  });
}

export async function attach(
  ctx: ExperimentsContext,
  caller: Caller,
  value: ExperimentAttach,
  transaction?: Transaction,
): Promise<ExperimentEvidence> {
  ctx.open();
  caller = structuredClone(caller);
  const input = parseExperimentInput(experimentAttachSchema, value);
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await command(ctx, caller, 'attach', input, tx, async () => {
      const experiment = await ctx.get(caller, input.experimentId, tx);
      handleFor(ctx, experiment.workflow.version);
      revision(ctx, experiment, input.expectedRevision);
      check(
        experiment.attempt.index === input.attemptIndex,
        'attempt_conflict',
        `Expected attempt ${input.attemptIndex}, the current attempt is ${experiment.attempt.index}`,
        409,
      );
      await assertProducer(ctx, caller, experiment, tx);
      check(
        rolesFor(experiment.workflow.state).includes(input.role),
        'invalid_experiment_role',
        'This evidence role is not writable in the current state',
        409,
      );
      // Evidence is written against the work this experiment depends on, like the step itself.
      requireDependencies(
        (await ctx.workflows.prerequisites(caller, [experiment.id], tx)).get(experiment.id)!,
      );
      const artifact = await ctx.artifacts.get(caller, input.artifactId, tx);
      const inherited = await pinnedRecovery(ctx, caller, experiment, tx);
      check(
        (await authoredInExecution(ctx, caller, artifact, tx)) ||
          experiment.captureArtifactIds?.includes(artifact.id) ||
          inherited.some(
            (e) =>
              e.artifactId === artifact.id &&
              e.role === input.role &&
              e.path === input.path &&
              e.hash === artifact.hash &&
              e.resultFormat === input.resultFormat,
          ),
        'invalid_evidence_author',
        'Evidence must be authored by this worker or be its exact frozen recovery input',
        403,
      );
      const text = await evidenceText(ctx, caller, artifact.id, tx);
      if (input.role === 'result') {
        parseResult(text, input.resultFormat ?? 'json');
        // The exhibit pins every current result, so one past its limits could never be submitted.
        const kept = currentEvidence(experiment, ['result']).filter((e) => e.path !== input.path);
        const added = {
          path: input.path,
          artifactId: artifact.id,
          hash: artifact.hash,
          createdAt: now(),
          resultFormat: input.resultFormat,
          sequence: 0,
        } as ExperimentEvidence;
        await buildExhibit(ctx, caller, experiment, [...kept, added], tx).catch((error) => {
          throw error instanceof MervError && error.code === 'invalid_experiment_evidence'
            ? new MervError(
                error.code,
                `The attempt's metrics exhibit cannot hold this result beside the others (${error.message}); attach it at the path of one it replaces`,
              )
            : error;
        });
      }
      if (input.role === 'feasibility') parseFeasibility(text);
      const figureIds = ['plan', 'report'].includes(input.role)
        ? await figures(ctx, caller, text, experiment, tx)
        : [];
      const association = await saveEvidence(
        ctx,
        caller,
        experiment,
        input.role,
        input.path,
        artifact,
        input.resultFormat,
        false,
        tx,
        figureIds,
      );
      await recordEvent(
        ctx,
        caller,
        'evidence_attached',
        experiment.id,
        {
          evidenceId: association.id,
          artifactId: artifact.id,
          role: input.role,
          path: input.path,
          attemptIndex: input.attemptIndex,
        },
        tx,
      );
      return association;
    });
  });
}

async function selected(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  roles: readonly string[],
  tx: Transaction,
): Promise<ExperimentEvidence[]> {
  const evidence = currentEvidence(experiment, roles);
  // The worker holding this experiment sees the evidence it was offered plus its own;
  // anyone else, another record's worker included, reads what the record holds.
  if (!caller.session || !(await holds(ctx, caller, experiment, tx))) return evidence;
  const allowed = new Set(await allowedArtifacts(ctx, caller, experiment, tx));
  return evidence.filter((e) => allowed.has(e.artifactId));
}

function one(
  ctx: ExperimentsContext,
  evidence: ExperimentEvidence[],
  role: string,
): ExperimentEvidence {
  const matching = evidence.filter((e) => e.role === role);
  check(
    matching.length === 1,
    'experiment_evidence_required',
    `Exactly one current ${role} artifact is required`,
    409,
  );
  return matching[0]!;
}

async function authoredInExecution(
  ctx: ExperimentsContext,
  caller: Caller,
  artifact: Artifact,
  tx: Transaction,
): Promise<boolean> {
  return caller.session
    ? (await ctx.artifacts.executionOutputs(caller, tx)).some((output) => output.id === artifact.id)
    : artifact.createdBy === caller.actorId;
}

async function evidenceText(
  ctx: ExperimentsContext,
  caller: Caller,
  id: string,
  tx: Transaction,
): Promise<string> {
  return decodeEvidence((await ctx.artifacts.bytes(caller, id, tx)).bytes);
}

async function figures(
  ctx: ExperimentsContext,
  caller: Caller,
  text: string,
  experiment: Experiment,
  tx: Transaction,
): Promise<string[]> {
  const ids = [...new Set(markdownImageTargets(text))];
  const allowed = caller.session
    ? new Set(await allowedArtifacts(ctx, caller, experiment, tx))
    : null;
  for (const id of ids) {
    check(
      !allowed || allowed.has(id),
      'forbidden',
      'Figure is outside this worker’s frozen inputs and authored outputs',
      403,
    );
    const { artifact, bytes } = await ctx.artifacts.bytes(caller, id, tx);
    check(
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mediaType) &&
        bytes.length > 0,
      'invalid_experiment_evidence',
      'Figures must be retained PNG, JPEG, GIF or WebP image artifacts',
    );
  }
  return ids;
}

/** The metrics exhibit of the selected `result` evidence. */
async function buildExhibit(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  results: ExperimentEvidence[],
  tx: Transaction,
): Promise<ExperimentExhibit> {
  const sources = [...results].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.sequence - b.sequence,
  );
  const inputs = await mapAsync(sources, async (source) => ({
    path: source.path,
    artifactId: source.artifactId,
    sha256: source.hash,
    submittedAt: source.createdAt,
    resultFormat: source.resultFormat ?? 'json',
    data: parseResult(
      await evidenceText(ctx, caller, source.artifactId, tx),
      source.resultFormat ?? 'json',
    ),
  }));
  const exhibit = buildMetricsExhibit({
    projectId: experiment.projectId,
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    startedAt: experiment.attempt.startedAt,
    sources: inputs,
  });
  const bytes = exhibitBytes(exhibit);
  return {
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    path: `experiments/${experiment.name}/metrics_exhibit.json`,
    content: bytes.toString('utf8'),
    hash: sha256Hex(bytes),
    willPin: shouldPinExhibit(inputs),
    sources,
    startedAt: experiment.attempt.startedAt,
  };
}

export async function exhibit(
  ctx: ExperimentsContext,
  caller: Caller,
  id: string,
  transaction?: Transaction,
): Promise<ExperimentExhibit> {
  ctx.open();
  caller = structuredClone(caller);
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'read', tx);
    const experiment = await ctx.get(caller, id, tx);
    check(
      experiment.workflow.state === 'running',
      'experiment_not_running',
      'Exhibit preview is available while running; read a pinned exhibit artifact after submission',
      409,
    );
    return await buildExhibit(
      ctx,
      caller,
      experiment,
      await selected(ctx, caller, experiment, ['result'], tx),
      tx,
    );
  });
}

/**
 * Abandons an experiment of this project that nobody started, for a coordinator whose selected
 * work waits on an input that ended without success: one still planned with no work ever
 * started on it. False, with nothing changed, for anything else.
 */
export async function closeUnstarted(
  ctx: ExperimentsContext,
  caller: Caller,
  experimentId: string,
  reason: string,
  requestId: string,
  tx: Transaction,
): Promise<boolean> {
  ctx.open();
  const row = await tx.get<{ id: string }>(
    'SELECT id FROM experiments WHERE id=? AND project_id=?',
    experimentId,
    caller.projectId,
  );
  if (!row) return false;
  const current = await ctx.workflows.get(caller, row.id, tx);
  if (current.state !== 'planned') return false;
  if ((await ctx.workflows.workStarts(caller, row.id, tx)).length) return false;
  await transition(
    ctx,
    caller,
    {
      experimentId,
      expectedRevision: current.revision,
      transition: 'abandon',
      evidence: { reason },
      requestId,
    },
    tx,
  );
  return true;
}

export async function transition(
  ctx: ExperimentsContext,
  caller: Caller,
  value: ExperimentTransition,
  transaction?: Transaction,
): Promise<Experiment> {
  ctx.open();
  caller = structuredClone(caller);
  const input: ExperimentTransition = parseExperimentInput(experimentTransitionSchema, value);
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'write', tx);
    return await command(ctx, caller, 'transition', input, tx, async () => {
      const experiment = await ctx.get(caller, input.experimentId, tx);
      handleFor(ctx, experiment.workflow.version);
      revision(ctx, experiment, input.expectedRevision);
      const prepared = await checkAction(ctx, {
        caller,
        snapshot: experiment.workflow,
        tx,
        input: { ...input },
        transition: input.transition,
      });
      if (input.transition === 'submit_design' || input.transition === 'submit_results')
        return await submit(ctx, caller, experiment, input, prepared!, tx);
      if (experiment.reviewId && reviewing(experiment.workflow.state))
        await ctx.reviews.supersede(caller, experiment.reviewId, tx);
      const moved = await move(
        ctx,
        caller,
        experiment,
        {
          expectedRevision: input.expectedRevision,
          action: input.transition,
          input: { ...input },
          requestId: childRequest(caller, 'experiment', 'transition', input.requestId),
          data: { reason: input.evidence?.reason ?? null },
        },
        tx,
      );
      if (input.transition === 'retry_running')
        await feedback(
          ctx,
          experiment,
          `Infrastructure recovery: ${input.evidence?.reason}. ${input.evidence?.detail ?? ''} Recover existing jobs and retained outputs before starting new work.`,
          tx,
        );
      else {
        await tx.run(
          'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
          moved.revision,
          experiment.id,
          experiment.attempt.index,
        );
        await tx.run(
          'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
          input.evidence?.reason ?? null,
          experiment.id,
        );
      }
      await recordEvent(
        ctx,
        caller,
        'transitioned',
        experiment.id,
        {
          transition: input.transition,
          from: experiment.workflow.state,
          to: moved.state,
          revision: moved.revision,
          attemptIndex: experiment.attempt.index,
          reason: input.evidence?.reason ?? null,
          detail: input.evidence?.detail ?? null,
        },
        tx,
      );
      return await ctx.get(caller, experiment.id, tx);
    });
  });
}

/** The document, figure, exhibit and authorship gates over a submission's selected evidence. */
async function prepareSubmission(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  selection: ExperimentEvidence[],
  tx: Transaction,
): Promise<Submission> {
  let evidence = selection;
  let figureIds: string[] = [];
  let exhibit: ExperimentExhibit | null = null;
  // A result submission includes the exact approved design, never a newer plan association.
  const approved =
    experiment.workflow.state === 'running' ? approvedSubmission(experiment) : undefined;
  if (!approved) {
    const plan = one(ctx, evidence, 'plan');
    const text = await evidenceText(ctx, caller, plan.artifactId, tx);
    figureIds = await figures(ctx, caller, text, experiment, tx);
    validatePlan(text, { figures: figureIds });
    const statement = parseFeasibility(
      await evidenceText(ctx, caller, one(ctx, evidence, 'feasibility').artifactId, tx),
    );
    // The cheap check: a design whose own figures fall short never reaches a reviewer.
    const shortfalls = feasibilityShortfalls(statement);
    check(
      shortfalls.length === 0,
      'experiment_infeasible',
      `This design's own feasibility statement does not admit it: ${shortfalls.join('; ')}. Redesign within what is available, or end the experiment with a reason`,
      409,
    );
  } else {
    evidence = [...approved.evidence, ...evidence];
    const report = one(ctx, evidence, 'report');
    const text = await evidenceText(ctx, caller, report.artifactId, tx);
    figureIds = [
      ...new Set([...approved.figureIds, ...(await figures(ctx, caller, text, experiment, tx))]),
    ];
    // Their bytes were read when the design was submitted, and artifacts never change.
    await ctx.artifacts.getAll(caller, approved.figureIds, tx);
    exhibit = await buildExhibit(
      ctx,
      caller,
      experiment,
      selection.filter((e) => e.role === 'result'),
      tx,
    );
    validateReport(text, {
      figures: figureIds,
      ...(exhibit.willPin ? { exhibitPath: exhibit.path } : {}),
    });
  }
  const inherited = [
    ...(await pinnedRecovery(ctx, caller, experiment, tx)),
    ...(approved?.evidence ?? []),
  ];
  for (const item of evidence) {
    const metadata = await ctx.artifacts.get(caller, item.artifactId, tx);
    check(
      metadata.hash === item.hash,
      'artifact_hash_mismatch',
      'The selected evidence metadata changed',
      409,
    );
    check(
      (await authoredInExecution(ctx, caller, metadata, tx)) ||
        experiment.captureArtifactIds?.includes(item.artifactId) ||
        inherited.some(
          (pin) =>
            pin.experimentId === item.experimentId &&
            pin.attemptIndex === item.attemptIndex &&
            pin.role === item.role &&
            pin.path === item.path &&
            pin.artifactId === item.artifactId &&
            pin.hash === item.hash &&
            pin.resultFormat === item.resultFormat,
        ),
      'invalid_evidence_author',
      'Submission includes evidence outside the current worker’s authorship and frozen recovery selection',
      403,
    );
  }
  return { evidence, figureIds, exhibit };
}

/** A Git result is submitted from the attached running worker whose final capture is pending. */
async function finalCaptureRef(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<CodeCaptureRef> {
  check(
    caller.session,
    'session_required',
    'Git result submission requires its actual worker session',
    403,
  );
  const ref: CodeCaptureRef = { kind: 'session-final', sessionId: caller.session.id };
  const checked = await ctx.code.checkCapture(
    caller,
    ref,
    {
      unitId: experiment.id,
      revision: experiment.workflow.revision,
      workflow: runningNode,
      actorId: caller.actorId,
    },
    tx,
  );
  check(
    checked.status === 'pending' && checked.capture.provenance.hostRef,
    'experiment_capture_provenance',
    'Submit from the exact attached running Git worker before final capture',
    409,
  );
  return ref;
}

/** The submission is what checkAction verified moments earlier in this transaction. */
async function submit(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  input: ExperimentTransition,
  { evidence, figureIds, exhibit, codeCaptureRef }: Submission,
  tx: Transaction,
): Promise<Experiment> {
  const stage = input.transition === 'submit_design' ? 'design' : 'results';
  if (exhibit?.willPin) {
    const artifact = await ctx.artifacts.create(
      caller,
      {
        title: `Metrics exhibit: ${experiment.name}`,
        content: exhibit.content,
        mediaType: 'application/json',
      },
      tx,
    );
    evidence.push(
      await saveEvidence(
        ctx,
        caller,
        experiment,
        'exhibit',
        exhibit.path,
        artifact,
        undefined,
        true,
        tx,
      ),
    );
  }
  const artifactIds = [...new Set([...evidence.map((e) => e.artifactId), ...figureIds])];
  const pinnedInputIds = (await ctx.artifacts.getAll(caller, artifactIds, tx))
    .filter((artifact) => artifact.createdBy !== caller.actorId)
    .map((artifact) => artifact.id);
  const moved = await move(
    ctx,
    caller,
    experiment,
    {
      expectedRevision: input.expectedRevision,
      action: input.transition,
      input: { ...input },
      requestId: childRequest(caller, 'experiment', 'transition', input.requestId),
    },
    tx,
  );
  const review = await ctx.reviews.request(
    caller,
    {
      subjectId: experiment.id,
      subjectRevision: moved.revision,
      producerId: caller.actorId,
      administrativeActorId: experiment.ownerId,
      // Neither the owner nor the authority that directed a worker is independent of its work.
      ...(caller.session
        ? {
            excludedActorIds: [
              ...new Set([experiment.ownerId, (await ctx.scope.authorityActor(caller, tx)).id]),
            ],
          }
        : {}),
      artifactIds,
      pinnedInputIds,
      criteria: [...(stage === 'design' ? designCriteria : resultsCriteria)],
      ...(stage === 'design' ? { requiredCriteria: [feasibilityCriterion] } : {}),
      formatVersion: 2,
      requestId: childRequest(caller, 'experiment', 'submission', input.requestId),
    },
    tx,
  );
  const round =
    ((
      await tx.get<{ count: number }>(
        'SELECT COALESCE(MAX(round),0) AS count FROM experiment_submissions WHERE experiment_id=? AND attempt_index=? AND stage=?',
        experiment.id,
        experiment.attempt.index,
        stage,
      )
    )?.count ?? 0) + 1;
  const submission: ExperimentSubmission = {
    id: newId('exp_sub'),
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    stage,
    ...(codeCaptureRef ? { codeCaptureRef } : {}),
    round,
    subjectRevision: moved.revision,
    producerId: caller.actorId,
    sessionId: caller.session?.id ?? null,
    evidence,
    figureIds,
    manifestHash: digest({
      formatVersion: 1,
      evidence,
      figures: await ctx.artifacts.getAll(caller, figureIds, tx),
      ...(codeCaptureRef ? { codeCaptureRef } : {}),
    }),
    reviewId: review.id,
    createdAt: now(),
  };
  await tx.run(
    'INSERT INTO experiment_submissions(id,experiment_id,attempt_index,stage,round,review_id,record) VALUES(?,?,?,?,?,?,?)',
    submission.id,
    experiment.id,
    experiment.attempt.index,
    stage,
    round,
    review.id,
    JSON.stringify(submission),
  );
  await tx.run('UPDATE experiments SET review_id=? WHERE id=?', review.id, experiment.id);
  await recordEvent(
    ctx,
    caller,
    'submitted',
    experiment.id,
    {
      submissionId: submission.id,
      stage,
      round,
      attemptIndex: experiment.attempt.index,
      reviewId: review.id,
      manifestHash: submission.manifestHash,
      artifactIds,
    },
    tx,
  );
  return await ctx.get(caller, experiment.id, tx);
}

export async function submitReview(
  ctx: ExperimentsContext,
  caller: Caller,
  value: ExperimentReview,
  transaction?: Transaction,
): Promise<Experiment> {
  ctx.open();
  caller = structuredClone(caller);
  const input = plain<ExperimentReview>(value, 'invalid_experiment_input', {
    nodes: 8192,
    depth: 20,
    bytes: 262144,
  });
  return await inTransaction(ctx.state, transaction, async (tx) => {
    await ctx.scope.require(caller, 'review', tx);
    check(record(input), 'invalid_experiment_input', 'Review input must be an object');
    if (input.paperChanges !== undefined)
      input.paperChanges = ctx.paper.parseChanges(input.paperChanges);
    check(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'invalid_revision',
      'expectedRevision is required',
    );
    const review = await ctx.reviews.get(caller, input.reviewId, tx);
    const experiment = await ctx.get(caller, review.subjectId, tx);
    const submission = experiment.submissions.find((s) => s.reviewId === review.id);
    check(submission, 'stale_review', 'Review is not an experiment submission', 409);
    const action = route(ctx, submission.stage, input);
    return await command(ctx, caller, 'submit_review', input, tx, async () => {
      // The transition's guard runs checkReview before anything below is written.
      let conclusion: string | null = null;
      if (action === 'accept_results') {
        const report = one(ctx, submission.evidence, 'report');
        const body = await evidenceText(ctx, caller, report.artifactId, tx);
        const section = reportConclusion(body);
        conclusion =
          typeof input.evidence?.conclusion === 'string' && visible(input.evidence.conclusion)
            ? input.evidence.conclusion.trim()
            : section || input.notes;
      }
      const moved = await handleFor(ctx, experiment.workflow.version).transition(
        caller,
        {
          instanceId: experiment.id,
          expectedRevision: input.expectedRevision,
          action,
          input: { ...input },
          requestId: childRequest(caller, 'experiment', 'review', input.requestId),
          data: {
            verdict: input.verdict,
            reviewId: review.id,
            returnTo: input.returnTo ?? null,
            ...epochAfter(
              experiment,
              action,
              experiment.attempt.index +
                (['revise_design', 'revise_plan'].includes(action) ? 1 : 0),
            ),
          },
        },
        tx,
      );
      const { expectedRevision: _revision, ...verdict } = input;
      await ctx.reviews.submit(
        caller,
        { ...verdict, requestId: childRequest(caller, 'experiment', 'review', input.requestId) },
        tx,
      );
      if (input.paperChanges !== undefined)
        await ctx.paper.applyReview(
          caller,
          {
            ...input.paperChanges,
            source: { kind: 'experiment', id: experiment.id, revision: review.subjectRevision },
            reviewId: review.id,
            verdict: input.verdict,
            evidenceIds: review.artifactIds,
          },
          tx,
        );
      if (action === 'approve_design')
        await tx.run(
          'UPDATE experiment_attempts SET approved_submission_id=?,approved_review_id=? WHERE experiment_id=? AND attempt_index=?',
          submission.id,
          review.id,
          experiment.id,
          experiment.attempt.index,
        );
      else if (['revise_design', 'revise_plan'].includes(action)) {
        await tx.run(
          'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
          moved.revision - 1,
          experiment.id,
          experiment.attempt.index,
        );
        const index = experiment.attempt.index + 1;
        await addAttempt(
          ctx,
          experiment.id,
          index,
          moved.revision,
          experiment.attempt.index,
          [input.notes],
          now(),
          tx,
          [review.id],
        );
        await tx.run('UPDATE experiments SET attempt_index=? WHERE id=?', index, experiment.id);
      } else if (action === 'revise_execution')
        await feedback(ctx, experiment, input.notes, tx, review.id);
      else if (action === 'accept_results') {
        await tx.run(
          'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
          moved.revision,
          experiment.id,
          experiment.attempt.index,
        );
        // Every version records its success, so later work can take its base from it. The
        // reference is the one the submission stored: the review capture is read only while
        // the experiment is under review, and the guard's checkReview has just verified it there.
        await ctx.code.acceptUnit(
          caller,
          {
            unitId: experiment.id,
            terminalRevision: moved.revision,
            submissionRef: submission.id,
            reviewRef: review.id,
            codeRef: submission.codeCaptureRef!,
            reviewSessionId: caller.session?.id ?? null,
          },
          tx,
        );
      }
      await tx.run(
        'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
        conclusion,
        experiment.id,
      );
      await recordEvent(
        ctx,
        caller,
        'review_applied',
        experiment.id,
        {
          reviewId: review.id,
          submissionId: submission.id,
          verdict: input.verdict,
          returnTo: input.returnTo ?? null,
          action,
          from: experiment.workflow.state,
          to: moved.state,
          revision: moved.revision,
        },
        tx,
      );
      return await ctx.get(caller, experiment.id, tx);
    });
  });
}

/**
 * Exit readiness of an owner transition, shared by guidance and the command writer. For a
 * submission, it answers with what would be submitted.
 */
export async function checkAction(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<Submission | undefined> {
  const { caller, tx } = context,
    experiment = await current(ctx, context);
  const action = context.transition;
  if (context.input?.expectedRevision !== undefined)
    revision(ctx, experiment, context.input.expectedRevision as number);
  if (action === 'abandon' || action === 'mark_failed') {
    await ctx.scope.require(caller, 'write', tx);
    check(
      !terminal.has(experiment.workflow.state),
      'experiment_closed',
      'The experiment is already terminal',
      409,
    );
    await assertAdministration(ctx, caller, experiment, tx);
    reasoned(context.input, 'Ending an experiment requires a reason');
    return;
  }
  // Running work's approved plan and prerequisites are checked here as well.
  await assertProducer(ctx, caller, experiment, tx);
  if (action === 'submit_design' || action === 'submit_results') {
    check(
      experiment.workflow.state === (action === 'submit_design' ? 'planned' : 'running'),
      'invalid_transition',
      'This submission is not available in the current state',
      409,
    );
    const selection = await selected(
      ctx,
      caller,
      experiment,
      rolesFor(experiment.workflow.state),
      tx,
    );
    const own = one(ctx, selection, action === 'submit_design' ? 'plan' : 'report');
    check(
      await authoredInExecution(
        ctx,
        caller,
        await ctx.artifacts.get(caller, own.artifactId, tx),
        tx,
      ),
      'invalid_evidence_author',
      'The submitting worker must retain and attach its own plan or report after verifying any inherited evidence',
      403,
    );
    let codeCaptureRef: CodeCaptureRef | undefined;
    if (action === 'submit_results') {
      check(
        selection.some((e) => e.role === 'result'),
        'experiment_evidence_required',
        'At least one result is required',
        409,
      );
      // Only the worker that ran the attempt submits it, so guidance never offers it a person.
      codeCaptureRef = await finalCaptureRef(ctx, caller, experiment, tx);
    }
    return {
      ...(await prepareSubmission(ctx, caller, experiment, selection, tx)),
      codeCaptureRef,
    };
  }
  if (action === 'retry_running') {
    check(
      experiment.workflow.state === 'running',
      'invalid_transition',
      'retry_running is available only during execution',
      409,
    );
    // The submission requires the interruption's reason under evidence, as ending does.
    // Without this, guidance answered `ready` for a retry the tool then refused.
    reasoned(context.input, 'Retrying an experiment requires the reason for the interruption');
  }
}

async function addAttempt(
  ctx: ExperimentsContext,
  id: string,
  index: number,
  revision: number,
  previous: number | null,
  feedback: string[],
  createdAt: string,
  tx: Transaction,
  feedbackReviewIds: string[] = [],
): Promise<void> {
  await tx.run(
    'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,previous_index,feedback,created_at,feedback_review_ids) VALUES(?,?,?,?,?,?,?)',
    id,
    index,
    revision,
    previous,
    JSON.stringify(feedback),
    createdAt,
    JSON.stringify(feedbackReviewIds),
  );
}

async function feedback(
  ctx: ExperimentsContext,
  experiment: Experiment,
  note: string,
  tx: Transaction,
  reviewId?: string,
): Promise<void> {
  await tx.run(
    'UPDATE experiment_attempts SET feedback=?,feedback_review_ids=? WHERE experiment_id=? AND attempt_index=?',
    JSON.stringify([...experiment.attempt.feedback, note]),
    JSON.stringify([...experiment.attempt.feedbackReviewIds, ...(reviewId ? [reviewId] : [])]),
    experiment.id,
    experiment.attempt.index,
  );
}

async function saveEvidence(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  role: ExperimentEvidence['role'],
  path: string,
  artifact: Artifact,
  resultFormat: 'json' | 'qualitative' | undefined,
  systemGenerated: boolean,
  tx: Transaction,
  figureIds: string[] = [],
): Promise<ExperimentEvidence> {
  const sequence =
    ((
      await tx.get<{ sequence: number }>(
        'SELECT COALESCE(MAX(sequence),0) AS sequence FROM experiment_evidence WHERE experiment_id=?',
        experiment.id,
      )
    )?.sequence ?? 0) + 1;
  const evidence: ExperimentEvidence = {
    id: newId('exp_ev'),
    experimentId: experiment.id,
    attemptIndex: experiment.attempt.index,
    role,
    path,
    artifactId: artifact.id,
    hash: artifact.hash,
    figureIds,
    createdBy: caller.actorId,
    sessionId: caller.session?.id ?? null,
    createdAt: now(),
    sequence,
    current: true,
    ...(resultFormat ? { resultFormat } : {}),
    systemGenerated,
  };
  await tx.run(
    'INSERT INTO experiment_evidence(id,experiment_id,attempt_index,role,path,sequence,record) VALUES(?,?,?,?,?,?,?)',
    evidence.id,
    experiment.id,
    experiment.attempt.index,
    role,
    path,
    sequence,
    JSON.stringify(evidence),
  );
  // A plan, a feasibility statement and a report are one document each: a newer one at another
  // path replaces the earlier, so an attempt is never stuck with two current plans and no way
  // to choose.
  if (role === 'plan' || role === 'feasibility' || role === 'report')
    await tx.run(
      'DELETE FROM experiment_slots WHERE experiment_id=? AND attempt_index=? AND role=? AND path<>?',
      experiment.id,
      experiment.attempt.index,
      role,
      path,
    );
  await tx.run(
    'INSERT INTO experiment_slots(experiment_id,attempt_index,role,path,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT(experiment_id,attempt_index,role,path) DO UPDATE SET evidence_id=excluded.evidence_id',
    experiment.id,
    experiment.attempt.index,
    role,
    path,
    evidence.id,
  );
  return evidence;
}

async function command<T>(
  ctx: ExperimentsContext,
  caller: Caller,
  operation: string,
  input: { requestId: string },
  tx: Transaction,
  execute: () => T | Promise<T>,
): Promise<T> {
  return await replayed(tx, 'experiment_commands', caller, operation, input, execute, {
    after: async () =>
      await ctx.scope.require(caller, operation === 'submit_review' ? 'review' : 'write', tx),
  });
}

async function recordEvent(
  ctx: ExperimentsContext,
  caller: Caller,
  type: string,
  id: string,
  data: Data,
  tx: Transaction,
) {
  await recorded(ctx.state, tx, caller, `experiment.${type}`, id, data);
}
