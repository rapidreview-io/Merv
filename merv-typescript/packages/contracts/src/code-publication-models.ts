import type { GitHubPullRequest } from './github-models.js';

export interface CodePublication {
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
   * The sealed publication envelope. A reviewed consolidation and a unit accepted to publish
   * fill the same fields, so the pull request, the approval status and the human-only merge
   * have one thing to check whichever opened the publication. The reviewed head and tree are
   * not repeated here: this row already carries them, and it is immutable.
   */
  approval?: {
    /**
     * Absent on every envelope sealed before units could publish, which record_json makes
     * immutable: no source means a consolidation, and that is how a reader must take it.
     */
    source?: 'consolidation' | 'unit';
    integrationBase: string;
    /** The review's pinned provenance; null where the passing review carried none. */
    certificateHash: string | null;
    acceptanceHash: string;
    /** A consolidation's own frozen inputs. */
    candidateSetHash?: string;
    decisionManifestHash?: string;
  };
  stale?: boolean;
  successor?: string | null;
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
