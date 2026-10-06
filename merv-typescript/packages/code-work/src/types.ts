import type {
  Caller,
  CodeCommandRecord,
  CodeCommitCommand,
  CodeCommitInput,
  CodeLocalBindInput,
  CodeProjectBinding,
  GitHubPullDetails,
  RunningMark,
  RunningNode,
  RunningPanelPart,
  RunningSection,
  RunningSummary,
  SessionWorkspace,
  Transaction,
} from '@merv/contracts';
import type { SessionObservationProvenance } from '@merv/sessions/types';
import type {} from 'cordis';
import type {
  CodeAcceptedSince,
  CodeBasePin,
  CodeBaseStatus,
  CodeProjectStatus,
  CodeStoreLimits,
  CodeUnit,
  CodeUnitAcceptance,
  CodeUnitAcceptInput,
  CodePublication,
  CodeCaptureRef,
} from './models.js';

/** A project's check and admission lists, all restated on every call. */
export type CodeRepositoryConfigureInput = Omit<CodeStoreLimits, 'format'> & { requestId: string };
export interface CodePublicationMerge {
  proposalId: string;
  expectedHead: string;
  expectedBase: string;
  requestId: string;
}
export interface CodePublicationApi {
  publications(caller: Caller): Promise<CodePublication[]>;
  syncPublications(caller: Caller): Promise<CodePublication[]>;
  publicationDetails(
    caller: Caller,
    proposalId: string,
  ): Promise<{ publication: CodePublication; details: GitHubPullDetails | null }>;
  mergePublication(caller: Caller, input: CodePublicationMerge): Promise<CodePublication>;
}

export interface CodeCommands {
  merge(
    caller: Caller,
    input: import('@merv/contracts').CodeMergeInput,
  ): Promise<CodeCommandRecord>;
  list(caller: Caller): Promise<CodeCommandRecord[]>;
  commit(caller: Caller, input: CodeCommitInput): Promise<CodeCommandRecord>;
  operation(caller: Caller, commandId: string): Promise<CodeCommandRecord>;
  /** Each control parses its own input, so callers hand it the body they received. */
  nextCommand(caller: Caller, input: unknown): Promise<CodeCommitCommand | null>;
  completeCommand(caller: Caller, input: unknown): Promise<CodeCommandRecord>;
  close(): void;
}
export type { CodeCaptureRef } from './models.js';
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
/**
 * The writable session a capture must come from: one unit at one revision, in one state of
 * one of its workflow's versions and, where named, one session and actor.
 */
export interface CodeCaptureOrigin {
  unitId: string;
  revision: number;
  workflow: { name: string; versions: readonly number[]; state: string };
  sessionId?: string;
  actorId?: string;
}
/** A capture read against its origin; `foreign` when it came from anywhere else. */
export type CheckedCodeCapture =
  | { status: 'ready'; capture: CodeCapture & { workspace: SessionWorkspace } }
  | { status: 'foreign' | Exclude<CodeCapture['status'], 'ready'>; capture: CodeCapture };
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
  ): Promise<import('@merv/code/store/protocol').CodeWriterStatus>;
  /** Whether a new writer could be leased now; a pure read, like baseStatus. */
  writerStatus(
    caller: Caller,
    unitId: string,
    tx: Transaction,
  ): Promise<import('@merv/code/store/protocol').CodeWriterStatus>;
  /**
   * Refuses, with Code's own blocker, a unit no lease could take now: its base cannot be
   * derived or, for a writer, the last writer's machine still owes its final capture or an
   * operator must fence it. Pure reads, like the two statuses it asks.
   */
  requireLeasable(
    caller: Caller,
    input: { unitId: string; writer: boolean },
    tx: Transaction,
  ): Promise<void>;
}
/** The project's repository on the server's disk; refused where the server keeps none. */
export interface CodeRepositoryControls {
  /** Declare the project repository before creating new work. */
  ensureRepository(caller: Caller, tx: Transaction): Promise<void>;
  prepareRepository(
    caller: Caller,
    input: import('@merv/code/store/protocol').CodeRepositoryPrepareInput,
  ): Promise<import('@merv/code/store/protocol').CodeRepositoryPreparation>;
  /**
   * The accepted units of this project whose code the current main does not contain yet.
   * It asks Git, so it lives with the repository rather than with the units, and takes no
   * transaction: Git never runs inside one, and the candidate scan is a read of its own.
   */
  acceptedSince(caller: Caller): Promise<CodeAcceptedSince>;
  controlBase(
    caller: Caller,
    input: Omit<import('./models.js').CodeBaseControlInput, 'action'> & {
      /** Contracts publishes the first five; release and repair are Code's own routes back. */
      action: import('./models.js').CodeBaseControlInput['action'] | 'release' | 'repair';
    },
  ): Promise<import('./models.js').CodeBaseRecord>;
  importRepository(
    caller: Caller,
    input: import('@merv/code/store/protocol').CodeRepositoryImportInput,
  ): Promise<import('@merv/code/store/protocol').CodeStoreOperation>;
  /** Change the repository identity of a hosted project, after proving Code holds its history. */
  rebindRepository(
    caller: Caller,
    input: import('@merv/code/store/protocol').CodeRepositoryRebindInput,
  ): Promise<import('@merv/code/store/protocol').CodeStoreOperation>;
  configureRepository(
    caller: Caller,
    input: CodeRepositoryConfigureInput,
  ): Promise<CodeStoreLimits>;
  fenceUnit(
    caller: Caller,
    input: import('@merv/code/store/protocol').CodeUnitFenceInput,
  ): Promise<import('@merv/code/store/protocol').CodeWriterStatus>;
  /** Put a ref publication that waits for an operator back in the queue; it never forces. */
  retryMirror(
    caller: Caller,
    input: import('@merv/code/store/protocol').CodeMirrorRetryInput,
  ): Promise<import('@merv/code/store/protocol').CodeMirrorStatus>;
}
/**
 * Code's part of the Running page. Each is one read inside the page's snapshot, and none
 * writes; the words are the person moves the Code page itself says.
 */
