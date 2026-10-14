import type { WorkflowDefinition } from '@merv/contracts';

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
