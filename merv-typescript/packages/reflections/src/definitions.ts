import { PAPER_REVIEWER_INSTRUCTION } from '@merv/paper/rules';
import type { ContextRecipeDefinition, WorkflowDefinition } from '@merv/contracts';

export const LENSES = [
  {
    perspective: 'evidence',
    instructions:
      'Audit the empirical evidence, controls, uncertainty and reproducibility. Separate results from interpretations and trace every conclusion to the current research.',
  },
  {
    perspective: 'theory',
    instructions:
      'Examine the explanatory model, assumptions and causal claims. Identify contradictions and rival explanations that fit the current evidence.',
  },
  {
    perspective: 'methods',
    instructions:
      'Audit experimental design, implementation, evaluation, confounding and measurement. Identify which conclusions survive methodological weaknesses.',
  },
  {
    perspective: 'synthesis',
    instructions:
      'Compare experiments and findings across the corpus. Identify supported patterns, negative results, unresolved tensions and limits of generalization.',
  },
  {
    perspective: 'next_steps',
    instructions:
      'Identify the highest-information next experiments and project-scope changes justified by the current research. Distinguish actionable proposals from established findings. Weigh what the work cost: usage.read reports it for the project or, given a research cycle id, for that cycle, and the limits in workflow.status_and_next show which loops ran out of rounds. Treat token and cost figures as runner-reported and unverified.',
  },
] as const;
/**
 * A wave that cannot finish, for want of five lens authors say, is abandoned by its owner or an
 * operator, which lifts the pause on new work; its lenses end with it. Edge order is part of
 * each fingerprint; never reorder it. Version 3 of the wave and 2 of the lens, which could not
 * be ended, are retired.
 */
export const REFLECTION_WORKFLOW: WorkflowDefinition = {
  name: 'reflection',
  version: 4,
  blocksStarts: ['task', 'experiment'],
  initial: 'reflecting',
  states: ['reflecting', 'synthesizing', 'in_review', 'approved', 'abandoned'],
  terminal: ['approved', 'abandoned'],
  edges: [
    { from: 'reflecting', action: 'join', to: 'synthesizing' },
    { from: 'synthesizing', action: 'submit', to: 'in_review' },
    { from: 'in_review', action: 'approve', to: 'approved' },
    { from: 'in_review', action: 'revise_synthesis', to: 'synthesizing' },
    { from: 'in_review', action: 'restart_lenses', to: 'reflecting' },
    ...['reflecting', 'synthesizing', 'in_review'].map((from) => ({
      from,
      action: 'abandon',
      to: 'abandoned',
    })),
  ],
};
export const LENS_WORKFLOW: WorkflowDefinition = {
  name: 'reflection.lens',
  version: 3,
  initial: 'reflecting',
  states: ['reflecting', 'complete', 'abandoned'],
  terminal: ['complete', 'abandoned'],
  edges: [
    { from: 'reflecting', action: 'submit', to: 'complete' },
    { from: 'reflecting', action: 'abandon', to: 'abandoned' },
  ],
};
export const REFLECTION_CRITERIA = [
  'Research coverage is explained, including unfinished work and any new results observed during the wave; factual conclusions and claim changes cite exact evidence and preserve uncertainty.',
  'Five independently authored lens reports are reconciled, including disagreements, negative results and methodological limitations.',
  'The synthesis report and proposed change specification agree and honestly preserve rework, stopped runs and dead ends; proposals are clearly separated from established results.',
  'Proposed follow-up research and consolidation decisions follow from the evidence and respect the current project scope.',
];
/** Asked only when the change specification is a structured plan the next wave will create. */
export const CHANGE_SPEC_CRITERION =
  'Every next-wave work item follows from cited lens evidence, has checkable Done-when checks or a falsifiable question, and orders cheap feasibility work before the experiments that depend on it; rejected alternatives and carried-over work are recorded honestly, and a stop decision is justified.';
/** How a worker reaches the live records behind its context, whichever way the context lists them. */
const liveRecords =
  "Read the live inventory with project.records; task.list repeats its task records. If Research is available, research.list identifies this wave's cycle by reflectionId and its researchDependencies name the selected work; research.lineage shows predecessor cycle digests. Verify those tasks and experiments through task.get, experiment.get_state, review.get and artifact.read before saying work was not done. Paper content can lag accepted current-cycle results; reconcile record and evidence times with paper.read before concluding. Refresh live records when needed.";
/** Current format-2 recipes. Retired recipe construction is not a runtime dependency;
 * preserve the published version, instructions and section ordering directly. */
