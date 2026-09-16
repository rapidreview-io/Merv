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
      'Identify the highest-information next experiments and project-scope changes justified by the current research. Distinguish actionable proposals from established findings.',
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
export const RECIPES: TaskTypeDefinition[] = ['lens', 'synthesis', 'review'].map((stage) => ({
  name: `reflection.${stage}`,
  version: 4,
  kind: stage === 'review' ? 'review' : 'work',
  recipe: {
    instructions:
      stage === 'lens'
        ? 'Independently examine the live project research from your assigned perspective. Do not consult other lens outputs. Verify sources before forming conclusions.'
        : stage === 'synthesis'
          ? 'Reconcile all five independent lens reports against the current research. Preserve disagreement and uncertainty. Produce an evidence-linked synthesis report and explicit proposed change specification.'
          : 'Independently verify the synthesis report and change specification against all five lens reports and the current research. Verify the exact proposed paper edits in reflection.get against their original text and evidence as part of this review. Reading assertions is not verification.',
    sections: [
      { key: 'assignment', title: 'Exact assignment and perspective', required: true },
      { key: 'research', title: 'Live research access', required: true },
      { key: 'lenses', title: 'Independent lens reports', required: stage !== 'lens' },
      { key: 'submission', title: 'Exact submitted synthesis', required: stage === 'review' },
      { key: 'assessment', title: 'Review criteria and claim', required: stage === 'review' },
      { key: 'feedback', title: 'Prior review feedback and recovery', required: false },
    ],
    outputInstructions:
      stage === 'lens'
        ? 'Write an evidence-linked UTF-8 report with a nonempty Summary section. Save it with artifact.create, then reflection.submit_lens with lensId, artifactId, expectedRevision and requestId.'
        : stage === 'synthesis'
          ? 'Retain your own report and change specification as immutable text artifacts. Prepare any cross-experiment Methods/Results edits in an application/json artifact with documents: [{kind: methods or results, expectedRevision: current paper revision, changes: [{id, title, content}]}]. Call reflection.submit with their IDs, optional paperChangesArtifactId, reflectionId, expectedRevision and requestId. Explain in the report if no paper edits are needed. Stop for independent review.'
          : 'Use review.submit with the exact claimId and expectedRevision, verdict, verification notes, synopsis and one finding per criterion. A pass approves this immutable report. For needs_changes or fail choose returnTo synthesizing to retain the lenses, or reflecting to require five fresh lens reports.',
    maxChars: 24000,
  },
}));
