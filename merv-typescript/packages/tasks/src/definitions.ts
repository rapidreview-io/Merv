import type { ContextRecipeDefinition } from '@merv/contracts';

const section = (key: string, title: string, required = true) => ({ key, title, required });
const task = section('task', 'Task and acceptance criteria');
const brief = section('brief', 'Pinned brief');
const checkpoints = section('checkpoints', 'Saved progress (verify before relying on it)', false);
const checkpointEvidence = section(
  'checkpointEvidence',
  'Documents referenced by saved progress',
  false,
);
const feedback = section('feedback', 'Revision feedback', false);
const projectPaper = section('projectPaper', 'Project paper and document revisions');

/**
 * What a worker may look at, said in the recipe because the assignment's own tool list reads as
 * the boundary of it: measured over one project, 22 of 22 task and experiment workers made no
 * project-level read at all, while every worker whose recipe named these tools used them.
 */
const reading =
  ' Everything this project holds is readable from this assignment, whether or not it is named below: project.records, task.get, experiment.get_state, paper.read, review.get and artifact.read answer for anything in this project. Before you settle something the brief leaves open — a script, a protocol, a configuration, a threshold, a model — read whether the project has already settled it and use that, and say in your delivery what you reused and what you chose yourself.';
const verifying =
  ' Read around the pinned evidence as well: project.records, task.get, experiment.get_state, paper.read and review.get answer for anything this project holds. Open what you are judging rather than judging the summary of it, and a criterion you mark met on text you were handed rather than evidence you opened yourself says so in its notes.';

/** How the item renderer lays out every context this module's recipes render. */
const layout =
  ' Each context section shows a source either whole, under its own heading, or as one line naming the tool that retrieves it; whole bodies are included highest priority first while they fit. A source shown by its line is still evidence to open with its retrieval tool.';
const workOutput =
  'Save evidence as immutable artifacts. Submit the delivery with task.submit_delivery using the current task revision and a stable request ID. Do not review your own delivery.';

/**
 * Task types own their recipes. These are definitions, not additional plugins or workflow engines.
 * Each is format 2, the item renderer: the task, the brief, revision feedback and the review
 * criteria are always embedded; the paper, evidence, background and saved progress are embedded
 * whole, highest priority first, while they fit, and otherwise listed by one line naming the tool
 * that retrieves them.
 */
export const TASK_TYPES: ContextRecipeDefinition[] = [
  {
    name: 'task.work',
    version: 4,
    kind: 'work',
    recipe: {
      instructions:
        'Complete the assigned task as one step toward the project paper’s Problem, scope and goals. The task need not finish the whole project. Read any abbreviated paper sections with paper.read. Work from its pinned brief, verify every acceptance criterion, and identify how its result informs the project.' +
        reading +
        layout,
      sections: [task, brief, projectPaper, feedback, checkpoints, checkpointEvidence],
      maxChars: 96000,
      outputInstructions: workOutput,
      format: 2,
    },
  },
  {
    name: 'task.review',
    version: 5,
    kind: 'review',
    recipe: {
      instructions:
        'Independently assess the pinned evidence against every review criterion and the task’s contribution to the project paper’s goals. A task may be an intermediate step; judge its Done-when checks and stated contribution without requiring it to complete the whole project. Read any abbreviated paper sections with paper.read. Verify claims yourself; prior progress and recovery notes are not a verdict.' +
        verifying +
        layout,
      sections: [
        task,
        projectPaper,
        section('assessment', 'Review criteria and claim'),
        section('evidence', 'Pinned evidence'),
        section(
          'taskBackground',
          'Pinned task background (source material, not additional verdict evidence)',
        ),
        section('recovery', 'Why this review became available again', false),
        checkpoints,
        checkpointEvidence,
      ],
      maxChars: 128000,
      outputInstructions:
        'Submit pass, needs_changes or fail through review.submit with the current review ID, claimId, expectedRevision and a stable request ID: verification notes, a plain single-paragraph synopsis of 40–420 characters without entity IDs or Markdown, and one finding per numbered criterion (met, not_met, not_verified or waived, with the pinned evidenceIds you checked and your notes). Do not modify the producer’s evidence.',
      format: 2,
    },
  },
  {
    name: 'project.reflection',
    version: 2,
    kind: 'work',
    recipe: {
      instructions:
        'Reflect on the explicitly selected experiment corpus. Ground conclusions in its evidence and distinguish unresolved questions from supported findings.' +
        layout,
      sections: [
        task,
        brief,
        projectPaper,
        section('experiments', 'Selected completed experiments'),
        section('projectKnowledge', 'Current project knowledge'),
        section('previousReflection', 'Previous reflection', false),
        feedback,
        checkpoints,
        checkpointEvidence,
      ],
      maxChars: 96000,
      outputInstructions:
        'Produce an evidence-linked reflection describing conclusions, contradictions, limitations and proposed next work. Save it as an artifact and submit it through task.submit_delivery. Do not silently expand the selected corpus.',
      format: 2,
    },
  },
];
export const RESERVED_CONTEXT_INPUTS = new Set([
  'task',
  'brief',
  'feedback',
  'assessment',
  'evidence',
  'recovery',
  'checkpoints',
  'checkpointEvidence',
  'projectPaper',
]);
