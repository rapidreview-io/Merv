import type { Artifact } from '@merv/contracts/types';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import type { PaperRevision } from '@merv/paper/models';
import type { CodeUnitPublication } from '@merv/code-work/models';

export interface ResearchCreate {
  name: string;
  /** Existing project work selected by the coordinator, not automatically invented. */
  dependsOn?: string[];
  /**
   * A finished or ended cycle this one follows. Its digest is composed now if it has none. A
   * cycle is followed by at most one other.
   */
  previousCycleId?: string;
  /** Advance the cycle without manual advances as its work ends. Opt-in. */
  automatic?: boolean;
  requestId: string;
}
/** What every command on an existing cycle names: the cycle, the revision it read, the request. */
export interface ResearchCommandBase {
  researchId: string;
  expectedRevision: number;
  requestId: string;
}
export interface ResearchAdvance extends ResearchCommandBase {
  /** Inject a fresh consolidation task after the current one ended without acceptance. */
  retryIntegration?: boolean;
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
export interface ResearchAutomation {
  /** Why automatic progress is waiting or has stopped; no source credentials are exposed. */
  blocker: { code: string; message: string } | null;
}
export interface ResearchRecord {
  id: string;
  projectId: string;
  ownerId: string;
  automation?: ResearchAutomation | null;
  name: string;
  createdAt: string;
  researchDependencies: string[];
  /** How many of researchDependencies ended in success, of how many. */
  progress: { settled: number; total: number };
  workflow: WorkflowSnapshot;
  /** Exact definition accepted on leaving the defining stage. */
  problem: PaperRevision | null;
  /** The consolidation tasks this cycle injected, oldest first; a stale publication appends a successor. */
  integrations: string[];
  /** The cycle that follows this one, if somebody named it so. */
  successorId: string | null;
  /** The cycle this one follows; null for a first cycle. */
  previousCycleId: string | null;
  /** The immutable artifact that records what this cycle did; null until it has been composed. */
  digest: Artifact | null;
  /** Whether this reader may move the cycle (advance, end, replan), as Research decides it. */
  writable?: boolean;
}
/** An immutable artifact named exactly, so a reader can tell it was not replaced. */
export interface ResearchArtifactRef {
  id: string;
  title: string;
  hash: string;
}
/**
 * What a cycle did, composed by the server from records when the cycle finished or was ended,
 * and kept as one immutable application/json artifact. It names no actor, so handing it to a
 * later worker or reviewer says nothing about who did the earlier work. Format 1 also named the
 * cycle's reflection and the alternatives its plan rejected.
 */
export interface ResearchDigest {
  formatVersion: 2;
  cycle: {
    id: string;
    name: string;
    outcome: 'complete' | 'abandoned' | 'failed';
    /** Why the cycle was ended; null for a completed cycle and for one ended before reasons were kept. */
    reason: string | null;
    createdAt: string;
    composedAt: string;
    /** Composed after the cycle finished, so work reads as it was then, not at the end. */
    late: boolean;
  };
  previousCycleId: string | null;
  /** The consolidation task that took the cycle's accepted code to main, and where its publication stood. */
  integration: { taskId: string; publication: CodeUnitPublication['state'] | null } | null;
  experiments: {
    id: string;
    name: string;
    state: string;
    attempts: number;
    submissions: number;
    conclusion: string | null;
  }[];
  tasks: { id: string; title: string; state: string }[];
  /** Selected work that failed or was abandoned. */
  dropped: string[];
  /** Selected work still unfinished. */
  carriedOver: string[];
  /** Entries left out to keep the digest within its bound. */
  omitted: number;
}
export interface ResearchLineageEntry {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  previousCycleId: string | null;
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
/**
 * A choice a cycle's gate asks of its owner, as Research names it on its Cycles row
 * (`view.answers`): where research.advance is `refused` with the code `name`, or an automatic run
 * `stopped` on the code `name`, the page offers these moves in place of the plain one. The first
 * that applies, and whose moves the page can all make, is the one drawn. While a run is
 * automatic only its `stopped` answers and ways elsewhere are drawn: any other move would race
 * the run.
 */
export type ResearchAnswer = {
  when: 'refused' | 'stopped';
  name: string;
  moves: ResearchMove[];
};
/**
 * One move of an answer: a call of `tool` (research.write advance where unnamed, and otherwise only
 * where the gate offers it) sending `input`, or the way to the page of the row whose view is
 * `row`.
 */
export type ResearchMove = {
  label: string;
  tool?: 'research.write:end';
  input?: { [field: string]: string | boolean };
  row?: string;
};
