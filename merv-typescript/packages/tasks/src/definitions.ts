import type { TaskTypeDefinition } from '@merv/contracts';

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

const planInstructions =
  'Design an experiment that can test the stated research claim. Use the supplied research and constraints; distinguish established findings from hypotheses.';
const planSections = [
  task,
  brief,
  section('research', 'Relevant research and prior findings'),
  section('constraints', 'Project and execution constraints'),
  feedback,
  checkpoints,
  checkpointEvidence,
];

/**
 * What a worker may look at, said in the recipe because the assignment's own tool list reads as
 * the boundary of it: measured over one project, 22 of 22 task and experiment workers made no
 * project-level read at all, while every worker whose recipe named these tools used them.
 */
const reading =
  ' Everything this project holds is readable from this assignment, whether or not it is named below: project.records, task.get, experiment.get_state, paper.read, review.get and artifact.read answer for anything in this project. Before you settle something the brief leaves open — a script, a protocol, a configuration, a threshold, a model — read whether the project has already settled it and use that, and say in your delivery what you reused and what you chose yourself.';
const verifying =
  ' Read around the pinned evidence as well: project.records, task.get, experiment.get_state, paper.read and review.get answer for anything this project holds. Open what you are judging rather than judging the summary of it, and a criterion you mark met on text you were handed rather than evidence you opened yourself says so in its notes.';

/** Task types own their recipes. These are definitions, not additional plugins or workflow engines. */
export const TASK_TYPES: TaskTypeDefinition[] = [
  {
    name: 'task.work',
    version: 1,
    kind: 'work',
    recipe: {
      instructions:
        'Complete the assigned task. Work from its pinned brief and verify every acceptance criterion.',
      sections: [task, brief, feedback, checkpoints, checkpointEvidence],
      maxChars: 48000,
      outputInstructions:
        'Save evidence as immutable artifacts. Submit the delivery with task.submit_delivery using the current task revision and a stable request ID. Do not review your own delivery.',
    },
  },
  {
    name: 'task.work',
    version: 2,
    kind: 'work',
    recipe: {
      instructions:
        'Complete the assigned task. Work from its pinned brief and verify every acceptance criterion.' +
        reading,
      sections: [task, brief, feedback, checkpoints, checkpointEvidence],
      maxChars: 48000,
      outputInstructions:
        'Save evidence as immutable artifacts. Submit the delivery with task.submit_delivery using the current task revision and a stable request ID. Do not review your own delivery.',
    },
  },
  {
    name: 'experiment.plan',
    version: 2,
    kind: 'work',
    recipe: {
      instructions: planInstructions,
      sections: planSections,
      maxChars: 64000,
      outputInstructions:
        'Produce a plan covering the hypothesis, controls, baselines, data, metrics, procedure, resource budget and decision criteria. State its feasibility in the plan: what it requires against what exists — data, compute and time, each with the record the figure was measured from — every dependency and whether it is present, and any known blocker. Measure, do not assume; the feasibility check of this task is required and its review cannot waive it. Save the plan as an artifact and submit it through task.submit_delivery for independent review. This assignment is planning; it does not authorize experiment execution.',
    },
  },
  {
    name: 'project.reflection',
    version: 1,
    kind: 'work',
    recipe: {
      instructions:
        'Reflect on the explicitly selected experiment corpus. Ground conclusions in its evidence and distinguish unresolved questions from supported findings.',
      sections: [
        task,
        brief,
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
    },
  },
  {
    name: 'task.review',
    version: 3,
    kind: 'review',
    recipe: {
      instructions:
        'Independently assess the pinned evidence against every review criterion. Verify claims yourself; prior progress and recovery notes are not a verdict.' +
        verifying,
      sections: [
        task,
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
      maxChars: 96000,
      outputInstructions:
        'Submit pass, needs_changes or fail through review.submit with the current review ID, claimId, expectedRevision and a stable request ID: verification notes, a plain single-paragraph synopsis of 40–420 characters without entity IDs or Markdown, and one finding per numbered criterion (met, not_met, not_verified or waived, with the pinned evidenceIds you checked and your notes). Do not modify the producer’s evidence.',
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
]);

/**
 * Checks the server adds to every new task of a type, and that the delivery review may not waive.
 * A plan whose data or compute does not exist cost scenario run 01 four design-review rounds; the
 * fact is cheap to establish while planning.
 */
export const TYPE_REQUIRED_CHECKS: Record<string, string[]> = {
  'experiment.plan': [
    'The plan states what it requires against what exists — data, compute and time with the measured basis of each — names every dependency and whether it is present, and leaves no known blocker.',
  ],
};
