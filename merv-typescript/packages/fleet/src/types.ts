import type { Caller, DelegationSource, Transaction } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import type { SandboxRuntimeHandle, SandboxRuntimeOffer } from '@merv/sandboxes/types';

export type FleetPhase =
  'queued' | 'provisioning' | 'starting' | 'running' | 'uncertain' | 'releasing' | 'released';
export type FleetIntent = 'run' | 'drain' | 'stop';
export interface FleetAllocation {
  id: string;
  projectId: string;
  source: DelegationSource;
  owner: { kind: string; id: string };
  requestId: string;
  /** The host project whose connection rents the machine, when not `projectId`'s own. */
  rentedIn?: string;
  /** The request's own machine time, when it set one. */
  seconds?: number;
  profileId: string;
  /** Who the machine is for, as Pi and Fleet key a person: what its day's compute counts toward. */
  person?: string;
  /** The offer's hourly price when Fleet reserved it under a USD cap: what its time costs `person`. */
  usdPerHour?: number;
  /** One allocation never changes epoch or rents a successor machine. */
  epoch: number;
  phase: FleetPhase;
  intent: FleetIntent;
  runtime: SandboxRuntimeHandle | null;
  /** Durable intent written before create; false proves no provider call has begun. */
  createAttempted: boolean;
  /** Number of durable create dispatches. A refusal of dispatch one is definitive only if
   * no other controller has begun dispatch two. Missing on legacy rows. */
  createAttempts?: number;
  /** Original lease duration, retained for diagnostics across configuration replacements.
   * Neither it nor the observed expiry authorizes releasing a reservation. */
  leaseSeconds?: number;
  /** Greatest provider lease expiry ever observed, normalized to UTC. A later observation
   * cannot erase longer-lived evidence from an earlier response. */
  leaseExpiresAt?: string;
  createdAt: string;
  /** While queued, when the request gives up; once reserved, when the machine must stop. */
  deadlineAt: string;
  /** When phase or intent last changed; retries and provider observations leave it alone. */
  updatedAt: string;
  /** Legacy timeout, ignored and cleared during cleanup. Release requires a terminal
   * provider observation or proof that no create invocation could have had an effect. */
  releaseBy?: string;
  retryAt: string | null;
  failures: number;
  error: FleetError | null;
}
/** runtime_unavailable: an ambiguous failure being retried with the same keys.
 * runtime_refused: the service refused before any machine could exist, so the slot was freed, or
 * a capped request's offer listed no price for ten minutes. */
export type FleetError = 'runtime_unavailable' | 'runtime_refused' | 'wallet_refused';
export interface FleetRequest {
  requestId: string;
  /** The registered owner's kind, and its own id for the work. */
  owner: { kind: string; id: string };
  /** The Sandboxes runtime profile key to rent ('standard', 'large'); absent means the default
   * (first) profile. Part of the request's fingerprint; the allocation keeps that profile's id. */
  profile?: string;
  /** Seconds the machine may run once it leaves the queue (a queued request gives up after as
   * long), within allocationTimeoutSeconds, the default. Part of the fingerprint. */
  seconds?: number;
}
/** A machine Fleet can rent, as the service's options describe the profile's offer. */
export type FleetMachine = SandboxRuntimeOffer;
/** Trusted server adapter, never an agent-supplied command or harness implementation.
 * Workflow and chat own authority, enrollment and completion. Fleet owns machines only.
 */
export interface FleetOwner {
  sourcePermission?: 'read' | 'write';
  /** Rent through the host project, so work in a project without its own connection can rent.
   * connected(), free() and describe() still answer for the project's own connection. */
  rentsInHost?: true;
  /** Its machines outlive a Main restart, launched or not: closing leaves its running work in
   * every phase, and the owner registering again after the restart takes it back. */
  keepsRunning?: true;
  /** Who a machine for this source and owner id is for, keyed as Pi keys a person (a digest of
   * their sign-in); null when nobody's daily compute should count it. */
  payer?(source: DelegationSource, ownerId: string, tx: Transaction): Promise<string | null>;
  /** Read-only transactional check; false fences new authority and starts cleanup. */
  valid(allocation: FleetAllocation, tx: Transaction): Promise<boolean>;
  /** Stable bytes for this allocation/epoch across retries, never persisted by Fleet. */
  bootstrap(allocation: FleetAllocation): Promise<string>;
  /** finished means all required capture/checkpoint work has been retained. */
  observe(allocation: FleetAllocation): Promise<'starting' | 'running' | 'finished'>;
  /** Recheck completion under the SAME writer transaction that records stop. Owners whose
   * work can be claimed after observe() must implement this local retirement fence. */
  canRetire?(allocation: FleetAllocation, tx: Transaction): Promise<boolean>;
}
/** What a worker's model calls may do, read again about once a second while one streams. */
export interface ModelRelayGrant {
  id: string;
  model: string;
  expiresAt: string;
}
export interface ModelRelayFailure<E extends string = string> {
  event: E;
  phase: 'request' | 'upstream' | 'stream';
  /** The code the worker was answered with, such as relay_timeout or upstream_failed. */
  code: string;
  model: string;
  elapsedMs: number;
  upstreamHttpStatus?: number;
}
/** One finished model call's tokens, for spend per model, or a zero refund record for a charged
 *  call the provider never took; it names no person or conversation. */
