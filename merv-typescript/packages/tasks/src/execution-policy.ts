import { type WorkflowExecutionBinding, type WorkflowExecutionPolicy } from '@merv/contracts';
import { artifactGrants, grant, reference, reviewGrants, target } from '@merv/workflows/rules';
import { codeWorkspace } from '@merv/code-work/workspace';
import { artifactTaskExecution } from './legacy-artifact-review.js';

type Bindings = Record<string, WorkflowExecutionBinding>;

/** New tasks use Git; the retired artifact contract only resumes retained reviews. */
export type TaskWorkspace = 'code' | 'resolution' | 'artifacts';

/** Fixed work protocols. Completion readiness and context rendering never mint grants. */
export function taskExecutionPolicy(
  purpose: 'work' | 'review',
  workspace: TaskWorkspace,
  research = false,
  ordinaryGit = false,
): WorkflowExecutionPolicy {
  if (workspace === 'artifacts') return artifactTaskExecution(purpose);
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
    workspace: codeWorkspace(purpose, purpose === 'work' ? 'tasks' : 'task-reviews', ordinaryGit),
    tools: [
      ...(research ? [grant('nisa.research', {})] : []),
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
            ...artifactGrants(),
            grant('task.submit_delivery', { taskId: reference('producerTaskId'), ...revision }),
            grant('task.mark_failed', { ...task, ...revision }),
            ...(!ordinaryGit ? [grant('code.commit', {}), grant('code.operation', {})] : []),
            ...(workspace === 'resolution' && !ordinaryGit ? [grant('code.merge', {})] : []),
          ]
        : reviewGrants()),
    ],
  };
}
