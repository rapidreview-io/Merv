import { z } from 'zod';
import { codeCommandControlSchema, codeCommitReceiptSchema } from './code.js';
import { sessionWorkspaceSchema } from './workspace.js';
import { githubBranchSchema } from './code-github.js';

export const codeTransportInputSchema = z.union([
  codeCommandControlSchema.extend({ operation: z.literal('fetch') }).strict(),
  codeCommandControlSchema
    .extend({ operation: z.literal('checkpoint'), receipt: codeCommitReceiptSchema })
    .strict(),
  codeCommandControlSchema
    .extend({ operation: z.literal('capture'), workspace: sessionWorkspaceSchema })
    .strict(),
]);
export type CodeTransportInput = z.infer<typeof codeTransportInputSchema>;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
export const codeTransportGrantSchema = z
  .object({
    repositoryId: z.string().regex(/^github:[1-9][0-9]*$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    revision: z.number().int().nonnegative().safe(),
    baseBranch: githubBranchSchema,
    baseOid: oid,
    target: z
      .object({ branch: githubBranchSchema, headOid: oid, treeOid: oid })
      .strict()
      .nullable(),
    token: z.string().min(1).max(16384),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Controller-only secret, never a worker tool result or durable launch field. */
export type CodeTransportGrant = z.infer<typeof codeTransportGrantSchema>;
