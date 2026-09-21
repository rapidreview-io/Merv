import type { WorkflowExecutionBinding, WorkflowExecutionPolicy } from '@merv/contracts';

type Bindings = Record<string, WorkflowExecutionBinding>;
const target = (field: 'instanceId' | 'revision'): WorkflowExecutionBinding => ({
  kind: 'target',
  field,
});
const reference = (name: string): WorkflowExecutionBinding => ({ kind: 'reference', name });
const grant = (name: string, ...alternatives: Bindings[]) => ({ name, alternatives });

/** Where a task version's private Git checkout starts, or 'none' for the original scratch task. */
export type TaskWorkspace = 'none' | 'central' | 'reference' | 'code';
/** The workspace driver that prepares checkouts from Code's own repository; opaque to Tasks. */
const CODE_DRIVER = 'code.v2';

/**
 * Fixed work protocols. Completion readiness and context rendering never mint grants.
 *
 * A published execution policy is immutable, so the workspace belongs to the task's workflow
 * version: a scratch version declares nothing and stays byte-identical, and a Git version adds
 * the checkout and, for the producer alone, the commit tools a workspace never grants by itself.
 * A `code` version declares the same checkouts as a `reference` one and names the driver that
 * prepares them from Code's repository, so only a runner that carries it is offered the work.
 */
export function taskExecutionPolicy(
  purpose: 'work' | 'review',
  workspace: TaskWorkspace = 'none',
): WorkflowExecutionPolicy {
  const driver = workspace === 'code' ? { driver: CODE_DRIVER } : {};
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
    ...(workspace === 'none'
      ? {}
      : {
          workspace:
            purpose === 'work'
              ? {
                  mode: 'persistent' as const,
                  namespace: 'tasks',
                  base:
                    workspace === 'central' ? ('central' as const) : ('reference:base' as const),
                  perBase: false,
                  retain: true,
                  advancesCentral: false,
                  ...driver,
                }
              : {
                  // The reviewer inspects exactly the delivered commit and keeps nothing.
                  mode: 'ephemeral' as const,
                  namespace: 'task-reviews',
                  base: 'reference:code' as const,
                  retain: false,
                  ...driver,
                },
        }),
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
            ...(workspace === 'none'
              ? []
              : [grant('code.commit', {}), grant('code.operation', {})]),
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
