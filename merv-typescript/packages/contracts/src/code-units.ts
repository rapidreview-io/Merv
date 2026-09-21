import type { CodeCaptureRef } from './code-models.js';
import type { WorkflowProvidedBlockerInput } from './workflow-guidance.js';

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
  storage: 'none' | 'legacy-local' | 'code';
  /** The Code operation that made the accepted commit durable; only `code` storage has one. */
  receipt?: string;
}
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
export interface CodeBasePin {
  unitId: string;
  kind: 'main' | 'accepted';
  reference: string;
  /** Every acceptance that contributed, including those whose code was the same. */
  sources: { unitId: string; acceptanceHash: string }[];
  pinnedAt: string;
  leaseId: string;
}
/**
 * Where a unit's base stands. Only `pinned` is a fact; the others are what a derivation would
 * find now, and may differ by the time a lease pins it.
 */
export type CodeBaseStatus =
  | { status: 'pinned'; pin: CodeBasePin }
  | { status: 'ready'; kind: CodeBasePin['kind']; sources: string[] }
  /** A declared dependency has not settled; Workflows already says so, and Code adds nothing. */
  | { status: 'waiting' }
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[] };
export interface CodeUnit {
  unitId: string;
  workflow: string;
  version: number;
  declaredAt: string;
  base: CodeBasePin | null;
  /** Null once the unit has ended or been accepted without ever taking a base. */
  baseStatus: CodeBaseStatus | null;
  acceptance: CodeUnitAcceptance | null;
  /** Zero until a session first writes to Code's repository for this unit. */
  generation: number;
  writerState: CodeWriterState;
  /** The newest commit Code admitted for this unit, which is what a successor resumes from. */
  canonicalHead: string | null;
  /** The newest commit a mirror push put on the published repository; behind while it catches up. */
  mirroredHead: string | null;
  mirroredAt: string | null;
  /** A final capture admission refused; the unit waits for an operator until it is fenced. */
  quarantine: { operationId: string } | null;
}
