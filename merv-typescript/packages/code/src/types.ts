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
  CodePublicationApi,
  CodeBasePin,
  CodeBaseStatus,
  CodeLocalBindInput,
  CodeProjectBinding,
  CodeProjectStatus,
  CodeUnit,
  CodeUnitAcceptance,
  CodeUnitAcceptInput,
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
  /**
   * Present only for a final capture whose runner attached a checkout: the commit that checkout
   * was prepared from. Sessions fixed it at attach, so it proves where the session worked even
   * before — or without — a final result.
   */
  attachedBaseOid?: string;
  observedAt: string | null;
  eventId: number | null;
  error?: string;
}
export interface CodeCaptures {
  /** Historical, project-scoped immutable facts; never renders context or admits a new command. */
  capture(caller: Caller, ref: CodeCaptureRef, tx?: Transaction): Promise<CodeCapture>;
}
/**
 * Units, their acceptances and the project's local binding. The transaction-only methods are
 * the owner contract: no tool route reaches them, and the owner has already checked authority.
 */
export interface CodeUnits {
  declareUnit(caller: Caller, unitId: string, tx: Transaction): Promise<CodeUnit>;
  acceptUnit(
    caller: Caller,
    input: CodeUnitAcceptInput,
    tx: Transaction,
  ): Promise<CodeUnitAcceptance>;
  /** What a lease would find now; a pure read, safe under every admission and candidate scan. */
  baseStatus(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBaseStatus>;
  /** Only an owner's lease acquisition calls this: the base is fixed with the lease it serves. */
  pinBase(
    caller: Caller,
    input: { unitId: string; leaseId: string },
    tx: Transaction,
  ): Promise<CodeBasePin>;
  /** The pin alone, never a derivation, for an owner's references(). */
  basePin(caller: Caller, unitId: string, tx: Transaction): Promise<CodeBasePin | null>;
  bindLocal(caller: Caller, input: CodeLocalBindInput): Promise<CodeProjectBinding>;
  unit(caller: Caller, unitId: string, tx?: Transaction): Promise<CodeUnit>;
  status(caller: Caller): Promise<CodeProjectStatus>;
}
/** The project's repository on the server's disk; refused where the server keeps none. */
export interface CodeRepositoryControls {
  importRepository(
    caller: Caller,
    input: import('@merv/contracts').CodeRepositoryImportInput,
  ): Promise<import('@merv/contracts').CodeStoreOperation>;
  configureRepository(
    caller: Caller,
    input: import('@merv/contracts').CodeRepositoryConfigureInput,
  ): Promise<import('@merv/contracts').CodeStoreLimits>;
}
export interface Code
  extends
    CodeCommands,
    CodeProposals,
    CodeCaptures,
    CodeUnits,
    CodeRepositoryControls,
    CodePublicationApi {
  readonly github: import('@merv/contracts').CodeGitHub;
  transportGrant(
    caller: Caller,
    input: import('@merv/contracts').CodeTransportInput,
  ): Promise<import('@merv/contracts').CodeTransportGrant>;
  verifyTransport(
    caller: Caller,
    input: import('@merv/contracts').CodeTransportInput,
  ): Promise<{ verified: boolean }>;
  /** Domain-only hook; no HTTP or MCP route can create an independent-review verdict. */
  recordPublicationReview(
    caller: Caller,
    proposal: CodeProposal,
    reviewId: string,
    verdict: 'pass' | 'needs_changes' | 'fail',
    tx: Transaction,
  ): Promise<void>;
}
declare module 'cordis' {
  interface Context {
    code: Code;
  }
}
