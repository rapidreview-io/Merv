import type { Context } from 'cordis';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  sourceCaller,
  type Actor,
  type DelegationSource,
  type Scope,
  type Transaction,
} from '@merv/contracts';
import type { Sessions, ManagedRunnerBindingIdentity } from '@merv/sessions/types';
import type { Fleet, FleetAllocation, FleetOwner } from './types.js';

/** A deployment opt-in. Fleet still owns all machine limits and lifecycle transitions. */
const workflowConfig = z
  .object({
    enabled: z.boolean().default(false),
    /** Whose choice of Fleet it serves: sign-in identities as 'issuer subject', or '*' for all. */
    people: z
      .array(z.string().regex(/^(\*|\S+ \S+)$/))
      .max(100)
      .default([]),
    modelApiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    baseUrl: z.string().url().max(2048).optional(),
    maxAgents: z.number().int().min(1).max(64).default(10),
    maxAgentsPerPerson: z.number().int().min(1).max(64).default(5),
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
const demandInput = { platform: hostedCodexPlatform, capabilities: [...hostedCodexCapabilities] };
/** Messages may carry credentials; operators get the project and the finite code only. */
const skipped = (projectId: string, error: unknown) => {
  const code = error instanceof MervError ? error.code : 'unexpected';
  process.stderr.write(`${JSON.stringify({ event: 'fleet.workflow_skipped', projectId, code })}\n`);
};

/** The narrow Sessions-to-Fleet bridge. No user-facing tools or research dependency. */
export class FleetWorkflowAdapter implements FleetOwner {
  /** Work in a project without its own Sandboxes connection rents through the host. */
  readonly rentsInHost = true;
  private readonly config: z.infer<typeof workflowConfig>;
  private modelApiKey?: string;
  /** The projects the last reconcile rented for. */
  private served = new Set<string>();
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
        this.config.people.length && this.config.modelApiKeyEnv && this.config.baseUrl,
        'invalid_fleet_workflow_config',
        'Enabled Fleet workflow needs its people, a model key and API URL',
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
          serves: (projectId) => this.served.has(projectId),
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
    // A missing model key leaves demand unserved, never the server down.
    await this.reconcile().catch(() => undefined);
  }
  /** Revocation is fenced by each allocation's own source; a new director lets work finish. */
  private accepted(a: FleetAllocation): boolean {
    return a.owner.kind === ownerKind;
  }
  async valid(a: FleetAllocation, _tx: Transaction): Promise<boolean> {
    return !this.closed && this.accepted(a) && a.deadlineAt > new Date(this.clock()).toISOString();
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
      this.accepted(a) && this.modelApiKey && this.config.baseUrl,
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
      modelApiKey: this.modelApiKey,
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
    const demand = await this.sessions.dispatchDemand(sourceCaller(a.source), demandInput);
    const grace = observed?.runnerId ? emptyRunnerGraceMs : startupGraceMs;
    if (!demand.candidates.length && this.clock() - Date.parse(a.createdAt) >= grace)
      return 'finished';
    return observed?.runnerId ? 'running' : 'starting';
  }
  /** Idempotent demand reconciliation; pending Fleet allocations cover their target revision. */
  reconcile(): Promise<void> {
    if (!this.config.enabled || this.closed) return Promise.resolve();
    return (this.pending ??= this.reconcileOnce().finally(() => {
      this.pending = undefined;
    }));
  }
  /** Serves each project whose admin chose Fleet, as that admin, while they may write and are
   * one of its people; a failure in one project leaves the others served. */
  private async reconcileOnce(): Promise<void> {
    this.modelApiKey ??= process.env[this.config.modelApiKeyEnv!];
    check(this.modelApiKey, 'fleet_workflow_secret', 'Fleet model key is unavailable', 503);
    // Who a source acts as while it may write; null once it may not, which also stops its machines.
    const director = (source: DelegationSource) =>
      this.scope.requireDelegation(source, 'write').catch((error: unknown) => {
        if (error instanceof MervError && [401, 403].includes(error.status)) return null;
        throw error;
      });
    // One person across projects: their sign-in identity, else the machine actor itself, which
    // only '*' lists, since an identity is two words.
    const person = (actor: Actor | null, source: DelegationSource) =>
      actor?.user ? `${actor.user.issuer} ${actor.user.subject}` : (actor?.id ?? source.actorId);
    const everyone = this.config.people.includes('*');
    const served = new Map<string, { source: DelegationSource; who: string; wanted: string[] }>();
    for (const { projectId, source } of await this.sessions.servedSources()) {
      try {
        const actor = await director(source);
        const who = person(actor, source);
        if (!actor || !(everyone || this.config.people.includes(who))) continue;
        const demand = await this.sessions.dispatchDemand(sourceCaller(source), demandInput);
        served.set(projectId, { source, who, wanted: demand.candidates.map(targetId) });
      } catch (error) {
        skipped(projectId, error);
      }
    }
    this.served = new Set(served.keys());
    const allocations = await this.fleet.listOwned(
      this,
      [...served.values()].flatMap((project) => project.wanted),
    );
    const active = allocations.filter(occupied);
    for (const a of active)
      if (
        a.intent === 'run' &&
        !launched(a) &&
        !served.get(a.projectId)?.wanted.includes(a.owner.id)
      )
        await this.fleet.cancelOwned(this, a.id);
    const load = new Map<string, number>();
    for (const a of active) {
      const who = person(await director(a.source), a.source);
      load.set(who, (load.get(who) ?? 0) + 1);
    }
    const covered = new Set(active.filter((a) => a.intent === 'run').map((a) => a.owner.id));
    let slots = Math.max(0, this.config.maxAgents - active.length);
    const queue = [...served].flatMap(([projectId, { source, who, wanted }]) =>
      wanted.map((id) => ({ projectId, source, who, id })),
    );
    for (const { projectId, source, who, id } of queue) {
      if (!slots || covered.has(id) || !this.served.has(projectId)) continue;
      if ((load.get(who) ?? 0) >= this.config.maxAgentsPerPerson) continue;
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
      try {
        await this.fleet.request(sourceCaller(source), {
          requestId: `wf:${digest({ id, generation })}`,
          owner: { kind: ownerKind, id },
        });
      } catch (error) {
        // Fleet refuses this project (no connection, say): it is not served.
        skipped(projectId, error);
        this.served.delete(projectId);
        continue;
      }
      covered.add(id);
      slots--;
      load.set(who, (load.get(who) ?? 0) + 1);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.pending?.catch(() => undefined);
    for (const dispose of this.disposers.reverse()) dispose();
    this.disposers = [];
    this.modelApiKey = undefined;
  }
}

declare module 'cordis' {
  interface Context {
    fleetWorkflow: FleetWorkflowAdapter;
  }
}

export const fleetWorkflowPlugin = {
  name: 'merv-fleet-workflow',
  inject: ['fleet', 'sessions', 'scope'],
  async apply(ctx: Context, config: FleetWorkflowConfig = {}) {
    const adapter = new FleetWorkflowAdapter(ctx.fleet, ctx.sessions, ctx.scope, config);
    await adapter.start();
    ctx.effect(() => () => adapter.close());
    ctx.provide('fleetWorkflow', adapter);
  },
};
export default fleetWorkflowPlugin;
