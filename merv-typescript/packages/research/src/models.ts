import type { Artifact, WorkflowSnapshot } from '@merv/contracts/types';
import type { PaperRevision } from '@merv/paper/models';

export interface ResearchCreate {
  name: string;
  /** Existing project work selected by the coordinator, not automatically invented. */
  dependsOn?: string[];
  /** New cycles: none finishes after reflection; git adds implementation and review. */
  consolidationWorkspace?: 'none' | 'git';
  consolidationDependsOn?: string[];
  /**
   * A finished or ended cycle this one follows. Its digest is composed now if it has none, and
   * this cycle's reflection receives it. A cycle is followed by at most one other.
   */
  previousCycleId?: string;
  requestId: string;
}
/** What every command on an existing cycle names: the cycle, the revision it read, the request. */
export interface ResearchCommandBase {
  researchId: string;
  expectedRevision: number;
  requestId: string;
}
export interface ResearchAdvance extends ResearchCommandBase {
  /**
   * The owner's answer to an approved plan that continues, on the advance that completes the
   * cycle: create its work and the next cycle, or complete without them. Required then, so
   * no caller creates agent-planned work without saying so; ignored everywhere else.
   */
  nextWave?: 'create' | 'skip';
}
/** Ending a cycle that cannot reach an answer. Terminal; the reason is recorded. */
export interface ResearchEnd extends ResearchCommandBase {
  outcome: 'abandoned' | 'failed';
  reason: string;
}
/** The cycle's selected work, reselected whole: what is missing is added, what is left out is dropped. */
export interface ResearchReplan extends ResearchCommandBase {
  dependsOn: string[];
}
/** Where a cycle opened from an approved reflection plan came from, pinned when it was created. */
export interface ResearchOrigin {
  /** The cycle whose completion created this one. */
  researchId: string;
  reflectionId: string;
  reviewId: string;
  changeSpec: { id: string; hash: string };
  /** The plan's items as the records they became. */
  items: { key: string; kind: 'task' | 'experiment'; id: string }[];
  carriedOver: string[];
}
export interface ResearchRecord {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  createdAt: string;
  researchDependencies: string[];
  consolidationWorkspace: 'none' | 'git';
  consolidationDependencies: string[];
  workflow: WorkflowSnapshot;
  /** Exact definition accepted on leaving the defining stage. */
  problem: PaperRevision | null;
  reflectionId: string | null;
  consolidationId: string | null;
  /** Null for a cycle somebody created by hand. */
  origin: ResearchOrigin | null;
  /** The cycle this one's approved plan opened, if it did. */
  successorId: string | null;
  /** The cycle this one follows, whether a plan opened it or somebody named it; null for a first cycle. */
  previousCycleId: string | null;
  /** The immutable artifact that records what this cycle decided; null until it has been composed. */
  digest: Artifact | null;
}
/** An immutable artifact named exactly, so a reader can tell it was not replaced. */
export interface ResearchArtifactRef {
  id: string;
  title: string;
  hash: string;
}
/**
 * What a cycle decided, composed by the server from records when the cycle finished or was
 * ended, and kept as one immutable application/json artifact. It names no actor, so handing it
 * to a later worker or reviewer says nothing about who did the earlier work. Reports and change
 * specifications are named by ID and hash, never inlined: the records stay authoritative.
 */
export interface ResearchDigest {
  formatVersion: 1;
  cycle: {
    id: string;
    name: string;
    outcome: 'complete' | 'abandoned' | 'failed';
    /** Why the cycle was ended; null for a completed cycle and for one ended before reasons were kept. */
    reason: string | null;
    createdAt: string;
    composedAt: string;
    /** Composed after the cycle finished, so claims and work read as they were then, not at the end. */
    late: boolean;
  };
  previousCycleId: string | null;
  reflection: {
    id: string;
    reviewId: string;
    approvedAt: string;
    report: ResearchArtifactRef;
    changeSpec: ResearchArtifactRef;
    /** What a structured change specification decided comes next; null for a text one. */
    next: {
      decision: 'continue' | 'stop';
      /** The stop reason; null when the plan continues. */
      reason: string | null;
      rationale: string;
    } | null;
  } | null;
  consolidation: { id: string; reviewId: string; report: ResearchArtifactRef } | null;
  experiments: {
    id: string;
    name: string;
    state: string;
    attempts: number;
    submissions: number;
    /** Historical only. */
    testedClaimIds?: string[];
    conclusion: string | null;
    /** The approved consolidation's decision for this experiment, when there was one. */
    decision: 'retain' | 'adapt' | 'drop' | 'no_code' | null;
    rationale: string | null;
  }[];
  tasks: { id: string; title: string; state: string }[];
  /** The claims the cycle's experiments tested. */
  claims?: {
    id: string;
    statement: string;
    status: string;
    confidence: string;
    testedBy: string[];
  }[];
  /** Selected work that failed or was abandoned, and experiments consolidation dropped. */
  dropped: string[];
  /** Selected work still unfinished, and experiments consolidation chose to adapt. */
  carriedOver: string[];
  /** Tested claims still draft or active: derived, not authored. */
  openQuestions?: { claimId: string; statement: string }[];
  /** Alternatives the approved structured plan weighed and turned down, so they are not proposed again unknowingly. */
  rejected: { title: string; reason: string }[];
  /** Entries left out to keep the digest within its bound. */
  omitted: number;
}
export interface ResearchLineageEntry {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  previousCycleId: string | null;
  reflectionId: string | null;
  consolidationId: string | null;
  digest: Artifact | null;
}
export interface ResearchLineage {
  researchId: string;
  /** Oldest first; the last entry is the cycle asked about. */
  cycles: ResearchLineageEntry[];
  /** True when the chain is longer than was walked. */
  truncated: boolean;
  successor: { id: string; name: string; state: string } | null;
}
