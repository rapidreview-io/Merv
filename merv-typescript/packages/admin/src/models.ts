export interface AdminIdentity {
  issuer: string;
  subject: string;
  label?: string;
}
export interface AdminExperiment {
  id: string;
  projectId: string;
  project: string;
  title: string;
  source: 'project' | 'standalone';
  customer: string;
  customerKey: string;
  state: string;
  updatedAt: string;
  createdAt: string;
  attempt: number;
  paid: boolean | null;
  activity: string;
  sessions: number;
  requestId?: string;
}
export interface AdminUser {
  key: string;
  label: string;
  experiments: number;
  active: number;
}
export interface AdminOverview {
  users: AdminUser[];
  at: string;
  rows: AdminExperiment[];
  truncated: boolean;
  unavailable: string[];
}
