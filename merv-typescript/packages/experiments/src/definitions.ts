import { PAPER_REVIEWER_INSTRUCTION } from '@merv/paper/rules';
import { type ContextRecipeDefinition } from '@merv/contracts';
import type { FeasibilityStatement } from './evidence.js';
import { activeStates, type ActiveState, reviewing, writesReport } from './program.js';

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
    'Design a credible, feasible experiment that answers the stated question and advances the project. Read the project paper and relevant prior work; learn from earlier results and reviewer feedback. Investigate uncertain assumptions with primary sources, research tools and bounded feasibility probes. Choose the simplest design that yields useful evidence, make its limits clear, and submit it for independent approval before execution.',
  design_review:
    'You are the independent, adversarial reviewer of this experiment’s design. Challenge whether its reasoning and methods can produce credible evidence for the stated question—not merely whether the plan is complete. Read relevant prior project work and check that the plan learns from it. Use research and web tools to investigate questionable assumptions or methodological choices. Focus on consequential flaws. Be rigorous without demanding unnecessary work or imposing your preferred approach. Explain why each blocking concern matters and what would resolve it.',
  running:
    'Execute the exact approved design. Read its pinned plan, feasibility limits and review before starting; recover existing work before rerunning it. Retain the evidence, failed runs and deviations needed to judge the results. Draw conclusions supported by what happened, including negative findings, and submit the results for independent review.',
  experiment_review:
    'You are the independent, adversarial reviewer of this experiment’s results. Judge whether execution followed the approved plan and whether the evidence supports the conclusions—not merely whether the report is convincing. Inspect the underlying evidence and code. Use relevant project work, research, and web tools to investigate questionable claims. A negative result can be a successful experiment. Focus on consequential flaws. Distinguish what you verified from what remains uncertain, and explain what would resolve each blocking concern.',
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
  handoffs[state] += ` ${PAPER_REVIEWER_INSTRUCTION}`;

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

/**
 * How an executor presents what it found, said in the running assignment beside its handoff. It
 * is not part of the handoff, which every registered version embeds exactly; the report's shape
 * (its headings and diagram) stays the template's.
 */
export const reportPresentation =
  'Presenting results in the report: choose the form by the shape of the content. Use a table when two or more items (arms, domains, metrics, runs, settings) are compared on one or more measures; never put a run of numbers in a sentence. Use a sentence for one number and its comparison, a Mermaid flowchart for a process or flow, and a Mermaid xychart-beta chart when a pattern across many values or over time matters more than the exact numbers. Keep prose for reasoning, interpretation and caveats. Every number states what it is compared with and its unit; where its meaning is not obvious, add a few plain words on what it means for the result. Define each abbreviation or unit once, where it first appears. Make the report longer only by adding information, a table or a figure, never by adding wording. Link every record or file you name: artifacts as [name](/artifacts/<artifact id>), files in the experiment code as [name](code-file:<full commit>:<path from the repository root>), and external models, datasets and papers by their URL at the exact revision used. Identifiers such as revisions, seeds and hashes belong where someone needs them to reproduce the work: shorten them in the text and link the full record. Say plainly what was verified and how, as facts, not as a first-person account.';

/**
 * What the workflow can hold, said in each stage's brief beside its pinned handoff. Approved plans
 * asked for readiness and final-freeze approvals no state holds, and agents then bent result
 * submissions into gates and spent the result rounds on them (2026-10-05).
 */
export const workflowGates: Partial<Record<ActiveState, string>> = {
  planned:
    ' The workflow holds two independent reviews: of this design before execution, and of the results after it. It cannot hold any further approval a plan asks for, such as a readiness check before validation or a freeze before test access, so design the run to need none; split a staged evaluation that does need one into separate experiments.',
  design_review:
    ' The workflow holds only this design review and the results review: a plan that requires a further approval during execution, such as a readiness check or a freeze before test access, cannot be carried out as written and needs changes.',
  // Executors handed live runs on with retry_running before their leases ran out (2026-09-30).
  running:
    ' Execution has no route back to design. If the approved design proves unworkable, stop, retain what showed it, and submit results whose report says so; the results reviewer returns the experiment to planning for a new design. Each return uses one of its result rounds, which status_and_next shows under limits. To wait for a long run where session.await_compute is offered, end your visit with it rather than sleeping or polling; retry_running is for an infrastructure interruption only, never for waiting or for a lease that is about to end.',
};

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
 * What feasibilityFormat leaves unsaid, beside it: the statement is strict, and planners added
 * keys of their own or wrote blockers as objects, each found only when attaching the artifact.
 */
export const feasibilityRules =
  'Use exactly these keys, and no others at any level: formatVersion 1; resources, each with kind (data, compute or time), name, unit, required and available (numbers) and basis; dependencies, each with name, present (true or false) and basis; blockers, a list of plain strings, empty when there are none. Put other observations in a basis or in the plan; experiment.attach refuses any other key.';

/**
 * What a worker may look at. The assignment's own tool list reads as the boundary of it: over
 * one project, 22 of 22 task and experiment workers made no project-level read, while every
 * worker whose recipe named these tools used them.
 */
export const reviewerNavigation =
  ' Review only the pinned submission below. Use project.get for project metadata and paper.read for the project’s problem, scope, goals, constraints, Methods and Results. Discover prior work with project.records; inspect experiments with experiment.get_state and tasks with task.get. Use review.get for the pinned criteria, earlier verdicts and review requirements. artifact.get returns metadata; artifact.read opens retained contents. Inspect the provided checkout directly. Tool descriptions explain their arguments; use available research and web tools when useful. These references are starting points, not the boundary of your investigation.';

