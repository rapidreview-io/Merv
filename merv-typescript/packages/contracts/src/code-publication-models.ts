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
  merge: {
    requestId: string;
    actorId: string;
    expectedBase: string;
    requestedAt: string;
    commitSha: string | null;
  } | null;
}
