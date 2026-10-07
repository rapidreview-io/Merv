import type { Context } from 'cordis';
import { z } from 'zod';
import {
  canonical,
  check,
  digest,
  MervError,
  recorded,
  type Caller,
  type DelegationSource,
  type Scope,
  type State,
  type Transaction,
  requireHuman,
} from '@merv/contracts';
import { sourceCaller } from '@merv/scope/rules';
import { INQUIRY_CAPABILITY } from '@merv/sessions/rules';
import type {
  ManagedRunnerBindingIdentity,
  Sessions,
  SessionsProjectStatus,
} from '@merv/sessions/types';
import type { Fleet, FleetAllocation, FleetOwner, ManagedModelGrant } from './types.js';
import { personKey } from './model-ledger.js';
import { hostedCodexCapabilities, hostedCodexPlatform } from './hosted-codex.js';
import { codexModelRelay, hostedGrant, modelBudgetStatus, setDailyTokens } from './codex-relay.js';
import { modelMigrations } from './schema.js';

/** Loading the adapter is the switch. Fleet still owns all machine limits and lifecycle. */
const workflowConfig = z
  .object({
    /** Ignored: configurations rendered before still carry it. */
    enabled: z.boolean().optional(),
    /** Whose choice of Fleet it serves: sign-in identities as 'issuer subject', or '*' for all. */
    people: z
      .array(z.string().regex(/^(\*|\S+ \S+)$/))
      .min(1)
      .max(100),
    modelApiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    baseUrl: z.string().url().max(2048),
    maxAgents: z.number().int().min(1).max(64).default(10),
    dailyTokensPerPerson: z.number().int().min(1).default(20_000_000),
    pollIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .strict();
export type FleetWorkflowConfig = z.input<typeof workflowConfig>;

const ownerKind = 'workflow';
/** A step's wall-clock cap. A work host is rented for a day (Fleet caps it at its own limit), for
 *  several steps: Sessions starts a step on it only with the whole step and five minutes to stop
 *  left, and a settled host short of that stops, so the next step gets a fresh host. */
const stepSeconds = 120 * 60;
const hostSeconds = 86_400;
const workHostCapability = 'workflow.workhost.1';
/** How long a work host waits, its last step settled, for the next step of its work item. */
const workIdleMs = 300_000;
/** One machine, a work host, serves every step of one work item, each in a fresh session; it is
 *  rented under `work:<instance>`. An allocation of the retired one-machine-per-step owner
 *  (`<instance>:<revision>`) has none, and is no longer valid. */
const workId = (a: FleetAllocation) =>
  a.owner.id.startsWith('work:') ? a.owner.id.slice(5) : undefined;
const workOwner = (id: string) => `work:${id.slice(0, id.lastIndexOf(':'))}`;
const startupGraceMs = 60_000;
const emptyRunnerGraceMs = 30_000;
const releaseAckGraceMs = 120_000;
const unclaimedRetryCooldownMs = 60_000;
const unclaimedAttemptLimit = 2;
const refusedRetryCooldownMs = 15 * 60_000;
const retryInput = z
  .object({
    instanceId: z.string().min(1).max(200),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(8).max(500),
    requestId: z.string().min(1).max(200),
  })
  .strict();
type RetryInput = z.infer<typeof retryInput>;
type RetryGrant = {
  id: number;
  project_id: string;
  instance_id: string;
  expected_revision: number;
  prior_allocations: number;
  request_id: string;
  input_hash: string;
  reason: string;
  actor_id: string;
  created_at: string;
};
/** What can be done about a revision in each retry state. */
const retryNext = {
  exhausted_unclaimed:
    'A project administrator can use fleet.workflow_retry with this exact revision, a reason and a stable requestId. The two failed rentals remain in Fleet history.',
  exhausted_cooldown:
    'Two unclaimed rentals exhausted this revision. Wait for the cooldown, then a project administrator can use fleet.workflow_retry.',
  cooldown: 'Fleet will try again after the cooldown if capacity and budgets allow.',
  not_current_demand: 'This exact revision is not currently offered for managed dispatch.',
  active: 'An active machine already covers this target.',
  ready: 'Fleet may allocate when capacity, wallet and model budgets allow.',
};
const raiseLimit = 'Raise the Fleet daily token limit in Settings or wait for the UTC reset.';
const targetId = (candidate: { instanceId: string; expectedRevision: number }) =>
  `${candidate.instanceId}:${candidate.expectedRevision}`;
const grantKey = (projectId: string, id: string) => `${projectId} ${id}`;
const occupied = (allocation: FleetAllocation) => allocation.phase !== 'released';
/** The wallet or the provider refused its machine, or no price was listed for it. */
const refused = (a: FleetAllocation) =>
  a.error === 'runtime_refused' || a.error === 'wallet_refused';
/** Before Fleet observes the launch no runner can have enrolled, so nothing claimed is at stake. */
const launched = (a: FleetAllocation) => a.runtime?.launch?.deliveryState === 'launched';
/** What Fleet rents for: work its machines can take, and questions to agents whose conversations
 *  they can resume (an image that runs inquiry visits says so in its heartbeat; one that does not
 *  is never offered one, and its host goes unclaimed). */
const demandInput = {
  platform: hostedCodexPlatform,
  capabilities: [...hostedCodexCapabilities, INQUIRY_CAPABILITY],
};
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
    config: FleetWorkflowConfig,
    private readonly clock: () => number = Date.now,
    private readonly state: State,
  ) {
    const parsed = workflowConfig.safeParse(config);
    check(
      parsed.success,
      'invalid_fleet_workflow_config',
      'Fleet workflow configuration is invalid',
    );
    this.config = parsed.data;
    // Sessions starts a step on a host only with the whole step and five minutes to stop left.
    check(
      fleet.allocationSeconds >= stepSeconds + 300,
      'invalid_fleet_workflow_config',
      `Fleet rents machines for less than a workflow step: allocationTimeoutSeconds must be at least ${stepSeconds + 300}`,
    );
  }
  async start(): Promise<void> {
    await this.state.migrate('fleet_workflow', modelMigrations);
    check(
      !this.closed && !this.timer,
      'fleet_workflow_started',
      'Fleet workflow is already started',
      409,
    );
    try {
      this.disposers.push(this.fleet.registerOwner(ownerKind, this));
      this.disposers.push(
        this.sessions.managed.registerValidator({
          current: async (binding, tx) => await this.current(binding, tx),
          admits: async (allocationId, epoch, tx) =>
            await this.fleet.admits(allocationId, epoch, tx),
          serves: (projectId) => this.served.has(projectId),
          assignmentSources: async (binding, tx) => [
            binding.source,
            await this.reviewer(binding.source, tx),
          ],
          retired: async (binding, tx) => await this.fleet.retired(binding.allocationId, tx),
          // Hosted Codex's image brokers Hugging Face downloads through HF_TOKEN/HF_ENDPOINT.
          huggingFace: (binding) => canonical(binding.platform) === canonical(hostedCodexPlatform),
        }),
      );
      // Fleet's sections of system.status: the project's, and a leased worker's own budget.
      this.disposers.push(
        this.sessions.contributeStatus('fleet', async (caller, project) =>
          project ? await this.status(caller, project) : undefined,
        ),
        this.sessions.contributeStatus('modelBudget', async (caller, project) =>
          project ? undefined : await this.modelWait(caller),
        ),
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
      this.accepted(a) &&
      a.deadlineAt > new Date(this.clock()).toISOString() &&
      !!workId(a) &&
      !!(await this.director(a.source, tx))
    );
  }
  /** A step's machine is for the person who directs it; a review director's, for its voucher.
   * A lookup that fails refuses the request. */
  async payer(source: DelegationSource, _ownerId: string, tx?: Transaction): Promise<string> {
    const who = source.kind === 'service' ? source.vouchedBy : source;
    return personKey(
      who.kind === 'human' ? who : (await this.scope.requireDelegation(who, 'read', tx)).user,
      who,
    );
  }
  /** The one grant of hosted Codex's model, by session bearer or id, charged to the person its
   *  machine was rented for; an inquiry visit's, to the person who asked, within its budget. */
  async modelGrant(tokenOrSessionId: string): Promise<ManagedModelGrant> {
    const bound = await this.sessions.managed.boundSession(tokenOrSessionId);
    const person = bound.inquiry
      ? await this.payer(bound.inquiry.asker, '')
      : (await this.fleet.inspectOwned(this, bound.allocationId)).person;
    return hostedGrant(bound, person, this.clock());
  }
  /** The managed worker's or project's current Fleet director's budget, without private counts. */
  async modelBudget(caller: Caller) {
    await this.scope.require(caller, 'read');
    let person: string;
    if (caller.session) {
      try {
        person = (await this.modelGrant(caller.session.id)).person;
      } catch (error) {
        if (error instanceof MervError && [401, 403, 404].includes(error.status)) return null;
        throw error;
      }
    } else {
      const selected = (await this.sessions.dispatch.servedSources()).find(
        (entry) => entry.projectId === caller.projectId,
      );
      if (!selected) return null;
      const actor = await this.director(selected.source);
      if (!actor) return null;
      person = personKey(actor.user, selected.source);
    }
    const { blocked, blockReason, resetsAt } = await modelBudgetStatus(
      this.state,
      person,
      this.config.dailyTokensPerPerson,
    );
    return { blocked, blockReason, resetsAt };
  }
  private async modelWait(caller: Caller) {
    const budget = await this.modelBudget(caller);
    if (!budget) return null;
    const { blocked, blockReason: reason, resetsAt } = budget;
    return { blocked, reason, resetsAt, ...(blocked ? { next: raiseLimit } : {}) };
  }
  private async status(caller: Caller, project: SessionsProjectStatus) {
    const [allocations, modelBudget, retries] = await Promise.all([
      this.fleet.list(caller, 0),
      this.modelWait(caller),
      this.retryStatus(caller, project.queue).catch(() => undefined),
    ]);
    return {
      available: true,
      modelBudget,
      retryBlocked: {
        available: retries !== undefined,
        truncated: project.queueTotal > project.queue.length,
        items: (retries ?? [])
          .filter((status) => status.state.startsWith('exhausted_'))
          .map((status) => ({
            instanceId: status.instanceId,
            expectedRevision: status.expectedRevision,
            reason: `${status.unclaimedAttempts}/${status.attemptLimit} created Fleet machines ended before claiming work.`,
            next: status.next,
            ...(status.retryAvailable ? { tool: 'fleet.workflow_retry' } : {}),
          })),
      },
      allocations: allocations
        .filter(({ phase }) => phase !== 'released')
        .map(({ id, owner, phase, intent, error, createdAt }) => {
          return { id, owner: owner.kind, phase, intent, error, createdAt };
        }),
    };
  }
  /** Retry status follows the current director, even when the last failed rent names an old one. */
  private async demandTargets(projectId: string, historical: DelegationSource[]) {
    const sources = new Map<string, DelegationSource>();
    const add = (source: DelegationSource) => sources.set(digest(source), source);
    for (const source of historical) add(source);
    for (const { source } of (await this.sessions.dispatch.servedSources()).filter(
      (entry) => entry.projectId === projectId,
    )) {
      add(source);
      for (const old of historical) if (old.kind === 'service') add({ ...old, vouchedBy: source });
      const reviewer = this.reviewers.get(projectId);
      if (reviewer) add({ kind: 'service', projectId, actorId: reviewer, vouchedBy: source });
    }
    // Each revision wanted, and since when it has stood.
    const current = new Map<string, string | undefined>();
    for (const source of sources.values()) {
      try {
        for (const candidate of (
          await this.sessions.dispatch.dispatchDemand(sourceCaller(source), demandInput)
        ).candidates)
          current.set(targetId(candidate), candidate.since);
      } catch (error) {
        // Historical directors can be revoked; another current director may still serve work.
        if (!(error instanceof MervError && [401, 403, 404].includes(error.status))) throw error;
      }
    }
    return current;
  }
  /** The latest retry grant of each revision in these projects, in one indexed read. */
  private async retryGrants(projectIds: string[]): Promise<Map<string, RetryGrant>> {
    if (!projectIds.length) return new Map();
    const rows = await this.state.read((sql) =>
      sql.all<RetryGrant>(
        `SELECT DISTINCT ON (project_id, instance_id, expected_revision) * FROM fleet_workflow_retry_grants
         WHERE project_id IN (${projectIds.map(() => '?').join(',')})
         ORDER BY project_id, instance_id, expected_revision, id DESC`,
        ...projectIds,
      ),
    );
    return new Map(
      rows.map((row) => [
        grantKey(
          row.project_id,
          targetId({ instanceId: row.instance_id, expectedRevision: row.expected_revision }),
        ),
        row,
      ]),
    );
  }
  /**
   * The machines since a revision's latest grant that no session claimed, newest first, up to
   * the limit, and when the cooldown after the newest ends. A claimed session starts a new
   * streak; a refused create made no machine and is not one, but a machine never launched is.
   * A create that fails otherwise and leaves no machine is not one either: it is retried each
   * releaseBy and never exhausts the revision, but it costs nothing. Its work item's machines are
   * counted only from when the revision began (`since`, as demand says it), so a later revision,
   * such as one a person moved the work to, starts a streak of its own.
   */
  private async streak(attempts: FleetAllocation[], prior = 0, since?: string) {
    let unclaimed = 0;
    let newest = 0;
    for (const a of attempts.slice(prior).toReversed()) {
      if (since && Date.parse(a.createdAt) < Date.parse(since)) break;
      if (a.phase !== 'released' || !a.runtime) continue;
      if ((await this.sessions.managed.inspect(a.id, a.epoch))?.session) break;
      unclaimed++;
      newest ||= Date.parse(a.updatedAt);
      if (unclaimed === unclaimedAttemptLimit) break;
    }
    return { unclaimed, cooldownUntil: unclaimed ? newest + unclaimedRetryCooldownMs : 0 };
  }
  /**
   * A narrow, auditable window after two rentals failed before any work was claimed: where each
   * exact revision stands. Demand is read for every revision, whether or not it has attempts,
   * through Sessions' own snapshot transaction, so this never runs under the writer lock.
   */
  private async retryState(
    caller: Caller,
    targets: { instanceId: string; expectedRevision: number }[],
  ) {
    const ids = targets.map(targetId);
    const allocations = (await this.fleet.listOwned(this, ids.map(workOwner))).filter(
      (a) => a.projectId === caller.projectId,
    );
    const grants = await this.retryGrants([caller.projectId]);
    const latest = new Map(allocations.map((a) => [a.owner.id, a.source]));
    const current = await this.demandTargets(caller.projectId, [...latest.values()]);
    const active = new Set<string>();
    for (const a of allocations.filter(occupied)) {
      active.add(a.owner.id);
      const session = (await this.sessions.managed.inspect(a.id, a.epoch))?.session;
      if (session) active.add(targetId(session));
    }
    return await Promise.all(
      targets.map(async ({ instanceId, expectedRevision }) => {
        const id = targetId({ instanceId, expectedRevision });
        // Exactly the machines renting counts, so a grant's prior count is the same list's.
        const attempts = allocations.filter((a) => a.owner.id === workOwner(id));
        const prior = grants.get(grantKey(caller.projectId, id))?.prior_allocations;
        const { unclaimed, cooldownUntil: until } = await this.streak(
          attempts,
          prior,
          current.get(id),
        );
        const cooldownUntil = until > this.clock() ? new Date(until).toISOString() : null;
        const state: keyof typeof retryNext =
          active.has(id) || active.has(`work:${instanceId}`)
            ? 'active'
            : !current.has(id)
              ? 'not_current_demand'
              : unclaimed >= unclaimedAttemptLimit
                ? cooldownUntil
                  ? 'exhausted_cooldown'
                  : 'exhausted_unclaimed'
                : cooldownUntil
                  ? 'cooldown'
                  : 'ready';
        return {
          instanceId,
          expectedRevision,
          state,
          unclaimedAttempts: unclaimed,
          attemptLimit: unclaimedAttemptLimit,
          allocationCount: attempts.length,
          cooldownUntil,
          retryAvailable: state === 'exhausted_unclaimed',
          next: retryNext[state],
        };
      }),
    );
  }
  async retryStatus(caller: Caller, targets: { instanceId: string; expectedRevision: number }[]) {
    await this.scope.require(caller, 'read');
    check(
      !caller.session,
      'fleet_forbidden',
      'Worker sessions cannot inspect project retry status',
      403,
    );
    if (!targets.length) return [];
    return await this.retryState(caller, targets);
  }
  async retry(caller: Caller, raw: RetryInput) {
    const parsed = retryInput.safeParse(raw);
    check(parsed.success, 'invalid_retry', 'Retry needs an exact revision, reason and requestId');
    const input = parsed.data;
    const hash = digest(input);
    await this.scope.require(caller, 'admin');
    check(
      !caller.session && !caller.key,
      'fleet_forbidden',
      'Only a project administrator may retry a workflow rental',
      403,
    );
    // Demand uses Sessions' own snapshot transaction; never call it under this writer lock.
    const status = (await this.retryState(caller, [input]))[0]!;
    const result = await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      const prior = await tx.get<RetryGrant>(
        'SELECT * FROM fleet_workflow_retry_grants WHERE project_id=? AND request_id=?',
        caller.projectId,
        input.requestId,
      );
      if (prior) {
        check(
          prior.input_hash === hash,
          'request_conflict',
          'Retry requestId was used with different input',
          409,
        );
        return {
          id: prior.id,
          instanceId: prior.instance_id,
          expectedRevision: prior.expected_revision,
          priorAllocations: prior.prior_allocations,
          reason: prior.reason,
          createdAt: prior.created_at,
        };
      }
      check(
        status.state !== 'not_current_demand',
        'revision_conflict',
        'This workflow revision is stale, or not offered for managed dispatch',
        409,
      );
      check(
        status.retryAvailable,
        'fleet_retry_unavailable',
        `Fleet retry is unavailable: ${status.state}`,
        409,
      );
      // Another retry of the same window already recorded fails the UNIQUE constraint (409).
      const createdAt = new Date(this.clock()).toISOString();
      const row = await tx.get<{ id: number }>(
        'INSERT INTO fleet_workflow_retry_grants(project_id,instance_id,expected_revision,prior_allocations,request_id,input_hash,reason,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
        caller.projectId,
        input.instanceId,
        input.expectedRevision,
        status.allocationCount,
        input.requestId,
        hash,
        input.reason,
        caller.actorId,
        createdAt,
      );
      await recorded(this.state, tx, caller, 'fleet.workflow_retry_granted', input.instanceId, {
        expectedRevision: input.expectedRevision,
        priorAllocations: status.allocationCount,
        reason: input.reason,
        requestId: input.requestId,
      });
      return {
        id: row!.id,
        instanceId: input.instanceId,
        expectedRevision: input.expectedRevision,
        priorAllocations: status.allocationCount,
        reason: input.reason,
        createdAt,
      };
    });
    void this.reconcile().catch(() => undefined);
    return result;
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
  /** Fleet's own reviewer in the owner's project, vouched for by that owner, so a fresh agent
   * reviews what their hand may not: their and Pi's deliveries, and Code-provenance reviews. */
  private async reviewer(source: DelegationSource, tx?: Transaction): Promise<DelegationSource> {
    const { projectId } = source;
    const actorId =
      this.reviewers.get(projectId) ??
      (await this.scope.serviceActor('fleet-review', projectId, tx, 'reviewer')).actorId;
    this.reviewers.set(projectId, actorId);
    return { actorId, projectId, kind: 'service', vouchedBy: source };
  }
  private async current(binding: ManagedRunnerBindingIdentity, tx: Transaction): Promise<boolean> {
    if (
      canonical(binding.platform) !== canonical(hostedCodexPlatform) ||
      canonical(binding.capabilities) !==
        canonical([...hostedCodexCapabilities, workHostCapability])
    )
      return false;
    try {
      const a = await this.fleet.inspectOwned(this, binding.allocationId, tx);
      return (
        this.accepted(a) &&
        a.phase !== 'released' &&
        a.intent !== 'stop' &&
        a.deadlineAt > new Date(this.clock()).toISOString() &&
        a.epoch === binding.epoch &&
        a.profileId === binding.runtimeProfileId &&
        !!workId(a) &&
        workId(a) === binding.workInstanceId &&
        binding.stepSeconds === stepSeconds &&
        a.deadlineAt === binding.expiresAt &&
        digest(a.source) === digest(binding.source)
      );
    } catch (error) {
      if (error instanceof MervError && [403, 404].includes(error.status)) return false;
      throw error;
    }
  }
  async bootstrap(a: FleetAllocation): Promise<string> {
    const workInstanceId = workId(a);
    check(
      this.accepted(a) && workInstanceId,
      'fleet_workflow_source',
      'Fleet workflow allocation is unavailable',
      403,
    );
    const { enrollmentToken } = await this.sessions.managed.ensure({
      allocationId: a.id,
      epoch: a.epoch,
      source: a.source,
      runtimeProfileId: a.profileId,
      platform: hostedCodexPlatform,
      capabilities: [...hostedCodexCapabilities, workHostCapability],
      workInstanceId,
      stepSeconds,
      expiresAt: a.deadlineAt,
    });
    return JSON.stringify({
      baseUrl: this.config.baseUrl,
      projectId: a.projectId,
      enrollmentToken,
      workInstanceId,
    });
  }
  async observe(a: FleetAllocation): Promise<'starting' | 'running' | 'finished'> {
    check(
      this.accepted(a),
      'fleet_workflow_source',
      'Fleet workflow allocation is unavailable',
      403,
    );
    const observed = await this.sessions.managed.inspect(a.id, a.epoch);
    if (observed?.session) {
      const session = observed.session;
      // The exact process acknowledgement is required for reuse. A runner whose acknowledgement
      // was lost, as when Main restarts while it closes, never sends another: past the grace its
      // machine stops, never serving a successor while its producer could still run. The relay
      // metered its tokens. An acknowledged host waits a bounded idle time for the next step.
      const closed = session.status === 'released' || session.status === 'expired';
      if (!closed || session.capturePending) return 'running';
      if (Date.parse(a.deadlineAt) - this.clock() < (stepSeconds + 300) * 1000) return 'finished';
      const idle = session.releaseAcknowledged ? workIdleMs : releaseAckGraceMs;
      return this.clock() - Date.parse(session.closedAt!) >= idle ? 'finished' : 'running';
    }
    // A host that has claimed no work when its enrollment lapses never will.
    if (observed && Date.parse(observed.enrollmentExpiresAt) <= this.clock()) return 'finished';
    // A work host is rented under the owner for its reviews too, which only the reviewer sees;
    // it is wanted only for its own instance.
    let wanted = false;
    for (const director of [a.source, await this.reviewer(a.source)])
      wanted ||= (
        await this.sessions.dispatch.dispatchDemand(sourceCaller(director), demandInput)
      ).candidates.some((c) => c.instanceId === workId(a));
    // Counted from the launch, or the runner's enrollment. Work claimed after the first read
    // keeps its machine; a claim after the second is refused once the stop commits.
    const grace = observed?.runnerId ? emptyRunnerGraceMs : startupGraceMs;
    if (
      !wanted &&
      this.clock() - Date.parse(a.updatedAt) >= grace &&
      !(await this.sessions.managed.inspect(a.id, a.epoch))?.session
    )
      return 'finished';
    return observed?.runnerId ? 'running' : 'starting';
  }
  /** Idempotent demand reconciliation; pending Fleet allocations cover their target revision. */
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.reconcileOnce().finally(() => {
      this.pending = undefined;
    }));
  }
  /** Serves each project as its owner (Sessions.servedSources), while they may write and are
   * one of its people, and its reviews the owner may not direct through its review director;
   * a failure in one project leaves the others served. */
  private async reconcileOnce(): Promise<void> {
    if (await this.fleet.held()) return await this.drainForRelease();
    // The key stays on Main for the relay; without it no machine is rented to call the model.
    check(
      process.env[this.config.modelApiKeyEnv],
      'fleet_workflow_secret',
      'Fleet model key is unavailable',
      503,
    );
    // One person across projects: the owner's sign-in identity, while they may write.
    const person = async (source: DelegationSource) => {
      const user = (await this.director(source))?.user;
      return { who: user && `${user.issuer} ${user.subject}`, key: personKey(user, source) };
    };
    const everyone = this.config.people.includes('*');
    // Each target a project wants, with the director whose machine takes it, and since when its
    // revision has stood.
    const served = new Map<string, Map<string, DelegationSource>>();
    const since = new Map<string, string | undefined>();
    // Projects passed over this pass: their reads failed, or Fleet refused one of their requests.
    const failed = new Set<string>();
    for (const { projectId, source } of await this.sessions.dispatch.servedSources()) {
      try {
        const { who, key } = await person(source);
        if (!who || !(everyone || this.config.people.includes(who))) continue;
        const wanted = new Map<string, DelegationSource>();
        if ((await modelBudgetStatus(this.state, key, this.config.dailyTokensPerPerson)).blocked) {
          served.set(projectId, wanted);
          continue;
        }
        for (const director of [source, await this.reviewer(source)])
          for (const target of (
            await this.sessions.dispatch.dispatchDemand(sourceCaller(director), demandInput)
          ).candidates)
            if (!wanted.has(targetId(target))) {
              wanted.set(targetId(target), director);
              since.set(grantKey(projectId, targetId(target)), target.since);
            }
        served.set(projectId, wanted);
      } catch (error) {
        skipped(projectId, error);
        failed.add(projectId);
      }
    }
    // A project that could not be read this pass keeps its standing and its machines.
    this.served = new Set([...served.keys(), ...[...this.served].filter((p) => failed.has(p))]);
    const allocations = await this.fleet.listOwned(
      this,
      [...served.values()].flatMap((wanted) => [...wanted.keys()].map(workOwner)),
    );
    const newestRefused = Math.max(
      0,
      ...allocations.filter(refused).map((a) => Date.parse(a.updatedAt)),
    );
    const newestAdmitted = Math.max(
      0,
      ...allocations.filter((a) => a.runtime).map((a) => Date.parse(a.updatedAt)),
    );
    // Workflow machines rent in the host project, so one refusal there pauses them all; after
    // the pause, one target at a time is tried until one is admitted.
    const paused = newestRefused > newestAdmitted;
    const active = allocations.filter(occupied);
    // The steps of its work item a running host covers: every revision the project wants.
    const steps = (a: FleetAllocation) =>
      [...(served.get(a.projectId)?.keys() ?? [])].filter((id) => workOwner(id) === a.owner.id);
    for (const a of active)
      if (a.intent === 'run' && !launched(a) && !failed.has(a.projectId) && !steps(a).length)
        await this.fleet.cancelOwned(this, a.id);
    if (paused && this.clock() - newestRefused < refusedRetryCooldownMs) return;
    const covered = new Set(active.filter((a) => a.intent === 'run').flatMap(steps));
    let slots = Math.max(0, this.config.maxAgents - active.length);
    const queue = [...served].flatMap(([projectId, wanted]) =>
      [...wanted].map(([id, source]) => ({ projectId, source, id })),
    );
    // Read only once some target reaches the streak check, so a full or covered pass reads none.
    let grants: Map<string, RetryGrant> | undefined;
    for (const { projectId, source, id } of queue) {
      if (!slots || covered.has(id) || failed.has(projectId)) continue;
      const owner = workOwner(id);
      // Accepted: machines the retired per-step owner (`<instance>:<revision>`) rented do not count,
      // so work it exhausted gets one more two-rental window; grants index this list as it is.
      const attempts = allocations.filter((a) => a.projectId === projectId && a.owner.id === owner);
      // A new task revision has a new id. For this exact revision, stop paying for
      // repeated machines that never claimed work.
      grants ??= await this.retryGrants([...new Set(queue.map((item) => item.projectId))]);
      const { unclaimed, cooldownUntil } = await this.streak(
        attempts,
        grants.get(grantKey(projectId, id))?.prior_allocations,
        since.get(grantKey(projectId, id)),
      );
      if (unclaimed >= unclaimedAttemptLimit || cooldownUntil > this.clock()) continue;
      // An active allocation claimed by different work still owns its original request ID.
      // Count it too, or Fleet's idempotent request simply returns that busy allocation.
      const generation = attempts.length;
      try {
        // A host serves the work item's reviews too, so it is rented under the owner.
        await this.fleet.request(
          sourceCaller(source.kind === 'service' ? source.vouchedBy : source),
          {
            requestId: `wf:${digest({ id: owner, generation })}`,
            owner: { kind: ownerKind, id: owner },
            seconds: hostSeconds,
          },
        );
      } catch (error) {
        // A refusal, such as the payer's spend cap, passes over the project's other targets this
        // pass; only a project without a connection is no longer served.
        skipped(projectId, error);
        failed.add(projectId);
        if (error instanceof MervError && error.code === 'sandbox_not_connected')
          this.served.delete(projectId);
        continue;
      }
      covered.add(id);
      slots--;
      if (paused) break;
    }
  }
  /**
   * While a release holds work machines (it is about to replace the apps they run on, which kills
   * every running container): rent nothing, and stop each machine with no step in flight, so the
   * release finds none up. A step in flight runs on, and its machine admits no other (Fleet.admits),
   * so it stops once the step has settled. Each is judged and stopped under the writer, where no
   * step can be claimed between the two.
   */
  private async drainForRelease(): Promise<void> {
    for (const a of (await this.fleet.listOwned(this, [])).filter(occupied))
      if (a.intent !== 'stop')
        await this.state.transaction(async (tx) => {
          const session = (await this.sessions.managed.inspect(a.id, a.epoch, tx))?.session;
          const settled =
            !session ||
            ((session.status === 'released' || session.status === 'expired') &&
              !session.capturePending);
          if (settled) await this.fleet.cancelOwned(this, a.id, tx);
        });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // Unregister first: Sessions then answers 503 instead of revoking live sessions, and a pass
    // in flight can no longer request or cancel anything.
    for (const dispose of this.disposers.reverse()) dispose();
    this.disposers = [];
    await this.pending?.catch(() => undefined);
  }
}