const plannerNavigation =
  ' Use project.get for project metadata and paper.read for the problem, scope, goals, constraints, Methods and Results. Find prior work with project.records; use experiment.get_state for this experiment’s full brief, dependencies and attempt history, task.get for prerequisite deliveries, and review.get for prior verdicts. Open artifact references with artifact.read; artifact.get returns metadata. Inspect the provided checkout and verify assumptions with available research and web tools. Tool descriptions explain their arguments. Read existing work before revising or repeating it; references are starting points, not an investigation boundary.';

const executorNavigation =
  ' Open the exact approvedPlan references with artifact.read; artifact.get returns metadata. review.get provides the approval and any repair feedback. experiment.get_state provides the full brief, current attempt and recovery history. Use paper.read for project goals and accumulated findings, project.records to discover other work, and task.get for prerequisite deliveries. Inspect and work in the provided checkout. Tool descriptions explain their arguments. References are starting points; the approved scope remains the authority for execution.';

/** Current format-2 recipes, constructed directly without retired intermediate versions.
 * Published versions and recipe bytes are immutable; only their construction is shared. The
 * design and execute recipes are at 12 for the plan and report templates (2026-10-06). */
const recipeVersions: Record<ActiveState, number> = {
  planned: 13,
  design_review: 12,
  running: 14,
  experiment_review: 13,
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
      (reviewing(state)
        ? reviewerNavigation
        : state === 'planned'
          ? plannerNavigation
          : executorNavigation),
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

/**
 * Where a rejected design or results review may send the experiment, by the stage it read: a
 * design has one route, taken when none is named; a results review must choose.
 */
export const REVIEW_RETURNS = {
  design: [{ value: 'planned', label: 'Planning, for a new design', default: true }],
  results: [
    { value: 'planned', label: 'Planning, for a new design and attempt' },
    { value: 'running', label: 'Running, to repair under the approved plan' },
  ],
} as const;

/**
 * What experiment@43's executor is handed instead of the Markdown report template: the report tools,
 * a persistent draft and its final render. A new recipe version carries it, since published recipe
 * and policy bytes never change.
 */
export const reportHandoff = `Retain result artifacts and attach them to this attempt as role result. Write the report with the report tools (subjectKind experiment, subjectId this experiment): report.open returns a draft prefilled from the approved plan, its question, inquiry and constraints locked, and the format guide; Merv renders it to a one-page PDF. The draft persists across rounds: when a review returns the work, act on its findings by editing the draft with report.write, or report.clear to start over from the plan; do not rewrite what still holds. Compute every number from the retained results; result artifacts can feed charts directly. Review each chart with report.review_visual, fix it until it makes its message, then report.approve_visual; check the whole page with report.render, then render it with final: true. Attach the returned sourceArtifactId as role report with the current numeric attemptIndex and expectedRevision; the report you submit must be rendered in this session. Verify inherited results before reusing their exact frozen records. Selecting what mattered is the authorship; do not hide known rework, pivots or failed attempts: record them by id in Execution. Declared JSON results must be finite valid JSON; explicitly qualitative results are distinct. Use experiment.exhibit to inspect the deterministic metrics exhibit. Submit via experiment.transition with transition submit_results, the current revision, and a stable requestId. The reviewer owns the paper update; submit the scientific evidence and report, not paper edits. Use retry_running only for an infrastructure interruption; it preserves the attempt and its approved plan.`;

/** experiment@43's presentation guidance: the report is a fixed one-page layout Merv renders. */
export const reportedPresentation =
  'Presenting results in the report: choose the form by the shape of the content. Compare two or more items (arms, metrics, runs) in a table or a chart, never as a run of numbers in a sentence; use a sentence for one number and its comparison. Every number states what it is compared with and its unit; define each abbreviation once, where it first appears. Keep prose for reasoning, interpretation and caveats, and mark interpretation that was not tested. Make the report longer only by adding information, never by adding wording. Say plainly what was verified and how, as facts, not as a first-person account.';

/** experiment@43's results criteria: the same three, and the rendered report's format last. */
export const reportedResultsCriteria = [
  ...resultsCriteria.slice(0, -1),
  'Format: the report is the rendered one-page report: a one-line answer and a chart of every pre-registered criterion against its bar with uncertainty, execution with every deviation and its cost, data, verification and limitations, within each section’s limits and without padding; each chart makes the point its message states.',
];

const runningRecipe = EXPERIMENT_RECIPES.find((r) => r.name === recipeNames.running)!;
/** experiment.execute@15: reference-only running context for experiment@43+, with the report tools' handoff. */
export const REPORTED_EXECUTE_RECIPE: ContextRecipeDefinition = {
  ...runningRecipe,
  version: 15,
  recipe: { ...runningRecipe.recipe, outputInstructions: reportHandoff },
};

/** The recipe key an experiment's state uses at its version. */
export const recipeKey = (state: ActiveState, version: number) =>
  state === 'running' && writesReport(version) ? 'running:report' : state;
/** The handoff an experiment's state gives at its version. */
export const handoffAt = (state: ActiveState, version: number) =>
  state === 'running' && writesReport(version) ? reportHandoff : handoff(state);
export const presentationAt = (version: number) =>
  writesReport(version) ? reportedPresentation : reportPresentation;
export const resultsCriteriaAt = (version: number) =>
  writesReport(version) ? reportedResultsCriteria : resultsCriteria;
