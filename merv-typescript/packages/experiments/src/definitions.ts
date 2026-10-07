import { type ContextRecipeDefinition } from '@merv/contracts';
import type { FeasibilityStatement } from './evidence.js';
import { activeStates, type ActiveState, reviewing } from './program.js';

// The experiment recipes and review criteria: what each assignment is told, and what each
// review judges.

export const recipeNames: Record<ActiveState, string> = {
  planned: 'experiment.design',
  design_review: 'experiment.design_review',
  running: 'experiment.execute',
  experiment_review: 'experiment.attempt_review',
};

export const instructions: Record<ActiveState, string> = {
  planned:
    'Design an experiment that can test its stated question as one step toward the project paper’s Problem, scope and goals. It need not achieve the whole project goal alone. Read any abbreviated paper sections with paper.read and distinguish established findings from the hypothesis. Preserve source-specified methods when the question calls for reproduction; identify each deliberate departure and limit the conclusion accordingly. Define matched controls, data, metrics, evaluation conditions and decision criteria. Planning waits for the tasks this experiment depends on and is written against their outputs.',
  design_review:
    'Independently test whether the exact pinned design can answer its research question and make the stated contribution toward the project paper’s goals. An experiment may be an intermediate step; do not require it to complete the whole project. Read any abbreviated paper sections with paper.read. Compare source-specified methods with the plan when it claims reproduction, and check that departures are explicit and the promised conclusion is limited accordingly. Examine controls, baselines, leakage, evaluation and feasibility. A structurally complete plan can still be scientifically unsound. Grade only the pinned submission.',
  running:
    'Execute the exact approved plan below. Recover completed work and retained outputs before rerunning after interruption. Preserve errors and failed runs. Compare observations with the planned criteria without treating a negative finding as failed execution. Do not replace the approved plan with a newer upload.',
  experiment_review:
    'Independently assess the exact submitted results against the pinned approved plan. Verify counts, metrics, deviations and conclusions from retained evidence. A passing experiment can refute its hypothesis. Separate a flawed design from execution or reporting that can be repaired under the same plan.',
};

/**
 * The plan and the report as the owner wants them read (2026-10-06): visual, brief and scannable,
 * the report whole without the plan. Their headings are the ones validatePlan and validateReport
 * require; each template is short because it is part of every planner's and executor's context.
 */
const PLAN_TEMPLATE = [
  '## Summary',
  'Question: <one line>',
  '## Objective & hypothesis',
  '<one line>',
  '## Evaluation',
  '```mermaid',
  'flowchart LR',
  '  D[Data] --> A[Arm A] & B[Arm B] --> M[Measure] --> X{Decision}',
  '```',
  '| Arm | What it varies |',
  '|---|---|',
  '',
  '- Primary measure: <one line>',
  '- Success: <threshold, one line>',
  '- Budget: <compute and time, one line>',
  '',
  'Risks:',
  '- <at most 3 bullets>',
].join('\n');

const REPORT_TEMPLATE = [
  '## Summary',
  '<the answer, two sentences>',
  '## Results',
  '| Arm | <primary measure> ± <uncertainty> |',
  '|---|---|',
  '',
  '```mermaid',
  'flowchart LR',
  '  D[Data] --> R[What ran] --> M[What was measured] --> X{Decision}',
  '```',
  'Evidence: [<name>](/artifacts/<artifact id>) for each evidence artifact',
  '## Deviations from plan',
  '<None, or bullets>',
  '## Conclusion',
  '- <what it means, at most 3 bullets>',
  '',
  'Limits:',
  '- <at most 3 bullets>',
].join('\n');

