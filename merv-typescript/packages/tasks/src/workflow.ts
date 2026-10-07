import { check, type WorkflowDefinition } from '@merv/contracts';
import type { TaskWorkspace } from './execution-policy.js';

// The task workflow: its graph, the executable versions, and the guidance its assignments carry.

/** The ordinary-task graph. Edge order is part of its fingerprint; never reorder it. */
export const TASK_WORKFLOW: WorkflowDefinition = {
  name: 'task',
  version: 31,
  initial: 'in_progress',
  states: ['in_progress', 'in_review', 'done', 'failed'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'in_progress', action: 'submit_delivery', to: 'in_review' },
    { from: 'in_review', action: 'reissue_review', to: 'in_review' },
    { from: 'in_review', action: 'accept', to: 'done' },
    { from: 'in_review', action: 'revise', to: 'in_progress' },
    { from: 'in_review', action: 'fail_review', to: 'failed' },
    { from: 'in_progress', action: 'mark_failed', to: 'failed' },
    { from: 'in_review', action: 'mark_failed', to: 'failed' },
  ],
};
/**
 * The executable contracts. Each grants the large-upload tools, which refuse where the blob
 * store cannot sign uploads; the twins without them (task@6, @39) are retired.
 */
export const taskVersions: Record<number, { workspace: TaskWorkspace }> = {
  11: { workspace: 'resolution' },
  43: { workspace: 'code' },
};
export function taskContract(version: number) {
  const contract = taskVersions[version];
  check(contract, 'workflow_version_retired', `Task workflow ${version} is retired`, 409);
  return contract;
}
export const taskWorkspace = (version: number): TaskWorkspace => taskContract(version).workspace;
/** Service tasks are the resolution contracts; every other task runs on a Code one. */
export const taskVersion = (service = false): number => (service ? 11 : 43);
export const serviceOwned = (version: number) => taskVersions[version]?.workspace === 'resolution';
/** The workflow node a Git task's commit is made in. */
export const producing = {
  name: 'task',
  versions: Object.keys(taskVersions).map(Number),
  state: 'in_progress',
};

export const roundsFrom = (version: number) =>
  serviceOwned(version) ? 'in_progress' : 'in_review';
export const serviceWorkflow: WorkflowDefinition = {
  ...TASK_WORKFLOW,
  states: ['in_progress', 'in_review', 'suspended', 'done'],
  terminal: ['done'],
  edges: [
    ...TASK_WORKFLOW.edges.map((edge) =>
      edge.to === 'failed' ? { ...edge, to: 'suspended' } : edge,
    ),
    { from: 'in_review', action: 'revise_suspended', to: 'suspended' },
    { from: 'suspended', action: 'resume', to: 'in_progress' },
  ],
};

/** What only a Git task's producer must know; the published recipes stay as they are. */
export const GIT_DELIVERY =
  'This is a Git task: work in the private Git checkout prepared for this assignment. Record the work with code.commit (expectedHead is the HEAD of your local checkout), wait until code.operation reports it succeeded, then pass that operation’s commandId to task.submit_delivery. The commit must be your own, made in this assignment: if an earlier worker committed but did not deliver, commit again, which succeeds even when nothing changed. artifactIds may be empty, and a met confirmation that cites no evidenceIds is backed by the delivered commit.';
export const GIT_REVIEW =
  'This is a Git task: the read-only checkout prepared for this assignment is pinned to the exact delivered commit named by the ‘Delivered commit’ record in your evidence; do not substitute another branch or a newer head. Cite that record’s artifact id in the findings the commit supports. Only this leased review, working in that checkout, can pass the task.';
/**
 * Reviews admits an interactive claim without asking Tasks, and a claimed review can no longer be
 * leased. The reviewer is told before claiming, because afterwards only a release frees the task.
 */
export const GIT_CLAIM =
  'This is a Git task: only a leased review worker, whose runner prepares a checkout of the delivered commit, can pass it, and only that worker may claim it until review_rounds is used up. A claim made without a lease after that can only fail the task, and blocks every leased reviewer until its claimer or an admin hands it back with review.release.';

/** Said to every producer and reviewer of a task, in the assignment; the published recipes stay as they are. */
export const SOURCE_VERIFICATION =
  'Verify pivotal source-stated formulas and procedures against the primary paper and nearby prose or derivation before implementation or verdict. Text extraction can lose superscripts and symbols: inspect the rendered page when available, otherwise cross-check adjacent source statements. Cite the section and distinguish printed from PDF page numbering. Treat unresolved notation as uncertainty, not a paper inconsistency; reviewers must independently verify pivotal claims before passing.';

/**
 * How often a review may return a task for changes. After that many returns the next delivery
 * waits for a human, who reviews it by hand or allows another round. It is deployed policy
 * and not part of the published graph, so it covers every live task of every version.
 */
export const TASK_LIMITS = { reviewRounds: 3 };
