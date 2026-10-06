import type { GitHubPullRequest } from './github-models.js';

/**
 * Merv's one word for where a publication stands, which also says where its verdict stands:
 * integrated into Merv main or merged on GitHub, blocked by an error, returned by its review,
 * closed unmerged, ready to merge, a draft, or not opened yet.
 */
export type CodePublicationState =
  'integrated' | 'blocked' | 'merged' | 'returned' | 'closed' | 'ready' | 'draft' | 'pending';
export interface CodePublication {
  state: CodePublicationState;
  /** Frozen when the reviewed work is sealed; linking GitHub never retargets it. */
  destination?: 'local' | 'github';
  proposalId: string;
  instanceId: string;
  manifestHash: string;
  repository: string;
  repositoryId: number;
  connectionRevision: number;
  branch: string;
  baseBranch: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
  title: string;
  createdAt: string;
  review: {
    id: string;
    actorId: string;
    verdict: 'pass' | 'needs_changes' | 'fail';
    recordedAt: string;
  } | null;
  pull: GitHubPullRequest | null;
  lastError: string | null;
  /**
   * The sealed publication envelope of an accepted unit, so the pull request, the approval
   * status and the human-only merge have one thing to check. The reviewed head and tree are
   * not repeated here: this row already carries them, and it is immutable.
   */
  approval?: {
    /** Who opened the publication: always `unit`, an accepted unit of work. */
    source?: string;
    integrationBase: string;
    /** The review's pinned provenance; null where the passing review carried none. */
    certificateHash: string | null;
    acceptanceHash: string;
  };
  stale?: boolean;
  verified?: boolean;
  incident?: {
    commitSha: string | null;
    expectedHead: string;
    expectedTree: string;
    tree?: string;
    parents?: string[];
    at: string;
  } | null;
  merge: {
    requestId: string;
    actorId: string;
    expectedBase: string;
    requestedAt: string;
    commitSha: string | null;
    mainParent?: string;
  } | null;
}

export interface CodePublicationControls {
  disabled?: boolean;
  visibility?: { incomplete: boolean; evidence: unknown; observedAt: string };
  acknowledgement?: { actorId: string; reason: string; at: string };
  canary?: {
    bindingHash: string;
    staleMerged: boolean;
    actorId: string;
    reason: string;
    at: string;
  };
}
