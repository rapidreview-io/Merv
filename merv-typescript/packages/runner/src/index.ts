import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
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
  type WorkspaceDriver,
  type WorkspaceDriverFactory,
} from '@merv/contracts';
import type {
  RunnerPlatform,
  Session,
  SessionDeferral,
  SessionReleaseOutcome,
  SessionUsageReport,
} from '@merv/sessions/types';
import { INQUIRY_CAPABILITY, live as liveSession, ownEnd } from '@merv/sessions/rules';
import { RunnerClient, RunnerControlError } from './client.js';
import {
  LocalLedger,
  terminalLaunch,
  type LaunchRecord,
  type LaunchMetadata,
  type PendingLaunchRequest,
} from './ledger.js';
import { ProcessHost, usageFile } from './process-host.js';
import { readTranscript, type TranscriptFacts } from './transcript.js';
import { AgentStream } from './agent-stream.js';
import {
  conversationFile,
  forgetConversations,
  keepConversation,
  refusedResume,
  restoreConversation,
  type ConversationFacts,
} from './conversation.js';
import { harnessOf, launcherOf, type HarnessName } from './harness/index.js';
import { assignmentUser, RunnerWorkspaces } from './workspaces.js';
import {
  buildLaunch,
  sealed,
  inquiring,
  collectRepositorySkillPaths,
  handoffGraceMs,
  validateProfile,
  type RunnerProfile,
} from './profiles.js';
import type { Runner, RunnerSnapshot } from './types.js';
export type * from './types.js';

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
    /** Ignored: the CLI always composes the Code driver. Older configurations still name it. */
    workspaceDrivers: z.array(z.literal('code')).max(1).optional(),
    /** Existing image-provisioned scratch root outside the private ledger, for isolated Codex. */
    assignmentWorkspaceDirectory: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\0\r\n]/.test(value) && resolve(value) === value)
      .optional(),
    /** A managed hosted machine, a work host: it keeps its workspace across the separate
     *  sessions of exactly this one work item. */
    workInstanceId: z.string().min(1).max(200).optional(),
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
  if (parsed.data.assignmentWorkspaceDirectory || parsed.data.workInstanceId)
    check(
      profiles.length === 1 &&
        launcherOf(profiles[0]).isolated(profiles[0]) &&
        profiles[0].parallelism === 1 &&
        parsed.data.capacity === 1 &&
        !!parsed.data.assignmentWorkspaceDirectory &&
        !!parsed.data.workInstanceId,
      'invalid_runner_config',
      'A work host requires one isolated Codex profile, capacity one and an assignment root',
    );
  return { ...parsed.data, profiles };
}
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
  if (reason === 'socket_failed') return 'local_process_socket_failed';
  if (reason === 'launch_timeout') return 'local_process_launch_timeout';
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
    ...(s.threadId ? { threadId: s.threadId } : {}),
    status: s.status,
    closeReason: s.closeReason,
    hostRef: s.hostRef,
    expiresAt: s.expiresAt,
    hardDeadline: s.hardDeadline,
    ...(s.workspace ? { workspace: s.workspace } : {}),
    ...(s.continuity ? { continuity: s.continuity } : {}),
    kind: s.kind,
    ...(s.kind === 'inquiry' ? { inquiry: s.inquiry } : {}),
    // The budget check reads it from here on, since a running launch polls only the control view.
    ...(s.tokenBudget !== undefined ? { tokenBudget: s.tokenBudget } : {}),
    execution: { policy: { readOnly, workspace, tools: tools.map(({ name }) => ({ name })) } },
  };
};
type SessionView = ReturnType<typeof view>;
/**
 * What a launch owes of its transcript and of the conversation it kept, each in its metadata
 * under its own name: hashes and sizes, never bytes.
 */
type Owed<Facts> =
  | { state: 'none' | 'uploaded' }
  | { state: 'refused'; code: string }
  | ({ state: 'owed'; tries?: number } & Facts);
