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

/** One recorded transition: the durable account of which edge was taken, by whom. */
export interface WorkflowHistoryEntry {
  instanceId: string;
  revision: number;
  action: string;
  actorId: string;
  requestId: string;
  fromState: string | null;
  toState: string;
  data: Data;
  createdAt: string;
}
