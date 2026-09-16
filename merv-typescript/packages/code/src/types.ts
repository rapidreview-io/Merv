import type {
  Caller,
  CodeCommitInput,
  CodeCommandRecord,
  CodeCommitCommand,
  CodeCommandControl,
  CodeCommandCompletion,
  Artifact,
  Data,
  DelegationSource,
  Transaction,
  WorkflowDispatchAdmission,
  CodeCommitReceipt,
  SessionWorkspace,
} from '@merv/contracts';
import type {} from 'cordis';
import type { SessionObservationProvenance } from '@merv/sessions/types';

export interface CodeCommands {
  list(caller: Caller): Promise<CodeCommandRecord[]>;
  commit(caller: Caller, input: CodeCommitInput): Promise<CodeCommandRecord>;
  operation(caller: Caller, commandId: string): Promise<CodeCommandRecord>;
  nextCommand(caller: Caller, input: CodeCommandControl): Promise<CodeCommitCommand | null>;
  completeCommand(caller: Caller, input: CodeCommandCompletion): Promise<CodeCommandRecord>;
  close(): void;
}
export interface CodeProposalInput {
  commandId: string;
  summary: string;
  artifactIds: string[];
  /** Trusted program-selected inputs; every other artifact must be authored by this worker. */
  pinnedInputIds?: string[];
  /** Domain-owned provenance, supplied by the admitting program. */
  provenance?: Data;
  requestId: string;
}
export interface CodeProposal {
  id: string;
  projectId: string;
  instanceId: string;
  /** Immutable sequence within this project and workflow instance, starting at one. */
  revision: number;
  createdAt: string;
  producer: { actorId: string; sessionId: string; source: DelegationSource };
  workflow: {
    name: string;
    version: number;
    state: string;
    revision: number;
    policyHash: string;
    registrationId: string;
  };
  command: CodeCommitCommand;
  receipt: CodeCommitReceipt;
  summary: string;
  artifacts: Artifact[];
  pinnedInputIds: string[];
  provenance: Data;
  admission: WorkflowDispatchAdmission;
  manifestHash: string;
  manifestArtifact: Artifact;
}
export interface CodeProposals {
  /** Seal inside the actual program command's transaction and existing session invocation. */
  seal(
    caller: Caller,
    input: CodeProposalInput,
    admission: WorkflowDispatchAdmission,
    tx: Transaction,
  ): Promise<CodeProposal>;
  proposal(caller: Caller, proposalId: string, tx?: Transaction): Promise<CodeProposal>;
  /** Most recent 100 proposals in this project, optionally restricted to an instance. */
  proposals(caller: Caller, instanceId?: string, tx?: Transaction): Promise<CodeProposal[]>;
  close(): void;
}
import type { CodeCaptureRef } from '@merv/contracts/types';
export type { CodeCaptureRef } from '@merv/contracts/types';
export interface CodeCapture {
  ref: CodeCaptureRef;
  status: 'none' | 'pending' | 'ready' | 'failed';
  provenance: SessionObservationProvenance;
  workspace: SessionWorkspace | null;
  /** Present only for an exact interactive commit receipt. */
  parentOid?: string;
  observedAt: string | null;
  eventId: number | null;
  error?: string;
}
export interface CodeCaptures {
  /** Historical, project-scoped immutable facts; never renders context or admits a new command. */
  capture(caller: Caller, ref: CodeCaptureRef, tx?: Transaction): Promise<CodeCapture>;
}
export interface Code extends CodeCommands, CodeProposals, CodeCaptures {
  readonly github: import('@merv/contracts').CodeGitHub;
}
declare module 'cordis' {
  interface Context {
    code: Code;
  }
}
