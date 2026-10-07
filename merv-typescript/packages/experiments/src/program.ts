import { computeGuidance } from '@merv/sandboxes/compute-capability';
import { requireDependencies } from '@merv/workflows/rules';
import {
  directsIndependently,
  excludedFromReview,
  NOT_INDEPENDENT,
  reviewHistory,
  reviewActions,
  REVIEW_VERDICTS,
} from '@merv/reviews/rules';
import { mapAsync } from '@merv/contracts';
import {
  insertLease,
  leaseRows,
  reviewedLeaseHooks,
  type LeaseRow as WorkflowLeaseRow,
} from '@merv/workflows/lease-rows';
import { grant, literal, reference, target } from '@merv/workflows/rules';
import { codeWorkspace } from '@merv/code-work/workspace';
import { postgresMigrations } from './program.postgres.js';
import {
  check,
  clip,
  digest,
  type Artifact,
  type Caller,
  type ContextInput,
  type ContextItem,
  type Data,
  type ReviewRequest,
  type ContextRecipeDefinition,
  type Transaction,
  type WorkflowAssignmentRule,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowExecutionReferences,
  type WorkflowPolicy,
  type WorkflowSnapshot,
  type WorkflowTransition,
} from '@merv/contracts';
import type { ExperimentsContext } from './index.js';
import { artifactItem, textItem } from '@merv/context-builder/artifact-item';
import type { CodeCapture } from '@merv/code-work/types';
import type {
  Experiment,
  ExperimentAttempt,
  ExperimentEvidence,
  ExperimentReview,
  ExperimentSubmission,
} from './types.js';
import type { FeasibilityStatement } from './evidence.js';

const activeStates = ['planned', 'design_review', 'running', 'experiment_review'] as const;
export type ActiveState = (typeof activeStates)[number];
export const reviewing = (state: string) =>
  state === 'design_review' || state === 'experiment_review';
export const producing = (state: string) => state === 'planned' || state === 'running';

/** The executable contracts: new work selects one by its uploads, live work keeps its own. */
const programVersions: Record<number, { largeUploads: boolean }> = {
  36: { largeUploads: false },
  40: { largeUploads: true },
};
function programContract(version: number) {
  const contract = programVersions[version];
  check(contract, 'workflow_version_retired', `Experiment workflow ${version} is retired`, 409);
  return contract;
}
export const currentExperiment = (version: number) => Object.hasOwn(programVersions, version);
/** The workflow node an experiment's Git work is captured from. */
export const runningNode = {
  name: 'experiment',
  versions: Object.keys(programVersions).map(Number),
  state: 'running',
};
/** The contract a new experiment runs on. */
export const programVersion = (largeUploads = false): number =>
  Number(
    Object.entries(programVersions).find(
      ([, contract]) => contract.largeUploads === largeUploads,
    )![0],
  );
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

