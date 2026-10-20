import { visible } from './text.js';
import { idSchema as id, oidSchema as oid } from './schemas.js';
import { z } from 'zod';
import { sessionWorkspaceSchema } from './workspace.js';
export type CodeCommitInput = z.infer<typeof codeCommitInputSchema>;
/** Server-frozen command. Workers never supply filesystem paths or executable arguments. */
export type CodeCommitCommand = z.infer<typeof codeCommitCommandSchema>;
/** An immutable, authenticated runner observation of this exact commit operation. */
export type CodeCommitReceipt = z.infer<typeof codeCommitReceiptSchema>;
export type CodeCommandRecord = z.infer<typeof codeCommandRecordSchema>;
export type CodeCommandControl = z.infer<typeof codeCommandControlSchema>;
export type CodeCommandCompletion = CodeCommandControl & {
  commandId: string;
} & ({ receipt: CodeCommitReceipt; error?: never } | { error: string; receipt?: never });

const count = z.number().int().nonnegative().safe();
const message = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => visible(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
export const codeCommitInputSchema = z
  .object({ expectedHead: oid, message, requestId: id })
  .strict();
export const codeMergeInputSchema = codeCommitInputSchema
  .extend({ operation: z.enum(['start', 'complete']) })
  .strict();
export type CodeMergeInput = z.infer<typeof codeMergeInputSchema>;
export const codeCommandControlSchema = z
  .object({ sessionId: id, runnerId: id, hostRef: id })
  .strict();
/** The request id a runner asks its nth periodic checkpoint under, by which Code Work tells one. */
export const checkpointRequestId = (count: number) => `checkpoint-${count}`;
export const isCheckpointRequestId = (requestId: string) => /^checkpoint-\d+$/.test(requestId);
export const codeCommitCommandSchema = z
  .object({
    id,
    projectId: id,
    sessionId: id,
    actorId: id,
    instanceId: id,
    expectedRevision: count,
    runnerId: id,
    hostRef: id,
    workspace: sessionWorkspaceSchema,
    expectedHead: oid,
    message,
    createdAt: z.string().datetime(),
    merge: z.enum(['start', 'complete']).optional(),
  })
  .strict()
  .refine((value) => value.expectedHead.length === value.workspace.baseOid.length);
const codeCommitReceiptSchema = z
  .object({
    commandId: id,
    repositoryId: id,
    workspaceId: id,
    baseOid: oid,
    parentOid: oid,
    headOid: oid,
    treeOid: oid,
    stats: z
      .object({ commitCount: count, filesChanged: count, insertions: count, deletions: count })
      .strict(),
  })
  .strict()
  .refine((value) =>
    [value.parentOid, value.headOid, value.treeOid].every((x) => x.length === value.baseOid.length),
  );
export const codeCommandCompletionSchema = z.union([
  codeCommandControlSchema.extend({ commandId: id, receipt: codeCommitReceiptSchema }).strict(),
  codeCommandControlSchema
    .extend({ commandId: id, error: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) })
    .strict(),
]);
export const codeCommandRecordSchema = z
  .object({
    command: codeCommitCommandSchema,
    status: z.enum(['queued', 'dispatched', 'succeeded', 'failed', 'cancelled']),
    receipt: codeCommitReceiptSchema.nullable(),
    error: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,99}$/)
      .nullable(),
  })
  .strict()
  .refine((value) =>
    value.status === 'succeeded'
      ? value.receipt !== null && value.error === null
      : value.receipt === null &&
        (['failed', 'cancelled'].includes(value.status)
          ? value.error !== null
          : value.error === null),
  );

/** An operator binds the repository identity and names main; moving main is a compare-and-set. */
export type CodeLocalBindInput = z.input<typeof codeLocalBindInputSchema>;
export interface CodeProjectBinding {
  mode: 'local';
  repositoryId: string;
  boundBy: string;
  boundAt: string;
  /** `stored` says Code's own repository holds that commit, so work can be prepared from it. */
  main: { oid: string; admittedBy: string; admittedAt: string; stored: boolean };
  /**
   * The repositories this project was bound to before, oldest first; empty for a project that
   * was never rebound. The acceptances and pins made under a previous repository name it by
   * value and are immutable, so they can never be restated: the binding has to retain every
   * repository it has been bound to for them to stay readable as this project's own.
   */
  previous: {
    repositoryId: string;
    boundBy: string;
    boundAt: string;
    reboundBy: string;
    reboundAt: string;
    reason: string;
    operationId: string;
  }[];
}
export const codeLocalBindInputSchema = z
  .object({
    repositoryId: id,
    mainOid: oid,
    expectedMainOid: oid.optional(),
    requestId: id,
  })
  .strict();
