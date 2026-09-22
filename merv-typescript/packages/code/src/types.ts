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
  CodeAcceptedSince,
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

/** Opaque, immutable inputs frozen before a consolidation chooses its retained frontier. */
export interface CodeCandidateSet {
  formatVersion: 1;
  projectId: string;
  repositoryId: string;
  integrationBase: string;
  candidates: { unitId: string; acceptanceHash: string; reference: string | null }[];
  hash: string;
}
export interface CodeCandidateDecision {
  unitId: string;
  decision: 'retain' | 'adapt' | 'drop' | 'no_code';
  replacementUnitId?: string;
  rationale: string;
}
export interface CodeReconciliation {
  unitId: string;
  retainedUnitId: string;
  rationale: string;
}
export interface CodeDecisionManifest {
  formatVersion: 1;
  candidateSetHash: string;
  decisionsHash: string;
  contributors: { references: string[]; sourceHash: string; excludedActorIds: string[] };
  decisions: CodeCandidateDecision[];
  reconciliations: CodeReconciliation[];
  frontier: string[];
  conflicts: (
    | { kind: 'carried'; unitId: string; retainedUnitId: string; message: string }
    | { kind: 'on_main'; unitId: string; message: string }
  )[];
  hash: string;
}
export interface PublicationOwner {
  check(caller: Caller, instanceId: string, reference: string, tx: Transaction): Promise<void>;
  /**
   * The consolidations of this project that still hold a frozen candidate set. The set names
   * the repository it froze under and is re-validated against that same frozen value, so only
   * its owner can say whether one is outstanding.
   */
  frozen(projectId: string, tx: Transaction): Promise<string[]>;
  apply(
    caller: Caller,
    instanceId: string,
    reference: string,
    outcome: 'stale' | 'resume' | 'published',
    tx: Transaction,
  ): Promise<number>;
}
export interface CodeConsolidations {
  publicationReferences(
    caller: Caller,
    unitId: string,
    tx: Transaction,
  ): Promise<import('@merv/contracts').WorkflowExecutionReferences>;
  registerPublicationOwner(owner: PublicationOwner): () => void;
  controlPublication(caller: Caller, input: unknown): Promise<unknown>;
  releasePublication(caller: Caller, input: unknown): Promise<unknown>;

  freezeCandidates(caller: Caller, roots: string[], tx: Transaction): Promise<CodeCandidateSet>;
  inspectCandidates(
    caller: Caller,
    frozen: CodeCandidateSet,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[],
  ): Promise<CodeDecisionManifest>;
  verifyCandidates(
    caller: Caller,
    frozen: CodeCandidateSet,
    decisions: CodeCandidateDecision[],
    reconciliations: CodeReconciliation[],
    manifest: CodeDecisionManifest | undefined,
    tx: Transaction,
  ): Promise<void>;
}

export interface CodeCommands {
  merge(
    caller: Caller,
    input: import('@merv/contracts').CodeMergeInput,
  ): Promise<CodeCommandRecord>;
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
  /** Owners may freeze a frontier instead of deriving from every scheduling prerequisite. */
  declareUnit(
    caller: Caller,
    unitId: string,
    tx: Transaction,
    baseReference?: string,
    derivationInputs?: string[],
  ): Promise<CodeUnit>;
  acceptUnit(
    caller: Caller,
    input: CodeUnitAcceptInput,
    tx: Transaction,
  ): Promise<CodeUnitAcceptance>;
  /**
   * Records, once, that this unit's accepted code goes to main. It is declared before the
   * first lease, because main joins the unit's base at derivation and a pin is immutable.
   */
  publishOnAcceptance(
    caller: Caller,
    input: { unitId: string },
    tx: Transaction,
  ): Promise<CodeUnit>;
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
  /**
   * Whether Code keeps this project's history in its own repository. It never turns false
   * again, and it is read from the database alone, so an owner may ask inside a create.
   */
  hosted(caller: Caller, tx: Transaction): Promise<boolean>;
  status(caller: Caller): Promise<CodeProjectStatus>;
}
/** The writer fence of a unit; like CodeUnits, reached only inside an owner's transaction. */
export interface CodeWriters {
  /**
   * Only an owner's lease acquisition calls this, right after pinBase and for a writable
   * checkout that Code's driver prepares: the lease becomes the unit's next writer generation.
   */
  reserveWriter(
    caller: Caller,
    input: { unitId: string; leaseId: string },
    tx: Transaction,
  ): Promise<import('@merv/contracts').CodeWriterStatus>;
  /** Whether a new writer could be leased now; a pure read, like baseStatus. */
  writerStatus(
    caller: Caller,
    unitId: string,
    tx: Transaction,
  ): Promise<import('@merv/contracts').CodeWriterStatus>;
}
/** The project's repository on the server's disk; refused where the server keeps none. */
export interface CodeRepositoryControls {
  /**
   * The accepted units of this project whose code the current main does not contain yet.
   * It asks Git, so it lives with the repository rather than with the units, and takes no
   * transaction: Git never runs inside one, and the candidate scan is a read of its own.
   */
  acceptedSince(caller: Caller): Promise<CodeAcceptedSince>;
  controlBase(
    caller: Caller,
    input: Omit<import('@merv/contracts').CodeBaseControlInput, 'action'> & {
      /** Contracts publishes the first five; release and repair are Code's own routes back. */
      action: import('@merv/contracts').CodeBaseControlInput['action'] | 'release' | 'repair';
    },
  ): Promise<import('@merv/contracts').CodeBaseRecord>;
  importRepository(
    caller: Caller,
    input: import('@merv/contracts').CodeRepositoryImportInput,
  ): Promise<import('@merv/contracts').CodeStoreOperation>;
  /** Change the repository identity of a hosted project, after proving Code holds its history. */
  rebindRepository(
    caller: Caller,
    input: import('@merv/contracts').CodeRepositoryRebindInput,
  ): Promise<import('@merv/contracts').CodeStoreOperation>;
  configureRepository(
    caller: Caller,
    input: import('@merv/contracts').CodeRepositoryConfigureInput,
  ): Promise<import('@merv/contracts').CodeStoreLimits>;
  fenceUnit(
    caller: Caller,
    input: import('@merv/contracts').CodeUnitFenceInput,
  ): Promise<import('@merv/contracts').CodeWriterStatus>;
  /**
   * Take one verified copy of this project's repository and of the database to object
   * storage now, instead of waiting for the timer. A human or an operator key only.
   */
  runBackup(caller: Caller, input: unknown): Promise<import('@merv/contracts').CodeBackupStatus>;
  /** Put a ref publication that waits for an operator back in the queue; it never forces. */
  retryMirror(
    caller: Caller,
    input: import('@merv/contracts').CodeMirrorRetryInput,
  ): Promise<import('@merv/contracts').CodeMirrorStatus>;
}
export interface Code
  extends
    CodeCommands,
    CodeConsolidations,
    CodeProposals,
    CodeCaptures,
    CodeUnits,
    CodeWriters,
    CodeRepositoryControls,
    CodePublicationApi {
  bindServiceTasks(provider: import('@merv/contracts').ServiceTaskCreator): () => void;
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