const recipeNames: Record<ActiveState, string> = {
  planned: 'experiment.design',
  design_review: 'experiment.design_review',
  running: 'experiment.execute',
  experiment_review: 'experiment.attempt_review',
};
const instructions: Record<ActiveState, string> = {
  planned:
    'Design an experiment that can test its stated question as one step toward the project paper’s Problem, scope and goals. It need not achieve the whole project goal alone. Read any abbreviated paper sections with paper.read and distinguish established findings from the hypothesis. Preserve source-specified methods when the question calls for reproduction; identify each deliberate departure and limit the conclusion accordingly. Define matched controls, data, metrics, evaluation conditions and decision criteria. Planning waits for the tasks this experiment depends on and is written against their outputs.',
  design_review:
    'Independently test whether the exact pinned design can answer its research question and make the stated contribution toward the project paper’s goals. An experiment may be an intermediate step; do not require it to complete the whole project. Read any abbreviated paper sections with paper.read. Compare source-specified methods with the plan when it claims reproduction, and check that departures are explicit and the promised conclusion is limited accordingly. Examine controls, baselines, leakage, evaluation and feasibility. A structurally complete plan can still be scientifically unsound. Grade only the pinned submission.',
  running:
    'Execute the exact approved plan below. Recover completed work and retained outputs before rerunning after interruption. Preserve errors and failed runs. Compare observations with the planned criteria without treating a negative finding as failed execution. Do not replace the approved plan with a newer upload.',
  experiment_review:
    'Independently assess the exact submitted results against the pinned approved plan. Verify counts, metrics, deviations and conclusions from retained evidence. A passing experiment can refute its hypothesis. Separate a flawed design from execution or reporting that can be repaired under the same plan.',
};
const handoffs: Record<ActiveState, string> = {
  planned:
    'Create your own complete UTF-8 plan artifact with Summary, Objective & hypothesis, and Evaluation sections. Verify inherited planning work before retaining your own plan; its bytes may be unchanged after verification, but a predecessor’s plan cannot be submitted as your new output. Attach it as role plan with the current numeric attemptIndex and expectedRevision. Then call experiment.transition with transition submit_design and a stable requestId. Stop while independent design review is pending.',
  design_review:
    'You own the paper update: keep it brief, usually one or two sentences stating the hypothesis, proposed method and this experiment’s purpose as planned work, never as completed results. Submit through review.submit with the current reviewId, claimId and expectedRevision. Supply verification notes, a plain synopsis and one finding per criterion. Pass rejects returnTo. Either needs_changes or fail returns to planned; returnTo may be omitted or planned. A design rejection creates a new attempt. Stop after the verdict.',
  running:
    'Retain result and report artifacts and attach them to this attempt. The report is a UTF-8 markdown document with Summary, Results, Deviations from plan and Conclusion sections, and it names the pinned metrics exhibit by its filename. Verify inherited results and figures before reusing their exact frozen records. You must author and attach your own report affirming what you checked; a predecessor’s report cannot be your new submitted output. Selecting what mattered for the report is the authorship; do not hide known rework, pivots or failed attempts, and record them under Deviations from plan. Declared JSON results must be finite valid JSON; explicitly qualitative results are distinct. Use experiment.exhibit to inspect the deterministic metrics exhibit and interpret any pinned exhibit in the report. Submit via experiment.transition with transition submit_results, the current revision, and a stable requestId. The reviewer owns the paper update; submit the scientific evidence and report, not paper edits. Use retry_running only for an infrastructure interruption; it preserves the attempt and its approved plan.',
  experiment_review:
    'You own the paper update: explain what was actually done and learned, replacing planned text with verified outcomes and preserving uncertainty. Add comprehensive methods, results and interpretation when that detail helps explain the project’s trajectory and informs what comes next; there is no brevity requirement for results-review paper updates. Submit through review.submit with the current reviewId, claimId and expectedRevision, verification notes, a plain synopsis and one finding per criterion. Pass rejects returnTo and completes the experiment. For either needs_changes or fail, explicitly choose returnTo planned for a new design/attempt, or running for repair under this same approved plan. A fail verdict does not itself terminally fail the experiment. Stop after the verdict.',
};
for (const state of ['design_review', 'experiment_review'] as const)
  handoffs[state] +=
    ' You are responsible for updating the project paper’s Methods and Results in perspective of the whole project. Read paper.read immediately before preparing edits. Submit your own paperChanges: {documents: [{kind: "methods" or "results", expectedRevision: current revision, changes: [{id, title, content}]}]} with review.submit. Revise existing sections rather than appending a review log; cite experiments with Markdown links [Experiment name](/experiments/EXPERIMENT_ID), using each experiment’s actual name as the visible label, and cite exact evidence. Keep stable IDs only in link destinations. Paper edits save with any verdict, so describe rejected or inconclusive work honestly without presenting it as accepted findings. If no edits are warranted, explain why in notes.';

/**
 * What a feasibility-gated design adds to the planner's and the design reviewer's handoff. It is
 * added beside the handoffs above rather than written into them, because the published recipe and
 * the policies of every registered version embed both texts exactly as they are.
 */
const gatedHandoffs: Partial<Record<ActiveState, string>> = {
  planned:
    'Before submitting, also retain a feasibility statement as a JSON artifact in the shape of feasibilityFormat: what the design requires against what exists — data, compute and time, each with the basis you measured it from — the dependencies it needs and whether each is present, and any known blocker. Measure, do not assume; name the record or artifact each number came from. Attach it as role feasibility. A statement showing a shortfall, an absent dependency or a blocker cannot be submitted: shrink the design to what is available, or end the experiment with the reason.',
  design_review:
    'Criterion 4 is required: a pass cannot waive it or leave it not_verified, and its finding must cite the feasibility statement artifact. Open the records the statement names and recompute its numbers, and look for requirements, dependencies and blockers the statement leaves out. If it does not hold, the verdict is needs_changes.',
};
const handoff = (state: ActiveState) =>
  gatedHandoffs[state] ? `${handoffs[state]} ${gatedHandoffs[state]}` : handoffs[state];
/** Said to every planner, executor and reviewer of an experiment, in the assignment. */
const sourceVerification =
  'Verify pivotal source-stated formulas and procedures against the primary paper and nearby prose or derivation before implementation or verdict. Text extraction can lose superscripts and symbols: inspect the rendered page when available, otherwise cross-check adjacent source statements. Cite the section and distinguish printed from PDF page numbering. Treat unresolved notation as uncertainty, not a paper inconsistency; reviewers must independently verify pivotal claims before passing.';
/** The shape a planner fills in, shown beside the design it is asked for. */
const feasibilityFormat: FeasibilityStatement = {
  formatVersion: 1,
  resources: [
    {
      kind: 'data',
      name: 'What is needed, such as labelled training examples',
      unit: 'examples',
      required: 0,
      available: 0,
      basis: 'The record or artifact the available figure was measured from',
    },
  ],
  dependencies: [
    { name: 'A model, dataset, service or tool', present: true, basis: 'How it was verified' },
  ],
  blockers: [],
};

/**
 * What a worker may look at. The assignment's own tool list reads as the boundary of it: over
 * one project, 22 of 22 task and experiment workers made no project-level read, while every
 * worker whose recipe named these tools used them.
 */
const reading =
  ' Everything this project holds is readable from this assignment, whether or not it is named below: project.records, task.get, experiment.get_state, paper.read, review.get and artifact.read answer for anything in this project — the other experiments and their plans and results, the tasks and their deliveries, the reviews and the feed. Read the project before you settle anything it may already have settled, and say what you reused and what you chose yourself.';
