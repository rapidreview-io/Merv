import { excludedFromReview, releasedLease, mapAsync } from '@merv/contracts';
import { postgresMigrations } from './program.postgres.js';
import {
  check,
  digest,
  MervError,
  reviewHistory,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type ContextInput,
  type ContextRegistration,
  type Data,
  type ReviewApplication,
  type ReviewRequest,
  type Reviews,
  type Scope,
  type State,
  type TaskTypeDefinition,
  type Transaction,
  type WorkflowAssignmentRule,
  type WorkflowCheckContext,
  type WorkflowDefinition,
  type WorkflowExecutionBinding,
  type WorkflowExecutionPolicy,
  type WorkflowExecutionReferences,
  type WorkflowLease,
  type WorkflowPolicy,
  type Workflows,
} from '@merv/contracts';
import type { Paper, PaperRevision, PaperWorkspace } from '@merv/paper/types';
import type { Code, CodeCapture } from '@merv/code-research/types';
import type { Experiment, ExperimentEvidence } from './types.js';
import type { FeasibilityStatement } from './evidence.js';

const activeStates = ['planned', 'design_review', 'running', 'experiment_review'] as const;
type ActiveState = (typeof activeStates)[number];
const reviewing = (state: string) => state === 'design_review' || state === 'experiment_review';
const producing = (state: string) => state === 'planned' || state === 'running';

/**
 * Registered program versions by workspace kind. A published execution policy is immutable, so
 * any policy change publishes a new version. New experiments start on 5 or 6, or 7 with an
 * explicit accepted task as base. In a project Code hosts, Git work without an explicit base
 * starts on 8: the first producing lease pins the derived base, normally at planning, and
 * execution inherits it. Only execution reserves a writer generation. Versions 1-4 could no
 * longer start and were retired on 2026-09-22 together with their records (experiments@4).
 */
const workspaces: Record<number, 'none' | 'git'> = {
  5: 'none',
  6: 'git',
  7: 'git',
  8: 'git',
};
const PROGRAM_VERSIONS = Object.keys(workspaces).map(Number);
export const programWorkspace = (version: number): 'none' | 'git' => workspaces[version] ?? 'none';
const referencedBase = (version: number) => version === 7 || derivedBase(version);
/** Whether Code derives and pins the base, rather than the creator naming a task. */
export const derivedBase = (version: number) => version === 8;
const CODE_DRIVER = 'code.v2';
export const programVersion = (workspace?: string, baseTaskId?: string, hosted = false): number =>
  workspace !== 'git' ? 5 : baseTaskId !== undefined ? 7 : hosted ? 8 : 6;
/**
 * The evidence a design submission is made of, which is also what a successor planner inherits.
 * Every registered version submits a design with a feasibility statement, and its review cannot
 * waive the feasibility criterion.
 */
export const designRoles: readonly string[] = ['plan', 'feasibility'];

