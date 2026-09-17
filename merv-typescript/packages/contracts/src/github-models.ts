export interface GitHubRepositoryInput {
  expectedRevision: number;
  installationId: number | null;
  repositoryId: number | null;
}
export interface GitHubRepository {
  id: number;
  installationId: number;
  fullName: string;
  url: string;
  defaultBranch: string | null;
  private: boolean;
}
export interface GitHubStatus {
  configured: boolean;
  revision: number;
  status: 'disconnected' | 'connected' | 'needs_reconnect' | 'refreshing';
  user: { id: number; login: string } | null;
  repository: GitHubRepository | null;
  canManage: boolean;
  canBrowse: boolean;
  installUrl: string | null;
  automationConfigured: boolean;
  automation: 'off' | 'read' | 'write';
  baseBranch: string | null;
}

export interface GitHubAutomationInput {
  expectedRevision: number;
  mode: 'off' | 'read' | 'write';
  baseBranch: string | null;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}
export interface GitHubCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  url: string;
}
export interface GitHubPullRequest {
  id: number;
  number: number;
  nodeId: string;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  head: { ref: string; sha: string; repositoryId: number | null };
  base: { ref: string; sha: string; repositoryId: number };
  merged: boolean;
  mergeCommitSha: string | null;
  mergeable: boolean | null;
  mergeState: string;
  updatedAt: string;
}
export interface GitHubChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** GitHub omits patches for binary files and large diffs. Never interpret omission as no change. */
  patch: string | null;
}
export interface GitHubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}
export interface GitHubReview {
  id: number;
  user: string;
  state: string;
  commitSha: string;
  body: string;
  submittedAt: string | null;
}
export interface GitHubPullDetails {
  pull: GitHubPullRequest;
  files: GitHubChangedFile[];
  commits: GitHubCommit[];
  checks: GitHubCheck[];
  reviews: GitHubReview[];
  commitStatus: 'pending' | 'success' | 'failure';
  statusCount: number;
}