type Transcript = Owed<TranscriptFacts>;
const kinds = ['transcript', 'conversation'] as const;
type Kind = (typeof kinds)[number];
/**
 * Ten PUTs at most, a minute apart after a failure; one at a time, off the tick. The delivery
 * after the tenth only confirms it.
 */
const transcriptTries = 10,
  transcriptRetryMs = 60_000;
/** A declaration's facts: what its route is sent. */
const factsOf = <Facts extends object>({
  state: _state,
  tries: _tries,
  ...facts
}: { state: 'owed'; tries?: number } & Facts) => facts as Facts;
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
  private readonly workspaces: RunnerWorkspaces;
  /**
   * Whatever prepares checkouts, by the name a workspace policy gives it. The scheduler below
   * only ever speaks the driver interface; work that names no driver gets only a scratch
   * directory.
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
  private readonly resetAssignment?: () => Promise<void>;
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
  /** The one transcript PUT in flight; it writes no ledger state, so it may outlive a stop. */
  private uploading?: AbortController;
  /** When each kind of a launch's files may be put again, by `kind:launch`. */
  private readonly transcriptRetry = new Map<string, number>();
  /** Each launched agent's live stream, kept until its log is sent to the end. */
  private readonly streams = new Map<string, AgentStream>();

  constructor(
    config: RunnerConfig,
    options: {
      fetch?: typeof fetch;
      clock?: () => number;
      autoPoll?: boolean;
      /** Workspace drivers other plugins own; whoever composes the machine supplies them. */
      drivers?: WorkspaceDriverFactory[];
      /** Trusted hosted-runtime barrier: kill all assignment descendants and clear private state. */
      resetAssignment?: () => Promise<void>;
    } = {},
  ) {
    const parsed = validateRunnerConfig(config);
    check(
      !parsed.workInstanceId || options.resetAssignment,
      'invalid_runner_config',
      'A retained work host requires an assignment cleanup barrier',
    );
    this.resetAssignment = parsed.workInstanceId ? options.resetAssignment : undefined;
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
      !JSON.stringify({ profiles: this.profiles }).includes(source),
      'invalid_runner_config',
      'Source credentials cannot appear in launch configuration',
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
    this.host = new ProcessHost(this.ledger, source);
    try {
      check(
        !this.config.workInstanceId ||
          this.ledger
            .list()
            .every(
              (record) =>
                (record.metadata.session as unknown as SessionView | undefined)?.instanceId ===
                this.config.workInstanceId,
            ),
        'invalid_runner_config',
        'Retained runner history belongs to another work item',
      );
      // A work host always has both: the configuration refuses one without the other.
      this.workspaces = new RunnerWorkspaces(
        this.ledger,
        this.config.workInstanceId
          ? {
              directory: this.config.assignmentWorkspaceDirectory!,
              workInstanceId: this.config.workInstanceId,
            }
          : undefined,
        (id) => this.previousWorkspace(id),
      );
      for (const factory of options.drivers ?? [])
        try {
          this.drivers.set(
            factory.name,
            factory.create(
              {
                directory: this.ledger.directory,
                assignmentWorkspaceDirectory: this.config.assignmentWorkspaceDirectory,
                assignmentUser,
                workInstanceId: this.config.workInstanceId,
                previousWorkspace: (id) => this.previousWorkspace(id),
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
  private previousWorkspace(id: string) {
    if (!this.config.workInstanceId) return undefined;
    const record = this.ledger.previousSettled(id);
    if (
      !record ||
      !terminalLaunch(record) ||
      (record.metadata.session as unknown as SessionView | undefined)?.instanceId !==
        this.config.workInstanceId
    )
      return undefined;
    const workspace = this.driverOf(record)?.get(record.id);
    return workspace?.status === 'closed' ? workspace : undefined;
  }
  private occupied(record: LaunchRecord): boolean {
    const workspace = this.driverOf(record)?.get(record.id);
    return !terminalLaunch(record) || (!!workspace && workspace.status !== 'closed');
  }
  private managed(): boolean {
    return !!this.config.workInstanceId;
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
    // `runner.2`: this runner ignores fields a server adds to its replies (`runner.1`), and it
    // has no repository of its own for work that names no driver. A managed runner's
    // capabilities must equal its enrolment, so it names only its drivers.
    // `inquiry.1`: it runs an inquiry visit as one, read-only and keeping nothing (`inquiring`).
    const marker = [this.managed() ? 'workflow.workhost.1' : 'runner.2', INQUIRY_CAPABILITY];
    const capabilities = [...this.drivers.keys(), ...marker].sort();
    // Sent when it changed or 15 s after the last one succeeded (fresh for 45 s on the server).
    const heartbeat = async () => {
      const body = {
        runnerId: this.ledger.runnerId,
        machine: { hostname: hostname(), system: process.platform, architecture: process.arch },
        platforms: this.profiles.map(platformOf),
        capacity: this.capacity(),
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
          ...(launcherOf(profile).tuned ? { model: desired.model, effort: desired.effort } : {}),
        };
        return validateProfile(candidate);
      });
      this.appliedVersion = presence.desiredVersion;
      await heartbeat();
    }
  }
  private async cycle(): Promise<void> {
    this.lastError = undefined;
    for (const error of await this.host.reconcile()) this.lastError = diagnostic(error);
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
    this.follow(settled);
    if (this.stopping) return;
    // One work host advances only after process cleanup, capture, release and transcript settled.
    // A terminal process alone is not enough: its durable handoff may still be outstanding.
    if (this.config.workInstanceId && this.ledger.open().length) leasing = false;
    // Existing uncertain requests are retried first, preserving their original platform and secret.
    for (const pending of this.ledger.pendingRequests()) {
      if (this.stopping || !leasing) break;
      await this.acquire(pending);
    }
    for (const profile of this.profiles) {
      if (this.stopping || !leasing) break;
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
        // The server waits for presence to report its settings: the next cycle sends it at once.
        if (result.reason === 'settings_pending') this.presented = undefined;
        this.ledger.completeRequest(pending.platform.name, pending.requestId);
        return;
      }
      this.lastDeclined = undefined;
      check(
        !this.config.workInstanceId || session.instanceId === this.config.workInstanceId,
        'invalid_control_response',
        'Retained machine received another work item',
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
  private deadline(session: Pick<Session, 'expiresAt' | 'hardDeadline'>): number {
    return Math.min(Date.parse(session.expiresAt), Date.parse(session.hardDeadline));
  }
  /** One tick of a launch's supervision; true once it has ended and owes nothing more. The
   *  tick's host.reconcile() has asked its guardian already, so the ledger is read as it is. */
  private async reconcileLaunch(initial: LaunchRecord): Promise<boolean> {
    let record = this.ledger.get(initial.id)!;
    if (terminalLaunch(record) && record.metadata.remoteClosed === true) return this.settle(record);
    // A launch not yet started reads the whole session its workspace is prepared from. A started
    // one polls only the control fields; the rest is what its lease and attach gave it.
    const launching = record.status === 'reserved' || record.status === 'starting';
    let session: SessionView, full: Session | undefined;
    try {
      session = launching
        ? view((full = await this.client.get(record.sessionId, this.ledger.runnerId)))
        : {
            ...(record.metadata.session as unknown as SessionView),
            ...(await this.client.control(record.sessionId, this.ledger.runnerId)),
          };
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
      session,
      ...(session.hostRef === record.id ? { attached: true } : {}),
    });
    if (!liveSession(session)) {
      // Its own handoff or question closed it: the profile's grace, within its deadline, lets it finish
      // the turn and exit. The final capture is still taken only once it has ended.
      const since = Number(record.metadata.handedOffAt ?? this.clock()),
        grace = handoffGraceMs(record.metadata.profile as RunnerProfile);
      if (
        ownEnd(session.closeReason) &&
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
    // A visit with a budget of its own stops once what its agent printed of its spend passes it,
    // where no model relay holds it to it: on a machine of the owner's (self-hosted Claude). A
    // hosted machine's calls go through Fleet's relay, which refuses the call past it.
    const budget = session.tokenBudget;
    if (record.status === 'running' && typeof budget === 'number' && !this.managed()) {
      const used = this.readUsage(record, 16 << 20);
      if (used && used.inputTokens + used.outputTokens > budget) {
        record = await this.halt(record.id, {
          releaseOutcome: 'host_failed',
          releaseReason: 'token_budget_spent',
        });
        return terminalLaunch(record) && this.settle(record);
      }
    }
    if (full) {
      if (this.stopping) return false;
      const profile = validateProfile(record.metadata.profile);
      // What a failure costs: the workspace before the attach, the launch after it.
      let outcome: SessionReleaseOutcome = 'workspace_failed';
      try {
        if (this.resetAssignment && record.metadata.assignmentPrepared !== true) {
          await this.resetAssignment();
          record = this.save(record.id, { assignmentPrepared: true });
        }
        const driver = this.driverOf(record);
        if (!driver) throw new WorkspaceDeferred('driver_absent', 'workspace_driver_missing');
        const workspace = await driver.prepare(record, full);
        outcome = 'launch_failed';
        // Preparation may take time; the attach route rechecks current admission before spawn.
        const { session, prompt } = await this.client.attach(
          record.sessionId,
          this.ledger.runnerId,
          record.id,
          workspace.snapshot,
        );
        this.save(record.id, { session: view(session), attached: true });
        if (!liveSession(session) || this.stopping) return false;
        const secret = this.ledger.sessionSecret(String(record.metadata.requestId));
        const launcher = launcherOf(profile);
        const hfAccess =
          /^mr_[0-9a-f]{64}$/.test(this.sourceBearer) && launcher.huggingface(profile)
            ? await this.client
                .huggingfaceAccess(session.id, this.ledger.runnerId, record.id)
                .catch(() => null)
            : null;
        const connections =
          launcher.agent && !sealed(session)
            ? await this.client.launchConnections(session.id, this.ledger.runnerId, record.id)
            : [];
        if (this.stopping) return false;
        const home = launcher.prepare(profile, record.runDirectory);
        const resume = await this.restore(record, profile, session, workspace.path);
        // An inquiry is put to the conversation it names; a fresh agent would know nothing.
        check(
          !inquiring(session) || resume,
          'inquiry_unresumable',
          'The conversation the inquiry asks could not be restored',
        );
        const command = buildLaunch(
          profile,
          {
            prompt,
            connections,
            hfToken: hfAccess?.token,
            hfEndpoint: hfAccess?.endpoint,
            session,
            secret,
            mcpUrl: `${this.client.baseUrl}/mcp`,
            cwd: workspace.path,
            ...(launcher.skills
              ? { disabledSkillPaths: collectRepositorySkillPaths(workspace.path) }
              : {}),
            shellEnvFile: join(record.runDirectory, 'shell-env.sh'),
            ...(resume && { resume }),
          },
          home ? { ...process.env, ...home } : process.env,
        );
        if (command.shellEnv)
          writeFileSync(command.env.CLAUDE_ENV_FILE!, command.shellEnv, { mode: 0o600 });
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
      // Read afresh from this tick's GET: a heartbeat slides the session to min(now + 4 h,
      // hardDeadline), and the server keeps only a slide of 15 minutes or one to hardDeadline, so
      // only such a slide is asked for. The guardian follows when its deadline moves over a minute.
      const hard = Date.parse(session.hardDeadline),
        expires = Date.parse(session.expiresAt);
      const slid = Math.min(this.clock() + 4 * 3_600_000, hard);
      if (slid - expires >= (slid === hard ? 1 : 900_000)) {
        session = view(await this.client.heartbeat(record.sessionId, this.ledger.runnerId));
        record = this.save(record.id, { session });
      }
      if (this.deadline(session) > record.deadline + 60_000)
        await this.host.extendDeadline(record.id, this.deadline(session));
      await this.reconcileCodeCommands(record, session);
    }
    return false;
  }
  private async reconcileCodeCommands(record: LaunchRecord, session?: SessionView): Promise<void> {
    const driver = this.driverOf(record);
    check(driver, 'workspace_driver_missing', 'This runner does not carry that driver');
    if (!driver.pendingCommits) return; // A lifecycle-only driver runs no Code commands.
    const workspaces = driver as Required<WorkspaceDriver>; // The contract: all four or none.
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
   * What an ended launch owes, in order: its transcript's declaration and its release, capture,
   * owed Code receipts, workspace result, closed checkout and last the transcript itself; true
   * once nothing is. One whose driver is gone waits for it.
   */
  private async settle(record: LaunchRecord): Promise<boolean> {
    // First, before the hosted reset wipes the harness's home: the conversation it wrote.
    if (record.metadata.conversation === undefined)
      record = this.save(record.id, { conversation: this.keep(record) });
    // ProcessHost proves its process group ended; the hosted boundary also removes escaped
    // descendants. Never capture a tree a previous worker can still change.
    if (this.resetAssignment && record.metadata.assignmentStopped !== true) {
      await this.resetAssignment();
      record = this.save(record.id, { assignmentStopped: true });
    }
    if (record.metadata.usageReported !== true) {
      record = await this.declare(record);
      record = await this.release(record);
    }
    const driver = this.driverOf(record);
    if (!driver) {
      this.lastError = 'workspace_driver_missing';
      return false;
    }
    const workspace = driver.get(record.id);
    if (!workspace || workspace.status === 'closed') return await this.finishAssignment(record);
    const result = await driver.capture(record);
    // Work the capture moved aside or rescued is reported, never passed over in silence.
    const notes = this.ledger.get(record.id)?.metadata.workspaceNotes;
    if (notes && typeof notes === 'object') this.lastError = Object.keys(notes)[0];
    await this.reconcileCodeCommands(
      record,
      record.metadata.session as unknown as SessionView | undefined,
    );
    // Only an attached checkout has a result to report; the session is closed by now.
    if (result && record.metadata.attached === true && record.metadata.workspaceReported !== true) {
      await this.answer(() =>
        this.client.workspaceResult(record.sessionId, this.ledger.runnerId, record.id, result),
      );
      record = this.save(record.id, { workspaceReported: true });
    }
    await driver.close(record);
    return await this.finishAssignment(record);
  }
  private async finishAssignment(record: LaunchRecord): Promise<boolean> {
    // Capture helpers touch untrusted checkout content too. Close their descendants and
    // private state before admitting the next independent agent, including after restart.
    if (this.resetAssignment && record.metadata.assignmentSettled !== true) {
      await this.resetAssignment();
      record = this.save(record.id, { assignmentSettled: true });
    }
    return await this.deliver(record);
  }
  /**
   * Before the release: what the process printed and the conversation it kept, declared (no store
   * I/O on the server) so a hosted machine is kept for them. A final refusal or a local fault
   * ends one; the release never waits on them. The log is read once; each release try declares
   * them again.
   */
  private async declare(record: LaunchRecord): Promise<LaunchRecord> {
    for (const kind of kinds)
      try {
        let t = record.metadata[kind] as Owed<TranscriptFacts | ConversationFacts> | undefined;
        // The conversation was kept when the launch settled; the log is read here, once.
        if (!t) {
          const file = this.transcript(record);
          t = file ? { state: 'owed', ...file.facts } : { state: 'none' };
          record = this.save(record.id, { transcript: t });
        }
        if (t.state === 'owed') await this.send(kind, record, factsOf(t));
      } catch (error) {
        if (error instanceof RunnerControlError && !error.final) this.lastError = error.code;
        else
          record = this.save(record.id, {
            [kind]: {
              state: 'refused',
              code: error instanceof RunnerControlError ? error.code : `${kind}_unreadable`,
            },
          });
      }
    return record;
  }
  private send(kind: Kind, record: LaunchRecord, facts: object, deliver?: true) {
    const input = { hostRef: record.id, ...facts, ...(deliver && { deliver }) };
    // Each kind's facts were read for it; their route checks them again.
    return kind === 'transcript'
      ? this.client.transcript(record.sessionId, this.ledger.runnerId, input as never)
      : this.client.conversation(record.sessionId, this.ledger.runnerId, input as never);
  }
  /**
   * Last, after everything workflow-visible: one background PUT at a time, recorded once
   * Sessions' HEAD finds the bytes. Every call is a delivery, so a lost PUT, a 412 or a restart
   * between them takes the same path. True once nothing is owed.
   */
  private async deliver(record: LaunchRecord): Promise<boolean> {
    let done = true;
    for (const kind of kinds) done = (await this.deliverOne(kind, record)) && done;
    return done;
  }
  private async deliverOne(kind: Kind, record: LaunchRecord): Promise<boolean> {
    const t = record.metadata[kind] as Owed<TranscriptFacts | ConversationFacts> | undefined;
    if (t?.state !== 'owed') return true;
    const retry = `${kind}:${record.id}`;
    if (this.uploading || this.stopping || (this.transcriptRetry.get(retry) ?? 0) > this.clock())
      return false;
    // Past the tenth PUT a delivery only confirms: stored, or abandoned.
    const tries = (t.tries ?? 0) + 1,
      spent = tries > transcriptTries;
    this.save(record.id, { [kind]: { ...t, tries } });
    try {
      const reply = await this.send(kind, record, factsOf(t), true);
      if (reply.uploadedAt) return this.delivered(kind, record.id);
      if (spent) return this.delivered(kind, record.id, `${kind}_abandoned`);
      // The declaration is write-once: a file changed or removed since cannot be delivered.
      const bytes = this.kept(kind, record);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== t.sha256)
        return this.delivered(kind, record.id, `${kind}_changed`);
      const abort = (this.uploading = new AbortController());
      // Off the tick: presence, leases and other launches go on. 128 KiB/s (~1 Mbit/s) is the
      // slowest link it waits for.
      void this.client
        .putSigned(
          reply.upload!,
          bytes,
          AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(60_000 + Math.ceil(bytes.length / 128)),
          ]),
        )
        .catch((error: unknown) => {
          this.lastError = diagnostic(error);
          this.transcriptRetry.set(retry, this.clock() + transcriptRetryMs);
        })
        .finally(() => {
          this.uploading = undefined;
        });
    } catch (error) {
      if (error instanceof RunnerControlError && error.final)
        return this.delivered(kind, record.id, error.code);
      if (spent) return this.delivered(kind, record.id, `${kind}_abandoned`);
      this.lastError = diagnostic(error);
      this.transcriptRetry.set(retry, this.clock() + transcriptRetryMs);
    }
    return false;
  }
  private transcript(record: LaunchRecord) {
    const profile = record.metadata.profile as RunnerProfile | undefined;
    return readTranscript(record.runDirectory, [this.sourceBearer], profile && harnessOf(profile));
  }
  /** The bytes a declaration named, read again: the log, or the conversation's redacted copy. */
  private kept(kind: Kind, record: LaunchRecord): Buffer | undefined {
    if (kind === 'transcript') return this.transcript(record)?.bytes;
    try {
      return readFileSync(conversationFile(record.runDirectory));
    } catch {
      return undefined;
    }
  }
  private delivered(kind: Kind, id: string, refused?: string): true {
    this.transcriptRetry.delete(`${kind}:${id}`);
    this.save(id, {
      [kind]: refused ? { state: 'refused', code: refused } : { state: 'uploaded' },
    });
    return true;
  }
  /**
   * An ended launch's conversation, where its session may be continued: redacted into its run
   * directory, then owed like its transcript. Read once, before anything resets its home.
   */
  private keep(record: LaunchRecord): Owed<ConversationFacts> {
    const profile = record.metadata.profile as RunnerProfile | undefined;
    const kept = record.metadata.session as unknown as SessionView | undefined;
    // Where the launch ran, whose copy of a conversation is its own.
    let cwd: string | undefined;
    try {
      cwd = this.driverOf(record)?.get(record.id)?.path;
    } catch {
      cwd = undefined;
    }
    try {
      // An inquiry visit's conversation is a fork never saved back: its thread resumes the one
      // it had. Its copy here is forgotten all the same.
      if (!profile || !kept?.continuity || kept.inquiry) return { state: 'none' };
      const facts = keepConversation(
        record.runDirectory,
        profile,
        [this.sourceBearer],
        process.env,
        cwd,
      );
      return facts ? { state: 'owed', ...facts } : { state: 'none' };
    } catch {
      return { state: 'refused', code: 'conversation_unreadable' };
    } finally {
      try {
        const { resumed } = record.metadata;
        if (profile)
          forgetConversations(
            record.runDirectory,
            profile,
            typeof resumed === 'string' ? resumed : undefined,
            process.env,
            kept?.inquiry ? { cwd } : undefined,
          );
      } catch (error) {
        this.lastError = diagnostic(error);
      }
    }
  }
  /**
   * Before a launch whose session continues a conversation: that conversation, fetched, checked
   * against the SHA-256 Sessions recorded and put where the harness finds it. Anything that fails
   * launches it fresh, as every launch was before, and says why.
   */
  private async restore(
    { id, runDirectory }: LaunchRecord,
    profile: RunnerProfile,
    session: Session,
    cwd: string,
  ): Promise<string | undefined> {
    const resume = session.continuity?.resume;
    if (!resume) return undefined;
    try {
      check(profile.harness === resume.harness, 'resume_other_harness', 'Kept by another harness');
      // A harness here once refused it after it was restored: this time it starts afresh.
      check(
        !this.ledger.list().some((r) => r.metadata.resumeFailed === resume.conversationId),
        'resume_failed_before',
        'This runner could not resume it before',
      );
      const bytes = await this.client.resume(session.id, this.ledger.runnerId, id, resume.size);
      check(
        createHash('sha256').update(bytes).digest('hex') === resume.sha256,
        'resume_hash_mismatch',
        'Not the conversation Sessions recorded',
      );
      restoreConversation(profile, runDirectory, cwd, resume.conversationId, bytes);
      this.save(id, { resumed: resume.conversationId });
      return resume.conversationId;
    } catch (error) {
      const code = diagnostic(error);
      this.save(id, { resumed: { unavailable: code } });
      this.lastError = 'resume_unavailable';
      process.stderr.write(`merv-runner: launch ${id} resume unavailable: ${code}\n`);
      return undefined;
    }
  }
  /** The one release: its outcome, or only its usage once closed. The reply says if attached. */
  private async release(record: LaunchRecord): Promise<LaunchRecord> {
    // A harness that would not take up the conversation restored for it failed to resume, not
    // to work: put off uncounted, and Sessions offers the work fresh. Any other end is counted.
    const { resumed, profile } = record.metadata as { resumed?: unknown; profile?: RunnerProfile };
    if (
      typeof resumed === 'string' &&
      profile &&
      record.metadata.releaseOutcome === undefined &&
      record.metadata.remoteClosed !== true &&
      !this.stopping &&
      record.metadata.runnerStopped !== true &&
      refusedResume(profile, record.runDirectory)
    )
      record = this.save(record.id, {
        releaseOutcome: 'preparation_deferred',
        deferral: { cause: 'resume_failed', code: 'resume_failed' },
        resumeFailed: resumed,
      });
    const { metadata } = record,
      remote = metadata.remoteClosed === true,
      usage = this.readUsage(record);
    // A stop the user made on their own machine is nobody's failure; an ending that merely
    // raced it still counts. Hosted stops and source-refusal halts stay counted: `released`
    // has no backoff, so a repeated eviction or a poison 401 would re-offer the work at once.
    const byStop =
      !this.managed() &&
      (this.stopping || metadata.runnerStopped === true) &&
      ['controller_stop', 'external_stop', 'cancelled_before_spawn'].includes(record.reason ?? '');
    // A successful process exit does not prove that its workflow gate was completed.
    const failed = this.clock() - record.createdAt < 10_000 ? 'crash_loop' : 'host_failed';
    const outcome =
      (metadata.releaseOutcome as SessionReleaseOutcome | undefined) ??
      (byStop ? undefined : failed);
    let session: Session | undefined;
    // A managed runner acknowledges its local stop even when a handoff left no usage.
    if (!remote || usage || this.managed()) {
      const input = remote
        ? { usage }
        : {
            outcome,
            reason:
              typeof metadata.releaseReason === 'string'
                ? metadata.releaseReason
                : terminalReason(record),
            usage,
            deferral: deferralOf(record),
          };
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
  /**
   * Starts each launched agent's stream and moves every stream on by one batch, off the tick.
   * A stream outlives its launch's settling until it has sent the log's end.
   */
  private follow(settled: string[]): void {
    if (this.stopping) return;
    const ended = settled.flatMap((id) => this.ledger.get(id) ?? []);
    for (const record of [...this.ledger.open(), ...ended]) {
      const profile = record.metadata.profile as RunnerProfile | undefined;
      if (
        this.streams.has(record.id) ||
        !profile ||
        !harnessOf(profile) ||
        record.status === 'reserved' ||
        record.status === 'starting'
      )
        continue;
      this.streams.set(
        record.id,
        new AgentStream(
          record.runDirectory,
          profile.harness as HarnessName,
          [this.sourceBearer],
          (batch) => this.client.stream(record.sessionId, this.ledger.runnerId, record.id, batch),
          this.clock,
        ),
      );
    }
    for (const record of [...this.ledger.open(), ...ended])
      if (terminalLaunch(record)) this.streams.get(record.id)?.end();
    for (const [id, stream] of this.streams)
      if (stream.finished) this.streams.delete(id);
      else stream.tick();
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
   * its last `tailBytes` (1 MiB), from the first whole line, however long the log grew.
   */
  private readUsage(record: LaunchRecord, tailBytes = 1 << 20): SessionUsageReport | undefined {
    const read = (path: string, limit: number, tail = false) => {
      // Never a link, and never a wait on a FIFO swapped in before the open.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (!tail && stat.size > limit))
          throw new Error('Not a readable report');
        const bytes = Buffer.alloc(Math.min(stat.size, limit));
        readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
        const text = bytes.toString('utf8');
        return bytes.length < stat.size ? text.slice(text.indexOf('\n') + 1) : text;
      } finally {
        closeSync(fd);
      }
    };
    try {
      return sessionUsageReportSchema.parse(JSON.parse(read(usageFile(record), 4096)));
    } catch {
      // No report of its own; the harness may have printed one.
    }
    try {
      const log = read(join(record.runDirectory, 'stdout.log'), tailBytes, true);
      const profile = record.metadata.profile as RunnerProfile;
      const model = 'model' in profile ? profile.model : undefined;
      return sessionUsageReportSchema.parse(harnessOf(profile)?.usage(log, model));
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
        ...(session?.threadId ? { threadId: session.threadId } : {}),
        status: r.status,
        platform: String(r.metadata.platform ?? ''),
        deadline: r.deadline,
        exitCode: r.exitCode,
        releasePending: terminalLaunch(r) && r.metadata.usageReported !== true,
        // The conversation is owed as the transcript is: a hosted machine waits for both.
        transcriptPending:
          terminalLaunch(r) &&
          kinds.some((kind) => (r.metadata[kind] as Transcript | undefined)?.state === 'owed'),
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
      if (!this.managed())
        for (const record of this.ledger.open())
          if (record.metadata.usageReported !== true) this.save(record.id, { runnerStopped: true });
      await this.current;
      this.uploading?.abort(); // the next start delivers it
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
