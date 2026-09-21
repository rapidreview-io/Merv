import { visible } from './text.js';
import { z } from 'zod';
import { sessionWorkspaceSchema, type SessionWorkspace } from './workspace.js';
import type { CodeUnit } from './code-units.js';
import type { WorkflowProvidedBlocker } from './workflow-guidance.js';

export interface CodeCommitInput {
  expectedHead: string;
  message: string;
  requestId: string;
}
/** Server-frozen command. Workers never supply filesystem paths or executable arguments. */
export interface CodeCommitCommand {
  id: string;
  projectId: string;
  sessionId: string;
  actorId: string;
  instanceId: string;
  expectedRevision: number;
  runnerId: string;
  hostRef: string;
  workspace: SessionWorkspace;
  expectedHead: string;
  message: string;
  createdAt: string;
}
/** An immutable, authenticated runner observation of this exact commit operation. */
export interface CodeCommitReceipt {
  commandId: string;
  repositoryId: string;
  workspaceId: string;
  baseOid: string;
  parentOid: string;
  headOid: string;
  treeOid: string;
  stats: SessionWorkspace['stats'];
}
export interface CodeCommandRecord {
  command: CodeCommitCommand;
  status: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled';
  receipt: CodeCommitReceipt | null;
  error: string | null;
}
export interface CodeCommandControl {
  sessionId: string;
  runnerId: string;
  hostRef: string;
}
export type CodeCommandCompletion = CodeCommandControl & {
  commandId: string;
} & ({ receipt: CodeCommitReceipt; error?: never } | { error: string; receipt?: never });

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const count = z.number().int().nonnegative().safe();
const message = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => visible(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
export const codeCommitInputSchema = z
  .object({ expectedHead: oid, message, requestId: id })
  .strict();
export const codeCommandControlSchema = z
  .object({ sessionId: id, runnerId: id, hostRef: id })
  .strict();
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
  })
  .strict()
  .refine((value) => value.expectedHead.length === value.workspace.baseOid.length);
export const codeCommitReceiptSchema = z
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

/**
 * Local mode: an operator names the one runner repository the project's work lives in and the
 * commit of its main. The server cannot look inside that repository, so both are asserted.
 */
export interface CodeLocalBindInput {
  repositoryId: string;
  mainOid: string;
  /** The main this caller last read; absent for the first binding. Moving main is a compare-and-set. */
  expectedMainOid?: string;
  requestId: string;
}
export interface CodeProjectBinding {
  mode: 'local';
  repositoryId: string;
  boundBy: string;
  boundAt: string;
  main: { oid: string; admittedBy: string; admittedAt: string };
  /** Accepted code stays in the runner's repository; the server claims no durability for it. */
  durability: 'legacy-local';
}
export interface CodeProjectStatus {
  project: CodeProjectBinding | null;
  /** The newest 200 units. */
  units: CodeUnit[];
  blockers: WorkflowProvidedBlocker[];
}
export const codeLocalBindInputSchema = z
  .object({
    repositoryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
    mainOid: oid,
    expectedMainOid: oid.optional(),
    requestId: id,
  })
  .strict();