export const handoffs: Record<ActiveState, string> = {
  planned: `Create your own UTF-8 Markdown plan artifact, about one screen, in this shape (headings exact; no walls of prose; long technical detail goes in a separate appendix artifact the plan links):\n\n${PLAN_TEMPLATE}\n\nVerify inherited planning work before retaining your own plan; its bytes may be unchanged after verification, but a predecessor’s plan cannot be submitted as your new output. Attach it as role plan with the current numeric attemptIndex and expectedRevision. Then call experiment.transition with transition submit_design and a stable requestId. Stop while independent design review is pending.`,
  design_review:
    'You own the paper update: keep it brief, usually one or two sentences stating the hypothesis, proposed method and this experiment’s purpose as planned work, never as completed results. Submit through review.submit with the current reviewId, claimId and expectedRevision. Supply verification notes, a plain synopsis and one finding per criterion. Pass rejects returnTo. Either needs_changes or fail returns to planned; returnTo may be omitted or planned. A design rejection creates a new attempt. Stop after the verdict.',
  running: `Retain result and report artifacts and attach them to this attempt. The report is a UTF-8 Markdown document of one to two screens that stands alone, read without the plan, in this shape (headings exact), and it names the pinned metrics exhibit by its filename:\n\n${REPORT_TEMPLATE}\n\nVerify inherited results and figures before reusing their exact frozen records. You must author and attach your own report affirming what you checked; a predecessor’s report cannot be your new submitted output. Selecting what mattered for the report is the authorship; do not hide known rework, pivots or failed attempts, and record them under Deviations from plan. Declared JSON results must be finite valid JSON; explicitly qualitative results are distinct. Use experiment.exhibit to inspect the deterministic metrics exhibit and interpret any pinned exhibit in the report. Submit via experiment.transition with transition submit_results, the current revision, and a stable requestId. The reviewer owns the paper update; submit the scientific evidence and report, not paper edits. Use retry_running only for an infrastructure interruption; it preserves the attempt and its approved plan.`,
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

export const handoff = (state: ActiveState) =>
  gatedHandoffs[state] ? `${handoffs[state]} ${gatedHandoffs[state]}` : handoffs[state];

/** Said to every planner, executor and reviewer of an experiment, in the assignment. */
export const sourceVerification =
  'Verify pivotal source-stated formulas and procedures against the primary paper and nearby prose or derivation before implementation or verdict. Text extraction can lose superscripts and symbols: inspect the rendered page when available, otherwise cross-check adjacent source statements. Cite the section and distinguish printed from PDF page numbering. Treat unresolved notation as uncertainty, not a paper inconsistency; reviewers must independently verify pivotal claims before passing.';

/** The shape a planner fills in, shown beside the design it is asked for. */
export const feasibilityFormat: FeasibilityStatement = {
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
 * Published versions and recipe bytes are immutable; only their construction is shared. The
 * design and execute recipes are at 12 for the plan and report templates (2026-10-06). */
const recipeVersions: Record<ActiveState, number> = {
  planned: 12,
  design_review: 11,
  running: 12,
  experiment_review: 12,
};

/** Every recipe's budget, which the paper's items are chosen within too. */
export const CONTEXT_CHARS = 160_000;

export const EXPERIMENT_RECIPES: ContextRecipeDefinition[] = activeStates.map((state) => ({
  name: recipeNames[state],
  version: recipeVersions[state],
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
 * Feasibility is its own design criterion, number 4, so the review can be asked never to waive it;
 * the statement's arithmetic is its author's, which is why the reviewer is told to look for what it
 * leaves out as well as for what it gets wrong. Each stage's last criterion is the document's
 * format (owner, 2026-10-06), appended so a review requested before it keeps its numbering.
 */
export const designCriteria = [
  'The plan defines a testable hypothesis and an evaluation that can distinguish it from alternatives.',
  'Controls, baselines, data, metrics and decision criteria make the proposed comparison defensible.',
  'The limitations and possible failure modes of the proposed execution are addressed.',
  'The feasibility statement is accurate and complete: each required and available quantity, the compute and time estimate, and the presence of every dependency were verified by the reviewer against retained records; no requirement, dependency or blocker the design implies is omitted; and no known blocker remains.',
  'Format: the plan is about one screen, without padding, and has a one-line question, a mermaid flowchart (data → arms → measurement → decision), a table of arms and what each varies, the primary measure and success threshold, a budget line and at most 3 risks.',
];

export const feasibilityCriterion = 4;

export const resultsCriteria = [
  'The retained execution and results follow the exact approved plan, with deviations and failures explained.',
  'The submitted measurements agree with the retained results and any metrics exhibit, and the report selects what mattered without hiding known rework.',
  'The report’s conclusions follow from the evidence, including negative findings and limitations.',
  'Format: the report stands alone without the plan, is one to two screens without padding, and has the answer first in two sentences, a table of every arm’s primary measure with uncertainty, a mermaid diagram of what happened or the decision, at most 3 bullets each of meaning and limits, and links to the evidence.',
];
