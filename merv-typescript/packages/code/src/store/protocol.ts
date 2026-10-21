import { z } from 'zod';
import { codePendingMergeSchema } from '@merv/contracts/workspace';
import { idSchema as id, oidSchema as oid } from '@merv/contracts/schemas';

const glob = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\x00-\x1f\x7f\\]/.test(value) && !value.startsWith('/'));

/** No single transfer is larger, whatever a project's quota allows. */
export const CODE_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
/** What admission found wrong in a transfer. It names the place and never the matched text. */
const codeFindingSchema = z.strictObject({
  rule: z.string().regex(/^[a-z][a-z0-9_@.]{0,59}$/),
  path: z.string().max(4096).nullable(),
  oid: oid.nullable(),
});
export type CodeFinding = z.infer<typeof codeFindingSchema>;

/** Admission policy for incoming Git histories. */
export const codeAdmissionLimitsSchema = z.strictObject({
  format: z.literal(1),
  denyGlobs: z.array(glob).max(64),
  secretExemptGlobs: z.array(glob).max(64),
});
export type CodeAdmissionLimits = z.infer<typeof codeAdmissionLimitsSchema>;

/** One journalled transfer or ref operation, as everyone allowed to read the project sees it. */
export interface CodeStoreOperation {
  id: string;
  kind: string;
  status: 'prepared' | 'completed' | 'failed';
  phase: string | null;
  unitId: string | null;
  generation: number | null;
  /** Bundle bytes the server holds, and how many it was promised. */
  received: number;
  bytes: number | null;
  /** Historical compatibility field; zero because multipart transfers are retired. */
  partBytes: number;
  /** The commit the operation delivers, once it is known. */
  head: string | null;
  error: string | null;
  findings: CodeFinding[];
  /** Why an unfinished operation is not moving, and what would move it. */
  waiting: { code: string; message: string; next: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** A project's repository on the server's disk. */
export interface CodeStoreStatus {
  hosted: boolean;
  objectFormat: 'sha1' | 'sha256' | null;
  rootOid: string | null;
  source: 'bundle' | 'github' | 'managed' | null;
  /** The newest commits imports delivered; an importer excludes what it already finds here. */
  tips: string[];
  /** Everything this project keeps on disk: objects, quarantine, held bundles and exports. */
  diskBytes: number;
  quotaBytes: number;
  limits: CodeAdmissionLimits;
}

/** Something about a project's repository that needs saying and stops nothing. */
export interface CodeStoreWarning {
  code: string;
  /** The ref it is about, where it is about one. */
  ref: string | null;
  message: string;
  at: string;
}
export const codeWorkspaceManifestSchema = z.strictObject({
  remote: z.string().regex(/^\/git\/[A-Za-z0-9_-]+\.git$/),
  projectRef: id,
  repositoryId: id,
  objectFormat: z.enum(['sha1', 'sha256']),
  unitId: id,
  generation: z.number().int().positive().safe().nullable(),
  mode: z.enum(['write', 'read']),
  head: oid,
  base: oid,
  branch: z.string().min(1).max(512).nullable(),
  prerequisites: z.array(oid).max(256),
  pendingMerge: codePendingMergeSchema.optional(),
  submission: z.strictObject({ sessionId: id, parentOid: oid, treeOid: oid }).optional(),
  submissionRequested: z.boolean().optional(),
});
export type CodeWorkspaceManifest = z.infer<typeof codeWorkspaceManifestSchema>;

/** The writer fence an upload is made under; Code checks all of it, whatever carried it here. */
export const codePushFenceSchema = z
  .strictObject({ sessionId: id, runnerId: id, hostRef: id })
  .extend({
    unitId: id,
    generation: z.number().int().positive().safe(),
    leaseId: id,
    expectedHead: oid,
    proposedHead: oid,
    treeOid: oid,
  });
export const codeUnitFenceInputSchema = z.object({ unitId: id, requestId: id }).strict();
/**
 * Who may advance a unit's branch in Code's repository. A generation belongs to one leased
 * session; the next begins only once this one closed or an operator fenced it.
 */
export type CodeWriterState =
  'idle' | 'reserved' | 'active' | 'closing' | 'closed' | 'recovery_required';
export interface CodeWriterStatus {
  generation: number;
  state: CodeWriterState;
  /** Why no new writer may be leased now, in the words of a refusal; null when one may. */
  blocked: { code: string; message: string } | null;
}
