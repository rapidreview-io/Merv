import type { Data } from './data.js';

/** Portable workflow record, shared by domain services and browser read models. */
export interface WorkflowSnapshot {
  id: string;
  projectId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  data: Data;
  createdAt: string;
  updatedAt: string;
}
