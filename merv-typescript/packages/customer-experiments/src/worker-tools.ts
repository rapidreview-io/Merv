import { z } from 'zod';
import type { Context } from 'cordis';
import { check, type Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { CustomerExperiments } from './domain.js';
import type { FilesService } from './files.js';
import { progressSchema, submitResultsSchema } from './schema.js';
import { isDocumentContract } from './types.js';

/** Deliberately no create/approve/payment tool: customer authority stays at the HTTP edge. */
export function registerWorkerTools(
  tools: Context['tools'],
  service: CustomerExperiments,
  files?: FilesService,
): () => Promise<void> {
  /** v3: the customer's files, read-only and only once the contract froze them. */
  const frozen = async (caller: Caller, id: string) => {
    const exp = await service.get(caller, id);
    check(exp.workflow.version >= 3, 'not_found', 'This experiment has no request files', 404);
    check(
      exp.acceptedContractId && exp.contract && isDocumentContract(exp.contract),
      'files_not_frozen',
      'Request files are read after contract acceptance',
      409,
    );
    check(files?.storage, 'files_unavailable', 'File storage is not configured', 503);
    return { files, manifest: exp.contract.files, record: await files.forExperiment(exp.id) };
  };
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
    tools.register({
      name: 'customer_experiment.progress',
      conversation: 'never',
      description:
        "Tell the customer how the run is going; their status page shows each line. Post a short plain sentence at each milestone (machine ready, files checked, each model or condition started or finished, results being written). With a finished item, pass result {name, score, total} (e.g. one model's correct answers out of the cases); pass step {done, total} for how many planned items are finished. No paths, IDs, hashes or internal detail.",
      inputSchema: progressSchema,
      handler: async (caller: Caller, input: unknown) => service.reportProgress(caller, input),
    }),
    tools.register({
      name: 'customer_experiment.files',
      conversation: 'never',
      description:
        "List the customer's request files frozen into the accepted contract: key, size and ETag of each.",
      inputSchema: z.object({ id: z.string().min(1) }).strict(),
      readOnly: true,
      handler: async (caller: Caller, input: { id: string }) => {
        return { files: (await frozen(caller, input.id)).manifest };
      },
    }),
    tools.register({
      name: 'customer_experiment.file_download',
      conversation: 'never',
      description:
        'A short-lived presigned GET URL for one request file listed by customer_experiment.files.',
      inputSchema: z.object({ id: z.string().min(1), key: z.string().min(1).max(4096) }).strict(),
      readOnly: true,
      handler: async (caller: Caller, input: { id: string; key: string }) => {
        const { files, manifest, record } = await frozen(caller, input.id);
        check(
          manifest.some((f) => f.key === input.key),
          'not_found',
          'File is not in the accepted contract',
          404,
        );
        return files.download(record, input.key);
      },
    }),
  ];
  return async () => {
    for (const dispose of [...disposers].reverse()) await dispose();
  };
}
