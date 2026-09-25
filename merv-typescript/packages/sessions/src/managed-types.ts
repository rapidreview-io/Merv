/** Types of the managed-runner binding, kept free of runtime imports for the public type module. */
import type { DelegationSource, Transaction } from '@merv/contracts';
import type { RunnerPlatform, Session } from './types.js';

export interface ManagedRunnerBindingIdentity {
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
  serves?(projectId: string): boolean;
  /** A machine no longer current because a release retired its image, not for any fault. */
  retired?(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean>;
};
export type ManagedEnrollmentInput = Omit<ManagedRunnerBindingIdentity, 'capabilities'> & {
  capabilities?: string[];
};
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
    capturePending: boolean;
  } | null;
}
export interface ManagedBindingRow {
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
