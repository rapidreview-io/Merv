import { z } from 'zod';
import {
  codeAdmissionLimitsSchema,
  codeAdmissionConfigureInputSchema,
  type CodeStoreStatus,
} from './code-store.js';

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
    denyGlobs: codeAdmissionLimitsSchema.shape.denyGlobs,
    /** Paths the credential patterns skip, for fixtures that are shaped like tokens. */
    secretExemptGlobs: codeAdmissionLimitsSchema.shape.secretExemptGlobs,
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
    denyGlobs: codeAdmissionLimitsSchema.shape.denyGlobs,
    secretExemptGlobs: codeAdmissionLimitsSchema.shape.secretExemptGlobs,
    /**
     * Stated on every call, never defaulted: the lists here replace what was set, so a check
     * that could be left out would let an operator editing one glob switch verification off
     * and have every later base seal unchecked without anybody having typed that.
     */
    check: codeCheckSpecSchema.nullable(),
    requestId: codeAdmissionConfigureInputSchema.shape.requestId,
  })
  .strict();
export type CodeRepositoryConfigureInput = z.infer<typeof codeRepositoryConfigureInputSchema>;

/** Research exposes its check configuration alongside technical repository status. */
export interface CodeResearchStoreStatus extends Omit<CodeStoreStatus, 'limits'> {
  limits: CodeStoreLimits;
}
