import { z } from 'zod';
import { codePendingMergeSchema } from './workspace.js';

/**
 * The second workspace protocol: Code keeps one repository per project and machines move Git
 * bundles to and from it. Everything here is opaque to the API, which forwards these bodies
 * and the bundle bytes unread; only Code and its workspace driver interpret them.
 */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
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
export const codeFindingSchema = z
  .object({
    rule: z.string().regex(/^[a-z][a-z0-9_@.]{0,59}$/),
    path: z.string().max(4096).nullable(),
    oid: oid.nullable(),
  })
  .strict();
export type CodeFinding = z.infer<typeof codeFindingSchema>;

/** The largest merged tree a project check may ship, so one upload is one page of parts. */
export const CODE_CHECK_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
/**
 * How much longer than the command's own timeout a check is given: the archive, the upload,
 * provisioning a machine, restoring a snapshot, polling and tearing down all happen outside
 * the command, and a deadline that does not cover them turns every check into a re-rental.
 * It must also exceed the allowance an adapter adds to the command's timeout for setup on
 * the machine, or the lease and the reservation would end under a job still inside its own.
 */
export const CODE_CHECK_SLACK_SECONDS = 1500;

/**
 * The one command a project runs against a merged base, and the machine it runs in. The
 * offer is named rather than described, because a floating market pick would make two runs
 * of one base two environments and no receipt could say what the check ran in.
 */
export const codeCheckSpecSchema = z
  .object({
    command: z.string().trim().min(1).max(4000),
    timeoutSeconds: z.number().int().min(30).max(3600),
    image: z
      .object({
        provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        offerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        snapshotId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type CodeCheckSpec = z.infer<typeof codeCheckSpecSchema>;

export const codeStoreLimitsSchema = z
  .object({
    format: z.literal(1),
    /** Paths no admitted history may contain: literals, `*`, `?` and `**`. */
    denyGlobs: z.array(glob).max(64),
    /** Paths the credential patterns skip, for fixtures that are shaped like tokens. */
    secretExemptGlobs: z.array(glob).max(64),
    /**
     * The project check, or null for none. The tag stays 1: an added field with a default is
     * readable by the reader that was written for format 1, and every stored row reads back
     * as no command configured, which is what those projects meant.
     */
    check: codeCheckSpecSchema.nullable().default(null),
  })
  .strict();
export type CodeStoreLimits = z.infer<typeof codeStoreLimitsSchema>;

export const codeRepositoryConfigureInputSchema = z
  .object({
    denyGlobs: z.array(glob).max(64),
    secretExemptGlobs: z.array(glob).max(64),
    /**
     * Stated on every call, never defaulted: the lists here replace what was set, so a check
     * that could be left out would let an operator editing one glob switch verification off
     * and have every later base seal unchecked without anybody having typed that.
     */
    check: codeCheckSpecSchema.nullable(),
    requestId: id,
  })
  .strict();
export type CodeRepositoryConfigureInput = z.infer<typeof codeRepositoryConfigureInputSchema>;

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
      .regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((value) => !value.includes('..') && !value.endsWith('/') && !value.includes('//'))
      .optional(),
    requestId: id,
  })
  .strict()
  .refine(
    (value) =>
      value.source === 'bundle'
        ? value.tip !== undefined && value.bundle !== undefined && value.ref === undefined
        : value.ref !== undefined && value.tip === undefined && value.bundle === undefined,
    'A bundle import names tip and bundle; a GitHub import names ref',
  );
export type CodeRepositoryImportInput = z.infer<typeof codeRepositoryImportInputSchema>;

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
  source: 'bundle' | 'github' | null;
  /** The newest commits imports delivered; an importer excludes what it already finds here. */
  tips: string[];
  /** Everything this project keeps on disk: objects, quarantine, held bundles and exports. */
  diskBytes: number;
  quotaBytes: number;
  limits: CodeStoreLimits;
  /** The newest verified copy in object storage; null where none is configured or none has run. */
  backup: CodeBackupStatus | null;
}

/**
 * What the last completed backup run wrote for this project. The disk stays authoritative —
 * a bare repository needs a filesystem no bucket provides — so this describes a copy that a
 * restore can be built from, and its age is how much acknowledged work a disk failure costs.
 * Present with every field null where copies are configured and none has ever completed,
 * which is a server to attend to and not the same as one that keeps no copy.
 */
export interface CodeBackupStatus {
  /** When the copy was taken, which is what an age is read from; null where none has been. */
  at: string | null;
  /**
   * When the copy was checked in the bucket: the manifest and the pointer read back byte for
   * byte, the bundle and the database dump sized against what was written, their sha256
   * having travelled with the write for the store itself to refuse damaged bytes.
   */
  verifiedAt: string | null;
  /** What the run put in the bucket; a project whose refs did not move writes almost nothing. */
  bytes: number;
  /** The bundle a restore of this project would read, or null where the repository is empty. */
  key: string | null;
  refsHash: string | null;
  warnings: string[];
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
export type CodeWorkspaceManifestInput = z.infer<typeof codeWorkspaceManifestInputSchema>;
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
export type CodeDownloadBegin = z.infer<typeof codeDownloadBeginSchema>;
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
export type CodeDownloadRead = z.infer<typeof codeDownloadReadSchema>;

export const codeUnitFenceInputSchema = z.object({ unitId: id, requestId: id }).strict();
export type CodeUnitFenceInput = z.infer<typeof codeUnitFenceInputSchema>;
export const codeMirrorRetryInputSchema = z
  .object({ operationId: id, acknowledgeRemote: oid.optional(), requestId: id })
  .strict();
export type CodeMirrorRetryInput = z.infer<typeof codeMirrorRetryInputSchema>;

/** Why a machine could not prepare a workspace yet, when nothing about the launch was wrong. */
export const codeDeferralCauseSchema = z.enum([
  'code_unavailable',
  'transport_unavailable',
  'store_busy',
  'local_recovery',
  'base_pending',
]);
export type CodeDeferralCause = z.infer<typeof codeDeferralCauseSchema>;