export interface ModelRelayUsage<E extends string = string> {
  event: E;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** A zero record that returns the charge of a call the provider never took. */
  refund?: true;
}
/** A provider terminal frame, without its text, tool arguments, identifiers or raw reason. */
export interface ModelRelayTerminal<E extends string = string> {
  event: E;
  model: string;
  status: 'completed' | 'incomplete' | 'failed';
  incompleteReason: 'max_output_tokens' | 'content_filter' | 'other' | null;
  elapsedMs: number;
}
/**
 * A relay that holds the provider key for the workers Fleet launches, which hold none
 * (model-relay.ts). A feature
 * supplies what differs: its route and bearer, how a grant reads, which request bodies pass and
 * what the relay sets in them, and the lane that allows one call in flight.
 */
export interface ModelRelayConfig<
  G extends ModelRelayGrant,
  N extends string = string,
  R = unknown,
> {
  /** Names the records, `${name}_relay_usage`, `${name}_relay_failure` and `${name}_relay_terminal`. */
  name: N;
  route: string;
  token: RegExp;
  enabled?: boolean;
  providerKey: () => string | Promise<string>;
  authority?: {
    authorize(token: string): Promise<unknown>;
    validate(grant: G): Promise<void>;
  };
  /** Throws for a grant the relay must not honour. */
  grant(raw: unknown): G;
  /** The body sent upstream, with the relay's own settings, or null to refuse the request. */
  payload(raw: unknown, grant: G): Record<string, unknown> | null;
  lane(grant: G): string;
  fetchImpl?: typeof fetch;
  maxRequestBytes: number;
  maxResponseBytes?: number;
  totalTimeoutMs: number;
  idleTimeoutMs?: number;
  /** For calls whose effort is not `none`, which may reason in silence. */
  reasoningIdleTimeoutMs?: number;
  maxConcurrent?: number;
  maxRequestsPerGrant?: number;
  maxGrantEntries?: number;
  onFailure?: (record: ModelRelayFailure<`${N}_relay_failure`>) => void | Promise<void>;
  onTerminal?: (record: ModelRelayTerminal<`${N}_relay_terminal`>) => void | Promise<void>;
  /** Charges a call just before its last authority read and the upstream send, and returns the
   *  charge as the feature reads it back; throwing refuses the call with the error's `code`, or
   *  with 503 relay_unavailable when the error's `status` is 500 or more. A call refused after the
   *  charge, or never taken by the provider, is refunded through `onUsage`; the charge stands for
   *  a call the provider may have run that never finishes. */
  reserve?: (grant: G, body: Record<string, unknown>) => Promise<R>;
  /** A finished call's usage, or a refund of a call refused before it was sent or answered with
   *  an error status, with what `reserve` returned for it. */
  onUsage?: (
    record: ModelRelayUsage<`${N}_relay_usage`>,
    grant: G,
    reserved: R,
  ) => void | Promise<void>;
}
/** A model relay: its HTTP handler, which answers 404 off its one route and authenticates its own
 *  bearers, so its owner mounts it public; and close(), which ends the calls it is streaming. */
export interface ModelRelayHandle {
  readonly handle: MountHandler;
  close(): void;
}
export interface Fleet {
  /** Look again now, not at the next tick, at everything not yet running steadily (requests,
   * starts, stops). Safe at any time, even inside a transaction; a no-op until the first full
   * pass after start, since owners register after Fleet starts. */
  kick(): void;
  /** Whether this project can rent machines at all; false means every request is refused. */
  connected(projectId: string): boolean;
  /** Slots a new request in this project could take now: the smaller of the global and this
   * project's room, each less what is already open in it. Queued work counts even where its own
   * project's cap holds it back, so this errs low; 0 when the project cannot rent. */
  free(projectId: string, tx?: Transaction): Promise<number>;
  /** The machine behind a profile key for this project, from Sandboxes' cached options (cheap
   * enough for every snapshot); null when the key is not configured or its offer is missing,
   * and then the machine is hidden. */
  describe(projectId: string, key: string): Promise<FleetMachine | null>;
  registerOwner(kind: string, owner: FleetOwner): () => void;
  inspectOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Whether a release retired this allocation's machine: its profile is no longer configured. */
  retired(id: string, tx?: Transaction): Promise<boolean>;
  /** The owner's open allocations in every project, oldest first, with every released one whose
   * owner id is in `targets`: exact counts, however long the history. */
  listOwned(owner: FleetOwner, targets: string[]): Promise<FleetAllocation[]>;
  cancelOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation>;
  request(caller: Caller, input: FleetRequest, tx?: Transaction): Promise<FleetAllocation>;
  inspect(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Open allocations, oldest first, with only the `recent` latest released ones when given. */
  list(caller: Caller, recent?: number): Promise<FleetAllocation[]>;
  cancel(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  drain(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Sessions must call this inside the same transaction that enrolls or claims work. */
  admits(id: string, epoch: number, tx: Transaction): Promise<boolean>;
  /** A model relay for workers that hold no provider key; its owner mounts and closes it. */
  modelRelay<G extends ModelRelayGrant, N extends string, R>(
    config: ModelRelayConfig<G, N, R>,
  ): ModelRelayHandle;
}
declare module 'cordis' {
  interface Context {
    fleet: Fleet;
  }
}
