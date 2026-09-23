import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
class RunnerSourceRefusal extends RunnerControlError {}
/** What a put-off preparation recorded on the launch, as the release route carries it. */
const deferralOf = (record: LaunchRecord): SessionDeferral | undefined => {
  if (record.metadata.releaseOutcome !== 'preparation_deferred') return undefined;
  const deferral = record.metadata.deferral as { cause?: unknown; code?: unknown } | undefined;
  return typeof deferral?.cause === 'string' && typeof deferral.code === 'string'
    ? { cause: deferral.cause, code: deferral.code }
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
  /** The driver a launch was reserved for; fixed with the lease, like its policy. */
  private driverFor(record: LaunchRecord): WorkspaceDriver {
    const name = record.metadata.workspaceDriver;
    if (typeof name !== 'string') return this.workspaces;
    const driver = this.drivers.get(name);
    check(driver, 'workspace_driver_missing', 'This runner does not carry that workspace driver');
    return driver;
  }
  /** Whether the launch uses the runner's own repository, which alone may involve GitHub. */
  private local(record: LaunchRecord): boolean {
    return typeof record.metadata.workspaceDriver !== 'string';
  }
  private occupied(record: LaunchRecord): boolean {
    const workspace = this.driverFor(record).get(record.id);
    return !terminalLaunch(record) || (!!workspace && workspace.status !== 'closed');
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
    const heartbeat = () =>
      this.client.presence({
        runnerId: this.ledger.runnerId,
        machine: { hostname: hostname(), system: process.platform, architecture: process.arch },
        platforms: this.profiles.map(platformOf),
        capacity: this.config.oneAssignment && this.ledger.list().length > 0 ? 0 : this.capacity(),
        appliedVersion: this.appliedVersion,
        ...(this.drivers.size ? { capabilities: [...this.drivers.keys()].sort() } : {}),
      });
    const presence = await heartbeat();
    if (presence.desiredVersion !== this.appliedVersion) {
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
    try {
      await this.advertise();
    } catch (error) {
      this.lastError = diagnostic(error);
      if (error instanceof RunnerControlError && [401, 403].includes(error.status)) {
        this.state = 'unauthorized';
        await this.stopOwned();
      } else {
        this.state = 'offline';
        await this.enforceDeadlines();
      }
      return;
    }
    for (const launch of this.ledger.list()) {
      if (this.stopping) break;
      try {
        await this.reconcileLaunch(launch);
      } catch (error) {
        this.lastError = diagnostic(error);
      }
    }
    if (this.stopping) return;
    // Existing uncertain requests are retried first, preserving their original platform and secret.
    for (const pending of this.ledger.pendingRequests()) {
      if (this.stopping) break;
      if (
        this.config.oneAssignment &&
        this.ledger.list().length > 0 &&
        !this.ledger.list().some((record) => record.metadata.requestId === pending.requestId)
      )
        continue;
      await this.acquire(pending);
    }
    for (const profile of this.profiles) {
      if (this.stopping || (this.config.oneAssignment && this.ledger.list().length > 0)) break;
      const live = this.ledger.list().filter((record) => this.occupied(record));
      if (
        !profile.enabled ||
        live.length >= this.capacity() ||
        live.filter((record) => record.metadata.platform === profile.name).length >=
          profile.parallelism ||
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
    const records = this.ledger.list();
    if (this.config.workspace && 'github' in this.config.workspace) {
      // External publication is recoverable and must not stop local worker supervision.
      await this.client.syncPublications().catch(() => {});
    }
    this.state =
      this.lastError || records.some((r) => r.status === 'uncertain')
        ? 'degraded'
        : records.some((r) => !terminalLaunch(r))
          ? 'running'
          : 'idle';
  }
  private async acquire(pending: PendingLaunchRequest): Promise<void> {
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
      const profile = validateProfile({ ...configured, ...pending.platform });
      const workspace = effectiveWorkspace(session.execution.policy);
      const driver = workspace.mode === 'none' ? undefined : workspace.driver;
      record = this.ledger.reserve({
        id,
        sessionId: session.id,
        deadline: this.deadline(session),
        metadata: {
          session,
          profile,
          platform: profile.name,
          requestId: pending.requestId,
          releasePending: false,
          attached: false,
          ...(driver === undefined ? {} : { workspaceDriver: driver }),
        } as unknown as LaunchMetadata,
      });
      if (session.status === 'active') this.ledger.markUncertain(id);
    }
    this.ledger.completeRequest(pending.platform.name, pending.requestId);
    await this.reconcileLaunch(this.ledger.get(id)!);
  }
  private deadline(session: Session): number {
    return Math.min(Date.parse(session.expiresAt), Date.parse(session.hardDeadline));
  }
  private async reconcileLaunch(initial: LaunchRecord): Promise<void> {
    let record = await this.host.inspect(initial.id);
    if (terminalLaunch(record)) await this.captureWorkspace(record);
    if (terminalLaunch(record) && record.metadata.remoteClosed === true) {
      await this.reportUsage(record);
      await this.finishWorkspace(record);
      return;
    }
    let session: Session;
    try {
      session = await this.client.get(record.sessionId, this.ledger.runnerId);
    } catch (error) {
      if (error instanceof RunnerControlError && [401, 403, 404, 409].includes(error.status))
        await this.halt(record.id, { remoteRefusal: error.code });
      else if (record.deadline <= this.clock()) await this.halt(record.id);
      throw error;
    }
    record = this.save(record.id, {
      session,
      ...(session.hostRef === record.id ? { attached: true } : {}),
    });
    if (!liveSession(session)) {
      record = await this.host.stop(record.id);
      this.save(record.id, {
        remoteClosed: true,
        releasePending: this.config.oneAssignment || !terminalLaunch(record),
      });
      if (terminalLaunch(record)) {
        await this.reportUsage(record);
        await this.finishWorkspace(record);
      }
      return;
    }
    if (record.status === 'uncertain') return;
    if (terminalLaunch(record)) {
      await this.release(record);
      return;
    }
    if (this.deadline(session) <= this.clock()) {
      record = await this.host.stop(record.id);
      if (terminalLaunch(record)) await this.release(record);
      return;
    }
    if (record.status === 'reserved' || record.status === 'starting') {
      if (this.stopping) return;
      const profile = validateProfile(record.metadata.profile);
      let workspace;
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
        workspace = await this.driverFor(record).prepare(record, session);
      } catch (error) {
        record = await this.host.stop(record.id);
        // A preparation that could not happen yet is not a failure of this work or this
        // machine: it is released as deferred and nothing counts it.
        this.save(
          record.id,
          error instanceof WorkspaceDeferred
            ? {
                releaseOutcome: 'preparation_deferred',
                deferral: { cause: error.cause, code: error.code },
                lastError: error.code,
              }
            : { releaseOutcome: 'workspace_failed' },
        );
        if (terminalLaunch(record)) await this.release(this.ledger.get(record.id)!);
        throw error;
      }
      // Preparation may take time; the attach route rechecks current admission before spawn.
      this.save(record.id, { attachAttempted: true });
      session = await this.client.attach(
        record.sessionId,
        this.ledger.runnerId,
        record.id,
        workspace.snapshot,
      );
      this.save(record.id, { session, attached: true });
      if (!liveSession(session) || this.stopping) return;
      const secret = this.ledger.sessionSecret(String(record.metadata.requestId));
      try {
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
        const stopped = await this.host.stop(record.id);
        this.save(record.id, { releaseOutcome: 'launch_failed', lastError: diagnostic(error) });
        if (terminalLaunch(stopped)) await this.release(this.ledger.get(record.id)!);
        throw error;
      }
      return;
    }
    if (session.status === 'active') {
      session = await this.client.heartbeat(record.sessionId, this.ledger.runnerId);
      await this.host.extendDeadline(record.id, this.deadline(session));
      this.save(record.id, { session });
      await this.reconcileCodeCommands(this.ledger.get(record.id)!, session);
    }
  }
  private async reconcileCodeCommands(record: LaunchRecord, session?: Session): Promise<void> {
    const workspaces = this.driverFor(record);
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
        if (terminalLaunch(record)) await this.captureWorkspace(record);
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
      await this.client.completeCodeCommand(command, outcome);
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
    const command = await this.client.nextCodeCommand(session, record.id);
    if (!command) return;
    // A lost next-command response may have left only a server-side dispatch.
    // Terminal launches recover its descriptor after capture has revoked the
    // workspace owner fence; perform can then report a stopped-safe outcome.
    await perform(command);
  }
  private async release(record: LaunchRecord): Promise<void> {
    if (!terminalLaunch(record)) return;
    await this.finishWorkspace(record);
    this.save(record.id, { releasePending: true });
    const requested = record.metadata.releaseOutcome;
    // A successful process exit does not prove that its workflow gate was completed.
    const outcome =
      requested === 'launch_failed' ||
      requested === 'workspace_failed' ||
      requested === 'preparation_deferred'
        ? requested
        : this.clock() - record.createdAt < 10_000
          ? 'crash_loop'
          : 'host_failed';
    const session = await this.client.release(
      record.sessionId,
      this.ledger.runnerId,
      outcome,
      'local_process_finished',
      this.readUsage(record),
      deferralOf(record),
    );
    this.save(record.id, {
      session,
      releasePending: false,
      remoteClosed: true,
      usageReported: true,
    });
  }
  /**
   * A regular file of at most 4 KB in the one closed shape, or nothing: a launched process
   * can write anything here, so a link, a device or a malformed report is simply not sent.
   */
  private readUsage(record: LaunchRecord): SessionUsageReport | undefined {
    try {
      const path = usageFile(record),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096) return;
      const parsed = sessionUsageReportSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  }
  /** A managed runner acknowledges local stop even when a remote handoff left no usage file. */
  private async reportUsage(record: LaunchRecord): Promise<void> {
    if (record.metadata.usageReported === true) return;
    const usage = this.readUsage(record);
    if (this.config.oneAssignment) this.save(record.id, { releasePending: true });
    try {
      if (usage || this.config.oneAssignment)
        await this.client.reportUsage(record.sessionId, this.ledger.runnerId, usage);
    } catch (error) {
      if (!(error instanceof RunnerControlError) || error.unavailable) throw error;
    }
    this.save(record.id, {
      usageReported: true,
      ...(this.config.oneAssignment ? { releasePending: false } : {}),
    });
  }
  /** Stop a launch, capture what an ended one left, and owe the server its release. */
  private async halt(id: string, patch: Record<string, unknown> = {}): Promise<void> {
    const stopped = await this.host.stop(id);
    if (terminalLaunch(stopped)) await this.captureWorkspace(stopped);
    this.save(id, { releasePending: true, ...patch });
  }
  private async enforceDeadlines(): Promise<void> {
    for (const record of this.ledger.list())
      if (!terminalLaunch(record) && record.deadline <= this.clock()) await this.halt(record.id);
  }
  private async stopOwned(): Promise<void> {
    await Promise.all(
      this.ledger
        .list()
        .filter((record) => !terminalLaunch(record))
        .map(async (record) => {
          try {
            await this.halt(record.id);
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
  private async captureWorkspace(record: LaunchRecord): Promise<void> {
    const workspace = this.driverFor(record).get(record.id);
    if (!workspace || workspace.status === 'closed') return;
    await this.driverFor(record).capture(record);
  }
  private async finishWorkspace(record: LaunchRecord): Promise<void> {
    const workspace = this.driverFor(record).get(record.id);
    if (!workspace || workspace.status === 'closed') return;
    const result = await this.driverFor(record).capture(record);
    await this.reconcileCodeCommands(
      record,
      record.metadata.session as unknown as Session | undefined,
    );
    if (result && record.metadata.attachAttempted === true && record.metadata.attached !== true) {
      // A lost attach reply is ambiguous. Close the lease before interpreting a null host,
      // so no delayed attach can commit after we release the local checkout reservation.
      const deferral = deferralOf(record);
      const session = await this.client.release(
        record.sessionId,
        this.ledger.runnerId,
        deferral ? 'preparation_deferred' : 'launch_failed',
        'stopped_before_attach_confirmed',
        undefined,
        deferral,
      );
      record = this.save(record.id, {
        session,
        attached: session.hostRef === record.id,
        remoteClosed: true,
        releasePending: false,
      });
    }
    // A capture from an unstarted/unattached checkout has no remote attachment to finalize.
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
      const session = await this.client.workspaceResult(
        record.sessionId,
        this.ledger.runnerId,
        record.id,
        result,
      );
      this.save(record.id, { session, workspaceReported: true });
    }
    await this.driverFor(record).close(record);
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
      const session = r.metadata.session as unknown as Session | undefined;
      const workspace = (
        typeof r.metadata.workspaceDriver === 'string'
          ? this.drivers.get(r.metadata.workspaceDriver)
          : this.workspaces
      )?.get(r.id);
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
        releasePending: r.metadata.releasePending === true,
        ...(workspace
          ? {
              workspace: {
                status: workspace.status,
                headOid: workspace.snapshot?.headOid,
                capturePending: !['captured', 'closed'].includes(workspace.status),
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
      await this.current;
      await this.stopOwned();
      for (const record of this.ledger.list())
        if (terminalLaunch(record)) {
          try {
            if (record.metadata.remoteClosed !== true) await this.release(record);
            else await this.finishWorkspace(record);
          } catch {
            /* Persisted cleanup remains retryable on restart. */
          }
        }
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
