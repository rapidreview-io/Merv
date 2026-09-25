import type { Context } from 'cordis';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  sourceCaller,
  type Caller,
  type DelegationSource,
  type Scope,
  type Transaction,
} from '@merv/contracts';
import type { Sessions, ManagedRunnerBindingIdentity } from '@merv/sessions/types';
import type { Fleet, FleetAllocation, FleetOwner } from './types.js';
import { codexModelRelay, dailyTokens, setDailyTokens } from './codex-relay.js';

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
    /** A step's wall-clock cap; its machine is rented ten minutes longer, within Fleet's limit. */
    stepMinutes: z.number().int().min(10).max(1430).default(120),
    dailyTokensPerPerson: z.number().int().min(1).default(20_000_000),
    pollIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .strict();
export type FleetWorkflowConfig = z.input<typeof workflowConfig>;

const ownerKind = 'workflow';
const startupGraceMs = 60_000;
const emptyRunnerGraceMs = 30_000;
const releaseAckGraceMs = 120_000;
const unclaimedRetryCooldownMs = 60_000;
const unclaimedAttemptLimit = 2;
const walletRetryCooldownMs = 15 * 60_000;
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
  /** Fleet asks only that a source can read; valid() holds each to its director's permission. */
  readonly sourcePermission = 'read';
  /** A step in progress survives a Main release: the restarted adapter takes its machine back. */
  readonly keepsRunning = true;
  readonly config: z.infer<typeof workflowConfig>;
  /** The projects the last reconcile rented for. */
  private served = new Set<string>();
  /** Each project's review director actor, retained once made. */
  private reviewers = new Map<string, string>();
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
          retired: async (binding, tx) => await this.fleet.retired(binding.allocationId, tx),
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
  async valid(a: FleetAllocation, tx: Transaction): Promise<boolean> {
    return (
      !this.closed &&
      this.accepted(a) &&
      a.deadlineAt > new Date(this.clock()).toISOString() &&
      !!(await this.director(a.source, tx))
    );
  }
  /** A step's machine is for the person who directs it; a review director's, for its voucher.
   * Keyed as Pi keys a person, so one day's compute counts both. */
  async payer(source: DelegationSource, _ownerId: string, tx: Transaction): Promise<string | null> {
    const who = source.kind === 'service' ? source.vouchedBy : source;
    if (who.kind === 'human') return digest({ issuer: who.issuer, subject: who.subject });
    const actor = await this.scope.requireDelegation(who, 'read', tx).catch(() => null);
    return digest(
      actor?.user
        ? { issuer: actor.user.issuer, subject: actor.user.subject }
        : { projectId: who.projectId, actorId: who.actorId },
    );
  }
  /** Who a source acts as while it may direct Fleet's work, else null, which also stops its
   * machines: a person while they may write, the review director while it may review. */
  private director(source: DelegationSource, tx?: Transaction) {
    return this.scope
      .requireDelegation(source, source.kind === 'service' ? 'review' : 'write', tx)
      .catch((error: unknown) => {
        if (error instanceof MervError && [401, 403].includes(error.status)) return null;
        throw error;
      });
  }
  /** Fleet's own reviewer in the admin's project, vouched for by that admin, so a fresh agent
   * reviews what their hand may not: their and Pi's deliveries, and Code-provenance reviews. */
  private async reviewer(source: DelegationSource): Promise<DelegationSource> {
    const { projectId } = source;
    const actorId =
      this.reviewers.get(projectId) ??
      (await this.scope.serviceActor('fleet-review', projectId, undefined, 'reviewer')).actorId;
    this.reviewers.set(projectId, actorId);
    return { actorId, projectId, kind: 'service', vouchedBy: source };
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
      // A runner whose acknowledgement was lost, as when Main restarts while it closes, never
      // sends another: past the grace its machine stops anyway. The relay metered its tokens.
      const acknowledged =
        session.releaseAcknowledged ||
        (!!session.closedAt && this.clock() - Date.parse(session.closedAt) >= releaseAckGraceMs);
      return (session.status === 'released' || session.status === 'expired') &&
        acknowledged &&
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
   * one of its people, and its reviews that admin may not direct through its review director;
   * a failure in one project leaves the others served. */
  private async reconcileOnce(): Promise<void> {
    // The key stays on Main for the relay; without it no machine is rented to call the model.
    check(
      process.env[this.config.modelApiKeyEnv!],
      'fleet_workflow_secret',
      'Fleet model key is unavailable',
      503,
    );
    // One person across projects: their sign-in identity, else the machine actor itself, which
    // only '*' lists, since an identity is two words. A review director counts as its voucher.
    const person = async (source: DelegationSource) => {
      if (source.kind === 'service') source = source.vouchedBy;
      const actor = await this.director(source);
      return {
        actor,
        who: actor?.user ? `${actor.user.issuer} ${actor.user.subject}` : source.actorId,
      };
    };
    const everyone = this.config.people.includes('*');
    // Each target a project wants, with the director whose machine takes it.
    const served = new Map<string, Map<string, DelegationSource>>();
    for (const { projectId, source } of await this.sessions.servedSources()) {
      try {
        const { actor, who } = await person(source);
        if (!actor || !(everyone || this.config.people.includes(who))) continue;
        const wanted = new Map<string, DelegationSource>();
        for (const director of [source, await this.reviewer(source)])
          for (const target of (
            await this.sessions.dispatchDemand(sourceCaller(director), demandInput)
          ).candidates)
            if (!wanted.has(targetId(target))) wanted.set(targetId(target), director);
        served.set(projectId, wanted);
      } catch (error) {
        skipped(projectId, error);
      }
    }
    this.served = new Set(served.keys());
    const allocations = await this.fleet.listOwned(
      this,
      [...served.values()].flatMap((wanted) => [...wanted.keys()]),
    );
    const newestWallet = Math.max(
      0,
      ...allocations
        .filter((a) => a.error === 'wallet_refused')
        .map((a) => Date.parse(a.updatedAt)),
    );
    const newestAdmitted = Math.max(
      0,
      ...allocations.filter((a) => a.runtime).map((a) => Date.parse(a.updatedAt)),
    );
    const walletPaused = newestWallet > newestAdmitted;
    const active = allocations.filter(occupied);
    for (const a of active)
      if (a.intent === 'run' && !launched(a) && !served.get(a.projectId)?.has(a.owner.id))
        await this.fleet.cancelOwned(this, a.id);
    if (walletPaused && this.clock() - newestWallet < walletRetryCooldownMs) return;
    const covered = new Set(active.filter((a) => a.intent === 'run').map((a) => a.owner.id));
    let slots = Math.max(0, this.config.maxAgents - active.length);
    const queue = [...served].flatMap(([projectId, wanted]) =>
      [...wanted].map(([id, source]) => ({ projectId, source, id })),
    );
    for (const { projectId, source, id } of queue) {
      if (!slots || covered.has(id) || !this.served.has(projectId)) continue;
      const released = allocations.filter((a) => a.owner.id === id && a.phase === 'released');
      let unclaimed = 0;
      let lastUnclaimedAt = 0;
      // A new task revision has a new id. For this exact revision, stop paying for
      // repeated machines that never claimed work; a claimed session starts a new streak.
      for (const a of released.toReversed()) {
        if (!a.createAttempted || a.error === 'wallet_refused') continue;
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
          seconds: this.config.stepMinutes * 60 + 600,
        });
      } catch (error) {
        // Fleet refuses this project (no connection, say): it is not served.
        skipped(projectId, error);
        this.served.delete(projectId);
        continue;
      }
      covered.add(id);
      slots--;
      if (walletPaused) break;
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
  inject: ['fleet', 'sessions', 'scope', 'api', 'state', 'tools'],
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
      // A person's own daily limit: only they, signed in, read or change it, never an agent.
      const person = (caller: Caller) => {
        check(
          caller.human && !caller.key && !caller.session && !caller.conversation,
          'fleet_forbidden',
          'Only you, signed in, can see or change your daily tokens',
          403,
        );
        return digest({ issuer: caller.human!.issuer, subject: caller.human!.subject });
      };
      ctx.effect(() =>
        ctx.tools.register({
          name: 'fleet.daily_tokens',
          conversation: 'never' as const,
          description:
            'Your own daily limit of model tokens for Fleet workers, and what they used today (UTC). Only you, signed in, can change it.',
          inputSchema: z
            .object({ tokens: z.number().int().min(1).max(1_000_000_000).optional() })
            .strict(),
          handler: async (caller: Caller, input: { tokens?: number }) => {
            const who = person(caller);
            if (input.tokens !== undefined) await setDailyTokens(ctx.state, who, input.tokens);
            return await dailyTokens(ctx.state, who, adapter.config.dailyTokensPerPerson);
          },
        }),
      );
    }
    ctx.provide('fleetWorkflow', adapter);
  },
};
export default fleetWorkflowPlugin;
