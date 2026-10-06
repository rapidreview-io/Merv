import { configureWorkRepository, projectCheck } from './check-configuration.js';
import type { CodeGitHubService, GitHubBinding } from '@merv/code/github';
import { parseCodeInput } from '@merv/code/input';
import { declareManagedProject } from '@merv/code/store/managed';
import type { CodeService as CodeUtility } from '@merv/code/service';
import {
  CodeMirrorService,
  enqueueMirror,
  GitMirrorTransport,
  type CodeMirrorConfig,
  type MirrorAuthority,
  type MirrorTransport,
} from '@merv/code/store/mirror';
import {
  CodeStore,
  type CodeImportRemote,
  type CodeStoreConfig,
  type FaultPoint,
} from '@merv/code/store/operations';
import type {
  Caller,
  CodeAcceptedSince,
  CodeRepositoryPrepareInput,
  CodeStoreOperation,
  Scope,
  State,
  StoredEvent,
  Transaction,
  Workflows,
} from '@merv/contracts';
import {
  check,
  codeCommandCompletionSchema,
  createService,
  digest,
  MervError,
  now,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { CodeBaseService } from './bases.js';
import { checkedCapture, CodeCaptureReader } from './captures.js';
import { CodeCommandService } from './commands.js';
import { CodeWorkspaceProtocol } from './protocol.js';
import { PublicationHost } from './publication-host.js';
import { CodePublicationService } from './publications.js';
import { migrateRepositorySync, reconcileRepository } from './repository-sync.js';
import { prepareRepository, repositoryPrepareSchema } from './repository-setup.js';
import { CodeRunningReader } from './running.js';
import type {
  CheckedCodeCapture,
  Code,
  CodeCaptureOrigin,
  CodeCaptureRef,
  ResolutionWorkCreator,
} from './types.js';
import { CodeUnitService } from './units.js';
import { CODE_DRIVER } from './workspace.js';
import type { CodeWriterService } from '@merv/code/writers';

/** How many times verification imports one merge commit before an operator imports it. */
const PUBLICATION_IMPORT_ATTEMPTS = 3;

/** Work-unit operations over the repositories owned by the core Code service. */
export interface CodeStoreOptions {
  config?: Partial<Omit<CodeStoreConfig, 'root'>>;
  /** Replaces the linked GitHub repository as the place an import reads from. */
  remote?: CodeImportRemote;
  fault?: (point: FaultPoint) => void;
  /** Replaces the linked GitHub repository as the place work is published to. */
  mirror?: MirrorTransport;
  mirrorConfig?: Partial<CodeMirrorConfig>;
  /** Merge several accepted commits into one base on the server. On unless disabled. */
  autoMerge?: boolean;
}

/**
 * Refusals at a lease that only mean "not yet": a base still pending, contested, merging or
 * needing an operator, or a last writer still handing over what it left. Each is published
 * where blocked work is shown and says nothing against the work, so it is marked a wait.
 */
const waits = new Set([
  'code_base_pending',
  'code_merge_required',
  'code_base_wait',
  'code_base_admission',
  'code_merge_conflict',
  'code_base_blocked',
  'code_quarantined',
  'code_dependencies_changed',
  'code_writer_busy',
  'code_recovery_required',
  'code_capture_quarantined',
]);
/** Rethrows a refusal, marked as a wait when it is one of those. */
function refuse(error: unknown): never {
  if (error instanceof MervError && waits.has(error.code)) error.wait = true;
  throw error;
}

export class CodeService extends CodeCommandService implements Code {
  private captureReader!: CodeCaptureReader;
  private unitStore!: CodeUnitService;
  private readonly writerStore: CodeWriterService;
  private store?: CodeStore;
  private mirrorStore?: CodeMirrorService;
  private baseStore?: CodeBaseService;
  private protocol?: CodeWorkspaceProtocol;
  readonly github: CodeGitHubService;
  private publicationStore: CodePublicationService;
  private publicationHost: PublicationHost;
  private readonly board: CodeRunningReader;
  private publicationClosed = false;
  private publicationTimer?: NodeJS.Timeout;
  private networkOperations = new Set<Promise<unknown>>();
  private network<T>(operation: () => Promise<T>): Promise<T> {
    if (this.publicationClosed)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const pending = operation();
    this.networkOperations.add(pending);
    void pending.then(
      () => this.networkOperations.delete(pending),
      () => this.networkOperations.delete(pending),
    );
    return pending;
  }
  constructor(
    state: State,
    scope: Scope,
    sessions: Sessions,
    private readonly workflows: Workflows,
    private readonly utility: Pick<CodeUtility, 'github' | 'writers' | 'repositories' | 'units'>,
    private readonly repositories: CodeStoreOptions = {},
  ) {
    super(state, scope, sessions);
    this.github = utility.github;
    this.writerStore = utility.writers;
    this.publicationHost = new PublicationHost(
      state,
      scope,
      () => this.requireStore().repositories,
      () =>
        repositories.mirror ??
        new GitMirrorTransport(this.requireStore().repositories, this.published()),
      async (caller, ref, oid) => {
        const store = this.requireStore();
        if (await store.contains(caller.projectId, oid)) return;
        // A failed import is final under its request id, so each call past one starts the next
        // attempt. Code's operation journal holds every attempt, and so the bound.
        const started = now();
        let operation: CodeStoreOperation | undefined;
        for (let attempt = 1; attempt <= PUBLICATION_IMPORT_ATTEMPTS; attempt++) {
          operation = await store.importRepository(caller, {
            source: 'github',
            ref,
            requestId: `publication-import:${oid}${attempt > 1 ? `:${attempt}` : ''}`,
          });
          if (operation.status !== 'failed' || operation.createdAt >= started) break;
        }
        check(
          operation!.status !== 'failed' || operation!.createdAt >= started,
          'code_publication_import_failed',
          `Importing the merge commit failed ${PUBLICATION_IMPORT_ATTEMPTS} times; read code.status and import ${ref} with code-import`,
          409,
        );
        check(
          operation!.status === 'completed' && (await store.contains(caller.projectId, oid)),
          'code_publication_import_pending',
          'The publication commit must finish Code admission before verification; retry this same request',
          409,
        );
      },
      (caller, tx) => this.github.publicationBinding(caller, tx),
      this.writerStore,
      (caller, oid, tx, expectedOid) => this.unitStore.moveMain(caller, oid, tx, expectedOid),
      (projectId, tx) => this.unitStore.imported(tx, projectId),
    );
    this.publicationStore = new CodePublicationService(
      state,
      scope,
      this.github,
      this.publicationHost,
    );
    this.board = new CodeRunningReader(state, scope, workflows, {
      unit: (caller, unitId, tx) => this.unitStore.unit(caller, unitId, tx),
      bases: () => this.baseStore,
      receipt: (sql, projectId, instanceId) => this.newestReceipt(sql, projectId, instanceId),
    });
  }
  override async initialize(): Promise<void> {
    await super.initialize();
    const { state, scope, sessions, utility, repositories } = this;
    this.captureReader = new CodeCaptureReader(state, scope, sessions, this.writerStore);
    try {
      this.unitStore = await createService(
        new CodeUnitService(
          state,
          scope,
          this.workflows,
          this,
          this.writerStore,
          utility.units,
          sessions,
        ),
      );
      this.unitStore.publications = this.publicationStore;
      if (utility.repositories) {
        // Published only once it holds the writer lock and has finished what a crash left.
        const store = new CodeStore(
          state,
          scope,
          { ...utility.repositories.config, ...repositories.config },
          {
            imported: (tx, projectId) => this.unitStore.imported(tx, projectId),
            workspaces: (projectId, tx) => sessions.holdingWorkspace(projectId, CODE_DRIVER, tx),
            fenced: (tx, fence, kind) => this.writerStore.fenced(tx, fence, kind),
            advanced: (tx, fence, input) => this.writerStore.advanced(tx, fence, input),
            quarantined: (tx, fence, id) => this.writerStore.quarantined(tx, fence, id),
            maintained: () => this.writerStore.expire(),
          },
          utility.repositories,
          repositories.remote ?? this.linkedRepository(),
          repositories.fault,
        );
        await store.initialize();
        this.store = store;
        this.protocol = new CodeWorkspaceProtocol(state, sessions, this.writerStore, store);
        this.mirrorStore = new CodeMirrorService(
          state,
          scope,
          store.repositories,
          repositories.mirror ?? new GitMirrorTransport(store.repositories, this.published()),
          repositories.mirrorConfig,
        );
        const bases = new CodeBaseService(
          state,
          store.repositories,
          {
            changed: (tx, projectId) => this.unitStore.imported(tx, projectId),
            sponsors: (tx, projectId, members) =>
              this.unitStore.baseSponsors(tx, projectId, members),
            serviceWork: sessions.serviceWork,
            resolved: async (tx, projectId, key, commit) => {
              await this.unitStore.retainBaseResult(tx, projectId, key, commit);
              await enqueueMirror(tx, projectId, 'mirror-base', key, commit);
            },
          },
          repositories.autoMerge !== false,
        );
        await bases.initialize();
        this.unitStore.bases = bases;
        this.baseStore = bases;
        bases.start();
      }
      // The mirror reads the project's GitHub link, so it only starts looking for refs to
      // publish once that store exists.
      this.mirrorStore?.initialize();
      await this.publicationStore.initialize();
      await migrateRepositorySync(state);
      // The first pass waits a period, so Reviews, which every publication checks, is bound;
      // a tick while a pass runs starts nothing, and closing stops the pass.
      let pass: Promise<unknown> | undefined;
      this.publicationTimer = setInterval(() => {
        pass ??= this.network(() => this.publicationStore.syncDue(() => this.publicationClosed))
          .catch(() => undefined)
          .finally(() => (pass = undefined));
      }, 30_000);
      this.publicationTimer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  capture: Code['capture'] = (...args) => this.captureReader.capture(...args);
  async checkCapture(
    caller: Caller,
    ref: CodeCaptureRef,
    origin: CodeCaptureOrigin,
    tx?: Transaction,
  ): Promise<CheckedCodeCapture> {
    return checkedCapture(await this.capture(caller, ref, tx), caller.projectId, origin);
  }
  override async completeCommand(caller: Caller, value: unknown) {
    caller = structuredClone(caller);
    const input = parseCodeInput(codeCommandCompletionSchema, value);
    const complete = async (tx: Transaction) => {
      const command = await tx.get<{ command_json: string; status: string }>(
        'SELECT command_json,status FROM code_commands WHERE id=? AND project_id=?',
        input.commandId,
        caller.projectId,
      );
      // Replay still checks controller ownership and the exact retained receipt.
      if (command?.status === 'succeeded') return super.completeCommand(caller, input);
      const binding = command
        ? (JSON.parse(command.command_json) as { projectId: string; instanceId: string })
        : null;
      const writer =
        binding && (await this.writerStore.row(tx, binding.projectId, binding.instanceId));
      // Only Code's own repository admits a commit now; nothing verifies one on GitHub.
      check(
        !(
          (!writer || Number(writer.generation) === 0) &&
          'receipt' in input &&
          input.receipt?.repositoryId.startsWith('github:')
        ),
        'code_upload_required',
        'A commit to a GitHub repository succeeds only once Code admitted it',
        409,
      );
      if (binding) await this.writerStore.requireAdmitted(input, binding, tx);
      return super.completeCommand(caller, input);
    };
    const tx = this.state.ambient;
    return tx ? complete(tx) : this.state.transaction(complete);
  }
  controlPublication: Code['controlPublication'] = (...args) =>
    this.publicationHost.control(...args);
  publications: Code['publications'] = (caller) => this.publicationStore.publications(caller);
  syncPublications: Code['syncPublications'] = (caller) =>
    this.network(() => this.publicationStore.syncPublications(caller));
  publicationDetails: Code['publicationDetails'] = (...args) =>
    this.network(() => this.publicationStore.publicationDetails(...args));
  mergePublication: Code['mergePublication'] = (...args) =>
    this.network(() => this.publicationStore.mergePublication(...args));
  bindReviews(reviews: import('@merv/contracts').Reviews): () => void {
    this.unitStore.reviews = reviews;
    const releasePublication = this.publicationHost.bindReviews(reviews);
    const release = reviews
      .provenance('code')
      .register((projectId, subjectId, tx) =>
        this.unitStore.reviewProvenance(projectId, subjectId, tx),
      );
    return () => {
      release();
      releasePublication();
      if (this.unitStore.reviews === reviews) this.unitStore.reviews = undefined;
    };
  }
  /**
   * The adapter that runs a project check. A deployment with no repository root keeps no
   * bases, so there is nothing to check and nothing to unbind.
   */
  bindChecks(sandboxes: import('@merv/sandboxes/types').Sandboxes): () => void {
    const bases = this.baseStore;
    if (!bases) return () => {};
    bases.checks = sandboxes.checks;
    return () => {
      if (bases.checks === sandboxes.checks) bases.checks = undefined;
    };
  }
  bindServiceTasks(provider: ResolutionWorkCreator): () => void {
    this.unitStore.resolutionTasks = provider;
    // The startup pass did everything else; only a conflict needs the provider it lacked.
    void this.unitStore.reconcileAll(true).catch(() => undefined);
    return () => {
      if (this.unitStore.resolutionTasks === provider) this.unitStore.resolutionTasks = undefined;
    };
  }

  declareUnit: Code['declareUnit'] = (...args) => this.unitStore.declareUnit(...args);
  acceptUnit: Code['acceptUnit'] = (...args) => this.unitStore.acceptUnit(...args);
  publishOnAcceptance: Code['publishOnAcceptance'] = (...args) =>
    this.unitStore.publishOnAcceptance(...args);
  /**
   * The accepted units whose code the project's main does not contain yet. It takes no
   * transaction, because the house rule is that Git never runs inside one: the candidates are
   * read on their own and Git is asked afterwards. `rev-list` of every accepted commit
   * `--not main` walks only the history beyond main, so the reading costs what is actually
   * unpublished rather than the project's whole past.
   */
  async acceptedSince(caller: Caller): Promise<CodeAcceptedSince> {
    caller = structuredClone(caller);
    const { main, candidates } = await this.unitStore.acceptedCandidates(caller);
    const repositories = this.requireStore().repositories;
    const commits = [...new Set(candidates.map((item) => item.commit))];
    const beyond = new Set<string>();
    if (commits.length) {
      const walk = await repositories.git.run(['rev-list', ...commits, '--not', main], {
        env: repositories.environment(caller.projectId),
      });
      check(
        walk.code === 0,
        'code_candidate_unavailable',
        'Code must hold main and every accepted commit; import the missing history',
        409,
      );
      for (const line of walk.stdout.toString('utf8').split('\n'))
        if (line) beyond.add(line.trim());
    }
    const missing = (quarantined: boolean) =>
      candidates
        .filter((item) => beyond.has(item.commit) && !!item.quarantined === quarantined)
        .map((item) => item.unitId)
        .sort();
    const [unitIds, quarantined] = [missing(false), missing(true)];
    return {
      unitIds,
      quarantined,
      main,
      hash: digest({ formatVersion: 1, main, unitIds, quarantined }),
    };
  }
  baseStatus: Code['baseStatus'] = (...args) => this.unitStore.baseStatus(...args);
  pinBase: Code['pinBase'] = (...args) => this.unitStore.pinBase(...args).catch(refuse);
  basePin: Code['basePin'] = (...args) => this.unitStore.basePin(...args);
  /** Plugin wiring, not part of the Code contract: no other plugin reconciles Code's view. */
  reconcileAll = () => this.unitStore.reconcileAll();
  async transitioned(...args: Parameters<CodeUnitService['transitioned']>) {
    await this.unitStore.transitioned(...args);
    // An acceptance journals the ref it is kept under; the journal takes it up after this.
    this.store?.wake();
  }
  /** One maintenance pass now, as the timer would make it. */
  maintainStore = async () => void (await this.store?.maintain());
  /** One publication pass now, as the timer would make it. */
  mirrorStep = async () => void (await this.mirrorStore?.run());
  async controlBase(caller: Caller, input: unknown) {
    check(this.baseStore, 'code_unavailable', 'Hosted bases are unavailable', 503);
    return this.baseStore.control(this.scope, caller, input);
  }
  async retryMirror(caller: Caller, input: unknown) {
    this.requireStore();
    return await this.mirrorStore!.retry(caller, input);
  }
  async sessionChanged(event: StoredEvent, tx: Transaction) {
    check(!this.publicationClosed, 'code_unavailable', 'Code is unavailable', 503);
    if (event.type === 'session.workspace_attached' || event.type === 'session.closed')
      await this.writerStore.sessionChanged(
        event.projectId,
        event.subjectId,
        event.type === 'session.workspace_attached' ? 'attached' : 'closed',
        tx,
      );
  }
  async reserveWriter(...args: Parameters<CodeWriterService['reserveWriter']>) {
    check(!this.publicationClosed, 'code_unavailable', 'Code is unavailable', 503);
    return await this.writerStore.reserveWriter(...args).catch(refuse);
  }
  async writerStatus(...args: Parameters<CodeWriterService['writerStatus']>) {
    check(!this.publicationClosed, 'code_unavailable', 'Code is unavailable', 503);
    return await this.writerStore.writerStatus(...args);
  }
  async requireLeasable(
    caller: Caller,
    input: { unitId: string; writer: boolean },
    tx: Transaction,
  ): Promise<void> {
    await this.scope.require(caller, 'read', tx);
    // A board's guidance asks this of each unit more than once; one snapshot answers once.
    const blocked = await this.state.remember(
      `code-work:leasable:${caller.projectId}:${input.unitId}:${input.writer}`,
      async () => {
        const base = await this.baseStatus(caller, input.unitId, tx);
        if (base.status === 'blocked') return base.blockers[0]!;
        return input.writer ? (await this.writerStatus(caller, input.unitId, tx)).blocked : null;
      },
    );
    if (blocked) refuse(new MervError(blocked.code, blocked.message, 409));
  }
  /** Every admitted upload of the unit is first given the chance to finish; then the fence. */
  async fenceUnit(caller: Caller, input: unknown) {
    const store = this.requireStore();
    caller = structuredClone(caller);
    await store.maintain(false);
    const status = await this.state.transaction(async (tx) => {
      check(!this.publicationClosed, 'code_unavailable', 'Code is unavailable', 503);
      return await this.writerStore.fence(caller, input, tx);
    });
    // What the fenced generation had only begun to send is kept where no route serves it.
    await store.maintain();
    return status;
  }
  async bindLocal(
    caller: Caller,
    input: Parameters<CodeUnitService['bindLocal']>[1],
    binding?: GitHubBinding,
  ) {
    // Whether Code's repository holds the named commit is asked of Git before the transaction.
    const named = (input as { mainOid?: unknown } | null)?.mainOid;
    const stored =
      !!this.store &&
      typeof named === 'string' &&
      /^[0-9a-f]{40,64}$/.test(named) &&
      (await this.store.contains(caller.projectId, named));
    if (!binding) return await this.unitStore.bindLocal(caller, input, stored);
    return await this.state.transaction(async (tx) => {
      await this.github.assertBinding(caller, binding, tx, 'read');
      return await this.unitStore.bindLocal(caller, input, stored, tx);
    });
  }
  /** The Running page's reads, each on the page's snapshot (running.ts). */
  runningHolds: Code['runningHolds'] = (caller) => this.board.holds(caller);
  runningChecks: Code['runningChecks'] = (caller) => this.board.checks(caller);
  runningPanel: Code['runningPanel'] = (caller, key) => this.board.panel(caller, key);
  runningCode: Code['runningCode'] = (caller, keys) => this.board.sections(caller, keys);
  hosted: Code['hosted'] = (...args) => this.unitStore.hosted(...args);
  async ensureRepository(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    if (await this.unitStore.hosted(caller, tx)) return;
    const store = this.requireStore();
    await declareManagedProject(tx, caller.projectId);
    store.wake();
  }
  async projectCreated(projectId: string, tx: Transaction): Promise<void> {
    if (!this.store) return;
    await declareManagedProject(tx, projectId);
    this.store.wake();
  }
  unit: Code['unit'] = (...args) => this.unitStore.unit(...args);
  async status(caller: Caller) {
    const status = await this.unitStore.status(caller);
    const publication =
      status.project?.durability === 'code'
        ? {
            publication: {
              controls: await this.publicationHost.status(caller),
              records: await this.publicationStore.publications(caller),
            },
          }
        : {};
    if (!this.store) return { ...status, ...publication };
    const technical = await this.store.describe(caller.projectId);
    const configuredCheck = await this.state.read((sql) => projectCheck(sql, caller.projectId));
    return {
      ...status,
      ...publication,
      bases: await this.state.read(
        (sql) => this.baseStore?.records(sql, caller.projectId) ?? Promise.resolve([]),
      ),
      ...technical,
      store: { ...technical.store, limits: { ...technical.store.limits, check: configuredCheck } },
      mirror: (await this.mirrorStore?.describe(caller.projectId)) ?? null,
    };
  }
  private requireStore(): CodeStore {
    if (!this.store)
      throw new MervError('code_store_unavailable', 'This server keeps no Code repositories', 503);
    return this.store;
  }
  importRepository = async (caller: Caller, input: unknown) =>
    this.requireStore().importRepository(caller, input);
  async prepareRepository(caller: Caller, value: CodeRepositoryPrepareInput) {
    caller = structuredClone(caller);
    const input = parseCodeInput(repositoryPrepareSchema, value);
    await this.state.transaction((tx) => this.ensureRepository(caller, tx));
    await this.requireStore().maintain(false);
    return prepareRepository(this, caller, input, (operation) =>
      reconcileRepository(
        this.state,
        this.requireStore().repositories,
        this.github,
        this.unitStore,
        caller,
        input,
        operation,
      ),
    );
  }
  /** The binding and hosting a preparation compares; status() reads far more than these. */
  async repositoryState(caller: Caller) {
    const store = this.requireStore();
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const project = await this.unitStore.project(tx, caller.projectId);
      return { project, store: { hosted: !!(await store.stored(tx, caller.projectId)) } };
    });
  }
  rebindRepository = async (caller: Caller, input: unknown) =>
    this.requireStore().rebindRepository(caller, input);
  configureRepository = async (caller: Caller, input: unknown) =>
    configureWorkRepository(this.state, this.scope, this.requireStore(), caller, input);
  /**
   * The second workspace protocol as the API forwards it: opaque bodies and bundle bytes.
   * Absent when this server keeps no repositories, which the API answers as unavailable.
   */
  get v2() {
    return this.publicationClosed ? undefined : this.protocol;
  }
  /**
   * What the server publishes a project's work to, with no caller: the owner's link and the
   * write automation they turned on are the authorisation, and unlinking is the off switch.
   */
  private published(): MirrorAuthority {
    return {
      target: (projectId) => this.github.mirrorTarget(projectId),
      token: (projectId, use) => this.network(() => this.github.mirrorToken(projectId, use)),
    };
  }
  /** An import reads GitHub as the administrator who asked, with a token that ends with the call. */
  private linkedRepository(): CodeImportRemote {
    return {
      read: (caller, use, expected) =>
        this.network(() => this.github.importRemote.read(caller, use, expected)),
    };
  }
  override async close(): Promise<void> {
    this.publicationClosed = true;
    clearInterval(this.publicationTimer);
    // Stop scheduling immediately, then join the whole pass, including its final journal write.
    const mirroring = this.mirrorStore?.close();
    // No new merge starts from here; one that is running is waited for below, because every
    // read must be refused before this method first yields.
    const merging = this.baseStore?.close();
    this.captureReader?.close();
    this.unitStore?.close();
    super.close();
    // Every read is refused from here on. Running admissions and GitHub calls still reach the
    // database, which outlives Code, and are waited for before the writer lock is given up.
    await Promise.all([merging, mirroring, Promise.allSettled([...this.networkOperations])]);
    await this.store?.close();
  }
}
