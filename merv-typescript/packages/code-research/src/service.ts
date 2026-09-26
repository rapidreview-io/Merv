import { CodeGitHubService, type GitHubBinding } from '@merv/code/github';
import type { GitHubConfig } from '@merv/code/github-client';
import { parseCodeInput } from '@merv/code/input';
import type { CodeService as CodeUtility } from '@merv/code/service';
import { codeBackupRunSchema } from '@merv/code/store/backup';
import {
  CodeMirrorService,
  enqueueMirror,
  GitMirrorTransport,
  type CodeMirrorConfig,
  type MirrorTransport,
} from '@merv/code/store/mirror';
import {
  CodeStore,
  type CodeImportRemote,
  type CodeStoreConfig,
  type FaultPoint,
} from '@merv/code/store/operations';
import type {
  Artifacts,
  Caller,
  CodeAcceptedSince,
  CodeCommandCompletion,
  CodeTransportInput,
  Scope,
  State,
  Transaction,
  Workflows,
} from '@merv/contracts';
import {
  check,
  codeCommandCompletionSchema,
  createService,
  digest,
  MervError,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { CodeBaseService } from './bases.js';
import { CodeCaptureReader } from './captures.js';
import { CodeCommandService } from './commands.js';
import { CodeProposalService } from './proposals.js';
import { CodeWorkspaceProtocol } from './protocol.js';
import { PublicationHost } from './publication-host.js';
import { CodePublicationService } from './publications.js';
import { prepareRepository } from './repository-setup.js';
import { CodeRunningReader } from './running.js';
import { CodeTransportService } from './transport.js';
import type { Code } from './types.js';
import { CODE_DRIVER, CodeUnitService } from './units.js';
import { archiveCommit } from './base-check.js';
import { ResearchCodeWriters as CodeWriterService } from './writers.js';

/** Where Code keeps repositories. Without it the server keeps none and nothing is hosted. */
export interface CodeStoreOptions {
  config: Pick<CodeStoreConfig, 'root'> & Partial<CodeStoreConfig>;
  /** Replaces the linked GitHub repository as the place an import reads from. */
  remote?: CodeImportRemote;
  fault?: (point: FaultPoint) => void;
  /** How long a closed session's machine has to hand over its final capture. */
  finalizeGraceSeconds?: number;
  /** Replaces the linked GitHub repository as the place work is published to. */
  mirror?: MirrorTransport;
  mirrorConfig?: Partial<CodeMirrorConfig>;
  /** Merge several accepted commits into one base on the server. On unless disabled. */
  autoMerge?: boolean;
}

/** One Code capability; immutable proposals and machine commands retain separate records. */
export class CodeService extends CodeCommandService implements Code {
  async source(
    projectId: string,
    instanceId: string,
    commandId: string,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    const row = await this.storage.read((sql) =>
      sql.get<{ command_json: string; receipt_json: string | null; status: string }>(
        'SELECT command_json,receipt_json,status FROM code_commands WHERE id=? AND project_id=?',
        commandId,
        projectId,
      ),
    );
    const command = row && JSON.parse(row.command_json);
    const receipt = row?.receipt_json && JSON.parse(row.receipt_json);
    check(
      command?.instanceId === instanceId &&
        row?.status === 'succeeded' &&
        typeof receipt?.headOid === 'string' &&
        typeof receipt?.treeOid === 'string',
      'code_source_unavailable',
      'A succeeded commit for this experiment is required',
      409,
    );
    const store = this.requireStore();
    check(
      await store.contains(projectId, receipt.headOid),
      'code_source_unavailable',
      'The committed source is not in Code’s repository',
      409,
    );
    const env = store.repositories.environment(projectId);
    const tree = (
      await store.repositories.git.ok(['rev-parse', '--verify', `${receipt.headOid}^{tree}`], {
        env,
      })
    )
      .toString()
      .trim();
    check(
      tree === receipt.treeOid,
      'code_source_unavailable',
      'The commit tree differs from its receipt',
      409,
    );
    return await archiveCommit(store.repositories.git, env, receipt.headOid);
  }
  private proposalStore!: CodeProposalService;
  private captureReader!: CodeCaptureReader;
  private unitStore!: CodeUnitService;
  private writerStore!: CodeWriterService;
  private store?: CodeStore;
  private mirrorStore?: CodeMirrorService;
  private baseStore?: CodeBaseService;
  private protocol?: CodeWorkspaceProtocol;
  readonly github: CodeGitHubService;
  readonly transport: CodeTransportService;
  private publicationStore: CodePublicationService;
  private publicationHost: PublicationHost;
  private readonly board: CodeRunningReader;
  private storage: State;
  private readonly baseScope: Scope;
  private publicationClosed = false;
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
    artifacts: Artifacts,
    workflows: Workflows,
    github?: GitHubConfig,
    fetcher?: typeof fetch,
    repositories?: CodeStoreOptions,
    private readonly utility?: CodeUtility,
  ) {
    super(state, scope, sessions);
    this.storage = state;
    this.baseScope = scope;
    this.github = utility?.github ?? new CodeGitHubService(state, scope, github, fetcher);
    this.transport = new CodeTransportService(state, sessions, this, this.github);
    this.publicationHost = new PublicationHost(
      state,
      scope,
      () => this.requireStore().repositories,
      () =>
        repositories?.mirror ??
        new GitMirrorTransport(this.requireStore().repositories, this.published()),
      async (caller, ref, oid) => {
        const store = this.requireStore();
        if (await store.contains(caller.projectId, oid)) return;
        const operation = await store.importRepository(caller, {
          source: 'github',
          ref,
          requestId: `publication-import:${oid}`,
        });
        check(
          operation.status === 'completed' && (await store.contains(caller.projectId, oid)),
          'code_publication_import_pending',
          'The publication commit must finish Code admission before verification; retry this same request',
          409,
        );
      },
      (caller, tx) => this.github.publicationBinding(caller, tx),
      (projectId, tx) => this.unitStore.imported(tx, projectId),
    );
    this.publicationStore = new CodePublicationService(
      state,
      scope,
      this.github,
      this.transport,
      this.publicationHost,
    );
    this.board = new CodeRunningReader(state, scope, workflows, {
      unit: (caller, unitId, tx) => this.unitStore.unit(caller, unitId, tx),
      bases: () => this.baseStore,
      receipt: (sql, projectId, instanceId) => this.newestReceipt(sql, projectId, instanceId),
    });
    const initializeBase = this.initialize.bind(this);
    this.initialize = async () => {
      await initializeBase();

      this.captureReader = new CodeCaptureReader(state, scope, sessions);
      try {
        this.proposalStore = await createService(
          new CodeProposalService(this, state, scope, sessions, artifacts),
        );
        this.writerStore = new CodeWriterService(
          state,
          scope,
          utility?.writers.finalizeGraceSeconds ?? repositories?.finalizeGraceSeconds ?? 900,
          utility?.changes,
        );
        this.unitStore = await createService(
          new CodeUnitService(state, scope, workflows, this, this.writerStore, sessions),
        );
        this.unitStore.publications = this.publicationStore;
        if (repositories) {
          // Published only once it holds the writer lock and has finished what a crash left.
          const store = new CodeStore(
            state,
            scope,
            repositories.config,
            {
              imported: (tx, projectId) => this.unitStore.imported(tx, projectId),
              workspaces: (projectId, tx) => sessions.holdingWorkspace(projectId, CODE_DRIVER, tx),
              frozen: async () => [],
              fenced: (tx, fence, kind) => this.writerStore.fenced(tx, fence, kind),
              advanced: (tx, fence, input) => this.writerStore.advanced(tx, fence, input),
              quarantined: (tx, fence, id) => this.writerStore.quarantined(tx, fence, id),
              maintained: () => this.writerStore.expire(),
            },
            repositories.remote ?? this.linkedRepository(),
            repositories.fault,
            utility?.repositories,
          );
          await store.initialize();
          this.store = store;
          this.protocol = new CodeWorkspaceProtocol(state, sessions, this.writerStore, store);
          const mirror = new CodeMirrorService(
            state,
            scope,
            store.repositories,
            repositories.mirror ?? new GitMirrorTransport(store.repositories, this.published()),
            repositories.mirrorConfig,
          );
          this.mirrorStore = mirror;
          const bases = new CodeBaseService(
            state,
            store.repositories,
            {
              changed: (tx, projectId) => this.unitStore.imported(tx, projectId),
              sponsors: (tx, projectId, members) =>
                this.unitStore.baseSponsors(tx, projectId, members),
              serviceWork: sessions.serviceWork,
              resolved: (tx, projectId, key, commit) =>
                enqueueMirror(tx, projectId, 'mirror-base', key, commit),
            },
            repositories.autoMerge !== false,
          );
          await bases.initialize();
          this.unitStore.bases = bases;
          this.baseStore = bases;
          bases.start();
        }
        if (!utility) await this.github.initialize();
        // The mirror reads the project's GitHub link, so it only starts looking for refs to
        // publish once that store exists.
        this.mirrorStore?.initialize();
        await this.transport.initialize();
        await this.publicationStore.initialize();
      } catch (error) {
        await this.close();
        throw error;
      }
    };
  }
  async capture(...args: Parameters<CodeCaptureReader['capture']>) {
    return await this.captureReader.capture(...args);
  }
  transportGrant(caller: Caller, input: CodeTransportInput) {
    return this.network(() => this.transport.grant(caller, input));
  }
  verifyTransport(caller: Caller, input: CodeTransportInput) {
    return this.network(() => this.transport.verify(caller, input));
  }
  override async completeCommand(caller: Caller, value: CodeCommandCompletion) {
    caller = structuredClone(caller);
    const input = parseCodeInput(codeCommandCompletionSchema, value);
    const complete = async (tx: Transaction) => {
      const command = await tx.get<{ command_json: string }>(
        'SELECT command_json FROM code_commands WHERE id=? AND project_id=?',
        input.commandId,
        caller.projectId,
      );
      const binding = command
        ? (JSON.parse(command.command_json) as { projectId: string; instanceId: string })
        : null;
      const writer =
        binding && (await this.writerStore.row(tx, binding.projectId, binding.instanceId));
      if (!writer || Number(writer.generation) === 0)
        await this.transport.requireCheckpoint(input, tx);
      if (binding) await this.writerStore.requireAdmitted(input, binding, tx);
      return super.completeCommand(caller, input);
    };
    return this.storage.read((sql) =>
      'transactionId' in sql ? complete(sql as Transaction) : this.storage.transaction(complete),
    );
  }
  async seal(
    caller: Caller,
    input: Parameters<CodeProposalService['seal']>[1],
    binding: Parameters<CodeProposalService['seal']>[2],
    tx: Transaction,
  ) {
    caller = structuredClone(caller);
    const proposal = await this.proposalStore.seal(caller, input, binding, tx);
    await this.publicationStore.enqueue(caller, proposal, tx);
    return proposal;
  }
  controlPublication(caller: Caller, input: unknown): Promise<unknown> {
    return this.publicationHost.control(caller, input);
  }
  recordPublicationReview(...args: Parameters<CodePublicationService['recordReview']>) {
    return this.publicationStore.recordReview(...args);
  }
  publications(...args: Parameters<CodePublicationService['publications']>) {
    return this.publicationStore.publications(...args);
  }
  syncPublications(...args: Parameters<CodePublicationService['syncPublications']>) {
    return this.network(() => this.publicationStore.syncPublications(...args));
  }
  publicationDetails(...args: Parameters<CodePublicationService['publicationDetails']>) {
    return this.network(() => this.publicationStore.publicationDetails(...args));
  }
  mergePublication(...args: Parameters<CodePublicationService['mergePublication']>) {
    return this.network(() => this.publicationStore.mergePublication(...args));
  }
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
  bindServiceTasks(provider: import('@merv/contracts').ServiceTaskCreator): () => void {
    this.unitStore.resolutionTasks = provider;
    void this.unitStore.reconcileAll().catch(() => undefined);
    return () => {
      if (this.unitStore.resolutionTasks === provider) this.unitStore.resolutionTasks = undefined;
    };
  }

  async declareUnit(...args: Parameters<CodeUnitService['declareUnit']>) {
    return await this.unitStore.declareUnit(...args);
  }
  async acceptUnit(...args: Parameters<CodeUnitService['acceptUnit']>) {
    return await this.unitStore.acceptUnit(...args);
  }
  async publishOnAcceptance(...args: Parameters<CodeUnitService['publishOnAcceptance']>) {
    return await this.unitStore.publishOnAcceptance(...args);
  }
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
    const missing = candidates.filter((item) => beyond.has(item.commit));
    const unitIds = missing
      .filter((item) => !item.quarantined)
      .map((item) => item.unitId)
      .sort();
    const quarantined = missing
      .filter((item) => item.quarantined)
      .map((item) => item.unitId)
      .sort();
    return {
      unitIds,
      quarantined,
      main,
      hash: digest({ formatVersion: 1, main, unitIds, quarantined }),
    };
  }
  async baseStatus(...args: Parameters<CodeUnitService['baseStatus']>) {
    return await this.unitStore.baseStatus(...args);
  }
  async pinBase(...args: Parameters<CodeUnitService['pinBase']>) {
    return await this.unitStore.pinBase(...args);
  }
  async basePin(...args: Parameters<CodeUnitService['basePin']>) {
    return await this.unitStore.basePin(...args);
  }
  /** Plugin wiring, not part of the Code contract: no other plugin reconciles Code's view. */
  async reconcileAll() {
    await this.unitStore.reconcileAll();
  }
  async transitioned(...args: Parameters<CodeUnitService['transitioned']>) {
    await this.unitStore.transitioned(...args);
    // An acceptance journals the ref it is kept under; the journal takes it up after this.
    this.store?.wake();
  }
  /** One maintenance pass now, as the timer would make it. */
  async maintainStore() {
    await this.store?.maintain();
  }
  /** One publication pass now, as the timer would make it. */
  async mirrorStep() {
    await this.mirrorStore?.run();
  }
  /** One backup pass over every project now, as the timer would make it. */
  async backupStep(requestId: string) {
    await this.requireStore().backup(null, { requestId });
  }
  async runBackup(caller: Caller, input: unknown) {
    const { requestId } = parseCodeInput(codeBackupRunSchema, input);
    return await this.requireStore().backup(structuredClone(caller), {
      requestId,
      projectId: caller.projectId,
    });
  }
  async controlBase(caller: Caller, input: unknown) {
    if (!this.baseStore)
      throw new MervError('code_unavailable', 'Hosted bases are unavailable', 503);
    return this.baseStore.control(this.baseScope, caller, input);
  }
  async retryMirror(caller: Caller, input: unknown) {
    if (!this.mirrorStore)
      throw new MervError('code_store_unavailable', 'This server keeps no Code repositories', 503);
    return await this.mirrorStore.retry(caller, input);
  }
  async sessionChanged(...args: Parameters<CodeWriterService['sessionChanged']>) {
    await this.writerStore.sessionChanged(...args);
  }
  async reserveWriter(...args: Parameters<CodeWriterService['reserveWriter']>) {
    return await this.writerStore.reserveWriter(...args);
  }
  async writerStatus(...args: Parameters<CodeWriterService['writerStatus']>) {
    return await this.writerStore.writerStatus(...args);
  }
  /** Every admitted upload of the unit is first given the chance to finish; then the fence. */
  async fenceUnit(caller: Caller, input: unknown) {
    const store = this.requireStore();
    caller = structuredClone(caller);
    await store.maintain(false);
    const status = await this.storage.transaction(
      async (tx) => await this.writerStore.fence(caller, input, tx),
    );
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
    return await this.storage.transaction(async (tx) => {
      await this.github.assertBinding(caller, binding, tx, 'read');
      return await this.unitStore.bindLocal(caller, input, stored, tx);
    });
  }
  /** The Running page's reads, each on the page's snapshot (running.ts). */
  runningHolds(caller: Caller) {
    return this.board.holds(caller);
  }
  runningChecks(caller: Caller) {
    return this.board.checks(caller);
  }
  runningPanel(caller: Caller, key: string) {
    return this.board.panel(caller, key);
  }
  runningCode(caller: Caller, keys: readonly string[]) {
    return this.board.sections(caller, keys);
  }
  async hosted(...args: Parameters<CodeUnitService['hosted']>) {
    return await this.unitStore.hosted(...args);
  }
  async unit(...args: Parameters<CodeUnitService['unit']>) {
    return await this.unitStore.unit(...args);
  }
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
    return {
      ...status,
      ...publication,
      bases: await this.storage.read(
        (sql) => this.baseStore?.records(sql, caller.projectId) ?? Promise.resolve([]),
      ),
      ...(await this.store.describe(caller.projectId)),
      mirror: (await this.mirrorStore?.describe(caller.projectId)) ?? null,
    };
  }
  private requireStore(): CodeStore {
    if (!this.store)
      throw new MervError('code_store_unavailable', 'This server keeps no Code repositories', 503);
    return this.store;
  }
  async importRepository(caller: Caller, input: unknown) {
    return await this.requireStore().importRepository(caller, input);
  }
  prepareRepository(caller: Caller, input: import('@merv/contracts').CodeRepositoryPrepareInput) {
    return prepareRepository(this, caller, input);
  }
  async rebindRepository(caller: Caller, input: unknown) {
    return await this.requireStore().rebindRepository(caller, input);
  }
  async configureRepository(caller: Caller, input: unknown) {
    return await this.requireStore().configure(caller, input);
  }
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
  private published() {
    return {
      target: async (projectId: string) => {
        const found = await this.github.mirrorTarget(projectId);
        return 'blocked' in found ? found : { id: found.id, fullName: found.fullName };
      },
      token: async <T>(projectId: string, use: (token: string) => Promise<T>): Promise<T> => {
        const found = await this.github.mirrorTarget(projectId);
        if ('blocked' in found)
          throw new MervError('code_mirror_unavailable', 'Nothing is linked to publish to', 503);
        return await this.network(() => this.github.mirrorToken(found, use));
      },
    };
  }
  /** An import reads GitHub as the administrator who asked, with a token that ends with the call. */
  private linkedRepository(): CodeImportRemote {
    return {
      read: (caller, use, expected) =>
        this.network(() =>
          this.github.automation(caller, 'read', undefined, async (client, _token, binding) => {
            check(
              !expected ||
                (binding.revision === expected.revision &&
                  binding.repository.id === expected.repositoryId &&
                  binding.baseBranch === expected.baseBranch),
              'github_conflict',
              'Repository settings changed; the selected import remains pinned to its original connection',
              409,
            );
            const grant = await client.installationToken(binding.repository, false);
            try {
              return await use({
                url: `https://github.com/${binding.repository.fullName}.git`,
                protocol: 'https',
                repository: binding.repository,
                // The token exists only in the environment of that one Git child.
                env: {
                  GIT_CONFIG_COUNT: '1',
                  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${grant.token}`).toString('base64')}`,
                },
              });
            } finally {
              await client.revokeInstallationToken(grant.token).catch(() => {});
            }
          }),
        ),
    };
  }
  async proposal(...args: Parameters<CodeProposalService['proposal']>) {
    return await this.proposalStore.proposal(...args);
  }
  override async close(): Promise<void> {
    this.publicationClosed = true;
    // Stop scheduling immediately, then join the whole pass, including its final journal write.
    const mirroring = this.mirrorStore?.close();
    // No new merge starts from here; one that is running is waited for below, because every
    // read must be refused before this method first yields.
    const merging = this.baseStore?.close();
    this.captureReader?.close();
    this.proposalStore?.close();
    this.unitStore?.close();
    this.writerStore?.close();
    super.close();
    // Every read is refused from here on. Running admissions still reach the database, which
    // outlives Code, and are waited for before the writer lock is given up.
    await Promise.all([merging, mirroring]);
    await this.store?.close();
    if (!this.utility) await this.github.close();
    await Promise.allSettled([...this.networkOperations]);
  }
}
