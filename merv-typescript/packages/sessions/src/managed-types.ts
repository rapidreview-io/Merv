/** Types of the managed-runner binding, kept free of runtime imports for the public type module. */
import type { DelegationSource, Transaction } from '@merv/contracts';
import type { RunnerPlatform, Session } from './types.js';

export interface ManagedRunnerBindingIdentity {
  /** The one workflow instance this work host serves, each step in a fresh session. */
  workInstanceId: string;
  /** Per-phase cap, independent of the host deadline. */
  stepSeconds: number;
  allocationId: string;
  epoch: number;
  source: DelegationSource;
  runtimeProfileId: string;
  platform: RunnerPlatform;
  capabilities: string[];
  expiresAt: string;
}
export type ManagedRunnerValidator = {
  current(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean>;
  admits(allocationId: string, epoch: number, tx: Transaction): Promise<boolean>;
  /** Whether its last look rented machines for this project's automatic work. */
  serves(projectId: string): boolean;
  /** Trusted phase directors; host registration and billing remain under its original source. */
  assignmentSources(
    binding: ManagedRunnerBindingIdentity,
    tx: Transaction,
  ): Promise<DelegationSource[]>;
  /** A machine no longer current because a release retired its image, not for any fault. */
  retired(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean>;
  /** Whether this machine's image brokers Hugging Face downloads; without it, none does. */
  huggingFace?(binding: ManagedRunnerBindingIdentity): boolean;
  /**
   * When the person this machine's work is charged to can spend no more model tokens today, the
   * moment that ends; else null. The validator's budget, which Sessions only reads: before it
   * offers the machine work, and when one of its visits fails.
   */
  modelBudget?(
    binding: ManagedRunnerBindingIdentity,
    tx: Transaction,
  ): Promise<{ resetsAt: string } | null>;
};
export type ManagedEnrollmentInput = Omit<ManagedRunnerBindingIdentity, 'capabilities'> & {
  capabilities?: string[];
};
/** A session a managed runner holds: live, or closed by its own handoff. */
export interface ManagedBoundSession {
  sessionId: string;
  projectId: string;
  /** The Fleet allocation whose machine runs it. */
  allocationId: string;
  /** Its hard deadline, or its allocation's end when that comes first. */
  expiresAt: string;
  /** When it closed by its own handoff; absent while it is live. */
  handedOffAt?: string;
  /** An inquiry visit's asker, whose model tokens it spends rather than the machine's payer's. */
  inquiry?: { id: string; asker: DelegationSource };
  /** The session's own model tokens (`Session.tokenBudget`), which each call is charged to. */
  tokenBudget?: number;
}
export interface ManagedRunnerInspection {
  runnerId: string | null;
  /** After this no runner can enroll on the allocation. */
  enrollmentExpiresAt: string;
  session: {
    id: string;
    instanceId: string;
    expectedRevision: number;
    status: 'offered' | 'active' | 'released' | 'expired';
    closedAt: string | null;
    outcome: Session['outcome'];
    releaseAcknowledged: boolean;
    /** A final output the runner still owes: the workspace result, or a transcript declared
     *  under 30 minutes ago. */
    capturePending: boolean;
  } | null;
}
export interface ManagedBindingRow {
  work_instance_id: string | null;
  step_seconds: number | null;
  allocation_id: string;
  epoch: number;
  project_id: string;
  source_json: string;
  source_hash: string;
  runtime_profile_id: string;
  platform_json: string;
  capabilities_json: string;
  enrollment_hash: string;
  enrollment_expires_at: string;
  control_hash: string;
  worker_nonce_hash: string | null;
  control_expires_at: string;
  runner_id: string | null;
  bound_session_id: string | null;
  runner_released_at: string | null;
  created_at: string;
}
