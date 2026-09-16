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
}
