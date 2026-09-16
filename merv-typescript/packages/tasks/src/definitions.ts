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
    name: 'experiment.plan',
    version: 1,
    kind: 'work',
    recipe: {
      instructions:
        'Design an experiment that can test the stated research claim. Use the supplied research and constraints; distinguish established findings from hypotheses.',
      sections: [
        task,
        brief,
        section('research', 'Relevant research and prior findings'),
        section('constraints', 'Project and execution constraints'),
        feedback,
        checkpoints,
        checkpointEvidence,
      ],
      maxChars: 64000,
      outputInstructions:
        'Produce a plan covering the hypothesis, controls, baselines, data, metrics, procedure, resource budget and decision criteria. Save it as an artifact and submit it through task.submit_delivery for independent review. This assignment is planning; it does not authorize experiment execution.',
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
    version: 1,
    kind: 'review',
    recipe: {
      instructions:
        'Independently assess the pinned evidence against every review criterion. Verify claims yourself; prior progress and recovery notes are not a verdict.',
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
        'Submit pass, needs_changes or fail with verification notes through review.submit. Include the current review ID, claimId, expectedRevision and a stable request ID. Do not modify the producer’s evidence.',
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