export interface CodeRunning {
  /**
   * Work a person owes a move to, as marks on its key: the blockers Code publishes whose next
   * move is an operator's or an administrator's. Done work is held for its publication alone,
   * the newest first and only so many; the summary counts the rest.
   */
  runningHolds(caller: Caller): Promise<{ marks: RunningMark[]; summary: RunningSummary | null }>;
  /**
   * The machines project checks hold, and any a check could not give back, as hardware
   * nodes `check:<baseKey>`.
   */
  runningChecks(caller: Caller): Promise<RunningNode[]>;
  /** The sidebar of `check:<baseKey>`; null for any other key. */
  runningPanel(caller: Caller, key: string): Promise<RunningPanelPart | null>;
  /** The Code section of each `work:<id>` key that has a unit; nothing for the rest. */
  runningCode(caller: Caller, keys: readonly string[]): Promise<RunningSection[]>;
}
/** One accepted commit of a resolution input, and the units accepted with it. */
export interface ResolutionInput {
  commit: string;
  /** `name` is null where the unit's work is gone. */
  units: { id: string; name: string | null }[];
}
/**
 * What the reviewed work Code asks for has to achieve, as facts; its owner words the brief.
 * `base`: two inputs of a base whose merge conflicted, or merged cleanly and failed the
 * project check. `sync`: a GitHub branch head to integrate with Merv main.
 */
export type ResolutionWork =
  | {
      kind: 'base';
      /** The workspace starts at `left`; `right` stays frozen. */
      left: { commit: string; inputs: ResolutionInput[] };
      right: { commit: string; inputs: ResolutionInput[] };
      conflict: { paths: string[]; messages: string };
      /** The failed project check of the merge; `output` is already bounded. */
      check: {
        command: string;
        machine: string;
        exitCode: number | null;
        timedOut: boolean;
        timeoutSeconds: number;
        output: string;
      } | null;
    }
  | { kind: 'sync'; branch: string; main: string; head: string };
/**
 * The port a work owner binds so Code can open the reviewed work that resolves a base or
 * integrates a GitHub branch, starting at `baseReference`. It runs in Code's transaction; no
 * public input selects it.
 */
export interface ResolutionWorkCreator {
  create(
    input: { projectId: string; requestId: string; baseReference: string; work: ResolutionWork },
    tx: Transaction,
  ): Promise<{ id: string }>;
  /** What resumes the work once it is suspended, said to whatever waits on it. */
  readonly resume: string;
}
export interface Code
  extends
    CodeCommands,
    CodeCaptures,
    CodeUnits,
    CodeWriters,
    CodeRepositoryControls,
    CodePublicationApi,
    CodeRunning {
  /** A capture, checked to come from exactly this origin, and whether it holds its result. */
  checkCapture(
    caller: Caller,
    ref: CodeCaptureRef,
    origin: CodeCaptureOrigin,
    tx?: Transaction,
  ): Promise<CheckedCodeCapture>;
  bindServiceTasks(provider: ResolutionWorkCreator): () => void;
  controlPublication(caller: Caller, input: unknown): Promise<unknown>;
  readonly github: import('@merv/contracts').CodeGitHub;
  /**
   * The workspace protocol, served below `/code/v2/`: a route with its JSON body, or the
   * bytes of one part. Each parses what it receives. Absent where the server keeps no
   * repositories, and once Code is closing.
   */
  readonly v2?: {
    call(caller: Caller, route: string, body: unknown): Promise<unknown>;
    putPart(caller: Caller, operationId: string, offset: number, bytes: Buffer): Promise<unknown>;
    readPart(caller: Caller, exportId: string, input: unknown): Promise<Buffer>;
  };
}
declare module 'cordis' {
  interface Context {
    codeWork: Code;
  }
}
