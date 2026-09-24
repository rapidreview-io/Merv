import type { Caller, Json } from '@merv/contracts';
import type {} from 'cordis';

/** One project's authorized connection. Secrets are named, never carried. */
export interface SandboxConnection {
  projectId: string;
  /** The namespace the grant selects, sent as `X-Sandbox-Namespace` on every call. */
  namespace: string;
  /** Environment variable holding that project's `sbxt_` consumer grant. */
  tokenEnv: string;
}

export interface SandboxesConfig {
  /** Environment variable holding the service origin; the only origin this plugin calls. */
  urlEnv: string;
  connections: SandboxConnection[];
  /** Manifest re-poll cadence; five minutes by default. */
  refreshMs?: number;
  timeoutMs?: number;
  /**
   * Bucket origins a check's source may be uploaded to. The service tells this plugin where
   * to PUT, which is request-forgery-shaped by construction, so naming those origins in
   * deployment configuration makes it an operator's decision rather than a guess in code.
   * Without it there are no checks at all: `Sandboxes.checks` is undefined.
   */
  storageOrigins?: string[];
  /** Operator-selected protected runtime profile. Absence disables the server-only capability. */
  runtime?: SandboxRuntimeProfile;
}

/** Fixed by the operator; Fleet work cannot select a provider, offer, image or release. */
export interface SandboxRuntimeProfile {
  provider: string;
  offerId: string;
  releaseId: string;
  leaseSeconds: number;
  ttlSeconds?: number;
}

export type SandboxRuntimeState =
  'provisioning' | 'ready' | 'unknown' | 'deleting' | 'failed' | 'stopped';

/** The public receipt contains metadata only; the bootstrap is never returned. */
export interface SandboxRuntimeLaunch {
  sandboxId: string;
  launchId: string;
  operationKey: string;
  releaseId: string;
  jobId: string;
  state: 'pending' | 'consumed' | 'revoked' | 'expired';
  deliveryState: 'pending' | 'uncertain' | 'launched';
  expiresAt: string;
}

/** Durable Fleet handle. A deletion request is not proof of provider release. */
export interface SandboxRuntimeHandle {
  sandboxId: string;
  state: SandboxRuntimeState;
  ready: boolean;
  deleted: boolean;
  leaseExpiresAt: string | null;
  revision: number;
  launch: SandboxRuntimeLaunch | null;
}

/** Server-owned capability, deliberately absent from agent tools and the UI manifest. */
export interface SandboxRuntimes {
  readonly profileId: string;
  /** Every create and renewal asks for this lease; the service reaps a machine when it ends. */
  readonly leaseSeconds: number;
  /** False (no connection, or no grant for it) proves no call for this project can reach the service. */
  connected(projectId: string): boolean;
  provision(projectId: string, operationKey: string): Promise<SandboxRuntimeHandle>;
  inspect(projectId: string, handle: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle>;
  launch(
    projectId: string,
    handle: SandboxRuntimeHandle,
    operationKey: string,
    bootstrap: string,
  ): Promise<SandboxRuntimeHandle>;
  acknowledge(projectId: string, handle: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle>;
  stop(projectId: string, handle: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle>;
  /** Renew to the operator's configured lease, never an agent-selected lifetime. */
  renew(projectId: string, handle: SandboxRuntimeHandle): Promise<SandboxRuntimeHandle>;
}

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
/**
 * Everything one check has durably reached. Each field is null until its own step ran, which
 * is what lets a crash resume from the handle instead of renting a second machine.
 */
export interface SandboxCheckHandle {
  sandboxId: string | null;
  jobId: string | null;
  objectId: string | null;
  /** A snapshot is restored by a job of its own; the check waits for it before running. */
  restoreJobId: string | null;
  /** The digest the machine verifies the download against; known once the source was shipped. */
  sha256: string | null;
  ready: boolean;
  environment: { provider: string; offerId: string; snapshotId: string | null } | null;
  isolation: { network: 'on'; sourceReadOnly: false; imagePinned: 'offer'; facts: string[] };
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
  release(projectId: string, handle: SandboxCheckHandle): Promise<void>;
}

/**
 * One sidebar row derived from a manifest row. Data only: the browser renders `view`,
 * and `spec`/`record` are the manifest's own collection and record specifications.
 */
export type SandboxRow = {
  id: string;
  label: string;
  group: string;
  order: number;
  path: string;
  view: { kind: 'collection'; icon: string | null; spec: Json; record: Json };
};

/** One sandbox, named by the id the collection publishes as its key. */
export interface SandboxTarget {
  id: string;
}
export interface SandboxExtend extends SandboxTarget {
  /** Extra lifetime, added to whatever is left of the lease when the service renews it. */
  seconds: number;
}

/** Readiness only. A count beside a row means open work, and a proxy cannot know that. */
export interface SandboxReadiness {
  state: 'ready' | 'degraded';
  detail?: string;
}

export interface Sandboxes {
  /** Rows from the last accepted manifest, already named and routed for the UI registry. */
  rows(): SandboxRow[];
  status(): SandboxReadiness;
  /** Fetch every connection's manifest now; rows change only when the manifest does. */
  refresh(): Promise<void>;
  /** The collection, or one record when `id` is given, read as the caller's own project. */
  read(caller: Caller, rowId: string, params?: Record<string, unknown>): Promise<Json>;
  /** Add `seconds` to what is left of one sandbox's lease; the service refuses a dead one. */
  extend(caller: Caller, input: SandboxExtend): Promise<Json>;
  /** Ask the provider to delete one sandbox, then answer the record as it now reads. */
  release(caller: Caller, input: SandboxTarget): Promise<Json>;
  /** Fires after the published row set changes. */
  subscribe(listener: () => void): () => void;
  /** Present only where the deployment named the bucket origins a source may be uploaded to. */
  readonly checks?: SandboxChecks;
  /** Present only when deployment configured a fixed protected runtime profile. */
  readonly runtimes?: SandboxRuntimes;
}

declare module 'cordis' {
  interface Context {
    sandboxes: Sandboxes;
  }
}
