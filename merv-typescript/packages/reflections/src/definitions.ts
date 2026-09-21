import type { TaskTypeDefinition, WorkflowDefinition } from '@merv/contracts';

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
      'Compare experiments and claims across the corpus. Identify supported patterns, negative results, unresolved tensions and limits of generalization.',
  },
  {
    perspective: 'next_steps',
    instructions:
      'Identify the highest-information next experiments and project-scope changes justified by the current research. Distinguish actionable proposals from established findings. Weigh what the work cost: usage.read reports it for the project or, given a research cycle id, for that cycle, and the limits in workflow.status_and_next show which loops ran out of rounds. Treat token and cost figures as runner-reported and unverified.',
  },
] as const;
export const REFLECTION_WORKFLOW: WorkflowDefinition = {
  name: 'reflection',
  version: 2,
  blocksStarts: ['task', 'experiment'],
  managed: true,
  initial: 'reflecting',
  states: ['reflecting', 'synthesizing', 'in_review', 'approved'],
  terminal: ['approved'],
  edges: [
    { from: 'reflecting', action: 'join', to: 'synthesizing' },
    { from: 'synthesizing', action: 'submit', to: 'in_review' },
    { from: 'in_review', action: 'approve', to: 'approved' },
    { from: 'in_review', action: 'revise_synthesis', to: 'synthesizing' },
    { from: 'in_review', action: 'restart_lenses', to: 'reflecting' },
  ],
};
export const LENS_WORKFLOW: WorkflowDefinition = {
  name: 'reflection.lens',
  version: 2,
  managed: true,
  initial: 'reflecting',
  states: ['reflecting', 'complete'],
  terminal: ['complete'],
  edges: [{ from: 'reflecting', action: 'submit', to: 'complete' }],
};
export const REFLECTION_CRITERIA = [
  'Research coverage is explained, including unfinished work and any new results observed during the wave; factual conclusions and claim changes cite exact evidence and preserve uncertainty.',
  'Five independently authored lens reports are reconciled, including disagreements, negative results and methodological limitations.',
  'The synthesis report and proposed change specification agree and honestly preserve rework, stopped runs and dead ends; proposals are clearly separated from established results.',
  'Proposed follow-up research and consolidation decisions follow from the evidence and respect the current project scope.',
];
/** Asked only when the change specification is a structured plan the next wave will create. */
export const CHANGE_SPEC_CRITERION =
  'Every next-wave work item follows from cited lens evidence, has checkable Done-when checks or a falsifiable question, names only existing claims, and orders cheap feasibility work before the experiments that depend on it; rejected alternatives and carried-over work are recorded honestly, and a stop decision is justified.';
export const RECIPES: TaskTypeDefinition[] = ['lens', 'synthesis', 'review'].map((stage) => ({
  name: `reflection.${stage}`,
  version: 5,
  kind: stage === 'review' ? 'review' : 'work',
  recipe: {
    instructions:
      stage === 'lens'
        ? 'Independently examine the live project research from your assigned perspective. Do not consult other lens outputs. Verify sources before forming conclusions.'
        : stage === 'synthesis'
          ? 'Reconcile all five independent lens reports against the current research. Preserve disagreement and uncertainty. Produce an evidence-linked synthesis report and explicit proposed change specification.'
          : 'Independently verify the synthesis report and change specification against all five lens reports and the current research. Verify the exact proposed paper edits in reflection.get against their original text and evidence as part of this review. When reflection.get returns a plan, the change specification is structured: if the project owner chooses to create the next wave, research.advance creates exactly these tasks and experiments, so verify every item, its checks or question, its claims and its ordering against the evidence. Reading assertions is not verification.',
    sections: [
      { key: 'assignment', title: 'Exact assignment and perspective', required: true },
      { key: 'research', title: 'Live research access', required: true },
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
          ? 'Retain your own report as an immutable text artifact. Retain the change specification either as text, which leaves all follow-on work for the owner to create by hand, or as an application/json artifact (mediaType application/json, at most 64000 bytes) that the owner can turn into the next wave without retyping it: {version: 1, changes: prose scope, claim and consolidation changes (at most 8000 characters), next: {decision: "continue", name: next research cycle name, rationale} or {decision: "stop", reason: goal_met | no_worthwhile_next_step | needs_owner, rationale}, items: at most 12 of {key, kind: "task", title, goal, checks: 1-12 distinct one-line checks, dependsOn, rationale} or {key, kind: "experiment", name, question, details, testedClaimIds, dependsOn, rationale}, carriedOver: at most 20 of {workflowId, reason} naming existing tasks or experiments the next cycle still waits on, rejected: [{title, reason}]}. Every listed field is required and no other is accepted. A key is lowercase letters, digits and hyphens; dependsOn holds keys of other items without cycles; an experiment depends only on tasks, and a plan holds at most 7 experiments; goal, question and details are at most 4000 characters and each rationale or reason at most 1000. A stop decision has no items and no carriedOver; a continue decision has at least one of either. Prepare any cross-experiment Methods/Results edits in an application/json artifact with documents: [{kind: methods or results, expectedRevision: current paper revision, changes: [{id, title, content}]}]. Call reflection.submit with their IDs, optional paperChangesArtifactId, reflectionId, expectedRevision and requestId. Explain in the report if no paper edits are needed. Stop for independent review.'
          : 'Use review.submit with the exact claimId and expectedRevision, verdict, verification notes, synopsis and one finding per criterion. A pass approves this immutable report. For needs_changes or fail choose returnTo synthesizing to retain the lenses, or reflecting to require five fresh lens reports.',
    maxChars: 24000,
  },
}));
