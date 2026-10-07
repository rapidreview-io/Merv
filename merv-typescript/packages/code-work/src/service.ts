import { configureWorkRepository, projectCheck } from './check-configuration.js';
import type { CodeGitHubService, GitHubBinding } from '@merv/code/github';
import { parseCodeInput } from '@merv/code/input';
import type { CodeService as CodeUtility, CodeStoreOptions } from '@merv/code/service';
import {
  enqueueMirror,
  type CodeMirrorService,
  type MirrorTransport,
} from '@merv/code/store/mirror';
import type { CodeStore } from '@merv/code/store/operations';
import type { Caller, Reviews, Scope, State, Transaction, Workflows } from '@merv/contracts';
import type { CodeStoreOperation } from '@merv/code/store/protocol';
import type { CodeRepositoryPrepareInput } from './models.js';
import {
  check,
  CODE_DRIVER,
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
import type { CodeWriterService } from '@merv/code/writers';
import type { CodeAcceptedSince } from './models.js';

/** How many times verification imports one merge commit before an operator imports it. */
const PUBLICATION_IMPORT_ATTEMPTS = 3;

export type { CodeStoreOptions };

/**
 * Refusals at a lease that only mean "not yet": a base still pending, contested, merging or
 * needing an operator, or a last writer still handing over what it left. Each is published
 * where blocked work is shown and says nothing against the work, so it is marked a wait.
 */
const waits = new Set([
  'code_base_pending',
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

export class CodeService implements Code {
  /** The durable runner commands; this service adds Code's admission to their completion. */
  private readonly commands: CodeCommandService;
  private captureReader!: CodeCaptureReader;
  private unitStore!: CodeUnitService;
  private readonly writerStore: CodeWriterService;
  // Set by initialize(); close() also runs after an initialization that failed half-way.
  private store!: CodeStore;
  private mirrorStore!: CodeMirrorService;
  private transport!: MirrorTransport;
  private baseStore!: CodeBaseService;
  private protocol!: CodeWorkspaceProtocol;
  readonly github: CodeGitHubService;
  private publicationStore: CodePublicationService;
  private publicationHost: PublicationHost;
  private readonly board: CodeRunningReader;
  private publicationClosed = false;
  private releaseProvenance?: () => void;
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
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
    private readonly workflows: Workflows,
    private readonly reviews: Reviews,
    private readonly utility: Pick<
      CodeUtility,
      'github' | 'writers' | 'units' | 'openStore' | 'declareManaged' | 'repositories'
    >,
    private readonly repositories: CodeStoreOptions = {},
  ) {
    this.commands = new CodeCommandService(state, scope, sessions);
    this.github = utility.github;
    this.writerStore = utility.writers;
    this.publicationHost = new PublicationHost(
      state,
      scope,
      reviews,
      utility.repositories,
      () => this.transport,
      async (caller, ref, oid) => {
        const store = this.store;
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
      (caller, oid, tx, expectedOid) =>
        this.unitStore.records.moveMain(caller, oid, tx, expectedOid),
      (projectId, tx) => this.unitStore.imported(tx, projectId),
    );
    this.publicationStore = new CodePublicationService(
      state,
      scope,
      this.github,
      utility.units,
      this.publicationHost,
    );
    this.board = new CodeRunningReader(state, scope, workflows, {
      unit: (caller, unitId, tx) => this.unitStore.records.unit(caller, unitId, tx),
      bases: () => this.baseStore,
      receipt: (sql, projectId, instanceId) =>
        this.commands.newestReceipt(sql, projectId, instanceId),
    });
  }
  async initialize(): Promise<void> {
    await this.commands.initialize();
    const { state, scope, sessions, utility, repositories } = this;
    this.captureReader = new CodeCaptureReader(
      state,
      scope,
      sessions,
      this.writerStore,
      async (projectId, base, head) => await this.store.stats(projectId, base, head),
    );
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
          this.reviews,
        ),
      );
      // Reviews asks Code who contributed to a resolution before it lets anyone review it.
      this.releaseProvenance = this.reviews
        .provenance('code')
        .register((projectId, subjectId, tx) =>
          this.unitStore.reviewProvenance(projectId, subjectId, tx),
        );
      this.unitStore.publications = this.publicationStore;
      // Bases come first: what the store's start finishes may derive units, which merge.
      const bases = new CodeBaseService(state, utility.repositories, {
        changed: (tx, projectId) => this.unitStore.imported(tx, projectId),
        sponsors: (tx, projectId, members) => this.unitStore.baseSponsors(tx, projectId, members),
        serviceWork: sessions.serviceWork,
        resolved: async (tx, projectId, key, commit) => {
          await this.unitStore.records.retainBaseResult(tx, projectId, key, commit);
          await enqueueMirror(tx, projectId, 'mirror-base', key, commit);
        },
      });
      await bases.initialize();
      this.unitStore.bases = bases;
      this.baseStore = bases;
      const opened = await utility.openStore(
        {
          imported: (tx, projectId) => this.unitStore.imported(tx, projectId),
          workspaces: (projectId, tx) => sessions.holdingWorkspace(projectId, CODE_DRIVER, tx),
          network: (operation) => this.network(operation),
        },
        repositories,
      );
      this.store = opened.store;
      this.mirrorStore = opened.mirror;
      this.transport = opened.transport;
      this.protocol = new CodeWorkspaceProtocol(state, sessions, this.writerStore, opened.store);
      bases.start();
      await this.publicationStore.initialize();
      await migrateRepositorySync(state);
      // A tick while a pass runs starts nothing, and closing stops the pass.
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
  captures: Code['captures'] = (...args) => this.captureReader.captures(...args);
  async checkCapture(
    caller: Caller,
    ref: CodeCaptureRef,
    origin: CodeCaptureOrigin,
    tx?: Transaction,
  ): Promise<CheckedCodeCapture> {
    return checkedCapture(await this.capture(caller, ref, tx), caller.projectId, origin);
  }
  list: Code['list'] = (...args) => this.commands.list(...args);
  operation: Code['operation'] = (...args) => this.commands.operation(...args);
  commit: Code['commit'] = (...args) => this.commands.commit(...args);
  merge: Code['merge'] = (...args) => this.commands.merge(...args);
  nextCommand: Code['nextCommand'] = (...args) => this.commands.nextCommand(...args);
  async completeCommand(caller: Caller, value: unknown) {
    caller = structuredClone(caller);
    const input = parseCodeInput(codeCommandCompletionSchema, value);
    const complete = async (tx: Transaction) => {
      const command = await tx.get<{ command_json: string; status: string }>(
        'SELECT command_json,status FROM code_commands WHERE id=? AND project_id=?',
        input.commandId,
        caller.projectId,
      );
      // Replay still checks controller ownership and the exact retained receipt.
      if (command?.status === 'succeeded') return this.commands.completeCommand(caller, input);
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
      return this.commands.completeCommand(caller, input);
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
  /** The adapter that runs a project check. */
  bindChecks(sandboxes: import('@merv/sandboxes/types').Sandboxes): () => void {
    const bases = this.baseStore;
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
    const { main, candidates } = await this.unitStore.records.acceptedCandidates(caller);
    const repositories = this.utility.repositories;
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
  async pinBase(...[caller, input, tx]: Parameters<Code['pinBase']>) {
    const pin = await this.unitStore.pinBase(caller, input, tx).catch(refuse);
    // A writable checkout's lease becomes the unit's next writer generation in Code.
    if (input.writer) await this.writerStore.reserveWriter(caller, input, tx).catch(refuse);
    return pin;
  }
  basePin: Code['basePin'] = (...args) => this.unitStore.records.basePin(...args);
  /** Plugin wiring, not part of the Code contract: no other plugin reconciles Code's view. */
  reconcileAll = () => this.unitStore.reconcileAll();
  async transitioned(...args: Parameters<CodeUnitService['transitioned']>) {
    await this.unitStore.transitioned(...args);
    // An acceptance journals the ref it is kept under; the journal takes it up after this.
    this.store.wake();
  }
  /** One maintenance pass now, as the timer would make it. */
  maintainStore = async () => void (await this.store.maintain());
  /** One publication pass now, as the timer would make it. */
  mirrorStep = async () => void (await this.mirrorStore.run());
  async controlBase(caller: Caller, input: unknown) {
    return this.baseStore.control(this.scope, caller, input);
  }
  async retryMirror(caller: Caller, input: unknown) {
    return await this.mirrorStore.retry(caller, input);
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
        return input.writer
          ? (await this.writerStore.writerStatus(caller, input.unitId, tx)).blocked
          : null;
      },
    );
    if (blocked) refuse(new MervError(blocked.code, blocked.message, 409));
  }
  /** Every admitted upload of the unit is first given the chance to finish; then the fence. */
  async fenceUnit(caller: Caller, input: unknown) {
    const store = this.store;
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
    input: Parameters<CodeUtility['units']['bindLocal']>[1],
    binding?: GitHubBinding,
  ) {
    // Whether Code's repository holds the named commit is asked of Git before the transaction.
    const named = (input as { mainOid?: unknown } | null)?.mainOid;
    const stored =
      typeof named === 'string' &&
      /^[0-9a-f]{40,64}$/.test(named) &&
      (await this.store.contains(caller.projectId, named));
    if (!binding) return await this.utility.units.bindLocal(caller, input, stored);
    return await this.state.transaction(async (tx) => {
      await this.github.assertBinding(caller, binding, tx, 'read');
      return await this.utility.units.bindLocal(caller, input, stored, tx);
    });
  }
  /** The Running page's reads, each on the page's snapshot (running.ts). */
  runningHolds: Code['runningHolds'] = (caller) => this.board.holds(caller);
  runningChecks: Code['runningChecks'] = (caller) => this.board.checks(caller);
  runningPanel: Code['runningPanel'] = (caller, key) => this.board.panel(caller, key);
  runningCode: Code['runningCode'] = (caller, keys) => this.board.sections(caller, keys);
  hosted: Code['hosted'] = (...args) => this.utility.units.hosted(...args);
  async ensureRepository(caller: Caller, tx: Transaction): Promise<void> {
    await this.scope.require(caller, 'write', tx);
    if (await this.utility.units.hosted(caller, tx)) return;
    await this.utility.declareManaged(tx, caller.projectId);
    this.store.wake();
  }
  async projectCreated(projectId: string, tx: Transaction): Promise<void> {
    await this.utility.declareManaged(tx, projectId);
    this.store.wake();
  }
  unit: Code['unit'] = (...args) => this.unitStore.records.unit(...args);
  async status(caller: Caller) {
    const status = await this.unitStore.status(caller);
    const publication = status.project
      ? {
          publication: {
            controls: await this.publicationHost.status(caller),
            records: await this.publicationStore.publications(caller),
          },
        }
      : {};
    const technical = await this.store.describe(caller.projectId);
    const configuredCheck = await this.state.read((sql) => projectCheck(sql, caller.projectId));
    return {
      ...status,
      ...publication,
      bases: await this.state.read((sql) => this.baseStore.records(sql, caller.projectId)),
      ...technical,
      store: { ...technical.store, limits: { ...technical.store.limits, check: configuredCheck } },
      mirror: await this.mirrorStore.describe(caller.projectId),
    };
  }
  importRepository = async (caller: Caller, input: unknown) =>
    this.store.importRepository(caller, input);
  async prepareRepository(caller: Caller, value: CodeRepositoryPrepareInput) {
    caller = structuredClone(caller);
    const input = parseCodeInput(repositoryPrepareSchema, value);
    await this.state.transaction((tx) => this.ensureRepository(caller, tx));
    await this.store.maintain(false);
    return prepareRepository(this, caller, input, (operation) =>
      reconcileRepository(
        this.state,
        this.utility.repositories,
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
    const store = this.store;
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const project = await this.utility.units.project(tx, caller.projectId);
      return { project, store: { hosted: !!(await store.stored(tx, caller.projectId)) } };
    });
  }
  rebindRepository = async (caller: Caller, input: unknown) =>
    this.store.rebindRepository(caller, input);
  configureRepository = async (caller: Caller, input: unknown) =>
    configureWorkRepository(this.state, this.scope, this.store, caller, input);
  /**
   * The second workspace protocol as the API forwards it: opaque bodies and bundle bytes.
   * Absent once Code Work is closing, which the API answers as unavailable.
   */
  get v2() {
    return this.publicationClosed ? undefined : this.protocol;
  }
  async close(): Promise<void> {
    this.publicationClosed = true;
    this.releaseProvenance?.();
    this.releaseProvenance = undefined;
    clearInterval(this.publicationTimer);
    // Stop scheduling immediately, then join the whole pass, including its final journal write.
    const mirroring = this.mirrorStore?.close();
    // No new merge starts from here; one that is running is waited for below, because every
    // read must be refused before this method first yields.
    const merging = this.baseStore?.close();
    this.captureReader?.close();
    this.unitStore?.close();
    this.commands.close();
    // Every read is refused from here on. Running admissions and GitHub calls still reach the
    // database, which outlives Code, and are waited for before the writer lock is given up.
    await Promise.all([merging, mirroring, Promise.allSettled([...this.networkOperations])]);
    await this.store?.close();
  }
}
