import type { Caller, DelegationSource, Transaction } from '@merv/contracts';
import type { SandboxRuntimeHandle } from '@merv/sandboxes/types';

export type FleetPhase =
  | 'queued'
  | 'provisioning'
  | 'launching'
  | 'starting'
  | 'running'
  | 'uncertain'
  | 'releasing'
  | 'released';
export type FleetIntent = 'run' | 'drain' | 'stop';
export interface FleetAllocation {
  id: string;
  projectId: string;
  source: DelegationSource;
  owner: { kind: string; id: string };
  requestId: string;
  profileId: string;
  /** One allocation never changes epoch or rents a successor machine. */
  epoch: number;
  phase: FleetPhase;
  intent: FleetIntent;
  runtime: SandboxRuntimeHandle | null;
  /** Durable intent written before create; false proves no provider call has begun. */
  createAttempted: boolean;
  createdAt: string;
  deadlineAt: string;
  updatedAt: string;
  retryAt: string | null;
  failures: number;
  error: string | null;
}
export interface FleetRequest {
  requestId: string;
  owner: { kind: string; id: string };
}
export interface FleetConfig {
  /** Deployment opt-in; keep false until the actual provider gates pass. */
  enabled?: boolean;
  globalLimit?: number;
  projectLimit?: number;
  pollIntervalMs?: number;
  allocationTimeoutSeconds?: number;
}
/** Trusted server adapter, never an agent-supplied command or harness implementation.
 * Workflow and chat own authority, enrollment and completion. Fleet owns machines only.
 */
export interface FleetOwner {
  /** Read-only transactional check; false fences new authority and starts cleanup. */
  valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean>;
  /** Stable bytes for this allocation/epoch across retries, never persisted by Fleet. */
  bootstrap(allocation: FleetAllocation): Promise<string>;
  /** finished means all required capture/checkpoint work has been retained. */
  observe(allocation: FleetAllocation): Promise<'starting' | 'running' | 'finished'>;
}
export interface Fleet {
  registerOwner(kind: string, owner: FleetOwner): () => void;
  request(caller: Caller, input: FleetRequest, tx?: Transaction): Promise<FleetAllocation>;
  inspect(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  list(caller: Caller): Promise<FleetAllocation[]>;
  cancel(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  drain(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Sessions must call this inside the same transaction that enrolls or claims work. */
  admits(id: string, epoch: number, tx: Transaction): Promise<boolean>;
  tick(): Promise<void>;
}
declare module 'cordis' {
  interface Context {
    fleet: Fleet;
  }
}
