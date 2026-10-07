import { grant, literal, reference, target } from '@merv/workflows/rules';
import { codeWorkspace } from '@merv/code-work/workspace';
import { type WorkflowExecutionPolicy } from '@merv/contracts';
import { type ActiveState, designCheckout, reviewing, rolesFor } from './program.js';

// The fixed tools each assignment of an experiment is granted.

/** Whether an assignment changes nothing in Git: every review, and from experiment@41 a design,
 *  which reads the code execution will start from in a checkout it keeps nothing of. */
export const readsOnly = (state: ActiveState, version: number) =>
  reviewing(state) || (state === 'planned' && designCheckout(version));

export function execution(state: ActiveState, version: number): WorkflowExecutionPolicy {
  const experiment = { experimentId: target('instanceId') };
  const revision = { expectedRevision: target('revision') };
  const workerActions =
    state === 'planned'
      ? ['submit_design', 'abandon', 'mark_failed']
      : ['submit_results', 'retry_running', 'abandon', 'mark_failed'];
  return {
    readOnly: readsOnly(state, version),
    workspace:
      state === 'running'
        ? codeWorkspace('work', 'experiments')
        : state === 'experiment_review'
          ? codeWorkspace('review', 'experiment-reviews')
          : designCheckout(version)
            ? codeWorkspace('read', 'experiment-designs')
            : { mode: 'none' },
    tools: [
      grant(
        'workflow.status_and_next',
        { instanceId: target('instanceId') },
        { instanceId: { kind: 'oneOf', name: 'dependencies' } },
      ),
      grant('workflow.assignment', { instanceId: target('instanceId') }),
      grant('experiment.get_state', experiment),
      grant('artifact.get', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('artifact.read', { artifactId: { kind: 'oneOf', name: 'artifacts' } }),
      grant('review.get', { reviewId: { kind: 'oneOf', name: 'reviews' } }),
      ...(reviewing(state)
        ? [
            grant('review.start', { reviewId: reference('reviewId') }),
            grant('review.submit', {
              reviewId: reference('reviewId'),
              claimId: reference('claimId'),
              ...revision,
            }),
          ]
        : [
            grant('artifact.create', {}),
            grant('artifact.upload_begin', {}),
            grant('artifact.upload_resume', {}),
            grant('artifact.upload_complete', {}),
            grant(
              'experiment.attach',
              ...rolesFor(state).map((role) => ({
                ...experiment,
                ...revision,
                artifactId: { kind: 'oneOf' as const, name: 'artifacts' },
                role: literal(role),
              })),
            ),
            grant(
              'experiment.transition',
              ...workerActions.map((transition) => ({
                ...experiment,
                ...revision,
                transition: literal(transition),
              })),
            ),
            ...(state === 'running' ? [grant('experiment.exhibit', experiment)] : []),
            ...(state === 'running' ? [grant('code.commit', {}), grant('code.operation', {})] : []),
          ]),
    ],
  };
}
