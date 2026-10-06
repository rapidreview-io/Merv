import { z } from 'zod';
import { codePendingMergeSchema, gitBranchSchema } from './workspace.js';
import { idSchema as id, oidSchema as oid } from './schemas.js';

const importBranch = gitBranchSchema(255);

/**
 * The second workspace protocol: Code keeps one repository per project and machines move Git
 * bundles to and from it. Everything here is opaque to the API, which forwards these bodies
 * and the bundle bytes unread; only Code and its workspace driver interpret them.
 */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const glob = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\x00-\x1f\x7f\\]/.test(value) && !value.startsWith('/'));

/** No single transfer is larger, whatever a project's quota allows. */
export const CODE_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
/** The largest body of one part; a server may ask for less. */
export const CODE_PART_MAX_BYTES = 4 * 1024 * 1024;

const bundle = z
  .object({ sha256, bytes: z.number().int().positive().max(CODE_BUNDLE_MAX_BYTES) })
  .strict();

/** What admission found wrong in a transfer. It names the place and never the matched text. */
const codeFindingSchema = z
  .object({
    rule: z.string().regex(/^[a-z][a-z0-9_@.]{0,59}$/),
    path: z.string().max(4096).nullable(),
    oid: oid.nullable(),
  })
  .strict();
export type CodeFinding = z.infer<typeof codeFindingSchema>;

/** Admission policy for incoming Git histories. */
export const codeAdmissionLimitsSchema = z
  .object({
    format: z.literal(1),
    denyGlobs: z.array(glob).max(64),
    secretExemptGlobs: z.array(glob).max(64),
  })
  .strict();
export type CodeAdmissionLimits = z.infer<typeof codeAdmissionLimitsSchema>;
export const codeAdmissionConfigureInputSchema = codeAdmissionLimitsSchema
  .omit({ format: true })
  .extend({ requestId: id })
  .strict();

