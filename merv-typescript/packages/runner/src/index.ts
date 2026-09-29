import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Context } from 'cordis';
import { z } from 'zod';
import {
  check,
  effectiveWorkspace,
  sessionSecretPattern,
  sessionUsageReportSchema,
  WorkspaceDeferred,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type WorkspaceDriver,
  type WorkspaceDriverFactory,
  type WorkspaceLaunch,
} from '@merv/contracts';
import type {
  RunnerPlatform,
  Session,
  SessionDeferral,
  SessionReleaseOutcome,
  SessionUsageReport,
} from '@merv/sessions/types';
import { RunnerClient, RunnerControlError } from './client.js';
import {
  LocalLedger,
  terminalLaunch,
  type LaunchRecord,
  type LaunchMetadata,
  type PendingLaunchRequest,
} from './ledger.js';
import { ProcessHost, usageFile } from './process-host.js';
import { GitWorkspaceManager } from './workspaces.js';
import {
  buildLaunch,
  collectRepositorySkillPaths,
  handoffGraceMs,
  harnessUsage,
  validateProfile,
  type RunnerProfile,
} from './profiles.js';
import type { Runner, RunnerSnapshot } from './types.js';
export type * from './types.js';

/** Optional Git command capability; ordinary workspace drivers only own their lifecycle. */
interface CommitDriver extends WorkspaceDriver {
  checkpointCommit(launch: WorkspaceLaunch, command: CodeCommitCommand): Promise<CodeCommitReceipt>;
  pendingCommits(launchId: string): CodeCommitCommand[];
  commitOutcome(commandId: string): { receipt: CodeCommitReceipt } | { error: string } | null;
  acknowledgeCommit(commandId: string): void;
}
function commits(driver: WorkspaceDriver): driver is CommitDriver {
  return ['checkpointCommit', 'pendingCommits', 'commitOutcome', 'acknowledgeCommit'].every(
    (method) => typeof (driver as unknown as Record<string, unknown>)[method] === 'function',
  );
}

/** Local machine configuration. Remote settings can tune profiles, never replace executables. */
const configSchema = z
  .object({
    directory: z.string().min(1),
    baseUrl: z.string().min(1),
    projectId: z.string().min(1).max(200),
    credentialEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .refine(
        (name) =>
          ![
            'PATH',
            'HOME',
            'USER',
            'SHELL',
            'TMPDIR',
            'LANG',
            'LC_ALL',
            'CODEX_HOME',
            'MERV_AGENT_SESSION_TOKEN',
            'MERV_MCP_URL',
          ].includes(name),
      ),
    profiles: z.array(z.unknown()).max(32),
    /** CLI composition: omit for the existing Code driver, or [] for workspace-free research. */
    workspaceDrivers: z.array(z.literal('code')).max(1).optional(),
    /** A local source repository; the runner creates and owns its private Git copy. */
    workspace: z
      .union([
        z.object({ github: z.literal(true) }).strict(),
        z
          .object({
            repository: z
              .string()
              .min(1)
              .refine((value) => !/[\0\r\n]/.test(value)),
            baseRef: z
              .string()
              .min(1)
              .max(200)
              .refine((value) => !value.startsWith('-') && !/[\0\r\n]/.test(value)),
          })
          .strict(),
      ])
      .optional(),
    /** Existing image-provisioned scratch root outside the private ledger, for isolated Codex. */
    assignmentWorkspaceDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value) && resolve(value) === value)
      .optional(),
    /** A managed machine admits at most one durable assignment during its lifetime. */
    oneAssignment: z.boolean().optional(),
    capacity: z.number().int().min(0).max(256).optional(),
    pollIntervalMs: z.number().int().min(100).max(30_000).optional(),
    requestTimeoutMs: z.number().int().min(100).max(30_000).optional(),
  })
  .strict();
export type RunnerConfig = Omit<z.infer<typeof configSchema>, 'profiles'> & {
  profiles: RunnerProfile[];
};
export function validateRunnerConfig(input: unknown): RunnerConfig {
  const parsed = configSchema.safeParse(input);
  check(
    parsed.success,
    'invalid_runner_config',
    'Runner configuration must use the closed local configuration schema',
  );
  const profiles = parsed.data.profiles.map(validateProfile);
  check(
    new Set(profiles.map((profile) => profile.name)).size === profiles.length,
    'invalid_runner_config',
    'Runner profile names must be distinct',
  );
  if (parsed.data.assignmentWorkspaceDirectory || parsed.data.oneAssignment)
    check(
      profiles.length === 1 &&
        profiles[0].harness === 'codex' &&
        !!profiles[0].isolatedLauncher &&
        profiles[0].parallelism === 1 &&
        parsed.data.capacity === 1 &&
        (!parsed.data.assignmentWorkspaceDirectory || parsed.data.oneAssignment === true),
      'invalid_runner_config',
      'One assignment requires one isolated Codex profile and capacity one',
    );
  // An isolated machine's Git checkouts are its workspace driver's; the runner's own
  // repository gives it only scratch directories.
  check(
    !parsed.data.assignmentWorkspaceDirectory || !parsed.data.workspace,
    'invalid_runner_config',
    'An assignment workspace directory cannot be combined with a runner repository',
  );
  return { ...parsed.data, profiles };
}
const liveSession = (session: Session) =>
  session.status === 'offered' || session.status === 'active';
