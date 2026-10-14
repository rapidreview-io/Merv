/** The machine and the command, without the bytes: what every step after the first needs. */
export interface SandboxCheckPlan {
  provider: string;
  offerId: string;
  snapshotId: string | null;
  command: string;
  timeoutSeconds: number;
  leaseSeconds: number;
  /** Derived from the base and its execution epoch, so a repeat rents nothing twice. */
  idempotencyKey: string;
}
/** What Code hands over to begin: bytes and a digest, never a tree and never a repository. */
export interface SandboxCheckSpec extends SandboxCheckPlan {
  source: { bytes: Uint8Array; sha256: string };
}
/** Retained resources to release; no execution or environment needs to be fabricated. */
export interface SandboxCheckCleanup {
  sandboxId: string | null;
  jobId: string | null;
  objectId: string | null;
}

/**
 * Everything one check has durably reached after shipping the source and renting a machine.
 * Jobs stay null until their steps run, so a crash can resume from the retained resources.
 */
export interface SandboxCheckHandle {
  sandboxId: string;
  jobId: string | null;
  objectId: string;
  /** A snapshot is restored by a job of its own; the check waits for it before running. */
  restoreJobId: string | null;
  ready: boolean;
  environment: { provider: string; offerId: string; snapshotId: string | null } | null;
}
/**
 * `result` present is the verdict — exit 0 passed, anything else failed. `result` absent is
 * infrastructure, and `setup` names the step that failed. The wrapper always exits 0 after
 * writing its result, so no operator command can impersonate a setup failure.
 */
export interface SandboxCheckVerdict {
  state: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  result: { exit: number; bytes: number; head: string; tail: string } | null;
  setup: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  usage: { amount: string; currency: string } | null;
}
/**
 * Server-owned check work. It takes a projectId rather than a Caller because there is no
 * human and no session behind it, and it is a capability rather than a tool precisely so
 * that no leased worker can ever start or stop a machine through it.
 */
export interface SandboxChecks {
  /** Ship the source and ask for a machine; returns before the machine exists. */
  start(projectId: string, spec: SandboxCheckSpec): Promise<SandboxCheckHandle>;
  /** One bounded advance: readiness, then restore, then the job. Never blocks on provisioning. */
  step(
    projectId: string,
    plan: SandboxCheckPlan,
    handle: SandboxCheckHandle,
  ): Promise<SandboxCheckHandle>;
  follow(projectId: string, handle: SandboxCheckHandle): Promise<SandboxCheckVerdict>;
  /** Cancel, delete the machine and delete the source. Safe twice and safe after a crash. */
  release(projectId: string, resources: SandboxCheckCleanup): Promise<void>;
}
