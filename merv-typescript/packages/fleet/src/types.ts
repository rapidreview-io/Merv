import type { Caller, DelegationSource, Sql, Transaction } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';

export type FleetPhase =
  'queued' | 'provisioning' | 'starting' | 'running' | 'uncertain' | 'releasing' | 'released';
export type FleetIntent = 'run' | 'drain' | 'stop';
export interface FleetAllocation {
  id: string;
  projectId: string;
  source: DelegationSource;
  owner: { kind: string; id: string };
  requestId: string;
  /** The host project whose link pays for the machine, when not `projectId`'s own. */
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
  runtime: FleetRuntimeHandle | null;
  /** Durable intent written before create; false proves no provider call has begun. */
  createAttempted: boolean;
  /** When Fleet adopted its current machine, which must be ready within a minute. */
  adoptedAt?: string;
  /** Machines that never became ready, stopped and rented again each under a new create key. */
  replaced?: number;
  createdAt: string;
  /** While queued, when the request gives up; once reserved, when the machine must stop. */
  deadlineAt: string;
  /** When phase or intent last changed; retries and provider observations leave it alone. */
  updatedAt: string;
  /** Set once stopping stalls: Fleet renews nothing after stop, so the provider lease has
   * ended any machine this allocation could hold by then, and the slot is freed. */
  releaseBy?: string;
  retryAt: string | null;
  failures: number;
  error: FleetError | null;
}
/** runtime_unavailable: an ambiguous failure being retried with the same keys, or a machine that
 * never became ready, being rented again under a new key.
 * runtime_refused: the service refused before any machine could exist, so the slot was freed, or
 * a capped request's offer listed no price for ten minutes.
 * wallet_refused: the provider's spending limit refused it.
 * person_capped: its person spent today's compute while it queued; nobody else is held back.
 * runtime_not_ready: none of its machines became ready, so it stopped. */
export type FleetError =
  | 'runtime_unavailable'
  | 'runtime_refused'
  | 'wallet_refused'
  | 'person_capped'
  | 'runtime_not_ready';
export interface FleetRequest {
  requestId: string;
  /** The registered owner's kind, and its own id for the work. */
  owner: { kind: string; id: string };
  /** The Fleet runtime profile key to rent ('standard', 'large'); absent means the default
   * (first) profile. Part of the request's fingerprint; the allocation keeps that profile's id. */
  profile?: string;
  /** Seconds the machine may run once it leaves the queue (a queued request gives up after as
   * long), within allocationTimeoutSeconds, the default. Part of the fingerprint. */
  seconds?: number;
}
/** How many machines a project may hold at once: its own setting, or the operator's default. */
export interface FleetProjectLimit {
  machines: number;
  /** What the project holds without its own setting. */
  default: number;
  /** The most it may be set to. */
  max: number;
}
/** A machine Fleet can rent, as the service's options describe the profile's offer. */
export interface FleetMachine {
  key: string;
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
  maxHourlyUsd: number;
}
/** Stored allocation shape. */
export interface FleetRuntimeHandle {
  sandboxId: string;
  state: 'provisioning' | 'ready' | 'unknown' | 'deleting' | 'failed' | 'stopped';
  ready: boolean;
  leaseExpiresAt: string | null;
  revision: number;
  launch: FleetRuntimeLaunch | null;
}
export interface FleetRuntimeLaunch {
  launchId: string;
  jobId: string;
  state: 'pending' | 'consumed' | 'revoked' | 'expired';
  deliveryState: 'pending' | 'uncertain' | 'launched';
}
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
  /** The model tokens this owner charges `person` for over the UTC days [from, to): read for the
   *  platform admin. */
  modelTokens?(person: string, sql: Sql, from: string, to: string): Promise<ModelTokens>;
  /** Sets `person`'s own daily model tokens, or clears them (null): the platform admin's write. */
  setModelTokens?(person: string, tokens: number | null): Promise<void>;
}
/** What a person used over a window, and the daily limit that holds for them now: their own
 *  (`own`), else the deployment's. */
