import type { WorkflowExecutionBinding, WorkflowExecutionPolicy } from '@merv/contracts';

type Bindings = Record<string, WorkflowExecutionBinding>;
const target = (field: 'instanceId' | 'revision'): WorkflowExecutionBinding => ({
  kind: 'target',
  field,
});
const reference = (name: string): WorkflowExecutionBinding => ({ kind: 'reference', name });
const grant = (name: string, ...alternatives: Bindings[]) => ({ name, alternatives });

/** Fixed work protocols. Completion readiness and context rendering never mint grants. */
export function taskExecutionPolicy(purpose: 'work' | 'review'): WorkflowExecutionPolicy {
  const instance = { instanceId: target('instanceId') };
  const task = { taskId: target('instanceId') };
  const revision = { expectedRevision: target('revision') };
  const assignment: Bindings = {
    ...task,
    ...revision,
    purpose: { kind: 'literal', value: purpose },
    ...(purpose === 'review' ? { claimId: reference('claimId') } : {}),
  };
  return {
    readOnly: purpose === 'review',
    tools: [
      grant('workflow.status_and_next', instance, {
        instanceId: { kind: 'oneOf', name: 'dependencies' },
      }),
      grant('workflow.assignment', instance),
      grant('task.get', task),
      grant('task.context', assignment),
      grant('task.checkpoint', {
        ...assignment,
        artifactIds: { kind: 'subset', name: 'artifacts' },
      }),
      grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('review.get', { reviewId: reference('reviewId') }),
      ...(purpose === 'work'
        ? [
            grant('artifact.create', {}),
            grant('task.submit_delivery', { taskId: reference('producerTaskId'), ...revision }),
            grant('task.mark_failed', { ...task, ...revision }),
          ]
        : [
            grant('review.start', { reviewId: reference('reviewId') }),
            grant('review.submit', {
              reviewId: reference('reviewId'),
              claimId: reference('claimId'),
              ...revision,
            }),
          ]),
    ],
  };
}