/** One object rather than a union, because a tool's input is described as a single object. */
export const codeRepositoryImportInputSchema = z
  .object({
    source: z.enum(['bundle', 'github']),
    /** Bundle: the one commit it delivers; the bundle's own ref name authorises nothing. */
    tip: oid.optional(),
    bundle: bundle.optional(),
    /** GitHub: a full ref of the linked repository, such as refs/heads/main. */
    ref: z
      .string()
      .max(255)
      .regex(/^refs\/(?:heads|tags)\//)
      .refine(
        (value) => importBranch.safeParse(value.replace(/^refs\/(?:heads|tags)\//, '')).success,
      )
      .optional(),
    /** Refuse a moving remote ref instead of importing an unselected head. */
    expectedHead: oid.optional(),
    /** Freeze the selected GitHub connection when preparation spans retries. */
    githubBinding: z
      .object({
        revision: z.number().int().nonnegative(),
        repositoryId: z.number().int().positive(),
        baseBranch: gitBranchSchema(200),
      })
      .strict()
      .optional(),
    requestId: id,
  })
  .strict()
  .refine(
    (value) =>
      value.source === 'bundle'
        ? value.tip !== undefined &&
          value.bundle !== undefined &&
          value.ref === undefined &&
          value.githubBinding === undefined &&
          value.expectedHead === undefined
        : value.ref !== undefined && value.tip === undefined && value.bundle === undefined,
    'A bundle import names tip and bundle; a GitHub import names ref',
  );
export type CodeRepositoryImportInput = z.infer<typeof codeRepositoryImportInputSchema>;

/** The branch and exact commit selected by a repository administrator before preparation. */
export interface CodeRepositoryPrepareInput {
  expectedRevision: number;
  baseBranch: string;
  headOid: string;
  expectedMainOid?: string;
  requestId: string;
}
export interface CodeRepositoryPreparation {
  state: 'ready' | 'importing' | 'review_required' | 'failed';
  mainOid?: string;
  taskId?: string;
  baseBranch: string;
  headOid: string;
  operation: CodeStoreOperation;
}

/**
 * Bind a hosted project to another repository identity. `repositoryId` is the same opaque
 * Code-side name `code.local.bind` takes, `mainOid` is the commit main becomes, and
 * `acknowledgePreviousMain` names the main being left behind when the new one is not ahead of
 * it — the operator states what they are letting go of, as `code.mirror.retry` makes them.
 */
export const codeRepositoryRebindInputSchema = z
  .object({
    repositoryId: id,
    mainOid: oid,
    reason: z.string().trim().min(1).max(4000),
    acknowledgePreviousMain: oid.optional(),
    requestId: id,
  })
  .strict();
export type CodeRepositoryRebindInput = z.infer<typeof codeRepositoryRebindInputSchema>;

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
  /** The size of one part the server accepts for this operation. */
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
/**
 * How a project's work reaches the repository it is published to. Mirroring is the server's
 * own asynchronous work: it never blocks a machine, a handoff or an acceptance, so a mirror
 * that is behind, retrying or blocked is a fact to read here and nothing that holds anyone up.
 */
export interface CodeMirrorStatus {
  /** `off` while nothing is linked or write automation is not configured. */
  state: 'off' | 'idle' | 'pending' | 'retrying' | 'blocked';
  /** The linked repository, or the reason nothing is published. */
  repository: string | null;
  blockedBy: string | null;
  /** Refs whose canonical commit has not reached the repository yet. */
  pending: number;
  oldestPendingAt: string | null;
  lastError: string | null;
  /** Refs no push may move without an operator, newest first. */
  blockedRefs: {
    operationId: string;
    unitId: string | null;
    ref: string;
    code: string;
    message: string;
    at: string;
  }[];
}

const control = z.object({ sessionId: id, runnerId: id, hostRef: id }).strict();
export const codeWorkspaceManifestInputSchema = z
  .object({ sessionId: id, runnerId: id, hostRef: id.optional() })
  .strict();
export const codeWorkspaceManifestSchema = z
  .object({
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
  })
  .strict();
export type CodeWorkspaceManifest = z.infer<typeof codeWorkspaceManifestSchema>;

const fence = control.extend({
  unitId: id,
  generation: z.number().int().positive().safe(),
  leaseId: id,
  expectedHead: oid,
  proposedHead: oid,
  treeOid: oid,
  /** Null when the proposed head is the expected head and nothing needs to move. */
  bundle: bundle.nullable(),
});
export const codeUploadBeginSchema = fence
  .extend({ kind: z.literal('checkpoint'), commandId: id, requestId: id })
  .strict();
export type CodeUploadBegin = z.infer<typeof codeUploadBeginSchema>;
/** The one capture a machine may hand over after its session closed; the server names the request. */
export const codeUploadFinalizeSchema = fence.extend({ kind: z.literal('final') }).strict();
export type CodeUploadFinalize = z.infer<typeof codeUploadFinalizeSchema>;

export const codeDownloadBeginSchema = z
  .object({
    sessionId: id,
    runnerId: id,
    hostRef: id.optional(),
    /** Commits the machine says it holds. A wrong claim only breaks that machine's import. */
    haves: z.array(oid).max(256),
  })
  .strict();
export const codeDownloadReadSchema = z
  .object({
    /** An export is read only by the machine that runs the session it was made for. */
    sessionId: id,
    runnerId: id,
    hostRef: id.optional(),
    offset: z.number().int().nonnegative().safe(),
    length: z.number().int().positive().max(CODE_PART_MAX_BYTES),
  })
  .strict();

export const codeUnitFenceInputSchema = z.object({ unitId: id, requestId: id }).strict();
export type CodeUnitFenceInput = z.infer<typeof codeUnitFenceInputSchema>;
export const codeMirrorRetryInputSchema = z
  .object({ operationId: id, acknowledgeRemote: oid.optional(), requestId: id })
  .strict();
export type CodeMirrorRetryInput = z.infer<typeof codeMirrorRetryInputSchema>;
