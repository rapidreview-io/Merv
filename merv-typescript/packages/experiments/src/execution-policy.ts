import { artifactGrants, grant, literal, reviewGrants, target } from '@merv/workflows/rules';
import { codeWorkspace } from '@merv/code-work/workspace';
import { type WorkflowExecutionPolicy } from '@merv/contracts';
import { REPORT_TOOLS } from '@merv/reports/prefill';
import {
  type ActiveState,
  approvalCommits,
  designCheckout,
  reviewing,
  rolesFor,
  writesReport,
} from './program.js';

// The fixed tools each assignment of an experiment is granted.

/** Whether an assignment changes nothing in Git: every review, and from experiment@41 a design,
 *  which reads the code execution will start from in a checkout it keeps nothing of. */
export const readsOnly = (state: ActiveState, version: number) =>
  reviewing(state) || (state === 'planned' && designCheckout(version) && !approvalCommits(version));

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
      state === 'running' || (state === 'planned' && approvalCommits(version))
        ? codeWorkspace('work', 'experiments', approvalCommits(version))
        : state === 'experiment_review' || (state === 'design_review' && approvalCommits(version))
          ? codeWorkspace('review', 'experiment-reviews', approvalCommits(version))
          : designCheckout(version)
            ? codeWorkspace('read', 'experiment-designs')
            : { mode: 'none' },
    tools: [
      ...(version >= 42 ? [grant('nisa.research', {})] : []),
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
        ? reviewGrants()
        : [
            ...artifactGrants(),
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
            ...(state === 'running' && !approvalCommits(version)
              ? [grant('code.commit', {}), grant('code.operation', {})]
              : []),
            ...(state === 'running' && writesReport(version)
              ? REPORT_TOOLS.map((name) =>
                  grant(name, {
                    subjectKind: literal('experiment'),
                    subjectId: target('instanceId'),
                  }),
                )
              : []),
          ]),
    ],
  };
}
