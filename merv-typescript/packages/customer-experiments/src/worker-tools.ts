import { z } from 'zod';
import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { CustomerExperiments } from './domain.js';
import { submitResultsSchema } from './schema.js';

/** Deliberately no create/approve/payment tool: customer authority stays at the HTTP edge. */
export function registerWorkerTools(
  tools: Context['tools'],
  service: CustomerExperiments,
): () => Promise<void> {
  const disposers = [
    tools.register({
      name: 'customer_experiment.get',
      conversation: 'never',
      description:
        'Read the fixed customer contract, manifest, current execution and result review for this experiment.',
      inputSchema: z.object({ id: z.string().min(1) }).strict(),
      readOnly: true,
      handler: async (caller: Caller, input: { id: string }) => service.get(caller, input.id),
    }),
    tools.register({
      name: 'customer_experiment.submit_results',
      conversation: 'never',
      description:
        'Submit retained results of the exact accepted and paid contract at expectedRevision. Only its leased execution worker may submit its own artifacts. The session then ends, final code is retained, and an independent Astra reviewer verifies the results. Never change scope; explain deviations or infeasibility in the report.',
      inputSchema: submitResultsSchema,
      handler: async (caller: Caller, input: unknown) => service.submitResults(caller, input),
    }),
  ];
  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose();
  };
}