export interface PersonUse<Limit = number> {
  used: number;
  limit: Limit;
  own: boolean;
}
export type ModelTokens = PersonUse;
/** A person's Fleet use over a window. */
export interface FleetPersonUsage {
  /** What their machines cost, at the prices stamped when Fleet reserved them: an estimate. Its
   *  limit is null where no daily cap holds. */
  usd: PersonUse<number | null>;
  /** Null when no owner meters model tokens. */
  tokens: ModelTokens | null;
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
  /** A failure the provider streamed: the code its frame named (`upstream_failed` if none). */
  providerCode?: string;
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
/** A hosted session's authority to call the model through Main's relay, which Fleet grants. */
export interface ManagedModelGrant {
  /** The session. */
  id: string;
  projectId: string;
  /** The Fleet allocation whose machine runs it. */
  allocationId: string;
  /** Whose spend it is: the person Fleet rented its machine for, or who asked an inquiry visit. */
  person: string;
  model: string;
  effort?: string;
  expiresAt: string;
  /** The session's own model tokens (`Session.tokenBudget`): each call is charged to it too. */
  tokenBudget?: number;
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
  providerKey: () => string | Promise<string>;
  /** Operator-selected Responses endpoint; defaults to OpenAI. */
  responsesUrl?: string;
  authority: {
    authorize(token: string): Promise<unknown>;
    validate(grant: G): Promise<void>;
  };
  /** Throws for a grant the relay must not honour. */
  grant(raw: unknown): G;
  /** The body sent upstream, with the relay's own settings, or null to refuse the request. */
  payload(raw: unknown, grant: G): Record<string, unknown> | null;
  /** Headers the upstream call carries for that body, besides the relay's own. */
  headers?(body: Record<string, unknown>): Record<string, string>;
  lane(grant: G): string;
  maxRequestBytes: number;
  totalTimeoutMs: number;
  maxRequestsPerGrant?: number;
  /** A call that failed once admitted, with the grant it ran under. */
  onFailure?: (record: ModelRelayFailure<`${N}_relay_failure`>, grant: G) => void | Promise<void>;
  onTerminal?: (record: ModelRelayTerminal<`${N}_relay_terminal`>) => void | Promise<void>;
  /** Charges a call just before its last authority read and the upstream send, and returns the
   *  charge as the feature reads it back; throwing refuses the call with the error's `code`, or
   *  with 503 relay_unavailable when the error's `status` is 500 or more. A call refused after the
   *  charge, never taken by the provider, or failed by it with no usage, is refunded through
   *  `onUsage`; the charge stands for a call the provider may have run that never finishes. */
  reserve?: (grant: G, body: Record<string, unknown>) => Promise<R>;
  /** A finished call's usage, or a refund of a call refused before it was sent, answered with an
   *  error status or failed with no usage, with what `reserve` returned for it. */
  onUsage?: (
    record: ModelRelayUsage<`${N}_relay_usage`>,
    grant: G,
    reserved: R,
  ) => void | Promise<void>;
}
/** A model relay's latest call the provider answered and latest it failed, on one provider key
 *  and model (`Fleet.relayOutcomes`). */
export interface RelayOutcome {
  relay: string;
  /** The environment variable the relay's provider key is read from. */
  keyEnv: string;
  model: string;
  lastOkAt: string | null;
  /** Its latest `upstream_failed` call. */
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  lastFailureCode: string | null;
  /** That failure was the provider refusing the key itself. */
  rejected: boolean;
}
/** A model relay: its HTTP handler, which answers 404 off its one route and authenticates its own
 *  bearers, so its owner mounts it public; and close(), which ends the calls it is streaming. */
export interface ModelRelayHandle {
  readonly handle: MountHandler;
  close(): void;
}
/** One more window for one exact workflow revision that unclaimed machines exhausted. */
export type FleetRetryInput = Record<'instanceId' | 'reason' | 'requestId', string> & {
  expectedRevision: number;
};
export interface Fleet {
  /** The workflow owner's retries while it is loaded (the fleet tool's workflow_retry actions). */
  retries?: {
    retryStatus(
      caller: Caller,
      targets: Omit<FleetRetryInput, 'reason' | 'requestId'>[],
    ): Promise<unknown[]>;
    retry(caller: Caller, input: FleetRetryInput): Promise<unknown>;
  };
  /** The longest Fleet rents a machine for (allocationTimeoutSeconds); a longer request gets this. */
  readonly allocationSeconds: number;
  /** How long Fleet may take to give up on a machine whose agent never connects, as
   *  `runtime_not_ready`: every machine it tries, each created, given its minute, and replaced. */
  readonly readyWindowMs: number;
  /** Look again now, not at the next tick, at everything not yet running steadily (requests,
   * starts, stops). Safe at any time, even inside a transaction; a no-op until the first full
   * pass after start, since owners register after Fleet starts. */
  kick(): void;
  /** Whether this project can rent machines at all; false means every request is refused. */
  connected(projectId: string): Promise<boolean>;
  /** Slots a new request in this project could take now: the smaller of the global and this
   * project's room, each less what is already open in it. Queued work counts even where its own
   * project's cap holds it back, so this errs low; 0 when the project cannot rent. */
  free(projectId: string, tx?: Transaction): Promise<number>;
  describe(projectId: string, key: string): Promise<FleetMachine | null>;
  registerOwner(kind: string, owner: FleetOwner): () => void;
  inspectOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Whether work machines are held (fleet_holds): a release is about to replace them, so the
   * workflow owner rents none and stops each whose step has settled, and none admits a step
   * (those of an owner that keepsRunning; Pi's are drained by their turns). */
  held(tx?: Transaction): Promise<boolean>;
  /** Whether a release retired this allocation's machine: its profile is no longer configured. */
  retired(id: string, tx?: Transaction): Promise<boolean>;
  /** The owner's open allocations in every project, oldest first, with every released one whose
   * owner id is in `targets`: exact counts, however long the history. */
  listOwned(owner: FleetOwner, targets: string[]): Promise<FleetAllocation[]>;
  /** Platform admin read, never exposed through a tool, an owner or a machine key: every open
   * allocation in every project, with its profile's key and provider while this deployment
   * keeps that profile, and the unit of work it was rented for. */
  platformAllocations(): Promise<
    (FleetAllocation & { profile: string | null; provider: string | null; work: string | null })[]
  >;
  cancelOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation>;
  request(caller: Caller, input: FleetRequest, tx?: Transaction): Promise<FleetAllocation>;
  inspect(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** Open allocations, oldest first, with only the `recent` latest released ones when given. */
  list(caller: Caller, recent?: number): Promise<FleetAllocation[]>;
  cancel(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  drain(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation>;
  /** How many machines the caller's project may hold at once. */
  projectLimit(caller: Caller): Promise<FleetProjectLimit>;
  /** A project administrator, signed in, sets how many machines the project may hold at once. */
  setProjectLimit(caller: Caller, machines: number): Promise<FleetProjectLimit>;
  /** Sessions must call this inside the same transaction that enrolls or claims work. False for
   * a work machine while work machines are held. */
  admits(id: string, epoch: number, tx: Transaction): Promise<boolean>;
  /** A model relay for workers that hold no provider key; its owner mounts and closes it. Its
   *  calls' outcomes are kept under `keyEnv`, the variable its provider key is read from. */
  modelRelay<G extends ModelRelayGrant, N extends string, R>(
    config: ModelRelayConfig<G, N, R>,
    keyEnv: string,
  ): ModelRelayHandle;
  /** For the platform admin only, never a tool: each of `persons`' use over the UTC days
   *  [from, to), in order. */
  peopleUsage(persons: readonly string[], from: string, to: string): Promise<FleetPersonUsage[]>;
  /** For the platform admin only, never a tool: sets `person`'s own daily machine dollars or
   *  model tokens, or clears it (null) so the deployment's holds again. */
  setPersonLimit(person: string, of: 'usd' | 'tokens', limit: number | null): Promise<void>;
  /** Every relay's latest outcomes per provider key and model: the platform admin's read, never
   *  a tool's. */
  relayOutcomes(): Promise<RelayOutcome[]>;
}
declare module 'cordis' {
  interface Context {
    fleet: Fleet;
  }
}
