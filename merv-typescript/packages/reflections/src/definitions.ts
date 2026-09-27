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
      'Compare experiments and findings across the corpus. Identify supported patterns, negative results, unresolved tensions and limits of generalization.',
  },
  {
    perspective: 'next_steps',
    instructions:
      'Identify the highest-information next experiments and project-scope changes justified by the current research. Distinguish actionable proposals from established findings. Weigh what the work cost: usage.read reports it for the project or, given a research cycle id, for that cycle, and the limits in workflow.status_and_next show which loops ran out of rounds. Treat token and cost figures as runner-reported and unverified.',
  },
] as const;
export const REFLECTION_WORKFLOW: WorkflowDefinition = {
  name: 'reflection',
  version: 3,
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
/** A published definition never changes, so a version that can be ended is a new version. */
const endable = (definition: WorkflowDefinition, live: string[]): WorkflowDefinition => ({
  ...definition,
  version: definition.version + 1,
  states: [...definition.states, 'abandoned'],
  terminal: [...definition.terminal, 'abandoned'],
  edges: [
    ...definition.edges,
    ...live.map((from) => ({ from, action: 'abandon', to: 'abandoned' })),
  ],
});
/**
 * Version 4 is version 3 with an ending: a wave that cannot finish, for want of five lens
 * authors say, is abandoned by its owner or an operator, which lifts the pause on new work.
 * Its lenses are version 3, which the wave's ending ends with it.
 */
export const REFLECTION_WORKFLOW_ENDABLE = endable(REFLECTION_WORKFLOW, [
  'reflecting',
  'synthesizing',
  'in_review',
]);
export const LENS_WORKFLOW_ENDABLE = endable(LENS_WORKFLOW, ['reflecting']);
export const REFLECTION_CRITERIA = [
  'Research coverage is explained, including unfinished work and any new results observed during the wave; factual conclusions and claim changes cite exact evidence and preserve uncertainty.',
  'Five independently authored lens reports are reconciled, including disagreements, negative results and methodological limitations.',
  'The synthesis report and proposed change specification agree and honestly preserve rework, stopped runs and dead ends; proposals are clearly separated from established results.',
  'Proposed follow-up research and consolidation decisions follow from the evidence and respect the current project scope.',
];
/** Asked only when the change specification is a structured plan the next wave will create. */
export const CHANGE_SPEC_CRITERION =
  'Every next-wave work item follows from cited lens evidence, has checkable Done-when checks or a falsifiable question, and orders cheap feasibility work before the experiments that depend on it; rejected alternatives and carried-over work are recorded honestly, and a stop decision is justified.';
/**
 * Version 7 of the three stage recipes. Only the lens recipe is still registered; synthesis@7 and
 * review@7 served the retired reflection@2 and remain only as the text version 8 is derived from,
 * whose hash is pinned.
 */
const RECIPES: TaskTypeDefinition[] = ['lens', 'synthesis', 'review'].map((stage) => ({
  name: `reflection.${stage}`,
  version: 7,
  kind: stage === 'review' ? 'review' : 'work',
  recipe: {
    instructions:
      stage === 'lens'
        ? 'Independently examine the live project research from your assigned perspective. Do not consult other lens outputs. Verify sources before forming conclusions.'
        : stage === 'synthesis'
          ? 'Reconcile all five independent lens reports against the current research. Preserve disagreement and uncertainty. Produce an evidence-linked synthesis report and explicit proposed change specification.'
          : 'Independently verify the synthesis report and change specification against all five lens reports and the current research. You own the project paper update: reconcile cross-experiment Methods and Results against the evidence, retaining disagreements and limits. Add comprehensive detail when it helps explain the project’s trajectory, how understanding has changed and what comes next; there is no brevity requirement for reflection-review paper updates. When reflection.get returns a plan, the change specification is structured: if the project owner chooses to create the next wave, research.advance creates exactly these tasks and experiments, so verify every item, its checks or question and its ordering against the evidence. Reading assertions is not verification.',
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
          ? 'Retain your own report as an immutable text artifact. Retain the change specification either as text, which leaves all follow-on work for the owner to create by hand, or as an application/json artifact (mediaType application/json, at most 64000 bytes) that the owner can turn into the next wave without retyping it: {version: 1, changes: prose scope and consolidation changes (at most 8000 characters), next: {decision: "continue", name: next research cycle name, rationale} or {decision: "stop", reason: goal_met | no_worthwhile_next_step | needs_owner, rationale}, items: at most 12 of {key, kind: "task", title, goal, checks: 1-12 distinct one-line checks, dependsOn, rationale} or {key, kind: "experiment", name, question, details, dependsOn, rationale}, carriedOver: at most 20 of {workflowId, reason} naming existing tasks or experiments the next cycle still waits on, rejected: [{title, reason}]}. Every listed field is required and no other is accepted. A key is lowercase letters, digits and hyphens; dependsOn holds keys of other items without cycles; an experiment depends only on tasks, and a plan holds at most 7 experiments; goal, question and details are at most 4000 characters and each rationale or reason at most 1000. A stop decision has no items and no carriedOver; a continue decision has at least one of either. Call reflection.submit with the report and change specification IDs, reflectionId, expectedRevision and requestId. The reviewer owns the paper update. Stop for independent review.'
          : 'Use review.submit with the exact claimId and expectedRevision, verdict, verification notes, synopsis and one finding per criterion. A pass approves this immutable report. For needs_changes or fail choose returnTo synthesizing to retain the lenses, or reflecting to require five fresh lens reports.' +
            ' You are responsible for updating the project paper’s Methods and Results in perspective of the whole project. Read paper.read immediately before preparing edits. Submit your own paperChanges: {documents: [{kind: "methods" or "results", expectedRevision: current revision, changes: [{id, title, content}]}]} with review.submit. Revise existing sections rather than appending a review log; cite experiments with Markdown links [Experiment name](/experiments/EXPERIMENT_ID), using each experiment’s actual name as the visible label, and cite exact evidence. Keep stable IDs only in link destinations. Paper edits save with any verdict, so describe rejected or inconclusive work honestly without presenting it as accepted findings. If no edits are warranted, explain why in notes.',
    maxChars: 24000,
  },
}));

export const LENS_RECIPE = RECIPES.find((recipe) => recipe.name === 'reflection.lens')!;
/** Synthesis and review for reflection@3 and @4, whose plans declare a workspace per item. */
export const WORKSPACE_RECIPES: TaskTypeDefinition[] = RECIPES.filter(
  (recipe) => recipe.name !== 'reflection.lens',
).map((recipe) => ({
  ...recipe,
  version: 8,
  recipe: {
    ...recipe.recipe,
    instructions: `${recipe.recipe.instructions} Every version-2 plan item declares workspace: {provider: "none"} or {provider: "code", version: 1}. Choose code when the item's deliverable is code in the project's repository; choose none for analysis, reports or other work that needs no repository checkout. Verify that each declaration matches its deliverable. Dependencies determine the base: never supply baseTaskId, a commit or a branch.`,
    outputInstructions:
      recipe.name === 'reflection.synthesis'
        ? recipe.recipe.outputInstructions
            .replace('{version: 1,', '{version: 2,')
            .replaceAll('dependsOn, rationale}', 'dependsOn, rationale, workspace}')
        : recipe.recipe.outputInstructions,
  },
}));

/** Current assignments carry the project paper; published earlier recipes remain registered. */
export const PROJECT_PAPER_RECIPES: TaskTypeDefinition[] = [LENS_RECIPE, ...WORKSPACE_RECIPES].map(
  (definition) => ({
    ...definition,
    version: 9,
    recipe: {
      ...definition.recipe,
      instructions: `${definition.recipe.instructions} Use the project paper’s Problem, scope, goals and current findings to place this reflection in the project’s trajectory. Read any abbreviated paper sections with paper.read. Verify newer evidence before changing established conclusions.`,
      sections: [
        ...definition.recipe.sections.slice(0, 1),
        { key: 'projectPaper', title: 'Project paper and document revisions', required: true },
        ...definition.recipe.sections.slice(1),
      ],
      maxChars: 32000,
    },
  }),
);

/** Keep published recipe hashes intact while teaching new plans the prerequisite boundary. */
export const DEPENDENCY_SAFE_RECIPES: TaskTypeDefinition[] = PROJECT_PAPER_RECIPES.map(
  (definition) =>
    definition.name === 'reflection.lens'
      ? definition
      : {
          ...definition,
          version: 10,
          recipe: {
            ...definition.recipe,
            instructions: `${definition.recipe.instructions} In a next-wave plan, each task's Done-when checks must be achievable and independently reviewable before any work that depends on it starts. A dependent experiment's design submission and review belong to that experiment's own gate; do not require them for acceptance of its prerequisite task. Check this ordering in the change specification before submitting or approving it.`,
          },
        },
);

/** Ranked source items replace all-or-nothing sections without changing published recipes. */
export const HIERARCHICAL_RECIPES: TaskTypeDefinition[] = DEPENDENCY_SAFE_RECIPES.map(
  (definition) => ({
    ...definition,
    version: definition.version + 1,
    recipe: {
      ...definition.recipe,
      instructions: `${definition.recipe.instructions} The context first lists every source with its retrieval tool and then includes whole source bodies in priority order. An item absent from Selected full content is still evidence to open with its retrieval tool. Read the live inventory with project.records; task.list repeats its task records. If Research is available, research.list identifies this wave's cycle by reflectionId and its researchDependencies name the selected work; research.lineage shows predecessor cycle digests. Verify those tasks and experiments through task.get, experiment.get_state, review.get and artifact.read before saying work was not done. Paper content can lag accepted current-cycle results; reconcile record and evidence times with paper.read before concluding. Refresh live records when needed.`,
      sections: definition.recipe.sections.map((section) =>
        section.key === 'research' ? { ...section, required: false } : section,
      ),
    },
  }),
);
