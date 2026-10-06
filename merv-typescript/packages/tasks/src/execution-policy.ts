import {
  grant,
  reference,
  target,
  type WorkflowExecutionBinding,
  type WorkflowExecutionPolicy,
} from '@merv/contracts';
import { codeWorkspace } from '@merv/code-work/workspace';

type Bindings = Record<string, WorkflowExecutionBinding>;

/** Current tasks all use Code-managed Git; resolution work additionally grants merge tools. */
export type TaskWorkspace = 'code' | 'resolution';

/** Fixed work protocols. Completion readiness and context rendering never mint grants. */
export function taskExecutionPolicy(
  purpose: 'work' | 'review',
  workspace: TaskWorkspace,
  largeUploads = false,
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
    workspace: codeWorkspace(purpose, purpose === 'work' ? 'tasks' : 'task-reviews'),
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