const platformOf = (profile: RunnerProfile): RunnerPlatform => ({
  name: profile.name,
  harness: profile.harness,
  enabled: profile.enabled,
  parallelism: profile.parallelism,
  ...('model' in profile && profile.model ? { model: profile.model } : {}),
  ...('effort' in profile && profile.effort ? { effort: profile.effort } : {}),
});
const diagnostic = (error: unknown) =>
  error instanceof RunnerControlError
    ? error.code
    : typeof (error as { code?: unknown })?.code === 'string' &&
        /^[a-z_]{1,100}$/.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : 'runner_operation_failed';
/** Only supervisor-owned fields enter the durable session reason; process output is untrusted. */
function terminalReason(record: LaunchRecord): string {
  const reason = record.reason;
  if (reason === 'deadline') return 'local_process_deadline';
  if (reason === 'launch_failed') return 'local_process_launch_failed';
  if (reason === 'controller_stop') return 'local_process_controller_stopped';
  if (reason === 'external_stop') return 'local_process_external_stop';
  if (reason === 'guardian_lost') return 'local_process_guardian_lost';
  if (reason === 'cancelled_before_spawn') return 'local_process_not_started';
  if (reason === 'host_rebooted') return 'local_process_host_rebooted';
  if (reason === 'guardian_lost_before_launch') return 'local_process_guardian_lost_before_launch';
  if (record.exitSignal && /^SIG[A-Z0-9]{1,20}$/.test(record.exitSignal))
    return `local_process_signal_${record.exitSignal}`;
  if (Number.isSafeInteger(record.exitCode) && record.exitCode! >= 0 && record.exitCode! <= 255)
    return record.exitCode === 0
      ? 'local_process_exit_code_0_without_handoff'
      : `local_process_exit_code_${record.exitCode}`;
  return 'local_process_finished_without_exit_status';
}
class RunnerSourceRefusal extends RunnerControlError {}
/** What a launch keeps of its session: the fields it reads back, never the assignment. */
const view = (s: Session) => {
  const { readOnly, workspace, tools } = s.execution.policy;
  return {
    id: s.id,
    projectId: s.projectId,
    actorId: s.actorId,
    instanceId: s.instanceId,
    expectedRevision: s.expectedRevision,
    runnerId: s.runnerId,
    ...(s.agentId ? { agentId: s.agentId, agentSessionId: s.agentSessionId } : {}),
    status: s.status,
    closeReason: s.closeReason,
    hostRef: s.hostRef,
    expiresAt: s.expiresAt,
    hardDeadline: s.hardDeadline,
    ...(s.workspace ? { workspace: s.workspace } : {}),
    execution: { policy: { readOnly, workspace, tools: tools.map(({ name }) => ({ name })) } },
  };
};
type SessionView = ReturnType<typeof view>;
/** What a put-off preparation recorded, in words the release route accepts, else a default. */
const deferralOf = (record: LaunchRecord): SessionDeferral | undefined => {
  if (record.metadata.releaseOutcome !== 'preparation_deferred') return undefined;
  const { cause, code } = (record.metadata.deferral ?? {}) as { cause?: unknown; code?: unknown };
  const word = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
  return word(cause) && word(code)
    ? { cause, code }
    : { cause: 'code_unavailable', code: 'workspace_deferred' };
};

/** Machine-local actuator. Every server operation uses HTTP; no server service is injected. */
export class MachineRunner implements Runner {
  private readonly config: RunnerConfig;
  private readonly client: RunnerClient;
  private readonly ledger: LocalLedger;
  private readonly host: ProcessHost;
  private readonly workspaces: GitWorkspaceManager;
  /**
   * Whatever prepares checkouts, by the name a workspace policy gives it. The scheduler below
   * only ever speaks the driver interface; the runner's own repository serves every policy
   * that names no driver, exactly as it always has.
   */
  private readonly drivers = new Map<string, WorkspaceDriver>();
  private lastDeclined?: string;
  /** The last presence the server accepted, and when; a declined profile's last decline. */
  private presented?: [body: string, at: number];
  private readonly declinedAt = new Map<string, number>();
  private profiles: RunnerProfile[];
  private appliedVersion = 0;
  private readonly clock: () => number;
  private readonly autoPoll: boolean;
  private readonly sourceBearer: string;
  private state: RunnerSnapshot['state'] = 'starting';
  private lastError?: string;
  private timer?: ReturnType<typeof setInterval>;
  private unlock?: () => void;
  private started = false;
  private stopping = false;
  private stopped = false;
  private current?: Promise<void>;
  private stopPromise?: Promise<void>;
  private finalPendingRequests = 0;

