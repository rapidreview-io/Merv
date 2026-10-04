import {
  grant,
  reference,
  target,
  type WorkflowExecutionBinding,
  type WorkflowExecutionPolicy,
} from '@merv/contracts';

type Bindings = Record<string, WorkflowExecutionBinding>;

/** Current tasks all use Code-managed Git; resolution work additionally grants merge tools. */
export type TaskWorkspace = 'code' | 'resolution';
const CODE_DRIVER = 'code.v2';

/** Fixed work protocols. Completion readiness and context rendering never mint grants. */
export function taskExecutionPolicy(
  purpose: 'work' | 'review',
  workspace: TaskWorkspace,
  largeUploads = false,
  compute = false,
): WorkflowExecutionPolicy {
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
    workspace:
      purpose === 'work'
        ? {
            mode: 'persistent',
            namespace: 'tasks',
            base: 'reference:base',
            perBase: false,
            retain: true,
            advancesCentral: false,
            driver: CODE_DRIVER,
          }
        : {
            mode: 'ephemeral',
            namespace: 'task-reviews',
            base: 'reference:code',
            retain: false,
            driver: CODE_DRIVER,
          },
    tools: [
      grant('workflow.status_and_next', instance, {
        instanceId: { kind: 'oneOf', name: 'dependencies' },
      }),
      grant('workflow.assignment', instance),
      grant('task.get', task),
      ...(compute ? [grant('task.compute_status', task)] : []),
      ...(compute
        ? [
            ...(purpose === 'review' ? [grant('task.compute_offers', {})] : []),
            ...(purpose === 'review'
              ? [
                  grant('task.compute_run', {
                    ...task,
                    ...revision,
                    purpose: { kind: 'literal', value: 'check' },
                  }),
                  grant('task.compute_cancel', task),
                ]
              : []),
            ...['machines', 'rent', 'ssh', 'extend', 'release'].map((name) =>
              grant(`task.compute_${name}`, task),
            ),
          ]
        : []),
      ...(compute && purpose === 'work'
        ? [
            grant('task.compute_offers', {}),
            grant('task.compute_run', { ...task, ...revision }),
            grant('task.compute_cancel', task),
          ]
        : []),
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
            ...(largeUploads
              ? [
                  grant('artifact.upload_begin', {}),
                  grant('artifact.upload_resume', {}),
                  grant('artifact.upload_complete', {}),
                ]
              : []),
            grant('task.submit_delivery', { taskId: reference('producerTaskId'), ...revision }),
            grant('task.mark_failed', { ...task, ...revision }),
            grant('code.commit', {}),
            grant('code.operation', {}),
            ...(workspace === 'resolution' ? [grant('code.merge', {})] : []),
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
