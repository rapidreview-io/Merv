import type { Context } from 'cordis';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  type Caller,
  type DelegationSource,
  type Scope,
  type Transaction,
} from '@merv/contracts';
import type { Sessions, ManagedRunnerBindingIdentity } from '@merv/sessions/types';
import { sourceCaller } from '@merv/sessions/agents';
import type { Fleet, FleetAllocation, FleetOwner } from './types.js';

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
    pollIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .strict();
export type FleetWorkflowConfig = z.input<typeof workflowConfig>;

const ownerKind = 'workflow';
const startupGraceMs = 60_000;
const emptyRunnerGraceMs = 30_000;
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

/** The narrow Sessions-to-Fleet bridge. No user-facing tools or research dependency. */
export class FleetWorkflowAdapter implements FleetOwner {
  private readonly config: z.infer<typeof workflowConfig>;
  private caller?: Caller;
  private source?: DelegationSource;
  private modelApiKey?: string;
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
      !this.closed && !this.caller,
      'fleet_workflow_started',
      'Fleet workflow is already started',
      409,
    );
    const token = process.env[this.config.sourceCredentialEnv!];
    const modelApiKey = process.env[this.config.modelApiKeyEnv!];
    check(
      token && modelApiKey,
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
    const caller: Caller = {
      actorId: actor.id,
      projectId: actor.projectId,
      credentialId: actor.credential.id,
    };
    const source = await this.scope.delegationSource(caller);
    this.caller = caller;
    this.source = source;
    this.modelApiKey = modelApiKey;
    try {
      this.disposers.push(this.fleet.registerOwner(ownerKind, this));
      this.disposers.push(
        this.sessions.registerManagedValidator({
          current: async (binding, tx) => await this.current(binding, tx),
          admits: async (allocationId, epoch, tx) =>
            await this.fleet.admits(allocationId, epoch, tx),
        }),
      );
      this.timer = setInterval(() => {
        void this.reconcile().catch(() => undefined);
      }, this.config.pollIntervalMs);
      this.timer.unref();
      await this.reconcile();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private accepted(a: FleetAllocation): boolean {
    return (
      a.owner.kind === ownerKind &&
      a.projectId === this.config.projectId &&
      !!this.source &&
      digest(a.source) === digest(this.source)
    );
  }
  async valid(a: FleetAllocation, _tx: Transaction): Promise<boolean> {
    return !this.closed && this.accepted(a) && a.deadlineAt > new Date(this.clock()).toISOString();
  }
  private async current(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean> {
    if (
      this.closed ||
      !this.source ||
      digest(binding.source) !== digest(this.source) ||
      canonical(binding.platform) !== canonical(hostedCodexPlatform) ||
      canonical(binding.capabilities) !== canonical([...hostedCodexCapabilities])
    )
      return false;
    try {
      const a = await this.fleet.inspect(sourceCaller(binding.source), binding.allocationId, tx);
      return (
        this.accepted(a) &&
        a.phase !== 'released' &&
        a.deadlineAt > new Date(this.clock()).toISOString() &&
        a.epoch === binding.epoch &&
        a.profileId === binding.runtimeProfileId &&
        a.deadlineAt === binding.expiresAt &&
        a.projectId === binding.source.projectId
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      )
        return false;
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
    const demand = await this.sessions.dispatchDemand(this.caller!, {
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
    return (this.pending ??= this.reconcileOnce().finally(() => {
      this.pending = undefined;
    }));
  }
  private async reconcileOnce(): Promise<void> {
    const caller = this.caller!;
    const demand = await this.sessions.dispatchDemand(caller, {
      platform: hostedCodexPlatform,
      capabilities: [...hostedCodexCapabilities],
    });
    const allocations = (await this.fleet.list(caller)).filter((a) => this.accepted(a));
    const active = allocations.filter(occupied);
    const covered = new Set(active.filter((a) => a.intent === 'run').map((a) => a.owner.id));
    const wanted = new Set(demand.candidates.map(targetId));
    for (const a of active) {
      if (
        !wanted.has(a.owner.id) &&
        a.intent === 'run' &&
        ['queued', 'provisioning', 'launching'].includes(a.phase)
      )
        await this.fleet.cancel(caller, a.id);
    }
    let slots = Math.max(0, this.config.maxAgents - active.length);
    for (const candidate of demand.candidates) {
      const id = targetId(candidate);
      if (!slots || covered.has(id)) continue;
      const generation = allocations.filter(
        (a) => a.owner.id === id && a.phase === 'released',
      ).length;
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
    this.modelApiKey = undefined;
  }
}

export const fleetWorkflowPlugin = {
  name: 'merv-fleet-workflow',
  inject: ['fleet', 'sessions', 'scope'],
  async apply(ctx: Context, config: FleetWorkflowConfig = {}) {
    const adapter = new FleetWorkflowAdapter(ctx.fleet, ctx.sessions, ctx.scope, config);
    await adapter.start();
    ctx.effect(() => () => adapter.close());
  },
};
export default fleetWorkflowPlugin;