export const fleetWorkflowPlugin = {
  name: 'merv-fleet-workflow',
  inject: ['fleet', 'sessions', 'scope', 'api', 'state', 'tools'],
  async apply(ctx: Context, config: FleetWorkflowConfig) {
    const adapter = new FleetWorkflowAdapter(
      ctx.fleet,
      ctx.sessions,
      ctx.scope,
      config,
      Date.now,
      ctx.state,
    );
    await adapter.start();
    ctx.effect(() => () => adapter.close());
    // The provider key stays on Main: hosted Codex calls the model through this relay.
    const relay = codexModelRelay(ctx.state, {
      providerKey: () => process.env[adapter.config.modelApiKeyEnv] ?? '',
      dailyTokensPerPerson: adapter.config.dailyTokensPerPerson,
      authorize: (token) => adapter.modelGrant(token),
      inquiries: ctx.sessions.inquiries,
    });
    ctx.effect(() => {
      const model = ctx.fleet.modelRelay(relay);
      const unmount = ctx.api.mount('/codex-model', model.handle, { public: true });
      return () => {
        unmount();
        model.close();
      };
    });
    // A person's own daily limit: only they, signed in, read or change it, never an agent.
    const person = (caller: Caller) => {
      requireHuman(
        caller,
        'fleet_forbidden',
        'Only you, signed in, can see or change your daily tokens',
      );
      return personKey(caller.human, caller);
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
          return await modelBudgetStatus(ctx.state, who, adapter.config.dailyTokensPerPerson);
        },
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'fleet.workflow_retry_status',
        description:
          'Read why managed Fleet stopped renting for one exact workflow revision after unclaimed machines. This does not change any allocation or dispatch state.',
        readOnly: true,
        inputSchema: retryInput.pick({ instanceId: true, expectedRevision: true }),
        handler: async (caller: Caller, input: { instanceId: string; expectedRevision: number }) =>
          (await adapter.retryStatus(caller, [input]))[0],
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'fleet.workflow_retry',
        act: { title: 'Retry on Fleet' },
        conversation: 'propose' as const,
        description:
          'Project administrator only. After two created but unclaimed Fleet machines exhaust one exact workflow revision, record a reason and open one more bounded two-attempt window. Prior allocations and the grant remain auditable. A stable requestId makes uncertain retries idempotent; active or stale work is refused. Capacity, wallet and model budgets still govern renting.',
        inputSchema: retryInput,
        handler: async (caller: Caller, input: RetryInput) => await adapter.retry(caller, input),
      }),
    );
  },
};
export default fleetWorkflowPlugin;