const verifying =
  ' Open what you are judging rather than judging the summary of it: artifact.read returns the retained bytes of everything pinned to this submission, and a criterion you mark met on text you were handed rather than evidence you opened yourself says so in its notes.';

/** Current format-2 recipes, constructed directly without retired intermediate versions.
 * Published versions and recipe bytes are immutable; only their construction is shared. */
/** Every recipe's budget, which the paper's items are chosen within too. */
const CONTEXT_CHARS = 160_000;
export const EXPERIMENT_RECIPES: ContextRecipeDefinition[] = activeStates.map((state) => ({
  name: recipeNames[state],
  version: state === 'experiment_review' ? 12 : 11,
  kind: reviewing(state) ? 'review' : 'work',
  recipe: {
    instructions:
      instructions[state] +
      reading +
      (reviewing(state) ? verifying : '') +
      ' Each context section shows a source either whole, under its own heading, or as one line naming the tool that retrieves it; whole bodies are included highest priority first while they fit. A source shown by its line is still evidence to open with its retrieval tool.',
    outputInstructions:
      handoffs[state] +
      (gatedHandoffs[state]
        ? ` When ${state === 'planned' ? 'the experiment below carries feasibilityFormat' : 'the pinned review names requiredCriteria'}: ${gatedHandoffs[state]}`
        : ''),
    maxChars: CONTEXT_CHARS,
    sections: [
      { key: 'experiment', title: 'Experiment and exact assignment', required: true },
      { key: 'projectPaper', title: 'Project paper and document revisions', required: false },
      {
        key: 'approvedPlan',
        title: 'Exact approved plan',
        required: state === 'running' || state === 'experiment_review',
      },
      {
        key: 'assessment',
        title: 'Pinned review and numbered criteria',
        required: reviewing(state),
      },
      { key: 'evidence', title: 'Selected evidence and retained work', required: reviewing(state) },
      { key: 'feedback', title: 'Previous review and interruption feedback', required: false },
      ...(state === 'experiment_review'
        ? [
            {
              key: 'exhibitReference',
              title: 'Metrics exhibit (read the retained artifact to verify its source mapping)',
              required: true,
            },
          ]
        : []),
    ],
    format: 2 as const,
  },
}));

/**
 * How often a design review, and a results review, may return an experiment. A design return
 * or a return to planning opens a new attempt, so together they bound an experiment's
 * attempts. After the last return the next submission waits for a human, who reviews it by
 * hand or allows another round. Deployed policy, so every live program version is covered.
 */
export const EXPERIMENT_LIMITS = { designRounds: 4, resultRounds: 3 };

/**
 * Feasibility is its own design criterion, the last, so the review can be asked never to waive it;
 * the statement's arithmetic is its author's, which is why the reviewer is told to look for what it
 * leaves out as well as for what it gets wrong.
 */
export const designCriteria = [
  'The plan defines a testable hypothesis and an evaluation that can distinguish it from alternatives.',
  'Controls, baselines, data, metrics and decision criteria make the proposed comparison defensible.',
  'The limitations and possible failure modes of the proposed execution are addressed.',
  'The feasibility statement is accurate and complete: each required and available quantity, the compute and time estimate, and the presence of every dependency were verified by the reviewer against retained records; no requirement, dependency or blocker the design implies is omitted; and no known blocker remains.',
];
export const feasibilityCriterion = designCriteria.length;
export const resultsCriteria = [
  'The retained execution and results follow the exact approved plan, with deviations and failures explained.',
  'The submitted measurements agree with the retained results and any metrics exhibit, and the report selects what mattered without hiding known rework.',
  'The report’s conclusions follow from the evidence, including negative findings and limitations.',
];

