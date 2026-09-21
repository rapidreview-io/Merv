import { createService, codeCommandCompletionSchema, MervError } from '@merv/contracts';
import type { Artifacts, Scope, State, Workflows } from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { Code } from './types.js';
import { CodeCommandService } from './commands.js';
import { CodeProposalService } from './proposals.js';
import { CodeCaptureReader } from './captures.js';
import { CodeGitHubService } from './github.js';
import type { GitHubConfig } from './github-client.js';
import { CodeTransportService } from './transport.js';
import { CodePublicationService } from './publications.js';
import { CodeUnitService } from './units.js';
import { CodeBaseService } from './bases.js';
import { CodeWriterService } from './writers.js';
import { CodeWorkspaceProtocol } from './protocol.js';
import {
  CodeStore,
  type CodeImportRemote,
  type CodeStoreConfig,
  type FaultPoint,
} from './store/operations.js';
import {
  CodeMirrorService,
  GitMirrorTransport,
  type CodeMirrorConfig,
  type MirrorTransport,
} from './store/mirror.js';
import type {
  Caller,
  CodeCommandCompletion,
  CodeTransportInput,
  Transaction,
} from '@merv/contracts';
import { parseCodeInput } from './input.js';

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
  /** Merge several accepted commits into one base on the server. Off unless set. */
  autoMerge?: boolean;
}

/** One Code capability; immutable proposals and machine commands retain separate records. */
export class CodeService extends CodeCommandService implements Code {
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
  private storage: State;
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
  ) {
    super(state, scope, sessions);
    this.storage = state;
    this.github = new CodeGitHubService(state, scope, github, fetcher);
    this.transport = new CodeTransportService(state, sessions, this, this.github);
    this.publicationStore = new CodePublicationService(state, scope, this.github, this.transport);
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
          workflows,
          repositories?.finalizeGraceSeconds ?? 900,
        );
        this.unitStore = await createService(
          new CodeUnitService(state, scope, workflows, this, this.writerStore),
        );
        if (repositories) {
          // Published only once it holds the writer lock and has finished what a crash left.
          const store = new CodeStore(
            state,
            scope,
            repositories.config,
            {
              imported: (tx, projectId) => this.unitStore.imported(tx, projectId),
              fenced: (tx, fence, kind) => this.writerStore.fenced(tx, fence, kind),
              advanced: (tx, fence, input) => this.writerStore.advanced(tx, fence, input),
              quarantined: (tx, fence, id) => this.writerStore.quarantined(tx, fence, id),
              maintained: () => this.writerStore.expire(),
            },
            repositories.remote ?? this.linkedRepository(),
            repositories.fault,
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
          // Several accepted commits are merged here, once per set; it stays off until a
          // deployment turns it on, because a conflict needs its resolution task to exist.
          const bases = new CodeBaseService(
            state,
            store.repositories,
            { changed: (tx, projectId) => this.unitStore.imported(tx, projectId) },
            repositories.autoMerge === true,
          );
          await bases.initialize();
          this.unitStore.bases = bases;
          this.baseStore = bases;
          bases.start();
        }
        await this.github.initialize();
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
      await this.transport.requireCheckpoint(input, tx);
      const command = await tx.get<{ command_json: string }>(
        'SELECT command_json FROM code_commands WHERE id=? AND project_id=?',
        input.commandId,
        caller.projectId,
      );
      if (command)
        await this.writerStore.requireAdmitted(
          input,
          JSON.parse(command.command_json) as { projectId: string; instanceId: string },
          tx,
        );
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
  async bindLocal(caller: Caller, input: Parameters<CodeUnitService['bindLocal']>[1]) {
    // Whether Code's repository holds the named commit is asked of Git before the transaction.
    const named = (input as { mainOid?: unknown } | null)?.mainOid;
    const stored =
      !!this.store &&
      typeof named === 'string' &&
      /^[0-9a-f]{40,64}$/.test(named) &&
      (await this.store.contains(caller.projectId, named));
    return await this.unitStore.bindLocal(caller, input, stored);
  }
  async hosted(...args: Parameters<CodeUnitService['hosted']>) {
    return await this.unitStore.hosted(...args);
  }
  async unit(...args: Parameters<CodeUnitService['unit']>) {
    return await this.unitStore.unit(...args);
  }
  async status(caller: Caller) {
    const status = await this.unitStore.status(caller);
    if (!this.store) return status;
    return {
      ...status,
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
  async configureRepository(caller: Caller, input: unknown) {
    return await this.requireStore().configure(caller, input);
  }
  /**
   * The second workspace protocol as the API forwards it: opaque bodies and bundle bytes.
   * Absent when this server keeps no repositories, which the API answers as unavailable.
   */
  get v2() {
    const protocol = this.protocol;
    if (!protocol || this.publicationClosed) return undefined;
    return {
      call: (caller: Caller, route: string, body: unknown) => protocol.call(caller, route, body),
      putPart: (caller: Caller, operationId: string, offset: number, bytes: Buffer) =>
        protocol.putPart(caller, operationId, offset, bytes),
      readPart: (caller: Caller, exportId: string, input: unknown) =>
        protocol.readPart(caller, exportId, input),
    };
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
      read: (caller, use) =>
        this.network(() =>
          this.github.automation(caller, 'read', undefined, async (client, _token, binding) => {
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
  async proposals(...args: Parameters<CodeProposalService['proposals']>) {
    return await this.proposalStore.proposals(...args);
  }
  override async close(): Promise<void> {
    this.publicationClosed = true;
    // Publication stops before the repositories drain: it is the one thing here nothing waits
    // for, and a push that was interrupted is simply queued again by the next start.
    this.mirrorStore?.close();
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
    await merging;
    await this.store?.close();
    await this.github.close();
    await Promise.allSettled([...this.networkOperations]);
  }
}
