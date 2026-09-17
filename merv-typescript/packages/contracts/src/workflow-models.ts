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

export type Role = 'operator' | 'producer' | 'reviewer' | 'reader';
export type WorkflowWorkspaceBase = 'central' | `reference:${string}`;
/** Checkout intent only. References are resolved and Git facts verified by workspace preparation. */
export type WorkflowWorkspacePolicy =
  | { mode: 'none' }
  | {
      mode: 'ephemeral';
      namespace: string;
      base: WorkflowWorkspaceBase;
      retain: boolean;
    }
  | {
      mode: 'persistent';
      namespace: string;
      base: WorkflowWorkspaceBase;
      perBase: boolean;
      retain: boolean;
      advancesCentral: boolean;
    };
export interface WorkflowExecutionTarget {
  instanceId: string;
  expectedRevision: number;
}
/** Source-authorized scheduling hint; selecting it still requires an atomic offerLease. */
export interface WorkflowDispatchCandidate extends WorkflowExecutionTarget {
  projectId: string;
  workflow: string;
  version: number;
  state: string;
  role: Role;
  readOnly: boolean;
  label: string;
  policyHash: string;
  registrationId: string;
  workspace: WorkflowWorkspacePolicy;
}