interface FrozenInputs {
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
/** An experiment's lease: the attempt it serves and the inputs, artifacts and recovery it froze. */
type LeaseRow = WorkflowLeaseRow<{
  attemptIndex: number;
  artifacts: Artifact[];
  recovery: ExperimentEvidence[];
  inputs: FrozenInputs;
}>;
const own = (value: unknown): Data => JSON.parse(JSON.stringify(value)) as Data;
/** What names an experiment's lease. */
type LeaseTarget = Pick<Experiment, 'id' | 'projectId'> & {
  workflow: Pick<Experiment['workflow'], 'revision' | 'state'>;
  attempt?: Pick<Experiment['attempt'], 'index'>;
};
/**
 * What the rounds of every attempt may add to the optional feedback section. The section is
 * dropped whole when it does not fit, so the history stays small beside the latest reviews.
 */
const REVIEW_HISTORY_CHARS = 8000;
/** The newest interruption and revision notes a context embeds, each clipped; get_state has all. */
const FEEDBACK_KEPT = 5;
const FEEDBACK_CHARS = 2000;

function execution(state: ActiveState, version: number): WorkflowExecutionPolicy {
  const experiment = { experimentId: target('instanceId') };
  const revision = { expectedRevision: target('revision') };
  const workerActions =
    state === 'planned'
      ? ['submit_design', 'abandon', 'mark_failed']
      : ['submit_results', 'retry_running', 'abandon', 'mark_failed'];
  return {
    readOnly: reviewing(state),
    workspace:
      state === 'running'
        ? codeWorkspace('work', 'experiments')
        : state === 'experiment_review'
          ? codeWorkspace('review', 'experiment-reviews')
          : { mode: 'none' },
    tools: [
      grant(
        'workflow.status_and_next',
        { instanceId: target('instanceId') },
        { instanceId: { kind: 'oneOf', name: 'dependencies' } },
      ),
      grant('workflow.assignment', { instanceId: target('instanceId') }),
      grant('experiment.get_state', experiment),
      grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('review.get', { reviewId: { kind: 'oneOf', name: 'reviews' } }),
      ...(reviewing(state)
        ? [
            grant('review.start', { reviewId: reference('reviewId') }),
            grant('review.submit', {
              reviewId: reference('reviewId'),
              claimId: reference('claimId'),
              ...revision,
            }),
          ]
        : [
            grant('artifact.create', {}),
            ...(programContract(version).largeUploads
              ? [
                  grant('artifact.upload_begin', {}),
                  grant('artifact.upload_resume', {}),
                  grant('artifact.upload_complete', {}),
                ]
              : []),
            grant(
              'experiment.attach',
              ...rolesFor(state).map((role) => ({
                ...experiment,
                ...revision,
                artifactId: { kind: 'oneOf' as const, name: 'artifacts' },
                role: literal(role),
              })),
            ),
            grant(
              'experiment.transition',
              ...workerActions.map((transition) => ({
                ...experiment,
                ...revision,
                transition: literal(transition),
              })),
            ),
            ...(state === 'running' ? [grant('experiment.exhibit', experiment)] : []),
            ...(state === 'running' ? [grant('code.commit', {}), grant('code.operation', {})] : []),
          ]),
    ],
  };
}

// The experiment program: the workflow, context and lease rules of every current contract. It
// never launches or authenticates a session. Each runs on ExperimentService (index.ts) as its
// ExperimentsContext: the records and evidence these rules read, with one set of dependencies
// and one lifecycle.

/** Migrates the lease table, then registers every recipe and current workflow version. */
export async function register(ctx: ExperimentsContext): Promise<void> {
  await ctx.state.migrate('experiment_program', postgresMigrations);
  try {
    for (const recipe of EXPERIMENT_RECIPES)
      ctx.contexts.set(
        activeStates.find((state) => recipeNames[state] === recipe.name)!,
        await ctx.contextBuilder.register(recipe),
      );
    for (const version of Object.keys(programVersions).map(Number))
      ctx.handles.set(
        version,
        await ctx.workflows.register({ ...EXPERIMENT_WORKFLOW, version }, policy(ctx, version)),
      );
  } catch (error) {
    unregister(ctx);
    throw error;
  }
}

export function unregister(ctx: ExperimentsContext): void {
  for (const handle of ctx.handles.values()) handle.dispose();
  ctx.handles.clear();
  for (const context of ctx.contexts.values()) context.dispose();
  ctx.contexts.clear();
}

export function handleFor(ctx: ExperimentsContext, version: number) {
  programContract(version);
  const handle = ctx.handles.get(version);
  check(
    handle,
    'experiment_version_unavailable',
    'The experiment program version is unavailable',
    503,
  );
  return handle;
}

/**
 * Takes an owner edge whose exit checks the calling command has just run in this transaction,
 * so the edge's guard does not run them again. Every other path to the edge is still guarded.
 */
export async function move(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  transition: Omit<WorkflowTransition, 'instanceId'>,
  tx: Transaction,
) {
  const { id, revision, version } = experiment.workflow;
  const data = {
    ...transition.data,
    ...epochAfter(experiment, transition.action, experiment.attempt.index),
  };
  return await ctx.checked.take(tx, { instanceId: id, revision, action: transition.action }, () =>
    handleFor(ctx, version).transition(
      caller,
      { instanceId: experiment.id, ...transition, data },
      tx,
    ),
  );
}

export function revision(ctx: ExperimentsContext, experiment: Experiment, expected: number): void {
  check(
    Number.isSafeInteger(expected) && experiment.workflow.revision === expected,
    'revision_conflict',
    'The experiment changed; read its current revision',
    409,
  );
}

/** The review edge a verdict takes from the stage it assessed. */
export function route(
  ctx: ExperimentsContext,
  stage: 'design' | 'results',
  input: ExperimentReview,
): string {
  check(
    REVIEW_VERDICTS.includes(input.verdict),
    'invalid_verdict',
    'A supported review verdict is required',
  );
  if (input.verdict === 'pass') {
    check(
      input.returnTo === undefined,
      'invalid_review_return',
      'Passing reviews do not accept returnTo',
    );
    return stage === 'design' ? 'approve_design' : 'accept_results';
  }
  if (stage === 'design') {
    check(
      input.returnTo === undefined || input.returnTo === 'planned',
      'invalid_review_return',
      'A rejected design returns only to planned',
    );
    return 'revise_design';
  }
  check(
    input.returnTo === 'planned' || input.returnTo === 'running',
    'invalid_review_return',
    'Both negative attempt verdicts require returnTo planned or running',
  );
  return input.returnTo === 'planned' ? 'revise_plan' : 'revise_execution';
}

/** The checked experiment. Guidance's callbacks each ask; one snapshot reads it once. */
export async function current(
  ctx: ExperimentsContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<Experiment> {
  const key = `experiments:get:${caller.projectId}:${snapshot.id}`;
  return structuredClone(await ctx.state.remember(key, () => ctx.get(caller, snapshot.id, tx)));
}

export async function facts(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<Experiment> {
  check(!ctx.closed, 'experiment_unavailable', 'The experiment program is unavailable', 503);
  const experiment = await current(ctx, context);
  check(
    experiment.workflow.revision === context.snapshot.revision &&
      experiment.workflow.state === context.snapshot.state,
    'revision_conflict',
    'The experiment assignment changed',
    409,
  );
  return experiment;
}

/** Read once per snapshot, or per write transaction until it writes; each caller gets a copy. */
export async function activeLease(
  ctx: ExperimentsContext,
  experiment: LeaseTarget,
  tx: Transaction,
): Promise<LeaseRow | undefined> {
  const { projectId, id, workflow } = experiment;
  const lease = await ctx.state.remember(
    `experiments:lease:${projectId}:${id}:${workflow.revision}`,
    async () =>
      (
        await leaseRows<LeaseRow['details']>(
          tx,
          { projectId, instanceIds: [id], revision: workflow.revision, active: true },
          'full',
        )
      )[0],
  );
  // A copy: what the lease froze is the caller's to read, not the cached row's.
  return lease && structuredClone(lease);
}

/** The caller's live lease on this revision; without `attempt`, at whichever attempt it holds. */
export async function leaseOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: LeaseTarget,
  tx: Transaction,
): Promise<LeaseRow> {
  check(
    caller.session,
    'stale_lease',
    'This operation requires the current experiment worker',
    403,
  );
  const lease = await activeLease(ctx, experiment, tx);
  check(
    lease &&
      lease.id === caller.session.id &&
      lease.actor_id === caller.actorId &&
      (!experiment.attempt || lease.details.attemptIndex === experiment.attempt.index) &&
      lease.state === experiment.workflow.state,
    'stale_lease',
    'The worker no longer owns this exact experiment assignment',
    409,
  );
  return lease;
}

/** Interactive production is fenced while a lease owns the current node. Terminal administration is separate. */
export async function assertProducer(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<void> {
  await ctx.scope.require(caller, 'write', tx);
  check(
    producing(experiment.workflow.state),
    'experiment_not_writable',
    'Evidence work is available only during planning or execution',
    409,
  );
  if (caller.session) await leaseOf(ctx, caller, experiment, tx);
  else {
    if (caller.actorId !== experiment.ownerId) await ctx.scope.require(caller, 'admin', tx);
    check(
      !(await activeLease(ctx, experiment, tx)),
      'experiment_leased',
      'A worker session holds this revision; the operator who offered it can halt it, or wait for its handoff',
      409,
    );
  }
  if (experiment.workflow.state === 'running') {
    approvedPlan(ctx, experiment);
    requireDependencies(
      (await ctx.workflows.prerequisites(caller, [experiment.id], tx)).get(experiment.id)!,
    );
  }
}

/** Ending work is explicit administration, independent of production readiness or prerequisites. */
export async function assertAdministration(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<void> {
  await ctx.scope.require(caller, 'write', tx);
  if (caller.session) {
    check(
      producing(experiment.workflow.state),
      'forbidden',
      'Review workers cannot end an experiment',
      403,
    );
    await leaseOf(ctx, caller, experiment, tx);
  } else if (caller.actorId !== experiment.ownerId) {
    await ctx.scope.require(caller, 'admin', tx);
  }
}

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

/** The current review, pinned to this exact submission. Its code capture is read separately. */
export async function reviewOf(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ReviewRequest> {
  check(
    experiment.reviewId && reviewing(experiment.workflow.state),
    'stale_review',
    'The experiment has no current review assignment',
    409,
  );
  const review = await ctx.reviews.get(caller, experiment.reviewId, tx);
  check(
    review.subjectId === experiment.id &&
      review.subjectRevision === experiment.workflow.revision &&
      reviewedSubmission(experiment, review.id),
    'stale_review',
    'This review must pin the exact current submission and attempt',
    409,
  );
  return review;
}

/**
 * The commit a results review pins: the producing session's final capture, resolved by its
 * immutable reference even after its handoff. A machine that died before handing that capture
 * over leaves its writer for an operator to fence; Code then answers with the last commit it
 * admitted from that session, which is what the fence kept.
 */
export async function reviewCapture(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<CodeCapture | null> {
  if (experiment.workflow.state !== 'experiment_review') return null;
  const submission = experiment.submissions.find((entry) => entry.reviewId === experiment.reviewId);
  check(
    submission?.stage === 'results' &&
      submission.codeCaptureRef?.kind === 'session-final' &&
      submission.codeCaptureRef.sessionId === submission.sessionId,
    'experiment_capture_required',
    'The result submission must pin its producing session capture',
    409,
  );
  const checked = await ctx.code.checkCapture(
    caller,
    submission.codeCaptureRef,
    {
      unitId: experiment.id,
      revision: submission.subjectRevision - 1,
      workflow: runningNode,
      sessionId: submission.sessionId,
      actorId: submission.producerId,
    },
    tx,
  );
  check(
    checked.status !== 'foreign',
    'experiment_capture_provenance',
    'The code capture must belong to the exact producing experiment node',
    409,
  );
  check(
    checked.status === 'ready',
    'experiment_capture_pending',
    'The producing worker must stop and report its final Git capture before review, or an operator fences its writer with code.unit.fence',
    409,
  );
  return checked.capture;
}

/**
 * A verdict's own checks, made after its review is pinned and Reviews has checked the
 * submission: it names that review at the current revision, and it routes to this edge.
 */
export async function checkReview(
  ctx: ExperimentsContext,
  { caller, tx, input: proposed, transition }: WorkflowCheckContext,
  experiment: Experiment,
  pinned: ReviewRequest,
): Promise<void> {
  const input = proposed as unknown as ExperimentReview;
  if (input.expectedRevision !== undefined) revision(ctx, experiment, input.expectedRevision);
  await ctx.scope.require(caller, 'review', tx);
  const review =
    input.reviewId === pinned.id ? pinned : await ctx.reviews.get(caller, input.reviewId, tx);
  check(
    experiment.reviewId === review.id,
    'stale_review',
    'This review no longer belongs to the current submission',
    409,
  );
  revision(ctx, experiment, input.expectedRevision);
  const submission = reviewedSubmission(experiment, review.id)!;
  check(
    submission.subjectRevision === review.subjectRevision &&
      submission.producerId === review.producerId,
    'stale_review',
    'The review must pin this exact attempt and submission',
    409,
  );
  check(
    digest([
      ...new Set([...submission.evidence.map((e) => e.artifactId), ...submission.figureIds]),
    ]) === digest(review.artifactIds),
    'stale_review',
    'Review evidence differs from the sealed submission',
    409,
  );
  const action = route(ctx, submission.stage, input);
  // Reviews holds the criterion to met with some pinned evidence; only Experiments knows
  // which artifact is the statement, and a finding citing the plan alone has not read it.
  const statement = submission.evidence.find((e) => e.role === 'feasibility');
  if (input.verdict === 'pass' && submission.stage === 'design' && statement)
    check(
      input.findings
        ?.find((finding) => finding.criterionNumber === feasibilityCriterion)
        ?.evidenceIds.includes(statement.artifactId),
      'feasibility_not_cited',
      `A passing design review cites the feasibility statement ${statement.artifactId} in the finding for criterion ${feasibilityCriterion}`,
    );
  if (input.paperChanges !== undefined)
    await ctx.paper.checkReview(
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
  check(
    !transition || action === transition,
    'invalid_review_return',
    'The verdict does not select this transition',
  );
}

export async function admit(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<{ experiment: Experiment; review: ReviewRequest | null }> {
  const experiment = await facts(ctx, context);
  if (producing(context.snapshot.state)) {
    await assertProducer(ctx, context.caller, experiment, context.tx);
    await requireBase(ctx, context);
    return { experiment, review: null };
  }
  await ctx.scope.require(context.caller, 'review', context.tx);
  const review = await reviewOf(ctx, context.caller, experiment, context.tx);
  await reviewCapture(ctx, context.caller, experiment, context.tx);
  if (context.caller.session) {
    const lease = await leaseOf(ctx, context.caller, experiment, context.tx);
    check(
      lease.review_id === review.id && lease.claim_id === review.claimId,
      'stale_claim',
      'The session no longer owns its pinned claim',
      409,
    );
    await ctx.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
  } else if (review.status === 'requested')
    await ctx.reviews.checkStart(context.caller, review.id, context.tx);
  else await ctx.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
  return { experiment, review };
}

/**
 * Refuses producing work whose base Code cannot derive, with Code's own blocker code. This
 * only reads: it runs under lease admission, the dispatch candidate scan and every
 * assignment check. The refusal makes the experiment no candidate at all, so it is never
 * launched and never held; Code publishes the reason where status and the stuck report look.
 */
export async function requireBase(
  ctx: ExperimentsContext,
  { caller, snapshot, tx }: WorkflowCheckContext,
): Promise<void> {
  await ctx.code.requireLeasable(
    caller,
    { unitId: snapshot.id, writer: snapshot.state === 'running' },
    tx,
  );
}

export function eligibleRecovery(
  ctx: ExperimentsContext,
  experiment: Experiment,
): ExperimentEvidence[] {
  return currentEvidence(experiment, rolesFor(experiment.workflow.state));
}

/** Only associations selected before this worker's offer can exempt old output authorship. */
export async function pinnedRecovery(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<ExperimentEvidence[]> {
  await ctx.scope.require(caller, 'read', tx);
  if (!caller.session) return [];
  return (await leaseOf(ctx, caller, experiment, tx)).details.recovery;
}

/** Whether this session is the worker holding the experiment's live lease. */
export async function holds(
  ctx: ExperimentsContext,
  caller: Caller,
  experiment: Experiment,
  tx: Transaction,
): Promise<boolean> {
  return (await activeLease(ctx, experiment, tx))?.id === caller.session?.id;
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
    ...(context.snapshot.state === 'running' ? await pinnedBase(ctx, context) : {}),
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
        : '\nThis experiment will execute in a configured private Git workspace; planning and design review use scratch space.';
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
      computeGuidance(state === 'running' ? 'execute' : 'check'),
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
    execution: { readOnly: reviewing(state), tools: [] },
    context: preview,
  };
}

export async function leaseRole(
  ctx: ExperimentsContext,
  context: WorkflowCheckContext,
): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> {
  check(!context.caller.session, 'forbidden', 'A leased worker cannot delegate work', 403);
  const experiment = await facts(ctx, context);
  if (producing(context.snapshot.state)) {
    await assertProducer(ctx, context.caller, experiment, context.tx);
    await requireBase(ctx, context);
    return 'producer';
  }
  await ctx.scope.require(context.caller, 'review', context.tx);
  const review = await reviewOf(ctx, context.caller, experiment, context.tx);
  await reviewCapture(ctx, context.caller, experiment, context.tx);
  check(
    review.status === 'requested' && !(await activeLease(ctx, experiment, context.tx)),
    'review_unavailable',
    'This review is already reserved or claimed',
    409,
  );
  // A source may have directed a prior producer session, but never directs the review of
  // work it produced itself. The rest of independence belongs to the new worker.
  check(directsIndependently(review, context.caller.actorId), ...NOT_INDEPENDENT);
  return 'reviewer';
}

export function leaseHooks(ctx: ExperimentsContext): NonNullable<WorkflowAssignmentRule['lease']> {
  return reviewedLeaseHooks({
    reviews: ctx.reviews,
    artifacts: ctx.artifacts,
    excluded: excludedFromReview,
    label: async (context) => (await facts(ctx, context)).name,
    review: async (context) => {
      const experiment = await facts(ctx, context);
      return reviewing(experiment.workflow.state) ? experiment.reviewId : null;
    },
    // The lease of the attempt the facts name: Workflows admitted the step just before.
    lease: async (context) =>
      await leaseOf(ctx, context.caller, await facts(ctx, context), context.tx),
    captures: async (context, lease) =>
      (await ctx.sandboxes?.captures(
        context.caller.projectId,
        context.snapshot.id,
        context.tx,
        captureEpochs(
          await attemptRevisions(ctx, context.snapshot.id, lease.details.attemptIndex, context.tx),
          context.snapshot,
        ),
      )) ?? [],
    role: async (context) => await leaseRole(ctx, context),
    acquire: async (context) => {
      await leaseRole(ctx, { ...context, caller: context.source });
      const experiment = await facts(ctx, context);
      check(
        context.caller.session?.id === context.leaseId &&
          context.source.projectId === context.caller.projectId,
        'invalid_lease',
        'The offered experiment worker must match its source and lease',
        403,
      );
      // The first producing lease fixes the base, and it is normally the planner's; a later
      // one reads the same pin back, so execution inherits what the plan was written against.
      // A refused offer takes the pin back with its transaction.
      if (producing(context.snapshot.state)) {
        // Only execution has a checkout, so only its lease is a writer generation.
        await ctx.code.pinBase(
          context.source,
          {
            unitId: experiment.id,
            leaseId: context.leaseId,
            writer: context.snapshot.state === 'running',
          },
          context.tx,
        );
      }
      let review: ReviewRequest | null = null;
      if (reviewing(context.snapshot.state)) {
        const pinned = await reviewOf(ctx, context.caller, experiment, context.tx);
        await reviewCapture(ctx, context.caller, experiment, context.tx);
        review = await ctx.reviews.start(context.caller, pinned.id, context.tx);
      }
      const inputs = await inputsOf(ctx, context.caller, experiment, context.tx);
      const artifacts = await ctx.artifacts.getAll(
        context.source,
        inputIds(ctx, inputs),
        context.tx,
      );
      const recovery = reviewing(context.snapshot.state) ? [] : eligibleRecovery(ctx, experiment);
      const receipt: Data = {
        leaseId: context.leaseId,
        experimentId: experiment.id,
        revision: context.snapshot.revision,
        attemptIndex: experiment.attempt.index,
        state: context.snapshot.state,
        actorId: context.caller.actorId,
        sourceActorId: context.source.actorId,
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
        details: { attemptIndex: experiment.attempt.index, artifacts, recovery, inputs },
      });
      return receipt;
    },
  });
}

/** The revisions an attempt ran through, as captureEpochs reads them. */
export async function attemptRevisions(
  ctx: ExperimentsContext,
  id: string,
  index: number,
  tx: Transaction,
) {
  const row = (await tx.get<{ started_revision: number; ended_revision: number | null }>(
    'SELECT started_revision,ended_revision FROM experiment_attempts WHERE experiment_id=? AND attempt_index=?',
    id,
    index,
  ))!;
  return {
    index,
    startedRevision: Number(row.started_revision),
    endedRevision: row.ended_revision === null ? null : Number(row.ended_revision),
  };
}

export function policy(ctx: ExperimentsContext, version: number): WorkflowPolicy {
  const argumentsFor = (context: WorkflowCheckContext): Data => ({
    experimentId: context.snapshot.id,
    expectedRevision: context.snapshot.revision,
  });
  const action = (
    name: string,
    states: string[],
    instruction: string,
    requiresDependencies = false,
  ) => ({
    name,
    states,
    transitions: [name],
    tool: 'experiment.transition',
    instruction,
    requiresDependencies,
    // Ending or retrying takes a reason under evidence; the guidance says so before the call.
    ...(['retry_running', 'abandon', 'mark_failed'].includes(name)
      ? { requiredInput: ['evidence'] }
      : {}),
    suggested: !['retry_running', 'abandon', 'mark_failed'].includes(name),
    arguments: (context: WorkflowCheckContext): Data => ({
      ...argumentsFor(context),
      transition: name,
    }),
    check: async (context: WorkflowCheckContext) => {
      if (!ctx.checked.found(context)) await ctx.checkAction({ ...context, transition: name });
    },
  });
  const lease = leaseHooks(ctx);
  return {
    successStates: ['complete'],
    dependencyFailureAction: 'mark_failed',
    limits: [
      {
        name: 'design_rounds',
        from: 'design_review',
        actions: ['revise_design'],
        max: ctx.limits.designRounds,
      },
      {
        name: 'result_rounds',
        from: 'experiment_review',
        actions: ['revise_plan', 'revise_execution'],
        max: ctx.limits.resultRounds,
      },
    ],
    assignments: activeStates.map((state) => ({
      state,
      // A plan is written against its inputs, so planning waits for the tasks the
      // experiment depends on, as running does (founder, 2026-09-18: an experiment
      // depends on tasks, never on another experiment).
      ...(['planned', 'running'].includes(state) ? { requiresDependencies: true } : {}),
      check: async (context) => {
        await admit(ctx, context);
      },
      build: async (context) => await build(ctx, context),
      references: async (context) => await references(ctx, context),
      execution: execution(state, version),
      lease,
    })),
    describe: async (context) => {
      const experiment = await facts(ctx, context);
      const review = experiment.reviewId
        ? await ctx.reviews.get(context.caller, experiment.reviewId, context.tx)
        : null;
      const state = context.snapshot.state as ActiveState;
      return {
        label: experiment.name,
        owner: {
          actorId: experiment.ownerId,
          asks: {
            submit_design: 'Submit the design for review',
            submit_results: 'Submit the results for review',
          },
        },
        gate:
          state === 'planned'
            ? 'design_required'
            : state === 'running'
              ? 'execution_evidence_required'
              : review?.status === 'requested'
                ? 'review_required'
                : 'independent_review',
        waiting: producing(state)
          ? handoff(state)
          : 'Wait for an independent reviewer to assess the exact pinned submission. Producer evidence stays immutable while its review is pending.',
        references: [
          ...(context.dependencies ?? []).map((dependency) => ({
            kind: 'workflow',
            id: dependency.id,
            label: `Prerequisite: ${dependency.name || dependency.id}`,
          })),
          ...(experiment.reviewId
            ? [
                {
                  kind: 'review',
                  id: experiment.reviewId,
                  label: 'Current or previous independent review',
                },
              ]
            : []),
          ...(experiment.attempt.approvedSubmissionId
            ? [
                {
                  kind: 'submission',
                  id: experiment.attempt.approvedSubmissionId,
                  label: 'Exact approved design',
                },
              ]
            : []),
        ],
      };
    },
    actions: [
      action('submit_design', ['planned'], handoff('planned'), true),
      action('submit_results', ['running'], handoffs.running, true),
      action(
        'retry_running',
        ['running'],
        'For an infrastructure interruption, retain a specific reason and recover completed work before rerunning. This preserves the attempt and approved plan.',
      ),
      action(
        'abandon',
        [...activeStates],
        'End this experiment as abandoned with a specific reason; unfinished review ownership is closed and evidence remains retained.',
      ),
      action(
        'mark_failed',
        [...activeStates],
        'End this experiment as failed with a specific reason; do not confuse this owner action with a reviewer returning work for correction.',
      ),
      ...(['design_review', 'experiment_review'] as const).flatMap((state) =>
        reviewActions<WorkflowCheckContext>({
          names: { submit: `submit_${state}`, start: `start_${state}` },
          states: [state],
          transitions:
            state === 'design_review'
              ? ['approve_design', 'revise_design']
              : ['accept_results', 'revise_plan', 'revise_execution'],
          instructions: {
            submit: handoff(state),
            start: 'Claim the exact current independent review, then refresh its assignment.',
          },
          reviews: ctx.reviews,
          // The submit check pins the same review and gates its capture, so this only names it.
          current: async (context) =>
            await reviewOf(ctx, context.caller, await facts(ctx, context), context.tx),
          submit: async (context) => {
            const experiment = await facts(ctx, context);
            const review = await reviewOf(ctx, context.caller, experiment, context.tx);
            await reviewCapture(ctx, context.caller, experiment, context.tx);
            await ctx.reviews.checkSubmit(
              context.caller,
              review.id,
              context.input as unknown as ExperimentReview | undefined,
              context.tx,
            );
            if (context.input) await checkReview(ctx, context, experiment, review);
          },
          start: async (context, review) => {
            await reviewCapture(ctx, context.caller, await facts(ctx, context), context.tx);
            check(
              !context.input?.reviewId || context.input.reviewId === review.id,
              'stale_review',
              'The current review is required',
              409,
            );
          },
        }),
      ),
    ],
  };
}