export const EXPERIMENT_WORKFLOW: WorkflowDefinition = {
  name: 'experiment',
  version: 1,
  managed: true,
  initial: 'planned',
  states: [...activeStates, 'complete', 'abandoned', 'failed'],
  terminal: ['complete', 'abandoned', 'failed'],
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
    'Design an experiment that can test its stated question. Distinguish the hypothesis from established evidence. Define matched controls, data, metrics, evaluation conditions and decision criteria. Planning waits for the tasks this experiment depends on and is written against their outputs.',
  design_review:
    'Independently test whether the exact pinned design can answer its research question. Examine controls, baselines, leakage, evaluation and feasibility. A structurally complete plan can still be scientifically unsound. Grade only the pinned submission.',
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
 * The paper as a worker needs it in its frozen context: every document's revision and
 * sections, with the text while it fits the room a recipe leaves for the rest. A section
 * past that names its size, and the worker reads it with paper.read; a paper that grew
 * within its own limits must never make an experiment impossible to assign.
 */
function paperContext(documents: PaperWorkspace['documents'], room = 40_000) {
  let left = room;
  const brief = (document: PaperRevision): PaperRevision => ({
    ...document,
    sections: document.sections.map((section) => {
      const kept = section.content.length <= left;
      if (kept) left -= section.content.length;
      return kept
        ? section
        : { ...section, content: `(${section.content.length} characters; read with paper.read)` };
    }),
  });
  return Object.fromEntries(
    Object.entries(documents).map(([kind, document]) => [
      kind,
      {
        current: brief(document.current),
        published: document.published && {
          ...document.published,
          document: brief(document.published.document),
        },
      },
    ]),
  );
}

/**
 * What a worker may look at. The assignment's own tool list reads as the boundary of it: over
 * one project, 22 of 22 task and experiment workers made no project-level read, while every
 * worker whose recipe named these tools used them.
 */
const reading =
  ' Everything this project holds is readable from this assignment, whether or not it is named below: project.records, task.get, experiment.get_state, paper.read, review.get and artifact.read answer for anything in this project — the other experiments and their plans and results, the tasks and their deliveries, the reviews and the feed. Read the project before you settle anything it may already have settled, and say what you reused and what you chose yourself.';
const verifying =
  ' Open what you are judging rather than judging the summary of it: artifact.read returns the retained bytes of everything pinned to this submission, and a criterion you mark met on text you were handed rather than evidence you opened yourself says so in its notes.';

export const EXPERIMENT_RECIPES: TaskTypeDefinition[] = activeStates.map((state) => ({
  name: recipeNames[state],
  version: 9,
  kind: reviewing(state) ? 'review' : 'work',
  recipe: {
    instructions: instructions[state] + reading + (reviewing(state) ? verifying : ''),
    // One recipe serves every program version, so it says when the feasibility text applies.
    outputInstructions:
      handoffs[state] +
      (gatedHandoffs[state]
        ? ` When ${state === 'planned' ? 'the experiment below carries feasibilityFormat' : 'the pinned review names requiredCriteria'}: ${gatedHandoffs[state]}`
        : ''),
    maxChars: 160_000,
    sections: [
      { key: 'experiment', title: 'Experiment and exact assignment', required: true },
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
    ],
  },
}));

/**
 * How often a design review, and a results review, may return an experiment. A design return
 * or a return to planning opens a new attempt, so together they bound an experiment's
 * attempts. After the last return the next submission waits for a human, who reviews it by
 * hand or allows another round. Deployed policy, so every live program version is covered.
 */
export const EXPERIMENT_LIMITS = { designRounds: 4, resultRounds: 3 };

export interface ExperimentProgramHost {
  limits: typeof EXPERIMENT_LIMITS;
  state: State;
  scope: Scope;
  paper: Paper;
  code?: Pick<
    Code,
    'capture' | 'baseStatus' | 'pinBase' | 'basePin' | 'reserveWriter' | 'writerStatus'
  >;
  artifacts: Artifacts;
  workflows: Workflows;
  reviews: Reviews;
  contextBuilder: ContextBuilder;
  /** Domain records only. Never evaluate guidance or render context in this callback. */
  facts(caller: Caller, experimentId: string, tx: Transaction): Promise<Experiment>;
  /** Exit readiness belongs to the record/evidence owner. context.transition names the edge. */
  checkAction(context: WorkflowCheckContext): Promise<void>;
}

interface FrozenInputs {
  experiment: Data;
  approvedArtifacts: string[];
  evidenceArtifacts: string[];
  review: ReviewRequest | null;
  feedback: Data;
}
interface LeaseRow {
  id: string;
  project_id: string;
  experiment_id: string;
  revision: number;
  attempt_index: number;
  state: ActiveState;
  actor_id: string;
  source_actor_id: string;
  review_id: string | null;
  claim_id: string | null;
  receipt: string;
  artifacts: string;
  recovery: string;
  inputs: string;
  released_at: string | null;
}
const target = (field: 'instanceId' | 'revision'): WorkflowExecutionBinding => ({
  kind: 'target',
  field,
});
const ref = (name: string): WorkflowExecutionBinding => ({ kind: 'reference', name });
const literal = (value: string): WorkflowExecutionBinding => ({ kind: 'literal', value });
type Bindings = Record<string, WorkflowExecutionBinding>;
const grant = (name: string, ...alternatives: Bindings[]) => ({ name, alternatives });
const own = (value: unknown): Data => JSON.parse(JSON.stringify(value)) as Data;
/**
 * What the rounds of every attempt may add to the optional feedback section. The section is
 * dropped whole when it does not fit, so the history stays small beside the latest reviews.
 */
const REVIEW_HISTORY_CHARS = 8000;

/** One owned program: workflow, context and lease rules. It never launches or authenticates a session. */
export class ExperimentProgram {
  private handles = new Map<number, Awaited<ReturnType<Workflows['register']>>>();
  handleFor(version: number) {
    const handle = this.handles.get(version);
    check(
      handle,
      'experiment_version_unavailable',
      'The experiment program version is unavailable',
      503,
    );
    return handle;
  }
  private contexts = new Map<ActiveState, ContextRegistration>();
  private closed = false;

  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(private host: ExperimentProgramHost) {
    this.initialize = async () => {
      await host.state.migrate('experiment_program', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
        {
          version: 2,
          sql: postgresMigrations[2],
        },
        {
          version: 3,
          sql: postgresMigrations[3],
        },
      ]);
      try {
        for (const state of activeStates)
          this.contexts.set(
            state,
            await host.contextBuilder.register(
              EXPERIMENT_RECIPES.find((recipe) => recipe.name === recipeNames[state])!,
            ),
          );
        for (const version of PROGRAM_VERSIONS)
          this.handles.set(
            version,
            await host.workflows.register(
              { ...EXPERIMENT_WORKFLOW, version },
              this.policy(version),
            ),
          );
      } catch (error) {
        for (const handle of this.handles.values()) handle.dispose();
        for (const context of this.contexts.values()) context.dispose();
        throw error;
      }
    };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
    for (const context of this.contexts.values()) context.dispose();
    this.contexts.clear();
  }

  private async facts(context: WorkflowCheckContext): Promise<Experiment> {
    check(!this.closed, 'experiment_unavailable', 'The experiment program is unavailable', 503);
    const experiment = await this.host.facts(context.caller, context.snapshot.id, context.tx);
    check(
      experiment.workflow.revision === context.snapshot.revision &&
        experiment.workflow.state === context.snapshot.state,
      'revision_conflict',
      'The experiment assignment changed',
      409,
    );
    return experiment;
  }

  private async activeLease(
    experiment: Experiment,
    tx: Transaction,
  ): Promise<LeaseRow | undefined> {
    return await tx.get<LeaseRow>(
      'SELECT * FROM experiment_leases WHERE project_id=? AND experiment_id=? AND revision=? AND released_at IS NULL',
      experiment.projectId,
      experiment.id,
      experiment.workflow.revision,
    );
  }

  private async lease(caller: Caller, experiment: Experiment, tx: Transaction): Promise<LeaseRow> {
    check(
      caller.session,
      'stale_lease',
      'This operation requires the current experiment worker',
      403,
    );
    const lease = await this.activeLease(experiment, tx);
    check(
      lease &&
        lease.id === caller.session.id &&
        lease.actor_id === caller.actorId &&
        lease.attempt_index === experiment.attempt.index &&
        lease.state === experiment.workflow.state,
      'stale_lease',
      'The worker no longer owns this exact experiment assignment',
      409,
    );
    return lease;
  }

  /** Interactive production is fenced while a lease owns the current node. Terminal administration is separate. */
  async assertProducer(caller: Caller, experiment: Experiment, tx: Transaction): Promise<void> {
    await this.host.scope.require(caller, 'write', tx);
    check(
      producing(experiment.workflow.state),
      'experiment_not_writable',
      'Evidence work is available only during planning or execution',
      409,
    );
    if (caller.session) await this.lease(caller, experiment, tx);
    else {
      if (caller.actorId !== experiment.ownerId) await this.host.scope.require(caller, 'admin', tx);
      check(
        !(await this.activeLease(experiment, tx)),
        'experiment_leased',
        'A worker session holds this revision; the operator who offered it can halt it, or wait for its handoff',
        409,
      );
    }
    if (experiment.workflow.state === 'running') {
      this.approvedPlan(experiment);
      await this.host.workflows.checkDependencies(caller, experiment.id, tx);
    }
  }

  /** Ending work is explicit administration, independent of production readiness or prerequisites. */
  async assertAdministration(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<void> {
    await this.host.scope.require(caller, 'write', tx);
    if (caller.session) {
      check(
        producing(experiment.workflow.state),
        'forbidden',
        'Review workers cannot end an experiment',
        403,
      );
      await this.lease(caller, experiment, tx);
    } else if (caller.actorId !== experiment.ownerId) {
      await this.host.scope.require(caller, 'admin', tx);
    }
  }

  private approvedPlan(experiment: Experiment): string[] {
    const submission = experiment.submissions.find(
      (submission) => submission.id === experiment.attempt.approvedSubmissionId,
    );
    check(
      submission &&
        submission.stage === 'design' &&
        submission.attemptIndex === experiment.attempt.index &&
        experiment.attempt.approvedReviewId === submission.reviewId,
      'approved_plan_required',
      'Execution requires this attempt’s exact approved design submission',
      409,
    );
    const plans = submission.evidence
      .filter((evidence) => evidence.role === 'plan')
      .map((evidence) => evidence.artifactId);
    check(
      plans.length > 0,
      'approved_plan_required',
      'The approved design has no pinned plan',
      409,
    );
    // The admitted feasibility statement travels with the plan, so the running worker and the
    // results reviewer see the budget the design was approved under. It is not required here:
    // submission and the design review are the gates, and this runs only after both.
    const feasibility = submission.evidence
      .filter((evidence) => evidence.role === 'feasibility')
      .map((evidence) => evidence.artifactId);
    return [...new Set([...plans, ...feasibility, ...submission.figureIds])];
  }

  private async review(
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
    const review = await this.host.reviews.get(caller, experiment.reviewId, tx);
    const submission = experiment.submissions.find((entry) => entry.reviewId === review.id);
    check(
      review.subjectId === experiment.id &&
        review.subjectRevision === experiment.workflow.revision &&
        submission?.attemptIndex === experiment.attempt.index &&
        submission.stage === (experiment.workflow.state === 'design_review' ? 'design' : 'results'),
      'stale_review',
      'This review must pin the exact current submission and attempt',
      409,
    );
    await this.reviewCapture(caller, experiment, tx);
    return review;
  }

  /** Resolves only the immutable producing-session reference, even after its handoff. */
  async reviewCapture(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<CodeCapture | null> {
    if (experiment.workspace !== 'git' || experiment.workflow.state !== 'experiment_review')
      return null;
    const submission = experiment.submissions.find(
      (entry) => entry.reviewId === experiment.reviewId,
    );
    check(
      submission?.stage === 'results' &&
        submission.codeCaptureRef?.kind === 'session-final' &&
        submission.codeCaptureRef.sessionId === submission.sessionId,
      'experiment_capture_required',
      'The result submission must pin its producing session capture',
      409,
    );
    check(this.host.code, 'code_unavailable', 'Code capture reader is unavailable', 503);
    const capture = await this.host.code.capture(caller, submission.codeCaptureRef, tx);
    const p = capture.provenance;
    check(
      p.projectId === experiment.projectId &&
        p.instanceId === experiment.id &&
        p.sessionId === submission.sessionId &&
        p.actorId === submission.producerId &&
        p.revision === submission.subjectRevision - 1 &&
        p.workflow.name === 'experiment' &&
        programWorkspace(p.workflow.version) === 'git' &&
        p.workflow.state === 'running' &&
        !p.readOnly,
      'experiment_capture_provenance',
      'The code capture must belong to the exact producing experiment node',
      409,
    );
    check(
      capture.status === 'ready' && capture.workspace,
      'experiment_capture_pending',
      'The producing worker must stop and report its final Git capture before review',
      409,
    );
    return capture;
  }

  private async admit(context: WorkflowCheckContext): Promise<Experiment> {
    const experiment = await this.facts(context);
    check(
      experiment.workspace !== 'git' || this.host.code,
      'code_unavailable',
      'Git assignments require Code',
      503,
    );
    if (producing(context.snapshot.state)) {
      await this.assertProducer(context.caller, experiment, context.tx);
      await this.requireBase(context);
    } else {
      await this.host.scope.require(context.caller, 'review', context.tx);
      const review = await this.review(context.caller, experiment, context.tx);
      if (context.caller.session) {
        const lease = await this.lease(context.caller, experiment, context.tx);
        check(
          lease.review_id === review.id && lease.claim_id === review.claimId,
          'stale_claim',
          'The session no longer owns its pinned claim',
          409,
        );
        await this.host.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
      } else if (review.status === 'requested')
        await this.host.reviews.checkStart(context.caller, review.id, context.tx);
      else await this.host.reviews.checkSubmit(context.caller, review.id, undefined, context.tx);
    }
    return experiment;
  }

  /**
   * Refuses producing work whose base Code cannot derive, with Code's own blocker code. This
   * only reads: it runs under lease admission, the dispatch candidate scan and every
   * assignment check. The refusal makes the experiment no candidate at all, so it is never
   * launched and never held; Code publishes the reason where status and the stuck report look.
   */
  private async requireBase({ caller, snapshot, tx }: WorkflowCheckContext): Promise<void> {
    if (!derivedBase(snapshot.version)) return;
    check(this.host.code, 'code_unavailable', 'Git assignments require Code', 503);
    const base = await this.host.code.baseStatus(caller, snapshot.id, tx);
    if (base.status === 'blocked')
      throw new MervError(base.blockers[0]!.code, base.blockers[0]!.message, 409);
    if (snapshot.state !== 'running') return;
    // The last writer's machine still owes its final capture, or an operator must fence it.
    const writer = await this.host.code.writerStatus(caller, snapshot.id, tx);
    if (writer.blocked) throw new MervError(writer.blocked.code, writer.blocked.message, 409);
  }

  private eligibleRecovery(experiment: Experiment): ExperimentEvidence[] {
    const roles = experiment.workflow.state === 'planned' ? designRoles : ['result', 'report'];
    return experiment.evidence.filter(
      (evidence) =>
        evidence.current &&
        evidence.attemptIndex === experiment.attempt.index &&
        roles.includes(evidence.role),
    );
  }

  /** Only associations selected before this worker's offer can exempt old output authorship. */
  async pinnedRecovery(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<ExperimentEvidence[]> {
    await this.host.scope.require(caller, 'read', tx);
    if (!caller.session) return [];
    return JSON.parse((await this.lease(caller, experiment, tx)).recovery) as ExperimentEvidence[];
  }

  /** Whether this session is the worker holding the experiment's live lease. */
  async holds(caller: Caller, experiment: Experiment, tx: Transaction): Promise<boolean> {
    return (await this.activeLease(experiment, tx))?.id === caller.session?.id;
  }
  async allowedArtifacts(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<string[]> {
    await this.host.scope.require(caller, 'read', tx);
    if (caller.session) {
      const lease = await this.lease(caller, experiment, tx);
      return [
        ...new Set([
          ...(JSON.parse(lease.artifacts) as Artifact[]).map((artifact) => artifact.id),
          ...(await this.host.artifacts.authored(caller, tx)).map((artifact) => artifact.id),
        ]),
      ].sort();
    }
    return this.inputIds(await this.inputs(caller, experiment, tx));
  }

  private async inputs(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<FrozenInputs> {
    const state = experiment.workflow.state;
    const review = reviewing(state) ? await this.review(caller, experiment, tx) : null;
    const feedbackReviews = await this.feedbackReviews(caller, experiment, tx);
    // Authors only: a reviewer already reads the current attempt's rejections in previousReviews
    // and judges this submission, not the verdicts earlier attempts received.
    const history = reviewHistory(
      reviewing(state) ? [] : await this.rejectedRounds(caller, experiment, tx),
      REVIEW_HISTORY_CHARS,
    );
    const selected = reviewing(state)
      ? review!.artifactIds
      : this.eligibleRecovery(experiment).flatMap((evidence) => [
          evidence.artifactId,
          ...evidence.figureIds,
        ]);
    const approvedArtifacts =
      state === 'running' || state === 'experiment_review' ? this.approvedPlan(experiment) : [];
    return {
      experiment: own({
        id: experiment.id,
        name: experiment.name,
        intent: experiment.intent,
        details: experiment.details,
        ownerId: experiment.ownerId,
        project: own(await this.host.scope.project(caller, tx)),
        ...(experiment.workspace === 'git'
          ? { workspace: 'git', codeCapture: await this.reviewCapture(caller, experiment, tx) }
          : {}),
        paper: paperContext((await this.host.paper.read(caller, tx)).documents),
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
        attempt: experiment.attempt,
        workflow: experiment.workflow,
        selectedEvidence: experiment.evidence.filter((evidence) =>
          selected.includes(evidence.artifactId),
        ),
      }),
      approvedArtifacts,
      evidenceArtifacts: [
        ...new Set([...selected, ...feedbackReviews.flatMap((prior) => prior.artifactIds)]),
      ],
      review,
      feedback: own({
        interruptions: experiment.attempt.feedback,
        previousReviews: feedbackReviews,
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
  private async rejectedRounds(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<{ review: ReviewRequest; label: string }[]> {
    const rounds = await mapAsync(
      [...experiment.submissions].sort((a, b) => a.subjectRevision - b.subjectRevision),
      async (submission) => ({
        review: await this.host.reviews.get(caller, submission.reviewId, tx),
        label: `${submission.stage} attempt ${submission.attemptIndex} round ${submission.round}`,
      }),
    );
    return rounds.filter(
      ({ review }) => review.status === 'submitted' && review.verdict !== 'pass',
    );
  }

  private async feedbackReviews(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<ReviewRequest[]> {
    const ids = experiment.attempt.feedbackReviewIds;
    return await mapAsync([...new Set(ids)], async (id) => {
      const review = await this.host.reviews.get(caller, id, tx);
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

  private inputIds(inputs: FrozenInputs): string[] {
    return [...new Set([...inputs.approvedArtifacts, ...inputs.evidenceArtifacts])].sort();
  }

  /**
   * Experiments does not inject Tasks: the commit is read from the task's own workflow data,
   * which only Tasks' transitions write. Done is terminal, so the OID a persistent checkout fixes
   * at its first launch cannot move; Sessions checks its shape again at attachment.
   */
  private async baseCommit({ caller, snapshot, tx }: WorkflowCheckContext): Promise<string> {
    const baseTaskId = snapshot.data.baseTaskId;
    const base =
      typeof baseTaskId === 'string'
        ? await this.host.workflows.get(caller, baseTaskId, tx)
        : undefined;
    const headOid = (base?.data.deliveryCode as { headOid?: unknown } | undefined)?.headOid;
    check(
      base?.workflow === 'task' &&
        base.state === 'done' &&
        typeof headOid === 'string' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid),
      'experiment_base_unavailable',
      'The base task has not been accepted with a delivered commit',
      409,
    );
    return headOid;
  }

  /**
   * A derived base is only ever read here. Until a lease has pinned one there is none to name:
   * an interactive producer has no checkout, and a leased one always finds its pin.
   */
  private async pinnedBase({
    caller,
    snapshot,
    tx,
  }: WorkflowCheckContext): Promise<{ base?: string }> {
    const pin = await this.host.code?.basePin(caller, snapshot.id, tx);
    return pin ? { base: pin.reference } : {};
  }

  private async references(context: WorkflowCheckContext): Promise<WorkflowExecutionReferences> {
    const experiment = await this.admit(context);
    const review = experiment.reviewId
      ? await this.host.reviews.get(context.caller, experiment.reviewId, context.tx)
      : null;
    return {
      ...(referencedBase(context.snapshot.version) && context.snapshot.state === 'running'
        ? derivedBase(context.snapshot.version)
          ? await this.pinnedBase(context)
          : { base: await this.baseCommit(context) }
        : {}),
      ...(experiment.workspace === 'git' && context.snapshot.state === 'experiment_review'
        ? {
            code: (await this.reviewCapture(context.caller, experiment, context.tx))!.workspace!
              .headOid,
          }
        : {}),
      artifacts: await this.allowedArtifacts(context.caller, experiment, context.tx),
      dependencies: (context.dependencies ?? []).map((dependency) => dependency.id).sort(),
      reviews: [
        ...new Set(
          [
            experiment.reviewId,
            experiment.attempt.approvedReviewId,
            ...(await this.feedbackReviews(context.caller, experiment, context.tx)).map(
              (prior) => prior.id,
            ),
            ...(await this.rejectedRounds(context.caller, experiment, context.tx)).map(
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

  private async build(context: WorkflowCheckContext) {
    const experiment = await this.admit(context);
    const state = context.snapshot.state as ActiveState;
    let inputs: FrozenInputs;
    if (context.caller.session) {
      inputs = JSON.parse(
        (await this.lease(context.caller, experiment, context.tx)).inputs,
      ) as FrozenInputs;
      const owned = this.eligibleRecovery(experiment).filter(
        (evidence) => evidence.createdBy === context.caller.actorId,
      );
      const allowed = new Set(await this.allowedArtifacts(context.caller, experiment, context.tx));
      inputs.evidenceArtifacts = [
        ...new Set([
          ...inputs.evidenceArtifacts,
          ...owned.flatMap((evidence) => [evidence.artifactId, ...evidence.figureIds]),
        ]),
      ].filter((id) => allowed.has(id));
    } else inputs = await this.inputs(context.caller, experiment, context.tx);
    const sources: Record<string, ContextInput> = {
      experiment: { text: JSON.stringify(inputs.experiment) },
      feedback: { text: JSON.stringify(inputs.feedback) },
      ...(inputs.approvedArtifacts.length
        ? { approvedPlan: { artifactIds: inputs.approvedArtifacts, mode: 'auto' as const } }
        : {}),
      ...(inputs.evidenceArtifacts.length
        ? {
            evidence: {
              artifactIds: inputs.evidenceArtifacts,
              mode: await this.host.contextBuilder.mode(
                context.caller,
                inputs.evidenceArtifacts,
                96_000,
                context.tx,
              ),
            },
          }
        : {}),
      ...(inputs.review ? { assessment: { text: JSON.stringify(inputs.review) } } : {}),
    };
    const recipe = this.contexts.get(state);
    check(recipe, 'experiment_unavailable', 'This experiment recipe is unavailable', 503);
    const review = reviewing(state)
      ? await this.review(context.caller, experiment, context.tx)
      : null;
    const gitInstruction =
      experiment.workspace === 'git'
        ? state === 'running'
          ? '\nExecute code in the configured private Git checkout. Retain experiment outputs through the declared artifact tools. After submit_results, stop: the Runner will capture the final code before independent review becomes eligible.'
          : state === 'experiment_review'
            ? '\nThe read-only checkout is pinned to the exact final producing-session Git capture in your context. Inspect and verify that code against the approved plan and retained results; do not substitute another branch or a newer head.'
            : '\nThis experiment will execute in a configured private Git workspace; planning and design review use scratch space.'
        : '';
    const needsClaim = review?.status === 'requested';
    const instruction = needsClaim
      ? 'Call review.start to claim this exact review, then refresh workflow.assignment for the new claim. Reading or beginning the assignment does not claim it.'
      : handoff(state);
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
      brief: `${instructions[state]}\n\nExperiment: ${experiment.name}\nAttempt index: ${experiment.attempt.index}\nExpected revision: ${experiment.workflow.revision}\n\n${instruction}${gitInstruction}`,
      references: [
        { kind: 'experiment', id: experiment.id, label: experiment.name },
        ...preview.sources.map((artifact) => ({
          kind: 'artifact',
          id: artifact.id,
          label: artifact.title,
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

  private execution(state: ActiveState, version: number): WorkflowExecutionPolicy {
    const experiment = { experimentId: target('instanceId') };
    const revision = { expectedRevision: target('revision') };
    const workerActions =
      state === 'planned'
        ? ['submit_design', 'abandon', 'mark_failed']
        : ['submit_results', 'retry_running', 'abandon', 'mark_failed'];
    const roles = state === 'planned' ? designRoles : ['result', 'report'];
    const git = programWorkspace(version) === 'git';
    return {
      readOnly: reviewing(state),
      workspace:
        git && state === 'running'
          ? {
              mode: 'persistent',
              namespace: 'experiments',
              base: referencedBase(version) ? 'reference:base' : 'central',
              perBase: false,
              retain: true,
              advancesCentral: false,
              ...(derivedBase(version) ? { driver: CODE_DRIVER } : {}),
            }
          : git && state === 'experiment_review'
            ? {
                mode: 'ephemeral',
                namespace: 'experiment-reviews',
                base: 'reference:code',
                retain: false,
                ...(derivedBase(version) ? { driver: CODE_DRIVER } : {}),
              }
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
              grant('review.start', { reviewId: ref('reviewId') }),
              grant('review.submit', {
                reviewId: ref('reviewId'),
                claimId: ref('claimId'),
                ...revision,
              }),
            ]
          : [
              grant('artifact.create', {}),
              grant(
                'experiment.attach',
                ...roles.map((role) => ({
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
            ]),
      ],
    };
  }

  private leaseHooks(): NonNullable<WorkflowAssignmentRule['lease']> {
    return {
      label: async (context) => (await this.facts(context)).name,
      excludes: async (context, actorId) => {
        const experiment = await this.facts(context);
        return (
          !!experiment.reviewId &&
          reviewing(experiment.workflow.state) &&
          excludedFromReview(
            await this.host.reviews.get(context.caller, experiment.reviewId, context.tx),
            actorId,
          )
        );
      },
      role: async (context): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
        check(!context.caller.session, 'forbidden', 'A leased worker cannot delegate work', 403);
        const experiment = await this.facts(context);
        if (producing(context.snapshot.state)) {
          await this.assertProducer(context.caller, experiment, context.tx);
          await this.requireBase(context);
          return 'producer';
        }
        await this.host.scope.require(context.caller, 'review', context.tx);
        const review = await this.review(context.caller, experiment, context.tx);
        check(
          review.status === 'requested' && !(await this.activeLease(experiment, context.tx)),
          'review_unavailable',
          'This review is already reserved or claimed',
          409,
        );
        // Source identity may be shared with a prior producer session. Independence belongs to the new worker.
        return 'reviewer';
      },
      acquire: async (context) => {
        const sourceContext = { ...context, caller: context.source };
        await this.leaseHooks().role(sourceContext);
        const experiment = await this.facts(context);
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
        if (producing(context.snapshot.state) && derivedBase(context.snapshot.version)) {
          check(this.host.code, 'code_unavailable', 'Git assignments require Code', 503);
          await this.host.code.pinBase(
            context.source,
            { unitId: experiment.id, leaseId: context.leaseId },
            context.tx,
          );
          // Only execution has a checkout, so only its lease is a writer generation.
          if (context.snapshot.state === 'running')
            await this.host.code.reserveWriter(
              context.source,
              { unitId: experiment.id, leaseId: context.leaseId },
              context.tx,
            );
        }
        const review = reviewing(context.snapshot.state)
          ? await this.host.reviews.start(
              context.caller,
              (await this.review(context.caller, experiment, context.tx)).id,
              context.tx,
            )
          : null;
        const inputs = await this.inputs(context.caller, experiment, context.tx);
        const artifacts = await mapAsync(
          this.inputIds(inputs),
          async (id) => await this.host.artifacts.get(context.source, id, context.tx),
        );
        const recovery = reviewing(context.snapshot.state) ? [] : this.eligibleRecovery(experiment);
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
        await context.tx.run(
          'INSERT INTO experiment_leases(id,project_id,experiment_id,revision,attempt_index,state,actor_id,source_actor_id,review_id,claim_id,receipt,artifacts,recovery,inputs) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          context.leaseId,
          context.caller.projectId,
          experiment.id,
          context.snapshot.revision,
          experiment.attempt.index,
          context.snapshot.state,
          context.caller.actorId,
          context.source.actorId,
          review?.id ?? null,
          review?.claimId ?? null,
          JSON.stringify(receipt),
          JSON.stringify(artifacts),
          JSON.stringify(recovery),
          JSON.stringify(inputs),
        );
        return receipt;
      },
      check: async (context, receipt) => {
        const experiment = await this.admit(context);
        const lease = await this.lease(context.caller, experiment, context.tx);
        check(
          digest(receipt) === digest(JSON.parse(lease.receipt)),
          'stale_lease',
          'The exact experiment lease receipt is required',
          409,
        );
      },
      outputs: async (context) => {
        await this.lease(context.caller, await this.admit(context), context.tx);
        return {
          artifacts: (await this.host.artifacts.authored(context.caller, context.tx)).map(
            (artifact) => artifact.id,
          ),
        };
      },
      release: async ({ lease, reason, tx }) => await this.release(lease, reason, tx),
    };
  }

  private async release(lease: WorkflowLease, reason: string, tx: Transaction): Promise<void> {
    this.host.state.assertTransaction(tx);
    await releasedLease(tx, this.host.reviews, 'experiment_leases', lease, reason, {
      experiment_id: lease.instanceId,
      state: lease.state,
    });
  }

  private policy(version: number): WorkflowPolicy {
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
        await this.host.checkAction({ ...context, transition: name });
      },
    });
    return {
      successStates: ['complete'],
      dependencyFailureAction: 'mark_failed',
      limits: [
        {
          name: 'design_rounds',
          from: 'design_review',
          actions: ['revise_design'],
          max: this.host.limits.designRounds,
        },
        {
          name: 'result_rounds',
          from: 'experiment_review',
          actions: ['revise_plan', 'revise_execution'],
          max: this.host.limits.resultRounds,
        },
      ],
      assignments: activeStates.map((state) => ({
        state,
        // A plan is written against its inputs, so planning waits for the tasks the
        // experiment depends on, as running does (founder, 2026-09-18: an experiment
        // depends on tasks, never on another experiment).
        ...(['planned', 'running'].includes(state) ? { requiresDependencies: true } : {}),
        check: async (context) => {
          await this.admit(context);
        },
        build: async (context) => await this.build(context),
        references: async (context) => await this.references(context),
        execution: this.execution(state, version),
        lease: this.leaseHooks(),
      })),
      describe: async (context) => {
        const experiment = await this.facts(context);
        const review = experiment.reviewId
          ? await this.host.reviews.get(context.caller, experiment.reviewId, context.tx)
          : null;
        return {
          label: experiment.name,
          gate:
            context.snapshot.state === 'planned'
              ? 'design_required'
              : context.snapshot.state === 'running'
                ? 'execution_evidence_required'
                : review?.status === 'requested'
                  ? 'review_required'
                  : 'independent_review',
          waiting: producing(context.snapshot.state)
            ? handoff(context.snapshot.state as ActiveState)
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
        ...(['design_review', 'experiment_review'] as const).map((state) => ({
          name: `submit_${state}`,
          states: [state],
          transitions:
            state === 'design_review'
              ? ['approve_design', 'revise_design']
              : ['accept_results', 'revise_plan', 'revise_execution'],
          tool: 'review.submit',
          instruction: handoff(state),
          requiredInput: ['verdict', 'notes', 'synopsis', 'findings'],
          arguments: async (context: WorkflowCheckContext): Promise<Data> => {
            const review = await this.review(context.caller, await this.facts(context), context.tx);
            return {
              reviewId: review.id,
              ...(review.claimId ? { claimId: review.claimId } : {}),
              expectedRevision: context.snapshot.revision,
            };
          },
          check: async (context: WorkflowCheckContext) => {
            const review = await this.review(context.caller, await this.facts(context), context.tx);
            await this.host.reviews.checkSubmit(
              context.caller,
              review.id,
              context.input as unknown as ReviewApplication | undefined,
              context.tx,
            );
            if (context.input) await this.host.checkAction(context);
          },
        })),
        ...(['design_review', 'experiment_review'] as const).map((state) => ({
          name: `start_${state}`,
          states: [state],
          tool: 'review.start',
          instruction: 'Claim the exact current independent review, then refresh its assignment.',
          arguments: async (context: WorkflowCheckContext): Promise<Data> => ({
            reviewId: (await this.review(context.caller, await this.facts(context), context.tx)).id,
          }),
          check: async (context: WorkflowCheckContext) => {
            const review = await this.review(context.caller, await this.facts(context), context.tx);
            check(
              !context.input?.reviewId || context.input.reviewId === review.id,
              'stale_review',
              'The current review is required',
              409,
            );
            await this.host.reviews.checkStart(context.caller, review.id, context.tx);
          },
        })),
      ],
    };
  }
}
