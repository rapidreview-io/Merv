import type { WorkflowDefinition } from '@merv/contracts';

/** service_experiment@2 (2026-10-14): results are submitted with the rendered one-page report.
 *  service_experiment@3 (2026-10-14): the plan is one Markdown document the customer and the
 *  intake agent co-edit; the agent verifies it and its acceptance freezes the contract.
 *  service_experiment@4 (2026-10-18): the executor may post progress to the customer's status
 *  page (customer_experiment.progress), which version 3 told it to but never granted.
 *  Earlier versions stay registered, unchanged, for requests started on them. */
export const SERVICE_VERSIONS = [1, 2, 3, 4] as const;
export const SERVICE_VERSION = 4;
export const writesReport = (version: number) => version >= 2;
export const plansDocument = (version: number) => version >= 3;
export const postsProgress = (version: number) => version >= 4;

/** Separate graph: customer acceptance is its sole design approval gate. */
export const SERVICE_EXPERIMENT: WorkflowDefinition = {
  name: 'service_experiment',
  version: 1,
  initial: 'planning',
  states: [
    'planning',
    'ready',
    'awaiting_payment',
    'running',
    'finalizing',
    'results_review',
    'complete',
    'failed',
  ],
  terminal: ['complete', 'failed'],
  edges: [
    { from: 'planning', action: 'propose', to: 'ready' },
    { from: 'ready', action: 'revise', to: 'planning' },
    { from: 'ready', action: 'approve', to: 'awaiting_payment' },
    { from: 'awaiting_payment', action: 'confirm_payment', to: 'running' },
    { from: 'running', action: 'submit_results', to: 'finalizing' },
    { from: 'finalizing', action: 'retain_results', to: 'results_review' },
    { from: 'results_review', action: 'accept_results', to: 'complete' },
    { from: 'results_review', action: 'repair_execution', to: 'running' },
    { from: 'results_review', action: 'change_scope', to: 'planning' },
    ...['planning', 'ready', 'awaiting_payment', 'running', 'finalizing', 'results_review'].map(
      (from) => ({ from, action: 'fail', to: 'failed' }),
    ),
  ],
};