  constructor(
    config: RunnerConfig,
    options: {
      fetch?: typeof fetch;
      clock?: () => number;
      autoPoll?: boolean;
      /** Workspace drivers other plugins own; whoever composes the machine supplies them. */
      drivers?: WorkspaceDriverFactory[];
    } = {},
  ) {
    const parsed = validateRunnerConfig(config);
    this.profiles = parsed.profiles;
    this.config = {
      ...parsed,
      directory: resolve(parsed.directory),
      profiles: this.profiles,
    };
    const source = process.env[config.credentialEnv];
    check(
      source && !sessionSecretPattern.test(source),
      'missing_runner_credential',
      'Runner requires a source or managed control credential in the configured environment variable',
    );
    this.sourceBearer = source;
    check(
      !JSON.stringify({ profiles: this.profiles, workspace: this.config.workspace }).includes(
        source,
      ),
      'invalid_runner_config',
      'Source credentials cannot appear in launch or workspace configuration',
    );
    this.clock = options.clock ?? Date.now;
    this.autoPoll = options.autoPoll ?? true;
    this.client = new RunnerClient(
      config.baseUrl,
      config.projectId,
      source,
      options.fetch,
      config.requestTimeoutMs,
    );
    this.ledger = new LocalLedger({
      directory: this.config.directory,
      binding: {
        baseUrl: this.client.baseUrl,
        projectId: config.projectId,
        sourceId: createHash('sha256').update(source).digest('hex'),
      },
    });
    this.host = new ProcessHost(this.ledger);
    try {
      this.workspaces = new GitWorkspaceManager(
        this.ledger,
        this.config.workspace,
        this.config.assignmentWorkspaceDirectory,
      );
      for (const factory of options.drivers ?? [])
        try {
          this.drivers.set(
            factory.name,
            factory.create(
              {
                directory: this.ledger.directory,
                assignmentWorkspaceDirectory: this.config.assignmentWorkspaceDirectory,
                path: this.ledger.path,
                terminal: (id) => terminalLaunch(this.ledger.get(id)!),
              },
              this.client.workspaceTransport(),
            ),
          );
        } catch {
          // A driver this machine cannot run is simply not advertised.
        }
    } catch (error) {
      this.ledger.close();
      throw error;
    }
  }
  async start(): Promise<void> {
    check(!this.stopping && !this.stopped, 'runner_stopped', 'Runner is stopping or stopped');
    if (this.started) return;
    this.unlock = this.ledger.acquireController();
    this.started = true;
    await this.tick();
    if (!this.stopping && this.autoPoll)
      this.timer = setInterval(() => {
        void this.tick();
      }, this.config.pollIntervalMs ?? 1000);
  }
  tick(): Promise<void> {
    if (this.stopping || this.stopped || !this.started) return Promise.resolve();
    if (this.current) return this.current;
    const current = this.cycle()
      .catch(async (error) => {
        this.lastError = diagnostic(error);
        if (error instanceof RunnerSourceRefusal) {
          this.state = 'unauthorized';
          await this.stopOwned();
        } else
          this.state =
            error instanceof RunnerControlError && error.unavailable ? 'offline' : 'degraded';
      })
      .finally(() => {
        if (this.current === current) this.current = undefined;
      });
    this.current = current;
    return current;
  }
  private capacity(): number {
    return (
      this.config.capacity ??
      Math.min(
        256,
        this.profiles.reduce((n, p) => n + p.parallelism, 0),
      )
    );
  }
  // The driver a launch was reserved for, fixed with the lease like its policy. Undefined when
  // this machine no longer composes it: that launch waits for it, and nothing else does.
  private driverOf(record: LaunchRecord): WorkspaceDriver | undefined {
    const name = record.metadata.workspaceDriver;
    return typeof name === 'string' ? this.drivers.get(name) : this.workspaces;
  }
  /** Whether the launch uses the runner's own repository, which alone may involve GitHub. */
  private local(record: LaunchRecord): boolean {
    return typeof record.metadata.workspaceDriver !== 'string';
  }
  private occupied(record: LaunchRecord): boolean {
    const workspace = this.driverOf(record)?.get(record.id);
    return !terminalLaunch(record) || (!!workspace && workspace.status !== 'closed');
  }
  /** A managed machine admits one assignment in its lifetime. */
  private assigned(): boolean {
    return !!this.config.oneAssignment && this.ledger.count() > 0;
  }
  /** The ledger detaches and bounds the patch; only the source bearer is known here. */
  private save(id: string, patch: Record<string, unknown>): LaunchRecord {
    check(
      !JSON.stringify(patch).includes(this.sourceBearer),
      'unsafe_runner_metadata',
      'Source credential cannot be retained in launch metadata',
    );
    return this.ledger.updateMetadata(id, patch as LaunchMetadata);
  }
  private async advertise(): Promise<void> {
    // `runner.2`: this runner ignores fields a server adds to its replies (`runner.1`) and names
    // `git.local` exactly when it has a repository of its own for work that names no driver.
    // A managed runner's capabilities must equal its enrolment, so it names only its drivers.
    const marker = this.config.oneAssignment
      ? []
      : ['runner.2', ...(this.config.workspace ? ['git.local'] : [])];
    const capabilities = [...this.drivers.keys(), ...marker].sort();
    // Sent when it changed or 15 s after the last one succeeded (fresh for 45 s on the server).
    const heartbeat = async () => {
      const body = {
        runnerId: this.ledger.runnerId,
        machine: { hostname: hostname(), system: process.platform, architecture: process.arch },
        platforms: this.profiles.map(platformOf),
        capacity: this.assigned() ? 0 : this.capacity(),
        appliedVersion: this.appliedVersion,
        ...(capabilities.length ? { capabilities } : {}),
      };
      const key = JSON.stringify(body);
      if (this.presented?.[0] === key && this.clock() - this.presented[1] < 15_000) return;
      const reply = await this.client.presence(body);
      this.presented = [key, this.clock()];
      return reply;
    };
    const presence = await heartbeat();
    if (presence && presence.desiredVersion !== this.appliedVersion) {
      this.profiles = this.config.profiles.map((profile) => {
        const desired = presence.desiredSettings.platforms.find(
          (item) => item.name === profile.name,
        );
        if (!desired) return validateProfile({ ...profile, enabled: false });
        // Remote settings tune a locally trusted executable; they cannot replace it.
        const candidate = {
          ...profile,
          enabled: desired.enabled,
          parallelism: desired.parallelism,
          ...(profile.harness === 'codex' || profile.harness === 'claude'
            ? { model: desired.model, effort: desired.effort }
            : {}),
        };
        return validateProfile(candidate);
      });
      this.appliedVersion = presence.desiredVersion;
      await heartbeat();
    }
  }
  private async cycle(): Promise<void> {
    this.lastError = undefined;
    await this.host.reconcile();
    let leasing = true;
    try {
      await this.advertise();
    } catch (error) {
      this.lastError = diagnostic(error);
      this.presented = undefined; // the next cycle asks again at once
      if (error instanceof RunnerControlError && [401, 403].includes(error.status)) {
        this.state = 'unauthorized';
        return this.stopOwned();
      }
      if (!(error instanceof RunnerControlError && error.final)) {
        this.state = 'offline';
        return this.enforceDeadlines();
      }
      leasing = false; // Refused for good (say `runner_limit`): what runs is still supervised.
    }
    const settled: string[] = [];
    for (const launch of this.ledger.open()) {
      if (this.stopping) break;
      try {
        if (await this.reconcileLaunch(launch)) settled.push(launch.id);
      } catch (error) {
        this.lastError = diagnostic(error);
      }
    }
    this.ledger.settle(settled);
    if (this.stopping) return;
    // Existing uncertain requests are retried first, preserving their original platform and secret.
    for (const pending of this.ledger.pendingRequests()) {
      if (this.stopping || !leasing) break;
      if (
        this.assigned() &&
        !this.ledger.list().some((record) => record.metadata.requestId === pending.requestId)
      )
        continue;
      await this.acquire(pending);
    }
    for (const profile of this.profiles) {
      if (this.stopping || !leasing || this.assigned()) break;
      const live = this.ledger.open().filter((record) => this.occupied(record));
      if (
        !profile.enabled ||
        live.length >= this.capacity() ||
        live.filter((record) => record.metadata.platform === profile.name).length >=
          profile.parallelism ||
        // A decline is answered for this profile for 5 s; kept requests above are always replayed.
        this.clock() - (this.declinedAt.get(profile.name) ?? -Infinity) < 5_000 ||
        this.ledger.pendingRequests().some((p) => p.platform.name === profile.name)
      )
        continue;
      const declared = platformOf(profile);
      const pending = this.ledger.request({
        name: declared.name,
        harness: declared.harness,
        ...(declared.model ? { model: declared.model } : {}),
        ...(declared.effort ? { effort: declared.effort } : {}),
      });
      await this.acquire(pending);
    }
    if (this.config.workspace && 'github' in this.config.workspace) {
      // External publication is recoverable and must not stop local worker supervision.
      await this.client.syncPublications().catch(() => {});
    }
    const records = this.ledger.open();
    this.state =
      this.lastError || records.some((r) => r.status === 'uncertain')
        ? 'degraded'
        : records.some((r) => !terminalLaunch(r))
          ? 'running'
          : 'idle';
  }
  /**
   * One lease request's failure is that request's, never the tick's. A request is completed
   * once reserved, declined, refused for good (its profile may lease anew this tick) or
   * replayed closed; anything else keeps it and its secret, so the next tick replays the receipt.
   */
  private async acquire(pending: PendingLaunchRequest): Promise<void> {
    try {
      const result = await this.client
        .lease({
          runnerId: this.ledger.runnerId,
          ...pending,
          platform: pending.platform as RunnerPlatform,
        })
        .catch((error: unknown) => {
          // Only source-level admission proves that all this runner's authority is gone.
          // A concurrent halt of one session can also return 401 from its own controls.
          if (error instanceof RunnerControlError && [401, 403].includes(error.status))
            throw new RunnerSourceRefusal(error.code, error.status);
          throw error;
        });
      const session = result.session;
      if (session === null) {
        this.lastDeclined = result.reason;
        this.declinedAt.set(pending.platform.name, this.clock());
        this.ledger.completeRequest(pending.platform.name, pending.requestId);
        return;
      }
      this.lastDeclined = undefined;
      check(
        !this.config.oneAssignment ||
          this.ledger.list().every((record) => record.sessionId === session.id),
        'invalid_control_response',
        'One-assignment runner received a second session',
      );
      check(
        session.runnerId === this.ledger.runnerId,
        'invalid_control_response',
        'Lease names another runner',
      );
      const id = `launch_${createHash('sha256').update(session.id).digest('hex').slice(0, 32)}`;
      let record = this.ledger.get(id);
      if (!record && !liveSession(session)) {
        this.ledger.completeRequest(pending.platform.name, pending.requestId);
        return;
      }
      if (!record) {
        const configured = this.config.profiles.find((p) => p.name === pending.platform.name);
        check(
          configured,
          'runner_profile_missing',
          'The pending lease profile is no longer configured',
        );
        // It runs as leased: the locally trusted executable with the leased model and effort.
        const { model: _model, effort: _effort, ...local } = configured as Record<string, unknown>;
        const profile = validateProfile({ ...local, ...pending.platform, enabled: true });
        const workspace = effectiveWorkspace(session.execution.policy);
        const driver = workspace.mode === 'none' ? undefined : workspace.driver;
        record = this.ledger.reserve({
          id,
          sessionId: session.id,
          deadline: this.deadline(session),
          metadata: {
            session: view(session),
            profile,
            platform: profile.name,
            requestId: pending.requestId,
            attached: false,
            ...(driver === undefined ? {} : { workspaceDriver: driver }),
          } as unknown as LaunchMetadata,
        });
        if (session.status === 'active') this.ledger.markUncertain(id);
      }
      this.ledger.completeRequest(pending.platform.name, pending.requestId);
      await this.reconcileLaunch(this.ledger.get(id)!);
    } catch (error) {
      if (error instanceof RunnerSourceRefusal) throw error;
      this.lastError = diagnostic(error);
      if (error instanceof RunnerControlError && error.final)
        this.ledger.completeRequest(pending.platform.name, pending.requestId);
    }
  }
  private deadline(session: Session): number {
    return Math.min(Date.parse(session.expiresAt), Date.parse(session.hardDeadline));
  }
  /** One tick of a launch's supervision; true once it has ended and owes nothing more. */
  private async reconcileLaunch(initial: LaunchRecord): Promise<boolean> {
    let record = await this.host.inspect(initial.id);
    if (terminalLaunch(record) && record.metadata.remoteClosed === true) return this.settle(record);
    let session: Session;
    try {
      session = await this.client.get(record.sessionId, this.ledger.runnerId);
    } catch (error) {
      // A session refused for good is stopped once and settled with no release. A 404 is
      // final only because a server answers 503 while a route's owning plugin is unmounted.
      if (error instanceof RunnerControlError && error.final)
        await this.halt(record.id, { remoteClosed: true, usageReported: true });
      else if (!terminalLaunch(record) && record.deadline <= this.clock())
        await this.halt(record.id, { releaseOutcome: 'host_failed' });
      throw error;
    }
    record = this.save(record.id, {
      session: view(session),
      ...(session.hostRef === record.id ? { attached: true } : {}),
    });
    if (!liveSession(session)) {
      // Its own handoff closed it: the profile's grace, within its deadline, lets it finish
      // the turn and exit. The final capture is still taken only once it has ended.
      const since = Number(record.metadata.handedOffAt ?? this.clock()),
        grace = handoffGraceMs(record.metadata.profile as RunnerProfile);
      if (
        session.closeReason === 'handoff' &&
        record.status === 'running' &&
        this.clock() < Math.min(record.deadline, since + grace)
      ) {
        this.save(record.id, { handedOffAt: since });
        return false;
      }
      record = await this.halt(record.id, { remoteClosed: true });
      return terminalLaunch(record) && this.settle(record);
    }
    if (record.status === 'uncertain') return false;
    if (terminalLaunch(record)) return this.settle(record);
    if (this.deadline(session) <= this.clock()) {
      // Running out of time is the work's own ending, even when it races a stop of this runner.
      record = await this.halt(record.id, { releaseOutcome: 'host_failed' });
      return terminalLaunch(record) && this.settle(record);
    }
    if (record.status === 'reserved' || record.status === 'starting') {
      if (this.stopping) return false;
      const profile = validateProfile(record.metadata.profile);
      // What a failure costs: the workspace before the attach, the launch after it.
      let outcome: SessionReleaseOutcome = 'workspace_failed';
      try {
        if (
          this.local(record) &&
          this.config.workspace &&
          'github' in this.config.workspace &&
          effectiveWorkspace(session.execution.policy).mode !== 'none'
        ) {
          const grant = await this.client.transportGrant({
            sessionId: session.id,
            runnerId: session.runnerId,
            hostRef: record.id,
            operation: 'fetch',
          });
          try {
            const references = Object.values(session.execution.references)
              .flat()
              .filter((v): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v));
            await this.workspaces.syncGitHub(grant, references);
          } finally {
            await this.client.revokeGrant(grant);
          }
        }
        const driver = this.driverOf(record);
        if (!driver) throw new WorkspaceDeferred('driver_absent', 'workspace_driver_missing');
        const workspace = await driver.prepare(record, session);
        outcome = 'launch_failed';
        // Preparation may take time; the attach route rechecks current admission before spawn.
        session = await this.client.attach(
          record.sessionId,
          this.ledger.runnerId,
          record.id,
          workspace.snapshot,
        );
        this.save(record.id, { session: view(session), attached: true });
        if (!liveSession(session) || this.stopping) return false;
        const secret = this.ledger.sessionSecret(String(record.metadata.requestId));
        const command = buildLaunch(profile, {
          session,
          secret,
          mcpUrl: `${this.client.baseUrl}/mcp`,
          cwd: workspace.path,
          ...(profile.harness === 'codex'
            ? { disabledSkillPaths: collectRepositorySkillPaths(workspace.path) }
            : {}),
        });
        check(
          !JSON.stringify({ args: command.args, stdin: command.stdin }).includes(this.sourceBearer),
          'unsafe_runner_launch',
          'Source credential cannot enter the agent launch',
        );
        check(
          !Object.values(command.env).some((value) => value?.includes(this.sourceBearer)),
          'unsafe_runner_launch',
          'Source credential cannot enter the agent environment',
        );
        await this.host.launch({
          launchId: record.id,
          command,
          sessionToken: secret,
          deadline: record.deadline,
        });
      } catch (error) {
        // A reply that may yet come (a lost attach, say) is asked again on the next tick.
        if (error instanceof RunnerControlError && !error.final) throw error;
        this.lastError = diagnostic(error);
        // A preparation that could not happen yet is not a failure of this work or this
        // machine: it is released as deferred and nothing counts it.
        record = await this.halt(
          record.id,
          error instanceof WorkspaceDeferred
            ? {
                releaseOutcome: 'preparation_deferred',
                deferral: { cause: error.cause, code: error.code },
              }
            : { releaseOutcome: outcome },
        );
        return terminalLaunch(record) && this.settle(record);
      }
      return false;
    }
    if (session.status === 'active') {
      // Each only when it moves something by over a minute, read afresh from this tick's GET: a
      // heartbeat slides the session to min(now + 4 h, hardDeadline); the guardian follows it.
      const slid = Math.min(this.clock() + 4 * 3_600_000, Date.parse(session.hardDeadline));
      if (slid - Date.parse(session.expiresAt) > 60_000) {
        session = await this.client.heartbeat(record.sessionId, this.ledger.runnerId);
        record = this.save(record.id, { session: view(session) });
      }
      if (this.deadline(session) > record.deadline + 60_000)
        await this.host.extendDeadline(record.id, this.deadline(session));
      await this.reconcileCodeCommands(record, view(session));
    }
    return false;
  }
  private async reconcileCodeCommands(record: LaunchRecord, session?: SessionView): Promise<void> {
    const workspaces = this.driverOf(record);
    check(workspaces, 'workspace_driver_missing', 'This runner does not carry that driver');
    if (!commits(workspaces)) {
      check(
        !session?.execution.policy.tools.some((tool) => tool.name === 'code.commit'),
        'workspace_commit_unsupported',
        'This workspace driver does not support Code commands',
      );
      return;
    }
    const local = this.local(record);
    const perform = async (command: CodeCommitCommand) => {
      // A restart may owe only a receipt, even after the worker or workspace has closed.
      // The manager distinguishes proven outcomes from an interrupted Git operation.
      if (!workspaces.commitOutcome(command.id)) {
        record = await this.host.inspect(record.id);
        if (terminalLaunch(record)) await workspaces.capture(record);
      }
      try {
        await workspaces.checkpointCommit(record, command);
      } catch (error) {
        if (!workspaces.commitOutcome(command.id)) throw error;
      }
      const outcome = workspaces.commitOutcome(command.id);
      check(outcome, 'code_operation_uncertain', 'Git operation has no proven outcome', 503);
      if (local && 'receipt' in outcome && outcome.receipt.repositoryId.startsWith('github:')) {
        await this.publishGit({
          sessionId: command.sessionId,
          runnerId: command.runnerId,
          hostRef: command.hostRef,
          operation: 'checkpoint',
          receipt: outcome.receipt,
        });
      }
      await this.answer(() => this.client.completeCodeCommand(command, outcome));
      workspaces.acknowledgeCommit(command.id);
    };
    for (const command of workspaces.pendingCommits(record.id)) await perform(command);
    if (
      !session ||
      (record.status !== 'running' && !terminalLaunch(record)) ||
      !session.workspace ||
      session.execution.policy.readOnly ||
      !session.execution.policy.tools.some((tool) => tool.name === 'code.commit')
    )
      return;
    const command = await this.answer(() => this.client.nextCodeCommand(session, record.id));
    if (!command) return;
    // A lost next-command response may have left only a server-side dispatch.
    // Terminal launches recover its descriptor after capture has revoked the
    // workspace owner fence; perform can then report a stopped-safe outcome.
    await perform(command);
  }
  /**
   * What an ended launch owes, in order: its release, capture, owed Code receipts, workspace
   * result and closed checkout; true once nothing is. One whose driver is gone waits for it.
   */
  private async settle(record: LaunchRecord): Promise<boolean> {
    if (record.metadata.usageReported !== true) record = await this.release(record);
    const driver = this.driverOf(record);
    if (!driver) {
      this.lastError = 'workspace_driver_missing';
      return false;
    }
    const workspace = driver.get(record.id);
    if (!workspace || workspace.status === 'closed') return true;
    const result = await driver.capture(record);
    await this.reconcileCodeCommands(
      record,
      record.metadata.session as unknown as SessionView | undefined,
    );
    // Only an attached checkout has a result to report; the session is closed by now.
    if (result && record.metadata.attached === true && record.metadata.workspaceReported !== true) {
      if (this.local(record) && result.repositoryId.startsWith('github:') && !workspace.readOnly) {
        await this.publishGit({
          sessionId: record.sessionId,
          runnerId: this.ledger.runnerId,
          hostRef: record.id,
          operation: 'capture',
          workspace: result,
        });
      }
      await this.answer(() =>
        this.client.workspaceResult(record.sessionId, this.ledger.runnerId, record.id, result),
      );
      record = this.save(record.id, { workspaceReported: true });
    }
    await driver.close(record);
    return true;
  }
  /** The one release: its outcome, or only its usage once closed. The reply says if attached. */
  private async release(record: LaunchRecord): Promise<LaunchRecord> {
    const { metadata } = record,
      remote = metadata.remoteClosed === true,
      usage = this.readUsage(record);
    // A stop the user made on their own machine is nobody's failure; an ending that merely
    // raced it still counts. Hosted stops and source-refusal halts stay counted: `released`
    // has no backoff, so a repeated eviction or a poison 401 would re-offer the work at once.
    const byStop =
      !this.config.oneAssignment &&
      (this.stopping || metadata.runnerStopped === true) &&
      ['controller_stop', 'external_stop', 'cancelled_before_spawn'].includes(record.reason ?? '');
    // A successful process exit does not prove that its workflow gate was completed.
    const failed = this.clock() - record.createdAt < 10_000 ? 'crash_loop' : 'host_failed';
    const outcome =
      (metadata.releaseOutcome as SessionReleaseOutcome | undefined) ??
      (byStop ? undefined : failed);
    let session: Session | undefined;
    // A managed runner acknowledges its local stop even when a handoff left no usage.
    if (!remote || usage || this.config.oneAssignment) {
      const input = remote
        ? { usage }
        : { outcome, reason: terminalReason(record), usage, deferral: deferralOf(record) };
      session = await this.answer(() =>
        this.client.release(record.sessionId, this.ledger.runnerId, input),
      );
    }
    return this.save(record.id, {
      ...(session ? { session: view(session), attached: session.hostRef === record.id } : {}),
      remoteClosed: true,
      usageReported: true,
    });
  }
  /** A final refusal is that call's answer: recorded once, never replayed. */
  private async answer<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RunnerControlError) || !error.final) throw error;
      this.lastError = error.code;
      return undefined;
    }
  }
  /**
   * A regular file of at most 4 KB in the one closed shape: a launched process can write
   * anything here, so a link, a device or a malformed report is simply not sent. Without one,
   * what the profile's harness printed of its spending at the end of the launch's redacted log:
   * its last 1 MiB, from the first whole line, however long the log grew.
   */
  private readUsage(record: LaunchRecord): SessionUsageReport | undefined {
    const read = (path: string, limit: number, tail = false) => {
      const stat = lstatSync(path),
        size = stat.size;
      if (!stat.isFile() || (!tail && size > limit)) throw new Error('Not a readable report');
      const bytes = Buffer.alloc(Math.min(size, limit)),
        fd = openSync(path, 'r');
      try {
        readSync(fd, bytes, 0, bytes.length, size - bytes.length);
      } finally {
        closeSync(fd);
      }
      const text = bytes.toString('utf8');
      return bytes.length < size ? text.slice(text.indexOf('\n') + 1) : text;
    };
    try {
      return sessionUsageReportSchema.parse(JSON.parse(read(usageFile(record), 4096)));
    } catch {
      // No report of its own; the harness may have printed one.
    }
    try {
      const log = read(join(record.runDirectory, 'stdout.log'), 1 << 20, true);
      return sessionUsageReportSchema.parse(
        harnessUsage(record.metadata.profile as RunnerProfile, log),
      );
    } catch {
      return;
    }
  }
  /** Stop a launch, having recorded why first; an ended launch is then settled. */
  private async halt(id: string, patch: Record<string, unknown>): Promise<LaunchRecord> {
    this.save(id, patch);
    return this.host.stop(id);
  }
  private async enforceDeadlines(): Promise<void> {
    for (const record of this.ledger.open())
      if (!terminalLaunch(record) && record.deadline <= this.clock())
        await this.halt(record.id, { releaseOutcome: 'host_failed' });
  }
  private async stopOwned(): Promise<void> {
    await Promise.all(
      this.ledger
        .open()
        .filter((record) => !terminalLaunch(record))
        .map(async (record) => {
          try {
            await this.host.stop(record.id);
          } catch {
            this.lastError = 'local_stop_unconfirmed';
          }
        }),
    );
  }
  snapshot(): RunnerSnapshot {
    return {
      runnerId: this.ledger.runnerId,
      state: this.state,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastDeclined ? { lastDeclined: this.lastDeclined } : {}),
      pendingRequests: this.stopped
        ? this.finalPendingRequests
        : this.ledger.pendingRequests().length,
      launches: this.stopped ? this.finalLaunches : this.summaries(),
    };
  }
  private async publishGit(input: import('@merv/contracts').CodeTransportInput) {
    const grant = await this.client.transportGrant(input);
    try {
      await this.workspaces.pushGitHub(grant);
      await this.client.verifyTransport(input);
    } finally {
      await this.client.revokeGrant(grant);
    }
  }
  private disposeDrivers(): void {
    this.workspaces.dispose();
    for (const driver of this.drivers.values()) driver.dispose();
  }
  private finalLaunches: RunnerSnapshot['launches'] = [];
  private summaries(): RunnerSnapshot['launches'] {
    return this.ledger.list().map((r) => {
      const session = r.metadata.session as unknown as SessionView | undefined;
      const workspace = this.driverOf(r)?.get(r.id);
      return {
        id: r.id,
        sessionId: r.sessionId,
        ...(session?.agentId
          ? {
              agentId: session?.agentId,
              agentSessionId: session?.agentSessionId,
            }
          : {}),
        status: r.status,
        platform: String(r.metadata.platform ?? ''),
        deadline: r.deadline,
        exitCode: r.exitCode,
        releasePending: terminalLaunch(r) && r.metadata.usageReported !== true,
        ...(workspace
          ? {
              workspace: {
                status: workspace.status,
                headOid: workspace.snapshot?.headOid,
                capturePending: workspace.status !== 'closed',
              },
            }
          : {}),
      };
    });
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.state = 'stopping';
    if (this.timer) clearInterval(this.timer);
    return (this.stopPromise = (async () => {
      // A failed lock acquisition never grants authority over another controller's children.
      if (!this.started) return this.finalize();
      // What this stop ends is released uncounted (see release()). The flag outlives a
      // controller that exits before those releases go out, and ended launches carry it too:
      // the same stop's group SIGTERM may have reached their guardian first.
      if (!this.config.oneAssignment)
        for (const record of this.ledger.open())
          if (record.metadata.usageReported !== true) this.save(record.id, { runnerStopped: true });
      await this.current;
      await this.stopOwned();
      const settled: string[] = [];
      for (const record of this.ledger.open())
        try {
          if (terminalLaunch(record) && (await this.settle(record))) settled.push(record.id);
        } catch {
          /* Persisted cleanup remains retryable on restart. */
        }
      this.ledger.settle(settled);
      this.finalize();
    })());
  }
  /** Keep the last snapshot, then close everything; a runner that never started holds no lock. */
  private finalize(): void {
    this.finalLaunches = this.summaries();
    this.finalPendingRequests = this.ledger.pendingRequests().length;
    this.disposeDrivers();
    this.unlock?.();
    this.ledger.close();
    this.stopped = true;
    this.state = 'stopped';
  }
}

/** The runner with the workspace drivers of other plugins, which only a composition may name. */
export const runnerWith = (drivers: WorkspaceDriverFactory[]) => ({
  name: 'merv-runner',
  inject: [],
  async apply(ctx: Context, config: RunnerConfig) {
    await ctx.effect(async function* () {
      const runner = new MachineRunner(config, { drivers });
      yield () => runner.stop();
      await runner.start();
      yield ctx.provide('runner', runner);
    });
  },
});
export const runnerPlugin = runnerWith([]);
export default runnerPlugin;
