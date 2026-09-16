// Versioned definitions retained for existing snapshot-based waves and assignment receipts.
import type { TaskTypeDefinition, WorkflowDefinition } from '@merv/contracts';

export const LENSES = [
  {
    perspective: 'evidence',
    instructions:
      'Audit the empirical evidence, controls, uncertainty and reproducibility. Separate results from interpretations and trace every conclusion to the frozen corpus.',
  },
  {
    perspective: 'theory',
    instructions:
      'Examine the explanatory model, assumptions and causal claims. Identify contradictions and rival explanations that fit the frozen evidence.',
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
      'Identify the highest-information next experiments and project-scope changes justified by the frozen corpus. Distinguish actionable proposals from established findings.',
  },
] as const;
export const REFLECTION_WORKFLOW: WorkflowDefinition = {
  name: 'reflection',
  version: 1,
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
  version: 1,
  managed: true,
  initial: 'reflecting',
  states: ['reflecting', 'complete'],
  terminal: ['complete'],
  edges: [{ from: 'reflecting', action: 'submit', to: 'complete' }],
};
export const REFLECTION_CRITERIA = [
  'Every frozen source is accounted for; factual conclusions and claim changes cite exact evidence and preserve uncertainty.',
  'Five independently authored lens reports are reconciled, including disagreements, negative results and methodological limitations.',
  'The project graph, synthesis report and proposed change specification agree; proposals are clearly separated from established results.',
  'Proposed follow-up research and consolidation decisions follow from the evidence and respect the pinned project scope.',
];
export const RECIPES: TaskTypeDefinition[] = ['lens', 'synthesis', 'review'].map((stage) => ({
  name: `reflection.${stage}`,
  version: 2,
  kind: stage === 'review' ? 'review' : 'work',
  recipe: {
    instructions:
      stage === 'lens'
        ? 'Independently examine the frozen project corpus from your assigned perspective. Do not consult other lens outputs. Verify sources before forming conclusions.'
        : stage === 'synthesis'
          ? 'Reconcile all five independent lens reports against the frozen corpus. Preserve disagreement and uncertainty. Produce an evidence-linked synthesis report, project graph and explicit proposed change specification.'
          : 'Independently verify the synthesis, project graph and change specification against all five lens reports and the frozen corpus. Verify the exact proposed paper edits against their original text and evidence as part of this review. Reading assertions is not verification.',
    sections: [
      { key: 'assignment', title: 'Exact assignment and perspective', required: true },
      { key: 'corpus', title: 'Frozen project corpus and source provenance', required: true },
      { key: 'sources', title: 'Retained source references', required: false },
      { key: 'lenses', title: 'Independent lens reports', required: stage !== 'lens' },
      { key: 'submission', title: 'Exact submitted synthesis', required: stage === 'review' },
      { key: 'assessment', title: 'Review criteria and claim', required: stage === 'review' },
      { key: 'feedback', title: 'Prior review feedback and recovery', required: false },
    ],
    outputInstructions:
      stage === 'lens'
        ? 'Write an evidence-linked UTF-8 report with a nonempty Summary section. Save it with artifact.create, then reflection.submit_lens with lensId, artifactId, expectedRevision and requestId.'
        : stage === 'synthesis'
          ? 'Retain your own report, graph and change specification as immutable text artifacts. Prepare any cross-experiment Methods/Results edits in an application/json artifact with documents: [{kind: methods or results, expectedRevision: current paper revision, changes: [{id, title, content}]}]. Call reflection.submit with their IDs, optional paperChangesArtifactId, reflectionId, expectedRevision and requestId. Explain in the report if no paper edits are needed. Stop for independent review.'
          : 'Use review.submit with the exact claimId and expectedRevision, verdict, verification notes, synopsis and one finding per criterion. A pass approves this immutable report. For needs_changes or fail choose returnTo synthesizing to retain the lenses, or reflecting to require five fresh lens reports.',
    maxChars: 180000,
  },
}));
