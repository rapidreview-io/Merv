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
  approval?: {
    candidateSetHash: string;
    decisionManifestHash: string;
    integrationBase: string;
    certificateHash: string;
    acceptanceHash: string;
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
