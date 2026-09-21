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
import type {
  Caller,
  CodeCommandCompletion,
  CodeTransportInput,
  Transaction,
} from '@merv/contracts';
import { parseCodeInput } from './input.js';

/** One Code capability; immutable proposals and machine commands retain separate records. */
export class CodeService extends CodeCommandService implements Code {
  private proposalStore!: CodeProposalService;
  private captureReader!: CodeCaptureReader;
  private unitStore!: CodeUnitService;
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
        this.unitStore = await createService(new CodeUnitService(state, scope, workflows, this));
        await this.github.initialize();
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
  async declareUnit(...args: Parameters<CodeUnitService['declareUnit']>) {
    return await this.unitStore.declareUnit(...args);
  }
  async acceptUnit(...args: Parameters<CodeUnitService['acceptUnit']>) {
    return await this.unitStore.acceptUnit(...args);
  }
  async bindLocal(...args: Parameters<CodeUnitService['bindLocal']>) {
    return await this.unitStore.bindLocal(...args);
  }
  async unit(...args: Parameters<CodeUnitService['unit']>) {
    return await this.unitStore.unit(...args);
  }
  async status(...args: Parameters<CodeUnitService['status']>) {
    return await this.unitStore.status(...args);
  }
  async proposal(...args: Parameters<CodeProposalService['proposal']>) {
    return await this.proposalStore.proposal(...args);
  }
  async proposals(...args: Parameters<CodeProposalService['proposals']>) {
    return await this.proposalStore.proposals(...args);
  }
  override async close(): Promise<void> {
    this.publicationClosed = true;
    this.captureReader?.close();
    this.proposalStore?.close();
    this.unitStore?.close();
    super.close();
    await this.github.close();
    await Promise.allSettled([...this.networkOperations]);
  }
}
