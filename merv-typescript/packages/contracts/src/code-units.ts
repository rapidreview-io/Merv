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
/**
 * Accepted units of a project whose code the project's main does not yet contain, as one
 * answer: a reader that wants to know what is still unpublished asks once rather than
 * comparing commits it is not allowed to interpret.
 */
export interface CodeAcceptedSince {
  unitIds: string[];
  /**
   * The unpublished units whose acceptance is quarantined. They are unpublished code like the
   * rest, and are named rather than hidden, because nothing may be built on them.
   */
  quarantined: string[];
  /** The main those units were compared against. */
  main: string;
  /** The answer's identity, so a caller can tell one reading from another. */
  hash: string;
}
/**
 * Where a unit that publishes its accepted code to main stands. Null for every unit that
 * does not publish, and for one that is marked but not accepted yet: publication begins at
 * acceptance. `pending` is a wait on a signed-in operator, never a failure of the work, and
 * `unsealed` is the accepted unit whose facts could not open a publication at all.
 */
export interface CodeUnitPublication {
  state: 'pending' | 'stale' | 'disabled' | 'closed' | 'unsealed' | 'incident' | 'published';
  pull?: { number: number; url: string };
  /** The verified merge commit on main; present only once `published`. */
  mergeCommit?: string;
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
  /** `merged` is a base Code made from several accepted commits; it is never itself accepted. */
  kind: 'main' | 'accepted' | 'merged';
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
  /**
   * `merge` names the accepted commits the base was made from, so a reader can join this
   * unit to that base by its member set without asking the server for a second name.
   */
  | { status: 'ready'; kind: CodeBasePin['kind']; sources: string[]; merge?: string[] }
  /** A declared dependency has not settled; Workflows already says so, and Code adds nothing. */
  | { status: 'waiting' }
  /** `merge` names the accepted commits a base has still to be made from. */
  | { status: 'blocked'; blockers: WorkflowProvidedBlockerInput[]; merge?: string[] };
export interface CodeUnit {
  unitId: string;
  workflow: string;
  version: number;
  declaredAt: string;
  /** The branch a writer stands on, which is the name the mirror publishes it under. */
  branch: string;
  base: CodeBasePin | null;
  /** Null once the unit has ended or been accepted without ever taking a base. */
  baseStatus: CodeBaseStatus | null;
  acceptance: CodeUnitAcceptance | null;
  /** Where this unit's publication to main stands; null unless it publishes and was accepted. */
  publication: CodeUnitPublication | null;
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

export type CodeBaseState =
  | 'waiting_inputs'
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'blocked_infra'
  | 'awaiting_resolution'
  | 'resolved'
  | 'suspended'
  | 'cancelled';
export interface CodeBaseRecord {
  key: string;
  members: string[];
  left: string;
  right: string;
  /**
   * The two commits `left` and `right` stand for, in that order: a lone member is itself, an
   * earlier base is the result it reached. A null is an input that has no usable result, and
   * a base nobody may build on again is left unresolved rather than read for. Present only
   * where a whole project was in hand: one row on its own is not worth two more reads.
   */
  parents?: [string | null, string | null];
  state: CodeBaseState;
  quarantined: boolean;
  /** How the result was made: by this server's merge, or by the one task that resolved it. */
  result: { method: 'auto' | 'task'; commit: string; tree: string | null; engine: string } | null;
  conflict: { paths: string[]; messages: string } | null;
  resolutionTaskId: string | null;
  resolutionError: string | null;
  attempts: number;
  executionEpoch: number;
  deadline: string | null;
  sponsors: string[];
  blocker: string | null;
  operatorReason: string | null;
  updatedAt: string;
}

/** Operator disposition of one retained base; every request retains its reason. */
export interface CodeBaseControlInput {
  key: string;
  action: 'retry' | 'suspend' | 'resume' | 'cancel' | 'quarantine';
  reason: string;
  requestId: string;
}
