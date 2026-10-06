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

/** A move as history records it, and how many times the instance made it. */
export type WorkflowTransitionCount = Pick<
  WorkflowHistoryEntry,
  'action' | 'fromState' | 'toState'
> & {
  count: number;
};

export type Role = 'operator' | 'producer' | 'reviewer' | 'reader';
/**
 * Checkout intent only. The base names an execution reference, which workspace preparation
 * resolves to an exact commit. `driver` names the workspace driver that prepares the checkout,
 * opaque to everything but the runner and the plugin that owns the driver.
 */
export type WorkflowWorkspacePolicy =
  | { mode: 'none' }
  | {
      mode: 'ephemeral';
      namespace: string;
      base: `reference:${string}`;
      retain: boolean;
      driver: string;
    }
  | {
      mode: 'persistent';
      namespace: string;
      base: `reference:${string}`;
      retain: boolean;
      driver: string;
      /** Always false. Kept only because the pinned fingerprints of registered versions hold them. */
      perBase: false;
      advancesCentral: false;
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
  /** When the instance last changed revision: how long this step has been waiting. */
  updatedAt: string;
}
