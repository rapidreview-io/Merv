import { check, type WorkflowDefinition, type WorkflowSnapshot } from '@merv/contracts';
import type { Experiment, ExperimentAttempt, ExperimentSubmission } from './types.js';

// The experiment workflow: its graph, the executable versions, the evidence roles and the
// compute epochs every current contract shares.

export const activeStates = ['planned', 'design_review', 'running', 'experiment_review'] as const;

export type ActiveState = (typeof activeStates)[number];

export const reviewing = (state: string) =>
  state === 'design_review' || state === 'experiment_review';

export const producing = (state: string) => state === 'planned' || state === 'running';

/**
 * The executable contracts. Each grants the large-upload tools, which refuse where the blob
 * store cannot sign uploads; the twin without them (experiment@36) is retired.
 */
export const programVersions: readonly number[] = [40];

export function programContract(version: number) {
  check(
    programVersions.includes(version),
    'workflow_version_retired',
    `Experiment workflow ${version} is retired`,
    409,
  );
}

export const currentExperiment = (version: number) => programVersions.includes(version);

/** The workflow node an experiment's Git work is captured from. */
export const runningNode = {
  name: 'experiment',
  versions: [...programVersions],
  state: 'running',
};

/** The contract a new experiment runs on. */
export const programVersion = 40;

/**
 * The evidence a design submission is made of, which is also what a successor planner inherits.
 * Every registered version submits a design with a feasibility statement, and its review cannot
 * waive the feasibility criterion.
 */
export const designRoles: readonly string[] = ['plan', 'feasibility'];

/** The evidence roles a producer attaches in a state: its design, then its results. */
export const rolesFor = (state: string): readonly string[] =>
  state === 'planned' ? designRoles : ['result', 'report'];

/** This attempt's current evidence in the given roles. */
export const currentEvidence = (experiment: Experiment, roles: readonly string[]) =>
  experiment.evidence.filter(
    (e) => e.current && e.attemptIndex === experiment.attempt.index && roles.includes(e.role),
  );

/** The design submission this attempt was approved on, exactly as its review approved it. */
export function approvedSubmission(
  experiment: Experiment,
  message = 'The current attempt requires an exact approved plan',
): ExperimentSubmission {
  const submission = experiment.submissions.find(
    (s) => s.id === experiment.attempt.approvedSubmissionId,
  );
  check(
    submission &&
      submission.stage === 'design' &&
      submission.attemptIndex === experiment.attempt.index &&
      submission.reviewId === experiment.attempt.approvedReviewId,
    'approved_plan_required',
    message,
    409,
  );
  return submission;
}

/** The submission a review assesses, if it is this attempt's and of the stage under review. */
export function reviewedSubmission(
  experiment: Experiment,
  reviewId: string,
): ExperimentSubmission | undefined {
  const submission = experiment.submissions.find((s) => s.reviewId === reviewId);
  const stage = experiment.workflow.state === 'design_review' ? 'design' : 'results';
  return submission?.attemptIndex === experiment.attempt.index && submission.stage === stage
    ? submission
    : undefined;
}

/**
 * The compute epoch of an attempt in a state, kept in workflow data as `computeEpoch`. Sandboxes
 * cancels compute started under an older epoch, so a retry in the same state keeps it.
 */
export const experimentEpoch = (attemptIndex: number, state: string) => `${attemptIndex}:${state}`;

/**
 * The epochs an attempt's compute runs under: one per state, and for work Sandboxes pinned
 * before Experiments recorded one, the epoch Sandboxes derived from each revision this attempt
 * passed through (a move changes it and from then on records one). No other attempt's revisions.
 */
export const captureEpochs = (
  attempt: Pick<ExperimentAttempt, 'index' | 'startedRevision' | 'endedRevision'>,
  workflow: Pick<WorkflowSnapshot, 'data' | 'revision'>,
): string[] => {
  const last = attempt.endedRevision ?? workflow.revision;
  return [
    ...new Set([
      ...EXPERIMENT_WORKFLOW.states.map((state) => experimentEpoch(attempt.index, state)),
      ...Array.from({ length: Math.max(0, last - attempt.startedRevision + 1) }, (_, n) =>
        String(attempt.startedRevision + n),
      ),
    ]),
  ];
};

/** The workflow data that sets the epoch the move `action` leads to. */
export function epochAfter(
  experiment: Pick<Experiment, 'workflow'>,
  action: string,
  attemptIndex: number,
): { computeEpoch?: string } {
  const { state, data } = experiment.workflow;
  const to = EXPERIMENT_WORKFLOW.edges.find(
    (edge) => edge.from === state && edge.action === action,
  )?.to;
  if (!to) return {};
  // A retry keeps the epoch its compute runs under; work started before Experiments recorded
  // one ran under attempt:state.
  if (to === state)
    return {
      computeEpoch:
        typeof data.computeEpoch === 'string'
          ? data.computeEpoch
          : experimentEpoch(attemptIndex, to),
    };
  return { computeEpoch: experimentEpoch(attemptIndex, to) };
}

/** An experiment in one of these states is over: complete, abandoned or failed. */
export const TERMINAL = ['complete', 'abandoned', 'failed'] as const;

export const EXPERIMENT_WORKFLOW: WorkflowDefinition = {
  name: 'experiment',
  version: 28,
  initial: 'planned',
  states: [...activeStates, ...TERMINAL],
  terminal: [...TERMINAL],
  edges: [
    { from: 'planned', action: 'submit_design', to: 'design_review' },
    { from: 'design_review', action: 'approve_design', to: 'running' },
    { from: 'design_review', action: 'revise_design', to: 'planned' },
    { from: 'running', action: 'submit_results', to: 'experiment_review' },
    { from: 'running', action: 'retry_running', to: 'running' },
    { from: 'experiment_review', action: 'accept_results', to: 'complete' },
    { from: 'experiment_review', action: 'revise_plan', to: 'planned' },
    { from: 'experiment_review', action: 'revise_execution', to: 'running' },
    ...activeStates.flatMap((from) => [
      { from, action: 'abandon', to: 'abandoned' },
      { from, action: 'mark_failed', to: 'failed' },
    ]),
  ],
};

/**
 * How often a design review, and a results review, may return an experiment. A design return
 * or a return to planning opens a new attempt, so together they bound an experiment's
 * attempts. After the last return the next submission waits for a human, who reviews it by
 * hand or allows another round. Deployed policy, so every live program version is covered.
 */
export const EXPERIMENT_LIMITS = { designRounds: 4, resultRounds: 3 };
