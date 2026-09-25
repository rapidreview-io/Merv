import type { Context } from 'cordis';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  type Caller,
  type Scope,
  type Transaction,
} from '@merv/contracts';
import type { Sessions, ManagedRunnerBindingIdentity } from '@merv/sessions/types';
import type { Fleet, FleetAllocation, FleetOwner } from './types.js';
import { codexModelRelay } from './codex-relay.js';

/** A deployment opt-in. Fleet still owns all machine limits and lifecycle transitions. */
const workflowConfig = z
  .object({
    enabled: z.boolean().default(false),
    projectId: z.string().min(1).max(200).optional(),
    sourceCredentialEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    modelApiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    baseUrl: z.string().url().max(2048).optional(),
    maxAgents: z.number().int().min(1).max(32).default(1),
    dailyTokensPerPerson: z.number().int().min(1).default(5_000_000),
    pollIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .strict();
export type FleetWorkflowConfig = z.input<typeof workflowConfig>;

const ownerKind = 'workflow';
const startupGraceMs = 60_000;
const emptyRunnerGraceMs = 30_000;
const unclaimedRetryCooldownMs = 60_000;
const unclaimedAttemptLimit = 2;
/** The image-owned runner advertises this exact profile; Git is transport inside Code v2. */
export const hostedCodexPlatform = Object.freeze({
  name: 'hosted-codex',
  harness: 'codex' as const,
  model: 'gpt-6-luna',
  enabled: true,
  parallelism: 1,
});
export const hostedCodexCapabilities = Object.freeze(['code.v2']);
const targetId = (candidate: { instanceId: string; expectedRevision: number }) =>
  `${candidate.instanceId}:${candidate.expectedRevision}`;
const occupied = (allocation: FleetAllocation) => allocation.phase !== 'released';
/** Before Fleet observes the launch no runner can have enrolled, so nothing claimed is at stake. */
const launched = (a: FleetAllocation) => a.runtime?.launch?.deliveryState === 'launched';

/** The narrow Sessions-to-Fleet bridge. No user-facing tools or research dependency. */
export class FleetWorkflowAdapter implements FleetOwner {
  readonly config: z.infer<typeof workflowConfig>;
  private caller?: Caller;
  /** Why the last reconcile could not serve hosted demand; null once one succeeds. */
  unavailable: string | null = null;
  private disposers: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;

  constructor(
    private readonly fleet: Fleet,
    private readonly sessions: Sessions,
    private readonly scope: Scope,
    config: FleetWorkflowConfig = {},
    private readonly clock: () => number = Date.now,
  ) {
    const parsed = workflowConfig.safeParse(config);
    check(
      parsed.success,
      'invalid_fleet_workflow_config',
      'Fleet workflow configuration is invalid',
    );
    this.config = parsed.data;
    if (this.config.enabled)
      check(
        this.config.projectId &&
          this.config.sourceCredentialEnv &&
          this.config.modelApiKeyEnv &&
          this.config.baseUrl,
        'invalid_fleet_workflow_config',
        'Enabled Fleet workflow needs a project, source credential, model key and API URL',
      );
  }
  async start(): Promise<void> {
    if (!this.config.enabled) return;
    check(
      !this.closed && !this.timer,
      'fleet_workflow_started',
      'Fleet workflow is already started',
      409,
    );
    try {
      this.disposers.push(this.fleet.registerOwner(ownerKind, this));
      this.disposers.push(
        this.sessions.registerManagedValidator({
          current: async (binding, tx) => await this.current(binding, tx),
          admits: async (allocationId, epoch, tx) =>
            await this.fleet.admits(allocationId, epoch, tx),
        }),
      );
    } catch (error) {
      await this.close();
      throw error;
    }
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => undefined);
    }, this.config.pollIntervalMs);
    this.timer.unref();
    // A missing secret or revoked key leaves demand unserved with its reason, never the server down.
    await this.reconcile().catch(() => undefined);
  }
  private async connect(): Promise<Caller> {
    if (this.caller) return this.caller;
    const token = process.env[this.config.sourceCredentialEnv!];
    check(
      token && process.env[this.config.modelApiKeyEnv!],
      'fleet_workflow_secret',
      'Fleet workflow credentials are unavailable',
      503,
    );
    const actor = await this.scope.authenticate(token);
    check(
      actor.projectId === this.config.projectId,
      'fleet_workflow_source',
      'Fleet workflow source is outside its configured project',
      403,
    );
    return (this.caller = {
      actorId: actor.id,
      projectId: actor.projectId,
      credentialId: actor.credential.id,
    });
  }
  /** Revocation is fenced by each allocation's own source; a replaced key lets work finish. */
  private accepted(a: FleetAllocation): boolean {
    return a.owner.kind === ownerKind && a.projectId === this.config.projectId;
  }
  async valid(a: FleetAllocation, _tx: Transaction): Promise<boolean> {
    // Until its own source authenticates the adapter launches nothing; launched work runs on.
    return (
      !this.closed &&
      this.accepted(a) &&
      (!!this.caller || launched(a)) &&
      a.deadlineAt > new Date(this.clock()).toISOString()
    );
  }
  private async current(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean> {
    if (
      this.closed ||
      canonical(binding.platform) !== canonical(hostedCodexPlatform) ||
      canonical(binding.capabilities) !== canonical([...hostedCodexCapabilities])
    )
      return false;
    try {
      const a = await this.fleet.inspectOwned(this, binding.allocationId, tx);
      return (
        this.accepted(a) &&
        a.phase !== 'released' &&
        a.deadlineAt > new Date(this.clock()).toISOString() &&
        a.epoch === binding.epoch &&
        a.profileId === binding.runtimeProfileId &&
        a.deadlineAt === binding.expiresAt &&
        digest(a.source) === digest(binding.source)
      );
    } catch (error) {
      if (error instanceof MervError && [403, 404].includes(error.status)) return false;
      throw error;
    }
  }
  async bootstrap(a: FleetAllocation): Promise<string> {
    check(
      this.accepted(a) && this.config.baseUrl,
      'fleet_workflow_source',
      'Fleet workflow allocation is unavailable',
      403,
    );
    const { enrollmentToken } = await this.sessions.ensureManagedEnrollment({
      allocationId: a.id,
      epoch: a.epoch,
      source: a.source,
      runtimeProfileId: a.profileId,
      platform: hostedCodexPlatform,
      capabilities: [...hostedCodexCapabilities],
      expiresAt: a.deadlineAt,
    });
    return JSON.stringify({
      baseUrl: this.config.baseUrl,
      projectId: a.projectId,
      enrollmentToken,
    });
  }
  async observe(a: FleetAllocation): Promise<'starting' | 'running' | 'finished'> {
    check(
      this.accepted(a),
      'fleet_workflow_source',
      'Fleet workflow allocation is unavailable',
      403,
    );
    const observed = await this.sessions.inspectManaged(a.id, a.epoch);
    if (observed?.session) {
      const session = observed.session;
      return (session.status === 'released' || session.status === 'expired') &&
        session.releaseAcknowledged &&
        !session.capturePending
        ? 'finished'
        : 'running';
    }
    // A one-assignment supervisor that has not claimed work when its enrollment lapses never will.
    if (observed && Date.parse(observed.enrollmentExpiresAt) <= this.clock()) return 'finished';
    const demand = await this.sessions.dispatchDemand(await this.connect(), {
      platform: hostedCodexPlatform,
      capabilities: [...hostedCodexCapabilities],
    });
    const grace = observed?.runnerId ? emptyRunnerGraceMs : startupGraceMs;
    if (!demand.candidates.length && this.clock() - Date.parse(a.createdAt) >= grace)
      return 'finished';
    return observed?.runnerId ? 'running' : 'starting';
  }
  /** Idempotent demand reconciliation; pending Fleet allocations cover their target revision. */
  reconcile(): Promise<void> {
    if (!this.config.enabled || this.closed) return Promise.resolve();
    return (this.pending ??= this.reconcileOnce()
      .then(
        () => void (this.unavailable = null),
        (error: unknown) => {
          this.unavailable = error instanceof MervError ? error.code : 'fleet_workflow_unavailable';
          throw error;
        },
      )
      .finally(() => {
        this.pending = undefined;
      }));
  }
  private async reconcileOnce(): Promise<void> {
    const caller = await this.connect();
    const demand = await this.sessions.dispatchDemand(caller, {
      platform: hostedCodexPlatform,
      capabilities: [...hostedCodexCapabilities],
    });
    const allocations = (await this.fleet.list(caller)).filter((a) => this.accepted(a));
    const active = allocations.filter(occupied);
    const covered = new Set(active.filter((a) => a.intent === 'run').map((a) => a.owner.id));
    const wanted = new Set(demand.candidates.map(targetId));
    for (const a of active)
      if (!wanted.has(a.owner.id) && a.intent === 'run' && !launched(a))
        await this.fleet.cancelOwned(this, a.id);
    let slots = Math.max(0, this.config.maxAgents - active.length);
    for (const candidate of demand.candidates) {
      const id = targetId(candidate);
      if (!slots || covered.has(id)) continue;
      const released = allocations.filter((a) => a.owner.id === id && a.phase === 'released');
      let unclaimed = 0;
      let lastUnclaimedAt = 0;
      // A new task revision has a new id. For this exact revision, stop paying for
      // repeated machines that never claimed work; a claimed session starts a new streak.
      for (const a of released.toReversed()) {
        if (!a.createAttempted) continue;
        if ((await this.sessions.inspectManaged(a.id, a.epoch))?.session) break;
        unclaimed++;
        if (!lastUnclaimedAt) lastUnclaimedAt = Date.parse(a.updatedAt);
        if (unclaimed === unclaimedAttemptLimit) break;
      }
      if (
        unclaimed >= unclaimedAttemptLimit ||
        (unclaimed > 0 && this.clock() - lastUnclaimedAt < unclaimedRetryCooldownMs)
      )
        continue;
      const generation = released.length;
      await this.fleet.request(caller, {
        requestId: `wf:${digest({ id, generation })}`,
        owner: { kind: ownerKind, id },
      });
      covered.add(id);
      slots--;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    for (const dispose of this.disposers.reverse()) dispose();
    this.disposers = [];
  }
}

declare module 'cordis' {
  interface Context {
    fleetWorkflow: FleetWorkflowAdapter;
  }
}

export const fleetWorkflowPlugin = {
  name: 'merv-fleet-workflow',
  inject: ['fleet', 'sessions', 'scope', 'api', 'state'],
  async apply(ctx: Context, config: FleetWorkflowConfig = {}) {
    const adapter = new FleetWorkflowAdapter(ctx.fleet, ctx.sessions, ctx.scope, config);
    await adapter.start();
    ctx.effect(() => () => adapter.close());
    // The provider key stays on Main: hosted Codex calls the model through this relay.
    if (adapter.config.enabled) {
      const relay = await codexModelRelay(ctx.sessions, ctx.state, {
        providerKey: () => process.env[adapter.config.modelApiKeyEnv!] ?? '',
        dailyTokensPerPerson: adapter.config.dailyTokensPerPerson,
      });
      ctx.effect(() => ctx.api.mountModelRelay('/codex-model', relay));
    }
    ctx.provide('fleetWorkflow', adapter);
  },
};
export default fleetWorkflowPlugin;
