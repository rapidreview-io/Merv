import type { Json, Transaction, WorkflowExecutionReferences } from '@merv/contracts';

export interface NativeMachineReads {
  list(projectId: string): Promise<Json[]>;
  record(projectId: string, id: string): Promise<Json | null>;
}

export type NativeWorkKind = 'task' | 'experiment';
export type NativeComputeProfile = 'execute' | 'check';

/** Server capabilities. Workflow owners decide research authority; these calls only
 * pin it and queue native reconciliation in their existing database transaction. */
export interface NativeSandboxWork {
  guidance(profile: NativeComputeProfile): string;
  connected(projectId: string, tx?: Transaction): Promise<boolean>;
  pin(projectId: string, kind: NativeWorkKind, workId: string, tx: Transaction): Promise<void>;
  references(
    projectId: string,
    kind: NativeWorkKind,
    workId: string,
    attempt: string,
    profile: NativeComputeProfile,
    tx: Transaction,
  ): Promise<WorkflowExecutionReferences>;
  transition(
    projectId: string,
    kind: NativeWorkKind,
    workId: string,
    change: { attempt?: string; closed?: boolean },
    tx: Transaction,
  ): Promise<void>;
  /** Queue assignment access revocation, including credentials still being issued. */
  revokeAssignment(leaseId: string, tx: Transaction): Promise<void>;
  /** Only collections verified and registered by this work's evidence bridge. */
  artifactIds(
    projectId: string,
    kind: NativeWorkKind,
    workId: string,
    tx: Transaction,
  ): Promise<string[]>;
}

export interface NativeSandboxesConfig {
  applicationId: string;
  applicationSecretEnv: string;
  encryptionKeyEnv: string;
  publicOrigin: string;
  managed?: { namespace: string; tokenEnv: string };
}

export interface NativeConnectionStatus {
  url: string | null;
  available: boolean;
  connected: boolean;
  connectionId: string | null;
  accountId: string | null;
  memberId: string | null;
  connectedAt: string | null;
  funding?: 'managed' | 'personal';
  managedAvailable?: boolean;
  allowance?: Json;
}
