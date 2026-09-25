import { AsyncResource } from 'node:async_hooks';
import type { Context } from 'cordis';
import type {} from '@merv/sandboxes/types';
import { z } from 'zod';
import {
  check,
  digest,
  eventSource,
  inTransaction,
  MervError,
  newId,
  type Caller,
  type Scope,
  type Sql,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { SandboxRuntimes, SandboxRuntimeHandle } from '@merv/sandboxes/types';
import { migration } from './schema.js';
import type {
  Fleet,
  FleetAllocation,
  FleetConfig,
  FleetIntent,
  FleetOwner,
  FleetRequest,
} from './types.js';
export type * from './types.js';

const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const requestSchema = z
  .object({
    requestId: token,
    owner: z.object({ kind: token, id: token }).strict(),
    profile: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
  })
  .strict();
export const fleetConfig = z
  .object({
    enabled: z.boolean().default(false),
    globalLimit: z.number().int().min(1).max(64).default(50),
    projectLimit: z.number().int().min(1).max(64).default(5),
    projectLimits: z.record(token, z.number().int().min(1).max(64)).default({}),
    pollIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
    allocationTimeoutSeconds: z.number().int().min(60).max(86_400).default(86_400),
    hostProjectId: token.optional(),
  })
  .strict();
type Row = { data_json: string };
const decode = (row: Row): FleetAllocation => JSON.parse(row.data_json);
const occupied = (a: FleetAllocation) => a.phase !== 'queued' && a.phase !== 'released';
/** A machine in use needs only the slow watch; one on its way up or down is watched often. */
const steady = (a: FleetAllocation) => a.phase === 'running' && a.intent !== 'stop';
/** A 4xx other than timeout, conflict or rate limit, or a local precondition: nothing was made. */
const refused = (error: unknown) =>
  error instanceof MervError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 409, 429].includes(error.status);
/** Provider and owner messages may carry credentials; operators get the finite code only. */
const report = (event: string, a: FleetAllocation, error: unknown) => {
  const code = error instanceof MervError ? error.code : 'unexpected';
  process.stderr.write(`${JSON.stringify({ event, allocation: a.id, code })}\n`);
};

