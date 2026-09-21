import type { CodeCaptureRef } from './code-models.js';

/**
 * What an owner plugin and Code say to each other about a unit of work. Nothing here names a
 * commit: an owner hands over the capture reference it already holds and receives an opaque
 * `reference` it passes on unread, so only Code interprets either.
 */
export interface CodeUnitAcceptInput {
  /** The workflow instance that succeeded. */
  unitId: string;
  /** The revision at which it reached its success state. */
  terminalRevision: number;
  submissionRef: string;
  reviewRef: string;
  /** Null says the unit succeeded without code, which lets a later base look past it. */
  codeRef: CodeCaptureRef | null;
  /** The leased review session, when there was one, so Code can record where it attached. */
  reviewSessionId: string | null;
}
export interface CodeUnitAcceptance {
  unitId: string;
  hash: string;
  acceptedAt: string;
  terminalRevision: number;
  submissionRef: string;
  reviewRef: string;
  acceptedBy: string;
  /** The exact reviewed code, opaque to everyone but Code; null for a code-less success. */
  reference: string | null;
  /** Whether the reviewer's checkout was attached at exactly that code; null without code. */
  reviewAttached: boolean | null;
  /**
   * Where the accepted code is kept. `legacy-local` is the runner's own retained capture:
   * the server holds the identity and makes no durability claim for the objects.
   */
  storage: 'none' | 'legacy-local';
}
export interface CodeBasePin {
  unitId: string;
  kind: 'main' | 'accepted';
  reference: string;
  /** Every acceptance that contributed, including those whose code was the same. */
  sources: { unitId: string; acceptanceHash: string }[];
  pinnedAt: string;
  leaseId: string;
}
export interface CodeUnit {
  unitId: string;
  workflow: string;
  version: number;
  declaredAt: string;
  base: CodeBasePin | null;
  acceptance: CodeUnitAcceptance | null;
}
