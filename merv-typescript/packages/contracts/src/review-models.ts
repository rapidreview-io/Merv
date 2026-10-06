import type { Data } from './data.js';
import type { Verdict } from './types.js';

/** A review as Reviews keeps it and every reader reads it: portable, with no server code. */
export type ReviewFinding = {
  criterionNumber: number;
  status: 'met' | 'not_met' | 'not_verified' | 'waived';
  evidenceIds: string[];
  notes: string;
};
/** Owner-derived identities and a digest of the retained records that justify them. */
export interface ReviewProvenance {
  /** Recompute this certificate inside claim and verdict transactions; absence keeps legacy review rules. */
  revalidate?: true;
  formatVersion: 1;
  provider: string;
  reference: string;
  sourceHash: string;
  excludedActorIds: string[];
  hash: string;
}
/** A route a rejecting verdict may send its subject back along (`returnTo`), in a reviewer's words. */
export interface ReviewReturn {
  value: string;
  label: string;
}
/** What the work under review claimed of one of its checks, as the owning domain kept it. */
export interface ReviewClaim {
  checkNumber: number;
  status: 'met' | 'not_met';
  evidenceIds: string[];
  notes: string;
}
/** What the owning domain tells a reviewer reading or claiming one of its reviews. */
export interface ReviewGuide {
  /** The owner's verdict rules. */
  guidance?: string;
  /** The routes a rejecting verdict may choose; absent where the owner's routes are fixed. */
  returns?: ReviewReturn[];
  /** The gate the review is read at, where the owner reviews its records at more than one. */
  gate?: string;
  /** What the delivery under review claimed of each check, where the owner keeps such claims. */
  claims?: ReviewClaim[];
}
export interface ReviewRequest {
  provenance?: ReviewProvenance;
  /** Why no independent reviewer can currently take this request. */
  waiting?: string;
  id: string;
  projectId: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  pinnedInputIds?: string[];
  /** Immutable contributor exclusions in addition to the primary producer. Omitted for legacy reviews. */
  excludedActorIds?: string[];
  /** Immutable numbers of the criteria a pass can never waive. Omitted for reviews requested without any. */
  requiredCriteria?: number[];
  /** Whether the reader of this answer may claim it now. Present on reads, not on writes. */
  claimable?: boolean;
  /** On list reads: requested or started, so its subject is in its reviewer's hands. */
  open?: true;
  /** On list reads: the newest decided review of its subject, whose verdict sent the work back. */
  returned?: true;
  /** Claimed by the project's owner as owner, past the independence rule; its reviewer is that person. */
  override?: true;
  /** On reads: the reader is the signed-in owner, or their agent, and may decide it as owner. */
  overridable?: true;
  criteria: string[];
  formatVersion: 2;
  snapshotHash: string;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  claimId: string | null;
  claimGeneration: number;
  recovery: {
    eventId: number;
    previousActorId: string;
    previousClaimId: string | null;
    reason: string;
  } | null;
  verdict: Verdict | null;
  /** Explicit return route chosen and validated by the owning domain, when applicable. */
  returnTo?: string;
  notes: string | null;
  synopsis: string | null;
  findings: ReviewFinding[];
  evidence: Data;
  createdAt: string;
}