/** Durable capacity and machine lifecycle. No task, workflow or research dependencies. */
export class FleetService implements Fleet {
  private readonly config: z.infer<typeof fleetConfig>;
  private readonly owners = new Map<string, FleetOwner>();
  private pending?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private due = Infinity;
  private fullAt = 0;
  private watching = false;
  private awake = false;
  private unlisten?: () => void;
  /** Timers never inherit a caller's database scope: kicks come from inside transactions. */
  private readonly detached = AsyncResource.bind((fn: () => void) => fn());
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly runtimes: SandboxRuntimes | undefined,
    config: FleetConfig = {},
    private readonly clock: () => number = Date.now,
  ) {
    const parsed = fleetConfig.safeParse(config);
    check(parsed.success, 'invalid_fleet_config', 'Fleet configuration is invalid');
    this.config = parsed.data;
    check(
      !this.config.enabled || runtimes,
      'fleet_runtime_unavailable',
      'Enabled Fleet requires a protected Sandboxes runtime',
      503,
    );
  }
  async initialize() {
    await this.state.migrate('fleet', [migration]);
  }
  start(): void {
    check(!this.closed, 'fleet_closed', 'Fleet is closed', 503);
    if (this.unlisten) return;
    // A kick inside a transaction acts again at the next commit that records an event: its own,
    // since writers share one lock (Fleet's own requests and stops always record one).
    this.unlisten = this.state.onEventsCommitted(() => {
      if (this.watching) this.wake(0);
      this.watching = false;
    });
    // The first pass waits a full interval so owners can register before anything is judged.
    this.fullAt = Date.now() + this.config.pollIntervalMs;
    this.wake(this.config.pollIntervalMs);
  }
  connected(projectId: string): boolean {
    return this.config.enabled && !!this.runtimes?.connected(projectId);
  }
  /** Each room less what already waits for it: queued work is reserved before a new request. */
  async free(projectId: string, tx?: Transaction): Promise<number> {
    if (tx) this.state.assertTransaction(tx);
    if (!this.connected(projectId)) return 0;
    const open = await (tx ? this.all(tx) : this.state.read((sql) => this.all(sql)));
    const mine = open.filter((a) => a.projectId === projectId).length;
    return Math.max(
      0,
      Math.min(this.config.globalLimit - open.length, this.limit(projectId) - mine),
    );
  }
  async describe(projectId: string, key: string) {
    return this.connected(projectId) ? this.runtimes!.describe(projectId, key) : null;
  }
  private limit(projectId: string): number {
    return this.config.projectLimits[projectId] ?? this.config.projectLimit;
  }
  /** A profile no longer configured rents, launches, renews and admits nothing: its machine stops. */
  private stale(a: FleetAllocation): boolean {
    return !this.runtimes?.profiles.some((profile) => profile.id === a.profileId);
  }
  /** Coalesced: many kicks make one pass now and one after the next commit. */
  kick(): void {
    // Owners register after Fleet starts and a pass stops what has none: wait for the first.
    if (!this.unlisten || !this.awake || this.closed) return;
    this.watching = true;
    this.wake(0);
  }
  private wake(ms: number): void {
    if (this.closed || Date.now() + ms >= this.due) return;
    clearTimeout(this.timer);
    this.due = Date.now() + ms;
    this.detached(() => (this.timer = setTimeout(() => void this.pass(), ms).unref()));
  }
  /** A full pass each poll interval; in between, each second, only what is not yet steady. */
  private async pass(): Promise<void> {
    this.due = Infinity;
    // Never join a reconcile that began before the change this pass was woken for.
    await this.pending?.catch(() => undefined);
    const full = Date.now() >= this.fullAt;
    if (full) this.fullAt = Date.now() + this.config.pollIntervalMs;
    const busy = await this.run(full).catch(() => false);
    this.wake(busy ? Math.min(1000, this.config.pollIntervalMs / 5) : this.fullAt - Date.now());
  }
  registerOwner(kind: string, owner: FleetOwner): () => void {
    check(!this.closed, 'fleet_closed', 'Fleet is closed', 503);
    check(
      token.safeParse(kind).success && !this.owners.has(kind),
      'fleet_owner_conflict',
      'Fleet owner is invalid or already registered',
    );
    this.owners.set(kind, owner);
    return () => {
      if (this.owners.get(kind) === owner) this.owners.delete(kind);
    };
  }
  private time() {
    return new Date(this.clock()).toISOString();
  }
  private deadline() {
    return new Date(this.clock() + this.config.allocationTimeoutSeconds * 1000).toISOString();
  }
  private async get(sql: Sql, id: string): Promise<FleetAllocation> {
    const row = await sql.get<Row>('SELECT data_json FROM fleet_allocations WHERE id=?', id);
    check(row, 'fleet_not_found', 'Fleet allocation not found', 404);
    return decode(row);
  }
  private async all(sql: Sql): Promise<FleetAllocation[]> {
    return (
      await sql.all<Row>(
        "SELECT data_json FROM fleet_allocations WHERE phase <> 'released' ORDER BY created_at,id",
      )
    ).map(decode);
  }
  async inspectOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation> {
    if (tx) this.state.assertTransaction(tx);
    const read = async (sql: Sql) => {
      const allocation = await this.get(sql, id);
      check(
        this.owners.get(allocation.owner.kind) === owner,
        'fleet_owner_denied',
        'Only the registered owner may inspect this allocation',
        403,
      );
      return structuredClone(allocation);
    };
    return tx ? read(tx) : this.state.read(read);
  }
  async listOwned(owner: FleetOwner, targets: string[]): Promise<FleetAllocation[]> {
    const kind = [...this.owners].find(([, value]) => value === owner)?.[0];
    check(kind, 'fleet_owner_denied', 'Only a registered owner may list its allocations', 403);
    const ids = targets.map(() => '?').join(',') || 'NULL';
    const rows = await this.state.read((sql) =>
      sql.all<Row>(
        `SELECT data_json FROM fleet_allocations WHERE data_json::jsonb #>> '{owner,kind}'=? AND
         (phase<>'released' OR data_json::jsonb #>> '{owner,id}' IN (${ids})) ORDER BY created_at,id`,
        kind,
        ...targets,
      ),
    );
    return rows.map(decode);
  }
  async cancelOwned(owner: FleetOwner, id: string, tx?: Transaction): Promise<FleetAllocation> {
    return inTransaction(this.state, tx, async (tx) => {
      const allocation = await this.inspectOwned(owner, id, tx);
      const before = structuredClone(allocation);
      if (allocation.phase !== 'released') allocation.intent = 'stop';
      if (allocation.phase === 'queued') allocation.phase = 'released';
      await this.save(tx, allocation, before);
      this.kick();
      return structuredClone(allocation);
    });
  }
  /** `caller` is who changed it, when not the allocation's source or Fleet itself. */
  private async save(
    tx: Transaction,
    a: FleetAllocation,
    before: FleetAllocation,
    caller?: Caller,
  ): Promise<void> {
    if (digest(a) === digest(before)) return;
    const moved = a.phase !== before.phase || a.intent !== before.intent;
    if (moved) a.updatedAt = this.time();
    await tx.run(
      'UPDATE fleet_allocations SET phase=?,data_json=? WHERE id=?',
      a.phase,
      JSON.stringify(a),
      a.id,
    );
    if (moved)
      await this.state.appendEvent(tx, {
        projectId: a.projectId,
        actorId: caller?.actorId ?? a.source.actorId,
        type: 'fleet.changed',
        subjectId: a.id,
        data: {
          phase: a.phase,
          intent: a.intent,
          owner: a.owner,
          ...(caller ? eventSource(caller) : {}),
        },
      });
  }
  async request(caller: Caller, input: FleetRequest, tx?: Transaction): Promise<FleetAllocation> {
    check(
      !this.closed && this.config.enabled,
      'fleet_disabled',
      'Fleet admission is disabled',
      503,
    );
    const parsed = requestSchema.safeParse(input);
    check(parsed.success, 'invalid_fleet_request', 'Fleet request is invalid');
    input = parsed.data;
    check(!caller.session, 'fleet_forbidden', 'Assignment agents cannot allocate machines', 403);
    const owner = this.owners.get(input.owner.kind);
    check(owner, 'fleet_owner_unavailable', 'Fleet owner is unavailable', 503);
    const place = (owner.rentsInHost && this.config.hostProjectId) || caller.projectId;
    // Without a connection no create can ever succeed, and an admitted request would hold a slot.
    check(
      this.connected(place),
      'sandbox_not_connected',
      'Hosted agents are not set up for this project yet',
      403,
    );
    return inTransaction(this.state, tx, async (tx) => {
      await this.scope.require(caller, owner.sourcePermission ?? 'write', tx);
      const source = await this.scope.delegationSource(caller, tx);
      const sourceHash = digest(source);
      const fingerprint = digest(input);
      const previous = await tx.get<Row & { input_hash: string }>(
        'SELECT data_json,input_hash FROM fleet_allocations WHERE project_id=? AND source_hash=? AND request_id=?',
        caller.projectId,
        sourceHash,
        input.requestId,
      );
      if (previous) {
        check(
          previous.input_hash === fingerprint,
          'request_conflict',
          'Fleet requestId was reused with different input',
          409,
        );
        return decode(previous);
      }
      const profile = this.runtimes!.profiles.find(
        (p) => !input.profile || p.key === input.profile,
      );
      check(profile, 'fleet_profile_unavailable', 'That machine is not offered', 409);
      const a: FleetAllocation = {
        id: newId('flt'),
        projectId: caller.projectId,
        source,
        owner: input.owner,
        requestId: input.requestId,
        ...(place !== caller.projectId && { rentedIn: place }),
        profileId: profile.id,
        epoch: 1,
        phase: 'queued',
        intent: 'run',
        runtime: null,
        createAttempted: false,
        createdAt: this.time(),
        updatedAt: this.time(),
        deadlineAt: this.deadline(),
        retryAt: null,
        failures: 0,
        error: null,
      };
      check(
        await owner.valid(a, tx),
        'fleet_owner_denied',
        'Fleet owner refused this allocation',
        403,
      );
      await tx.run(
        'INSERT INTO fleet_allocations(id,project_id,source_hash,request_id,input_hash,phase,created_at,data_json) VALUES(?,?,?,?,?,?,?,?)',
        a.id,
        a.projectId,
        sourceHash,
        a.requestId,
        fingerprint,
        a.phase,
        a.createdAt,
        JSON.stringify(a),
      );
      await this.state.appendEvent(tx, {
        projectId: a.projectId,
        actorId: a.source.actorId,
        type: 'fleet.requested',
        subjectId: a.id,
        data: { owner: a.owner },
      });
      this.kick();
      return structuredClone(a);
    });
  }
  async inspect(caller: Caller, id: string, tx?: Transaction): Promise<FleetAllocation> {
    const read = async (tx: Transaction) => {
      await this.scope.require(caller, 'read', tx);
      const a = await this.get(tx, id);
      check(a.projectId === caller.projectId, 'fleet_not_found', 'Fleet allocation not found', 404);
      return a;
    };
    return tx
      ? inTransaction(this.state, tx, read)
      : this.state.snapshot(() => this.state.transaction(read));
  }
  async list(caller: Caller, recent?: number): Promise<FleetAllocation[]> {
    return this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        await this.scope.require(caller, 'read', tx);
        return (
          await tx.all<Row>(
            `SELECT data_json FROM fleet_allocations WHERE project_id=? AND (phase<>'released' OR id IN
              (SELECT id FROM fleet_allocations WHERE project_id=? AND phase='released'
               ORDER BY created_at DESC,id DESC LIMIT ?)) ORDER BY created_at,id`,
            caller.projectId,
            caller.projectId,
            recent ?? null,
          )
        ).map(decode);
      }),
    );
  }
  private async changeIntent(caller: Caller, id: string, intent: FleetIntent, tx?: Transaction) {
    return inTransaction(this.state, tx, async (tx) => {
      const a = await this.inspect(caller, id, tx);
      check(!caller.session, 'fleet_forbidden', 'Assignment agents cannot control machines', 403);
      const source = await this.scope.delegationSource(caller, tx);
      if (digest(source) !== digest(a.source)) await this.scope.require(caller, 'admin', tx);
      const before = structuredClone(a);
      if (a.phase !== 'released' && a.intent !== 'stop') a.intent = intent;
      if (a.phase === 'queued' && a.intent !== 'run') a.phase = 'released';
      await this.save(tx, a, before, caller);
      this.kick();
      return a;
    });
  }
  cancel(caller: Caller, id: string, tx?: Transaction) {
    return this.changeIntent(caller, id, 'stop', tx);
  }
  drain(caller: Caller, id: string, tx?: Transaction) {
    return this.changeIntent(caller, id, 'drain', tx);
  }
  async admits(id: string, epoch: number, tx: Transaction): Promise<boolean> {
    this.state.assertTransaction(tx);
    const a = await this.get(tx, id);
    if (
      this.closed ||
      !this.config.enabled ||
      a.epoch !== epoch ||
      a.intent !== 'run' ||
      !['starting', 'running'].includes(a.phase) ||
      !a.runtime?.ready ||
      a.runtime.launch?.deliveryState !== 'launched' ||
      a.deadlineAt <= this.time() ||
      this.stale(a)
    )
      return false;
    const owner = this.owners.get(a.owner.kind);
    return !!owner && this.authorized(a, owner, tx);
  }
  /** Current source authority, then the owner's own check; a revoked source is simply invalid. */
  private async authorized(a: FleetAllocation, owner: FleetOwner, tx: Transaction) {
    try {
      await this.scope.requireDelegation(a.source, owner.sourcePermission ?? 'write', tx);
    } catch (error) {
      if (error instanceof MervError && [401, 403].includes(error.status)) return false;
      throw error;
    }
    return owner.valid(a, tx);
  }
  async tick(): Promise<void> {
    await this.run(true);
  }
  /** Only a full pass looks at steady machines; true while anything is not steady. */
  private run(full: boolean): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return (this.pending ??= this.reconcile(full).finally(() => {
      this.pending = undefined;
    }));
  }
  private async reserve(): Promise<void> {
    if (!this.config.enabled || !this.runtimes) return;
    const waiting = await this.state.read((sql) => this.all(sql));
    const queued = waiting.filter((a) => a.phase === 'queued');
    if (!queued.length) return;
    const active = waiting.filter(occupied);
    const projectCount = new Map<string, number>();
    for (const a of active) projectCount.set(a.projectId, (projectCount.get(a.projectId) ?? 0) + 1);
    const dropped = (a: FleetAllocation) =>
      a.intent !== 'run' ||
      a.deadlineAt <= this.time() ||
      this.stale(a) ||
      !this.owners.has(a.owner.kind);
    const hasRoom =
      active.length < this.config.globalLimit &&
      queued.some((a) => (projectCount.get(a.projectId) ?? 0) < this.limit(a.projectId));
    if (!queued.some(dropped) && !hasRoom) return;
    await this.state.transaction(async (tx) => {
      const allocations = await this.all(tx);
      let count = allocations.filter(occupied).length;
      const byProject = new Map<string, number>();
      for (const active of allocations.filter(occupied))
        byProject.set(active.projectId, (byProject.get(active.projectId) ?? 0) + 1);
      for (const a of allocations.filter((a) => a.phase === 'queued')) {
        const before = structuredClone(a);
        if (dropped(a)) {
          a.intent = 'stop';
          a.phase = 'released';
        } else if (
          count < this.config.globalLimit &&
          (byProject.get(a.projectId) ?? 0) < this.limit(a.projectId)
        ) {
          a.phase = 'provisioning';
          // The machine's time starts here; waiting in the queue does not spend it.
          a.deadlineAt = this.deadline();
          count++;
          byProject.set(a.projectId, (byProject.get(a.projectId) ?? 0) + 1);
        }
        await this.save(tx, a, before);
      }
    });
  }
  private async update(id: string, mutate: (a: FleetAllocation) => void): Promise<FleetAllocation> {
    return this.state.transaction(async (tx) => {
      const a = await this.get(tx, id),
        before = structuredClone(a);
      mutate(a);
      await this.save(tx, a, before);
      return a;
    });
  }
  private async observed(
    a: FleetAllocation,
    runtime: SandboxRuntimeHandle,
    phase: FleetAllocation['phase'],
  ): Promise<FleetAllocation> {
    // Sandboxes increments its revision for tunnel heartbeats too. Keep the fresh
    // revision in memory without turning those observations into State writes.
    const facts = (handle: SandboxRuntimeHandle | null) => {
      if (!handle) return null;
      const { revision: _revision, ...meaningful } = handle;
      return meaningful;
    };
    if (
      digest(facts(runtime)) === digest(facts(a.runtime)) &&
      phase === a.phase &&
      !a.error &&
      !a.failures
    )
      return { ...a, runtime };
    return this.update(a.id, (current) => {
      check(
        !current.runtime || current.runtime.sandboxId === runtime.sandboxId,
        'fleet_runtime_conflict',
        'Allocation cannot adopt a second machine',
        409,
      );
      if (current.phase === 'released') return;
      // Concurrent replies cannot replace a later runtime receipt/revision with an older one.
      if (
        current.runtime &&
        (current.runtime.revision > runtime.revision ||
          (current.runtime.launch && !runtime.launch) ||
          (current.runtime.launch?.deliveryState === 'launched' &&
            runtime.launch?.deliveryState !== 'launched'))
      )
        return;
      current.runtime = runtime;
      current.phase = runtime.deleted
        ? 'released'
        : current.intent === 'stop'
          ? 'releasing'
          : phase;
      current.retryAt = null;
      current.failures = 0;
      current.error = null;
    });
  }
  /** Recheck durable cancellation and source authority after slow bootstrap work. */
  private async launchAllowed(
    a: FleetAllocation,
    owner: FleetOwner,
    handle: SandboxRuntimeHandle,
  ): Promise<boolean> {
    return this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const current = await this.get(tx, a.id);
        if (
          this.closed ||
          !this.config.enabled ||
          this.owners.get(current.owner.kind) !== owner ||
          current.intent !== 'run' ||
          current.phase === 'released' ||
          current.phase === 'releasing' ||
          current.deadlineAt <= this.time() ||
          this.stale(current) ||
          current.runtime?.sandboxId !== handle.sandboxId ||
          current.runtime.launch?.deliveryState === 'launched'
        )
          return false;
        return this.authorized(current, owner, tx);
      }),
    );
  }
  private async renewalAllowed(
    a: FleetAllocation,
    owner: FleetOwner,
    handle: SandboxRuntimeHandle,
  ): Promise<boolean> {
    return this.state.snapshot(() =>
      this.state.transaction(async (tx) => {
        const current = await this.get(tx, a.id);
        if (
          this.closed ||
          !this.config.enabled ||
          this.owners.get(current.owner.kind) !== owner ||
          !['run', 'drain'].includes(current.intent) ||
          !['starting', 'running'].includes(current.phase) ||
          current.deadlineAt <= this.time() ||
          this.stale(current) ||
          current.runtime?.sandboxId !== handle.sandboxId ||
          current.runtime.launch?.deliveryState !== 'launched'
        )
          return false;
        return this.authorized(current, owner, tx);
      }),
    );
  }
  private async reconcile(full = true): Promise<boolean> {
    this.awake ||= full;
    await this.reserve();
    const allocations = await this.state.read((sql) => this.all(sql));
    if (!this.runtimes) return false;
    await Promise.all(
      allocations
        .filter(
          (a) => occupied(a) && (full || !steady(a)) && (!a.retryAt || a.retryAt <= this.time()),
        )
        .map(async (a) => {
          try {
            await this.advance(a);
          } catch (error) {
            report('fleet.retry', a, error);
            await this.update(a.id, (current) => {
              if (current.phase === 'released') return;
              // Cloudflare lists a new machine a second or two after making it, so its first
              // launch is often refused: retry that each second for a minute before counting.
              const launching =
                current.runtime?.launch === null &&
                Date.parse(current.updatedAt) > this.clock() - 60_000;
              // Sandboxes answers that launch 503 provider_unavailable before delivering anything:
              // the machine is still starting, not uncertain.
              const booting =
                launching &&
                error instanceof MervError &&
                error.code === 'sandbox_provider_unavailable';
              if (current.intent === 'stop') this.waitOutLease(current);
              // A launched machine keeps its phase, and its worker admission, within its lease.
              else if (
                !booting &&
                (!['starting', 'running'].includes(current.phase) ||
                  (current.runtime?.leaseExpiresAt ?? '') <= this.time())
              )
                current.phase = 'uncertain';
              if (!launching) current.failures++;
              current.error = 'runtime_unavailable';
              current.retryAt = new Date(
                this.clock() +
                  (launching ? 1000 : Math.min(60_000, 1000 * 2 ** Math.min(current.failures, 6))),
              ).toISOString();
            });
          }
        }),
    );
    return allocations.some((a) => !steady(a));
  }
  private async advance(a: FleetAllocation): Promise<void> {
    const runtime = this.runtimes!;
    const place = a.rentedIn ?? a.projectId;
    const owner = this.owners.get(a.owner.kind);
    if (
      a.intent !== 'stop' &&
      (a.deadlineAt <= this.time() || this.stale(a) || !this.config.enabled || !owner)
    )
      a = await this.update(a.id, (current) => {
        current.intent = 'stop';
      });
    if (a.intent !== 'stop' && owner) {
      const valid = await this.state.snapshot(() =>
        this.state.transaction(async (tx) => this.authorized(await this.get(tx, a.id), owner, tx)),
      );
      if (!valid)
        a = await this.update(a.id, (current) => {
          current.intent = 'stop';
        });
    }
    if (!a.runtime) {
      // A false marker proves no create could have happened; older records count as attempted.
      let first = false;
      let create = false;
      a = await this.update(a.id, (current) => {
        if (current.runtime || current.phase === 'released') return;
        const connected = runtime.connected(place);
        const configured = !this.stale(current);
        if (current.intent === 'run' && connected && configured && owner) {
          first = current.createAttempted === false;
          create = current.createAttempted = true;
          return;
        }
        // One last same-key create recovers a machine made before a lost reply, to delete it
        // (never under a changed profile). Then Fleet waits out the lease of any such machine.
        create = current.createAttempted !== false && !current.releaseBy && connected && configured;
        if (!connected && current.createAttempted === false) current.error = 'runtime_refused';
        current.intent = 'stop';
        this.waitOutLease(current);
      });
      if (!create) return;
      const handle = await runtime
        .provision(place, `${a.id}:create`, a.profileId)
        .catch((error) => {
          // Refusing the first attempt proves no machine exists: free the slot, do not retry.
          if (!first || !refused(error)) throw error;
          report('fleet.refused', a, error);
        });
      if (handle) await this.observed(a, handle, 'provisioning');
      else
        await this.update(a.id, (current) => {
          if (current.runtime) return;
          current.intent = 'stop';
          current.phase = 'released';
          current.error = 'runtime_refused';
        });
      return;
    }
    const handle = await runtime.inspect(place, a.runtime);
    a = await this.observed(a, handle, a.phase);
    if (a.phase === 'released') return;
    if (
      handle.state === 'failed' ||
      handle.state === 'deleting' ||
      handle.launch?.state === 'revoked'
    )
      a = await this.update(a.id, (current) => {
        current.intent = 'stop';
      });
    if (a.intent === 'stop') {
      await this.observed(a, await runtime.stop(place, a.runtime!), 'releasing');
      return;
    }
    if (!owner || !handle.ready) return;
    if (handle.launch?.deliveryState !== 'launched') {
      if (a.intent === 'drain') {
        await this.update(a.id, (current) => {
          current.intent = 'stop';
        });
        return;
      }
      if (!(await this.launchAllowed(a, owner, handle))) return;
      const bootstrap = await owner.bootstrap(structuredClone(a));
      if (!(await this.launchAllowed(a, owner, handle))) return;
      const launched = await runtime.launch(
        place,
        handle,
        `${a.id}:launch`,
        bootstrap,
        a.profileId,
      );
      await this.observed(
        a,
        launched,
        launched.launch?.deliveryState === 'launched' ? 'starting' : 'uncertain',
      );
      return;
    }
    const status = await owner.observe(structuredClone(a));
    let exchanged = handle;
    if (status === 'running') {
      if (handle.launch?.state === 'pending') exchanged = await runtime.acknowledge(place, handle);
      a = await this.observed(a, exchanged, status);
    }
    if (status === 'finished') {
      a = await this.update(a.id, (current) => {
        current.intent = 'stop';
      });
      await this.observed(a, await runtime.stop(place, a.runtime!), 'releasing');
    } else {
      if (status === 'starting') await this.observed(a, handle, status);
      if (
        handle.leaseExpiresAt &&
        Date.parse(handle.leaseExpiresAt) - this.clock() < 60_000 &&
        (await this.renewalAllowed(a, owner, handle))
      )
        await this.observed(a, await runtime.renew(place, exchanged, a.profileId), status);
    }
  }
  /** Fleet renews nothing once stopped, so past `releaseBy` the provider lease has ended any
   * machine this allocation could hold (a minute covers a reply still in flight; the longest
   * configured lease covers every profile). Without a create attempt there is none to wait for. */
  private waitOutLease(a: FleetAllocation): void {
    const lease = Math.max(...this.runtimes!.profiles.map((profile) => profile.leaseSeconds));
    a.releaseBy ??= new Date(this.clock() + (lease + 60) * 1000).toISOString();
    a.phase =
      (!a.runtime && a.createAttempted === false) || a.releaseBy <= this.time()
        ? 'released'
        : 'releasing';
  }
  /** Disposal fences admission durably, then makes one bounded provider cleanup pass.
   * Pending deletes remain counted and are reconciled when the plugin is re-enabled.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.unlisten?.();
    this.closing = (async () => {
      await this.pending?.catch(() => undefined);
      await this.state.transaction(async (tx) => {
        for (const a of await this.all(tx)) {
          const before = structuredClone(a);
          a.intent = 'stop';
          if (a.phase === 'queued') a.phase = 'released';
          a.retryAt = null;
          await this.save(tx, a, before);
        }
      });
      await this.reconcile();
      this.owners.clear();
    })();
    return this.closing;
  }
}

export const fleetPlugin = {
  name: 'merv-fleet',
  Config: fleetConfig,
  inject: ['state', 'scope', 'sandboxes'],
  async apply(ctx: Context, config: FleetConfig) {
    const fleet = new FleetService(ctx.state, ctx.scope, ctx.sandboxes.runtimes, config);
    await fleet.initialize();
    ctx.effect(() => () => fleet.close());
    ctx.provide('fleet', fleet);
    fleet.start();
  },
};
export default fleetPlugin;