export const ITEM_RECIPES: ContextRecipeDefinition[] = ['lens', 'synthesis', 'review'].map(
  (stage) => ({
    name: `reflection.${stage}`,
    version: 13,
    kind: stage === 'review' ? 'review' : 'work',
    recipe: {
      instructions:
        (stage === 'lens'
          ? 'Independently examine the live project research from your assigned perspective. The other lenses’ reports are withheld from you until synthesis, so this view is yours alone. Verify sources before forming conclusions.'
          : stage === 'synthesis'
            ? 'Reconcile all five independent lens reports against the current research. Preserve disagreement and uncertainty. Produce an evidence-linked synthesis report and explicit proposed change specification.'
            : 'Independently verify the synthesis report and change specification against all five lens reports and the current research. You own the project paper update: reconcile cross-experiment Methods and Results against the evidence, retaining disagreements and limits. Add comprehensive detail when it helps explain the project’s trajectory, how understanding has changed and what comes next; there is no brevity requirement for reflection-review paper updates. When reflection.get returns a plan, the change specification is structured: if the project owner chooses to create the next wave, research.advance creates exactly these tasks and experiments, so verify every item, its checks or question and its ordering against the evidence. Reading assertions is not verification.') +
        (stage === 'lens'
          ? ''
          : ' Every new task and experiment has managed Git storage, independently of GitHub. Submit a version-3 plan without workspace fields. Dependencies determine the base: never supply baseTaskId, a commit or a branch.') +
        ' Use the project paper’s Problem, scope, goals and current findings to place this reflection in the project’s trajectory. Read any abbreviated paper sections with paper.read. Verify newer evidence before changing established conclusions.' +
        (stage === 'lens'
          ? ''
          : " In a next-wave plan, each task's Done-when checks must be achievable and independently reviewable before any work that depends on it starts. A dependent experiment's design submission and review belong to that experiment's own gate; do not require them for acceptance of its prerequisite task. Check this ordering in the change specification before submitting or approving it.") +
        ` Each context section shows a source either whole, under its own heading, or as one line naming the tool that retrieves it; whole bodies are included highest priority first while they fit. A source shown by its line is still evidence to open with its retrieval tool, and a section with sources left unlisted for lack of room says how many and which tools reach them. ${liveRecords}`,
      sections: [
        { key: 'assignment', title: 'Exact assignment and perspective', required: true },
        { key: 'projectPaper', title: 'Project paper and document revisions', required: true },
        { key: 'research', title: 'Live research access', required: false },
        { key: 'lenses', title: 'Independent lens reports', required: stage !== 'lens' },
        { key: 'submission', title: 'Exact submitted synthesis', required: stage === 'review' },
        { key: 'assessment', title: 'Review criteria and claim', required: stage === 'review' },
        { key: 'feedback', title: 'Prior review feedback and recovery', required: false },
        // After feedback, so the latest review wins the budget; a reviewer is shown no earlier
        // verdicts, so the review recipe has no such section.
        ...(stage === 'review'
          ? []
          : [{ key: 'history', title: 'Earlier review rounds, oldest first', required: false }]),
        // Last, so rework feedback wins the budget. A digest that does not fit is reported omitted
        // and stays readable with artifact.read.
        {
          key: 'previousCycle',
          title: 'Predecessor cycle digest (decisions already made; verify before relying on it)',
          required: false,
        },
      ],
      outputInstructions:
        stage === 'lens'
          ? 'Write an evidence-linked UTF-8 report with a nonempty Summary section. Save it with artifact.create, then reflection.submit_lens with lensId, artifactId, expectedRevision and requestId.'
          : stage === 'synthesis'
            ? 'Retain your own report as an immutable text artifact. Retain the change specification either as text, which leaves all follow-on work for the owner to create by hand, or as an application/json artifact (mediaType application/json, at most 64000 bytes) that the owner can turn into the next wave without retyping it: {version: 3, changes: prose scope and consolidation changes (at most 8000 characters), next: {decision: "continue", name: next research cycle name, rationale} or {decision: "stop", reason: goal_met | no_worthwhile_next_step | needs_owner, rationale}, items: at most 12 of {key, kind: "task", title, goal, checks: 1-12 distinct one-line checks, dependsOn, rationale} or {key, kind: "experiment", name, question, details, dependsOn, rationale}, carriedOver: at most 20 of {workflowId, reason} naming existing tasks or experiments the next cycle still waits on, rejected: [{title, reason}]}. Every listed field is required and no other is accepted. A key is lowercase letters, digits and hyphens; dependsOn holds keys of other items without cycles; an experiment depends only on tasks, and a plan holds at most 7 experiments; goal, question and details are at most 4000 characters and each rationale or reason at most 1000. A stop decision has no items and no carriedOver; a continue decision has at least one of either. Call reflection.submit with the report and change specification IDs, reflectionId, expectedRevision and requestId. The reviewer owns the paper update. Stop for independent review.'
            : 'Use review.submit with the exact claimId and expectedRevision, verdict, verification notes, synopsis and one finding per criterion. A pass approves this immutable report. For needs_changes or fail choose returnTo synthesizing to retain the lenses, or reflecting to require five fresh lens reports.' +
              ` ${PAPER_REVIEWER_INSTRUCTION}`,
      maxChars: 32000,
      format: 2,
    },
  }),
);

/**
 * Where a rejected synthesis may send its wave: back to synthesis (the default, keeping the
 * lenses), or to the lenses for five new reports.
 */
export const REVIEW_RETURNS = [
  { value: 'synthesizing', label: 'Synthesis, for a revised report' },
  { value: 'reflecting', label: 'Lenses, for five new reports' },
] as const;
