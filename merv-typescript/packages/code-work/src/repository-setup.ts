import { z } from 'zod';
import { oidSchema } from '@merv/contracts';
import { gitBranchSchema } from '@merv/contracts/workspace';

/** Select exact retained history; an ordinary push alone never advances the research baseline. */
export const repositoryPrepareSchema = z.strictObject({
  baseBranch: gitBranchSchema(200),
  headOid: oidSchema,
  expectedMainOid: oidSchema,
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/),
});
