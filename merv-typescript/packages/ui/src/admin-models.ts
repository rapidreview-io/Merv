export interface AdminIdentity {
  issuer: string;
  subject: string;
}
export interface AdminExperiment {
  id: string;
  projectId: string;
  project: string;
  title: string;
  source: 'project' | 'standalone';
  customer: string;
  state: string;
  updatedAt: string;
  createdAt: string;
  attempt: number;
  paid: boolean | null;
  activity: string;
  sessions: number;
  requestId?: string;
}
export interface AdminOverview {
  at: string;
  rows: AdminExperiment[];
  truncated: boolean;
  unavailable: string[];
}
