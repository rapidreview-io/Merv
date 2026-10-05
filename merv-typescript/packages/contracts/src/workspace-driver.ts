import type { CodeCommitCommand, CodeCommitReceipt } from './code.js';
import type { SessionWorkspace } from './sessions-models.js';
import type { WorkflowExecution, WorkflowWorkspacePolicy } from './index.js';

/**
 * What a machine runner asks of whatever prepares its checkouts. The runner schedules,
 * launches and reports; it never learns how a checkout is made or where its history lives.
 * A policy names its driver, and a runner advertises the drivers it carries as capabilities.
 */
export interface WorkspaceHandle {
  path: string;
  snapshot?: SessionWorkspace;
  retain: boolean;
  readOnly: boolean;
  status: 'preparing' | 'ready' | 'capturing' | 'captured' | 'closing' | 'closed';
}
/** The part of a local launch record a driver may rely on. */
export interface WorkspaceLaunch {
  id: string;
  sessionId: string;
  runDirectory: string;
}
/** The part of a leased session a driver may rely on. */
export interface WorkspaceSession {
  id: string;
  runnerId: string;
  instanceId: string;
  execution: WorkflowExecution;
}
export interface WorkspaceDriver {
  get(launchId: string): WorkspaceHandle | undefined;
  prepare(launch: WorkspaceLaunch, session: WorkspaceSession): Promise<WorkspaceHandle>;
  /** Only after the launch's process has provably stopped. */
  capture(launch: WorkspaceLaunch): Promise<SessionWorkspace | undefined>;
  close(launch: WorkspaceLaunch): Promise<void>;
  dispose(): void;
  /** Code commands, journalled until acknowledged: a driver that runs them has all four. */
  checkpointCommit?(
    launch: WorkspaceLaunch,
    command: CodeCommitCommand,
  ): Promise<CodeCommitReceipt>;
  pendingCommits?(launchId: string): CodeCommitCommand[];
  commitOutcome?(commandId: string): { receipt: CodeCommitReceipt } | { error: string } | null;
  acknowledgeCommit?(commandId: string): void;
}
/** One launch's claim of a checkout path, with the workspace row it opens. */
export interface CheckoutSlotClaim {
  launchId: string;
  slotId: string;
  path: string;
  branch: string | null;
  base: string;
  policy: WorkflowWorkspacePolicy;
  readOnly: boolean;
  repositoryId: string | null;
}
type SlotOwner = { launch_id: string; slot_id: string; epoch: number };
/** A launch's workspace row in a runner's slot ledger. */
export interface CheckoutWorkspaceRow extends SlotOwner {
  path: string;
  policy_json: string;
  read_only: number;
  base_oid: string;
  branch: string | null;
  repository_id: string | null;
  status: WorkspaceHandle['status'];
  attachment_json: string | null;
  result_json: string | null;
  canceled: number;
}
/** What moves a workspace row on; an attachment and a result are each written once. */
export interface CheckoutWorkspaceChange {
  status?: WorkspaceHandle['status'];
  attachment?: SessionWorkspace;
  result?: SessionWorkspace;
  canceled?: true;
}
/** A runner's checkout-slot ledger, lent to the driver of the runner's own repository. */
export interface CheckoutSlotLedger {
  /** The base a slot was first claimed at, if it ever was. */
  base(slotId: string): string | undefined;
  claim(claim: CheckoutSlotClaim): void;
  /** The launch's workspace row, if it claimed a slot. */
  workspace(launchId: string): CheckoutWorkspaceRow | undefined;
  update(launchId: string, change: CheckoutWorkspaceChange): void;
  /** Cancels the launch's row; a capture in progress counts as captured. */
  abandon(launchId: string): void;
  requireOwnership(row: SlotOwner): void;
  /** Frees the slot its owner still holds and closes the launch's workspace row. */
  release(row: SlotOwner): void;
}
/** What a runner lends a driver: its ledger's place on disk and what it knows of a launch. */
export interface WorkspaceDriverHost {
  /** The ledger directory; a driver keeps what it owns in a directory of its own inside it. */
  directory: string;
  /** Image-provisioned root for assignment-owned independent hosted checkouts. */
  assignmentWorkspaceDirectory?: string;
  /** Who owns the checkouts under that root, and the wrapper that runs Git as that user. */
  assignmentUser?: { uid: number; gid: number; git: string };
  /** A hosted machine retained for this one work item; every phase uses the same cwd. */
  workInstanceId?: string;
  /** Last fully settled phase of this same work item, authenticated by the runner's private ledger. */
  previousWorkspace?(launchId: string): WorkspaceHandle | undefined;
  /** The ledger database, in which a driver may keep its own tables beside the runner's. */
  path: string;
  /** Whether the launch's process has provably stopped. */
  terminal(launchId: string): boolean;
}
/**
 * How a driver reaches a runner without either package importing the other: whoever composes
 * the machine hands the runner the factories, and the runner advertises each one it could
 * create as a capability of that name. A factory that cannot work on this machine throws.
 */
export interface WorkspaceDriverFactory {
  name: string;
  create(host: WorkspaceDriverHost, transport: WorkspaceTransport): WorkspaceDriver;
}
/**
 * A preparation that could not happen yet although nothing about the launch is wrong: the
 * place history lives is away, busy or full. The runner releases such a lease as deferred,
 * which is never counted against the work.
 */
export class WorkspaceDeferred extends Error {
  constructor(
    readonly cause: string,
    readonly code: string,
  ) {
    super(code);
    this.name = 'WorkspaceDeferred';
  }
}
/**
 * How a driver reaches the server through the runner's own authenticated client: a route
 * with an opaque body, or the bytes of one part. A refusal is thrown with the server's
 * `code` and `status`; `status` 0 means the server could not be reached.
 */
export interface WorkspaceTransport {
  call(route: string, body: unknown): Promise<unknown>;
  putPart(operationId: string, offset: number, bytes: Uint8Array): Promise<unknown>;
  readPart(exportId: string, input: unknown): Promise<Uint8Array>;
}
